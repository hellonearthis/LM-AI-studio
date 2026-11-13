/**
 * ============================================================================
 * SEARCH.JS — Imperative Shell & Coordinator for search.html
 * ============================================================================
 *
 * WHAT: Coordinates DOM events, Web Worker communication (`search-worker.js`),
 *       API calls, infinite scroll pagination, and UI state for `search.html`.
 * WHY:  Delegates all pure data transformations (filtering, sorting, ranking,
 *       HTML card building, tag deduplication) to `public/modules/cardCore.js`
 *       and `public/modules/searchFilters.js`, and delegates modal dialogs to
 *       `public/modules/uiModals.js`.
 */

import { createSearchMaintenanceController } from "./modules/searchMaintenanceController.js";
import {
    escapeHtmlCharacters,
    deduplicateAndNormalizeAnalysisRecord,
    calculatePretextCardTextWidth,
    buildSearchResultCardHtml,
    extractDicedPromptMasterRecord,
    renderDicedPromptBackDetailsHtml,
    buildCardBackIdentityHeaderHtml
} from './modules/cardCore.js';

import {
    computeCardPixelWidthFromGridWidth,
    computeTriangularPrismRadiusPixels,
    computeNextPrismSpinDegrees
} from './modules/databaseCardRenderers.js';

import {
    filterImageRecordsByCriteria,
    sortFilteredImageRecords,
    rankTagAutocompleteMatches,
    extractSimilarImageSearchState,
    computeUpdatedRecentRenamesList,
    formatDetectedIntentFilterDescriptions
} from './modules/searchFilters.js';

import {
    showTagInputModal,
    showSummaryInputModal,
    showIntegrityCheckModal,
    showConfirmModal,
    showAlertModal,
    showBulkRenameModal,
    showDeleteModal,
    showImagePreview
} from './modules/uiModals.js';

// ============================================================================
// DOM ELEMENT REFERENCES & CONSTANTS
// ============================================================================

const searchQuery = document.getElementById('searchQuery');
const negativeQuery = document.getElementById('negativeQuery');
const sceneType = document.getElementById('sceneType');
const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const resultsCount = document.getElementById('resultsCount');
const API_BASE_URL = 'http://localhost:3000';
const {
    checkOrPruneOrphanedEmbeddings,
    fetchEmbeddingsStatus,
    updateModelIndicator
} = createSearchMaintenanceController({ apiBaseUrl: API_BASE_URL, refreshData: () => refreshData() });

const tagFilterInput = document.getElementById('tagFilterInput');
const tagAutocomplete = document.getElementById('tagAutocomplete');
const tagFilterChips = document.getElementById('tagFilterChips');
const similarBanner = document.getElementById('similarBanner');
const similarBannerName = document.getElementById('similarBannerName');
const clearSimilarBtn = document.getElementById('clearSimilarBtn');

const clusterThemeSelect = document.getElementById('clusterThemeSelect');
const facetMediumSelect = document.getElementById('facetMediumSelect');
const facetMoodSelect = document.getElementById('facetMoodSelect');
const facetCompositionSelect = document.getElementById('facetCompositionSelect');
const smartIntentIndicator = document.getElementById('smartIntentIndicator');
const smartIntentText = document.getElementById('smartIntentText');

const fuzzinessSlider = document.getElementById('fuzzinessSlider');
const fuzzinessValue = document.getElementById('fuzzinessValue');
const semanticToggle = document.getElementById('semanticToggle');
const searchModeHint = document.getElementById('searchModeHint');

const scopeAnalysis = document.getElementById('scopeAnalysis');
const scopeObjects = document.getElementById('scopeObjects');
const scopeTags = document.getElementById('scopeTags');
const sortOrder = document.getElementById('sortOrder');

const sentinel = document.getElementById('scroll-sentinel');
const contextMenu = document.getElementById('contextMenu');
const generateEmbeddingsBtn = document.getElementById('generateEmbeddingsBtn');
const genProgress = document.getElementById('genProgress');
const embeddingsStatusEl = document.getElementById('embeddingsStatus');

const selectMissingBtn = document.getElementById('selectMissingBtn');
const unselectAllBtn = document.getElementById('unselectAllBtn');
const processSelectedBtn = document.getElementById('processSelectedBtn');
const dbPromptType = document.getElementById('dbPromptType');
const validateBtn = document.getElementById('validateBtn');
const validationStatus = document.getElementById('validationStatus');
const validationText = document.getElementById('validationText');
const validationProgressBar = document.getElementById('validationProgressBar');
const closeStatus = document.getElementById('closeStatus');

const SEARCH_MODE_HINTS = Object.freeze({
    keyword: 'Fuzzy keyword matching on summaries, tags, and objects.',
    hybrid: '⚡ Combines keyword + semantic search via Reciprocal Rank Fusion.',
    semantic: '🧠 AI concept search using embedding similarity.'
});

const BATCH_SIZE = 50;

// ============================================================================
// IMPERATIVE SHELL UI STATE
// ============================================================================

const selectedTagFilters = new Set();
const selectedObjectFilters = new Set();
const currently_rendered_image_identifier_set = new Set();
const selectedIds = new Set();

let allKnownTags = [];
let allKnownObjects = [];
let autocomplete_active_index = -1;

let allImages = [];
let lastWorkerResults = [];
let filteredImages = [];
let currentIndex = 0;
let isRendering = false;
let searchWorker = null;
let isInitialized = false;
let is_search_system_currently_initializing = false;
let observer = null;
let context_menu_target_state = null;

// ============================================================================
// SEARCH MODE & FILTER CONTROLS
// ============================================================================

/**
 * WHAT: Reads the currently selected search mode radio input (`keyword`, `hybrid`, or `semantic`).
 * WHY:  Provides a single source of truth for search execution and UI state toggling.
 *
 * @returns {string} Active search mode identifier.
 */
function getSearchMode() {
    const checked_radio_element = document.querySelector('input[name="searchMode"]:checked');
    return checked_radio_element ? checked_radio_element.value : 'keyword';
}

/**
 * WHAT: Updates control availability, opacity, hints, and sort order when switching search modes.
 * WHY:  Fuzziness and field scopes do not apply to pure vector semantic search, and semantic/hybrid
 *       modes default to relevance ranking.
 */
function updateSearchModeUI() {
    const active_mode = getSearchMode();
    const is_pure_semantic = active_mode === 'semantic';

    if (fuzzinessSlider) fuzzinessSlider.disabled = is_pure_semantic;
    if (scopeAnalysis) scopeAnalysis.disabled = is_pure_semantic;
    if (scopeObjects) scopeObjects.disabled = is_pure_semantic;
    if (scopeTags) scopeTags.disabled = is_pure_semantic;

    const control_opacity = is_pure_semantic ? '0.5' : '1';
    const fuzziness_container = document.querySelector('.fuzziness-container');
    const scope_container = document.querySelector('.scope-container');
    if (fuzziness_container) fuzziness_container.style.opacity = control_opacity;
    if (scope_container) scope_container.style.opacity = control_opacity;

    if (searchModeHint) {
        searchModeHint.textContent = SEARCH_MODE_HINTS[active_mode] || '';
    }

    if ((active_mode === 'semantic' || active_mode === 'hybrid') && sortOrder) {
        sortOrder.value = 'relevance';
    }
}

if (fuzzinessSlider) {
    fuzzinessSlider.addEventListener('input', () => {
        if (fuzzinessValue) fuzzinessValue.textContent = fuzzinessSlider.value;
    });

    fuzzinessSlider.addEventListener('change', () => {
        const active_mode = getSearchMode();
        if (active_mode === 'semantic') return;

        if (searchWorker) {
            searchWorker.postMessage({
                type: 'UPDATE_CONFIG',
                payload: { fuzziness: parseFloat(fuzzinessSlider.value) }
            });
            executeSearchQuery();
        }
    });
}

document.querySelectorAll('input[name="searchMode"]').forEach((mode_radio_element) => {
    mode_radio_element.addEventListener('change', () => {
        const active_mode = getSearchMode();
        if (semanticToggle) {
            semanticToggle.checked = active_mode === 'semantic' || active_mode === 'hybrid';
        }
        updateSearchModeUI();
        executeSearchQuery();
    });
});

[
    scopeAnalysis, scopeObjects, scopeTags, sortOrder, negativeQuery,
    document.getElementById('dataStatus'), sceneType, startDate, endDate,
    clusterThemeSelect, facetMediumSelect, facetMoodSelect, facetCompositionSelect
].forEach((filter_input_element) => {
    if (filter_input_element) {
        filter_input_element.addEventListener('change', () => {
            executeSearchQuery();
        });
    }
});

if (negativeQuery) {
    negativeQuery.addEventListener('keydown', (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter') executeSearchQuery();
    });
}

if (searchBtn) {
    searchBtn.addEventListener('click', () => {
        executeSearchQuery();
    });
}

if (searchQuery) {
    searchQuery.addEventListener('keydown', (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter') executeSearchQuery();
    });
}

/**
 * WHAT: Fetches EVoC cluster themes from `/api/clusters/themes` and populates the theme dropdown.
 * WHY:  Exposes discovered semantic visual categories in the search filter bar.
 */
async function loadClusterThemesIntoFilterDropdown() {
    if (!clusterThemeSelect) return;
    try {
        const cluster_themes_http_response = await fetch('/api/clusters/themes');
        if (!cluster_themes_http_response.ok) return;
        const { themes } = await cluster_themes_http_response.json();
        if (!themes || !Array.isArray(themes)) return;

        clusterThemeSelect.innerHTML = '<option value="all">All Cluster Themes</option>';
        themes.forEach((theme_record) => {
            const theme_option_element = document.createElement('option');
            theme_option_element.value = theme_record.theme_name;
            const human_readable_theme_name = theme_record.theme_name.replace(/_/g, ' ');
            theme_option_element.textContent = `${human_readable_theme_name} (${theme_record.item_count})`;
            clusterThemeSelect.appendChild(theme_option_element);
        });
    } catch (load_themes_error) {
        console.warn('[SEARCH] Could not populate cluster themes dropdown:', load_themes_error.message);
    }
}

// ============================================================================
// WORKER INITIALIZATION & SEARCH EXECUTION
// ============================================================================

/**
 * WHAT: Initializes the Web Worker search engine, Pretext layout engine, URL filters, and cluster dropdown.
 * WHY:  Keeps multi-megabyte JSON index parsing and vector math off the main UI thread.
 */
