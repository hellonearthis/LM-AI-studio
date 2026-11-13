/**
 * Ovis-Omni Multimodal Engine Client
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 * Pure functional core with thin delegation wrapper for backward-compatible call boundaries.
 */

// ============================================================================
// TAXONOMY SPECIFICATIONS (IMMUTABLE CONSTANTS)
// ============================================================================

// WHAT: Standard visual taxonomy definitions for zero-shot visual classification.
// WHY: Standardized categories allow instant zero-shot categorization into image facets.
export const STANDARD_CLASSIFICATION_TAXONOMIES = Object.freeze({
    visual_medium: Object.freeze([
        'real-world photography',
        '3D CGI digital render',
        'digital concept illustration',
        'traditional oil or watercolor painting',
        'handcrafted sculpture or physical craft',
        'diagrammatic graphic layout or typography'
    ]),
    visual_mood: Object.freeze([
        'dark, moody and atmospheric',
        'bright, vibrant and luminous',
        'minimalist, calm and serene',
        'whimsical, playful and colorful',
        'dramatic, epic and cinematic'
    ]),
    composition_framing: Object.freeze([
        'tight macro close-up focus',
        'portrait headshot character framing',
        'wide scenic panoramic landscape vista',
        'interior architectural room space',
        'birds-eye aerial overhead perspective'
    ])
});

// ============================================================================
// PURE FUNCTIONAL CONFIGURATION FACTORY
// ============================================================================

/**
 * WHAT: Produces an immutable configuration record for the Ovis-Omni multimodal service.
 * WHY: Replaces mutable class instances with frozen records.
 * 
 * @param {string|null} optional_custom_endpoint_override - Explicit URL override.
 * @returns {Readonly<Object>} Frozen client configuration record.
 */
export const create_ovis_omni_configuration = (optional_custom_endpoint_override = null) => {
    const environment_specified_endpoint = process.env.OVIS_SERVER_URL;
    const default_candidate_endpoints = optional_custom_endpoint_override
        ? [optional_custom_endpoint_override]
        : [
            environment_specified_endpoint,
            'http://127.0.0.1:8082',
            'http://localhost:8082'
        ];

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
        active_endpoint_url: candidate_endpoint_urls[0] || 'http://127.0.0.1:8082',
        embedding_vector_dimensions: 2048,
        health_check_cache_duration_milliseconds: 5000,
        standard_classification_taxonomies: STANDARD_CLASSIFICATION_TAXONOMIES
    });
};

// ============================================================================
// PURE FUNCTIONAL DOMAIN PROCEDURES
// ============================================================================

/**
 * WHAT: Probes the health and readiness of the Ovis-Omni microservice on port 8082.
 * WHY: Verifies server availability and model readiness without mutating global state.
 * 
 * @param {Readonly<Object>} client_configuration - The frozen client configuration.
 * @returns {Promise<{ is_online: boolean, responsive_endpoint_url: string, hardware_device_name: string }>}
 */
export const probe_ovis_server_health = async (client_configuration) => {
    for (const candidate_endpoint_url of client_configuration.candidate_endpoint_urls) {
        try {
            const target_health_url = `${candidate_endpoint_url}/health`;
            const abort_controller_instance = new AbortController();
            const timeout_handle = setTimeout(() => abort_controller_instance.abort(), 2000);

            const http_health_response = await fetch(target_health_url, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: abort_controller_instance.signal
            });
            clearTimeout(timeout_handle);

            if (http_health_response.ok) {
                const parsed_health_payload = await http_health_response.json();
                return {
                    is_online: parsed_health_payload.status === 'online',
                    responsive_endpoint_url: candidate_endpoint_url,
                    hardware_device_name: parsed_health_payload.gpu_device_name || parsed_health_payload.device || 'unknown'
                };
            }
        } catch (network_connection_error) {
            continue;
        }
    }

    return {
        is_online: false,
        responsive_endpoint_url: client_configuration.active_endpoint_url,
        hardware_device_name: 'unknown'
    };
};

/**
 * WHAT: Generates a 2048-dimensional normalized embedding directly from an image file.
 * WHY: Encodes raw optical textures and composition directly into high-dimensional vector space.
 * 
 * @param {Readonly<Object>} client_configuration - The frozen client configuration.
 * @param {string} physical_image_file_path - Absolute path to the image on local storage.
 * @returns {Promise<ReadonlyArray<number>>} 2048-dimensional normalized float vector.
 */
export const generate_image_multimodal_embedding = async (client_configuration, physical_image_file_path) => {
    const health_status = await probe_ovis_server_health(client_configuration);
    if (!health_status.is_online) {
        throw new Error(`Ovis-Omni microservice is offline at ${client_configuration.active_endpoint_url}. Launch start_ovis_server.bat to start it.`);
    }

    const target_image_embed_url = `${health_status.responsive_endpoint_url}/embed/image`;
    const http_embed_response = await fetch(target_image_embed_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image_file_path: physical_image_file_path,
            instruction_prefix: 'Represent this image for retrieval'
        })
    });

    if (!http_embed_response.ok) {
        const error_message_text = await http_embed_response.text();
        throw new Error(`Ovis-Omni Image Embed Error (${http_embed_response.status}): ${error_message_text}`);
    }

    const parsed_response_payload = await http_embed_response.json();
    return Object.freeze(parsed_response_payload.embedding);
};

/**
 * WHAT: Generates a 2048-dimensional normalized embedding for a text search query.
 * WHY: Projects text queries into the exact multimodal vector space as visual embeddings.
 * 
 * @param {Readonly<Object>} client_configuration - The frozen client configuration.
 * @param {string} text_search_query - The conceptual search query typed by the user.
 * @returns {Promise<ReadonlyArray<number>>} 2048-dimensional float vector.
 */
