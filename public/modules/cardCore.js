/**
 * ============================================================================
 * MODULE: cardCore.js — Pure Functional Core for Image Cards & Tag Normalization
 * ============================================================================
 *
 * WHAT: Provides 100% pure, deterministic data transformations for HTML escaping,
 *       tag/object deduplication, Pretext card width calculation, gradient bucket
 *       selection, and search result card HTML construction.
 * WHY:  Follows the Functional Core, Imperative Shell architecture. Every function
 *       in this module takes explicit inputs, returns a fresh immutable value, has
 *       zero side effects, and can be unit-tested in Node.js without DOM mocks.
 */

const CARD_GRADIENT_VARIANTS_TABLE = Object.freeze([
    'purple',
    'blue',
    'green',
    'orange',
    'pink'
]);

/**
 * WHAT: Escapes special HTML characters (`&`, `<`, `>`, `"`, `'`) into safe HTML entities.
 * WHY:  Prevents Cross-Site Scripting (XSS) and broken HTML attributes when rendering
 *       user-supplied filenames, summaries, and AI tags inside template literals.
 *
 * @param {unknown} input_value_to_be_escaped - Raw value to convert and escape.
 * @returns {string} HTML-safe string.
 */
export function escapeHtmlCharacters(input_value_to_be_escaped) {
    if (input_value_to_be_escaped === null || input_value_to_be_escaped === undefined) {
        return '';
    }
    return String(input_value_to_be_escaped)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * WHAT: Normalizes a tag or object string into a canonical comparison token.
 * WHY:  AI vision models frequently produce near-duplicate tags differing only by
 *       pluralization (`tree` vs `trees`), hyphens (`sci-fi` vs `sci fi`), or casing.
 *       Collapsing these variations into a single comparison key prevents redundant tags.
 *
 * @param {string} raw_tag_string - Original tag or object label.
 * @returns {string} Canonical lowercase comparison token.
 */
export function normalizeTagComparisonToken(raw_tag_string) {
    if (!raw_tag_string || typeof raw_tag_string !== 'string') {
        return '';
    }
    // WHAT: Lowercase, trim, collapse spaces/hyphens/underscores, and strip trailing plural suffixes.
    // WHY:  Ensures "Sci-Fi", "sci fi", and "sci_fi" map to the exact same canonical token.
    const alphanumeric_collapsed_token = raw_tag_string
        .toLowerCase()
        .trim()
        .replace(/[\s\-_]+/g, '');

    if (alphanumeric_collapsed_token.endsWith('ies') && alphanumeric_collapsed_token.length > 4) {
        return alphanumeric_collapsed_token.slice(0, -3) + 'y';
    }
    if (alphanumeric_collapsed_token.endsWith('es') && alphanumeric_collapsed_token.length > 3) {
        return alphanumeric_collapsed_token.slice(0, -2);
    }
    if (alphanumeric_collapsed_token.endsWith('s') && !alphanumeric_collapsed_token.endsWith('ss') && alphanumeric_collapsed_token.length > 2) {
        return alphanumeric_collapsed_token.slice(0, -1);
    }
    return alphanumeric_collapsed_token;
}

/**
 * WHAT: Deduplicates an array of tag or object strings using `normalizeTagComparisonToken`
 *       without mutating the input array.
 * WHY:  When two variants collide (e.g. `["sci-fi", "scifi"]`), we prefer the more readable
 *       spaced or hyphenated form while keeping the operation 100% pure and non-mutating.
 *
 * @param {readonly string[]} raw_items_list - Input list of tag or object strings.
 * @param {ReadonlySet<string>} [excluded_canonical_tokens_set] - Optional set of canonical tokens to exclude.
 * @returns {{ readonly deduplicated_items: readonly string[], readonly seen_canonical_tokens: ReadonlySet<string> }}
 */
export function deduplicateTagListPure(raw_items_list, excluded_canonical_tokens_set = new Set()) {
    if (!Array.isArray(raw_items_list)) {
        return {
            deduplicated_items: [],
            seen_canonical_tokens: new Set(excluded_canonical_tokens_set)
        };
    }

    // WHAT: Sort a shallow copy so spaced/hyphenated human-readable labels are evaluated first.
    // WHY:  Sorting in-place would mutate caller arguments; `.slice().sort(...)` creates a safe local copy.
    const prioritized_items_copy = raw_items_list.slice().sort((first_item, second_item) => {
        const first_has_separator = /[\s\-]/.test(String(first_item));
        const second_has_separator = /[\s\-]/.test(String(second_item));
        if (first_has_separator && !second_has_separator) return -1;
        if (!first_has_separator && second_has_separator) return 1;
        return String(first_item).length - String(second_item).length;
    });

    const seen_canonical_tokens = new Set(excluded_canonical_tokens_set);
    const deduplicated_items = [];

    for (const candidate_item of prioritized_items_copy) {
        if (typeof candidate_item !== 'string') continue;
        const trimmed_item = candidate_item.trim();
        if (!trimmed_item) continue;

        const canonical_token = normalizeTagComparisonToken(trimmed_item);
        if (canonical_token && !seen_canonical_tokens.has(canonical_token)) {
            seen_canonical_tokens.add(canonical_token);
            deduplicated_items.push(trimmed_item);
        }
    }

    return {
        deduplicated_items,
        seen_canonical_tokens
    };
}

/**
 * WHAT: Returns a new immutable analysis record with deduplicated `objects` and `tags`,
 *       ensuring no tag duplicates an object already listed on the same image.
 * WHY:  Replaces the legacy mutating `cleanAndDeduplicateAnalysis` helper with a pure
 *       transformation that never mutates the input `analysis_record`.
 *
 * @param {Readonly<Record<string, unknown>> | null | undefined} analysis_record - Raw image analysis object.
 * @returns {Record<string, unknown>} Fresh analysis record with clean `objects` and `tags` arrays.
 */
export function deduplicateAndNormalizeAnalysisRecord(analysis_record) {
    if (!analysis_record || typeof analysis_record !== 'object') {
        return { objects: [], tags: [], summary: '', scene_type: 'Unknown' };
    }

    const raw_objects_array = Array.isArray(analysis_record.objects) ? analysis_record.objects : [];
    const raw_tags_array = Array.isArray(analysis_record.tags) ? analysis_record.tags : [];

    const objects_deduplication_result = deduplicateTagListPure(raw_objects_array);
    const tags_deduplication_result = deduplicateTagListPure(
        raw_tags_array,
        objects_deduplication_result.seen_canonical_tokens
    );

    return {
        ...analysis_record,
        objects: objects_deduplication_result.deduplicated_items,
        tags: tags_deduplication_result.deduplicated_items
    };
}

/**
 * WHAT: Deterministically maps an image identifier to one of the five card gradient variants.
 * WHY:  Gives each card a stable visual accent color across re-renders without storing random state.
 *
 * @param {number | string} image_identifier - Numeric or string image ID.
 * @returns {string} Gradient variant name (`'purple'`, `'blue'`, `'green'`, `'orange'`, or `'pink'`).
 */
export function computeCardGradientVariant(image_identifier) {
    const numeric_hash_value = typeof image_identifier === 'string'
        ? image_identifier.split('').reduce((accumulated_sum, character) => accumulated_sum + character.charCodeAt(0), 0)
        : Number(image_identifier) || 0;
    const safe_positive_index = Math.abs(numeric_hash_value) % CARD_GRADIENT_VARIANTS_TABLE.length;
    return CARD_GRADIENT_VARIANTS_TABLE[safe_positive_index];
}

/**
 * WHAT: Computes the exact pixel width available for summary text inside a masonry card.
 * WHY:  Pretext requires an accurate pixel line width to pre-calculate multiline text height
 *       and prevent Cumulative Layout Shift (CLS) before cards enter the DOM.
 *
 * @param {number} grid_container_width_pixels - Measured width of `#searchResults` container.
 * @param {number} existing_card_client_width_pixels - Measured width of an existing `.card` if present (`0` otherwise).
 * @param {number} [default_text_width_pixels=396] - Fallback width when neither measurement is available.
 * @returns {number} Calculated inner text width in pixels.
 */
export function calculatePretextCardTextWidth(
    grid_container_width_pixels,
    existing_card_client_width_pixels = 0,
    default_text_width_pixels = 396
) {
    if (existing_card_client_width_pixels > 24) {
        return existing_card_client_width_pixels - 24;
    }
    const effective_grid_width_pixels = grid_container_width_pixels > 0 ? grid_container_width_pixels : 1000;
    const column_count = Math.max(1, Math.floor((effective_grid_width_pixels + 16) / (420 + 16)));
    const single_card_width_pixels = (effective_grid_width_pixels - (column_count - 1) * 16) / column_count;
    return Math.max(120, single_card_width_pixels - 24) || default_text_width_pixels;
}

/**
 * WHAT: Extracts the Master Record (Pass A-D) from an image record or its parsed analysis JSON.
 * WHY: Supports unified diced prompt access across database and search card views regardless
 *      of whether `diced_prompt` is stored as an object, JSON string, or nested under analysis.
 *
 * @param {Readonly<Record<string, any>>} image_record - Image database record.
 * @param {Readonly<Record<string, any>>} [parsed_analysis] - Optional pre-parsed analysis object.
 * @returns {Record<string, any> | null} Parsed Master Record or null if not diced yet.
 */
export function extractDicedPromptMasterRecord(image_record, parsed_analysis) {
    if (parsed_analysis && parsed_analysis.diced_prompt && typeof parsed_analysis.diced_prompt === 'object') {
        return parsed_analysis.diced_prompt;
    }
    if (image_record && image_record.diced_prompt) {
        if (typeof image_record.diced_prompt === 'object') {
            return image_record.diced_prompt;
        }
        if (typeof image_record.diced_prompt === 'string') {
            try {
                return JSON.parse(image_record.diced_prompt);
            } catch (parse_error) {
                return null;
            }
        }
    }
    return null;
}

/**
 * WHAT: Generates the HTML for a card's thumbnail image and its fallback regenerate button.
 * WHY: Centralizes thumbnail markup across all three card sides so error fallbacks, lazy loading, and click-to-preview work uniformly without duplicating HTML.
 */
export function buildCardThumbnailBlockHtml({
    image_id,
    display_path,
    full_path,
    filename_text,
    size_pixels = 80,
    is_eager = false,
    is_priority = false
}) {
    const safe_size = Number(size_pixels) > 0 ? Number(size_pixels) : 80;
    const is_compact_size = safe_size < 80;
    return `
        <img src="${escapeHtmlCharacters(display_path)}"
                data-fullpath="${escapeHtmlCharacters(full_path)}"
                alt="${escapeHtmlCharacters(filename_text)}"
                class="thumbnail-preview"
                loading="${is_eager ? 'eager' : 'lazy'}"
                decoding="async"
                ${is_priority ? 'fetchpriority="high"' : ''}
                width="${safe_size}"
                height="${safe_size}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                style="width: ${safe_size}px; height: ${safe_size}px; flex-shrink: 0; object-fit: cover; border-radius: ${is_compact_size ? '6px' : '8px'}; cursor: pointer; border: 1px solid rgba(255, 255, 255, 0.08);"
                title="Click to view full size">
        <div class="thumb-fallback" style="display: none; width: ${safe_size}px; height: ${safe_size}px; flex-shrink: 0; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; flex-direction: column; align-items: center; justify-content: center; gap: 0.2rem; font-size: ${is_compact_size ? '0.6rem' : '0.7rem'}; color: var(--text-secondary); text-align: center; padding: 0.3rem;">
            <span>No Preview</span>
            <button class="regen-thumb-btn" data-id="${image_id}" style="background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); cursor: pointer; border-radius: 4px; padding: 2px 5px; font-size: ${is_compact_size ? '0.58rem' : '0.65rem'};" title="Regenerate Thumbnail">
                🔄 Regen
            </button>
        </div>
    `;
}

/**
 * WHAT: Generates the compact thumbnail and filename header strip shown on the card's back faces.
 * WHY: Keeps the image visually identifiable on both Side 2 (Tags) and Side 3 (Diced Prompt) while preserving space for scrollable tag and ingredient details.
 */
export function buildCardBackIdentityHeaderHtml({
    image_id,
    display_path,
    full_path,
    filename_text,
    metadata_tooltip,
    date_text,
    width_text,
    height_text,
    is_eager = false
}) {
    const thumbnail_html = buildCardThumbnailBlockHtml({
        image_id,
        display_path,
        full_path,
        filename_text,
        size_pixels: 64,
        is_eager,
        is_priority: false
    });

    return `
        <div class="card-back-media-header" style="display: flex; align-items: center; gap: 0.7rem; padding-bottom: 0.65rem; margin-bottom: 0.7rem; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
            ${thumbnail_html}
            <div style="flex: 1; min-width: 0;">
                <h3 class="card-filename file-link" data-path="${escapeHtmlCharacters(full_path)}" style="margin: 0; border: none; font-size: 0.92rem; cursor: pointer; color: var(--accent); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtmlCharacters(metadata_tooltip)}">${escapeHtmlCharacters(filename_text)}</h3>
                <small style="color: var(--text-secondary); font-size: 0.72rem;">${escapeHtmlCharacters(date_text)} • ${width_text}w ${height_text}h</small>
            </div>
        </div>
    `;
}

/**
 * WHAT: Purely renders the HTML panel for Side 3 (Diced Prompt Master Record).
 * WHY: Surfaces physical slots, theta roles, measurements, and directed influence edges uniformly across cards.
 */
export function renderDicedPromptBackDetailsHtml(image_record, diced_master_record) {
    if (!diced_master_record || !Array.isArray(diced_master_record.ingredients)) {
        return `
            <div style="padding: 1rem; border: 1px dashed rgba(56, 189, 248, 0.3); border-radius: 8px; text-align: center; margin-top: 0.5rem;">
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.6rem;">No diced prompt structure saved for this image yet.</div>
                <button class="dice-card-btn" data-id="${image_record.id}" style="background: rgba(56, 189, 248, 0.18); border: 1px solid #38bdf8; color: #38bdf8; padding: 0.4rem 0.85rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; cursor: pointer;">🧩 Dice Prompt Now</button>
            </div>
        `;
    }

    const subjects_list = Array.isArray(diced_master_record.subjects) ? diced_master_record.subjects : [];
    const ingredients_list = Array.isArray(diced_master_record.ingredients) ? diced_master_record.ingredients : [];
    const influences_list = Array.isArray(diced_master_record.influences) ? diced_master_record.influences : [];
    const physicality_percentage = Math.round((Number(diced_master_record.metrics?.physicality_ratio) || 0) * 100);
    const physical_count = diced_master_record.metrics?.physical_anchor_count ?? 0;
    const pretext_count = diced_master_record.metrics?.pretext_term_count ?? 0;

    const subjects_html = subjects_list.map(subject_item => `
        <span style="display: inline-block; font-size: 0.7rem; background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.35); color: #34d399; padding: 0.15rem 0.45rem; border-radius: 4px; margin: 0 4px 4px 0;">
            <strong>${escapeHtmlCharacters(subject_item.subject_id)}</strong>: ${escapeHtmlCharacters(subject_item.role_label || subject_item.description || '')} <em>(${escapeHtmlCharacters(subject_item.theta_role || 'AGENT')}${subject_item.verb_action ? ` • ${escapeHtmlCharacters(subject_item.verb_action)}` : ''})</em>
        </span>
    `).join('');

    const ingredients_html = ingredients_list.map(ingredient_item => {
        const is_pretext = ingredient_item.kind === 'pretext_term' || ingredient_item.kind === 'pretext';
        const is_ovis_facet = ingredient_item.source === 'ovis_facet';
        const subject_label = ingredient_item.bound_to_subject_id
            ? (subjects_list.find(subject_entry => subject_entry.subject_id === ingredient_item.bound_to_subject_id)?.role_label || ingredient_item.bound_to_subject_id)
            : null;
        const replacement_html = (is_pretext && ingredient_item.observable_replacement?.text)
            ? `<div style="font-size: 0.68rem; color: #f472b6; margin-top: 2px;">↳ Physical [${escapeHtmlCharacters(ingredient_item.observable_replacement.replacement_slot)}]: ${escapeHtmlCharacters(ingredient_item.observable_replacement.text)}</div>`
            : '';
        const measured_html = ingredient_item.measured_value
            ? ` <span style="color: #fbbf24; font-weight: 600;">[${escapeHtmlCharacters(ingredient_item.measured_value.number)} ${escapeHtmlCharacters(ingredient_item.measured_value.unit)}]</span>`
            : '';
        const subject_badge = subject_label
            ? ` <span style="color: #34d399; font-size: 0.65rem;">@${escapeHtmlCharacters(subject_label)}</span>`
            : '';
        const ovis_provenance_badge = is_ovis_facet
            ? ` <span style="font-size: 0.63rem; padding: 0.05rem 0.3rem; border-radius: 4px; background: rgba(167, 139, 250, 0.16); color: #c4b5fd;">👁️ Ovis ${Math.round((Number(ingredient_item.facet_confidence) || 0) * 100)}%</span>`
            : '';
        const border_accent_color = is_ovis_facet ? '#a78bfa' : (is_pretext ? '#f472b6' : '#38bdf8');

        return `
            <div style="padding: 0.3rem 0.45rem; margin-bottom: 4px; border-radius: 5px; background: rgba(255,255,255,0.03); border-left: 3px solid ${border_accent_color}; font-size: 0.72rem;">
                <div>
                    <strong style="color: ${border_accent_color};">[${escapeHtmlCharacters(ingredient_item.slot)}]</strong>
                    <span style="color: var(--text-primary);"> ${escapeHtmlCharacters(ingredient_item.text)}</span>${measured_html}${subject_badge}${ovis_provenance_badge}
                </div>
                ${replacement_html}
            </div>
        `;
    }).join('');

    const grounding_info = diced_master_record.visual_grounding;
    const grounding_badge_html = (grounding_info && grounding_info.checked)
        ? (() => {
            const is_grounded = grounding_info.grounding_status === 'grounded';
            const is_borderline = grounding_info.grounding_status === 'borderline';
            const badge_color = is_grounded ? '#34d399' : (is_borderline ? '#fbbf24' : '#f87171');
            const badge_bg = is_grounded ? 'rgba(16, 185, 129, 0.16)' : (is_borderline ? 'rgba(245, 158, 11, 0.16)' : 'rgba(239, 68, 68, 0.18)');
            const badge_icon = is_grounded ? '👁️' : (is_borderline ? '⚠️' : '❌');
            const missing_ingredients = Array.isArray(grounding_info.missing_ingredients) ? grounding_info.missing_ingredients : [];
            const missing_suffix = missing_ingredients.length > 0 ? ` • ${missing_ingredients.length} ungrounded` : '';
            const missing_tooltip = missing_ingredients.length > 0
                ? ` | Missing ingredients: ${missing_ingredients.map(missing_entry => missing_entry.text).join(', ')}`
                : '';
            return `<span style="font-size: 0.65rem; padding: 0.08rem 0.35rem; border-radius: 4px; background: ${badge_bg}; color: ${badge_color}; font-weight: 600;" title="Ovis-Omni pixel vs caption cosine similarity${escapeHtmlCharacters(missing_tooltip)}">${badge_icon} ${grounding_info.grounding_status} (${grounding_info.grounding_score}${missing_suffix})</span>`;
        })()
        : '';

    const influences_html = influences_list.map(influence_item => `
        <div style="padding: 0.3rem 0.45rem; margin-bottom: 4px; border-radius: 5px; background: rgba(167, 139, 250, 0.08); border-left: 3px solid #a78bfa; font-size: 0.7rem;">
            <div style="color: #c4b5fd; font-weight: 600;">
                ⚡ ${escapeHtmlCharacters(influence_item.source_ingredient_id)} ➔ ${escapeHtmlCharacters(influence_item.target_ingredient_id)} (${escapeHtmlCharacters(influence_item.interaction_type)})
            </div>
            <div style="color: var(--text-primary);">${escapeHtmlCharacters(influence_item.consequence_description)}</div>
            <div style="color: var(--text-secondary); font-size: 0.65rem;">
                <code>${escapeHtmlCharacters(influence_item.state_key)}=${escapeHtmlCharacters(influence_item.applied_state_value)}</code> (clashes: <code>${escapeHtmlCharacters(influence_item.clashes_with_value)}</code>)
            </div>
        </div>
    `).join('');

    return `
        <div class="diced-prompt-back-panel" style="display: flex; flex-direction: column; flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.35rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">
                    <strong style="font-size: 0.8rem; color: #38bdf8;">🧩 ${escapeHtmlCharacters(diced_master_record.prompt_id)}</strong>
                    <span style="font-size: 0.68rem; padding: 0.08rem 0.38rem; border-radius: 4px; background: ${physicality_percentage >= 65 ? 'rgba(16, 185, 129, 0.18)' : 'rgba(245, 158, 11, 0.18)'}; color: ${physicality_percentage >= 65 ? '#34d399' : '#fbbf24'}; font-weight: 600;">
                        ${physicality_percentage}% Concrete (${physical_count}P / ${pretext_count}V)
                    </span>
                    ${grounding_badge_html}
                </div>
                <div style="display: flex; align-items: center; gap: 0.35rem;">
                    <a href="dicer.html?prompt_id=${encodeURIComponent(diced_master_record.prompt_id)}" class="open-dicer-link" style="font-size: 0.7rem; color: #a78bfa; text-decoration: none; border: 1px solid rgba(167, 139, 250, 0.35); padding: 0.12rem 0.45rem; border-radius: 4px;" title="Pull and recombine in Remix Workbench">Remix ↗</a>
                    <button class="dice-card-btn" data-id="${image_record.id}" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); border-radius: 4px; padding: 0.12rem 0.4rem; font-size: 0.68rem; cursor: pointer;" title="Re-dice prompt from latest description">🔄</button>
                </div>
            </div>
            ${subjects_html ? `<div style="margin-bottom: 0.5rem;"><strong style="font-size: 0.72rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">Subjects (Pass A):</strong>${subjects_html}</div>` : ''}
            <div style="margin-bottom: 0.5rem;">
                <strong style="font-size: 0.72rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">Ingredients (Pass B & C — ${ingredients_list.length}):</strong>
                <div style="max-height: 210px; overflow-y: auto; padding-right: 2px;">
                    ${ingredients_html}
                </div>
            </div>
            ${influences_html ? `<div><strong style="font-size: 0.72rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">Influence Seeds (Pass D — ${influences_list.length}):</strong>${influences_html}</div>` : ''}
        </div>
    `;
}

/**
 * WHAT: Pure HTML builder for a single tri-face search result prism card.
 * WHY:  Separates HTML string construction from DOM mutation and global `selectedIds` state, providing
 *       Side 1 (Summary), Side 2 (Tags & Objects), and Side 3 (Diced Prompt Master Record) uniformly.
 *
 * @param {Readonly<Record<string, any>>} image_record - Image record from the database/worker.
 * @param {Readonly<{
 *   summary_height_pixels?: number,
 *   is_selected?: boolean,
 *   is_priority_lcp?: boolean,
 *   is_eager_loaded?: boolean,
 *   formatted_date_string?: string
 * }>} [render_options={}] - Explicit presentation options.
 * @returns {string} Complete HTML string for the `.card` element.
 */
export function buildSearchResultCardHtml(image_record, render_options = {}) {
    const {
        summary_height_pixels = undefined,
        is_selected = false,
        is_priority_lcp = false,
        is_eager_loaded = false,
        formatted_date_string = undefined
    } = render_options;

    const display_date_string = formatted_date_string ||
        new Date(image_record.created_at || Date.now()).toLocaleDateString();

    const cache_busting_timestamp = image_record.updated_at
        ? new Date(image_record.updated_at).getTime()
        : (image_record.created_at ? new Date(image_record.created_at).getTime() : '');
    const thumbnail_display_path = `thumbnails/id_${image_record.id}.avif${cache_busting_timestamp ? '?t=' + cache_busting_timestamp : ''}`;

    const analysis_record = image_record.analysis || {};
    const detected_objects_list = Array.isArray(analysis_record.objects) ? analysis_record.objects : [];
    const image_tags_list = Array.isArray(analysis_record.tags) ? analysis_record.tags : [];
    const card_gradient_variant = computeCardGradientVariant(image_record.id);

    const diced_master_record = extractDicedPromptMasterRecord(image_record, analysis_record);

    const summary_height_style = summary_height_pixels ? ` min-height: ${summary_height_pixels}px;` : '';
    const summary_measured_class = summary_height_pixels ? 'pretext-measured' : '';

    const back_identity_header_html = buildCardBackIdentityHeaderHtml({
        image_id: image_record.id,
        display_path: thumbnail_display_path,
        full_path: image_record.path,
        filename_text: image_record.filename,
        metadata_tooltip: image_record.path,
        date_text: display_date_string,
        width_text: image_record.width || 'N/A',
        height_text: image_record.height || 'N/A',
        is_eager: is_eager_loaded
    });

    const thumbnail_html = buildCardThumbnailBlockHtml({
        image_id: image_record.id,
        display_path: thumbnail_display_path,
        full_path: image_record.path,
        filename_text: image_record.filename,
        size_pixels: 80,
        is_eager: is_eager_loaded,
        is_priority: is_priority_lcp
    });

    return `
        <div class="card ${is_selected ? 'selected' : ''}" data-id="${image_record.id}" data-grad="${card_gradient_variant}" data-side="1" data-spin-deg="0" style="--spin-deg: 0deg;">
            <div class="card-inner">
                <!-- SIDE 1: SUMMARY (3D PRISM FACE AT 0deg) -->
                <div class="card-front" data-face="1">
                    <div style="position: absolute; top: 0.75rem; right: 0.75rem; z-index: 5;">
                        <label class="card-select-target" title="Select image">
                            <input type="checkbox" class="card-select-cb" data-id="${image_record.id}" aria-label="Select ${escapeHtmlCharacters(image_record.filename || 'image')}" ${is_selected ? 'checked' : ''}>
                        </label>
                    </div>
                    
                    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; padding-right: 2.2rem;">
                        ${thumbnail_html}
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <h3 class="card-filename file-link" data-path="${escapeHtmlCharacters(image_record.path)}" style="margin: 0; color: var(--accent); font-size: 1rem; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Show in folder">${escapeHtmlCharacters(image_record.filename)}</h3>
                                <button class="delete-btn" data-id="${image_record.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.7rem; transition: all 0.2s; margin-left: 0.5rem;" title="Delete Image">X</button>
                            </div>
                            <small style="color: var(--text-secondary); font-size: 0.72rem;">${escapeHtmlCharacters(display_date_string)} • ${image_record.width || 'N/A'}w ${image_record.height || 'N/A'}h</small>
                            <div style="margin-top: 0.25rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
                                <span class="badge" style="font-size: 0.7rem;">${escapeHtmlCharacters(analysis_record.scene_type) || 'Unknown'}</span>
                                ${image_record.theme_name ? `<span class="badge" style="font-size: 0.65rem; background: rgba(147, 51, 234, 0.2); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.4);" title="EVoC Cluster Theme by Laya">🏷️ ${escapeHtmlCharacters(String(image_record.theme_name).replace(/_/g, ' '))}</span>` : ''}
                                ${image_record.facet_medium ? `<span class="badge" style="font-size: 0.65rem; background: rgba(59, 130, 246, 0.15); color: #60a5fa;" title="Artistic Medium">🎨 ${escapeHtmlCharacters(String(image_record.facet_medium).replace(/_/g, ' '))}</span>` : ''}
                                ${image_record.facet_mood ? `<span class="badge" style="font-size: 0.65rem; background: rgba(245, 158, 11, 0.15); color: #fbbf24;" title="Visual Mood">✨ ${escapeHtmlCharacters(String(image_record.facet_mood).replace(/_/g, ' '))}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    
                    <div style="flex: 1;">
                        <p class="summary-text image-summary ${summary_measured_class}" data-id="${image_record.id}" style="font-size: 0.9rem; color: var(--text-primary); margin: 0; line-height: 1.4;${summary_height_style}">
                            <button class="copy-btn" data-text="${escapeHtmlCharacters(analysis_record.summary || '')}" style="float: right; margin: 0.1rem 0 0.25rem 0.5rem; background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.75rem; white-space: nowrap;" title="Copy to clipboard">Copy</button>
                            ${escapeHtmlCharacters(analysis_record.summary) || 'No summary available'}
                        </p>
                    </div>

                    <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.68rem; color: var(--text-secondary); opacity: 0.55;">1/3 • Summary</span>
                        <span style="font-size: 0.7rem; color: var(--text-secondary); opacity: 0.65;">Click card: Tags → Diced Prompt ↻</span>
                    </div>
                </div>

                <!-- SIDE 2: TAGS & OBJECTS (3D PRISM FACE AT 120deg) -->
                <div class="card-back card-back-face card-back-tags" data-face="2">
                    ${back_identity_header_html}
                    <div class="tags-section" style="flex: 1;">
                        <div class="tags-container" style="margin-bottom: 1rem;">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Detected Objects:</strong>
                            ${detected_objects_list.map(object_label => `<span class="tag editable" data-id="${image_record.id}" data-type="objects" data-tag="${escapeHtmlCharacters(object_label)}" title="Click to search, Right-click to edit" style="cursor: pointer; font-size: 0.75rem; background-color: rgba(16, 185, 129, 0.2); color: #34d399; margin-bottom: 4px;">${escapeHtmlCharacters(object_label)}</span>`).join('')}
                            <button class="add-tag-btn" data-id="${image_record.id}" data-type="objects" title="Add Object">+</button>
                        </div>
                        <div class="tags-container">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Image Tags:</strong>
                            ${image_tags_list.map(tag_label => `<span class="tag editable" data-id="${image_record.id}" data-type="tags" data-tag="${escapeHtmlCharacters(tag_label)}" title="Click to search, Right-click to edit" style="cursor: pointer; font-size: 0.75rem; margin-bottom: 4px;">${escapeHtmlCharacters(tag_label)}</span>`).join('')}
                            ${analysis_record.scene_type ? `<span class="tag" style="background-color: rgba(129, 140, 248, 0.2); color: #818cf8; font-size: 0.75rem; margin-bottom: 4px;">${escapeHtmlCharacters(analysis_record.scene_type)}</span>` : ''}
                            <button class="add-tag-btn" data-id="${image_record.id}" data-type="tags" title="Add Tag">+</button>
                        </div>
                    </div>
                    
                    <div style="margin-top: 1rem; text-align: center;">
                        <button class="card-side-pill" data-target-side="3" style="border-color: rgba(56, 189, 248, 0.5); color: #38bdf8;">Next: Diced Prompt (3/3) ↻</button>
                    </div>
                </div>

                <!-- SIDE 3: DICED PROMPT MASTER RECORD (3D PRISM FACE AT 240deg) -->
                <div class="card-back card-back-face card-back-dicer" data-face="3">
                    ${back_identity_header_html}
                    ${renderDicedPromptBackDetailsHtml(image_record, diced_master_record)}
                    <div style="margin-top: 0.85rem; text-align: center;">
                        <button class="card-side-pill" data-target-side="1" style="border-color: var(--accent); color: var(--accent);">Back to Summary (1/3) ↻</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

