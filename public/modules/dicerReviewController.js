/**
 * Prompt Dicer Rapid Review Queue & Calibration Dashboard Controller
 *
 * Isolated UI controller module extracted from public/dicer.js.
 */

import { escapeHtmlCharacters as escapeHtmlEntities } from "./cardCore.js";
import {
    CONTROLLED_SLOT_METADATA_TABLE,
    buildSittingProgressHtml,
    buildHighlightedPromptTokensHtml,
    buildGroundingHistogramSvg,
    buildLayaCalibrationSvg
} from "./dicerRenderers.js";

// WHAT: Creates the imperative controller for the Rapid Review Queue and Calibration Dashboard tabs.
// WHY: Isolates review queue state, hotkey handling, and SVG dashboard fetching from remix workbench code.
export function createDicerReviewController() {
    let global_review_queue_cards = [];
    let global_review_queue_cursor = 0;
    let global_review_seed_counter = 1;

    // ============================================================================
    // 9. REVIEW QUEUE & CALIBRATION DASHBOARD
    // ============================================================================

    /**
     * WHAT: Fetches the stratified (or uncertainty-ordered) single-question review queue from the server.
     * WHY: Keeps human labeling fast and structured across all 5 card types while feeding the calibration dashboard.
     */
    async function loadReviewQueue(increment_seed = false) {
        const container_element = document.getElementById('reviewQueueCardContainer');
        if (increment_seed) {
            global_review_seed_counter += 1;
        }

        const card_type_filter = document.getElementById('reviewCardTypeFilter')?.value || 'all';
        const ordering_mode = document.getElementById('reviewOrderingSelect')?.value || 'stratified';
        const enrich_grounding = Boolean(document.getElementById('toggleEnrichOvisQueue')?.checked);

        if (container_element) {
            container_element.innerHTML = '<div style="text-align: center; padding: 2.5rem; color: var(--text-secondary);">Building stratified review queue...</div>';
        }

        try {
            const query_string = new URLSearchParams({
                card_type: card_type_filter,
                ordering: ordering_mode,
                limit: '40',
                seed: String(global_review_seed_counter),
                enrich_grounding: String(enrich_grounding)
            }).toString();

            const http_response = await fetch(`/api/dicer/review-queue?${query_string}`);
            const payload = await http_response.json();
            if (!http_response.ok || !payload.success) {
                throw new Error(payload.error || 'Failed to load review queue.');
            }

            global_review_queue_cards = Array.isArray(payload.cards) ? payload.cards : [];
            global_review_queue_cursor = 0;

            renderSittingProgressBars(payload.sitting_progress);
            renderActiveReviewCard();
            fetchAndRenderCalibrationDashboard();
        } catch (queue_error) {
            if (container_element) {
                container_element.innerHTML = `<div style="padding: 1.5rem; color: #f87171;">Review Queue Error: ${escapeHtmlEntities(queue_error.message)}</div>`;
            }
        }
    }

    /**
     * WHAT: Renders pure HTML progress pills tracking first-sitting labeling targets.
     * WHY: Lets the curator see progress toward 200 grounding pairs, 300 edges, 300 slots, and 50 missing-edge probes.
     */
    /**
     * WHAT: Injects the generated sitting progress bars markup into the Review Queue header grid.
     * WHY: Isolates the DOM mutation step from the pure `buildSittingProgressHtml` formatter.
     *
     * @param {Object} sitting_progress - Counts and targets for each review card stratum.
     */
    function renderSittingProgressBars(sitting_progress) {
        const progress_grid = document.getElementById('reviewSittingProgressGrid');
        if (progress_grid) {
            progress_grid.innerHTML = buildSittingProgressHtml(sitting_progress);
        }
    }

    /**
     * WHAT: Renders the currently queued single-question card with keyboard shortcut chips.
     * WHY: Enables rapid sub-2-second review actions across caption grounding, ingredient grounding, edge verification, slot checks, and missing-edge probes.
     */
    function renderActiveReviewCard() {
        const container_element = document.getElementById('reviewQueueCardContainer');
        if (!container_element) return;

        if (!Array.isArray(global_review_queue_cards) || global_review_queue_cards.length === 0) {
            container_element.innerHTML = '<div style="text-align: center; padding: 2.5rem; color: var(--text-secondary);">No unreviewed cards matched this filter. Try switching Card Type or reloading the queue.</div>';
            return;
        }

        if (global_review_queue_cursor >= global_review_queue_cards.length) {
            container_element.innerHTML = `
                <div style="text-align: center; padding: 2.5rem;">
                    <div style="font-size: 1.1rem; color: #38bdf8; margin-bottom: 0.75rem;">Batch Complete (${global_review_queue_cards.length} cards reviewed)</div>
                    <button class="dicer-primary-btn" onclick="loadReviewQueue(true)">🔄 Load Next Stratified Batch</button>
                </div>
            `;
            return;
        }

        const active_card = global_review_queue_cards[global_review_queue_cursor];
        const remaining_count = global_review_queue_cards.length - global_review_queue_cursor;
        const confidence_display = Number.isFinite(Number(active_card.model_confidence))
            ? Number(active_card.model_confidence).toFixed(3)
            : 'N/A';

        const image_stage_html = active_card.image_id
            ? `<img src="thumbnails/id_${encodeURIComponent(active_card.image_id)}.avif" alt="Review Thumbnail #${escapeHtmlEntities(active_card.image_id)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
               <div style="display: none; flex-direction: column; align-items: center; color: var(--text-secondary); padding: 2rem; text-align: center;">
                   <span>Image #${escapeHtmlEntities(active_card.image_id)} thumbnail missing</span>
                   <span style="font-size: 0.78rem; margin-top: 0.25rem;">${escapeHtmlEntities(active_card.image_filename || '')}</span>
               </div>`
            : '<div style="color: var(--text-secondary); padding: 2rem; text-align: center;">Text-only prompt record (no linked image_id)</div>';

        let action_controls_html = '';
        if (active_card.card_type === 'grounding_caption') {
            action_controls_html = `
                <div class="review-action-buttons">
                    <button class="dicer-primary-btn" style="background: #16a34a;" onclick="submitReviewEvent('grounded')"><span class="hotkey-chip">1</span> Grounded</button>
                    <button class="dicer-secondary-btn" onclick="submitReviewEvent('borderline')"><span class="hotkey-chip">2</span> Borderline</button>
                    <button class="dicer-primary-btn" style="background: #dc2626;" onclick="submitReviewEvent('mismatched')"><span class="hotkey-chip">3</span> Mismatched</button>
                    <button class="dicer-secondary-btn" onclick="submitReviewEvent('skipped')"><span class="hotkey-chip">S</span> Skip</button>
                </div>
            `;
        } else if (active_card.card_type === 'grounding_ingredient') {
            action_controls_html = `
                <div class="review-action-buttons">
                    <button class="dicer-primary-btn" style="background: #16a34a;" onclick="submitReviewEvent('present')"><span class="hotkey-chip">Y / 1</span> Visible / Present</button>
                    <button class="dicer-primary-btn" style="background: #dc2626;" onclick="submitReviewEvent('absent')"><span class="hotkey-chip">N / 2</span> Absent / Not Visible</button>
                    <button class="dicer-secondary-btn" onclick="submitReviewEvent('skipped')"><span class="hotkey-chip">S</span> Skip</button>
                </div>
            `;
        } else if (active_card.card_type === 'edge_check') {
            action_controls_html = `
                <div class="review-action-buttons">
                    <button class="dicer-primary-btn" style="background: #16a34a;" onclick="submitReviewEvent('confirmed')"><span class="hotkey-chip">Y / 1</span> Real Influence</button>
                    <button class="dicer-primary-btn" style="background: #dc2626;" onclick="submitReviewEvent('rejected')"><span class="hotkey-chip">N / 2</span> False / Reject</button>
                    <button class="dicer-secondary-btn" onclick="submitReviewEvent('skipped')"><span class="hotkey-chip">S</span> Skip</button>
                </div>
            `;
        } else if (active_card.card_type === 'slot_check') {
            const slot_options_html = Object.entries(CONTROLLED_SLOT_METADATA_TABLE).map(([slot_key, slot_meta]) => {
                const selected_attr = slot_key === active_card.slot ? 'selected' : '';
                return `<option value="${escapeHtmlEntities(slot_key)}" ${selected_attr}>${escapeHtmlEntities(slot_meta.emoji)} ${escapeHtmlEntities(slot_meta.label)} (${escapeHtmlEntities(slot_key)})</option>`;
            }).join('');
            action_controls_html = `
                <div class="review-action-buttons">
                    <button class="dicer-primary-btn" style="background: #16a34a;" onclick="submitReviewEvent('correct')"><span class="hotkey-chip">Y / 1</span> Slot Correct</button>
                    <select id="reviewCorrectedSlotSelect" class="transplant-count-select">${slot_options_html}</select>
                    <button class="dicer-primary-btn" style="background: #d97706;" onclick="submitSlotCorrectionEvent()"><span class="hotkey-chip">N / 2</span> Apply Corrected Slot</button>
                    <button class="dicer-secondary-btn" onclick="submitReviewEvent('skipped')"><span class="hotkey-chip">S</span> Skip</button>
                </div>
            `;
        } else if (active_card.card_type === 'missing_edge') {
            const ingredients_options = (active_card.ingredients || []).map(ing =>
                `<option value="${escapeHtmlEntities(ing.ingredient_id)}">${escapeHtmlEntities(ing.text)} [${escapeHtmlEntities(ing.slot)}]</option>`
            ).join('');
            action_controls_html = `
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.5rem; margin-bottom: 0.75rem;">
                    <select id="reviewMissingEdgeSource" class="transplant-count-select">${ingredients_options}</select>
                    <select id="reviewMissingEdgeTarget" class="transplant-count-select">${ingredients_options}</select>
                    <input id="reviewMissingEdgeStateKey" type="text" class="transplant-count-select" placeholder="state_key (e.g. surface_wetness)" value="physical_state" />
                    <input id="reviewMissingEdgeStateValue" type="text" class="transplant-count-select" placeholder="applied value (e.g. wet)" value="linked" />
                </div>
                <div class="review-action-buttons">
                    <button class="dicer-primary-btn" style="background: #2563eb;" onclick="submitMissingEdgeEvent()"><span class="hotkey-chip">Y</span> Add Missing Edge</button>
                    <button class="dicer-primary-btn" style="background: #16a34a;" onclick="submitReviewEvent('no_missing_edge')"><span class="hotkey-chip">N / 1</span> No Missing Edges</button>
                    <button class="dicer-secondary-btn" onclick="submitReviewEvent('skipped')"><span class="hotkey-chip">S</span> Skip</button>
                </div>
            `;
        }

        container_element.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem; flex-wrap: wrap; gap: 0.5rem;">
                <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                    <span class="dicer-badge" style="background: rgba(56, 189, 248, 0.16); color: #38bdf8;">${escapeHtmlEntities(active_card.card_type)}</span>
                    <span class="dicer-badge">${escapeHtmlEntities(active_card.source || 'prompt_extraction')}</span>
                    <span class="dicer-badge">split: ${escapeHtmlEntities(active_card.dataset_split || 'train')}</span>
                    <span class="dicer-badge">score/conf: ${escapeHtmlEntities(confidence_display)}</span>
                </div>
                <span style="font-size: 0.82rem; color: var(--text-secondary);">Card ${global_review_queue_cursor + 1} of ${global_review_queue_cards.length} (${remaining_count} remaining)</span>
            </div>
            <div class="review-card-split">
                <div class="review-image-stage">${image_stage_html}</div>
                <div style="display: flex; flex-direction: column; gap: 0.85rem;">
                    ${buildHighlightedPromptTokensHtml(active_card)}
                    <div class="review-question-bar">
                        <div style="font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.75rem;">
                            ${escapeHtmlEntities(active_card.question_text)}
                        </div>
                        ${action_controls_html}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * WHAT: Sends the corrected slot choice for a `slot_check` card to `POST /api/dicer/review-events`.
     * WHY: Updates both the append-only `review_events` ledger and the normalized `diced_ingredients.slot` column.
     */
    function submitSlotCorrectionEvent() {
        const active_card = global_review_queue_cards[global_review_queue_cursor];
        const selected_slot = document.getElementById('reviewCorrectedSlotSelect')?.value;
        if (!active_card || !selected_slot) return;
        if (selected_slot === active_card.slot) {
            submitReviewEvent('correct');
            return;
        }
        submitReviewEvent('corrected_slot', { new_slot: selected_slot });
    }

    /**
     * WHAT: Captures a missing physical influence edge directly from a `missing_edge` recall probe card.
     * WHY: Feeds Pass D recall metrics and inserts verified human edges into `diced_influences`.
     */
    function submitMissingEdgeEvent() {
        const source_ingredient_id = document.getElementById('reviewMissingEdgeSource')?.value;
        const target_ingredient_id = document.getElementById('reviewMissingEdgeTarget')?.value;
        const state_key = document.getElementById('reviewMissingEdgeStateKey')?.value?.trim() || 'physical_state';
        const applied_state_value = document.getElementById('reviewMissingEdgeStateValue')?.value?.trim() || 'linked';
        if (!source_ingredient_id || !target_ingredient_id || source_ingredient_id === target_ingredient_id) {
            alert('Please choose two distinct source and target ingredients.');
            return;
        }
        submitReviewEvent('added_edge', {
            source_ingredient_id,
            target_ingredient_id,
            state_key,
            applied_state_value
        });
    }

    /**
     * WHAT: Appends an immutable review decision row and immediately advances to the next queued card.
     * WHY: Keeps review latency low while recording model confidence/version snapshots at review time.
     */
    async function submitReviewEvent(label_value, corrected_value = null) {
        const active_card = global_review_queue_cards[global_review_queue_cursor];
        if (!active_card) return;

        try {
            const http_response = await fetch('/api/dicer/review-events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    card_type: active_card.card_type,
                    item_type: active_card.item_type,
                    item_id: active_card.item_id,
                    prompt_id: active_card.prompt_id,
                    image_id: active_card.image_id,
                    label: label_value,
                    corrected_value,
                    model_confidence: active_card.model_confidence,
                    model_version: active_card.model_version,
                    is_repeat_check: Boolean(active_card.is_repeat_check)
                })
            });
            const payload = await http_response.json();
            if (!http_response.ok || !payload.success) {
                throw new Error(payload.error || 'Failed to record review event.');
            }

            global_review_queue_cursor += 1;
            if (payload.sitting_progress) {
                renderSittingProgressBars(payload.sitting_progress);
            }
            renderActiveReviewCard();
            fetchAndRenderCalibrationDashboard();
        } catch (submit_error) {
            alert(`Could not save review label: ${submit_error.message}`);
        }
    }

    /**
     * WHAT: Builds a pure inline SVG stacked bar histogram for Ovis grounding scores across human labels.
     * WHY: Shows at a glance where grounded vs. borderline vs. mismatched distributions cross the configured cutoffs.
     */
    /**
     * WHAT: Fetches calibration metrics and renders grounding histograms, Laya calibration, edge recall, and repeat consistency.
     * WHY: Keeps threshold tuning and Pass D / Laya readiness visible directly inside the Review tab.
     */
    async function fetchAndRenderCalibrationDashboard() {
        const charts_container = document.getElementById('calibrationChartsContent');
        if (!charts_container) return;

        try {
            const http_response = await fetch('/api/dicer/calibration-dashboard');
            const analytics = await http_response.json();
            if (!http_response.ok || !analytics.success) {
                throw new Error(analytics.error || 'Failed to load calibration dashboard.');
            }

            renderSittingProgressBars(analytics.sitting_progress);

            const caption_svg = buildGroundingHistogramSvg(
                `Caption Grounding Scores (Cutoffs: ≥${analytics.grounding_caption_histogram?.cutoffs?.grounded_min ?? 0.28} / ≥${analytics.grounding_caption_histogram?.cutoffs?.borderline_min ?? 0.18})`,
                analytics.grounding_caption_histogram,
                [
                    { key: 'grounded', label: 'Grounded', color: '#22c55e' },
                    { key: 'borderline', label: 'Borderline', color: '#eab308' },
                    { key: 'mismatched', label: 'Mismatched', color: '#ef4444' }
                ]
            );
            const ingredient_svg = buildGroundingHistogramSvg(
                `Per-Ingredient Scores (Cutoffs: ≥${analytics.grounding_ingredient_histogram?.cutoffs?.grounded_min ?? 0.24} / ≥${analytics.grounding_ingredient_histogram?.cutoffs?.borderline_min ?? 0.16})`,
                analytics.grounding_ingredient_histogram,
                [
                    { key: 'present', label: 'Present', color: '#22c55e' },
                    { key: 'absent', label: 'Absent', color: '#ef4444' }
                ]
            );
            const laya_svg = buildLayaCalibrationSvg(analytics.laya_calibration_bands);

            const recall_pct = analytics.edge_recall_estimate?.estimated_recall !== null && analytics.edge_recall_estimate?.estimated_recall !== undefined
                ? `${(analytics.edge_recall_estimate.estimated_recall * 100).toFixed(1)}%`
                : 'Pending probes';
            const repeat_pct = analytics.repeat_consistency?.agreement_rate !== null && analytics.repeat_consistency?.agreement_rate !== undefined
                ? `${(analytics.repeat_consistency.agreement_rate * 100).toFixed(1)}%`
                : 'Pending repeats';

            const summary_panel = `
                <div class="calibration-panel-box">
                    <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.65rem;">Graph Recall, Split Integrity & Intra-Rater Consistency</div>
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.65rem; font-size: 0.82rem;">
                        <div><span style="color: var(--text-secondary);">Total Events:</span> <strong>${analytics.total_events || 0}</strong></div>
                        <div><span style="color: var(--text-secondary);">Train / Holdout:</span> <strong>${analytics.train_events_count || 0} / ${analytics.holdout_events_count || 0}</strong></div>
                        <div><span style="color: var(--text-secondary);">Est. Pass D Recall:</span> <strong>${escapeHtmlEntities(recall_pct)}</strong></div>
                        <div><span style="color: var(--text-secondary);">Missing Edges Added:</span> <strong>${analytics.edge_recall_estimate?.newly_discovered_edges_count || 0}</strong></div>
                        <div><span style="color: var(--text-secondary);">Repeat Consistency (5%):</span> <strong>${escapeHtmlEntities(repeat_pct)}</strong></div>
                        <div><span style="color: var(--text-secondary);">Paired Repeats:</span> <strong>${analytics.repeat_consistency?.matched_repeats || 0} / ${analytics.repeat_consistency?.paired_repeats || 0}</strong></div>
                    </div>
                </div>
            `;

            charts_container.innerHTML = `<div class="calibration-charts-grid">${caption_svg}${ingredient_svg}${laya_svg}${summary_panel}</div>`;
        } catch (dashboard_error) {
            charts_container.innerHTML = `<div style="color: #f87171;">Dashboard Error: ${escapeHtmlEntities(dashboard_error.message)}</div>`;
        }
    }

    /**
     * WHAT: Handles single-key review shortcuts (`y`, `n`, `s`, `1`, `2`, `3`) only while the Review tab is active.
     * WHY: Enables fast labeling cadence without hijacking typing inside form inputs or other tabs.
     */
    function handleReviewKeyboardShortcut(keyboard_event) {
        const review_tab_active = document.getElementById('tabContentReview')?.classList.contains('active');
        if (!review_tab_active) return;

        const target_tag = String(keyboard_event.target?.tagName || '').toLowerCase();
        if (target_tag === 'input' || target_tag === 'textarea' || target_tag === 'select') return;

        const active_card = global_review_queue_cards[global_review_queue_cursor];
        if (!active_card) return;

        const pressed_key = String(keyboard_event.key || '').toLowerCase();
        if (pressed_key === 's') {
            keyboard_event.preventDefault();
            submitReviewEvent('skipped');
            return;
        }

        if (active_card.card_type === 'grounding_caption') {
            if (pressed_key === '1') submitReviewEvent('grounded');
            else if (pressed_key === '2') submitReviewEvent('borderline');
            else if (pressed_key === '3') submitReviewEvent('mismatched');
        } else if (active_card.card_type === 'grounding_ingredient') {
            if (pressed_key === 'y' || pressed_key === '1') submitReviewEvent('present');
            else if (pressed_key === 'n' || pressed_key === '2') submitReviewEvent('absent');
        } else if (active_card.card_type === 'edge_check') {
            if (pressed_key === 'y' || pressed_key === '1') submitReviewEvent('confirmed');
            else if (pressed_key === 'n' || pressed_key === '2') submitReviewEvent('rejected');
        } else if (active_card.card_type === 'slot_check') {
            if (pressed_key === 'y' || pressed_key === '1') submitReviewEvent('correct');
            else if (pressed_key === 'n' || pressed_key === '2') submitSlotCorrectionEvent();
        } else if (active_card.card_type === 'missing_edge') {
            if (pressed_key === 'y') submitMissingEdgeEvent();
            else if (pressed_key === 'n' || pressed_key === '1') submitReviewEvent('no_missing_edge');
        }
    }


    function ensureReviewQueueLoadedOrRendered() {
        if (global_review_queue_cards.length === 0 || global_review_queue_cursor >= global_review_queue_cards.length) {
            loadReviewQueue(false);
        } else {
            renderActiveReviewCard();
        }
    }

    return {
        loadReviewQueue,
        submitReviewEvent,
        submitSlotCorrectionEvent,
        submitMissingEdgeEvent,
        fetchAndRenderCalibrationDashboard,
        handleReviewKeyboardShortcut,
        ensureReviewQueueLoadedOrRendered
    };
}
