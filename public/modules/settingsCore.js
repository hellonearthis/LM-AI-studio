// ============================================================================
// LUMINA STUDIO - SETTINGS PURE FUNCTIONAL CORE
// ============================================================================
// WHAT: Pure payload builders, status formatters, and safe log chunk renderers
//       for the Settings & Hardware Configuration page.
// WHY: Keeps `public/settings.js` as a thin Imperative Shell while allowing
//      deterministic, mock-free testing of configuration payloads and UI text.
// ============================================================================

import { escapeHtmlCharacters } from './cardCore.js';

// WHAT: Builds a sanitized configuration payload object for `/api/config`.
// WHY: Centralizes fallback defaults (`'max'` GPU layers, `8192` context length)
//      so both saving and loading use identical normalization rules.
export function buildUserConfigurationPayload(
    selected_vision_model_identifier,
    selected_embedding_model_identifier,
    raw_gpu_layers_value,
    raw_context_length_value
) {
    const parsed_context_length_number = parseInt(String(raw_context_length_value ?? '8192'), 10);
    return {
        visionModel: selected_vision_model_identifier || '',
        embeddingModel: selected_embedding_model_identifier || '',
        gpuLayers: raw_gpu_layers_value || 'max',
        contextLength: Number.isFinite(parsed_context_length_number) && parsed_context_length_number > 0
            ? parsed_context_length_number
            : 8192
    };
}

// WHAT: Builds the JSON request body for hot-swapping a vision model into VRAM.
// WHY: Keeps `/api/proxy/load` schema construction pure and deterministic.
export function buildModelLoadRequestPayload(
    selected_vision_model_identifier,
    raw_gpu_layers_value,
    raw_context_length_value
) {
    const parsed_context_length_number = parseInt(String(raw_context_length_value ?? '8192'), 10);
    return {
        model_identifier: selected_vision_model_identifier,
        config: {
            gpu_offload: raw_gpu_layers_value || 'max',
            context_length: Number.isFinite(parsed_context_length_number) && parsed_context_length_number > 0
                ? parsed_context_length_number
                : 8192
        }
    };
}

// WHAT: Computes the UI status message, color, and diagnostics flag after `/api/proxy/load`.
// WHY: Separates response interpretation from DOM mutation.
export function formatModelLoadStatusPresentation(is_http_response_ok, parsed_load_response_data) {
    if (is_http_response_ok) {
        const message_text = parsed_load_response_data && parsed_load_response_data.message
            ? `ℹ️ ${parsed_load_response_data.message}`
            : '✅ Model Loaded Successfully!';
        return {
            text: message_text,
            color: '#4ade80',
            shouldRefreshDiagnostics: true
        };
    }

    const error_reason_text = parsed_load_response_data && parsed_load_response_data.error
        ? parsed_load_response_data.error
        : 'Check local AI server logs.';
    return {
        text: `❌ Load Failed: ${error_reason_text}`,
        color: '#ef4444',
        shouldRefreshDiagnostics: false
    };
}

// WHAT: Maps a `/api/laya/status` JSON payload into badge colors and text labels.
// WHY: Eliminates branching inside the DOM shell and makes status rendering deterministic.
export function formatLayaStatusPresentation(laya_status_payload) {
    const is_service_online = Boolean(laya_status_payload && laya_status_payload.status === 'online');
    if (is_service_online) {
        return {
            dotColor: '#4ade80',
            titleText: `Online (${laya_status_payload.device || 'CUDA'})`,
            subtitleText: (
                `Endpoint: ${laya_status_payload.endpoint} • ` +
                `${laya_status_payload.cluster_themes_count} Themes • ` +
                `${laya_status_payload.classified_facets_count} Facets Tagged`
            ),
            enableBatchButton: true
        };
    }

    return {
        dotColor: '#ef4444',
        titleText: 'Offline (Port 8765 unreachable)',
        subtitleText: 'Launch start_laya_server.bat to start Laya Decision Engine',
        enableBatchButton: false
    };
}

// WHAT: Escapes a streamed log text chunk and converts newlines (and optional `[*]`) to safe HTML.
// WHY: Prevents XSS if Python/subprocess stdout contains `<` or `>` characters while preserving formatting.
export function formatStreamingLogChunkHtml(raw_stream_chunk_text, should_highlight_marker = false) {
    const escaped_chunk_text = escapeHtmlCharacters(raw_stream_chunk_text);
    const newline_formatted_html = escaped_chunk_text.replace(/\r?\n/g, '<br>');
    if (!should_highlight_marker) {
        return newline_formatted_html;
    }
    return newline_formatted_html.replace(/\[\*\]/g, '<span style="color: #0ff">[*]</span>');
}

