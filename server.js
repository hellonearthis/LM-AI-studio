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

// Create table if it doesn't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        path TEXT UNIQUE,
        file_hash TEXT,
        metadata TEXT,
        analysis TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT
    )
`);

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
        const sql = `SELECT * FROM images ORDER BY created_at DESC`;
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

// Generate initial index on startup
generateSearchIndex();

// Analyze image endpoint
app.post('/analyze', async (req, res) => {
    console.log('[ANALYZE] Request received');

    try {
        const { imageData } = req.body;

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
            console.log('[ANALYZE] Metadata keys:', Object.keys(metadata)); // Debug log
        } catch (exifError) {
            console.log('[ANALYZE] No EXIF data or error parsing:', exifError.message);
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

        const lmResponse = await fetch(LM_STUDIO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!lmResponse.ok) {
            throw new Error(`LM Studio API Error: ${lmResponse.statusText}`);
        }

        const lmData = await lmResponse.json();
        const analysisContent = lmData.choices[0].message.content;
        const analysis = JSON.parse(analysisContent);

        res.json({ analysis, metadata });

    } catch (error) {
        console.error('[ANALYZE] Error:', error);
        res.status(500).json({ error: 'Image analysis failed' });
    }
});

// Save to Database
app.post('/save', async (req, res) => {
    console.log('[SAVE] Request received');
    try {
        const { filename, path, metadata, analysis } = req.body;

        // Auto-generate created_at if not provided (should be standard ISO)
        // If file exists (by hash or path), update it?
        // User wants duplicate checking? 
        // For now, simple insert. Unique constraint on path might throw.

        let created_at = new Date().toISOString();
        // Try to get original creation date from metadata
        if (metadata.DateTimeOriginal) {
            created_at = new Date(metadata.DateTimeOriginal).toISOString();
        } else if (metadata.CreateDate) {
            created_at = new Date(metadata.CreateDate).toISOString();
        }

        // Generate a simple hash (fake for now, or use path)
        const file_hash = crypto.createHash('md5').update(path + filename).digest('hex');

        // Check for existing path
        const checkSql = `SELECT id FROM images WHERE path = ?`;
        const existingByPath = db.prepare(checkSql).get(path);

        if (existingByPath) {
            // Update existing
            console.log(`[SAVE] Updating existing file by path: ${path}`);
            const updateSql = `
                UPDATE images 
                SET filename = ?, file_hash = ?, metadata = ?, analysis = ?, created_at = ?
                WHERE id = ?
            `;
            db.prepare(updateSql).run(filename, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, existingByPath.id);
            generateSearchIndex(); // Update index
            return res.json({ message: 'Updated successfully', id: existingByPath.id, updated: true });
        }

        // Check for existing hash (optional, maybe just path is enough for now)
        // const checkHashSql = `SELECT id FROM images WHERE file_hash = ?`;
        // const existingByHash = db.prepare(checkHashSql).get(file_hash);

        // Actually, user mentioned "Deduplicate" logic.
        // Let's stick to path unique for now.

        const insertSql = `INSERT INTO images (filename, path, file_hash, metadata, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
        const info = db.prepare(insertSql).run(filename, path, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at);
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

// Get Images
app.get('/images', (req, res) => {
    console.log('[GET-IMAGES] Request received');
    try {
        const sql = `SELECT * FROM images ORDER BY created_at DESC`;
        const images = db.prepare(sql).all();
        console.log(`[GET-IMAGES] Returning ${images.length} images`);
        res.json(images);
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
// DATABASE VALIDATION
// ============================================================================
app.post('/validate-database', async (req, res) => {
    console.log('[VALIDATE] Request received');
    const { reanalyze } = req.body;
    const results = {
        total: 0,
        missing: 0,
        fixedThumbnails: 0,
        reanalyzed: 0,
        errors: []
    };

    try {
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
            const thumbPath = path.join(__dirname, 'public', 'thumbnails', `${filenameBase}.avif`);

            if (!fs.existsSync(thumbPath)) {
                console.log(`[VALIDATE] Thumbnail missing, regenerating: ${filePath}`);
                try {
                    const buffer = fs.readFileSync(filePath);
                    await sharp(buffer)
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

            // 3. Optional: Metadata check
            // Note: Full AI re-analysis is too slow for bulk.
            // We just report if items are "incomplete" for now, or the user can choose to re-run.
        }

        if (results.missing > 0 || results.fixedThumbnails > 0) {
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

// Start Server...
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
});
