/**
 * Prompt Dicer Offline Heuristic Parser & Metadata Prompt Extractor
 *
 * Pure deterministic transformations for extracting prompts from ComfyUI/A1111 metadata
 * and parsing prompt prose into Pass A/B/D structures when llama-server is offline.
 */

import { ALLOWED_INGREDIENT_SLOTS } from "./schemasAndConstants.js";

// 4. METADATA PROMPT EXTRACTION (FROM IMAGES.DB)
// ============================================================================

/**
 * WHAT: Extracts prompt strings from image metadata (ComfyUI / A1111 / analysis summary).
 * WHY: Users have images with embedded ComfyUI/A1111 generation prompts and detailed visual summaries.
 *      This pure function extracts clean prompt text ready for dicing.
 * 
 * @param {string|Object|null} metadata_input - Raw metadata JSON string or object from images table.
 * @param {string|Object|null} analysis_input - Raw analysis JSON string or object from images table.
 * @returns {ReadonlyArray<{ source_type: string, prompt_text: string, confidence: number }>}
 */
export function extract_prompts_from_image_records(metadata_input, analysis_input) {
    const extracted_prompts_collection = [];

    if (metadata_input) {
        try {
            const parsed_metadata = typeof metadata_input === 'string'
                ? JSON.parse(metadata_input)
                : metadata_input;

            if (parsed_metadata.prompt) {
                const comfy_prompt_graph = typeof parsed_metadata.prompt === 'string'
                    ? JSON.parse(parsed_metadata.prompt)
                    : parsed_metadata.prompt;

                for (const node_identifier of Object.keys(comfy_prompt_graph)) {
                    const node_record = comfy_prompt_graph[node_identifier];
                    const node_text_input = node_record?.inputs?.text || node_record?.inputs?.prompt;
                    if (typeof node_text_input === 'string' && node_text_input.trim().length > 10) {
                        extracted_prompts_collection.push(Object.freeze({
                            source_type: 'comfyui_node_text',
                            prompt_text: node_text_input.trim(),
                            confidence: 0.95
                        }));
                    }
                }
            }

            if (parsed_metadata.parameters && typeof parsed_metadata.parameters === 'string') {
                const parameters_raw_text = parsed_metadata.parameters;
                const positive_prompt_extracted = parameters_raw_text
                    .split(/Negative prompt:|Steps:/i)[0]
                    .trim();

                if (positive_prompt_extracted.length > 5) {
                    extracted_prompts_collection.push(Object.freeze({
                        source_type: 'automatic1111_parameters',
                        prompt_text: positive_prompt_extracted,
                        confidence: 0.9
                    }));
                }
            }

            const general_comment = parsed_metadata.UserComment || parsed_metadata.Description;
            if (typeof general_comment === 'string' && general_comment.trim().length > 15) {
                extracted_prompts_collection.push(Object.freeze({
                    source_type: 'metadata_comment',
                    prompt_text: general_comment.trim(),
                    confidence: 0.7
                }));
            }
        } catch (metadata_parsing_error) {
            // Ignore malformed metadata JSON
        }
    }

    if (analysis_input) {
        try {
            const parsed_analysis = typeof analysis_input === 'string'
                ? JSON.parse(analysis_input)
                : analysis_input;
            if (typeof parsed_analysis.summary === 'string' && parsed_analysis.summary.trim().length > 10) {
                extracted_prompts_collection.push(Object.freeze({
                    source_type: 'vision_analysis_summary',
                    prompt_text: parsed_analysis.summary.trim(),
                    confidence: 0.8
                }));
            }
        } catch (analysis_parsing_error) {
            // Ignore malformed analysis JSON
        }
    }

    return Object.freeze(extracted_prompts_collection);
}

// ============================================================================
// 5. DETERMINISTIC OFFLINE HEURISTIC PARSER (FOR ALL LIBRARY PROMPTS & TESTS)
// ============================================================================

