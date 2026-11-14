/**
 * Prompt Dicer Service: Ingredient Catalog & Remix System
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 * Pure Functional Architecture is strictly enforced: pure calculations, immutable objects,
 * no classes or `this` for domain logic, and explicit side-effect boundaries.
 */

import { local_ai_client_instance } from './localAiClient.js';
import {
    ALLOWED_INGREDIENT_SLOTS,
    ALLOWED_MEASURED_UNITS,
    ALLOWED_INTERACTION_TYPES,
    OVIS_FACET_LABEL_NORMALIZATION_MAP,
    DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS,
    PASS_A_SYSTEM_PROMPT,
    PASS_B_SYSTEM_PROMPT,
    PASS_D_SYSTEM_PROMPT,
    PASS_A_JSON_SCHEMA,
    PASS_B_JSON_SCHEMA,
    PASS_D_JSON_SCHEMA
} from './promptDicer/schemasAndConstants.js';

export {
    ALLOWED_INGREDIENT_SLOTS,
    ALLOWED_MEASURED_UNITS,
    ALLOWED_INTERACTION_TYPES,
    OVIS_FACET_LABEL_NORMALIZATION_MAP,
    DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS,
    PASS_A_SYSTEM_PROMPT,
    PASS_B_SYSTEM_PROMPT,
    PASS_D_SYSTEM_PROMPT,
    PASS_A_JSON_SCHEMA,
    PASS_B_JSON_SCHEMA,
    PASS_D_JSON_SCHEMA
};

// ============================================================================
// 3. PURE COMPUTATION & TRANSFORMATION FUNCTIONS
// ============================================================================

/**
 * WHAT: Generates a deterministic prompt_id formatted as prm_00142 when linked to an image_id.
 * WHY: Ensures re-dicing an image in images.db updates its existing Master Record instead of creating duplicates.
 *
 * @param {number|null} image_identifier - Database ID from the images table, if linked.
 * @param {string|null} explicit_prompt_identifier - Explicit ID override, if provided.
 * @returns {string} Formatted prompt identifier (e.g., "prm_01155").
 */
export function format_deterministic_prompt_identifier(image_identifier = null, explicit_prompt_identifier = null) {
    if (typeof explicit_prompt_identifier === 'string' && explicit_prompt_identifier.trim().length > 0) {
        return explicit_prompt_identifier.trim();
    }
    const numeric_image_identifier = Number(image_identifier);
    if (Number.isSafeInteger(numeric_image_identifier) && numeric_image_identifier > 0) {
        return `prm_${String(numeric_image_identifier).padStart(5, '0')}`;
    }
    return `prm_${Date.now().toString(36)}`;
}

/**
 * WHAT: Computes the physicality ratio scoring the concreteness of a prompt.
 * WHY: High ratio indicates concrete, observable instructions that diffusion models render faithfully,
 *      while low ratio indicates heavy reliance on ambiguous pretext/vibe adjectives.
 * 
 * @param {number} count_of_physical_anchors - Number of concrete physical anchors.
 * @param {number} count_of_pretext_terms - Number of abstract vibe/hype words.
 * @param {number} pretext_penalty_weight - Penalty multiplier for pretext terms (default 1.5).
 * @returns {number} Score rounded to 2 decimal places between 0.0 and 1.0.
 */
export function compute_physicality_ratio(
    count_of_physical_anchors,
    count_of_pretext_terms,
    pretext_penalty_weight = 1.5
) {
    const safe_physical_count = Math.max(0, Number(count_of_physical_anchors) || 0);
    const safe_pretext_count = Math.max(0, Number(count_of_pretext_terms) || 0);
    const weighted_total_of_instructions_and_pretext = (
        safe_physical_count + (safe_pretext_count * pretext_penalty_weight)
    );
    const safe_denominator = Math.max(1, weighted_total_of_instructions_and_pretext);
    const calculated_physicality_ratio = Number((safe_physical_count / safe_denominator).toFixed(2));
    return calculated_physicality_ratio;
}

/**
 * WHAT: Assembles the Pass C Master Record by deterministically combining Pass A, Pass B, and Pass D outputs.
 * WHY: Ingestion does not need fuzzy matching. Sequential `ing_1`, `ing_2`, ... IDs are minted in order,
 *      attaching concrete anchors, pretext terms with observable replacements, and directed influences.
 * 
 * @param {Object} pass_a_structured_output - Validated Pass A object { media_type, subjects, ambiguous_clauses }.
 * @param {Object} pass_b_structured_output - Validated Pass B object { pretext_terms, physical_anchors }.
 * @param {string} prompt_identifier - Stable prompt ID (e.g., "prm_00142").
 * @param {string} raw_prompt_text - Full original prompt text.
 * @param {string} media_type - "image" or "video".
 * @param {ReadonlyArray<Object>} influences_collection - Directed influence edges from Pass D.
 * @returns {Object} Complete Pass C/D master record matching pass_c_remix_lens.md and pass_d_influence_seeds.md.
 */
