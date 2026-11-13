import {
    computeCardPixelWidthFromGridWidth,
    computeTriangularPrismRadiusPixels,
    computeNextPrismSpinDegrees,
    getCardGrad,
    escapeCardHtmlText,
    extractDicedPromptMasterRecord,
    renderDicedPromptBackDetailsHtml,
    buildCardThumbnailBlockHtml,
    buildCardBackIdentityHeaderHtml,
    createCardHtml
} from "./modules/databaseCardRenderers.js?v=3";

// ============================================================================
// IMAGE ANALYSIS STUDIO - DATABASE VIEWER
// ============================================================================
// This file handles loading and displaying saved image analyses from the
// database, including thumbnails, metadata, and AI analysis results.

import { escapeHtmlCharacters } from './modules/cardCore.js';
import { computeUpdatedRecentRenamesList } from './modules/searchFilters.js';
import {
    showImagePreview,
    showIntegrityCheckModal,
    showBulkRenameModal,
    showTagInputModal,
    showConfirmModal
} from './modules/uiModals.js';

// ============================================================================
// DOM ELEMENT REFERENCES
// ============================================================================
const dbGrid = document.getElementById('dbGrid');
const loadingDb = document.getElementById('loadingDb');

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;

    // Choose icon
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `
        <span style="font-size: 1.2rem;">${icon}</span>
        <span>${escapeHtmlCharacters(message)}</span>
    `;

    document.body.appendChild(toast);

    // Auto remove
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s forwards';
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}

// ============================================================================
// MAIN FUNCTION - LOAD DATABASE
// ============================================================================
// ============================================================================
// MAIN FUNCTION - LOAD DATABASE (INFINITE SCROLL)
// ============================================================================
const API_BASE_URL = 'http://localhost:3000';

// State for infinite scroll
const currently_rendered_database_image_identifier_set = new Set();
let imagesData = [];
let currentPage = 1;
const PAGE_SIZE = 50;
let totalImages = 0;
let isLoading = false;
let hasMore = true;
let isSelectionMode = false;
let selectedIds = new Set();
let observer = null;

/**
 * WHAT: Initializes the database viewer.
 * WHY: Resets pagination state and cache, prepares Pretext font measurement,
 *      and kicks off the initial batch load.
 */
async function initDatabase() {
    try {
        // Reset state
        currently_rendered_database_image_identifier_set.clear();
        imagesData = [];
        currentPage = 1;
        isLoading = false;
        hasMore = true;
        dbGrid.innerHTML = '';

        loadingDb.style.display = 'block';
        loadingDb.textContent = 'Loading database...';

        // Initialize pretext measuring engine (waits for font load)
        if (window.PretextLayout) {
            await window.PretextLayout.init();
        }

        await loadNextPage();

    } catch (error) {
        console.error('Error:', error);
        loadingDb.style.display = 'block';
        loadingDb.textContent = 'Error loading database. Please check console.';
    }
}

/**
 * WHAT: Loads the next batch page of images from the server.
 * WHY: Supports incremental row-by-row pagination with deduplication to prevent duplicate cards or layout jumps.
 */
async function loadNextPage() {
    if (isLoading || !hasMore) return;

    isLoading = true;
    console.log(`[DB] Fetching page ${currentPage}...`);

    try {
        const sortSelect = document.getElementById('sortSelect');
        const sort = sortSelect ? sortSelect.value : 'recent_update';

        const response = await fetch(`${API_BASE_URL}/images?page=${currentPage}&limit=${PAGE_SIZE}&sort=${sort}`);
        if (!response.ok) throw new Error('Failed to load images');

        const data = await response.json();
        const incoming_image_records = data.images.map(image_record => {
            if (typeof image_record.analysis === 'string') {
                try { image_record.analysis = JSON.parse(image_record.analysis || '{}'); } catch (e) { image_record.analysis = {}; }
            }
            return image_record;
        });

        // WHAT: Deduplicating incoming images against the rendered set.
        // WHY: Prevents duplicate cards from appearing in the grid when rapid scrolling occurs.
        const deduplicated_new_images = incoming_image_records.filter((candidate_image_record) => {
            const image_unique_identifier_string = String(candidate_image_record.id);
            if (currently_rendered_database_image_identifier_set.has(image_unique_identifier_string)) {
                return false;
            }
            currently_rendered_database_image_identifier_set.add(image_unique_identifier_string);
            return true;
        });

        imagesData.push(...deduplicated_new_images); // Keep local cache in sync for tag updates

        totalImages = data.total;
        hasMore = currentPage < data.totalPages;

        // Update the entry count in the header
        const dbCount = document.getElementById('dbCount');
        if (dbCount) dbCount.textContent = totalImages;

        if (totalImages === 0) {
            dbGrid.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No images saved yet.</p>';
            loadingDb.style.display = 'none';
            return;
        }

        if (deduplicated_new_images.length > 0) {
            renderBatch(deduplicated_new_images);
        }

        currentPage++;
        loadingDb.style.display = 'none';

        // Setup Sentinel if it's the first page
        if (currentPage === 2) {
            setupSentinel();
        }

    } catch (page_load_error) {
        console.error('[DB] Page Load Error:', page_load_error);
        if (loadingDb) {
            loadingDb.style.display = 'block';
            loadingDb.textContent = `Error loading database: ${page_load_error.message}`;
        }
    } finally {
        isLoading = false;
    }
}

/**
 * WHAT: Sets up the scroll sentinel element for infinite scrolling.
 * WHY: Detects when the user scrolls near the bottom and automatically requests the next batch of images.
 */
function setupSentinel() {
    let scroll_sentinel_element = document.getElementById('scroll-sentinel');
    if (!scroll_sentinel_element) {
        scroll_sentinel_element = document.createElement('div');
        scroll_sentinel_element.id = 'scroll-sentinel';
        scroll_sentinel_element.className = 'scroll-sentinel';
        dbGrid.parentNode.appendChild(scroll_sentinel_element);
    }
    setupIntersectionObserver(scroll_sentinel_element);
}

/**
 * WHAT: Renders a batch of image cards directly into the row-by-row CSS grid.
 * WHY: Pre-measures text heights using PretextLayout to prevent Cumulative Layout Shift (CLS),
 *      then appends new card elements at the bottom of the grid without disturbing preceding rows.
 */
/**
 * WHAT: Computes the responsive card column width in pixels for a grid container width.
 * WHY: Matches the CSS rule `repeat(auto-fill, minmax(min(100%, 420px), 1fr))` with a `16px` gap so both Pretext measurement and 3D prism radius stay exact without querying every card.
 */
