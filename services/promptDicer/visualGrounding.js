/**
 * Prompt Dicer Visual Grounding & Laya Confidence Gating
 *
 * WHAT: Ovis-Omni facet fallback builders, normalized cosine similarity,
 *       per-ingredient visual grounding scoring, and Laya `/decide` gatekeepers.
 * WHY: Keeps multimodal visual grounding and Laya confidence evaluation in a
 *      pure functional module separate from LLM dicing and beam search.
 */

import {
    OVIS_FACET_LABEL_NORMALIZATION_MAP,
    DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS
} from './schemasAndConstants.js';

export function normalize_ovis_facet_value_to_phrase(raw_facet_value) {
    if (typeof raw_facet_value !== 'string') {
        return null;
    }
    const cleaned_lowercase_key = raw_facet_value.trim().toLowerCase();
    if (!cleaned_lowercase_key) {
        return null;
    }
    return OVIS_FACET_LABEL_NORMALIZATION_MAP[cleaned_lowercase_key] || raw_facet_value.trim();
}

export function build_ovis_facet_fallback_ingredients(
    image_facet_record,
    existing_ingredients_collection = [],
    fallback_options = {}
) {
    if (!image_facet_record || typeof image_facet_record !== 'object') {
        return Object.freeze([]);
    }

    const medium_threshold = Number.isFinite(fallback_options.medium_confidence_threshold)
        ? Number(fallback_options.medium_confidence_threshold)
        : DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS.medium;
    const composition_threshold = Number.isFinite(fallback_options.composition_confidence_threshold)
        ? Number(fallback_options.composition_confidence_threshold)
        : DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS.composition;
    const mood_threshold = Number.isFinite(fallback_options.mood_confidence_threshold)
        ? Number(fallback_options.mood_confidence_threshold)
        : DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS.mood;

    const occupied_slots_set = new Set();
    for (const ingredient_item of existing_ingredients_collection) {
        if (ingredient_item?.slot) {
            occupied_slots_set.add(ingredient_item.slot);
        }
        const replacement_slot = ingredient_item?.observable_replacement?.replacement_slot || ingredient_item?.replacement_slot;
        if (replacement_slot) {
            occupied_slots_set.add(replacement_slot);
        }
    }

    const facet_mapping_specifications = [
        {
            facet_field: 'medium',
            confidence_field: 'confidence_medium',
            target_slot: 'film_stock_or_medium',
            confidence_threshold: medium_threshold
        },
        {
            facet_field: 'composition',
            confidence_field: 'confidence_composition',
            target_slot: 'framing',
            confidence_threshold: composition_threshold
        },
        {
            facet_field: 'mood',
            confidence_field: 'confidence_mood',
            target_slot: 'mood',
            confidence_threshold: mood_threshold
        }
    ];

    const starting_sequence_number = existing_ingredients_collection.length + 1;
    const generated_fallbacks = [];

    for (const specification of facet_mapping_specifications) {
        if (occupied_slots_set.has(specification.target_slot)) {
            continue;
        }

        const normalized_phrase = normalize_ovis_facet_value_to_phrase(image_facet_record[specification.facet_field]);
        const facet_confidence = Number(image_facet_record[specification.confidence_field] ?? 0);
        if (!normalized_phrase || !Number.isFinite(facet_confidence) || facet_confidence < specification.confidence_threshold) {
            continue;
        }

        const fallback_identifier = `ovis_${starting_sequence_number + generated_fallbacks.length}`;
        generated_fallbacks.push(Object.freeze({
            ingredient_id: fallback_identifier,
            kind: 'ovis_facet_hint',
            source: 'ovis_facet',
            facet_field: specification.facet_field,
            facet_confidence: Number(facet_confidence.toFixed(4)),
            text: normalized_phrase,
            slot: specification.target_slot,
            bound_to_subject_id: null,
            measured_value: null
        }));
    }

    return Object.freeze(generated_fallbacks);
}