export function assemble_pass_c_master_record(
    pass_a_structured_output,
    pass_b_structured_output,
    prompt_identifier,
    raw_prompt_text,
    media_type = 'image',
    influences_collection = []
) {
    const safe_subjects_collection = Array.isArray(pass_a_structured_output?.subjects)
        ? pass_a_structured_output.subjects.map(subject_entry => Object.freeze({ ...subject_entry }))
        : [];

    const safe_ambiguous_clauses_collection = Array.isArray(pass_a_structured_output?.ambiguous_clauses)
        ? pass_a_structured_output.ambiguous_clauses.map(clause_entry => Object.freeze({ ...clause_entry }))
        : [];

    const safe_physical_anchors = Array.isArray(pass_b_structured_output?.physical_anchors)
        ? pass_b_structured_output.physical_anchors
        : [];

    const safe_pretext_terms = Array.isArray(pass_b_structured_output?.pretext_terms)
        ? pass_b_structured_output.pretext_terms
        : [];

    // WHAT: Minting sequential ingredient IDs (ing_1, ing_2, ...) in immutable order.
    // WHY: Provides deterministic, collision-free identification for graph edges and influence tracking.
    const physical_ingredients_collection = safe_physical_anchors.map((physical_anchor_record, anchor_index) => {
        const sequential_ingredient_identifier = `ing_${anchor_index + 1}`;
        return Object.freeze({
            ingredient_id: sequential_ingredient_identifier,
            kind: 'physical_anchor',
            text: physical_anchor_record.ingredient_text || '',
            slot: physical_anchor_record.slot || 'other',
            bound_to_subject_id: physical_anchor_record.bound_to_subject_id || null,
            measured_value: physical_anchor_record.measured_value
                ? Object.freeze({
                    number: Number(physical_anchor_record.measured_value.number),
                    unit: String(physical_anchor_record.measured_value.unit)
                })
                : null
        });
    });

    const physical_anchors_count = physical_ingredients_collection.length;

    const pretext_ingredients_collection = safe_pretext_terms.map((pretext_term_record, pretext_index) => {
        const sequential_ingredient_identifier = `ing_${physical_anchors_count + pretext_index + 1}`;
        return Object.freeze({
            ingredient_id: sequential_ingredient_identifier,
            kind: 'pretext_term',
            text: pretext_term_record.term_as_written || '',
            slot: pretext_term_record.tag_slot || 'mood',
            bound_to_subject_id: pretext_term_record.bound_to_subject_id || null,
            observable_replacement: Object.freeze({
                text: pretext_term_record.observable_replacement_text || '',
                replacement_slot: pretext_term_record.replacement_slot || 'lighting'
            })
        });
    });

    const all_ingredients_collection = Object.freeze([
        ...physical_ingredients_collection,
        ...pretext_ingredients_collection
    ]);

    const calculated_physicality_ratio = compute_physicality_ratio(
        physical_ingredients_collection.length,
        pretext_ingredients_collection.length
    );

    const safe_influences_collection = Array.isArray(influences_collection)
        ? influences_collection.map(influence_item => Object.freeze({ ...influence_item }))
        : [];

    return Object.freeze({
        prompt_id: prompt_identifier,
        media_type: media_type,
        raw_prompt: raw_prompt_text,
        metrics: Object.freeze({
            physical_anchor_count: physical_ingredients_collection.length,
            pretext_term_count: pretext_ingredients_collection.length,
            physicality_ratio: calculated_physicality_ratio
        }),
        subjects: Object.freeze(safe_subjects_collection),
        ambiguous_clauses: Object.freeze(safe_ambiguous_clauses_collection),
        ingredients: all_ingredients_collection,
        influences: Object.freeze(safe_influences_collection)
    });
}

/**
 * WHAT: Translates a raw `image_facets` label into a clean photographic prompt phrase.
 * WHY: Handles legacy underscore slugs and full taxonomy phrases uniformly via a static lookup table.
 * 
 * @param {string|null|undefined} raw_facet_value - Raw column value from `image_facets`.
 * @returns {string|null} Normalized phrase or null when empty.
 */
