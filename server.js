import 'dotenv/config';
import express from 'express';

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import exifr from 'exifr';
import sharp from 'sharp';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Initialize LM Studio (No SDK needed, just URL)
const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

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
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

console.log('[DB] Database initialized');

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
            metadata = await exifr.parse(buffer) || {};
            console.log('[ANALYZE] EXIF extracted:', Object.keys(metadata).length, 'fields');
        } catch (exifError) {
            console.log('[ANALYZE] No EXIF data or error parsing:', exifError.message);
        }

        // Prepare for LM Studio
        const prompt = `Analyze this image and return ONLY a JSON object with this exact structure:
{
"summary": "A concise description of the image content.",
"objects": ["list", "of", "visible", "objects"],
"tags": ["list", "of", "descriptive", "tags"],
"scene_type": "indoor/outdoor/portrait/etc",
"visual_elements": {
"dominant_colors": ["color1", "color2"],
"lighting": "description of lighting"
}
}
Do not include markdown formatting or explanations.`;

        console.log('[ANALYZE] Sending to LM Studio...');

        const response = await fetch(LM_STUDIO_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "local-model", // LM Studio usually accepts any string here
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Data}`
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`LM Studio API Error: ${response.statusText}`);
        }

        const result = await response.json();
        let text = result.choices[0].message.content;

        console.log('[ANALYZE] LM Studio response received');

        // Remove markdown formatting if present
        text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // Parse JSON
        let analysis;
        try {
            analysis = JSON.parse(text);
        } catch (jsonError) {
            console.error('[ANALYZE] JSON parse error:', jsonError);
            console.error('[ANALYZE] Response text:', text);
            // Attempt to recover partial JSON or return raw text if needed, 
            // but for now fail gracefully
            return res.status(500).json({ error: 'Failed to parse AI response as JSON' });
        }

        console.log('[ANALYZE] Success');
        res.json({
            metadata,
            description: analysis
        });

    } catch (error) {
        console.error('[ANALYZE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save image analysis to database
app.post('/save', (req, res) => {
    console.log('[SAVE] Request received');
    const { filename, path, file_hash, metadata, analysis, created_at } = req.body;
    console.log(`[SAVE] Saving: ${filename}`);

    // Validate required file_hash
    if (!file_hash) {
        return res.status(400).json({
            error: 'file_hash is required',
            details: 'File content hash must be provided for duplicate detection'
        });
    }

    try {
        console.log(`[SAVE] File hash: ${file_hash.substring(0, 16)}...`);

        // Check if file already exists in DB by content hash first, then by path
        const checkSql = `SELECT id, file_hash, path FROM images WHERE file_hash = ?`;
        const existing = db.prepare(checkSql).get(file_hash);

        if (existing) {
            // Exact content match - this is a duplicate
            console.log(`[SAVE] Skipping - exact duplicate found (ID: ${existing.id}, Path: ${existing.path})`);
            return res.json({
                message: 'Skipped - file already exists (same content)',
                id: existing.id,
                existingPath: existing.path,
                duplicate: true
            });
        }

        // Check if same path exists with different content
        const pathCheckSql = `SELECT id, file_hash FROM images WHERE path = ?`;
        const pathMatch = db.prepare(pathCheckSql).get(path);

        if (pathMatch) {
            // Same path but different content - file was modified, update it
            console.log(`[SAVE] Updating existing record ID: ${pathMatch.id} (file content changed)`);
            const updateSql = `
                UPDATE images 
                SET filename = ?, file_hash = ?, metadata = ?, analysis = ?, created_at = ?
                WHERE id = ?
            `;
            db.prepare(updateSql).run(filename, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, pathMatch.id);
            return res.json({ message: 'Updated successfully', id: pathMatch.id, updated: true });
        }

        // Insert new record
        const insertSql = `INSERT INTO images (filename, path, file_hash, metadata, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
        const info = db.prepare(insertSql).run(filename, path, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at);
        console.log(`[SAVE] Success. New ID: ${info.lastInsertRowid}`);
        res.json({ message: 'Saved successfully', id: info.lastInsertRowid, new: true });
    } catch (err) {
        console.error('[SAVE] Error:', err);
        // Return specific error message to client
        return res.status(500).json({
            error: err.message,
            code: err.code || 'UNKNOWN_ERROR',
            details: 'Database operation failed'
        });
    }
});

// Check single file
app.post('/check-file', (req, res) => {
    console.log('[CHECK-FILE] Request received');
    const { filePath } = req.body;

    if (!filePath) {
        return res.status(400).json({ error: 'No file path provided' });
    }

    try {
        // Check if file exists in filesystem
        if (!fs.existsSync(filePath)) {
            return res.json({ exists: false, reason: 'File not found on disk' });
        }

        // Calculate current file hash
        const fileBuffer = fs.readFileSync(filePath);
        const currentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Query database for this file path
        const sql = `SELECT * FROM images WHERE path = ? ORDER BY created_at DESC LIMIT 1`;
        const row = db.prepare(sql).get(filePath);

        if (!row) {
            console.log('[CHECK-FILE] File not found in database');
            return res.json({ exists: false, reason: 'Not in database' });
        }

        // Compare hashes
        if (row.file_hash && row.file_hash !== currentHash) {
            console.log('[CHECK-FILE] File content has changed (hash mismatch)');
            return res.json({
                exists: false,
                reason: 'File content changed',
                oldHash: row.file_hash.substring(0, 16) + '...',
                newHash: currentHash.substring(0, 16) + '...'
            });
        }

        // File exists and hash matches (or no hash stored)
        console.log('[CHECK-FILE] File found in database with matching hash');
        return res.json({
            exists: true,
            data: {
                filename: row.filename,
                path: row.path,
                fullPath: filePath,
                file_hash: row.file_hash,
                metadata: JSON.parse(row.metadata),
                description: JSON.parse(row.analysis),
                created_at: row.created_at
            }
        });

    } catch (err) {
        console.error('[CHECK-FILE] Error:', err);
        return res.status(500).json({ error: 'Failed to check file in database' });
    }
});

