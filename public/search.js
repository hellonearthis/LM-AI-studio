// ============================================================================
// SEARCH PAGE LOGIC
// ============================================================================
/**
 * Handles all logic for the search.html page.
 * Includes:
 * - Fuse.js fuzzy search initialization and execution
 * - Search rendering with infinite scroll (IntersectionObserver)
 * - Filtering by date and scene type
 * - Inline tag management and file operations
 */

const searchQuery = document.getElementById('searchQuery');
const negativeQuery = document.getElementById('negativeQuery'); // New input
const sceneType = document.getElementById('sceneType');
const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const searchLogicToggle = document.getElementById('searchLogicToggle');
const logicLabel = document.getElementById('logicLabel');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const resultsCount = document.getElementById('resultsCount');
const API_BASE_URL = 'http://localhost:3000';

// ============================================================================
// TAG & OBJECT FILTER STATE
// ============================================================================
const tagFilterInput = document.getElementById('tagFilterInput');
const tagAutocomplete = document.getElementById('tagAutocomplete');
const tagFilterChips = document.getElementById('tagFilterChips');
const similarBanner = document.getElementById('similarBanner');
const similarBannerName = document.getElementById('similarBannerName');
const clearSimilarBtn = document.getElementById('clearSimilarBtn');

const selectedTagFilters = new Set();   // Exact tag names
const selectedObjectFilters = new Set(); // Exact object names
let allKnownTags = [];    // [{name, count, type:'tag'}, ...]
let allKnownObjects = [];  // [{name, count, type:'object'}, ...]
let acActiveIndex = -1;   // Keyboard nav index for autocomplete

// Helper: Deduplicate tags and objects
function deduplicateTags(analysis) {
    if (!analysis) return;
    
    // Helper: Normalize by removing plurals, brackets, and extra spaces
    const normalize = (s) => String(s).trim().toLowerCase().replace(/[\[\]\(\)\{\}]/g, '').replace(/\s+/g, ' ').trim().replace(/s$/, '');

    if (Array.isArray(analysis.objects)) {
        // Initial cleaning
        let objects = analysis.objects
            .map(o => String(o).trim())
            .filter(o => o.length > 0 && o.length < 100 && o.split(/\s+/).length <= 8);

        // Case-insensitive distinct
        const seen = new Set();
        analysis.objects = objects.filter(o => {
            const norm = normalize(o);
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });
    }
    
    if (Array.isArray(analysis.tags)) {
        // 1. Initial cleaning (Length and Word Count limits)
        let tags = analysis.tags
            .map(t => String(t).trim())
            .filter(t => t.length > 0 && t.length < 120 && t.split(/\s+/).length <= 10);

        // 2. Case-insensitive and Plural-insensitive deduplication
        const seen = new Set();
        tags = tags.filter(t => {
            const norm = normalize(t);
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });

        // 3. Substring / Recursive pruning:
        tags.sort((a, b) => a.length - b.length); 

        const finalTags = [];
        for (const tag of tags) {
            const normTag = normalize(tag);
            const isRedundant = finalTags.some(existing => {
                const normExisting = normalize(existing);
                if (normTag.length > 5 && normExisting.length > 5) {
                    if (normTag.includes(normExisting) || normExisting.includes(normTag)) return true;
                }
                return false;
            });
            if (!isRedundant) finalTags.push(tag);
        }

        analysis.tags = finalTags;

        // 4. Remove tags that are already represented as objects
        if (Array.isArray(analysis.objects)) {
            const objectNorms = new Set(analysis.objects.map(normalize));
            analysis.tags = analysis.tags.filter(tag => !objectNorms.has(normalize(tag)));
        }
    }
}

// State
let allImages = []; // We keep a local copy for filtering date/scene types quickly if needed, or we rely on worker results.
// Actually, worker sends back "results" (which are full objects from search-data.json). 
// So we update this list based on search results.
let searchWorker = null;
let isInitialized = false;

// State for pagination
let filteredImages = [];
let currentIndex = 0;
let isRendering = false; // Prevents concurrent batch rendering
let selectedIds = new Set();
const BATCH_SIZE = 50;
let observer = null;
const sentinel = document.getElementById('scroll-sentinel');

// Toggle Label Update
const fuzzinessSlider = document.getElementById('fuzzinessSlider');
const fuzzinessValue = document.getElementById('fuzzinessValue');
const semanticToggle = document.getElementById('semanticToggle'); // Hidden compat checkbox
const searchModeHint = document.getElementById('searchModeHint');

// Search Mode Helper
function getSearchMode() {
    const checked = document.querySelector('input[name="searchMode"]:checked');
    return checked ? checked.value : 'keyword';
}

const SEARCH_MODE_HINTS = {
    keyword: 'Fuzzy keyword matching on summaries, tags, and objects.',
    hybrid: '⚡ Combines keyword + semantic search via Reciprocal Rank Fusion.',
    semantic: '🧠 AI concept search using embedding similarity.'
};

// Scope Elements
const scopeAnalysis = document.getElementById('scopeAnalysis');
const scopeObjects = document.getElementById('scopeObjects');
const scopeTags = document.getElementById('scopeTags');

// Update Fuzziness Label
const sortOrder = document.getElementById('sortOrder');

fuzzinessSlider.addEventListener('input', () => {
    fuzzinessValue.textContent = fuzzinessSlider.value;
});

// Update Search on Slider Change
fuzzinessSlider.addEventListener('change', () => {
    const mode = getSearchMode();
    if (mode === 'semantic') return; // Fuzziness not relevant for pure semantic

    if (searchWorker) {
        searchWorker.postMessage({
            type: 'UPDATE_CONFIG',
            payload: { fuzziness: parseFloat(fuzzinessSlider.value) }
        });
        executeSearchQuery();
    }
});

// Search Mode Radio Listeners
document.querySelectorAll('input[name="searchMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        // Sync hidden checkbox for backward compat
        const mode = getSearchMode();
        if (semanticToggle) semanticToggle.checked = (mode === 'semantic' || mode === 'hybrid');
        updateSearchModeUI();
        executeSearchQuery();
    });
});

// Update Search on Scope/Filter Change
[scopeAnalysis, scopeObjects, scopeTags, sortOrder, negativeQuery, document.getElementById('dataStatus')].forEach(el => {
    if (el) {
        el.addEventListener('change', () => {
            if (el === sortOrder || el === negativeQuery) {
                executeSearchQuery();
            } else {
                const mode = getSearchMode();
                if (mode === 'keyword' || mode === 'hybrid') {
                    executeSearchQuery();
                }
            }
        });
    }
});

function updateSearchModeUI() {
    const mode = getSearchMode();
    const isPureSemantic = (mode === 'semantic');

    // Disable/Dim Fuzziness & Scope (Not used in pure Semantic)
    fuzzinessSlider.disabled = isPureSemantic;
    scopeAnalysis.disabled = isPureSemantic;
    scopeObjects.disabled = isPureSemantic;
    scopeTags.disabled = isPureSemantic;

    // Visual feedback
    const opacity = isPureSemantic ? '0.5' : '1';
    document.querySelector('.fuzziness-container').style.opacity = opacity;
    document.querySelector('.scope-container').style.opacity = opacity;

    // Update hint text
    if (searchModeHint) {
        searchModeHint.textContent = SEARCH_MODE_HINTS[mode] || '';
    }

    // Force Sort to Relevance if semantic or hybrid
    if (mode === 'semantic' || mode === 'hybrid') {
        sortOrder.value = 'relevance';
    }
}

// Allow Enter key in negative query
if (negativeQuery) {
    negativeQuery.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') executeSearchQuery();
    });
}

/**
 * INITIALIZATION: The Search Engine Handshake
 * 
 * This function sets up the communication bridge between the browser and 
 * our background Search Worker. We do this primarily to keep the main 
 * interface responsive during heavy computations.
 */
function initializeSearchSystem() {
    if (isInitialized) return;

    // Give visual feedback that the heavy lifing is starting
    searchBtn.disabled = true;
    searchBtn.textContent = 'Preparing Search Engine...';

    // The PretextLayout engine helps us calculate the exact height of 
    // AI summaries so the grid doesn't "jump" when images load.
    if (window.PretextLayout) {
        window.PretextLayout.init();
    }

    // Step 1: Handle any filters passed in the URL (e.g. from the Tags page)
    processUrlParams();

    // Step 2: Spawn the background thread
    searchWorker = new Worker('search-worker.js');

    // Step 3: Listen for signals from the worker
    searchWorker.onmessage = function (event) {
        const { type, payload } = event.data;

        switch (type) {
            case 'READY':
                // The worker has finished parsing the multi-megabyte JSON indexes
                console.log(`[MAIN] Search Engine Ready. Items: ${payload.count}. Semantic: ${payload.hasEmbeddings}`);
                isInitialized = true;
                searchBtn.disabled = false;
                searchBtn.textContent = 'Search Images';

                // FEATURE DETECTION: If the user hasn't generated embeddings yet, 
                // we hide the Hybrid and Semantic search options to prevent confusion.
                if (!payload.hasEmbeddings) {
                    document.querySelectorAll('input[name="searchMode"]').forEach(radio => {
                        if (radio.value === 'hybrid' || radio.value === 'semantic') {
                            radio.disabled = true;
                        }
                    });
                    const modeSelectorGroup = document.querySelector('.search-mode-selector')?.closest('.filter-group');
                    if (modeSelectorGroup) {
                        modeSelectorGroup.title = "Hybrid & Semantic modes require embeddings. Click 'Generate Data' first.";
                    }
                } else {
                    // CONVENIENCE: If embeddings exist, default to the best mode (Hybrid)
                    const hybridRadio = document.querySelector('input[name="searchMode"][value="hybrid"]');
                    if (hybridRadio && !hybridRadio.disabled) {
                        hybridRadio.checked = true;
                        if (semanticToggle) semanticToggle.checked = true;
                        updateSearchModeUI();
                    }
                }

                // Always run an initial search to populate the grid
                executeSearchQuery();
                break;

            case 'RESULTS':
                // The worker found some matches! Now we display them.
                processAndDisplayMatches(payload.results);
                break;

            case 'ERROR':
                console.error('[MAIN] Search Engine Error:', payload);
                searchResults.innerHTML = '<div class="error-msg">Failed to load search index.</div>';
                searchBtn.disabled = false;
                searchBtn.textContent = 'Retry Engine Load';
                break;
        }
    };

    // Step 4: Tell the worker to start loading data
    searchWorker.postMessage({
        type: 'INIT',
        payload: { fuzziness: parseFloat(fuzzinessSlider.value) }
    });
}

/**
 * RESULTS HANDLING: From Background Task to Visual Grid
 * 
 * The Worker sends us a list of "text-relevance" matches. We then 
 * apply local "client-side" filters (like Date or Scene Type) before 
 * showing the final results to the user.
 */
