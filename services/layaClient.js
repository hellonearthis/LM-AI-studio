/**
 * Laya Decision Engine Fast Classifier Client
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 * Pure functional core with thin delegation wrapper for backward-compatible call boundaries.
 */

// ============================================================================
// TAXONOMY SPECIFICATIONS (IMMUTABLE CONSTANTS)
// ============================================================================

// WHAT: Curated taxonomy for image facet classification across medium, mood, and framing.
// WHY: ModernBERT classifies text across multiple criteria simultaneously in a single forward pass.
export const IMAGE_FACET_TAXONOMY_QUESTIONS = Object.freeze({
    visual_medium: Object.freeze({
        type: 'choice',
        instructions: 'What artistic or photographic medium best characterizes this visual scene?',
        criteria: Object.freeze({
            photography: 'real-world camera photo, street photography, portrait photograph, documentary',
            three_dimensional_render: '3D CGI render, Blender, Unreal Engine, digital 3D model, CGI character',
            digital_art: 'digital concept painting, anime illustration, Photoshop digital drawing, matte painting',
            traditional_art: 'oil painting, watercolor, ink wash, pencil sketch, etching, historical canvas',
            sculpture_craft: 'physical 3D sculpture, clay carving, origami, wood carving, ceramic, doll',
            diagram_typography: 'text overlay, chart, diagram, infographic, book page, typography layout'
        })
    }),
    visual_mood: Object.freeze({
        type: 'choice',
        instructions: 'What overall atmospheric mood or emotion dominates this image?',
        criteria: Object.freeze({
            dark_and_moody: 'somber, gothic, mysterious, shadows, eerie, dark ambient, melancholy',
            bright_and_vibrant: 'sunny, joyful, high saturation, cheerful, energetic, luminous',
            minimalist_serene: 'clean, tranquil, zen, spacious, quiet, understated, calm',
            whimsical_playful: 'cartoonish, cute, humorous, surreal, quirky, plush, playful',
            dramatic_cinematic: 'epic action, high tension, cinematic blockbuster lighting, heroic struggle'
        })
    }),
    composition_framing: Object.freeze({
        type: 'choice',
        instructions: 'What is the primary camera framing or spatial composition?',
        criteria: Object.freeze({
            portrait_close_up: 'close-up face, headshot, character bust, tight focus on single subject',
            wide_landscape: 'broad panoramic landscape, outdoor vista, mountain range, wide city street',
            macro_texture: 'extreme close-up on surface textures, abstract material patterns, microscopic',
            interior_enclosed: 'interior room, architectural indoor space, hallway, stage, confined setting'
        })
    }),
    caption_richness_score: Object.freeze({
        type: 'score',
        instructions: 'Rate the descriptive richness and completeness of this visual analysis text.',
        criteria: Object.freeze([
            'low: brief, generic single sentence with minimal visual detail',
            'medium: decent paragraph describing primary subjects and colors',
            'high: comprehensive breakdown covering lighting, composition, textures, and mood'
        ])
    })
});

// WHAT: Questions for user search query intent classification.
// WHY: Enables automatic facet pre-filtering and smart query routing in search.html.
export const SEARCH_QUERY_INTENT_QUESTIONS = Object.freeze({
    search_intent_type: Object.freeze({
        type: 'choice',
        instructions: 'What primary search intent is expressed by the user search query?',
        criteria: Object.freeze({
            semantic_concept: 'abstract mood or thematic query like "peaceful morning" or "cyberpunk world"',
            specific_entity: 'concrete object, animal, person, or character like "red fox" or "vintage bicycle"',
            medium_focused: 'explicit medium specified like "oil painting", "pencil sketch", or "macro photo"',
            style_aesthetic: 'artistic style or lighting like "noir", "neon glow", or "vaporwave"'
        })
    }),
    target_medium: Object.freeze({
        type: 'choice',
        instructions: 'Does this query explicitly specify or strongly imply a visual medium?',
        criteria: Object.freeze({
            photography: 'photo, photograph, realistic camera shot, documentary shot',
            three_dimensional_render: '3d, render, cgi, blender, unreal',
            digital_art: 'digital art, digital painting, illustration, concept art',
            traditional_art: 'painting, oil painting, watercolor, sketch, drawing, etching',
            sculpture_craft: 'sculpture, statue, carved, origami, ceramic',
            unspecified: 'no specific artistic medium requested'
        })
    }),
    target_mood: Object.freeze({
        type: 'choice',
        instructions: 'Does this query specify a mood or lighting atmosphere?',
        criteria: Object.freeze({
            dark_and_moody: 'dark, night, moody, horror, eerie, shadow, noir',
            bright_and_vibrant: 'bright, sunny, colorful, vibrant, happy, summer',
            minimalist_serene: 'minimal, peaceful, zen, simple, quiet, calm',
            whimsical_playful: 'cute, cartoon, funny, silly, whimsical, plush',
            unspecified: 'no specific emotional mood requested'
        })
    })
});

