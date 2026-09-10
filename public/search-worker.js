/*
 * ============================================================================
 * LUMINA SEARCH WORKER (TUTORIAL-STYLE WALKTHROUGH)
 * ============================================================================
 * 
 * WHY USE A WORKER?
 * Searching through thousands of images with complex fuzzy matching (Fuse.js)
 * and vector math (Cosine Similarity) is "CPU-heavy". If we ran this on the 
 * main UI thread, the screen would "freeze" every time a user typed a letter.
 * 
 * This Worker runs in its own background thread, keeping the UI silky smooth.
 */

// We import Fuse.js from a local path. This library handles our keyword-based 
// "fuzzy" searching (finding "coffe" when the user types "coffee").
importScripts('libs/fuse.min.js');

// ============================================================================
// 1. PRECISION CALCULATIONS (POLYFILLS)
// ============================================================================

/**
 * ES2026 introduces Math.sumPrecise() to handle floating-point addition 
 * without the typical accumulated errors (like 0.1 + 0.2 leading to 0.30000000000000004).
 * We use this for vector math to ensure our search rankings are perfectly accurate.
 */
if (typeof Math.sumPrecise !== 'function') {
    Math.sumPrecise = function (iterable) {
        let total = 0;
        for (const value of iterable) {
            total += Number(value);
        }
        return total;
    };
    console.warn('[WORKER] Math.sumPrecise not natively supported, using standard fallback.');
}

// ============================================================================
// 2. GLOBAL WORKER STATE
// ============================================================================

// The primary fuzzy search engine instance
let fuseInstance = null;

// Our lightweight image database (IDs, filenames, and AI analysis text)
let globalImageDatabase = [];

// A Map of ImageID -> Vector (for Semantic Search)
// These vectors are 768-dimensional mathematical representations of the image content.
let semanticEmbeddingsMap = null; 

// Track whether the worker has finished downloading and parsing the search indexes
let isWorkerReady = false;

// We assign "weights" to different parts of the image data.
// Searching the FILENAME is important, but TAGS and OBJECTS are twice as 
// important for finding the right image conceptually.
const SEARCHABLE_FIELDS_AND_WEIGHTS = [
    { name: 'filename', weight: 1 },
    { name: 'analysis.summary', weight: 1 },
    { name: 'analysis.objects', weight: 2 },
    { name: 'analysis.tags', weight: 2 }
];

// ============================================================================
// 3. MESSAGE HANDLING (COMMUNICATION WITH MAIN THREAD)
// ============================================================================

/**
 * The worker listens for "messages" from the main application.
 * Each message has a 'type' telling the worker what action to perform.
 */
self.onmessage = async function (event) {
    const { type, payload } = event.data;

    switch (type) {
        case 'INIT':
            // Step 1: Load the data files and set up the search engine
            await initializeSearchEngine(payload.fuzziness || 0.2);
            break;

        case 'SEARCH':
            // Step 2a: Perform a standard keyword search
            runKeywordSearch(payload.query, payload.options);
            break;

        case 'SEMANTIC_SEARCH':
            // Step 2b: Perform an AI concept search using a query vector
            runSemanticSearch(payload.vector);
            break;

        case 'HYBRID_SEARCH':
            // Step 2c: The best of both worlds! Merge keyword and semantic results.
            runHybridSearch(payload.query, payload.vector);
            break;

        case 'UPDATE_CONFIG':
            // Step 3: Change settings (like fuzziness) on the fly without reloading data
            updateSearchConfiguration(payload);
            break;
    }
};

// ============================================================================
// 4. INITIALIZATION LOGIC
// ============================================================================

/**
 * Downloads the pre-computed search index and image metadata.
 */