function processAndDisplayMatches(rawWorkerResults) {
    // 1. Temporarily store the raw results (useful for local context lookups)
    lastWorkerResults = rawWorkerResults;

    // 2. Apply "Client-Side" Filters
    // We do things like Date Range and Scene Type here in the main thread
    // because they are lightweight and change frequently based on user clicks.
    const finalFilteredResults = applyLocalClientFilters(rawWorkerResults);

    // 3. Prepare the Infinite Scroll state
    window.currentSearchResults = finalFilteredResults;
    filteredImages = finalFilteredResults;
    currentIndex = 0; // Reset scroll position to the top
    searchResults.innerHTML = ''; // Wipe the previous grid

    // 4. Update the UI Count
    resultsCount.textContent = `Found ${finalFilteredResults.length} results`;
    searchBtn.disabled = false;
    searchBtn.textContent = 'Search Images';

    if (finalFilteredResults.length === 0) {
        searchResults.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 4rem 2rem;">
                <div style="font-size: 3rem; margin-bottom: 1rem;">🔍</div>
                <div style="color: var(--text-secondary); font-size: 1.1rem;">No images found matching your current filters.</div>
                <button class="action-btn" style="margin-top: 1rem;" onclick="location.reload()">Clear All Filters</button>
            </div>`;
    } else {
        // 5. Start the batch-rendering process
        setupInfiniteScrollObserver();
        renderNextBatchOfResults();
    }
}

/**
 * CLIENT-SIDE FILTERING: Precision Slicing
 * 
 * While the Worker handles "Fuzzy Search" and "AI Vector Search", 
 * this function handles the sharp, binary filters: "Is it a Portrait?", 
 * "Is it from 2024?", "Does it NOT contain 'cats'?".
 */
function applyLocalClientFilters(baseResultSet) {
    const negativeQueryText = negativeQuery ? negativeQuery.value.trim() : '';
    const activeSceneType = sceneType.value;
    const dataStatusFilter = document.getElementById('dataStatus')?.value || 'all';
    const startDateFilter = startDate.value;
    const endDateFilter = endDate.value;
    const activeSortMode = sortOrder ? sortOrder.value : 'newest';
    const activeSearchQuery = searchQuery.value.trim();

    // Prepare negative terms for fast lookup
    const negativeTermsArray = negativeQueryText 
        ? negativeQueryText.toLowerCase().split(/\s+/).filter(term => term.length > 0) 
        : [];

    let filteredSet = baseResultSet.filter(imageRecord => {
        
        // --- FILTER 1: Exact Tag/Object Chips ---
        if (selectedTagFilters.size > 0 || selectedObjectFilters.size > 0) {
            const analysis = imageRecord.analysis || {};
            const imageTags = (analysis.tags || []).map(t => t.toLowerCase());
            const imageObjects = (analysis.objects || []).map(o => o.toLowerCase());
            
            // Map the selected filters into a standardized search structure
            const activeFilterRequirements = [
                ...Array.from(selectedTagFilters).map(tagName => ({ name: tagName.toLowerCase(), source: imageTags })),
                ...Array.from(selectedObjectFilters).map(objName => ({ name: objName.toLowerCase(), source: imageObjects }))
            ];

            const matchLogicMode = document.querySelector('input[name="tagLogic"]:checked')?.value || 'AND';

            if (matchLogicMode === 'AND') {
                // "Match All": Every single selected chip must exist on the image
                if (!activeFilterRequirements.every(req => req.source.includes(req.name))) return false;
            } else {
                // "Match Any": If even one chip matches, the image is passed through
                if (!activeFilterRequirements.some(req => req.source.includes(req.name))) return false;
            }
        }

        // --- FILTER 2: Negative Search ("Subtract" concepts) ---
        if (negativeTermsArray.length > 0) {
            const analysis = imageRecord.analysis || {};
            const searchableBlob = [
                imageRecord.filename,
                analysis.summary,
                ...(analysis.objects || []),
                ...(analysis.tags || []),
                analysis.scene_type
            ].join(' ').toLowerCase();

            // If the image contains ANY of the negative keywords, we discard it
            if (negativeTermsArray.some(badTerm => searchableBlob.includes(badTerm))) return false;
        }

        // --- FILTER 3: Scene Type (Indoor, Nature, etc.) ---
        if (activeSceneType !== 'all') {
            const imageScene = (imageRecord.analysis && imageRecord.analysis.scene_type) || '';
            if (imageScene.toLowerCase() !== activeSceneType.toLowerCase()) return false;
        }

        // --- FILTER 4: Date Range (Time-traveling search) ---
        const imageCreationTime = new Date(imageRecord.created_at);
        if (startDateFilter && imageCreationTime < new Date(startDateFilter)) return false;
        if (endDateFilter) {
            const endOfDay = new Date(endDateFilter);
            endOfDay.setHours(23, 59, 59); // Include the entire end date
            if (imageCreationTime > endOfDay) return false;
        }

        // --- FILTER 5: Data Hygiene (Finding missing AI data) ---
        if (dataStatusFilter !== 'all') {
            const analysis = imageRecord.analysis || {};
            const hasTags = Array.isArray(analysis.tags) && analysis.tags.length > 0;
            const hasObjects = Array.isArray(analysis.objects) && analysis.objects.length > 0;
            const hasScene = !!analysis.scene_type && analysis.scene_type !== 'unknown';
            const hasSummary = !!analysis.summary && analysis.summary.length > 0;

            if (dataStatusFilter === 'missing-any' && (hasTags && hasObjects && hasScene && hasSummary)) return false;
            if (dataStatusFilter === 'missing-tags' && hasTags) return false;
            if (dataStatusFilter === 'missing-objects' && hasObjects) return false;
            if (dataStatusFilter === 'missing-badge' && hasScene) return false;
            if (dataStatusFilter === 'missing-summary' && hasSummary) return false;
        }

        return true;
    });

    // --- SORTING: Final Ordering ---
    filteredSet.sort((firstImage, secondImage) => {
        
        // RELEVANCE: If we have a query, the Worker already sorted them by score.
        // We preserve that order by returning 0 (no change).
        if (activeSortMode === 'relevance' && activeSearchQuery) {
            return 0; 
        }

        const dateA = new Date(firstImage.created_at || 0).getTime();
        const dateB = new Date(secondImage.created_at || 0).getTime();
        const updateA = firstImage.updated_at ? new Date(firstImage.updated_at).getTime() : dateA;
        const updateB = secondImage.updated_at ? new Date(secondImage.updated_at).getTime() : dateB;

        if (activeSortMode === 'oldest') {
            return dateA - dateB;
        } else if (activeSortMode === 'newest') {
            return updateB - updateA; // Newest edits/additions first
        } else {
            // Default "Relevance" fallback for non-query views is just Newest
            return updateB - updateA;
        }
    });

    return filteredSet;
}

/**
 * EXECUTION: The Central Search Orchestrator
 * 
 * This is the brain of the search page. It decides whether to use 
 * Keyword logic, AI Semantic logic, or the Hybrid merge.
 */
async function executeSearchQuery() {
    if (!isInitialized || !searchWorker) return;

    // Show a loading spinner so the user knows we are working
    searchBtn.disabled = true;
    searchBtn.innerHTML = '<div class="spinner"></div> Searching...';

    const rawQueryString = searchQuery.value.trim();
    const activeSearchMode = getSearchMode();

    // SCENARIO 1: HYBRID MODE (Keyword + Semantic)
    if (activeSearchMode === 'hybrid' && rawQueryString) {
        try {
            // First, we need to turn the user's text into a concept vector.
            // We ask our local server (which proxies to LM Studio) for the math.
            searchBtn.textContent = 'Generating Embedding...';
            const embedResponse = await fetch('/api/embed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: rawQueryString })
            });

            if (!embedResponse.ok) throw new Error('LM Studio failed to generate a search vector.');
            const vectorData = await embedResponse.json();

            // Now we send BOTH the text and the vector to the Worker.
            // It will run two searches in parallel and fuse them with RRF.
            searchBtn.textContent = 'Fusing Results...';
            searchWorker.postMessage({
                type: 'HYBRID_SEARCH',
                payload: { query: rawQueryString, vector: vectorData.embedding }
            });

        } catch (err) {
            console.error('Hybrid Search Failed:', err);
            // FAIL-SAFE: If the AI model isn't loaded, don't crash! 
            // Just drop back to reliable keyword search.
            console.warn('[MAIN] AI Engine offline. Falling back to Keyword search.');
            searchWorker.postMessage({
                type: 'SEARCH',
                payload: { query: rawQueryString }
            });
        }
    } 
    // SCENARIO 2: PURE SEMANTIC (AI Matches Only)
    else if (activeSearchMode === 'semantic' && rawQueryString) {
        try {
            searchBtn.textContent = 'Analyzing Concept...';
            const embedResponse = await fetch('/api/embed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: rawQueryString })
            });

            if (!embedResponse.ok) throw new Error('AI Engine unreachable.');
            const vectorData = await embedResponse.json();

            searchBtn.textContent = 'Comparing Concepts...';
            searchWorker.postMessage({
                type: 'SEMANTIC_SEARCH',
                payload: { vector: vectorData.embedding }
            });

        } catch (err) {
            console.error('Semantic Search Failed:', err);
            showAlertModal('AI search failed. Please ensure LM Studio is running. Error: ' + err.message, 'Concept Search Error');
            searchBtn.disabled = false;
            searchBtn.textContent = 'Search Images';
        }
    } 
    // SCENARIO 3: KEYWORD MODE (Fast & Familiar)
    else {
        // Just send the text to the worker for fuzzy matching (Fuse.js)
        searchWorker.postMessage({
            type: 'SEARCH',
            payload: { query: rawQueryString }
        });
    }
}

/**
 * Instantly populates the UI from URL parameters (q, type, similar)
 * Provides immediate visual feedback while the index loads.
 */
const urlParams = new URLSearchParams(window.location.search);

function processUrlParams() {
    const initialQuery = urlParams.get('q');
    const initialSimilar = urlParams.get('similar');
    const initialTag = urlParams.get('tag'); // Legacy support

    if (initialSimilar) {
        console.log(`[MAIN] Pre-populating 'similar' for ID: ${initialSimilar}`);
        findSimilar(initialSimilar); // This handles its own search execution
    } else if (initialQuery || initialTag) {
        const queryVal = initialQuery || initialTag;
        const decoded = decodeURIComponent(queryVal);
        const urlType = urlParams.get('type'); // 'tag' or 'object'
        console.log(`[MAIN] Pre-populating query: ${decoded}, type: ${urlType}`);

        // If 'tag' parameter is present but 'type' is missing, assume it's a tag filter
        const effectiveType = urlType || (initialTag ? 'tag' : null);

        if (effectiveType === 'tag' || effectiveType === 'object') {
            addTagFilter(decoded, effectiveType);
        } else {
            searchQuery.value = decoded;
        }
    }
}


// Refresh Data (Simplistic implementation: just reload page or re-init worker?)
// For now, re-init worker is safer to get fresh JSONs
function refreshData() {
    if (searchWorker) {
        searchWorker.terminate();
        isInitialized = false;
        initializeSearchSystem();
    }
}

function setupInfiniteScrollObserver() {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            renderNextBatchOfResults();
        }
    }, { rootMargin: '400px' });

    if (sentinel) observer.observe(sentinel);
}

/**
 * Renders the next set of search results from the 'filteredImages' list.
 * This utilizes infinite scroll via a scroll-sentinel.
 */
function renderNextBatchOfResults() {
    // 1. Guards: Prevent double-rendering or rendering past the end of results
    if (isRendering || currentIndex >= filteredImages.length) {
        if (currentIndex >= filteredImages.length && observer) observer.disconnect();
        return;
    }

    isRendering = true;
    const startIndex = currentIndex;
    const currentBatch = filteredImages.slice(startIndex, startIndex + BATCH_SIZE);
    currentIndex += currentBatch.length; 

    // 2. PRE-MEASUREMENT (The 'Why'):
    // Before rendering, we calculate the exact height of the AI summaries. 
    // This allows the masonry grid to calculate the positions of all cards 
    // before the images load, preventing layout shifts (CLS).
    let summaryHeightsMap = new Map();
    if (window.PretextLayout && window.PretextLayout.ready) {
        const gridWidth = searchResults.offsetWidth > 0 ? searchResults.offsetWidth : 1000;
        const colCount = Math.max(1, Math.floor((gridWidth + 16) / (320 + 16)));
        const actualCardWidth = (gridWidth - (colCount - 1) * 16) / colCount;
        const textWidth = actualCardWidth - 24; // Card padding (0.75rem * 2)

        const textItemsToMeasure = currentBatch.map(img => {
            const analysis = img.analysis || {};
            return { id: img.id, text: analysis.summary || '' };
        });

        summaryHeightsMap = window.PretextLayout.measureBatch(textItemsToMeasure, textWidth, 'search');
    }

    // 3. HTML GENERATION:
    // We convert the batch of images into HTML strings.
    let finalBatchHtml = '';
    const isFirstPage = (startIndex === 0);
    
    currentBatch.forEach((img, index) => {
        try {
            const measuredHeight = summaryHeightsMap.get(String(img.id));
            
            // INTELLIGENT LOADING (The 'Why'):
            // The first few search results are what the user sees first. 
            // Setting 'eager' load and 'high' priority ensures these images 
            // are requested immediately by the browser.
            const isPriorityImage = (isFirstPage && index === 0);
            const isEagerLoad = (isFirstPage && index < 4);
            
            finalBatchHtml += createResultHtml(img, measuredHeight, isPriorityImage, isEagerLoad);
        } catch (err) {
            console.error('Error rendering search result card:', img, err);
        }
    });

    // 4. Final UI Update
    searchResults.insertAdjacentHTML('beforeend', finalBatchHtml);
    isRendering = false;
}

// Factor out result HTML generation (similar to card creation in database.js)
// Helper: Measure pretext height for a single card update
function measureSingleCardHeight(img, context = 'search') {
    if (!window.PretextLayout || !window.PretextLayout.ready) return undefined;
    const analysis = img.analysis || {};
    const summaryText = analysis.summary || '';
    if (!summaryText) return undefined;

    let textWidth = 296; // Safe default
    const existingCard = document.querySelector(`.card[data-id="${img.id}"]`);
    if (existingCard && existingCard.clientWidth > 0) {
        textWidth = existingCard.clientWidth - 24;
    } else {
        const gridWidth = searchResults.offsetWidth > 0 ? searchResults.offsetWidth : 1000;
        const colCount = Math.max(1, Math.floor((gridWidth + 16) / (320 + 16)));
        const actualCardWidth = (gridWidth - (colCount - 1) * 16) / colCount;
        textWidth = actualCardWidth - 24;
    }
    const result = window.PretextLayout.measureText(summaryText, textWidth, context);
    return result.height;
}

const BRICKS_GRADS = ['purple', 'blue', 'green', 'orange', 'pink'];
function getCardGrad(id) {
    const numericId = typeof id === 'string' ? id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : id;
    return BRICKS_GRADS[numericId % BRICKS_GRADS.length];
}

function createResultHtml(img, summaryHeight, isPriority = false, isEager = false) {
    // Helper to escape HTML special characters
    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

    const date = new Date(img.created_at || Date.now()).toLocaleDateString();

    // Thumbnail path logic (ID-based)
    const timeStamp = img.updated_at ? new Date(img.updated_at).getTime() : (img.created_at ? new Date(img.created_at).getTime() : '');
    const displayPath = `thumbnails/id_${img.id}.avif${timeStamp ? '?t=' + timeStamp : ''}`;

    const analysis = img.analysis || {};
    const objects = analysis.objects || [];
    const tags = analysis.tags || [];
    const isSelected = selectedIds.has(String(img.id));

    return `
        <div class="card ${isSelected ? 'selected' : ''}" data-id="${img.id}" data-grad="${getCardGrad(img.id)}">
            <div class="card-inner">
                <!-- FRONT FACE -->
                <div class="card-front">
                    <div style="position: absolute; top: 0.75rem; right: 0.75rem; z-index: 5;">
                        <input type="checkbox" class="card-select-cb" data-id="${img.id}" ${isSelected ? 'checked' : ''} style="transform: scale(1.3); cursor: pointer;">
                    </div>
                    
                    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; padding-right: 1.5rem;">
                        <img src="${escapeHtml(displayPath)}" 
                             data-fullpath="${escapeHtml(img.path)}"
                             class="thumbnail-preview"
                             loading="${isEager ? 'eager' : 'lazy'}"
                             decoding="async"
                             ${isPriority ? 'fetchpriority="high"' : ''}
                             width="80"
                             height="80"
                             onerror="this.style.display='none'"
                             style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; cursor: pointer;"
                             title="Click to view full size">
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <h3 class="file-link" data-path="${escapeHtml(img.path)}" style="margin: 0; color: var(--accent); font-size: 1rem; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Show in folder">${escapeHtml(img.filename)}</h3>
                                <button class="delete-btn" data-id="${img.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.7rem; transition: all 0.2s; margin-left: 0.5rem;">X</button>
                            </div>
                            <small style="color: var(--text-secondary);">${date}</small>
                            <div style="margin-top: 0.25rem;">
                                <span class="badge" style="font-size: 0.7rem;">${escapeHtml(analysis.scene_type) || 'Unknown'}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div style="flex: 1;">
                        <p class="summary-text ${summaryHeight ? 'pretext-measured' : ''}" data-id="${img.id}" style="font-size: 0.9rem; color: var(--text-primary); margin: 0; line-height: 1.4;${summaryHeight ? ` min-height: ${summaryHeight}px;` : ''}">
                            <button class="copy-btn" data-text="${escapeHtml(analysis.summary || '')}" style="float: right; margin: 0.1rem 0 0.25rem 0.5rem; background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.75rem; white-space: nowrap;" title="Copy to clipboard">Copy</button>
                            ${escapeHtml(analysis.summary) || 'No summary available'}
                        </p>
                    </div>

                    <div style="margin-top: 1rem; text-align: right;">
                        <span style="font-size: 0.7rem; color: var(--text-secondary); opacity: 0.6;">Click card to reveal details ↻</span>
                    </div>
                </div>

                <!-- BACK FACE -->
                <div class="card-back">
                    <div class="tags-section">
                        <div class="tags-container" style="margin-bottom: 1rem;">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Detected Objects:</strong>
                            ${objects.map(obj => `<span class="tag editable" data-id="${img.id}" data-type="objects" data-tag="${escapeHtml(obj)}" title="Click to search, Right-click to edit" style="cursor: pointer; font-size: 0.75rem; background-color: rgba(16, 185, 129, 0.2); color: #34d399; margin-bottom: 4px;">${escapeHtml(obj)}</span>`).join('')}
                            <button class="add-tag-btn" data-id="${img.id}" data-type="objects" title="Add Object">+</button>
                        </div>
                        <div class="tags-container">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Image Tags:</strong>
                            ${tags.map(tag => `<span class="tag editable" data-id="${img.id}" data-type="tags" data-tag="${escapeHtml(tag)}" title="Click to search, Right-click to edit" style="cursor: pointer; font-size: 0.75rem; margin-bottom: 4px;">${escapeHtml(tag)}</span>`).join('')}
                            <button class="add-tag-btn" data-id="${img.id}" data-type="tags" title="Add Tag">+</button>
                        </div>
                    </div>
                    
                    <div style="margin-top: 2rem; text-align: center;">
                        <span style="font-size: 0.75rem; color: var(--accent); cursor: pointer; padding: 0.5rem; border: 1px solid var(--accent); border-radius: 6px;" onclick="this.closest('.card').classList.remove('flipped')">Back to Summary</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Override Load Stats to also init search
// Defer slightly to allow pretext module script to register on window
requestAnimationFrame(() => initializeSearchSystem());

// Event Listeners
if (searchBtn) {
    searchBtn.addEventListener('click', () => {
        executeSearchQuery();
    });
}
// Allow Enter key in search box
if (searchQuery) {
    searchQuery.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') executeSearchQuery();
    });
}

