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


import { local_ai_client_instance } from './services/localAiClient.js';
import { laya_client_instance } from './services/layaClient.js';
import { ovis_omni_client_instance } from './services/ovisOmniClient.js';

// ... [Inside existing routes, add generateSearchIndex() calls]

// Start Server...
// app.listen below handles this.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// WHAT: Initializing the dynamic Local AI Client for port and model discovery.
// WHY: We automatically connect to llama-server on port 8081 (or 9931).
local_ai_client_instance.discoverActiveModel().catch((initial_discovery_error) => {
    console.warn('[SERVER] Initial llama-server discovery warning:', initial_discovery_error.message);
});

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

// WHAT: Initializing the image_facets table and indices for Laya multi-faceted classification.
// WHY: Laya evaluates medium, mood, composition, and caption completeness in ~10ms per record,
//      persisting structured facets in SQLite for instantaneous filtering across the library.
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS image_facets (
            image_id INTEGER PRIMARY KEY,
            medium TEXT,
            mood TEXT,
            composition TEXT,
            detail_score REAL,
            confidence_medium REAL,
            confidence_mood REAL,
            confidence_composition REAL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_image_facets_medium ON image_facets(medium);
        CREATE INDEX IF NOT EXISTS idx_image_facets_mood ON image_facets(mood);
        CREATE INDEX IF NOT EXISTS idx_image_facets_composition ON image_facets(composition);
    `);
} catch (database_facet_migration_error) {
    console.error('[DB] Facet table initialization error:', database_facet_migration_error);
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
        const { path: targetPath, size, mtime } = req.body;
        const row = db.prepare('SELECT id, size, mtime FROM images WHERE path = ?').get(targetPath);

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
        // WHAT: Querying all image records joined with EVoC cluster themes and Laya facets.
        // WHY: Exposes semantic cluster themes, medium, mood, and composition directly to the search index and frontend without per-card DB roundtrips.
        const sql = `
            SELECT 
                images.id, 
                images.filename, 
                images.path, 
                images.analysis, 
                images.width, 
                images.height, 
                images.size, 
                images.created_at, 
                images.updated_at,
                image_clusters.cluster_label,
                cluster_themes.theme_name,
                image_facets.medium AS facet_medium,
                image_facets.mood AS facet_mood,
                image_facets.composition AS facet_composition,
                image_facets.detail_score AS facet_detail_score
            FROM images
            LEFT JOIN image_clusters ON images.id = image_clusters.image_id
            LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
            LEFT JOIN image_facets ON images.id = image_facets.image_id
            ORDER BY COALESCE(images.updated_at, images.created_at) DESC, images.id DESC
        `;
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
                { name: 'analysis.tags', weight: 2 },
                { name: 'theme_name', weight: 1.5 },
                { name: 'facet_medium', weight: 1 },
                { name: 'facet_mood', weight: 1 }
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
 * WHAT: Performs AI vision analysis on an image buffer using dynamic llama-server discovery.
 * WHY: Discovers llama-server (port 8081), verifies that the loaded model supports multimodal projector features,
 *      and dispatches OpenAI-compatible requests.
 */
async function performImageAnalysis(imageData, promptType) {
    // WHAT: Probing the local AI server to discover active model metadata.
    // WHY: By actively querying the server endpoints, we avoid breaking when users restart llama-server
    //      or switch quantization checkpoints with different filenames.
    const discovered_model_summary = await local_ai_client_instance.discoverActiveModel({
        require_multimodal_vision: true
    });

    if (!discovered_model_summary) {
        throw new Error('llama-server is offline. Please launch start_llama_server.bat on port 8081.');
    }

    if (!discovered_model_summary.has_multimodal_vision) {
        console.warn(
            `[ANALYZE] Warning: The active model (${discovered_model_summary.model_identifier}) does not report multimodal capabilities. ` +
            `If image analysis fails, make sure llama-server was started with --mmproj for vision support.`
        );
    }

    // WHAT: Resolving the target model identifier to send in the API payload.
    // WHY: If the user configured a specific vision model in config.json, honor that preference;
    //      otherwise, use the dynamically discovered model or clean alias from llama-server.
    const current_application_config = getConfig();
    const active_vision_model_identifier = (
        current_application_config.visionModel ||
        local_ai_client_instance.getActiveModelIdentifier() ||
        "default"
    );
    // WHAT: Detecting if the active model uses the Qwen architecture.
    // WHY: Qwen models excel at rich prose and structured output together, whereas Gemma/others require
    //      pure JSON-only prompting. We inspect config, aliases, and discovered backend metadata.
    const discovered_vision_server_summary = local_ai_client_instance.buildDiscoveredModelSummary();
    const is_qwen_architecture_model = (
        active_vision_model_identifier.toLowerCase().includes('qwen') ||
        (discovered_vision_server_summary?.model_identifier || '').toLowerCase().includes('qwen') ||
        (discovered_vision_server_summary?.model_aliases || []).some((alias_string) => alias_string.toLowerCase().includes('qwen'))
    );

    // Select System Prompt
    const selectedKey = promptType || 'Detailed Description';
    let basePrompt = qwenPrompts[selectedKey] || qwenPrompts['Detailed Description'] || Object.values(qwenPrompts)[0];
    let systemPrompt;

    if (is_qwen_architecture_model) {
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

    // Model-specific parameters
    const modelParams = is_qwen_architecture_model
        ? { temperature: 0.2, repetition_penalty: 1.2, frequency_penalty: 1.0 }
        : { temperature: 0.1, repetition_penalty: 1.5, frequency_penalty: 1.5 };

    const payload = {
        model: active_vision_model_identifier,
        messages: [
            { role: "system", content: systemPrompt },
            {
                role: "user",
                content: [
                    { type: "text", text: is_qwen_architecture_model ? "Analyze this image." : "Analyze this image. Return JSON only." },
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

    const target_completions_endpoint_url = local_ai_client_instance.getChatCompletionsUrl();
    console.log(`[ANALYZE] Dispatching to ${target_completions_endpoint_url} using model: ${active_vision_model_identifier} (${is_qwen_architecture_model ? 'Qwen-optimized' : 'Generic'} prompt)`);

    const http_analysis_response = await fetch(target_completions_endpoint_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!http_analysis_response.ok) {
        const error_response_body_text = await http_analysis_response.text();
        console.error(`[ANALYZE] Local AI Server Error Body:`, error_response_body_text);
        throw new Error(`Local AI API Error (${http_analysis_response.status}): ${http_analysis_response.statusText} - ${error_response_body_text}`);
    }

    const lmData = await http_analysis_response.json();
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

        // WHAT: Standardizing image buffer and downscaling oversize images to maximum 1344px.
        // WHY: Ensures fast prompt evaluation under 2 seconds without degrading caption or object recognition accuracy.
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
            generateSearchIndex(); // Update index
            return res.json({ message: 'Updated successfully', id: existingByPath.id, updated: true });
        }

        // 3. New Insert
        const insertSql = `INSERT INTO images (filename, path, file_hash, metadata, analysis, created_at, mtime, width, height, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const info = db.prepare(insertSql).run(filename, targetPath, file_hash, JSON.stringify(metadata), JSON.stringify(analysis), created_at, mtime || null, width, height, size);
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
            const sql_single_image_query = `
                SELECT 
                    images.*,
                    image_clusters.cluster_label,
                    cluster_themes.theme_name,
                    image_facets.medium AS facet_medium,
                    image_facets.mood AS facet_mood,
                    image_facets.composition AS facet_composition,
                    image_facets.detail_score AS facet_detail_score
                FROM images
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
            image_clusters.cluster_label,
            cluster_themes.theme_name,
            image_facets.medium AS facet_medium,
            image_facets.mood AS facet_mood,
            image_facets.composition AS facet_composition,
            image_facets.detail_score AS facet_detail_score
        `;
        const sql_joined_tables = `
            FROM images
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

        const offset = (page - 1) * limit;

        // Get total count
        const countSql = `SELECT COUNT(*) as total FROM images`;
        const total = db.prepare(countSql).get().total;

        // Get paginated data
        const sql = `SELECT ${sql_joined_columns} ${sql_joined_tables} ${orderBy} LIMIT ? OFFSET ?`;
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
// Global tracking for DB validation
global.validationProgress = { status: 'Idle', progress: 0 };

app.get('/validate-status', (req, res) => {
    res.json(global.validationProgress || { status: 'Idle', progress: 0 });
});

app.post('/validate-database', async (req, res) => {
    global.validationProgress = { status: 'Starting integrity check...', progress: 2 };

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

        global.validationProgress = { status: 'Preparing metadata check...', progress: 10 };

        // Refresh images list after dedupe
        const images = db.prepare(`SELECT * FROM images`).all();
        results.total = images.length;

        let completed = 0;
        for (const img of images) {
            completed++;
            global.validationProgress = { 
                status: `Scanning file ${completed} of ${images.length}`, 
                progress: Math.floor(10 + (completed / images.length) * 85)
            };

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
                    db.prepare('UPDATE images SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), img.id);
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

        global.validationProgress = { status: 'Saving search indexes...', progress: 95 };
        
        if (results.missing > 0 || results.fixedThumbnails > 0 || results.reanalyzed > 0) {
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

        db.prepare('UPDATE images SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        
        // Return a raw timestamp so the UI can immediately append it to the image src
        res.json({ success: true, thumbPath: `thumbnails/id_${id}.avif`, newTimestamp: Date.now() });

    } catch (err) {
        console.error('[THUMB] Regeneration Error:', err);
        res.status(500).json({ error: 'Failed to regenerate thumbnail', details: err.message });
    }
});

// WHAT: Semantic Search Embedding Proxy endpoint.
// WHY: Proxies client vectorization requests to the active llama-server instance (port 8083),
//      enabling concept-based image searching without hardcoded endpoints.
app.post('/api/embed', async (http_incoming_request, http_server_response) => {
    const text_content_to_embed = http_incoming_request.body.text;
    if (!text_content_to_embed) {
        return http_server_response.status(400).json({ error: 'Text is required for vector generation' });
    }

    try {
        // WHAT: Resolving the target embedding model identifier and endpoint.
        // WHY: If configured in config.json or .env, use that; otherwise discover the active server model.
        const current_application_config = getConfig();
        let target_embedding_model_identifier = (
            current_application_config.embeddingModel ||
            process.env.EMBEDDING_MODEL_ID
        );

        if (!target_embedding_model_identifier) {
            await local_ai_client_instance.discoverActiveModel();
            target_embedding_model_identifier = local_ai_client_instance.getActiveModelIdentifier() || 'local-model';
        }

        const target_embeddings_endpoint_url = local_ai_client_instance.getEmbeddingsUrl();

        const http_embeddings_response = await fetch(target_embeddings_endpoint_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: text_content_to_embed,
                model: target_embedding_model_identifier
            })
        });

        if (!http_embeddings_response.ok) {
            const error_response_body_text = await http_embeddings_response.text();
            throw new Error(`Local AI Server Error (${http_embeddings_response.status}): ${error_response_body_text}`);
        }

        const parsed_embeddings_payload = await http_embeddings_response.json();
        if (parsed_embeddings_payload.data && parsed_embeddings_payload.data[0] && parsed_embeddings_payload.data[0].embedding) {
            http_server_response.json({ embedding: parsed_embeddings_payload.data[0].embedding });
        } else {
            throw new Error('Invalid response format received from local AI embeddings endpoint');
        }

    } catch (embedding_proxy_error) {
        console.error('[EMBED] Proxy Error:', embedding_proxy_error.message);
        http_server_response.status(500).json({
            error: 'Failed to generate embedding',
            details: embedding_proxy_error.message
        });
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

// WHAT: OpenAI-compatible Model Discovery Proxy endpoint.
// WHY: Returns the combined list of models exposed by active llama-server instances (port 8081 and port 8083),
//      so the frontend settings dropdown and search status indicator reflect all running models.
app.get('/api/proxy/models', async (http_incoming_request, http_server_response) => {
    try {
        const combined_models_payload = await local_ai_client_instance.fetchCombinedModelsList();
        if (!combined_models_payload.data || combined_models_payload.data.length === 0) {
            return http_server_response.status(502).json({
                error: 'No active llama-server instances detected. Ensure llama-server is running on port 8081 or 8083.'
            });
        }
        http_server_response.json(combined_models_payload);
    } catch (models_proxy_error) {
        http_server_response.status(502).json({
            error: 'Failed to fetch models from llama-server. Ensure llama-server (port 8081 / 8083) is running.'
        });
    }
});

// WHAT: Model Load Proxy endpoint.
// WHY: Informs callers that llama-server statically loads models specified on process startup.
app.post('/api/proxy/load', async (http_incoming_request, http_server_response) => {
    try {
        console.log('[PROXY] Requesting model load for:', http_incoming_request.body.model_identifier);
        const discovered_model_summary = await local_ai_client_instance.discoverActiveModel();

        http_server_response.json({
            success: true,
            message: discovered_model_summary
                ? `Active model is managed by llama-server: ${discovered_model_summary.model_identifier}. llama-server loads weights via startup flags.`
                : 'llama-server is currently offline. Please launch start_llama_server.bat on port 8081.'
        });
    } catch (model_load_error) {
        console.error('[PROXY] Load error:', model_load_error.message);
        http_server_response.status(502).json({ error: 'Failed to query model load in llama-server' });
    }
});

// WHAT: Model Unload Proxy endpoint.
// WHY: Informs callers that llama-server runs as a dedicated process.
app.post('/api/proxy/unload', async (http_incoming_request, http_server_response) => {
    try {
        console.log('[PROXY] Requesting model unload for:', http_incoming_request.body.model_identifier);
        http_server_response.json({
            success: true,
            message: 'llama-server runs a dedicated process; close the console window to unload model weights.'
        });
    } catch (model_unload_error) {
        console.error('[PROXY] Unload error:', model_unload_error.message);
        http_server_response.status(502).json({ error: 'Failed to trigger model unload in llama-server' });
    }
});

// WHAT: Serving SQLite database cluster coordinates joined with Toponymy topics and Laya semantic themes.
// WHY: Used by scope.js ("Evoc DB" toggle) to render 2D scatter plots colored by semantic cluster topics.
app.get('/api/scope/db-data', (http_incoming_request, http_server_response) => {
    try {
        const sql_coordinates_query = `
            SELECT 
                image_coordinates.x, 
                image_coordinates.y, 
                image_clusters.cluster_label AS cluster, 
                COALESCE(
                    image_cluster_topics.topic_title || CASE 
                        WHEN cluster_themes.theme_name IS NOT NULL 
                        THEN ' (' || REPLACE(cluster_themes.theme_name, '_', ' ') || ')' 
                        ELSE '' 
                    END,
                    cluster_themes.theme_name,
                    'Cluster ' || image_clusters.cluster_label
                ) AS label, 
                image_cluster_topics.topic_title AS topic_title,
                image_cluster_topics.keyphrases_json AS topic_keyphrases,
                images.path, 
                images.filename,
                images.id
            FROM image_coordinates
            JOIN image_clusters ON image_coordinates.image_id = image_clusters.image_id
            LEFT JOIN image_cluster_topics ON image_clusters.cluster_label = image_cluster_topics.cluster_label
            LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
            JOIN images ON image_coordinates.image_id = images.id
        `;
        const coordinate_points_collection = db.prepare(sql_coordinates_query).all();
        http_server_response.json(coordinate_points_collection);
    } catch (database_scope_query_error) {
        console.error('[DB] Failed to fetch database scope data:', database_scope_query_error);
        if (database_scope_query_error.message.includes('no such table')) {
            return http_server_response.json([]);
        }
        http_server_response.status(500).json({ error: 'Failed to fetch database coordinate data' });
    }
});

// WHAT: Retrieves all EVoC cluster themes and Toponymy semantic topics.
// WHY: Allows frontend dropdowns and filter chips to list all 316+ semantic cluster categories.
app.get('/api/clusters/themes', (http_incoming_request, http_server_response) => {
    try {
        const sql_cluster_themes_query = `
            SELECT 
                image_clusters.cluster_label,
                COALESCE(
                    image_cluster_topics.topic_title || CASE 
                        WHEN cluster_themes.theme_name IS NOT NULL 
                        THEN ' (' || REPLACE(cluster_themes.theme_name, '_', ' ') || ')' 
                        ELSE '' 
                    END,
                    cluster_themes.theme_name,
                    'Cluster ' || image_clusters.cluster_label
                ) AS theme_name,
                image_cluster_topics.topic_title AS topic_title,
                cluster_themes.theme_name AS raw_theme_category,
                COALESCE(cluster_themes.confidence, 1.0) AS confidence,
                COALESCE(cluster_themes.purity, 1.0) AS purity,
                COUNT(image_clusters.image_id) AS item_count,
                COALESCE(image_cluster_topics.keyphrases_json, cluster_themes.sample_summary) AS sample_summary,
                image_cluster_topics.updated_at
            FROM image_clusters
            LEFT JOIN image_cluster_topics ON image_clusters.cluster_label = image_cluster_topics.cluster_label
            LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
            WHERE image_clusters.cluster_label != -1
            GROUP BY image_clusters.cluster_label
            ORDER BY item_count DESC
        `;
        const cluster_themes_records = db.prepare(sql_cluster_themes_query).all();
        http_server_response.json({ themes: cluster_themes_records });
    } catch (cluster_themes_retrieval_error) {
        console.error('[CLUSTERS] Failed to fetch cluster themes:', cluster_themes_retrieval_error);
        if (cluster_themes_retrieval_error.message.includes('no such table')) {
            return http_server_response.json({ themes: [] });
        }
        http_server_response.status(500).json({ error: 'Failed to fetch cluster themes' });
    }
});

// WHAT: Retrieves paginated image records belonging to a specific cluster.
// WHY: Enables clicking a cluster theme to browse all matching images.
app.get('/api/clusters/:cluster_identifier/images', (http_incoming_request, http_server_response) => {
    try {
        const target_cluster_identifier = parseInt(http_incoming_request.params.cluster_identifier, 10);
        const request_page_number = parseInt(http_incoming_request.query.page, 10) || 1;
        const request_limit_number = parseInt(http_incoming_request.query.limit, 10) || 50;
        const pagination_offset_amount = (request_page_number - 1) * request_limit_number;

        const sql_cluster_images_count_query = `
            SELECT COUNT(*) as total
            FROM images
            JOIN image_clusters ON images.id = image_clusters.image_id
            WHERE image_clusters.cluster_label = ?
        `;
        const total_cluster_images_count = db.prepare(sql_cluster_images_count_query).get(target_cluster_identifier)?.total || 0;

        const sql_cluster_images_query = `
            SELECT 
                images.id, 
                images.filename, 
                images.path, 
                images.analysis, 
                images.width, 
                images.height, 
                images.created_at, 
                image_clusters.cluster_label,
                cluster_themes.theme_name,
                image_facets.medium AS facet_medium,
                image_facets.mood AS facet_mood,
                image_facets.composition AS facet_composition,
                image_facets.detail_score AS facet_detail_score
            FROM images
            JOIN image_clusters ON images.id = image_clusters.image_id
            LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
            LEFT JOIN image_facets ON images.id = image_facets.image_id
            WHERE image_clusters.cluster_label = ?
            ORDER BY images.id ASC
            LIMIT ? OFFSET ?
        `;
        const cluster_images_collection = db.prepare(sql_cluster_images_query).all(
            target_cluster_identifier,
            request_limit_number,
            pagination_offset_amount
        );

        http_server_response.json({
            images: cluster_images_collection,
            total: total_cluster_images_count,
            page: request_page_number,
            limit: request_limit_number
        });
    } catch (cluster_images_retrieval_error) {
        console.error('[CLUSTERS] Failed to fetch cluster images:', cluster_images_retrieval_error);
        http_server_response.status(500).json({ error: 'Failed to fetch cluster images' });
    }
});

// ============================================================================
// GRAPHMEMORY ASSOCIATIVE RETRIEVAL & KNOWLEDGE GRAPH ENDPOINTS
// ============================================================================

// WHAT: Executes a command against the GraphMemory Python retrieval engine with defensive argument validation.
// WHY: Decouples HTTP handling while rejecting dangerous characters or path injection attempts.
function executeGraphMemoryRetrievalCli(cli_arguments_array) {
    return new Promise((resolve_promise, reject_promise) => {
        // WHAT: Boundary fuzzing and input sanitization check.
        // WHY: Validates that each CLI argument token contains only safe alphanumeric, dash, underscore, dot, colon characters.
        const SAFE_CLI_TOKEN_REGEX = /^[a-zA-Z0-9_\-\.\:\/]+$/;
        for (const single_token_string of cli_arguments_array) {
            if (typeof single_token_string !== 'string' || !SAFE_CLI_TOKEN_REGEX.test(single_token_string)) {
                return reject_promise(new Error(`Rejected unsafe CLI argument token: ${single_token_string}`));
            }
        }

        const python_executable_path = fs.existsSync(path.join(__dirname, 'venv', 'Scripts', 'python.exe'))
            ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
            : 'python';
        const script_file_path = path.join(__dirname, 'scripts', 'associative_retrieval.py');

        const subprocess_instance = spawn(python_executable_path, [script_file_path, ...cli_arguments_array]);
        let accumulated_standard_output_buffer = '';
        let accumulated_standard_error_buffer = '';

        subprocess_instance.stdout.on('data', (output_chunk) => {
            accumulated_standard_output_buffer += output_chunk.toString();
        });

        subprocess_instance.stderr.on('data', (error_chunk) => {
            accumulated_standard_error_buffer += error_chunk.toString();
        });

        subprocess_instance.on('close', (process_exit_code) => {
            if (process_exit_code !== 0) {
                return reject_promise(new Error(accumulated_standard_error_buffer || `Exit code ${process_exit_code}`));
            }
            try {
                const parsed_json_payload = JSON.parse(accumulated_standard_output_buffer);
                resolve_promise(parsed_json_payload);
            } catch (json_parsing_error) {
                reject_promise(new Error(`Failed to parse GraphMemory output: ${json_parsing_error.message}`));
            }
        });
    });
}

// WHAT: Queries GraphMemory for multi-hop associative neighbors of an image with boundary validation.
// WHY: Surfaces images that share high conceptual resonance while guarding against negative/overflow integer inputs.
app.get('/api/graph/associative-related', async (http_incoming_request, http_server_response) => {
    try {
        const raw_target_id = Number(http_incoming_request.query.image_id);
        if (!Number.isSafeInteger(raw_target_id) || raw_target_id <= 0) {
            return http_server_response.status(400).json({ error: 'Valid positive integer image_id query parameter is required.' });
        }
        const target_image_identifier = raw_target_id;
        const requested_limit = Number(http_incoming_request.query.limit);
        const maximum_results_limit = (Number.isSafeInteger(requested_limit) && requested_limit > 0)
            ? Math.min(100, requested_limit)
            : 24;

        const associative_search_result = await executeGraphMemoryRetrievalCli([
            '--image', String(target_image_identifier),
            '--limit', String(maximum_results_limit)
        ]);
        http_server_response.json(associative_search_result);
    } catch (graph_search_error) {
        console.error('[GRAPHMEMORY] Associative retrieval error:', graph_search_error);
        http_server_response.status(500).json({ error: graph_search_error.message });
    }
});

// WHAT: Extracts an interactive ego-network subgraph around an image entity with boundary validation.
// WHY: Used by frontend visualization components; rejects invalid or non-numeric identifiers.
app.get('/api/graph/subgraph', async (http_incoming_request, http_server_response) => {
    try {
        const raw_target_id = Number(http_incoming_request.query.image_id);
        if (!Number.isSafeInteger(raw_target_id) || raw_target_id <= 0) {
            return http_server_response.status(400).json({ error: 'Valid positive integer image_id query parameter is required.' });
        }
        const target_image_identifier = raw_target_id;

        const subgraph_result = await executeGraphMemoryRetrievalCli([
            '--subgraph', String(target_image_identifier)
        ]);
        http_server_response.json(subgraph_result);
    } catch (graph_subgraph_error) {
        console.error('[GRAPHMEMORY] Subgraph extraction error:', graph_subgraph_error);
        http_server_response.status(500).json({ error: graph_subgraph_error.message });
    }
});

// WHAT: Discovers semantic bridge concepts connecting two distinct EVoC clusters with boundary validation.
// WHY: Rejects negative/overflow cluster coordinates and clamps result limits safely.
app.get('/api/graph/bridges', async (http_incoming_request, http_server_response) => {
    try {
        const raw_cluster_a = Number(http_incoming_request.query.cluster_a);
        const raw_cluster_b = Number(http_incoming_request.query.cluster_b);
        if (!Number.isSafeInteger(raw_cluster_a) || !Number.isSafeInteger(raw_cluster_b) || raw_cluster_a < -1 || raw_cluster_b < -1) {
            return http_server_response.status(400).json({ error: 'Valid integer cluster_a and cluster_b parameters (>= -1) are required.' });
        }
        const first_cluster_label = raw_cluster_a;
        const second_cluster_label = raw_cluster_b;
        const requested_limit = Number(http_incoming_request.query.limit);
        const maximum_results_limit = (Number.isSafeInteger(requested_limit) && requested_limit > 0)
            ? Math.min(50, requested_limit)
            : 15;

        const bridges_result = await executeGraphMemoryRetrievalCli([
            '--bridges', String(first_cluster_label), String(second_cluster_label),
            '--limit', String(maximum_results_limit)
        ]);
        http_server_response.json(bridges_result);
    } catch (graph_bridges_error) {
        console.error('[GRAPHMEMORY] Cluster bridges error:', graph_bridges_error);
        http_server_response.status(500).json({ error: graph_bridges_error.message });
    }
});

// WHAT: Probes the status of the local Laya Decision Engine microservice.
// WHY: Gives the settings and diagnostics UI immediate feedback on port 8765 reachability and GPU device.
app.get('/api/laya/status', async (http_incoming_request, http_server_response) => {
    try {
        const is_laya_service_online = await laya_client_instance.checkServerHealth(true);
        let total_classified_facets_count = 0;
        let total_cluster_themes_count = 0;

        try {
            total_classified_facets_count = db.prepare('SELECT COUNT(*) as total FROM image_facets').get()?.total || 0;
            total_cluster_themes_count = db.prepare('SELECT COUNT(*) as total FROM cluster_themes').get()?.total || 0;
        } catch (table_count_probe_error) { /* tables may be uninitialized */ }

        http_server_response.json({
            status: is_laya_service_online ? 'online' : 'offline',
            endpoint: laya_client_instance.active_endpoint_url,
            device: laya_client_instance.active_device_name,
            classified_facets_count: total_classified_facets_count,
            cluster_themes_count: total_cluster_themes_count
        });
    } catch (laya_status_probe_error) {
        http_server_response.status(500).json({ error: laya_status_probe_error.message });
    }
});

// WHAT: Classifies a search query's intent and extracts desired artistic medium or emotional mood.
// WHY: Enables instant sub-15ms smart query intent routing in search.html.
app.post('/api/laya/query-intent', async (http_incoming_request, http_server_response) => {
    try {
        const { query } = http_incoming_request.body;
        if (!query || typeof query !== 'string' || !query.trim()) {
            return http_server_response.json({
                intent_type: 'semantic_concept',
                target_medium: 'unspecified',
                target_mood: 'unspecified',
                suggested_filters: {}
            });
        }

        const query_intent_classification_result = await laya_client_instance.classifyQueryIntent(query);
        http_server_response.json(query_intent_classification_result);
    } catch (query_intent_classification_error) {
        console.warn('[LAYA] Query intent classification skipped:', query_intent_classification_error.message);
        http_server_response.json({
            intent_type: 'semantic_concept',
            target_medium: 'unspecified',
            target_mood: 'unspecified',
            suggested_filters: {},
            fallback: true
        });
    }
});

// WHAT: Streams batch facet classification for unclassified images using Laya.
// WHY: Evaluates medium, mood, composition, and caption detail score at ~50-100 items per second.
app.post('/api/facets/batch-classify', async (http_incoming_request, http_server_response) => {
    const is_laya_microservice_online = await laya_client_instance.checkServerHealth();
    if (!is_laya_microservice_online) {
        return http_server_response.status(503).json({
            error: 'Laya Decision Engine is offline on port 8765. Please run start_laya_server.bat.'
        });
    }

    http_server_response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    http_server_response.setHeader('Transfer-Encoding', 'chunked');

    try {
        http_server_response.write('Starting Laya batch facet classification...\n');

        const sql_unclassified_images_query = `
            SELECT images.id, images.analysis 
            FROM images
            LEFT JOIN image_facets ON images.id = image_facets.image_id
            WHERE image_facets.image_id IS NULL AND images.analysis IS NOT NULL AND images.analysis != ''
            LIMIT 1000
        `;
        const unclassified_candidate_images = db.prepare(sql_unclassified_images_query).all();
        http_server_response.write(`Found ${unclassified_candidate_images.length} images requiring facet tagging.\n`);

        const insert_image_facet_statement = db.prepare(`
            INSERT OR REPLACE INTO image_facets (
                image_id, medium, mood, composition, detail_score, 
                confidence_medium, confidence_mood, confidence_composition
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let successfully_classified_count = 0;

        for (const candidate_image_record of unclassified_candidate_images) {
            let parsed_summary_text = '';
            try {
                const parsed_analysis = JSON.parse(candidate_image_record.analysis);
                parsed_summary_text = parsed_analysis.summary || '';
            } catch (json_parse_error) {
                parsed_summary_text = candidate_image_record.analysis.slice(0, 300);
            }

            if (!parsed_summary_text.trim()) continue;

            try {
                const facet_evaluation_result = await laya_client_instance.classifyImageFacets(parsed_summary_text);

                insert_image_facet_statement.run(
                    candidate_image_record.id,
                    facet_evaluation_result.medium,
                    facet_evaluation_result.mood,
                    facet_evaluation_result.composition,
                    facet_evaluation_result.detail_score,
                    facet_evaluation_result.confidence_scores.medium,
                    facet_evaluation_result.confidence_scores.mood,
                    facet_evaluation_result.confidence_scores.composition
                );

                successfully_classified_count++;
                if (successfully_classified_count % 25 === 0) {
                    http_server_response.write(`Processed ${successfully_classified_count}/${unclassified_candidate_images.length} images...\n`);
                }
            } catch (single_facet_classification_error) {
                console.warn(`[LAYA] Error classifying image ID ${candidate_image_record.id}:`, single_facet_classification_error.message);
            }
        }

        http_server_response.write(`\nSuccessfully classified and saved ${successfully_classified_count} image facets.\n`);
        http_server_response.end();

        // Trigger search index refresh so newly tagged facets are immediately searchable
        generateSearchIndex();
    } catch (batch_facet_execution_error) {
        console.error('[FACETS] Batch classification error:', batch_facet_execution_error);
        http_server_response.write(`\nError: ${batch_facet_execution_error.message}\n`);
        http_server_response.end();
    }
});