/**
 * WHAT: Comprehensive deterministic prompt dicer when llama-server is offline.
 * WHY: Parses any image prompt or visual analysis summary into Pass A subjects, Pass B pretext terms
 *      and physical anchors (with measured values and slots), and Pass D physical influences.
 * 
 * @param {string} prompt_text - The input prompt or visual summary.
 * @param {string} media_type - "image" or "video".
 * @param {Object|null} optional_image_context - Optional { objects: [], tags: [], scene_type: '', metadata: {} } from images.db.
 * @returns {Object} Deterministic Pass A, Pass B, and Pass D outputs.
 */
export function execute_heuristic_offline_dicing(prompt_text, media_type = 'image', optional_image_context = null) {
    const safe_prompt_text = String(prompt_text || '').trim();
    const existing_objects = Array.isArray(optional_image_context?.objects) ? optional_image_context.objects : [];
    const existing_tags = Array.isArray(optional_image_context?.tags) ? optional_image_context.tags : [];
    const existing_scene_type = typeof optional_image_context?.scene_type === 'string' ? optional_image_context.scene_type : '';

    // ------------------------------------------------------------------------
    // PASS A: Subject Binding Grid
    // ------------------------------------------------------------------------
    const detected_subjects = [];
    const seen_subject_labels = new Set();

    // Check explicit reference image tags like "Subject 1 (Image 1)" or "<Picture 1>"
    const reference_tag_match = safe_prompt_text.match(/\b(Image\s*\d+|Picture\s*\d+|<Picture\s*\d+>|<Subject\s*\d+>)/i);
    const extracted_reference_tag = reference_tag_match ? reference_tag_match[1] : null;

    // 1. Named acting entities in prompt text
    const actor_candidates = [
        { regex: /\b(weary\s+detective|detective)\b/i, role: 'weary detective', theta: 'AGENT', verb: 'aiming', instrument: 'flashlight' },
        { regex: /\b(towering\s+bartender|bartender)\b/i, role: 'towering bartender', theta: 'PATIENT', verb: 'wiping', instrument: 'glass' },
        { regex: /\b(astronaut)\b/i, role: 'astronaut', theta: 'AGENT', verb: 'floating', instrument: null },
        { regex: /\b(woman|young\s+woman|elderly\s+woman|girl|bride|queen|warrior\s+woman|dancer)\b/i, role: null, theta: 'AGENT', verb: 'posing', instrument: null },
        { regex: /\b(man|young\s+man|old\s+man|boy|monk|soldier|samurai|knight|figure|person|rider|sculptor|artist|traveler)\b/i, role: null, theta: 'AGENT', verb: 'standing', instrument: null },
        { regex: /\b(cat|black\s+cat|dog|wolf|horse|bird|owl|dragon|lion|tiger|crow|fish)\b/i, role: null, theta: 'AGENT', verb: 'perched', instrument: null },
        { regex: /\b(human\s+skull|skull|statue|sculpture|shrine|totem|carving|temple|monolith)\b/i, role: null, theta: 'PATIENT', verb: null, instrument: null }
    ];

    for (const candidate of actor_candidates) {
        const match = safe_prompt_text.match(candidate.regex);
        if (match) {
            const label = (candidate.role || match[1]).toLowerCase().trim();
            if (!seen_subject_labels.has(label) && detected_subjects.length < 4) {
                seen_subject_labels.add(label);
                const subject_index = detected_subjects.length + 1;
                const is_first_subject = subject_index === 1;
                detected_subjects.push({
                    subject_id: `subject_${subject_index}`,
                    role_label: label,
                    source_reference_tag: is_first_subject ? extracted_reference_tag : null,
                    requires_reference_image: Boolean(is_first_subject && extracted_reference_tag),
                    theta_role: candidate.theta,
                    verb_action: candidate.verb,
                    instrument: candidate.instrument,
                    target_subject_id: null,
                    speech_state: media_type === 'video' ? 'locked_silent' : null
                });
            }
        }
    }

    // 2. Also incorporate top distinct objects from image analysis if no subjects matched yet
    if (detected_subjects.length === 0 && existing_objects.length > 0) {
        for (const object_label of existing_objects.slice(0, 2)) {
            const clean_label = String(object_label || '').toLowerCase().trim();
            if (clean_label && !seen_subject_labels.has(clean_label)) {
                seen_subject_labels.add(clean_label);
                const subject_index = detected_subjects.length + 1;
                detected_subjects.push({
                    subject_id: `subject_${subject_index}`,
                    role_label: clean_label,
                    source_reference_tag: null,
                    requires_reference_image: false,
                    theta_role: subject_index === 1 ? 'AGENT' : 'PATIENT',
                    verb_action: null,
                    instrument: null,
                    target_subject_id: null,
                    speech_state: media_type === 'video' ? 'locked_silent' : null
                });
            }
        }
    }

    // Connect AGENT to PATIENT if both exist
    if (detected_subjects.length >= 2 && detected_subjects[0].theta_role === 'AGENT' && detected_subjects[1].theta_role === 'PATIENT') {
        detected_subjects[0].target_subject_id = detected_subjects[1].subject_id;
    }

    if (detected_subjects.length === 0) {
        detected_subjects.push({
            subject_id: 'subject_1',
            role_label: existing_scene_type ? `${existing_scene_type} subject` : 'primary scene subject',
            source_reference_tag: extracted_reference_tag,
            requires_reference_image: Boolean(extracted_reference_tag),
            theta_role: 'AGENT',
            verb_action: null,
            instrument: null,
            target_subject_id: null,
            speech_state: media_type === 'video' ? 'locked_silent' : null
        });
    }

    const primary_subject_id = detected_subjects[0].subject_id;

    // ------------------------------------------------------------------------
    // PASS B: Pretext Terms vs Physical Anchors
    // ------------------------------------------------------------------------
    const pretext_lookup_dictionary = [
        { term: 'cinematic', slot: 'mood', replacement: 'anamorphic lens flare with controlled 4:1 key-to-fill lighting ratio', replacement_slot: 'lighting' },
        { term: 'lovecraftian', slot: 'mood', replacement: 'low-angle framing with deep green-black shadows obscuring upper architecture', replacement_slot: 'lighting' },
        { term: 'epic', slot: 'mood', replacement: 'ultra-wide low-horizon framing emphasizing vertical scale', replacement_slot: 'framing' },
        { term: 'atmospheric', slot: 'mood', replacement: 'suspended particulate haze catching directional light beams', replacement_slot: 'weather_or_matter' },
        { term: 'mysterious', slot: 'mood', replacement: 'heavy edge vignetting with half-lit facial silhouette', replacement_slot: 'lighting' },
        { term: 'dramatic', slot: 'mood', replacement: 'hard directional side-key light with deep chiaroscuro falloff', replacement_slot: 'lighting' },
        { term: 'ethereal', slot: 'mood', replacement: 'soft backlit halation diffusing through translucent mist', replacement_slot: 'lighting' },
        { term: 'serene', slot: 'mood', replacement: 'still reflective water surface under even diffused skylight', replacement_slot: 'setting' },
        { term: 'tranquil', slot: 'mood', replacement: 'calm horizontal composition with soft warm ambient fill', replacement_slot: 'framing' },
        { term: 'haunting', slot: 'mood', replacement: 'desaturated cold cyan shadows with isolated rim highlight', replacement_slot: 'palette' },
        { term: 'breathtaking', slot: 'mood', replacement: 'deep-focus vista with layered foreground and distant mountain haze', replacement_slot: 'framing' },
        { term: 'majestic', slot: 'mood', replacement: 'low-angle pedestal framing looking upward at monumental form', replacement_slot: 'framing' },
        { term: 'vibrant', slot: 'mood', replacement: 'high-saturation complementary color contrast under direct sunlight', replacement_slot: 'palette' },
        { term: 'abstract details', slot: 'other', replacement: 'geometric relief line work with high-contrast carved edges', replacement_slot: 'palette' },
        { term: 'masterpiece', slot: 'other', replacement: 'tack-sharp micro-texture resolution across surface grain', replacement_slot: 'lens' }
    ];

    const detected_pretext_terms = [];
    const seen_pretext_terms = new Set();
    const combined_text_for_pretext = `${safe_prompt_text} ${existing_tags.join(' ')}`;

    for (const pretext_entry of pretext_lookup_dictionary) {
        const regex = new RegExp(`\\b${pretext_entry.term}\\b`, 'i');
        if (regex.test(combined_text_for_pretext) && !seen_pretext_terms.has(pretext_entry.term)) {
            seen_pretext_terms.add(pretext_entry.term);
            detected_pretext_terms.push({
                term_as_written: pretext_entry.term,
                bound_to_subject_id: null,
                tag_slot: pretext_entry.slot,
                observable_replacement_text: pretext_entry.replacement,
                replacement_slot: pretext_entry.replacement_slot
            });
        }
    }

    const physical_anchors = [];
    const seen_anchor_texts = new Set();
    const add_physical_anchor = (ingredient_text, slot, bound_to_subject_id = null, measured_value = null) => {
        const clean_text = String(ingredient_text || '').trim();
        const normalized_key = clean_text.toLowerCase();
        if (!clean_text || clean_text.length < 3 || seen_anchor_texts.has(normalized_key)) return;
        seen_anchor_texts.add(normalized_key);
        physical_anchors.push({
            ingredient_text: clean_text,
            slot: ALLOWED_INGREDIENT_SLOTS.includes(slot) ? slot : 'other',
            bound_to_subject_id,
            measured_value
        });
    };

    // 1. Measurements: Focal Length (mm), Color Temp (K), Aperture (f/x), Ratio (x:1), FPS, Degrees
    const mm_matches = [...safe_prompt_text.matchAll(/(\d+(?:\.\d+)?)\s*mm\b([^,.;]*)/gi)];
    for (const match of mm_matches) {
        const number_value = Number(match[1]);
        const trailing_noun = (match[2] || '').trim().split(/\s+/).slice(0, 3).join(' ');
        const full_phrase = trailing_noun ? `${match[1]}mm ${trailing_noun}` : `${match[1]}mm lens`;
        const target_slot = /kodak|vision|film|stock|print/i.test(full_phrase) ? 'film_stock_or_medium' : 'lens';
        add_physical_anchor(full_phrase, target_slot, null, { number: number_value, unit: 'mm' });
    }

    const kelvin_matches = [...safe_prompt_text.matchAll(/(\d{3,5})\s*K\b([^,.;]*)/gi)];
    for (const match of kelvin_matches) {
        const number_value = Number(match[1]);
        const trailing_words = (match[2] || '').trim().split(/\s+/).slice(0, 3).join(' ');
        const full_phrase = trailing_words ? `${match[1]}K ${trailing_words}` : `${match[1]}K key light`;
        add_physical_anchor(full_phrase, 'lighting', null, { number: number_value, unit: 'K' });
    }

    const fstop_matches = [...safe_prompt_text.matchAll(/\bf\/(\d+(?:\.\d+)?)/gi)];
    for (const match of fstop_matches) {
        add_physical_anchor(`f/${match[1]} aperture`, 'lens', null, { number: Number(match[1]), unit: 'f_stop' });
    }

    const ratio_matches = [...safe_prompt_text.matchAll(/\b(\d+(?:\.\d+)?)\s*:\s*1\b([^,.;]*)/gi)];
    for (const match of ratio_matches) {
        add_physical_anchor(`${match[1]}:1 lighting ratio`, 'lighting', null, { number: Number(match[1]), unit: 'ratio_to_1' });
    }

    // 2. Framing patterns
    const framing_matches = safe_prompt_text.match(/\b(extreme\s+close-?up|close-?up\s+shot|close-?up|medium\s+shot|wide\s+shot|extreme\s+wide\s+shot|full-?body\s+shot|low-?angle\s+shot|high-?angle\s+shot|overhead\s+shot|aerial\s+view|macro\s+shot|portrait\s+framing)\b/gi) || [];
    for (const framing_phrase of framing_matches) {
        add_physical_anchor(framing_phrase.toLowerCase(), 'framing', null, null);
    }

    // 3. Weather / Matter patterns
    const weather_matches = safe_prompt_text.match(/\b(heavy\s+rain|pouring\s+rain|rain|thick\s+fog|morning\s+fog|fog|mist|rising\s+steam|steam|dense\s+smoke|smoke|falling\s+snow|snow|dust\s+motes|swirling\s+dust|sea\s+spray|wet\s+cobblestones|water\s+droplets)\b/gi) || [];
    for (const weather_phrase of weather_matches) {
        add_physical_anchor(weather_phrase.toLowerCase(), 'weather_or_matter', null, null);
    }

    // 4. Lighting patterns
    const lighting_matches = safe_prompt_text.match(/\b(natural\s+sunlight|golden\s+hour\s+sunlight|soft\s+diffused\s+light|hard\s+directional\s+light|backlit\s+rim\s+light|neon\s+glow|candlelight| dappled\s+sunlight|overcast\s+daylight|chiaroscuro\s+lighting|studio\s+softbox|streetlamp|flashlight\s+beam)\b/gi) || [];
    for (const light_phrase of lighting_matches) {
        add_physical_anchor(light_phrase.toLowerCase(), 'lighting', null, null);
    }

    // 5. Film stock / Medium patterns
    const medium_matches = safe_prompt_text.match(/\b(black\s+and\s+white\s+woodblock\s+print|woodblock\s+print|oil\s+painting|watercolor\s+illustration|charcoal\s+sketch|35mm\s+film\s+grain|analog\s+photograph|digital\s+illustration|bronze\s+sculpture|carved\s+wood|stone\s+relief|monochrome\s+print)\b/gi) || [];
    for (const medium_phrase of medium_matches) {
        add_physical_anchor(medium_phrase.toLowerCase(), 'film_stock_or_medium', null, null);
    }

    // 6. Palette patterns
    const palette_matches = safe_prompt_text.match(/\b(black\s+and\s+white|monochrome|warm\s+earth\s+tones|muted\s+pastel\s+tones|deep\s+crimson\s+and\s+gold|teal\s+and\s+amber|high-?contrast\s+monochrome|vibrant\s+polychrome|earthy\s+ochre\s+palette)\b/gi) || [];
    for (const palette_phrase of palette_matches) {
        add_physical_anchor(palette_phrase.toLowerCase(), 'palette', null, null);
    }

    // 7. Subject appearance, clothing, expression, and setting from clauses & image analysis
    const appearance_matches = safe_prompt_text.match(/\b(in\s+a\s+trenchcoat|trenchcoat|silk\s+dress|traditional\s+garments|carved\s+facial\s+tattoos|moko\s+patterns|weathered\s+stone\s+surface|moss-?covered\s+rock|bold\s+lines|ornate\s+headdress|feathered\s+cloak)\b/gi) || [];
    for (const app_phrase of appearance_matches) {
        add_physical_anchor(app_phrase.toLowerCase(), 'subject_appearance', primary_subject_id, null);
    }

    const expression_matches = safe_prompt_text.match(/\b(weary\s+expression|stoic\s+gaze|serene\s+expression|contemplative\s+pose|seated\s+cross-?legged|standing\s+upright|crouching\s+low|looking\s+directly\s+at\s+camera)\b/gi) || [];
    for (const exp_phrase of expression_matches) {
        add_physical_anchor(exp_phrase.toLowerCase(), 'expression_or_pose', primary_subject_id, null);
    }

    // 8. Extract additional concrete clauses from the prompt/summary text and existing objects/tags so every image gets rich ingredients
    for (const obj_item of existing_objects.slice(0, 5)) {
        const clean_obj = String(obj_item || '').trim();
        if (clean_obj) {
            const slot = /sky|mountain|forest|ocean|beach|river|temple|shrine|building|room|street|garden|wall/i.test(clean_obj)
                ? 'setting'
                : 'subject_appearance';
            add_physical_anchor(clean_obj, slot, slot === 'subject_appearance' ? primary_subject_id : null, null);
        }
    }

    for (const tag_item of existing_tags.slice(0, 6)) {
        const clean_tag = String(tag_item || '').trim();
        if (!clean_tag || seen_pretext_terms.has(clean_tag.toLowerCase())) continue;
        if (/light|shadow|glow|sun|illumination|bright|dark/i.test(clean_tag)) {
            add_physical_anchor(clean_tag, 'lighting', null, null);
        } else if (/color|tone|warm|cool|vibrant|monochrome|black and white|red|blue|green|gold/i.test(clean_tag)) {
            add_physical_anchor(clean_tag, 'palette', null, null);
        } else if (/portrait|close-up|wide|angle|view|composition|macro/i.test(clean_tag)) {
            add_physical_anchor(clean_tag, 'framing', null, null);
        } else if (/rain|fog|mist|cloud|water|snow|wind|dust/i.test(clean_tag)) {
            add_physical_anchor(clean_tag, 'weather_or_matter', null, null);
        } else if (/painting|print|drawing|sculpture|carving|photograph|art|illustration/i.test(clean_tag)) {
            add_physical_anchor(clean_tag, 'film_stock_or_medium', null, null);
        } else if (/outdoor|indoor|landscape|nature|architecture|interior|exterior/i.test(clean_tag)) {
            add_physical_anchor(clean_tag, 'setting', null, null);
        }
    }

    // If still fewer than 3 physical anchors, split the prompt/summary into atomic descriptive clauses
    if (physical_anchors.length < 3 && safe_prompt_text.length > 0) {
        const clauses = safe_prompt_text
            .split(/[,.;]+/)
            .map(clause => clause.trim())
            .filter(clause => clause.length >= 4 && clause.length <= 75);

        for (const clause of clauses.slice(0, 6)) {
            let inferred_slot = 'subject_appearance';
            if (/shot|view|angle|frame|close-up|wide/i.test(clause)) inferred_slot = 'framing';
            else if (/light|shadow|sun|lamp|glow/i.test(clause)) inferred_slot = 'lighting';
            else if (/rain|fog|mist|water|sky|cloud/i.test(clause)) inferred_slot = 'weather_or_matter';
            else if (/print|painting|photo|film|sketch|carving/i.test(clause)) inferred_slot = 'film_stock_or_medium';
            else if (/room|street|forest|beach|mountain|temple|shrine|background/i.test(clause)) inferred_slot = 'setting';
            else if (/color|palette|black and white|tone/i.test(clause)) inferred_slot = 'palette';

            add_physical_anchor(
                clause,
                inferred_slot,
                inferred_slot === 'subject_appearance' ? primary_subject_id : null,
                null
            );
        }
    }

    return {
        pass_a: {
            media_type: media_type,
            subjects: detected_subjects,
            ambiguous_clauses: []
        },
        pass_b: {
            pretext_terms: detected_pretext_terms,
            physical_anchors: physical_anchors
        }
    };
}

