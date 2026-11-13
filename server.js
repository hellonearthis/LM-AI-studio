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
import { repairTruncatedJson, deduplicateTags } from './services/server/analysisHelpers.js';
import {
    buildContiguousVectorData,
    normalizeQueryVectorToFloat32,
    computeContiguousCpuDotProducts
} from './services/server/contiguousVectorMath.js';
import { createDicerRouter } from "./routes/dicerRoutes.js";
import { createScopeAndGraphRouter } from "./routes/scopeAndGraphRoutes.js";
import { createLayaAndOvisRouter } from "./routes/layaAndOvisRoutes.js";
import { createImageAndLibraryRouter } from "./routes/imageAndLibraryRoutes.js";
import { createMaintenanceRouter } from "./routes/maintenanceRoutes.js";
import {
    initialize_prompt_dicer_tables,
    save_diced_prompt_record,
    dice_and_save_image_record,
    validate_and_repair_diced_prompts,
    evaluate_caption_visual_grounding_for_image,
    get_diced_catalog_statistics,
    get_all_diced_prompts,
    get_diced_prompt_by_identifier,
    get_ingredients_catalog_by_slot,
    get_visually_compatible_ingredients,
    get_undiced_candidate_images,
    update_diced_prompt_review_status,
    export_active_learning_dataset_jsonl,
    fetch_relevant_influences_for_ingredients,
    fetch_transplant_candidate_pools,
    build_review_queue_cards,
    append_review_event_and_sync_item,
    get_calibration_dashboard_summary
} from './services/promptDicerDb.js';
import {
    execute_prompt_dicing_pipeline,
    detect_ingredient_clashes,
    assemble_remixed_prompt_text,
    extract_prompts_from_image_records,
    compute_normalized_vector_cosine_similarity,
    build_laya_slot_and_state_questions,
    apply_laya_confidence_gates,
    DEFAULT_TRANSPLANT_LOCKED_SLOTS,
    resolve_ingredient_influence_closure,
    solve_constraint_transplant_beam,
    verify_prompt_round_trip,
    ALLOWED_INGREDIENT_SLOTS
} from './services/promptDicerService.js';

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

