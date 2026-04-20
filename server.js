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
import { exec, spawn } from 'child_process';
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
// ============================================================================
// SEARCH INDEX GENERATION
// ============================================================================
function generateSearchIndex() {
    console.log('[INDEX] Generating search index and data...');
    try {
        // Fetch all images for indexing (Must match /images sort order)
        const sql = `SELECT id, filename, path, analysis, width, height, size, created_at, updated_at FROM images ORDER BY COALESCE(updated_at, created_at) DESC`;
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

        // 1. Create Fuse Index
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

        // 2. Save Index (The structure)
        const indexOutputPath = path.join(__dirname, 'public', 'search-index.json');
        fs.writeFileSync(indexOutputPath, JSON.stringify(index.toJSON()));

        // 3. Save Data (The content - Lightweight, no 'metadata' column)
        const dataOutputPath = path.join(__dirname, 'public', 'search-data.json');
        fs.writeFileSync(dataOutputPath, JSON.stringify(indexData));

        console.log(`[INDEX] Generated successfully (${images.length} items)`);
        console.log(`[INDEX] Index saved to: ${indexOutputPath}`);
        console.log(`[INDEX] Data saved to: ${dataOutputPath}`);

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

// ============================================================================
// IMAGE ANALYSIS HELPERS
// ============================================================================

/**
 * Attempts to repair a truncated JSON string from an LLM.
 * Closes unclosed braces/brackets and ensures strings are terminated.
 */
function repairTruncatedJson(str) {
    if (!str || typeof str !== 'string') return '{}';
    
    let trimmed = str.trim();
    if (trimmed.endsWith('}')) return trimmed; // Probably fine

    console.log('[REPAIR] Attempting to fix truncated JSON...');
    
    // 1. Basic string termination
    // If we're inside a string (odd number of quotes), close it
    const quoteCount = (trimmed.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
        trimmed += '"';
    }

    // 2. Close open brackets and braces
    const stack = [];
    for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '{' || trimmed[i] === '[') {
            stack.push(trimmed[i]);
        } else if (trimmed[i] === '}' || trimmed[i] === ']') {
            const last = stack.pop();
            // Mismatch handling (basic)
            if ((trimmed[i] === '}' && last !== '{') || (trimmed[i] === ']' && last !== '[')) {
                // If it's a mismatch, we might have truncated in a way that makes the stack invalid
                // but for simple truncation, the stack should stay valid or empty.
            }
        }
    }

    // Close in reverse order
    while (stack.length > 0) {
        const last = stack.pop();
        if (last === '{') trimmed += '}';
        else if (last === '[') trimmed += ']';
    }

    // 3. Final cleanup - remove trailing commas before closing braces/brackets
    trimmed = trimmed.replace(/,\s*([\]}])/g, '$1');

    try {
        JSON.parse(trimmed);
        console.log('[REPAIR] Success!');
        return trimmed;
    } catch (e) {
        console.warn('[REPAIR] Failed to fully repair JSON:', e.message);
        // If it still fails, find the last successful closing brace and cut there
        const lastBrace = trimmed.lastIndexOf('}');
        if (lastBrace !== -1) {
            return trimmed.substring(0, lastBrace + 1);
        }
        return '{}';
    }
}

/**
 * Deduplicates tags and objects in the analysis result.
 */
