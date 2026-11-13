/**
 * Server-Side Contiguous Float32 Vector Math
 *
 * WHAT: Packs embedding dictionaries into contiguous Float32Array buffers and computes
 *       clamped cosine similarity rankings with zero per-vector JS object allocations.
 * WHY: `public/modules/vectorMath.js` is a classic Web Worker script loaded via `importScripts`,
 *      so Node.js ESM (`"type": "module"`) imports this pure ESM counterpart cleanly.
 */

// WHAT: Packs a `{ id: number[] }` dictionary into a single contiguous Float32Array matrix.
// WHY: Eliminates thousands of small heap array allocations and keeps dot-product scans cache-local.
export function buildContiguousVectorData(embeddings_dictionary) {
    if (!embeddings_dictionary || typeof embeddings_dictionary !== 'object') {
        return { buffer: new Float32Array(0), dimensionsCount: 0, vectorsCount: 0, indexedIdentifiers: [] };
    }

    const entry_keys = Object.keys(embeddings_dictionary);
    if (entry_keys.length === 0) {
        return { buffer: new Float32Array(0), dimensionsCount: 0, vectorsCount: 0, indexedIdentifiers: [] };
    }

    let vector_dimensions = 0;
    for (const candidate_key of entry_keys) {
        const candidate_vector = embeddings_dictionary[candidate_key];
        if (Array.isArray(candidate_vector) && candidate_vector.length > 0) {
            vector_dimensions = candidate_vector.length;
            break;
        }
    }

    if (vector_dimensions <= 0) {
        return { buffer: new Float32Array(0), dimensionsCount: 0, vectorsCount: 0, indexedIdentifiers: [] };
    }

    const valid_identifiers = [];
    for (const candidate_key of entry_keys) {
        const candidate_vector = embeddings_dictionary[candidate_key];
        if (Array.isArray(candidate_vector) && candidate_vector.length === vector_dimensions) {
            valid_identifiers.push(candidate_key);
        }
    }

    const contiguous_buffer = new Float32Array(valid_identifiers.length * vector_dimensions);
    for (let row_index = 0; row_index < valid_identifiers.length; row_index++) {
        const source_vector = embeddings_dictionary[valid_identifiers[row_index]];
        const row_offset = row_index * vector_dimensions;
        for (let dimension_index = 0; dimension_index < vector_dimensions; dimension_index++) {
            const raw_scalar = source_vector[dimension_index];
            contiguous_buffer[row_offset + dimension_index] = (typeof raw_scalar === 'number' && Number.isFinite(raw_scalar))
                ? raw_scalar
                : 0.0;
        }
    }

    return {
        buffer: contiguous_buffer,
        dimensionsCount: vector_dimensions,
        vectorsCount: valid_identifiers.length,
        indexedIdentifiers: valid_identifiers
    };
}

// WHAT: L2-normalizes a raw query vector into a Float32Array of the expected dimensionality.
// WHY: Pre-normalizing the query vector allows cosine similarity to be computed as a plain dot product.
export function normalizeQueryVectorToFloat32(raw_query_vector_array, expected_dimensions_count) {
    if (!Array.isArray(raw_query_vector_array) || expected_dimensions_count <= 0) {
        return null;
    }

    const safe_query_length = Math.min(raw_query_vector_array.length, expected_dimensions_count);
    let query_magnitude_squared = 0.0;
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
// WHY: Pure kernel enables deterministic server-side similarity ranking without per-vector allocations.
export function computeContiguousCpuDotProducts(
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

