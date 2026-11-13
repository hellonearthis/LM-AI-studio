/**
 * Prompt Dicer Review Queue, Append-Only Review Events & Calibration Analytics Repository
 *
 * Extracted from promptDicerDb.js to keep SQLite repository modules focused and maintainable.
 */

import {
    build_stratified_review_queue_order,
    compute_calibration_and_grounding_analytics
} from "../promptDicerService.js";
import {
    assign_deterministic_dataset_split,
    classify_prompt_length_bucket,
    extract_visual_grounding_metadata
} from "./dbSchema.js";

// ============================================================================
// 6. REVIEW QUEUE, APPEND-ONLY EVENTS & CALIBRATION ANALYTICS REPOSITORY
// ============================================================================


/**
 * WHAT: Builds a single-question stratified (or uncertainty-sorted) Review Queue across the 5 card types with ~5% repeat checks.
 * WHY: Enables rapid keyboard-driven human labeling that simultaneously calibrates grounding cutoffs, estimates Pass D recall, and collects Laya fine-tuning data.
 *
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} queue_options - `{ card_type, ordering, limit, repeat_fraction, seed }`.
 * @returns {Object} Frozen `{ cards, repeat_pool_size, sitting_progress }`.
 */
export function build_review_queue_cards(database_connection, queue_options = {}) {
    const requested_type = ['all', 'grounding_caption', 'grounding_ingredient', 'edge_check', 'slot_check', 'missing_edge'].includes(queue_options.card_type)
        ? queue_options.card_type
        : 'all';
    const ordering_mode = queue_options.ordering === 'uncertainty' ? 'uncertainty' : 'stratified';
    const queue_limit = Math.max(1, Math.min(120, Number(queue_options.limit) || 40));
    const seed = Number(queue_options.seed) || 1;
    const candidate_fetch_cap = Math.max(120, queue_limit * 6);

    // Fetch existing baseline review events so reviewed items go to repeat pool instead of primary queue
    const prior_events = database_connection.prepare(`
        SELECT DISTINCT card_type, item_type, item_id
        FROM review_events
        WHERE label != 'skipped'
    `).all();
    const reviewed_key_set = new Set(prior_events.map(ev => `${ev.card_type}::${ev.item_type}::${ev.item_id}`));

    // Load recent prompt context map for fast ingredient highlighting on every card
    const prompt_rows = database_connection.prepare(`
        SELECT
            diced_prompts.prompt_id,
            diced_prompts.image_id,
            diced_prompts.raw_prompt,
            diced_prompts.master_record_json,
            images.filename AS image_filename,
            images.diced_prompt AS image_diced_prompt
        FROM diced_prompts
        LEFT JOIN images ON diced_prompts.image_id = images.id
        ORDER BY diced_prompts.id DESC
        LIMIT ?
    `).all(candidate_fetch_cap);

    const prompt_context_by_id = new Map();
    for (const row of prompt_rows) {
        let ingredients_summary = [];
        try {
            const parsed_master = JSON.parse(row.master_record_json || '{}');
            ingredients_summary = Array.isArray(parsed_master.ingredients)
                ? parsed_master.ingredients.map(ing => ({
                    ingredient_id: ing.ingredient_id,
                    text: ing.text,
                    slot: ing.slot,
                    source: ing.source || 'prompt_extraction',
                    kind: ing.kind || 'physical_anchor'
                }))
                : [];
        } catch (json_err) {
            ingredients_summary = [];
        }
        const grounding_meta = extract_visual_grounding_metadata(row.image_diced_prompt);
        prompt_context_by_id.set(row.prompt_id, {
            prompt_id: row.prompt_id,
            image_id: row.image_id || null,
            image_filename: row.image_filename || null,
            raw_prompt: row.raw_prompt,
            length_bucket: classify_prompt_length_bucket(row.raw_prompt),
            dataset_split: assign_deterministic_dataset_split(row.prompt_id, 0.2),
            visual_grounding: grounding_meta,
            ingredients: ingredients_summary
        });
    }

    const primary_candidates = [];
    const repeat_pool = [];

    const classify_candidate_into_bucket = (card_object) => {
        const key = `${card_object.card_type}::${card_object.item_type}::${card_object.item_id}`;
        if (reviewed_key_set.has(key)) {
            repeat_pool.push(card_object);
        } else {
            primary_candidates.push(card_object);
        }
    };

    // WHAT: Building caption-level visual grounding review cards for image-linked prompts.
    // WHY: Lets human reviewers verify whether an image caption accurately describes the visible pixels.
    if (requested_type === 'all' || requested_type === 'grounding_caption') {
        for (const prompt_context of prompt_context_by_id.values()) {
            if (!prompt_context.image_id) continue;
            const grounding_score = prompt_context.visual_grounding?.grounding_score ?? null;
            classify_candidate_into_bucket({
                card_key: `grounding_caption::prompt::${prompt_context.prompt_id}`,
                card_type: 'grounding_caption',
                item_type: 'prompt',
                item_id: prompt_context.prompt_id,
                prompt_id: prompt_context.prompt_id,
                image_id: prompt_context.image_id,
                image_filename: prompt_context.image_filename,
                raw_prompt: prompt_context.raw_prompt,
                ingredients: prompt_context.ingredients,
                question_text: 'Does the caption match what is actually visible in this image?',
                target_label: prompt_context.raw_prompt,
                slot: 'caption',
                source: 'prompt_extraction',
                length_bucket: prompt_context.length_bucket,
                dataset_split: prompt_context.dataset_split,
                model_confidence: Number.isFinite(Number(grounding_score)) ? Number(grounding_score) : null,
                model_version: 'ovis-omni-2048d'
            });
        }
    }

    // WHAT: Building per-ingredient grounding and controlled slot classification review cards.
    // WHY: Audits individual physical anchors and slot assignments so calibration metrics track fine-grained accuracy.
    if (requested_type === 'all' || requested_type === 'grounding_ingredient' || requested_type === 'slot_check') {
        const ingredient_rows = database_connection.prepare(`
            SELECT
                diced_ingredients.id AS row_id,
                diced_ingredients.prompt_id,
                diced_ingredients.ingredient_id,
                diced_ingredients.kind,
                diced_ingredients.source,
                diced_ingredients.text,
                diced_ingredients.slot,
                diced_ingredients.is_reviewed
            FROM diced_ingredients
            ORDER BY diced_ingredients.id DESC
            LIMIT ?
        `).all(candidate_fetch_cap * 2);

        for (const ingredient_row of ingredient_rows) {
            const prompt_context = prompt_context_by_id.get(ingredient_row.prompt_id);
            if (!prompt_context) continue;

            if ((requested_type === 'all' || requested_type === 'grounding_ingredient') && prompt_context.image_id && ingredient_row.kind === 'physical_anchor') {
                const per_ingredient_match = Array.isArray(prompt_context.visual_grounding?.ingredient_grounding?.ingredients)
                    ? prompt_context.visual_grounding.ingredient_grounding.ingredients.find(
                        entry => entry.ingredient_id === ingredient_row.ingredient_id || entry.text === ingredient_row.text
                    )
                    : null;
                classify_candidate_into_bucket({
                    card_key: `grounding_ingredient::ingredient::diced_ingredients:${ingredient_row.row_id}`,
                    card_type: 'grounding_ingredient',
                    item_type: 'ingredient',
                    item_id: `diced_ingredients:${ingredient_row.row_id}`,
                    prompt_id: prompt_context.prompt_id,
                    image_id: prompt_context.image_id,
                    image_filename: prompt_context.image_filename,
                    raw_prompt: prompt_context.raw_prompt,
                    ingredients: prompt_context.ingredients,
                    target_ingredient_id: ingredient_row.ingredient_id,
                    target_text: ingredient_row.text,
                    question_text: `Is "${ingredient_row.text}" visibly present in the image?`,
                    slot: ingredient_row.slot,
                    source: ingredient_row.source || 'prompt_extraction',
                    length_bucket: prompt_context.length_bucket,
                    dataset_split: prompt_context.dataset_split,
                    model_confidence: per_ingredient_match ? Number(per_ingredient_match.grounding_score) : null,
                    model_version: 'ovis-omni-2048d'
                });
            }

            if (requested_type === 'all' || requested_type === 'slot_check') {
                classify_candidate_into_bucket({
                    card_key: `slot_check::ingredient::diced_ingredients:${ingredient_row.row_id}`,
                    card_type: 'slot_check',
                    item_type: 'ingredient',
                    item_id: `diced_ingredients:${ingredient_row.row_id}`,
                    prompt_id: prompt_context.prompt_id,
                    image_id: prompt_context.image_id,
                    image_filename: prompt_context.image_filename,
                    raw_prompt: prompt_context.raw_prompt,
                    ingredients: prompt_context.ingredients,
                    target_ingredient_id: ingredient_row.ingredient_id,
                    target_text: ingredient_row.text,
                    question_text: `Does "${ingredient_row.text}" belong in the \`${ingredient_row.slot}\` slot?`,
                    slot: ingredient_row.slot,
                    source: ingredient_row.source || 'prompt_extraction',
                    length_bucket: prompt_context.length_bucket,
                    dataset_split: prompt_context.dataset_split,
                    model_confidence: null,
                    model_version: ingredient_row.source === 'ovis_facet' ? 'ovis-facet-fallback' : 'heuristic-pass-b'
                });
            }
        }
    }

    // WHAT: Building directed Pass D influence edge verification cards.
    // WHY: Confirms whether causal relationships between source and target ingredients reflect genuine physical constraints.
    if (requested_type === 'all' || requested_type === 'edge_check') {
        const edge_rows = database_connection.prepare(`
            SELECT
                diced_influences.id AS row_id,
                diced_influences.prompt_id,
                diced_influences.source_ingredient_id,
                diced_influences.target_ingredient_id,
                diced_influences.state_key,
                diced_influences.applied_state_value,
                diced_influences.consequence_description,
                src_ing.text AS source_text,
                src_ing.slot AS source_slot,
                tgt_ing.text AS target_text,
                tgt_ing.slot AS target_slot
            FROM diced_influences
            LEFT JOIN diced_ingredients AS src_ing
                ON src_ing.prompt_id = diced_influences.prompt_id
                AND src_ing.ingredient_id = diced_influences.source_ingredient_id
            LEFT JOIN diced_ingredients AS tgt_ing
                ON tgt_ing.prompt_id = diced_influences.prompt_id
                AND tgt_ing.ingredient_id = diced_influences.target_ingredient_id
            ORDER BY diced_influences.id DESC
            LIMIT ?
        `).all(candidate_fetch_cap);

        for (const edge_row of edge_rows) {
            const prompt_context = prompt_context_by_id.get(edge_row.prompt_id);
            if (!prompt_context || !edge_row.source_text || !edge_row.target_text) continue;
            classify_candidate_into_bucket({
                card_key: `edge_check::influence::diced_influences:${edge_row.row_id}`,
                card_type: 'edge_check',
                item_type: 'influence',
                item_id: `diced_influences:${edge_row.row_id}`,
                prompt_id: prompt_context.prompt_id,
                image_id: prompt_context.image_id,
                image_filename: prompt_context.image_filename,
                raw_prompt: prompt_context.raw_prompt,
                ingredients: prompt_context.ingredients,
                source_text: edge_row.source_text,
                target_text: edge_row.target_text,
                target_ingredient_id: edge_row.source_ingredient_id,
                secondary_ingredient_id: edge_row.target_ingredient_id,
                state_key: edge_row.state_key,
                applied_state_value: edge_row.applied_state_value,
                question_text: `"${edge_row.source_text}" → "${edge_row.target_text}" (${edge_row.state_key} = ${edge_row.applied_state_value}): is this physical link real?`,
                slot: edge_row.source_slot || 'other',
                source: 'prompt_extraction',
                length_bucket: prompt_context.length_bucket,
                dataset_split: prompt_context.dataset_split,
                model_confidence: null,
                model_version: 'heuristic-pass-d'
            });
        }
    }

    // WHAT: Building missing-edge recall probe cards for multi-ingredient prompts.
    // WHY: Measures whether the Pass D extractor missed real physical interactions between unlinked ingredients.
    if (requested_type === 'all' || requested_type === 'missing_edge') {
        for (const prompt_context of prompt_context_by_id.values()) {
            if (prompt_context.ingredients.length < 2) continue;
            classify_candidate_into_bucket({
                card_key: `missing_edge::missing_edge_probe::${prompt_context.prompt_id}`,
                card_type: 'missing_edge',
                item_type: 'missing_edge_probe',
                item_id: prompt_context.prompt_id,
                prompt_id: prompt_context.prompt_id,
                image_id: prompt_context.image_id,
                image_filename: prompt_context.image_filename,
                raw_prompt: prompt_context.raw_prompt,
                ingredients: prompt_context.ingredients,
                question_text: 'Does any ingredient here physically imply another unlinked ingredient in this prompt?',
                slot: 'missing_edge',
                source: 'prompt_extraction',
                length_bucket: prompt_context.length_bucket,
                dataset_split: prompt_context.dataset_split,
                model_confidence: null,
                model_version: 'heuristic-pass-d'
            });
        }
    }

    const ordered_cards = build_stratified_review_queue_order(primary_candidates, repeat_pool, {
        ordering: ordering_mode,
        limit: queue_limit,
        repeat_fraction: 0.05,
        seed
    });

    const analytics = get_calibration_dashboard_summary(database_connection);

    return Object.freeze({
        cards: ordered_cards,
        candidate_count: primary_candidates.length,
        repeat_pool_size: repeat_pool.length,
        ordering: ordering_mode,
        sitting_progress: analytics.sitting_progress
    });
}