// ============================================================================
// PURE FUNCTIONAL CLIENT CONFIGURATION FACTORY
// ============================================================================

/**
 * WHAT: Produces an immutable configuration record for the Laya microservice.
 * WHY: Eliminates mutable instance properties by encapsulating client parameters as frozen data.
 * 
 * @param {string|null} optional_custom_endpoint_override - Explicit URL override.
 * @returns {Readonly<Object>} Frozen client configuration record.
 */
export const create_laya_client_configuration = (optional_custom_endpoint_override = null) => {
    const environment_specified_endpoint = process.env.LAYA_SERVER_URL;
    const default_candidate_endpoints = optional_custom_endpoint_override
        ? [optional_custom_endpoint_override]
        : [
            environment_specified_endpoint,
            'http://127.0.0.1:8765',
            'http://localhost:8765'
        ];

    // WHAT: Deduplicating and trimming candidate endpoint URLs.
    // WHY: Guarantees sanitized network addresses without redundant slashes.
    const candidate_endpoint_urls = Object.freeze(
        Array.from(
            new Set(
                default_candidate_endpoints
                    .filter((candidate_url) => typeof candidate_url === 'string' && candidate_url.trim().length > 0)
                    .map((candidate_url) => candidate_url.replace(/\/+$/, ''))
            )
        )
    );

    return Object.freeze({
        candidate_endpoint_urls,
        active_endpoint_url: candidate_endpoint_urls[0] || 'http://127.0.0.1:8765',
        health_check_cache_duration_milliseconds: 5000,
        image_facet_taxonomy_questions: IMAGE_FACET_TAXONOMY_QUESTIONS,
        search_query_intent_questions: SEARCH_QUERY_INTENT_QUESTIONS
    });
};

// ============================================================================
// PURE FUNCTIONAL DOMAIN PROCEDURES
// ============================================================================

/**
 * WHAT: Probes candidate endpoints to determine if the Laya microservice is reachable.
 * WHY: Verifies server availability before dispatching classifications without side effects.
 * 
 * @param {Readonly<Object>} client_configuration - The frozen client configuration.
 * @returns {Promise<{ is_online: boolean, responsive_endpoint_url: string, active_device_name: string }>}
 */
export const probe_laya_server_health = async (client_configuration) => {
    for (const candidate_endpoint_url of client_configuration.candidate_endpoint_urls) {
        try {
            const abort_controller_instance = new AbortController();
            const timeout_handle = setTimeout(() => abort_controller_instance.abort(), 1500);

            const health_probe_response = await fetch(`${candidate_endpoint_url}/health`, {
                signal: abort_controller_instance.signal
            });
            clearTimeout(timeout_handle);

            if (health_probe_response.ok) {
                const health_payload = await health_probe_response.json();
                return {
                    is_online: true,
                    responsive_endpoint_url: candidate_endpoint_url,
                    active_device_name: health_payload.device || 'cuda'
                };
            }
        } catch (probe_network_error) {
            // WHAT: Fallback to next candidate endpoint if connection refused.
            // WHY: Probing continues until an active address is found or all candidates fail.
            continue;
        }
    }

    return {
        is_online: false,
        responsive_endpoint_url: client_configuration.active_endpoint_url,
        active_device_name: 'unknown'
    };
};

/**
 * WHAT: Dispatches a structured classification request to Laya's /decide endpoint.
 * WHY: Executes single forward-pass classification across all supplied criteria questions.
 * 
 * @param {Readonly<Object>} client_configuration - The client configuration record.
 * @param {string|Object} state_context_data - The text or object to classify.
 * @param {Object} questions_specification - The questions dictionary for Laya.
 * @returns {Promise<Object>} The decision results dictionary.
 */