function syncGridPrismGeometry() {
    if (!dbGrid) return;
    const sample_card_element = dbGrid.querySelector('.card');
    const measured_card_width = (sample_card_element && sample_card_element.clientWidth > 0)
        ? sample_card_element.clientWidth
        : computeCardPixelWidthFromGridWidth(dbGrid.offsetWidth);
    const prism_radius_pixels = computeTriangularPrismRadiusPixels(measured_card_width);
    dbGrid.style.setProperty('--prism-r', `${prism_radius_pixels}px`);
}

if (typeof ResizeObserver !== 'undefined' && dbGrid) {
    const database_grid_prism_resize_observer = new ResizeObserver(() => {
        syncGridPrismGeometry();
    });
    database_grid_prism_resize_observer.observe(dbGrid);
}

function renderBatch(deduplicated_batch_images) {
    // PRE-MEASUREMENT STEP:
    // We use PretextLayout to calculate exactly how many pixels of height the 
    // AI summary text will need BEFORE we actually put it in the DOM. 
    let summaryHeightsMap = new Map();
    if (window.PretextLayout && window.PretextLayout.ready) {
        const grid_container_pixel_width = dbGrid.offsetWidth > 0 ? dbGrid.offsetWidth : 1000;
        const calculated_card_pixel_width = computeCardPixelWidthFromGridWidth(grid_container_pixel_width);
        const text_usable_pixel_width = Math.max(100, calculated_card_pixel_width - 24); // Account for card padding (0.75rem * 2)

        const text_measurement_payload_array = deduplicated_batch_images.map(image_record => {
            // WHAT: Safely parses the stored analysis JSON string without crashing the batch render.
            // WHY: A single corrupted JSON string in SQLite must not abort rendering all other image cards.
            let parsed_analysis_record = {};
            if (typeof image_record.analysis === 'string') {
                try {
                    parsed_analysis_record = JSON.parse(image_record.analysis || '{}') || {};
                } catch (_json_parse_error) {
                    parsed_analysis_record = {};
                }
            } else if (image_record.analysis && typeof image_record.analysis === 'object') {
                parsed_analysis_record = image_record.analysis;
            }
            return { id: image_record.id, text: parsed_analysis_record.summary || '' };
        });

        summaryHeightsMap = window.PretextLayout.measureBatch(text_measurement_payload_array, text_usable_pixel_width, 'database');
    }

    // HTML GENERATION STEP:
    // We map over our image data and convert each record into a string of HTML.
    const batchHtml = deduplicated_batch_images.map((image_record, batch_position_index) => {
        const measured_summary_height = summaryHeightsMap.get(String(image_record.id));
        
        // INTELLIGENT LOADING:
        // First visible images use eager loading and high priority
        const isPriorityImage = (currentPage === 1 && batch_position_index === 0);
        const isEagerLoad = (currentPage === 1 && batch_position_index < 4);
        
        return createCardHtml(image_record, measured_summary_height, isPriorityImage, isEagerLoad);
    }).join('');

    // Final DOM injection directly into the row grid
    dbGrid.insertAdjacentHTML('beforeend', batchHtml);
    syncGridPrismGeometry();
}

/**
 * WHAT: Attaches an IntersectionObserver to the scroll sentinel.
 * WHY: Uses double requestAnimationFrame delay to ensure the browser has finished painting
 *      the newly inserted rows before observing, eliminating false-positive trigger loops.
 */
function setupIntersectionObserver(scroll_sentinel_element) {
    if (observer) {
        observer.disconnect();
        observer = null;
    }

    observer = new IntersectionObserver((intersection_observer_entries) => {
        if (intersection_observer_entries[0].isIntersecting && !isLoading && hasMore) {
            loadNextPage();
        }
    }, { rootMargin: '400px' }); // Load early

    // WHAT: Deferring sentinel observation across two animation frames.
    // WHY: In the CSS Grid row layout, cards render and calculate their dimensions across layout passes.
    // Waiting two animation frames ensures the container height has expanded and pushed the sentinel below the viewport,
    // preventing the observer from immediately triggering a false-positive second batch on page load.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (scroll_sentinel_element && observer && hasMore) {
                observer.observe(scroll_sentinel_element);
            }
        });
    });
}

/**
 * Generates the HTML for a single image card.
 * @param {Object} img - The image object containing metadata and analysis.
 * @returns {string} The HTML string for the card.
 */
// Helper: Measure pretext height for a single card update
function measureSingleCardHeight(img, context = 'database') {
    if (!window.PretextLayout || !window.PretextLayout.ready) return undefined;
    let analysis = img.analysis;
    if (typeof analysis === 'string') {
        try { analysis = JSON.parse(analysis || '{}'); } catch (e) { analysis = {}; }
    }
    analysis = analysis || {};
    const summaryText = analysis.summary || '';
    if (!summaryText) return undefined;

    let textWidth = 296; // Safe fallback
    const existingCard = document.querySelector(`.card[data-id="${img.id}"]`);
    if (existingCard && existingCard.clientWidth > 0) {
        textWidth = existingCard.clientWidth - 24;
    } else {
        const gridWidth = dbGrid.offsetWidth > 0 ? dbGrid.offsetWidth : 1000;
        const colCount = Math.max(1, Math.floor((gridWidth + 16) / (320 + 16)));
        const actualCardWidth = (gridWidth - (colCount - 1) * 16) / colCount;
        textWidth = actualCardWidth - 24;
    }
    const result = window.PretextLayout.measureText(summaryText, textWidth, context);
    return result.height;
}