export function append_ovis_facet_fallbacks_to_master_record(
    master_record,
    ovis_fallback_ingredients = [],
    sync_options = {}
) {
    if (!master_record || typeof master_record !== 'object') {
        return master_record;
    }

    const valid_fallbacks = Array.isArray(ovis_fallback_ingredients)
        ? ovis_fallback_ingredients
        : [];
    const sync_attempted_flag = sync_options.sync_attempted !== false;

    const base_ingredients = Array.isArray(master_record.ingredients)
        ? master_record.ingredients.filter(item => item.source !== 'ovis_facet')
        : [];

    const merged_ingredients = Object.freeze([
        ...base_ingredients,
        ...valid_fallbacks
    ]);

    return Object.freeze({
        ...master_record,
        ingredients: merged_ingredients,
        ovis_facet_fallback_count: valid_fallbacks.length,
        ovis_facet_sync_attempted: sync_attempted_flag
    });
}

export function compute_normalized_vector_cosine_similarity(vector_alpha, vector_beta) {
    if (!Array.isArray(vector_alpha) || !Array.isArray(vector_beta) || vector_alpha.length === 0 || vector_alpha.length !== vector_beta.length) {
        return 0;
    }

    let dot_product_accumulator = 0;
    let magnitude_alpha_squared = 0;
    let magnitude_beta_squared = 0;

    for (let dimension_index = 0; dimension_index < vector_alpha.length; dimension_index++) {
        const value_alpha = Number(vector_alpha[dimension_index]);
        const value_beta = Number(vector_beta[dimension_index]);
        if (!Number.isFinite(value_alpha) || !Number.isFinite(value_beta)) {
            return 0;
        }
        dot_product_accumulator += value_alpha * value_beta;
        magnitude_alpha_squared += value_alpha * value_alpha;
        magnitude_beta_squared += value_beta * value_beta;
    }

    const denominator = Math.sqrt(magnitude_alpha_squared) * Math.sqrt(magnitude_beta_squared);
    if (denominator <= 0) {
        return 0;
    }

    const raw_cosine = dot_product_accumulator / denominator;
    return Math.max(-1, Math.min(1, Number(raw_cosine.toFixed(6))));
}

export function classify_caption_visual_grounding(cosine_similarity_score, threshold_overrides = {}) {
    const safe_score = Number.isFinite(Number(cosine_similarity_score))
        ? Number(Number(cosine_similarity_score).toFixed(4))
        : 0;
    const grounded_minimum_score = Number.isFinite(threshold_overrides.grounded_min)
        ? Number(threshold_overrides.grounded_min)
        : 0.28;
    const borderline_minimum_score = Number.isFinite(threshold_overrides.borderline_min)
        ? Number(threshold_overrides.borderline_min)
        : 0.18;

    if (safe_score >= grounded_minimum_score) {
        return Object.freeze({
            grounding_score: safe_score,
            grounding_status: 'grounded',
            needs_reanalysis: false
        });
    }

    if (safe_score >= borderline_minimum_score) {
        return Object.freeze({
            grounding_score: safe_score,
            grounding_status: 'borderline',
            needs_reanalysis: false
        });
    }

    return Object.freeze({
        grounding_score: safe_score,
        grounding_status: 'mismatched',
        needs_reanalysis: true
    });
}