export const execute_laya_decision = async (client_configuration, state_context_data, questions_specification) => {
    const health_status = await probe_laya_server_health(client_configuration);
    if (!health_status.is_online) {
        throw new Error(`Laya Decision Engine microservice is offline at ${client_configuration.active_endpoint_url}. Please launch start_laya_server.bat.`);
    }

    const abort_controller_instance = new AbortController();
    const timeout_handle = setTimeout(() => abort_controller_instance.abort(), 5000);

    try {
        const decision_http_response = await fetch(`${health_status.responsive_endpoint_url}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                state: state_context_data,
                questions: questions_specification
            }),
            signal: abort_controller_instance.signal
        });
        clearTimeout(timeout_handle);

        if (!decision_http_response.ok) {
            const error_message_text = await decision_http_response.text();
            throw new Error(`Laya decision API error (${decision_http_response.status}): ${error_message_text}`);
        }

        return await decision_http_response.json();
    } catch (network_execution_error) {
        clearTimeout(timeout_handle);
        throw network_execution_error;
    }
};

/**
 * WHAT: Evaluates an image's description across medium, mood, composition, and detail richness.
 * WHY: Pure functional mapping from summary text to structured facet records.
 * 
 * @param {Readonly<Object>} client_configuration - The client configuration record.
 * @param {string} image_analysis_summary - The summary or description text from database.
 * @returns {Promise<Object>} Formatted facets with choices and confidence values.
 */
export const classify_image_facets = async (client_configuration, image_analysis_summary) => {
    const trimmed_analysis_context = (image_analysis_summary || '').slice(0, 350).trim();
    if (!trimmed_analysis_context) {
        return Object.freeze({
            medium: 'photography',
            mood: 'minimalist_serene',
            composition: 'portrait_close_up',
            detail_score: 0.5,
            confidence_scores: Object.freeze({ medium: 0.0, mood: 0.0, composition: 0.0 })
        });
    }

    const prediction_result = await execute_laya_decision(
        client_configuration,
        trimmed_analysis_context,
        client_configuration.image_facet_taxonomy_questions
    );
    const answers_map = prediction_result.answers || {};

    const medium_answer = answers_map.visual_medium || {};
    const mood_answer = answers_map.visual_mood || {};
    const composition_answer = answers_map.composition_framing || {};
    const detail_score_answer = answers_map.caption_richness_score || {};

    return Object.freeze({
        medium: medium_answer.choice || 'photography',
        mood: mood_answer.choice || 'minimalist_serene',
        composition: composition_answer.choice || 'portrait_close_up',
        detail_score: typeof detail_score_answer.score === 'number' ? detail_score_answer.score / 2.0 : 0.5,
        confidence_scores: Object.freeze({
            medium: medium_answer.confidence || 0.0,
            mood: mood_answer.confidence || 0.0,
            composition: composition_answer.confidence || 0.0
        })
    });
};

/**
 * WHAT: Analyzes user search queries to detect intent, desired medium, and mood.
 * WHY: Pure functional mapping from search query text to suggested facet filters.
 * 
 * @param {Readonly<Object>} client_configuration - The client configuration record.
 * @param {string} user_search_query_text - Raw query entered into search input.
 * @returns {Promise<Object>} Intent classification with suggested filter adjustments.
 */
export const classify_search_query_intent = async (client_configuration, user_search_query_text) => {
    const clean_query_text = (user_search_query_text || '').slice(0, 150).trim();
    if (!clean_query_text) {
        return Object.freeze({
            intent_type: 'semantic_concept',
            target_medium: 'unspecified',
            target_mood: 'unspecified',
            suggested_filters: Object.freeze({}),
            confidence: Object.freeze({ intent_type: 0.0, medium: 0.0, mood: 0.0 })
        });
    }

    const prediction_result = await execute_laya_decision(
        client_configuration,
        clean_query_text,
        client_configuration.search_query_intent_questions
    );
    const answers_map = prediction_result.answers || {};

    const intent_type_choice = answers_map.search_intent_type?.choice || 'semantic_concept';
    const target_medium_choice = answers_map.target_medium?.choice || 'unspecified';
    const target_mood_choice = answers_map.target_mood?.choice || 'unspecified';

    const suggested_filters = {};
    if (target_medium_choice !== 'unspecified' && (answers_map.target_medium?.confidence || 0) >= 0.70) {
        suggested_filters.medium = target_medium_choice;
    }
    if (target_mood_choice !== 'unspecified' && (answers_map.target_mood?.confidence || 0) >= 0.70) {
        suggested_filters.mood = target_mood_choice;
    }

    return Object.freeze({
        intent_type: intent_type_choice,
        target_medium: target_medium_choice,
        target_mood: target_mood_choice,
        suggested_filters: Object.freeze(suggested_filters),
        confidence: Object.freeze({
            intent_type: answers_map.search_intent_type?.confidence || 0.0,
            medium: answers_map.target_medium?.confidence || 0.0,
            mood: answers_map.target_mood?.confidence || 0.0
        })
    });
};

/**
 * WHAT: Executes a non-throwing `/decide` call against Laya for optional Prompt Dicer slot/clash scoring.
 * WHY: Allows offline-first pipelines to query Laya probabilities when available without failing when port 8765 is offline.
 * 
 * @param {Readonly<Object>} client_configuration - The client configuration record.
 * @param {string|Object} state_context_data - Text context to evaluate.
 * @param {Object} questions_specification - Structured Laya choice/yes-no questions dictionary.
 * @returns {Promise<Object>} Frozen `{ available, answers, reason? }`.
 */
export const try_execute_laya_decision = async (
    client_configuration,
    state_context_data,
    questions_specification
) => {
    try {
        const health_status = await probe_laya_server_health(client_configuration);
        if (!health_status.is_online) {
            return Object.freeze({ available: false, answers: Object.freeze({}), reason: 'laya_offline' });
        }
        const decision_payload = await execute_laya_decision(
            client_configuration,
            state_context_data,
            questions_specification
        );
        return Object.freeze({
            available: true,
            answers: decision_payload?.answers || Object.freeze({})
        });
    } catch (laya_optional_error) {
        return Object.freeze({
            available: false,
            answers: Object.freeze({}),
            reason: laya_optional_error.message || 'laya_error'
        });
    }
};

// ============================================================================
// THIN DELEGATION WRAPPER (BACKWARD-COMPATIBLE BOUNDARY ADAPTER)
// ============================================================================

/**
 * WHAT: Pure factory adapter delegating calls to pure functional routines without `class` or `this`.
 * WHY: Supports existing callers expecting client object method signatures while adhering to Pure Functional Architecture.
 */
export function createLayaClient(optional_endpoint_override = null) {
    const configuration = create_laya_client_configuration(optional_endpoint_override);
    let client_health_state = {
        active_endpoint_url: configuration.active_endpoint_url,
        active_device_name: 'unknown',
        is_server_online: false,
        last_health_check_timestamp_milliseconds: 0
    };
    const health_check_cache_duration_milliseconds = 5000;

    return {
        get configuration() { return configuration; },
        get active_endpoint_url() { return client_health_state.active_endpoint_url; },
        get active_device_name() { return client_health_state.active_device_name; },
        get is_server_online() { return client_health_state.is_server_online; },
        image_facet_taxonomy_questions: configuration.image_facet_taxonomy_questions,
        search_query_intent_questions: configuration.search_query_intent_questions,

        async checkServerHealth(force_immediate_probe = false) {
            const current_timestamp_milliseconds = Date.now();
            const time_elapsed_since_last_check = current_timestamp_milliseconds - client_health_state.last_health_check_timestamp_milliseconds;

            if (!force_immediate_probe && time_elapsed_since_last_check < health_check_cache_duration_milliseconds) {
                return client_health_state.is_server_online;
            }

            const probe_result = await probe_laya_server_health(configuration);
            client_health_state = {
                active_endpoint_url: probe_result.responsive_endpoint_url,
                active_device_name: probe_result.active_device_name,
                is_server_online: probe_result.is_online,
                last_health_check_timestamp_milliseconds: current_timestamp_milliseconds
            };
            return probe_result.is_online;
        },

        async decide(state_context_data, questions_specification) {
            return execute_laya_decision(configuration, state_context_data, questions_specification);
        },

        async tryDecide(state_context_data, questions_specification) {
            return try_execute_laya_decision(configuration, state_context_data, questions_specification);
        },

        async classifyImageFacets(image_analysis_summary) {
            return classify_image_facets(configuration, image_analysis_summary);
        },

        async classifyQueryIntent(user_search_query_text) {
            return classify_search_query_intent(configuration, user_search_query_text);
        }
    };
}

export const LayaClient = createLayaClient;

// WHAT: Default singleton adapter instance for server route handlers.
// WHY: Ensures zero breaking changes for existing Express routes.
export const laya_client_instance = createLayaClient();