async function diceSingleImageAndRefreshCard(target_image_identifier) {
    const numeric_image_identifier = Number(target_image_identifier);
    if (!numeric_image_identifier) return;

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

        const local_image_record = imagesData.find(
            single_image_record => Number(single_image_record.id) === numeric_image_identifier
        );
        if (local_image_record) {
            local_image_record.diced_prompt = master_record;
            if (dice_payload.updated_analysis) {
                local_image_record.analysis = dice_payload.updated_analysis;
            } else {
                const parsed_analysis = (() => {
                    if (typeof local_image_record.analysis !== 'string') {
                        return local_image_record.analysis;
                    }
                    try {
                        return JSON.parse(local_image_record.analysis || '{}');
                    } catch (analysis_parse_error) {
                        return {};
                    }
                })();
                local_image_record.analysis = { ...(parsed_analysis || {}), diced_prompt: master_record };
            }

            const existing_card_element = document.querySelector(`.card[data-id="${numeric_image_identifier}"]`);
            if (existing_card_element) {
                const previous_side = existing_card_element.getAttribute('data-side') || '1';
                const previous_spin_degrees = existing_card_element.getAttribute('data-spin-deg');
                const updated_card_html = createCardHtml(
                    local_image_record,
                    measureSingleCardHeight(local_image_record)
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

        const total_ingredients = master_record.ingredients.length;
        const concreteness_pct = Math.round((Number(master_record.metrics?.physicality_ratio) || 0) * 100);
        showToast(
            `✓ Saved ${master_record.prompt_id} to images.db (${total_ingredients} ingredients, ${concreteness_pct}% concrete)`,
            'success'
        );
    } catch (dice_error) {
        console.error('[DATABASE-DICER] Error dicing image:', dice_error);
        showToast(`Dicing failed: ${dice_error.message}`, 'error');
    }
}

/**
 * WHAT: Updates a card element's active face (`1`, `2`, or `3`) and triggers its 3D Y-axis prism spin.
 * WHY: Advances `--spin-deg` smoothly in 120-degree steps and optionally suppresses animation when re-rendering a card in place.
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

    card_element.querySelectorAll('.card-side-pill[data-target-side]').forEach(pill_button => {
        const pill_target_side = pill_button.getAttribute('data-target-side');
        if (pill_target_side === normalized_side && normalized_side !== '1') {
            pill_button.classList.add('active');
        } else {
            pill_button.classList.remove('active');
        }
    });

    if (transition_options.instant && card_inner_element && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                card_inner_element.style.transition = '';
            });
        });
    }
}

// Handle Regenerate Thumbnail, Copy, Side Switch, and Three-Sided Card Cycle (Delegated)
dbGrid.addEventListener('click', async (e) => {
    const side_pill_button = e.target.closest('.card-side-pill[data-target-side]');
    if (side_pill_button) {
        e.stopPropagation();
        const parent_card = side_pill_button.closest('.card');
        applyCardSideState(parent_card, side_pill_button.getAttribute('data-target-side'));
        return;
    }

    const dice_button_element = e.target.closest('.dice-card-btn');
    if (dice_button_element) {
        e.stopPropagation();
        const target_image_identifier = dice_button_element.dataset.id;
        dice_button_element.disabled = true;
        await diceSingleImageAndRefreshCard(target_image_identifier);
        dice_button_element.disabled = false;
        return;
    }

    const open_dicer_link = e.target.closest('.open-dicer-link');
    if (open_dicer_link) {
        e.stopPropagation();
        return;
    }

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

    if (e.target.classList.contains('regen-thumb-btn')) {
        const btn = e.target;
        const id = btn.dataset.id;

        btn.disabled = true;
        btn.textContent = '...';

        try {
            const response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });

            if (response.ok) {
                const data = await response.json();
                // Update thumbnail across all three 3D card sides so cache busting applies everywhere
                const card = btn.closest('.card');
                const refreshed_thumbnail_url = `${data.thumbPath}?t=${Date.now()}`;
                card.querySelectorAll('.thumbnail-preview').forEach(thumbnail_image_element => {
                    thumbnail_image_element.src = refreshed_thumbnail_url;
                    thumbnail_image_element.style.display = 'block';
                });
                card.querySelectorAll('.thumb-fallback').forEach(fallback_element => {
                    fallback_element.style.display = 'none';
                });

            } else {
                showToast('Failed to regenerate thumbnail', 'error');
            }
        } catch (err) {
            console.error('Regen error:', err);
            showToast('Error regenerating thumbnail', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '🔄 Regen';
        }
        return;
    }
    
    // Tag Click (Redirect to Search)
    const tagEl = e.target.closest('.tag.editable');
    if (tagEl) {
        e.stopPropagation();
        const tagText = tagEl.dataset.tag;
        const dataType = tagEl.dataset.type; // 'tags' or 'objects'
        if (tagText) {
            const searchType = dataType === 'objects' ? 'object' : 'tag';
            window.location.href = `search.html?tag=${encodeURIComponent(tagText)}&type=${searchType}`;
        }
        return;
    }

    // Three-Sided Card Flip Cycle: Side 1 (Summary) -> Side 2 (Tags) -> Side 3 (Diced Prompt) -> Side 1
    const card = e.target.closest('.card');
    if (card) {
        // Only cycle sides if we didn't click an interactive element
        const isInteractive = e.target.closest('button, a, input, label, .file-link, .tag, .thumbnail-preview');
        if (!isInteractive) {
            const current_side = card.getAttribute('data-side') || (card.classList.contains('flipped') ? '2' : '1');
            const next_side = current_side === '1' ? '2' : (current_side === '2' ? '3' : '1');
            applyCardSideState(card, next_side);
        }
    }
});

// ============================================================================
// [Deleted old deleteFromDatabase - see new implementation below]

// ============================================================================
// FILE LINK HANDLER
// ============================================================================
// Allow clicking filenames to show file in folder (Electron integration)
document.addEventListener("click", (click_event) => {
    const file_link_anchor_element = click_event.target.closest(".file-link");
    if (!file_link_anchor_element) return;

    const fullPath = file_link_anchor_element.dataset.path;

    // Check if Electron API is available
    if (window.electronAPI && window.electronAPI.showInFolder) {
        window.electronAPI.showInFolder(fullPath);
    } else {
        console.warn('Electron API not available. File path:', fullPath);
        showToast('This feature requires Electron.', 'error');
    }
});

// ============================================================================
// IMAGE PREVIEW HANDLER
// ============================================================================
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('thumbnail-preview')) {
        const fullPath = e.target.dataset.fullpath;
        if (fullPath) {
            showImagePreview(fullPath);
        }
    }
});

// ============================================================================
// DATABASE VALIDATION HANDLER
// ============================================================================
const validateBtn = document.getElementById('validateBtn');
const validationStatus = document.getElementById('validationStatus');
const validationText = document.getElementById('validationText');
const validationProgressBar = document.getElementById('validationProgressBar');
const closeStatus = document.getElementById('closeStatus');

if (validateBtn) {
    validateBtn.addEventListener('click', async () => {
        const options = await showIntegrityCheckModal({ includeValidateDiced: true });
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

            if (validateInterval) clearInterval(validateInterval);

            if (!res.ok) throw new Error('Validation failed');

            const data = await res.json();
            const r = data.results;

            if (validationProgressBar) validationProgressBar.style.width = '100%';

            let message = `<strong>Check Complete</strong><br>`;
            if (r.purged > 0) message += `🔥 Purged ${r.purged} legacy thumbnails<br>`;
            if (r.duplicatesRemoved > 0) message += `🧹 Removed ${r.duplicatesRemoved} duplicates<br>`;
            if (r.metadataRepaired > 0) message += `🔧 Repaired ${r.metadataRepaired} metadata<br>`;
            if (r.missing > 0) message += `🗑️ Removed ${r.missing} missing files<br>`;
            if (r.fixedThumbnails > 0) message += `🖼️ Fixed ${r.fixedThumbnails} thumbnails<br>`;
            if (r.dicedStaleReDiced > 0) message += `🧩 Re-diced ${r.dicedStaleReDiced} stale prompts (description changed)<br>`;
            if (r.dicedMissingRepaired > 0) message += `🧩 Diced ${r.dicedMissingRepaired} missing prompts<br>`;
            if (r.dicedDesyncedRepaired > 0) message += `🔗 Synced ${r.dicedDesyncedRepaired} image rows<br>`;
            if (r.dicedOrphansCleaned > 0) message += `🧹 Cleaned ${r.dicedOrphansCleaned} orphaned diced entries<br>`;
            if (r.orphanedEmbeddingsPruned > 0) message += `🧬 Pruned ${r.orphanedEmbeddingsPruned} orphaned embedding vectors<br>`;
            if (r.errors.length > 0) message += `⚠️ ${r.errors.length} errors occurred`;

            if (
                r.purged === 0 && r.duplicatesRemoved === 0 && r.metadataRepaired === 0
                && r.missing === 0 && r.fixedThumbnails === 0 && r.errors.length === 0
                && (r.dicedStaleReDiced || 0) === 0 && (r.dicedMissingRepaired || 0) === 0
                && (r.dicedDesyncedRepaired || 0) === 0 && (r.orphanedEmbeddingsPruned || 0) === 0
            ) {
                message += "✅ Database, Diced Prompts & Embeddings are healthy!";
            }

            validationText.innerHTML = message;
            
            // Auto-hide after 5 seconds if successful
            setTimeout(() => {
                if (validationStatus.style.display === 'block' && !message.includes('Error')) {
                    validationStatus.style.display = 'none';
                    validationProgressBar.style.width = '0%';
                }
            }, 5000);

            // Refresh grid if changes were made
            if (
                r.missing > 0 || r.fixedThumbnails > 0 || r.purged > 0
                || (r.dicedStaleReDiced || 0) > 0 || (r.dicedMissingRepaired || 0) > 0
                || (r.dicedDesyncedRepaired || 0) > 0
            ) {
                setTimeout(() => {
                    initDatabase(); // Reload current view
                }, 1000);
            }

        } catch (err) {
            console.error('Validation error:', err);
            if (validationText) validationText.textContent = 'Error: ' + err.message;
            if (validationProgressBar) validationProgressBar.style.backgroundColor = '#ef4444';
        } finally {
            if (validateInterval) clearInterval(validateInterval);
            validateBtn.disabled = false;
            validateBtn.innerHTML = originalText;
        }
    });
}

// ============================================================================
// SELECTION & BATCH ANALYSIS
// ============================================================================
const selectMissingBtn = document.getElementById('selectMissingBtn');
const unselectAllBtn = document.getElementById('unselectAllBtn');
const processSelectedBtn = document.getElementById('processSelectedBtn');
const dbPromptType = document.getElementById('dbPromptType');

// Custom Modal Elements
const customModal = document.getElementById('customModal');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalConfirm = document.getElementById('modalConfirm');
const modalHasCancel = document.getElementById('modalHasCancel');

// Helper: Custom Modal
// WHAT: Opens, configures, and displays the app-wide general message modal dialog.
// WHY: This central overlay modal is used for notifications or basic binary confirm prompts. By escaping the
// message using `escapeHtmlCharacters` before replacing line breaks with `<br>` tags, we guarantee XSS safety
// while still supporting multi-line spacing structure in the dialogue.
function showModal(modal_dialogue_header_title_text, modal_dialogue_body_message_text, is_confirmation_prompt_boolean = false) {
    return new Promise((promise_resolution_handler_function) => {
        if (!customModal) {
            // WHAT: Fallback logic using native alerts/confirms if the custom modal elements are not found in the DOM.
            // WHY: Ensures the application remains functional even in anomalous visual states.
            if (is_confirmation_prompt_boolean) {
                promise_resolution_handler_function(confirm(modal_dialogue_body_message_text));
            } else {
                showToast(modal_dialogue_body_message_text, 'info');
                promise_resolution_handler_function(true);
            }
            return;
        }

        // WHAT: Assigning the text parameters and escaping inputs to shield the element from script injections.
        // WHY: Escaping ensures any dynamic data or error messages inside the body are rendered safely.
        modalTitle.textContent = modal_dialogue_header_title_text;
        
        const escaped_modal_dialogue_body_message_text = escapeHtmlCharacters(modal_dialogue_body_message_text);
        modalMessage.innerHTML = escaped_modal_dialogue_body_message_text.replace(/\n/g, '<br>');

        modalHasCancel.style.display = is_confirmation_prompt_boolean ? 'block' : 'none';
        modalConfirm.textContent = is_confirmation_prompt_boolean ? 'Confirm' : 'OK';

        customModal.style.display = 'flex';

        // WHAT: Defining click event handlers for confirming or cancelling the modal choice.
        // WHY: The handlers close the dialogue and return the user's action through the promise scope.
        const confirm_selection_action_handler_function = () => {
            cleanup_modal_and_remove_event_listeners();
            promise_resolution_handler_function(true);
        };

        const cancel_selection_action_handler_function = () => {
            cleanup_modal_and_remove_event_listeners();
            promise_resolution_handler_function(false);
        };

        // WHAT: Dismantling click listeners and hiding the custom modal layout node.
        // WHY: Teardowns ensure no event trigger conflicts occur when the dialog is re-opened.
        const cleanup_modal_and_remove_event_listeners = () => {
            modalConfirm.removeEventListener('click', confirm_selection_action_handler_function);
            modalHasCancel.removeEventListener('click', cancel_selection_action_handler_function);
            customModal.style.display = 'none';
        };

        modalConfirm.addEventListener('click', confirm_selection_action_handler_function);
        modalHasCancel.addEventListener('click', cancel_selection_action_handler_function);
    });
}


// 1. Select Missing
if (selectMissingBtn) {
    selectMissingBtn.addEventListener('click', () => {
        let count = 0;
        const is_dicer_mode = dbPromptType && dbPromptType.value === 'Prompt Dicer';

        imagesData.forEach(single_image_record => {
            let analysis = {};
            try {
                analysis = typeof single_image_record.analysis === 'string'
                    ? JSON.parse(single_image_record.analysis)
                    : (single_image_record.analysis || {});
            } catch (e) { }

            const diced_record = extractDicedPromptMasterRecord(single_image_record, analysis);
            const is_missing_data = is_dicer_mode
                ? !diced_record
                : (!analysis.summary || !analysis.tags || analysis.tags.length === 0 || !analysis.objects || analysis.objects.length === 0 || !single_image_record.width || !single_image_record.height);

            if (is_missing_data) {
                selectedIds.add(String(single_image_record.id));
                count++;

                // Updates visual check
                const checkbox = document.querySelector(`.card-select-cb[data-id="${single_image_record.id}"]`);
                if (checkbox) checkbox.checked = true;

                const card = document.querySelector(`.card[data-id="${single_image_record.id}"]`);
                if (card) card.classList.add('selected');
            }
        });

        if (count > 0) {
            updateProcessButton();
        } else {
            showModal('Auto-Selection', is_dicer_mode ? 'All loaded images already have a diced prompt Master Record!' : 'No loaded images found with missing data.');
        }
    });
}

// 1b. Validate & Sync All Diced Prompts in Library
const diceAllPromptsBtn = document.getElementById('diceAllPromptsBtn');
if (diceAllPromptsBtn) {
    diceAllPromptsBtn.addEventListener('click', async () => {
        diceAllPromptsBtn.disabled = true;
        const original_button_label = diceAllPromptsBtn.textContent;
        diceAllPromptsBtn.textContent = '🧩 Validating & Syncing...';

        if (validationStatus) {
            validationStatus.style.display = 'block';
            validationText.textContent = 'Validating diced prompts against latest image descriptions...';
            validationProgressBar.style.width = '35%';
        }

        try {
            const http_response = await fetch(`${API_BASE_URL}/api/dicer/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force_heuristic: true })
            });
            const payload = await http_response.json();
            if (!http_response.ok || !payload.success) {
                throw new Error(payload.error || 'Diced prompt validation failed');
            }

            // WHAT: Naming the validation summary payload semantically and displaying repair counts.
            // WHY: Makes each summary metric clear without cryptic single-letter abbreviations.
            const validation_summary = payload.summary;
            const ovis_enriched_total = validation_summary.ovis_enriched_count || 0;
            if (validationProgressBar) validationProgressBar.style.width = '100%';
            if (validationText) {
                validationText.innerHTML = `<strong>Diced Prompt Validation Complete!</strong><br>Valid: ${validation_summary.valid_count} | Re-diced Stale: ${validation_summary.stale_re_diced_count} | Repaired Missing: ${validation_summary.missing_repaired_count} | Structural Repairs: ${validation_summary.desynced_repaired_count} | Ovis Enriched: ${ovis_enriched_total}`;
            }
            showToast(
                `✓ Validated ${validation_summary.total_images} images (Re-diced ${validation_summary.stale_re_diced_count} stale, repaired ${validation_summary.missing_repaired_count + validation_summary.desynced_repaired_count}, Ovis enriched ${ovis_enriched_total})`,
                'success'
            );
            if (validation_summary.stale_re_diced_count > 0 || validation_summary.missing_repaired_count > 0 || validation_summary.desynced_repaired_count > 0 || ovis_enriched_total > 0) {
                await initDatabase();
            }
        } catch (batch_dice_error) {
            console.error('[DATABASE-DICER] Validation error:', batch_dice_error);
            showToast(`Diced validation error: ${batch_dice_error.message}`, 'error');
        } finally {
            diceAllPromptsBtn.disabled = false;
            diceAllPromptsBtn.textContent = original_button_label;
        }
    });
}

// 2. Unselect All
if (unselectAllBtn) {
    unselectAllBtn.addEventListener('click', () => {
        selectedIds.clear();
        document.querySelectorAll('.card-select-cb').forEach(cb => cb.checked = false);
        document.querySelectorAll('.card.selected').forEach(card => card.classList.remove('selected'));
        updateProcessButton();
    });
}

// 3. Handle Individual Selection (Delegated from Grid)
dbGrid.addEventListener('change', (e) => {
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

    // Show/Hide Unselect All Button
    if (unselectAllBtn) {
        unselectAllBtn.style.display = count > 0 ? 'block' : 'none';
    }
}

// ============================================================================
// BULK RENAME HANDLER
// ============================================================================
/**
 * Attached to the "Bulk Rename" button. This triggers the multi-file rename
 * workflow using our custom modal to collect the base name from the user.
 * 
 * Flow:
 * 1. Collect Base Name (UI Modal)
 * 2. Send IDs + BaseName to Server (/bulk-rename)
 * 3. Clearing selection and refreshing view on success.
 */
const bulkRenameBtn = document.getElementById('bulkRenameBtn');
if (bulkRenameBtn) {
    bulkRenameBtn.addEventListener('click', async () => {
        // Guard: Don't do anything if no files are selected
        if (selectedIds.size === 0) return;

        /**
         * STEP 1: UI INTERACTION
         * We trigger our custom modal to ask for the naming prefix (e.g. "beach")
         */
        const selectedBaseName = await showBulkRenameModal(selectedIds, imagesData, getRecentRenames());
        
        // If the user cancelled the modal or entered an empty string, we exit
        if (!selectedBaseName || !selectedBaseName.trim()) {
            return; 
        }

        // Disable button during network request to prevent double-clicks
        bulkRenameBtn.disabled = true;
        const previousButtonLabel = bulkRenameBtn.textContent;
        bulkRenameBtn.textContent = 'Renaming Files...';

        try {
            /**
             * STEP 2: SERVER COMMUNICATION
             * We send the Array of selected IDs and the sanitized name to our Express backend.
             */
            const renameRequest = await fetch(`${API_BASE_URL}/bulk-rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: Array.from(selectedIds),
                    baseName: selectedBaseName.trim()
                })
            });

            const renameResponseData = await renameRequest.json();
            
            if (renameRequest.ok && renameResponseData.success) {
                /**
                 * STEP 3: SUCCESS FEEDBACK
                 * Notify user, clear selection, and trigger a full database reload
                 * so the UI immediately reflects the new filenames.
                 */
                saveRecentRename(selectedBaseName.trim());
                showToast(renameResponseData.message || 'Successfully renamed files', 'success');
                
                selectedIds.clear(); // Important: Deselect everything after the batch move
                updateProcessButton(); // Reset sidebar state
                initDatabase(); // Reload the whole grid (uses local cache + fetch)
            } else {
                // Specific error from backend logic (e.g. file collision)
                showToast(renameResponseData.error || 'Failed to bulk rename', 'error');
            }
        } catch (commError) {
            console.error('Bulk rename network failure:', commError);
            showToast('Unable to reach the server for renaming.', 'error');
        } finally {
            // Restore button state
            bulkRenameBtn.disabled = false;
            bulkRenameBtn.textContent = previousButtonLabel;
        }
    });
}

// 4. Process Selected
if (processSelectedBtn) {
    processSelectedBtn.addEventListener('click', async () => {
        if (selectedIds.size === 0) return;

        if (!await showModal('Confirm Processing', `Re-analyze ${selectedIds.size} images with mode: "<strong>${dbPromptType.value}</strong>"?`, true)) {
            return;
        }

        processSelectedBtn.disabled = true;
        processSelectedBtn.textContent = 'Processing...';

        // Cancellation support
        let isCancelled = false;
        const closeBtn = document.getElementById('closeStatus');
        const cancelHandler = () => { isCancelled = true; };
        if (closeBtn) closeBtn.addEventListener('click', cancelHandler, { once: true });

        try {
            const ids = Array.from(selectedIds);
            const promptType = dbPromptType.value;
            const total = ids.length;
            let successCount = 0;
            let failedCount = 0;
            const errors = [];

            // Show status
            validationStatus.style.display = 'block';
            validationText.textContent = `Starting batch processing...`;
            validationProgressBar.style.width = '0%';

            for (let i = 0; i < total; i++) {
                if (isCancelled) {
                    validationText.textContent = 'Processing cancelled.';
                    break;
                }

                validationText.textContent = `Processing image ${i + 1} of ${total}...`;

                try {
                    const id = ids[i];
                    // Sequential Request
                    const response = await fetch(`${API_BASE_URL}/batch-analyze`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: [id], promptType })
                    });

                    if (!response.ok) throw new Error('API request failed');

                    const result = await response.json();

                    if (result.success > 0 && result.updatedImages && result.updatedImages.length > 0) {
                        successCount++;
                        const updated = result.updatedImages[0];

                        // Update Local Cache
                        const local_image_record = imagesData.find(single_image_record => single_image_record.id == updated.id);
                        if (local_image_record) {
                            local_image_record.analysis = updated.analysis;
                            if (updated.diced_prompt) {
                                local_image_record.diced_prompt = updated.diced_prompt;
                            }
                            local_image_record.updated_at = updated.updated_at;
                            if (updated.width) local_image_record.width = updated.width;
                            if (updated.height) local_image_record.height = updated.height;
                            if (updated.size) local_image_record.size = updated.size;

                            // Update DOM
                            const existingCard = document.querySelector(`.card[data-id="${updated.id}"]`);
                            if (existingCard) {
                                const newCardHtml = createCardHtml(local_image_record, measureSingleCardHeight(local_image_record));
                                const temp = document.createElement('div');
                                temp.innerHTML = newCardHtml;
                                existingCard.replaceWith(temp.firstElementChild);
                            }
                        }
                    } else {
                        failedCount++;
                        if (result.errors) errors.push(...result.errors);
                    }

                } catch (err) {
                    console.error(`Error processing ID ${ids[i]}:`, err);
                    failedCount++;
                    errors.push(`${ids[i]}: ${err.message}`);
                }

                // Update Progress Bar
                const percent = Math.round(((i + 1) / total) * 100);
                validationProgressBar.style.width = `${percent}%`;
            }

            validationProgressBar.style.width = '100%';
            validationText.innerHTML = `
                <strong>Batch Complete!</strong><br>
                Success: ${successCount} | Failed: ${failedCount}
                ${isCancelled ? '<br>(Cancelled)' : ''}
            `;

            // Auto-close if success
            if (successCount > 0 && failedCount === 0 && !isCancelled) {
                setTimeout(() => {
                    validationStatus.style.display = 'none';
                    validationProgressBar.style.width = '0%';
                }, 4000);
            }

            // Auto-Deselect
            if (!isCancelled) {
                if (unselectAllBtn) {
                    unselectAllBtn.click();
                } else {
                    selectedIds.clear();
                    document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
                    document.querySelectorAll('.card-select-cb').forEach(cb => cb.checked = false);
                    updateProcessButton();
                }
            }

        } catch (error) {
            console.error('Batch Process Error:', error);
            validationText.textContent = 'Error: ' + error.message;
            validationProgressBar.style.backgroundColor = '#ef4444';
        } finally {
            if (closeBtn) closeBtn.removeEventListener('click', cancelHandler);
            updateProcessButton();
            processSelectedBtn.disabled = false;
            processSelectedBtn.textContent = 'Process';
        }
    });
}

// 5. Delete Button Handler (Delegated)
document.addEventListener('click', async (e) => {
    // Check if clicked element is delete button or inside it
    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation(); // Essential!

        const id = deleteBtn.dataset.id;
        if (id) {
            await deleteFromDatabase(id);
        }
    }
});

if (closeStatus) {
    closeStatus.addEventListener('click', () => {
        validationStatus.style.display = 'none';
        validationProgressBar.style.width = '0%';
        validationProgressBar.style.backgroundColor = 'var(--accent)';
    });
}

// ============================================================================
// CONTEXT MENU & TAG MANAGEMENT
// ============================================================================
const contextMenu = document.getElementById('contextMenu');
let ctxTarget = null; // { id, tag, type, card }

function showContextMenu(e, id, type, tag = null, card = null, dataType = null) {
    ctxTarget = { id, type, tag, card, dataType };
    contextMenu.style.display = 'block';

    // Position menu
    const menuWidth = 180;
    const menuHeight = type === 'thumbnail' ? 60 : 120;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) x -= menuWidth;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    // Show/hide relevant items
    const isFileLink = e.target.closest('.file-link');
    const renameItem = document.getElementById('ctxRename');

    document.getElementById('ctxRegenThumb').style.display = type === 'thumbnail' ? 'block' : 'none';
    document.getElementById('ctxFindSimilar').style.display = (type === 'thumbnail' || type === 'tag') ? 'block' : 'none';
    const ovis_classify_menu_item = document.getElementById('ctxOvisClassify');
    if (ovis_classify_menu_item) {
        ovis_classify_menu_item.style.display = type === 'thumbnail' ? 'block' : 'none';
    }
    const dice_prompt_menu_item = document.getElementById('ctxDicePrompt');
    if (dice_prompt_menu_item) {
        dice_prompt_menu_item.style.display = type === 'thumbnail' ? 'block' : 'none';
    }
    document.getElementById('ctxSearch').style.display = type === 'tag' ? 'block' : 'none';
    document.getElementById('ctxEdit').style.display = type === 'tag' ? 'block' : 'none';
    document.getElementById('ctxDelete').style.display = type === 'tag' ? 'block' : 'none';

    if (renameItem) {
        renameItem.style.display = (type === 'file' || isFileLink) ? 'block' : 'none';
        if (isFileLink && !tag) ctxTarget.tag = isFileLink.textContent.trim();
    }

    const dividers = contextMenu.querySelectorAll('.context-menu-divider');
    dividers.forEach(d => d.style.display = (type === 'tag' || type === 'thumbnail') ? 'block' : 'none');
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
    ctxTarget = null;
}

document.addEventListener('click', hideContextMenu);

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
        showContextMenu(e, tagEl.dataset.id, 'tag', tagEl.dataset.tag, null, tagEl.dataset.type);
        return;
    }

    // Filename Right-Click
    const fileLink = e.target.closest('.file-link');
    if (fileLink) {
        e.preventDefault();
        e.stopPropagation();
        const card = fileLink.closest('.card');
        const id = card.dataset.id;
        showContextMenu(e, id, 'file', fileLink.textContent.trim(), card);
        return;
    }

    hideContextMenu();
});

// Context menu action listeners are located further down in the "Context Menu Actions" section.

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
            if (newName.match(/[<>:"\/\\|?*]/)) {
                alert('Invalid characters in filename.');
                return;
            }

            try {
                const res = await fetch(`${API_BASE_URL}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, newFilename: newName })
                });

                if (!res.ok) throw new Error((await res.json()).error || 'Rename failed');

                const data = await res.json();

                // Update UI
                const card = document.querySelector(`.card[data-id="${id}"]`);
                if (card) {
                    const fileLink = card.querySelector('.file-link');
                    if (fileLink) {
                        fileLink.textContent = data.newFilename;
                        fileLink.dataset.path = data.newPath;
                    }
                    const matched_image_record = imagesData.find(single_image_record => single_image_record.id == id);
                    if (matched_image_record) {
                        matched_image_record.filename = data.newFilename;
                        matched_image_record.path = data.newPath;
                    }
                }
            } catch (err) {
                alert('Rename Error: ' + err.message);
            }
        });
    });
}