// WHAT: Configuring SQLite Write-Ahead Logging (WAL), memory-mapped temp store, and a 64 MB page cache.
// WHY: `images.db` is >200 MB; WAL + NORMAL sync prevents read/write lock contention between the UI
//      and background batch/dicer jobs while speeding up multi-table JOIN queries.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');

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
    );
    CREATE INDEX IF NOT EXISTS idx_images_file_hash ON images(file_hash);
    CREATE INDEX IF NOT EXISTS idx_images_path ON images(path);
    CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at);
    CREATE INDEX IF NOT EXISTS idx_images_updated_at ON images(updated_at);
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
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_image_clusters_label ON image_clusters(cluster_label);`);
    } catch (_cluster_index_err) {
        // `image_clusters` may not exist until `evoc_pipeline.py` runs for the first time
    }
} catch (database_facet_migration_error) {
    console.error('[DB] Facet table initialization error:', database_facet_migration_error);
}

// WHAT: Initializing the Prompt Dicer and Ingredient Catalog tables and indices.
// WHY: Persists Master Records (Pass C), atomic ingredients with slots and measurements (Pass B),
//      and directed influence/clash edges (Pass D) into SQLite.
try {
    initialize_prompt_dicer_tables(db);
    console.log('[DB] Prompt Dicer tables initialized successfully.');
} catch (database_dicer_migration_error) {
    console.error('[DB] Prompt Dicer table initialization error:', database_dicer_migration_error);
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
// ============================================================================
// SEARCH INDEX GENERATION
// ============================================================================
// WHAT: Generates the Fuse.js index and lightweight `search-data.json` payload from SQLite.
// WHY: Strips bulky `diced_prompt` Master Record blobs (which `search-worker.js` does not index or render)
//      so `search-data.json` stays compact (~20 MB instead of ~96+ MB) and loads rapidly in the browser.
let is_search_index_writing = false;
let has_pending_search_index_write = false;

async function generateSearchIndex() {
    if (is_search_index_writing) {
        has_pending_search_index_write = true;
        return;
    }
    is_search_index_writing = true;
    console.log('[INDEX] Generating search index and data...');
    try {
        // WHAT: Querying all image records joined with EVoC cluster themes, Laya facets, and lightweight Dicer scalars.
        // WHY: Exposes semantic cluster themes, medium, mood, composition, and physicality metrics directly to the search index without per-card DB roundtrips.
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
            ORDER BY COALESCE(images.updated_at, images.created_at) DESC, images.id DESC
        `;
        const images = db.prepare(sql).all();

        // WHAT: Parsing `analysis` JSON and omitting any embedded `diced_prompt` sub-tree from the search payload.
        // WHY: `diced_prompt` is only needed on Database cards (fetched live from SQLite), so omitting it here
        //      eliminates ~80% of `search-data.json` serialization size and Web Worker parse time.
        const indexData = images.map(image_row => {
            let parsed_analysis = {};
            try {
                parsed_analysis = typeof image_row.analysis === 'string'
                    ? JSON.parse(image_row.analysis)
                    : (image_row.analysis || {});
            } catch (analysis_parse_error) { /* ignore */ }

            const { diced_prompt: _omitted_diced_prompt, ...lightweight_analysis } = parsed_analysis || {};
            return {
                ...image_row,
                analysis: lightweight_analysis
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

        // 2. Save Index & Data asynchronously so the HTTP event loop stays responsive
        const indexOutputPath = path.join(__dirname, 'public', 'search-index.json');
        const dataOutputPath = path.join(__dirname, 'public', 'search-data.json');
        await Promise.all([
            fs.promises.writeFile(indexOutputPath, JSON.stringify(index.toJSON())),
            fs.promises.writeFile(dataOutputPath, JSON.stringify(indexData))
        ]);

        console.log(`[INDEX] Generated successfully (${images.length} items)`);
        console.log(`[INDEX] Index saved to: ${indexOutputPath}`);
        console.log(`[INDEX] Data saved to: ${dataOutputPath}`);

    } catch (err) {
        console.error('[INDEX] Generation failed:', err);
    } finally {
        is_search_index_writing = false;
        if (has_pending_search_index_write) {
            has_pending_search_index_write = false;
            scheduleSearchIndexRebuild(250);
        }
    }
}

let pending_search_index_rebuild_timer = null;

// WHAT: Coalesces rapid per-image save/update index rebuild requests into a single trailing rebuild.
// WHY: Calling `generateSearchIndex()` synchronously on every `/save` or `/update-tags` request rebuilds
//      a 11k+ item Fuse.js index and writes ~40 MB of JSON per image during batch imports.
function scheduleSearchIndexRebuild(debounce_delay_ms = 1500) {
    if (pending_search_index_rebuild_timer) {
        clearTimeout(pending_search_index_rebuild_timer);
    }
    pending_search_index_rebuild_timer = setTimeout(() => {
        pending_search_index_rebuild_timer = null;
        generateSearchIndex();
    }, debounce_delay_ms);
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
    const selectedKey = promptType || 'Ultra Detailed Description';
    let basePrompt = qwenPrompts[selectedKey] || qwenPrompts['Ultra Detailed Description'] || Object.values(qwenPrompts)[0];
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

// WHAT: Mounts image analysis, library CRUD, search, and rename routes.
// WHY: Isolates core image/library HTTP handlers in routes/imageAndLibraryRoutes.js.
app.use(createImageAndLibraryRouter({
    db,
    rootDirectoryPath: __dirname,
    generateSearchIndex,
    scheduleSearchIndexRebuild,
    performImageAnalysis
}));

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

/**
 * WHAT: Reads and parses `config.json` from disk, returning an empty object on missing or malformed files.
 * WHY: Centralizes user configuration lookups (models, ports, folders) with safe fallback behavior.
 */
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

// WHAT: Mounts Scope, Cluster, and GraphMemory HTTP endpoints from routes/scopeAndGraphRoutes.js.
// WHY: Reduces server.js surface area and isolates Python GraphMemory bridge routes.
app.use(createScopeAndGraphRouter({ db, rootDirectoryPath: __dirname }));


// ============================================================================
// PROMPT DICER & INGREDIENT CATALOG API ENDPOINTS
// ============================================================================

// WHAT: Dices an image or video prompt into ingredients, subjects, pretext terms, and influences.
// WHY: Executes the Pass A -> B -> C -> D pipeline, stores results in both `images` and `diced_prompts` in images.db, and returns the master record.
const OVIS_EMBEDDINGS_FILE_PATH = path.join(__dirname, 'public', 'ovis-embeddings.json');
let ovis_embeddings_memory_cache = { mtimeMs: -1, embeddingsMap: null };
let ovis_contiguous_table_cache = { mtimeMs: -1, table: null };

// WHAT: Loads `public/ovis-embeddings.json` with an `mtimeMs`-validated in-memory cache.
// WHY: `ovis-embeddings.json` is ~371 MB; caching the parsed object in memory avoids multi-second
//      synchronous disk reads and V8 JSON.parse spikes on every visual grounding or neighbor request.
function loadOvisEmbeddingsCached() {
    if (!fs.existsSync(OVIS_EMBEDDINGS_FILE_PATH)) {
        ovis_embeddings_memory_cache = { mtimeMs: -1, embeddingsMap: null };
        ovis_contiguous_table_cache = { mtimeMs: -1, table: null };
        return null;
    }
    try {
        const file_stats = fs.statSync(OVIS_EMBEDDINGS_FILE_PATH);
        if (ovis_embeddings_memory_cache.embeddingsMap && ovis_embeddings_memory_cache.mtimeMs === file_stats.mtimeMs) {
            return ovis_embeddings_memory_cache.embeddingsMap;
        }
        const parsed_embeddings_map = JSON.parse(fs.readFileSync(OVIS_EMBEDDINGS_FILE_PATH, 'utf8'));
        ovis_embeddings_memory_cache = {
            mtimeMs: file_stats.mtimeMs,
            embeddingsMap: parsed_embeddings_map
        };
        ovis_contiguous_table_cache = { mtimeMs: -1, table: null };
        return parsed_embeddings_map;
    } catch (embeddings_read_error) {
        console.warn('[OVIS-CACHE] Failed to load ovis-embeddings.json:', embeddings_read_error.message);
        return null;
    }
}

// WHAT: Packs the cached Ovis embeddings map into a single contiguous `Float32Array` buffer.
// WHY: Enables linear-memory dot-product similarity scans with zero per-vector JS array overhead.
function loadOvisContiguousTableCached() {
    const embeddings_map = loadOvisEmbeddingsCached();
    if (!embeddings_map) return null;
    const current_mtime = ovis_embeddings_memory_cache.mtimeMs;
    if (ovis_contiguous_table_cache.table && ovis_contiguous_table_cache.mtimeMs === current_mtime) {
        return ovis_contiguous_table_cache.table;
    }
    const packed_table = buildContiguousVectorData(embeddings_map);
    ovis_contiguous_table_cache = {
        mtimeMs: current_mtime,
        table: packed_table
    };
    return packed_table;
}

// WHAT: Persists updated Ovis embeddings to disk and refreshes the in-memory cache `mtimeMs`.
// WHY: Prevents the next read from unnecessarily re-parsing 371 MB after an embedding write.
function saveOvisEmbeddingsAndRefreshCache(updated_embeddings_map) {
    fs.writeFileSync(OVIS_EMBEDDINGS_FILE_PATH, JSON.stringify(updated_embeddings_map));
    const updated_stats = fs.statSync(OVIS_EMBEDDINGS_FILE_PATH);
    ovis_embeddings_memory_cache = {
        mtimeMs: updated_stats.mtimeMs,
        embeddingsMap: updated_embeddings_map
    };
    ovis_contiguous_table_cache = { mtimeMs: -1, table: null };
}

// WHAT: Mounts all Prompt Dicer HTTP endpoints from the modular dicerRoutes factory.
// WHY: Keeps server.js focused on core middleware, image indexing, and server startup.
app.use(createDicerRouter({ db, loadOvisEmbeddingsCached, generateSearchIndex }));


// WHAT: Mounts Laya Decision Engine, Facet Batch, and Ovis-Omni endpoints from routes/layaAndOvisRoutes.js.
// WHY: Isolates external AI microservice routes from core server bootstrap.
app.use(createLayaAndOvisRouter({
    db,
    loadOvisEmbeddingsCached,
    loadOvisContiguousTableCached,
    saveOvisEmbeddingsAndRefreshCache,
    generateSearchIndex,
    normalizeQueryVectorToFloat32,
    computeContiguousCpuDotProducts
}));


// WHAT: Mounts maintenance, validation, diagnostics, and embedding audit routes.
// WHY: Isolates maintenance HTTP handlers in routes/maintenanceRoutes.js.
app.use(createMaintenanceRouter({
    db,
    rootDirectoryPath: __dirname,
    CONFIG_PATH,
    getConfig,
    generateSearchIndex,
    loadOvisEmbeddingsCached,
    saveOvisEmbeddingsAndRefreshCache
}));

// Start Server...
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);

    // Generate initial index after startup so we don't block
    setTimeout(() => {
        generateSearchIndex();
    }, 1000);
});