import {
    normalize_ovis_facet_value_to_phrase,
    build_ovis_facet_fallback_ingredients,
    append_ovis_facet_fallbacks_to_master_record,
    compute_normalized_vector_cosine_similarity,
    classify_caption_visual_grounding,
    score_per_ingredient_visual_grounding,
    LAYA_SLOT_CHOICE_CRITERIA,
    build_laya_slot_and_state_questions,
    apply_laya_confidence_gates
} from './promptDicer/visualGrounding.js';

export {
    normalize_ovis_facet_value_to_phrase,
    build_ovis_facet_fallback_ingredients,
    append_ovis_facet_fallbacks_to_master_record,
    compute_normalized_vector_cosine_similarity,
    classify_caption_visual_grounding,
    score_per_ingredient_visual_grounding,
    LAYA_SLOT_CHOICE_CRITERIA,
    build_laya_slot_and_state_questions,
    apply_laya_confidence_gates
};

import {
    extract_prompts_from_image_records,
    execute_heuristic_offline_dicing,
    build_heuristic_influences_for_master_record
} from "./promptDicer/heuristicDicer.js";
export {
    extract_prompts_from_image_records,
    execute_heuristic_offline_dicing,
    build_heuristic_influences_for_master_record
};

// ============================================================================
// 6. LLAMA-SERVER PIPELINE EXECUTION (PASS A -> B -> C -> D)
// ============================================================================

/**
 * WHAT: Executes a single LLM pass constrained by a JSON schema via llama-server.
 * WHY: llama-server uses context-free grammar constraints to guarantee valid JSON adhering to the spec.
 */
async function call_llama_server_with_json_schema(system_prompt, user_content, json_schema) {
    const chat_completions_endpoint_url = local_ai_client_instance.getChatCompletionsUrl();
    const active_model_identifier = local_ai_client_instance.getActiveModelIdentifier();

    const request_payload = {
        model: active_model_identifier,
        messages: [
            { role: 'system', content: system_prompt },
            { role: 'user', content: user_content }
        ],
        temperature: 0.1,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'structured_diced_output',
                strict: true,
                schema: json_schema
            }
        }
    };

    const fetch_abort_controller = new AbortController();
    const timeout_handle = setTimeout(() => {
        fetch_abort_controller.abort();
    }, 45000);

    try {
        const http_response = await fetch(chat_completions_endpoint_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(request_payload),
            signal: fetch_abort_controller.signal
        });

        clearTimeout(timeout_handle);

        if (!http_response.ok) {
            const error_body_text = await http_response.text();
            throw new Error(`llama-server responded with HTTP ${http_response.status}: ${error_body_text}`);
        }

        const completion_response_json = await http_response.json();
        const raw_completion_text = completion_response_json.choices?.[0]?.message?.content || '{}';
        return JSON.parse(raw_completion_text);
    } catch (network_or_grammar_error) {
        clearTimeout(timeout_handle);
        throw network_or_grammar_error;
    }
}

/**
 * WHAT: Runs the full 4-pass dicing pipeline on a single prompt or image record.
 * WHY: Orchestrates Pass A (Subject binding), Pass B (Pretext vs Physical), Pass C (Master Record),
 *      and Pass D (Influence seeds), falling back to the deterministic heuristic engine if llama-server is offline.
 * 
 * @param {Object} dicing_request_parameters
 * @param {string} dicing_request_parameters.prompt_text - Raw prompt text to split.
 * @param {string} dicing_request_parameters.media_type - "image" or "video".
 * @param {number|null} dicing_request_parameters.image_id - Optional database image ID.
 * @param {string} dicing_request_parameters.prompt_identifier - Optional ID (e.g. "prm_00142").
 * @param {Object|null} dicing_request_parameters.image_context - Optional { objects, tags, scene_type } from images.db.
 * @param {boolean} dicing_request_parameters.run_pass_d_influences - Whether to extract influence seeds.
 * @param {boolean} dicing_request_parameters.force_heuristic - Force heuristic offline execution.
 * @returns {Promise<{ master_record: Object, influences: ReadonlyArray<Object>, execution_mode: string }>}
 */
/**
 * WHAT: Appends Ovis fallbacks (recording sync status) and optionally runs Laya confidence gating.
 * WHY: Avoids duplicating post-Pass-D enrichment between heuristic and llama-server paths.
 */
