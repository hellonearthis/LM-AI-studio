// ============================================================================
// LUMINA STUDIO - SETTINGS & HARDWARE CONFIGURATION
// ============================================================================
// WHAT: Controls local AI model discovery, GPU offloading, and background pipelines.
// WHY: Coordinates the imperative shell bridging user preferences to the Node backend,
//      llama-server, Ovis-Omni, and Laya Decision Engine microservices.
//
// PROTOCOL COMPLIANCE:
// 1. "can_be_long" Protocol: Expressive semantic variable naming without shorthand.
// 2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
// ============================================================================

const API_BASE_URL = 'http://localhost:3000';

// ============================================================================
// DOM ELEMENT BINDINGS
// ============================================================================
const vision_model_select_element = document.getElementById('visionModelSelect');
const embedding_model_select_element = document.getElementById('embeddingModelSelect');
const gpu_offload_layers_input_element = document.getElementById('gpuLayers');
const context_length_tokens_input_element = document.getElementById('contextLength');
const advanced_settings_toggle_element = document.getElementById('advancedToggle');
const advanced_settings_content_element = document.getElementById('advancedContent');
const advanced_toggle_icon_element = document.getElementById('toggleIcon');
const load_model_button_element = document.getElementById('loadModelBtn');
const model_load_status_message_element = document.getElementById('loadStatus');

const refresh_models_button_element = document.getElementById('refreshModelsBtn');
const save_configuration_button_element = document.getElementById('saveConfigBtn');
const save_status_indicator_element = document.getElementById('saveStatus');
const diagnostics_output_pre_element = document.getElementById('diagnosticsOutput');

// ============================================================================
// ADVANCED ACCORDION CONTROLLER
// ============================================================================

// WHAT: Toggles visibility of advanced hardware settings (GPU layers, context tokens).
// WHY: Keeps primary interface clean for standard users while exposing power parameters.
if (advanced_settings_toggle_element) {
    advanced_settings_toggle_element.addEventListener('click', () => {
        advanced_settings_content_element.classList.toggle('open');
        const is_accordion_expanded = advanced_settings_content_element.classList.contains('open');
        advanced_toggle_icon_element.textContent = is_accordion_expanded ? '▼' : '▶';
    });
}

// ============================================================================
// INITIALIZATION AND EVENT LISTENERS
// ============================================================================

// WHAT: Queries available models, saved preferences, and service status on page load.
// WHY: Populates form dropdowns and indicators immediately upon view entry.
document.addEventListener('DOMContentLoaded', async () => {
    await refreshAvailableModelsList();
    await loadPersistedSystemConfiguration();
    await checkLayaMicroserviceStatus();
});

refresh_models_button_element.addEventListener('click', async () => {
    refresh_models_button_element.disabled = true;
    refresh_models_button_element.textContent = 'Refreshing...';
    await refreshAvailableModelsList();
    refresh_models_button_element.textContent = '🔄 Refresh Models';
    refresh_models_button_element.disabled = false;
});

// WHAT: Saves user-selected models and hardware parameters to config.json on the server.
// WHY: Ensures user selections persist across server and Electron application restarts.
save_configuration_button_element.addEventListener('click', async () => {
    const user_configuration_payload = {
        visionModel: vision_model_select_element.value,
        embeddingModel: embedding_model_select_element.value,
        gpuLayers: gpu_offload_layers_input_element ? gpu_offload_layers_input_element.value : 'max',
        contextLength: parseInt(gpu_offload_layers_input_element ? context_length_tokens_input_element.value : '8192', 10) || 8192
    };

    try {
        const configuration_save_response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user_configuration_payload)
        });

        if (configuration_save_response.ok) {
            save_status_indicator_element.style.display = 'inline';
            setTimeout(() => {
                save_status_indicator_element.style.display = 'none';
            }, 2000);
            updateDiagnosticsDisplay();
        } else {
            alert('Failed to save configuration to server.');
        }
    } catch (configuration_save_error_exception) {
        console.error('Error saving configuration:', configuration_save_error_exception);
        alert('Error communicating with server while saving configuration.');
    }
});