function initializeSearchSystem() {
    if (isInitialized || is_search_system_currently_initializing) return;
    is_search_system_currently_initializing = true;

    if (searchBtn) {
        searchBtn.disabled = true;
        searchBtn.textContent = 'Preparing Search Engine...';
    }

    if (window.PretextLayout) {
        window.PretextLayout.init();
    }

    processUrlParams();
    loadClusterThemesIntoFilterDropdown();

    if (searchWorker) {
        searchWorker.terminate();
        searchWorker = null;
    }

    searchWorker = new Worker('search-worker.js');

    searchWorker.onmessage = function (worker_message_event) {
        const { type: message_type, payload } = worker_message_event.data;

        switch (message_type) {
            case 'READY': {
                console.log(`[MAIN] Search Engine Ready. Items: ${payload.count}. Semantic: ${payload.hasEmbeddings}`);
                isInitialized = true;
                is_search_system_currently_initializing = false;
                if (searchBtn) {
                    searchBtn.disabled = false;
                    searchBtn.textContent = 'Search Images';
                }

                if (!payload.hasEmbeddings) {
                    document.querySelectorAll('input[name="searchMode"]').forEach((mode_radio_element) => {
                        if (mode_radio_element.value === 'hybrid' || mode_radio_element.value === 'semantic') {
                            mode_radio_element.disabled = true;
                        }
                    });
                    const mode_selector_group = document.querySelector('.search-mode-selector')?.closest('.filter-group');
                    if (mode_selector_group) {
                        mode_selector_group.title = "Hybrid & Semantic modes require embeddings. Click 'Generate Data' first.";
                    }
                } else {
                    const hybrid_radio_element = document.querySelector('input[name="searchMode"][value="hybrid"]');
                    if (hybrid_radio_element && !hybrid_radio_element.disabled) {
                        hybrid_radio_element.checked = true;
                        if (semanticToggle) semanticToggle.checked = true;
                        updateSearchModeUI();
                    }
                }

                executeSearchQuery();
                break;
            }

            case 'RESULTS':
                processAndDisplayMatches(payload.results);
                break;

            case 'ERROR':
                console.error('[MAIN] Search Engine Error:', payload);
                if (searchResults) {
                    searchResults.innerHTML = '<div class="error-msg">Failed to load search index.</div>';
                }
                if (searchBtn) {
                    searchBtn.disabled = false;
                    searchBtn.textContent = 'Retry Engine Load';
                }
                is_search_system_currently_initializing = false;
                break;
        }
    };

    searchWorker.postMessage({
        type: 'INIT',
        payload: { fuzziness: parseFloat(fuzzinessSlider ? fuzzinessSlider.value : '0.4') }
    });
}

/**
 * WHAT: Applies pure client-side filters and sorting to raw worker results, then resets and renders the grid.
 * WHY:  Delegates all filtering and sorting to pure functions in `searchFilters.js` while keeping DOM updates isolated.
 *
 * @param {readonly Record<string, any>[]} raw_worker_results - Candidate image records returned by `search-worker.js`.
 */
function processAndDisplayMatches(raw_worker_results) {
    lastWorkerResults = raw_worker_results;
    if (allImages.length === 0 && Array.isArray(raw_worker_results)) {
        allImages = raw_worker_results.slice();
    }

    const active_search_query = searchQuery ? searchQuery.value.trim() : '';
    const active_sort_mode = sortOrder ? sortOrder.value : 'newest';
    const match_logic_mode = document.querySelector('input[name="tagLogic"]:checked')?.value || 'AND';

    const filter_criteria_snapshot = {
        selected_tags: selectedTagFilters,
        selected_objects: selectedObjectFilters,
        tag_filter_mode: match_logic_mode,
        exclude_terms_raw: negativeQuery ? negativeQuery.value.trim() : '',
        scene_type: sceneType ? sceneType.value : 'all',
        date_from: startDate ? startDate.value : '',
        date_to: endDate ? endDate.value : '',
        data_status: document.getElementById('dataStatus')?.value || 'all',
        theme_filter: clusterThemeSelect ? clusterThemeSelect.value : 'all',
        facet_medium: facetMediumSelect ? facetMediumSelect.value : 'all',
        facet_mood: facetMoodSelect ? facetMoodSelect.value : 'all',
        facet_composition: facetCompositionSelect ? facetCompositionSelect.value : 'all'
    };

    const filtered_records = filterImageRecordsByCriteria(raw_worker_results, filter_criteria_snapshot);
    const sorted_filtered_results = sortFilteredImageRecords(
        filtered_records,
        active_sort_mode,
        Boolean(active_search_query)
    );

    if (observer) {
        observer.disconnect();
        observer = null;
    }

    window.currentSearchResults = sorted_filtered_results;
    filteredImages = sorted_filtered_results;
    currentIndex = 0;

    currently_rendered_image_identifier_set.clear();
    if (searchResults) searchResults.innerHTML = '';

    if (resultsCount) resultsCount.textContent = `Found ${sorted_filtered_results.length} results`;
    if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search Images';
    }

    if (sorted_filtered_results.length === 0) {
        if (searchResults) {
            searchResults.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 4rem 2rem;">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">🔍</div>
                    <div style="color: var(--text-secondary); font-size: 1.1rem;">No images found matching your current filters.</div>
                    <button class="action-btn" style="margin-top: 1rem;" onclick="location.reload()">Clear All Filters</button>
                </div>`;
        }
    } else {
        renderNextBatchOfResults();
        setupInfiniteScrollObserver();
    }
}

/**
 * WHAT: Orchestrates keyword, semantic, or hybrid search queries against `search-worker.js` and `/api/embed`.
 * WHY:  Dispatches embedding generation when needed and falls back gracefully to keyword search if the AI server is offline.
 */
async function executeSearchQuery() {
    if (!isInitialized || !searchWorker) return;

    if (observer) {
        observer.disconnect();
        observer = null;
    }

    if (searchBtn) {
        searchBtn.disabled = true;
        searchBtn.innerHTML = '<div class="spinner"></div> Searching...';
    }

    const raw_query_string = searchQuery ? searchQuery.value.trim() : '';
    const active_search_mode = getSearchMode();

    // Fast Laya Query Intent Check in background
    if (raw_query_string && smartIntentIndicator && smartIntentText) {
        fetch('/api/laya/query-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: raw_query_string })
        })
            .then((intent_http_response) => {
                if (!intent_http_response.ok) {
                    throw new Error(`Intent request failed with HTTP ${intent_http_response.status}`);
                }
                return intent_http_response.json();
            })
            .then((intent_payload) => {
                const detected_filter_descriptions = formatDetectedIntentFilterDescriptions(intent_payload);
                if (detected_filter_descriptions.length > 0) {
                    smartIntentText.textContent = `Laya Intent: ${detected_filter_descriptions.join(', ')}`;
                    smartIntentIndicator.style.display = 'block';
                } else {
                    smartIntentIndicator.style.display = 'none';
                }
            })
            .catch(() => {
                smartIntentIndicator.style.display = 'none';
            });
    } else if (smartIntentIndicator) {
        smartIntentIndicator.style.display = 'none';
    }

    if (active_search_mode === 'hybrid' && raw_query_string) {
        try {
            if (searchBtn) searchBtn.textContent = 'Generating Embedding...';
            const embed_http_response = await fetch('/api/embed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: raw_query_string })
            });

            if (!embed_http_response.ok) throw new Error('Local AI server failed to generate a search vector.');
            const vector_payload = await embed_http_response.json();

            if (searchBtn) searchBtn.textContent = 'Fusing Results...';
            searchWorker.postMessage({
                type: 'HYBRID_SEARCH',
                payload: { query: raw_query_string, vector: vector_payload.embedding }
            });
        } catch (hybrid_search_error) {
            console.error('Hybrid Search Failed:', hybrid_search_error);
            console.warn('[MAIN] AI Engine offline. Falling back to Keyword search.');
            searchWorker.postMessage({
                type: 'SEARCH',
                payload: { query: raw_query_string }
            });
        }
    } else if (active_search_mode === 'semantic' && raw_query_string) {
        try {
            if (searchBtn) searchBtn.textContent = 'Analyzing Concept...';
            const embed_http_response = await fetch('/api/embed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: raw_query_string })
            });

            if (!embed_http_response.ok) throw new Error('AI Engine unreachable.');
            const vector_payload = await embed_http_response.json();

            if (searchBtn) searchBtn.textContent = 'Comparing Concepts...';
            searchWorker.postMessage({
                type: 'SEMANTIC_SEARCH',
                payload: { vector: vector_payload.embedding }
            });
        } catch (semantic_search_error) {
            console.error('Semantic Search Failed:', semantic_search_error);
            showAlertModal(
                'AI search failed. Please ensure llama-server is running on port 8080. Error: ' + semantic_search_error.message,
                'Concept Search Error'
            );
            if (searchBtn) {
                searchBtn.disabled = false;
                searchBtn.textContent = 'Search Images';
            }
        }
    } else {
        searchWorker.postMessage({
            type: 'SEARCH',
            payload: { query: raw_query_string }
        });
    }
}

/**
 * WHAT: Reads URL query parameters (`q`, `tag`, `type`, `similar`) to pre-populate filters on page load.
 * WHY:  Allows deep-linking from `tags.html`, `database.html`, or "Find Similar" links.
 */
function processUrlParams() {
    const url_search_params = new URLSearchParams(window.location.search);
    const initial_query = url_search_params.get('q');
    const initial_similar = url_search_params.get('similar');
    const initial_tag = url_search_params.get('tag');

    if (initial_similar) {
        console.log(`[MAIN] Pre-populating 'similar' for ID: ${initial_similar}`);
        findSimilar(initial_similar);
    } else if (initial_query || initial_tag) {
        const raw_query_value = initial_query || initial_tag;
        const decoded_query_value = decodeURIComponent(raw_query_value);
        const url_filter_type = url_search_params.get('type');
        const effective_filter_type = url_filter_type || (initial_tag ? 'tag' : null);

        if (effective_filter_type === 'tag' || effective_filter_type === 'object') {
            addTagFilter(decoded_query_value, effective_filter_type);
        } else if (searchQuery) {
            searchQuery.value = decoded_query_value;
        }
    }
}

/**
 * WHAT: Restarts the background search worker to reload fresh JSON indexes after mutations or pruning.
 * WHY:  Ensures newly generated embeddings, renames, or pruned vectors are immediately reflected in search.
 */
function refreshData() {
    allImages = [];
    if (searchWorker) {
        searchWorker.terminate();
        isInitialized = false;
        is_search_system_currently_initializing = false;
        initializeSearchSystem();
    }
}

// ============================================================================
// INFINITE SCROLL & BATCH CARD RENDERING
// ============================================================================

/**
 * WHAT: Attaches an IntersectionObserver to `#scroll-sentinel` to trigger batch pagination.
 * WHY:  Waiting two animation frames prevents false-positive second-batch loads before initial grid layout settles.
 */
function setupInfiniteScrollObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }

    observer = new IntersectionObserver((intersection_observer_entries) => {
        if (intersection_observer_entries[0].isIntersecting && !isRendering) {
            renderNextBatchOfResults();
        }
    }, { rootMargin: '400px' });

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (sentinel && observer && currentIndex < filteredImages.length) {
                observer.observe(sentinel);
            }
        });
    });
}

/**
 * WHAT: Measures summary height for a single card via Pretext before replacing its DOM markup.
 * WHY:  Preserves layout stability during in-place tag/summary edits.
 *
 * @param {Readonly<Record<string, any>>} image_record - Image record to measure.
 * @param {string} [layout_context='search'] - Pretext font/line-height profile name.
 * @returns {number | undefined} Measured text height in pixels, or `undefined` if Pretext is unavailable.
 */
function measureSingleCardHeight(image_record, layout_context = 'search') {
    if (!window.PretextLayout || !window.PretextLayout.ready) return undefined;
    const summary_text = image_record?.analysis?.summary || '';
    if (!summary_text) return undefined;

    const existing_card_element = document.querySelector(`.card[data-id="${image_record.id}"]`);
    const existing_card_width = existing_card_element ? existing_card_element.clientWidth : 0;
    const grid_container_width = searchResults ? searchResults.offsetWidth : 1000;
    const text_width_pixels = calculatePretextCardTextWidth(grid_container_width, existing_card_width);

    const measurement_result = window.PretextLayout.measureText(summary_text, text_width_pixels, layout_context);
    return measurement_result.height;
}

