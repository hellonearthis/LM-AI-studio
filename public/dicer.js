/**
 * Prompt Dicer & Remix Workbench Client Application
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 * Pure Functional Architecture is enforced: deterministic transformations, immutability,
 * and strict separation between pure calculations and DOM side-effect boundaries.
 */

import { escapeHtmlCharacters as escapeHtmlEntities } from './modules/cardCore.js';
import { createDicerReviewController } from "./modules/dicerReviewController.js";
import {
    CONTROLLED_SLOT_METADATA_TABLE,
    DEFAULT_TRANSPLANT_LOCKED_SLOTS,
    buildRemixPromptThumbnailHtml,
    buildClosureTraceBannerHtml,
    buildRoundTripBadgeMeta,
    buildDicingResultPreviewHtml,
    buildSittingProgressHtml,
    buildHighlightedPromptTokensHtml,
    buildGroundingHistogramSvg,
    buildLayaCalibrationSvg
} from './modules/dicerRenderers.js';

// WHAT: Instantiating the Rapid Review Queue & Calibration Dashboard controller.
// WHY: Exposes queue pagination, hotkey listeners, and calibration fetching methods in scope.
const {
    loadReviewQueue,
    submitReviewEvent,
    submitSlotCorrectionEvent,
    submitMissingEdgeEvent,
    fetchAndRenderCalibrationDashboard,
    handleReviewKeyboardShortcut,
    ensureReviewQueueLoadedOrRendered
} = createDicerReviewController();

// Application mutable boundary (state container)
let global_active_ingredients_collection = [];
let global_active_consequences_collection = [];
let global_catalog_ingredients_cache = [];
let global_discovered_candidate_prompts = [];
let global_all_influences_cache = [];
let global_locked_slots_set = new Set(DEFAULT_TRANSPLANT_LOCKED_SLOTS);
let global_remix_undo_stack = [];
let global_transplant_variation_counter = 0;

// ============================================================================
// 2. TAB NAVIGATION
// ============================================================================

/**
 * WHAT: Switches between the active tabs (Remix Workbench, Process & Dice, Catalog, Review Queue).
 * WHY: Provides single-page tab switching without full browser reloads.
 * 
 * @param {string} target_tab_identifier - 'remix' | 'process' | 'catalog' | 'review'.
 */
function switchDicerTab(target_tab_identifier) {
    const tab_identifiers_list = ['remix', 'process', 'catalog', 'review'];

    for (const single_tab_identifier of tab_identifiers_list) {
        const tab_button_element = document.getElementById(
            `tabBtn${single_tab_identifier.charAt(0).toUpperCase() + single_tab_identifier.slice(1)}`
        );
        const tab_content_element = document.getElementById(
            `tabContent${single_tab_identifier.charAt(0).toUpperCase() + single_tab_identifier.slice(1)}`
        );

        if (single_tab_identifier === target_tab_identifier) {
            tab_button_element?.classList.add('active');
            tab_content_element?.classList.add('active');
        } else {
            tab_button_element?.classList.remove('active');
            tab_content_element?.classList.remove('active');
        }
    }

    if (target_tab_identifier === 'catalog') {
        fetchAndRenderCatalogPrompts();
    } else if (target_tab_identifier === 'process') {
        fetchAndRenderCandidatePrompts();
    } else if (target_tab_identifier === 'review') {
        ensureReviewQueueLoadedOrRendered();
        fetchAndRenderCalibrationDashboard();
    }
}

// Make globally accessible for HTML onclick attributes
window.switchDicerTab = switchDicerTab;

// ============================================================================
// 3. STATS & CATALOG INITIALIZATION
// ============================================================================

/**
 * WHAT: Fetches top-level catalog counts and physicality metrics from the backend.
 * WHY: Populates the stats bar with real-time totals of prompts, ingredients, and average ratio.
 */
async function fetchAndRenderTopLevelStats() {
    try {
        const http_prompts_response = await fetch('/api/dicer/prompts?limit=15');
        if (!http_prompts_response.ok) throw new Error(`HTTP ${http_prompts_response.status}`);
        const prompts_payload = await http_prompts_response.json();
        const prompts_collection = prompts_payload.prompts || [];
        const catalog_stats = prompts_payload.stats || {};

        const http_ingredients_response = await fetch('/api/dicer/ingredients?limit=250');
        if (!http_ingredients_response.ok) throw new Error(`HTTP ${http_ingredients_response.status}`);
        const ingredients_payload = await http_ingredients_response.json();
        const ingredients_collection = ingredients_payload.ingredients || [];

        global_catalog_ingredients_cache = ingredients_collection;

        // Update DOM elements with full SQLite catalog statistics
        const prompts_count_element = document.getElementById('statsPromptsCount');
        const ingredients_count_element = document.getElementById('statsIngredientsCount');
        const ratio_value_element = document.getElementById('statsPhysicalityRatio');
        const influences_count_element = document.getElementById('statsInfluencesCount');

        if (prompts_count_element) {
            prompts_count_element.textContent = (catalog_stats.total_prompts ?? prompts_collection.length).toLocaleString();
        }
        if (ingredients_count_element) {
            ingredients_count_element.textContent = (catalog_stats.unique_ingredients ?? ingredients_collection.length).toLocaleString();
        }
        if (ratio_value_element) {
            ratio_value_element.textContent = Number(catalog_stats.average_physicality_ratio ?? 0).toFixed(2);
        }
        if (influences_count_element) {
            influences_count_element.textContent = (catalog_stats.total_influences ?? 0).toLocaleString();
        }

        renderSlotLibraryDrawer(ingredients_collection);
        renderSourcePromptsPicker(prompts_collection.slice(0, 6));
    } catch (stats_fetch_error) {
        console.error('[DICER-UI] Failed to load top-level stats:', stats_fetch_error);
    }
}

/**
 * WHAT: Validates all diced prompts against the latest image descriptions and repairs stale/missing rows.
 * WHY: Keeps diced prompts accurate whenever image descriptions are updated or regenerated.
 */
async function validateAndSyncAllDicedPrompts() {
    const validate_button = document.getElementById('btnValidateDicedPrompts');
    const original_label = validate_button ? validate_button.innerHTML : '';
    if (validate_button) {
        validate_button.disabled = true;
        validate_button.innerHTML = '<span>🔄</span> Validating...';
    }

    try {
        const http_response = await fetch('/api/dicer/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force_heuristic: true, sync_ovis_facets: true })
        });
        const payload = await http_response.json();
        if (!http_response.ok || !payload.success) {
            throw new Error(payload.error || 'Validation failed');
        }

        // WHAT: Unpacking the validation summary returned by the backend repair endpoint.
        // WHY: Giving the summary object a descriptive semantic name avoids opaque single-letter
        //      identifiers and makes each reported repair counter immediately self-explanatory.
        const validation_summary = payload.summary;
        alert(
            `✓ Diced Prompt Validation Complete!\n` +
            `• Total Images Checked: ${validation_summary.total_images}\n` +
            `• Up-to-date: ${validation_summary.valid_count}\n` +
            `• Re-diced Stale (Updated Descriptions): ${validation_summary.stale_repaired_count ?? validation_summary.stale_re_diced_count}\n` +
            `• Missing Repaired: ${validation_summary.missing_repaired_count}\n` +
            `• Structural Sync Repairs: ${validation_summary.desynced_repaired_count}\n` +
            `• Ovis Facet Enrichments: ${validation_summary.ovis_enriched_count ?? 0}`
        );
        await fetchAndRenderTopLevelStats();
        fetchAndRenderCatalogPrompts();
    } catch (validation_error) {
        alert(`Validation error: ${validation_error.message}`);
    } finally {
        if (validate_button) {
            validate_button.disabled = false;
            validate_button.innerHTML = original_label;
        }
    }
}

window.validateAndSyncAllDicedPrompts = validateAndSyncAllDicedPrompts;

/**
 * WHAT: Audits recent image captions against raw pixels using Ovis-Omni's 2048-dim multimodal space.
 * WHY: Flags mismatched or stale AI summaries so users know which images need re-analysis before trusting their diced prompts.
 */