// WHAT: Dispatches a hot-swap load command to llama-server via proxy endpoint.
// WHY: Enables users to load newly chosen model weights into VRAM without command-line restarts.
if (load_model_button_element) {
    load_model_button_element.addEventListener('click', async () => {
        const selected_vision_model_identifier = vision_model_select_element.value;
        if (!selected_vision_model_identifier) {
            alert('Please select a Vision model from the dropdown first.');
            return;
        }

        const resolved_gpu_layers_specification = gpu_offload_layers_input_element ? gpu_offload_layers_input_element.value : 'max';
        const resolved_context_length_tokens = parseInt(context_length_tokens_input_element ? context_length_tokens_input_element.value : '8192', 10) || 8192;

        load_model_button_element.disabled = true;
        load_model_button_element.textContent = '⏳ Loading Model...';
        model_load_status_message_element.textContent = 'Initiating model load into VRAM...';
        model_load_status_message_element.style.color = 'var(--accent)';

        try {
            const model_load_http_response = await fetch('/api/proxy/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_identifier: selected_vision_model_identifier,
                    config: {
                        gpu_offload: resolved_gpu_layers_specification,
                        context_length: resolved_context_length_tokens
                    }
                })
            });

            const parsed_load_response_data = await model_load_http_response.json();

            if (model_load_http_response.ok) {
                model_load_status_message_element.textContent = (
                    parsed_load_response_data.message
                        ? `ℹ️ ${parsed_load_response_data.message}`
                        : '✅ Model Loaded Successfully!'
                );
                model_load_status_message_element.style.color = '#4ade80';
                updateDiagnosticsDisplay();
            } else {
                model_load_status_message_element.textContent = '❌ Load Failed: ' + (parsed_load_response_data.error || 'Check local AI server logs.');
                model_load_status_message_element.style.color = '#ef4444';
            }
        } catch (model_load_network_error_exception) {
            console.error('Model load network error:', model_load_network_error_exception);
            model_load_status_message_element.textContent = '❌ Connection Error to local server.';
            model_load_status_message_element.style.color = '#ef4444';
        } finally {
            load_model_button_element.disabled = false;
            load_model_button_element.textContent = '🚀 Load into GPU';
            setTimeout(() => {
                if (model_load_status_message_element.textContent && model_load_status_message_element.textContent.includes('Success')) {
                    model_load_status_message_element.textContent = '';
                }
            }, 5000);
        }
    });
}

// ============================================================================
// MODEL AND CONFIGURATION LOADERS
// ============================================================================

// WHAT: Queries available models from the local AI server and populates selection dropdowns.
// WHY: Keeps model lists synchronized with what llama-server or LM Studio currently exposes.
async function refreshAvailableModelsList() {
    try {
        const models_fetch_response = await fetch('/api/proxy/models');
        if (!models_fetch_response.ok) {
            throw new Error('Failed to fetch models list from local AI server.');
        }

        const parsed_models_payload = await models_fetch_response.json();
        const available_models_collection = parsed_models_payload.data || [];

        // Save current selections to restore them after rebuilding options
        const previous_vision_selection_value = vision_model_select_element.value;
        const previous_embedding_selection_value = embedding_model_select_element.value;

        // Clear existing options while retaining the primary "Auto" fallback option
        while (vision_model_select_element.options.length > 1) {
            vision_model_select_element.remove(1);
        }
        while (embedding_model_select_element.options.length > 1) {
            embedding_model_select_element.remove(1);
        }

        available_models_collection.forEach(single_model_record => {
            const vision_option_element = document.createElement('option');
            vision_option_element.value = single_model_record.id;
            vision_option_element.textContent = single_model_record.id;
            vision_model_select_element.appendChild(vision_option_element);

            const embedding_option_element = document.createElement('option');
            embedding_option_element.value = single_model_record.id;
            embedding_option_element.textContent = single_model_record.id;
            embedding_model_select_element.appendChild(embedding_option_element);
        });

        // Restore prior selections if they still exist in the updated manifest
        vision_model_select_element.value = previous_vision_selection_value;
        embedding_model_select_element.value = previous_embedding_selection_value;

        updateDiagnosticsDisplay(available_models_collection);

    } catch (models_refresh_error_exception) {
        console.error('Models refresh error:', models_refresh_error_exception);
        diagnostics_output_pre_element.textContent = (
            'Error loading models from llama-server: ' + models_refresh_error_exception.message +
            '\nEnsure llama-server is running on port 8081 (start_llama_server.bat).'
        );
    }
}

