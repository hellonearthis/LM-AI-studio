import 'dotenv/config';
import express from 'express';

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import exifr from 'exifr';
import sharp from 'sharp';
import Fuse from 'fuse.js';

import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';


// ... [Inside existing routes, add generateSearchIndex() calls]

// Start Server...
// app.listen below handles this.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Initialize LM Studio (No SDK needed, just URL)
const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/ls-data', express.static('ls-data'));

// ============================================================================
// DATABASE SETUP
// ============================================================================
const db = new Database('images.db');

// MTime Tolerance (in ms) to handle minor OS timestamp differences
const MTIME_TOLERANCE = 2000;

// Create table if it doesn't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        path TEXT UNIQUE,
        file_hash TEXT,
        metadata TEXT,
        analysis TEXT,
        width INTEGER,
        height INTEGER,
        size INTEGER,
        mtime INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT
    )
`);

// Migration: Add columns if they don't exist (for existing DBs)
try {
    const columns = db.pragma('table_info(images)');
    const hasWidth = columns.some(c => c.name === 'width');
    if (!hasWidth) {
        console.log('[DB] Migrating: Adding width, height, size columns...');
        db.exec('ALTER TABLE images ADD COLUMN width INTEGER');
        db.exec('ALTER TABLE images ADD COLUMN height INTEGER');
        db.exec('ALTER TABLE images ADD COLUMN size INTEGER');
    }

    // Check for mtime
    const hasMtime = columns.some(c => c.name === 'mtime');
    if (!hasMtime) {
        console.log('[DB] Migrating: Adding mtime column...');
        db.exec('ALTER TABLE images ADD COLUMN mtime INTEGER');
    }
} catch (err) {
    console.error('[DB] Migration error:', err);
}

// ============================================================================
// FAST SYNC ENDPOINTS
// ============================================================================

/**
 * Checks if a single file needs to be re-analyzed.
 * Compares file size and modification time (mtime) with the database record.
 * Uses a tolerance (MTIME_TOLERANCE) to allow for minor filesystem discrepancies.
 */
app.post('/check-fast', (req, res) => {
    try {
        const { path, size, mtime } = req.body;
        const row = db.prepare('SELECT id, size, mtime FROM images WHERE path = ?').get(path);

        if (!row) {
            return res.json({ exists: false });
        }

        // Exact match check with tolerance
        const timeDiff = Math.abs(row.mtime - mtime);

        // size must match exactly, but time can have tolerance
        if (row.size === size && timeDiff < MTIME_TOLERANCE) {
            return res.json({ exists: true, match: 'exact' });
        }

        // File exists but different size/time -> likely modified
        return res.json({ exists: true, match: 'partial' });

    } catch (err) {
        console.error('[CHECK-FAST] Error:', err);
        res.status(500).json({ error: 'Check failed' });
    }
});

/**
 * Bulk version of /check-fast.
 * Checks an array of files against the database in a single transaction.
 * Returns a map of results: 'exact', 'missing', or 'partial'.
 */
app.post('/check-fast-batch', (req, res) => {
    try {
        const { files } = req.body; // Array of { path, size, mtime }
        if (!files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Invalid input' });
        }

        const results = {};
        const stmt = db.prepare('SELECT size, mtime FROM images WHERE path = ?');

        const transaction = db.transaction((fileList) => {
            for (const file of fileList) {
                const row = stmt.get(file.path);
                if (!row) {
                    results[file.path] = 'missing';
                } else {
                    const timeDiff = Math.abs(row.mtime - file.mtime);
                    if (row.size === file.size && timeDiff < MTIME_TOLERANCE) {
                        results[file.path] = 'exact';
                    } else {
                        results[file.path] = 'partial'; // Exists but modified
                    }
                }
            }
        });

        transaction(files);
        res.json({ results });

    } catch (err) {
        console.error('[CHECK-FAST-BATCH] Error:', err);
        res.status(500).json({ error: 'Batch check failed' });
    }
});

// Auto-migration: Add updated_at column if it doesn't exist
try {
    db.prepare('SELECT updated_at FROM images LIMIT 1').get();
} catch (err) {
    if (err.message.includes('no such column')) {
        console.log('[DB] Adding missing column: updated_at');
        db.exec('ALTER TABLE images ADD COLUMN updated_at TEXT');
    }
}

console.log('[DB] Database initialized');

// ============================================================================
// SEARCH INDEX GENERATION
// ============================================================================
function generateSearchIndex() {
    console.log('[INDEX] Generating search index...');
    try {
        // Fetch all images for indexing (Must match /images sort order)
        const sql = `SELECT * FROM images ORDER BY COALESCE(updated_at, created_at) DESC`;
        const images = db.prepare(sql).all();

        // Pre-process data for indexing (parse JSON strings)
        const indexData = images.map(img => {
            let analysis = {};
            try {
                analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis) : (img.analysis || {});
            } catch (e) { /* ignore */ }

            return {
                ...img,
                analysis
            };
        });

        // Create Index
        // Keys must match client-side expected keys
        const index = Fuse.createIndex(
            [
                { name: 'filename', weight: 1 },
                { name: 'analysis.summary', weight: 1 },
                { name: 'analysis.objects', weight: 2 },
                { name: 'analysis.tags', weight: 2 }
            ],
            indexData
        );

        // Serialize and Save
        const outputPath = path.join(__dirname, 'public', 'search-index.json');
        fs.writeFileSync(outputPath, JSON.stringify(index.toJSON()));

        console.log(`[INDEX] Generated successfully (${images.length} items)`);
    } catch (err) {
        console.error('[INDEX] Generation failed:', err);
    }
}

// Initial index removed from here to prevent blocking startup
// generateSearchIndex();

// Analyze image endpoint
// Load Qwen Prompts
let qwenPrompts = {};
const PROMPTS_FILE = path.join(__dirname, 'qwen_vl3_prompts.json');

try {
    if (fs.existsSync(PROMPTS_FILE)) {
        console.log('[PROMPTS] Loading Qwen prompts...');
        const rawData = fs.readFileSync(PROMPTS_FILE, 'utf8');
        const json = JSON.parse(rawData);

        // Process qwenvl prompts
        if (json.qwenvl) {
            Object.entries(json.qwenvl).forEach(([key, value]) => {
                // User manually cleaned emojis. We just trim to be safe.
                // If there are still emojis we missed, we might want a safer regex like /[^\x00-\x7F]/g to remove non-ascii if that was the goal, 
                // but user specifically mentioned removing emojis.
                // Let's just trim for now to match exact keys like "Prompt Refine & Expand".
                const cleanKey = key.trim();
                qwenPrompts[cleanKey] = value;
            });
        }
        console.log('[PROMPTS] Loaded keys:', Object.keys(qwenPrompts));
    } else {
        console.warn('[PROMPTS] Warning: prompts file not found:', PROMPTS_FILE);
    }
} catch (err) {
    console.error('[PROMPTS] Error loading prompts:', err);
}

// Analyze image endpoint
app.post('/analyze', async (req, res) => {
    console.log('[ANALYZE] Request received');

    try {
        const { imageData, promptType } = req.body;

        if (!imageData) {
            return res.status(400).json({ error: 'No image data provided' });
        }

        // Convert base64 to buffer for EXIF (keep this)
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        console.log(`[ANALYZE] Buffer size: ${buffer.length} bytes`);

        // Parse EXIF data using exifr (more robust than exif-parser)
        let metadata = {};
        try {
            // Enable all metadata segments
            metadata = await exifr.parse(buffer, {
                tiff: true,
                xmp: true,
                icc: true,
                iptc: true,
                jfif: true,
                ihdr: true, // For PNG dimensions
                mergeOutput: true
            }) || {};
            console.log('[ANALYZE] EXIF extracted:', Object.keys(metadata).length, 'fields');
        } catch (exifError) {
            console.log('[ANALYZE] No EXIF data or error parsing:', exifError.message);
        }

        // FALLBACK: Use Sharp for basic metadata (Width, Height, Format) - Critical for GIFs/WebP
        try {
            const sharpMeta = await sharp(buffer).metadata();
            // Merge sharp metadata if missing in exifr
            if (!metadata.ImageWidth && sharpMeta.width) metadata.ImageWidth = sharpMeta.width;
            if (!metadata.ImageHeight && sharpMeta.height) metadata.ImageHeight = sharpMeta.height;
            if (!metadata.format) metadata.format = sharpMeta.format;
            console.log(`[ANALYZE] Sharp metadata merged: ${sharpMeta.width}x${sharpMeta.height} (${sharpMeta.format})`);
        } catch (err) {
            console.error('[ANALYZE] Sharp metadata extraction failed:', err);
        }

        // Special handling for ComfyUI metadata (prompt/workflow are JSON strings)
        if (metadata.prompt) {
            try {
                // Keep it as an object if possible, or string?
                // Actually the DB expects metadata to be logged.
                // The frontend display logic might need checking.
                // For now just pass it through.
                console.log('[ANALYZE] Found ComfyUI prompt data');
            } catch (e) {
                console.warn('[ANALYZE] Error parsing Comfy prompt');
            }
        }

        if (metadata.workflow) {
            console.log('[ANALYZE] Found ComfyUI workflow data');
        }

        // --- LM Studio Analysis ---
        // Standardize to JPEG for vision model compatibility (avoids errors with AVIF/WebP)
        const standardizedBuffer = await sharp(buffer)
            .jpeg({ quality: 80 })
            .toBuffer();
        const standardizedImageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

        // Select System Prompt
        let systemPrompt = "You are an expert image analyst. Analyze the image and extract: 1. A detailed summary. 2. A list of objects. 3. A list of descriptive tags. 4. The scene type. Return JSON.";

        // Use prompt from file if available
        const selectedKey = promptType || 'Detailed Description'; // Default changed per user request
        let basePrompt = qwenPrompts[selectedKey] || qwenPrompts['Detailed Description'] || Object.values(qwenPrompts)[0];

        if (basePrompt) {
            // Combined Strategy: Append metadata extraction instructions to ANY selected prompt
            // unless it's the "Detailed Analysis" which already has it.
            if (selectedKey !== 'Detailed Analysis') {
                systemPrompt = `${basePrompt}\n\nIMPORTANT: regardless of the above, ALSO extract: 1. A list of objects (visible items). 2. A list of descriptive tags (visual style, colors, mood). 3. The scene type. Format the response as valid JSON with keys: 'summary' (containing your main generated text), 'objects', 'tags', 'scene_type'.`;
            } else {
                systemPrompt = basePrompt;
            }
            console.log(`[ANALYZE] Using prompt: "${selectedKey}"`);
        } else {
            console.log(`[ANALYZE] Requested prompt "${promptType}" not found. Using default.`);
        }

        // Always use Full Schema
        const jsonSchema = {
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
        };

        const payload = {
            model: "qwen2.5-vl-7b-instruct",
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Analyze this image." },
                        { type: "image_url", image_url: { url: standardizedImageData } }
                    ]
                }
            ],
            max_tokens: 1000,
            response_format: {
                type: "json_schema",
                json_schema: jsonSchema
            }
        };

        const lmResponse = await fetch(LM_STUDIO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!lmResponse.ok) {
            throw new Error(`LM Studio API Error: ${lmResponse.statusText}`);
        }

        const lmData = await lmResponse.json();
        let analysisContent = lmData.choices[0].message.content;

        // Sanitize markdown fences
        analysisContent = analysisContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');

        // Robust Parsing: Find outermost braces
        const firstOpen = analysisContent.indexOf('{');
        const lastClose = analysisContent.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose !== -1) {
            analysisContent = analysisContent.substring(firstOpen, lastClose + 1);
        }

        let analysis;
        try {
            analysis = JSON.parse(analysisContent);
            deduplicateTags(analysis); // <--- Deduplicate
        } catch (parseError) {
            console.warn('[ANALYZE] JSON Parsing failed. Raw content:', analysisContent);
            // Fallback: Use raw content as summary
            analysis = {
                summary: analysisContent, // raw string
                objects: [],
                tags: [],
                scene_type: 'unknown'
            };
        }

        res.json({ analysis, metadata });

    } catch (error) {
        console.error('[ANALYZE] Error:', error);
        res.status(500).json({ error: 'Image analysis failed' });
    }
});

// Delete Image Endpoint
app.post('/delete-image', (req, res) => {
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
                    // Continue to delete from DB even if file delete fails (or maybe warn?)
                }
            }
        }

        db.prepare('DELETE FROM images WHERE id = ?').run(id);

        // Also delete from search index if exists (handled by regeneration usually, but good to be clean)
        // For now, just DB delete is sufficient.

        res.json({ success: true });
    } catch (error) {
        console.error('[DELETE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Batch Analyze Endpoint
app.post('/batch-analyze', async (req, res) => {
    console.log('[BATCH] Request received');
    const { ids, promptType } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided' });
    }

    const results = {
        total: ids.length,
        processed: 0,
        success: 0,
        failed: 0,
        errors: [],
        updatedImages: []
    };

    // We process sequentially to avoid overwhelming LM Studio
    for (const id of ids) {
        try {
            const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
            if (!img || !fs.existsSync(img.path)) {
                results.failed++;
                results.errors.push(`Image not found: ${id}`);
                continue;
            }

            console.log(`[BATCH] Processing ${img.filename} (${results.processed + 1}/${results.total})`);

            // Read and standarize image
            const buffer = fs.readFileSync(img.path);
            const fileStats = fs.statSync(img.path);
            const metadata = await sharp(buffer).metadata(); // Get correct dimensions

            const standardizedBuffer = await sharp(buffer)
                .jpeg({ quality: 80 })
                .toBuffer();
            const imageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

            // Reuse logic? Ideally refactor into a helper function, but for now duplicate the fetch logic for isolation.
            // Select System Prompt (Same Logic as /analyze)
            const selectedKey = promptType || 'Detailed Description'; // Default changed per user request
            let basePrompt = qwenPrompts[selectedKey] || qwenPrompts['Detailed Description'] || Object.values(qwenPrompts)[0];
            let systemPrompt = "You are an expert image analyst...";

            if (basePrompt) {
                if (selectedKey !== 'Detailed Analysis') {
                    systemPrompt = `${basePrompt}\n\nIMPORTANT: regardless of the above, ALSO extract: 1. A list of objects. 2. A list of descriptive tags. 3. The scene type. Format the response as valid JSON with keys: 'summary', 'objects', 'tags', 'scene_type'.`;
                } else {
                    systemPrompt = basePrompt;
                }
            }

            const payload = {
                model: "qwen2.5-vl-7b-instruct",
                messages: [
                    { role: "system", content: systemPrompt },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze this image." },
                            { type: "image_url", image_url: { url: imageData } }
                        ]
                    }
                ],
                max_tokens: 1800,
                temperature: 0.7,
                repetition_penalty: 1.1,
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

            const lmResponse = await fetch(LM_STUDIO_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!lmResponse.ok) throw new Error(lmResponse.statusText);

            const lmData = await lmResponse.json();
            let analysisContent = lmData.choices[0].message.content;

            // Sanitize markdown fences
            analysisContent = analysisContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');

            // Robust Parsing: Find outermost braces
            const firstOpen = analysisContent.indexOf('{');
            const lastClose = analysisContent.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1) {
                analysisContent = analysisContent.substring(firstOpen, lastClose + 1);
            }

            let analysis;
            try {
                analysis = JSON.parse(analysisContent);
                deduplicateTags(analysis); // <--- Deduplicate
            } catch (pErr) {
                console.warn(`[BATCH] JSON Parsing failed for ${id}. Content:`, analysisContent);
                analysis = {
                    summary: analysisContent,
                    objects: [],
                    tags: [], // Could try to extract list items if failed?
                    scene_type: 'unknown'
                };
            }

            // Update DB with Analysis AND Metadata
            // Update DB with Analysis AND Metadata
            const updatedAt = new Date().toISOString();
            const newWidth = metadata.width || null;
            const newHeight = metadata.height || null;
            const newSize = fileStats.size || null;

            db.prepare(`UPDATE images SET analysis = ?, width = ?, height = ?, size = ?, updated_at = ? WHERE id = ?`)
                .run(JSON.stringify(analysis), newWidth, newHeight, newSize, updatedAt, id);

            results.success++;
            results.updatedImages.push({
                id,
                analysis,
                width: newWidth,
                height: newHeight,
                size: newSize,
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


// Create Thumbnail Endpoint
app.post('/create-thumbnail', async (req, res) => {
    console.log('[THUMB] Create request received');
    try {
        const { imageData, filename } = req.body;
        if (!imageData || !filename) {
            return res.status(400).json({ error: 'Missing image data or filename' });
        }

        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        const filenameBase = filename.substring(0, filename.lastIndexOf('.')) || filename;
        const thumbPath = path.join(__dirname, 'public', 'thumbnails', `${filenameBase}.avif`);

        await sharp(buffer)
            .resize(100, 100, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .avif({ quality: 50 })
            .toFile(thumbPath);

        console.log(`[THUMB] Created: ${thumbPath}`);
        res.json({ success: true, path: `thumbnails/${filenameBase}.avif` });

    } catch (err) {
        console.error('[THUMB] Creation Error:', err);
        res.status(500).json({ error: 'Thumbnail creation failed' });
    }
});

// Save to Database
app.post('/save', async (req, res) => {
    console.log('[SAVE] Request received');
    try {
        const { filename, path, metadata, analysis, file_hash, mtime } = req.body;

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
                if (existingByHash.path === path) {
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
                        generateSearchIndex();
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
        const existingByPath = db.prepare(checkPathSql).get(path);

        if (existingByPath) {
            // Update existing
            console.log(`[SAVE] Updating existing file by path: ${path}`);
            const updateSql = `
                UPDATE images 
                SET filename = ?, file_hash = ?, metadata = ?, analysis = ?, created_at = ?, mtime = ?, width = ?, height = ?, size = ?
                WHERE id = ?
            `;
            db.prepare(updateSql).run(filename, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, mtime || null, width, height, size, existingByPath.id);
            generateSearchIndex(); // Update index
            return res.json({ message: 'Updated successfully', id: existingByPath.id, updated: true });
        }

        // 3. New Insert
        const insertSql = `INSERT INTO images (filename, path, file_hash, metadata, analysis, created_at, mtime, width, height, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const info = db.prepare(insertSql).run(filename, path, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, mtime || null, width, height, size);
        console.log(`[SAVE] Success. New ID: ${info.lastInsertRowid}`);
        generateSearchIndex(); // Update index
        res.json({ message: 'Saved successfully', id: info.lastInsertRowid, new: true });
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
app.post('/update-tags', (req, res) => {
    console.log('[UPDATE-TAGS] Request received');
    try {
        const { id, analysis } = req.body;

        if (analysis) deduplicateTags(analysis);

        if (!id || !analysis) {
            return res.status(400).json({ error: 'Missing id or analysis data' });
        }

        // Update just the analysis column and updated_at
        const updatedTime = new Date().toISOString();
        const sql = `UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?`;
        db.prepare(sql).run(JSON.stringify(analysis), updatedTime, id);

        console.log(`[UPDATE-TAGS] Updated tags for ID: ${id}`);
        generateSearchIndex(); // Update index
        res.json({ success: true, analysis, updated_at: updatedTime });

    } catch (err) {
        console.error('[UPDATE-TAGS] Error:', err);
        res.status(500).json({ error: 'Failed to update tags' });
    }
});

// Get Images (Supports Pagination or All)
// Get Images (Supports Pagination or All)
app.get('/images', (req, res) => {
    console.log('[GET-IMAGES] Request received');
    try {
        const page = parseInt(req.query.page);
        const limit = parseInt(req.query.limit);
        const sort = req.query.sort || 'recent_update';

        let orderBy = 'ORDER BY COALESCE(updated_at, created_at) DESC';
        switch (sort) {
            case 'newest': orderBy = 'ORDER BY created_at DESC'; break;
            case 'oldest': orderBy = 'ORDER BY created_at ASC'; break;
            case 'name_asc': orderBy = 'ORDER BY filename ASC'; break;
            case 'name_desc': orderBy = 'ORDER BY filename DESC'; break;
            case 'recent_update':
            default: orderBy = 'ORDER BY COALESCE(updated_at, created_at) DESC'; break;
        }

        if (isNaN(page) || isNaN(limit)) {
            // Return ALL images if no pagination params
            const sql = `SELECT * FROM images ${orderBy}`;
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

        const offset = (page - 1) * limit;

        // Get total count
        const countSql = `SELECT COUNT(*) as total FROM images`;
        const total = db.prepare(countSql).get().total;

        // Get paginated data
        const sql = `SELECT * FROM images ${orderBy} LIMIT ? OFFSET ?`;
        const images = db.prepare(sql).all(limit, offset);

        console.log(`[GET-IMAGES] Returning ${images.length} images (Page ${page}, Sort: ${sort})`);
        res.json({
            images,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('[GET-IMAGES] Error:', err);
        res.status(500).json({ error: 'Failed to fetch images' });
    }
});

// Delete Image
app.delete('/images/:id', (req, res) => {
    console.log('[DELETE] Request received for ID:', req.params.id);
    try {
        const id = req.params.id;
        const sql = `DELETE FROM images WHERE id = ?`;
        const info = db.prepare(sql).run(id);

        if (info.changes > 0) {
            console.log(`[DELETE] Deleted record ID: ${id}`);
            generateSearchIndex(); // Update index
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
app.get('/stats', (req, res) => {
    try {
        const sql = `SELECT analysis FROM images`;
        const rows = db.prepare(sql).all();

        const tagCounts = {};
        const objCounts = {};

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
app.post('/search', (req, res) => {
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

/**
 * Performs a deep integrity check of the database.
 * 1. Deduplicates tags and objects.
 * 2. Prunes records for missing files.
 * 3. Repairs corrupted metadata JSON.
 * 4. regenerate missing or valid thumbnails (including deep verification).
 * 5. Deduplicates entire image records based on file path.
 */
app.post('/validate-database', async (req, res) => {
    console.log('[VALIDATE] Request received');
    const { reanalyze } = req.body;
    const results = {
        total: 0,
        missing: 0,
        fixedThumbnails: 0,
        reanalyzed: 0,
        duplicatesRemoved: 0,
        errors: []
    };

    try {
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
                        db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
                        results.duplicatesRemoved++;
                        console.log(`[VALIDATE] Removed duplicate (inferior): ${img.path}`);
                    } else {
                        db.prepare('DELETE FROM images WHERE id = ?').run(existing.id);
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

        // Refresh images list after dedupe
        const images = db.prepare(`SELECT * FROM images`).all();
        results.total = images.length;

        for (const img of images) {
            const filePath = img.path;

            // 1. Check if file exists on disk
            if (!fs.existsSync(filePath)) {
                console.log(`[VALIDATE] File missing, removing from DB: ${filePath}`);
                db.prepare(`DELETE FROM images WHERE id = ?`).run(img.id);
                results.missing++;

                // Try to delete thumbnail too
                const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
                const thumbPath = path.join(__dirname, 'public', 'thumbnails', `${filenameBase}.avif`);
                if (fs.existsSync(thumbPath)) {
                    try { fs.unlinkSync(thumbPath); } catch (e) { }
                }
                continue;
            }

            // 2. Check for missing thumbnail
            const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
            let thumbValid = false;
            const thumbPath = path.join(__dirname, 'public', 'thumbnails', `${filenameBase}.avif`);

            if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
                try {
                    // Deep check: Verify the thumbnail is actually a valid image
                    await sharp(thumbPath).metadata();
                    thumbValid = true;
                } catch (e) {
                    console.warn(`[VALIDATE] Corrupted thumbnail detected for ${img.filename}, deleting.`);
                    try { fs.unlinkSync(thumbPath); } catch (err) { }
                }
            }

            if (!thumbValid) {
                console.log(`[VALIDATE] Thumbnail missing/invalid, generating: ${filePath}`);
                try {
                    await sharp(filePath)
                        .resize(100, 100, {
                            fit: 'contain',
                            background: { r: 0, g: 0, b: 0, alpha: 0 }
                        })
                        .avif({ quality: 50 })
                        .toFile(thumbPath);
                    results.fixedThumbnails++;
                } catch (err) {
                    console.error(`[VALIDATE] Failed to regenerate thumbnail for ${filePath}:`, err.message);
                    results.errors.push(`Thumbnail error: ${img.filename}`);
                }
            }

            // 3. Check for filename mismatch (Corruption repair)
            // Use regex to handle both forward and backslashes safely
            const correctFilename = (img.path || '').split(/[/\\]/).pop();

            // formatting check: If current filename looks like JSON or metadata, forcing update
            const isSuspicious = img.filename.trim().startsWith('{') || img.filename.includes('Lite Graph');

            if ((correctFilename && img.filename !== correctFilename) || isSuspicious) {
                console.log(`[VALIDATE] Fixing corrupted filename for ID ${img.id}`);
                console.log(`   Old: "${img.filename.substring(0, 50)}..."`);
                console.log(`   New: "${correctFilename}"`);

                if (correctFilename) {
                    db.prepare('UPDATE images SET filename = ? WHERE id = ?').run(correctFilename, img.id);
                    results.errors.push(`Fixed filename: ${correctFilename}`);
                }
            }

            // 4. Check for missing metadata (dimensions)
            if (!img.width || !img.height) {
                // Try from stored metadata first
                let metaObj = {};
                try {
                    metaObj = typeof img.metadata === 'string' ? JSON.parse(img.metadata) : (img.metadata || {});
                } catch (e) { }

                const metaH = metaObj.ImageHeight || metaObj.ExifImageHeight || metaObj.PixelYDimension || metaObj.height;
                const metaW = metaObj.ImageWidth || metaObj.ExifImageWidth || metaObj.PixelXDimension || metaObj.width;

                if (metaW && metaH) {
                    console.log(`[VALIDATE] Restoring dimensions from metadata for ${img.filename}`);
                    db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?')
                        .run(metaW, metaH, img.id);
                    results.metadataRepaired = (results.metadataRepaired || 0) + 1;
                } else {
                    // Fallback to file scan
                    console.log(`[VALIDATE] Missing dimensions for ${img.filename}, scanning file...`);
                    try {
                        const metadata = await sharp(img.path).metadata();
                        if (metadata.width && metadata.height) {
                            db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?')
                                .run(metadata.width, metadata.height, img.id);
                            results.metadataRepaired = (results.metadataRepaired || 0) + 1;
                            console.log(`[VALIDATE] Repaired dimensions: ${metadata.width}x${metadata.height}`);
                        }
                    } catch (err) {
                        console.error(`[VALIDATE] Failed to repair metadata for ${img.filename}:`, err.message);
                    }
                }
            }

            // 5. Check for missing size
            if (!img.size) {
                try {
                    const stats = fs.statSync(img.path);
                    if (stats.size) {
                        db.prepare('UPDATE images SET size = ? WHERE id = ?').run(stats.size, img.id);
                        results.metadataRepaired = (results.metadataRepaired || 0) + 1;
                        console.log(`[VALIDATE] Repaired size for ${img.filename}: ${stats.size}`);
                    }
                } catch (e) {
                    console.warn(`[VALIDATE] Failed to get size for ${img.path}:`, e.message);
                }
            }

            // 3. Check for missing AI analysis data (ONLY if requested)
            if (reanalyze) {
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

                        const payload = {
                            model: "qwen2.5-vl-7b-instruct",
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

                        console.log(`[VALIDATE] Sending request to LM Studio for ${img.filename}...`);
                        const lmResponse = await fetch(LM_STUDIO_URL, {
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
                            db.prepare(`UPDATE images SET analysis = ? WHERE id = ?`).run(JSON.stringify(newAnalysis), img.id);
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

        if (results.missing > 0 || results.fixedThumbnails > 0 || results.reanalyzed > 0) {
            generateSearchIndex();
        }

        res.json({ success: true, results });

    } catch (err) {
        console.error('[VALIDATE] Critical Error:', err);
        res.status(500).json({ error: 'Validation failed', details: err.message });
    }
});

// Regenerate specific thumbnail
app.post('/regenerate-thumbnail', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Image ID required' });

    try {
        const img = db.prepare(`SELECT * FROM images WHERE id = ?`).get(id);
        if (!img) return res.status(404).json({ error: 'Image not found' });

        const filePath = img.path;
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Source file no longer exists' });
        }

        const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
        const thumbPath = path.join(__dirname, 'public', 'thumbnails', `${filenameBase}.avif`);

        console.log(`[THUMB] Manual regeneration: ${filePath}`);

        const buffer = fs.readFileSync(filePath);
        await sharp(buffer)
            .resize(100, 100, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .avif({ quality: 50 })
            .toFile(thumbPath);

        res.json({ success: true, thumbPath: `thumbnails/${filenameBase}.avif` });

    } catch (err) {
        console.error('[THUMB] Regeneration Error:', err);
        res.status(500).json({ error: 'Failed to regenerate thumbnail', details: err.message });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function deduplicateTags(analysis) {
    if (analysis && analysis.tags && analysis.objects && Array.isArray(analysis.tags) && Array.isArray(analysis.objects)) {
        const objectSet = new Set(analysis.objects.map(o => o.toLowerCase()));
        const originalCount = analysis.tags.length;
        // Filter out tags that are present in objects (case-insensitive)
        analysis.tags = analysis.tags.filter(tag => !objectSet.has(tag.toLowerCase()));

        if (analysis.tags.length < originalCount) {
            // console.log(`[DEDUPE] Removed ${originalCount - analysis.tags.length} duplicate tags`);
        }
    }
    return analysis;
}

// ============================================================================
// MAINTENANCE ENDPOINTS
// ============================================================================
app.post('/maintenance/deduplicate-tags', (req, res) => {
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

                if (!analysis.tags || !analysis.objects) continue;

                const originalTags = JSON.stringify(analysis.tags);
                deduplicateTags(analysis);
                const newTags = JSON.stringify(analysis.tags);

                if (originalTags !== newTags) {
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

// Rename Endpoint
app.post('/rename', (req, res) => {
    const { id, newFilename } = req.body;
    if (!id || !newFilename) return res.status(400).json({ error: 'Missing ID or filename' });

    try {
        const image = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
        if (!image) return res.status(404).json({ error: 'Image not found' });

        const oldPath = image.path;
        const dir = path.dirname(oldPath);
        const newPath = path.join(dir, newFilename);

        // Security / Validation
        if (fs.existsSync(newPath)) {
            return res.status(409).json({ error: 'A file with that name already exists in this folder.' });
        }

        // Rename on Disk
        fs.renameSync(oldPath, newPath);

        // Best effort thumbnail rename
        const thumbDir = path.join(__dirname, 'public/thumbnails');
        const oldBase = path.parse(oldPath).name; // e.g. 'foo'
        const newBase = path.parse(newFilename).name; // e.g. 'bar'

        try {
            const oldThumbPath = path.join(thumbDir, oldBase + '.avif');
            const newThumbPath = path.join(thumbDir, newBase + '.avif');
            if (fs.existsSync(oldThumbPath)) {
                fs.renameSync(oldThumbPath, newThumbPath);
            }
        } catch (e) {
            console.warn('[RENAME] Failed to rename thumbnail:', e);
        }

        // Update Database
        db.prepare('UPDATE images SET filename = ?, path = ?, mtime = ? WHERE id = ?')
            .run(newFilename, newPath, new Date().toISOString(), id);

        res.json({ success: true, newPath, newFilename });

    } catch (err) {
        console.error('[RENAME] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start Server...
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);

    // Generate initial index after startup so we don't block
    setTimeout(() => {
        generateSearchIndex();
    }, 1000);
});