export function score_per_ingredient_visual_grounding(
    image_vector,
    ingredient_vector_entries = [],
    threshold_overrides = {}
) {
    if (!Array.isArray(image_vector) || image_vector.length === 0 || !Array.isArray(ingredient_vector_entries)) {
        return Object.freeze({
            ingredients: Object.freeze([]),
            grounded_count: 0,
            borderline_count: 0,
            mismatched_count: 0,
            missing_ingredients: Object.freeze([])
        });
    }

    const effective_thresholds = {
        grounded_min: Number.isFinite(threshold_overrides.grounded_min) ? Number(threshold_overrides.grounded_min) : 0.24,
        borderline_min: Number.isFinite(threshold_overrides.borderline_min) ? Number(threshold_overrides.borderline_min) : 0.16
    };

    const scored_entries = [];
    const missing_ingredients = [];
    let grounded_count = 0;
    let borderline_count = 0;
    let mismatched_count = 0;

    for (const entry of ingredient_vector_entries) {
        if (!entry || !Array.isArray(entry.vector) || entry.vector.length === 0) {
            continue;
        }
        const cosine_score = compute_normalized_vector_cosine_similarity(image_vector, entry.vector);
        const verdict = classify_caption_visual_grounding(cosine_score, effective_thresholds);
        const is_missing_visually = verdict.grounding_status === 'mismatched';

        if (verdict.grounding_status === 'grounded') grounded_count++;
        else if (verdict.grounding_status === 'borderline') borderline_count++;
        else {
            mismatched_count++;
            missing_ingredients.push(Object.freeze({
                ingredient_id: entry.ingredient_id || null,
                text: entry.text || '',
                slot: entry.slot || 'other',
                grounding_score: verdict.grounding_score
            }));
        }

        scored_entries.push(Object.freeze({
            ingredient_id: entry.ingredient_id || null,
            text: entry.text || '',
            slot: entry.slot || 'other',
            kind: entry.kind || 'physical_anchor',
            source: entry.source || 'prompt_extraction',
            grounding_score: verdict.grounding_score,
            grounding_status: verdict.grounding_status,
            is_missing_visually
        }));
    }

    return Object.freeze({
        ingredients: Object.freeze(scored_entries),
        grounded_count,
        borderline_count,
        mismatched_count,
        missing_ingredients: Object.freeze(missing_ingredients)
    });
}

export const LAYA_SLOT_CHOICE_CRITERIA = Object.freeze({
    subject_appearance: 'visible body traits, hair, clothing, accessories, material texture on a character or object',
    expression_or_pose: 'facial expression, gaze, posture, hand gesture, body stance',
    action: 'dynamic physical action, movement verb, interaction happening between actors',
    lens: 'camera focal length in mm, aperture f-stop, T-stop, depth of field, optical lens glass look',
    camera_motion: 'camera movement such as pan, tilt, dolly track, handheld shake, zoom',
    framing: 'shot scale and composition such as close-up, wide vista, low angle, overhead',
    lighting: 'light source, Kelvin temperature, key/fill lighting ratio, shadows, glow, bounce light',
    palette: 'color scheme, hue contrast, monochrome, pastel or earth tones',
    setting: 'physical environment, room, architecture, landscape location, background objects',
    weather_or_matter: 'rain, fog, mist, snow, dust, smoke, water droplets, wind, particulate matter',
    film_stock_or_medium: 'photographic film grain, 35mm film, oil painting, 3D CGI render, watercolor, woodblock print',
    mood: 'emotional atmosphere or tone such as somber, cheerful, tense, serene',
    audio: 'sound effects, voice dialogue, ambient acoustics',
    other: 'miscellaneous prompt instruction not fitting photographic, optical, subject, or setting slots'
});