async function auditVisualGroundingWithOvis() {
    const audit_button = document.getElementById('btnAuditVisualGrounding');
    const original_label = audit_button ? audit_button.innerHTML : '';
    if (audit_button) {
        audit_button.disabled = true;
        audit_button.innerHTML = '<span>⏳</span> Auditing...';
    }

    try {
        const http_response = await fetch('/api/dicer/visual-grounding-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 25, include_per_ingredient: true })
        });
        const payload = await http_response.json();
        if (!http_response.ok || !payload.online) {
            throw new Error(payload.error || 'Ovis-Omni service unavailable');
        }

        const flagged_preview = (payload.mismatched_items || [])
            .slice(0, 5)
            .map(item => {
                const missing_list = Array.isArray(item.missing_ingredients) && item.missing_ingredients.length > 0
                    ? ` | Missing: ${item.missing_ingredients.slice(0, 3).map(missing_entry => missing_entry.text).join(', ')}`
                    : '';
                return `- #${item.image_id} (${item.filename}): score ${item.grounding_score}${missing_list}`;
            })
            .join('\n');

        const per_ingredient_summary = payload.ingredient_grounding_counts &&
            (payload.ingredient_grounding_counts.grounded + payload.ingredient_grounding_counts.borderline + payload.ingredient_grounding_counts.mismatched) > 0
            ? `\n• Ingredient Checks: ${payload.ingredient_grounding_counts.grounded} grounded, ${payload.ingredient_grounding_counts.borderline} borderline, ${payload.ingredient_grounding_counts.mismatched} missing`
            : '';

        alert(
            `👁️ Ovis-Omni Visual Grounding Audit Complete\n` +
            `• Checked: ${payload.checked_count}\n` +
            `• Grounded: ${payload.grounded_count}\n` +
            `• Borderline: ${payload.borderline_count}\n` +
            `• Mismatched (Needs Re-analysis): ${payload.mismatched_count}` +
            per_ingredient_summary +
            (flagged_preview ? `\n\nFlagged Examples:\n${flagged_preview}` : '')
        );
    } catch (audit_error) {
        alert(`Visual grounding audit skipped: ${audit_error.message}`);
    } finally {
        if (audit_button) {
            audit_button.disabled = false;
            audit_button.innerHTML = original_label;
        }
    }
}

window.auditVisualGroundingWithOvis = auditVisualGroundingWithOvis;

/**
 * WHAT: Queries the backend for diced prompts matching the Remix Workbench search input.
 * WHY: Lets the user pick an existing prompt from the catalog as a base or merge source
 *      without having to remember exact prompt IDs.
 */
async function searchSourcePromptsForRemix() {
    const search_input = document.getElementById('remixPromptSearchInput');
    const search_query = search_input ? search_input.value.trim() : '';
    try {
        // WHAT: Constructing either a filtered query or a recent-prompts fallback URL.
        // WHY: An empty search box still surfaces 10 recent prompts so the picker is immediately useful.
        const query_url = search_query
            ? `/api/dicer/prompts?limit=15&q=${encodeURIComponent(search_query)}`
            : `/api/dicer/prompts?limit=10`;
        const http_response = await fetch(query_url);
        if (!http_response.ok) throw new Error(`HTTP ${http_response.status}`);
        const payload = await http_response.json();
        renderSourcePromptsPicker(payload.prompts || []);
    } catch (search_error) {
        console.error('[DICER-UI] Prompt search error:', search_error);
    }
}

window.searchSourcePromptsForRemix = searchSourcePromptsForRemix;

/**
 * WHAT: Builds HTML for a thumbnail preview (or fallback badge) inside a diced prompt search row.
 * WHY: Gives visual context alongside the prompt text when choosing source prompts for remixing.
 *
 * @param {Object} prompt_item - Diced prompt summary row returned from `/api/dicer/prompts`.
 * @returns {string} HTML string for the thumbnail container.
 */
/**
 * WHAT: Renders the list of searchable source prompts inside the Remix Workbench picker.
 * WHY: Shows thumbnails, physicality ratios, and Load Base / Merge actions side by side
 *      so users can compose new prompts from verified catalog pieces.
 *
 * @param {ReadonlyArray<Object>} prompts_collection - Candidate prompt summary records.
 */
