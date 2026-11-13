/**
 * Prompt Dicer Controlled Vocabulary, System Prompts & JSON Schemas
 *
 * WHAT: Immutable slot taxonomies, measurement units, interaction types,
 *       Ovis facet normalization tables, and llama-server JSON schemas.
 * WHY: Separates static domain contracts from execution logic in `promptDicerService.js`.
 */

export const ALLOWED_INGREDIENT_SLOTS = Object.freeze([
    'subject_appearance',
    'expression_or_pose',
    'action',
    'lens',
    'camera_motion',
    'framing',
    'lighting',
    'palette',
    'setting',
    'weather_or_matter',
    'film_stock_or_medium',
    'mood',
    'audio',
    'other'
]);

export const ALLOWED_MEASURED_UNITS = Object.freeze([
    'K',
    'mm',
    'f_stop',
    'T_stop',
    'fps',
    'degrees',
    'ratio_to_1',
    'seconds',
    'other'
]);

export const ALLOWED_INTERACTION_TYPES = Object.freeze([
    'surface_physical',
    'optical_lighting',
    'motion_mechanics',
    'mood_shift',
    'acoustic'
]);

export const OVIS_FACET_LABEL_NORMALIZATION_MAP = Object.freeze({
    photography: 'real-world photography',
    'real-world photography': 'real-world photography',
    three_dimensional_render: '3D CGI digital render',
    '3d cgi digital render': '3D CGI digital render',
    digital_art: 'digital concept illustration',
    'digital concept illustration': 'digital concept illustration',
    traditional_art: 'traditional oil or watercolor painting',
    'traditional oil or watercolor painting': 'traditional oil or watercolor painting',
    sculpture_craft: 'handcrafted sculpture or physical craft',
    'handcrafted sculpture or physical craft': 'handcrafted sculpture or physical craft',
    diagram_typography: 'diagrammatic graphic layout or typography',
    'diagrammatic graphic layout or typography': 'diagrammatic graphic layout or typography',
    dark_moody: 'dark, moody and atmospheric',
    'dark, moody and atmospheric': 'dark, moody and atmospheric',
    bright_vibrant: 'bright, vibrant and luminous',
    'bright, vibrant and luminous': 'bright, vibrant and luminous',
    minimalist_serene: 'minimalist, calm and serene',
    'minimalist, calm and serene': 'minimalist, calm and serene',
    whimsical_playful: 'whimsical, playful and colorful',
    'whimsical, playful and colorful': 'whimsical, playful and colorful',
    dramatic_cinematic: 'dramatic, epic and cinematic',
    'dramatic, epic and cinematic': 'dramatic, epic and cinematic',
    tight_closeup: 'tight macro close-up focus',
    'tight macro close-up focus': 'tight macro close-up focus',
    portrait_headshot: 'portrait headshot character framing',
    'portrait headshot character framing': 'portrait headshot character framing',
    wide_landscape: 'wide scenic panoramic landscape vista',
    'wide scenic panoramic landscape vista': 'wide scenic panoramic landscape vista',
    interior_architecture: 'interior architectural room space',
    'interior architectural room space': 'interior architectural room space',
    aerial_overhead: 'birds-eye aerial overhead perspective',
    'birds-eye aerial overhead perspective': 'birds-eye aerial overhead perspective'
});

export const DEFAULT_OVIS_FACET_CONFIDENCE_THRESHOLDS = Object.freeze({
    medium: 0.42,
    composition: 0.42,
    mood: 0.50
});

export const PASS_A_SYSTEM_PROMPT = `You are a prompt-structure analyst. Read one image or video generation prompt and work out who is in it and who does what to whom. Do not judge quality, do not extract clothing or appearance ingredients, and do not rewrite the prompt. Quote the prompt's own wording wherever you can.

Rules:

1. Every distinct character or acting entity gets one subject with an internal id: subject_1, subject_2, and so on.
2. Theta roles. AGENT starts the action. PATIENT receives or is targeted by it. SPECTATOR is present but must not inherit anyone else's motion or speech.
3. Keep \`verb_action\` to the core verb or short edge label connecting the subject to an instrument or target. Leave detailed clothing, appearance, expressions, and multi-beat timelines for later passes.
4. Flag a clause as ambiguous when two or more subjects share a sentence with an action verb and the prompt does not make clear who is agent and who is patient. Explain which attributes or actions could swap between them.
5. If the prompt refers to a reference image by tag (for example "Image 1" or "<Picture 1>"), copy the tag and set requires_reference_image to true. Otherwise set it to false.
6. For video prompts fill speech_state. For image prompts set speech_state to null.
7. Use null when the prompt does not say. Never invent details.
8. Return only JSON that matches the schema.`;

