import express from "express";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { spawn } from "child_process";
import { local_ai_client_instance } from "../services/localAiClient.js";
import { ovis_omni_client_instance } from "../services/ovisOmniClient.js";
import { deduplicateTags } from "../services/server/analysisHelpers.js";
import { auditEmbeddingStores } from "../services/server/embeddingAudit.js";
import {
    dice_and_save_image_record,
    validate_and_repair_diced_prompts
} from "../services/promptDicerDb.js";

// WHAT: Creates an Express router for database validation, diagnostics, embeddings, and tag maintenance.
// WHY: Separates long-running maintenance and diagnostic endpoints from core app startup.
export function createMaintenanceRouter({
    db,
    rootDirectoryPath,
    CONFIG_PATH,
    getConfig,
    generateSearchIndex,
    loadOvisEmbeddingsCached,
    saveOvisEmbeddingsAndRefreshCache = () => {}
}) {
    const router = express.Router();

    /**
     * Performs a deep integrity check of the database.
     * 1. Deduplicates tags and objects.
     * 2. Prunes records for missing files.
     * 3. Repairs corrupted metadata JSON.
     * 4. regenerate missing or valid thumbnails (including deep verification).
     * 5. Deduplicates entire image records based on file path.
     */
    // Global tracking for DB validation
    global.validationProgress = { status: 'Idle', progress: 0 };

    router.get('/validate-status', (req, res) => {
        res.json(global.validationProgress || { status: 'Idle', progress: 0 });
    });

    router.post('/validate-database', async (req, res) => {
        global.validationProgress = { status: 'Starting integrity check...', progress: 2 };

        console.log('[VALIDATE] Request received');
        const options = {
            removeMissing: true,
            repairMetadata: true,
            regenThumbnails: true,
            purgeThumbnails: false,
            validateDicedPrompts: true,
            pruneOrphanedEmbeddings: true,
            reanalyze: req.body.reanalyze || false,
            ...(req.body.options || {})
        };

        const results = {
            total: 0,
            missing: 0,
            fixedThumbnails: 0,
            reanalyzed: 0,
            metadataRepaired: 0,
            duplicatesRemoved: 0,
            purged: 0,
            dicedValid: 0,
            dicedMissingRepaired: 0,
            dicedStaleReDiced: 0,
            dicedDesyncedRepaired: 0,
            dicedOrphansCleaned: 0,
            orphanedEmbeddingsFound: 0,
            orphanedEmbeddingsPruned: 0,
            errors: []
        };

        try {
            // 0. Purge Old Thumbnails if requested
            if (options.purgeThumbnails) {
                console.log('[VALIDATE] Purging all thumbnails...');
                const thumbDir = path.join(rootDirectoryPath, 'public', 'thumbnails');
                if (fs.existsSync(thumbDir)) {
                    const files = fs.readdirSync(thumbDir);
                    for (const file of files) {
                        if (file.endsWith('.avif')) {
                            try { fs.unlinkSync(path.join(thumbDir, file)); results.purged++; } catch (e) { }
                        }
                    }
                }
            }

            // Hoist SQLite prepared statements outside loops for zero per-row prepare overhead
            const deleteDicedByImageStmt = db.prepare('DELETE FROM diced_prompts WHERE image_id = ?');
            const deleteImageByIdStmt = db.prepare('DELETE FROM images WHERE id = ?');
            const updateThumbTimestampStmt = db.prepare('UPDATE images SET updated_at = ? WHERE id = ?');
            const updateFilenameStmt = db.prepare('UPDATE images SET filename = ? WHERE id = ?');
            const updateDimensionsStmt = db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?');
            const updateSizeStmt = db.prepare('UPDATE images SET size = ? WHERE id = ?');

            // 0. De-duplicate (Prioritize entries with metadata/analysis)
            const allImages = db.prepare('SELECT * FROM images').all();
            const pathMap = new Map();

            // Transaction for safety
            const dedupeTransaction = db.transaction((images) => {
                for (const img of images) {
                    // Normalize path for Windows case-insensitivity logic
                    const normPath = (img.path || '').toLowerCase().trim();

                    if (pathMap.has(normPath)) {
                        const existing = pathMap.get(normPath);
                        let keepExisting = true;

                        // Scoring function: Higher is better
                        const getScore = (item) => {
                            let score = 0;
                            if (item.width && item.height) score += 100; // valid dimensions
                            if (item.analysis && item.analysis.length > 10) score += 50; // has analysis
                            if (!item.file_hash) score -= 10; // missing hash
                            return score;
                        };

                        const s1 = getScore(existing);
                        const s2 = getScore(img);

                        if (s2 > s1) {
                            keepExisting = false;
                        } else if (s2 === s1) {
                            // Tie-breaker: Keep most recently updated
                            if (new Date(img.updated_at || 0) > new Date(existing.updated_at || 0)) {
                                keepExisting = false;
                            }
                        }

                        if (keepExisting) {
                            deleteDicedByImageStmt.run(img.id);
                            deleteImageByIdStmt.run(img.id);
                            const duplicate_thumb_path = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${img.id}.avif`);
                            if (fs.existsSync(duplicate_thumb_path)) {
                                try { fs.unlinkSync(duplicate_thumb_path); } catch (_unlink_err) { }
                            }
                            results.duplicatesRemoved++;
                            console.log(`[VALIDATE] Removed duplicate (inferior): ${img.path}`);
                        } else {
                            deleteDicedByImageStmt.run(existing.id);
                            deleteImageByIdStmt.run(existing.id);
                            const duplicate_thumb_path = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${existing.id}.avif`);
                            if (fs.existsSync(duplicate_thumb_path)) {
                                try { fs.unlinkSync(duplicate_thumb_path); } catch (_unlink_err) { }
                            }
                            results.duplicatesRemoved++;
                            console.log(`[VALIDATE] Removed duplicate (inferior): ${existing.path}`);
                            pathMap.set(normPath, img); // Update map with the winner
                        }

                    } else {
                        pathMap.set(normPath, img);
                    }
                }
            });

            dedupeTransaction(allImages);

            global.validationProgress = { status: 'Preparing metadata check...', progress: 10 };

            // Refresh images list after dedupe
            const images = db.prepare(`SELECT * FROM images`).all();
            results.total = images.length;

            // Pre-verify thumbnail validity in bounded concurrent batches (16 at a time)
            // when thumbnail regeneration is enabled, avoiding serial `sharp().metadata()` I/O.
            const thumbValidityById = new Map();
            if (options.regenThumbnails !== false) {
                const VALIDATION_BATCH_SIZE = 16;
                for (let batchStart = 0; batchStart < images.length; batchStart += VALIDATION_BATCH_SIZE) {
                    const batchSlice = images.slice(batchStart, batchStart + VALIDATION_BATCH_SIZE);
                    await Promise.all(batchSlice.map(async (batchImg) => {
                        const thumbPath = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${batchImg.id}.avif`);
                        try {
                            const thumbStats = await fs.promises.stat(thumbPath);
                            if (thumbStats.size > 0) {
                                await sharp(thumbPath).metadata();
                                thumbValidityById.set(batchImg.id, true);
                                return;
                            }
                        } catch (_thumbErr) {
                            if (fs.existsSync(thumbPath)) {
                                console.warn(`[VALIDATE] Corrupted thumbnail detected for ID ${batchImg.id}, deleting.`);
                                try { await fs.promises.unlink(thumbPath); } catch (_unlinkErr) { }
                            }
                        }
                        thumbValidityById.set(batchImg.id, false);
                    }));
                }
            }

            let completed = 0;
            for (const img of images) {
                completed++;
                global.validationProgress = { 
                    status: `Scanning file ${completed} of ${images.length}`, 
                    progress: Math.floor(10 + (completed / Math.max(1, images.length)) * 85)
                };

                const filePath = img.path;

                // 1. Check if file exists on disk
                if (!fs.existsSync(filePath)) {
                    if (options.removeMissing) {
                        console.log(`[VALIDATE] File missing, removing from DB: ${filePath}`);
                        deleteDicedByImageStmt.run(img.id);
                        deleteImageByIdStmt.run(img.id);
                        results.missing++;

                        // Try to delete thumbnail too
                        const thumbPath = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${img.id}.avif`);
                        if (fs.existsSync(thumbPath)) {
                            try { fs.unlinkSync(thumbPath); } catch (e) { }
                        }
                        continue;
                    } else {
                        console.warn(`[VALIDATE] File missing but "Remove Missing" is disabled: ${filePath}`);
                    }
                }

                // 2. Check for missing thumbnail (already verified concurrently above)
                const thumbValid = thumbValidityById.get(img.id) === true;
                const thumbPath = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${img.id}.avif`);

                if (!thumbValid && options.regenThumbnails !== false) {
                    console.log(`[VALIDATE] Thumbnail missing/invalid, generating for ID ${img.id}`);
                    try {
                        await sharp(filePath)
                            .resize(100, 100, {
                                fit: 'contain',
                                background: { r: 0, g: 0, b: 0, alpha: 0 }
                            })
                            .avif({ quality: 50 })
                            .toFile(thumbPath);
                        results.fixedThumbnails++;
                        updateThumbTimestampStmt.run(new Date().toISOString(), img.id);
                    } catch (err) {
                        console.error(`[VALIDATE] Failed to regenerate thumbnail for ${filePath}:`, err.message);
                        results.errors.push(`Thumbnail error: ${img.filename}`);
                    }
                }

                // 3. Metadata & Repair (ONLY if requested)
                if (options.repairMetadata) {
                    // Check for filename mismatch (Corruption repair)
                    const correctFilename = (img.path || '').split(/[/\\]/).pop();
                    const isSuspicious = img.filename.trim().startsWith('{') || img.filename.includes('Lite Graph');

                    if ((correctFilename && img.filename !== correctFilename) || isSuspicious) {
                        console.log(`[VALIDATE] Fixing corrupted filename for ID ${img.id}`);
                        if (correctFilename) {
                            updateFilenameStmt.run(correctFilename, img.id);
                            results.metadataRepaired++;
                        }
                    }

                    // Check for missing metadata (dimensions)
                    if (!img.width || !img.height) {
                        let metaObj = {};
                        try { metaObj = JSON.parse(img.metadata || '{}'); } catch (e) { }
                        
                        const metaH = metaObj.ImageHeight || metaObj.ExifImageHeight || metaObj.PixelYDimension || metaObj.height;
                        const metaW = metaObj.ImageWidth || metaObj.ExifImageWidth || metaObj.PixelXDimension || metaObj.width;

                        if (metaW && metaH) {
                            updateDimensionsStmt.run(metaW, metaH, img.id);
                            results.metadataRepaired++;
                        } else {
                            try {
                                const metadata = await sharp(img.path).metadata();
                                if (metadata.width && metadata.height) {
                                    updateDimensionsStmt.run(metadata.width, metadata.height, img.id);
                                    results.metadataRepaired++;
                                }
                            } catch (err) { }
                        }
                    }

                    // Check for missing size
                    if (!img.size) {
                        try {
                            const stats = fs.statSync(img.path);
                            if (stats.size) {
                                updateSizeStmt.run(stats.size, img.id);
                                results.metadataRepaired++;
                            }
                        } catch (e) { }
                    }
                }

                // 4. Check for missing AI analysis data (ONLY if requested)
                if (options.reanalyze) {
                    let analysis = {};
                    try {
                        analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis || '{}') : (img.analysis || {});
                    } catch (e) { analysis = {}; }

                    const isMissingData = !analysis.summary || !analysis.tags || analysis.tags.length === 0 || !analysis.objects || analysis.objects.length === 0;

                    if (isMissingData) {
                        console.log(`[VALIDATE] AI data missing for ${img.filename}, re-analyzing...`);
                        console.log(`[VALIDATE] Missing fields: summary=${!!analysis.summary}, tags=${analysis.tags?.length || 0}, objects=${analysis.objects?.length || 0}`);

                        try {
                            // Standardize to JPEG for vision model compatibility
                            const buffer = fs.readFileSync(filePath);
                            const standardizedBuffer = await sharp(buffer)
                                .jpeg({ quality: 80 })
                                .toBuffer();
                            const imageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

                            // WHAT: Dynamically resolving the vision model for missing tag backfill.
                            // WHY: Probes llama-server or LM Studio to get the currently running vision model and endpoint.
                            const current_application_config = getConfig();
                            let active_analysis_model_identifier = current_application_config.visionModel || process.env.VISION_MODEL_ID;

                            if (!active_analysis_model_identifier) {
                                await local_ai_client_instance.discoverActiveModel({ require_multimodal_vision: true });
                                active_analysis_model_identifier = local_ai_client_instance.getActiveModelIdentifier() || "default";
                            }

                            const payload = {
                                model: active_analysis_model_identifier,
                                messages: [
                                    {
                                        role: "system",
                                        content: "You are an expert image analyst. Analyze the image and extract: 1. A detailed summary. 2. A list of objects. 3. A list of descriptive tags. 4. The scene type. Return JSON."
                                    },
                                    {
                                        role: "user",
                                        content: [
                                            { type: "text", text: "Analyze this image." },
                                            { type: "image_url", image_url: { url: imageData } }
                                        ]
                                    }
                                ],
                                max_tokens: 500,
                                response_format: {
                                    type: "json_schema",
                                    json_schema: {
                                        name: "image_analysis",
                                        strict: true,
                                        schema: {
                                            type: "object",
                                            properties: {
                                                summary: { type: "string" },
                                                objects: { type: "array", items: { type: "string" } },
                                                tags: { type: "array", items: { type: "string" } },
                                                scene_type: { type: "string" }
                                            },
                                            required: ["summary", "objects", "tags", "scene_type"],
                                            additionalProperties: false
                                        }
                                    }
                                }
                            };

                            const target_validation_endpoint_url = local_ai_client_instance.getChatCompletionsUrl();
                            console.log(`[VALIDATE] Sending request to ${target_validation_endpoint_url} using ${active_analysis_model_identifier} for ${img.filename}...`);
                            const lmResponse = await fetch(target_validation_endpoint_url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });

                            if (lmResponse.ok) {
                                const lmData = await lmResponse.json();
                                let analysisContent = lmData.choices[0].message.content;
                                // Sanitize markdown fences
                                analysisContent = analysisContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
                                const newAnalysis = JSON.parse(analysisContent);

                                // Update DB
                                db.prepare(`UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?`).run(
                                    JSON.stringify(newAnalysis),
                                    new Date().toISOString(),
                                    img.id
                                );
                                await dice_and_save_image_record(db, {
                                    ...img,
                                    analysis: JSON.stringify(newAnalysis)
                                }, { run_pass_d_influences: true, force_heuristic: true });
                                results.reanalyzed++;
                                console.log(`[VALIDATE] Successfully updated AI data for ${img.filename}`);
                            } else {
                                const errorText = await lmResponse.text();
                                console.warn(`[VALIDATE] LM Studio failed for ${img.filename}: ${lmResponse.status} ${lmResponse.statusText}`);
                                console.warn(`[VALIDATE] Error response: ${errorText}`);
                            }
                        } catch (err) {
                            console.error(`[VALIDATE] Failed to re-analyze ${img.filename}:`, err.message);
                            results.errors.push(`AI Analysis error: ${img.filename}`);
                        }
                    }
                }
            }

            // 5. Validate existing diced prompts (detect stale/updated descriptions, missing, or desynced rows)
            if (options.validateDicedPrompts !== false) {
                global.validationProgress = { status: 'Validating & syncing diced prompts...', progress: 92 };
                const dicer_validation_summary = await validate_and_repair_diced_prompts(db, {
                    force_heuristic: true,
                    on_progress: (current_index, total_rows) => {
                        if (total_rows > 0) {
                            const sub_pct = 90 + Math.floor((current_index / total_rows) * 6);
                            global.validationProgress = {
                                status: `Validating diced prompt ${current_index} / ${total_rows}`,
                                progress: sub_pct
                            };
                        }
                    }
                });
                results.dicedValid = dicer_validation_summary.valid_count;
                results.dicedMissingRepaired = dicer_validation_summary.missing_repaired_count;
                results.dicedStaleReDiced = dicer_validation_summary.stale_re_diced_count;
                results.dicedDesyncedRepaired = dicer_validation_summary.desynced_repaired_count;
                results.dicedOrphansCleaned = dicer_validation_summary.orphaned_cleaned_count;
            }

            // 6. Audit & optionally prune orphaned embedding vectors (search-embeddings.json & ovis-embeddings.json)
            if (options.pruneOrphanedEmbeddings !== false) {
                global.validationProgress = { status: 'Checking & pruning orphaned embedding vectors...', progress: 95 };
                const embedding_audit_summary = auditAndOptionallyPruneEmbeddingVectors({ prune_orphans: true });
                results.orphanedEmbeddingsFound = embedding_audit_summary.total_orphaned_before_prune;
                results.orphanedEmbeddingsPruned = embedding_audit_summary.total_pruned_count;
            }

            global.validationProgress = { status: 'Saving search indexes...', progress: 97 };
            
            if (
                results.missing > 0
                || results.fixedThumbnails > 0
                || results.reanalyzed > 0
                || results.dicedMissingRepaired > 0
                || results.dicedStaleReDiced > 0
                || results.dicedDesyncedRepaired > 0
            ) {
                generateSearchIndex();
            }

            global.validationProgress = { status: 'Complete', progress: 100 };
            res.json({ success: true, results });

        } catch (err) {
            console.error('[VALIDATE] Critical Error:', err);
            global.validationProgress = { status: 'Error', progress: 0 };
            res.status(500).json({ error: 'Validation failed', details: err.message });
        }
    });

    // Regenerate specific thumbnail
    router.post('/regenerate-thumbnail', async (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'Image ID required' });

        try {
            const img = db.prepare(`SELECT * FROM images WHERE id = ?`).get(id);
            if (!img) return res.status(404).json({ error: 'Image not found' });

            const filePath = img.path;
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'Source file no longer exists' });
            }

            const thumbPath = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${id}.avif`);

            console.log(`[THUMB] Manual regeneration for ID ${id}: ${filePath}`);

            const buffer = fs.readFileSync(filePath);
            await sharp(buffer)
                .resize(100, 100, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .avif({ quality: 50 })
                .toFile(thumbPath);

            db.prepare('UPDATE images SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
            
            // Return a raw timestamp so the UI can immediately append it to the image src
            res.json({ success: true, thumbPath: `thumbnails/id_${id}.avif`, newTimestamp: Date.now() });

        } catch (err) {
            console.error('[THUMB] Regeneration Error:', err);
            res.status(500).json({ error: 'Failed to regenerate thumbnail', details: err.message });
        }
    });


    // WHAT: System Diagnostics endpoint.
    // WHY: Returns comprehensive runtime diagnostics detailing active local AI server discovery,
    //      multimodal vision projector status, context window sizes, and configuration sources.
    router.get('/api/diagnostics', async (http_incoming_request, http_server_response) => {
        try {
            const current_application_config = getConfig();
            const discovered_model_summary = await local_ai_client_instance.discoverActiveModel({
                force_refresh: true
            });

            const is_ovis_service_online = await ovis_omni_client_instance.checkHealth();
            const ovis_status_description = is_ovis_service_online
                ? `ONLINE on ${ovis_omni_client_instance.active_endpoint_url} (${ovis_omni_client_instance.detected_hardware_device_name}, 2048-dim)`
                : 'OFFLINE (Run start_ovis_server.bat on port 8082)';

            let active_vision_source_description = 'Auto-detect (Dynamic Local AI Discovery)';
            let active_vision_model_identifier = 'Offline (Server unreachable)';
            let active_embedding_source_description = 'Auto-detect (Dynamic Local AI Discovery)';
            let active_embedding_model_identifier = 'Offline (Server unreachable)';

            // Evaluate Vision Model Configuration & Discovery
            if (current_application_config.visionModel) {
                active_vision_source_description = 'Settings (config.json)';
                active_vision_model_identifier = current_application_config.visionModel;
            } else if (process.env.VISION_MODEL_ID) {
                active_vision_source_description = 'Environment Variable (.env)';
                active_vision_model_identifier = process.env.VISION_MODEL_ID;
            } else if (discovered_model_summary) {
                active_vision_model_identifier = discovered_model_summary.model_identifier;
                if (discovered_model_summary.model_aliases.length > 0) {
                    active_vision_model_identifier += ` (Aliases: ${discovered_model_summary.model_aliases.join(', ')})`;
                }
            }

            // Evaluate Embedding Model Configuration & Discovery
            if (current_application_config.embeddingModel) {
                active_embedding_source_description = 'Settings (config.json)';
                active_embedding_model_identifier = current_application_config.embeddingModel;
            } else if (process.env.EMBEDDING_MODEL_ID) {
                active_embedding_source_description = 'Environment Variable (.env)';
                active_embedding_model_identifier = process.env.EMBEDDING_MODEL_ID;
            } else if (discovered_model_summary) {
                active_embedding_model_identifier = discovered_model_summary.model_identifier;
            }

            const server_status_description = discovered_model_summary
                ? `${discovered_model_summary.backend_type} on ${discovered_model_summary.endpoint_url}`
                : 'OFFLINE (Probe failed on ports 8081, 9931)';

            const vision_support_status_description = discovered_model_summary
                ? (discovered_model_summary.has_multimodal_vision ? 'Supported (Multimodal projector verified)' : 'Missing vision capability (--mmproj needed)')
                : 'Unknown (Server offline)';

            const diagnostic_report_text = `
    SYSTEM DIAGNOSTICS
    ------------------
    Local AI Server:   ${server_status_description}
    Multimodal Vision: ${vision_support_status_description}
    Context Window:    ${discovered_model_summary ? `${discovered_model_summary.context_window_size} tokens` : 'Unknown'}

    Vision Model:      ${active_vision_model_identifier}
    Vision Source:     ${active_vision_source_description}

    Embedding Model:   ${active_embedding_model_identifier}
    Embedding Source:  ${active_embedding_source_description}

    Ovis-Omni Engine:  ${ovis_status_description}

    Config Path:       ${CONFIG_PATH}
        `;

            return http_server_response.send(diagnostic_report_text.trim());
        } catch (diagnostic_error) {
            console.error('[Diagnostics] Error generating runtime diagnostics:', diagnostic_error);
            return http_server_response.status(500).send(`Diagnostics failed: ${diagnostic_error.message}`);
        }
    });

    // ============================================================================
    // MAINTENANCE & AI PIPELINE ENDPOINTS
    // ============================================================================

    /**
     * ENDPOINT: Get Embeddings Status
     * 
     * WHY: The Search UI needs to know when the embeddings were last generated
     * and how many images are covered so it can show the "Last updated" status line.
     */
    let search_embeddings_status_cache = {
        mtimeMs: -1,
        sizeBytes: -1,
        count: 0,
        keySet: new Set()
    };

    /**
     * WHAT: Audits `public/search-embeddings.json` (768-d text) and `public/ovis-embeddings.json` (2048-d visual)
     *       against active `images.db` records to detect and optionally prune orphaned embedding vectors.
     * WHY: When images are deleted from `images.db`, their vectors in `search-embeddings.json` or `ovis-embeddings.json`
     *      can become orphaned, wasting disk space and memory in the search worker. Caching the key set by `(mtimeMs, sizeBytes)`
     *      allows instant (<2 ms) orphan checks against SQLite without re-parsing 540+ MB of JSON on every check.
     *
     * @param {Object} [audit_options={}] - Options (`{ prune_orphans: boolean }`).
     * @returns {Object} Structured audit and pruning report.
     */
    function auditAndOptionallyPruneEmbeddingVectors(audit_options = {}) {
        return auditEmbeddingStores({
            db,
            baseDir: rootDirectoryPath,
            pruneOrphans: Boolean(audit_options.prune_orphans),
            getSearchCache: () => search_embeddings_status_cache,
            setSearchCache: (next_cache) => { search_embeddings_status_cache = next_cache; },
            loadOvisEmbeddingsCached,
            saveOvisEmbeddingsAndRefreshCache
        });
    }

    router.get('/api/embeddings-status', (req, res) => {
        try {
            const audit_summary = auditAndOptionallyPruneEmbeddingVectors({ prune_orphans: false });
            const search_info = audit_summary.search_embeddings;
            const ovis_info = audit_summary.ovis_embeddings;

            if (!search_info.exists) {
                return res.json({
                    exists: false,
                    dbImageCount: audit_summary.database_image_count,
                    ovisExists: ovis_info.exists,
                    ovisCount: ovis_info.count,
                    ovisOrphanedCount: ovis_info.orphanedCount,
                    ovisMissingCount: ovis_info.missingCount
                });
            }

            res.json({
                exists: true,
                lastModified: search_info.lastModified,
                sizeBytes: search_info.sizeBytes,
                count: search_info.count,
                validCount: search_info.validCount,
                orphanedCount: search_info.orphanedCount,
                missingCount: search_info.missingCount,
                sampleOrphanedIds: search_info.sampleOrphanedIds,
                dbImageCount: audit_summary.database_image_count,
                ovisExists: ovis_info.exists,
                ovisCount: ovis_info.count,
                ovisOrphanedCount: ovis_info.orphanedCount,
                ovisMissingCount: ovis_info.missingCount
            });
        } catch (err) {
            res.json({ exists: false, error: err.message });
        }
    });

    // WHAT: Audits `search-embeddings.json` and `ovis-embeddings.json` for orphaned vectors against `images.db`.
    // WHY: Allows the UI and diagnostic tools to check for orphaned or missing embeddings on demand.
    router.get('/api/embeddings/audit', (http_incoming_request, http_server_response) => {
        try {
            const audit_report = auditAndOptionallyPruneEmbeddingVectors({ prune_orphans: false });
            http_server_response.json(audit_report);
        } catch (audit_error) {
            http_server_response.status(500).json({ success: false, error: audit_error.message });
        }
    });

    // WHAT: Prunes orphaned embedding vectors from `search-embeddings.json` and `ovis-embeddings.json`.
    // WHY: Removes vectors belonging to deleted image IDs and refreshes in-memory caches immediately.
    router.post('/api/embeddings/prune-orphans', (http_incoming_request, http_server_response) => {
        try {
            const prune_report = auditAndOptionallyPruneEmbeddingVectors({ prune_orphans: true });
            http_server_response.json(prune_report);
        } catch (prune_error) {
            http_server_response.status(500).json({ success: false, error: prune_error.message });
        }
    });

    /**
     * ENDPOINT: Run EVoC + UMAP Pipeline
     * 
     * WHAT: This triggers an external Python script that performs semantic clustering.
     * WHY: It uses the embeddings we generated to find groups of similar images 
     * and calculates 2D coordinates for the "Data Map" visualization.
     */
    router.post('/api/maintenance/run-evoc', (req, res) => {
        console.log('[MAINTENANCE] Initiating Semantic Map Analysis (EVoC + UMAP)...');

        // This is a long-running process, so we use "Chunked" encoding to send 
        // progress updates back to the browser in real-time.
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Transfer-Encoding', 'chunked');

        const pythonScriptPath = path.join(rootDirectoryPath, 'scripts', 'evoc_pipeline.py');
        const sqliteDatabasePath = path.join(rootDirectoryPath, 'images.db');
        const searchEmbeddingsPath = path.join(rootDirectoryPath, 'public', 'search-embeddings.json');

        // WHAT: Resolves the project virtualenv Python binary before falling back to system `python`.
        // WHY: `evoc` and `umap-learn` are installed inside `venv`; spawning bare `python` fails if global PATH lacks them.
        const venv_windows_python_path = path.join(rootDirectoryPath, 'venv', 'Scripts', 'python.exe');
        const venv_posix_python_path = path.join(rootDirectoryPath, 'venv', 'bin', 'python');
        const python_executable_path = fs.existsSync(venv_windows_python_path)
            ? venv_windows_python_path
            : (fs.existsSync(venv_posix_python_path) ? venv_posix_python_path : 'python');

        // We use 'spawn' to run the Python environment as a child process.
        const pythonSubprocess = spawn(python_executable_path, [
            pythonScriptPath, 
            '--db', sqliteDatabasePath, 
            '--embeddings', searchEmbeddingsPath
        ]);

        req.on('close', () => {
            if (!pythonSubprocess.killed) {
                pythonSubprocess.kill();
            }
        });

        pythonSubprocess.on('error', (spawn_error) => {
            console.error('[PYTHON-SPAWN-ERR]', spawn_error);
            if (!res.writableEnded && !res.closed) {
                res.write(`\nPIPELINE_ERROR: Failed to start Python process (${spawn_error.message})\n`);
                res.end();
            }
        });

        // Pipe the Python output directly to the HTTP response
        pythonSubprocess.stdout.on('data', (chunk) => {
            if (!res.writableEnded && !res.closed) {
                res.write(chunk.toString());
            }
            process.stdout.write(`[PYTHON-LOG] ${chunk}`);
        });

        pythonSubprocess.stderr.on('data', (errorChunk) => {
            if (!res.writableEnded && !res.closed) {
                res.write(`PIPELINE_ERROR: ${errorChunk.toString()}`);
            }
            process.stderr.write(`[PYTHON-ERR] ${errorChunk}`);
        });

        pythonSubprocess.on('close', (exitCode) => {
            if (!res.writableEnded && !res.closed) {
                res.write(`\n[ANALYSIS COMPLETE - EXIT CODE ${exitCode}]\n`);
                res.end();
            }
        });
    });

    /**
     * ENDPOINT: Generate Search Embeddings
     * 
     * WHAT: Converts every image's AI analysis (descriptions/tags) into math vectors.
     * WHY: This is the fuel for "Semantic" and "Hybrid" search. It allows the 
     * app to understand that "a golden retriever" is similar to "a yellow dog".
     */
    router.post('/maintenance/generate-embeddings', async (req, res) => {
        console.log('[MAINTENANCE] Starting background embedding generation...');

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Transfer-Encoding', 'chunked');

        try {
            // Step 1: Find images that have already been analyzed by the vision model
            const analyzedImages = db.prepare(`
                SELECT id, filename, analysis 
                FROM images 
                WHERE analysis IS NOT NULL AND analysis != '{}'
            `).all();
            
            res.write(`Found ${analyzedImages.length} analyzed images to process.\n`);

            const SEARCH_EMBEDDINGS_FILE = path.join(rootDirectoryPath, 'public', 'search-embeddings.json');

            // Step 2: Load existing embeddings so we can do an "Incremental" update (don't waste API calls!)
            let existingEmbeddingsMap = {};
            if (fs.existsSync(SEARCH_EMBEDDINGS_FILE)) {
                try {
                    existingEmbeddingsMap = JSON.parse(fs.readFileSync(SEARCH_EMBEDDINGS_FILE, 'utf8'));
                    
                    // PRUNING STEP: Remove "ghost" entries for images that no longer exist in the database.
                    const currentImageIdsInDatabase = new Set(analyzedImages.map(img => String(img.id)));
                    const storedEmbeddingIds = Object.keys(existingEmbeddingsMap);
                    
                    let prunedCount = 0;
                    for (const id of storedEmbeddingIds) {
                        if (!currentImageIdsInDatabase.has(String(id))) {
                            delete existingEmbeddingsMap[id];
                            prunedCount++;
                        }
                    }

                    if (prunedCount > 0) {
                        res.write(`Pruned ${prunedCount} stale embedding entries for deleted images.\n`);
                        console.log(`[MAINTENANCE] Pruned ${prunedCount} ghost entries from search-embeddings.json`);
                    }

                    res.write(`Resume mode: Found ${Object.keys(existingEmbeddingsMap).length} valid embeddings. Skipping overhead.\n`);
                } catch (e) {
                    res.write('Existing embedding file was unreadable. Starting fresh.\n');
                }
            }

            // WHAT: Step 3: Resolving the target embedding model and endpoint dynamically.
            // WHY: Queries the active local server (llama-server) rather than hardcoded endpoints.
            const currentApplicationConfig = getConfig();
            let target_embedding_model_identifier = currentApplicationConfig.embeddingModel || process.env.EMBEDDING_MODEL_ID;

            if (!target_embedding_model_identifier) {
                try {
                    const discovered_server_summary = await local_ai_client_instance.discoverActiveModel();
                    if (discovered_server_summary) {
                        target_embedding_model_identifier = local_ai_client_instance.getActiveModelIdentifier();
                        res.write(`Auto-detected Model on ${discovered_server_summary.endpoint_url}: ${target_embedding_model_identifier}\n`);
                    } else {
                        target_embedding_model_identifier = 'text-embedding-nomic-embed-text-v1.5';
                        res.write(`Warning: Local AI server offline. Using fallback identifier: ${target_embedding_model_identifier}\n`);
                    }
                } catch (embedding_discovery_error) {
                    target_embedding_model_identifier = 'text-embedding-nomic-embed-text-v1.5';
                    res.write('Warning: Could not contact local AI server for model auto-detection. Using defaults.\n');
                }
            } else {
                res.write(`Using Configured Model: ${target_embedding_model_identifier}\n`);
            }

            let imagesSuccessfullyEmbedded = 0;
            let imagesSkipped = 0;
            let imagesWithErrors = 0;

            // Step 4: The Processing Loop
            for (const image of analyzedImages) {
                // Safety Check: Did the user close the browser tab?
                if (res.writableEnded || res.closed) {
                    console.log('[MAINTENANCE] Client disconnected. Stopping generation.');
                    break;
                }

                // Skip if we already have this image vectorized
                if (existingEmbeddingsMap[image.id]) {
                    imagesSkipped++;
                    if (imagesSkipped % 50 === 0) process.stdout.write('.'); 
                    continue;
                }

                // Parse the AI analysis JSON stored in the database
                let imageAnalysisData = {};
                try {
                    imageAnalysisData = typeof image.analysis === 'string' ? JSON.parse(image.analysis) : image.analysis;
                } catch (e) { continue; }

                // Construct the search text blob (The more data we include, the better the semantic matches)
                const textToEmbed = [
                    imageAnalysisData.summary ? `Description: ${imageAnalysisData.summary}` : '',
                    imageAnalysisData.scene_type ? `Scene: ${imageAnalysisData.scene_type}` : '',
                    (imageAnalysisData.objects && imageAnalysisData.objects.length > 0) ? `Objects: ${imageAnalysisData.objects.join(', ')}` : '',
                    (imageAnalysisData.tags && imageAnalysisData.tags.length > 0) ? `Tags: ${imageAnalysisData.tags.join(', ')}` : ''
                ].filter(part => part.length > 0).join('. ');

                if (!textToEmbed) continue;

                try {
                    // Call Local AI Server's Embeddings API
                    const target_embeddings_endpoint_url = local_ai_client_instance.getEmbeddingsUrl();
                    const lmStudioResponse = await fetch(target_embeddings_endpoint_url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ input: textToEmbed, model: target_embedding_model_identifier })
                    });

                    if (lmStudioResponse.ok) {
                        const embeddingResult = await lmStudioResponse.json();
                        if (embeddingResult.data && embeddingResult.data[0]?.embedding) {
                            existingEmbeddingsMap[image.id] = embeddingResult.data[0].embedding;
                            imagesSuccessfullyEmbedded++;
                            
                            // Periodic counter update instead of a character for every image
                            if (imagesSuccessfullyEmbedded % 10 === 0) {
                                res.write(`Progress: ${imagesSuccessfullyEmbedded} images embedded...\n`);
                            }
                        } else {
                            imagesWithErrors++;
                            res.write('! (Invalid embedding format)\n');
                        }
                    } else {
                        imagesWithErrors++;
                        const errorDetails = await lmStudioResponse.text();
                        res.write(`! (API Error: ${lmStudioResponse.status})\n`);
                        console.error(`[EMBED-API-ERR] ${image.id}: ${lmStudioResponse.status} - ${errorDetails}`);
                    }
                } catch (err) {
                    imagesWithErrors++;
                    res.write('X');
                    console.error(`[EMBED-FETCH-ERR] ${image.id}:`, err.message);
                }

                // INTERMEDIATE SAVE: We save every 20 images so that if the power 
                // goes out, we don't lose all our progress.
                if (imagesSuccessfullyEmbedded % 20 === 0 && imagesSuccessfullyEmbedded > 0) {
                    fs.writeFileSync(SEARCH_EMBEDDINGS_FILE, JSON.stringify(existingEmbeddingsMap));
                    console.log(`[MAINTENANCE] Checkpoint: Saved ${imagesSuccessfullyEmbedded} new entries.`);
                }
            }

            // Final Save
            fs.writeFileSync(SEARCH_EMBEDDINGS_FILE, JSON.stringify(existingEmbeddingsMap));
            res.write(`\n\nPROCESS COMPLETE.\n- Added: ${imagesSuccessfullyEmbedded}\n- Skipped: ${imagesSkipped}\n- Errors: ${imagesWithErrors}\n`);
            res.end();

        } catch (err) {
            console.error('[MAINTENANCE-CRITICAL] Global Embed Error:', err);
            res.write(`\nCRITICAL ERROR: ${err.message}\n`);
            res.end();
        }
    });

    router.post('/maintenance/deduplicate-tags', (req, res) => {
        console.log('[MAINTENANCE] Starting tag deduplication...');
        try {
            const images = db.prepare('SELECT id, analysis FROM images').all();
            let updatedCount = 0;

            const updateStmt = db.prepare('UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?');

            db.transaction(() => {
                const now = new Date().toISOString();

                for (const img of images) {
                    let analysis = {};
                    try {
                        analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis) : (img.analysis || {});
                    } catch (e) { continue; }

                    if (!Array.isArray(analysis.tags) && !Array.isArray(analysis.objects)) continue;

                    const originalTags = JSON.stringify(analysis.tags || []);
                    const originalObjects = JSON.stringify(analysis.objects || []);
                    deduplicateTags(analysis);
                    const newTags = JSON.stringify(analysis.tags || []);
                    const newObjects = JSON.stringify(analysis.objects || []);

                    if (originalTags !== newTags || originalObjects !== newObjects) {
                        updateStmt.run(JSON.stringify(analysis), now, img.id);
                        updatedCount++;
                    }
                }
            })();

            if (updatedCount > 0) {
                generateSearchIndex();
            }

            console.log(`[MAINTENANCE] Completed. Updated ${updatedCount} images.`);
            res.json({ success: true, updatedCount });

        } catch (err) {
            console.error('[MAINTENANCE] Error:', err);
            res.status(500).json({ error: 'Maintenance failed' });
        }
    });


    return router;
}