export const generate_text_multimodal_embedding = async (client_configuration, text_search_query) => {
    const health_status = await probe_ovis_server_health(client_configuration);
    if (!health_status.is_online) {
        throw new Error(`Ovis-Omni microservice is offline at ${client_configuration.active_endpoint_url}. Launch start_ovis_server.bat to start it.`);
    }

    const target_text_embed_url = `${health_status.responsive_endpoint_url}/embed/text`;
    const http_embed_response = await fetch(target_text_embed_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text_content: text_search_query,
            instruction_prefix: 'Represent this query for retrieving relevant images: '
        })
    });

    if (!http_embed_response.ok) {
        const error_message_text = await http_embed_response.text();
        throw new Error(`Ovis-Omni Text Embed Error (${http_embed_response.status}): ${error_message_text}`);
    }

    const parsed_response_payload = await http_embed_response.json();
    return Object.freeze(parsed_response_payload.embedding);
};

/**
 * WHAT: Classifies an image into candidate labels via zero-shot cosine similarity.
 * WHY: Pure functional classification evaluating image embeddings against label embeddings.
 * 
 * @param {Readonly<Object>} client_configuration - The client configuration record.
 * @param {string} physical_image_file_path - Path to the image file.
 * @param {Array<string>} candidate_taxonomic_labels - Labels to classify against.
 * @param {string} classification_facet_name - Name of the facet category.
 * @returns {Promise<Object>} Formatted classification payload.
 */
export const classify_image_zero_shot = async (
    client_configuration,
    physical_image_file_path,
    candidate_taxonomic_labels,
    classification_facet_name = 'visual_facet'
) => {
    const health_status = await probe_ovis_server_health(client_configuration);
    if (!health_status.is_online) {
        throw new Error(`Ovis-Omni microservice is offline at ${client_configuration.active_endpoint_url}. Launch start_ovis_server.bat to start it.`);
    }

    const target_classify_url = `${health_status.responsive_endpoint_url}/classify/zero-shot`;
    const http_classify_response = await fetch(target_classify_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image_file_path: physical_image_file_path,
            candidate_taxonomic_labels: candidate_taxonomic_labels,
            classification_facet_name: classification_facet_name
        })
    });

    if (!http_classify_response.ok) {
        const error_message_text = await http_classify_response.text();
        throw new Error(`Ovis-Omni Classification Error (${http_classify_response.status}): ${error_message_text}`);
    }

    return await http_classify_response.json();
};

// ============================================================================
// THIN DELEGATION WRAPPER (BACKWARD-COMPATIBLE BOUNDARY ADAPTER)
// ============================================================================

/**
 * WHAT: Thin backward-compatible adapter delegating calls to pure functional routines.
 * WHY: Supports existing callers expecting class-like method signatures without violating pure functional architecture.
 */
// WHAT: Pure factory adapter delegating calls to pure functional Ovis-Omni routines without `class` or `this`.
// WHY: Replaces mutable class instances with functional closures while keeping existing method callers compatible.
export function createOvisOmniClient(optional_endpoint_override = null) {
    const configuration = create_ovis_omni_configuration(optional_endpoint_override);
    let client_health_state = {
        active_endpoint_url: configuration.active_endpoint_url,
        detected_hardware_device_name: 'unknown',
        is_server_online: false,
        last_health_check_timestamp_milliseconds: 0
    };
    const health_check_cache_duration_milliseconds = 5000;

    return {
        get configuration() { return configuration; },
        get active_endpoint_url() { return client_health_state.active_endpoint_url; },
        get detected_hardware_device_name() { return client_health_state.detected_hardware_device_name; },
        get is_server_online() { return client_health_state.is_server_online; },
        embedding_vector_dimensions: configuration.embedding_vector_dimensions,
        standard_classification_taxonomies: configuration.standard_classification_taxonomies,

        async checkHealth(force_refresh_probe = false) {
            const current_timestamp_milliseconds = Date.now();
            const is_health_cache_still_valid = (
                !force_refresh_probe &&
                (current_timestamp_milliseconds - client_health_state.last_health_check_timestamp_milliseconds) < health_check_cache_duration_milliseconds
            );

            if (is_health_cache_still_valid) {
                return client_health_state.is_server_online;
            }

            const probe_result = await probe_ovis_server_health(configuration);
            client_health_state = {
                active_endpoint_url: probe_result.responsive_endpoint_url,
                detected_hardware_device_name: probe_result.hardware_device_name,
                is_server_online: probe_result.is_online,
                last_health_check_timestamp_milliseconds: current_timestamp_milliseconds
            };
            return probe_result.is_online;
        },

        async generateImageEmbedding(physical_image_file_path) {
            return generate_image_multimodal_embedding(configuration, physical_image_file_path);
        },

        async generateTextEmbedding(text_search_query) {
            return generate_text_multimodal_embedding(configuration, text_search_query);
        },

        async classifyImageZeroShot(physical_image_file_path, candidate_taxonomic_labels, classification_facet_name = 'visual_facet') {
            return classify_image_zero_shot(configuration, physical_image_file_path, candidate_taxonomic_labels, classification_facet_name);
        }
    };
}

export const OvisOmniClient = createOvisOmniClient;

// WHAT: Default singleton adapter instance for server route handlers.
// WHY: Ensures zero breaking changes for existing Express routes.
export const ovis_omni_client_instance = createOvisOmniClient();
