import express from "express";
import path from "path";
import { laya_client_instance } from "../services/layaClient.js";
import { ovis_omni_client_instance } from "../services/ovisOmniClient.js";
import {
    save_diced_prompt_record,
    evaluate_caption_visual_grounding_for_image,
    dice_and_save_image_record,
    validate_and_repair_diced_prompts,
    get_all_diced_prompts,
    get_diced_catalog_statistics,
    get_diced_prompt_by_identifier,
    get_ingredients_catalog_by_slot,
    get_visually_compatible_ingredients,
    get_undiced_candidate_images,
    update_diced_prompt_review_status,
    export_active_learning_dataset_jsonl,
    fetch_relevant_influences_for_ingredients,
    fetch_transplant_candidate_pools,
    get_recent_remix_memory_and_rejections,
    record_recent_remix_memory_entry,
    record_rejected_remix_draft,
    increment_prompt_keeper_count,
    build_review_queue_cards,
    append_review_event_and_sync_item,
    get_calibration_dashboard_summary
} from "../services/promptDicerDb.js";
import {
    detect_ingredient_clashes,
    assemble_remixed_prompt_text,
    extract_prompts_from_image_records,
    execute_prompt_dicing_pipeline,
    DEFAULT_TRANSPLANT_LOCKED_SLOTS,
    resolve_ingredient_influence_closure,
    solve_constraint_transplant_beam,
    verify_prompt_round_trip,
    compute_normalized_vector_cosine_similarity,
    build_laya_slot_and_state_questions,
    apply_laya_confidence_gates
} from "../services/promptDicerService.js";