function deduplicateTags(analysis) {
    if (!analysis) return;
    
    // Helper: Normalize by removing plurals, brackets, and extra spaces
    const normalize = (s) => String(s).trim().toLowerCase().replace(/[\[\]\(\)\{\}]/g, '').replace(/\s+/g, ' ').trim().replace(/s$/, '');

    if (Array.isArray(analysis.objects)) {
        // Initial cleaning
        let objects = analysis.objects
            .map(o => String(o).trim())
            .filter(o => o.length > 0 && o.length < 100 && o.split(/\s+/).length <= 8);

        // Case-insensitive distinct
        const seen = new Set();
        analysis.objects = objects.filter(o => {
            const norm = normalize(o);
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });
    }
    
    if (Array.isArray(analysis.tags)) {
        // 1. Initial cleaning (Length and Word Count limits)
        let tags = analysis.tags
            .map(t => String(t).trim())
            .filter(t => t.length > 0 && t.length < 120 && t.split(/\s+/).length <= 10);

        // 2. Case-insensitive and Plural-insensitive deduplication
        const seen = new Set();
        tags = tags.filter(t => {
            const norm = normalize(t);
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });

        // 3. Substring / Recursive pruning:
        // Sort by length (descending) so we can check if shorter tags are contained in longer ones
        // Actually, usually we want to prune the LONG ones if they are just extensions of existing short ones.
        tags.sort((a, b) => a.length - b.length); 

        const finalTags = [];
        for (const tag of tags) {
            const normTag = normalize(tag);
            // Check if this tag is a major subset of an already added tag, or vice-versa
            const isRedundant = finalTags.some(existing => {
                const normExisting = normalize(existing);
                // If one contains the other entirely, and they are long-ish, prune.
                if (normTag.length > 5 && normExisting.length > 5) {
                    if (normTag.includes(normExisting) || normExisting.includes(normTag)) return true;
                }
                return false;
            });
            if (!isRedundant) finalTags.push(tag);
        }

        analysis.tags = finalTags;

        // 4. Remove tags that are already represented as objects
        if (Array.isArray(analysis.objects)) {
            const objectNorms = new Set(analysis.objects.map(normalize));
            analysis.tags = analysis.tags.filter(tag => !objectNorms.has(normalize(tag)));
        }
    }
}

/**
 * Shared logic for performing image analysis via LM Studio.
 */
