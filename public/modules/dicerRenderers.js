// ============================================================================
// LUMINA STUDIO - PROMPT DICER PURE HTML & SVG RENDERERS
// ============================================================================
// WHAT: Immutable slot metadata tables and pure HTML/SVG string builders for
//       the Prompt Dicer & Remix Workbench UI.
// WHY: Isolates deterministic markup generation from DOM mutations, fetch calls,
//      and interactive state management in `public/dicer.js`.
// ============================================================================

import { escapeHtmlCharacters } from './cardCore.js';

// WHAT: Controlled slot definitions with visual emoji indicators and badge classes.
// WHY: Ensures that ingredients in the remix canvas are visually segregated by their photographic function.
export const CONTROLLED_SLOT_METADATA_TABLE = Object.freeze({
    framing: { label: 'Framing', emoji: '🎬', badgeClass: 'badge-framing' },
    lens: { label: 'Lens & Optics', emoji: '🔍', badgeClass: 'badge-lens' },
    subject_appearance: { label: 'Subject Appearance', emoji: '👤', badgeClass: 'badge-subject_appearance' },
    expression_or_pose: { label: 'Expression & Pose', emoji: '🎭', badgeClass: 'badge-expression_or_pose' },
    action: { label: 'Action & Verbs', emoji: '⚡', badgeClass: 'badge-action' },
    weather_or_matter: { label: 'Weather & Matter', emoji: '🌧️', badgeClass: 'badge-weather_or_matter' },
    lighting: { label: 'Lighting', emoji: '💡', badgeClass: 'badge-lighting' },
    palette: { label: 'Palette & Color', emoji: '🎨', badgeClass: 'badge-palette' },
    setting: { label: 'Setting & Scene', emoji: '🏛️', badgeClass: 'badge-setting' },
    film_stock_or_medium: { label: 'Film Stock / Medium', emoji: '🎞️', badgeClass: 'badge-film_stock_or_medium' },
    mood: { label: 'Mood & Pretext Vibe', emoji: '🔮', badgeClass: 'badge-mood' },
    camera_motion: { label: 'Camera Motion', emoji: '🎥', badgeClass: 'badge-other' },
    audio: { label: 'Audio & Acoustics', emoji: '🔊', badgeClass: 'badge-other' },
    other: { label: 'Other Modifiers', emoji: '✨', badgeClass: 'badge-other' }
});

// WHAT: Default slots locked when loading a base prompt for constrained transplantation.
// WHY: Matches Phase 1 UX contract—keeps character appearance, pose, action, and lens steady by default.
export const DEFAULT_TRANSPLANT_LOCKED_SLOTS = Object.freeze([
    'subject_appearance',
    'expression_or_pose',
    'action',
    'lens'
]);

// WHAT: Builds the thumbnail HTML for a source prompt card in the Remix Workbench picker.
// WHY: Reuses existing AVIF thumbnails (`thumbnails/id_<image_id>.avif`) and renders a clean fallback for standalone prompts.
export function buildRemixPromptThumbnailHtml(prompt_item) {
    const numeric_image_identifier = Number(prompt_item && prompt_item.image_id);
    if (!Number.isInteger(numeric_image_identifier) || numeric_image_identifier <= 0) {
        return `<div class="remix-prompt-thumb-wrap" title="Standalone / Remixed Prompt"><div class="remix-prompt-thumb-fallback">🧩</div></div>`;
    }

    const cache_buster_query = prompt_item.updated_at
        ? `?t=${encodeURIComponent(String(prompt_item.updated_at))}`
        : '';
    const thumbnail_source_url = `thumbnails/id_${numeric_image_identifier}.avif${cache_buster_query}`;
    const alternate_label = escapeHtmlCharacters(prompt_item.image_filename || prompt_item.prompt_id || 'Prompt thumbnail');

    return `
        <div class="remix-prompt-thumb-wrap" title="${alternate_label}">
            <img class="remix-prompt-thumb" src="${thumbnail_source_url}" alt="${alternate_label}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div class="remix-prompt-thumb-fallback" style="display: none;">🖼️</div>
        </div>
    `;
}

