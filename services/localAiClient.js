/**
 * Local AI Client with Dynamic Server Discovery & Capability Verification
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

export function createLocalAIClient() {
    /**
     * WHAT: Initializes the LocalAIClient instance with candidate endpoints and default fallback state.
     * WHY: Applications need a reliable list of standard ports (8081 for llama-server, 1234 for LM Studio,
     *      and 9931 for upcoming llama.cpp standards) to automatically establish contact without manual user setup.
     */
    const client_state = {};
        // Collect candidate endpoints prioritizing explicit environment overrides
        const environment_specified_endpoint = process.env.LOCAL_AI_URL || process.env.OPENAI_BASE_URL;

        const standard_candidate_endpoints = [
            environment_specified_endpoint,
            'http://127.0.0.1:8081',
            'http://localhost:8081',
            'http://127.0.0.1:9931',
            'http://localhost:9931'
        ];

        // WHAT: Deduplicating and cleaning candidate URLs.
        // WHY: We want to eliminate null, undefined, or redundant loopback entries while preserving probe priority.
        client_state.candidate_endpoint_urls = Array.from(
            new Set(
                standard_candidate_endpoints
                    .filter((candidate_url) => typeof candidate_url === 'string' && candidate_url.trim().length > 0)
                    .map((candidate_url) => candidate_url.replace(/\/+$/, ''))
            )
        );

        // WHAT: Initializing candidate endpoints dedicated for vector text embeddings.
        // WHY: Users running llama.cpp typically run a separate lightweight instance on port 8083 for fast embeddings.
        const environment_specified_embedding_endpoint = process.env.LOCAL_EMBEDDING_URL;
        const standard_candidate_embedding_endpoints = [
            environment_specified_embedding_endpoint,
            'http://127.0.0.1:8083',
            'http://localhost:8083',
            'http://127.0.0.1:8081',
            'http://localhost:8081'
        ];

        client_state.candidate_embedding_endpoint_urls = Array.from(
            new Set(
                standard_candidate_embedding_endpoints
                    .filter((candidate_url) => typeof candidate_url === 'string' && candidate_url.trim().length > 0)
                    .map((candidate_url) => candidate_url.replace(/\/+$/, ''))
            )
        );

        // Internal discovered state
        client_state.active_endpoint_url = null;
        client_state.active_embedding_endpoint_url = null;
        client_state.active_model_identifier = 'default';
        client_state.active_embedding_model_identifier = 'nomic-embed-text-v1.5';
        client_state.active_model_aliases = [];
        client_state.active_model_capabilities = [];
        client_state.has_multimodal_vision_capability = false;
        client_state.active_context_window_size = 4096;
        client_state.discovered_server_backend_type = 'unknown'; // 'llama-server' | 'generic'
        client_state.last_discovery_timestamp_milliseconds = 0;
        client_state.discovery_cache_duration_milliseconds = 10000; // 10 seconds cache to prevent excessive probing

    /**
     * WHAT: Discovers an active local AI server by probing candidate endpoints and verifying capabilities.
     * WHY: Users frequently switch between llama-server.exe and LM Studio or restart their server on different ports.
     *      Probing ensures seamless zero-configuration discovery with fast timeout failovers.
     * 
     * @param {Object} discovery_options
     * @param {boolean} discovery_options.require_multimodal_vision - Whether the caller strictly requires image understanding.
     * @param {boolean} discovery_options.force_refresh - Bypass cache and re-probe network immediately.
     * @returns {Promise<Object|null>} Discovered model metadata or null if offline.
     */
    async function discoverActiveModel(discovery_options = {}) {
        const require_multimodal_vision = discovery_options.require_multimodal_vision ?? false;
        const force_refresh = discovery_options.force_refresh ?? false;
        const current_timestamp_milliseconds = Date.now();

        // WHAT: Checking if the cached discovery is still fresh.
        // WHY: During high-frequency batch requests (like tagging 100 images), probing every single image
        //      introduces unnecessary latency. A short cache keeps operations snappy while adapting to restarts.
        const is_cache_valid = (
            !force_refresh &&
            client_state.active_endpoint_url !== null &&
            (current_timestamp_milliseconds - client_state.last_discovery_timestamp_milliseconds) < client_state.discovery_cache_duration_milliseconds
        );

        if (is_cache_valid) {
            return buildDiscoveredModelSummary();
        }

        // WHAT: Also probing the dedicated embeddings server to keep embedding state synchronized.
        // WHY: Ensures that both vision and embedding endpoints are ready for immediate search or maintenance operations.
        await discoverActiveEmbeddingModel(force_refresh);

        // WHAT: Iterating through candidate endpoints with an aggressive timeout.
        // WHY: If a port has no listener, we want to fail quickly within 1500ms rather than hanging the application.
        for (const candidate_endpoint_url of client_state.candidate_endpoint_urls) {
            try {
                const target_models_endpoint_url = `${candidate_endpoint_url}/v1/models`;

                const fetch_abort_controller = new AbortController();
                const timeout_handle = setTimeout(() => {
                    fetch_abort_controller.abort();
                }, 1500);

                const http_models_response = await fetch(target_models_endpoint_url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: fetch_abort_controller.signal
                });

                clearTimeout(timeout_handle);

                if (http_models_response.ok) {
                    const parsed_models_json = await http_models_response.json();
                    
                    // WHAT: Extracting model records across both llama-server and LM Studio response schemas.
                    // WHY: llama-server returns { data: [...], models: [...] } while standard OpenAI returns { data: [...] }.
                    const primary_model_data_record = parsed_models_json.data?.[0] || null;
                    const primary_raw_model_record = parsed_models_json.models?.[0] || null;

                    if (primary_model_data_record || primary_raw_model_record) {
                        client_state.active_endpoint_url = candidate_endpoint_url;
                        client_state.active_model_identifier = primary_model_data_record?.id || primary_raw_model_record?.name || 'default';
                        
                        // Extract aliases if supplied by llama-server --alias parameter
                        client_state.active_model_aliases = (
                            primary_model_data_record?.aliases ||
                            primary_raw_model_record?.aliases ||
                            []
                        );

                        // Extract capabilities array (llama-server supplies ["completion", "multimodal"])
                        const raw_capabilities = (
                            primary_raw_model_record?.capabilities ||
                            primary_model_data_record?.capabilities ||
                            []
                        );
                        client_state.active_model_capabilities = Array.isArray(raw_capabilities) ? raw_capabilities : [];

                        // WHAT: Evaluating multimodal vision capability.
                        // WHY: llama-server explicitly includes "multimodal" when a vision projector (--mmproj) is attached.
                        //      For LM Studio or other backends, we also inspect common vision model keywords in the identifier.
                        const has_explicit_multimodal_capability = client_state.active_model_capabilities.includes('multimodal');
                        const lowercase_identifier = client_state.active_model_identifier.toLowerCase();
                        const has_vision_name_indicators = (
                            lowercase_identifier.includes('vl') ||
                            lowercase_identifier.includes('vision') ||
                            lowercase_identifier.includes('llava') ||
                            lowercase_identifier.includes('qwen') && lowercase_identifier.includes('vl')
                        );

                        client_state.has_multimodal_vision_capability = (
                            has_explicit_multimodal_capability ||
                            has_vision_name_indicators
                        );

                        // Extract context size
                        client_state.active_context_window_size = (
                            primary_raw_model_record?.meta?.n_ctx ||
                            primary_model_data_record?.meta?.n_ctx ||
                            8192
                        );

                        // Identify backend architecture
                        if (parsed_models_json.models && Array.isArray(parsed_models_json.models)) {
                            client_state.discovered_server_backend_type = 'llama-server';
                        } else {
                            client_state.discovered_server_backend_type = 'llama-server-compatible';
                        }

                        client_state.last_discovery_timestamp_milliseconds = current_timestamp_milliseconds;

                        // WHAT: Issuing instructional warning if vision is required but not detected.
                        // WHY: The user needs clear feedback explaining that the server is online but missing --mmproj.
                        if (require_multimodal_vision && !client_state.has_multimodal_vision_capability) {
                            console.warn(
                                `[LocalAIClient] Warning: Connected to ${client_state.active_model_identifier} at ${client_state.active_endpoint_url}, ` +
                                `but the active model does not declare multimodal capabilities. Ensure llama-server was started with --mmproj.`
                            );
                        }

                        return buildDiscoveredModelSummary();
                    }
                }
            } catch (network_probe_error) {
                // WHAT: Silently catching connection failures and continuing to the next candidate port.
                // WHY: Probing ports that are not actively listening is standard behavior during port auto-discovery.
                continue;
            }
        }

        // WHAT: Resetting state if all candidate endpoints failed to respond.
        // WHY: Prevents stale endpoints from being used when the local server process was terminated.
        client_state.active_endpoint_url = null;
        client_state.active_model_identifier = 'default';
        client_state.has_multimodal_vision_capability = false;
        client_state.discovered_server_backend_type = 'offline';
        return null;
    }

    /**
     * WHAT: Discovers an active dedicated text embeddings server (such as port 8081).
     * WHY: Running text embeddings on a dedicated port allows semantic search to operate concurrently
     *      without interrupting or reloading weights in the primary vision server.
     * 
     * @param {boolean} force_refresh - Bypass cached discovery state.
     * @returns {Promise<string|null>} Discovered embeddings endpoint URL or null if offline.
     */
    async function discoverActiveEmbeddingModel(force_refresh = false) {
        for (const candidate_embedding_endpoint_url of client_state.candidate_embedding_endpoint_urls) {
            try {
                const target_models_endpoint_url = `${candidate_embedding_endpoint_url}/v1/models`;

                const fetch_abort_controller = new AbortController();
                const timeout_handle = setTimeout(() => {
                    fetch_abort_controller.abort();
                }, 1500);

                const http_models_response = await fetch(target_models_endpoint_url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: fetch_abort_controller.signal
                });

                clearTimeout(timeout_handle);

                if (http_models_response.ok) {
                    const parsed_models_json = await http_models_response.json();
                    const primary_model_data_record = parsed_models_json.data?.[0] || null;
                    const primary_raw_model_record = parsed_models_json.models?.[0] || null;

                    if (primary_model_data_record || primary_raw_model_record) {
                        client_state.active_embedding_endpoint_url = candidate_embedding_endpoint_url;
                        client_state.active_embedding_model_identifier = (
                            primary_model_data_record?.id ||
                            primary_raw_model_record?.name ||
                            'nomic-embed-text-v1.5'
                        );
                        return client_state.active_embedding_endpoint_url;
                    }
                }
            } catch (network_probe_error) {
                // Continue probing next candidate embedding port
                continue;
            }
        }

        // Fallback: If 8083 is not running, but 8081 is online, use 8081
        if (client_state.active_endpoint_url) {
            client_state.active_embedding_endpoint_url = client_state.active_endpoint_url;
            return client_state.active_embedding_endpoint_url;
        }

        client_state.active_embedding_endpoint_url = null;
        return null;
    }

    /**
     * WHAT: Constructs a structured summary object representing the active discovered model.
     * WHY: Provides caller functions with an immutable representation of current connection state.
     * 
     * @returns {Object} Structured model summary.
     */
    function buildDiscoveredModelSummary() {
        return {
            endpoint_url: client_state.active_endpoint_url,
            embedding_endpoint_url: client_state.active_embedding_endpoint_url,
            model_identifier: client_state.active_model_identifier,
            embedding_model_identifier: client_state.active_embedding_model_identifier,
            model_aliases: [...client_state.active_model_aliases],
            model_capabilities: [...client_state.active_model_capabilities],
            has_multimodal_vision: client_state.has_multimodal_vision_capability,
            context_window_size: client_state.active_context_window_size,
            backend_type: client_state.discovered_server_backend_type,
            is_connected: client_state.active_endpoint_url !== null
        };
    }

    /**
     * WHAT: Aggregates model lists from both the vision server (e.g., port 8081) and dedicated embedding server (port 8083).
     * WHY: In the UI settings, users need to see and configure both the vision model and the embedding model
     *      even when they are served by separate llama-server processes running on distinct ports.
     * 
     * @returns {Promise<{ object: string, data: Array<Object>, models: Array<Object> }>}
     */
    async function fetchCombinedModelsList() {
        // WHAT: Ensuring both endpoints are freshly discovered.
        // WHY: Guarantees that newly started or restarted servers are captured before fetching model manifests.
        await discoverActiveModel();
        await discoverActiveEmbeddingModel();

        let aggregated_model_records = [];
        const seen_model_identifiers = new Set();
        const endpoints_to_query = Array.from(new Set([
            client_state.active_endpoint_url,
            client_state.active_embedding_endpoint_url
        ].filter(Boolean)));

        for (const target_endpoint_url of endpoints_to_query) {
            try {
                const http_models_response = await fetch(`${target_endpoint_url}/v1/models`, {
                    headers: { 'Accept': 'application/json' }
                });
                if (http_models_response.ok) {
                    const parsed_payload = await http_models_response.json();
                    const models_array = parsed_payload.data || parsed_payload.models || [];
                    for (const model_record of models_array) {
                        const model_identifier = model_record.id || model_record.name;
                        if (model_identifier && !seen_model_identifiers.has(model_identifier)) {
                            seen_model_identifiers.add(model_identifier);
                            aggregated_model_records = [...aggregated_model_records, model_record];
                        }
                    }
                }
            } catch (query_models_error) {
                // Silently ignore unreachable endpoint during combined list build
            }
        }

        return {
            object: "list",
            data: aggregated_model_records,
            models: aggregated_model_records
        };
    }

    /**
     * WHAT: Returns the base endpoint URL of the active server (e.g., "http://127.0.0.1:8081").
     * WHY: Needed when formulating sub-routes such as /v1/chat/completions or /v1/embeddings.
     */
    function getActiveEndpointUrl() {
        return client_state.active_endpoint_url;
    }

    /**
     * WHAT: Returns the active model identifier or first alias.
     * WHY: Passed as the "model" property in OpenAI-compatible request payloads.
     */
    function getActiveModelIdentifier() {
        if (client_state.active_model_aliases.length > 0) {
            return client_state.active_model_aliases[0];
        }
        return client_state.active_model_identifier;
    }

    /**
     * WHAT: Returns the active embedding model identifier.
     * WHY: Passed as the "model" property in OpenAI-compatible embeddings request payloads.
     */
    function getActiveEmbeddingModelIdentifier() {
        return client_state.active_embedding_model_identifier;
    }

    /**
     * WHAT: Returns whether multimodal vision understanding is supported by the active model.
     * WHY: Used by image tagging and cinematic analysis modules to verify camera analysis capability.
     */
    function hasMultimodalVisionSupport() {
        return client_state.has_multimodal_vision_capability;
    }

    /**
     * WHAT: Returns the full HTTP URL for Chat Completions.
     * WHY: Centralizes endpoint construction so consumers never hardcode '/v1/chat/completions'.
     */
    function getChatCompletionsUrl() {
        const base_url = client_state.active_endpoint_url || 'http://127.0.0.1:8081';
        return `${base_url}/v1/chat/completions`;
    }

    /**
     * WHAT: Returns the full HTTP URL for Text Embeddings.
     * WHY: Centralizes endpoint construction for semantic vector indexing, pointing to port 8083 if dedicated or 8081 fallback.
     */
    function getEmbeddingsUrl() {
        if (client_state.active_embedding_endpoint_url) {
            return `${client_state.active_embedding_endpoint_url}/v1/embeddings`;
        }
        const base_url = client_state.active_endpoint_url || 'http://127.0.0.1:8081';
        return `${base_url}/v1/embeddings`;
    }

    /**
     * WHAT: Returns the full HTTP URL for Model Discovery.
     * WHY: Provides proxy routes with the upstream /v1/models endpoint location.
     */
    function getModelsUrl() {
        const base_url = client_state.active_endpoint_url || 'http://127.0.0.1:8081';
        return `${base_url}/v1/models`;
    }

    /**
     * WHAT: Generates an instructional text diagnostic report of current server connection status.
     * WHY: Displayed on diagnostic pages and terminal logs to troubleshoot configuration issues.
     */
    function getDiagnosticReport() {
        // WHAT: Constructing diagnostic report via pure array composition without in-place mutation.
        // WHY: Pure functional array concatenation guarantees deterministic formatting and zero side effects.
        const header_banner_lines = [
            '======================================================================',
            '                   LOCAL AI SERVER DIAGNOSTIC REPORT                  ',
            '======================================================================'
        ];

        const vision_server_diagnostic_lines = client_state.active_endpoint_url
            ? [
                'VISION SERVER: ONLINE',
                `  Endpoint:          ${client_state.active_endpoint_url}`,
                `  Backend Type:      ${client_state.discovered_server_backend_type}`,
                `  Active Model:      ${client_state.active_model_identifier}`,
                `  Aliases:           ${client_state.active_model_aliases.length > 0 ? client_state.active_model_aliases.join(', ') : 'None'}`,
                `  Multimodal Vision: ${client_state.has_multimodal_vision_capability ? 'YES (Supported)' : 'NO (Missing --mmproj)'}`,
                `  Context Window:    ${client_state.active_context_window_size} tokens`
            ]
            : [
                'VISION SERVER: OFFLINE',
                '  Status: No active vision server listening on port 8081.',
                '  Recommended Action: Run start_llama_server.bat (or start_llama_vision_4b.bat for low-VRAM).'
            ];

        const section_divider_line = ['----------------------------------------------------------------------'];

        const embedding_server_diagnostic_lines = client_state.active_embedding_endpoint_url
            ? [
                'EMBEDDING SERVER: ONLINE',
                `  Endpoint:          ${client_state.active_embedding_endpoint_url}`,
                `  Active Model:      ${client_state.active_embedding_model_identifier}`
            ]
            : [
                'EMBEDDING SERVER: OFFLINE',
                '  Status: No dedicated embedding server listening on port 8083.',
                '  Recommended Action: Run start_llama_embeddings.bat on port 8083.'
            ];

        const footer_banner_line = ['======================================================================'];

        const complete_diagnostic_lines_collection = [
            ...header_banner_lines,
            ...vision_server_diagnostic_lines,
            ...section_divider_line,
            ...embedding_server_diagnostic_lines,
            ...footer_banner_line
        ];

        return complete_diagnostic_lines_collection.join('\n');
    }
    return {
        get candidate_endpoint_urls() { return client_state.candidate_endpoint_urls; },
        set candidate_endpoint_urls(urls) { client_state.candidate_endpoint_urls = urls; },
        get candidate_embedding_endpoint_urls() { return client_state.candidate_embedding_endpoint_urls; },
        set candidate_embedding_endpoint_urls(urls) { client_state.candidate_embedding_endpoint_urls = urls; },
        get active_endpoint_url() { return client_state.active_endpoint_url; },
        get active_embedding_endpoint_url() { return client_state.active_embedding_endpoint_url; },
        get active_model_identifier() { return client_state.active_model_identifier; },
        get active_embedding_model_identifier() { return client_state.active_embedding_model_identifier; },
        get active_model_aliases() { return client_state.active_model_aliases; },
        get active_model_capabilities() { return client_state.active_model_capabilities; },
        get has_multimodal_vision_capability() { return client_state.has_multimodal_vision_capability; },
        get active_context_window_size() { return client_state.active_context_window_size; },
        get discovered_server_backend_type() { return client_state.discovered_server_backend_type; },
        discoverActiveModel,
        discoverActiveEmbeddingModel,
        buildDiscoveredModelSummary,
        fetchCombinedModelsList,
        getActiveEndpointUrl,
        getActiveModelIdentifier,
        getActiveEmbeddingModelIdentifier,
        hasMultimodalVisionSupport,
        getChatCompletionsUrl,
        getEmbeddingsUrl,
        getModelsUrl,
        getDiagnosticReport
    };
}

export const LocalAIClient = createLocalAIClient;

// Export singleton instance for app-wide sharing across routes
export const local_ai_client_instance = createLocalAIClient();