async function finalize_dicing_pipeline_output(
    base_complete_master_record,
    influences_collection,
    execution_mode_label,
    dicing_request_parameters
) {
    const ovis_facets_record = dicing_request_parameters.ovis_facets || null;
    const mark_ovis_sync_attempted = Boolean(
        dicing_request_parameters.mark_ovis_sync_attempted ?? (dicing_request_parameters.ovis_facets !== undefined)
    );

    const ovis_fallback_ingredients = build_ovis_facet_fallback_ingredients(
        ovis_facets_record,
        base_complete_master_record.ingredients
    );
    const enriched_master_record = append_ovis_facet_fallbacks_to_master_record(
        base_complete_master_record,
        ovis_fallback_ingredients,
        { sync_attempted: mark_ovis_sync_attempted }
    );

    const laya_decide_adapter = typeof dicing_request_parameters.laya_decide_adapter === 'function'
        ? dicing_request_parameters.laya_decide_adapter
        : null;

    if (!laya_decide_adapter) {
        return Object.freeze({
            master_record: enriched_master_record,
            influences: Object.freeze(influences_collection),
            execution_mode: execution_mode_label
        });
    }

    const questions_specification = build_laya_slot_and_state_questions(
        enriched_master_record.ingredients,
        influences_collection
    );
    if (Object.keys(questions_specification).length === 0) {
        return Object.freeze({
            master_record: enriched_master_record,
            influences: Object.freeze(influences_collection),
            execution_mode: execution_mode_label
        });
    }

    try {
        const laya_response = await laya_decide_adapter(
            dicing_request_parameters.prompt_text || '',
            questions_specification
        );
        const laya_answers = laya_response?.answers || laya_response || {};
        const gated_result = apply_laya_confidence_gates(
            enriched_master_record.ingredients,
            influences_collection,
            laya_answers,
            dicing_request_parameters.laya_gate_options
        );
        return Object.freeze({
            master_record: Object.freeze({
                ...enriched_master_record,
                ingredients: gated_result.ingredients,
                laya_validation: gated_result.summary
            }),
            influences: gated_result.influences,
            execution_mode: execution_mode_label
        });
    } catch (laya_gate_error) {
        console.warn('[PromptDicer] Optional Laya confidence gate skipped:', laya_gate_error.message);
        return Object.freeze({
            master_record: enriched_master_record,
            influences: Object.freeze(influences_collection),
            execution_mode: execution_mode_label
        });
    }
}

/**
 * WHAT: Executes the full 4-pass Prompt Dicer pipeline (Subject Binding, Pretext vs Physical, Remix Master Record, and Influence Edges).
 * WHY: Orchestrates LLM-backed extraction with automatic heuristic offline fallback and optional Laya validation gates
 *      so callers always receive an immutable, schema-compliant Master Record regardless of local model availability.
 *
 * @param {Object} dicing_request_parameters - Prompt text, media type, identifiers, and optional Laya/Ovis context.
 * @returns {Promise<Object>} Frozen `{ master_record, influences, execution_mode }`.
 */