// WHAT: Builds the HTML summary lines for the Influence Closure / Transplant banner.
// WHY: Makes automated graph additions and removals transparent and reviewable on the canvas.
export function buildClosureTraceBannerHtml(closure_trace, swapped_slots = []) {
    const swapped_list = Array.isArray(swapped_slots) ? swapped_slots : [];
    const pulled_list = Array.isArray(closure_trace?.pulled_effects) ? closure_trace.pulled_effects : [];
    const pruned_list = Array.isArray(closure_trace?.pruned_orphans) ? closure_trace.pruned_orphans : [];

    if (swapped_list.length === 0 && pulled_list.length === 0 && pruned_list.length === 0) {
        return '';
    }

    const lines_html = [];
    if (swapped_list.length > 0) {
        const swap_descriptions = swapped_list.map(entry => {
            const old_label = entry.replaced_texts && entry.replaced_texts.length > 0
                ? `${entry.replaced_texts.join(' / ')} → `
                : '+ ';
            return `<code>${escapeHtmlCharacters(entry.slot)}</code>: ${escapeHtmlCharacters(old_label)}<strong>${escapeHtmlCharacters(entry.chosen_text)}</strong>`;
        });
        lines_html.push(`<div>🎲 <strong>Transplanted:</strong> ${swap_descriptions.join(' • ')}</div>`);
    }
    if (pulled_list.length > 0) {
        const pulled_descriptions = pulled_list.map(entry =>
            `<code>${escapeHtmlCharacters(entry.slot)}</code>: +${escapeHtmlCharacters(entry.text)} <em>(from ${escapeHtmlCharacters(entry.from_cause)})</em>`
        );
        lines_html.push(`<div>🔗 <strong>Influence Closure Pulled:</strong> ${pulled_descriptions.join(' • ')}</div>`);
    }
    if (pruned_list.length > 0) {
        const pruned_descriptions = pruned_list.map(entry =>
            `<code>${escapeHtmlCharacters(entry.slot)}</code>: −${escapeHtmlCharacters(entry.text)}`
        );
        lines_html.push(`<div>🧹 <strong>Pruned Orphaned Effects:</strong> ${pruned_descriptions.join(' • ')}</div>`);
    }

    return lines_html.join('');
}

// WHAT: Computes className, text, title, and visibility for `#roundTripStatusBadge`.
// WHY: Keeps round-trip verification presentation pure and testable outside the DOM.
export function buildRoundTripBadgeMeta(round_trip_verdict, execution_mode = null) {
    if (!round_trip_verdict || round_trip_verdict.status === 'empty_input') {
        return { visible: false, className: 'round-trip-badge', text: '', title: '' };
    }

    const mode_suffix = execution_mode === 'llama_server_grammar' ? ' [LLM]' : '';
    if (round_trip_verdict.verified) {
        return {
            visible: true,
            className: 'round-trip-badge round-trip-badge-verified',
            text: `✅ Round-Trip Verified (${round_trip_verdict.preserved_slot_count}/${round_trip_verdict.total_planned_slots} slots)${mode_suffix}`,
            title: `Round-trip check passed. Ratio: ${round_trip_verdict.round_trip_ratio}`
        };
    }

    const issues = [];
    if (round_trip_verdict.missing_slots?.length > 0) issues.push(`missing slots: ${round_trip_verdict.missing_slots.join(', ')}`);
    if (round_trip_verdict.missing_anchors?.length > 0) issues.push(`${round_trip_verdict.missing_anchors.length} dropped phrase(s)`);
    if (round_trip_verdict.clash_count > 0) issues.push(`${round_trip_verdict.clash_count} clash(es)`);

    return {
        visible: true,
        className: 'round-trip-badge round-trip-badge-drift',
        text: `⚠️ Drift (${issues.join('; ') || 'review output'})${mode_suffix}`,
        title: `Round-trip preserved ${round_trip_verdict.preserved_slot_count}/${round_trip_verdict.total_planned_slots} slots.`
    };
}