/**
 * WHAT: Appends an immutable event row to `review_events` and updates per-item review flags (`diced_ingredients`, `diced_influences`).
 * WHY: Guarantees an auditable time-stamped ledger for calibration plots while allowing granular `reviewed_only` JSONL training exports.
 *
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} event_payload - Submitted label event from UI or API.
 * @returns {Object} Frozen result `{ success, event_id, dataset_split }`.
 */
export function append_review_event_and_sync_item(database_connection, event_payload = {}) {
    const prompt_id = String(event_payload.prompt_id || '').trim();
    const card_type = String(event_payload.card_type || '').trim();
    const item_type = String(event_payload.item_type || '').trim();
    const item_id = String(event_payload.item_id || '').trim();
    const label = String(event_payload.label || '').trim();

    if (!prompt_id || !card_type || !item_type || !item_id || !label) {
        throw new Error('prompt_id, card_type, item_type, item_id, and label are required.');
    }

    const dataset_split = assign_deterministic_dataset_split(prompt_id, 0.2);
    const corrected_json = event_payload.corrected_value && typeof event_payload.corrected_value === 'object'
        ? JSON.stringify(event_payload.corrected_value)
        : (typeof event_payload.corrected_value_json === 'string' ? event_payload.corrected_value_json : null);

    const run_event_transaction = database_connection.transaction(() => {
        const insert_stmt = database_connection.prepare(`
            INSERT INTO review_events (
                card_type, item_type, item_id, prompt_id, image_id, label,
                corrected_value_json, reviewer, model_confidence, model_version,
                dataset_split, is_repeat_check
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insert_info = insert_stmt.run(
            card_type,
            item_type,
            item_id,
            prompt_id,
            Number.isSafeInteger(Number(event_payload.image_id)) ? Number(event_payload.image_id) : null,
            label,
            corrected_json,
            String(event_payload.reviewer || 'curator'),
            Number.isFinite(Number(event_payload.model_confidence)) ? Number(event_payload.model_confidence) : null,
            event_payload.model_version ? String(event_payload.model_version) : null,
            dataset_split,
            event_payload.is_repeat_check ? 1 : 0
        );

        // Apply per-item updates on non-skipped, non-repeat reviews
        if (label !== 'skipped' && !event_payload.is_repeat_check) {
            if (item_type === 'ingredient' && item_id.startsWith('diced_ingredients:')) {
                const numeric_ing_id = Number(item_id.split(':')[1]);
                if (Number.isSafeInteger(numeric_ing_id) && numeric_ing_id > 0) {
                    if (card_type === 'slot_check' && label === 'corrected_slot' && event_payload.corrected_value?.new_slot) {
                        database_connection.prepare(`
                            UPDATE diced_ingredients
                            SET slot = ?, is_reviewed = 1
                            WHERE id = ?
                        `).run(String(event_payload.corrected_value.new_slot), numeric_ing_id);
                    } else {
                        database_connection.prepare('UPDATE diced_ingredients SET is_reviewed = 1 WHERE id = ?').run(numeric_ing_id);
                    }
                }
            } else if (item_type === 'influence' && item_id.startsWith('diced_influences:')) {
                const numeric_inf_id = Number(item_id.split(':')[1]);
                if (Number.isSafeInteger(numeric_inf_id) && numeric_inf_id > 0) {
                    const is_confirmed = label === 'confirmed' ? 1 : 0;
                    database_connection.prepare(`
                        UPDATE diced_influences
                        SET is_reviewed = 1, is_verified = ?
                        WHERE id = ?
                    `).run(is_confirmed, numeric_inf_id);
                }
            } else if (card_type === 'missing_edge' && label === 'added_edge' && event_payload.corrected_value) {
                const edge_data = event_payload.corrected_value;
                if (edge_data.source_ingredient_id && edge_data.target_ingredient_id && edge_data.state_key && edge_data.applied_state_value) {
                    database_connection.prepare(`
                        INSERT INTO diced_influences (
                            prompt_id, source_ingredient_id, target_ingredient_id, interaction_type,
                            portable_target_slot, target_subject_scope, consequence_description,
                            state_key, applied_state_value, clashes_with_value, is_verified, is_reviewed
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
                    `).run(
                        prompt_id,
                        String(edge_data.source_ingredient_id),
                        String(edge_data.target_ingredient_id),
                        String(edge_data.interaction_type || 'surface_physical'),
                        String(edge_data.portable_target_slot || 'other'),
                        String(edge_data.target_subject_scope || 'whole_frame'),
                        String(edge_data.consequence_description || `${edge_data.state_key}: ${edge_data.applied_state_value}`),
                        String(edge_data.state_key),
                        String(edge_data.applied_state_value),
                        String(edge_data.clashes_with_value || 'none')
                    );
                }
            }
        }

        return insert_info.lastInsertRowid;
    });

    const new_event_id = run_event_transaction();
    return Object.freeze({
        success: true,
        event_id: Number(new_event_id),
        dataset_split
    });
}

/**
 * WHAT: Reads all `review_events` from SQLite and returns grounding histograms, Laya calibration bands, and Pass D edge recall metrics.
 * WHY: Backs the Review Calibration Dashboard so cutoff adjustments and post-fine-tune evaluations are grounded in real reviewed data.
 *
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @returns {Object} Frozen calibration analytics object.
 */
export function get_calibration_dashboard_summary(database_connection) {
    const all_events = database_connection.prepare(`
        SELECT id, card_type, item_type, item_id, prompt_id, image_id, label,
               model_confidence, model_version, dataset_split, is_repeat_check, created_at
        FROM review_events
        ORDER BY id ASC
    `).all();

    return compute_calibration_and_grounding_analytics(all_events);
}