function renderSourcePromptsPicker(prompts_collection) {
    const container = document.getElementById('remixPromptSearchResults');
    if (!container) return;

    // WHAT: Guarding against empty search results before rendering HTML rows.
    // WHY: Displaying a clear empty-state message avoids silent blank panels when no prompts match.
    if (!Array.isArray(prompts_collection) || prompts_collection.length === 0) {
        container.innerHTML = `<div style="font-size: 0.8rem; color: var(--text-secondary); padding: 0.4rem;">No matching diced prompts found.</div>`;
        return;
    }

    container.innerHTML = prompts_collection.map(prompt_item => {
        const raw_prompt_text = String(prompt_item.raw_prompt || '');
        const snippet = escapeHtmlEntities(
            raw_prompt_text.length > 280
                ? raw_prompt_text.slice(0, 280) + '...'
                : raw_prompt_text
        );
        const file_label = prompt_item.image_filename
            ? `<span style="color: var(--text-secondary); font-weight: 500;">(${escapeHtmlEntities(prompt_item.image_filename)})</span>`
            : '';
        const concreteness_badge = Number.isFinite(Number(prompt_item.physicality_ratio))
            ? `<span style="font-size: 0.72rem; color: #34d399; background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.25); border-radius: 999px; padding: 0.08rem 0.45rem;">⚡ ${Math.round(Number(prompt_item.physicality_ratio) * 100)}%</span>`
            : '';
        const safe_prompt_identifier = escapeHtmlEntities(prompt_item.prompt_id);
        const thumbnail_html = buildRemixPromptThumbnailHtml(prompt_item);

        return `
            <div class="remix-prompt-result-row">
                ${thumbnail_html}
                <div class="remix-prompt-result-body">
                    <div class="remix-prompt-result-header">
                        <span>${safe_prompt_identifier}</span>
                        ${file_label}
                        ${concreteness_badge}
                    </div>
                    <div class="remix-prompt-result-snippet">${snippet}</div>
                </div>
                <div class="remix-prompt-result-actions">
                    <button class="add-ingredient-btn" onclick="loadPromptIntoRemixWorkbench('${safe_prompt_identifier}', false)" title="Load all slots as starting base (replaces current canvas)">Load Base</button>
                    <button class="add-ingredient-btn" style="background: rgba(167, 139, 250, 0.16); color: #c4b5fd; border-color: rgba(167, 139, 250, 0.35);" onclick="loadPromptIntoRemixWorkbench('${safe_prompt_identifier}', true)" title="Merge all sliced ingredients from this prompt with existing pieces">+ Merge Pieces</button>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================================
// 4. REMIX WORKBENCH LOGIC
// ============================================================================

/**
 * WHAT: Updates the disabled state of the Undo button based on snapshot depth.
 * WHY: Keeps undo availability visually obvious without extra polling.
 */
function updateRemixUndoButtonState() {
    const undo_button = document.getElementById('btnUndoTransplant');
    if (undo_button) {
        undo_button.disabled = global_remix_undo_stack.length === 0;
    }
}

/**
 * WHAT: Saves an immutable snapshot of active ingredients, consequences, and locked slots onto the undo stack.
 * WHY: Supports one-click Undo after automated slot transplantation or manual closure pruning.
 */
function pushRemixUndoSnapshot() {
    const snapshot = {
        ingredients: global_active_ingredients_collection.map(item => ({ ...item })),
        consequences: [...global_active_consequences_collection],
        locked_slots: Array.from(global_locked_slots_set)
    };
    global_remix_undo_stack = [...global_remix_undo_stack.slice(-14), snapshot];
    updateRemixUndoButtonState();
}

/**
 * WHAT: Reverts the Remix canvas back to the previous ingredient/lock snapshot.
 * WHY: Gives curators instant one-click recovery if an automated swap goes in an undesired direction.
 */
async function undoLastRemixMutation() {
    if (global_remix_undo_stack.length === 0) return;
    const previous_snapshot = global_remix_undo_stack[global_remix_undo_stack.length - 1];
    global_remix_undo_stack = global_remix_undo_stack.slice(0, -1);

    global_active_ingredients_collection = previous_snapshot.ingredients || [];
    global_active_consequences_collection = previous_snapshot.consequences || [];
    global_locked_slots_set = new Set(previous_snapshot.locked_slots || DEFAULT_TRANSPLANT_LOCKED_SLOTS);

    updateRemixUndoButtonState();
    renderClosureTraceBanner(null, []);
    renderActiveIngredientsCanvas();
    await executeRemixPreviewEvaluation({ resolve_closure: false });
}

window.undoLastRemixMutation = undoLastRemixMutation;

/**
 * WHAT: Toggles whether a photographic slot is locked against automated transplantation and closure overwrites.
 * WHY: Lets users freeze subjects or optics while experimenting freely on weather, lighting, or setting.
 */
function toggleRemixSlotLock(slot_identifier) {
    const next_locked = new Set(global_locked_slots_set);
    if (next_locked.has(slot_identifier)) {
        next_locked.delete(slot_identifier);
    } else {
        next_locked.add(slot_identifier);
    }
    global_locked_slots_set = next_locked;
    renderActiveIngredientsCanvas();
}

window.toggleRemixSlotLock = toggleRemixSlotLock;

/**
 * WHAT: Displays pulled Influence Closure effects, pruned orphans, and transplanted slots in #closureTraceBanner.
 * WHY: Makes automated graph additions and removals transparent and reviewable on the canvas.
 */
function renderClosureTraceBanner(closure_trace, swapped_slots = []) {
    const banner_element = document.getElementById('closureTraceBanner');
    if (!banner_element) return;

    const banner_html = buildClosureTraceBannerHtml(closure_trace, swapped_slots);
    if (!banner_html) {
        banner_element.style.display = 'none';
        banner_element.innerHTML = '';
        return;
    }

    banner_element.innerHTML = banner_html;
    banner_element.style.display = 'block';
}

/**
 * WHAT: Updates the #roundTripStatusBadge in the output panel after verification.
 * WHY: Immediately surfaces whether re-dicing recovered all planned slots without new clashes.
 */
function renderRoundTripBadge(round_trip_verdict, execution_mode = null) {
    const badge_element = document.getElementById('roundTripStatusBadge');
    if (!badge_element) return;

    const badge_meta = buildRoundTripBadgeMeta(round_trip_verdict, execution_mode);
    badge_element.className = badge_meta.className;
    badge_element.textContent = badge_meta.text;
    badge_element.title = badge_meta.title;
    badge_element.style.display = badge_meta.visible ? 'inline-flex' : 'none';
}

/**
 * WHAT: Adds an ingredient to the active remix canvas and triggers Influence Closure + remix preview.
 * WHY: When a user clicks an ingredient chip from the catalog drawer, it binds to the canvas,
 *      pulls compatible downstream effects, and verifies continuity + round-trip survival.
 * 
 * @param {Object} ingredient_record - The ingredient object to append.
 */
function addIngredientToRemixCanvas(ingredient_record) {
    const is_already_present = global_active_ingredients_collection.some(
        existing_ingredient => existing_ingredient.text === ingredient_record.text
    );

    if (is_already_present) {
        return; // Prevent duplicate identical chips
    }

    pushRemixUndoSnapshot();
    global_active_ingredients_collection = [
        ...global_active_ingredients_collection,
        ingredient_record
    ];

    renderActiveIngredientsCanvas();
    executeRemixPreviewEvaluation({ resolve_closure: true });
}

/**
 * WHAT: Removes an ingredient chip from the active remix canvas and prunes orphaned effects.
 * WHY: Allows interactive removal of modifiers, pruning unsupported downstream closure receivers and clearing clashes.
 * 
 * @param {string} ingredient_text_to_remove - The text of the ingredient to remove.
 */
function removeIngredientFromRemixCanvas(ingredient_text_to_remove) {
    const removed_items = global_active_ingredients_collection.filter(
        single_ingredient => single_ingredient.text === ingredient_text_to_remove
    );
    if (removed_items.length === 0) return;

    pushRemixUndoSnapshot();
    global_active_ingredients_collection = global_active_ingredients_collection.filter(
        single_ingredient => single_ingredient.text !== ingredient_text_to_remove
    );

    renderActiveIngredientsCanvas();
    executeRemixPreviewEvaluation({
        resolve_closure: true,
        removed_ingredients: removed_items
    });
}

window.removeIngredientFromRemixCanvas = removeIngredientFromRemixCanvas;

/**
 * WHAT: Clears all ingredients from the active remix canvas.
 * WHY: Resets the workbench for building a fresh prompt from scratch and refreshes the ingredient library drawer.
 */
function clearRemixCanvas() {
    if (global_active_ingredients_collection.length > 0) {
        pushRemixUndoSnapshot();
    }
    global_active_ingredients_collection = [];
    global_active_consequences_collection = [];
    renderClosureTraceBanner(null, []);
    renderActiveIngredientsCanvas();
    executeRemixPreviewEvaluation({ resolve_closure: false });
    // WHAT: Refresh the ingredient library drawer after clearing active pieces.
    // WHY: Clears any cluster-scoped recommendation bias from the previously active prompt pieces.
    filterSlotLibrary();
}

window.clearRemixCanvas = clearRemixCanvas;

/**
 * WHAT: Renders the active ingredient chips grouped by photographic slots with per-slot lock toggles.
 * WHY: Visually separates lens, lighting, weather, appearance, and mood while letting users lock slots before transplanting.
 */
function updateRemixSourceAttributionSummary() {
    const summary_element = document.getElementById('remixSourceSummary');
    if (!summary_element) return;

    const total_pieces = global_active_ingredients_collection.length;
    const distinct_prompts = new Set(
        global_active_ingredients_collection.map(item => item.prompt_id).filter(Boolean)
    );
    if (total_pieces === 0) {
        summary_element.textContent = '0 active pieces';
    } else if (distinct_prompts.size > 0) {
        summary_element.textContent = `Recombining ${total_pieces} pieces from ${distinct_prompts.size} prompt${distinct_prompts.size === 1 ? '' : 's'}`;
    } else {
        summary_element.textContent = `${total_pieces} active pieces`;
    }
}

/**
 * WHAT: Renders all currently active Remix Workbench ingredients grouped into controlled slot lanes.
 * WHY: Organizing chips by semantic slot (camera, lighting, appearance, etc.) lets users lock
 *      specific lanes for Constraint Transplant and spot missing or conflicting pieces quickly.
 */
function renderActiveIngredientsCanvas() {
    const active_slots_container = document.getElementById('activeSlotsContainer');
    updateRemixSourceAttributionSummary();
    updateRemixUndoButtonState();
    if (!active_slots_container) return;

    // WHAT: Showing onboarding instructions when the active ingredient canvas is empty.
    // WHY: Guides first-time users to load a base prompt or pick pieces from the right-hand drawer.
    if (global_active_ingredients_collection.length === 0) {
        active_slots_container.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.9rem;">
                No ingredients added yet. Load a base prompt above or pick ingredients from the library drawer on the right.
            </div>
        `;
        return;
    }

    // WHAT: Grouping active ingredients into an immutable slot-keyed dictionary via reduce.
    // WHY: Pure reduction keeps lane grouping deterministic without mutating intermediate arrays.
    const grouped_by_slot = global_active_ingredients_collection.reduce((accumulator_map, single_ingredient) => {
        const slot_key = single_ingredient.slot || 'other';
        const existing_slot_items = accumulator_map[slot_key] || [];
        return {
            ...accumulator_map,
            [slot_key]: [...existing_slot_items, single_ingredient]
        };
    }, {});

    const slot_keys_list = Object.keys(grouped_by_slot);
    const html_rows_collection = slot_keys_list.map(slot_identifier => {
        const is_slot_locked = global_locked_slots_set.has(slot_identifier);
        const slot_metadata = CONTROLLED_SLOT_METADATA_TABLE[slot_identifier] || {
            label: slot_identifier,
            emoji: '✨',
            badgeClass: 'badge-other'
        };

        const chips_html = grouped_by_slot[slot_identifier].map(ingredient_item => {
            const safe_text = escapeHtmlEntities(ingredient_item.text);
            const measurement_badge = ingredient_item.measured_number
                ? `<span style="opacity: 0.7; font-size: 0.75rem; margin-left: 0.25rem;">(${ingredient_item.measured_number}${ingredient_item.measured_unit || ''})</span>`
                : '';
            const ovis_chip_badge = ingredient_item.source === 'ovis_facet'
                ? `<span style="font-size: 0.68rem; color: #c4b5fd; margin-left: 0.25rem;" title="Inferred from Ovis-Omni image_facets">👁️</span>`
                : '';
            const provenance_badge = ingredient_item.provenance === 'influence_closure'
                ? `<span style="font-size: 0.68rem; color: #38bdf8; margin-left: 0.25rem;" title="Auto-pulled via Pass D Influence Closure">🔗</span>`
                : (ingredient_item.provenance === 'constraint_transplant'
                    ? `<span style="font-size: 0.68rem; color: #34d399; margin-left: 0.25rem;" title="Selected by Constraint Transplant Solver">🎲</span>`
                    : '');

            const encoded_ingredient_text = encodeURIComponent(ingredient_item.text || '');

            return `
                <div class="ingredient-chip" title="Click &times; to remove">
                    <span>${safe_text}${measurement_badge}${ovis_chip_badge}${provenance_badge}</span>
                    <button class="chip-remove-btn" onclick="removeIngredientFromRemixCanvas(decodeURIComponent('${encoded_ingredient_text.replace(/'/g, '%27')}'))">&times;</button>
                </div>
            `;
        }).join('');

        return `
            <div class="slot-lane-row ${is_slot_locked ? 'slot-lane-locked' : ''}">
                <div class="slot-lane-controls">
                    <button type="button" class="slot-lock-btn ${is_slot_locked ? 'is-locked' : ''}" onclick="toggleRemixSlotLock('${escapeHtmlEntities(slot_identifier)}')" title="${is_slot_locked ? 'Locked (click to unlock for Transplant)' : 'Unlocked (click to lock)'}">
                        ${is_slot_locked ? '🔒' : '🔓'}
                    </button>
                    <div class="slot-lane-badge ${slot_metadata.badgeClass}">
                        <span>${slot_metadata.emoji}</span>
                        <span>${slot_metadata.label}</span>
                    </div>
                </div>
                <div class="slot-lane-chips">
                    ${chips_html}
                </div>
            </div>
        `;
    });

    active_slots_container.innerHTML = html_rows_collection.join('');
}

/**
 * WHAT: Calls /api/dicer/remix-preview to test clashes, optionally resolve Influence Closure, format prompt text, and verify round-trip survival.
 * WHY: Keeps physical continuity, implied/orphaned graph effects, and prompt output synchronized in real time.
 */
async function executeRemixPreviewEvaluation(preview_options = {}) {
    const prompt_output_textarea = document.getElementById('remixedPromptOutput');
    const word_count_element = document.getElementById('remixWordCount');
    const clash_alert_panel = document.getElementById('clashAlertPanel');
    const clash_message_element = document.getElementById('clashAlertMessage');

    if (global_active_ingredients_collection.length === 0) {
        if (prompt_output_textarea) prompt_output_textarea.value = '';
        if (word_count_element) word_count_element.textContent = '0 words';
        if (clash_alert_panel) clash_alert_panel.style.display = 'none';
        renderRoundTripBadge(null);
        return;
    }

    const toggle_replacements_checkbox = document.getElementById('toggleObservableReplacements');
    const include_replacements_flag = toggle_replacements_checkbox ? toggle_replacements_checkbox.checked : true;

    try {
        const http_preview_response = await fetch('/api/dicer/remix-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ingredients: global_active_ingredients_collection,
                consequences: global_active_consequences_collection,
                influences: global_all_influences_cache,
                removed_ingredients: preview_options.removed_ingredients || [],
                locked_slots: Array.from(global_locked_slots_set),
                resolve_closure: Boolean(preview_options.resolve_closure),
                run_round_trip: true,
                include_observable_replacements: include_replacements_flag
            })
        });

        if (http_preview_response.ok) {
            const preview_payload = await http_preview_response.json();

            if (preview_options.resolve_closure && Array.isArray(preview_payload.ingredients)) {
                const closure_changed = (
                    preview_payload.closure_trace?.pulled_effects?.length > 0
                    || preview_payload.closure_trace?.pruned_orphans?.length > 0
                );
                if (closure_changed) {
                    global_active_ingredients_collection = preview_payload.ingredients;
                    global_active_consequences_collection = preview_payload.consequences || [];
                    renderClosureTraceBanner(preview_payload.closure_trace, []);
                    renderActiveIngredientsCanvas();
                }
            }

            if (prompt_output_textarea) {
                prompt_output_textarea.value = preview_payload.remixed_prompt;
            }

            if (word_count_element) {
                const total_words = preview_payload.remixed_prompt.trim().split(/\s+/).filter(Boolean).length;
                word_count_element.textContent = `${total_words} words`;
            }

            renderRoundTripBadge(preview_payload.round_trip);

            // Display or hide continuity clash warnings (including multi-hop transitive chains)
            if (preview_payload.has_clashes && preview_payload.clashes.length > 0) {
                const first_clash = preview_payload.clashes[0];
                const transitive_prefix = first_clash.is_transitive && Array.isArray(first_clash.chain_path)
                    ? `[${first_clash.hop_depth}-hop chain: ${first_clash.chain_path.join(' -> ')}] `
                    : '';
                if (clash_message_element) {
                    clash_message_element.textContent = first_clash.remediation_advice ||
                        `${transitive_prefix}Conflict on '${first_clash.state_key}': '${first_clash.applied_value_alpha}' conflicts with '${first_clash.applied_value_beta}'.`;
                }
                if (clash_alert_panel) clash_alert_panel.style.display = 'flex';
            } else {
                if (clash_alert_panel) clash_alert_panel.style.display = 'none';
            }
        }
    } catch (preview_evaluation_error) {
        console.error('[DICER-UI] Remix preview error:', preview_evaluation_error);
    }
}