// WHAT: Reads persisted configuration preferences from the server and binds them to UI inputs.
// WHY: Ensures the interface accurately reflects saved user preferences on load.
async function loadPersistedSystemConfiguration() {
    try {
        const configuration_fetch_response = await fetch('/api/config');
        if (configuration_fetch_response.ok) {
            const persisted_configuration_data = await configuration_fetch_response.json();

            if (persisted_configuration_data.visionModel) {
                const does_model_exist_in_dropdown = Array.from(vision_model_select_element.options).some(
                    single_option_element => single_option_element.value === persisted_configuration_data.visionModel
                );

                if (!does_model_exist_in_dropdown && persisted_configuration_data.visionModel) {
                    const fallback_configured_option = document.createElement('option');
                    fallback_configured_option.value = persisted_configuration_data.visionModel;
                    fallback_configured_option.textContent = `${persisted_configuration_data.visionModel} (Configured)`;
                    vision_model_select_element.appendChild(fallback_configured_option);
                }
                vision_model_select_element.value = persisted_configuration_data.visionModel;
            }

            if (persisted_configuration_data.embeddingModel) {
                embedding_model_select_element.value = persisted_configuration_data.embeddingModel;
            }
            if (persisted_configuration_data.gpuLayers && gpu_offload_layers_input_element) {
                gpu_offload_layers_input_element.value = persisted_configuration_data.gpuLayers;
            }
            if (persisted_configuration_data.contextLength && context_length_tokens_input_element) {
                context_length_tokens_input_element.value = persisted_configuration_data.contextLength;
            }
        }
    } catch (configuration_load_error_exception) {
        console.error('Error loading persisted configuration:', configuration_load_error_exception);
    }
}

// WHAT: Requests live server diagnostics detailing active model capabilities and endpoints.
// WHY: Provides instant technical transparency regarding backend server bindings.
function updateDiagnosticsDisplay() {
    fetch('/api/diagnostics')
        .then(diagnostics_http_response => diagnostics_http_response.text())
        .then(diagnostics_report_text => {
            diagnostics_output_pre_element.textContent = diagnostics_report_text;
        })
        .catch(diagnostics_fetch_error_exception => {
            diagnostics_output_pre_element.textContent = 'Failed to load server diagnostics.';
        });
}

// ============================================================================
// DATA MAPPING & EVOC PIPELINE CONTROLLER
// ============================================================================

const run_evoc_analysis_button_element = document.getElementById('runEvocBtn');
const evoc_log_container_element = document.getElementById('evocLogContainer');
const evoc_log_output_element = document.getElementById('evocLogOutput');
const evoc_status_message_element = document.getElementById('evocStatusText');

// WHAT: Streams execution of the Python EVoC + UMAP dimensionality reduction script.
// WHY: Generates 2D cluster coordinates from high-dimensional embeddings for the Scope Map visualizer.
run_evoc_analysis_button_element.addEventListener('click', async () => {
    run_evoc_analysis_button_element.disabled = true;
    run_evoc_analysis_button_element.textContent = '⏳ Processing Data...';
    evoc_log_container_element.style.display = 'block';
    evoc_log_output_element.innerHTML = '<i>Initializing EVoC analysis pipeline...</i><br>';
    evoc_status_message_element.textContent = 'Starting Python EVoC + UMAP analysis...';

    try {
        const evoc_execution_response = await fetch('/api/maintenance/run-evoc', { method: 'POST' });
        const stream_reader_instance = evoc_execution_response.body.getReader();
        const stream_text_decoder = new TextDecoder();

        while (true) {
            const { done: is_stream_complete, value: stream_byte_chunk } = await stream_reader_instance.read();
            if (is_stream_complete) {
                break;
            }

            const decoded_chunk_string = stream_text_decoder.decode(stream_byte_chunk, { stream: true });
            const formatted_log_markup = decoded_chunk_string
                .replace(/\n/g, '<br>')
                .replace(/\[\*\]/g, '<span style="color: #0ff">[*]</span>');

            evoc_log_output_element.innerHTML += formatted_log_markup;
            evoc_log_container_element.scrollTop = evoc_log_container_element.scrollHeight;
        }

        evoc_status_message_element.textContent = 'Analysis complete! Check the Scope Data Map.';
        run_evoc_analysis_button_element.innerHTML = '✅ Analysis Finished';
        setTimeout(() => {
            run_evoc_analysis_button_element.disabled = false;
            run_evoc_analysis_button_element.textContent = '🚀 Run Map Analysis (EVoC + UMAP)';
        }, 5000);

    } catch (pipeline_execution_error_exception) {
        console.error('EVoC pipeline error:', pipeline_execution_error_exception);
        evoc_log_output_element.innerHTML += `<br><span style="color: #f00">Error: ${pipeline_execution_error_exception.message}</span>`;
        evoc_status_message_element.textContent = 'Pipeline failed. Check output console for details.';
        run_evoc_analysis_button_element.disabled = false;
        run_evoc_analysis_button_element.textContent = '🚀 Retry Map Analysis';
    }
});

// ============================================================================
// LAYA DECISION ENGINE INTEGRATION CONTROLLERS
// ============================================================================