// Bulk check files endpoint
app.post('/check-files', (req, res) => {
    console.log('[CHECK-FILES] Bulk request received');
    const { filePaths } = req.body;

    if (!filePaths || !Array.isArray(filePaths)) {
        return res.status(400).json({ error: 'Invalid file paths array' });
    }

    try {
        // Build a query to fetch all records for the given paths
        const placeholders = filePaths.map(() => '?').join(',');
        const sql = `SELECT * FROM images WHERE path IN (${placeholders})`;
        const rows = db.prepare(sql).all(...filePaths);

        // Create a map of path -> record
        const recordMap = {};
        rows.forEach(row => {
            recordMap[row.path] = {
                id: row.id,
                filename: row.filename,
                path: row.path,
                file_hash: row.file_hash,
                metadata: row.metadata ? JSON.parse(row.metadata) : {},
                analysis: row.analysis ? JSON.parse(row.analysis) : {},
                created_at: row.created_at
            };
        });

        console.log(`[CHECK-FILES] Found ${rows.length} records for ${filePaths.length} paths`);
        res.json(recordMap);

    } catch (err) {
        console.error('[CHECK-FILES] Error:', err);
        return res.status(500).json({ error: 'Failed to check files in database' });
    }
});

// Get all images from database
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

// Search images endpoint
app.post('/search', (req, res) => {
    console.log('[SEARCH] Request received');
    const { query, tags, sceneType, startDate, endDate } = req.body;

    try {
        let sql = `SELECT * FROM images WHERE 1=1`;
        const params = [];

        // Text search in analysis
        if (query && query.trim()) {
            sql += ` AND analysis LIKE ?`;
            params.push(`%${query}%`);
        }

        // Filter by tags
        if (tags && tags.length > 0) {
            const tagConditions = tags.map(() => `analysis LIKE ?`).join(' AND ');
            sql += ` AND (${tagConditions})`;
            tags.forEach(tag => params.push(`%"${tag}"%`));
        }

        // Filter by scene type
        if (sceneType && sceneType !== 'all') {
            sql += ` AND analysis LIKE ?`;
            params.push(`%"scene_type":"${sceneType}"%`);
        }

        // Date range filter
        if (startDate) {
            sql += ` AND created_at >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            sql += ` AND created_at <= ?`;
            params.push(endDate + ' 23:59:59');
        }

        sql += ` ORDER BY created_at DESC`;

        console.log('[SEARCH] Query:', sql);
        console.log('[SEARCH] Params:', params);

        const results = db.prepare(sql).all(...params);
        console.log(`[SEARCH] Found ${results.length} results`);
        res.json(results);

    } catch (err) {
        console.error('[SEARCH] Error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Delete image endpoint
app.delete('/images/:id', (req, res) => {
    console.log('[DELETE] Request received');
    const { id } = req.params;

    try {
        const sql = `DELETE FROM images WHERE id = ?`;
        const info = db.prepare(sql).run(id);

        if (info.changes > 0) {
            console.log(`[DELETE] Deleted record ID: ${id}`);
            res.json({ message: 'Deleted successfully' });
        } else {
            console.log(`[DELETE] Record not found ID: ${id}`);
            res.status(404).json({ error: 'Image not found' });
        }
    } catch (err) {
        console.error('[DELETE] Error:', err);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

// Serve thumbnail endpoint
app.get('/thumbnail/:filename', (req, res) => {
    const { filename } = req.params;
    const thumbPath = path.join(__dirname, 'public', 'thumbnails', filename);

    if (fs.existsSync(thumbPath)) {
        res.sendFile(thumbPath);
    } else {
        res.status(404).send('Thumbnail not found');
    }
});

// Create thumbnail endpoint
app.post('/create-thumbnail', async (req, res) => {
    console.log('[THUMBNAIL] Request received');
    const { imageData, filename } = req.body;

    try {
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        const thumbnailsDir = path.join(__dirname, 'public', 'thumbnails');
        if (!fs.existsSync(thumbnailsDir)) {
            fs.mkdirSync(thumbnailsDir, { recursive: true });
        }

        const filenameBase = filename.substring(0, filename.lastIndexOf('.')) || filename;
        const thumbnailPath = path.join(thumbnailsDir, `${filenameBase}.avif`);

        await sharp(buffer)
            .resize(80, 80, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .avif({ quality: 40 })
            .toFile(thumbnailPath);

        console.log('[THUMBNAIL] Created successfully');
        res.json({ message: 'Thumbnail created', path: `thumbnails/${filenameBase}.avif` });

    } catch (error) {
        console.error('[THUMBNAIL] Error:', error);
        res.status(500).json({ error: 'Failed to create thumbnail' });
    }
});

// ============================================================================
// START SERVER
// ============================================================================
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
});