/**
 * WHAT: Executes Phase 1 K-slot constrained transplant across unlocked canvas slots.
 * WHY: Swaps unlocked slots with clash-free EVoC/graph-compatible candidates and resolves Influence Closure in-place.
 */
async function executeConstraintTransplant() {
    if (global_active_ingredients_collection.length === 0) {
        alert('Load a base prompt or add ingredients before running Transplant.');
        return;
    }

    const transplant_button = document.getElementById('btnTransplantSlots');
    const swap_select = document.getElementById('transplantSwapCountSelect');
    const toggle_replacements_checkbox = document.getElementById('toggleObservableReplacements');
    const swap_count = swap_select ? Number(swap_select.value) || 2 : 2;
    const include_replacements_flag = toggle_replacements_checkbox ? toggle_replacements_checkbox.checked : true;

    const original_label = transplant_button ? transplant_button.innerHTML : '';
    if (transplant_button) {
        transplant_button.disabled = true;
        transplant_button.innerHTML = '⏳ Solving...';
    }

    try {
        pushRemixUndoSnapshot();
        global_transplant_variation_counter += 1;

        const http_response = await fetch('/api/dicer/transplant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_ingredients: global_active_ingredients_collection,
                locked_slots: Array.from(global_locked_slots_set),
                swap_count,
                allow_empty_fills: true,
                variation_seed: global_transplant_variation_counter,
                use_laya_tiebreaker: false,
                include_observable_replacements: include_replacements_flag
            })
        });

        const payload = await http_response.json();
        if (!http_response.ok || !payload.success) {
            throw new Error(payload.error || 'Constraint transplant failed');
        }

        global_active_ingredients_collection = Array.isArray(payload.ingredients) ? payload.ingredients : [];
        global_active_consequences_collection = Array.isArray(payload.consequences) ? payload.consequences : [];

        renderClosureTraceBanner(
            { pulled_effects: payload.pulled_effects, pruned_orphans: payload.pruned_orphans },
            payload.swapped_slots
        );
        renderActiveIngredientsCanvas();

        const prompt_output_textarea = document.getElementById('remixedPromptOutput');
        const word_count_element = document.getElementById('remixWordCount');
        if (prompt_output_textarea) prompt_output_textarea.value = payload.remixed_prompt || '';
        if (word_count_element) {
            const total_words = (payload.remixed_prompt || '').trim().split(/\s+/).filter(Boolean).length;
            word_count_element.textContent = `${total_words} words`;
        }

        renderRoundTripBadge(payload.round_trip);
        filterSlotLibrary();
    } catch (transplant_error) {
        // Revert unused snapshot on failure
        global_remix_undo_stack = global_remix_undo_stack.slice(0, -1);
        updateRemixUndoButtonState();
        alert(`Transplant error: ${transplant_error.message}`);
    } finally {
        if (transplant_button) {
            transplant_button.disabled = false;
            transplant_button.innerHTML = original_label;
        }
    }
}

window.executeConstraintTransplant = executeConstraintTransplant;

/**
 * WHAT: Sends the current prompt output through full llama-server re-dicing (#8 Deep Round-Trip Check).
 * WHY: Verifies semantic preservation even when edited manually or stitched beyond fast keyword heuristics.
 */