export const PASS_B_SYSTEM_PROMPT = `You are a prompt-structure analyst. Read one image or video generation prompt and separate two kinds of wording.

PRETEXT terms are abstract mood, intent, or hype words that do not tell a diffusion model what to draw: for example "epic", "mysterious", "emotional", "cinematic", "haunting", "heroic", "breathtaking", "intense", "visceral", "magical", "atmospheric", "lovecraftian".

PHYSICAL anchors are concrete, observable instructions: subject clothing and appearance, facial expressions and poses, lens focal lengths, f-stops and T-stops, camera moves, lighting angles, ratios and colour temperatures, named materials, weather or matter (rain, steam, fog), and body mechanics.

Rules:

1. List every pretext term exactly as written in the prompt. Do not list a word that is already a physical instruction.
2. For each pretext term, write one observable replacement: a short phrase describing what the camera would actually see or hear. The replacement must change what is shown, not restate the mood.
3. List every physical anchor as a short atomic phrase, including subject clothing, appearance, pose, and expression.
   - Where a phrase contains a number and unit, fill \`measured_value\`; otherwise set it to null.
   - If a phrase contains multiple measurements (such as "85mm lens at f/1.4"), split it into separate physical anchors ("85mm lens" and "f/1.4 aperture") so each anchor has at most one \`measured_value\`.
   - For ratios like "6:1 lighting ratio", record \`number: 6\` and \`unit: "ratio_to_1"\`.
4. If an item belongs to one subject from SUBJECT_LIST_JSON (such as clothing, body features, expression, pose, or action), give that subject's \`subject_id\`. If it applies to the whole frame, use null.
5. Assign each item a slot from the allowed list only.
6. Do not count, score, or compute ratios. Another program does that.
7. Return only JSON that matches the schema.

Allowed slots: subject_appearance, expression_or_pose, action, lens, camera_motion, framing, lighting, palette, setting, weather_or_matter, film_stock_or_medium, mood, audio, other.`;

export const PASS_D_SYSTEM_PROMPT = `You are a physical continuity and prompt-interaction analyst. You are given a prompt's SUBJECT_LIST and its extracted INGREDIENT_LIST (each with a stable \`ingredient_id\`, \`slot\`, and \`bound_to_subject_id\`).

Your job is to find pairs of ingredients where one ingredient (the SOURCE) physically alters, optically changes, or shifts the mood/reading of another ingredient (the TARGET) within the scene.

Examples of valid influences:
- Weather/matter on appearance: "heavy rain" makes "trenchcoat" wet, darkened, and specular.
- Weather/matter on lighting: "heavy rain" or "thick fog" makes "3200K streetlamp" streaky or diffused.
- Lighting on appearance/palette: "3200K sodium streetlamp" casts an amber monochrome wash over "pale skin" or "white shirt".
- Expression/action on mood: "weeping" or "aiming a flashlight" shifts how the target subject or frame mood reads.

Rules:

1. Use only \`ingredient_id\`s that exist in INGREDIENT_LIST. Never invent IDs.
2. Only list genuine physical, optical, acoustic, or mood interactions. Do not link two ingredients just because they are in the same prompt or belong to the same subject.
3. For each influence, specify:
   - \`source_ingredient_id\`: the ingredient causing the change.
   - \`target_ingredient_id\`: the specific ingredient in this prompt being affected.
   - \`portable_target_slot\`: which slot this source ingredient naturally affects when remixed into a new prompt (for example, "heavy rain" affects \`subject_appearance\` and \`lighting\`, so if the trenchcoat is swapped for a silk dress, the rain still wets the dress).
   - \`target_subject_scope\`: whether the influence affects \`"same_subject_only"\`, \`"agent_to_patient"\`, or \`"whole_frame"\`.
   - \`consequence_description\`: a short, concrete phrase describing what the camera sees or hears as a result of the interaction.
   - \`state_key\`: physical dimension affected, e.g. 'surface_moisture', 'light_scatter', 'color_cast', 'fabric_drape'.
   - \`applied_state_value\`: the state imposed by the source ingredient, e.g. 'wet_specular'.
   - \`clashes_with_value\`: incompatible state on the same state_key, e.g. 'dry_matte_dust'.
4. Return only JSON that matches the schema.`;