// Display Results
// Display Results removed, replaced by renderBatch and createResultHtml

// Global Event Listeners for Search Results (Delegation)
searchResults.addEventListener('click', (e) => {
    // Copy Button Click
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
        e.stopPropagation();
        const text = copyBtn.dataset.text;
        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                copyBtn.style.borderColor = 'var(--accent)';
                copyBtn.style.color = 'var(--accent)';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.borderColor = 'var(--border)';
                    copyBtn.style.color = 'var(--text-secondary)';
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy to clipboard', err);
            });
        }
        return;
    }

    // Thumbnail Click
    // Thumbnail Click
    if (e.target.classList.contains('thumbnail-preview')) {
        e.stopPropagation();
        const fullPath = e.target.dataset.fullpath;
        if (fullPath) showImagePreview(fullPath);
    }

    // Tag Click (Add to Filter)
    const tagEl = e.target.closest('.tag.editable');
    if (tagEl) {
        e.stopPropagation();
        const tagText = tagEl.dataset.tag;
        const dataType = tagEl.dataset.type; // 'tags' or 'objects'
        if (tagText) {
            const filterType = dataType === 'objects' ? 'object' : 'tag';
            addTagFilter(tagText, filterType);
        }
        return;
    }

    // Delete Button Click
    if (e.target.closest('.delete-btn')) {
        e.stopPropagation();
        const btn = e.target.closest('.delete-btn');
        const id = btn.dataset.id;

        // To support disk delete, we need the full path.
        const card = btn.closest('.card');
        const fullPath = card.querySelector('.file-link').dataset.path;

        showDeleteModal(id, fullPath, card);
    }

    // Add Tag Button Click
    if (e.target.closest('.add-tag-btn')) {
        e.stopPropagation();
        const btn = e.target.closest('.add-tag-btn');
        const id = btn.dataset.id;
        const type = btn.dataset.type; // 'tags' or 'objects'
        showAddTagInput(id, type, btn);
        return;
    }

    // NEW: Card Flip Toggle
    const card = e.target.closest('.card');
    if (card) {
        // Only flip if we didn't click an interactive element
        const isInteractive = e.target.closest('button, input, .file-link, .tag, .thumbnail-preview');
        if (!isInteractive) {
            card.classList.toggle('flipped');
        }
    }
});

