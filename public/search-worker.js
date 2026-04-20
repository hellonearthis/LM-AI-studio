/*
 * Search Worker
 * Offloads Fuse.js search logic to a background thread to keep the UI responsive.
 * - Loads 'search-index.json' (pre-computed index)
 * - Loads 'search-data.json' (lightweight data)
 * - Runs search queries and returns results
 */

// Import Fuse.js (Available in public/libs/fuse.min.js)
// Import Fuse.js (Available in public/libs/fuse.min.js)
importScripts('libs/fuse.min.js');

// ============================================================================
// POLYFILLS
// ============================================================================
if (typeof Math.sumPrecise !== 'function') {
    /**
     * Polyfill for ES2026 Math.sumPrecise
     * Note: This fallback uses standard reduce, so it won't have the same 
     * precision guarantees as the native implementation if available.
     */
    Math.sumPrecise = function (iterable) {
        let sum = 0;
        for (const value of iterable) {
            sum += Number(value);
        }
        return sum;
    };
    console.warn('[WORKER] Math.sumPrecise not natively supported, using standard fallback.');
}

let fuse = null;
let allImages = [];
let embeddingsMap = null; // ID -> Vector
let isReady = false;

// ... [Existing search keys] ...
const SEARCH_KEYS = [
    { name: 'filename', weight: 1 },
    { name: 'analysis.summary', weight: 1 },
    { name: 'analysis.objects', weight: 2 },
    { name: 'analysis.tags', weight: 2 }
];

self.onmessage = async function (e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'INIT':
            await initSearch(payload.fuzziness || 0.2);
            break;

        case 'SEARCH':
            performSearch(payload.query, payload.options);
            break;

        case 'SEMANTIC_SEARCH':
            performSemanticSearch(payload.vector);
            break;

        case 'UPDATE_CONFIG':
            if (fuse && payload.fuzziness !== undefined) {
                const options = {
                    includeScore: true,
                    threshold: payload.fuzziness,
                    ignoreLocation: true,
                    keys: SEARCH_KEYS
                };
                const index = fuse.getIndex(); // Reuse the Fuse Index!
                fuse = new Fuse(allImages, options, index);
            }
            break;
    }
};

async function initSearch(fuzziness) {
    try {
        console.log('[WORKER] Initializing...');

        // Parallel fetch of Index, Data, AND Embeddings
        // Note: Embeddings might be 404 if script hasn't run, handle gracefully
        const [indexRes, dataRes, embedRes] = await Promise.all([
            fetch('search-index.json?t=' + Date.now()),
            fetch('search-data.json?t=' + Date.now()),
            fetch('search-embeddings.json?t=' + Date.now()).catch(e => ({ ok: false }))
        ]);

        if (!indexRes.ok || !dataRes.ok) {
            throw new Error('Failed to load search resources');
        }

        const fuseIndexData = await indexRes.json();
        allImages = await dataRes.json();

        // Load Embeddings if available
        if (embedRes.ok) {
            try {
                embeddingsMap = await embedRes.json();
                console.log(`[WORKER] Loaded embeddings for ${Object.keys(embeddingsMap).length} items.`);
            } catch (e) {
                console.warn('[WORKER] Failed to parse search-embeddings.json');
            }
        } else {
            console.warn('[WORKER] search-embeddings.json not found. Semantic search will be unavailable.');
        }

        // Parse Fuse Index
        const fuseIndex = Fuse.parseIndex(fuseIndexData);

        // Initialize Fuse with Index and Data
        const options = {
            includeScore: true,
            threshold: fuzziness,
            ignoreLocation: true,
            keys: SEARCH_KEYS
        };

        fuse = new Fuse(allImages, options, fuseIndex);
        isReady = true;

        console.log(`[WORKER] Ready. Loaded ${allImages.length} items.`);

        // Notify main thread
        self.postMessage({
            type: 'READY',
            payload: {
                count: allImages.length,
                hasEmbeddings: !!embeddingsMap
            }
        });

        // Send initial "all data" back so UI can render default view
        self.postMessage({ type: 'RESULTS', payload: { results: allImages, isFullList: true } });

    } catch (err) {
        console.error('[WORKER] Init Failed:', err);
        self.postMessage({ type: 'ERROR', payload: err.message });
    }
}

function performSearch(query, options = {}) {
    if (!isReady || !fuse) return;

    if (!query || query.trim() === '') {
        self.postMessage({ type: 'RESULTS', payload: { results: allImages, isFullList: true } });
        return;
    }

    // Run Fuse Search
    const searchResults = fuse.search(query);
    const results = searchResults.map(res => res.item);

    self.postMessage({ type: 'RESULTS', payload: { results: results, isFullList: false } });
}

function performSemanticSearch(queryVector) {
    if (!embeddingsMap) {
        console.error('[WORKER] Embeddings not loaded');
        self.postMessage({ type: 'RESULTS', payload: { results: [], isFullList: false } });
        return;
    }

    if (!queryVector || queryVector.length === 0) return;

    // Calculate Cosine Similarity for each image
    // Map is ID -> Vector
    const matches = [];

    // Pre-calculate query magnitude (optimization)
    // Use Math.sumPrecise for better precision in vector space
    const queryMag = Math.sqrt(Math.sumPrecise(queryVector.map(val => val * val)));

    for (const img of allImages) {
        const imgVector = embeddingsMap[img.id];
        if (imgVector) {
            const sim = cosineSimilarity(queryVector, imgVector, queryMag);
            // Threshold? Maybe 0.3? Let's just return sorted and let UI trunc/paginate
            matches.push({ item: img, score: sim });
        }
    }

    // Sort by Similarity DESC
    matches.sort((a, b) => b.score - a.score);

    // Limit to top 200 to save bandwidth? Or just return all sorted?
    // Let's return all, UI pagination handles it.
    const results = matches.map(m => m.item);

    self.postMessage({ type: 'RESULTS', payload: { results: results, isFullList: false } });
}

function cosineSimilarity(vecA, vecB, magA) {
    // Dot Product - use Math.sumPrecise to minimize floating point accumulation error
    const dot = Math.sumPrecise(vecA.map((val, i) => val * vecB[i]));
    
    // Vector B Magnitude
    const magB = Math.sqrt(Math.sumPrecise(vecB.map(val => val * val)));

    if (magA === 0 || magB === 0) return 0;
    return dot / (magA * magB);
}

