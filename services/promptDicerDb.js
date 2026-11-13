/**
 * Prompt Dicer Database Access Layer (SQLite Repository)
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 * Pure Functional Architecture is enforced: database connection is passed explicitly as an argument,
 * no classes or `this` for domain models, and queries return immutable frozen records.
 */

import {
    ALLOWED_INGREDIENT_SLOTS,
    DEFAULT_TRANSPLANT_LOCKED_SLOTS,
    build_stratified_review_queue_order,
    classify_caption_visual_grounding,
    compute_calibration_and_grounding_analytics,
    compute_normalized_vector_cosine_similarity,
    execute_prompt_dicing_pipeline,
    extract_prompts_from_image_records,
    format_deterministic_prompt_identifier,
    score_per_ingredient_visual_grounding
} from './promptDicerService.js';
import { ovis_omni_client_instance } from './ovisOmniClient.js';

// ============================================================================
// 1. TABLE INITIALIZATION & MIGRATIONS
// ============================================================================
export {
    initialize_prompt_dicer_tables,
    assign_deterministic_dataset_split,
    classify_prompt_length_bucket,
    extract_visual_grounding_metadata
} from "./promptDicer/dbSchema.js";
import {
    initialize_prompt_dicer_tables,
    assign_deterministic_dataset_split,
    classify_prompt_length_bucket,
    extract_visual_grounding_metadata
} from "./promptDicer/dbSchema.js";


// ============================================================================
// 2. TRANSACTIONAL PERSISTENCE (SYNCED WITH IMAGES TABLE)
// ============================================================================

/**
 * WHAT: Atomically persists a diced prompt master record, its ingredients, its influence edges,
 *       and synchronizes the Master Record directly onto the `images` row (`images.diced_prompt` and `images.analysis.diced_prompt`).
 * WHY: We use a database transaction to guarantee that the `images` entry in `images.db`, the `diced_prompts`
 *      record, individual ingredients, and influence relationships stay 100% in sync without orphaned rows.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} master_record - The Pass C/D master record object.
 * @param {ReadonlyArray<Object>} influences_collection - Influences from Pass D.
 * @param {number|null} image_identifier - Optional foreign key image ID from images table.
 * @returns {Object} Inserted summary record.
 */