async function performImageAnalysis(imageData, promptType) {
    // Get the selected model from config
    const config = getConfig();
    const activeModel = config.visionModel || "qwen2.5-vl-7b-instruct";
    const isQwen = activeModel.toLowerCase().includes('qwen');

    // Select System Prompt
    const selectedKey = promptType || 'Detailed Description';
    let basePrompt = qwenPrompts[selectedKey] || qwenPrompts['Detailed Description'] || Object.values(qwenPrompts)[0];
    let systemPrompt;

    if (isQwen) {
        // Qwen handles mixed prose+JSON prompts well
        systemPrompt = "You are an expert image analyst. Analyze the image and extract: 1. A detailed summary. 2. A list of objects. 3. A list of descriptive tags. 4. The scene type. Return JSON.";
        if (basePrompt) {
            if (selectedKey !== 'Detailed Analysis') {
                systemPrompt = `${basePrompt}\n\nIMPORTANT: extract: 1. A list of objects. 2. A list of descriptive tags. 3. The scene type. Format the response as valid JSON with keys: 'summary', 'objects', 'tags', 'scene_type'.`;
            } else {
                systemPrompt = basePrompt;
            }
        }
    } else {
        // For Gemma and other models: use a purely extractive, JSON-only prompt.
        // These models loop when given mixed "write prose" + "return JSON" instructions.
        systemPrompt = `You are an image analysis tool. You MUST output ONLY a valid JSON object with exactly these keys:
- "summary": A 2-4 sentence description of the image. Do NOT repeat yourself.
- "objects": An array of up to 15 distinct objects visible in the image. Use short labels (1-3 words each). No duplicates.
- "tags": An array of up to 20 descriptive tags about the image (style, mood, colors, setting). Use single words or 2-word phrases. No duplicates. No overlap with objects.
- "scene_type": A single word or short phrase classifying the scene (e.g., "landscape", "portrait", "macro", "abstract").

Rules:
- Output ONLY the JSON object. No other text before or after it.
- Do NOT repeat words or phrases.
- Do NOT write long compound phrases with "and".
- Keep every array item short and unique.`;
    }

    const jsonSchema = {
        name: "image_analysis",
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

    // Model-specific parameters
    const modelParams = isQwen
        ? { temperature: 0.2, repetition_penalty: 1.2, frequency_penalty: 1.0 }
        : { temperature: 0.1, repetition_penalty: 1.5, frequency_penalty: 1.5 };

    const payload = {
        model: activeModel,
        messages: [
            { role: "system", content: systemPrompt },
            {
                role: "user",
                content: [
                    { type: "text", text: isQwen ? "Analyze this image." : "Analyze this image. Return JSON only." },
                    { type: "image_url", image_url: { url: imageData } }
                ]
            }
        ],
        max_tokens: 2048,
        ...modelParams,
        response_format: {
            type: "json_schema",
            json_schema: jsonSchema
        }
    };

    console.log(`[ANALYZE] Using model: ${activeModel} (${isQwen ? 'Qwen-optimized' : 'Generic'} prompt)`);

    const lmResponse = await fetch(LM_STUDIO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!lmResponse.ok) {
        throw new Error(`LM Studio API Error: ${lmResponse.statusText}`);
    }

    const lmData = await lmResponse.json();
    let content = lmData.choices[0].message.content;

    // Sanitize
    content = content.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    
    // Find outermost braces
    const firstOpen = content.indexOf('{');
    const lastClose = content.lastIndexOf('}');
    
    let analysisStr = content;
    if (firstOpen !== -1) {
        analysisStr = content.substring(firstOpen, lastClose !== -1 ? lastClose + 1 : content.length);
    }

    let analysis;
    try {
        analysis = JSON.parse(analysisStr);
    } catch (e) {
        console.warn('[ANALYZE] Initial parse failed, attempting repair...');
        const repaired = repairTruncatedJson(analysisStr);
        try {
            analysis = JSON.parse(repaired);
        } catch (e2) {
            console.error('[ANALYZE] Critical: Failed to parse even repaired JSON');
            analysis = {
                summary: content,
                objects: [],
                tags: [],
                scene_type: 'unknown'
            };
        }
    }

    deduplicateTags(analysis);
    return analysis;
}

// Analyze image endpoint
app.post('/analyze', async (req, res) => {
    console.log('[ANALYZE] Request received');

    try {
        const { imageData, promptType } = req.body;

        if (!imageData) {
            return res.status(400).json({ error: 'No image data provided' });
        }

        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        // Metadata extraction (Keep existing logic)
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

        // Use shared analysis helper
        const analysis = await performImageAnalysis(imageData, promptType);

        res.json({ analysis, metadata });

    } catch (error) {
        console.error('[ANALYZE] Error:', error);
        res.status(500).json({ error: 'Image analysis failed: ' + error.message });
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
        total: ids.length, processed: 0,
        success: 0, failed: 0,
        errors: [], updatedImages: []
    };

    for (const id of ids) {
        try {
            const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
            if (!img || !fs.existsSync(img.path)) {
                results.failed++;
                results.errors.push(`Image not found: ${id}`);
                continue;
            }

            console.log(`[BATCH] Processing ${img.filename} (${results.processed + 1}/${results.total})`);

            const buffer = fs.readFileSync(img.path);
            const fileStats = fs.statSync(img.path);
            const sharpMeta = await sharp(buffer).metadata();

            const standardizedBuffer = await sharp(buffer).jpeg({ quality: 80 }).toBuffer();
            const imageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

            // Use shared analysis helper
            const analysis = await performImageAnalysis(imageData, promptType);

            const updatedAt = new Date().toISOString();
            const width = sharpMeta.width || null;
            const height = sharpMeta.height || null;
            const size = fileStats.size || null;

            db.prepare(`UPDATE images SET analysis = ?, width = ?, height = ?, size = ?, updated_at = ? WHERE id = ?`)
                .run(JSON.stringify(analysis), width, height, size, updatedAt, id);

            results.success++;
            results.updatedImages.push({ id, analysis, width, height, size, updated_at: updatedAt });

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
app.post('/reparse-analysis', (req, res) => {
    const { id } = req.body;
    try {
        const img = db.prepare('SELECT analysis FROM images WHERE id = ?').get(id);
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

            // Update DB
            db.prepare('UPDATE images SET analysis = ? WHERE id = ?')
                .run(JSON.stringify(newAnalysis), id);

            res.json({ success: true, analysis: newAnalysis });
        } catch (e) {
            res.json({ success: false, message: 'Could not recover valid JSON даже with repair.' });
        }
    } catch (error) {
        console.error('[REPARSE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Full Re-Analyze Image Endpoint (Calls LM Studio)
app.post('/re-analyze', async (req, res) => {
    const { id } = req.body;
    try {
        const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
        if (!img || !fs.existsSync(img.path)) {
            return res.status(404).json({ error: 'Image file not found' });
        }

        console.log(`[RE-ANALYZE] Triggering full analysis for ID ${id}`);

        // Read and standarize image
        const buffer = fs.readFileSync(img.path);
        const standardizedBuffer = await sharp(buffer)
            .jpeg({ quality: 80 })
            .toBuffer();
        const standardizedImageData = `data:image/jpeg;base64,${standardizedBuffer.toString('base64')}`;

        // Perform analysis using shared logic
        const analysis = await performImageAnalysis(standardizedImageData, null); // Use default prompt
        
        // Update DB
        const updatedAt = new Date().toISOString();
        db.prepare(`UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(analysis), updatedAt, id);

        // Update Search Index
        generateSearchIndex();

        res.json({ success: true, analysis, updated_at: updatedAt });

    } catch (error) {
        console.error('[RE-ANALYZE] Error:', error);
        res.status(500).json({ error: 'Re-analysis failed: ' + error.message });
    }
});


// Create Thumbnail Endpoint (Deprecated/Updated to use ID)
app.post('/create-thumbnail', async (req, res) => {
    try {
        const { imageData, id } = req.body;
        if (!imageData || !id) {
            return res.status(400).json({ error: 'Missing image data or image ID' });
        }

        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        const thumbPath = path.join(__dirname, 'public', 'thumbnails', `id_${id}.avif`);

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
        const newId = info.lastInsertRowid;
        console.log(`[SAVE] Success. New ID: ${newId}`);

        // OPTIONAL: Auto-generate thumbnail if imageData provided
        if (req.body.imageData) {
            try {
                const base64Data = req.body.imageData.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const thumbPath = path.join(__dirname, 'public', 'thumbnails', `id_${newId}.avif`);
                await sharp(buffer)
                    .resize(100, 100, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .avif({ quality: 50 })
                    .toFile(thumbPath);
                console.log(`[SAVE] Auto-generated thumbnail for ID: ${newId}`);
            } catch (te) {
                console.warn('[SAVE] Failed to auto-generate thumbnail:', te.message);
            }
        }

        generateSearchIndex(); // Update index
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
        const id = req.query.id;
        if (id) {
            const image = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
            if (!image) return res.status(404).json({ error: 'Image not found' });
            return res.json({ image });
        }

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
    const options = req.body.options || { 
        removeMissing: true, 
        repairMetadata: true, 
        regenThumbnails: true, 
        purgeThumbnails: false,
        reanalyze: req.body.reanalyze || false
    };

    const results = {
        total: 0,
        missing: 0,
        fixedThumbnails: 0,
        reanalyzed: 0,
        metadataRepaired: 0,
        duplicatesRemoved: 0,
        purged: 0,
        errors: []
    };

    try {
        // 0. Purge Old Thumbnails if requested
        if (options.purgeThumbnails) {
            console.log('[VALIDATE] Purging all thumbnails...');
            const thumbDir = path.join(__dirname, 'public', 'thumbnails');
            if (fs.existsSync(thumbDir)) {
                const files = fs.readdirSync(thumbDir);
                for (const file of files) {
                    if (file.endsWith('.avif')) {
                        try { fs.unlinkSync(path.join(thumbDir, file)); results.purged++; } catch (e) { }
                    }
                }
            }
        }

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
                if (options.removeMissing) {
                    console.log(`[VALIDATE] File missing, removing from DB: ${filePath}`);
                    db.prepare(`DELETE FROM images WHERE id = ?`).run(img.id);
                    results.missing++;

                    // Try to delete thumbnail too
                    const thumbPath = path.join(__dirname, 'public', 'thumbnails', `id_${img.id}.avif`);
                    if (fs.existsSync(thumbPath)) {
                        try { fs.unlinkSync(thumbPath); } catch (e) { }
                    }
                    continue;
                } else {
                    console.warn(`[VALIDATE] File missing but "Remove Missing" is disabled: ${filePath}`);
                }
            }

            // 2. Check for missing thumbnail
            let thumbValid = false;
            const thumbPath = path.join(__dirname, 'public', 'thumbnails', `id_${img.id}.avif`);

            if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
                try {
                    // Deep check: Verify the thumbnail is actually a valid image
                    await sharp(thumbPath).metadata();
                    thumbValid = true;
                } catch (e) {
                    console.warn(`[VALIDATE] Corrupted thumbnail detected for ID ${img.id}, deleting.`);
                    try { fs.unlinkSync(thumbPath); } catch (err) { }
                }
            }

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
                        db.prepare('UPDATE images SET filename = ? WHERE id = ?').run(correctFilename, img.id);
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
                        db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?').run(metaW, metaH, img.id);
                        results.metadataRepaired++;
                    } else {
                        try {
                            const metadata = await sharp(img.path).metadata();
                            if (metadata.width && metadata.height) {
                                db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?').run(metadata.width, metadata.height, img.id);
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
                            db.prepare('UPDATE images SET size = ? WHERE id = ?').run(stats.size, img.id);
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

                        // Dynamically find vision model (or use Config/ENV override)
                        const config = getConfig();
                        let analysisModel = config.visionModel || process.env.VISION_MODEL_ID || "qwen2.5-vl-7b-instruct";

                        // Only auto-detect if NOT configured
                        if (!config.visionModel && !process.env.VISION_MODEL_ID) {
                            try {
                                const mRes = await fetch('http://127.0.0.1:1234/v1/models');
                                if (mRes.ok) {
                                    const mData = await mRes.json();
                                    // Look for common vision model identifiers
                                    const vModel = mData.data.find(m => {
                                        const id = m.id.toLowerCase();
                                        return (id.includes('vl') || id.includes('vision') || id.includes('xc') || id.includes('llava')) && !id.includes('embed');
                                    });
                                    if (vModel) analysisModel = vModel.id;
                                }
                            } catch (e) { /* ignore */ }
                        }

                        const payload = {
                            model: analysisModel,
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

        const thumbPath = path.join(__dirname, 'public', 'thumbnails', `id_${id}.avif`);

        console.log(`[THUMB] Manual regeneration for ID ${id}: ${filePath}`);

        const buffer = fs.readFileSync(filePath);
        await sharp(buffer)
            .resize(100, 100, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .avif({ quality: 50 })
            .toFile(thumbPath);

        res.json({ success: true, thumbPath: `thumbnails/id_${id}.avif` });

    } catch (err) {
        console.error('[THUMB] Regeneration Error:', err);
        res.status(500).json({ error: 'Failed to regenerate thumbnail', details: err.message });
    }
});

// Semantic Search Embedding Proxy
// Proxies client request to LM Studio to get vector for query
app.post('/api/embed', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    try {
        // Use the same base but different endpoint
        // Existing LM_STUDIO_URL is likely 'http://127.0.0.1:1234/v1/chat/completions' or similar BASE
        // Let's assume standard local URL for now or parse from existing.
        // If LM_STUDIO_URL is 'http://localhost:1234/v1/chat/completions', we want 'http://localhost:1234/v1/embeddings'

        // Fetch model ID dynamically
        const config = getConfig();
        let modelId = config.embeddingModel || process.env.EMBEDDING_MODEL_ID || 'local-model';

        if (!config.embeddingModel && !process.env.EMBEDDING_MODEL_ID) {
            try {
                // Quick fetch to get current model
                const modelsRes = await fetch('http://127.0.0.1:1234/v1/models');
                if (modelsRes.ok) {
                    const modelsData = await modelsRes.json();
                    if (modelsData.data && modelsData.data.length > 0) {
                        const embeddingModel = modelsData.data.find(m => m.id.toLowerCase().includes('embed'));
                        modelId = embeddingModel ? embeddingModel.id : modelsData.data[0].id;
                    }
                }
            } catch (e) {
                console.warn('[EMBED] Failed to fetch model list, using fallback.');
            }
        }

        const embedUrl = 'http://127.0.0.1:1234/v1/embeddings';

        const response = await fetch(embedUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: text,
                model: modelId
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`LM Studio Error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        if (data.data && data.data[0] && data.data[0].embedding) {
            res.json({ embedding: data.data[0].embedding });
        } else {
            throw new Error('Invalid response format from LM Studio');
        }

    } catch (err) {
        console.error('[EMBED] Proxy Error:', err.message);
        res.status(500).json({ error: 'Failed to generate embedding', details: err.message });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================


// ============================================================================
// CONFIGURATION & SETTINGS
// ============================================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');

function getConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (e) { return {}; }
    }
    return {};
}

app.get('/api/config', (req, res) => {
    res.json(getConfig());
});

app.post('/api/config', (req, res) => {
    try {
        const newConfig = req.body;
        // Merge with existing or overwrite? Simple overwrite is fine for now.
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

app.get('/api/proxy/models', async (req, res) => {
    try {
        const response = await fetch('http://127.0.0.1:1234/v1/models');
        if (!response.ok) throw new Error('LM Studio Error');
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(502).json({ error: 'Failed to fetch models from LM Studio' });
    }
});

app.post('/api/proxy/load', async (req, res) => {
    try {
        console.log('[PROXY] Requesting model load:', req.body.model_identifier);
        const response = await fetch('http://127.0.0.1:1234/api/v1/models/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (e) {
        console.error('[PROXY] Load error:', e.message);
        res.status(502).json({ error: 'Failed to trigger model load in LM Studio' });
    }
});

app.post('/api/proxy/unload', async (req, res) => {
    try {
        console.log('[PROXY] Requesting model unload:', req.body.model_identifier);
        const response = await fetch('http://127.0.0.1:1234/api/v1/models/unload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (e) {
        console.error('[PROXY] Unload error:', e.message);
        res.status(502).json({ error: 'Failed to trigger model unload in LM Studio' });
    }
});

// Serve SQLite database cluster coordinates for the Data Map toggle function
app.get('/api/scope/db-data', (req, res) => {
    try {
        const sql = `
            SELECT 
                c.x, 
                c.y, 
                cl.cluster_label as cluster, 
                null as label, 
                i.path, 
                i.filename,
                i.id
            FROM image_coordinates c
            JOIN image_clusters cl ON c.image_id = cl.image_id
            JOIN images i ON c.image_id = i.id
        `;
        const points = db.prepare(sql).all();
        res.json(points);
    } catch (err) {
        console.error('[DB] Failed to fetch database scope data:', err);
        // If tables don't exist yet, return an empty array gracefully
        if (err.message.includes('no such table')) {
            return res.json([]);
        }
        res.status(500).json({ error: 'Failed to fetch database coordinate data' });
    }
});


app.get('/api/diagnostics', async (req, res) => {
    const config = getConfig();
    let visionSource = 'Auto-detect';
    let visionId = 'Unknown (will detect on demand)';
    let embedSource = 'Auto-detect';
    let embedId = 'Unknown (will detect on demand)';

    // Simulate Vision Logic
    if (config.visionModel) {
        visionSource = 'Settings (config.json)';
        visionId = config.visionModel;
    } else if (process.env.VISION_MODEL_ID) {
        visionSource = 'Environment Variable (.env)';
        visionId = process.env.VISION_MODEL_ID;
    } else {
        // Try fetch
        try {
            const mRes = await fetch('http://127.0.0.1:1234/v1/models');
            if (mRes.ok) {
                const mData = await mRes.json();
                const vModel = mData.data.find(m => {
                    const id = m.id.toLowerCase();
                    return (id.includes('vl') || id.includes('vision') || id.includes('xc') || id.includes('llava')) && !id.includes('embed');
                });
                if (vModel) visionId = vModel.id;
            }
        } catch (e) { visionId = 'LM Studio Unreachable'; }
    }

    // Simulate Embed Logic
    if (config.embeddingModel) {
        embedSource = 'Settings (config.json)';
        embedId = config.embeddingModel;
    } else if (process.env.EMBEDDING_MODEL_ID) {
        embedSource = 'Environment Variable (.env)';
        embedId = process.env.EMBEDDING_MODEL_ID;
    } else {
        // Try fetch
        try {
            const mRes = await fetch('http://127.0.0.1:1234/v1/models');
            if (mRes.ok) {
                const mData = await mRes.json();
                const eModel = mData.data.find(m => m.id.toLowerCase().includes('embed'));
                if (eModel) embedId = eModel.id;
                else if (mData.data.length > 0) embedId = mData.data[0].id + " (Fallback)";
            }
        } catch (e) { embedId = 'LM Studio Unreachable'; }
    }

    const report = `
SYSTEM DIAGNOSTICS
------------------
Vision Model:    ${visionId}
Source:          ${visionSource}

Embedding Model: ${embedId}
Source:          ${embedSource}

Config Path:     ${CONFIG_PATH}
    `;
    res.send(report.trim());
});

// ============================================================================
// MAINTENANCE ENDPOINTS
// ============================================================================

// Embeddings file status (for "Last updated" display)
app.get('/api/embeddings-status', (req, res) => {
    const embeddingsPath = path.join(__dirname, 'public', 'search-embeddings.json');
    try {
        if (!fs.existsSync(embeddingsPath)) {
            return res.json({ exists: false });
        }
        const stats = fs.statSync(embeddingsPath);
        // Count entries without fully parsing the large file (read first 100 chars to check if valid)
        let count = 0;
        try {
            const data = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
            count = Object.keys(data).length;
        } catch (e) { /* invalid json */ }

        res.json({
            exists: true,
            lastModified: stats.mtime.toISOString(),
            sizeBytes: stats.size,
            count
        });
    } catch (err) {
        res.json({ exists: false, error: err.message });
    }
});

// Run EVoC + UMAP Pipeline (Streaming)
app.post('/api/maintenance/run-evoc', (req, res) => {
    console.log('[MAINTENANCE] Running EVoC + UMAP Pipeline...');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    const scriptPath = path.join(__dirname, 'scripts', 'evoc_pipeline.py');
    const dbPath = path.join(__dirname, 'images.db');
    const embeddingsPath = path.join(__dirname, 'public', 'search-embeddings.json');

    // Run the python script
    const pythonProcess = spawn('python', [scriptPath, '--db', dbPath, '--embeddings', embeddingsPath]);

    pythonProcess.stdout.on('data', (data) => {
        res.write(data.toString());
        process.stdout.write(`[PY-STDOUT] ${data}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        res.write(`ERROR: ${data.toString()}`);
        process.stderr.write(`[PY-STDERR] ${data}`);
    });

    pythonProcess.on('close', (code) => {
        res.write(`\n[PROCESS COMPLETED WITH CODE ${code}]\n`);
        res.end();
    });
});

// Generate Embeddings (Streaming)
app.post('/maintenance/generate-embeddings', async (req, res) => {
    console.log('[MAINTENANCE] Generating embeddings...');

    // Set headers for long-running streaming response
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        const images = db.prepare(`SELECT id, filename, analysis FROM images WHERE analysis IS NOT NULL AND analysis != '{}'`).all();
        const msgFound = `Found ${images.length} images with analysis.\n`;
        res.write(msgFound);
        console.log(msgFound.trim());

        const OUTPUT_PATH = path.join(__dirname, 'public', 'search-embeddings.json');

        let embeddingMap = {};
        if (fs.existsSync(OUTPUT_PATH)) {
            try {
                embeddingMap = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
                res.write(`Loaded ${Object.keys(embeddingMap).length} existing embeddings.\n`);
            } catch (e) {
                res.write('Starting fresh (invalid existing file).\n');
            }
        }

        // Fetch Model ID
        const config = getConfig();
        let modelId = config.embeddingModel || process.env.EMBEDDING_MODEL_ID || 'local-model';

        if (config.embeddingModel || process.env.EMBEDDING_MODEL_ID) {
            const msgModel = `Using Configured Embedding Model: ${modelId}\n`;
            res.write(msgModel);
            console.log(msgModel.trim());
        } else {
            try {
                const modelsRes = await fetch('http://127.0.0.1:1234/v1/models');
                if (modelsRes.ok) {
                    const modelsData = await modelsRes.json();
                    if (modelsData.data && modelsData.data.length > 0) {
                        // Smart Selection: Prefer models with "embed" in the name
                        const embeddingModel = modelsData.data.find(m => m.id.toLowerCase().includes('embed'));
                        if (embeddingModel) {
                            modelId = embeddingModel.id;
                            const msgModel = `Using Dedicated Embedding Model: ${modelId}\n`;
                            res.write(msgModel);
                            console.log(msgModel.trim());
                        } else {
                            modelId = modelsData.data[0].id;
                            const msgModel = `Warning: No model with 'embed' found. Using first available: ${modelId}\n`;
                            res.write(msgModel);
                            console.log(msgModel.trim());
                        }
                    }
                }
            } catch (e) {
                res.write('Warning: Could not check models. Using default ID.\n');
                console.warn('Warning: Could not check models. Using default ID.');
            }
        }

        let newCount = 0;
        let skipCount = 0;
        let errorCount = 0;

        for (const img of images) {
            // Check cancellation (if connection closed)
            if (res.writableEnded || res.closed) {
                console.log('[MAINTENANCE] Connection closed by client.');
                break;
            }

            if (embeddingMap[img.id]) {
                skipCount++;
                if (skipCount % 100 === 0) process.stdout.write('.'); // Use process.stdout.write for dots
                continue;
            }

            // Parse Analysis
            let analysis = {};
            try {
                analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis) : img.analysis;
            } catch (e) { continue; }

            // Construct Text
            const textParts = [];
            if (analysis.summary) textParts.push(`Description: ${analysis.summary}`);
            if (analysis.scene_type) textParts.push(`Scene Type: ${analysis.scene_type}`);
            if (analysis.objects && analysis.objects.length > 0) textParts.push(`Objects: ${analysis.objects.join(', ')}`);
            if (analysis.tags && analysis.tags.length > 0) textParts.push(`Tags: ${analysis.tags.join(', ')}`);

            const inputText = textParts.join('. ');
            if (!inputText) continue;

            try {
                const response = await fetch('http://127.0.0.1:1234/v1/embeddings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        input: inputText,
                        model: modelId
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.data && data.data[0] && data.data[0].embedding) {
                        embeddingMap[img.id] = data.data[0].embedding;
                        newCount++;
                        res.write('+'); // Success dot
                        if (newCount % 10 === 0) console.log(`[EMBED] Generated ${newCount}...`);
                    } else {
                        errorCount++;
                        res.write('x');
                        console.log(`[EMBED] Invalid format for ${img.id}`);
                    }
                } else {
                    errorCount++;
                    res.write('E'); // Error
                    const errText = await response.text();
                    console.error(`[EMBED] API Error for ${img.id}: ${response.status} ${errText}`);
                }

            } catch (err) {
                errorCount++;
                res.write('!');
                console.error(`[EMBED] Fetch Error for ${img.id}:`, err.message);
            }

            // Save periodically
            if (newCount % 20 === 0 && newCount > 0) {
                fs.writeFileSync(OUTPUT_PATH, JSON.stringify(embeddingMap));
                console.log(`[EMBED] Autosaved ${newCount} embeddings.`);
            }
        }

        // Final Save
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(embeddingMap));
        res.write(`\n\nDone. Added: ${newCount}, Skipped: ${skipCount}, Errors: ${errorCount}\n`);
        res.end();

    } catch (err) {
        console.error('[MAINTENANCE] Embed Generation Error:', err);
        res.write(`\nError: ${err.message}\n`);
        res.end();
    }
});

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
        const oldExt = path.extname(oldPath); // e.g. '.jpg'
        const dir = path.dirname(oldPath);

        // Safety: If the user didn't provide an extension, auto-append the old one
        let finalNewFilename = newFilename;
        if (!path.extname(newFilename) && oldExt) {
            finalNewFilename += oldExt;
        }

        const newPath = path.join(dir, finalNewFilename);

        // Security / Validation
        if (fs.existsSync(newPath)) {
            return res.status(409).json({ error: 'A file with that name already exists in this folder.' });
        }

        // Rename on Disk
        fs.renameSync(oldPath, newPath);

        // Update Database
        db.prepare('UPDATE images SET filename = ?, path = ?, mtime = ? WHERE id = ?')
            .run(finalNewFilename, newPath, new Date().toISOString(), id);

        // Update Search Index
        generateSearchIndex();

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
app.post('/bulk-rename', (req, res) => {
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
        const thumbnailDirectory = path.join(__dirname, 'public/thumbnails');
        
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
        const imagesToRename = [];
        for (const id of ids) {
            const imageData = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
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
            generateSearchIndex();
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

// Start Server...
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);

    // Generate initial index after startup so we don't block
    setTimeout(() => {
        generateSearchIndex();
    }, 1000);
});