/**
 * WHAT: Renders a single card's HTML using the pure `buildSearchResultCardHtml` builder and current selection state.
 * WHY:  Centralizes `selectedIds` lookup so both batch rendering and single-card updates share one path.
 *
 * @param {Readonly<Record<string, any>>} image_record - Image record to render.
 * @param {number | undefined} summary_height_pixels - Pre-measured summary height.
 * @param {boolean} [is_priority_lcp=false] - Whether this card is the top-left LCP image.
 * @param {boolean} [is_eager_loaded=false] - Whether to load the thumbnail eagerly.
 * @returns {string} Complete HTML markup for the card.
 */
function renderCardMarkup(image_record, summary_height_pixels, is_priority_lcp = false, is_eager_loaded = false) {
    return buildSearchResultCardHtml(image_record, {
        summary_height_pixels,
        is_selected: selectedIds.has(String(image_record.id)),
        is_priority_lcp,
        is_eager_loaded
    });
}

/**
 * WHAT: Slices the next batch from `filteredImages`, pre-measures heights via Pretext, and appends cards to `#searchResults`.
 * WHY:  Batching keeps DOM mutations fast while `currently_rendered_image_identifier_set` guarantees zero duplicate cards.
 */
function renderNextBatchOfResults() {
    if (isRendering || currentIndex >= filteredImages.length) {
        if (currentIndex >= filteredImages.length && observer) {
            observer.disconnect();
            observer = null;
        }
        return;
    }

    isRendering = true;

    const batch_start_index = currentIndex;
    const candidate_batch_images = filteredImages.slice(batch_start_index, batch_start_index + BATCH_SIZE);
    currentIndex += candidate_batch_images.length;

    const deduplicated_batch_images = candidate_batch_images.filter((candidate_image_record) => {
        const image_unique_identifier_string = String(candidate_image_record.id);
        if (currently_rendered_image_identifier_set.has(image_unique_identifier_string)) {
            return false;
        }
        currently_rendered_image_identifier_set.add(image_unique_identifier_string);
        return true;
    });

    if (deduplicated_batch_images.length === 0) {
        isRendering = false;
        if (currentIndex < filteredImages.length) {
            renderNextBatchOfResults();
        }
        return;
    }

    let summary_heights_map = new Map();
    if (window.PretextLayout && window.PretextLayout.ready) {
        const container_total_pixel_width = searchResults && searchResults.offsetWidth > 0 ? searchResults.offsetWidth : 1000;
        const approximate_column_count = Math.max(1, Math.floor((container_total_pixel_width + 16) / (420 + 16)));
        const estimated_card_pixel_width = (container_total_pixel_width - (approximate_column_count - 1) * 16) / approximate_column_count;
        const text_usable_pixel_width = Math.max(100, estimated_card_pixel_width - 24);

        const text_measurement_payload_array = deduplicated_batch_images.map((image_record) => ({
            id: image_record.id,
            text: image_record?.analysis?.summary || ''
        }));

        summary_heights_map = window.PretextLayout.measureBatch(text_measurement_payload_array, text_usable_pixel_width, 'search');
    }

    let final_batch_concatenated_html_string = '';
    const is_first_page = batch_start_index === 0;

    deduplicated_batch_images.forEach((image_record, batch_position_index) => {
        try {
            const measured_summary_height = summary_heights_map.get(String(image_record.id));
            const is_priority_image = is_first_page && batch_position_index === 0;
            const is_eager_load = is_first_page && batch_position_index < 4;

            final_batch_concatenated_html_string += renderCardMarkup(
                image_record,
                measured_summary_height,
                is_priority_image,
                is_eager_load
            );
        } catch (card_rendering_error) {
            console.error('Error rendering search result card:', image_record, card_rendering_error);
        }
    });

    if (searchResults) {
        searchResults.insertAdjacentHTML('beforeend', final_batch_concatenated_html_string);
        syncGridPrismGeometry();
    }

    isRendering = false;
}

// ============================================================================
// 3D PRISM GEOMETRY, TOASTS & CARD STATE CONTROLLERS
// ============================================================================

/**
 * WHAT: Displays an ephemeral floating toast notification in the UI.
 * WHY: Provides immediate visual feedback for actions like Dicing and Thumbnail Regeneration without blocking modal popups.
 *
 * @param {string} toast_message - Content string to display.
 * @param {'info' | 'success' | 'error'} [notification_type='info'] - Visual style of toast.
 */
function showToast(toast_message, notification_type = 'info') {
    const toast_notification_element = document.createElement('div');
    toast_notification_element.className = `toast-notification ${notification_type}`;

    let icon_glyph = 'ℹ️';
    if (notification_type === 'success') icon_glyph = '✅';
    if (notification_type === 'error') icon_glyph = '⚠️';

    toast_notification_element.innerHTML = `
        <span style="font-size: 1.2rem;">${icon_glyph}</span>
        <span>${escapeHtmlCharacters(toast_message)}</span>
    `;

    document.body.appendChild(toast_notification_element);

    setTimeout(() => {
        toast_notification_element.style.animation = 'fadeOut 0.3s forwards';
        toast_notification_element.addEventListener('animationend', () => toast_notification_element.remove());
    }, 3000);
}

/**
 * WHAT: Calculates the equilateral 3D triangular prism radius (apothem) for `#searchResults` based on actual card column width.
 * WHY: Dynamically sets `--prism-r` so 3D rotation edges meet cleanly with razor-sharp geometry matching Database cards.
 */
function syncGridPrismGeometry() {
    if (!searchResults) return;
    const sample_card_element = searchResults.querySelector('.card');
    const measured_card_width = (sample_card_element && sample_card_element.clientWidth > 0)
        ? sample_card_element.clientWidth
        : computeCardPixelWidthFromGridWidth(searchResults.offsetWidth);
    const prism_radius_pixels = computeTriangularPrismRadiusPixels(measured_card_width);
    searchResults.style.setProperty('--prism-r', `${prism_radius_pixels}px`);
}

if (typeof ResizeObserver !== 'undefined' && searchResults) {
    const search_grid_prism_resize_observer = new ResizeObserver(() => {
        syncGridPrismGeometry();
    });
    search_grid_prism_resize_observer.observe(searchResults);
}

/**
 * WHAT: Updates a search card element's active face (`1`, `2`, or `3`) and triggers its 3D Y-axis prism spin.
 * WHY: Matches Database card behavior by smoothly rotating `--spin-deg` in 120-degree equilateral steps and toggling active pill states.
 *
 * @param {HTMLElement} card_element - Target card DOM element.
 * @param {string | number} target_side - Face number (`1` for Summary, `2` for Tags/Objects, `3` for Diced Prompt).
 * @param {Record<string, any>} [transition_options={}] - Optional instant flag or overridden spin degrees.
 */
function applyCardSideState(card_element, target_side, transition_options = {}) {
    if (!card_element) return;
    const normalized_side = ['1', '2', '3'].includes(String(target_side)) ? String(target_side) : '1';
    const previous_side = card_element.getAttribute('data-side') || '1';
    const current_spin_degrees = Number(card_element.getAttribute('data-spin-deg')) || 0;

    syncGridPrismGeometry();

    const next_spin_degrees = Number.isFinite(transition_options.override_spin_degrees)
        ? Number(transition_options.override_spin_degrees)
        : computeNextPrismSpinDegrees(current_spin_degrees, previous_side, normalized_side);

    const card_inner_element = card_element.querySelector('.card-inner');
    if (transition_options.instant && card_inner_element) {
        card_inner_element.style.transition = 'none';
    }

    card_element.setAttribute('data-side', normalized_side);
    card_element.setAttribute('data-spin-deg', String(next_spin_degrees));
    card_element.style.setProperty('--spin-deg', `${next_spin_degrees}deg`);

    if (normalized_side === '1') {
        card_element.classList.remove('flipped');
    } else {
        card_element.classList.add('flipped');
    }

    card_element.querySelectorAll('.card-side-pill[data-target-side]').forEach((pill_button_element) => {
        const pill_target_side = pill_button_element.getAttribute('data-target-side');
        if (pill_target_side === normalized_side && normalized_side !== '1') {
            pill_button_element.classList.add('active');
        } else {
            pill_button_element.classList.remove('active');
        }
    });

    if (transition_options.instant && card_inner_element && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                card_inner_element.style.transition = '';
            });
        });
    }

    if (normalized_side === '3') {
        ensureSearchCardDicedPromptLoaded(card_element);
    }
}

/**
 * WHAT: Purely parses a diced prompt payload (JSON string or object) into a validated Master Record.
 * WHY: Isolates JSON parsing and structural validation from async network/DOM side effects.
 *
 * @param {string | Record<string, any> | null | undefined} raw_diced_prompt_value - Raw field from SQLite.
 * @returns {Record<string, any> | null} Validated Master Record with ingredients array, or null.
 */
function parseValidatedDicedPromptRecord(raw_diced_prompt_value) {
    if (!raw_diced_prompt_value) return null;

    let parsed_diced_prompt_record = null;
    if (typeof raw_diced_prompt_value === 'string') {
        try {
            parsed_diced_prompt_record = JSON.parse(raw_diced_prompt_value);
        } catch (_json_parse_error) {
            return null;
        }
    } else if (typeof raw_diced_prompt_value === 'object') {
        parsed_diced_prompt_record = raw_diced_prompt_value;
    }

    if (!parsed_diced_prompt_record || !Array.isArray(parsed_diced_prompt_record.ingredients)) {
        return null;
    }
    return parsed_diced_prompt_record;
}

/**
 * WHAT: Lazily loads the full Diced Prompt Master Record from SQLite when Face 3 is revealed on Search cards.
 * WHY: search-data.json omits bulky diced prompt trees to keep initial download size under 20MB.
 *      Fetching on-demand when the user rotates to Face 3 ensures cards display real ingredients and influences.
 *
 * @param {HTMLElement} card_element - Target card DOM node.
 */