export function build_laya_slot_and_state_questions(
    ingredients_collection = [],
    influences_collection = [],
    builder_options = {}
) {
    const max_slot_questions = Math.max(0, Math.min(24, Number(builder_options.max_slot_questions) || 12));
    const max_influence_questions = Math.max(0, Math.min(16, Number(builder_options.max_influence_questions) || 8));
    const questions_dictionary = {};

    const valid_ingredients = Array.isArray(ingredients_collection) ? ingredients_collection : [];
    const valid_influences = Array.isArray(influences_collection) ? influences_collection : [];
    const ingredient_lookup_by_id = new Map(
        valid_ingredients.map(item => [item.ingredient_id, item])
    );

    for (let index = 0; index < Math.min(max_slot_questions, valid_ingredients.length); index++) {
        const ingredient = valid_ingredients[index];
        if (!ingredient || !ingredient.text) continue;
        const question_key = `slot__${ingredient.ingredient_id || index}`;
        questions_dictionary[question_key] = Object.freeze({
            type: 'choice',
            instructions: `Which controlled photographic/narrative slot best fits this phrase: "${ingredient.text}"?`,
            criteria: LAYA_SLOT_CHOICE_CRITERIA
        });
    }

    for (let index = 0; index < Math.min(max_influence_questions, valid_influences.length); index++) {
        const influence = valid_influences[index];
        if (!influence || !influence.state_key || !influence.applied_state_value) continue;
        const source_label = ingredient_lookup_by_id.get(influence.source_ingredient_id)?.text || influence.source_text || influence.source_ingredient_id;
        const target_label = ingredient_lookup_by_id.get(influence.target_ingredient_id)?.text || influence.target_text || influence.target_ingredient_id;
        const question_key = `state__${index}`;
        questions_dictionary[question_key] = Object.freeze({
            type: 'choice',
            instructions: `In scene continuity, does "${source_label}" acting on "${target_label}" physically imply ${influence.state_key} = "${influence.applied_state_value}"?`,
            criteria: Object.freeze({
                yes: `Yes, "${source_label}" directly causes or implies ${influence.applied_state_value} on "${target_label}".`,
                no: `No, that physical state implication is unlikely, contradictory, or unrelated.`
            })
        });
    }

    return Object.freeze(questions_dictionary);
}

export function apply_laya_confidence_gates(
    ingredients_collection = [],
    influences_collection = [],
    laya_answers_map = {},
    gate_options = {}
) {
    const slot_confidence_minimum = Number.isFinite(gate_options.slot_confidence_min)
        ? Number(gate_options.slot_confidence_min)
        : 0.55;
    const state_confidence_minimum = Number.isFinite(gate_options.state_confidence_min)
        ? Number(gate_options.state_confidence_min)
        : 0.60;

    let review_flags_count = 0;

    const evaluated_ingredients = Object.freeze((Array.isArray(ingredients_collection) ? ingredients_collection : []).map((ingredient, index) => {
        const answer = laya_answers_map[`slot__${ingredient.ingredient_id || index}`];
        if (!answer) return ingredient;

        const predicted_slot = answer.choice || ingredient.slot;
        const confidence_value = Number(answer.confidence ?? 0);
        const slot_mismatch = predicted_slot !== ingredient.slot;
        const low_confidence = Number.isFinite(confidence_value) && confidence_value < slot_confidence_minimum;
        const needs_human_review = Boolean(slot_mismatch || low_confidence);
        if (needs_human_review) review_flags_count++;

        return Object.freeze({
            ...ingredient,
            laya_predicted_slot: predicted_slot,
            laya_slot_confidence: Number(confidence_value.toFixed(4)),
            needs_human_review
        });
    }));

    const evaluated_influences = Object.freeze((Array.isArray(influences_collection) ? influences_collection : []).map((influence, index) => {
        const answer = laya_answers_map[`state__${index}`];
        if (!answer) return influence;

        const accepted = String(answer.choice || '').toLowerCase() === 'yes';
        const confidence_value = Number(answer.confidence ?? 0);
        const low_confidence = Number.isFinite(confidence_value) && confidence_value < state_confidence_minimum;
        const needs_human_review = Boolean(!accepted || low_confidence);
        if (needs_human_review) review_flags_count++;

        return Object.freeze({
            ...influence,
            laya_state_supported: accepted,
            laya_state_confidence: Number(confidence_value.toFixed(4)),
            needs_human_review
        });
    }));

    return Object.freeze({
        ingredients: evaluated_ingredients,
        influences: evaluated_influences,
        review_flags_count,
        summary: Object.freeze({
            slot_confidence_min: slot_confidence_minimum,
            state_confidence_min: state_confidence_minimum,
            flagged_for_review: review_flags_count
        })
    });
}

