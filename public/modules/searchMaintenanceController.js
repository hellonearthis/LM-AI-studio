/**
 * Search Embedding Audit, Maintenance & Model Indicator Controller
 *
 * Isolated controller module extracted from public/search.js.
 */

import { showAlertModal, showConfirmModal } from './uiModals.js';

// WHAT: Creates the maintenance and model status controller for the Search workspace.
// WHY: Keeps public/search.js focused on hybrid search execution and masonry grid rendering.
export function createSearchMaintenanceController({ apiBaseUrl, refreshData }) {
    const generateEmbeddingsBtn = document.getElementById('generateEmbeddingsBtn');
    const genProgress = document.getElementById('genProgress');
    const embeddingsStatusEl = document.getElementById('embeddingsStatus');

    // EMBEDDINGS GENERATION & ORPHAN VECTOR AUDITOR
    // ============================================================================

    if (generateEmbeddingsBtn) {
        generateEmbeddingsBtn.addEventListener('click', async () => {
            showConfirmModal(
                'This will generate embeddings for all images using llama-server. This may take a while. Ensure llama-server is running with an embedding model loaded. Continue?',
                async () => {
                    generateEmbeddingsBtn.disabled = true;
                    generateEmbeddingsBtn.textContent = 'Generating...';
                    if (genProgress) {
                        genProgress.style.display = 'block';
                        genProgress.textContent = 'Starting...';
                    }

                    try {
                        const http_response = await fetch(`${apiBaseUrl}/maintenance/generate-embeddings`, { method: 'POST' });
                        const stream_reader = http_response.body.getReader();
                        const text_decoder = new TextDecoder();

                        while (true) {
                            const { done, value: chunk_bytes } = await stream_reader.read();
                            if (done) break;
                            const decoded_chunk = text_decoder.decode(chunk_bytes);
                            if (genProgress) {
                                genProgress.textContent = (genProgress.textContent + decoded_chunk).slice(-200);
                            }
                        }

                        showAlertModal('Generation Complete!', 'Embeddings');
                        refreshData();
                        fetchEmbeddingsStatus();
                    } catch (generation_error) {
                        console.error('Generation Error:', generation_error);
                        showAlertModal('Error generating embeddings: ' + generation_error.message, 'Generation Error');
                    } finally {
                        generateEmbeddingsBtn.disabled = false;
                        generateEmbeddingsBtn.textContent = 'Generate Data';
                        if (genProgress) setTimeout(() => { genProgress.style.display = 'none'; }, 5000);
                    }
                },
                'Continue',
                'var(--accent)'
            );
        });
    }

    /**
     * WHAT: Queries `/api/embeddings/audit` (or `/api/embeddings/prune-orphans`) and displays a detailed modal report.
     * WHY:  Gives users an explicit, on-demand way to inspect exact orphaned and missing vector counts across
     *       both `search-embeddings.json` (768-d text) and `ovis-embeddings.json` (2048-d visual) against `images.db`.
     *
     * @param {boolean} [prune_immediately=false] - Whether to prune orphaned vectors during this call.
     */
    async function checkOrPruneOrphanedEmbeddings(prune_immediately = false) {
        try {
            const endpoint_path = prune_immediately ? '/api/embeddings/prune-orphans' : '/api/embeddings/audit';
            const request_method = prune_immediately ? 'POST' : 'GET';
            const http_response = await fetch(`${apiBaseUrl}${endpoint_path}`, { method: request_method });
            if (!http_response.ok) {
                throw new Error('Failed to communicate with embedding audit endpoint');
            }
            const audit_payload = await http_response.json();
            const search_stats = audit_payload.search_embeddings || {};
            const ovis_stats = audit_payload.ovis_embeddings || {};
            const freed_megabytes = ((audit_payload.total_bytes_freed || 0) / (1024 * 1024)).toFixed(2);

            const report_lines = [
                `Active Images in Database: ${(audit_payload.database_image_count || 0).toLocaleString()}`,
                ``,
                `[Search Embeddings — 768-dim Text]`,
                `• Stored Vectors: ${(search_stats.count || 0).toLocaleString()} (${((search_stats.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB)`,
                `• Valid DB Matches: ${(search_stats.validCount || 0).toLocaleString()}`,
                `• Missing Embeddings: ${(search_stats.missingCount || 0).toLocaleString()}`,
                `• Orphaned Vectors: ${(search_stats.orphanedCount || 0).toLocaleString()}${search_stats.prunedCount ? ` (Pruned ${search_stats.prunedCount.toLocaleString()})` : ''}`,
                ``,
                `[Ovis Embeddings — 2048-dim Visual]`,
                `• Stored Vectors: ${(ovis_stats.count || 0).toLocaleString()} (${((ovis_stats.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB)`,
                `• Valid DB Matches: ${(ovis_stats.validCount || 0).toLocaleString()}`,
                `• Missing Embeddings: ${(ovis_stats.missingCount || 0).toLocaleString()}`,
                `• Orphaned Vectors: ${(ovis_stats.orphanedCount || 0).toLocaleString()}${ovis_stats.prunedCount ? ` (Pruned ${ovis_stats.prunedCount.toLocaleString()})` : ''}`
            ];

            if (prune_immediately && audit_payload.total_pruned_count > 0) {
                report_lines.push(
                    ``,
                    `Cleaned ${audit_payload.total_pruned_count.toLocaleString()} total orphaned vector(s) (${freed_megabytes} MB freed).`
                );
                refreshData();
            } else if (audit_payload.total_remaining_orphaned === 0) {
                report_lines.push(``, `0 orphaned embedding vectors detected.`);
            }

            await fetchEmbeddingsStatus();
            showAlertModal(
                report_lines.join('\n'),
                prune_immediately ? 'Orphaned Embeddings Pruned' : 'Embedding Vectors Integrity Audit'
            );
        } catch (audit_error) {
            console.error('[EMBEDDINGS-AUDIT] Error:', audit_error);
            showAlertModal('Embedding audit failed: ' + audit_error.message, 'Audit Error');
        }
    }

    window.checkOrPruneOrphanedEmbeddings = checkOrPruneOrphanedEmbeddings;

    /**
     * WHAT: Fetches `/api/embeddings-status` and renders vector count, size, orphan badge, and audit controls.
     * WHY:  Surfaces orphaned vector status immediately in the search page header bar.
     */
    async function fetchEmbeddingsStatus() {
        if (!embeddingsStatusEl) return;
        try {
            const http_response = await fetch(`${apiBaseUrl}/api/embeddings-status`);
            if (!http_response.ok) throw new Error('Failed to fetch status');
            const status_payload = await http_response.json();

            if (status_payload.exists && status_payload.count > 0) {
                const modified_date = new Date(status_payload.lastModified);
                const formatted_date_string = modified_date.toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const size_megabytes = (status_payload.sizeBytes / (1024 * 1024)).toFixed(1);
                const total_orphaned_vectors = (status_payload.orphanedCount || 0) + (status_payload.ovisOrphanedCount || 0);
                const orphan_badge_html = total_orphaned_vectors > 0
                    ? `<span style="color: #f59e0b; font-weight: 600;" title="Search orphans: ${status_payload.orphanedCount || 0}, Ovis orphans: ${status_payload.ovisOrphanedCount || 0}">⚠️ ${total_orphaned_vectors.toLocaleString()} orphaned</span>
                       <button type="button" onclick="checkOrPruneOrphanedEmbeddings(true)" style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.68rem; cursor: pointer;">🧹 Prune Orphans</button>`
                    : `<span style="color: #10b981;" title="0 orphaned vectors in search-embeddings.json and ovis-embeddings.json">✓ 0 orphans</span>`;

                embeddingsStatusEl.innerHTML = `
                    <span style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;">
                        <span style="color: var(--accent);">●</span>
                        <span>${status_payload.count.toLocaleString()} embeddings · ${size_megabytes} MB · ${orphan_badge_html} · Updated ${formatted_date_string}</span>
                        <button type="button" onclick="checkOrPruneOrphanedEmbeddings(false)" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.68rem; cursor: pointer;" title="Audit search-embeddings.json and ovis-embeddings.json against images.db for orphaned or missing vectors">🔍 Check Orphans</button>
                    </span>
                `;
            } else {
                embeddingsStatusEl.innerHTML = `<span style="color: var(--text-secondary);">○</span> No embeddings generated yet. Click "Generate Data" to enable Hybrid & Semantic search.`;
            }
        } catch (_status_fetch_error) {
            embeddingsStatusEl.textContent = '';
        }
    }

    fetchEmbeddingsStatus();

    // ============================================================================


    /**
     * WHAT: Polls `/api/config` and `/api/proxy/models` to update the active llama-server status dot.
     * WHY:  Shows the user whether the vision/embedding server is active, on standby, or offline.
     */
    async function updateModelIndicator() {
        const model_name_label = document.getElementById('activeModelName');
        const model_status_dot = document.getElementById('modelStatusDot');
        if (!model_name_label || !model_status_dot) return;

        try {
            const config_http_response = await fetch('/api/config');
            if (!config_http_response.ok) return;
            const config_payload = await config_http_response.json();
            const configured_model_name = config_payload.visionModel || '';

            const status_http_response = await fetch('/api/proxy/models');
            if (!status_http_response.ok) {
                model_status_dot.style.background = '#ff4444';
                model_name_label.textContent = configured_model_name || 'llama-server Offline';
                model_name_label.title = 'llama-server is offline (Probe port 8080 failed)';
                return;
            }

            const models_payload = await status_http_response.json();
            const loaded_models_list = models_payload.data || [];
            const raw_models_list = models_payload.models || [];

            let active_model_identifier = configured_model_name;
            let is_model_loaded = false;

            if (configured_model_name) {
                is_model_loaded =
                    loaded_models_list.some(
                        (model_entry) =>
                            model_entry.id === configured_model_name ||
                            (model_entry.aliases && model_entry.aliases.includes(configured_model_name))
                    ) ||
                    raw_models_list.some(
                        (model_entry) =>
                            model_entry.name === configured_model_name ||
                            (model_entry.aliases && model_entry.aliases.includes(configured_model_name))
                    );
            } else if (loaded_models_list.length > 0 || raw_models_list.length > 0) {
                is_model_loaded = true;
                const primary_raw_model = raw_models_list[0];
                const primary_loaded_model = loaded_models_list[0];
                active_model_identifier =
                    primary_raw_model?.name ||
                    primary_raw_model?.aliases?.[0] ||
                    primary_loaded_model?.id ||
                    'Active Model';
            }

            model_name_label.textContent = active_model_identifier || 'Local AI Connected';
            model_name_label.title = `Active Model: ${active_model_identifier}`;

            if (is_model_loaded) {
                model_status_dot.style.background = '#00ff00';
                model_status_dot.title = `Model is active and ready: ${active_model_identifier}`;
            } else {
                model_status_dot.style.background = '#f59e0b';
                model_status_dot.title = 'Model on standby (will JIT load or needs selection)';
            }
        } catch (indicator_error) {
            console.warn('Failed to update model indicator:', indicator_error);
            model_status_dot.style.background = '#ff4444';
        }
    }

    return {
        checkOrPruneOrphanedEmbeddings,
        fetchEmbeddingsStatus,
        updateModelIndicator
    };
}