// WHAT: Creates an Express router encapsulating all /api/dicer/* HTTP endpoints.
// WHY: Isolates Prompt Dicer routing from the main server bootstrap so routes are modular and maintainable.
export function createDicerRouter({ db, loadOvisEmbeddingsCached, generateSearchIndex }) {
    const router = express.Router();

    router.post('/api/dicer/dice', async (http_incoming_request, http_server_response) => {
        try {
            const {
                prompt_text,
                media_type = 'image',
                image_id = null,
                run_pass_d = true,
                force_heuristic = false,
                check_visual_grounding = true,
                source_prompt_ids = []
            } = http_incoming_request.body;

            const safe_media_type = media_type === 'video' ? 'video' : 'image';
            const safe_image_id = (Number.isSafeInteger(Number(image_id)) && Number(image_id) > 0)
                ? Number(image_id)
                : null;

            if (safe_image_id !== null) {
                const target_image_row = db.prepare('SELECT * FROM images WHERE id = ?').get(safe_image_id);
                if (target_image_row) {
                    const image_dicing_result = await dice_and_save_image_record(db, target_image_row, {
                        prompt_text: (typeof prompt_text === 'string' && prompt_text.trim().length > 0) ? prompt_text.trim() : null,
                        media_type: safe_media_type,
                        run_pass_d_influences: Boolean(run_pass_d),
                        force_heuristic: Boolean(force_heuristic),
                        check_visual_grounding: Boolean(check_visual_grounding)
                    });
                    generateSearchIndex();
                    return http_server_response.json({
                        success: true,
                        image_id: safe_image_id,
                        master_record: image_dicing_result.master_record,
                        influences: image_dicing_result.influences,
                        visual_grounding: image_dicing_result.visual_grounding,
                        updated_analysis: image_dicing_result.updated_analysis,
                        execution_mode: image_dicing_result.execution_mode,
                        database_summary: image_dicing_result.database_summary
                    });
                }
            }

            if (!prompt_text || typeof prompt_text !== 'string' || !prompt_text.trim()) {
                return http_server_response.status(400).json({ error: 'A non-empty prompt_text string or valid image_id is required.' });
            }

            const dicing_pipeline_result = await execute_prompt_dicing_pipeline({
                prompt_text: prompt_text.trim(),
                media_type: safe_media_type,
                image_id: safe_image_id,
                run_pass_d_influences: Boolean(run_pass_d),
                force_heuristic: Boolean(force_heuristic)
            });

            const database_save_result = save_diced_prompt_record(
                db,
                dicing_pipeline_result.master_record,
                dicing_pipeline_result.influences,
                safe_image_id
            );

            // WHAT: Boost keeper success weights on source prompts when a user saves a newly remixed composition.
            // WHY: Mirrors Mondocraft's keeper weight escalation so proven source prompts participate 3x more often.
            const keeper_updated_count = (Array.isArray(source_prompt_ids) && source_prompt_ids.length > 0)
                ? increment_prompt_keeper_count(db, source_prompt_ids)
                : 0;

            http_server_response.json({
                success: true,
                master_record: dicing_pipeline_result.master_record,
                influences: dicing_pipeline_result.influences,
                execution_mode: dicing_pipeline_result.execution_mode,
                database_summary: database_save_result,
                keeper_updated_count
            });
        } catch (prompt_dicing_error) {
            console.error('[PROMPT-DICER] Pipeline execution failed:', prompt_dicing_error);
            http_server_response.status(500).json({ error: prompt_dicing_error.message });
        }
    });

    // WHAT: Batch-dices all undiced (or all) images in `images.db` and writes the structured Master Record onto each image entry.
    // WHY: Ensures every image in the database has its diced prompt structure stored on `images.diced_prompt`, `images.analysis.diced_prompt`, and `diced_prompts`.
    router.post('/api/dicer/batch-dice-library', async (http_incoming_request, http_server_response) => {
        try {
            const {
                limit = 500,
                only_undiced = true,
                force_heuristic = true
            } = http_incoming_request.body || {};

            const safe_limit = Math.min(5000, Math.max(1, Number(limit) || 500));
            const candidate_rows = only_undiced
                ? db.prepare(`
                    SELECT images.*
                    FROM images
                    LEFT JOIN diced_prompts ON images.id = diced_prompts.image_id
                    WHERE diced_prompts.id IS NULL OR images.diced_prompt IS NULL
                    ORDER BY images.id DESC
                    LIMIT ?
                `).all(safe_limit)
                : db.prepare('SELECT * FROM images ORDER BY id DESC LIMIT ?').all(safe_limit);

            let diced_count = 0;
            for (const image_row of candidate_rows) {
                await dice_and_save_image_record(db, image_row, {
                    run_pass_d_influences: true,
                    force_heuristic: Boolean(force_heuristic)
                });
                diced_count++;
            }

            if (diced_count > 0) {
                generateSearchIndex();
            }

            http_server_response.json({
                success: true,
                diced_count,
                total_candidates: candidate_rows.length
            });
        } catch (batch_dice_error) {
            console.error('[PROMPT-DICER] Batch library dicing failed:', batch_dice_error);
            http_server_response.status(500).json({ error: batch_dice_error.message });
        }
    });

    // WHAT: Validates all existing diced prompts against current image descriptions, metadata, and table sync state.
    // WHY: Re-dices any entry whose image description was updated/regenerated or whose diced columns drifted out of sync.
    router.post('/api/dicer/validate', async (http_incoming_request, http_server_response) => {
        try {
            const force_heuristic = http_incoming_request.body?.force_heuristic !== false;
            const sync_ovis_facets = Boolean(http_incoming_request.body?.sync_ovis_facets);
            const validation_summary = await validate_and_repair_diced_prompts(db, {
                force_heuristic: Boolean(force_heuristic),
                sync_ovis_facets
            });

            if (
                validation_summary.missing_repaired_count > 0
                || validation_summary.stale_re_diced_count > 0
                || validation_summary.desynced_repaired_count > 0
                || validation_summary.orphaned_cleaned_count > 0
            ) {
                generateSearchIndex();
            }

            http_server_response.json({
                success: true,
                summary: validation_summary
            });
        } catch (validation_error) {
            console.error('[PROMPT-DICER] Validation error:', validation_error);
            http_server_response.status(500).json({ error: validation_error.message });
        }
    });


    // WHAT: Audits image captions against raw pixels via Ovis-Omni 2048-dim cross-modal cosine similarity.
    // WHY: Flags stale or off-target image descriptions before/after dicing when port 8082 is online.
    router.post('/api/dicer/visual-grounding-audit', async (http_incoming_request, http_server_response) => {
        try {
            const is_ovis_online = await ovis_omni_client_instance.checkHealth(true);
            if (!is_ovis_online) {
                return http_server_response.status(503).json({
                    online: false,
                    error: 'Ovis-Omni microservice is offline on port 8082. Launch start_ovis_server.bat to run visual grounding checks.'
                });
            }

            const raw_limit = Number(http_incoming_request.body?.limit);
            const safe_limit = Number.isSafeInteger(raw_limit) && raw_limit > 0 ? Math.min(200, raw_limit) : 25;
            const target_image_ids = Array.isArray(http_incoming_request.body?.image_ids)
                ? http_incoming_request.body.image_ids
                    .map(Number)
                    .filter(candidate_image_id => Number.isSafeInteger(candidate_image_id) && candidate_image_id > 0)
                : [];

            const cached_ovis_embeddings_map = loadOvisEmbeddingsCached();

            const target_rows = target_image_ids.length > 0
                ? db.prepare(`SELECT id, filename, path, analysis, diced_prompt FROM images WHERE id IN (${target_image_ids.map(() => '?').join(', ')})`).all(...target_image_ids)
                : db.prepare('SELECT id, filename, path, analysis, diced_prompt FROM images ORDER BY id DESC LIMIT ?').all(safe_limit);

            const grounded_items = [];
            const borderline_items = [];
            const mismatched_items = [];

            for (const image_row of target_rows) {
                let parsed_analysis = {};
                try {
                    parsed_analysis = typeof image_row.analysis === 'string'
                        ? JSON.parse(image_row.analysis || '{}')
                        : (image_row.analysis || {});
                } catch (parse_error) {
                    parsed_analysis = {};
                }

                const caption_text = String(parsed_analysis.summary || '').trim();
                if (!caption_text) continue;

                let existing_diced = null;
                try {
                    existing_diced = typeof image_row.diced_prompt === 'string' && image_row.diced_prompt.trim()
                        ? JSON.parse(image_row.diced_prompt)
                        : (parsed_analysis.diced_prompt || null);
                } catch (diced_parse_error) {
                    existing_diced = parsed_analysis.diced_prompt || null;
                }

                const include_per_ingredient = http_incoming_request.body?.include_per_ingredient !== false;
                const verdict = await evaluate_caption_visual_grounding_for_image(
                    image_row,
                    caption_text,
                    {
                        ovis_client: ovis_omni_client_instance,
                        cached_ovis_embeddings_map,
                        ingredients: Array.isArray(existing_diced?.ingredients) ? existing_diced.ingredients : [],
                        include_per_ingredient
                    }
                );

                if (!verdict.checked) continue;

                const summary_entry = {
                    image_id: image_row.id,
                    filename: image_row.filename,
                    grounding_score: verdict.grounding_score,
                    grounding_status: verdict.grounding_status,
                    needs_reanalysis: verdict.needs_reanalysis,
                    summary_snippet: caption_text.slice(0, 120),
                    missing_ingredients: verdict.missing_ingredients || [],
                    ingredient_grounding_counts: verdict.ingredient_grounding
                        ? {
                            grounded: verdict.ingredient_grounding.grounded_count,
                            borderline: verdict.ingredient_grounding.borderline_count,
                            mismatched: verdict.ingredient_grounding.mismatched_count
                        }
                        : null
                };

                if (verdict.grounding_status === 'grounded') {
                    grounded_items.push(summary_entry);
                } else if (verdict.grounding_status === 'borderline') {
                    borderline_items.push(summary_entry);
                } else {
                    mismatched_items.push(summary_entry);
                }

                // Persist visual_grounding onto the stored diced_prompt when available
                if (existing_diced) {
                    try {
                        const updated_diced = { ...existing_diced, visual_grounding: verdict };
                        const updated_analysis_payload = { ...parsed_analysis, diced_prompt: updated_diced };
                        db.prepare('UPDATE images SET diced_prompt = ?, analysis = ? WHERE id = ?').run(
                            JSON.stringify(updated_diced),
                            JSON.stringify(updated_analysis_payload),
                            image_row.id
                        );
                    } catch (update_error) {
                        // Ignore JSON sync warning on malformed rows
                    }
                }
            }

            http_server_response.json({
                online: true,
                checked_count: grounded_items.length + borderline_items.length + mismatched_items.length,
                grounded_count: grounded_items.length,
                borderline_count: borderline_items.length,
                mismatched_count: mismatched_items.length,
                mismatched_items,
                borderline_items
            });
        } catch (grounding_audit_error) {
            console.error('[PROMPT-DICER] Visual grounding audit error:', grounding_audit_error);
            http_server_response.status(500).json({ error: grounding_audit_error.message });
        }
    });

    // WHAT: Ranks catalog ingredients by EVoC visual cluster compatibility and optional Ovis 2048-dim nearest-neighbor similarity.
    // WHY: Powers smart "Visually Compatible" suggestions in the Remix Workbench without loading the 389 MB JSON file during normal browsing.
    router.post('/api/dicer/visually-compatible-ingredients', (http_incoming_request, http_server_response) => {
        try {
            const {
                reference_prompt_ids = [],
                reference_image_ids = [],
                slot = null,
                q = '',
                limit = 150,
                include_vector_neighbors = false
            } = http_incoming_request.body || {};

            let neighbor_image_ids = [];
            if (include_vector_neighbors) {
                const seed_image_ids = new Set(
                    (Array.isArray(reference_image_ids) ? reference_image_ids : [])
                        .map(Number)
                        .filter(candidate_image_id => Number.isSafeInteger(candidate_image_id) && candidate_image_id > 0)
                );

                if (Array.isArray(reference_prompt_ids) && reference_prompt_ids.length > 0) {
                    const placeholders = reference_prompt_ids.map(() => '?').join(', ');
                    const linked_rows = db.prepare(`SELECT DISTINCT image_id FROM diced_prompts WHERE prompt_id IN (${placeholders}) AND image_id IS NOT NULL`).all(...reference_prompt_ids);
                    for (const row of linked_rows) {
                        if (row.image_id) seed_image_ids.add(Number(row.image_id));
                    }
                }

                const first_seed_image_id = Array.from(seed_image_ids)[0];
                const ovis_map = first_seed_image_id ? loadOvisEmbeddingsCached() : null;
                if (first_seed_image_id && ovis_map) {
                    try {
                        const seed_vector = ovis_map[String(first_seed_image_id)];
                        if (Array.isArray(seed_vector) && seed_vector.length > 0) {
                            // WHAT: Precomputing the seed vector's Euclidean norm once before scanning all candidates.
                            // WHY: Avoids recomputing `sqrt(sum(seed^2))` and allocating `Object.entries` tuples
                            //      across 11,000+ 2048-dim candidate vectors.
                            let seed_magnitude_squared = 0;
                            for (let dimension_index = 0; dimension_index < seed_vector.length; dimension_index++) {
                                const seed_component = Number(seed_vector[dimension_index]) || 0;
                                seed_magnitude_squared += seed_component * seed_component;
                            }
                            const seed_magnitude = Math.sqrt(seed_magnitude_squared);

                            if (seed_magnitude > 0) {
                                const scored_neighbors = [];
                                for (const candidate_id_str in ovis_map) {
                                    const candidate_id = Number(candidate_id_str);
                                    if (seed_image_ids.has(candidate_id)) continue;
                                    const candidate_vector = ovis_map[candidate_id_str];
                                    if (!Array.isArray(candidate_vector) || candidate_vector.length !== seed_vector.length) continue;

                                    let dot_product_sum = 0;
                                    let candidate_magnitude_squared = 0;
                                    for (let dimension_index = 0; dimension_index < seed_vector.length; dimension_index++) {
                                        const candidate_component = Number(candidate_vector[dimension_index]) || 0;
                                        dot_product_sum += (Number(seed_vector[dimension_index]) || 0) * candidate_component;
                                        candidate_magnitude_squared += candidate_component * candidate_component;
                                    }
                                    const denominator = seed_magnitude * Math.sqrt(candidate_magnitude_squared);
                                    const cosine = denominator > 0 ? Math.max(-1, Math.min(1, dot_product_sum / denominator)) : 0;
                                    if (cosine > 0.25) {
                                        scored_neighbors.push({ image_id: candidate_id, similarity: cosine });
                                    }
                                }
                                scored_neighbors.sort((first_item, second_item) => second_item.similarity - first_item.similarity);
                                neighbor_image_ids = scored_neighbors.slice(0, 30).map(item => item.image_id);
                            }
                        }
                    } catch (vector_lookup_error) {
                        console.warn('[PROMPT-DICER] Vector neighbor lookup skipped:', vector_lookup_error.message);
                    }
                }
            }

            const compatibility_result = get_visually_compatible_ingredients(db, {
                reference_prompt_ids,
                reference_image_ids,
                neighbor_image_ids,
                target_slot: slot,
                search_query: q,
                limit
            });

            http_server_response.json({
                success: true,
                count: compatibility_result.ingredients.length,
                ...compatibility_result
            });
        } catch (compatible_error) {
            console.error('[PROMPT-DICER] Visually compatible ingredient lookup failed:', compatible_error);
            http_server_response.status(500).json({ error: compatible_error.message });
        }
    });

    // WHAT: Retrieves a paginated catalog list of all diced prompts with physicality metrics and overall stats.
    // WHY: Allows frontend browsing, filtering, Remix Workbench prompt loading, and inspection of analyzed prompts.
    router.get('/api/dicer/prompts', (http_incoming_request, http_server_response) => {
        try {
            const raw_limit = Number(http_incoming_request.query.limit);
            const raw_offset = Number(http_incoming_request.query.offset);
            const search_query = typeof http_incoming_request.query.q === 'string'
                ? http_incoming_request.query.q.trim()
                : '';

            const safe_limit = (Number.isSafeInteger(raw_limit) && raw_limit > 0)
                ? Math.min(200, raw_limit)
                : 50;
            const safe_offset = (Number.isSafeInteger(raw_offset) && raw_offset >= 0)
                ? raw_offset
                : 0;

            const diced_prompts_list = get_all_diced_prompts(db, safe_limit, safe_offset, search_query);
            const catalog_stats = get_diced_catalog_statistics(db);
            http_server_response.json({
                prompts: diced_prompts_list,
                stats: catalog_stats,
                limit: safe_limit,
                offset: safe_offset
            });
        } catch (query_diced_prompts_error) {
            console.error('[PROMPT-DICER] Failed to fetch prompts:', query_diced_prompts_error);
            http_server_response.status(500).json({ error: query_diced_prompts_error.message });
        }
    });

    // WHAT: Retrieves the complete Master Record and influence edges for a specific prompt ID.
    // WHY: Displays subjects, physical anchors, observable replacements, and consequences in the UI.
    router.get('/api/dicer/prompts/:prompt_id', (http_incoming_request, http_server_response) => {
        try {
            const requested_prompt_identifier = http_incoming_request.params.prompt_id;
            const complete_prompt_record = get_diced_prompt_by_identifier(db, requested_prompt_identifier);

            if (!complete_prompt_record) {
                return http_server_response.status(404).json({ error: `Prompt '${requested_prompt_identifier}' was not found.` });
            }

            http_server_response.json(complete_prompt_record);
        } catch (fetch_prompt_record_error) {
            console.error('[PROMPT-DICER] Error fetching single prompt:', fetch_prompt_record_error);
            http_server_response.status(500).json({ error: fetch_prompt_record_error.message });
        }
    });

    // WHAT: Retrieves deduplicated cataloged ingredients filtered by controlled slot and search query.
    // WHY: Powers the Remix Workbench slot selector (lighting, lens, weather, mood, etc.).
    router.get('/api/dicer/ingredients', (http_incoming_request, http_server_response) => {
        try {
            const raw_slot_filter = http_incoming_request.query.slot;
            const safe_slot_filter = (typeof raw_slot_filter === 'string' && raw_slot_filter.trim().length > 0)
                ? raw_slot_filter.trim()
                : null;
            const search_query = typeof http_incoming_request.query.q === 'string'
                ? http_incoming_request.query.q.trim()
                : '';
            const raw_limit = Number(http_incoming_request.query.limit);
            const safe_limit = (Number.isSafeInteger(raw_limit) && raw_limit > 0)
                ? Math.min(500, raw_limit)
                : 250;

            const ingredients_catalog_collection = get_ingredients_catalog_by_slot(
                db,
                safe_slot_filter,
                search_query,
                safe_limit
            );
            http_server_response.json({
                slot_filter: safe_slot_filter,
                search_query,
                count: ingredients_catalog_collection.length,
                ingredients: ingredients_catalog_collection
            });
        } catch (query_ingredients_catalog_error) {
            console.error('[PROMPT-DICER] Error querying ingredients catalog:', query_ingredients_catalog_error);
            http_server_response.status(500).json({ error: query_ingredients_catalog_error.message });
        }
    });

    // WHAT: Scans library images for generation prompts (ComfyUI / A1111 / vision summary) ready for dicing.
    // WHY: Lets users quickly batch-dice existing image assets without manual copy-pasting.
    router.get('/api/dicer/candidate-prompts', (http_incoming_request, http_server_response) => {
        try {
            const raw_limit = Number(http_incoming_request.query.limit);
            const safe_limit = (Number.isSafeInteger(raw_limit) && raw_limit > 0)
                ? Math.min(100, raw_limit)
                : 30;

            const undiced_images = get_undiced_candidate_images(db, safe_limit);
            const candidate_prompts_collection = [];

            for (const candidate_image of undiced_images) {
                const extracted_prompts = extract_prompts_from_image_records(
                    candidate_image.metadata,
                    candidate_image.analysis
                );

                for (const prompt_entry of extracted_prompts) {
                    candidate_prompts_collection.push({
                        image_id: candidate_image.id,
                        filename: candidate_image.filename,
                        source_type: prompt_entry.source_type,
                        prompt_text: prompt_entry.prompt_text,
                        confidence: prompt_entry.confidence
                    });
                }
            }

            http_server_response.json({
                count: candidate_prompts_collection.length,
                candidates: candidate_prompts_collection
            });
        } catch (fetch_candidate_prompts_error) {
            console.error('[PROMPT-DICER] Error fetching candidate prompts:', fetch_candidate_prompts_error);
            http_server_response.status(500).json({ error: fetch_candidate_prompts_error.message });
        }
    });

    // WHAT: Tests an ingredient remix combination for Influence Closure, physical continuity clashes, round-trip integrity, and builds the prompt text.
    // WHY: Warns users in real-time when swapped ingredients contradict each other, pulls/prunes graph effects, and verifies slot survival.
    router.post('/api/dicer/remix-preview', (http_incoming_request, http_server_response) => {
        try {
            const {
                ingredients = [],
                consequences = [],
                influences = [],
                removed_ingredients = [],
                locked_slots = [],
                resolve_closure = false,
                run_round_trip = true,
                media_type = 'image',
                include_observable_replacements = true,
                style_mode = 'clauses',
                base_prompt_text = '',
                swapped_slots = [],
                variation_seed = 0
            } = http_incoming_request.body || {};

            if (!Array.isArray(ingredients)) {
                return http_server_response.status(400).json({ error: 'Ingredients must be an array of ingredient records.' });
            }

            // Augment client-supplied influences with matching graph edges from SQLite for cross-prompt checks
            const sqlite_graph_context = fetch_relevant_influences_for_ingredients(db, [
                ...ingredients,
                ...(Array.isArray(removed_ingredients) ? removed_ingredients : [])
            ]);
            const merged_influences = [
                ...(Array.isArray(influences) ? influences : []),
                ...(sqlite_graph_context.influences || [])
            ];

            let active_ingredients = ingredients;
            let active_consequences = Array.isArray(consequences) ? consequences : [];
            let closure_trace = { pulled_effects: [], pruned_orphans: [] };

            if (resolve_closure || (Array.isArray(removed_ingredients) && removed_ingredients.length > 0)) {
                const closure_result = resolve_ingredient_influence_closure(
                    ingredients,
                    merged_influences,
                    sqlite_graph_context.target_ingredients || [],
                    {
                        locked_slots: Array.isArray(locked_slots) ? locked_slots : [],
                        removed_ingredients: Array.isArray(removed_ingredients) ? removed_ingredients : []
                    }
                );
                active_ingredients = closure_result.ingredients;
                active_consequences = Array.from(new Set([...active_consequences, ...(closure_result.consequences || [])]));
                closure_trace = {
                    pulled_effects: closure_result.pulled_effects,
                    pruned_orphans: closure_result.pruned_orphans
                };
            }

            // 1. Detect direct and multi-hop transitive physical continuity clashes
            const detected_clashes = detect_ingredient_clashes(active_ingredients, merged_influences);

            // 2. Assemble generation prompt string (classic clauses, in-place natural sentences, or Dream modes)
            const remixed_prompt_string = assemble_remixed_prompt_text(
                active_ingredients,
                active_consequences,
                {
                    include_observable_replacements: Boolean(include_observable_replacements),
                    style_mode,
                    base_prompt_text,
                    swapped_slots: Array.isArray(swapped_slots) ? swapped_slots : [],
                    variation_seed: Number(variation_seed) || 0
                }
            );

            // 3. Fast heuristic round-trip verification (#8)
            const round_trip_verdict = run_round_trip
                ? verify_prompt_round_trip(active_ingredients, remixed_prompt_string, {
                    media_type,
                    include_observable_replacements: Boolean(include_observable_replacements)
                })
                : null;

            http_server_response.json({
                remixed_prompt: remixed_prompt_string,
                ingredients: active_ingredients,
                consequences: active_consequences,
                closure_trace,
                has_clashes: detected_clashes.length > 0,
                clashes: detected_clashes,
                round_trip: round_trip_verdict,
                ingredient_count: active_ingredients.length
            });
        } catch (remix_preview_error) {
            console.error('[PROMPT-DICER] Error generating remix preview:', remix_preview_error);
            http_server_response.status(500).json({ error: remix_preview_error.message });
        }
    });

    // WHAT: Solves constrained K-slot transplantation over a base prompt using EVoC/graph beam search, family clustering, staleness rotation, Influence Closure, and optional Laya tie-breaking.
    // WHY: Implements Phase 1 Constraint Transplant plus Mondocraft diversity, 48-draft rotation, rejection avoidance, and natural/Dream assembly.
    router.post('/api/dicer/transplant', async (http_incoming_request, http_server_response) => {
        try {
            const {
                base_ingredients = [],
                locked_slots = DEFAULT_TRANSPLANT_LOCKED_SLOTS,
                swap_count = 2,
                allow_empty_fills = true,
                variation_seed = 0,
                use_laya_tiebreaker = false,
                include_observable_replacements = true,
                media_type = 'image',
                style_mode = 'clauses',
                base_prompt_text = ''
            } = http_incoming_request.body || {};

            if (!Array.isArray(base_ingredients) || base_ingredients.length === 0) {
                return http_server_response.status(400).json({ error: 'Load at least one base prompt or ingredient onto the canvas before transplanting.' });
            }

            const safe_locked_slots = Array.isArray(locked_slots) ? locked_slots : [...DEFAULT_TRANSPLANT_LOCKED_SLOTS];
            const candidate_pool_bundle = fetch_transplant_candidate_pools(db, base_ingredients, {
                locked_slots: safe_locked_slots,
                per_slot_limit: 25
            });
            const { recent_remixes, rejected_drafts } = get_recent_remix_memory_and_rejections(db, media_type);

            const solver_result = solve_constraint_transplant_beam(
                base_ingredients,
                candidate_pool_bundle.candidate_pools_by_slot,
                candidate_pool_bundle.influences,
                {
                    locked_slots: safe_locked_slots,
                    swap_count,
                    allow_empty_fills: Boolean(allow_empty_fills),
                    variation_seed: Number(variation_seed) || 0,
                    recent_remixes,
                    rejected_drafts,
                    style_mode,
                    base_prompt_text,
                    include_observable_replacements: Boolean(include_observable_replacements)
                }
            );

            let chosen_plan = solver_result;
            let laya_tiebreaker_applied = false;

            // Optional single batched Laya /decide re-ranking over the top surviving beam candidates
            if (use_laya_tiebreaker && Array.isArray(solver_result.beam_candidates) && solver_result.beam_candidates.length > 1) {
                const top_plans = solver_result.beam_candidates.slice(0, 4);
                const plan_questions = {};
                for (let plan_index = 0; plan_index < top_plans.length; plan_index++) {
                    const assembled_candidate_text = assemble_remixed_prompt_text(
                        top_plans[plan_index].selected_ingredients,
                        top_plans[plan_index].consequences,
                        {
                            include_observable_replacements: Boolean(include_observable_replacements),
                            style_mode,
                            base_prompt_text,
                            swapped_slots: top_plans[plan_index].swapped_slots || [],
                            variation_seed: Number(variation_seed) || 0
                        }
                    );
                    plan_questions[`plan__${plan_index}`] = {
                        type: 'choice',
                        instructions: `Does this combined visual prompt form a physically coherent scene without narrative contradictions? "${assembled_candidate_text}"`,
                        criteria: {
                            yes: 'Physically coherent and visually unified scene.',
                            no: 'Contains awkward mismatches or unnatural juxtaposition.'
                        }
                    };
                }

                const laya_verdict = await laya_client_instance.tryDecide(
                    { task: 'dicer_beam_tiebreaker', candidate_count: top_plans.length },
                    plan_questions
                );

                if (laya_verdict.online && laya_verdict.answers) {
                    laya_tiebreaker_applied = true;
                    const rescored = top_plans.map((plan_item, plan_index) => {
                        const ans = laya_verdict.answers[`plan__${plan_index}`];
                        const yes_bonus = ans && String(ans.choice).toLowerCase() === 'yes'
                            ? (Number(ans.confidence) || 0.5) * 2.5
                            : -(Number(ans.confidence) || 0.5) * 1.5;
                        return { plan_item, combined_score: plan_item.score + yes_bonus };
                    }).toSorted((alpha, beta) => beta.combined_score - alpha.combined_score);
                    chosen_plan = rescored[0].plan_item;
                }
            }

            const remixed_prompt = assemble_remixed_prompt_text(
                chosen_plan.selected_ingredients,
                chosen_plan.consequences,
                {
                    include_observable_replacements: Boolean(include_observable_replacements),
                    style_mode,
                    base_prompt_text,
                    swapped_slots: chosen_plan.swapped_slots || [],
                    variation_seed: Number(variation_seed) || 0
                }
            );

            // WHAT: Persist this live roll into the 48-entry staleness window in SQLite.
            // WHY: Ensures the next Transplant roll steers away from these openings and source families.
            const swapped_slots_list = Array.isArray(chosen_plan.swapped_slots) ? chosen_plan.swapped_slots : [];
            record_recent_remix_memory_entry(db, {
                media_type,
                draft_text: remixed_prompt,
                source_prompt_ids: swapped_slots_list.map(swap_item => swap_item.chosen_source_prompt).filter(Boolean),
                source_family_ids: swapped_slots_list.map(swap_item => swap_item.source_family_id).filter(Boolean),
                swapped_texts: swapped_slots_list.map(swap_item => swap_item.chosen_text).filter(Boolean)
            });

            const round_trip_verdict = verify_prompt_round_trip(
                chosen_plan.selected_ingredients,
                remixed_prompt,
                {
                    media_type,
                    include_observable_replacements: Boolean(include_observable_replacements)
                }
            );

            http_server_response.json({
                success: true,
                ingredients: chosen_plan.selected_ingredients,
                consequences: chosen_plan.consequences,
                swapped_slots: chosen_plan.swapped_slots,
                pulled_effects: chosen_plan.pulled_effects,
                pruned_orphans: chosen_plan.pruned_orphans,
                remixed_prompt,
                has_clashes: chosen_plan.clashes.length > 0,
                clashes: chosen_plan.clashes,
                round_trip: round_trip_verdict,
                laya_tiebreaker_applied
            });
        } catch (transplant_error) {
            console.error('[PROMPT-DICER] Constraint transplant failed:', transplant_error);
            http_server_response.status(500).json({ error: transplant_error.message });
        }
    });

    // WHAT: Permanently records a rejected remix draft and swapped ingredients so Transplant skips them in future rolls.
    // WHY: Implements Mondocraft `remix_rejections` behavior behind "Reject & Re-roll".
    router.post('/api/dicer/reject-remix', (http_incoming_request, http_server_response) => {
        try {
            const {
                draft_text = '',
                rejected_ingredient_texts = [],
                media_type = 'image'
            } = http_incoming_request.body || {};

            if (!String(draft_text || '').trim() && (!Array.isArray(rejected_ingredient_texts) || rejected_ingredient_texts.length === 0)) {
                return http_server_response.status(400).json({ error: 'Provide draft_text or rejected_ingredient_texts to record a rejection.' });
            }

            const rejected_count = record_rejected_remix_draft(db, {
                media_type,
                draft_text,
                rejected_ingredient_texts
            });

            http_server_response.json({
                success: true,
                rejected_count
            });
        } catch (reject_error) {
            console.error('[PROMPT-DICER] Failed to record remix rejection:', reject_error);
            http_server_response.status(500).json({ error: reject_error.message });
        }
    });

    // WHAT: Increments keeper success weights on source prompts used in an approved remix.
    // WHY: Implements Mondocraft's 3x weight bias for proven winning prompts.
    router.post('/api/dicer/mark-keeper', (http_incoming_request, http_server_response) => {
        try {
            const { prompt_ids = [] } = http_incoming_request.body || {};
            if (!Array.isArray(prompt_ids) || prompt_ids.length === 0) {
                return http_server_response.status(400).json({ error: 'A non-empty prompt_ids array is required.' });
            }

            const updated_count = increment_prompt_keeper_count(db, prompt_ids);
            http_server_response.json({
                success: true,
                updated_count
            });
        } catch (keeper_error) {
            console.error('[PROMPT-DICER] Failed to mark keeper prompts:', keeper_error);
            http_server_response.status(500).json({ error: keeper_error.message });
        }
    });

    // WHAT: Runs an explicit Round-Trip Verification pass using llama-server (with heuristic fallback) on the stitched prompt.
    // WHY: Confirms whether full LLM re-dicing recovers all planned slots and physical anchors without introducing clashes.
    router.post('/api/dicer/round-trip-check', async (http_incoming_request, http_server_response) => {
        try {
            const {
                ingredients = [],
                prompt_text = '',
                media_type = 'image',
                include_observable_replacements = true,
                use_llm = true
            } = http_incoming_request.body || {};

            if (!prompt_text || typeof prompt_text !== 'string' || !prompt_text.trim()) {
                return http_server_response.status(400).json({ error: 'A non-empty prompt_text is required for round-trip checking.' });
            }

            const dicing_result = await execute_prompt_dicing_pipeline({
                prompt_text: prompt_text.trim(),
                media_type: media_type === 'video' ? 'video' : 'image',
                run_pass_d_influences: true,
                force_heuristic: use_llm === false
            });

            const verdict = verify_prompt_round_trip(ingredients, prompt_text.trim(), {
                media_type,
                include_observable_replacements: Boolean(include_observable_replacements),
                precomputed_dicing_result: dicing_result
            });

            http_server_response.json({
                success: true,
                execution_mode: dicing_result.execution_mode,
                round_trip: verdict
            });
        } catch (round_trip_error) {
            console.error('[PROMPT-DICER] Round-trip check failed:', round_trip_error);
            http_server_response.status(500).json({ error: round_trip_error.message });
        }
    });

    // WHAT: Updates the human review status and corrections for a diced prompt.
    // WHY: High-confidence approved records feed active learning datasets for Laya/CLM fine-tuning.
    router.post('/api/dicer/review', (http_incoming_request, http_server_response) => {
        try {
            const { prompt_id, is_reviewed = true, master_record = null } = http_incoming_request.body;

            if (!prompt_id || typeof prompt_id !== 'string') {
                return http_server_response.status(400).json({ error: 'A valid prompt_id string is required.' });
            }

            const update_success_boolean = update_diced_prompt_review_status(
                db,
                prompt_id,
                Boolean(is_reviewed),
                master_record
            );

            http_server_response.json({
                success: update_success_boolean,
                prompt_id: prompt_id,
                is_reviewed: Boolean(is_reviewed)
            });
        } catch (review_update_error) {
            console.error('[PROMPT-DICER] Error updating review status:', review_update_error);
            http_server_response.status(500).json({ error: review_update_error.message });
        }
    });

    // WHAT: Uses Laya (/decide) single-pass classification probabilities to check slot assignments and state implications.
    // WHY: Flags uncertain slots or Pass D physical continuity claims for human review when port 8765 is online.
    router.post('/api/dicer/laya-validate', async (http_incoming_request, http_server_response) => {
        try {
            const {
                prompt_text = '',
                ingredients = [],
                influences = [],
                slot_confidence_min,
                state_confidence_min
            } = http_incoming_request.body || {};

            const questions_specification = build_laya_slot_and_state_questions(ingredients, influences);
            if (Object.keys(questions_specification).length === 0) {
                return http_server_response.json({
                    checked: true,
                    online: true,
                    review_flags_count: 0,
                    ingredients,
                    influences
                });
            }

            const laya_result = await laya_client_instance.tryDecide(
                String(prompt_text || ''),
                questions_specification
            );
            if (!laya_result.available) {
                return http_server_response.json({
                    checked: false,
                    online: false,
                    reason: laya_result.reason || 'laya_offline',
                    review_flags_count: 0,
                    ingredients,
                    influences
                });
            }

            const gated_payload = apply_laya_confidence_gates(
                ingredients,
                influences,
                laya_result.answers,
                { slot_confidence_min, state_confidence_min }
            );

            http_server_response.json({
                checked: true,
                online: true,
                ...gated_payload
            });
        } catch (laya_validate_error) {
            console.error('[PROMPT-DICER] Error validating via Laya:', laya_validate_error);
            http_server_response.status(500).json({ error: laya_validate_error.message });
        }
    });

    // WHAT: Serves the rapid single-question Review Queue across all 5 card types with stratified or uncertainty ordering and ~5% repeat checks.
    // WHY: Feeds grounded cutoffs, Pass D edge recall, and Laya fine-tuning labels from one streamlined pass.
    router.get('/api/dicer/review-queue', async (http_incoming_request, http_server_response) => {
        try {
            const card_type = typeof http_incoming_request.query?.card_type === 'string'
                ? http_incoming_request.query.card_type
                : 'all';
            const ordering = http_incoming_request.query?.ordering === 'uncertainty' ? 'uncertainty' : 'stratified';
            const raw_limit = Number(http_incoming_request.query?.limit);
            const limit = Number.isSafeInteger(raw_limit) && raw_limit > 0 ? Math.min(100, raw_limit) : 40;
            const seed = Number(http_incoming_request.query?.seed) || 1;
            const enrich_grounding = String(http_incoming_request.query?.enrich_grounding || '').toLowerCase() === 'true';

            const queue_payload = build_review_queue_cards(db, {
                card_type,
                ordering,
                limit,
                seed
            });

            let final_cards = queue_payload.cards;

            // Optionally compute missing Ovis visual grounding scores for visible cards when Ovis-Omni is online
            if (enrich_grounding && Array.isArray(final_cards) && final_cards.length > 0) {
                const is_ovis_online = await ovis_omni_client_instance.checkHealth(false);
                if (is_ovis_online) {
                    const cached_ovis_embeddings_map = loadOvisEmbeddingsCached();

                    const enriched = [];
                    let lookups_remaining = 12;
                    for (const card of final_cards) {
                        if (
                            lookups_remaining > 0
                            && (card.card_type === 'grounding_caption' || card.card_type === 'grounding_ingredient')
                            && card.model_confidence === null
                            && card.image_id
                        ) {
                            lookups_remaining -= 1;
                            try {
                                const image_vector = cached_ovis_embeddings_map?.[String(card.image_id)] || null;
                                const target_phrase = card.card_type === 'grounding_ingredient' ? card.target_text : card.raw_prompt;
                                if (Array.isArray(image_vector) && image_vector.length > 0 && target_phrase) {
                                    const text_vector = await ovis_omni_client_instance.generateTextEmbedding(target_phrase);
                                    const cosine = compute_normalized_vector_cosine_similarity(image_vector, text_vector);
                                    enriched.push({ ...card, model_confidence: Number(cosine.toFixed(4)) });
                                    continue;
                                }
                            } catch (enrich_err) {
                                // Fall back to unenriched card
                            }
                        }
                        enriched.push(card);
                    }
                    final_cards = enriched;
                }
            }

            http_server_response.json({
                success: true,
                cards: final_cards,
                candidate_count: queue_payload.candidate_count,
                repeat_pool_size: queue_payload.repeat_pool_size,
                ordering: queue_payload.ordering,
                sitting_progress: queue_payload.sitting_progress
            });
        } catch (queue_error) {
            console.error('[PROMPT-DICER] Error building review queue:', queue_error);
            http_server_response.status(500).json({ error: queue_error.message });
        }
    });

    // WHAT: Records an append-only human review event and updates per-item review state cleanly.
    // WHY: Preserves exact model confidence/version at review time for calibration plots without overwriting history.
    router.post('/api/dicer/review-events', (http_incoming_request, http_server_response) => {
        try {
            const result = append_review_event_and_sync_item(db, http_incoming_request.body || {});
            const sitting_progress = get_calibration_dashboard_summary(db).sitting_progress;
            http_server_response.json({
                ...result,
                sitting_progress
            });
        } catch (review_event_error) {
            console.error('[PROMPT-DICER] Error recording review event:', review_event_error);
            http_server_response.status(400).json({ error: review_event_error.message });
        }
    });

    // WHAT: Computes score histograms, model confidence calibration bands, Pass D recall estimates, and sitting progress.
    // WHY: Surfaces data-driven evidence for calibrating Ovis grounding thresholds and measuring Laya fine-tune gains.
    router.get('/api/dicer/calibration-dashboard', (http_incoming_request, http_server_response) => {
        try {
            const analytics = get_calibration_dashboard_summary(db);
            http_server_response.json({
                success: true,
                ...analytics
            });
        } catch (calibration_error) {
            console.error('[PROMPT-DICER] Error computing calibration dashboard:', calibration_error);
            http_server_response.status(500).json({ error: calibration_error.message });
        }
    });

    // WHAT: Exports all verified prompt ingredient interactions as JSONL training/holdout data.
    // WHY: Supports human-reviewed gating (`reviewed_only=true`) and deterministic `train`/`holdout` splitting for Laya & CLM evaluation.
    router.get('/api/dicer/export-training-data', (http_incoming_request, http_server_response) => {
        try {
            const reviewed_only_param = String(http_incoming_request.query?.reviewed_only || '').toLowerCase();
            const reviewed_only = reviewed_only_param === 'true' || reviewed_only_param === '1';
            const split_param = ['train', 'holdout', 'all'].includes(http_incoming_request.query?.split)
                ? http_incoming_request.query.split
                : 'all';
            const raw_ratio = Number(http_incoming_request.query?.holdout_ratio);
            const holdout_ratio = Number.isFinite(raw_ratio) ? raw_ratio : 0.2;

            const exported_jsonl_lines = export_active_learning_dataset_jsonl(db, {
                reviewed_only,
                split: split_param,
                holdout_ratio
            });
            const serialized_dataset = exported_jsonl_lines.join('\n');

            http_server_response.setHeader('Content-Type', 'application/x-jsonlines; charset=utf-8');
            http_server_response.setHeader('Content-Disposition', `attachment; filename="prompt_dicer_${split_param}_data.jsonl"`);
            http_server_response.setHeader('X-Dicer-Reviewed-Only', String(reviewed_only));
            http_server_response.setHeader('X-Dicer-Split', split_param);
            http_server_response.send(serialized_dataset);
        } catch (export_dataset_error) {
            console.error('[PROMPT-DICER] Error exporting training data:', export_dataset_error);
            http_server_response.status(500).json({ error: export_dataset_error.message });
        }
    });

    return router;
}
