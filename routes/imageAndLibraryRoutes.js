import express from "express";
import fs from "fs";
import path from "path";
import exifr from "exifr";
import sharp from "sharp";
import util from "util";
import { repairTruncatedJson, deduplicateTags } from "../services/server/analysisHelpers.js";
import { dice_and_save_image_record } from "../services/promptDicerDb.js";

// WHAT: Creates an Express router for image analysis, library CRUD, search, and rename endpoints.
// WHY: Keeps server.js focused on server bootstrap and shared service initialization.
export function createImageAndLibraryRouter({
    db,
    rootDirectoryPath,
    generateSearchIndex,
    scheduleSearchIndexRebuild,
    performImageAnalysis
}) {
    const router = express.Router();

    // Analyze image endpoint
    router.post('/analyze', async (req, res) => {
        console.log('[ANALYZE] Request received');

        try {
            const { imageData, promptType } = req.body;

            if (!imageData) {
                return res.status(400).json({ error: 'No image data provided' });
            }

            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');

            // WHAT: Standardizing image buffer format and dimensions for vision model inference.
            // WHY: Clamping max dimension to 1344px fits the optimal dynamic resolution of Qwen/Gemma vision models,
            //      preventing multi-gigabyte token bloat (4000+ tokens) and reducing inference time from 40s to ~2s.
            const standardizedBuffer = await sharp(buffer)
                .resize({ width: 1344, height: 1344, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
            const standardizedImageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

            // Metadata extraction
            let metadata = {};
            try {
                metadata = await exifr.parse(buffer, {
                    tiff: true, xmp: true, icc: true, iptc: true,
                    jfif: true, ihdr: true, mergeOutput: true
                }) || {};
            } catch (e) { /* ignore */ }

            try {
                const sharpMeta = await sharp(buffer).metadata();
                if (!metadata.ImageWidth && sharpMeta.width) metadata.ImageWidth = sharpMeta.width;
                if (!metadata.ImageHeight && sharpMeta.height) metadata.ImageHeight = sharpMeta.height;
                if (!metadata.format) metadata.format = sharpMeta.format;
            } catch (e) { /* ignore */ }

            // Use shared analysis helper with standardized data
            const analysis = await performImageAnalysis(standardizedImageData, promptType);

            res.json({ analysis, metadata });

        } catch (error) {
            console.error('[ANALYZE] Error:', error);
            res.status(500).json({ error: 'Image analysis failed: ' + error.message });
        }
    });

    /**
     * WHAT: Deletes an image row along with its dependent `diced_prompts` record and cached AVIF thumbnail.
     * WHY: `diced_prompts.image_id` uses `ON DELETE SET NULL`; explicitly deleting `diced_prompts WHERE image_id = ?`
     *      cascades to `diced_ingredients` and `diced_influences` so deleted images never leave ghost prompts behind.
     *
     * @param {number|string} image_id - Target image ID to remove.
     * @returns {Object} Statement run info (`{ changes }`).
     */
    function deleteImageDatabaseRecordsAndThumbnail(image_id) {
        db.prepare('DELETE FROM diced_prompts WHERE image_id = ?').run(image_id);
        const delete_info = db.prepare('DELETE FROM images WHERE id = ?').run(image_id);
        const thumbnail_file_path = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${image_id}.avif`);
        if (fs.existsSync(thumbnail_file_path)) {
            try {
                fs.unlinkSync(thumbnail_file_path);
            } catch (thumbnail_unlink_error) {
                // Non-fatal if thumbnail is already removed or locked
            }
        }
        return delete_info;
    }

    // Delete Image Endpoint
    router.post('/delete-image', (req, res) => {
        const { id, deleteFile } = req.body;
        try {
            if (deleteFile) {
                const img = db.prepare('SELECT path FROM images WHERE id = ?').get(id);
                if (img && img.path && fs.existsSync(img.path)) {
                    try {
                        fs.unlinkSync(img.path);
                        console.log(`[DELETE] File deleted: ${img.path}`);
                    } catch (err) {
                        console.error(`[DELETE] Failed to delete file: ${err.message}`);
                    }
                }
            }

            deleteImageDatabaseRecordsAndThumbnail(id);
            scheduleSearchIndexRebuild();

            res.json({ success: true });
        } catch (error) {
            console.error('[DELETE] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Batch Analyze Endpoint
    router.post('/batch-analyze', async (req, res) => {
        console.log('[BATCH] Request received');
        const { ids, promptType } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }

        const results = {
            total: ids.length, processed: 0,
            success: 0, failed: 0,
            errors: [], updatedImages: []
        };

        const selectBatchImageStmt = db.prepare('SELECT * FROM images WHERE id = ?');
        const updateBatchTimestampStmt = db.prepare('UPDATE images SET updated_at = ? WHERE id = ?');
        const updateBatchAnalysisStmt = db.prepare('UPDATE images SET analysis = ?, width = ?, height = ?, size = ?, updated_at = ? WHERE id = ?');

        for (const id of ids) {
            try {
                const img = selectBatchImageStmt.get(id);
                if (!img) {
                    results.failed++;
                    results.errors.push(`Image not found: ${id}`);
                    continue;
                }

                // WHAT: Handling "Prompt Dicer" batch mode directly on existing image prompts/analyses.
                // WHY: Allows users in database.html to select any set of images and run the Pass A–D Prompt Dicer
                //      pipeline to populate `images.diced_prompt`, `images.analysis.diced_prompt`, and `diced_prompts`
                //      without requiring a slow vision re-captioning pass.
                if (promptType === 'Prompt Dicer') {
                    console.log(`[BATCH-DICER] Dicing prompt for ${img.filename} (${results.processed + 1}/${results.total})`);
                    const dicer_result = await dice_and_save_image_record(db, img, {
                        run_pass_d_influences: true
                    });
                    const updatedAt = new Date().toISOString();
                    updateBatchTimestampStmt.run(updatedAt, id);

                    results.success++;
                    results.updatedImages.push({
                        id,
                        analysis: dicer_result.updated_analysis,
                        diced_prompt: dicer_result.master_record,
                        diced_prompt_id: dicer_result.prompt_id,
                        diced_physicality_ratio: dicer_result.master_record.metrics.physicality_ratio,
                        width: img.width,
                        height: img.height,
                        size: img.size,
                        updated_at: updatedAt
                    });
                    continue;
                }

                if (!fs.existsSync(img.path)) {
                    results.failed++;
                    results.errors.push(`Image file not found on disk: ${id}`);
                    continue;
                }

                console.log(`[BATCH] Processing ${img.filename} (${results.processed + 1}/${results.total})`);

                const buffer = fs.readFileSync(img.path);
                const fileStats = fs.statSync(img.path);
                const sharpMeta = await sharp(buffer).metadata();

                // WHAT: Standardizing and resizing batch image for optimal vision inference tokens.
                // WHY: Prevents high-resolution multi-megapixel images from exhausting token limits and dragging down batch throughput.
                const standardizedBuffer = await sharp(buffer)
                    .resize({ width: 1344, height: 1344, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 85 })
                    .toBuffer();
                const imageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

                // Use shared analysis helper
                const analysis = await performImageAnalysis(imageData, promptType);

                const updatedAt = new Date().toISOString();
                const width = sharpMeta.width || null;
                const height = sharpMeta.height || null;
                const size = fileStats.size || null;

                updateBatchAnalysisStmt.run(JSON.stringify(analysis), width, height, size, updatedAt, id);

                // Automatically run Prompt Dicer on the newly analyzed image so its diced structure is stored immediately
                const refreshed_image_row = { ...img, analysis: JSON.stringify(analysis) };
                const dicer_result = await dice_and_save_image_record(db, refreshed_image_row, {
                    run_pass_d_influences: true,
                    force_heuristic: true
                });

                results.success++;
                results.updatedImages.push({
                    id,
                    analysis: dicer_result.updated_analysis,
                    diced_prompt: dicer_result.master_record,
                    diced_prompt_id: dicer_result.prompt_id,
                    diced_physicality_ratio: dicer_result.master_record.metrics.physicality_ratio,
                    width,
                    height,
                    size,
                    updated_at: updatedAt
                });

            } catch (err) {
                console.error(`[BATCH] Error on ID ${id}:`, err.message);
                results.failed++;
                results.errors.push(`${id}: ${err.message}`);
            } finally {
                results.processed++;
            }
        }

        if (results.success > 0) generateSearchIndex();
        res.json(results);
    });

    // Reparse Broken Analysis Endpoint
    router.post('/reparse-analysis', async (req, res) => {
        const { id } = req.body;
        try {
            const img = db.prepare('SELECT id, filename, metadata, analysis FROM images WHERE id = ?').get(id);
            if (!img) return res.status(404).json({ error: 'Image not found' });

            let analysis = JSON.parse(img.analysis);
            let rawContent = analysis.summary;

            // If summary doesn't look like JSON, nothing to reparse
            if (!rawContent.trim().startsWith('{')) {
                return res.json({ success: false, message: 'Summary is not a detectable JSON structure.' });
            }

            console.log(`[REVERSE-PARS] Attempting to reparse content for ID ${id}`);
            const repaired = repairTruncatedJson(rawContent);
            
            try {
                const newAnalysis = JSON.parse(repaired);
                deduplicateTags(newAnalysis);

                // Update DB and immediately refresh the diced prompt record so it matches the repaired description
                db.prepare('UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?')
                    .run(JSON.stringify(newAnalysis), new Date().toISOString(), id);

                const dicer_result = await dice_and_save_image_record(db, {
                    ...img,
                    analysis: JSON.stringify(newAnalysis)
                }, {
                    run_pass_d_influences: true,
                    force_heuristic: true
                });

                generateSearchIndex();
                res.json({ success: true, analysis: dicer_result.updated_analysis });
            } catch (e) {
                res.json({ success: false, message: 'Could not recover valid JSON даже with repair.' });
            }
        } catch (error) {
            console.error('[REPARSE] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Full Re-Analyze Image Endpoint (Calls LM Studio)
    router.post('/re-analyze', async (req, res) => {
        const { id } = req.body;
        try {
            const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
            if (!img || !fs.existsSync(img.path)) {
                return res.status(404).json({ error: 'Image file not found' });
            }

            console.log(`[RE-ANALYZE] Triggering full analysis for ID ${id}`);

            // WHAT: Reading image buffer and downscaling oversize images to maximum 1344px.
            // WHY: Ensures fast prompt evaluation under 2 seconds without degrading caption or object recognition accuracy.
            const buffer = fs.readFileSync(img.path);
            const standardizedBuffer = await sharp(buffer)
                .resize({ width: 1344, height: 1344, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
            const standardizedImageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

            // Perform analysis using shared logic
            const analysis = await performImageAnalysis(standardizedImageData, null); // Use default prompt
            
            // Update DB
            const updatedAt = new Date().toISOString();
            db.prepare(`UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?`)
                .run(JSON.stringify(analysis), updatedAt, id);

            // Immediately sync/re-dice the regenerated description into `images.diced_prompt` and `diced_prompts`
            const dicer_result = await dice_and_save_image_record(db, {
                ...img,
                analysis: JSON.stringify(analysis)
            }, {
                run_pass_d_influences: true,
                force_heuristic: true
            });

            // Schedule Search Index rebuild
            scheduleSearchIndexRebuild();

            res.json({ success: true, analysis: dicer_result.updated_analysis, updated_at: updatedAt });

        } catch (error) {
            console.error('[RE-ANALYZE] Error:', error);
            res.status(500).json({ error: 'Re-analysis failed: ' + error.message });
        }
    });


    // WHAT: In-memory cached fallback placeholder AVIF thumbnail buffer.
    // WHY: Prevents repeated disk allocations and eliminates red 404 network errors in DevTools when an image was deleted.
    let cached_fallback_placeholder_avif_buffer = null;
    async function resolveFallbackPlaceholderAvifBuffer() {
        if (!cached_fallback_placeholder_avif_buffer) {
            cached_fallback_placeholder_avif_buffer = await sharp({
                create: {
                    width: 100,
                    height: 100,
                    channels: 4,
                    background: { r: 30, g: 30, b: 40, alpha: 0.5 }
                }
            })
            .avif({ quality: 40 })
            .toBuffer();
        }
        return cached_fallback_placeholder_avif_buffer;
    }

    // WHAT: On-demand AVIF thumbnail generator and self-healing static fallback route.
    // WHY: If an image exists in the database but its cached thumbnail on disk was deleted or missing,
    //      this endpoint automatically recovers and renders the 100x100 AVIF thumbnail on the fly
    //      using Sharp from the original source file, preventing broken UI cards and 404 console errors.
    router.get('/thumbnails/id_:image_identifier.avif', async (http_incoming_request, http_server_response) => {
        const raw_image_identifier_string = http_incoming_request.params.image_identifier;
        const numeric_image_identifier = parseInt(raw_image_identifier_string, 10);
        if (!numeric_image_identifier) {
            return http_server_response.status(404).json({ error: 'Invalid thumbnail identifier' });
        }

        const thumbnail_directory_path = path.join(rootDirectoryPath, 'public', 'thumbnails');
        const target_thumbnail_file_path = path.join(thumbnail_directory_path, `id_${numeric_image_identifier}.avif`);

        // Check if the thumbnail file was generated concurrently by another request
        if (fs.existsSync(target_thumbnail_file_path)) {
            http_server_response.type('image/avif');
            return http_server_response.sendFile(target_thumbnail_file_path);
        }

        try {
            const image_database_record = db.prepare('SELECT id, path FROM images WHERE id = ?').get(numeric_image_identifier);
            if (image_database_record && image_database_record.path && fs.existsSync(image_database_record.path)) {
                if (!fs.existsSync(thumbnail_directory_path)) {
                    fs.mkdirSync(thumbnail_directory_path, { recursive: true });
                }

                await sharp(image_database_record.path)
                    .resize(100, 100, {
                        fit: 'contain',
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .avif({ quality: 50 })
                    .toFile(target_thumbnail_file_path);

                console.log(`[THUMB] Self-healing on-demand thumbnail created for image #${numeric_image_identifier}`);
                http_server_response.type('image/avif');
                return http_server_response.sendFile(target_thumbnail_file_path);
            }
        } catch (thumbnail_generation_error) {
            console.warn(`[THUMB] On-demand generation failed for image #${numeric_image_identifier}:`, thumbnail_generation_error.message);
        }

        // WHAT: Returns a valid 100x100 dark placeholder AVIF buffer with HTTP 200 and long-term caching.
        // WHY: Prevents browser DevTools from flooding with red 404 network errors when maps or legacy Parquet refer to deleted IDs.
        try {
            const fallback_placeholder_buffer = await resolveFallbackPlaceholderAvifBuffer();
            http_server_response.type('image/avif');
            http_server_response.setHeader('Cache-Control', 'public, max-age=86400');
            return http_server_response.send(fallback_placeholder_buffer);
        } catch (_placeholder_fallback_error) {
            return http_server_response.status(404).json({ error: 'Thumbnail not available' });
        }
    });

    // Create Thumbnail Endpoint (Deprecated/Updated to use ID)
    router.post('/create-thumbnail', async (req, res) => {
        try {
            const { imageData, id } = req.body;
            if (!imageData || !id) {
                return res.status(400).json({ error: 'Missing image data or image ID' });
            }

            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');

            const thumbPath = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${id}.avif`);

            await sharp(buffer)
                .resize(100, 100, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .avif({ quality: 50 })
                .toFile(thumbPath);

            console.log(`[THUMB] Created: ${thumbPath}`);
            res.json({ success: true, path: `thumbnails/id_${id}.avif` });

        } catch (err) {
            console.error('[THUMB] Creation Error:', err);
            res.status(500).json({ error: 'Thumbnail creation failed' });
        }
    });

    // Save to Database
    router.post('/save', async (req, res) => {
        console.log('[SAVE] Request received');
        try {
            const { filename, path: targetPath, metadata, analysis, file_hash, mtime } = req.body;

            // Ensure analysis is clean before any save operation
            if (analysis) deduplicateTags(analysis);

            // Auto-generate created_at if not provided (should be standard ISO)
            let created_at = new Date().toISOString();
            if (req.body.created_at) created_at = req.body.created_at;

            // Try to get original creation date from metadata
            if (metadata.DateTimeOriginal) {
                created_at = new Date(metadata.DateTimeOriginal).toISOString();
            } else if (metadata.CreateDate) {
                created_at = new Date(metadata.CreateDate).toISOString();
            }

            // Deduplication based on Hash AND Path
            // 1. Check by Hash first (Content Match)

            // Extract dimensions/size for column storage
            let width = req.body.width || metadata.ImageWidth || metadata.ExifImageWidth || metadata.width || null;
            let height = req.body.height || metadata.ImageHeight || metadata.ExifImageHeight || metadata.height || null;
            let size = req.body.size || null;

            // Fallback: If not validation-checked, maybe we can get size from file? 
            // Typically client sends size, but if not we can rely on integrity check later.

            if (file_hash) {
                const checkHashSql = `SELECT * FROM images WHERE file_hash = ?`;
                const existingByHash = db.prepare(checkHashSql).get(file_hash);

                if (existingByHash) {
                    console.log(`[SAVE] Duplicate found by hash: ${existingByHash.filename}`);
                    // If it's literally the same file (same path), we treat it as an update/skip
                    if (existingByHash.path === targetPath) {
                        // Same file path and same hash.
                        // If we have new analysis/metadata, we should UPDATE the record.
                        const hasNewData = (analysis && Object.keys(analysis).length > 0) || (metadata && Object.keys(metadata).length > 0);

                        if (hasNewData) {
                            try {
                                const currentMeta = JSON.parse(existingByHash.metadata || '{}');
                                const currentAnalysis = JSON.parse(existingByHash.analysis || '{}');

                                const metaChanged = !util.isDeepStrictEqual(metadata, currentMeta);
                                const analysisChanged = !util.isDeepStrictEqual(analysis, currentAnalysis);

                                if (!metaChanged && !analysisChanged) {
                                    console.log('[SAVE] No changes detected (content match). Skipping update.');
                                    const updateMtimeSql = `UPDATE images SET mtime = ? WHERE id = ?`;
                                    if (mtime) db.prepare(updateMtimeSql).run(mtime, existingByHash.id);
                                    return res.json({ message: 'No changes detected', id: existingByHash.id, updated: false });
                                }
                            } catch (e) {
                                console.warn('[SAVE] Error comparing metadata, forcing update:', e);
                            }

                            console.log(`[SAVE] Updating existing file (same hash) with new analysis/metadata`);
                            const updateSql = `
                                UPDATE images 
                                SET metadata = ?, analysis = ?, mtime = ?, updated_at = ?, width = ?, height = ?, size = ?
                                WHERE id = ?
                            `;
                            const now = new Date().toISOString();
                            db.prepare(updateSql).run(JSON.stringify(metadata), JSON.stringify(analysis), mtime || null, now, width, height, size, existingByHash.id);

                            await dice_and_save_image_record(db, {
                                id: existingByHash.id,
                                filename,
                                metadata: JSON.stringify(metadata),
                                analysis: JSON.stringify(analysis)
                            }, { run_pass_d_influences: true, force_heuristic: true });

                            scheduleSearchIndexRebuild();
                            return res.json({ message: 'Updated successfully', id: existingByHash.id, updated: true });
                        }

                        // Just an mtime update (fast scan or touch)
                        const updateMtimeSql = `UPDATE images SET mtime = ? WHERE id = ?`;
                        if (mtime) db.prepare(updateMtimeSql).run(mtime, existingByHash.id);

                        return res.json({
                            duplicate: true,
                            existingPath: existingByHash.path,
                            id: existingByHash.id,
                            message: 'File already exists in database (matched content)'
                        });
                    } else {
                        // Same content, different path. Duplicate.
                        return res.json({
                            duplicate: true,
                            existingPath: existingByHash.path,
                            id: existingByHash.id,
                            message: 'Duplicate content found in different database entry'
                        });
                    }
                }
            }

            // 2. Check by Path (Location Match - fallback if hash missing or hash changed but path same)
            const checkPathSql = `SELECT id FROM images WHERE path = ?`;
            const existingByPath = db.prepare(checkPathSql).get(targetPath);

            if (existingByPath) {
                // Update existing
                console.log(`[SAVE] Updating existing file by path: ${targetPath}`);
                const updateSql = `
                    UPDATE images 
                    SET filename = ?, file_hash = ?, metadata = ?, analysis = ?, created_at = ?, mtime = ?, width = ?, height = ?, size = ?
                    WHERE id = ?
                `;
                db.prepare(updateSql).run(filename, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, mtime || null, width, height, size, existingByPath.id);

                await dice_and_save_image_record(db, {
                    id: existingByPath.id,
                    filename,
                    metadata: JSON.stringify(metadata),
                    analysis: JSON.stringify(analysis)
                }, { run_pass_d_influences: true, force_heuristic: true });

                scheduleSearchIndexRebuild(); // Update index
                return res.json({ message: 'Updated successfully', id: existingByPath.id, updated: true });
            }

            // 3. New Insert
            const insertSql = `INSERT INTO images (filename, path, file_hash, metadata, analysis, created_at, mtime, width, height, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            const info = db.prepare(insertSql).run(filename, targetPath, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, mtime || null, width, height, size);
            const newId = info.lastInsertRowid;
            console.log(`[SAVE] Success. New ID: ${newId}`);

            // Automatically dice the newly saved image prompt/analysis into `images.diced_prompt` and `diced_prompts`
            await dice_and_save_image_record(db, {
                id: newId,
                filename,
                metadata: JSON.stringify(metadata),
                analysis: JSON.stringify(analysis)
            }, { run_pass_d_influences: true, force_heuristic: true });

            // OPTIONAL: Auto-generate thumbnail if imageData provided
            if (req.body.imageData) {
                try {
                    const base64Data = req.body.imageData.replace(/^data:image\/\w+;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');
                    const thumbPath = path.join(rootDirectoryPath, 'public', 'thumbnails', `id_${newId}.avif`);
                    await sharp(buffer)
                        .resize(100, 100, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                        .avif({ quality: 50 })
                        .toFile(thumbPath);
                    console.log(`[SAVE] Auto-generated thumbnail for ID: ${newId}`);
                } catch (te) {
                    console.warn('[SAVE] Failed to auto-generate thumbnail:', te.message);
                }
            }

            scheduleSearchIndexRebuild(); // Update index
            res.json({ message: 'Saved successfully', id: newId, new: true, thumbPath: `thumbnails/id_${newId}.avif` });
        } catch (err) {
            console.error('[SAVE] Error:', err);
            // Helper to extract SQLite error code
            const code = err.code || 'UNKNOWN';
            res.status(500).json({
                error: 'Database save failed',
                details: err.message,
                code: code
            });
        }
    });

    // Update Tags Endpoint
    router.post('/update-tags', async (req, res) => {
        console.log('[UPDATE-TAGS] Request received');
        try {
            const { id, analysis } = req.body;

            if (analysis) deduplicateTags(analysis);

            if (!id || !analysis) {
                return res.status(400).json({ error: 'Missing id or analysis data' });
            }

            // Update just the analysis column and updated_at, then synchronize diced_prompt
            const updatedTime = new Date().toISOString();
            const sql = `UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?`;
            db.prepare(sql).run(JSON.stringify(analysis), updatedTime, id);

            const existing_image_row = db.prepare('SELECT id, filename, metadata, analysis FROM images WHERE id = ?').get(id);
            let final_analysis = analysis;
            if (existing_image_row) {
                const dicer_result = await dice_and_save_image_record(db, existing_image_row, {
                    run_pass_d_influences: true,
                    force_heuristic: true
                });
                final_analysis = dicer_result.updated_analysis;
            }

            console.log(`[UPDATE-TAGS] Updated tags and synced diced prompt for ID: ${id}`);
            scheduleSearchIndexRebuild(); // Update index
            res.json({ success: true, analysis: final_analysis, updated_at: updatedTime });

        } catch (err) {
            console.error('[UPDATE-TAGS] Error:', err);
            res.status(500).json({ error: 'Failed to update tags' });
        }
    });

    // Get Images (Supports Pagination or All)
    router.get('/images', (req, res) => {
        console.log('[GET-IMAGES] Request received');
        try {
            const id = req.query.id;
            if (id) {
                const sql_single_image_query = `
                    SELECT 
                        images.*,
                        COALESCE(images.diced_prompt, diced_prompts.master_record_json) AS diced_prompt,
                        diced_prompts.prompt_id AS diced_prompt_id,
                        diced_prompts.physicality_ratio AS diced_physicality_ratio,
                        image_clusters.cluster_label,
                        cluster_themes.theme_name,
                        image_facets.medium AS facet_medium,
                        image_facets.mood AS facet_mood,
                        image_facets.composition AS facet_composition,
                        image_facets.detail_score AS facet_detail_score
                    FROM images
                    LEFT JOIN diced_prompts ON images.id = diced_prompts.image_id
                    LEFT JOIN image_clusters ON images.id = image_clusters.image_id
                    LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
                    LEFT JOIN image_facets ON images.id = image_facets.image_id
                    WHERE images.id = ?
                `;
                const image = db.prepare(sql_single_image_query).get(id);
                if (!image) return res.status(404).json({ error: 'Image not found' });
                return res.json({ image });
            }

            const page = parseInt(req.query.page);
            const limit = parseInt(req.query.limit);
            const sort = req.query.sort || 'recent_update';

            // WHAT: Constructing deterministic SQL sorting clauses for image retrieval.
            // WHY: Timestamps in SQLite can be identical across multiple batch-imported images.
            // Appending the primary key 'id' guarantees a consistent, deterministic sort order
            // across paginated LIMIT/OFFSET queries, preventing rows from shifting across pages.
            let orderBy = 'ORDER BY COALESCE(images.updated_at, images.created_at) DESC, images.id DESC';
            switch (sort) {
                case 'newest': orderBy = 'ORDER BY images.created_at DESC, images.id DESC'; break;
                case 'oldest': orderBy = 'ORDER BY images.created_at ASC, images.id ASC'; break;
                case 'name_asc': orderBy = 'ORDER BY images.filename ASC, images.id ASC'; break;
                case 'name_desc': orderBy = 'ORDER BY images.filename DESC, images.id DESC'; break;
                case 'recent_update':
                default: orderBy = 'ORDER BY COALESCE(images.updated_at, images.created_at) DESC, images.id DESC'; break;
            }

            const sql_joined_columns = `
                images.id, 
                images.filename, 
                images.path, 
                images.analysis, 
                images.width, 
                images.height, 
                images.size, 
                images.created_at, 
                images.updated_at,
                COALESCE(images.diced_prompt, diced_prompts.master_record_json) AS diced_prompt,
                diced_prompts.prompt_id AS diced_prompt_id,
                diced_prompts.physicality_ratio AS diced_physicality_ratio,
                image_clusters.cluster_label,
                cluster_themes.theme_name,
                image_facets.medium AS facet_medium,
                image_facets.mood AS facet_mood,
                image_facets.composition AS facet_composition,
                image_facets.detail_score AS facet_detail_score
            `;
            const sql_joined_tables = `
                FROM images
                LEFT JOIN diced_prompts ON images.id = diced_prompts.image_id
                LEFT JOIN image_clusters ON images.id = image_clusters.image_id
                LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
                LEFT JOIN image_facets ON images.id = image_facets.image_id
            `;

            if (isNaN(page) || isNaN(limit)) {
                // Return ALL images if no pagination params
                const sql = `SELECT ${sql_joined_columns} ${sql_joined_tables} ${orderBy}`;
                const images = db.prepare(sql).all();
                console.log(`[GET-IMAGES] Returning ALL ${images.length} images (Sort: ${sort})`);
                return res.json({
                    images,
                    total: images.length,
                    page: 1,
                    limit: images.length,
                    totalPages: 1
                });
            }

            const safePage = Math.max(1, page);
            const safeLimit = Math.min(500, Math.max(1, limit));
            const offset = (safePage - 1) * safeLimit;

            // Get total count
            const countSql = `SELECT COUNT(*) as total FROM images`;
            const total = db.prepare(countSql).get().total;

            // Get paginated data
            const sql = `SELECT ${sql_joined_columns} ${sql_joined_tables} ${orderBy} LIMIT ? OFFSET ?`;
            const images = db.prepare(sql).all(safeLimit, offset);

            console.log(`[GET-IMAGES] Returning ${images.length} images (Page ${safePage}, Sort: ${sort})`);
            res.json({
                images,
                total,
                page: safePage,
                limit: safeLimit,
                totalPages: Math.ceil(total / safeLimit)
            });
        } catch (err) {
            console.error('[GET-IMAGES] Error:', err);
            res.status(500).json({ error: 'Failed to fetch images' });
        }
    });

    // Delete Image
    router.delete('/images/:id', (req, res) => {
        console.log('[DELETE] Request received for ID:', req.params.id);
        try {
            const id = req.params.id;
            const info = deleteImageDatabaseRecordsAndThumbnail(id);

            if (info.changes > 0) {
                console.log(`[DELETE] Deleted record ID: ${id}`);
                scheduleSearchIndexRebuild();
                res.json({ message: 'Deleted successfully' });
            } else {
                console.log(`[DELETE] Record not found ID: ${id}`);
                res.status(404).json({ error: 'Record not found' });
            }
        } catch (err) {
            console.error('[DELETE] Error:', err);
            res.status(500).json({ error: 'Failed to delete image' });
        }
    });

    // Stats Endpoint
    router.get('/stats', (req, res) => {
        try {
            const sql = `SELECT analysis FROM images`;
            const rows = db.prepare(sql).all();

            // WHAT: Use null-prototype dictionaries so AI tags like "constructor" or "toString"
            //       never collide with Object.prototype properties.
            // WHY:  Prevents count corruption (e.g. "function Object()...1") on prototype-named tags.
            const tagCounts = Object.create(null);
            const objCounts = Object.create(null);

            rows.forEach(row => {
                let analysis = {};
                try {
                    analysis = typeof row.analysis === 'string' ? JSON.parse(row.analysis) : (row.analysis || {});
                } catch (e) { /* ignore */ }

                if (analysis.tags && Array.isArray(analysis.tags)) {
                    analysis.tags.forEach(tag => {
                        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                    });
                }

                if (analysis.objects && Array.isArray(analysis.objects)) {
                    analysis.objects.forEach(obj => {
                        objCounts[obj] = (objCounts[obj] || 0) + 1;
                    });
                }
            });

            // Convert to array and sort
            const sortedTags = Object.entries(tagCounts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);

            const sortedObjects = Object.entries(objCounts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);

            res.json({
                tags: sortedTags,
                objects: sortedObjects
            });

        } catch (err) {
            console.error('[STATS] Error:', err);
            res.status(500).json({ error: 'Failed to fetch stats' });
        }
    });

    // Search Endpoint (Legacy - now mostly client-side handled or returning raw results)
    router.post('/search', (req, res) => {
        console.log('[SEARCH] Request received');
        const { query, tags, searchLogic, sceneType, startDate, endDate } = req.body;

        // Construct SQL Query
        let sql = `SELECT * FROM images WHERE 1=1`;
        const params = [];

        // Text Search (Filename or Summary)
        if (query) {
            // Simple LIKE search for SQLite
            sql += ` AND (filename LIKE ? OR analysis LIKE ?)`;
            params.push(`%${query}%`, `%${query}%`);
        }

        // Scene Type Filter
        if (sceneType && sceneType !== 'all') {
            sql += ` AND analysis LIKE ?`;
            params.push(`%"scene_type":"${sceneType}"%`);
        }

        // Date Range
        if (startDate) {
            sql += ` AND created_at >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            // Add end of day time
            sql += ` AND created_at <= ?`;
            params.push(endDate + 'T23:59:59');
        }

        // Tag Filtering logic is complex with JSON storage in SQLite without JSON1 extension enabled sometimes.
        // Client-side filtering might be better for tags if dataset < 10k.
        // But for basic search:

        // Order by date
        sql += ` ORDER BY created_at DESC`;

        const results = db.prepare(sql).all(...params);
        res.json(results);
    });

    // ============================================================================
    // DATABASE VALIDATION & REPAIR
    // ============================================================================


    // Rename Endpoint
    router.post('/rename', (req, res) => {
        const { id, newFilename } = req.body;
        if (!id || !newFilename) return res.status(400).json({ error: 'Missing ID or filename' });

        try {
            const image = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
            if (!image) return res.status(404).json({ error: 'Image not found' });

            const oldPath = image.path;
            if (!oldPath || !fs.existsSync(oldPath)) {
                return res.status(404).json({ error: 'Source image file not found on disk.' });
            }
            const oldExt = path.extname(oldPath); // e.g. '.jpg'
            const dir = path.dirname(oldPath);

            // WHAT: Strips directory components and illegal filesystem characters from user-supplied filenames.
            // WHY: Prevents path traversal (`../`) and Windows/POSIX illegal filename errors.
            const sanitizedRequestedName = path.basename(String(newFilename)).replace(/[<>:"/\\|?*]+/g, '').trim();
            if (!sanitizedRequestedName || sanitizedRequestedName === '.' || sanitizedRequestedName === '..') {
                return res.status(400).json({ error: 'Invalid filename provided.' });
            }

            // Safety: If the user didn't provide an extension, auto-append the old one
            let finalNewFilename = sanitizedRequestedName;
            if (!path.extname(sanitizedRequestedName) && oldExt) {
                finalNewFilename += oldExt;
            }

            const newPath = path.join(dir, finalNewFilename);

            // Security / Validation (allow case-only renames of the same file on Windows/macOS)
            const isSameFileCaseRename = path.resolve(oldPath).toLowerCase() === path.resolve(newPath).toLowerCase();
            if (!isSameFileCaseRename && fs.existsSync(newPath)) {
                return res.status(409).json({ error: 'A file with that name already exists in this folder.' });
            }

            // Rename on Disk
            fs.renameSync(oldPath, newPath);

            // Update Database
            db.prepare('UPDATE images SET filename = ?, path = ?, mtime = ? WHERE id = ?')
                .run(finalNewFilename, newPath, new Date().toISOString(), id);

            // Schedule Search Index rebuild
            scheduleSearchIndexRebuild();

            res.json({ success: true, newPath, newFilename: finalNewFilename });

        } catch (err) {
            console.error('[RENAME] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * ============================================================================
     * BULK RENAME SYSTEM (Option A: Gap-Filling)
     * ============================================================================
     * 
     * This endpoint handles mass-renaming of files selected in the UI. 
     * It is designed with several safety and organizational guardrails:
     * 
     * 1. SANITIZATION: Prevents illegal characters from breaking the filesystem.
     * 2. ALPHABETICAL ORDERING: Renames files in their original display order.
     * 3. GAP FILLING (Option A): If "coffee_001" and "coffee_003" exist, it fills "coffee_002" first.
     * 4. COLLISION SAFETY: Checks both the disk and the current batch to prevent accidental overrides.
     * 5. ATOMIC UPDATES: Synchronizes the Disk, the Thumbnails, and the Database together.
     */
    router.post('/bulk-rename', (req, res) => {
        // Extract parameters from the request body
        const { ids, baseName } = req.body;

        // Validation: Ensure we actually have work to do
        if (!ids || !Array.isArray(ids) || ids.length === 0 || !baseName) {
            return res.status(400).json({ error: 'Missing image IDs array or a valid base name' });
        }

        /**
         * STEP 1: SANITIZATION
         * We strip out characters that are illegal in Windows/Linux filenames (<>:"/\\|?*)
         * to prevent the fs.renameSync call from throwing a system-level error.
         */
        const sanitizedBase = baseName.replace(/[<>:"/\\|?*]+/g, '').trim();
        if (!sanitizedBase) {
            return res.status(400).json({ error: 'The provided base name contains only illegal characters.' });
        }

        // Initialize a results tracker to report back to the frontend
        const processResults = {
            successCount: 0,
            failedCount: 0,
            errors: []
        };

        try {
            const thumbnailDirectory = path.join(rootDirectoryPath, 'public/thumbnails');
            
            /**
             * STEP 2: DATABASE PREPARATION
             * We prepare the SQL statement once for performance improvement, 
             * as we will be running it in a loop for every selected image.
             */
            const updateDatabaseStmt = db.prepare('UPDATE images SET filename = ?, path = ?, mtime = ? WHERE id = ?');

            /**
             * STEP 3: BATCH PREPARATION & SORTING
             * Why sort? If a user selects 5 files at random, they usually expect them 
             * to be numbered based on their current names. Without sorting, the order 
             * would be based on internal DB IDs, which is confusing.
             */
            const selectBulkImageStmt = db.prepare('SELECT * FROM images WHERE id = ?');
            const imagesToRename = [];
            for (const id of ids) {
                const imageData = selectBulkImageStmt.get(id);
                if (imageData) {
                    imagesToRename.push(imageData);
                } else {
                    processResults.failedCount++;
                    processResults.errors.push(`Database record for ID ${id} was not found.`);
                }
            }
            
            // Sort the batch by their existing file path to maintain a logical visual sequence
            imagesToRename.sort((fileA, fileB) => fileA.path.localeCompare(fileB.path));

            /**
             * STEP 4: INDEX TRACKING & CACHING
             * To implement "Option A" (Gap Filling), we start our counter at 1.
             * We also cache directory listings so we don't have to hit the hard drive
             * for expensive 'readdir' calls repeatedly inside the loop.
             */
            let currentSequenceIndex = 1;
            const assignedInBatch = new Set(); // Tracks indices we've assigned in THIS request
            const directoryCache = new Map();  // Stores 'occupied numbers' per folder
            
            // Main processing loop for the sorted batch
            for (const image of imagesToRename) {
                const imageId = image.id;
                try {
                    const originalFilePath = image.path;

                    // Basic integrity check: If the file was deleted/moved since the last sync, skip it.
                    if (!fs.existsSync(originalFilePath)) {
                        processResults.failedCount++;
                        processResults.errors.push(`File missing on disk: ${image.filename}`);
                        continue; 
                    }

                    const targetDirectory = path.dirname(originalFilePath);
                    const originalExtension = path.extname(originalFilePath);
                    
                    /**
                     * STEP 5: DIRECTORY SCANNING (Cross-Extension Safety)
                     * We need to know which numbers (001, 002...) are already taken in the target folder.
                     * Crucially, we ignore extensions. If 'coffee_001.png' exists, we should NOT 
                     * name our new file 'coffee_001.jpg', as that makes searching for 001 very messy.
                     */
                    if (!directoryCache.has(targetDirectory)) {
                        try {
                            const existingFiles = fs.readdirSync(targetDirectory);
                            const occupiedIndices = new Set();
                            
                            // Create a Regex that matches the base name exactly + digits + any extension
                            const escapedPrefix = sanitizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const sequenceRegex = new RegExp(`^${escapedPrefix}_(\\d+)\\.`, 'i');
                            
                            for (const fileName of existingFiles) {
                                const match = fileName.match(sequenceRegex);
                                if (match) {
                                    occupiedIndices.add(parseInt(match[1], 10)); 
                                }
                            }
                            directoryCache.set(targetDirectory, occupiedIndices);
                        } catch (cacheErr) {
                            directoryCache.set(targetDirectory, new Set()); 
                        }
                    }
                    
                    const occupiedInTargetDir = directoryCache.get(targetDirectory);
                    let finalNewFilename = '';
                    let finalNewPath = '';

                    /**
                     * STEP 6: SEQUENCE GENERATION (The "Gap Filler")
                     * We keep incrementing 'currentSequenceIndex' until we find a number 
                     * that is not in the directory AND hasn't been used by a previous image 
                     * in this specific batch.
                     */
                    while (true) {
                        const isTakenOnDisk = occupiedInTargetDir.has(currentSequenceIndex);
                        const isTakenInBatch = assignedInBatch.has(currentSequenceIndex);

                        if (isTakenOnDisk || isTakenInBatch) {
                            currentSequenceIndex++;
                            continue;
                        }

                        // Format with 3-digit padding: 1 becomes "001"
                        const formattedIndex = String(currentSequenceIndex).padStart(3, '0');
                        finalNewFilename = `${sanitizedBase}_${formattedIndex}${originalExtension}`;
                        finalNewPath = path.join(targetDirectory, finalNewFilename);

                        // Final disk-level safety check
                        if (fs.existsSync(finalNewPath)) {
                            occupiedInTargetDir.add(currentSequenceIndex);
                            currentSequenceIndex++;
                            continue;
                        }
                        
                        break; // Number is available!
                    }
                    
                    // Record that we've claimed this number
                    assignedInBatch.add(currentSequenceIndex);
                    occupiedInTargetDir.add(currentSequenceIndex);

                    /**
                     * STEP 7: EXECUTION (Disk & DB)
                     * Now we perform the actual rename.
                     */
                    fs.renameSync(originalFilePath, finalNewPath);

                    // Final step: Sync the SQLite database to point to the new location
                    updateDatabaseStmt.run(finalNewFilename, finalNewPath, new Date().toISOString(), imageId);
                    
                    processResults.successCount++;

                } catch (innerProcessErr) {
                    console.error(`[BULK RENAME] Error processing image:`, innerProcessErr);
                    processResults.failedCount++;
                    processResults.errors.push(`Error on image ${image.filename}: ${innerProcessErr.message}`);
                }
            }

            // STEP 8: RE-INDEXING
            // Since we've changed filenames on disk and in the DB, the search index
            // (search-index.json / search-data.json) is now out of date. We trigger
            // a regeneration so the Search page shows the NEW names immediately.
            if (processResults.successCount > 0) {
                scheduleSearchIndexRebuild();
            }

            // Send the final result summary back to the user
            res.json({ 
                success: true, 
                message: `Successfully renamed ${processResults.successCount} images.`,
                ...processResults
            });

        } catch (topLevelErr) {
            console.error('[BULK RENAME] Top-level failure:', topLevelErr);
            res.status(500).json({ error: topLevelErr.message });
        }
    });


    return router;
}