// Show Delete Modal (matches database.js)
function showDeleteModal(id, fullPath, cardElement) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';
    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 500px; width: 90%;">
            <h2 style="margin: 0 0 1rem 0; color: var(--text-primary);">Delete Image</h2>
            <p style="margin: 0 0 1.5rem 0; color: var(--text-secondary);">How would you like to delete this image?</p>
            <div style="display: flex; flex-direction: column; gap: 1rem;">
                <button id="deleteDbBtn" style="background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Delete from Database Only</button>
                <button id="cancelBtn" style="background: #a1f0f0ff;border:2px solid var(--border);color: #240d00ff; font-size:2rem;font-weight:700;padding:1.75rem 1.75rem;border-radius:6px;cursor:pointer;margin-top:0.5rem;">Cancel</button>
                <button id="deleteDiskBtn" style="background: #ef4444; border: none; color: white; padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 600;">Delete from Computer & Database</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Cancel
    modal.querySelector('#cancelBtn').onclick = () => modal.remove();

    // DB Only
    modal.querySelector('#deleteDbBtn').onclick = async () => {
        modal.remove();
        await deleteFromDatabase(id, cardElement);
    };

    // Disk & DB
    modal.querySelector('#deleteDiskBtn').onclick = async () => {
        if (!window.electronAPI || !window.electronAPI.trashFile) {
            showAlertModal('Error: Electron API not available for file operations.', 'System Error');
            return;
        }

        try {
            await window.electronAPI.trashFile(fullPath);
            modal.remove();
            await deleteFromDatabase(id, cardElement);
        } catch (error) {
            console.error('Error deleting file from disk:', error);
            showAlertModal(`Failed to delete file from computer: ${error.message}`, 'File Error');
            modal.remove();
        }
    };

    // Close on background click
    modal.onclick = (e) => {
        if (e.target === modal) modal.remove();
    };
}

// Perform DB Deletion
async function deleteFromDatabase(id, cardElement) {
    try {
        const response = await fetch(`${API_BASE_URL}/images/${id}`, {
            method: 'DELETE'
        });

        if (response.ok || response.status === 404) {
            cardElement.style.opacity = '0';
            setTimeout(() => cardElement.remove(), 300);

            // Update count
            const countText = resultsCount.textContent;
            const currentCount = parseInt(countText.match(/\d+/)[0]);
            resultsCount.textContent = `Found ${Math.max(0, currentCount - 1)} results`;
        } else {
            showAlertModal('Failed to delete entry from database', 'Database Error');
        }
    } catch (error) {
        console.error('Error deleting from DB:', error);
        showAlertModal('Failed to delete entry from database: ' + error.message, 'Database Error');
    }
}

// ============================================================================
// TAG MANAGEMENT
// ============================================================================

const contextMenu = document.getElementById('contextMenu');
let ctxTarget = null; // { id, tag, type, card }

function showContextMenu(e, id, type, tag = null, card = null) {
    console.log('[DEBUG] showContextMenu called:', { id, type, tag });
    ctxTarget = { id, type, tag, card };
    contextMenu.style.display = 'block';



    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    // Show/Hide Items
    const regenItem = document.getElementById('ctxRegenThumb');
    const editItem = document.getElementById('ctxEdit');
    const deleteItem = document.getElementById('ctxDelete');
    const renameItem = document.getElementById('ctxRename');
    const editSummaryItem = document.getElementById('ctxEditSummary');
    const reparseSummaryItem = document.getElementById('ctxReparseSummary');
    const reAnalyzeItem = document.getElementById('ctxReAnalyze');

    if (type === 'thumbnail') {
        regenItem.style.display = 'block';
        editItem.style.display = 'none';
        deleteItem.style.display = 'none';
        if (renameItem) renameItem.style.display = 'none';
        if (editSummaryItem) editSummaryItem.style.display = 'none';
    } else if (type === 'file') {
        regenItem.style.display = 'none';
        editItem.style.display = 'none';
        deleteItem.style.display = 'none';
        if (renameItem) renameItem.style.display = 'block';
        if (editSummaryItem) editSummaryItem.style.display = 'none';
    } else if (type === 'summary') {
        regenItem.style.display = 'none';
        editItem.style.display = 'none';
        deleteItem.style.display = 'none';
        if (renameItem) renameItem.style.display = 'none';
        if (editSummaryItem) editSummaryItem.style.display = 'block';
        if (reparseSummaryItem) reparseSummaryItem.style.display = 'block';
        if (reAnalyzeItem) reAnalyzeItem.style.display = 'block';
    } else {
        regenItem.style.display = 'none';
        editItem.style.display = 'block';
        deleteItem.style.display = 'block';
        if (renameItem) renameItem.style.display = 'none';
        if (editSummaryItem) editSummaryItem.style.display = 'none';
        if (reparseSummaryItem) reparseSummaryItem.style.display = 'none';
        if (reAnalyzeItem) reAnalyzeItem.style.display = 'none';
    }
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
    ctxTarget = null;
}

// Global click to hide context menu
document.addEventListener('click', (e) => {
    hideContextMenu();
});

// Context Menu Event Listener (Handles both Thumbnails and Tags)
document.addEventListener('contextmenu', (e) => {
    // Thumbnail Right-Click
    const thumb = e.target.closest('.thumbnail-preview');
    if (thumb) {
        e.preventDefault();
        const card = thumb.closest('.card');
        const id = card.dataset.id;
        showContextMenu(e, id, 'thumbnail', null, card);
        return;
    }

    // Tag Right-Click
    const tagEl = e.target.closest('.tag.editable');
    if (tagEl) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e, tagEl.dataset.id, tagEl.dataset.type, tagEl.dataset.tag);
        return;
    }

    // Filename Right-Click
    const fileLink = e.target.closest('.file-link');
    if (fileLink) {
        e.preventDefault();
        e.stopPropagation();
        const card = fileLink.closest('.card');
        const id = card.dataset.id;
        const filename = fileLink.textContent.trim();
        showContextMenu(e, id, 'file', filename, card);
        console.log('Right clicked file');
        return;
    }

    // Description Right-Click
    const summaryEl = e.target.closest('.summary-text');
    if (summaryEl) {
        e.preventDefault();
        e.stopPropagation();
        const id = summaryEl.dataset.id;
        // Try to get clean text from cache instead of scraping innerText
        const img = (allImages.find(i => i.id == id)) || 
                    (window.currentSearchResults && window.currentSearchResults.find(i => i.id == id));
        const text = img ? img.analysis.summary : summaryEl.innerText.replace('Copy', '').trim();
        showContextMenu(e, id, 'summary', text);
        return;
    }

    hideContextMenu();
});

// Generate Embeddings Action
const generateEmbeddingsBtn = document.getElementById('generateEmbeddingsBtn');
const genProgress = document.getElementById('genProgress');

if (generateEmbeddingsBtn) {
    generateEmbeddingsBtn.addEventListener('click', async () => {
        showConfirmModal('This will generate embeddings for all images using LM Studio. This may take a while. Ensure LM Studio server is running with a TEXT EMBEDDING model loaded. Continue?', async () => {

            generateEmbeddingsBtn.disabled = true;
            generateEmbeddingsBtn.textContent = 'Generating...';
            if (genProgress) {
                genProgress.style.display = 'block';
                genProgress.textContent = 'Starting...';
            }

            try {
                const response = await fetch(`${API_BASE_URL}/maintenance/generate-embeddings`, { method: 'POST' });
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value);
                    // Update UI with latest chunk
                    if (genProgress) {
                        const current = genProgress.textContent;
                        const combined = current + text;
                        genProgress.textContent = combined.slice(-200); // Show trail
                    }
                }

                showAlertModal('Generation Complete!', 'Embeddings');
                refreshData(); // Reload worker to pick up new file
                fetchEmbeddingsStatus(); // Refresh the "Last updated" display

            } catch (err) {
                console.error('Generation Error:', err);
                showAlertModal('Error generating embeddings: ' + err.message, 'Generation Error');
            } finally {
                generateEmbeddingsBtn.disabled = false;
                generateEmbeddingsBtn.textContent = 'Generate Data';
                if (genProgress) setTimeout(() => genProgress.style.display = 'none', 5000);
            }
        }, 'Continue', 'var(--accent)');
    });
}

// Embeddings Status Display
const embeddingsStatusEl = document.getElementById('embeddingsStatus');

async function fetchEmbeddingsStatus() {
    if (!embeddingsStatusEl) return;
    try {
        const res = await fetch(`${API_BASE_URL}/api/embeddings-status`);
        if (!res.ok) throw new Error('Failed to fetch status');
        const data = await res.json();

        if (data.exists && data.count > 0) {
            const date = new Date(data.lastModified);
            const formatted = date.toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
            const sizeMB = (data.sizeBytes / (1024 * 1024)).toFixed(1);
            embeddingsStatusEl.innerHTML = `<span style="color: var(--accent);">●</span> ${data.count.toLocaleString()} embeddings · ${sizeMB} MB · Updated ${formatted}`;
        } else {
            embeddingsStatusEl.innerHTML = `<span style="color: var(--text-secondary);">○</span> No embeddings generated yet. Click "Generate Data" to enable Hybrid & Semantic search.`;
        }
    } catch (e) {
        embeddingsStatusEl.textContent = '';
    }
}

// Fetch on page load
fetchEmbeddingsStatus();