// WHAT: Builds the preview card HTML for a freshly diced prompt.
// WHY: Separates Pass A/B/D markup generation from `#liveDicingResultContainer` DOM injection.
export function buildDicingResultPreviewHtml(master_record) {
    const ratio_percentage = Math.round(master_record.metrics.physicality_ratio * 100);
    const subjects_list_html = master_record.subjects.map(subject_item => `
        <div style="background: rgba(255, 255, 255, 0.04); border-radius: 8px; padding: 0.6rem; margin-bottom: 0.4rem; font-size: 0.85rem;">
            <strong>${escapeHtmlCharacters(subject_item.role_label)}</strong>
            <span style="color: #38bdf8; margin-left: 0.5rem;">[${escapeHtmlCharacters(subject_item.theta_role)}]</span>
            ${subject_item.speech_state ? `<span style="color: #de7e68; margin-left: 0.5rem;">• ${escapeHtmlCharacters(subject_item.speech_state)}</span>` : ''}
            ${subject_item.requires_reference_image ? `<span style="color: #fbbf24; margin-left: 0.5rem;">(Needs Reference Image)</span>` : ''}
        </div>
    `).join('');

    const ingredients_chips_html = master_record.ingredients.map(ingredient_item => {
        const slot_metadata = CONTROLLED_SLOT_METADATA_TABLE[ingredient_item.slot] || { badgeClass: 'badge-other' };
        return `
            <span class="slot-lane-badge ${slot_metadata.badgeClass}" style="margin: 0.2rem; font-size: 0.75rem;">
                ${escapeHtmlCharacters(ingredient_item.text)}
            </span>
        `;
    }).join('');

    return `
        <div style="background: rgba(11, 11, 26, 0.7); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h4 style="margin: 0; color: #38bdf8;">✓ Dicing Successful: ${escapeHtmlCharacters(master_record.prompt_id)}</h4>
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="font-size: 0.85rem; color: var(--text-secondary);">Concreteness:</span>
                    <span style="font-weight: 700; color: #34d399;">${ratio_percentage}% (${master_record.metrics.physicality_ratio})</span>
                </div>
            </div>

            <div class="physicality-ratio-meter">
                <div class="physicality-ratio-fill" style="width: ${ratio_percentage}%;"></div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem;">
                <div>
                    <h5 style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.4rem;">Pass A: Bound Subjects (${master_record.subjects.length})</h5>
                    ${subjects_list_html || '<div style="color: var(--text-secondary); font-size: 0.8rem;">Whole-frame prompt (No specific acting subjects)</div>'}
                </div>
                <div>
                    <h5 style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.4rem;">Pass B & D: Extracted Ingredients (${master_record.ingredients.length})</h5>
                    <div style="display: flex; flex-wrap: wrap;">
                        ${ingredients_chips_html}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// WHAT: Builds the 4-stratum target progress pill HTML purely from sitting progress counts.
// WHY: Lets the curator track progress toward review targets without mixing string logic into DOM code.
export function buildSittingProgressHtml(sitting_progress) {
    if (!sitting_progress) return '';
    const metrics_rows = [
        { key: 'grounding', label: 'Grounding Cutoffs', data: sitting_progress.grounding },
        { key: 'edge_check', label: 'Edge Checks', data: sitting_progress.edge_check },
        { key: 'slot_check', label: 'Slot Checks', data: sitting_progress.slot_check },
        { key: 'missing_edge', label: 'Recall Probes', data: sitting_progress.missing_edge }
    ];

    return metrics_rows.map((metric_item) => {
        const current_value = Number(metric_item.data?.current || 0);
        const target_value = Math.max(1, Number(metric_item.data?.target || 100));
        const percent_complete = Math.min(100, Math.round((current_value / target_value) * 100));
        return `
            <div class="review-progress-pill">
                <div style="display: flex; justify-content: space-between; font-size: 0.78rem;">
                    <span>${escapeHtmlCharacters(metric_item.label)}</span>
                    <strong>${current_value} / ${target_value}</strong>
                </div>
                <div class="physicality-ratio-meter" style="margin-top: 0.35rem; height: 6px;">
                    <div class="physicality-ratio-fill" style="width: ${percent_complete}%;"></div>
                </div>
            </div>
        `;
    }).join('');
}

// WHAT: Highlights extracted ingredients in the raw prompt by slot color without mutating card data.
// WHY: Gives visual grounding at a glance while emphasizing whichever ingredient or edge the active question targets.
export function buildHighlightedPromptTokensHtml(card_object) {
    const ingredients_list = Array.isArray(card_object?.ingredients) ? card_object.ingredients : [];
    const active_primary_id = card_object?.target_ingredient_id || null;
    const active_secondary_id = card_object?.secondary_ingredient_id || null;

    const badges_html = ingredients_list.map((ingredient_item) => {
        const slot_metadata = CONTROLLED_SLOT_METADATA_TABLE[ingredient_item.slot] || CONTROLLED_SLOT_METADATA_TABLE.other;
        const is_highlighted_target = ingredient_item.ingredient_id === active_primary_id
            || ingredient_item.ingredient_id === active_secondary_id
            || (card_object?.target_text && ingredient_item.text === card_object.target_text);
        const token_class = is_highlighted_target ? 'review-slot-token review-slot-token-active' : 'review-slot-token';
        return `<span class="${token_class} ${escapeHtmlCharacters(slot_metadata.badgeClass)}" title="${escapeHtmlCharacters(slot_metadata.label)} (${escapeHtmlCharacters(ingredient_item.source || 'prompt_extraction')})">${escapeHtmlCharacters(slot_metadata.emoji)} ${escapeHtmlCharacters(ingredient_item.text)}</span>`;
    }).join('');

    return `
        <div class="review-highlighted-prompt">
            <div style="font-size: 0.88rem; color: var(--text-primary); line-height: 1.5; margin-bottom: 0.65rem;">
                ${escapeHtmlCharacters(card_object?.raw_prompt || '(No prompt text stored)')}
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 0.4rem;">
                ${badges_html || '<span style="color: var(--text-secondary); font-size: 0.8rem;">No extracted ingredients recorded.</span>'}
            </div>
        </div>
    `;
}

// WHAT: Builds a pure inline SVG stacked bar histogram for Ovis grounding scores by human verdict.
// WHY: Shows where grounded vs. borderline vs. mismatched distributions cross the configured cutoffs.
export function buildGroundingHistogramSvg(title_text, histogram_data, series_specs) {
    const bins = Array.isArray(histogram_data?.bins) ? histogram_data.bins : [];
    const max_total = Math.max(
        1,
        ...bins.map(bin => series_specs.reduce((sum, spec) => sum + Number(bin.counts?.[spec.key] || 0), 0))
    );
    const bar_width = 34;
    const bar_gap = 6;
    const svg_width = bins.length * (bar_width + bar_gap) + 30;
    const chart_height = 110;

    const bars_svg = bins.map((bin, bin_index) => {
        const x_pos = 16 + bin_index * (bar_width + bar_gap);
        let stacked_offset = 0;
        const rects = series_specs.map((spec) => {
            const count_val = Number(bin.counts?.[spec.key] || 0);
            const rect_height = (count_val / max_total) * chart_height;
            const y_pos = 12 + chart_height - stacked_offset - rect_height;
            stacked_offset += rect_height;
            return `<rect x="${x_pos}" y="${y_pos.toFixed(1)}" width="${bar_width}" height="${rect_height.toFixed(1)}" fill="${spec.color}" rx="2"><title>${escapeHtmlCharacters(bin.range_label)} — ${escapeHtmlCharacters(spec.label)}: ${count_val}</title></rect>`;
        }).join('');
        const short_range = String(bin.range_label || '').split('–')[0];
        const label_svg = `<text x="${x_pos + bar_width / 2}" y="${12 + chart_height + 14}" fill="#94a3b8" font-size="9" text-anchor="middle">${escapeHtmlCharacters(short_range)}</text>`;
        return `${rects}${label_svg}`;
    }).join('');

    const legend_html = series_specs.map(spec =>
        `<span style="display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.75rem;"><span style="width: 10px; height: 10px; border-radius: 2px; background: ${spec.color};"></span>${escapeHtmlCharacters(spec.label)}</span>`
    ).join('');

    return `
        <div class="calibration-panel-box">
            <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.45rem;">${escapeHtmlCharacters(title_text)}</div>
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem;">${legend_html}</div>
            <svg viewBox="0 0 ${svg_width} 145" style="width: 100%; max-height: 150px; background: rgba(15, 23, 42, 0.45); border-radius: 6px;">
                ${bars_svg}
            </svg>
        </div>
    `;
}

// WHAT: Builds a pure inline SVG calibration chart comparing model confidence bands against empirical human accuracy.
// WHY: Verifies visually whether Laya's confidence predicts correctness before re-enabling beam tie-breaking.
export function buildLayaCalibrationSvg(bands_list) {
    const safe_bands = Array.isArray(bands_list) ? bands_list : [];
    const bars_svg = safe_bands.map((band, band_index) => {
        const x_pos = 18 + band_index * 62;
        const emp_acc = Number(band.empirical_accuracy ?? 0);
        const avg_conf = Number(band.avg_confidence ?? 0);
        const acc_height = Math.round(emp_acc * 100);
        const conf_height = Math.round(avg_conf * 100);
        return `
            <rect x="${x_pos}" y="${112 - acc_height}" width="22" height="${acc_height}" fill="#38bdf8" rx="2"><title>${escapeHtmlCharacters(band.band_label)} Empirical: ${(emp_acc * 100).toFixed(1)}% (n=${band.sample_count})</title></rect>
            <rect x="${x_pos + 24}" y="${112 - conf_height}" width="22" height="${conf_height}" fill="#a855f7" opacity="0.7" rx="2"><title>${escapeHtmlCharacters(band.band_label)} Model Conf: ${(avg_conf * 100).toFixed(1)}%</title></rect>
            <text x="${x_pos + 23}" y="128" fill="#94a3b8" font-size="9" text-anchor="middle">${escapeHtmlCharacters(band.band_label)}</text>
        `;
    }).join('');

    return `
        <div class="calibration-panel-box">
            <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.45rem;">Laya Confidence vs. Empirical Accuracy</div>
            <div style="display: flex; gap: 0.75rem; font-size: 0.75rem; margin-bottom: 0.5rem;">
                <span style="display: inline-flex; align-items: center; gap: 0.3rem;"><span style="width: 10px; height: 10px; background: #38bdf8; border-radius: 2px;"></span>Human Accuracy</span>
                <span style="display: inline-flex; align-items: center; gap: 0.3rem;"><span style="width: 10px; height: 10px; background: #a855f7; border-radius: 2px;"></span>Mean Model Conf</span>
            </div>
            <svg viewBox="0 0 335 140" style="width: 100%; max-height: 150px; background: rgba(15, 23, 42, 0.45); border-radius: 6px;">
                ${bars_svg}
            </svg>
        </div>
    `;
}