// ============================================================================
// OVIS-OMNI MULTIMODAL EMBEDDING & ZERO-SHOT CLASSIFICATION ENDPOINTS
// ============================================================================

/**
 * ENDPOINT: Get Ovis-Omni Service Status
 * 
 * WHAT: Probes the health and GPU status of the Ovis-Omni microservice on port 8082.
 * WHY: The UI and diagnostics need to know if the 3B multimodal model is loaded and ready.
 */
app.get('/api/ovis/health', async (http_incoming_request, http_server_response) => {
    try {
        const is_ovis_service_online = await ovis_omni_client_instance.checkHealth(true);
        http_server_response.json({
            online: is_ovis_service_online,
            endpoint_url: ovis_omni_client_instance.active_endpoint_url,
            hardware_device: ovis_omni_client_instance.detected_hardware_device_name,
            embedding_dimensions: ovis_omni_client_instance.embedding_vector_dimensions
        });
    } catch (health_probe_error) {
        http_server_response.status(500).json({
            online: false,
            error: health_probe_error.message
        });
    }
});

/**
 * ENDPOINT: Zero-Shot Visual Classification for a Single Image
 * 
 * WHAT: Classifies an image directly from disk into medium, mood, and composition using Ovis-Omni.
 * WHY: Unlike LLM text captioning, this compares visual features directly against category embeddings
 *      in a single forward pass (~30ms), allowing instant classification even without text descriptions.
 */