// Rename Action
const ctxRename = document.getElementById('ctxRename');
if (ctxRename) {
    ctxRename.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget) return;
        const { id, tag: currentFilename } = ctxTarget;
        hideContextMenu();

        // Strip extension for easier renaming
        const currentBase = currentFilename.substring(0, currentFilename.lastIndexOf('.')) || currentFilename;

        showTagInputModal('Rename File', currentBase, async (newName) => {
            if (!newName || newName === currentBase) return;

            // Basic validation
            if (newName.match(/[<>:"\/\\|?*]/)) {
                showAlertModal('Invalid characters in filename. Avoid: < > : " / \\ | ? *', 'Invalid Name');
                return;
            }

            try {
                const res = await fetch(`${API_BASE_URL}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, newFilename: newName })
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || 'Rename failed');
                }

                const data = await res.json();

                // Update UI locally
                const card = document.querySelector(`.card[data-id="${id}"]`);
                if (card) {
                    const fileLink = card.querySelector('.file-link');
                    if (fileLink) {
                        fileLink.textContent = data.newFilename;
                        fileLink.dataset.path = data.newPath;
                    }
                    // Search specific: update cache if needed
                    const img = allImages.find(i => i.id == id);
                    if (img) {
                        img.filename = data.newFilename;
                        img.path = data.newPath;
                    }
                }
            } catch (err) {
                showAlertModal('Rename Error: ' + err.message, 'Rename error');
            }
        });
    });
}

// Thumbnail Regen Action
document.getElementById('ctxRegenThumb').addEventListener('click', async () => {
    if (!ctxTarget || ctxTarget.type !== 'thumbnail') return;
    const { id, card } = ctxTarget;
    hideContextMenu();
    await regenerateThumbnail(id, card);
});

// Find Similar Action
const ctxFindSimilar = document.getElementById('ctxFindSimilar');
if (ctxFindSimilar) {
    ctxFindSimilar.addEventListener('click', () => {
        if (!ctxTarget) return;
        const { id } = ctxTarget;
        hideContextMenu();
        findSimilar(id);
    });
}

// Context Menu Actions
document.getElementById('ctxEdit').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent document click from hiding menu before we read ctxTarget
    if (!ctxTarget) return;
    const { id, tag, type } = ctxTarget;
    hideContextMenu();

    showTagInputModal(`Edit ${type.slice(0, -1)}`, tag, (newTag) => {
        if (newTag && newTag.trim() !== tag) {
            updateTag(id, type, tag, newTag.trim(), 'edit');
        }
    });
});

document.getElementById('ctxDelete').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent document click from hiding menu before we read ctxTarget
    if (!ctxTarget) return;
    const { id, tag, type } = ctxTarget;
    hideContextMenu();

    showConfirmModal(`Delete "${tag}"?`, () => {
        updateTag(id, type, tag, null, 'delete');
    });
});

document.getElementById('ctxEditSummary').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ctxTarget) return;
    const { id, tag: currentSummary } = ctxTarget;
    hideContextMenu();

    showSummaryInputModal('Edit Description', currentSummary, (newSummary) => {
        if (newSummary !== null && newSummary.trim() !== currentSummary) {
            updateTag(id, 'summary', currentSummary, newSummary.trim(), 'edit');
        }
    });
});

document.getElementById('ctxReparseSummary').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!ctxTarget) return;
    const { id } = ctxTarget;
    hideContextMenu();

    try {
        const response = await fetch(`${API_BASE_URL}/reparse-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        const data = await response.json();
        if (data.success) {
            // Update local cache
            const img = (allImages.find(i => i.id == id)) || 
                        (window.currentSearchResults && window.currentSearchResults.find(i => i.id == id));
            if (img) img.analysis = data.analysis;

            // In-Place UI Update
            const card = document.querySelector(`.card[data-id="${id}"]`);
            if (card) {
                card.outerHTML = createResultHtml(img, measureSingleCardHeight(img));
            }
            
            showAlertModal('Successfully recovered tags and objects from processed description!', 'Success');
        } else {
            showAlertModal(data.message || 'Description could not be reparsed.', 'Reparse Failed');
        }
    } catch (error) {
        showAlertModal('Error connecting to server for reparse.', 'Error');
    }
});

document.getElementById('ctxReAnalyze').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!ctxTarget) return;
    const { id } = ctxTarget;
    hideContextMenu();

    // Show a "Processing" message because AI can take time
    const loadingModal = document.createElement('div');
    loadingModal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10000; color: white; font-weight: bold; flex-direction: column; gap: 1rem;';
    loadingModal.innerHTML = '<div>🔍 Analyzing Image...</div><div style="font-size: 0.8rem; font-weight: normal;">This may take a few seconds</div>';
    document.body.appendChild(loadingModal);

    try {
        const response = await fetch(`${API_BASE_URL}/re-analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        const data = await response.json();
        loadingModal.remove();

        if (data.success) {
            // Update local cache
            const img = (allImages.find(i => i.id == id)) || 
                        (window.currentSearchResults && window.currentSearchResults.find(i => i.id == id));
            if (img) {
                img.analysis = data.analysis;
                img.updated_at = data.updated_at;
            }

            // In-Place UI Update
            const card = document.querySelector(`.card[data-id="${id}"]`);
            if (card) {
                card.outerHTML = createResultHtml(img, measureSingleCardHeight(img));
            }
            
            // Success indicator (optional, maybe just visual update is enough)
        } else {
            showAlertModal(data.error || 'Re-analysis failed.', 'Error');
        }
    } catch (error) {
        loadingModal.remove();
        console.error('Re-analyze error:', error);
        showAlertModal('Error connecting to server for re-analysis.', 'Error');
    }
});

// Add Tag Logic
async function addTag(id, type) {
    showTagInputModal(`Add new ${type.slice(0, -1)}`, '', (newTag) => {
        if (newTag && newTag.trim()) {
            updateTag(id, type, null, newTag.trim(), 'add');
        }
    });
}

// Custom Input Modal (Replaces prompt)
function showTagInputModal(title, initialValue, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${title}</h3>
            <input type="text" id="tagInput" value="${initialValue || ''}" style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); margin-bottom: 1.5rem; font-size: 1rem;">
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelTagBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveTagBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('#tagInput');
    const saveBtn = modal.querySelector('#saveTagBtn');
    const cancelBtn = modal.querySelector('#cancelTagBtn');

    // Global keyboard handler
    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };
    document.addEventListener('keydown', keyHandler);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const save = () => {
        const val = input.value;
        cleanup();
        callback(val);
    };

    // Use setTimeout to ensure focus applies after render cycle
    setTimeout(() => {
        input.focus();
        input.select();
    }, 10);

    saveBtn.onclick = save;
    cancelBtn.onclick = cleanup;

    // Handle Enter on the input
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            save();
        }
    });

    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };
}

// Custom Textarea Modal for Summaries
function showSummaryInputModal(title, initialValue, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 600px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${title}</h3>
            <textarea id="summaryInput" style="width: 100%; height: 200px; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); margin-bottom: 1.5rem; font-size: 0.9rem; line-height: 1.4; font-family: inherit; resize: vertical;">${initialValue || ''}</textarea>
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelSummaryBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveSummaryBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save Changes</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const textarea = modal.querySelector('#summaryInput');
    const saveBtn = modal.querySelector('#saveSummaryBtn');
    const cancelBtn = modal.querySelector('#cancelSummaryBtn');

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const keyHandler = (e) => {
        if (e.key === 'Escape') cleanup();
    };
    document.addEventListener('keydown', keyHandler);

    const save = () => {
        const val = textarea.value;
        cleanup();
        callback(val);
    };

    setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 10);

    saveBtn.onclick = save;
    cancelBtn.onclick = cleanup;

    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };
}

// Custom Confirmation Modal (Replaces native confirm)
async function showIntegrityCheckModal() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);';

        modal.innerHTML = `
            <div style="background: var(--bg-secondary); padding: 2.5rem; border-radius: 16px; border: 1px solid var(--border); max-width: 450px; width: 90%; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <h3 style="margin: 0 0 1.5rem 0; color: var(--accent); font-size: 1.5rem; display: flex; align-items: center; gap: 0.75rem;">
                    <span>🛡️</span> Database Integrity Check
                </h3>
                
                <p style="color: var(--text-secondary); margin-bottom: 2rem; font-size: 0.95rem; line-height: 1.5;">
                    Select the tasks you would like to perform during the maintenance pass:
                </p>

                <div style="display: flex; flex-direction: column; gap: 1.25rem; margin-bottom: 2.5rem;">
                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s; hover: background: rgba(255,255,255,0.05);">
                        <input type="checkbox" id="icRemoveMissing" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Remove Missing Files</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Delete database records for files no longer on disk.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRepairMetadata" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Repair Metadata</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Fix missing dimensions, resolution, and file size data.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRegenThumb" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Regenerate Thumbnails</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Rebuild missing thumbnails using the new unique ID scheme.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 1rem; border-radius: 8px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2);">
                        <input type="checkbox" id="icPurgeThumb" style="width: 18px; height: 18px; accent-color: #ef4444;">
                        <div>
                            <div style="color: #ef4444; font-weight: 600;">Purge Legacy Thumbnails</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Wipe all old thumbnails to fix collisions. (Recommended)</div>
                        </div>
                    </label>
                </div>

                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="icCancelBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.6rem 1.25rem; border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                    <button id="icRunBtn" style="background: var(--accent); border: none; color: white; padding: 0.6rem 2rem; border-radius: 8px; cursor: pointer; font-weight: 600;">Run Check</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('#icCancelBtn').onclick = () => {
            modal.remove();
            resolve(null);
        };

        modal.querySelector('#icRunBtn').onclick = () => {
            const options = {
                removeMissing: modal.querySelector('#icRemoveMissing').checked,
                repairMetadata: modal.querySelector('#icRepairMetadata').checked,
                regenThumbnails: modal.querySelector('#icRegenThumb').checked,
                purgeThumbnails: modal.querySelector('#icPurgeThumb').checked
            };
            modal.remove();
            resolve(options);
        };
    });
}