export function save_diced_prompt_record(
    database_connection,
    master_record,
    influences_collection = [],
    image_identifier = null
) {
    const normalized_influences = Array.isArray(influences_collection) && influences_collection.length > 0
        ? influences_collection
        : (Array.isArray(master_record?.influences) ? master_record.influences : []);

    const canonical_prompt_identifier = image_identifier
        ? format_deterministic_prompt_identifier(image_identifier, master_record.prompt_id)
        : master_record.prompt_id;

    const complete_master_record = Object.freeze({
        ...master_record,
        prompt_id: canonical_prompt_identifier,
        influences: Object.freeze([...normalized_influences])
    });

    const serialized_master_record_json = JSON.stringify(complete_master_record);
    const serialized_influences_json = JSON.stringify(normalized_influences);

    const delete_previous_image_prompts_statement = database_connection.prepare(`
        DELETE FROM diced_prompts WHERE image_id = ? AND prompt_id != ?
    `);

    const insert_prompt_statement = database_connection.prepare(`
        INSERT OR REPLACE INTO diced_prompts (
            prompt_id, image_id, media_type, raw_prompt,
            physical_anchor_count, pretext_term_count, physicality_ratio,
            master_record_json, influences_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const delete_existing_ingredients_statement = database_connection.prepare(`
        DELETE FROM diced_ingredients WHERE prompt_id = ?
    `);

    const insert_ingredient_statement = database_connection.prepare(`
        INSERT INTO diced_ingredients (
            prompt_id, ingredient_id, kind, source, text, slot,
            bound_to_subject_id, measured_number, measured_unit,
            observable_replacement_text, replacement_slot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const delete_existing_influences_statement = database_connection.prepare(`
        DELETE FROM diced_influences WHERE prompt_id = ?
    `);

    const insert_influence_statement = database_connection.prepare(`
        INSERT INTO diced_influences (
            prompt_id, source_ingredient_id, target_ingredient_id,
            interaction_type, portable_target_slot, target_subject_scope,
            consequence_description, state_key, applied_state_value,
            clashes_with_value, is_verified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const execute_save_transaction = database_connection.transaction(() => {
        // 0. If linked to an image_id, remove any stale random prompt_id rows for the same image
        if (image_identifier !== null && image_identifier !== undefined) {
            delete_previous_image_prompts_statement.run(image_identifier, canonical_prompt_identifier);
        }

        // 1. Insert or update diced_prompts
        insert_prompt_statement.run(
            canonical_prompt_identifier,
            image_identifier,
            complete_master_record.media_type,
            complete_master_record.raw_prompt,
            complete_master_record.metrics.physical_anchor_count,
            complete_master_record.metrics.pretext_term_count,
            complete_master_record.metrics.physicality_ratio,
            serialized_master_record_json,
            serialized_influences_json
        );

        // 2. Clear old ingredients for this prompt
        delete_existing_ingredients_statement.run(canonical_prompt_identifier);

        // 3. Insert each ingredient
        for (const ingredient_item of complete_master_record.ingredients) {
            insert_ingredient_statement.run(
                canonical_prompt_identifier,
                ingredient_item.ingredient_id,
                ingredient_item.kind,
                ingredient_item.source || 'prompt_extraction',
                ingredient_item.text,
                ingredient_item.slot,
                ingredient_item.bound_to_subject_id || null,
                ingredient_item.measured_value?.number ?? null,
                ingredient_item.measured_value?.unit || null,
                ingredient_item.observable_replacement?.text || null,
                ingredient_item.observable_replacement?.replacement_slot || null
            );
        }

        // 4. Clear old influences for this prompt
        delete_existing_influences_statement.run(canonical_prompt_identifier);

        // 5. Insert each influence edge
        for (const influence_item of normalized_influences) {
            insert_influence_statement.run(
                canonical_prompt_identifier,
                influence_item.source_ingredient_id,
                influence_item.target_ingredient_id,
                influence_item.interaction_type,
                influence_item.portable_target_slot,
                influence_item.target_subject_scope,
                influence_item.consequence_description,
                influence_item.state_key,
                influence_item.applied_state_value,
                influence_item.clashes_with_value
            );
        }

        // 6. Synchronize directly onto the `images` table row in `images.db`
        if (image_identifier !== null && image_identifier !== undefined) {
            try {
                const existing_image_row = database_connection
                    .prepare('SELECT analysis FROM images WHERE id = ?')
                    .get(image_identifier);

                if (existing_image_row) {
                    const parsed_existing_analysis = (() => {
                        try {
                            return typeof existing_image_row.analysis === 'string'
                                ? JSON.parse(existing_image_row.analysis || '{}')
                                : (existing_image_row.analysis || {});
                        } catch (analysis_parse_error) {
                            return {};
                        }
                    })();

                    const enriched_analysis_payload = {
                        ...parsed_existing_analysis,
                        diced_prompt: complete_master_record
                    };

                    try {
                        database_connection
                            .prepare('UPDATE images SET diced_prompt = ?, analysis = ? WHERE id = ?')
                            .run(
                                serialized_master_record_json,
                                JSON.stringify(enriched_analysis_payload),
                                image_identifier
                            );
                    } catch (missing_column_error) {
                        // Fallback if diced_prompt column was not added yet
                        database_connection
                            .prepare('UPDATE images SET analysis = ? WHERE id = ?')
                            .run(JSON.stringify(enriched_analysis_payload), image_identifier);
                    }
                }
            } catch (images_table_sync_error) {
                // Ignore if `images` table is absent in isolated unit test schemas
            }
        }
    });

    execute_save_transaction();

    return Object.freeze({
        success: true,
        prompt_id: canonical_prompt_identifier,
        image_id: image_identifier,
        physical_anchor_count: complete_master_record.metrics.physical_anchor_count,
        pretext_term_count: complete_master_record.metrics.pretext_term_count,
        physicality_ratio: complete_master_record.metrics.physicality_ratio,
        ingredient_count: complete_master_record.ingredients.length,
        influence_count: normalized_influences.length
    });
}

/**
 * WHAT: Deterministically resolves the canonical source prompt text and visual context from an `images` row.
 * WHY: Both `dice_and_save_image_record` and `validate_and_repair_diced_prompts` must resolve the exact same
 *      canonical prompt string so any edit to `images.analysis` or `images.metadata` is immediately detected as stale.
 * 
 * @param {Object} image_row - Row from `images` table (`id`, `filename`, `metadata`, `analysis`).
 * @returns {Object} Frozen `{ prompt_text, image_context, parsed_analysis }`.
 */
export function resolve_expected_prompt_for_image_row(image_row) {
    const parsed_analysis = (() => {
        try {
            return typeof image_row?.analysis === 'string'
                ? JSON.parse(image_row.analysis || '{}')
                : (image_row?.analysis || {});
        } catch (parse_error) {
            return {};
        }
    })();

    const candidate_prompts = extract_prompts_from_image_records(image_row?.metadata, parsed_analysis);
    const fallback_summary_text = parsed_analysis.summary
        || (Array.isArray(parsed_analysis.tags) && parsed_analysis.tags.length > 0 ? parsed_analysis.tags.join(', ') : '')
        || image_row?.filename
        || `Image #${image_row?.id ?? 0}`;

    const resolved_prompt_text = String(
        candidate_prompts.length > 0 ? candidate_prompts[0].prompt_text : fallback_summary_text
    ).trim();

    const image_context_payload = Object.freeze({
        objects: Array.isArray(parsed_analysis.objects) ? parsed_analysis.objects : [],
        tags: Array.isArray(parsed_analysis.tags) ? parsed_analysis.tags : [],
        scene_type: typeof parsed_analysis.scene_type === 'string' ? parsed_analysis.scene_type : ''
    });

    return Object.freeze({
        prompt_text: resolved_prompt_text,
        image_context: image_context_payload,
        parsed_analysis
    });
}

/**
 * WHAT: Extracts the best prompt/caption and visual context from an `images` row, runs the Pass A–D
 *       Prompt Dicer pipeline, and saves the structured Master Record back to both `images` and `diced_prompts`.
 * WHY: Provides a single reusable function for `/api/dicer/dice`, `/batch-analyze`, `/save`, `/re-analyze`, and validation.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} image_row - Row from `images` table (`id`, `filename`, `metadata`, `analysis`).
 * @param {Object} pipeline_options - Optional overrides (`prompt_text`, `force_heuristic`, `run_pass_d_influences`, `llm_completion_adapter`).
 * @returns {Promise<Object>} Diced result and updated image analysis object.
 */
/**
 * WHAT: Reads the Ovis-Omni visual facet record from `image_facets` for a given image ID if present.
 * WHY: Provides visual medium, mood, and composition fallbacks during dicing while staying safe if isolated unit test schemas omit `image_facets`.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {number|string|null} image_identifier - Image ID to query.
 * @returns {Object|null} Frozen facet record or null.
 */
export function read_image_facet_record(database_connection, image_identifier) {
    const numeric_image_identifier = Number(image_identifier);
    if (!database_connection || !Number.isSafeInteger(numeric_image_identifier) || numeric_image_identifier <= 0) {
        return null;
    }

    try {
        const facet_row = database_connection.prepare(`
            SELECT medium, mood, composition, detail_score,
                   confidence_medium, confidence_mood, confidence_composition
            FROM image_facets
            WHERE image_id = ?
        `).get(numeric_image_identifier);

        return facet_row ? Object.freeze({ ...facet_row }) : null;
    } catch (facet_query_error) {
        return null;
    }
}

/**
 * WHAT: Evaluates whether an image's caption/summary aligns optically with its pixels using Ovis-Omni's unified 2048-dim vector space.
 * WHY: Detects hallucinated, stale, or mismatched text descriptions before trusting diced prompt structures, gracefully skipping when port 8082 is offline.
 * 
 * @param {Object} image_row - Row from `images` (`id`, `path`, `filename`).
 * @param {string} caption_text - Text summary or prompt to verify against image pixels.
 * @param {Object} grounding_options - Optional `{ ovis_client, cached_ovis_embeddings_map }`.
 * @returns {Promise<Object>} Grounding check payload (`checked`, `grounding_score`, `grounding_status`, `needs_reanalysis`).
 */
export async function evaluate_caption_visual_grounding_for_image(
    image_row,
    caption_text,
    grounding_options = {}
) {
    const active_ovis_client = grounding_options.ovis_client || ovis_omni_client_instance;
    const cached_embeddings_map = grounding_options.cached_ovis_embeddings_map || null;
    const trimmed_caption = typeof caption_text === 'string' ? caption_text.trim() : '';

    if (!image_row || !trimmed_caption) {
        return Object.freeze({ checked: false, reason: 'missing_image_or_caption' });
    }

    try {
        const is_ovis_online = await active_ovis_client.checkHealth(false);
        if (!is_ovis_online) {
            return Object.freeze({ checked: false, reason: 'ovis_offline' });
        }

        const cached_vector = cached_embeddings_map && image_row.id !== undefined
            ? cached_embeddings_map[String(image_row.id)]
            : null;
        const used_cached_image_vector = Array.isArray(cached_vector) && cached_vector.length > 0;

        const image_vector = used_cached_image_vector
            ? cached_vector
            : (image_row.path
                ? await active_ovis_client.generateImageEmbedding(image_row.path)
                : null);

        if (!Array.isArray(image_vector) || image_vector.length === 0) {
            return Object.freeze({ checked: false, reason: 'image_vector_unavailable' });
        }

        const caption_text_vector = await active_ovis_client.generateTextEmbedding(trimmed_caption);
        const cosine_similarity_score = compute_normalized_vector_cosine_similarity(
            image_vector,
            caption_text_vector
        );
        const grounding_verdict = classify_caption_visual_grounding(
            cosine_similarity_score,
            grounding_options.thresholds
        );

        let ingredient_grounding_summary = null;
        const candidate_ingredients = Array.isArray(grounding_options.ingredients)
            ? grounding_options.ingredients
            : [];
        const include_per_ingredient = grounding_options.include_per_ingredient !== false && candidate_ingredients.length > 0;

        if (include_per_ingredient) {
            const max_ingredient_checks = Math.max(1, Math.min(24, Number(grounding_options.max_ingredient_checks) || 16));
            const unique_anchor_entries = [];
            const seen_texts = new Set();

            for (const item of candidate_ingredients) {
                if (!item || !item.text || item.source === 'ovis_facet' || item.kind === 'pretext_term') continue;
                const clean_text = String(item.text).trim();
                const lower_key = clean_text.toLowerCase();
                if (!clean_text || seen_texts.has(lower_key)) continue;
                seen_texts.add(lower_key);
                unique_anchor_entries.push(item);
                if (unique_anchor_entries.length >= max_ingredient_checks) break;
            }

            const embedded_ingredient_entries = [];
            for (const item of unique_anchor_entries) {
                try {
                    const ingredient_text_vector = await active_ovis_client.generateTextEmbedding(item.text);
                    if (Array.isArray(ingredient_text_vector) && ingredient_text_vector.length > 0) {
                        embedded_ingredient_entries.push({
                            ...item,
                            vector: ingredient_text_vector
                        });
                    }
                } catch (ingredient_embed_error) {
                    // Skip individual embedding failure without aborting caption check
                }
            }

            if (embedded_ingredient_entries.length > 0) {
                ingredient_grounding_summary = score_per_ingredient_visual_grounding(
                    image_vector,
                    embedded_ingredient_entries,
                    grounding_options.ingredient_thresholds
                );
            }
        }

        return Object.freeze({
            checked: true,
            image_id: image_row.id ?? null,
            filename: image_row.filename || null,
            used_cached_image_vector,
            ...grounding_verdict,
            ...(ingredient_grounding_summary ? {
                ingredient_grounding: ingredient_grounding_summary,
                missing_ingredients: ingredient_grounding_summary.missing_ingredients
            } : {})
        });
    } catch (grounding_error) {
        return Object.freeze({
            checked: false,
            reason: 'grounding_error',
            error: grounding_error.message
        });
    }
}

/**
 * WHAT: Extracts the target prompt from an image row, executes the Pass A–D dicing pipeline, and persists the result.
 * WHY: Centralizes single-image dicing so HTTP routes, batch repair jobs, and post-analysis hooks share identical
 *      Ovis facet fallback enrichment, visual grounding checks, and database transaction guarantees.
 *
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} image_row - Row from the `images` table.
 * @param {Object} [pipeline_options={}] - Optional prompt override, LLM flags, and grounding checks.
 * @returns {Promise<Object>} Saved master record and metadata summary.
 */
export async function dice_and_save_image_record(
    database_connection,
    image_row,
    pipeline_options = {}
) {
    const expected_source_resolution = resolve_expected_prompt_for_image_row(image_row);
    const selected_prompt_text = (typeof pipeline_options.prompt_text === 'string' && pipeline_options.prompt_text.trim().length > 0)
        ? pipeline_options.prompt_text.trim()
        : expected_source_resolution.prompt_text;

    const deterministic_prompt_id = format_deterministic_prompt_identifier(image_row.id, pipeline_options.prompt_id);
    const include_ovis_facets = pipeline_options.include_ovis_facets !== false;
    const ovis_facets_record = include_ovis_facets
        ? (pipeline_options.ovis_facets || read_image_facet_record(database_connection, image_row.id))
        : null;

    const dicing_pipeline_result = await execute_prompt_dicing_pipeline({
        prompt_text: selected_prompt_text,
        media_type: pipeline_options.media_type === 'video' ? 'video' : 'image',
        prompt_id: deterministic_prompt_id,
        image_id: image_row.id,
        image_context: expected_source_resolution.image_context,
        ovis_facets: ovis_facets_record,
        mark_ovis_sync_attempted: include_ovis_facets,
        laya_decide_adapter: pipeline_options.laya_decide_adapter || null,
        laya_gate_options: pipeline_options.laya_gate_options,
        llm_completion_adapter: pipeline_options.llm_completion_adapter || null,
        run_pass_d_influences: pipeline_options.run_pass_d_influences !== false,
        force_heuristic: Boolean(pipeline_options.force_heuristic)
    });

    const visual_grounding_result = pipeline_options.check_visual_grounding
        ? await evaluate_caption_visual_grounding_for_image(
            image_row,
            selected_prompt_text,
            {
                ovis_client: pipeline_options.ovis_client,
                cached_ovis_embeddings_map: pipeline_options.cached_ovis_embeddings_map,
                ingredients: dicing_pipeline_result.master_record.ingredients,
                include_per_ingredient: pipeline_options.check_ingredient_grounding !== false
            }
        )
        : null;

    const persisted_master_record = (visual_grounding_result && visual_grounding_result.checked)
        ? Object.freeze({
            ...dicing_pipeline_result.master_record,
            visual_grounding: visual_grounding_result
        })
        : dicing_pipeline_result.master_record;

    const database_summary = save_diced_prompt_record(
        database_connection,
        persisted_master_record,
        dicing_pipeline_result.influences,
        image_row.id
    );

    const updated_analysis = Object.freeze({
        ...expected_source_resolution.parsed_analysis,
        diced_prompt: persisted_master_record
    });

    return Object.freeze({
        success: true,
        image_id: image_row.id,
        prompt_id: persisted_master_record.prompt_id,
        master_record: persisted_master_record,
        influences: dicing_pipeline_result.influences,
        visual_grounding: visual_grounding_result,
        execution_mode: dicing_pipeline_result.execution_mode,
        database_summary,
        updated_analysis
    });
}

/**
 * WHAT: Audits all images and diced prompts in SQLite to detect and repair missing, stale, desynced, or orphaned entries.
 * WHY: When image descriptions (`analysis.summary`), tags, or embedded metadata are regenerated or updated,
 *      existing diced prompts can become stale; validation ensures every entry matches its latest description.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} validation_options - Controls (`force_heuristic`, `on_progress`).
 * @returns {Promise<Object>} Summary statistics of the validation and repair pass.
 */
export async function validate_and_repair_diced_prompts(database_connection, validation_options = {}) {
    const force_heuristic_mode = validation_options.force_heuristic !== false;
    const sync_ovis_facets = Boolean(validation_options.sync_ovis_facets);
    const progress_callback = typeof validation_options.on_progress === 'function'
        ? validation_options.on_progress
        : null;

    // 1. Clean up orphaned rows in `diced_prompts` where image_id points to a deleted image
    let orphaned_cleaned_count = 0;
    try {
        const orphan_cleanup_result = database_connection.prepare(`
            DELETE FROM diced_prompts
            WHERE image_id IS NOT NULL
              AND image_id NOT IN (SELECT id FROM images)
        `).run();
        orphaned_cleaned_count = orphan_cleanup_result.changes || 0;
    } catch (orphan_cleanup_error) {
        // Ignore if images table is absent in isolated tests
    }

    const joined_image_rows = database_connection.prepare(`
        SELECT
            images.id,
            images.filename,
            images.metadata,
            images.analysis,
            images.diced_prompt,
            diced_prompts.prompt_id AS existing_prompt_id,
            diced_prompts.raw_prompt AS existing_raw_prompt,
            diced_prompts.master_record_json AS existing_master_record_json
        FROM images
        LEFT JOIN diced_prompts ON images.id = diced_prompts.image_id
        ORDER BY images.id ASC
    `).all();

    let valid_count = 0;
    let missing_repaired_count = 0;
    let stale_re_diced_count = 0;
    let desynced_repaired_count = 0;
    let ovis_enriched_count = 0;
    const processed_total = joined_image_rows.length;

    for (let row_index = 0; row_index < joined_image_rows.length; row_index++) {
        const image_row = joined_image_rows[row_index];
        if (progress_callback && row_index % 100 === 0) {
            progress_callback(row_index, processed_total);
        }

        const expected_source = resolve_expected_prompt_for_image_row(image_row);
        const expected_prompt_id = format_deterministic_prompt_identifier(image_row.id);

        const parsed_column_diced = (() => {
            try {
                return typeof image_row.diced_prompt === 'string' && image_row.diced_prompt.trim()
                    ? JSON.parse(image_row.diced_prompt)
                    : null;
            } catch (column_parse_error) {
                return null;
            }
        })();

        const has_diced_table_row = Boolean(image_row.existing_prompt_id && image_row.existing_master_record_json);
        const has_image_column_diced = Boolean(parsed_column_diced && parsed_column_diced.prompt_id);
        const has_analysis_diced = Boolean(
            expected_source.parsed_analysis?.diced_prompt && expected_source.parsed_analysis.diced_prompt.prompt_id
        );

        const is_missing_anywhere = !has_diced_table_row || !has_image_column_diced || !has_analysis_diced;
        const normalized_existing_raw = String(image_row.existing_raw_prompt || parsed_column_diced?.raw_prompt || '').trim();
        const is_stale_description = normalized_existing_raw !== expected_source.prompt_text;
        const has_legacy_prompt_id = (image_row.existing_prompt_id && image_row.existing_prompt_id !== expected_prompt_id)
            || (parsed_column_diced?.prompt_id && parsed_column_diced.prompt_id !== expected_prompt_id);

        const has_attempted_ovis_sync = Boolean(
            parsed_column_diced?.ovis_facet_sync_attempted === true ||
            Number(parsed_column_diced?.ovis_facet_fallback_count) > 0 ||
            (Array.isArray(parsed_column_diced?.ingredients) && parsed_column_diced.ingredients.some(item => item.source === 'ovis_facet'))
        );
        const needs_ovis_facet_sync = sync_ovis_facets && !has_attempted_ovis_sync;

        if (is_stale_description && has_diced_table_row) {
            await dice_and_save_image_record(database_connection, image_row, {
                run_pass_d_influences: true,
                force_heuristic: force_heuristic_mode,
                include_ovis_facets: sync_ovis_facets || has_attempted_ovis_sync
            });
            stale_re_diced_count++;
        } else if (!has_diced_table_row) {
            await dice_and_save_image_record(database_connection, image_row, {
                run_pass_d_influences: true,
                force_heuristic: force_heuristic_mode,
                include_ovis_facets: sync_ovis_facets || true
            });
            missing_repaired_count++;
        } else if (is_missing_anywhere || has_legacy_prompt_id) {
            await dice_and_save_image_record(database_connection, image_row, {
                run_pass_d_influences: true,
                force_heuristic: force_heuristic_mode,
                include_ovis_facets: sync_ovis_facets || has_attempted_ovis_sync
            });
            desynced_repaired_count++;
        } else if (needs_ovis_facet_sync) {
            await dice_and_save_image_record(database_connection, image_row, {
                run_pass_d_influences: true,
                force_heuristic: force_heuristic_mode,
                include_ovis_facets: true
            });
            ovis_enriched_count++;
        } else {
            valid_count++;
        }
    }

    return Object.freeze({
        total_images: processed_total,
        valid_count,
        missing_repaired_count,
        stale_re_diced_count,
        desynced_repaired_count,
        ovis_enriched_count,
        orphaned_cleaned_count
    });
}

// ============================================================================
// 3. QUERY OPERATIONS
// ============================================================================

/**
 * WHAT: Retrieves a paginated list of diced prompts, optionally filtered by prompt ID, filename, or prompt text.
 * WHY: Displays the catalog overview and powers the Remix Workbench prompt picker across all library images.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {number} limit_count - Maximum items to return.
 * @param {number} offset_count - Pagination offset.
 * @param {string} search_query - Optional substring search filter.
 * @returns {ReadonlyArray<Object>} List of summary records.
 */
export function get_all_diced_prompts(database_connection, limit_count = 50, offset_count = 0, search_query = '') {
    const trimmed_query = typeof search_query === 'string' ? search_query.trim() : '';
    const safe_limit = Math.max(1, Math.min(200, Number(limit_count) || 50));
    const safe_offset = Math.max(0, Number(offset_count) || 0);

    if (trimmed_query.length > 0) {
        const like_pattern = `%${trimmed_query}%`;
        try {
            const filtered_statement = database_connection.prepare(`
                SELECT 
                    diced_prompts.id,
                    diced_prompts.prompt_id,
                    diced_prompts.image_id,
                    diced_prompts.media_type,
                    diced_prompts.raw_prompt,
                    diced_prompts.physical_anchor_count,
                    diced_prompts.pretext_term_count,
                    diced_prompts.physicality_ratio,
                    diced_prompts.is_reviewed,
                    diced_prompts.created_at,
                    diced_prompts.updated_at,
                    images.filename AS image_filename
                FROM diced_prompts
                LEFT JOIN images ON diced_prompts.image_id = images.id
                WHERE diced_prompts.prompt_id LIKE ?
                   OR diced_prompts.raw_prompt LIKE ?
                   OR COALESCE(images.filename, '') LIKE ?
                ORDER BY diced_prompts.updated_at DESC, diced_prompts.id DESC
                LIMIT ? OFFSET ?
            `);
            const filtered_rows = filtered_statement.all(like_pattern, like_pattern, like_pattern, safe_limit, safe_offset);
            return Object.freeze(filtered_rows.map(row => Object.freeze(row)));
        } catch (filter_fallback_error) {
            const fallback_filtered = database_connection.prepare(`
                SELECT 
                    id, prompt_id, image_id, media_type, raw_prompt,
                    physical_anchor_count, pretext_term_count, physicality_ratio,
                    is_reviewed, created_at, updated_at
                FROM diced_prompts
                WHERE prompt_id LIKE ? OR raw_prompt LIKE ?
                ORDER BY updated_at DESC, id DESC
                LIMIT ? OFFSET ?
            `);
            return Object.freeze(fallback_filtered.all(like_pattern, like_pattern, safe_limit, safe_offset).map(row => Object.freeze(row)));
        }
    }

    const query_statement = database_connection.prepare(`
        SELECT 
            diced_prompts.id,
            diced_prompts.prompt_id,
            diced_prompts.image_id,
            diced_prompts.media_type,
            diced_prompts.raw_prompt,
            diced_prompts.physical_anchor_count,
            diced_prompts.pretext_term_count,
            diced_prompts.physicality_ratio,
            diced_prompts.is_reviewed,
            diced_prompts.created_at,
            diced_prompts.updated_at,
            images.filename AS image_filename
        FROM diced_prompts
        LEFT JOIN images ON diced_prompts.image_id = images.id
        ORDER BY diced_prompts.updated_at DESC, diced_prompts.id DESC
        LIMIT ? OFFSET ?
    `);

    try {
        const raw_rows = query_statement.all(safe_limit, safe_offset);
        return Object.freeze(raw_rows.map(row => Object.freeze(row)));
    } catch (join_fallback_error) {
        const fallback_statement = database_connection.prepare(`
            SELECT 
                id, prompt_id, image_id, media_type, raw_prompt,
                physical_anchor_count, pretext_term_count, physicality_ratio,
                is_reviewed, created_at, updated_at
            FROM diced_prompts
            ORDER BY updated_at DESC, id DESC
            LIMIT ? OFFSET ?
        `);
        const raw_rows = fallback_statement.all(safe_limit, safe_offset);
        return Object.freeze(raw_rows.map(row => Object.freeze(row)));
    }
}

/**
 * WHAT: Retrieves summary totals and distinct counts across the entire diced catalog.
 * WHY: Keeps the Prompt Dicer header stats accurate even when paginated queries return 50–250 rows.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @returns {Object} Frozen catalog summary totals.
 */
export function get_diced_catalog_statistics(database_connection) {
    const prompt_stats = database_connection.prepare(`
        SELECT 
            COUNT(*) AS total_prompts,
            COALESCE(AVG(physicality_ratio), 0) AS average_physicality_ratio
        FROM diced_prompts
    `).get() || { total_prompts: 0, average_physicality_ratio: 0 };

    const ingredient_stats = database_connection.prepare(`
        SELECT
            COUNT(*) AS total_ingredient_rows,
            COUNT(DISTINCT LOWER(TRIM(text)) || '::' || slot) AS unique_ingredients
        FROM diced_ingredients
    `).get() || { total_ingredient_rows: 0, unique_ingredients: 0 };

    const influence_stats = database_connection.prepare(`
        SELECT COUNT(*) AS total_influences FROM diced_influences
    `).get() || { total_influences: 0 };

    return Object.freeze({
        total_prompts: prompt_stats.total_prompts || 0,
        average_physicality_ratio: Number((prompt_stats.average_physicality_ratio || 0).toFixed(2)),
        total_ingredient_rows: ingredient_stats.total_ingredient_rows || 0,
        unique_ingredients: ingredient_stats.unique_ingredients || 0,
        total_influences: influence_stats.total_influences || 0
    });
}

/**
 * WHAT: Retrieves the complete Master Record and influence edges for a specific prompt ID.
 * WHY: Used by the detail view, review queue, and remix workbench.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {string} prompt_identifier - Target prompt ID (e.g., "prm_00142").
 * @returns {Object|null} Complete master record with influences or null if not found.
 */
export function get_diced_prompt_by_identifier(database_connection, prompt_identifier) {
    const query_statement = database_connection.prepare(`
        SELECT master_record_json, influences_json, is_reviewed, image_id
        FROM diced_prompts
        WHERE prompt_id = ?
    `);

    const raw_row = query_statement.get(String(prompt_identifier));
    if (!raw_row) {
        return null;
    }

    try {
        const parsed_master_record = JSON.parse(raw_row.master_record_json);
        const parsed_influences = raw_row.influences_json
            ? JSON.parse(raw_row.influences_json)
            : (Array.isArray(parsed_master_record.influences) ? parsed_master_record.influences : []);
        return Object.freeze({
            ...parsed_master_record,
            influences: Object.freeze(parsed_influences),
            is_reviewed: Boolean(raw_row.is_reviewed),
            image_id: raw_row.image_id
        });
    } catch (parse_error) {
        console.error('[PromptDicerDb] Error parsing master record JSON:', parse_error);
        return null;
    }
}

/**
 * WHAT: Retrieves deduplicated catalog ingredients filtered by slot and optional search query.
 * WHY: Powers the Remix Workbench: users can choose an ingredient slot (e.g. 'lighting' or 'lens')
 *      or search across all 14 slots without receiving duplicate entries or getting truncated before
 *      later alphabetical slots appear.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {string|null} target_slot - Optional slot filter (e.g., 'lighting', 'lens', 'weather_or_matter').
 * @param {string} search_query - Optional text filter.
 * @param {number} limit_count - Maximum grouped results to return.
 * @returns {ReadonlyArray<Object>} List of unique catalog ingredients sorted by usage frequency.
 */
export function get_ingredients_catalog_by_slot(
    database_connection,
    target_slot = null,
    search_query = '',
    limit_count = 250
) {
    const safe_limit = Math.max(1, Math.min(500, Number(limit_count) || 250));
    const trimmed_slot = (target_slot && typeof target_slot === 'string' && target_slot !== 'all')
        ? target_slot.trim()
        : null;
    const trimmed_search = typeof search_query === 'string' ? search_query.trim() : '';

    const where_clauses = [];
    const query_params = [];

    if (trimmed_slot) {
        where_clauses.push('(diced_ingredients.slot = ? OR diced_ingredients.replacement_slot = ?)');
        query_params.push(trimmed_slot, trimmed_slot);
    }
    if (trimmed_search) {
        where_clauses.push('(diced_ingredients.text LIKE ? OR COALESCE(diced_ingredients.observable_replacement_text, \'\') LIKE ?)');
        const like_pattern = `%${trimmed_search}%`;
        query_params.push(like_pattern, like_pattern);
    }

    const where_sql = where_clauses.length > 0 ? `WHERE ${where_clauses.join(' AND ')}` : '';

    const grouped_query = database_connection.prepare(`
        SELECT 
            MIN(diced_ingredients.id) AS id,
            MIN(diced_ingredients.prompt_id) AS prompt_id,
            MIN(diced_ingredients.ingredient_id) AS ingredient_id,
            diced_ingredients.kind,
            MAX(diced_ingredients.source) AS source,
            MIN(diced_ingredients.text) AS text,
            diced_ingredients.slot,
            MIN(diced_ingredients.bound_to_subject_id) AS bound_to_subject_id,
            MAX(diced_ingredients.measured_number) AS measured_number,
            MAX(diced_ingredients.measured_unit) AS measured_unit,
            MAX(diced_ingredients.observable_replacement_text) AS observable_replacement_text,
            MAX(diced_ingredients.replacement_slot) AS replacement_slot,
            MIN(diced_prompts.raw_prompt) AS source_raw_prompt,
            MIN(diced_prompts.image_id) AS image_id,
            COUNT(*) AS usage_count
        FROM diced_ingredients
        JOIN diced_prompts ON diced_ingredients.prompt_id = diced_prompts.prompt_id
        ${where_sql}
        GROUP BY diced_ingredients.slot, diced_ingredients.kind, LOWER(TRIM(diced_ingredients.text))
        ORDER BY usage_count DESC, LENGTH(MIN(diced_ingredients.text)) ASC, MIN(diced_ingredients.text) ASC
        LIMIT ?
    `);

    const rows = grouped_query.all(...query_params, safe_limit);
    return Object.freeze(rows.map(row => Object.freeze(row)));
}

/**
 * WHAT: Queries catalog ingredients ranked by visual compatibility using EVoC clusters (`image_clusters`) and optional Ovis nearest-neighbor image IDs.
 * WHY: Lets users in the Remix Workbench discover ingredients harvested from images that share visual style, lighting, or cluster topology with their active canvas pieces — without reading huge JSON embedding files per request.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} query_options - `{ reference_prompt_ids, reference_image_ids, neighbor_image_ids, target_slot, search_query, limit }`.
 * @returns {Object} Frozen `{ ingredients, cluster_labels_used, reference_image_count }`.
 */
export function get_visually_compatible_ingredients(database_connection, query_options = {}) {
    const safe_limit = Math.max(1, Math.min(500, Number(query_options.limit) || 150));
    const trimmed_slot = (query_options.target_slot && typeof query_options.target_slot === 'string' && query_options.target_slot !== 'all')
        ? query_options.target_slot.trim()
        : null;
    const trimmed_search = typeof query_options.search_query === 'string' ? query_options.search_query.trim() : '';

    const raw_prompt_ids = Array.isArray(query_options.reference_prompt_ids)
        ? query_options.reference_prompt_ids.filter(item => typeof item === 'string' && item.trim().length > 0)
        : [];
    const direct_image_ids = Array.isArray(query_options.reference_image_ids)
        ? query_options.reference_image_ids.map(Number).filter(candidate_image_id => Number.isSafeInteger(candidate_image_id) && candidate_image_id > 0)
        : [];
    const neighbor_image_ids = Array.isArray(query_options.neighbor_image_ids)
        ? query_options.neighbor_image_ids.map(Number).filter(candidate_image_id => Number.isSafeInteger(candidate_image_id) && candidate_image_id > 0)
        : [];

    // Resolve image_ids from reference prompt_ids if any were supplied
    const resolved_reference_image_ids_set = new Set(direct_image_ids);
    if (raw_prompt_ids.length > 0) {
        const prompt_placeholders = raw_prompt_ids.map(() => '?').join(', ');
        const resolved_rows = database_connection.prepare(`
            SELECT DISTINCT image_id FROM diced_prompts
            WHERE prompt_id IN (${prompt_placeholders}) AND image_id IS NOT NULL
        `).all(...raw_prompt_ids);
        for (const resolved_row of resolved_rows) {
            if (resolved_row.image_id) {
                resolved_reference_image_ids_set.add(Number(resolved_row.image_id));
            }
        }
    }

    const reference_image_ids = Array.from(resolved_reference_image_ids_set);

    // Resolve EVoC visual cluster labels for those reference images
    let cluster_labels_list = [];
    if (reference_image_ids.length > 0) {
        try {
            const image_placeholders = reference_image_ids.map(() => '?').join(', ');
            const cluster_rows = database_connection.prepare(`
                SELECT DISTINCT cluster_label
                FROM image_clusters
                WHERE image_id IN (${image_placeholders}) AND cluster_label IS NOT NULL
            `).all(...reference_image_ids);
            cluster_labels_list = cluster_rows
                .map(row => row.cluster_label)
                .filter(label => label !== null && label !== undefined && label !== '');
        } catch (cluster_lookup_error) {
            cluster_labels_list = [];
        }
    }

    if (cluster_labels_list.length === 0 && neighbor_image_ids.length === 0) {
        const fallback_ingredients = get_ingredients_catalog_by_slot(
            database_connection,
            trimmed_slot,
            trimmed_search,
            safe_limit
        );
        return Object.freeze({
            ingredients: fallback_ingredients,
            cluster_labels_used: Object.freeze([]),
            reference_image_count: reference_image_ids.length,
            visual_ranking_active: false
        });
    }

    const where_clauses = [];
    const query_params = [];

    if (trimmed_slot) {
        where_clauses.push('(diced_ingredients.slot = ? OR diced_ingredients.replacement_slot = ?)');
        query_params.push(trimmed_slot, trimmed_slot);
    }
    if (trimmed_search) {
        where_clauses.push('(diced_ingredients.text LIKE ? OR COALESCE(diced_ingredients.observable_replacement_text, \'\') LIKE ?)');
        const like_pattern = `%${trimmed_search}%`;
        query_params.push(like_pattern, like_pattern);
    }

    const visual_match_predicates = [];
    if (cluster_labels_list.length > 0) {
        const cluster_placeholders = cluster_labels_list.map(() => '?').join(', ');
        visual_match_predicates.push(`image_clusters.cluster_label IN (${cluster_placeholders})`);
        query_params.push(...cluster_labels_list);
    }
    if (neighbor_image_ids.length > 0) {
        const neighbor_placeholders = neighbor_image_ids.map(() => '?').join(', ');
        visual_match_predicates.push(`diced_prompts.image_id IN (${neighbor_placeholders})`);
        query_params.push(...neighbor_image_ids);
    }
    where_clauses.push(`(${visual_match_predicates.join(' OR ')})`);

    const where_sql = `WHERE ${where_clauses.join(' AND ')}`;

    const neighbor_case_sql = neighbor_image_ids.length > 0
        ? `SUM(CASE WHEN diced_prompts.image_id IN (${neighbor_image_ids.map(() => '?').join(', ')}) THEN 1 ELSE 0 END)`
        : '0';
    const select_params = neighbor_image_ids.length > 0 ? [...neighbor_image_ids] : [];

    const ranked_statement = database_connection.prepare(`
        SELECT
            MIN(diced_ingredients.id) AS id,
            MIN(diced_ingredients.prompt_id) AS prompt_id,
            MIN(diced_ingredients.ingredient_id) AS ingredient_id,
            diced_ingredients.kind,
            MAX(diced_ingredients.source) AS source,
            MIN(diced_ingredients.text) AS text,
            diced_ingredients.slot,
            MIN(diced_ingredients.bound_to_subject_id) AS bound_to_subject_id,
            MAX(diced_ingredients.measured_number) AS measured_number,
            MAX(diced_ingredients.measured_unit) AS measured_unit,
            MAX(diced_ingredients.observable_replacement_text) AS observable_replacement_text,
            MAX(diced_ingredients.replacement_slot) AS replacement_slot,
            MIN(diced_prompts.raw_prompt) AS source_raw_prompt,
            MIN(diced_prompts.image_id) AS image_id,
            COUNT(DISTINCT diced_prompts.prompt_id) AS usage_count,
            COUNT(DISTINCT image_clusters.cluster_label) AS cluster_match_count,
            ${neighbor_case_sql} AS neighbor_match_count
        FROM diced_ingredients
        JOIN diced_prompts ON diced_ingredients.prompt_id = diced_prompts.prompt_id
        LEFT JOIN image_clusters ON diced_prompts.image_id = image_clusters.image_id
        ${where_sql}
        GROUP BY diced_ingredients.slot, diced_ingredients.kind, LOWER(TRIM(diced_ingredients.text))
        ORDER BY neighbor_match_count DESC, cluster_match_count DESC, usage_count DESC, LENGTH(MIN(diced_ingredients.text)) ASC
        LIMIT ?
    `);

    const matched_rows = ranked_statement.all(...select_params, ...query_params, safe_limit);
    const enriched_rows = matched_rows.map(row => Object.freeze({
        ...row,
        visual_compatibility_score: Number(((Number(row.neighbor_match_count || 0) * 3) + Number(row.cluster_match_count || 0) + Math.min(2, Number(row.usage_count || 0) * 0.1)).toFixed(2)),
        compatibility_reason: Number(row.neighbor_match_count) > 0
            ? 'ovis_visual_neighbor'
            : 'evoc_visual_cluster'
    }));

    return Object.freeze({
        ingredients: Object.freeze(enriched_rows),
        cluster_labels_used: Object.freeze(cluster_labels_list),
        reference_image_count: reference_image_ids.length,
        visual_ranking_active: true
    });
}

/**
 * WHAT: Retrieves candidate images from the library that have prompts but have not been diced yet.
 * WHY: Allows batch dicing existing library images into the new ingredient catalog.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {number} limit_count - Maximum images to inspect.
 * @returns {ReadonlyArray<Object>} List of candidate images with metadata and analysis.
 */
export function get_undiced_candidate_images(database_connection, limit_count = 50) {
    const query_statement = database_connection.prepare(`
        SELECT images.id, images.filename, images.path, images.metadata, images.analysis
        FROM images
        LEFT JOIN diced_prompts ON images.id = diced_prompts.image_id
        WHERE diced_prompts.id IS NULL
          AND (images.metadata LIKE '%prompt%' OR images.metadata LIKE '%parameters%' OR images.analysis LIKE '%summary%')
        LIMIT ?
    `);

    const raw_rows = query_statement.all(Number(limit_count) || 50);
    return Object.freeze(raw_rows.map(row => Object.freeze(row)));
}

/**
 * WHAT: Updates the review status and optional corrections for a diced prompt.
 * WHY: When a user inspects uncertain bindings or edits ingredient slots in the review queue,
 *      marking the prompt as reviewed marks it as verified training data for Laya/CLM.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {string} prompt_identifier - Target prompt ID.
 * @param {boolean} is_reviewed - Review status flag.
 * @param {Object|null} updated_master_record - Optional corrected master record.
 * @returns {boolean} Success status.
 */
export function update_diced_prompt_review_status(
    database_connection,
    prompt_identifier,
    is_reviewed = true,
    updated_master_record = null
) {
    if (updated_master_record) {
        const update_with_record_statement = database_connection.prepare(`
            UPDATE diced_prompts
            SET is_reviewed = ?, master_record_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE prompt_id = ?
        `);
        const result = update_with_record_statement.run(
            is_reviewed ? 1 : 0,
            JSON.stringify(updated_master_record),
            prompt_identifier
        );
        return result.changes > 0;
    }

    const update_status_only_statement = database_connection.prepare(`
        UPDATE diced_prompts
        SET is_reviewed = ?, updated_at = CURRENT_TIMESTAMP
        WHERE prompt_id = ?
    `);
    const result = update_status_only_statement.run(is_reviewed ? 1 : 0, prompt_identifier);
    return result.changes > 0;
}

/**
 * WHAT: Deterministically hashes a prompt identifier into `'train'` or `'holdout'` buckets.

/**
 * WHAT: Exports ingredient interactions as JSON Lines (JSONL) training/holdout pairs for Laya/CLM.
 * WHY: Supports filtering strictly to human-reviewed rows (`reviewed_only: true`) and carving deterministic
 *      train/holdout splits before comparing Heuristic vs. LLM vs. Laya Pass D models.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {Object} export_options - Optional `{ reviewed_only, split, holdout_ratio }`.
 * @returns {ReadonlyArray<string>} Array of JSONL formatted strings.
 */
export function export_active_learning_dataset_jsonl(database_connection, export_options = {}) {
    const reviewed_only = Boolean(export_options.reviewed_only);
    const requested_split = ['train', 'holdout', 'all'].includes(export_options.split)
        ? export_options.split
        : 'all';
    const holdout_ratio = Number.isFinite(export_options.holdout_ratio)
        ? Number(export_options.holdout_ratio)
        : 0.2;

    // WHAT: Query influence edges directly with per-item (`diced_influences.is_reviewed`) and prompt-level review status.
    // WHY: Per-item `is_reviewed` tracking prevents `reviewed_only` exports from being all-or-nothing across an entire prompt.
    const where_clause = reviewed_only
        ? 'WHERE diced_influences.is_reviewed = 1 OR diced_prompts.is_reviewed = 1'
        : '';

    const edge_rows = database_connection.prepare(`
        SELECT
            diced_influences.id AS influence_row_id,
            diced_influences.prompt_id,
            diced_influences.interaction_type,
            diced_influences.consequence_description,
            diced_influences.state_key,
            diced_influences.applied_state_value,
            diced_influences.is_verified,
            diced_influences.is_reviewed AS item_is_reviewed,
            diced_prompts.is_reviewed AS prompt_is_reviewed,
            src_ing.text AS source_text,
            src_ing.slot AS source_slot,
            src_ing.source AS source_origin,
            tgt_ing.text AS target_text,
            tgt_ing.slot AS target_slot,
            tgt_ing.source AS target_origin
        FROM diced_influences
        JOIN diced_prompts ON diced_influences.prompt_id = diced_prompts.prompt_id
        LEFT JOIN diced_ingredients AS src_ing
            ON src_ing.prompt_id = diced_influences.prompt_id
            AND src_ing.ingredient_id = diced_influences.source_ingredient_id
        LEFT JOIN diced_ingredients AS tgt_ing
            ON tgt_ing.prompt_id = diced_influences.prompt_id
            AND tgt_ing.ingredient_id = diced_influences.target_ingredient_id
        ${where_clause}
    `).all();

    const jsonl_records_collection = [];

    for (const edge_row of edge_rows) {
        const prompt_split = assign_deterministic_dataset_split(edge_row.prompt_id, holdout_ratio);
        if (requested_split !== 'all' && prompt_split !== requested_split) {
            continue;
        }
        if (
            !edge_row.source_text
            || !edge_row.target_text
            || edge_row.source_origin === 'ovis_facet'
            || edge_row.target_origin === 'ovis_facet'
        ) {
            continue;
        }

        const is_item_reviewed = Boolean(edge_row.item_is_reviewed || edge_row.prompt_is_reviewed);
        const binary_label = edge_row.item_is_reviewed ? (edge_row.is_verified ? 1 : 0) : 1;

        jsonl_records_collection.push(JSON.stringify({
            label: binary_label,
            prompt_id: edge_row.prompt_id,
            item_id: `diced_influences:${edge_row.influence_row_id}`,
            is_reviewed: is_item_reviewed,
            split: prompt_split,
            interaction_type: edge_row.interaction_type,
            source_text: edge_row.source_text,
            source_slot: edge_row.source_slot,
            target_text: edge_row.target_text,
            target_slot: edge_row.target_slot,
            consequence: edge_row.consequence_description,
            state_key: edge_row.state_key,
            applied_state_value: edge_row.applied_state_value
        }));
    }

    return Object.freeze(jsonl_records_collection);
}

/**
 * WHAT: Queries stored Pass D influence edges and referenced target ingredients matching active/candidate pieces.
 * WHY: Enables real-time transitive clash checks and Influence Closure across ingredients drawn from multiple different prompts.
 *
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {ReadonlyArray<Object>} ingredients_collection - Active or candidate ingredients to resolve graph context for.
 * @param {number} max_edges - Maximum edges to retrieve.
 * @returns {Object} Frozen `{ influences, target_ingredients }`.
 */
export function fetch_relevant_influences_for_ingredients(
    database_connection,
    ingredients_collection = [],
    max_edges = 350
) {
    const safe_ingredients = Array.isArray(ingredients_collection) ? ingredients_collection : [];
    if (safe_ingredients.length === 0) {
        return Object.freeze({
            influences: Object.freeze([]),
            target_ingredients: Object.freeze([])
        });
    }

    const prompt_identifiers = Array.from(new Set(
        safe_ingredients.map(item => item.prompt_id).filter(item => typeof item === 'string' && item.trim().length > 0)
    ));
    const lower_texts = Array.from(new Set(
        safe_ingredients.map(item => String(item.text || '').toLowerCase().trim()).filter(Boolean)
    )).slice(0, 60);

    const where_fragments = [];
    const bind_params = [];

    if (prompt_identifiers.length > 0) {
        const prompt_placeholders = prompt_identifiers.map(() => '?').join(', ');
        where_fragments.push(`diced_influences.prompt_id IN (${prompt_placeholders})`);
        bind_params.push(...prompt_identifiers);
    }
    if (lower_texts.length > 0) {
        const text_placeholders = lower_texts.map(() => '?').join(', ');
        where_fragments.push(`LOWER(TRIM(src_ing.text)) IN (${text_placeholders})`);
        where_fragments.push(`LOWER(TRIM(tgt_ing.text)) IN (${text_placeholders})`);
        bind_params.push(...lower_texts, ...lower_texts);
    }

    if (where_fragments.length === 0) {
        return Object.freeze({
            influences: Object.freeze([]),
            target_ingredients: Object.freeze([])
        });
    }

    const safe_limit = Math.max(10, Math.min(800, Number(max_edges) || 350));
    const edge_rows = database_connection.prepare(`
        SELECT
            diced_influences.prompt_id,
            diced_influences.source_ingredient_id,
            diced_influences.target_ingredient_id,
            diced_influences.interaction_type,
            diced_influences.state_key,
            diced_influences.applied_state_value,
            diced_influences.clashes_with_value,
            diced_influences.consequence_description,
            src_ing.text AS source_text,
            src_ing.slot AS source_slot,
            tgt_ing.text AS target_text,
            tgt_ing.slot AS target_slot,
            tgt_ing.kind AS target_kind,
            tgt_ing.source AS target_source,
            tgt_ing.bound_to_subject_id AS target_bound_to_subject_id,
            tgt_ing.measured_number AS target_measured_number,
            tgt_ing.measured_unit AS target_measured_unit,
            tgt_ing.observable_replacement_text AS target_observable_replacement_text,
            tgt_ing.replacement_slot AS target_replacement_slot
        FROM diced_influences
        LEFT JOIN diced_ingredients AS src_ing
            ON src_ing.prompt_id = diced_influences.prompt_id
            AND src_ing.ingredient_id = diced_influences.source_ingredient_id
        LEFT JOIN diced_ingredients AS tgt_ing
            ON tgt_ing.prompt_id = diced_influences.prompt_id
            AND tgt_ing.ingredient_id = diced_influences.target_ingredient_id
        WHERE ${where_fragments.join(' OR ')}
        LIMIT ?
    `).all(...bind_params, safe_limit);

    const extracted_targets_map = new Map();
    for (const row of edge_rows) {
        if (!row.target_text) continue;
        const target_key = `${row.prompt_id}::${row.target_ingredient_id}`;
        if (!extracted_targets_map.has(target_key)) {
            extracted_targets_map.set(target_key, Object.freeze({
                prompt_id: row.prompt_id,
                ingredient_id: row.target_ingredient_id,
                kind: row.target_kind || 'physical_anchor',
                source: row.target_source || 'prompt_extraction',
                text: row.target_text,
                slot: row.target_slot || 'other',
                bound_to_subject_id: row.target_bound_to_subject_id || null,
                measured_number: row.target_measured_number ?? null,
                measured_unit: row.target_measured_unit || null,
                observable_replacement_text: row.target_observable_replacement_text || null,
                replacement_slot: row.target_replacement_slot || null
            }));
        }
    }

    return Object.freeze({
        influences: Object.freeze(edge_rows.map(row => Object.freeze(row))),
        target_ingredients: Object.freeze(Array.from(extracted_targets_map.values()))
    });
}

/**
 * WHAT: Fetches EVoC-ranked candidate ingredient pools for every unlocked slot along with their graph influences.
 * WHY: Feeds pure `solve_constraint_transplant_beam` with visually coherent per-slot replacements from SQLite.
 *
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 * @param {ReadonlyArray<Object>} base_ingredients_collection - Starting base ingredients on the remix canvas.
 * @param {Object} pool_options - Optional `{ locked_slots, per_slot_limit }`.
 * @returns {Object} Frozen `{ candidate_pools_by_slot, influences, reference_prompt_ids }`.
 */
export function fetch_transplant_candidate_pools(
    database_connection,
    base_ingredients_collection = [],
    pool_options = {}
) {
    const safe_base = Array.isArray(base_ingredients_collection) ? base_ingredients_collection : [];
    const locked_slots_set = new Set(
        Array.isArray(pool_options.locked_slots)
            ? pool_options.locked_slots
            : DEFAULT_TRANSPLANT_LOCKED_SLOTS
    );
    const per_slot_limit = Math.max(5, Math.min(60, Number(pool_options.per_slot_limit) || 25));

    const reference_prompt_ids = Array.from(new Set(
        safe_base.map(item => item.prompt_id).filter(item => typeof item === 'string' && item.trim().length > 0)
    ));

    const candidate_pools_by_slot = {};
    const combined_candidates_for_graph = [...safe_base];

    for (const slot_name of ALLOWED_INGREDIENT_SLOTS) {
        if (locked_slots_set.has(slot_name)) continue;

        const compatibility_result = get_visually_compatible_ingredients(database_connection, {
            reference_prompt_ids,
            target_slot: slot_name,
            limit: per_slot_limit
        });

        const normalized_candidates = (compatibility_result.ingredients || []).map(row => Object.freeze({
            ...row,
            cluster_match: Number(row.cluster_match_count || 0) > 0,
            vector_neighbor_match: Number(row.neighbor_match_count || 0) > 0
        }));

        candidate_pools_by_slot[slot_name] = Object.freeze(normalized_candidates);
        combined_candidates_for_graph.push(...normalized_candidates);
    }

    const graph_context = fetch_relevant_influences_for_ingredients(
        database_connection,
        combined_candidates_for_graph,
        450
    );

    // Ensure closure-reachable downstream targets also exist in candidate pools for unlocked slots
    for (const target_item of graph_context.target_ingredients) {
        const target_slot = target_item.slot || 'other';
        if (locked_slots_set.has(target_slot)) continue;
        const existing_pool = candidate_pools_by_slot[target_slot] || [];
        const already_in_pool = existing_pool.some(entry =>
            String(entry.text || '').toLowerCase().trim() === String(target_item.text || '').toLowerCase().trim()
        );
        if (!already_in_pool) {
            candidate_pools_by_slot[target_slot] = Object.freeze([...existing_pool, target_item]);
        }
    }

    return Object.freeze({
        candidate_pools_by_slot: Object.freeze(candidate_pools_by_slot),
        influences: graph_context.influences,
        reference_prompt_ids: Object.freeze(reference_prompt_ids)
    });
}

export {
    build_review_queue_cards,
    append_review_event_and_sync_item,
    get_calibration_dashboard_summary
} from "./promptDicer/dbReviewRepo.js";