// Click delegation for Add Tag button
dbGrid.addEventListener('click', (e) => {
    if (e.target.closest('.add-tag-btn')) {
        const btn = e.target.closest('.add-tag-btn');
        const id = btn.dataset.id;
        const type = btn.dataset.type;
        addTag(id, type);
    }
});

// Context Menu Actions
document.getElementById('ctxRegenThumb').addEventListener('click', async () => {
    if (!ctxTarget || ctxTarget.type !== 'thumbnail') return;
    const { id, card } = ctxTarget;
    hideContextMenu();
    await regenerateThumbnail(id, card);
});

const ctxFindSimilar = document.getElementById('ctxFindSimilar');
if (ctxFindSimilar) {
    ctxFindSimilar.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget || !ctxTarget.id) return;
        const targetId = ctxTarget.id;
        hideContextMenu();
        window.location.href = `search.html?similar=${targetId}`;
    });
}

// WHAT: Event listener for Ovis-Omni Zero-Shot Visual Classification.
// WHY: Allows the user to trigger immediate zero-shot facet classification for an image directly from the UI,
//      evaluating medium, mood, and composition using raw vision embeddings without requiring full Qwen captioning.
const context_menu_ovis_classify_button = document.getElementById('ctxOvisClassify');
if (context_menu_ovis_classify_button) {
    context_menu_ovis_classify_button.addEventListener('click', async (mouse_click_event) => {
        mouse_click_event.stopPropagation();
        if (!ctxTarget || !ctxTarget.id) return;
        const target_image_database_identifier = ctxTarget.id;
        hideContextMenu();

        showToast('🧠 Running Ovis-Omni zero-shot visual classification...', 'info');

        try {
            const http_classification_response = await fetch('/api/ovis/classify-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_id: target_image_database_identifier,
                    persist_to_database: true
                })
            });

            if (!http_classification_response.ok) {
                const error_response_payload = await http_classification_response.json();
                throw new Error(error_response_payload.error || 'Classification failed');
            }

            const classification_result_payload = await http_classification_response.json();
            const visual_medium_name = classification_result_payload.medium;
            const visual_mood_name = classification_result_payload.mood;
            showToast(`🧠 Facets Saved: ${visual_medium_name} • ${visual_mood_name}`, 'success');
        } catch (zero_shot_classification_error) {
            console.error('[OVIS-CLIENT] Classification error:', zero_shot_classification_error);
            showToast(`Ovis classification failed: ${zero_shot_classification_error.message}`, 'error');
        }
    });
}