export async function execute_prompt_dicing_pipeline(dicing_request_parameters) {
    const prompt_text = String(dicing_request_parameters.prompt_text || '').trim();
    const media_type = dicing_request_parameters.media_type === 'video' ? 'video' : 'image';
    const prompt_identifier = format_deterministic_prompt_identifier(
        dicing_request_parameters.image_id,
        dicing_request_parameters.prompt_identifier
    );
    const run_pass_d = dicing_request_parameters.run_pass_d_influences ?? true;
    const force_heuristic = dicing_request_parameters.force_heuristic ?? false;
    const image_context = dicing_request_parameters.image_context || null;

    const discovered_model = force_heuristic ? null : await local_ai_client_instance.discoverActiveModel();
    const is_server_available = !force_heuristic && discovered_model !== null;

    if (!is_server_available) {
        const heuristic_dicing_result = execute_heuristic_offline_dicing(prompt_text, media_type, image_context);
        const initial_master_record = assemble_pass_c_master_record(
            heuristic_dicing_result.pass_a,
            heuristic_dicing_result.pass_b,
            prompt_identifier,
            prompt_text,
            media_type,
            []
        );
        const heuristic_influences = run_pass_d
            ? build_heuristic_influences_for_master_record(initial_master_record)
            : Object.freeze([]);

        const base_complete_master_record = assemble_pass_c_master_record(
            heuristic_dicing_result.pass_a,
            heuristic_dicing_result.pass_b,
            prompt_identifier,
            prompt_text,
            media_type,
            heuristic_influences
        );

        return finalize_dicing_pipeline_output(
            base_complete_master_record,
            heuristic_influences,
            'heuristic_offline',
            dicing_request_parameters
        );
    }

    // 1. PASS A: Subject Binding Grid
    const pass_a_user_content = `MEDIA_TYPE: ${media_type}\nPROMPT:\n${prompt_text}`;
    const pass_a_result = await call_llama_server_with_json_schema(
        PASS_A_SYSTEM_PROMPT,
        pass_a_user_content,
        PASS_A_JSON_SCHEMA
    );

    // 2. PASS B: Pretext Words vs Physical Anchors
    const pass_b_user_content = `MEDIA_TYPE: ${media_type}\nSUBJECT_LIST_JSON: ${JSON.stringify(pass_a_result.subjects)}\nPROMPT:\n${prompt_text}`;
    const pass_b_result = await call_llama_server_with_json_schema(
        PASS_B_SYSTEM_PROMPT,
        pass_b_user_content,
        PASS_B_JSON_SCHEMA
    );

    // 3. PASS C: Assemble Master Record in deterministic code
    const initial_master_record = assemble_pass_c_master_record(
        pass_a_result,
        pass_b_result,
        prompt_identifier,
        prompt_text,
        media_type,
        []
    );

    // 4. PASS D: Influence Seeds
    let extracted_influences = [];
    if (run_pass_d && initial_master_record.ingredients.length > 1) {
        const pass_d_user_content = `MEDIA_TYPE: ${media_type}\nSUBJECT_LIST_JSON: ${JSON.stringify(initial_master_record.subjects)}\nINGREDIENT_LIST_JSON: ${JSON.stringify(initial_master_record.ingredients)}\nPROMPT:\n${prompt_text}`;

        try {
            const pass_d_result = await call_llama_server_with_json_schema(
                PASS_D_SYSTEM_PROMPT,
                pass_d_user_content,
                PASS_D_JSON_SCHEMA
            );
            const valid_ingredient_ids = new Set(initial_master_record.ingredients.map(ing => ing.ingredient_id));
            extracted_influences = (Array.isArray(pass_d_result?.influences) ? pass_d_result.influences : [])
                .filter(inf =>
                    valid_ingredient_ids.has(inf.source_ingredient_id) &&
                    valid_ingredient_ids.has(inf.target_ingredient_id) &&
                    inf.source_ingredient_id !== inf.target_ingredient_id
                );
        } catch (pass_d_error) {
            console.warn('[PromptDicer] Warning: Pass D influence extraction encountered an error:', pass_d_error.message);
        }
    }

    const base_complete_master_record = assemble_pass_c_master_record(
        pass_a_result,
        pass_b_result,
        prompt_identifier,
        prompt_text,
        media_type,
        extracted_influences
    );

    return finalize_dicing_pipeline_output(
        base_complete_master_record,
        extracted_influences,
        'llama_server_grammar',
        dicing_request_parameters
    );
}

export {
    DEFAULT_TRANSPLANT_LOCKED_SLOTS,
    ENVIRONMENT_AND_CAMERA_FILL_SLOTS,
    detect_ingredient_clashes,
    assemble_remixed_prompt_text,
    resolve_ingredient_influence_closure,
    solve_constraint_transplant_beam,
    verify_prompt_round_trip,
    MONDOCRAFT_REMIX_MEMORY_LIMIT,
    MONDOCRAFT_OPENING_WORD_COUNT,
    ALLOWED_REMIX_STYLE_MODES,
    tidy_prompt_whitespace,
    extract_normalized_prompt_words,
    build_prompt_similarity_features,
    compute_sequence_matcher_ratio,
    are_near_copy_features,
    are_near_copy_prompts,
    cluster_near_copy_prompt_families,
    deduplicate_candidate_pool_by_family,
    extract_remix_opening_signature,
    is_candidate_rejected_by_memory,
    compute_candidate_staleness_score,
    select_freshest_beam_candidates,
    compute_source_success_weight_multiplier,
    compute_keeper_weighted_bonus,
    select_indefinite_article,
    pluralize_english_noun,
    recase_first_letter,
    strip_leading_determiners_and_numbers,
    build_span_replacement_edit,
    apply_non_overlapping_span_edits,
    apply_in_place_prompt_edits,
    apply_dream_mode_transformation
} from "./promptDicer/clashAndRemix.js";


export {
    REVIEW_SITTING_TARGETS,
    build_stratified_review_queue_order,
    compute_calibration_and_grounding_analytics
} from './promptDicer/reviewAnalytics.js';