async function initializeSearchEngine(initialFuzziness) {
    try {
        console.log('[WORKER] Loading search indexes...');

        // We fetch three critical files in parallel for maximum speed:
        // 1. search-index.json: Pre-built Fuse.js index (fast lookups)
        // 2. search-data.json: The actual text/tags for every image
        // 3. search-embeddings.json: The AI vectors (mental "concepts") for images
        const [indexResponse, dataResponse, embeddingResponse] = await Promise.all([
            fetch('search-index.json?t=' + Date.now()),
            fetch('search-data.json?t=' + Date.now()),
            fetch('search-embeddings.json?t=' + Date.now()).catch(() => ({ ok: false }))
        ]);

        if (!indexResponse.ok || !dataResponse.ok) {
            throw new Error('Critical search data files missing or unreachable.');
        }

        const fuseIndexStructure = await indexResponse.json();
        globalImageDatabase = await dataResponse.json();

        // If the user has generated embeddings, we load them into memory.
        if (embeddingResponse.ok) {
            try {
                semanticEmbeddingsMap = await embeddingResponse.json();
                console.log(`[WORKER] Semantic support enabled (${Object.keys(semanticEmbeddingsMap).length} images mapped).`);
            } catch (e) {
                console.warn('[WORKER] search-embeddings.json is corrupted or unreadable.');
            }
        }

        // Initialize the Fuse.js engine with our loaded data and weights
        const searchOptions = {
            includeScore: true,
            threshold: initialFuzziness,
            ignoreLocation: true, // Matches text anywhere in the string
            keys: SEARCHABLE_FIELDS_AND_WEIGHTS
        };

        const preComputedIndex = Fuse.parseIndex(fuseIndexStructure);
        fuseInstance = new Fuse(globalImageDatabase, searchOptions, preComputedIndex);
        
        isWorkerReady = true;

        // Tell the main thread we are ready to accept queries
        self.postMessage({
            type: 'READY',
            payload: {
                count: globalImageDatabase.length,
                hasEmbeddings: !!semanticEmbeddingsMap
            }
        });

        // Send the complete list of images so the UI can show them immediately on load
        self.postMessage({ 
            type: 'RESULTS', 
            payload: { results: globalImageDatabase, isFullList: true } 
        });

    } catch (err) {
        console.error('[WORKER] Initialization Error:', err);
        self.postMessage({ type: 'ERROR', payload: err.message });
    }
}

// ============================================================================
// 5. CORE SEARCH FUNCTIONS
// ============================================================================

/**
 * Standard Keyword Search (Uses Fuse.js)
 */
function runKeywordSearch(queryString) {
    if (!isWorkerReady || !fuseInstance) return;

    // If query is empty, return the entire database
    if (!queryString || queryString.trim() === '') {
        self.postMessage({ type: 'RESULTS', payload: { results: globalImageDatabase, isFullList: true } });
        return;
    }

    const fuseResults = fuseInstance.search(queryString);
    const flattenedResults = fuseResults.map(entry => entry.item);

    self.postMessage({ 
        type: 'RESULTS', 
        payload: { results: flattenedResults, isFullList: false } 
    });
}

// WHAT: Threshold constants to eliminate non-relevant images from semantic vector queries.
// WHY: Without a threshold, every single image in the database is returned regardless of relevance,
// filling infinite scroll pagination with unrelated images that the user already saw in the catalog.
const minimum_cosine_similarity_threshold_score = 0.35;
const maximum_semantic_candidate_results_limit = 250;

/**
 * Semantic Vector Search (Uses Cosine Similarity with Threshold Filtering)
 */