// WHAT: Context menu action to slice and dice prompt ingredients for the selected image entry.
// WHY: Gives users immediate right-click access from the Database grid to decompose image prompts into ingredients
//      and immediately update the image card in place.
const context_menu_dice_prompt_button = document.getElementById('ctxDicePrompt');
if (context_menu_dice_prompt_button) {
    context_menu_dice_prompt_button.addEventListener('click', async (mouse_click_event) => {
        mouse_click_event.stopPropagation();
        if (!ctxTarget || !ctxTarget.id) return;
        const target_image_identifier = ctxTarget.id;
        hideContextMenu();
        await diceSingleImageAndRefreshCard(target_image_identifier);
    });
}

const ctxSearch = document.getElementById('ctxSearch');
if (ctxSearch) {
    ctxSearch.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget || !ctxTarget.tag) return;
        
        const query = encodeURIComponent(ctxTarget.tag);
        const dataType = ctxTarget.dataType || 'tags';
        const filterType = dataType === 'objects' ? 'object' : 'tag';
        
        hideContextMenu();

        window.location.href = `search.html?q=${query}&type=${filterType}`;
    });
}

document.getElementById('ctxEdit').addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.type !== 'tag') return;
    const { id, tag, dataType } = ctxTarget;
    hideContextMenu();

    const realType = dataType || 'tags';

    showTagInputModal(`Edit ${realType.slice(0, -1)}`, tag, (newTag) => {
        if (newTag && newTag.trim() && newTag.trim() !== tag) {
            updateTag(id, realType, tag, newTag.trim(), 'edit');
        }
    });
});

