/**
 * Laya Decision Engine Fast Classifier Client
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

export class LayaClient {
    /**
     * WHAT: Initializes the LayaClient instance with default candidate endpoint and taxonomy configurations.
     * WHY: Laya runs as a high-speed non-autoregressive decision engine on localhost:8765.
     *      Having a dedicated client provides clean separation of concerns and sub-15ms classification.
     */
    constructor() {
        const environment_specified_endpoint = process.env.LAYA_SERVER_URL;
        const default_candidate_endpoints = [
            environment_specified_endpoint,
            'http://127.0.0.1:8765',
            'http://localhost:8765'
        ];

        // WHAT: Deduplicating and cleaning candidate URLs for the microservice.
        // WHY: Eliminates null or duplicate entries while ensuring trailing slashes are trimmed.
        this.candidate_endpoint_urls = Array.from(
            new Set(
                default_candidate_endpoints
                    .filter((candidate_url) => typeof candidate_url === 'string' && candidate_url.trim().length > 0)
                    .map((candidate_url) => candidate_url.replace(/\/+$/, ''))
            )
        );

        this.active_endpoint_url = this.candidate_endpoint_urls[0] || 'http://127.0.0.1:8765';
        this.is_server_online = false;
        this.last_health_check_timestamp_milliseconds = 0;
        this.health_check_cache_duration_milliseconds = 5000;
        this.active_device_name = 'unknown';

        // Curated taxonomy for image facet classification
        this.image_facet_taxonomy_questions = {
            visual_medium: {
                type: 'choice',
                instructions: 'What artistic or photographic medium best characterizes this visual scene?',
                criteria: {
                    photography: 'real-world camera photo, street photography, portrait photograph, documentary',
                    three_dimensional_render: '3D CGI render, Blender, Unreal Engine, digital 3D model, CGI character',
                    digital_art: 'digital concept painting, anime illustration, Photoshop digital drawing, matte painting',
                    traditional_art: 'oil painting, watercolor, ink wash, pencil sketch, etching, historical canvas',
                    sculpture_craft: 'physical 3D sculpture, clay carving, origami, wood carving, ceramic, doll',
                    diagram_typography: 'text overlay, chart, diagram, infographic, book page, typography layout'
                }
            },
            visual_mood: {
                type: 'choice',
                instructions: 'What overall atmospheric mood or emotion dominates this image?',
                criteria: {
                    dark_and_moody: 'somber, gothic, mysterious, shadows, eerie, dark ambient, melancholy',
                    bright_and_vibrant: 'sunny, joyful, high saturation, cheerful, energetic, luminous',
                    minimalist_serene: 'clean, tranquil, zen, spacious, quiet, understated, calm',
                    whimsical_playful: 'cartoonish, cute, humorous, surreal, quirky, plush, playful',
                    dramatic_cinematic: 'epic action, high tension, cinematic blockbuster lighting, heroic struggle'
                }
            },
            composition_framing: {
                type: 'choice',
                instructions: 'What is the primary camera framing or spatial composition?',
                criteria: {
                    portrait_close_up: 'close-up face, headshot, character bust, tight focus on single subject',
                    wide_landscape: 'broad panoramic landscape, outdoor vista, mountain range, wide city street',
                    macro_texture: 'extreme close-up on surface textures, abstract material patterns, microscopic',
                    interior_enclosed: 'interior room, architectural indoor space, hallway, stage, confined setting'
                }
            },
            caption_richness_score: {
                type: 'score',
                instructions: 'Rate the descriptive richness and completeness of this visual analysis text.',
                criteria: [
                    'low: brief, generic single sentence with minimal visual detail',
                    'medium: decent paragraph describing primary subjects and colors',
                    'high: comprehensive breakdown covering lighting, composition, textures, and mood'
                ]
            }
        };

        // Questions for search query intent classification
        this.search_query_intent_questions = {
            search_intent_type: {
                type: 'choice',
                instructions: 'What primary search intent is expressed by the user search query?',
                criteria: {
                    semantic_concept: 'abstract mood or thematic query like "peaceful morning" or "cyberpunk world"',
                    specific_entity: 'concrete object, animal, person, or character like "red fox" or "vintage bicycle"',
                    medium_focused: 'explicit medium specified like "oil painting", "pencil sketch", or "macro photo"',
                    style_aesthetic: 'artistic style or lighting like "noir", "neon glow", or "vaporwave"'
                }
            },
            target_medium: {
                type: 'choice',
                instructions: 'Does this query explicitly specify or strongly imply a visual medium?',
                criteria: {
                    photography: 'photo, photograph, realistic camera shot, documentary shot',
                    three_dimensional_render: '3d, render, cgi, blender, unreal',
                    digital_art: 'digital art, digital painting, illustration, concept art',
                    traditional_art: 'painting, oil painting, watercolor, sketch, drawing, etching',
                    sculpture_craft: 'sculpture, statue, carved, origami, ceramic',
                    unspecified: 'no specific artistic medium requested'
                }
            },
            target_mood: {
                type: 'choice',
                instructions: 'Does this query specify a mood or lighting atmosphere?',
                criteria: {
                    dark_and_moody: 'dark, night, moody, horror, eerie, shadow, noir',
                    bright_and_vibrant: 'bright, sunny, colorful, vibrant, happy, summer',
                    minimalist_serene: 'minimal, peaceful, zen, simple, quiet, calm',
                    whimsical_playful: 'cute, cartoon, funny, silly, whimsical, plush',
                    unspecified: 'no specific emotional mood requested'
                }
            }
        };
    }

    /**
     * WHAT: Probes the health endpoint of the Laya microservice.
     * WHY: Verifies server availability before dispatching classifications and reports GPU status.
     * 
     * @param {boolean} force_immediate_probe - Bypass short caching.
     * @returns {Promise<boolean>} True if server is responsive.
     */
    async checkServerHealth(force_immediate_probe = false) {
        const current_timestamp_milliseconds = Date.now();
        const time_elapsed_since_last_check = current_timestamp_milliseconds - this.last_health_check_timestamp_milliseconds;

        if (!force_immediate_probe && time_elapsed_since_last_check < this.health_check_cache_duration_milliseconds) {
            return this.is_server_online;
        }

        for (const candidate_endpoint_url of this.candidate_endpoint_urls) {
            try {
                const controller_instance = new AbortController();
                const timeout_handle = setTimeout(() => controller_instance.abort(), 1500);

                const health_probe_response = await fetch(`${candidate_endpoint_url}/health`, {
                    signal: controller_instance.signal
                });
                clearTimeout(timeout_handle);

                if (health_probe_response.ok) {
                    const health_data = await health_probe_response.json();
                    this.active_endpoint_url = candidate_endpoint_url;
                    this.is_server_online = true;
                    this.active_device_name = health_data.device || 'cuda';
                    this.last_health_check_timestamp_milliseconds = current_timestamp_milliseconds;
                    return true;
                }
            } catch (probe_network_error) {
                // Try next candidate endpoint URL
            }
        }

        this.is_server_online = false;
        this.last_health_check_timestamp_milliseconds = current_timestamp_milliseconds;
        return false;
    }

    /**
     * WHAT: Dispatches a structured classification request to Laya's /decide endpoint.
     * WHY: Single forward-pass classification across all supplied criteria questions simultaneously.
     * 
     * @param {string|Object} state_context_data - The text or object to classify.
     * @param {Object} questions_specification - The questions dictionary for Laya.
     * @returns {Promise<Object>} The decision results dictionary.
     */
    async decide(state_context_data, questions_specification) {
        const is_microservice_reachable = await this.checkServerHealth();
        if (!is_microservice_reachable) {
            throw new Error(`Laya Decision Engine microservice is offline at ${this.active_endpoint_url}. Please launch start_laya_server.bat.`);
        }

        const controller_instance = new AbortController();
        const timeout_handle = setTimeout(() => controller_instance.abort(), 5000);

        try {
            const decision_http_response = await fetch(`${this.active_endpoint_url}/decide`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    state: state_context_data,
                    questions: questions_specification
                }),
                signal: controller_instance.signal
            });
            clearTimeout(timeout_handle);

            if (!decision_http_response.ok) {
                const error_text = await decision_http_response.text();
                throw new Error(`Laya decision API error (${decision_http_response.status}): ${error_text}`);
            }

            const decision_response_payload = await decision_http_response.json();
            return decision_response_payload;
        } catch (network_execution_error) {
            clearTimeout(timeout_handle);
            throw network_execution_error;
        }
    }

    /**
     * WHAT: Evaluates an image's description across medium, mood, composition, and detail richness in ~10ms.
     * WHY: Enriches images with multi-faceted metadata without waiting for heavy autoregressive LLMs.
     * 
     * @param {string} image_analysis_summary - The summary or description text from images.db.
     * @returns {Promise<Object>} Formatted facets with choices and confidence values.
     */
    async classifyImageFacets(image_analysis_summary) {
        // Truncate to first 350 characters for optimal ModernBERT receptive field
        const trimmed_analysis_context = (image_analysis_summary || '').slice(0, 350).trim();
        if (!trimmed_analysis_context) {
            return {
                medium: 'photography',
                mood: 'minimalist_serene',
                composition: 'portrait_close_up',
                detail_score: 0.5,
                confidence_scores: { medium: 0.0, mood: 0.0, composition: 0.0 }
            };
        }

        const prediction_result = await this.decide(trimmed_analysis_context, this.image_facet_taxonomy_questions);
        const answers_map = prediction_result.answers || {};

        const medium_answer = answers_map.visual_medium || {};
        const mood_answer = answers_map.visual_mood || {};
        const composition_answer = answers_map.composition_framing || {};
        const detail_score_answer = answers_map.caption_richness_score || {};

        return {
            medium: medium_answer.choice || 'photography',
            mood: mood_answer.choice || 'minimalist_serene',
            composition: composition_answer.choice || 'portrait_close_up',
            detail_score: typeof detail_score_answer.score === 'number' ? detail_score_answer.score / 2.0 : 0.5,
            confidence_scores: {
                medium: medium_answer.confidence || 0.0,
                mood: mood_answer.confidence || 0.0,
                composition: composition_answer.confidence || 0.0
            }
        };
    }

    /**
     * WHAT: Analyzes user search queries to detect intent, desired medium, and mood.
     * WHY: Enables automatic facet pre-filtering and smart query routing in search.html.
     * 
     * @param {string} user_search_query_text - Raw query entered into search input.
     * @returns {Promise<Object>} Intent classification with suggested filter adjustments.
     */
    async classifyQueryIntent(user_search_query_text) {
        const clean_query_text = (user_search_query_text || '').slice(0, 150).trim();
        if (!clean_query_text) {
            return {
                intent_type: 'semantic_concept',
                target_medium: 'unspecified',
                target_mood: 'unspecified',
                suggested_filters: {}
            };
        }

        const prediction_result = await this.decide(clean_query_text, this.search_query_intent_questions);
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

        return {
            intent_type: intent_type_choice,
            target_medium: target_medium_choice,
            target_mood: target_mood_choice,
            suggested_filters: suggested_filters,
            confidence: {
                intent_type: answers_map.search_intent_type?.confidence || 0.0,
                medium: answers_map.target_medium?.confidence || 0.0,
                mood: answers_map.target_mood?.confidence || 0.0
            }
        };
    }
}

export const laya_client_instance = new LayaClient();