function showConfirmModal(message, onConfirm, confirmText = 'Delete', confirmColor = '#ef4444') {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    modal.innerHTML = `
        <div style="background: linear-gradient(135deg, var(--card-bg) 0%, ${confirmColor === '#ef4444' ? '#450a0a' : '#064e3b'} 100%); padding: 2rem; border-radius: 12px; border: 2px solid ${confirmColor}; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.7);">
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1.1rem; line-height: 1.4;">${message}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="cancelConfirmBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; transition: background 0.2s;">Cancel</button>
                <button id="okConfirmBtn" style="background: ${confirmColor}; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 12px ${confirmColor}44; transition: transform 0.1s, filter 0.2s;">${confirmText}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const okBtn = modal.querySelector('#okConfirmBtn');
    const cancelBtn = modal.querySelector('#cancelConfirmBtn');

    // Focus OK button for keyboard accessibility
    setTimeout(() => {
        okBtn.focus();
    }, 10);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const confirmAction = () => {
        cleanup();
        onConfirm();
    };

    okBtn.onclick = confirmAction;
    cancelBtn.onclick = cleanup;

    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };

    // Keyboard support
    const keyHandler = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmAction();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cleanup();
        }
    };

    document.addEventListener('keydown', keyHandler);
}

// Custom Alert Modal (Replaces native alert)
function showAlertModal(message, title = 'Notification', onOk = null) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%; text-align: center;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${title}</h3>
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1.1rem;">${message}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="okAlertBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">OK</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const okBtn = modal.querySelector('#okAlertBtn');

    setTimeout(() => {
        okBtn.focus();
    }, 10);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
        if (onOk) onOk();
    };

    okBtn.onclick = cleanup;

    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };

    const keyHandler = (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            cleanup();
        }
    };

    document.addEventListener('keydown', keyHandler);
}

/**
 * @function showBulkRenameModal
 * @description Creates an interactive HTML overlay for renaming search results.
 * 
 * DESIGN RATIONALE:
 * - Uses modern CSS for a premium "dark mode" aesthetic.
 * - Provides a scrollable preview of targeted files for user confidence.
 * - Handles 'Enter' and 'Escape' keys for efficiency.
 * 
 * @param {Set} selectedIdsSet - The unique IDs of the checked images.
 * @param {Array} imagesArray - The master list of image metadata.
 * @returns {Promise<string|null>} Resolves with the new base name or null if aborted.
 */
function showBulkRenameModal(selectedIdsSet, imagesArray) {
    return new Promise((resolve) => {
        // Create the dark background backdrop
        const modalBackdrop = document.createElement('div');
        modalBackdrop.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        // Convert the set of IDs into human-readable filenames for the preview
        const fileNamesToRename = Array.from(selectedIdsSet).map(id => {
            const matchedImage = imagesArray.find(img => String(img.id) === id);
            return matchedImage ? matchedImage.filename : `Image #${id}`;
        });

        // Build the preview list (limited to 100 entries for performance)
        const listItemsHtml = fileNamesToRename.slice(0, 100).map(name => `
            <li style="padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-secondary); font-size: 0.85rem; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                📄 ${name}
            </li>
        `).join('');
        
        // Show an indicator if the list is truncated
        const listOverflowHtml = fileNamesToRename.length > 100 ? `<li style="padding: 0.25rem 0; color: #a78bfa; font-size: 0.8rem; text-align: center;">...and ${fileNamesToRename.length - 100} more</li>` : '';

        modalBackdrop.innerHTML = `
            <div style="background: linear-gradient(135deg, var(--card-bg) 0%, #1e1b4b 100%); padding: 2rem; border-radius: 12px; border: 2px solid #8b5cf6; max-width: 450px; width: 90%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.7);">
                <h3 style="margin: 0 0 0.5rem 0; color: var(--text-primary); font-size: 1.25rem;">Bulk Rename Results</h3>
                <p style="margin: 0 0 1rem 0; color: #c4b5fd; font-size: 0.9rem;">Targeting ${selectedIdsSet.size} selected image(s).</p>
                
                <div style="background: rgba(0,0,0,0.3); border: 1px solid #4c1d95; border-radius: 6px; padding: 0.5rem; margin-bottom: 1.5rem; max-height: 150px; overflow-y: auto;">
                    <ul style="list-style: none; padding: 0; margin: 0;">
                        ${listItemsHtml}
                        ${listOverflowHtml}
                    </ul>
                </div>

                <div style="margin-bottom: 1.5rem; text-align: left;">
                    <label style="display: block; color: #a78bfa; font-size: 0.85rem; margin-bottom: 0.5rem;">New Base Name (e.g. "coffee")</label>
                    
                    ${(() => {
                        const recent = getRecentRenames();
                        if (recent.length === 0) return '';
                        return `
                            <div id="recentRenamesContainer" style="margin-bottom: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px dashed rgba(167, 139, 250, 0.3);">
                                <span style="font-size: 0.7rem; color: #8b5cf6; width: 100%; margin-bottom: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Recent:</span>
                                ${recent.map(name => `
                                    <span class="recent-rename-chip" 
                                          style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); color: #c4b5fd; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s;"
                                          onmouseover="this.style.background='rgba(139, 92, 246, 0.3)'; this.style.borderColor='#8b5cf6';"
                                          onmouseout="this.style.background='rgba(139, 92, 246, 0.15)'; this.style.borderColor='rgba(139, 92, 246, 0.3)';"
                                          onclick="document.getElementById('renameBaseInput').value = '${name.replace(/'/g, "\\'")}'; document.getElementById('renameBaseInput').focus();">
                                        ${name}
                                    </span>
                                `).join('')}
                            </div>
                        `;
                    })()}

                    <input type="text" id="renameBaseInput" placeholder="Enter base name..." style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid #4c1d95; background: var(--bg-color); color: var(--text-primary); font-size: 1rem; outline: none; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);">
                    <p style="margin: 0.5rem 0 0 0; color: #8b5cf6; font-size: 0.75rem;">Fills gaps in sequence automatically: coffee_001, etc.</p>
                </div>

                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="cancelRenameBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; transition: all 0.2s;">Cancel</button>
                    <button id="goRenameBtn" style="background: #8b5cf6; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Go</button>
                </div>
            </div>
        `;

        document.body.appendChild(modalBackdrop);

        // Binding DOM elements for logic
        const baseInput = modalBackdrop.querySelector('#renameBaseInput');
        const confirmBtn = modalBackdrop.querySelector('#goRenameBtn');
        const abortBtn = modalBackdrop.querySelector('#cancelRenameBtn');

        // Focus the text field immediately for a better UX
        setTimeout(() => baseInput.focus(), 50);

        const closeAndResolve = (result) => {
            document.removeEventListener('keydown', handleKeyInput);
            modalBackdrop.remove();
            resolve(result);
        };

        const onConfirm = () => {
            const value = baseInput.value.trim();
            if (value) {
                closeAndResolve(value);
            } else {
                // UI feedback for empty input
                baseInput.style.border = '1px solid #ef4444';
                setTimeout(() => baseInput.style.border = '1px solid var(--border)', 1000);
            }
        };

        confirmBtn.onclick = onConfirm;
        abortBtn.onclick = () => closeAndResolve(null);

        const handleKeyInput = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAndResolve(null);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                onConfirm();
            }
        };

        document.addEventListener('keydown', handleKeyInput);
        
        // Manual hover bindings to maintain consistent styling with other pages
        abortBtn.onmouseover = () => abortBtn.style.background = 'rgba(255,255,255,0.05)';
        abortBtn.onmouseout = () => abortBtn.style.background = 'transparent';
        confirmBtn.onmouseover = () => confirmBtn.style.filter = 'brightness(1.1)';
        confirmBtn.onmouseout = () => confirmBtn.style.filter = 'brightness(1)';
    });
}

// Update Tag Backend Call
async function updateTag(id, type, oldTag, newTag, action) {
    try {
        // 1. Update master list (allImages)
        const masterImage = allImages.find(img => img.id == id);

        // 2. Update current search results (if exists)
        const resultImage = window.currentSearchResults ? window.currentSearchResults.find(img => img.id == id) : null;

        const image = masterImage || resultImage;
        if (!image) throw new Error('Image not found in any local cache');

        let analysis = image.analysis || {};

        if (type === 'summary') {
            analysis.summary = newTag; // Here newTag is actually the new description
        } else {
            let list = analysis[type] || [];
            if (action === 'edit') {
                const idx = list.indexOf(oldTag);
                if (idx !== -1) list[idx] = newTag;
            } else if (action === 'delete') {
                list = list.filter(t => t !== oldTag);
            } else if (action === 'add') {
                if (!list.includes(newTag)) list.push(newTag);
            }
            analysis[type] = list; // Update the list
        }

        // Standardize and cleanup
        deduplicateTags(analysis);

        // Update BOTH references to ensure consistency
        if (masterImage) masterImage.analysis = analysis;
        if (resultImage) resultImage.analysis = analysis;

        // Also update filteredImages if it exists (for pagination consistency)
        const filteredImage = filteredImages ? filteredImages.find(img => img.id == id) : null;
        if (filteredImage) filteredImage.analysis = analysis;

        // 3. Send update to server
        const response = await fetch(`${API_BASE_URL}/update-tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, analysis })
        });

        if (!response.ok) throw new Error('Update failed');

        // Refresh stats list
        loadStats();

        // 4. In-Place UI Update
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            // Re-render only the inner content to preserve card structure if needed, 
            // but createResultHtml returns a full card string.
            // Let's replace the whole card's content or outer if simpler.
            const newHtml = createResultHtml(image, measureSingleCardHeight(image));
            card.outerHTML = newHtml;
        } else {
            // Fallback for extreme cases (shouldn't happen if card is visible)
            await executeSearchQuery();
        }

    } catch (error) {
        console.error('Tag update error:', error);
        showAlertModal('Failed to update tags: ' + error.message, 'Tag Update Error');
    }
}


// ============================================================================
// IMAGE PREVIEW POPUP
// ============================================================================
// Shows full-size image in a modal overlay
async function showImagePreview(imagePath) {
    try {
        console.log('[IMAGE PREVIEW] Path from search:', imagePath);

        // Read the file using Electron API
        const fileBuffer = await window.electronAPI.readFile(imagePath);
        const blob = new Blob([fileBuffer]);
        const url = URL.createObjectURL(blob);

        // Create modal overlay
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0,0,0,0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            cursor: pointer;
            overflow: hidden;
        `;

        // Create image element
        const img = document.createElement('img');
        img.src = url;
        img.style.cssText = `
            max-width: 95vw;
            max-height: 95vh;
            width: auto;
            height: auto;
            object-fit: contain;
            border-radius: 8px;
            cursor: default;
            box-shadow: 0 0 50px rgba(0,0,0,0.5);
        `;

        // Error handling
        img.onerror = () => {
            console.error('Failed to load image:', imagePath);
            modal.remove();
            URL.revokeObjectURL(url);
            showAlertModal('Failed to load image', 'Preview Error');
        };

        modal.appendChild(img);

        // Create hint element
        const hint = document.createElement('div');
        hint.textContent = 'PRESS ANY KEY or Click anywhere TO EXIT';
        hint.style.cssText = `
            position: absolute;
            top: 2rem;
            left: 50%;
            transform: translateX(-50%);
            color: rgba(255,255,255,0.5);
            font-size: 0.9rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            pointer-events: none;
            background: rgba(0,0,0,0.3);
            padding: 0.5rem 1rem;
            border-radius: 20px;
        `;
        modal.appendChild(hint);

        document.body.appendChild(modal);

        // Close on background click (and image click since we removed stopPropagation)
        modal.addEventListener('click', () => {
            modal.remove();
            URL.revokeObjectURL(url);
            document.removeEventListener('keydown', keyHandler);
        });

        // Close on any key press
        const keyHandler = (e) => {
            modal.remove();
            URL.revokeObjectURL(url);
            document.removeEventListener('keydown', keyHandler);
        };
        document.addEventListener('keydown', keyHandler);

    } catch (error) {
        console.error('[IMAGE PREVIEW] Error loading image:', error);
        showAlertModal(`Image File Not Found!\n\nPath: ${imagePath}\n\nThe file may have been moved or the path may be incorrect.`, 'File Error');
    }
}

// Load Stats
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE_URL}/stats`);
        if (!response.ok) throw new Error('Failed to fetch stats');

        const stats = await response.json();

        // Render Tags
        const topTagsList = document.getElementById('topTagsList');
        // Store for autocomplete
        allKnownTags = stats.tags || [];
        allKnownObjects = stats.objects || [];

        if (stats.tags.length === 0) {
            topTagsList.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No tags found</span>';
        } else {
            topTagsList.innerHTML = stats.tags.slice(0, 20).map(tag => {
                const safeName = tag.name.replace(/'/g, "\\'");
                return `
                    <span class="tag" style="cursor: pointer;" onclick="setSearchQuery('${safeName}')">
                        #${tag.name} <span style="opacity: 0.6; font-size: 0.8em;">(${tag.count})</span>
                    </span>
                `;
            }).join('');
        }

        // Render Objects
        const topObjectsList = document.getElementById('topObjectsList');
        if (stats.objects.length === 0) {
            topObjectsList.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No objects found</span>';
        } else {
            topObjectsList.innerHTML = stats.objects.slice(0, 20).map(obj => {
                const safeName = obj.name.replace(/'/g, "\\'");
                return `
                    <span class="tag" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399; cursor: pointer;" onclick="setObjectQuery('${safeName}')">
                        ${obj.name} <span style="opacity: 0.6; font-size: 0.8em;">(${obj.count})</span>
                    </span>
                `;
            }).join('');
        }

    } catch (error) {
        console.error('Error loading stats:', error);
        document.getElementById('topTagsList').innerHTML = '<span style="color: var(--text-secondary);">Error loading tags</span>';
        document.getElementById('topObjectsList').innerHTML = '<span style="color: var(--text-secondary);">Error loading objects</span>';
    }
}

// Regenerate Thumbnail Logic
async function regenerateThumbnail(id, cardElement) {
    try {
        const thumbImg = cardElement.querySelector('.thumbnail-preview');
        thumbImg.style.opacity = '0.5';

        const response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        if (!response.ok) throw new Error('Regeneration failed');

        const data = await response.json();

        // Refresh the image by appending a timestamp to bypass cache
        if (data.thumbPath) {
            thumbImg.src = `${data.thumbPath}?t=${Date.now()}`;
        }

    } catch (error) {
        console.error('Thumbnail regeneration error:', error);
        showAlertModal('Failed to regenerate thumbnail: ' + error.message, 'Regeneration Error');
    } finally {
        const thumbImg = cardElement.querySelector('.thumbnail-preview');
        if (thumbImg) thumbImg.style.opacity = '1';
    }
}

// Helper: Add tag/object to filter from sidebar click
window.setSearchQuery = (term) => {
    addTagFilter(term, 'tag');
};

window.setObjectQuery = (term) => {
    addTagFilter(term, 'object');
};

// ============================================================================
// TAG FILTER: AUTOCOMPLETE & CHIP MANAGEMENT
// ============================================================================

function addTagFilter(name, type) {
    const targetSet = type === 'tag' ? selectedTagFilters : selectedObjectFilters;
    if (targetSet.has(name)) return; // Already selected
    targetSet.add(name);
    renderFilterChips();
    if (tagFilterInput) tagFilterInput.value = '';
    hideAutocomplete();
    executeSearchQuery();
}

function removeTagFilter(name, type) {
    const targetSet = type === 'tag' ? selectedTagFilters : selectedObjectFilters;
    targetSet.delete(name);
    renderFilterChips();
    executeSearchQuery();
}

function renderFilterChips() {
    if (!tagFilterChips) return;
    let html = '';
    selectedTagFilters.forEach(tag => {
        html += `<span class="filter-chip chip-tag">#${tag} <span class="chip-remove" data-name="${tag}" data-type="tag">&times;</span></span>`;
    });
    selectedObjectFilters.forEach(obj => {
        html += `<span class="filter-chip chip-object">&boxbox; ${obj} <span class="chip-remove" data-name="${obj}" data-type="object">&times;</span></span>`;
    });
    tagFilterChips.innerHTML = html;

    // Attach remove handlers
    tagFilterChips.querySelectorAll('.chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            removeTagFilter(btn.dataset.name, btn.dataset.type);
        });
    });
}