document.getElementById('ctxDelete').addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.type !== 'tag') return;
    const { id, tag, dataType } = ctxTarget;
    hideContextMenu();

    const realType = dataType || 'tags';

    showConfirmModal(`Delete "${tag}"?`, () => {
        updateTag(id, realType, tag, null, 'delete');
    });
});

async function addTag(id, type) {
    showTagInputModal(`Add new ${type.slice(0, -1)}`, '', (inputValue) => {
        if (inputValue && inputValue.trim()) {
            // Split by comma to support multiple tags
            const tags = inputValue.split(',').map(t => t.trim()).filter(t => t.length > 0);

            tags.forEach(newTag => {
                updateTag(id, type, null, newTag, 'add');
            });

            if (tags.length > 0) {
                showToast(`Added ${tags.length} tag(s)`, 'success');
            }
        }
    });
}

// Update Tag Backend Call
async function updateTag(id, type, oldTag, newTag, action) {
    try {
        const image = imagesData.find(single_image_record => single_image_record.id == id);
        if (!image) throw new Error('Image not found in local cache');

        let analysis = image.analysis || {};
        let list = analysis[type] || [];

        if (action === 'edit') {
            const idx = list.indexOf(oldTag);
            if (idx !== -1) list[idx] = newTag;
        } else if (action === 'delete') {
            list = list.filter(t => t !== oldTag);
        } else if (action === 'add') {
            if (!list.includes(newTag)) list.push(newTag);
        }

        analysis[type] = list;
        image.analysis = analysis; // Keep local cache in sync

        const response = await fetch(`${API_BASE_URL}/update-tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, analysis })
        });

        if (!response.ok) throw new Error('Update failed');

        // In-Place UI Update
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            const newHtml = createCardHtml(image, measureSingleCardHeight(image));
            card.outerHTML = newHtml;
        }

    } catch (error) {
        console.error('Tag update error:', error);
        showToast('Failed to update tags: ' + error.message, 'error');
    }
}

async function deleteFromDatabase(id) {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (!card) return;

    // Get filename for context
    const filenameEl = card.querySelector('.card-filename') || card.querySelector('.text-accent'); // Fallback
    const filename = filenameEl ? filenameEl.textContent.trim() : 'Image';

    // 3-Option Delete Modal
    showDeleteOptionsModal(filename, async (action) => {
        if (action === 'cancel') return;

        try {
            const deleteFile = (action === 'delete-file');

            const response = await fetch(`${API_BASE_URL}/delete-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, deleteFile })
            });

            if (!response.ok) throw new Error('Delete failed');

            // Remove from UI
            card.remove();

            // Remove from selection if present
            selectedIds.delete(String(id));
            updateProcessButton();

        } catch (error) {
            console.error('Delete error:', error);
            showToast('Failed to delete: ' + error.message, 'error');
        }
    });
}

