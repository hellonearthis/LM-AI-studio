// ============================================================================
// LUMINA STUDIO - PURE VECTOR MATH & RECIPROCAL RANK FUSION MODULE
// ============================================================================
// WHAT: Pure Float32Array vector packing, L2 normalization, contiguous CPU
//       dot-product similarity search, and Reciprocal Rank Fusion (RRF).
// WHY: Isolates zero-GC numerical kernels from WebGPU/Worker messaging so the
//      same pure functions work in Web Workers (`importScripts`) and Node/VM tests.
// ============================================================================

// WHAT: Packs a dictionary of embedding vectors into a contiguous L2-normalized Float32Array.
// WHY: Contiguous linear memory avoids per-vector heap allocations and turns cosine
//      similarity into a single cache-friendly dot product pass.
function buildContiguousVectorData(raw_embeddings_json_dictionary) {
    const candidate_image_identifier_keys = Object.keys(raw_embeddings_json_dictionary || {});
    const total_indexed_vectors_count = candidate_image_identifier_keys.length;

    if (total_indexed_vectors_count === 0) {
        return {
            buffer: null,
            dimensionsCount: 0,
            vectorsCount: 0,
            indexedIdentifiers: [],
            idToVectorIndexMap: new Map()
        };
    }

    const first_vector = raw_embeddings_json_dictionary[candidate_image_identifier_keys[0]];
    const indexed_vector_dimensions_count = (first_vector && first_vector.length) || 768;

    const contiguous_normalized_embedding_vectors_buffer = new Float32Array(
        total_indexed_vectors_count * indexed_vector_dimensions_count
    );
    const indexed_image_identifiers_collection = new Array(total_indexed_vectors_count);
    const database_id_to_vector_index_lookup = new Map();

    for (let vector_index = 0; vector_index < total_indexed_vectors_count; vector_index++) {
        const image_identifier_key = candidate_image_identifier_keys[vector_index];
        const raw_vector_array = raw_embeddings_json_dictionary[image_identifier_key];
        const base_memory_offset = vector_index * indexed_vector_dimensions_count;

        indexed_image_identifiers_collection[vector_index] = image_identifier_key;
        database_id_to_vector_index_lookup.set(String(image_identifier_key), vector_index);

        let sum_of_squared_scalars = 0.0;
        const safe_vector_length = Array.isArray(raw_vector_array) ? raw_vector_array.length : 0;

        for (let dimension_index = 0; dimension_index < indexed_vector_dimensions_count; dimension_index++) {
            const raw_scalar = (dimension_index < safe_vector_length) ? raw_vector_array[dimension_index] : 0.0;
            const sanitized_scalar = (typeof raw_scalar === 'number' && Number.isFinite(raw_scalar)) ? raw_scalar : 0.0;
            sum_of_squared_scalars += sanitized_scalar * sanitized_scalar;
        }

        const vector_euclidean_magnitude = Math.sqrt(sum_of_squared_scalars);
        const inverse_magnitude_factor = (Number.isFinite(vector_euclidean_magnitude) && vector_euclidean_magnitude > 1e-12)
            ? 1.0 / vector_euclidean_magnitude
            : 0.0;

        for (let dimension_index = 0; dimension_index < indexed_vector_dimensions_count; dimension_index++) {
            const raw_scalar = (dimension_index < safe_vector_length) ? raw_vector_array[dimension_index] : 0.0;
            const sanitized_scalar = (typeof raw_scalar === 'number' && Number.isFinite(raw_scalar)) ? raw_scalar : 0.0;
            const normalized_scalar = sanitized_scalar * inverse_magnitude_factor;
            contiguous_normalized_embedding_vectors_buffer[base_memory_offset + dimension_index] = (
                Number.isFinite(normalized_scalar) ? normalized_scalar : 0.0
            );
        }
    }

    return {
        buffer: contiguous_normalized_embedding_vectors_buffer,
        dimensionsCount: indexed_vector_dimensions_count,
        vectorsCount: total_indexed_vectors_count,
        indexedIdentifiers: indexed_image_identifiers_collection,
        idToVectorIndexMap: database_id_to_vector_index_lookup
    };
}

// WHAT: Sanitizes and L2-normalizes a raw query vector into a fixed-dimension Float32Array.
// WHY: Guards against NaN, Infinity, and zero-magnitude inputs before GPU or CPU dot products.
function normalizeQueryVectorToFloat32(raw_query_vector_array, expected_dimensions_count) {
    if (!Array.isArray(raw_query_vector_array) && !(raw_query_vector_array instanceof Float32Array)) {
        return null;
    }
    if (raw_query_vector_array.length === 0 || expected_dimensions_count <= 0) {
        return null;
    }

    let query_magnitude_squared = 0.0;
    const safe_query_length = raw_query_vector_array.length;

    for (let index = 0; index < safe_query_length; index++) {
        const raw_scalar = raw_query_vector_array[index];
        const sanitized_scalar = (typeof raw_scalar === 'number' && Number.isFinite(raw_scalar)) ? raw_scalar : 0.0;
        query_magnitude_squared += sanitized_scalar * sanitized_scalar;
    }

    const query_magnitude = Math.sqrt(query_magnitude_squared);
    if (!Number.isFinite(query_magnitude) || query_magnitude <= 1e-12) {
        return null;
    }

    const inverse_query_magnitude = 1.0 / query_magnitude;
    const normalized_query_float32 = new Float32Array(expected_dimensions_count);
    for (let index = 0; index < expected_dimensions_count; index++) {
        if (index < safe_query_length) {
            const raw_scalar = raw_query_vector_array[index];
            const sanitized_scalar = (typeof raw_scalar === 'number' && Number.isFinite(raw_scalar)) ? raw_scalar : 0.0;
            normalized_query_float32[index] = sanitized_scalar * inverse_query_magnitude;
        } else {
            normalized_query_float32[index] = 0.0;
        }
    }

    return normalized_query_float32;
}

