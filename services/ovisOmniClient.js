/**
 * Ovis-Omni Multimodal Engine Client
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

export class OvisOmniClient {
    /**
     * WHAT: Initializes the OvisOmniClient instance with candidate endpoints and taxonomy definitions.
     * WHY: Ovis-Omni runs as a dedicated Python FastAPI service on port 8082, handling multimodal
     *      image vectorization, cross-modal query embedding, and zero-shot visual classification.
     */
    constructor() {
        const environment_specified_endpoint = process.env.OVIS_SERVER_URL;
        const default_candidate_endpoints = [
            environment_specified_endpoint,
            'http://127.0.0.1:8082',
            'http://localhost:8082'
        ];

        // WHAT: Deduplicating candidate URLs and trimming trailing slashes.
        // WHY: Ensures clean, reliable network requests without double-slash routing issues.
        this.candidate_endpoint_urls = Array.from(
            new Set(
                default_candidate_endpoints
                    .filter((candidate_url) => typeof candidate_url === 'string' && candidate_url.trim().length > 0)
                    .map((candidate_url) => candidate_url.replace(/\/+$/, ''))
            )
        );

        this.active_endpoint_url = this.candidate_endpoint_urls[0] || 'http://127.0.0.1:8082';
        this.is_server_online = false;
        this.last_health_check_timestamp_milliseconds = 0;
        this.health_check_cache_duration_milliseconds = 5000;
        this.detected_hardware_device_name = 'unknown';
        this.embedding_vector_dimensions = 2048;

        // WHAT: Standard visual taxonomy definitions for zero-shot classification.
        // WHY: Pre-defining standardized visual categories allows instant classification of newly ingested
        //      images into image_facets (medium, mood, framing) without waiting for slow autoregressive LLM captions.
        this.standard_classification_taxonomies = {
            visual_medium: [
                'real-world photography',
                '3D CGI digital render',
                'digital concept illustration',
                'traditional oil or watercolor painting',
                'handcrafted sculpture or physical craft',
                'diagrammatic graphic layout or typography'
            ],
            visual_mood: [
                'dark, moody and atmospheric',
                'bright, vibrant and luminous',
                'minimalist, calm and serene',
                'whimsical, playful and colorful',
                'dramatic, epic and cinematic'
            ],
            composition_framing: [
                'tight macro close-up focus',
                'portrait headshot character framing',
                'wide scenic panoramic landscape vista',
                'interior architectural room space',
                'birds-eye aerial overhead perspective'
            ]
        };
    }

    /**
     * WHAT: Checks the health and readiness of the Ovis-Omni microservice on port 8082.
     * WHY: Caching the result for 5 seconds avoids spamming the service during rapid UI interactions
     *      while still accurately tracking whether the model weights are loaded and ready.
     * 
     * @param {boolean} force_refresh_probe - Whether to bypass cache and re-probe immediately.
     * @returns {Promise<boolean>} True if the service is online and model is loaded.
     */
    async checkHealth(force_refresh_probe = false) {
        const current_timestamp_milliseconds = Date.now();
        const is_health_cache_still_valid = (
            !force_refresh_probe &&
            (current_timestamp_milliseconds - this.last_health_check_timestamp_milliseconds) < this.health_check_cache_duration_milliseconds
        );

        if (is_health_cache_still_valid) {
            return this.is_server_online;
        }

        for (const candidate_endpoint_url of this.candidate_endpoint_urls) {
            try {
                const target_health_url = `${candidate_endpoint_url}/health`;
                const abort_controller = new AbortController();
                const timeout_handle = setTimeout(() => abort_controller.abort(), 2000);

                const http_health_response = await fetch(target_health_url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: abort_controller.signal
                });

                clearTimeout(timeout_handle);

                if (http_health_response.ok) {
                    const parsed_health_payload = await http_health_response.json();
                    this.active_endpoint_url = candidate_endpoint_url;
                    this.is_server_online = (parsed_health_payload.status === 'online');
                    this.detected_hardware_device_name = parsed_health_payload.gpu_device_name || parsed_health_payload.device || 'unknown';
                    this.last_health_check_timestamp_milliseconds = current_timestamp_milliseconds;
                    return this.is_server_online;
                }
            } catch (network_connection_error) {
                // Continue probing next endpoint candidate
                continue;
            }
        }

        this.is_server_online = false;
        this.last_health_check_timestamp_milliseconds = current_timestamp_milliseconds;
        return false;
    }

    /**
     * WHAT: Generates a 2048-dimensional normalized embedding directly from an image file on disk.
     * WHY: Bypasses textual description entirely, preserving subtle optical textures, lighting,
     *      and visual styles directly in the embedding space.
     * 
     * @param {string} physical_image_file_path - Absolute path to the image on local storage.
     * @returns {Promise<Array<number>>} 2048-dimensional float vector.
     */
    async generateImageEmbedding(physical_image_file_path) {
        const is_online = await this.checkHealth();
        if (!is_online) {
            throw new Error(`Ovis-Omni microservice is offline at ${this.active_endpoint_url}. Launch start_ovis_server.bat to start it.`);
        }

        const target_image_embed_url = `${this.active_endpoint_url}/embed/image`;
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
        return parsed_response_payload.embedding;
    }

    /**
     * WHAT: Generates a 2048-dimensional normalized embedding for a text search query.
     * WHY: Maps the query into the exact same vector space as images, enabling direct cross-modal retrieval.
     * 
     * @param {string} text_search_query - The conceptual search query typed by the user.
     * @returns {Promise<Array<number>>} 2048-dimensional float vector.
     */
    async generateTextEmbedding(text_search_query) {
        const is_online = await this.checkHealth();
        if (!is_online) {
            throw new Error(`Ovis-Omni microservice is offline at ${this.active_endpoint_url}. Launch start_ovis_server.bat to start it.`);
        }

        const target_text_embed_url = `${this.active_endpoint_url}/embed/text`;
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
        return parsed_response_payload.embedding;
    }

    /**
     * WHAT: Classifies an image into candidate labels via zero-shot cosine similarity.
     * WHY: Provides instant taxonomy classification without prompt engineering or LLM token generation.
     * 
     * @param {string} physical_image_file_path - Path to the image file.
     * @param {Array<string>} candidate_taxonomic_labels - Labels to classify against.
     * @param {string} classification_facet_name - Name of the facet category.
     * @returns {Promise<{ facet_name: string, top_label: string, top_confidence: number, predictions: Array<Object> }>}
     */
    async classifyImageZeroShot(physical_image_file_path, candidate_taxonomic_labels, classification_facet_name = 'visual_facet') {
        const is_online = await this.checkHealth();
        if (!is_online) {
            throw new Error(`Ovis-Omni microservice is offline at ${this.active_endpoint_url}. Launch start_ovis_server.bat to start it.`);
        }

        const target_classify_url = `${this.active_endpoint_url}/classify/zero-shot`;
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
    }
}

export const ovis_omni_client_instance = new OvisOmniClient();