function showDeleteOptionsModal(filename, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 1rem; border-radius: 12px; border: 1px solid var(--border); max-width: 500px; width: 90%; text-align: center;">
            <h3 style="margin-top: 0; color: var(--text-primary);">Delete Image?</h3>
            <p style="color: var(--text-secondary); margin-bottom: 1rem;">
                Action for: <strong style="color: var(--accent);">${filename}</strong>
            </p>
            <div style="display: flex; flex-direction: column; gap: 1rem;">
                <button id="btnDbOnly" style="padding: 1rem; border-radius: 8px; border: 1px solid var(--border); background: #a05806ff; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                    <span>🗑️</span> Remove from Database (Keep File)
                </button>
                <button id="btnCancel" style="padding: 1.25rem; border-radius: 8px; border: 1px solid #4fb2a3; background: #4b7e91ff; color: white; cursor: pointer; font-size: 2rem; margin-top: 1rem; margin-bottom: 1rem;">
                    Cancel
                </button>
                <button id="btnDeleteFile" style="padding: 1rem; border-radius: 8px; border: none; background: #991b1b; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 1rem;">
                    <span>⚠️</span> Delete File & Remove from Database
                </button>

            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
            callback('cancel');
        }
    };
    document.addEventListener('keydown', keyHandler);

    modal.querySelector('#btnDbOnly').onclick = () => {
        cleanup();
        callback('delete-db');
    };

    modal.querySelector('#btnDeleteFile').onclick = () => {
        cleanup();
        callback('delete-file');
    };

    modal.querySelector('#btnCancel').onclick = () => {
        cleanup();
        callback('cancel');
    };

    modal.onclick = (e) => {
        if (e.target === modal) {
            cleanup();
            callback('cancel');
        }
    };
}