async function executeDeepLlmRoundTripCheck() {
    const prompt_output_textarea = document.getElementById('remixedPromptOutput');
    const deep_button = document.getElementById('btnDeepRoundTrip');
    const prompt_text = prompt_output_textarea ? prompt_output_textarea.value.trim() : '';

    if (!prompt_text || global_active_ingredients_collection.length === 0) {
        alert('Build or load a prompt before running a Deep Round-Trip Check.');
        return;
    }

    const original_label = deep_button ? deep_button.innerHTML : '';
    if (deep_button) {
        deep_button.disabled = true;
        deep_button.innerHTML = '⏳ Checking...';
    }

    try {
        const toggle_replacements_checkbox = document.getElementById('toggleObservableReplacements');
        const http_response = await fetch('/api/dicer/round-trip-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ingredients: global_active_ingredients_collection,
                prompt_text,
                include_observable_replacements: toggle_replacements_checkbox ? toggle_replacements_checkbox.checked : true,
                use_llm: true
            })
        });
        const payload = await http_response.json();
        if (!http_response.ok || !payload.success) {
            throw new Error(payload.error || 'Deep round-trip check failed');
        }
        renderRoundTripBadge(payload.round_trip, payload.execution_mode);
    } catch (round_trip_error) {
        alert(`Round-trip error: ${round_trip_error.message}`);
    } finally {
        if (deep_button) {
            deep_button.disabled = false;
            deep_button.innerHTML = original_label;
        }
    }
}

window.executeDeepLlmRoundTripCheck = executeDeepLlmRoundTripCheck;

/**
 * WHAT: Copies the remixed generation prompt to the user's clipboard.
 * WHY: Provides immediate utility to paste directly into ComfyUI or WebUI diffusion pipelines.
 */
function copyRemixedPrompt() {
    const prompt_output_textarea = document.getElementById('remixedPromptOutput');
    if (!prompt_output_textarea || !prompt_output_textarea.value.trim()) {
        alert('No prompt content to copy. Add ingredients first.');
        return;
    }

    navigator.clipboard.writeText(prompt_output_textarea.value.trim()).then(() => {
        alert('✓ Remixed prompt copied to clipboard!');
    }).catch(() => {
        prompt_output_textarea.select();
        document.execCommand('copy');
        alert('✓ Remixed prompt copied to clipboard!');
    });
}

window.copyRemixedPrompt = copyRemixedPrompt;

/**
 * WHAT: Saves the currently assembled remix prompt as a new diced master record in SQLite.
 * WHY: Allows users to persist new remixed creations directly back into the catalog.
 */
async function saveAsNewPrompt() {
    const prompt_output_textarea = document.getElementById('remixedPromptOutput');
    const raw_prompt_text = prompt_output_textarea ? prompt_output_textarea.value.trim() : '';

    if (!raw_prompt_text) {
        alert('Please build a prompt before saving.');
        return;
    }

    try {
        const http_save_response = await fetch('/api/dicer/dice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt_text: raw_prompt_text,
                media_type: 'image',
                run_pass_d: true
            })
        });

        if (http_save_response.ok) {
            const save_payload = await http_save_response.json();
            alert(`✓ Prompt successfully diced and saved as ${save_payload.master_record.prompt_id}!`);
            fetchAndRenderTopLevelStats();
        } else {
            const error_data = await http_save_response.json();
            alert(`Failed to save: ${error_data.error}`);
        }
    } catch (save_error) {
        alert(`Error saving prompt: ${save_error.message}`);
    }
}

window.saveAsNewPrompt = saveAsNewPrompt;

// ============================================================================
// 5. INGREDIENT CATALOG DRAWER (RIGHT PANEL)
// ============================================================================

/**
 * WHAT: Renders the right drawer ingredient list filtered by slot and search query.
 * WHY: Allows rapid discovery and addition of lighting, lenses, weather, and actions.
 */