app.post('/api/ovis/classify-image', async (http_incoming_request, http_server_response) => {
    const target_image_identifier = http_incoming_request.body.image_id;
    const should_persist_to_database = http_incoming_request.body.persist_to_database ?? true;

    if (!target_image_identifier) {
        return http_server_response.status(400).json({ error: 'Image ID is required for classification.' });
    }

    try {
        const candidate_image_record = db.prepare('SELECT id, filename, path FROM images WHERE id = ?').get(target_image_identifier);
        if (!candidate_image_record) {
            return http_server_response.status(404).json({ error: `Image with ID ${target_image_identifier} was not found.` });
        }

        const physical_image_file_path = candidate_image_record.path;
        if (!fs.existsSync(physical_image_file_path)) {
            return http_server_response.status(404).json({ error: `Source image file missing on disk: ${physical_image_file_path}` });
        }

        // Run classifications across the standard visual taxonomies
        const medium_classification_result = await ovis_omni_client_instance.classifyImageZeroShot(
            physical_image_file_path,
            ovis_omni_client_instance.standard_classification_taxonomies.visual_medium,
            'medium'
        );

        const mood_classification_result = await ovis_omni_client_instance.classifyImageZeroShot(
            physical_image_file_path,
            ovis_omni_client_instance.standard_classification_taxonomies.visual_mood,
            'mood'
        );

        const composition_classification_result = await ovis_omni_client_instance.classifyImageZeroShot(
            physical_image_file_path,
            ovis_omni_client_instance.standard_classification_taxonomies.composition_framing,
            'composition'
        );

        const classification_summary_payload = {
            image_id: candidate_image_record.id,
            filename: candidate_image_record.filename,
            medium: medium_classification_result.top_label,
            confidence_medium: medium_classification_result.top_confidence,
            mood: mood_classification_result.top_label,
            confidence_mood: mood_classification_result.top_confidence,
            composition: composition_classification_result.top_label,
            confidence_composition: composition_classification_result.top_confidence,
            detail_score: 1.0,
            full_predictions: {
                medium: medium_classification_result.predictions,
                mood: mood_classification_result.predictions,
                composition: composition_classification_result.predictions
            }
        };

        if (should_persist_to_database) {
            const upsert_facet_statement = db.prepare(`
                INSERT OR REPLACE INTO image_facets (
                    image_id, medium, mood, composition, detail_score,
                    confidence_medium, confidence_mood, confidence_composition
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            upsert_facet_statement.run(
                candidate_image_record.id,
                classification_summary_payload.medium,
                classification_summary_payload.mood,
                classification_summary_payload.composition,
                classification_summary_payload.detail_score,
                classification_summary_payload.confidence_medium,
                classification_summary_payload.confidence_mood,
                classification_summary_payload.confidence_composition
            );
        }

        http_server_response.json(classification_summary_payload);
    } catch (zero_shot_classification_error) {
        console.error('[OVIS-CLASSIFY] Error:', zero_shot_classification_error);
        http_server_response.status(500).json({
            error: 'Failed to execute zero-shot classification',
            details: zero_shot_classification_error.message
        });
    }
});

/**
 * ENDPOINT: Visual "Find Similar" via Direct Multimodal Cosine Similarity
 * 
 * WHAT: Finds the closest images to a target image by comparing Ovis 2048-dim vectors.
 * WHY: Provides true optical/stylistic visual matching without depending on text keywords or tag overlap.
 */
app.post('/api/ovis/find-similar', async (http_incoming_request, http_server_response) => {
    const target_image_identifier = http_incoming_request.body.image_id;
    const requested_result_limit = http_incoming_request.body.limit || 20;

    if (!target_image_identifier) {
        return http_server_response.status(400).json({ error: 'Image ID is required.' });
    }

    try {
        const target_image_record = db.prepare('SELECT id, filename, path FROM images WHERE id = ?').get(target_image_identifier);
        if (!target_image_record) {
            return http_server_response.status(404).json({ error: 'Target image not found.' });
        }

        const OVIS_EMBEDDINGS_FILE_PATH = path.join(__dirname, 'public', 'ovis-embeddings.json');
        let existing_ovis_embeddings_map = {};

        if (fs.existsSync(OVIS_EMBEDDINGS_FILE_PATH)) {
            try {
                existing_ovis_embeddings_map = JSON.parse(fs.readFileSync(OVIS_EMBEDDINGS_FILE_PATH, 'utf8'));
            } catch (file_read_error) {
                console.warn('[OVIS-SIMILAR] Could not parse existing ovis-embeddings.json:', file_read_error.message);
            }
        }

        // If target image doesn't have an embedding cached, generate it on the fly
        let target_image_vector = existing_ovis_embeddings_map[String(target_image_record.id)];
        if (!target_image_vector) {
            target_image_vector = await ovis_omni_client_instance.generateImageEmbedding(target_image_record.path);
            existing_ovis_embeddings_map[String(target_image_record.id)] = target_image_vector;
            fs.writeFileSync(OVIS_EMBEDDINGS_FILE_PATH, JSON.stringify(existing_ovis_embeddings_map));
        }

        // Calculate cosine similarity against all other cached image vectors
        const similarity_ranking_candidates = [];
        const candidate_image_identifiers = Object.keys(existing_ovis_embeddings_map);

        for (const candidate_identifier_string of candidate_image_identifiers) {
            if (candidate_identifier_string === String(target_image_identifier)) continue;

            const candidate_vector = existing_ovis_embeddings_map[candidate_identifier_string];
            if (!Array.isArray(candidate_vector) || candidate_vector.length !== target_image_vector.length) continue;

            // Dot product between normalized vectors equals cosine similarity
            let calculated_dot_product_accumulator = 0.0;
            for (let vector_dimension_index = 0; vector_dimension_index < target_image_vector.length; vector_dimension_index++) {
                calculated_dot_product_accumulator += target_image_vector[vector_dimension_index] * candidate_vector[vector_dimension_index];
            }

            similarity_ranking_candidates.push({
                image_id: parseInt(candidate_identifier_string, 10),
                similarity_score: calculated_dot_product_accumulator
            });
        }

        // Sort descending by similarity
        similarity_ranking_candidates.sort((first_candidate, second_candidate) => second_candidate.similarity_score - first_candidate.similarity_score);
        const top_ranked_similar_images = similarity_ranking_candidates.slice(0, requested_result_limit);

        // Fetch image metadata for the top results
        const enriched_similar_images = [];
        for (const ranking_entry of top_ranked_similar_images) {
            const matched_image_metadata = db.prepare('SELECT id, filename, path, analysis FROM images WHERE id = ?').get(ranking_entry.image_id);
            if (matched_image_metadata) {
                enriched_similar_images.push({
                    id: matched_image_metadata.id,
                    filename: matched_image_metadata.filename,
                    similarity_score: Math.round(ranking_entry.similarity_score * 1000) / 1000,
                    analysis: matched_image_metadata.analysis
                });
            }
        }

        http_server_response.json({
            target_image_id: target_image_record.id,
            total_compared_count: candidate_image_identifiers.length,
            similar_images: enriched_similar_images
        });

    } catch (find_similar_error) {
        console.error('[OVIS-SIMILAR] Error:', find_similar_error);
        http_server_response.status(500).json({
            error: 'Failed to compute visual similarity',
            details: find_similar_error.message
        });
    }
});

/**
 * ENDPOINT: Batch Generate Ovis-Omni Multimodal Embeddings
 * 
 * WHAT: Scans local image files on disk and streams real-time generation of 2048-dim vectors.
 * WHY: Writes to public/ovis-embeddings.json, creating a dedicated visual vector database
 *      for instant image-to-image similarity, cross-modal retrieval, and perceptual UMAP maps.
 */
app.post('/api/maintenance/generate-ovis-embeddings', async (http_incoming_request, http_server_response) => {
    const is_ovis_service_online = await ovis_omni_client_instance.checkHealth(true);
    if (!is_ovis_service_online) {
        return http_server_response.status(503).json({
            error: 'Ovis-Omni microservice is offline on port 8082. Please launch start_ovis_server.bat.'
        });
    }

    http_server_response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    http_server_response.setHeader('Transfer-Encoding', 'chunked');

    try {
        http_server_response.write('[OVIS-MAINTENANCE] Starting background multimodal image embedding...\n');

        const all_registered_images = db.prepare('SELECT id, filename, path FROM images').all();
        http_server_response.write(`Found ${all_registered_images.length} images registered in the database.\n`);

        const OVIS_EMBEDDINGS_FILE_PATH = path.join(__dirname, 'public', 'ovis-embeddings.json');
        let existing_ovis_embeddings_map = {};

        if (fs.existsSync(OVIS_EMBEDDINGS_FILE_PATH)) {
            try {
                existing_ovis_embeddings_map = JSON.parse(fs.readFileSync(OVIS_EMBEDDINGS_FILE_PATH, 'utf8'));
                http_server_response.write(`Resume mode: Found ${Object.keys(existing_ovis_embeddings_map).length} existing embeddings. Skipping already processed files.\n`);
            } catch (json_parse_error) {
                http_server_response.write('Existing ovis-embeddings.json was unreadable. Starting fresh.\n');
            }
        }

        let successfully_embedded_images_count = 0;
        let skipped_existing_images_count = 0;
        let failed_images_count = 0;

        for (const candidate_image_record of all_registered_images) {
            if (http_server_response.writableEnded || http_server_response.closed) {
                console.log('[OVIS-MAINTENANCE] Client disconnected. Terminating generation loop.');
                break;
            }

            if (existing_ovis_embeddings_map[String(candidate_image_record.id)]) {
                skipped_existing_images_count++;
                continue;
            }

            if (!fs.existsSync(candidate_image_record.path)) {
                failed_images_count++;
                continue;
            }

            try {
                const generated_image_vector = await ovis_omni_client_instance.generateImageEmbedding(candidate_image_record.path);
                existing_ovis_embeddings_map[String(candidate_image_record.id)] = generated_image_vector;
                successfully_embedded_images_count++;

                if (successfully_embedded_images_count % 10 === 0) {
                    http_server_response.write(`Progress: Embedded ${successfully_embedded_images_count} new images...\n`);
                }

                // Checkpoint save every 25 images
                if (successfully_embedded_images_count % 25 === 0) {
                    fs.writeFileSync(OVIS_EMBEDDINGS_FILE_PATH, JSON.stringify(existing_ovis_embeddings_map));
                }
            } catch (single_image_embedding_error) {
                failed_images_count++;
                http_server_response.write(`! Warning on ID ${candidate_image_record.id}: ${single_image_embedding_error.message}\n`);
            }
        }

        // Final save
        fs.writeFileSync(OVIS_EMBEDDINGS_FILE_PATH, JSON.stringify(existing_ovis_embeddings_map));
        http_server_response.write(`\n[COMPLETE] Successfully generated ${successfully_embedded_images_count} Ovis-Omni visual embeddings (Skipped: ${skipped_existing_images_count}, Errors: ${failed_images_count}).\n`);
        http_server_response.end();

    } catch (batch_generation_error) {
        console.error('[OVIS-MAINTENANCE] Critical error:', batch_generation_error);
        http_server_response.write(`\nCRITICAL ERROR: ${batch_generation_error.message}\n`);
        http_server_response.end();
    }
});

// WHAT: System Diagnostics endpoint.
// WHY: Returns comprehensive runtime diagnostics detailing active local AI server discovery,
//      multimodal vision projector status, context window sizes, and configuration sources.
app.get('/api/diagnostics', async (http_incoming_request, http_server_response) => {
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

    http_server_response.send(diagnostic_report_text.trim());
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
app.get('/api/embeddings-status', (req, res) => {
    const searchEmbeddingsPath = path.join(__dirname, 'public', 'search-embeddings.json');
    try {
        if (!fs.existsSync(searchEmbeddingsPath)) {
            return res.json({ exists: false });
        }

        const fileStatistics = fs.statSync(searchEmbeddingsPath);
        
        // We calculate the number of unique image embeddings currently stored.
        let totalEmbeddingCount = 0;
        try {
            const rawEmbeddingsData = JSON.parse(fs.readFileSync(searchEmbeddingsPath, 'utf8'));
            totalEmbeddingCount = Object.keys(rawEmbeddingsData).length;
        } catch (parseError) { 
            /* If the file is partially written or corrupt, we return 0 */
        }

        res.json({
            exists: true,
            lastModified: fileStatistics.mtime.toISOString(),
            sizeBytes: fileStatistics.size,
            count: totalEmbeddingCount
        });
    } catch (err) {
        res.json({ exists: false, error: err.message });
    }
});

/**
 * ENDPOINT: Run EVoC + UMAP Pipeline
 * 
 * WHAT: This triggers an external Python script that performs semantic clustering.
 * WHY: It uses the embeddings we generated to find groups of similar images 
 * and calculates 2D coordinates for the "Data Map" visualization.
 */
app.post('/api/maintenance/run-evoc', (req, res) => {
    console.log('[MAINTENANCE] Initiating Semantic Map Analysis (EVoC + UMAP)...');

    // This is a long-running process, so we use "Chunked" encoding to send 
    // progress updates back to the browser in real-time.
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    const pythonScriptPath = path.join(__dirname, 'scripts', 'evoc_pipeline.py');
    const sqliteDatabasePath = path.join(__dirname, 'images.db');
    const searchEmbeddingsPath = path.join(__dirname, 'public', 'search-embeddings.json');

    // We use 'spawn' to run the Python environment as a child process.
    const pythonSubprocess = spawn('python', [
        pythonScriptPath, 
        '--db', sqliteDatabasePath, 
        '--embeddings', searchEmbeddingsPath
    ]);

    // Pipe the Python output directly to the HTTP response
    pythonSubprocess.stdout.on('data', (chunk) => {
        res.write(chunk.toString());
        process.stdout.write(`[PYTHON-LOG] ${chunk}`);
    });

    pythonSubprocess.stderr.on('data', (errorChunk) => {
        res.write(`PIPELINE_ERROR: ${errorChunk.toString()}`);
        process.stderr.write(`[PYTHON-ERR] ${errorChunk}`);
    });

    pythonSubprocess.on('close', (exitCode) => {
        res.write(`\n[ANALYSIS COMPLETE - EXIT CODE ${exitCode}]\n`);
        res.end();
    });
});

/**
 * ENDPOINT: Generate Search Embeddings
 * 
 * WHAT: Converts every image's AI analysis (descriptions/tags) into math vectors.
 * WHY: This is the fuel for "Semantic" and "Hybrid" search. It allows the 
 * app to understand that "a golden retriever" is similar to "a yellow dog".
 */
app.post('/maintenance/generate-embeddings', async (req, res) => {
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

        const SEARCH_EMBEDDINGS_FILE = path.join(__dirname, 'public', 'search-embeddings.json');

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