// Custom Input Modal (Replaces prompt)
async function regenerateThumbnail(id, cardElement) {
    const thumbnail_elements = cardElement.querySelectorAll('.thumbnail-preview');
    try {
        thumbnail_elements.forEach(thumbnail_image_element => {
            thumbnail_image_element.style.opacity = '0.5';
        });

        const response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        if (!response.ok) throw new Error('Regeneration failed');

        const data = await response.json();

        if (data.thumbPath) {
            const refreshed_thumbnail_url = `${data.thumbPath}?t=${Date.now()}`;
            thumbnail_elements.forEach(thumbnail_image_element => {
                thumbnail_image_element.src = refreshed_thumbnail_url;
                thumbnail_image_element.style.display = 'block';
            });
            cardElement.querySelectorAll('.thumb-fallback').forEach(fallback_element => {
                fallback_element.style.display = 'none';
            });
        }

    } catch (error) {
        console.error('Regenerate error:', error);
        showToast('Failed to regenerate thumbnail: ' + error.message, 'error');
    } finally {
        cardElement.querySelectorAll('.thumbnail-preview').forEach(thumbnail_image_element => {
            thumbnail_image_element.style.opacity = '1';
        });
    }
}

// ============================================================================
// INITIALIZE
// ============================================================================
// Defer init slightly to allow the pretext type="module" script to register
// on window before the first renderBatch runs. Module scripts are deferred
// by spec and execute after inline scripts, so a microtask yield suffices.
Promise.resolve().then(() => {
    // Double-yield: first microtask lets the module script queue,
    // second requestAnimationFrame ensures it has executed.
    requestAnimationFrame(() => initDatabase());
});

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
    const updated_recent_renames_list = computeUpdatedRecentRenamesList(getRecentRenames(), name);
    localStorage.setItem('recentRenames', JSON.stringify(updated_recent_renames_list));
}