function renderSlotLibraryDrawer(ingredients_collection) {
    const drawer_container = document.getElementById('availableIngredientsList');
    const slot_dropdown = document.getElementById('slotSelectorDropdown');
    const search_input = document.getElementById('ingredientFilterSearch');

    if (!drawer_container) return;

    const selected_slot = slot_dropdown ? slot_dropdown.value : 'all';
    const search_query = search_input ? search_input.value.toLowerCase().trim() : '';

    const filtered_ingredients = ingredients_collection.filter(ingredient_item => {
        const matches_slot = (selected_slot === 'all')
            || (ingredient_item.slot === selected_slot)
            || (ingredient_item.replacement_slot === selected_slot);
        const matches_search = !search_query
            || ingredient_item.text.toLowerCase().includes(search_query)
            || (ingredient_item.observable_replacement_text || '').toLowerCase().includes(search_query);
        return matches_slot && matches_search;
    });

    if (filtered_ingredients.length === 0) {
        drawer_container.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.85rem;">
                No ingredients found matching filter.
            </div>
        `;
        return;
    }

    global_filtered_drawer_ingredients_cache = filtered_ingredients;

    const html_items = filtered_ingredients.map((ingredient_item, ingredient_index) => {
        const safe_text = escapeHtmlEntities(ingredient_item.text);
        const slot_metadata = CONTROLLED_SLOT_METADATA_TABLE[ingredient_item.slot] || { label: ingredient_item.slot, emoji: '✨' };
        const measurement_text = ingredient_item.measured_number
            ? `${ingredient_item.measured_number}${ingredient_item.measured_unit || ''}`
            : '';
        const usage_badge = ingredient_item.usage_count > 1
            ? `<span style="margin-left: 6px; color: #34d399;">• ${ingredient_item.usage_count}x</span>`
            : '';
        const compatibility_badge = ingredient_item.compatibility_reason === 'ovis_visual_neighbor'
            ? `<span style="margin-left: 6px; color: #f472b6;">• 👁️ Visual Neighbor</span>`
            : (ingredient_item.compatibility_reason === 'evoc_visual_cluster'
                ? `<span style="margin-left: 6px; color: #c4b5fd;">• 🎯 Cluster Match</span>`
                : '');
        const ovis_source_badge = ingredient_item.source === 'ovis_facet'
            ? `<span style="margin-left: 6px; color: #a78bfa;">• 👁️ Facet</span>`
            : '';

        return `
            <div class="catalog-ingredient-item">
                <div>
                    <div style="font-weight: 500; font-size: 0.85rem; color: var(--text-primary);">${safe_text}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 2px;">
                        <span>${slot_metadata.emoji} ${slot_metadata.label}</span>
                        ${measurement_text ? `<span style="margin-left: 6px; color: #38bdf8;">• ${measurement_text}</span>` : ''}
                        ${usage_badge}${compatibility_badge}${ovis_source_badge}
                    </div>
                </div>
                <button class="add-ingredient-btn" onclick="addIngredientFromDrawerByIndex(${ingredient_index})">+ Add</button>
            </div>
        `;
    });

    drawer_container.innerHTML = html_items.join('');
}

/**
 * WHAT: Filters the right-hand slot ingredient drawer using either keyword search or visual cluster ranking.
 * WHY: Allows the creator to switch seamlessly between text-based ingredient lookup and
 *      Ovis-Omni visually compatible neighbor matching relative to the current canvas prompts.
 *
 * @param {Object} [filter_options={}] - Optional flags such as `include_vector_neighbors`.
 */
async function filterSlotLibrary(filter_options = {}) {
    const slot_dropdown = document.getElementById('slotSelectorDropdown');
    const search_input = document.getElementById('ingredientFilterSearch');
    const visual_cluster_checkbox = document.getElementById('toggleVisualClusterMatch');
    const selected_slot = slot_dropdown ? slot_dropdown.value : 'all';
    const search_query = search_input ? search_input.value.trim() : '';

    const active_reference_prompt_ids = Array.from(new Set(
        global_active_ingredients_collection.map(item => item.prompt_id).filter(Boolean)
    ));
    const use_visual_ranking = (
        (visual_cluster_checkbox && visual_cluster_checkbox.checked && active_reference_prompt_ids.length > 0)
        || Boolean(filter_options.include_vector_neighbors && active_reference_prompt_ids.length > 0)
    );

    const deep_button = document.getElementById('btnDeepVisualMatch');
    if (filter_options.include_vector_neighbors && deep_button) {
        deep_button.disabled = true;
        deep_button.innerHTML = '<span>⏳</span> Matching...';
    }

    try {
        if (use_visual_ranking) {
            const http_response = await fetch('/api/dicer/visually-compatible-ingredients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reference_prompt_ids: active_reference_prompt_ids,
                    slot: selected_slot !== 'all' ? selected_slot : null,
                    q: search_query,
                    limit: 200,
                    include_vector_neighbors: Boolean(filter_options.include_vector_neighbors)
                })
            });
            if (http_response.ok) {
                const payload = await http_response.json();
                global_catalog_ingredients_cache = payload.ingredients || [];
            }
        } else {
            const params = new URLSearchParams();
            if (selected_slot && selected_slot !== 'all') params.set('slot', selected_slot);
            if (search_query) params.set('q', search_query);
            params.set('limit', '250');

            const http_response = await fetch(`/api/dicer/ingredients?${params.toString()}`);
            if (http_response.ok) {
                const payload = await http_response.json();
                global_catalog_ingredients_cache = payload.ingredients || [];
            }
        }
    } catch (filter_fetch_error) {
        console.warn('[DICER-UI] Ingredient filter fetch warning:', filter_fetch_error);
    } finally {
        if (filter_options.include_vector_neighbors && deep_button) {
            deep_button.disabled = false;
            deep_button.innerHTML = '<span>👁️</span> + Vector Neighbors';
        }
    }

    renderSlotLibraryDrawer(global_catalog_ingredients_cache);
}

window.filterSlotLibrary = filterSlotLibrary;

let global_filtered_drawer_ingredients_cache = [];

/**
 * WHAT: Handles click events from the Slot Library Drawer by forwarding the chosen ingredient to the canvas.
 * WHY: Keeps drawer DOM click handlers decoupled from canvas state and closure resolution logic.
 *
 * @param {Object} ingredient_item - Ingredient payload.
 */
function addIngredientFromDrawer(ingredient_item) {
    if (ingredient_item) {
        addIngredientToRemixCanvas(ingredient_item);
    }
}

/**
 * WHAT: Adds an ingredient from `global_filtered_drawer_ingredients_cache` by its array index.
 * WHY: Avoids embedding JSON strings into inline `onclick` HTML attributes, preventing quote/entity breakage.
 *
 * @param {number} ingredient_index - Zero-based index inside the currently rendered drawer list.
 */
function addIngredientFromDrawerByIndex(ingredient_index) {
    const selected_ingredient = global_filtered_drawer_ingredients_cache[ingredient_index];
    if (selected_ingredient) {
        addIngredientToRemixCanvas(selected_ingredient);
    }
}

window.addIngredientFromDrawer = addIngredientFromDrawer;
window.addIngredientFromDrawerByIndex = addIngredientFromDrawerByIndex;

// ============================================================================
// 6. PROCESS & BATCH DICE TAB
// ============================================================================

/**
 * WHAT: Executes dicing on a custom prompt pasted by the user.
 * WHY: Allows immediate testing of any custom prompt string, displaying subjects, physical anchors, and ratio.
 */
async function executeCustomPromptDicing() {
    const prompt_textarea = document.getElementById('customPromptInput');
    const media_type_radio = document.querySelector('input[name="customMediaType"]:checked');
    const result_container = document.getElementById('liveDicingResultContainer');
    const submit_button = document.getElementById('btnDiceCustomPrompt');

    const prompt_text = prompt_textarea ? prompt_textarea.value.trim() : '';
    const media_type = media_type_radio ? media_type_radio.value : 'image';

    if (!prompt_text) {
        alert('Please enter a prompt to dice.');
        return;
    }

    if (submit_button) {
        submit_button.disabled = true;
        submit_button.innerHTML = '<span>⏳</span> Dicing...';
    }

    try {
        const http_response = await fetch('/api/dicer/dice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt_text: prompt_text,
                media_type: media_type,
                run_pass_d: true
            })
        });

        const dicing_result = await http_response.json();

        if (http_response.ok && dicing_result.success) {
            renderDicingResultPreview(dicing_result.master_record, dicing_result.influences);
            fetchAndRenderTopLevelStats();
        } else {
            alert(`Dicing failed: ${dicing_result.error || 'Unknown error'}`);
        }
    } catch (dicing_error) {
        alert(`Error executing dicing pipeline: ${dicing_error.message}`);
    } finally {
        if (submit_button) {
            submit_button.disabled = false;
            submit_button.innerHTML = '<span>🧩</span> Dice This Prompt';
        }
    }
}

window.executeCustomPromptDicing = executeCustomPromptDicing;

/**
 * WHAT: Renders the preview card for a freshly diced prompt.
 * WHY: Immediately visualizes Pass A subjects, Pass B ingredients, and the physicality score.
 */
function renderDicingResultPreview(master_record, influences_collection = []) {
    const result_container = document.getElementById('liveDicingResultContainer');
    if (!result_container) return;

    result_container.style.display = 'block';
    result_container.innerHTML = buildDicingResultPreviewHtml(master_record, influences_collection);
}

/**
 * WHAT: Fetches candidate images from images.db that have ComfyUI / A1111 prompts ready to dice.
 * WHY: Allows batch processing of the user's existing image library into the new catalog.
 */
async function fetchAndRenderCandidatePrompts() {
    const candidate_grid = document.getElementById('candidatePromptsGrid');
    const badge_count = document.getElementById('candidateCountBadge');
    if (!candidate_grid) return;

    try {
        const http_response = await fetch('/api/dicer/candidate-prompts?limit=50');
        if (!http_response.ok) throw new Error(`HTTP ${http_response.status}`);
        const payload = await http_response.json();
        const candidate_list = payload.candidates || [];
        global_discovered_candidate_prompts = candidate_list;

        if (badge_count) badge_count.textContent = candidate_list.length;

        if (candidate_list.length === 0) {
            candidate_grid.innerHTML = `
                <div style="text-align: center; padding: 3rem; color: var(--text-secondary); grid-column: 1 / -1;">
                    All library image prompts have already been diced into the catalog!
                </div>
            `;
            return;
        }

        const cards_html = candidate_list.map((candidate_entry, candidate_index) => {
            const safe_filename = escapeHtmlEntities(candidate_entry.filename);
            const safe_prompt = escapeHtmlEntities(candidate_entry.prompt_text);
            const source_label = candidate_entry.source_type.replace(/_/g, ' ').toUpperCase();

            return `
                <div class="candidate-card" id="candidateCard_${candidate_index}">
                    <div class="candidate-meta-header">
                        <span>${safe_filename}</span>
                        <span class="badge-lens" style="font-size: 0.7rem; padding: 0.2rem 0.4rem; border-radius: 4px;">${source_label}</span>
                    </div>
                    <div class="candidate-prompt-snippet">
                        ${safe_prompt}
                    </div>
                    <div style="display: flex; justify-content: flex-end; margin-top: 0.5rem;">
                        <button class="add-ingredient-btn" onclick="diceSingleCandidatePrompt(${candidate_index})">
                            Dice This Entry
                        </button>
                    </div>
                </div>
            `;
        });

        candidate_grid.innerHTML = cards_html.join('');
    } catch (candidate_fetch_error) {
        console.error('[DICER-UI] Error loading candidate prompts:', candidate_fetch_error);
    }
}

/**
 * WHAT: Dices a single candidate prompt selected from the library grid.
 * WHY: Allows selective dicing of specific images.
 */
async function diceSingleCandidatePrompt(candidate_index) {
    const candidate_entry = global_discovered_candidate_prompts[candidate_index];
    if (!candidate_entry) return;

    const card_element = document.getElementById(`candidateCard_${candidate_index}`);
    if (card_element) {
        card_element.style.opacity = '0.5';
    }

    try {
        const http_response = await fetch('/api/dicer/dice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt_text: candidate_entry.prompt_text,
                media_type: 'image',
                image_id: candidate_entry.image_id,
                run_pass_d: true
            })
        });

        if (http_response.ok) {
            const result = await http_response.json();
            if (card_element) {
                card_element.innerHTML = `
                    <div style="padding: 1rem; text-align: center; color: #34d399; font-size: 0.85rem;">
                        ✓ Diced as ${result.master_record.prompt_id} (${result.master_record.ingredients.length} ingredients)
                    </div>
                `;
            }
            fetchAndRenderTopLevelStats();
        }
    } catch (error) {
        alert(`Failed to dice candidate: ${error.message}`);
        if (card_element) card_element.style.opacity = '1';
    }
}

window.diceSingleCandidatePrompt = diceSingleCandidatePrompt;

/**
 * WHAT: Iterates through all candidate prompts and dices them sequentially with progress bar feedback.
 * WHY: Provides one-click bulk processing for the user's entire image library.
 */
async function batchDiceAllCandidates() {
    if (global_discovered_candidate_prompts.length === 0) {
        alert('No candidate prompts remaining to process.');
        return;
    }

    const confirmed = confirm(`Batch dice ${global_discovered_candidate_prompts.length} candidate prompts into the ingredient catalog?`);
    if (!confirmed) return;

    const progress_container = document.getElementById('batchProgressBarContainer');
    const progress_bar = document.getElementById('batchProgressBarFill');
    const progress_text = document.getElementById('batchProgressText');
    const progress_percent = document.getElementById('batchProgressPercent');
    const batch_button = document.getElementById('btnBatchDiceAll');

    if (progress_container) progress_container.style.display = 'block';
    if (batch_button) batch_button.disabled = true;

    let processed_counter = 0;
    const total_to_process = global_discovered_candidate_prompts.length;

    for (let index = 0; index < total_to_process; index++) {
        const candidate_entry = global_discovered_candidate_prompts[index];

        if (progress_text) {
            progress_text.textContent = `Processing ${index + 1} of ${total_to_process}: ${candidate_entry.filename}...`;
        }

        try {
            await fetch('/api/dicer/dice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt_text: candidate_entry.prompt_text,
                    media_type: 'image',
                    image_id: candidate_entry.image_id,
                    run_pass_d: true
                })
            });
            processed_counter++;
        } catch (single_dice_error) {
            console.warn(`[DICER-BATCH] Failed on item ${index}:`, single_dice_error.message);
        }

        const percentage = Math.round(((index + 1) / total_to_process) * 100);
        if (progress_bar) progress_bar.style.width = `${percentage}%`;
        if (progress_percent) progress_percent.textContent = `${percentage}%`;
    }

    alert(`✓ Batch processing complete! Successfully diced ${processed_counter} prompts.`);
    if (progress_container) progress_container.style.display = 'none';
    if (batch_button) batch_button.disabled = false;

    fetchAndRenderTopLevelStats();
    fetchAndRenderCandidatePrompts();
}

window.batchDiceAllCandidates = batchDiceAllCandidates;

// ============================================================================
// 7. CATALOG & MASTER INSPECTOR TAB
// ============================================================================

/**
 * WHAT: Fetches and displays all analyzed prompts in the Catalog tab.
 * WHY: Displays the concreteness leaderboard and opens detailed master records.
 */
async function fetchAndRenderCatalogPrompts() {
    const table_container = document.getElementById('dicedPromptsTableContainer');
    if (!table_container) return;

    try {
        const http_response = await fetch('/api/dicer/prompts?limit=50');
        if (!http_response.ok) throw new Error(`HTTP ${http_response.status}`);
        const payload = await http_response.json();
        const prompts_list = payload.prompts || [];

        if (prompts_list.length === 0) {
            table_container.innerHTML = `
                <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                    No diced prompts found yet. Use the "Process & Batch Dice" tab to dice your library prompts!
                </div>
            `;
            return;
        }

        const table_rows_html = prompts_list.map(prompt_item => {
            const ratio_percent = Math.round((Number(prompt_item.physicality_ratio) || 0) * 100);
            const safe_prompt_text = escapeHtmlEntities(prompt_item.raw_prompt);
            const snippet = safe_prompt_text.length > 80
                ? safe_prompt_text.slice(0, 80) + '...'
                : safe_prompt_text;

            return `
                <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                    <td style="padding: 0.75rem 1rem; font-weight: 600; color: #38bdf8;">${prompt_item.prompt_id}</td>
                    <td style="padding: 0.75rem 1rem;">
                        <span class="badge-weather_or_matter" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px;">
                            ${prompt_item.media_type.toUpperCase()}
                        </span>
                    </td>
                    <td style="padding: 0.75rem 1rem; color: var(--text-primary); font-size: 0.85rem;" title="${safe_prompt_text}">
                        ${snippet}
                    </td>
                    <td style="padding: 0.75rem 1rem; text-align: center;">
                        <span style="font-weight: 700; color: ${ratio_percent >= 60 ? '#34d399' : '#de7e68'};">
                            ${ratio_percent}%
                        </span>
                    </td>
                    <td style="padding: 0.75rem 1rem; text-align: center; color: var(--text-secondary); font-size: 0.85rem;">
                        ${prompt_item.physical_anchor_count} physical / ${prompt_item.pretext_term_count} vibe
                    </td>
                    <td style="padding: 0.75rem 1rem; text-align: right; white-space: nowrap;">
                        <button class="add-ingredient-btn" style="background: rgba(167, 139, 250, 0.16); color: #c4b5fd; border-color: rgba(167, 139, 250, 0.35); margin-right: 0.35rem;" onclick="loadPromptIntoRemixWorkbench(decodeURIComponent('${encodeURIComponent(String(prompt_item.prompt_id || '')).replace(/'/g, '%27')}'), true)">
                            + Remix
                        </button>
                        <button class="add-ingredient-btn" onclick="inspectPromptMasterRecord(decodeURIComponent('${encodeURIComponent(String(prompt_item.prompt_id || '')).replace(/'/g, '%27')}'))">
                            Inspect
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        table_container.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--border); color: var(--text-secondary); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">
                        <th style="padding: 0.75rem 1rem;">ID</th>
                        <th style="padding: 0.75rem 1rem;">Type</th>
                        <th style="padding: 0.75rem 1rem;">Raw Prompt Text</th>
                        <th style="padding: 0.75rem 1rem; text-align: center;">Concreteness</th>
                        <th style="padding: 0.75rem 1rem; text-align: center;">Ingredients</th>
                        <th style="padding: 0.75rem 1rem; text-align: right;">Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${table_rows_html}
                </tbody>
            </table>
        `;
    } catch (catalog_error) {
        console.error('[DICER-UI] Error fetching catalog table:', catalog_error);
    }
}

/**
 * WHAT: Opens the Master Inspector modal for a specific prompt ID.
 * WHY: Allows detailed behavioral inspection of Pass A theta roles, Pass B replacements, and Pass D influences.
 */
async function inspectPromptMasterRecord(prompt_identifier) {
    const modal_overlay = document.getElementById('promptInspectorModal');
    const modal_body = document.getElementById('inspectorModalBody');
    const modal_title = document.getElementById('inspectorModalTitle');

    if (!modal_overlay || !modal_body) return;

    modal_overlay.style.display = 'flex';
    modal_body.innerHTML = '<div style="text-align: center; padding: 2rem;">Loading master record...</div>';

    try {
        const http_response = await fetch(`/api/dicer/prompts/${encodeURIComponent(prompt_identifier)}`);
        if (!http_response.ok) throw new Error('Prompt not found');

        const master_record = await http_response.json();
        if (modal_title) modal_title.textContent = `Master Record: ${master_record.prompt_id} (${master_record.media_type.toUpperCase()})`;

        const subjects_html = master_record.subjects.map(subject => `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 0.5rem; color: #38bdf8; font-weight: 600;">${escapeHtmlEntities(subject.subject_id)}</td>
                <td style="padding: 0.5rem;">${escapeHtmlEntities(subject.role_label)}</td>
                <td style="padding: 0.5rem;"><span class="badge-lighting" style="font-size: 0.75rem; padding: 0.2rem 0.4rem; border-radius: 4px;">${escapeHtmlEntities(subject.theta_role)}</span></td>
                <td style="padding: 0.5rem;">${escapeHtmlEntities(subject.verb_action || '—')}</td>
                <td style="padding: 0.5rem;">${escapeHtmlEntities(subject.instrument || '—')}</td>
                <td style="padding: 0.5rem;">${escapeHtmlEntities(subject.speech_state || '—')}</td>
            </tr>
        `).join('');

        const ingredients_html = master_record.ingredients.map(ing => {
            const slot_meta = CONTROLLED_SLOT_METADATA_TABLE[ing.slot] || { badgeClass: 'badge-other', label: ing.slot };
            const replacement_info = ing.observable_replacement
                ? `<div style="font-size: 0.75rem; color: #34d399; margin-top: 2px;">↳ Observable: "${escapeHtmlEntities(ing.observable_replacement.text)}" [${escapeHtmlEntities(ing.observable_replacement.replacement_slot)}]</div>`
                : '';

            return `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 0.5rem; font-weight: 600; color: var(--text-secondary);">${escapeHtmlEntities(ing.ingredient_id)}</td>
                    <td style="padding: 0.5rem;">
                        <span class="slot-lane-badge ${slot_meta.badgeClass}" style="font-size: 0.7rem;">${slot_meta.label}</span>
                    </td>
                    <td style="padding: 0.5rem;">
                        <strong>${escapeHtmlEntities(ing.text)}</strong>
                        ${replacement_info}
                    </td>
                    <td style="padding: 0.5rem; color: var(--text-secondary);">${ing.bound_to_subject_id || 'Whole Frame'}</td>
                </tr>
            `;
        }).join('');

        const influences_html = (master_record.influences || []).map(inf => `
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem;">
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 0.25rem;">
                    <span style="color: #38bdf8; font-weight: 600;">${inf.source_ingredient_id} ➔ ${inf.target_ingredient_id}</span>
                    <span style="color: #de7e68;">[${inf.interaction_type}]</span>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-primary); margin-bottom: 0.25rem;">
                    Consequence: "<em>${escapeHtmlEntities(inf.consequence_description)}</em>"
                </div>
                <div style="font-size: 0.75rem; color: var(--text-secondary);">
                    State Key: <code>${inf.state_key}</code> | Imposes: <code>${inf.applied_state_value}</code> | Clashes with: <code>${inf.clashes_with_value}</code>
                </div>
            </div>
        `).join('');

        modal_body.innerHTML = `
            <div style="margin-bottom: 1rem;">
                <h5 style="color: var(--text-secondary); margin-bottom: 0.25rem;">Raw Source Prompt</h5>
                <div style="background: rgba(11, 11, 26, 0.8); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; font-size: 0.85rem;">
                    ${escapeHtmlEntities(master_record.raw_prompt)}
                </div>
            </div>

            <div style="margin-bottom: 1.5rem;">
                <h5 style="color: var(--text-secondary); margin-bottom: 0.5rem;">Pass A: Subject Binding Grid</h5>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
                    <thead>
                        <tr style="color: var(--text-secondary); border-bottom: 1px solid var(--border); font-size: 0.75rem;">
                            <th style="padding: 0.5rem;">ID</th>
                            <th style="padding: 0.5rem;">Role Label</th>
                            <th style="padding: 0.5rem;">Theta Role</th>
                            <th style="padding: 0.5rem;">Verb</th>
                            <th style="padding: 0.5rem;">Instrument</th>
                            <th style="padding: 0.5rem;">Speech</th>
                        </tr>
                    </thead>
                    <tbody>${subjects_html || '<tr><td colspan="6" style="padding: 0.5rem; text-align: center; color: var(--text-secondary);">No individual subjects bound</td></tr>'}</tbody>
                </table>
            </div>

            <div style="margin-bottom: 1.5rem;">
                <h5 style="color: var(--text-secondary); margin-bottom: 0.5rem;">Pass B & C: Atomic Ingredients (${master_record.ingredients.length})</h5>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
                    <thead>
                        <tr style="color: var(--text-secondary); border-bottom: 1px solid var(--border); font-size: 0.75rem;">
                            <th style="padding: 0.5rem;">ID</th>
                            <th style="padding: 0.5rem;">Slot</th>
                            <th style="padding: 0.5rem;">Ingredient Text</th>
                            <th style="padding: 0.5rem;">Bound Subject</th>
                        </tr>
                    </thead>
                    <tbody>${ingredients_html}</tbody>
                </table>
            </div>

            <div>
                <h5 style="color: var(--text-secondary); margin-bottom: 0.5rem;">Pass D: Directed Influence Edges & State Clashes</h5>
                ${influences_html || '<div style="color: var(--text-secondary); font-size: 0.85rem;">No active influence chains detected.</div>'}
            </div>
        `;
    } catch (inspector_error) {
        modal_body.innerHTML = `<div style="color: #ef4444; padding: 2rem;">Error: ${escapeHtmlEntities(inspector_error.message)}</div>`;
    }
}

window.inspectPromptMasterRecord = inspectPromptMasterRecord;

/**
 * WHAT: Loads all ingredients and influences from a specific prompt ID directly into the Remix Workbench canvas.
 * WHY: Allows users clicking "Open in Remix" on any image card in `database.html` (or in the Catalog tab)
 *      to immediately start swapping ingredients and testing clashes.
 * 
 * @param {string} prompt_identifier - Target prompt ID (e.g., "prm_01155").
 */
async function loadPromptIntoRemixWorkbench(prompt_identifier, append_mode = false) {
    try {
        const http_response = await fetch(`/api/dicer/prompts/${encodeURIComponent(prompt_identifier)}`);
        if (!http_response.ok) return;
        const master_record = await http_response.json();
        if (Array.isArray(master_record.ingredients)) {
            const incoming_ingredients = master_record.ingredients.map(ing => ({
                ...ing,
                prompt_id: master_record.prompt_id,
                observable_replacement_text: ing.observable_replacement?.text || null,
                replacement_slot: ing.observable_replacement?.replacement_slot || null
            }));

            if (append_mode) {
                if (global_active_ingredients_collection.length > 0) {
                    pushRemixUndoSnapshot();
                }
                for (const single_ingredient of incoming_ingredients) {
                    const is_duplicate = global_active_ingredients_collection.some(
                        existing => existing.text.toLowerCase() === single_ingredient.text.toLowerCase()
                    );
                    if (!is_duplicate) {
                        global_active_ingredients_collection = [
                            ...global_active_ingredients_collection,
                            single_ingredient
                        ];
                    }
                }
                const incoming_influences = Array.isArray(master_record.influences) ? master_record.influences : [];
                global_all_influences_cache = [
                    ...global_all_influences_cache,
                    ...incoming_influences
                ];
            } else {
                if (global_active_ingredients_collection.length > 0) {
                    pushRemixUndoSnapshot();
                }
                global_active_ingredients_collection = incoming_ingredients;
                global_active_consequences_collection = [];
                global_locked_slots_set = new Set(DEFAULT_TRANSPLANT_LOCKED_SLOTS);
                global_transplant_variation_counter = 0;
                global_all_influences_cache = Array.isArray(master_record.influences)
                    ? [...master_record.influences]
                    : [];
                renderClosureTraceBanner(null, []);
            }

            switchDicerTab('remix');
            renderActiveIngredientsCanvas();
            await executeRemixPreviewEvaluation({ resolve_closure: false });
            await filterSlotLibrary();
        }
    } catch (load_remix_error) {
        console.error('[DICER-UI] Error loading prompt into Remix Workbench:', load_remix_error);
    }
}

window.loadPromptIntoRemixWorkbench = loadPromptIntoRemixWorkbench;

/**
 * WHAT: Hides the JSON Prompt Master Record inspector modal overlay.
 * WHY: Provides a single clean exit path for both the close button and backdrop click handlers.
 */
function closeInspectorModal() {
    const modal_overlay = document.getElementById('promptInspectorModal');
    if (modal_overlay) modal_overlay.style.display = 'none';
}

window.closeInspectorModal = closeInspectorModal;

// ============================================================================
// 10. INITIALIZATION ENTRY POINT
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderTopLevelStats();
    renderActiveIngredientsCanvas();
    document.addEventListener('keydown', handleReviewKeyboardShortcut);

    const prompt_search_input = document.getElementById('remixPromptSearchInput');
    if (prompt_search_input) {
        prompt_search_input.addEventListener('keydown', (key_event) => {
            if (key_event.key === 'Enter') {
                key_event.preventDefault();
                searchSourcePromptsForRemix();
            }
        });
    }

    const url_search_params = new URLSearchParams(window.location.search);
    const requested_prompt_identifier = url_search_params.get('prompt_id');
    const requested_mode = url_search_params.get('mode');
    if (requested_prompt_identifier) {
        loadPromptIntoRemixWorkbench(requested_prompt_identifier);
        if (requested_mode === 'inspect') {
            inspectPromptMasterRecord(requested_prompt_identifier);
        }
    }
});

// WHAT: Exposes inline HTML event handlers on `window` for ES module compatibility.
// WHY: `dicer.html` and dynamic card templates invoke these handlers via `onclick`/`onchange`/`oninput` attributes.
Object.assign(window, {
    switchDicerTab,
    auditVisualGroundingWithOvis,
    validateAndSyncAllDicedPrompts,
    searchSourcePromptsForRemix,
    executeConstraintTransplant,
    undoLastRemixMutation,
    clearRemixCanvas,
    executeRemixPreviewEvaluation,
    executeDeepLlmRoundTripCheck,
    copyRemixedPrompt,
    saveAsNewPrompt,
    filterSlotLibrary,
    executeCustomPromptDicing,
    batchDiceAllCandidates,
    loadReviewQueue,
    fetchAndRenderCalibrationDashboard,
    closeInspectorModal,
    loadPromptIntoRemixWorkbench,
    removeIngredientFromRemixCanvas,
    toggleRemixSlotLock,
    addIngredientFromDrawerByIndex,
    diceSingleCandidatePrompt,
    inspectPromptMasterRecord,
    submitReviewEvent,
    submitSlotCorrectionEvent,
    submitMissingEdgeEvent
});