function runSemanticSearch(query_embedding_vector) {
    // WHAT: Guarding against uninitialized vector embedding index.
    // WHY: Semantic search cannot proceed without the pre-computed mathematical representations of images.
    if (!semanticEmbeddingsMap) {
        console.error('[WORKER] Semantic search requested but no embeddings loaded.');
        self.postMessage({ type: 'RESULTS', payload: { results: [], isFullList: false } });
        return;
    }

    if (!query_embedding_vector || query_embedding_vector.length === 0) return;

    const matched_results_with_scores_collection = [];

    // WHAT: Pre-calculating the Euclidean vector magnitude of our search query embedding.
    // WHY: Pre-computing this scalar value once avoids redundant O(N) operations inside the database comparison loop.
    const query_embedding_magnitude_value = Math.sqrt(Math.sumPrecise(query_embedding_vector.map(dimension_value => dimension_value * dimension_value)));

    // WHAT: Iterating through every image record in the database and measuring angular similarity.
    // WHY: Cosine similarity compares the concept direction between the search prompt and image contents.
    for (const current_image_record of globalImageDatabase) {
        const current_image_embedding_vector = semanticEmbeddingsMap[current_image_record.id];
        if (current_image_embedding_vector) {
            const calculated_similarity_score = calculateCosineSimilarity(query_embedding_vector, current_image_embedding_vector, query_embedding_magnitude_value);
            // WHAT: Discarding images below the minimum semantic match threshold.
            // WHY: Prevents conceptually unrelated images from polluting the search results and pagination stream.
            if (calculated_similarity_score >= minimum_cosine_similarity_threshold_score) {
                matched_results_with_scores_collection.push({ item: current_image_record, score: calculated_similarity_score });
            }
        }
    }

    // WHAT: Sorting semantic matches in descending order by similarity score and capping candidates.
    // WHY: The most relevant images appear first, and capping bounds memory and downstream fusion costs.
    matched_results_with_scores_collection.sort((first_candidate, second_candidate) => second_candidate.score - first_candidate.score);

    const filtered_and_sorted_semantic_images = matched_results_with_scores_collection
        .slice(0, maximum_semantic_candidate_results_limit)
        .map(matched_candidate_entry => matched_candidate_entry.item);

    self.postMessage({ type: 'RESULTS', payload: { results: filtered_and_sorted_semantic_images, isFullList: false } });
}

/**
 * Hybrid Search (The "Exa Canon" Pattern with Strict Thresholding)
 * Runs keyword and semantic search in parallel and fuses their rankings.
 */
function runHybridSearch(raw_query_string, query_embedding_vector) {
    if (!isWorkerReady) return;

    console.log('[WORKER] Executing Hybrid Retrieval (Keyword + Semantic Paths)');

    // WHAT: Path A - Evaluating keyword relevance using Fuse.js fuzzy matching.
    // WHY: Captures literal token matches (filenames, specific named entities, exact tags).
    let keyword_matched_image_results = [];
    if (fuseInstance && raw_query_string && raw_query_string.trim() !== '') {
        keyword_matched_image_results = fuseInstance.search(raw_query_string).map(search_result_entry => search_result_entry.item);
    }

    // WHAT: Path B - Evaluating semantic conceptual similarity using embedding vectors.
    // WHY: Captures abstract concepts and semantic synonyms that keyword fuzzy matching misses.
    let semantic_matched_image_results = [];
    if (semanticEmbeddingsMap && query_embedding_vector && query_embedding_vector.length > 0) {
        const thresholded_semantic_matches = [];
        const query_embedding_magnitude_value = Math.sqrt(Math.sumPrecise(query_embedding_vector.map(dimension_value => dimension_value * dimension_value)));

        for (const current_image_record of globalImageDatabase) {
            const current_image_embedding_vector = semanticEmbeddingsMap[current_image_record.id];
            if (current_image_embedding_vector) {
                const calculated_similarity_score = calculateCosineSimilarity(query_embedding_vector, current_image_embedding_vector, query_embedding_magnitude_value);
                if (calculated_similarity_score >= minimum_cosine_similarity_threshold_score) {
                    thresholded_semantic_matches.push({ 
                        item: current_image_record, 
                        score: calculated_similarity_score 
                    });
                }
            }
        }
        thresholded_semantic_matches.sort((first_candidate, second_candidate) => second_candidate.score - first_candidate.score);
        semantic_matched_image_results = thresholded_semantic_matches
            .slice(0, maximum_semantic_candidate_results_limit)
            .map(matched_candidate_entry => matched_candidate_entry.item);
    }

    // WHAT: Fusing keyword and semantic candidate lists using Reciprocal Rank Fusion (RRF).
    // WHY: RRF normalizes distinct ranking scoring spaces without requiring arbitrary weight calibration.
    let fused_hybrid_search_results;
    if (keyword_matched_image_results.length > 0 && semantic_matched_image_results.length > 0) {
        fused_hybrid_search_results = fuseRankedListsUsingRRF(keyword_matched_image_results, semantic_matched_image_results);
        console.log(`[WORKER] RRF Hybrid Fusion: ${keyword_matched_image_results.length} keyword, ${semantic_matched_image_results.length} semantic merged.`);
    } else if (keyword_matched_image_results.length > 0) {
        fused_hybrid_search_results = keyword_matched_image_results;
    } else if (semantic_matched_image_results.length > 0) {
        fused_hybrid_search_results = semantic_matched_image_results;
    } else {
        // WHAT: Returning an empty result set if neither search path found any matches for the query.
        // WHY: If a user searches for an unknown term, we must show 0 results rather than dumping
        // all 11,369 images from the database, which caused previously seen images to flood the pagination.
        const is_query_string_empty = !raw_query_string || raw_query_string.trim() === '';
        const is_query_vector_empty = !query_embedding_vector || query_embedding_vector.length === 0;
        if (is_query_string_empty && is_query_vector_empty) {
            fused_hybrid_search_results = globalImageDatabase;
        } else {
            fused_hybrid_search_results = [];
        }
    }

    self.postMessage({ type: 'RESULTS', payload: { results: fused_hybrid_search_results, isFullList: false } });
}

