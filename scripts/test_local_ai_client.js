/**
 * Test Suite for LocalAIClient
 * 
 * Validates dynamic port discovery, llama-server response parsing,
 * LM Studio compatibility, and offline diagnostics.
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

import http from 'http';
import { LocalAIClient } from '../services/localAiClient.js';

/**
 * WHAT: Executes an automated verification test suite against the LocalAIClient module.
 * WHY: Ensures that model discovery, capability checking, and fallback mechanisms work reliably
 *      without regressions across different local AI backends.
 */
async function runLocalAiClientTestSuite() {
    console.log('--- Starting LocalAIClient Automated Verification Suite ---');
    let total_assertions_passed_count = 0;

    // =========================================================================
    // Test 1: Offline Discovery & Diagnostic Generation
    // =========================================================================
    console.log('\n[Test 1] Testing offline behavior with unreachable endpoints...');
    const offline_client_instance = new LocalAIClient();
    // Restrict candidates to an unreachable port
    offline_client_instance.candidate_endpoint_urls = ['http://127.0.0.1:49152'];
    offline_client_instance.candidate_embedding_endpoint_urls = ['http://127.0.0.1:49152'];
    
    const offline_discovery_result = await offline_client_instance.discoverActiveModel();
    if (offline_discovery_result === null) {
        console.log('  PASS: Offline discovery cleanly returned null.');
        total_assertions_passed_count++;
    } else {
        throw new Error(`Expected null for unreachable endpoint, got: ${JSON.stringify(offline_discovery_result)}`);
    }

    const offline_diagnostic_report = offline_client_instance.getDiagnosticReport();
    if (offline_diagnostic_report.includes('OFFLINE') && offline_diagnostic_report.includes('Recommended Action')) {
        console.log('  PASS: Offline diagnostic report provides actionable troubleshooting steps.');
        total_assertions_passed_count++;
    } else {
        throw new Error(`Expected offline guidance in report, got: ${offline_diagnostic_report}`);
    }

    // =========================================================================
    // Test 2: llama-server Mock Response with Multimodal Capabilities
    // =========================================================================
    console.log('\n[Test 2] Testing llama-server response parsing with multimodal projector...');
    
    // Create a temporary mock server mimicking llama-server.exe
    const mock_llama_server = http.createServer((http_incoming_request, http_server_response) => {
        if (http_incoming_request.url === '/v1/models') {
            const llama_server_mock_payload = {
                object: "list",
                data: [
                    {
                        id: "models/lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf",
                        object: "model",
                        created: 1720000000,
                        owned_by: "llamacpp"
                    }
                ],
                models: [
                    {
                        name: "qwen3.5-9b",
                        capabilities: ["completion", "multimodal"],
                        aliases: ["qwen-vision", "default"],
                        meta: {
                            n_ctx: 8192,
                            n_params: 9000000000
                        }
                    }
                ]
            };
            http_server_response.writeHead(200, { 'Content-Type': 'application/json' });
            http_server_response.end(JSON.stringify(llama_server_mock_payload));
        } else {
            http_server_response.writeHead(404);
            http_server_response.end();
        }
    });

    await new Promise((resolve_listening_promise) => {
        mock_llama_server.listen(49153, '127.0.0.1', resolve_listening_promise);
    });

    try {
        const llama_client_instance = new LocalAIClient();
        llama_client_instance.candidate_endpoint_urls = ['http://127.0.0.1:49153'];

        const discovered_llama_summary = await llama_client_instance.discoverActiveModel({
            require_multimodal_vision: true
        });

        if (discovered_llama_summary !== null) {
            console.log('  PASS: Discovered model summary is non-null.');
            total_assertions_passed_count++;
        }

        if (discovered_llama_summary.has_multimodal_vision === true) {
            console.log('  PASS: Successfully extracted multimodal vision capability flag.');
            total_assertions_passed_count++;
        } else {
            throw new Error('Expected has_multimodal_vision to be true for llama-server with multimodal capability.');
        }

        if (discovered_llama_summary.model_aliases.includes('qwen-vision')) {
            console.log('  PASS: Extracted model alias successfully.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected alias 'qwen-vision', got: ${JSON.stringify(discovered_llama_summary.model_aliases)}`);
        }

        if (llama_client_instance.getChatCompletionsUrl() === 'http://127.0.0.1:49153/v1/chat/completions') {
            console.log('  PASS: Constructed chat completions endpoint URL correctly.');
            total_assertions_passed_count++;
        }

        if (llama_client_instance.getEmbeddingsUrl() === 'http://127.0.0.1:49153/v1/embeddings') {
            console.log('  PASS: Constructed embeddings endpoint URL correctly.');
            total_assertions_passed_count++;
        }

        if (llama_client_instance.getActiveModelIdentifier() === 'qwen-vision') {
            console.log('  PASS: Preferred clean alias over raw file path for model identifier.');
            total_assertions_passed_count++;
        }
    } finally {
        await new Promise((resolve_close_promise) => {
            mock_llama_server.close(resolve_close_promise);
        });
    }

    // =========================================================================
    // Test 3: llama-server Text / Embeddings Instance (No Multimodal Projector)
    // =========================================================================
    console.log('\n[Test 3] Testing llama-server text/embeddings instance without --mmproj...');

    const mock_text_llama_server = http.createServer((http_incoming_request, http_server_response) => {
        if (http_incoming_request.url === '/v1/models') {
            const text_llama_payload = {
                data: [
                    {
                        id: "models/nomic-embed-text-v1.5.Q8_0.gguf",
                        object: "model",
                        created: 1720000000,
                        owned_by: "llamacpp"
                    }
                ],
                models: [
                    {
                        name: "nomic-embed-text",
                        capabilities: ["embedding"],
                        aliases: ["embed-model", "default"],
                        meta: {
                            n_ctx: 2048
                        }
                    }
                ]
            };
            http_server_response.writeHead(200, { 'Content-Type': 'application/json' });
            http_server_response.end(JSON.stringify(text_llama_payload));
        } else {
            http_server_response.writeHead(404);
            http_server_response.end();
        }
    });

    await new Promise((resolve_listening_promise) => {
        mock_text_llama_server.listen(49154, '127.0.0.1', resolve_listening_promise);
    });

    try {
        const text_llama_client_instance = new LocalAIClient();
        text_llama_client_instance.candidate_endpoint_urls = ['http://127.0.0.1:49154'];

        const discovered_text_summary = await text_llama_client_instance.discoverActiveModel({
            require_multimodal_vision: true
        });

        if (discovered_text_summary.model_identifier === 'models/nomic-embed-text-v1.5.Q8_0.gguf') {
            console.log('  PASS: Parsed primary model ID correctly.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected 'models/nomic-embed-text-v1.5.Q8_0.gguf', got: ${discovered_text_summary.model_identifier}`);
        }

        if (discovered_text_summary.has_multimodal_vision === false) {
            console.log('  PASS: Correctly flagged lack of multimodal vision capability.');
            total_assertions_passed_count++;
        } else {
            throw new Error('Expected has_multimodal_vision to be false for pure text/embedding model.');
        }

        if (discovered_text_summary.backend_type === 'llama-server') {
            console.log('  PASS: Correctly identified backend architecture as llama-server.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected backend_type 'llama-server', got: ${discovered_text_summary.backend_type}`);
        }
    } finally {
        await new Promise((resolve_close_promise) => {
            mock_text_llama_server.close(resolve_close_promise);
        });
    }
    // =========================================================================
    // Test 4: Dedicated Embedding Server Discovery & Combined Model Aggregation
    // =========================================================================
    console.log('\n[Test 4] Testing dual-server discovery and combined models manifest...');
    
    const mock_vision_server = http.createServer((http_incoming_request, http_server_response) => {
        if (http_incoming_request.url === '/v1/models') {
            const vision_server_mock_payload = {
                object: "list",
                data: [{ id: "qwen3.5-9b", object: "model" }],
                models: [{ name: "qwen3.5-9b", capabilities: ["completion", "multimodal"] }]
            };
            http_server_response.writeHead(200, { 'Content-Type': 'application/json' });
            http_server_response.end(JSON.stringify(vision_server_mock_payload));
        } else {
            http_server_response.writeHead(404);
            http_server_response.end();
        }
    });

    const mock_embedding_server = http.createServer((http_incoming_request, http_server_response) => {
        if (http_incoming_request.url === '/v1/models') {
            const embedding_server_mock_payload = {
                object: "list",
                data: [{ id: "nomic-embed-text-v1.5", object: "model" }],
                models: [{ name: "nomic-embed-text-v1.5", capabilities: ["embeddings"] }]
            };
            http_server_response.writeHead(200, { 'Content-Type': 'application/json' });
            http_server_response.end(JSON.stringify(embedding_server_mock_payload));
        } else {
            http_server_response.writeHead(404);
            http_server_response.end();
        }
    });

    await new Promise((resolve_vision_listening) => mock_vision_server.listen(49155, '127.0.0.1', resolve_vision_listening));
    await new Promise((resolve_embedding_listening) => mock_embedding_server.listen(49156, '127.0.0.1', resolve_embedding_listening));

    try {
        const dual_client_instance = new LocalAIClient();
        dual_client_instance.candidate_endpoint_urls = ['http://127.0.0.1:49155'];
        dual_client_instance.candidate_embedding_endpoint_urls = ['http://127.0.0.1:49156'];

        await dual_client_instance.discoverActiveModel();
        await dual_client_instance.discoverActiveEmbeddingModel();

        if (dual_client_instance.getActiveEndpointUrl() === 'http://127.0.0.1:49155') {
            console.log('  PASS: Discovered vision endpoint correctly.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected vision endpoint 49155, got: ${dual_client_instance.getActiveEndpointUrl()}`);
        }

        if (dual_client_instance.getEmbeddingsUrl() === 'http://127.0.0.1:49156/v1/embeddings') {
            console.log('  PASS: Routed embeddings URL to dedicated embedding port 49156.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected embeddings URL 49156, got: ${dual_client_instance.getEmbeddingsUrl()}`);
        }

        const combined_manifest = await dual_client_instance.fetchCombinedModelsList();
        const aggregated_model_names = combined_manifest.data.map((model_record) => model_record.id);

        if (aggregated_model_names.includes('qwen3.5-9b') && aggregated_model_names.includes('nomic-embed-text-v1.5')) {
            console.log('  PASS: Combined models list aggregated models across both server instances.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected both models in list, got: ${JSON.stringify(aggregated_model_names)}`);
        }

        const dual_diagnostic_report = dual_client_instance.getDiagnosticReport();
        if (dual_diagnostic_report.includes('VISION SERVER: ONLINE') && dual_diagnostic_report.includes('EMBEDDING SERVER: ONLINE')) {
            console.log('  PASS: Dual server diagnostic report correctly shows both vision and embeddings online.');
            total_assertions_passed_count++;
        } else {
            throw new Error(`Expected dual online diagnostics, got: ${dual_diagnostic_report}`);
        }
    } finally {
        await new Promise((resolve_close_vision) => mock_vision_server.close(resolve_close_vision));
        await new Promise((resolve_close_embedding) => mock_embedding_server.close(resolve_close_embedding));
    }

    console.log(`\nAll tests passed successfully! Total passing assertions: ${total_assertions_passed_count}`);
}

runLocalAiClientTestSuite().catch((unhandled_error_instance) => {
    console.error('\nTest suite execution failed with error:', unhandled_error_instance);
    process.exit(1);
});
