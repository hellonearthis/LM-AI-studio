/**
 * Prompt Dicer Pipeline & Master Record Test Suite
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compute_physicality_ratio,
    assemble_pass_c_master_record,
    detect_ingredient_clashes,
    assemble_remixed_prompt_text,
    extract_prompts_from_image_records,
    execute_heuristic_offline_dicing,
    execute_prompt_dicing_pipeline,
    normalize_ovis_facet_value_to_phrase,
    build_ovis_facet_fallback_ingredients,
    append_ovis_facet_fallbacks_to_master_record,
    compute_normalized_vector_cosine_similarity,
    classify_caption_visual_grounding,
    score_per_ingredient_visual_grounding,
    build_laya_slot_and_state_questions,
    apply_laya_confidence_gates,
    DEFAULT_TRANSPLANT_LOCKED_SLOTS,
    resolve_ingredient_influence_closure,
    solve_constraint_transplant_beam,
    verify_prompt_round_trip,
    ALLOWED_INGREDIENT_SLOTS,
    REVIEW_SITTING_TARGETS,
    build_stratified_review_queue_order,
    compute_calibration_and_grounding_analytics,
    cluster_near_copy_prompt_families,
    deduplicate_candidate_pool_by_family,
    compute_source_success_weight_multiplier,
    compute_keeper_weighted_bonus,
    is_candidate_rejected_by_memory,
    compute_candidate_staleness_score,
    apply_in_place_prompt_edits,
    apply_dream_mode_transformation
} from '../services/promptDicerService.js';

test('compute_physicality_ratio calculates exact weighted ratios with pretext penalty', () => {
    // WHAT: Testing standard case from pass_c_remix_lens.md (8 physical anchors, 2 pretext terms)
    // WHY: 8 / (8 + 2 * 1.5) = 8 / 11 = 0.7272... => rounded to 0.73
    const ratio_sample_record = compute_physicality_ratio(8, 2, 1.5);
    assert.equal(ratio_sample_record, 0.73);

    // WHAT: Testing pure physical prompt (5 physical, 0 pretext)
    // WHY: 5 / (5 + 0) = 1.0
    const ratio_pure_physical = compute_physicality_ratio(5, 0, 1.5);
    assert.equal(ratio_pure_physical, 1.0);

    // WHAT: Testing zero instructions guard against division by zero
    // WHY: max(1, 0) avoids NaN or Infinity crashes
    const ratio_empty_guard = compute_physicality_ratio(0, 0, 1.5);
    assert.equal(ratio_empty_guard, 0.0);
});

test('assemble_pass_c_master_record creates deterministic sequential ingredient IDs', () => {
    const mock_pass_a_output = {
        media_type: 'video',
        subjects: [
            {
                subject_id: 'subject_1',
                role_label: 'detective',
                source_reference_tag: 'Image 1',
                requires_reference_image: true,
                theta_role: 'AGENT',
                verb_action: 'aiming',
                instrument: 'flashlight',
                target_subject_id: 'subject_2',
                speech_state: 'locked_silent'
            },
            {
                subject_id: 'subject_2',
                role_label: 'bartender',
                source_reference_tag: null,
                requires_reference_image: false,
                theta_role: 'PATIENT',
                verb_action: 'wiping',
                instrument: 'glass',
                target_subject_id: null,
                speech_state: 'locked_silent'
            }
        ],
        ambiguous_clauses: []
    };

    const mock_pass_b_output = {
        physical_anchors: [
            {
                ingredient_text: 'wide shot',
                slot: 'framing',
                bound_to_subject_id: null,
                measured_value: null
            },
            {
                ingredient_text: '35mm lens',
                slot: 'lens',
                bound_to_subject_id: null,
                measured_value: { number: 35, unit: 'mm' }
            }
        ],
        pretext_terms: [
            {
                term_as_written: 'lovecraftian',
                bound_to_subject_id: null,
                tag_slot: 'mood',
                observable_replacement_text: 'deep green-black shadows obscuring architecture',
                replacement_slot: 'lighting'
            }
        ]
    };

    const assembled_master_record = assemble_pass_c_master_record(
        mock_pass_a_output,
        mock_pass_b_output,
        'prm_00142',
        'A lovecraftian wide shot on 35mm lens of a detective.',
        'video'
    );

    assert.equal(assembled_master_record.prompt_id, 'prm_00142');
    assert.equal(assembled_master_record.media_type, 'video');
    assert.equal(assembled_master_record.metrics.physical_anchor_count, 2);
    assert.equal(assembled_master_record.metrics.pretext_term_count, 1);
    assert.equal(assembled_master_record.metrics.physicality_ratio, 0.57); // 2 / (2 + 1.5) = 2 / 3.5 = 0.5714...

    assert.equal(assembled_master_record.ingredients.length, 3);
    assert.equal(assembled_master_record.ingredients[0].ingredient_id, 'ing_1');
    assert.equal(assembled_master_record.ingredients[0].kind, 'physical_anchor');
    assert.equal(assembled_master_record.ingredients[1].ingredient_id, 'ing_2');
    assert.equal(assembled_master_record.ingredients[1].measured_value.number, 35);
    assert.equal(assembled_master_record.ingredients[2].ingredient_id, 'ing_3');
    assert.equal(assembled_master_record.ingredients[2].kind, 'pretext_term');
    assert.equal(assembled_master_record.ingredients[2].observable_replacement.replacement_slot, 'lighting');

    // Immutability verification
    assert.ok(Object.isFrozen(assembled_master_record));
    assert.ok(Object.isFrozen(assembled_master_record.ingredients));
});

test('detect_ingredient_clashes detects state_key conflicts and clashes_with_value contradictions', () => {
    const selected_ingredients_sample = [
        { ingredient_id: 'ing_1', text: 'heavy rain', slot: 'weather_or_matter' },
        { ingredient_id: 'ing_2', text: 'trenchcoat', slot: 'subject_appearance' },
        { ingredient_id: 'ing_3', text: 'desert dust storm', slot: 'weather_or_matter' }
    ];

    const active_influences_sample = [
        {
            source_ingredient_id: 'ing_1',
            target_ingredient_id: 'ing_2',
            state_key: 'surface_moisture',
            applied_state_value: 'wet_specular',
            clashes_with_value: 'dry_matte_dust'
        },
        {
            source_ingredient_id: 'ing_3',
            target_ingredient_id: 'ing_2',
            state_key: 'surface_moisture',
            applied_state_value: 'dry_matte_dust',
            clashes_with_value: 'wet_specular'
        }
    ];

    const detected_clashes = detect_ingredient_clashes(
        selected_ingredients_sample,
        active_influences_sample
    );

    assert.equal(detected_clashes.length, 1);
    assert.equal(detected_clashes[0].state_key, 'surface_moisture');
    assert.equal(detected_clashes[0].applied_value_alpha, 'wet_specular');
    assert.equal(detected_clashes[0].applied_value_beta, 'dry_matte_dust');
});

test('detect_ingredient_clashes allows subject-scoped opposing states on separate subjects', () => {
    const selected_ingredients_sample = [
        { ingredient_id: 'ing_1', text: 'heavy rain', slot: 'weather_or_matter' },
        { ingredient_id: 'ing_2', text: 'wet trenchcoat', slot: 'subject_appearance', bound_to_subject_id: 'subject_1' },
        { ingredient_id: 'ing_3', text: 'desert dust', slot: 'weather_or_matter' },
        { ingredient_id: 'ing_4', text: 'dry boots', slot: 'subject_appearance', bound_to_subject_id: 'subject_2' }
    ];

    const active_influences_sample = [
        {
            source_ingredient_id: 'ing_1',
            target_ingredient_id: 'ing_2',
            target_subject_scope: 'same_subject_only',
            state_key: 'surface_moisture',
            applied_state_value: 'wet_specular',
            clashes_with_value: 'dry_matte_dust'
        },
        {
            source_ingredient_id: 'ing_3',
            target_ingredient_id: 'ing_4',
            target_subject_scope: 'same_subject_only',
            state_key: 'surface_moisture',
            applied_state_value: 'dry_matte_dust',
            clashes_with_value: 'wet_specular'
        }
    ];

    const detected_clashes = detect_ingredient_clashes(
        selected_ingredients_sample,
        active_influences_sample
    );

    assert.equal(detected_clashes.length, 0);
});

test('build_heuristic_influences_for_master_record does not tag neutral weather as dry_matte_dust', async () => {
    const dicing_result = await execute_prompt_dicing_pipeline({
        prompt_text: 'A detective in a wool coat stands in drifting smoke.',
        media_type: 'image',
        force_heuristic: true
    });

    const moisture_influences = dicing_result.influences.filter(
        influence_item => influence_item.state_key === 'surface_moisture'
    );
    assert.equal(moisture_influences.length, 0);
});

test('assemble_remixed_prompt_text orders clauses by slot and appends active consequences', () => {
    const sample_ingredients = [
        { ingredient_id: 'ing_1', kind: 'physical_anchor', text: 'heavy rain', slot: 'weather_or_matter' },
        { ingredient_id: 'ing_2', kind: 'physical_anchor', text: 'in a trenchcoat', slot: 'subject_appearance' },
        { ingredient_id: 'ing_3', kind: 'physical_anchor', text: '85mm lens', slot: 'lens' },
        {
            ingredient_id: 'ing_4',
            kind: 'pretext_term',
            text: 'cinematic',
            slot: 'mood',
            observable_replacement: {
                text: 'anamorphic flare with 2.39:1 aspect ratio',
                replacement_slot: 'lens'
            }
        }
    ];

    const active_consequences = [
        'darkened wet fabric with specular highlights'
    ];

    const remixed_prompt = assemble_remixed_prompt_text(
        sample_ingredients,
        active_consequences,
        { include_observable_replacements: true }
    );

    assert.ok(remixed_prompt.includes('85mm lens'));
    assert.ok(remixed_prompt.includes('anamorphic flare with 2.39:1 aspect ratio'));
    assert.ok(remixed_prompt.includes('in a trenchcoat'));
    assert.ok(remixed_prompt.includes('heavy rain'));
    assert.ok(remixed_prompt.includes('darkened wet fabric with specular highlights'));
});

test('extract_prompts_from_image_records extracts ComfyUI CLIP prompt nodes and A1111 parameters', () => {
    const mock_comfy_metadata = JSON.stringify({
        prompt: {
            "6": {
                class_type: "CLIPTextEncode",
                inputs: {
                    text: "A black and white woodblock print of a cat, bold lines, abstract details."
                }
            }
        }
    });

    const mock_a1111_metadata = JSON.stringify({
        parameters: "masterpiece, 85mm portrait of a weary detective\nNegative prompt: blurry, ugly\nSteps: 30, Sampler: DPM++ 2M"
    });

    const comfy_extracted = extract_prompts_from_image_records(mock_comfy_metadata, null);
    assert.equal(comfy_extracted.length, 1);
    assert.equal(comfy_extracted[0].source_type, 'comfyui_node_text');
    assert.ok(comfy_extracted[0].prompt_text.includes('woodblock print of a cat'));

    const a1111_extracted = extract_prompts_from_image_records(mock_a1111_metadata, null);
    assert.equal(a1111_extracted.length, 1);
    assert.equal(a1111_extracted[0].source_type, 'automatic1111_parameters');
    assert.equal(a1111_extracted[0].prompt_text, 'masterpiece, 85mm portrait of a weary detective');
});

test('execute_prompt_dicing_pipeline runs cleanly in heuristic offline mode with Pass D influences', async () => {
    const sample_raw_prompt = 'A cinematic, lovecraftian wide shot on 35mm. Subject 1 (Image 1), a weary detective in a trenchcoat, stands in heavy rain under a 3200K sodium streetlamp.';
    
    const dicing_result = await execute_prompt_dicing_pipeline({
        prompt_text: sample_raw_prompt,
        media_type: 'video',
        force_heuristic: true
    });

    assert.equal(dicing_result.execution_mode, 'heuristic_offline');
    assert.ok(dicing_result.master_record.metrics.physical_anchor_count >= 3);
    assert.ok(dicing_result.master_record.metrics.pretext_term_count >= 1);
    assert.ok(dicing_result.master_record.metrics.physicality_ratio > 0);
    assert.ok(dicing_result.influences.length >= 1);
    assert.equal(dicing_result.influences[0].state_key, 'surface_moisture');
});

test('build_ovis_facet_fallback_ingredients normalizes slugs, respects confidence gates, and preserves metrics', async () => {
    assert.equal(normalize_ovis_facet_value_to_phrase('photography'), 'real-world photography');
    assert.equal(normalize_ovis_facet_value_to_phrase('wide_landscape'), 'wide scenic panoramic landscape vista');

    const facet_record = {
        medium: 'photography',
        confidence_medium: 0.48,
        composition: 'wide_landscape',
        confidence_composition: 0.56,
        mood: 'minimalist_serene',
        confidence_mood: 0.12 // below 0.50 mood threshold -> should be skipped
    };

    const existing_ingredients = [
        { ingredient_id: 'ing_1', kind: 'physical_anchor', text: '3200K tungsten key light', slot: 'lighting' },
        { ingredient_id: 'ing_2', kind: 'physical_anchor', text: 'close-up portrait', slot: 'framing' }
    ];

    const fallback_ingredients = build_ovis_facet_fallback_ingredients(facet_record, existing_ingredients);
    // framing is already occupied, mood confidence is below 0.50 -> only film_stock_or_medium should be added
    assert.equal(fallback_ingredients.length, 1);
    assert.equal(fallback_ingredients[0].slot, 'film_stock_or_medium');
    assert.equal(fallback_ingredients[0].source, 'ovis_facet');
    assert.equal(fallback_ingredients[0].text, 'real-world photography');

    const dicing_with_facets = await execute_prompt_dicing_pipeline({
        prompt_text: 'A lantern on a wet dock at night.',
        force_heuristic: true,
        ovis_facets: {
            medium: 'three_dimensional_render',
            confidence_medium: 0.62,
            composition: 'portrait_headshot',
            confidence_composition: 0.58,
            mood: 'dark_moody',
            confidence_mood: 0.71
        }
    });

    const dicing_without_facets = await execute_prompt_dicing_pipeline({
        prompt_text: 'A lantern on a wet dock at night.',
        force_heuristic: true
    });

    assert.equal(
        dicing_with_facets.master_record.metrics.physicality_ratio,
        dicing_without_facets.master_record.metrics.physicality_ratio
    );
    assert.ok(dicing_with_facets.master_record.ingredients.some(item => item.source === 'ovis_facet' && item.slot === 'film_stock_or_medium'));
});

test('compute_normalized_vector_cosine_similarity and classify_caption_visual_grounding classify grounding states', () => {
    const identical_score = compute_normalized_vector_cosine_similarity([0.6, 0.8], [0.6, 0.8]);
    assert.equal(identical_score, 1);
    assert.equal(classify_caption_visual_grounding(0.35).grounding_status, 'grounded');
    assert.equal(classify_caption_visual_grounding(0.35).needs_reanalysis, false);

    assert.equal(classify_caption_visual_grounding(0.22).grounding_status, 'borderline');
    assert.equal(classify_caption_visual_grounding(0.22).needs_reanalysis, false);

    const mismatched = classify_caption_visual_grounding(0.11);
    assert.equal(mismatched.grounding_status, 'mismatched');
    assert.equal(mismatched.needs_reanalysis, true);
});

test('detect_ingredient_clashes discovers multi-hop transitive state clashes safely without infinite cycles', () => {
    const selected_ingredients = [
        { ingredient_id: 'ing_rain', text: 'heavy rain' },
        { ingredient_id: 'ing_sun', text: 'blazing dry sun' }
    ];

    const influence_edges = [
        {
            source_ingredient_id: 'ing_rain',
            target_ingredient_id: 'ing_puddle',
            state_key: 'surface_moisture',
            applied_state_value: 'wet'
        },
        {
            source_ingredient_id: 'ing_puddle',
            target_ingredient_id: 'ing_cobblestones',
            state_key: 'surface_reflectivity',
            applied_state_value: 'specular',
            clashes_with_value: 'matte_dry'
        },
        {
            source_ingredient_id: 'ing_cobblestones',
            target_ingredient_id: 'ing_rain',
            state_key: 'cycle_back_test',
            applied_state_value: 'looping',
            clashes_with_value: 'static'
        },
        {
            source_ingredient_id: 'ing_sun',
            target_ingredient_id: 'ing_cobblestones',
            state_key: 'surface_reflectivity',
            applied_state_value: 'matte_dry',
            clashes_with_value: 'specular'
        }
    ];

    const clashes = detect_ingredient_clashes(selected_ingredients, influence_edges, { max_hops: 3 });
    assert.ok(clashes.length >= 1);
    const transitive_clash = clashes.find(item => item.state_key === 'surface_reflectivity');
    assert.ok(transitive_clash, 'Expected transitive surface_reflectivity clash across rain -> puddle -> cobblestones vs sun');
    assert.equal(transitive_clash.is_transitive, true);
    assert.equal(transitive_clash.hop_depth, 2);
    assert.ok(Array.isArray(transitive_clash.chain_path) && transitive_clash.chain_path.length >= 2);
});

test('score_per_ingredient_visual_grounding pinpoints missing ingredients vs grounded ones', () => {
    const image_vector = [1.0, 0.0, 0.0];
    const ingredient_entries = [
        { ingredient_id: 'ing_1', text: 'wet cobblestone street', slot: 'setting', vector: [0.9, 0.1, 0.0] },
        { ingredient_id: 'ing_2', text: 'flying pink elephant', slot: 'subject_appearance', vector: [0.05, 0.99, 0.0] }
    ];

    const per_ingredient_result = score_per_ingredient_visual_grounding(image_vector, ingredient_entries);
    assert.equal(per_ingredient_result.grounded_count, 1);
    assert.equal(per_ingredient_result.mismatched_count, 1);
    assert.equal(per_ingredient_result.missing_ingredients.length, 1);
    assert.equal(per_ingredient_result.missing_ingredients[0].ingredient_id, 'ing_2');
});

test('build_laya_slot_and_state_questions and apply_laya_confidence_gates flag borderline slots and denied state claims', () => {
    const ingredients = [
        { ingredient_id: 'ing_1', text: '35mm anamorphic lens', slot: 'lens' },
        { ingredient_id: 'ing_2', text: 'glowing mist', slot: 'lighting' }
    ];
    const influences = [
        { source_ingredient_id: 'ing_2', target_ingredient_id: 'ing_1', state_key: 'visibility', applied_state_value: 'hazy' }
    ];

    const questions = build_laya_slot_and_state_questions(ingredients, influences);
    assert.equal(questions.slot__ing_1.type, 'choice');
    assert.equal(questions.state__0.type, 'choice');
    assert.ok(questions.state__0.criteria.yes && questions.state__0.criteria.no);

    const gated_result = apply_laya_confidence_gates(
        ingredients,
        influences,
        {
            slot__ing_1: { choice: 'lens', confidence: 0.91 },
            slot__ing_2: { choice: 'weather_or_matter', confidence: 0.42 },
            state__0: { choice: 'no', confidence: 0.78 }
        },
        { slot_confidence_min: 0.55, state_confidence_min: 0.60 }
    );

    assert.equal(gated_result.ingredients[0].needs_human_review, false);
    assert.equal(gated_result.ingredients[1].needs_human_review, true);
    assert.equal(gated_result.influences[0].laya_state_supported, false);
    assert.equal(gated_result.influences[0].needs_human_review, true);
    assert.equal(gated_result.review_flags_count, 2);
});

test('resolve_ingredient_influence_closure pulls implied downstream effects into unlocked slots and prunes orphaned receivers on removal', () => {
    const base_cause = { prompt_id: 'prm_00010', ingredient_id: 'ing_rain', slot: 'weather_or_matter', kind: 'physical_anchor', text: 'heavy downpour rain' };
    const implied_pavement = { prompt_id: 'prm_00010', ingredient_id: 'ing_pavement', slot: 'setting', kind: 'physical_anchor', text: 'glistening wet asphalt street' };

    const influences = [
        {
            prompt_id: 'prm_00010',
            source_ingredient_id: 'ing_rain',
            source_text: 'heavy downpour rain',
            target_ingredient_id: 'ing_pavement',
            target_text: 'glistening wet asphalt street',
            state_key: 'surface_moisture',
            applied_state_value: 'wet',
            clashes_with_value: 'bone_dry'
        }
    ];

    // Forward pull into unlocked `setting` slot
    const pulled_result = resolve_ingredient_influence_closure(
        [base_cause],
        influences,
        [implied_pavement],
        { locked_slots: ['lens'] }
    );
    assert.equal(pulled_result.pulled_effects.length, 1);
    assert.equal(pulled_result.ingredients.length, 2);
    assert.equal(pulled_result.ingredients[1].provenance, 'influence_closure');

    // Dropping the upstream cause prunes the unlocked auto-pulled receiver
    const pruned_result = resolve_ingredient_influence_closure(
        [pulled_result.ingredients[1]],
        influences,
        [implied_pavement],
        { locked_slots: ['lens'], removed_ingredients: [base_cause] }
    );
    assert.equal(pruned_result.pruned_orphans.length, 1);
    assert.equal(pruned_result.ingredients.length, 0);
});

test('solve_constraint_transplant_beam preserves locked slots, prunes hard clashes, and picks compatible candidates', () => {
    const base_ingredients = [
        { prompt_id: 'prm_00001', ingredient_id: 'ing_subj', slot: 'subject_appearance', kind: 'physical_anchor', text: 'weary detective in wool coat' },
        { prompt_id: 'prm_00001', ingredient_id: 'ing_light', slot: 'lighting', kind: 'physical_anchor', text: 'harbor tungsten bulb' }
    ];

    const candidate_pools_by_slot = {
        subject_appearance: [
            { prompt_id: 'prm_00099', ingredient_id: 'ing_other_subj', slot: 'subject_appearance', kind: 'physical_anchor', text: 'astronaut in spacesuit', cluster_match: true }
        ],
        lighting: [
            { prompt_id: 'prm_00002', ingredient_id: 'ing_clash_sun', slot: 'lighting', kind: 'physical_anchor', text: 'blazing desert noon glare', cluster_match: true, usage_count: 20 },
            { prompt_id: 'prm_00003', ingredient_id: 'ing_safe_neon', slot: 'lighting', kind: 'physical_anchor', text: 'cool cyan neon reflections', cluster_match: true, usage_count: 10 }
        ],
        weather_or_matter: [
            { prompt_id: 'prm_00004', ingredient_id: 'ing_mist', slot: 'weather_or_matter', kind: 'physical_anchor', text: 'dense river fog', cluster_match: true, usage_count: 8 }
        ]
    };

    const influences = [
        {
            source_ingredient_id: 'ing_subj',
            target_ingredient_id: 'ing_scene_state',
            state_key: 'lighting_environment',
            applied_state_value: 'moody_night',
            clashes_with_value: 'scorching_noon'
        },
        {
            source_ingredient_id: 'ing_clash_sun',
            target_ingredient_id: 'ing_scene_state',
            state_key: 'lighting_environment',
            applied_state_value: 'scorching_noon',
            clashes_with_value: 'moody_night'
        }
    ];

    const solved_plan = solve_constraint_transplant_beam(
        base_ingredients,
        candidate_pools_by_slot,
        influences,
        {
            locked_slots: DEFAULT_TRANSPLANT_LOCKED_SLOTS,
            swap_count: 2,
            allow_empty_fills: true
        }
    );

    // Locked `subject_appearance` must remain intact; clashing desert noon glare must be pruned in favor of safe neon + empty fill fog
    assert.ok(solved_plan.selected_ingredients.some(item => item.text === 'weary detective in wool coat'));
    assert.ok(!solved_plan.selected_ingredients.some(item => item.text === 'astronaut in spacesuit'));
    assert.ok(!solved_plan.selected_ingredients.some(item => item.text === 'blazing desert noon glare'));
    assert.ok(solved_plan.selected_ingredients.some(item => item.text === 'cool cyan neon reflections'));
    assert.ok(solved_plan.selected_ingredients.some(item => item.text === 'dense river fog'));
    assert.equal(solved_plan.clashes.length, 0);
});

test('verify_prompt_round_trip confirms intact prompts and flags dropped planned phrases', () => {
    const planned = [
        { ingredient_id: 'ing_1', slot: 'lens', kind: 'physical_anchor', text: '35mm anamorphic lens' },
        { ingredient_id: 'ing_2', slot: 'weather_or_matter', kind: 'physical_anchor', text: 'heavy rain' },
        { ingredient_id: 'ing_3', slot: 'lighting', kind: 'physical_anchor', text: '3200K sodium streetlamp' }
    ];

    const intact_verdict = verify_prompt_round_trip(
        planned,
        'heavy rain, 35mm anamorphic lens, 3200K sodium streetlamp'
    );
    assert.equal(intact_verdict.verified, true);
    assert.equal(intact_verdict.missing_anchors.length, 0);

    const drifted_verdict = verify_prompt_round_trip(
        planned,
        '35mm anamorphic lens in bright studio lighting'
    );
    assert.equal(drifted_verdict.verified, false);
    assert.ok(drifted_verdict.missing_anchors.includes('heavy rain'));
});

test('build_stratified_review_queue_order balances strata, sorts by uncertainty, and splices repeat checks', () => {
    const candidate_pool = [
        { card_key: 'c1', item_id: 'i1', card_type: 'slot_check', slot: 'lighting', source: 'prompt_extraction', length_bucket: 'short', model_confidence: 0.91 },
        { card_key: 'c2', item_id: 'i2', card_type: 'slot_check', slot: 'lighting', source: 'ovis_facet', length_bucket: 'short', model_confidence: 0.52 },
        { card_key: 'c3', item_id: 'i3', card_type: 'edge_check', slot: 'weather_or_matter', source: 'prompt_extraction', length_bucket: 'medium', model_confidence: 0.12 },
        { card_key: 'c4', item_id: 'i4', card_type: 'grounding_caption', slot: 'caption', source: 'prompt_extraction', length_bucket: 'long', model_confidence: 0.49 },
        { card_key: 'c5', item_id: 'i5', card_type: 'grounding_ingredient', slot: 'setting', source: 'ovis_facet', length_bucket: 'medium', model_confidence: 0.23 },
        { card_key: 'c6', item_id: 'i6', card_type: 'missing_edge', slot: 'missing_edge', source: 'prompt_extraction', length_bucket: 'long', model_confidence: null },
        { card_key: 'c7', item_id: 'i7', card_type: 'slot_check', slot: 'lens', source: 'prompt_extraction', length_bucket: 'short', model_confidence: 0.55 },
        { card_key: 'c8', item_id: 'i8', card_type: 'edge_check', slot: 'action', source: 'prompt_extraction', length_bucket: 'medium', model_confidence: 0.85 },
        { card_key: 'c9', item_id: 'i9', card_type: 'grounding_ingredient', slot: 'palette', source: 'ovis_facet', length_bucket: 'long', model_confidence: 0.19 },
        { card_key: 'c10', item_id: 'i10', card_type: 'slot_check', slot: 'mood', source: 'ovis_facet', length_bucket: 'short', model_confidence: 0.50 }
    ];
    const repeat_pool = [
        { card_key: 'rep1', item_id: 'r1', card_type: 'edge_check', slot: 'weather_or_matter', source: 'prompt_extraction', length_bucket: 'short', model_confidence: 0.61 }
    ];

    const stratified_queue = build_stratified_review_queue_order(candidate_pool, repeat_pool, {
        ordering: 'stratified',
        limit: 12,
        repeat_fraction: 0.05,
        seed: 42
    });
    assert.equal(stratified_queue.length, 11);
    assert.equal(stratified_queue.filter(card => card.is_repeat_check).length, 1);

    // Uncertainty mode should bubble 0.50 / 0.49 / 0.52 confidence items ahead of 0.91 / 0.12 items
    const uncertainty_queue = build_stratified_review_queue_order(candidate_pool, [], {
        ordering: 'uncertainty',
        limit: 5,
        repeat_fraction: 0,
        seed: 1
    });
    assert.equal(uncertainty_queue[0].card_key, 'c10');
    assert.equal(uncertainty_queue[1].card_key, 'c4');
});

test('compute_calibration_and_grounding_analytics aggregates histograms, Laya bands, recall, and consistency', () => {
    const sample_events = [
        { card_type: 'grounding_caption', item_type: 'prompt', item_id: 'p1', prompt_id: 'p1', label: 'grounded', model_confidence: 0.34, dataset_split: 'train', is_repeat_check: 0 },
        { card_type: 'grounding_caption', item_type: 'prompt', item_id: 'p2', prompt_id: 'p2', label: 'mismatched', model_confidence: 0.12, dataset_split: 'holdout', is_repeat_check: 0 },
        { card_type: 'grounding_ingredient', item_type: 'ingredient', item_id: 'i1', prompt_id: 'p1', label: 'present', model_confidence: 0.29, dataset_split: 'train', is_repeat_check: 0 },
        { card_type: 'edge_check', item_type: 'influence', item_id: 'e1', prompt_id: 'p1', label: 'confirmed', model_confidence: 0.88, dataset_split: 'train', is_repeat_check: 0 },
        { card_type: 'edge_check', item_type: 'influence', item_id: 'e2', prompt_id: 'p2', label: 'rejected', model_confidence: 0.88, dataset_split: 'holdout', is_repeat_check: 0 },
        { card_type: 'edge_check', item_type: 'influence', item_id: 'e1', prompt_id: 'p1', label: 'confirmed', model_confidence: 0.88, dataset_split: 'train', is_repeat_check: 1 },
        { card_type: 'missing_edge', item_type: 'missing_edge_probe', item_id: 'p1', prompt_id: 'p1', label: 'added_edge', model_confidence: null, dataset_split: 'train', is_repeat_check: 0 },
        { card_type: 'slot_check', item_type: 'ingredient', item_id: 'i1', prompt_id: 'p1', label: 'skipped', model_confidence: 0.50, dataset_split: 'train', is_repeat_check: 0 }
    ];

    const analytics = compute_calibration_and_grounding_analytics(sample_events);
    assert.equal(analytics.total_events, 7);
    assert.equal(analytics.train_events_count, 5);
    assert.equal(analytics.holdout_events_count, 2);
    assert.equal(analytics.edge_recall_estimate.estimated_recall, 0.5);
    assert.equal(analytics.repeat_consistency.agreement_rate, 1);
    assert.equal(analytics.sitting_progress.grounding.target, REVIEW_SITTING_TARGETS.grounding);

    const high_conf_band = analytics.laya_calibration_bands.find(band => band.band_label === '0.85–1.00');
    assert.ok(high_conf_band);
    assert.equal(high_conf_band.sample_count, 3);
    assert.equal(high_conf_band.empirical_accuracy, 0.667);
});

test('cluster_near_copy_prompt_families and deduplicate_candidate_pool_by_family collapse near-copies and rank source families', () => {
    // WHAT: Verify near-duplicate prompts collapse into one root while unrelated scenes keep distinct family roots.
    // WHY: Ensures minor edits to a prompt do not flood the Transplant beam pool with near-identical candidates.
    const prompt_texts_collection = [
        'weathered detective standing in a rainy alley under cold neon light',
        'weathered detective standing in a rainy alley under cool neon light',
        'sunlit sandstone canyon with drifting crimson dust at midday'
    ];
    const clustered_family_roots = cluster_near_copy_prompt_families(prompt_texts_collection);
    assert.equal(clustered_family_roots.length, 3);
    assert.equal(clustered_family_roots[0], clustered_family_roots[1]);
    assert.notEqual(clustered_family_roots[2], clustered_family_roots[0]);

    const active_canvas_ingredients = [
        { ingredient_id: 'act_1', slot: 'lighting', text: 'soft tungsten key light' }
    ];
    const raw_candidate_pool = [
        // Near-copy of already active lighting should be stripped
        { ingredient_id: 'cand_active_dup', slot: 'lighting', kind: 'physical_anchor', text: 'soft tungsten key lighting', prompt_id: 'prm_01', source_raw_prompt: 'Scene A with soft tungsten', usage_count: 5 },
        // Two near-copy lighting candidates in pool: keeper copy must win within phrase family
        { ingredient_id: 'cand_cool_plain', slot: 'lighting', kind: 'physical_anchor', text: 'cool cyan neon reflection', prompt_id: 'prm_02', source_raw_prompt: 'Harbor night rain neon', usage_count: 4, keeper_count: 0 },
        { ingredient_id: 'cand_cool_keeper', slot: 'lighting', kind: 'physical_anchor', text: 'cool cyan neon reflections', prompt_id: 'prm_03', source_raw_prompt: 'Rainy pier cyan light', usage_count: 4, keeper_count: 2 },
        // Second distinct phrase from the exact same source prompt family as cand_cool_keeper
        { ingredient_id: 'cand_rain_same_family', slot: 'lighting', kind: 'physical_anchor', text: 'sodium vapor backlight', prompt_id: 'prm_03', source_raw_prompt: 'Rainy pier cyan light', usage_count: 3, keeper_count: 2 }
    ];

    const deduplicated_candidates = deduplicate_candidate_pool_by_family(
        raw_candidate_pool,
        active_canvas_ingredients
    );

    assert.ok(!deduplicated_candidates.some(candidate_entry => candidate_entry.ingredient_id === 'cand_active_dup'));
    const cyan_family_winners = deduplicated_candidates.filter(candidate_entry =>
        String(candidate_entry.text).includes('cyan neon')
    );
    assert.equal(cyan_family_winners.length, 1);
    assert.equal(cyan_family_winners[0].ingredient_id, 'cand_cool_keeper');

    const ranked_same_source_picks = deduplicated_candidates.filter(
        candidate_entry => candidate_entry.prompt_id === 'prm_03'
    );
    assert.equal(ranked_same_source_picks.length, 2);
    assert.deepEqual(
        ranked_same_source_picks.map(candidate_entry => candidate_entry.source_family_rank),
        [0, 1]
    );
});

test('is_candidate_rejected_by_memory and solve_constraint_transplant_beam enforce rejection exclusion and 48-draft staleness rotation', () => {
    // WHAT: Test permanent rejection filtering and recent-memory freshness rotation during beam search.
    // WHY: Repeated clicks on Transplant or Reject & Re-roll must advance through unseen candidates instead of looping.
    const rejected_records_collection = [
        {
            draft_text: 'weary detective in wool coat, harsh magenta strobe',
            rejected_ingredient_texts: ['harsh magenta strobe']
        }
    ];

    assert.equal(
        is_candidate_rejected_by_memory({ text: 'harsh magenta strobe' }, rejected_records_collection),
        true
    );
    assert.equal(
        is_candidate_rejected_by_memory('weary detective in wool coat, harsh magenta strobe', rejected_records_collection),
        true
    );

    const recent_memory_collection = [
        {
            draft_text: 'weary detective in wool coat, pale sodium rim light',
            opening_signature: 'weary detective in wool coat pale',
            source_prompt_ids: ['prm_stale'],
            swapped_texts: ['pale sodium rim light']
        }
    ];

    const stale_score_metrics = compute_candidate_staleness_score(
        { text: 'pale sodium rim light', prompt_id: 'prm_stale' },
        recent_memory_collection
    );
    const fresh_score_metrics = compute_candidate_staleness_score(
        { text: 'amber oil lantern glow', prompt_id: 'prm_fresh' },
        recent_memory_collection
    );
    assert.equal(stale_score_metrics.minimum_age, 0);
    assert.ok(stale_score_metrics.recency_penalty < 0);
    assert.equal(fresh_score_metrics.freshness_bonus, 0.75);

    const base_ingredients = [
        { ingredient_id: 'ing_subj', slot: 'subject_appearance', kind: 'physical_anchor', text: 'weary detective in wool coat' },
        { ingredient_id: 'ing_light', slot: 'lighting', kind: 'physical_anchor', text: 'flat overcast skylight' }
    ];
    const candidate_pools_by_slot = {
        lighting: [
            { ingredient_id: 'cand_rejected', slot: 'lighting', kind: 'physical_anchor', text: 'harsh magenta strobe', prompt_id: 'prm_rej', cluster_match: true, usage_count: 10 },
            { ingredient_id: 'cand_stale', slot: 'lighting', kind: 'physical_anchor', text: 'pale sodium rim light', prompt_id: 'prm_stale', cluster_match: true, usage_count: 10 },
            { ingredient_id: 'cand_fresh', slot: 'lighting', kind: 'physical_anchor', text: 'amber oil lantern glow', prompt_id: 'prm_fresh', cluster_match: true, usage_count: 2 }
        ]
    };

    const solved_transplant_plan = solve_constraint_transplant_beam(
        base_ingredients,
        candidate_pools_by_slot,
        [],
        {
            locked_slots: ['subject_appearance'],
            swap_count: 1,
            allow_empty_fills: false,
            variation_seed: 1,
            recent_remixes: recent_memory_collection,
            rejected_drafts: rejected_records_collection,
            style_mode: 'clauses'
        }
    );

    assert.ok(!solved_transplant_plan.selected_ingredients.some(item => item.text === 'harsh magenta strobe'));
    assert.ok(solved_transplant_plan.selected_ingredients.some(item => item.text === 'amber oil lantern glow'));
});

test('apply_in_place_prompt_edits and assemble_remixed_prompt_text support natural sentence span edits with a/an repair and Dream modes', () => {
    // WHAT: Validate backward-compatible default clauses mode, in-place sentence span editing with article repair, and Dream operators.
    // WHY: Ensures Mondocraft syntax repair and surreal Dream transforms coexist with strict clause assembly.
    const sample_ingredients = [
        { ingredient_id: 's1', slot: 'weather_or_matter', kind: 'physical_anchor', text: 'heavy rain' },
        { ingredient_id: 's2', slot: 'subject_appearance', kind: 'physical_anchor', text: 'sleek barn owl' },
        { ingredient_id: 's3', slot: 'setting', kind: 'physical_anchor', text: 'amber lantern' }
    ];

    const default_clauses_output = assemble_remixed_prompt_text(sample_ingredients, [], {
        include_observable_replacements: false
    });
    assert.equal(default_clauses_output, 'amber lantern, sleek barn owl, heavy rain');

    const original_sentence_prompt = 'A sleek barn owl perches above a wooden pier beneath a moody sky.';
    const edited_natural_sentence = apply_in_place_prompt_edits(
        original_sentence_prompt,
        [
            {
                slot: 'setting',
                replaced_texts: ['wooden pier'],
                chosen_text: 'amber lantern'
            },
            {
                slot: 'weather_or_matter',
                replaced_texts: ['moody sky'],
                chosen_text: 'overcast mist'
            }
        ],
        sample_ingredients,
        []
    );
    assert.equal(edited_natural_sentence, 'A sleek barn owl perches above an amber lantern beneath an overcast mist.');

    const dream_ingredients = [
        { ingredient_id: 'd1', slot: 'subject_appearance', kind: 'physical_anchor', text: 'a weathered detective' },
        { ingredient_id: 'd2', slot: 'setting', kind: 'physical_anchor', text: 'clockwork greenhouse' }
    ];
    const dream_base_sentence = 'A weathered detective walks through a clockwork greenhouse.';

    const metamorph_output = apply_dream_mode_transformation(dream_base_sentence, dream_ingredients, 'metamorph', 1);
    const chimera_output = apply_dream_mode_transformation(dream_base_sentence, dream_ingredients, 'chimera', 1);
    const fractal_output = apply_dream_mode_transformation(dream_base_sentence, dream_ingredients, 'fractal', 1);
    const portal_output = apply_dream_mode_transformation(dream_base_sentence, dream_ingredients, 'portal', 1);

    assert.ok(metamorph_output.includes('clockwork greenhouse'));
    assert.notEqual(metamorph_output, dream_base_sentence);
    assert.ok(chimera_output.includes('detective-greenhouse hybrid'));
    assert.ok(fractal_output.includes('clockwork greenhouses'));
    assert.ok(portal_output.includes('clockwork greenhouse'));
    assert.notEqual(portal_output, dream_base_sentence);
});

test('compute_keeper_weighted_bonus and solve_constraint_transplant_beam apply 3x keeper selection bias', () => {
    // WHAT: Confirm reviewed and keeper-flagged sources receive 3x weighting and win ties in beam search.
    // WHY: Biases Transplant toward visually proven prompt ingredients from keeper records.
    assert.equal(compute_source_success_weight_multiplier({ keeper_count: 0, is_reviewed: 0 }), 1.0);
    assert.equal(compute_source_success_weight_multiplier({ keeper_count: 1, is_reviewed: 0 }), 3.0);
    assert.equal(compute_source_success_weight_multiplier({ keeper_count: 0, is_reviewed: 1 }), 3.0);

    const standard_bonus = compute_keeper_weighted_bonus({ text: 'plain amber lamp', keeper_count: 0 }, 0);
    const keeper_bonus = compute_keeper_weighted_bonus({ text: 'keeper cobalt mist', keeper_count: 2 }, 0);
    assert.ok(keeper_bonus > standard_bonus + 1.5);

    const base_ingredients = [
        { ingredient_id: 'base_subj', slot: 'subject_appearance', kind: 'physical_anchor', text: 'brass observatory telescope' },
        { ingredient_id: 'base_light', slot: 'lighting', kind: 'physical_anchor', text: 'neutral room light' }
    ];
    const candidate_pools_by_slot = {
        lighting: [
            { ingredient_id: 'cand_unreviewed', slot: 'lighting', kind: 'physical_anchor', text: 'plain white fluorescent', prompt_id: 'prm_u', keeper_count: 0, is_reviewed: 0, usage_count: 3, cluster_match: false },
            { ingredient_id: 'cand_keeper', slot: 'lighting', kind: 'physical_anchor', text: 'warm golden hour rim light', prompt_id: 'prm_k', keeper_count: 2, is_reviewed: 1, usage_count: 3, cluster_match: false }
        ]
    };

    const keeper_weighted_plan = solve_constraint_transplant_beam(
        base_ingredients,
        candidate_pools_by_slot,
        [],
        {
            locked_slots: ['subject_appearance'],
            swap_count: 1,
            allow_empty_fills: false,
            variation_seed: 2
        }
    );

    assert.ok(keeper_weighted_plan.selected_ingredients.some(item => item.text === 'warm golden hour rim light'));
});