async function ensureSearchCardDicedPromptLoaded(card_element) {
    // WHAT: Guard against missing card elements or cards that already have their diced prompt rendered.
    // WHY: Only cards still displaying the fallback `.dice-card-btn` placeholder need a live SQLite fetch.
    if (!card_element) return;
    const placeholder_dice_button = card_element.querySelector('.dice-card-btn');
    if (!placeholder_dice_button) return;

    const numeric_image_identifier = Number(card_element.dataset.id);
    if (!Number.isFinite(numeric_image_identifier)) return;

    // WHAT: Skip network fetch if the in-memory search record already holds a populated diced prompt object.
    // WHY: Avoids redundant HTTP requests if the user flips back and forth between card faces.
    const cached_image_record = findCachedImageRecordById(numeric_image_identifier);
    if (cached_image_record && cached_image_record.diced_prompt && typeof cached_image_record.diced_prompt === 'object') {
        return;
    }

    try {
        // WHAT: Fetches the complete single-image record including `diced_prompt` from SQLite via Express.
        // WHY: `GET /images?id=` joins `images` with `diced_prompts` to deliver the full Master Record.
        const http_image_response = await fetch(`${API_BASE_URL}/images?id=${numeric_image_identifier}`);
        if (!http_image_response.ok) return;

        const image_payload = await http_image_response.json();
        const incoming_full_image_record = image_payload?.image;
        const parsed_diced_prompt_record = parseValidatedDicedPromptRecord(incoming_full_image_record?.diced_prompt);
        if (!parsed_diced_prompt_record) return;

        if (cached_image_record) {
            cached_image_record.diced_prompt = parsed_diced_prompt_record;
        }

        // WHAT: Replaces the Face 3 inner HTML in-place with the hydrated Diced Prompt Master Record.
        // WHY: Updating only `.card-back-dicer` preserves the active 3D prism rotation without jarring re-layouts.
        const dicer_face_element = card_element.querySelector('.card-back-dicer');
        if (dicer_face_element) {
            const cache_busting_timestamp_ms = (cached_image_record?.updated_at)
                ? new Date(cached_image_record.updated_at).getTime()
                : (cached_image_record?.created_at ? new Date(cached_image_record.created_at).getTime() : '');
            const thumbnail_display_path = `thumbnails/id_${numeric_image_identifier}.avif${cache_busting_timestamp_ms ? '?t=' + cache_busting_timestamp_ms : ''}`;
            const display_date_string = new Date(cached_image_record?.created_at || Date.now()).toLocaleDateString();

            const back_identity_header_html = buildCardBackIdentityHeaderHtml({
                image_id: numeric_image_identifier,
                display_path: thumbnail_display_path,
                full_path: cached_image_record?.path || '',
                filename_text: cached_image_record?.filename || '',
                metadata_tooltip: cached_image_record?.path || '',
                date_text: display_date_string,
                width_text: cached_image_record?.width || 'N/A',
                height_text: cached_image_record?.height || 'N/A',
                is_eager: false
            });

            dicer_face_element.innerHTML = `
                ${back_identity_header_html}
                ${renderDicedPromptBackDetailsHtml(cached_image_record || incoming_full_image_record, parsed_diced_prompt_record)}
                <div style="margin-top: 0.85rem; text-align: center;">
                    <button class="card-side-pill" data-target-side="1" style="border-color: var(--accent); color: var(--accent);">Back to Summary (1/3) ↻</button>
                </div>
            `;
        }
    } catch (lazy_diced_load_error) {
        console.warn(`[Search] Lazy diced prompt lookup failed for image #${numeric_image_identifier}:`, lazy_diced_load_error);
    }
}

/**
 * WHAT: Dices an image prompt on demand via `POST /api/dicer/dice` and re-renders its card in place.
 * WHY: Matches Database card capability to run the prompt dicing pipeline directly from Face 3 while keeping 3D prism face intact.
 *
 * @param {string | number} target_image_identifier - Target image ID.
 */