/**
 * WHAT: Synthesizes deterministic Pass D influence edges from a Pass C Master Record's ingredients.
 * WHY: Links weather->appearance, weather->lighting, lighting->appearance/palette, and medium->palette
 *      with concrete state_key, applied_state_value, and clashes_with_value tags.
 *
 * @param {Object} master_record - The assembled Pass C master record.
 * @returns {ReadonlyArray<Object>} Array of validated Pass D influence edges.
 */
export function build_heuristic_influences_for_master_record(master_record) {
    const ingredients_list = Array.isArray(master_record?.ingredients) ? master_record.ingredients : [];
    const influences = [];

    const weather_ingredient = ingredients_list.find(ing => ing.slot === 'weather_or_matter');
    const appearance_ingredient = ingredients_list.find(ing => ing.slot === 'subject_appearance');
    const lighting_ingredient = ingredients_list.find(ing => ing.slot === 'lighting');
    const palette_ingredient = ingredients_list.find(ing => ing.slot === 'palette');
    const medium_ingredient = ingredients_list.find(ing => ing.slot === 'film_stock_or_medium');
    const setting_ingredient = ingredients_list.find(ing => ing.slot === 'setting');

    if (weather_ingredient && appearance_ingredient) {
        // WHAT: Classify weather/matter into explicit moisture states rather than a binary wet/dry fallback.
        // WHY: Neutral atmosphere (wind, smoke, haze, clouds) should not falsely claim 'dry_matte_dust' and clash with moisture.
        const is_wet_weather = /rain|water|spray|mist|fog|snow|steam|dew|wet|damp|puddle/i.test(weather_ingredient.text);
        const is_dry_particulate_weather = /dust|sand|arid|desert|ash|chalk|powder|parched|dry/i.test(weather_ingredient.text);

        if (is_wet_weather || is_dry_particulate_weather) {
            influences.push(Object.freeze({
                source_ingredient_id: weather_ingredient.ingredient_id,
                target_ingredient_id: appearance_ingredient.ingredient_id,
                interaction_type: 'surface_physical',
                portable_target_slot: 'subject_appearance',
                target_subject_scope: 'same_subject_only',
                consequence_description: is_wet_weather
                    ? 'darkened wet surface with specular moisture highlights'
                    : 'fine particulate dust settling across surface folds',
                state_key: 'surface_moisture',
                applied_state_value: is_wet_weather ? 'wet_specular' : 'dry_matte_dust',
                clashes_with_value: is_wet_weather ? 'dry_matte_dust' : 'wet_specular'
            }));
        }
    }

    if (weather_ingredient && lighting_ingredient) {
        influences.push(Object.freeze({
            source_ingredient_id: weather_ingredient.ingredient_id,
            target_ingredient_id: lighting_ingredient.ingredient_id,
            interaction_type: 'optical_lighting',
            portable_target_slot: 'lighting',
            target_subject_scope: 'whole_frame',
            consequence_description: 'diffused beam scatter with volumetric atmospheric streaks',
            state_key: 'light_scatter',
            applied_state_value: 'streaky_volumetric',
            clashes_with_value: 'sharp_hard_vacuum_shadow'
        }));
    }

    if (lighting_ingredient && (appearance_ingredient || palette_ingredient || setting_ingredient)) {
        const target_ing = appearance_ingredient || palette_ingredient || setting_ingredient;
        if (target_ing && target_ing.ingredient_id !== lighting_ingredient.ingredient_id) {
            const is_warm_kelvin = /3200K|sodium|golden|warm|candle/i.test(lighting_ingredient.text);
            influences.push(Object.freeze({
                source_ingredient_id: lighting_ingredient.ingredient_id,
                target_ingredient_id: target_ing.ingredient_id,
                interaction_type: 'optical_lighting',
                portable_target_slot: target_ing.slot,
                target_subject_scope: 'whole_frame',
                consequence_description: is_warm_kelvin
                    ? 'warm amber color cast across illuminated surfaces'
                    : 'directional highlight modelling across surface relief',
                state_key: 'color_cast',
                applied_state_value: is_warm_kelvin ? 'warm_amber_wash' : 'neutral_directional_key',
                clashes_with_value: is_warm_kelvin ? 'cold_sterile_daylight' : 'flat_shadowless_ambient'
            }));
        }
    }

    if (medium_ingredient && (palette_ingredient || appearance_ingredient)) {
        const target_ing = palette_ingredient || appearance_ingredient;
        if (target_ing && target_ing.ingredient_id !== medium_ingredient.ingredient_id) {
            influences.push(Object.freeze({
                source_ingredient_id: medium_ingredient.ingredient_id,
                target_ingredient_id: target_ing.ingredient_id,
                interaction_type: 'surface_physical',
                portable_target_slot: target_ing.slot,
                target_subject_scope: 'whole_frame',
                consequence_description: 'tactile medium grain and physical stroke texture across forms',
                state_key: 'surface_texture',
                applied_state_value: 'textured_medium_grain',
                clashes_with_value: 'smooth_plastic_cgi'
            }));
        }
    }

    return Object.freeze(influences);
}