function showAutocomplete(query) {
    if (!tagAutocomplete) return;
    const q = query.toLowerCase();
    const combined = [
        ...allKnownTags.map(t => ({ ...t, type: 'tag' })),
        ...allKnownObjects.map(o => ({ ...o, type: 'object' }))
    ];

    // Filter: match query, exclude already selected
    const matches = combined.filter(item => {
        if (item.type === 'tag' && selectedTagFilters.has(item.name)) return false;
        if (item.type === 'object' && selectedObjectFilters.has(item.name)) return false;
        return item.name.toLowerCase().includes(q);
    }).slice(0, 15);

    if (matches.length === 0) {
        hideAutocomplete();
        return;
    }

    tagAutocomplete.innerHTML = matches.map((item, i) => `
        <div class="tag-autocomplete-item${i === acActiveIndex ? ' active' : ''}" data-name="${item.name}" data-type="${item.type}">
            <span>
                <span class="ac-type ${item.type === 'tag' ? 'ac-tag' : 'ac-obj'}">${item.type === 'tag' ? 'tag' : 'obj'}</span>
                ${item.name}
            </span>
            <span class="ac-count">(${item.count})</span>
        </div>
    `).join('');

    tagAutocomplete.style.display = 'block';

    // Click handlers
    tagAutocomplete.querySelectorAll('.tag-autocomplete-item').forEach(el => {
        el.addEventListener('click', () => {
            addTagFilter(el.dataset.name, el.dataset.type);
        });
    });
}

function hideAutocomplete() {
    if (tagAutocomplete) {
        tagAutocomplete.style.display = 'none';
        tagAutocomplete.innerHTML = '';
    }
    acActiveIndex = -1;
}

// Wire up the filter input
if (tagFilterInput) {
    tagFilterInput.addEventListener('input', () => {
        const val = tagFilterInput.value.trim();
        acActiveIndex = -1;
        if (val.length > 0) {
            showAutocomplete(val);
        } else {
            hideAutocomplete();
        }
    });

    tagFilterInput.addEventListener('keydown', (e) => {
        const items = tagAutocomplete ? tagAutocomplete.querySelectorAll('.tag-autocomplete-item') : [];
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            acActiveIndex = Math.min(acActiveIndex + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('active', i === acActiveIndex));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            acActiveIndex = Math.max(acActiveIndex - 1, 0);
            items.forEach((el, i) => el.classList.toggle('active', i === acActiveIndex));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (acActiveIndex >= 0 && items[acActiveIndex]) {
                const el = items[acActiveIndex];
                addTagFilter(el.dataset.name, el.dataset.type);
            }
        } else if (e.key === 'Escape') {
            hideAutocomplete();
        }
    });

    // Close autocomplete when clicking outside
    document.addEventListener('click', (e) => {
        if (!tagFilterInput.contains(e.target) && !tagAutocomplete.contains(e.target)) {
            hideAutocomplete();
        }
    });
}

// AND/OR toggle triggers re-search
document.querySelectorAll('input[name="tagLogic"]').forEach(radio => {
    radio.addEventListener('change', () => {
        if (selectedTagFilters.size > 0 || selectedObjectFilters.size > 0) {
            executeSearchQuery();
        }
    });
});

// ============================================================================
// FIND SIMILAR
// ============================================================================

async function findSimilar(imageId) {
    // 1. Try to find in lastWorkerResults
    let allData = lastWorkerResults || [];
    let source = allData.find(img => img.id == imageId);

    // 2. If not found (e.g., initial load), fetch from server
    if (!source) {
        try {
            const response = await fetch(`${API_BASE_URL}/images?id=${imageId}`);
            if (response.ok) {
                const data = await response.json();
                source = data.image; // Assuming server returns { image: ... }
            }
        } catch (err) {
            console.error('Failed to fetch similar source image:', err);
        }
    }

    if (!source) {
        // Fallback: If we still don't have it, perform a search once to populate results
        if (allData.length === 0) {
            await executeSearchQuery(); // This is async now but we don't have a promise yet...
            // We'll just alert for now or retry once results are in.
            setTimeout(() => findSimilar(imageId), 1000); 
            return;
        }
        showAlertModal('Image data not found. Try searching first.', 'Find Similar');
        return;
    }

    // ENSURE DATA IS PARSED (Server returns stringified JSON)
    if (typeof source.analysis === 'string') {
        try {
            source.analysis = JSON.parse(source.analysis || '{}');
        } catch (e) {
            console.error('[FIND-SIMILAR] Failed to parse analysis JSON:', e);
            source.analysis = {};
        }
    }
    if (typeof source.metadata === 'string') {
        try {
            source.metadata = JSON.parse(source.metadata || '{}');
        } catch (e) {
            source.metadata = {};
        }
    }

    const analysis = source.analysis || {};
    const tags = analysis.tags || [];
    const objects = analysis.objects || [];
    const summary = analysis.summary || '';

    // Clear existing filters
    selectedTagFilters.clear();
    selectedObjectFilters.clear();

    // Populate tag filters with source image's tags
    tags.forEach(t => selectedTagFilters.add(t));
    objects.forEach(o => selectedObjectFilters.add(o));

    // Set logic to OR (we want images matching ANY of the tags)
    const orRadio = document.querySelector('input[name="tagLogic"][value="OR"]');
    if (orRadio) orRadio.checked = true;

    // Put a truncated summary into the text search for additional context
    const truncSummary = summary.split(/\s+/).slice(0, 6).join(' ');
    searchQuery.value = truncSummary;

    renderFilterChips();

    // Show banner
    if (similarBanner) {
        similarBanner.style.display = 'flex';
        similarBannerName.textContent = source.filename || `ID ${imageId}`;
    }

    executeSearchQuery();
}

function clearSimilarMode() {
    selectedTagFilters.clear();
    selectedObjectFilters.clear();
    searchQuery.value = '';
    renderFilterChips();

    const andRadio = document.querySelector('input[name="tagLogic"][value="AND"]');
    if (andRadio) andRadio.checked = true;

    if (similarBanner) similarBanner.style.display = 'none';

    executeSearchQuery();
}

if (clearSimilarBtn) {
    clearSimilarBtn.addEventListener('click', clearSimilarMode);
}

// Store last worker results for findSimilar lookups
let lastWorkerResults = [];


// Event Listeners
searchBtn.addEventListener('click', executeSearchQuery);

// Allow Enter key to search
searchQuery.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') executeSearchQuery();
});

// Initialize
loadStats();
initializeSearchSystem();
updateModelIndicator();
setInterval(updateModelIndicator, 10000);

async function updateModelIndicator() {
    const nameLabel = document.getElementById('activeModelName');
    const statusDot = document.getElementById('modelStatusDot');
    if (!nameLabel || !statusDot) return;

    try {
        // 1. Get our local config
        const configRes = await fetch('/api/config');
        if (!configRes.ok) return;
        const config = await configRes.json();
        const activeModel = config.visionModel || "qwen2.5-vl-7b-instruct";
        
        nameLabel.textContent = activeModel;
        nameLabel.title = activeModel;

        // 2. Get LM Studio's current loaded models
        const statusRes = await fetch('/api/proxy/models');
        if (!statusRes.ok) {
            statusDot.style.background = '#ff4444'; // Red for error/offline
            return;
        }
        
        const data = await statusRes.json();
        const loadedModels = data.data || [];
        const isLoaded = loadedModels.some(m => m.id === activeModel);

        if (isLoaded) {
            statusDot.style.background = '#00ff00'; // Pure Green for Loaded
            statusDot.title = 'Model is loaded in memory';
        } else {
            statusDot.style.background = '#666666'; // Gray for Available (Standby)
            statusDot.title = 'Model on standby (will JIT load)';
        }

    } catch (e) {
        console.warn('Failed to update model indicator:', e);
        statusDot.style.background = '#ff4444';
    }
}