async function diceSingleImageAndRefreshCard(target_image_identifier) {
    const numeric_image_identifier = Number(target_image_identifier);
    if (!Number.isFinite(numeric_image_identifier)) return;

    showToast(`🧩 Dicing prompt for image #${numeric_image_identifier} (Pass A–D)...`, 'info');
    try {
        const http_dice_response = await fetch(`${API_BASE_URL}/api/dicer/dice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image_id: numeric_image_identifier,
                media_type: 'image',
                run_pass_d: true
            })
        });

        if (!http_dice_response.ok) {
            const error_payload = await http_dice_response.json();
            throw new Error(error_payload.error || 'Dicing request failed');
        }

        const dice_payload = await http_dice_response.json();
        const master_record = dice_payload.master_record;

        const target_image_record = allImages.find(
            single_image_record => Number(single_image_record.id) === numeric_image_identifier
        );
        if (target_image_record) {
            target_image_record.diced_prompt = master_record;
            if (dice_payload.updated_analysis) {
                target_image_record.analysis = dice_payload.updated_analysis;
            } else {
                const parsed_analysis = (() => {
                    if (typeof target_image_record.analysis !== 'string') {
                        return target_image_record.analysis;
                    }
                    try {
                        return JSON.parse(target_image_record.analysis || '{}');
                    } catch (_analysis_parse_error) {
                        return {};
                    }
                })();
                target_image_record.analysis = { ...(parsed_analysis || {}), diced_prompt: master_record };
            }

            const existing_card_element = searchResults.querySelector(`.card[data-id="${numeric_image_identifier}"]`);
            if (existing_card_element) {
                const previous_side = existing_card_element.getAttribute('data-side') || '1';
                const previous_spin_degrees = existing_card_element.getAttribute('data-spin-deg');
                const updated_card_html = renderCardMarkup(
                    target_image_record,
                    measureSingleCardHeight(target_image_record)
                );
                const temporary_container = document.createElement('div');
                temporary_container.innerHTML = updated_card_html;
                const replacement_card_element = temporary_container.firstElementChild;
                existing_card_element.replaceWith(replacement_card_element);
                if (replacement_card_element) {
                    applyCardSideState(replacement_card_element, previous_side, {
                        instant: true,
                        override_spin_degrees: previous_spin_degrees !== null ? Number(previous_spin_degrees) : null
                    });
                }
            }
        }

        const total_ingredients_count = master_record.ingredients.length;
        const concreteness_percentage = Math.round((Number(master_record.metrics?.physicality_ratio) || 0) * 100);
        showToast(
            `✓ Saved ${master_record.prompt_id} to images.db (${total_ingredients_count} ingredients, ${concreteness_percentage}% concrete)`,
            'success'
        );
    } catch (dice_processing_error) {
        console.error('[SEARCH-DICER] Error dicing image:', dice_processing_error);
        showToast(`Dicing failed: ${dice_processing_error.message}`, 'error');
    }
}

// ============================================================================
// CARD DELEGATION & DELETION
// ============================================================================

if (searchResults) {
    searchResults.addEventListener('click', async (click_event) => {
        // 1. Navigation Pill Face Switch (Face 2 -> Face 3, Face 3 -> Face 1)
        const side_pill_button = click_event.target.closest('.card-side-pill[data-target-side]');
        if (side_pill_button) {
            click_event.stopPropagation();
            const parent_card = side_pill_button.closest('.card');
            applyCardSideState(parent_card, side_pill_button.getAttribute('data-target-side'));
            return;
        }

        // 2. Re-Dice Prompt Button on Face 3
        const dice_button_element = click_event.target.closest('.dice-card-btn');
        if (dice_button_element) {
            click_event.stopPropagation();
            const target_image_identifier = dice_button_element.dataset.id;
            dice_button_element.disabled = true;
            await diceSingleImageAndRefreshCard(target_image_identifier);
            dice_button_element.disabled = false;
            return;
        }

        // 3. Open in Prompt Dicer External Link
        const open_dicer_link = click_event.target.closest('.open-dicer-link');
        if (open_dicer_link) {
            click_event.stopPropagation();
            return;
        }

        // 4. Regenerate Thumbnail Button on Back Identity Header
        const regen_thumb_button = click_event.target.closest('.regen-thumb-btn');
        if (regen_thumb_button) {
            click_event.stopPropagation();
            const target_image_identifier = regen_thumb_button.dataset.id;
            const parent_card = regen_thumb_button.closest('.card');
            regen_thumb_button.disabled = true;
            regen_thumb_button.textContent = '...';
            try {
                const response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: target_image_identifier })
                });
                if (response.ok) {
                    const data = await response.json();
                    const refreshed_thumbnail_url = `${data.thumbPath}?t=${Date.now()}`;
                    parent_card.querySelectorAll('.thumbnail-preview').forEach((thumbnail_image_element) => {
                        thumbnail_image_element.src = refreshed_thumbnail_url;
                        thumbnail_image_element.style.display = 'block';
                    });
                    parent_card.querySelectorAll('.thumb-fallback').forEach((fallback_element) => {
                        fallback_element.style.display = 'none';
                    });
                    showToast('Thumbnail regenerated', 'success');
                } else {
                    showToast('Failed to regenerate thumbnail', 'error');
                }
            } catch (regeneration_network_error) {
                console.error('[SEARCH-REGEN] Error regenerating thumbnail:', regeneration_network_error);
                showToast('Error regenerating thumbnail', 'error');
            } finally {
                regen_thumb_button.disabled = false;
                regen_thumb_button.textContent = '🔄 Regen';
            }
            return;
        }

        // 5. Copy AI Summary Text Button
        const copy_button_element = click_event.target.closest('.copy-btn');
        if (copy_button_element) {
            click_event.stopPropagation();
            const text_to_copy = copy_button_element.dataset.text;
            if (text_to_copy) {
                navigator.clipboard.writeText(text_to_copy).then(() => {
                    const original_label_text = copy_button_element.textContent;
                    copy_button_element.textContent = 'Copied!';
                    copy_button_element.style.borderColor = 'var(--accent)';
                    copy_button_element.style.color = 'var(--accent)';
                    setTimeout(() => {
                        copy_button_element.textContent = original_label_text;
                        copy_button_element.style.borderColor = 'var(--border)';
                        copy_button_element.style.color = 'var(--text-secondary)';
                    }, 2000);
                }).catch((clipboard_error) => {
                    console.error('Failed to copy to clipboard', clipboard_error);
                });
            }
            return;
        }

        // 6. Thumbnail Preview Lightbox
        if (click_event.target.classList.contains('thumbnail-preview')) {
            click_event.stopPropagation();
            const full_filesystem_path = click_event.target.dataset.fullpath;
            if (full_filesystem_path) showImagePreview(full_filesystem_path);
            return;
        }

        // 7. Tag Chip Search Filtering
        const tag_chip_element = click_event.target.closest('.tag.editable');
        if (tag_chip_element) {
            click_event.stopPropagation();
            const tag_text_value = tag_chip_element.dataset.tag;
            const data_collection_type = tag_chip_element.dataset.type;
            if (tag_text_value) {
                const filter_type = data_collection_type === 'objects' ? 'object' : 'tag';
                addTagFilter(tag_text_value, filter_type);
            }
            return;
        }

        // 8. Delete Image Button
        const delete_button_element = click_event.target.closest('.delete-btn');
        if (delete_button_element) {
            click_event.stopPropagation();
            const image_identifier = delete_button_element.dataset.id;
            const card_element = delete_button_element.closest('.card');
            const full_filesystem_path = card_element?.querySelector('.file-link')?.dataset.path || '';
            showDeleteModal(image_identifier, full_filesystem_path, card_element, deleteFromDatabase);
            return;
        }

        // 9. Add Tag Button
        const add_tag_button_element = click_event.target.closest('.add-tag-btn');
        if (add_tag_button_element) {
            click_event.stopPropagation();
            const image_identifier = add_tag_button_element.dataset.id;
            const tag_or_object_type = add_tag_button_element.dataset.type;
            addTag(image_identifier, tag_or_object_type);
            return;
        }

        // 10. Three-Sided Equilateral Card Prism Rotation: Side 1 (Summary) -> Side 2 (Tags) -> Side 3 (Dicer) -> Side 1
        const card_element = click_event.target.closest('.card');
        if (card_element) {
            const is_interactive_target = click_event.target.closest('button, a, input, label, .file-link, .tag, .thumbnail-preview');
            if (!is_interactive_target) {
                const current_side = card_element.getAttribute('data-side') || (card_element.classList.contains('flipped') ? '2' : '1');
                const next_side = current_side === '1' ? '2' : (current_side === '2' ? '3' : '1');
                applyCardSideState(card_element, next_side);
            }
        }
    });

    searchResults.addEventListener('change', (change_event) => {
        if (change_event.target.classList.contains('card-select-cb')) {
            const image_identifier = change_event.target.dataset.id;
            const card_element = change_event.target.closest('.card');
            if (change_event.target.checked) {
                selectedIds.add(String(image_identifier));
                if (card_element) card_element.classList.add('selected');
            } else {
                selectedIds.delete(String(image_identifier));
                if (card_element) card_element.classList.remove('selected');
            }
            updateProcessButton();
        }
    });
}

/**
 * WHAT: Deletes an image record via `DELETE /images/:id`, animates out its card, and updates the result count.
 * WHY:  Passed as an explicit callback to `showDeleteModal` so modal UI remains decoupled from search state.
 *
 * @param {string | number} image_identifier - Target image ID.
 * @param {HTMLElement} card_element - Card element to fade out and remove.
 */
async function deleteFromDatabase(image_identifier, card_element) {
    try {
        const http_response = await fetch(`${API_BASE_URL}/images/${image_identifier}`, {
            method: 'DELETE'
        });

        if (http_response.ok || http_response.status === 404) {
            if (card_element) {
                card_element.style.opacity = '0';
                setTimeout(() => card_element.remove(), 300);
            }

            if (resultsCount) {
                const count_match = resultsCount.textContent.match(/\d+/);
                const current_count = count_match ? parseInt(count_match[0], 10) : 0;
                resultsCount.textContent = `Found ${Math.max(0, current_count - 1)} results`;
            }
        } else {
            showAlertModal('Failed to delete entry from database', 'Database Error');
        }
    } catch (delete_error) {
        console.error('Error deleting from DB:', delete_error);
        showAlertModal('Failed to delete entry from database: ' + delete_error.message, 'Database Error');
    }
}

// ============================================================================
// CONTEXT MENU & INLINE METADATA EDITING
// ============================================================================

/**
 * WHAT: Positions and displays the custom right-click context menu for thumbnails, tags, files, or summaries.
 * WHY:  Reveals only the menu actions relevant to the right-clicked target type.
 */
function showContextMenu(pointer_event, image_identifier, target_type, target_value = null, card_element = null) {
    if (!contextMenu) return;
    context_menu_target_state = {
        id: image_identifier,
        type: target_type,
        tag: target_value,
        card: card_element
    };
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${pointer_event.clientX}px`;
    contextMenu.style.top = `${pointer_event.clientY}px`;

    const regen_item = document.getElementById('ctxRegenThumb');
    const edit_item = document.getElementById('ctxEdit');
    const delete_item = document.getElementById('ctxDelete');
    const rename_item = document.getElementById('ctxRename');
    const edit_summary_item = document.getElementById('ctxEditSummary');
    const reparse_summary_item = document.getElementById('ctxReparseSummary');
    const reanalyze_item = document.getElementById('ctxReAnalyze');

    if (target_type === 'thumbnail') {
        if (regen_item) regen_item.style.display = 'block';
        if (edit_item) edit_item.style.display = 'none';
        if (delete_item) delete_item.style.display = 'none';
        if (rename_item) rename_item.style.display = 'none';
        if (edit_summary_item) edit_summary_item.style.display = 'none';
    } else if (target_type === 'file') {
        if (regen_item) regen_item.style.display = 'none';
        if (edit_item) edit_item.style.display = 'none';
        if (delete_item) delete_item.style.display = 'none';
        if (rename_item) rename_item.style.display = 'block';
        if (edit_summary_item) edit_summary_item.style.display = 'none';
    } else if (target_type === 'summary') {
        if (regen_item) regen_item.style.display = 'none';
        if (edit_item) edit_item.style.display = 'none';
        if (delete_item) delete_item.style.display = 'none';
        if (rename_item) rename_item.style.display = 'none';
        if (edit_summary_item) edit_summary_item.style.display = 'block';
        if (reparse_summary_item) reparse_summary_item.style.display = 'block';
        if (reanalyze_item) reanalyze_item.style.display = 'block';
    } else {
        if (regen_item) regen_item.style.display = 'none';
        if (edit_item) edit_item.style.display = 'block';
        if (delete_item) delete_item.style.display = 'block';
        if (rename_item) rename_item.style.display = 'none';
        if (edit_summary_item) edit_summary_item.style.display = 'none';
        if (reparse_summary_item) reparse_summary_item.style.display = 'none';
        if (reanalyze_item) reanalyze_item.style.display = 'none';
    }
}

/**
 * WHAT: Hides the context menu and clears the active target state.
 * WHY:  Prevents stale right-click targets from persisting after menu dismissal.
 */
function hideContextMenu() {
    if (contextMenu) contextMenu.style.display = 'none';
    context_menu_target_state = null;
}

document.addEventListener('click', () => {
    hideContextMenu();
});

document.addEventListener('contextmenu', (contextmenu_event) => {
    const thumbnail_element = contextmenu_event.target.closest('.thumbnail-preview');
    if (thumbnail_element) {
        contextmenu_event.preventDefault();
        const card_element = thumbnail_element.closest('.card');
        showContextMenu(contextmenu_event, card_element.dataset.id, 'thumbnail', null, card_element);
        return;
    }

    const tag_chip_element = contextmenu_event.target.closest('.tag.editable');
    if (tag_chip_element) {
        contextmenu_event.preventDefault();
        contextmenu_event.stopPropagation();
        showContextMenu(
            contextmenu_event,
            tag_chip_element.dataset.id,
            tag_chip_element.dataset.type,
            tag_chip_element.dataset.tag
        );
        return;
    }

    const file_link_element = contextmenu_event.target.closest('.file-link');
    if (file_link_element) {
        contextmenu_event.preventDefault();
        contextmenu_event.stopPropagation();
        const card_element = file_link_element.closest('.card');
        const filename_string = file_link_element.textContent.trim();
        showContextMenu(contextmenu_event, card_element.dataset.id, 'file', filename_string, card_element);
        return;
    }

    const summary_text_element = contextmenu_event.target.closest('.summary-text');
    if (summary_text_element) {
        contextmenu_event.preventDefault();
        contextmenu_event.stopPropagation();
        const image_identifier = summary_text_element.dataset.id;
        const matched_image_record = findCachedImageRecordById(image_identifier);
        const summary_string = matched_image_record
            ? matched_image_record.analysis.summary
            : summary_text_element.innerText.replace('Copy', '').trim();
        showContextMenu(contextmenu_event, image_identifier, 'summary', summary_string);
        return;
    }

    hideContextMenu();
});

/**
 * WHAT: Looks up an image record across `allImages` or `window.currentSearchResults` by ID.
 * WHY:  Avoids duplicating cache lookup logic across summary editing, reparsing, re-analyzing, and tag updates.
 *
 * @param {string | number} image_identifier - Target image ID.
 * @returns {Record<string, any> | null} Matched image record or `null`.
 */
function findCachedImageRecordById(image_identifier) {
    return (
        allImages.find((single_image_record) => single_image_record.id == image_identifier) ||
        (window.currentSearchResults &&
            window.currentSearchResults.find((single_image_record) => single_image_record.id == image_identifier)) ||
        null
    );
}

/**
 * WHAT: Updates an image's cached analysis across `allImages`, `currentSearchResults`, and `filteredImages`,
 *       then re-renders the visible DOM card in place.
 * WHY:  Keeps all client-side caches synchronized with server updates without a full grid reload.
 *
 * @param {string | number} image_identifier - Target image ID.
 * @param {Record<string, any>} updated_analysis_record - Normalized analysis payload.
 * @param {string | undefined} [updated_at_timestamp] - Optional updated timestamp.
 */
function syncImageAnalysisInCachesAndDom(image_identifier, updated_analysis_record, updated_at_timestamp = undefined) {
    const master_image_record = allImages.find((single_image_record) => single_image_record.id == image_identifier);
    const result_image_record = window.currentSearchResults
        ? window.currentSearchResults.find((single_image_record) => single_image_record.id == image_identifier)
        : null;
    const filtered_image_record = filteredImages
        ? filteredImages.find((single_image_record) => single_image_record.id == image_identifier)
        : null;

    [master_image_record, result_image_record, filtered_image_record].forEach((cached_record) => {
        if (cached_record) {
            cached_record.analysis = updated_analysis_record;
            if (updated_at_timestamp) cached_record.updated_at = updated_at_timestamp;
        }
    });

    const target_image_record = master_image_record || result_image_record || filtered_image_record;
    const card_element = document.querySelector(`.card[data-id="${image_identifier}"]`);
    if (card_element && target_image_record) {
        const previous_side = card_element.getAttribute('data-side') || '1';
        const previous_spin_degrees = card_element.getAttribute('data-spin-deg');
        const temporary_container = document.createElement('div');
        temporary_container.innerHTML = renderCardMarkup(target_image_record, measureSingleCardHeight(target_image_record));
        const replacement_card_element = temporary_container.firstElementChild;
        card_element.replaceWith(replacement_card_element);
        if (replacement_card_element) {
            applyCardSideState(replacement_card_element, previous_side, {
                instant: true,
                override_spin_degrees: previous_spin_degrees !== null ? Number(previous_spin_degrees) : null
            });
        }
    }
}

// ============================================================================
// CONTEXT MENU ACTION HANDLERS
// ============================================================================

const ctxRename = document.getElementById('ctxRename');
if (ctxRename) {
    ctxRename.addEventListener('click', (click_event) => {
        click_event.stopPropagation();
        if (!context_menu_target_state) return;
        const { id: image_identifier, tag: current_filename } = context_menu_target_state;
        hideContextMenu();

        const current_base_name = current_filename.substring(0, current_filename.lastIndexOf('.')) || current_filename;

        showTagInputModal('Rename File', current_base_name, async (entered_new_name) => {
            if (!entered_new_name || entered_new_name === current_base_name) return;

            if (entered_new_name.match(/[<>:"\/\\|?*]/)) {
                showAlertModal('Invalid characters in filename. Avoid: < > : " / \\ | ? *', 'Invalid Name');
                return;
            }

            try {
                const http_response = await fetch(`${API_BASE_URL}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: image_identifier, newFilename: entered_new_name })
                });

                if (!http_response.ok) {
                    const error_payload = await http_response.json();
                    throw new Error(error_payload.error || 'Rename failed');
                }

                const rename_payload = await http_response.json();
                const card_element = document.querySelector(`.card[data-id="${image_identifier}"]`);
                if (card_element) {
                    const file_link_element = card_element.querySelector('.file-link');
                    if (file_link_element) {
                        file_link_element.textContent = rename_payload.newFilename;
                        file_link_element.dataset.path = rename_payload.newPath;
                    }
                    const matched_image_record = findCachedImageRecordById(image_identifier);
                    if (matched_image_record) {
                        matched_image_record.filename = rename_payload.newFilename;
                        matched_image_record.path = rename_payload.newPath;
                    }
                }
            } catch (rename_error) {
                showAlertModal('Rename Error: ' + rename_error.message, 'Rename error');
            }
        });
    });
}

const ctxRegenThumb = document.getElementById('ctxRegenThumb');
if (ctxRegenThumb) {
    ctxRegenThumb.addEventListener('click', async () => {
        if (!context_menu_target_state || context_menu_target_state.type !== 'thumbnail') return;
        const { id: image_identifier, card: card_element } = context_menu_target_state;
        hideContextMenu();
        await regenerateThumbnail(image_identifier, card_element);
    });
}

const ctxFindSimilar = document.getElementById('ctxFindSimilar');
if (ctxFindSimilar) {
    ctxFindSimilar.addEventListener('click', () => {
        if (!context_menu_target_state) return;
        const { id: image_identifier } = context_menu_target_state;
        hideContextMenu();
        findSimilar(image_identifier);
    });
}

const ctxEdit = document.getElementById('ctxEdit');
if (ctxEdit) {
    ctxEdit.addEventListener('click', (click_event) => {
        click_event.stopPropagation();
        if (!context_menu_target_state) return;
        const { id: image_identifier, tag: original_tag_value, type: tag_collection_type } = context_menu_target_state;
        hideContextMenu();

        showTagInputModal(`Edit ${tag_collection_type.slice(0, -1)}`, original_tag_value, (entered_new_tag) => {
            if (entered_new_tag && entered_new_tag.trim() !== original_tag_value) {
                updateTag(image_identifier, tag_collection_type, original_tag_value, entered_new_tag.trim(), 'edit');
            }
        });
    });
}

const ctxDelete = document.getElementById('ctxDelete');
if (ctxDelete) {
    ctxDelete.addEventListener('click', (click_event) => {
        click_event.stopPropagation();
        if (!context_menu_target_state) return;
        const { id: image_identifier, tag: target_tag_value, type: tag_collection_type } = context_menu_target_state;
        hideContextMenu();

        showConfirmModal(`Delete "${target_tag_value}"?`, () => {
            updateTag(image_identifier, tag_collection_type, target_tag_value, null, 'delete');
        });
    });
}

const ctxEditSummary = document.getElementById('ctxEditSummary');
if (ctxEditSummary) {
    ctxEditSummary.addEventListener('click', (click_event) => {
        click_event.stopPropagation();
        if (!context_menu_target_state) return;
        const { id: image_identifier, tag: current_summary_text } = context_menu_target_state;
        hideContextMenu();

        showSummaryInputModal('Edit Description', current_summary_text, (entered_new_summary) => {
            if (entered_new_summary !== null && entered_new_summary.trim() !== current_summary_text) {
                updateTag(image_identifier, 'summary', current_summary_text, entered_new_summary.trim(), 'edit');
            }
        });
    });
}

const ctxReparseSummary = document.getElementById('ctxReparseSummary');
if (ctxReparseSummary) {
    ctxReparseSummary.addEventListener('click', async (click_event) => {
        click_event.stopPropagation();
        if (!context_menu_target_state) return;
        const { id: image_identifier } = context_menu_target_state;
        hideContextMenu();

        try {
            const http_response = await fetch(`${API_BASE_URL}/reparse-analysis`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: image_identifier })
            });

            const reparse_payload = await http_response.json();
            if (reparse_payload.success) {
                syncImageAnalysisInCachesAndDom(image_identifier, reparse_payload.analysis);
                showAlertModal('Successfully recovered tags and objects from processed description!', 'Success');
            } else {
                showAlertModal(reparse_payload.message || 'Description could not be reparsed.', 'Reparse Failed');
            }
        } catch (_reparse_error) {
            showAlertModal('Error connecting to server for reparse.', 'Error');
        }
    });
}

const ctxReAnalyze = document.getElementById('ctxReAnalyze');
if (ctxReAnalyze) {
    ctxReAnalyze.addEventListener('click', async (click_event) => {
        click_event.stopPropagation();
        if (!context_menu_target_state) return;
        const { id: image_identifier } = context_menu_target_state;
        hideContextMenu();

        const loading_modal_element = document.createElement('div');
        loading_modal_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10000; color: white; font-weight: bold; flex-direction: column; gap: 1rem;';
        loading_modal_element.innerHTML = '<div>🔍 Analyzing Image...</div><div style="font-size: 0.8rem; font-weight: normal;">This may take a few seconds</div>';
        document.body.appendChild(loading_modal_element);

        try {
            const http_response = await fetch(`${API_BASE_URL}/re-analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: image_identifier })
            });

            const reanalyze_payload = await http_response.json();
            loading_modal_element.remove();

            if (reanalyze_payload.success) {
                syncImageAnalysisInCachesAndDom(
                    image_identifier,
                    reanalyze_payload.analysis,
                    reanalyze_payload.updated_at
                );
            } else {
                showAlertModal(reanalyze_payload.error || 'Re-analysis failed.', 'Error');
            }
        } catch (reanalyze_error) {
            loading_modal_element.remove();
            console.error('Re-analyze error:', reanalyze_error);
            showAlertModal('Error connecting to server for re-analysis.', 'Error');
        }
    });
}

/**
 * WHAT: Prompts the user to enter a new tag or object and submits it via `updateTag`.
 * WHY:  Wires the `+` button on card backs cleanly to `showTagInputModal`.
 *
 * @param {string | number} image_identifier - Target image ID.
 * @param {'tags' | 'objects'} tag_collection_type - Target metadata array.
 */
async function addTag(image_identifier, tag_collection_type) {
    showTagInputModal(`Add new ${tag_collection_type.slice(0, -1)}`, '', (entered_new_tag) => {
        if (entered_new_tag && entered_new_tag.trim()) {
            updateTag(image_identifier, tag_collection_type, null, entered_new_tag.trim(), 'add');
        }
    });
}

/**
 * WHAT: Applies an immutable tag, object, or summary edit via pure `deduplicateAndNormalizeAnalysisRecord`,
 *       persists to `/update-tags`, and updates local caches and DOM.
 * WHY:  Eliminates in-place array mutations on cached image objects while keeping UI responsive.
 */
async function updateTag(image_identifier, target_field_type, old_tag_value, new_tag_value, edit_action) {
    try {
        const target_image_record = findCachedImageRecordById(image_identifier);
        if (!target_image_record) throw new Error('Image not found in any local cache');

        const base_analysis_record = target_image_record.analysis || {};
        let draft_analysis_record;

        if (target_field_type === 'summary') {
            draft_analysis_record = {
                ...base_analysis_record,
                summary: new_tag_value
            };
        } else {
            const current_items_list = Array.isArray(base_analysis_record[target_field_type])
                ? base_analysis_record[target_field_type].slice()
                : [];
            let next_items_list = current_items_list;

            if (edit_action === 'edit') {
                next_items_list = current_items_list.map((existing_item) =>
                    existing_item === old_tag_value ? new_tag_value : existing_item
                );
            } else if (edit_action === 'delete') {
                next_items_list = current_items_list.filter((existing_item) => existing_item !== old_tag_value);
            } else if (edit_action === 'add' && !current_items_list.includes(new_tag_value)) {
                next_items_list = [...current_items_list, new_tag_value];
            }

            draft_analysis_record = {
                ...base_analysis_record,
                [target_field_type]: next_items_list
            };
        }

        const normalized_analysis_record = deduplicateAndNormalizeAnalysisRecord(draft_analysis_record);

        const http_response = await fetch(`${API_BASE_URL}/update-tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: image_identifier, analysis: normalized_analysis_record })
        });

        if (!http_response.ok) throw new Error('Update failed');

        loadStats();

        const card_element = document.querySelector(`.card[data-id="${image_identifier}"]`);
        if (card_element) {
            syncImageAnalysisInCachesAndDom(image_identifier, normalized_analysis_record);
        } else {
            await executeSearchQuery();
        }
    } catch (tag_update_error) {
        console.error('Tag update error:', tag_update_error);
        showAlertModal('Failed to update tags: ' + tag_update_error.message, 'Tag Update Error');
    }
}

// ============================================================================
// STATS & THUMBNAIL REGENERATION
// ============================================================================

/**
 * WHAT: Fetches `/stats` to populate top discovery tags/objects and autocomplete catalogs.
 * WHY:  Keeps sidebar tag clouds and autocomplete suggestions up to date after edits.
 */
async function loadStats() {
    try {
        const http_response = await fetch(`${API_BASE_URL}/stats`);
        if (!http_response.ok) throw new Error('Failed to fetch stats');

        const stats_payload = await http_response.json();
        const top_tags_list_element = document.getElementById('topTagsList');
        const top_objects_list_element = document.getElementById('topObjectsList');

        allKnownTags = stats_payload.tags || [];
        allKnownObjects = stats_payload.objects || [];

        if (top_tags_list_element) {
            if (allKnownTags.length === 0) {
                top_tags_list_element.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No tags found</span>';
            } else {
                top_tags_list_element.innerHTML = allKnownTags.slice(0, 20).map((tag_entry) => {
                    const safe_escaped_attribute = escapeHtmlCharacters(tag_entry.name).replace(/'/g, "\\'");
                    return `
                        <span class="tag" style="cursor: pointer;" onclick="setSearchQuery('${safe_escaped_attribute}')">
                            #${escapeHtmlCharacters(tag_entry.name)} <span style="opacity: 0.6; font-size: 0.8em;">(${tag_entry.count})</span>
                        </span>
                    `;
                }).join('');
            }
        }

        if (top_objects_list_element) {
            if (allKnownObjects.length === 0) {
                top_objects_list_element.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No objects found</span>';
            } else {
                top_objects_list_element.innerHTML = allKnownObjects.slice(0, 20).map((object_entry) => {
                    const safe_escaped_attribute = escapeHtmlCharacters(object_entry.name).replace(/'/g, "\\'");
                    return `
                        <span class="tag" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399; cursor: pointer;" onclick="setObjectQuery('${safe_escaped_attribute}')">
                            ${escapeHtmlCharacters(object_entry.name)} <span style="opacity: 0.6; font-size: 0.8em;">(${object_entry.count})</span>
                        </span>
                    `;
                }).join('');
            }
        }
    } catch (stats_error) {
        console.error('Error loading stats:', stats_error);
        const top_tags_list_element = document.getElementById('topTagsList');
        const top_objects_list_element = document.getElementById('topObjectsList');
        if (top_tags_list_element) top_tags_list_element.innerHTML = '<span style="color: var(--text-secondary);">Error loading tags</span>';
        if (top_objects_list_element) top_objects_list_element.innerHTML = '<span style="color: var(--text-secondary);">Error loading objects</span>';
    }
}

/**
 * WHAT: Requests server-side thumbnail regeneration for an image and cache-busts the card thumbnail image.
 * WHY:  Fixes corrupted or stale AVIF thumbnails directly from the search grid.
 */
async function regenerateThumbnail(image_identifier, card_element) {
    try {
        const thumbnail_image_element = card_element?.querySelector('.thumbnail-preview');
        if (thumbnail_image_element) thumbnail_image_element.style.opacity = '0.5';

        const http_response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: image_identifier })
        });

        if (!http_response.ok) throw new Error('Regeneration failed');

        const regeneration_payload = await http_response.json();
        if (regeneration_payload.thumbPath && thumbnail_image_element) {
            thumbnail_image_element.src = `${regeneration_payload.thumbPath}?t=${Date.now()}`;
        }
    } catch (regeneration_error) {
        console.error('Thumbnail regeneration error:', regeneration_error);
        showAlertModal('Failed to regenerate thumbnail: ' + regeneration_error.message, 'Regeneration Error');
    } finally {
        const thumbnail_image_element = card_element?.querySelector('.thumbnail-preview');
        if (thumbnail_image_element) thumbnail_image_element.style.opacity = '1';
    }
}

window.setSearchQuery = (tag_term) => {
    addTagFilter(tag_term, 'tag');
};

window.setObjectQuery = (object_term) => {
    addTagFilter(object_term, 'object');
};

// ============================================================================
// TAG FILTER: AUTOCOMPLETE & CHIP MANAGEMENT
// ============================================================================

/**
 * WHAT: Adds a tag or object chip to the active filter sets and triggers a search.
 * WHY:  Avoids duplicate chips and clears the autocomplete dropdown cleanly.
 */
function addTagFilter(filter_name, filter_type) {
    const target_filter_set = filter_type === 'tag' ? selectedTagFilters : selectedObjectFilters;
    if (target_filter_set.has(filter_name)) return;
    target_filter_set.add(filter_name);
    renderFilterChips();
    if (tagFilterInput) tagFilterInput.value = '';
    hideAutocomplete();
    executeSearchQuery();
}

/**
 * WHAT: Removes a tag or object chip from the active filter sets and re-runs search.
 * WHY:  Allows instant one-click removal of filter chips.
 */
function removeTagFilter(filter_name, filter_type) {
    const target_filter_set = filter_type === 'tag' ? selectedTagFilters : selectedObjectFilters;
    target_filter_set.delete(filter_name);
    renderFilterChips();
    executeSearchQuery();
}

/**
 * WHAT: Renders active tag and object filter chips inside `#tagFilterChips` with remove buttons.
 * WHY:  Escapes all chip labels to prevent XSS and binds remove listeners cleanly.
 */
function renderFilterChips() {
    if (!tagFilterChips) return;
    let compiled_chips_html = '';
    selectedTagFilters.forEach((tag_name) => {
        const escaped_tag_name = escapeHtmlCharacters(tag_name);
        compiled_chips_html += `<span class="filter-chip chip-tag">#${escaped_tag_name} <span class="chip-remove" data-name="${escaped_tag_name}" data-type="tag">&times;</span></span>`;
    });
    selectedObjectFilters.forEach((object_name) => {
        const escaped_object_name = escapeHtmlCharacters(object_name);
        compiled_chips_html += `<span class="filter-chip chip-object">&boxbox; ${escaped_object_name} <span class="chip-remove" data-name="${escaped_object_name}" data-type="object">&times;</span></span>`;
    });
    tagFilterChips.innerHTML = compiled_chips_html;

    tagFilterChips.querySelectorAll('.chip-remove').forEach((remove_button_element) => {
        remove_button_element.addEventListener('click', () => {
            removeTagFilter(remove_button_element.dataset.name, remove_button_element.dataset.type);
        });
    });
}

/**
 * WHAT: Renders the tag/object autocomplete dropdown using pure `rankTagAutocompleteMatches`.
 * WHY:  Separates matching/filtering logic from DOM construction and wires click listeners cleanly.
 */
function showAutocomplete(raw_query_string) {
    if (!tagAutocomplete) return;

    const ranked_matches = rankTagAutocompleteMatches(
        allKnownTags,
        allKnownObjects,
        selectedTagFilters,
        selectedObjectFilters,
        raw_query_string,
        15
    );

    if (ranked_matches.length === 0) {
        hideAutocomplete();
        return;
    }

    tagAutocomplete.innerHTML = ranked_matches.map((match_item, match_index) => `
        <div class="tag-autocomplete-item${match_index === autocomplete_active_index ? ' active' : ''}" data-name="${escapeHtmlCharacters(match_item.name)}" data-type="${match_item.type}">
            <span>
                <span class="ac-type ${match_item.type === 'tag' ? 'ac-tag' : 'ac-obj'}">${match_item.type === 'tag' ? 'tag' : 'obj'}</span>
                ${escapeHtmlCharacters(match_item.name)}
            </span>
            <span class="ac-count">(${match_item.count})</span>
        </div>
    `).join('');

    tagAutocomplete.style.display = 'block';

    tagAutocomplete.querySelectorAll('.tag-autocomplete-item').forEach((autocomplete_option_element) => {
        autocomplete_option_element.addEventListener('click', () => {
            addTagFilter(autocomplete_option_element.dataset.name, autocomplete_option_element.dataset.type);
        });
    });
}

/**
 * WHAT: Hides the autocomplete dropdown and resets keyboard selection index.
 * WHY:  Keeps dropdown state clean after selection, Escape, or outside clicks.
 */
function hideAutocomplete() {
    if (tagAutocomplete) {
        tagAutocomplete.style.display = 'none';
        tagAutocomplete.innerHTML = '';
    }
    autocomplete_active_index = -1;
}

if (tagFilterInput) {
    tagFilterInput.addEventListener('input', () => {
        const filter_query_trimmed_value = tagFilterInput.value.trim();
        autocomplete_active_index = -1;
        if (filter_query_trimmed_value.length > 0) {
            showAutocomplete(filter_query_trimmed_value);
        } else {
            hideAutocomplete();
        }
    });

    tagFilterInput.addEventListener('keydown', (keyboard_event_object) => {
        const autocomplete_item_elements = tagAutocomplete
            ? tagAutocomplete.querySelectorAll('.tag-autocomplete-item')
            : [];

        if (keyboard_event_object.key === 'ArrowDown') {
            keyboard_event_object.preventDefault();
            autocomplete_active_index = Math.min(autocomplete_active_index + 1, autocomplete_item_elements.length - 1);
            autocomplete_item_elements.forEach((option_element, option_index) =>
                option_element.classList.toggle('active', option_index === autocomplete_active_index)
            );
        } else if (keyboard_event_object.key === 'ArrowUp') {
            keyboard_event_object.preventDefault();
            autocomplete_active_index = Math.max(autocomplete_active_index - 1, 0);
            autocomplete_item_elements.forEach((option_element, option_index) =>
                option_element.classList.toggle('active', option_index === autocomplete_active_index)
            );
        } else if (keyboard_event_object.key === 'Enter') {
            keyboard_event_object.preventDefault();
            if (autocomplete_active_index >= 0 && autocomplete_item_elements[autocomplete_active_index]) {
                const selected_option_element = autocomplete_item_elements[autocomplete_active_index];
                addTagFilter(selected_option_element.dataset.name, selected_option_element.dataset.type);
            }
        } else if (keyboard_event_object.key === 'Escape') {
            hideAutocomplete();
        }
    });

    document.addEventListener('click', (click_event) => {
        if (!tagFilterInput.contains(click_event.target) && (!tagAutocomplete || !tagAutocomplete.contains(click_event.target))) {
            hideAutocomplete();
        }
    });
}

document.querySelectorAll('input[name="tagLogic"]').forEach((logic_radio_element) => {
    logic_radio_element.addEventListener('change', () => {
        if (selectedTagFilters.size > 0 || selectedObjectFilters.size > 0) {
            executeSearchQuery();
        }
    });
});

// ============================================================================
// FIND SIMILAR
// ============================================================================

/**
 * WHAT: Populates tag/object OR filters and a truncated summary query from a reference image.
 * WHY:  Delegates JSON parsing and field extraction to pure `extractSimilarImageSearchState`.
 */
async function findSimilar(image_identifier) {
    const cached_results_list = lastWorkerResults || [];
    let source_image_record = cached_results_list.find((single_image_record) => single_image_record.id == image_identifier);

    if (!source_image_record) {
        try {
            const http_response = await fetch(`${API_BASE_URL}/images?id=${image_identifier}`);
            if (http_response.ok) {
                const image_payload = await http_response.json();
                source_image_record = image_payload.image;
            }
        } catch (fetch_similar_error) {
            console.error('Failed to fetch similar source image:', fetch_similar_error);
        }
    }

    if (!source_image_record) {
        if (cached_results_list.length === 0) {
            await executeSearchQuery();
            setTimeout(() => findSimilar(image_identifier), 1000);
            return;
        }
        showAlertModal('Image data not found. Try searching first.', 'Find Similar');
        return;
    }

    const {
        tags_to_select,
        objects_to_select,
        truncated_summary_query,
        parsed_analysis_record
    } = extractSimilarImageSearchState(source_image_record);

    source_image_record.analysis = parsed_analysis_record;

    selectedTagFilters.clear();
    selectedObjectFilters.clear();

    tags_to_select.forEach((tag_label) => selectedTagFilters.add(tag_label));
    objects_to_select.forEach((object_label) => selectedObjectFilters.add(object_label));

    const or_logic_radio = document.querySelector('input[name="tagLogic"][value="OR"]');
    if (or_logic_radio) or_logic_radio.checked = true;

    if (searchQuery) searchQuery.value = truncated_summary_query;
    renderFilterChips();

    if (similarBanner && similarBannerName) {
        similarBanner.style.display = 'flex';
        similarBannerName.textContent = source_image_record.filename || `ID ${image_identifier}`;
    }

    executeSearchQuery();
}

/**
 * WHAT: Clears active "Find Similar" filters and restores default AND tag logic.
 * WHY:  Lets users exit similarity exploration in one click.
 */
function clearSimilarMode() {
    selectedTagFilters.clear();
    selectedObjectFilters.clear();
    if (searchQuery) searchQuery.value = '';
    renderFilterChips();

    const and_logic_radio = document.querySelector('input[name="tagLogic"][value="AND"]');
    if (and_logic_radio) and_logic_radio.checked = true;

    if (similarBanner) similarBanner.style.display = 'none';

    executeSearchQuery();
}

if (clearSimilarBtn) {
    clearSimilarBtn.addEventListener('click', clearSimilarMode);
}

// ============================================================================
// MODEL STATUS INDICATOR & FILE LINK HANDLER
// ============================================================================
// ============================================================================
// BATCH CONTROLS & SELECTION LOGIC
// ============================================================================

/**
 * WHAT: Synchronizes button labels, disabled states, and visibility with `selectedIds.size`.
 * WHY:  Gives immediate feedback when selecting or clearing cards for batch operations.
 */
function updateProcessButton() {
    const selected_count = selectedIds.size;
    if (processSelectedBtn) {
        processSelectedBtn.textContent = `Process (${selected_count})`;
        processSelectedBtn.disabled = selected_count === 0;
        processSelectedBtn.style.opacity = selected_count === 0 ? '0.5' : '1';
    }

    const bulk_rename_button = document.getElementById('bulkRenameBtn');
    if (bulk_rename_button) {
        bulk_rename_button.disabled = selected_count === 0;
        bulk_rename_button.style.opacity = selected_count === 0 ? '0.5' : '1';
    }

    if (unselectAllBtn) {
        unselectAllBtn.style.display = selected_count > 0 ? 'block' : 'none';
    }
}

const bulkRenameBtn = document.getElementById('bulkRenameBtn');
if (bulkRenameBtn) {
    bulkRenameBtn.addEventListener('click', async () => {
        if (selectedIds.size === 0) return;

        const base_name_input = await showBulkRenameModal(selectedIds, allImages, getRecentRenames());
        if (!base_name_input || !base_name_input.trim()) return;

        bulkRenameBtn.disabled = true;
        const original_button_label = bulkRenameBtn.textContent;
        bulkRenameBtn.textContent = 'Renaming...';

        try {
            const http_response = await fetch(`${API_BASE_URL}/bulk-rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: Array.from(selectedIds),
                    baseName: base_name_input.trim()
                })
            });

            const bulk_rename_payload = await http_response.json();

            if (http_response.ok && bulk_rename_payload.success) {
                saveRecentRename(base_name_input.trim());
                showAlertModal(bulk_rename_payload.message || 'Successfully renamed files', 'Rename Complete');
                selectedIds.clear();
                updateProcessButton();
                await refreshData();
            } else {
                showAlertModal(bulk_rename_payload.error || 'Failed to bulk rename', 'Rename Error');
            }
        } catch (bulk_rename_error) {
            console.error('Bulk rename failed:', bulk_rename_error);
            showAlertModal('Error communicating with server.', 'Error');
        } finally {
            bulkRenameBtn.disabled = false;
            bulkRenameBtn.textContent = original_button_label;
        }
    });
}

if (selectMissingBtn) {
    selectMissingBtn.addEventListener('click', () => {
        let newly_selected_count = 0;
        filteredImages.forEach((single_image_record) => {
            const analysis_record = single_image_record.analysis || {};
            if (
                !analysis_record.summary ||
                !analysis_record.tags ||
                analysis_record.tags.length === 0 ||
                !analysis_record.objects ||
                analysis_record.objects.length === 0
            ) {
                selectedIds.add(String(single_image_record.id));
                newly_selected_count++;

                const checkbox_element = document.querySelector(`.card-select-cb[data-id="${single_image_record.id}"]`);
                if (checkbox_element) checkbox_element.checked = true;
                const card_element = document.querySelector(`.card[data-id="${single_image_record.id}"]`);
                if (card_element) card_element.classList.add('selected');
            }
        });

        if (newly_selected_count > 0) {
            updateProcessButton();
            showAlertModal(`Successfully selected ${newly_selected_count} images with missing data.`, 'Selection Complete');
        } else {
            showAlertModal('No visible images found with missing data.', 'Auto Selection');
        }
    });
}

if (unselectAllBtn) {
    unselectAllBtn.addEventListener('click', () => {
        selectedIds.clear();
        document.querySelectorAll('.card-select-cb').forEach((checkbox_element) => {
            checkbox_element.checked = false;
        });
        document.querySelectorAll('.card.selected').forEach((card_element) => {
            card_element.classList.remove('selected');
        });
        updateProcessButton();
    });
}

if (processSelectedBtn) {
    processSelectedBtn.addEventListener('click', () => {
        if (selectedIds.size === 0) return;

        showConfirmModal(
            `Re-analyze ${selectedIds.size} images with mode: "${dbPromptType.value}"?`,
            async () => {
                processSelectedBtn.disabled = true;
                processSelectedBtn.textContent = 'Processing...';

                const target_image_identifiers = Array.from(selectedIds);
                const selected_prompt_type = dbPromptType.value;
                const total_images_count = target_image_identifiers.length;
                let success_count = 0;

                if (validationStatus) {
                    validationStatus.style.display = 'block';
                    validationText.textContent = 'Starting batch...';
                    validationProgressBar.style.width = '0%';
                }

                for (let item_index = 0; item_index < total_images_count; item_index++) {
                    if (validationText) {
                        validationText.textContent = `Processing image ${item_index + 1} of ${total_images_count}...`;
                    }

                    try {
                        const http_response = await fetch(`${API_BASE_URL}/batch-analyze`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                ids: [target_image_identifiers[item_index]],
                                promptType: selected_prompt_type
                            })
                        });

                        if (http_response.ok) success_count++;
                    } catch (batch_item_error) {
                        console.error(batch_item_error);
                    }

                    if (validationProgressBar) {
                        validationProgressBar.style.width = `${Math.round(((item_index + 1) / total_images_count) * 100)}%`;
                    }
                }

                if (validationText) validationText.textContent = `Batch Complete! Success: ${success_count}`;

                selectedIds.clear();
                await refreshData();
                updateProcessButton();

                setTimeout(() => {
                    if (validationStatus) validationStatus.style.display = 'none';
                }, 2000);
            },
            'Start Batch',
            '#10b981'
        );
    });
}

if (validateBtn) {
    validateBtn.addEventListener('click', async () => {
        const selected_integrity_options = await showIntegrityCheckModal();
        if (!selected_integrity_options) return;

        validateBtn.disabled = true;
        const original_button_html = validateBtn.innerHTML;
        validateBtn.innerHTML = '🔄 Checking...';

        let validate_polling_interval;

        if (validationStatus) {
            validationStatus.style.display = 'block';
            validationText.textContent = 'Starting integrity check...';
            validationProgressBar.style.width = '2%';

            validate_polling_interval = setInterval(async () => {
                try {
                    const status_http_response = await fetch(`${API_BASE_URL}/validate-status`);
                    if (status_http_response.ok) {
                        const status_payload = await status_http_response.json();
                        validationText.textContent = status_payload.status;
                        validationProgressBar.style.width = `${Math.max(2, status_payload.progress)}%`;
                    }
                } catch (_polling_error) {}
            }, 250);
        }

        try {
            const http_response = await fetch(`${API_BASE_URL}/validate-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ options: selected_integrity_options, reanalyze: false })
            });
            const validation_payload = await http_response.json();

            if (validate_polling_interval) clearInterval(validate_polling_interval);
            if (!http_response.ok || !validation_payload || !validation_payload.results) {
                throw new Error(validation_payload?.error || `Validation failed (HTTP ${http_response.status})`);
            }

            const validation_results = validation_payload.results;
            if (validationProgressBar) validationProgressBar.style.width = '100%';

            let report_html_message = `<strong>Check Complete</strong><br>`;
            if (validation_results.purged > 0) report_html_message += `🔥 Purged ${validation_results.purged} legacy thumbnails<br>`;
            if (validation_results.duplicatesRemoved > 0) report_html_message += `🧹 Removed ${validation_results.duplicatesRemoved} duplicates<br>`;
            if (validation_results.metadataRepaired > 0) report_html_message += `🔧 Repaired ${validation_results.metadataRepaired} metadata<br>`;
            if (validation_results.missing > 0) report_html_message += `🗑️ Removed ${validation_results.missing} missing files<br>`;
            if (validation_results.fixedThumbnails > 0) report_html_message += `🖼️ Fixed ${validation_results.fixedThumbnails} thumbnails<br>`;
            if (validation_results.orphanedEmbeddingsPruned > 0) report_html_message += `🧬 Pruned ${validation_results.orphanedEmbeddingsPruned} orphaned embedding vectors<br>`;
            if (validation_results.errors.length > 0) report_html_message += `⚠️ ${validation_results.errors.length} errors occurred`;

            if (
                validation_results.purged === 0 &&
                validation_results.duplicatesRemoved === 0 &&
                validation_results.metadataRepaired === 0 &&
                validation_results.missing === 0 &&
                validation_results.fixedThumbnails === 0 &&
                (validation_results.orphanedEmbeddingsPruned || 0) === 0 &&
                validation_results.errors.length === 0
            ) {
                report_html_message += '✅ Database & Embeddings are healthy!';
            }

            if (validationText) validationText.innerHTML = report_html_message;

            await refreshData();
            await fetchEmbeddingsStatus();

            const hide_delay_milliseconds =
                validation_results.duplicatesRemoved > 0 ||
                validation_results.metadataRepaired > 0 ||
                validation_results.missing > 0
                    ? 5000
                    : 3000;

            setTimeout(() => {
                if (validationStatus) validationStatus.style.display = 'none';
            }, hide_delay_milliseconds);
        } catch (validation_error) {
            showAlertModal('Check failed: ' + validation_error.message, 'Integrity Check Error');
            if (validationStatus) validationStatus.style.display = 'none';
        } finally {
            if (validate_polling_interval) clearInterval(validate_polling_interval);
            validateBtn.disabled = false;
            validateBtn.innerHTML = original_button_html;
        }
    });
}

if (closeStatus) {
    closeStatus.addEventListener('click', () => {
        if (validationStatus) validationStatus.style.display = 'none';
    });
}

// ============================================================================
// STORAGE & DISCOVERY DRAWER HELPERS
// ============================================================================

/**
 * WHAT: Reads the list of recent bulk-rename base names from `localStorage`.
 * WHY:  Provides quick-pick history chips inside the bulk rename modal.
 *
 * @returns {readonly string[]} Array of recent base names.
 */
function getRecentRenames() {
    try {
        const stored_json = localStorage.getItem('recentRenames');
        return stored_json ? JSON.parse(stored_json) : [];
    } catch (_storage_error) {
        return [];
    }
}

/**
 * WHAT: Updates and persists the recent bulk-rename base name list using pure `computeUpdatedRecentRenamesList`.
 * WHY:  Delegates deduplication and truncation to a pure state transition before writing `localStorage`.
 */
function saveRecentRename(base_name_string) {
    if (!base_name_string || !base_name_string.trim()) return;
    const updated_recent_renames = computeUpdatedRecentRenamesList(getRecentRenames(), base_name_string, 10);
    localStorage.setItem('recentRenames', JSON.stringify(updated_recent_renames));
}

/**
 * WHAT: Initializes the collapsible Discovery Tags drawer state from `localStorage`.
 * WHY:  Remembers the user's preferred collapsed/expanded state across sessions.
 */
function initDiscoveryToggle() {
    const discovery_toggle_button = document.getElementById('discoveryToggle');
    const discovery_content_container = document.getElementById('discoveryContent');

    if (!discovery_toggle_button || !discovery_content_container) return;

    const is_initially_hidden = localStorage.getItem('discoveryTagsHidden') === 'true';
    if (is_initially_hidden) {
        discovery_toggle_button.classList.add('collapsed');
        discovery_content_container.classList.add('collapsed');
        discovery_content_container.classList.remove('show');
    }

    discovery_toggle_button.addEventListener('click', () => {
        const should_hide = !discovery_content_container.classList.contains('collapsed');

        if (should_hide) {
            discovery_toggle_button.classList.add('collapsed');
            discovery_content_container.classList.add('collapsed');
            discovery_content_container.classList.remove('show');
            localStorage.setItem('discoveryTagsHidden', 'true');
        } else {
            discovery_toggle_button.classList.remove('collapsed');
            discovery_content_container.classList.remove('collapsed');
            discovery_content_container.classList.add('show');
            localStorage.setItem('discoveryTagsHidden', 'false');
        }
    });
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

// WHAT: Listens for clicks on `.file-link` elements across the document and reveals the file in the OS file explorer.
// WHY: Cards can be dynamically paginated or injected, so delegated document listening handles all current and future file links.
document.addEventListener("click", (click_event) => {
    const file_link_anchor_element = click_event.target.closest(".file-link");
    if (!file_link_anchor_element) return;

    const full_filesystem_path = file_link_anchor_element.dataset.path;

    if (window.electronAPI && window.electronAPI.showInFolder) {
        window.electronAPI.showInFolder(full_filesystem_path);
    } else {
        console.warn('Electron API not available. File path:', full_filesystem_path);
        showAlertModal('This feature requires Electron. File path: ' + full_filesystem_path, 'System Limitation');
    }
});

initializeSearchSystem();
updateModelIndicator();
setInterval(updateModelIndicator, 10000);

requestAnimationFrame(() => {
    initDiscoveryToggle();
    loadStats();
});