// WHAT: Computes clamped cosine similarities between a unit query vector and a contiguous matrix.
// WHY: Pure kernel enables deterministic testing without requiring WebGPU or global worker state.
function computeContiguousCpuDotProducts(
    contiguous_matrix,
    vector_dimensions,
    total_vectors,
    indexed_identifiers,
    normalized_query_float32_array,
    minimum_similarity_threshold,
    lookup_image_record_fn
) {
    if (!normalized_query_float32_array || !contiguous_matrix || total_vectors <= 0 || vector_dimensions <= 0) {
        return [];
    }

    const candidate_matches_collection = [];
    const safe_query_length = normalized_query_float32_array.length;

    for (let vector_index = 0; vector_index < total_vectors; vector_index++) {
        const memory_offset = vector_index * vector_dimensions;
        let accumulated_dot_product = 0.0;

        for (let dimension_index = 0; dimension_index < vector_dimensions; dimension_index++) {
            const query_scalar = (dimension_index < safe_query_length) ? normalized_query_float32_array[dimension_index] : 0.0;
            accumulated_dot_product += query_scalar * contiguous_matrix[memory_offset + dimension_index];
        }

        const clamped_similarity_score = Math.min(1.0, Math.max(-1.0, accumulated_dot_product));

        if (Number.isFinite(clamped_similarity_score) && clamped_similarity_score >= minimum_similarity_threshold) {
            const image_identifier = indexed_identifiers[vector_index];
            const corresponding_image_record = lookup_image_record_fn(image_identifier);

            if (corresponding_image_record) {
                candidate_matches_collection.push({
                    item: corresponding_image_record,
                    score: clamped_similarity_score
                });
            }
        }
    }

    candidate_matches_collection.sort((first_candidate, second_candidate) => second_candidate.score - first_candidate.score);
    return candidate_matches_collection;
}

// WHAT: Merges two independently ranked candidate lists using Reciprocal Rank Fusion (RRF).
// WHY: Blends lexical and semantic ranks without requiring calibrated score distributions.
function fuseRankedListsPure(first_ranked_candidate_list, second_ranked_candidate_list, rrf_rank_smoothing_constant = 60) {
    const combined_scores_dictionary_map = new Map();
    const safe_first_ranked_list = Array.isArray(first_ranked_candidate_list) ? first_ranked_candidate_list : [];
    const safe_second_ranked_list = Array.isArray(second_ranked_candidate_list) ? second_ranked_candidate_list : [];

    safe_first_ranked_list.forEach((candidate_item, candidate_rank_position_index) => {
        if (!candidate_item || candidate_item.id === undefined || candidate_item.id === null) return;
        const candidate_identifier_string = String(candidate_item.id);
        const reciprocal_rank_contribution_score = 1 / (rrf_rank_smoothing_constant + candidate_rank_position_index);
        combined_scores_dictionary_map.set(
            candidate_identifier_string,
            { item: candidate_item, score: reciprocal_rank_contribution_score }
        );
    });

    safe_second_ranked_list.forEach((candidate_item, candidate_rank_position_index) => {
        if (!candidate_item || candidate_item.id === undefined || candidate_item.id === null) return;
        const candidate_identifier_string = String(candidate_item.id);
        const reciprocal_rank_contribution_score = 1 / (rrf_rank_smoothing_constant + candidate_rank_position_index);

        if (combined_scores_dictionary_map.has(candidate_identifier_string)) {
            combined_scores_dictionary_map.get(candidate_identifier_string).score += reciprocal_rank_contribution_score;
        } else {
            combined_scores_dictionary_map.set(
                candidate_identifier_string,
                { item: candidate_item, score: reciprocal_rank_contribution_score }
            );
        }
    });

    const sorted_candidate_entries_collection = Array.from(combined_scores_dictionary_map.values());
    sorted_candidate_entries_collection.sort(
        (first_candidate_entry, second_candidate_entry) => second_candidate_entry.score - first_candidate_entry.score
    );

    return sorted_candidate_entries_collection.map(candidate_entry => candidate_entry.item);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildContiguousVectorData,
        normalizeQueryVectorToFloat32,
        computeContiguousCpuDotProducts,
        fuseRankedListsPure
    };
}