export const PASS_A_JSON_SCHEMA = Object.freeze({
    type: 'object',
    required: ['media_type', 'subjects', 'ambiguous_clauses'],
    properties: {
        media_type: {
            type: 'string',
            enum: ['image', 'video']
        },
        subjects: {
            type: 'array',
            items: {
                type: 'object',
                required: [
                    'subject_id',
                    'role_label',
                    'source_reference_tag',
                    'requires_reference_image',
                    'theta_role',
                    'verb_action',
                    'instrument',
                    'target_subject_id',
                    'speech_state'
                ],
                properties: {
                    subject_id: {
                        type: 'string',
                        pattern: '^subject_[0-9]+$'
                    },
                    role_label: { type: 'string' },
                    source_reference_tag: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    requires_reference_image: { type: 'boolean' },
                    theta_role: {
                        type: 'string',
                        enum: ['AGENT', 'PATIENT', 'SPECTATOR']
                    },
                    verb_action: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    instrument: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    target_subject_id: {
                        anyOf: [
                            { type: 'string', pattern: '^subject_[0-9]+$' },
                            { type: 'null' }
                        ]
                    },
                    speech_state: {
                        anyOf: [
                            { type: 'string', enum: ['speaking', 'locked_silent'] },
                            { type: 'null' }
                        ]
                    }
                }
            }
        },
        ambiguous_clauses: {
            type: 'array',
            items: {
                type: 'object',
                required: ['original_clause', 'bleed_risk', 'suggested_binding'],
                properties: {
                    original_clause: { type: 'string' },
                    bleed_risk: { type: 'string' },
                    suggested_binding: { type: 'string' }
                }
            }
        }
    }
});

export const PASS_B_JSON_SCHEMA = Object.freeze({
    type: 'object',
    required: ['pretext_terms', 'physical_anchors'],
    properties: {
        pretext_terms: {
            type: 'array',
            items: {
                type: 'object',
                required: [
                    'term_as_written',
                    'bound_to_subject_id',
                    'tag_slot',
                    'observable_replacement_text',
                    'replacement_slot'
                ],
                properties: {
                    term_as_written: { type: 'string' },
                    bound_to_subject_id: {
                        anyOf: [
                            { type: 'string', pattern: '^subject_[0-9]+$' },
                            { type: 'null' }
                        ]
                    },
                    tag_slot: {
                        type: 'string',
                        enum: ['mood', 'film_stock_or_medium', 'setting', 'other']
                    },
                    observable_replacement_text: { type: 'string' },
                    replacement_slot: {
                        type: 'string',
                        enum: ALLOWED_INGREDIENT_SLOTS.filter(slot => slot !== 'mood')
                    }
                }
            }
        },
        physical_anchors: {
            type: 'array',
            items: {
                type: 'object',
                required: ['ingredient_text', 'slot', 'bound_to_subject_id', 'measured_value'],
                properties: {
                    ingredient_text: { type: 'string' },
                    slot: {
                        type: 'string',
                        enum: ALLOWED_INGREDIENT_SLOTS
                    },
                    bound_to_subject_id: {
                        anyOf: [
                            { type: 'string', pattern: '^subject_[0-9]+$' },
                            { type: 'null' }
                        ]
                    },
                    measured_value: {
                        anyOf: [
                            {
                                type: 'object',
                                required: ['number', 'unit'],
                                properties: {
                                    number: { type: 'number' },
                                    unit: {
                                        type: 'string',
                                        enum: ALLOWED_MEASURED_UNITS
                                    }
                                }
                            },
                            { type: 'null' }
                        ]
                    }
                }
            }
        }
    }
});

export const PASS_D_JSON_SCHEMA = Object.freeze({
    type: 'object',
    required: ['influences'],
    properties: {
        influences: {
            type: 'array',
            items: {
                type: 'object',
                required: [
                    'source_ingredient_id',
                    'target_ingredient_id',
                    'interaction_type',
                    'portable_target_slot',
                    'target_subject_scope',
                    'consequence_description',
                    'state_key',
                    'applied_state_value',
                    'clashes_with_value'
                ],
                properties: {
                    source_ingredient_id: {
                        type: 'string',
                        pattern: '^ing_[0-9]+$'
                    },
                    target_ingredient_id: {
                        type: 'string',
                        pattern: '^ing_[0-9]+$'
                    },
                    interaction_type: {
                        type: 'string',
                        enum: ALLOWED_INTERACTION_TYPES
                    },
                    portable_target_slot: {
                        type: 'string',
                        enum: ALLOWED_INGREDIENT_SLOTS
                    },
                    target_subject_scope: {
                        type: 'string',
                        enum: ['whole_frame', 'same_subject_only', 'agent_to_patient']
                    },
                    consequence_description: { type: 'string' },
                    state_key: { type: 'string' },
                    applied_state_value: { type: 'string' },
                    clashes_with_value: { type: 'string' }
                }
            }
        }
    }
});