// URL parameters are now handled by processUrlParams() called during initializeSearchSystem()

// File Link Handler (Show in Folder)
document.addEventListener("click", (e) => {
    const el = e.target.closest(".file-link");
    if (!el) return;

    const fullPath = el.dataset.path;

    if (window.electronAPI && window.electronAPI.showInFolder) {
        window.electronAPI.showInFolder(fullPath);
    } else {
        console.warn('Electron API not available. File path:', fullPath);
        showAlertModal('This feature requires Electron. File path: ' + fullPath, 'System Limitation');
    }
});

// ============================================================================
// BATCH CONTROLS & SELECTION LOGIC
// ============================================================================

const selectMissingBtn = document.getElementById('selectMissingBtn');
const unselectAllBtn = document.getElementById('unselectAllBtn');
const processSelectedBtn = document.getElementById('processSelectedBtn');
const dbPromptType = document.getElementById('dbPromptType');
const validateBtn = document.getElementById('validateBtn');
const validationStatus = document.getElementById('validationStatus');
const validationText = document.getElementById('validationText');
const validationProgressBar = document.getElementById('validationProgressBar');
const closeStatus = document.getElementById('closeStatus');


// Checkbox Delegation
searchResults.addEventListener('change', (e) => {
    if (e.target.classList.contains('card-select-cb')) {
        const id = e.target.dataset.id;
        const card = e.target.closest('.card');
        if (e.target.checked) {
            selectedIds.add(String(id));
            if (card) card.classList.add('selected');
        } else {
            selectedIds.delete(String(id));
            if (card) card.classList.remove('selected');
        }
        updateProcessButton();
    }
});

function updateProcessButton() {
    const count = selectedIds.size;
    if (processSelectedBtn) {
        processSelectedBtn.textContent = `Process (${count})`;
        processSelectedBtn.disabled = count === 0;
        processSelectedBtn.style.opacity = count === 0 ? '0.5' : '1';
    }
    
    const bulkRenameBtn = document.getElementById('bulkRenameBtn');
    if (bulkRenameBtn) {
        bulkRenameBtn.disabled = count === 0;
        bulkRenameBtn.style.opacity = count === 0 ? '0.5' : '1';
    }

    if (unselectAllBtn) {
        unselectAllBtn.style.display = count > 0 ? 'block' : 'none';
    }
}

// 0.5 Bulk Rename
const bulkRenameBtn = document.getElementById('bulkRenameBtn');
if (bulkRenameBtn) {
    bulkRenameBtn.addEventListener('click', async () => {
        if (selectedIds.size === 0) return;

        // In search.js we use the new custom modal, passing allImages for name lookups
        const baseName = await showBulkRenameModal(selectedIds, allImages);
        if (!baseName || !baseName.trim()) return;

        bulkRenameBtn.disabled = true;
        const originalText = bulkRenameBtn.textContent;
        bulkRenameBtn.textContent = 'Renaming...';

        try {
            const response = await fetch(`${API_BASE_URL}/bulk-rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: Array.from(selectedIds),
                    baseName: baseName.trim()
                })
            });

            const data = await response.json();
            
            if (response.ok && data.success) {
                saveRecentRename(baseName.trim());
                showAlertModal(data.message || 'Successfully renamed files', 'Rename Complete');
                selectedIds.clear();
                updateProcessButton();
                await refreshData();
            } else {
                showAlertModal(data.error || 'Failed to bulk rename', 'Rename Error');
            }
        } catch (err) {
            console.error('Bulk rename failed:', err);
            showAlertModal('Error communicating with server.', 'Error');
        } finally {
            bulkRenameBtn.disabled = false;
            bulkRenameBtn.textContent = originalText;
        }
    });
}

// 1. Select Missing
if (selectMissingBtn) {
    selectMissingBtn.addEventListener('click', () => {
        let count = 0;
        filteredImages.forEach(img => {
            const analysis = img.analysis || {};
            if (!analysis.summary || !analysis.tags || analysis.tags.length === 0 || !analysis.objects || analysis.objects.length === 0) {
                selectedIds.add(String(img.id));
                count++;

                const cb = document.querySelector(`.card-select-cb[data-id="${img.id}"]`);
                if (cb) cb.checked = true;
                const card = document.querySelector(`.card[data-id="${img.id}"]`);
                if (card) card.classList.add('selected');
            }
        });

        if (count > 0) {
            updateProcessButton();
            showAlertModal(`Successfully selected ${count} images with missing data.`, 'Selection Complete');
        } else {
            showAlertModal('No visible images found with missing data.', 'Auto Selection');
        }
    });
}

// 2. Unselect All
if (unselectAllBtn) {
    unselectAllBtn.addEventListener('click', () => {
        selectedIds.clear();
        document.querySelectorAll('.card-select-cb').forEach(cb => cb.checked = false);
        document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
        updateProcessButton();
    });
}

// 3. Process Selected
if (processSelectedBtn) {
    processSelectedBtn.addEventListener('click', () => {
        if (selectedIds.size === 0) return;

        showConfirmModal(`Re-analyze ${selectedIds.size} images with mode: "${dbPromptType.value}"?`, async () => {

            processSelectedBtn.disabled = true;
            processSelectedBtn.textContent = 'Processing...';

            const ids = Array.from(selectedIds);
            const promptType = dbPromptType.value;
            const total = ids.length;
            let successCount = 0;
            let failedCount = 0;

            if (validationStatus) {
                validationStatus.style.display = 'block';
                validationText.textContent = 'Starting batch...';
                validationProgressBar.style.width = '0%';
            }

            for (let i = 0; i < total; i++) {
                if (validationText) validationText.textContent = `Processing image ${i + 1} of ${total}...`;

                try {
                    const response = await fetch(`${API_BASE_URL}/batch-analyze`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: [ids[i]], promptType })
                    });

                    if (response.ok) successCount++;
                    else failedCount++;
                } catch (e) {
                    console.error(e);
                    failedCount++;
                }
                if (validationProgressBar) validationProgressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
            }

            if (validationText) validationText.textContent = `Batch Complete! Success: ${successCount}`;

            selectedIds.clear();
            await refreshData();
            updateProcessButton();

            setTimeout(() => {
                if (validationStatus) validationStatus.style.display = 'none';
            }, 2000);

        }, 'Start Batch', '#10b981');
    });
}

// 4. Validate (Integrity Check)
if (validateBtn) {
    validateBtn.addEventListener('click', async () => {
        const options = await showIntegrityCheckModal();
        if (!options) return;

        validateBtn.disabled = true;
        const originalText = validateBtn.innerHTML;
        validateBtn.innerHTML = '🔄 Checking...';

        let validateInterval;

        if (validationStatus) {
            validationStatus.style.display = 'block';
            validationText.textContent = 'Starting integrity check...';
            validationProgressBar.style.width = '2%';

            validateInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/validate-status`);
                    if (statusRes.ok) {
                        const statusData = await statusRes.json();
                        validationText.textContent = statusData.status;
                        validationProgressBar.style.width = `${Math.max(2, statusData.progress)}%`;
                    }
                } catch(e) {}
            }, 250);
        }

        try {
            const res = await fetch(`${API_BASE_URL}/validate-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ options, reanalyze: false })
            });
            const data = await res.json();
            
            if (validateInterval) clearInterval(validateInterval);
            
            const r = data.results;

            if (validationProgressBar) validationProgressBar.style.width = '100%';

            let message = `<strong>Check Complete</strong><br>`;
            if (r.purged > 0) message += `🔥 Purged ${r.purged} legacy thumbnails<br>`;
            if (r.duplicatesRemoved > 0) message += `🧹 Removed ${r.duplicatesRemoved} duplicates<br>`;
            if (r.metadataRepaired > 0) message += `🔧 Repaired ${r.metadataRepaired} metadata<br>`;
            if (r.missing > 0) message += `🗑️ Removed ${r.missing} missing files<br>`;
            if (r.fixedThumbnails > 0) message += `🖼️ Fixed ${r.fixedThumbnails} thumbnails<br>`;
            if (r.errors.length > 0) message += `⚠️ ${r.errors.length} errors occurred`;

            if (r.purged === 0 && r.duplicatesRemoved === 0 && r.metadataRepaired === 0 && r.missing === 0 && r.fixedThumbnails === 0 && r.errors.length === 0) {
                message += "✅ Database is healthy!";
            }

            if (validationText) validationText.innerHTML = message;

                await refreshData();

                // Keep status visible longer if we did something
                const delay = (r.duplicatesRemoved > 0 || r.metadataRepaired > 0 || r.missing > 0) ? 5000 : 3000;

                setTimeout(() => {
                    if (validationStatus) validationStatus.style.display = 'none';
                }, delay);
            } catch (e) {
                showAlertModal('Check failed: ' + e.message, 'Integrity Check Error');
                if (validationStatus) validationStatus.style.display = 'none';
            } finally {
                validateBtn.disabled = false;
                validateBtn.innerHTML = originalText;
            }
    });
}

if (closeStatus) {
    closeStatus.addEventListener('click', () => {
        validationStatus.style.display = 'none';
    });
}
// ============================================================================
// STORAGE HELPERS
// ============================================================================
function getRecentRenames() {
    try {
        const stored = localStorage.getItem('recentRenames');
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        return [];
    }
}

function saveRecentRename(name) {
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    let recent = getRecentRenames();
    // Remove if already exists to move it to the top
    recent = recent.filter(r => r !== trimmed);
    recent.unshift(trimmed);
    // Keep only last 10
    recent = recent.slice(0, 10);
localStorage.setItem('recentRenames', JSON.stringify(recent));
}

// ============================================================================
// DISCOVERY TAGS TOGGLE
// ============================================================================
function initDiscoveryToggle() {
    const toggle = document.getElementById('discoveryToggle');
    const content = document.getElementById('discoveryContent');
    
    if (!toggle || !content) return;

    // Load initial state
    const isHidden = localStorage.getItem('discoveryTagsHidden') === 'true';
    if (isHidden) {
        toggle.classList.add('collapsed');
        content.classList.add('collapsed');
        content.classList.remove('show');
    }

    toggle.addEventListener('click', () => {
        const hiding = !content.classList.contains('collapsed');
        
        if (hiding) {
            toggle.classList.add('collapsed');
            content.classList.add('collapsed');
            content.classList.remove('show');
            localStorage.setItem('discoveryTagsHidden', 'true');
        } else {
            toggle.classList.remove('collapsed');
            content.classList.remove('collapsed');
            content.classList.add('show');
            localStorage.setItem('discoveryTagsHidden', 'false');
        }
    });
}

// Initialize everything
requestAnimationFrame(() => {
    initDiscoveryToggle();
    loadStats();
});