const refresh_laya_status_button_element = document.getElementById('refreshLayaBtn');
const batch_classify_facets_button_element = document.getElementById('batchClassifyFacetsBtn');
const laya_status_dot_element = document.getElementById('layaStatusDot');
const laya_status_title_element = document.getElementById('layaStatusTitle');
const laya_status_subtitle_element = document.getElementById('layaStatusSubtitle');
const laya_log_container_element = document.getElementById('layaLogContainer');
const laya_log_output_element = document.getElementById('layaLogOutput');

// WHAT: Queries the backend to determine if the local Laya microservice is reachable on port 8765.
// WHY: Gives users immediate visual feedback regarding service availability and GPU device information.
async function checkLayaMicroserviceStatus() {
    if (!laya_status_dot_element || !laya_status_title_element) {
        return;
    }

    laya_status_title_element.textContent = 'Checking Laya server...';
    try {
        const laya_status_http_response = await fetch('/api/laya/status');
        if (!laya_status_http_response.ok) {
            throw new Error(`Server returned HTTP ${laya_status_http_response.status}`);
        }

        const laya_status_payload = await laya_status_http_response.json();
        const is_service_online = (laya_status_payload.status === 'online');

        if (is_service_online) {
            laya_status_dot_element.style.background = '#4ade80';
            laya_status_title_element.textContent = `Online (${laya_status_payload.device || 'CUDA'})`;
            laya_status_subtitle_element.textContent = (
                `Endpoint: ${laya_status_payload.endpoint} • ` +
                `${laya_status_payload.cluster_themes_count} Themes • ` +
                `${laya_status_payload.classified_facets_count} Facets Tagged`
            );
            if (batch_classify_facets_button_element) {
                batch_classify_facets_button_element.disabled = false;
            }
        } else {
            laya_status_dot_element.style.background = '#ef4444';
            laya_status_title_element.textContent = 'Offline (Port 8765 unreachable)';
            laya_status_subtitle_element.textContent = 'Launch start_laya_server.bat to start Laya Decision Engine';
        }
    } catch (laya_status_check_error) {
        laya_status_dot_element.style.background = '#ef4444';
        laya_status_title_element.textContent = 'Offline (Server unreachable)';
        laya_status_subtitle_element.textContent = 'Run start_laya_server.bat in project root';
    }
}

if (refresh_laya_status_button_element) {
    refresh_laya_status_button_element.addEventListener('click', checkLayaMicroserviceStatus);
}

// WHAT: Streams batch facet classification for unclassified image records using Laya.
// WHY: Classifies medium, mood, and framing across library images in rapid forward passes.
if (batch_classify_facets_button_element) {
    batch_classify_facets_button_element.addEventListener('click', async () => {
        batch_classify_facets_button_element.disabled = true;
        batch_classify_facets_button_element.textContent = '⏳ Classifying Facets...';
        laya_log_container_element.style.display = 'block';
        laya_log_output_element.innerHTML = '<i>Connecting to Laya Decision Engine on port 8765...</i><br>';

        try {
            const batch_classification_response = await fetch('/api/facets/batch-classify', { method: 'POST' });
            if (!batch_classification_response.ok) {
                const error_payload = await batch_classification_response.json();
                throw new Error(error_payload.error || 'Batch facet classification failed');
            }

            const stream_reader_instance = batch_classification_response.body.getReader();
            const text_stream_decoder = new TextDecoder();

            while (true) {
                const { done: is_stream_complete, value: stream_byte_chunk } = await stream_reader_instance.read();
                if (is_stream_complete) {
                    break;
                }

                const decoded_chunk_text = text_stream_decoder.decode(stream_byte_chunk, { stream: true });
                const formatted_log_text = decoded_chunk_text.replace(/\n/g, '<br>');
                laya_log_output_element.innerHTML += formatted_log_text;
                laya_log_container_element.scrollTop = laya_log_container_element.scrollHeight;
            }

            batch_classify_facets_button_element.innerHTML = '✅ Facets Tagged';
            checkLayaMicroserviceStatus();
            setTimeout(() => {
                batch_classify_facets_button_element.disabled = false;
                batch_classify_facets_button_element.textContent = '⚡ Generate Multi-Facet Tags (Laya)';
            }, 4000);
        } catch (batch_classification_error) {
            console.error('Batch classification error:', batch_classification_error);
            laya_log_output_element.innerHTML += `<br><span style="color: #ef4444;">Error: ${batch_classification_error.message}</span>`;
            batch_classify_facets_button_element.disabled = false;
            batch_classify_facets_button_element.textContent = '⚡ Retry Facet Tagging';
        }
    });
}