// ============================================================================
// 6. MATHEMATICAL UTILITIES
// ============================================================================

/**
 * Cosine Similarity measures the angle between two vectors.
 * If they point in the same direction, the concepts are similar.
 */
function calculateCosineSimilarity(vectorA, vectorB, magnitudeA) {
    // 1. Dot Product (sum of multiplied elements)
    const dotProduct = Math.sumPrecise(vectorA.map((val, i) => val * vectorB[i]));
    
    // 2. Magnitude of Vector B
    const magnitudeB = Math.sqrt(Math.sumPrecise(vectorB.map(val => val * val)));

    // Prevent division by zero if a vector is empty/corrupt
    if (magnitudeA === 0 || magnitudeB === 0) return 0;

    // 3. Result = (A dot B) / (||A|| * ||B||)
    return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * RECIPROCAL RANK FUSION (RRF)
 * This is a famous algorithm for merging two lists that used different scoring systems.
 * 
 * WHY USE RRF?
 * Keyword search returns a "Fuzziness Score". Semantic search returns "Similarity".
 * You can't just add these together (apples to oranges).
 * 
 * RRF ignores the "scores" and only looks at the "rank" (position 1, 2, 3...) in the list.
 * A document that is #1 in both lists gets a huge boost.
 */
const RRF_RANK_CONSTANT = 60; // Standard value used in research

function fuseRankedListsUsingRRF(listA, listB) {
    const combinedScoreMap = new Map(); // ImageID -> { item, combinedScore }

    // Factor in the ranking from the first list
    listA.forEach((item, indexInList) => {
        const id = String(item.id);
        const rrfContribution = 1 / (RRF_RANK_CONSTANT + indexInList);
        combinedScoreMap.set(id, { item, score: rrfContribution });
    });

    // Factor in the ranking from the second list
    listB.forEach((item, indexInList) => {
        const id = String(item.id);
        const rrfContribution = 1 / (RRF_RANK_CONSTANT + indexInList);
        
        if (combinedScoreMap.has(id)) {
            // If the image was in both lists, add the scores together!
            combinedScoreMap.get(id).score += rrfContribution;
        } else {
            combinedScoreMap.set(id, { item, score: rrfContribution });
        }
    });

    // Final sorting: highest accumulated RRF score wins.
    const sortedEntries = Array.from(combinedScoreMap.values());
    sortedEntries.sort((a, b) => b.score - a.score);

    return sortedEntries.map(entry => entry.item);
}

/**
 * Allows the user to change settings (e.g. fuzziness slider) without 
 * having to re-download the multi-megabyte data files.
 */
function updateSearchConfiguration(newConfig) {
    if (fuseInstance && newConfig.fuzziness !== undefined) {
        const updatedOptions = {
            includeScore: true,
            threshold: newConfig.fuzziness,
            ignoreLocation: true,
            keys: SEARCHABLE_FIELDS_AND_WEIGHTS
        };
        
        // We reuse the pre-computed index for efficiency!
        const existingIndex = fuseInstance.getIndex(); 
        fuseInstance = new Fuse(globalImageDatabase, updatedOptions, existingIndex);
        console.log(`[WORKER] Config Updated: Fuzziness = ${newConfig.fuzziness}`);
    }
}
