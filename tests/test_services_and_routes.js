/**
 * Automated Unit & Integration Tests for Microservice Clients and Express Routers
 *
 * WHAT: Verifies LayaClient, OvisOmniClient, and modular Express routers (`scopeAndGraphRoutes`,
 *       `maintenanceRoutes`, and `imageAndLibraryRoutes`) using ephemeral local HTTP servers and
 *       deterministic in-memory database doubles.
 * WHY: Ensures offline fallbacks, online JSON contracts, input boundary validation, filename
 *      sanitization, cascade deletion, and tag/object deduplication remain regression-free.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createLayaClient } from '../services/layaClient.js';
import { createOvisOmniClient } from '../services/ovisOmniClient.js';
import { createScopeAndGraphRouter } from '../routes/scopeAndGraphRoutes.js';
import { createMaintenanceRouter } from '../routes/maintenanceRoutes.js';
import { createImageAndLibraryRouter } from '../routes/imageAndLibraryRoutes.js';
import { createLayaAndOvisRouter } from '../routes/layaAndOvisRoutes.js';
import {
    buildContiguousVectorData,
    normalizeQueryVectorToFloat32,
    computeContiguousCpuDotProducts
} from '../services/server/contiguousVectorMath.js';

// WHAT: Starts an Express application or raw HTTP handler on an ephemeral OS-assigned port (`0`).
// WHY: Avoids port collisions during parallel test runs and returns a clean teardown handle.
function startEphemeralHttpServer(request_handler_function) {
    return new Promise((resolve_server) => {
        const http_server = http.createServer(request_handler_function);
        http_server.listen(0, '127.0.0.1', () => {
            const bound_address = http_server.address();
            const base_url = `http://127.0.0.1:${bound_address.port}`;
            resolve_server({
                baseUrl: base_url,
                close: () => new Promise((resolve_close) => http_server.close(resolve_close))
            });
        });
    });
}

test('createLayaClient handles offline fallback and online facet/intent classification', async () => {
    // 1. Offline behavior against an unreachable port
    const offline_laya_client = createLayaClient('http://127.0.0.1:59998');
    const is_offline_healthy = await offline_laya_client.checkServerHealth(true);
    assert.equal(is_offline_healthy, false);

    const offline_decision = await offline_laya_client.tryDecide({ caption: 'test' }, {});
    assert.equal(offline_decision.available, false);

    // 2. Online behavior against a mock Laya HTTP endpoint
    const mock_laya_server = await startEphemeralHttpServer((incoming_request, server_response) => {
        if (incoming_request.url === '/health') {
            server_response.writeHead(200, { 'Content-Type': 'application/json' });
            server_response.end(JSON.stringify({ status: 'ok', device: 'cuda:0' }));
            return;
        }
        if (incoming_request.url === '/decide' && incoming_request.method === 'POST') {
            let body_text = '';
            incoming_request.on('data', (chunk) => { body_text += chunk; });
            incoming_request.on('end', () => {
                const parsed_request = JSON.parse(body_text || '{}');
                const question_keys = Object.keys(parsed_request.questions || {});
                server_response.writeHead(200, { 'Content-Type': 'application/json' });
                if (question_keys.includes('visual_medium')) {
                    server_response.end(JSON.stringify({
                        answers: {
                            visual_medium: { choice: 'digital_art', confidence: 0.92 },
                            visual_mood: { choice: 'dark_and_moody', confidence: 0.88 },
                            composition_framing: { choice: 'wide_landscape', confidence: 0.79 },
                            caption_richness_score: { score: 2 }
                        }
                    }));
                } else {
                    server_response.end(JSON.stringify({
                        answers: {
                            search_intent_type: { choice: 'style_aesthetic', confidence: 0.91 },
                            target_medium: { choice: 'digital_art', confidence: 0.85 },
                            target_mood: { choice: 'dark_and_moody', confidence: 0.87 }
                        }
                    }));
                }
            });
            return;
        }
        server_response.writeHead(404);
        server_response.end();
    });

    try {
        const online_laya_client = createLayaClient(mock_laya_server.baseUrl);
        const is_online = await online_laya_client.checkServerHealth(true);
        assert.equal(is_online, true);
        assert.equal(online_laya_client.active_device_name, 'cuda:0');

        const facet_result = await online_laya_client.classifyImageFacets('A dark cyberpunk cityscape');
        assert.equal(facet_result.medium, 'digital_art');
        assert.equal(facet_result.mood, 'dark_and_moody');
        assert.equal(facet_result.composition, 'wide_landscape');

        const intent_result = await online_laya_client.classifyQueryIntent('dark digital art');
        assert.equal(intent_result.intent_type, 'style_aesthetic');
        assert.equal(intent_result.suggested_filters.medium, 'digital_art');
        assert.equal(intent_result.suggested_filters.mood, 'dark_and_moody');
    } finally {
        await mock_laya_server.close();
    }
});

test('createOvisOmniClient handles offline errors and online embeddings/zero-shot classification', async () => {
    const offline_ovis_client = createOvisOmniClient('http://127.0.0.1:59999');
    const is_offline = await offline_ovis_client.checkHealth(true);
    assert.equal(is_offline, false);
    await assert.rejects(
        () => offline_ovis_client.generateTextEmbedding('cyberpunk alley'),
        /offline/i
    );

    const mock_ovis_server = await startEphemeralHttpServer((incoming_request, server_response) => {
        if (incoming_request.url === '/health') {
            server_response.writeHead(200, { 'Content-Type': 'application/json' });
            server_response.end(JSON.stringify({ status: 'online', model_ready: true, device: 'cuda:0' }));
            return;
        }
        if (incoming_request.url === '/embed/text' && incoming_request.method === 'POST') {
            server_response.writeHead(200, { 'Content-Type': 'application/json' });
            server_response.end(JSON.stringify({ embedding: [0.25, 0.5, -0.25] }));
            return;
        }
        if (incoming_request.url === '/classify/zero-shot' && incoming_request.method === 'POST') {
            server_response.writeHead(200, { 'Content-Type': 'application/json' });
            server_response.end(JSON.stringify({
                top_label: 'real-world photography',
                top_confidence: 0.94,
                scores: { 'real-world photography': 0.94 }
            }));
            return;
        }
        server_response.writeHead(404);
        server_response.end();
    });

    try {
        const online_ovis_client = createOvisOmniClient(mock_ovis_server.baseUrl);
        const is_online = await online_ovis_client.checkHealth(true);
        assert.equal(is_online, true);
        assert.equal(online_ovis_client.detected_hardware_device_name, 'cuda:0');

        const embedding_vector = await online_ovis_client.generateTextEmbedding('neon alley');
        assert.deepEqual(embedding_vector, [0.25, 0.5, -0.25]);

        const classification_result = await online_ovis_client.classifyImageZeroShot(
            'C:/test.jpg',
            ['real-world photography', '3D CGI digital render'],
            'visual_medium'
        );
        assert.equal(classification_result.top_label, 'real-world photography');
    } finally {
        await mock_ovis_server.close();
    }
});

test('scopeAndGraphRoutes validates cluster and GraphMemory query parameters and handles missing tables', async () => {
    const mock_database = {
        prepare(sql_query_string) {
            if (sql_query_string.includes('FROM image_coordinates')) {
                return {
                    all() {
                        throw new Error('no such table: image_coordinates');
                    }
                };
            }
            if (sql_query_string.includes('SELECT COUNT(*) as total')) {
                return { get: () => ({ total: 1 }) };
            }
            return {
                all: (cluster_id, limit_val, offset_val) => [
                    { id: 7, cluster_label: cluster_id, limit_used: limit_val, offset_used: offset_val }
                ]
            };
        }
    };

    const express_app = express();
    express_app.use(express.json());
    express_app.use(createScopeAndGraphRouter({ db: mock_database, rootDirectoryPath: process.cwd() }));

    const test_server = await startEphemeralHttpServer(express_app);
    try {
        // 1. Missing table in /api/scope/db-data gracefully returns []
        const scope_response = await fetch(`${test_server.baseUrl}/api/scope/db-data`);
        assert.equal(scope_response.status, 200);
        assert.deepEqual(await scope_response.json(), []);

        // 2. Non-numeric cluster_identifier returns 400
        const bad_cluster_response = await fetch(`${test_server.baseUrl}/api/clusters/not-a-number/images`);
        assert.equal(bad_cluster_response.status, 400);

        // 3. Negative page and excessive limit are clamped safely
        const clamped_cluster_response = await fetch(`${test_server.baseUrl}/api/clusters/3/images?page=-5&limit=9999`);
        assert.equal(clamped_cluster_response.status, 200);
        const clamped_payload = await clamped_cluster_response.json();
        assert.equal(clamped_payload.page, 1);
        assert.equal(clamped_payload.limit, 200);
        assert.equal(clamped_payload.images[0].offset_used, 0);

        // 4. GraphMemory endpoints reject invalid/negative image_id or cluster_a/cluster_b
        const bad_associative = await fetch(`${test_server.baseUrl}/api/graph/associative-related?image_id=-1`);
        assert.equal(bad_associative.status, 400);

        const bad_subgraph = await fetch(`${test_server.baseUrl}/api/graph/subgraph?image_id=abc`);
        assert.equal(bad_subgraph.status, 400);

        const bad_bridges = await fetch(`${test_server.baseUrl}/api/graph/bridges?cluster_a=-5&cluster_b=2`);
        assert.equal(bad_bridges.status, 400);
    } finally {
        await test_server.close();
    }
});

test('maintenanceRoutes deduplicates both tags and objects and serves diagnostics', async () => {
    const stored_image_rows = [
        {
            id: 1,
            analysis: JSON.stringify({
                tags: ['Cyberpunk', 'cyberpunk'],
                objects: ['Car', 'cars']
            })
        },
        {
            id: 2,
            analysis: JSON.stringify({
                tags: ['Portrait'],
                objects: ['Tree', 'trees']
            })
        }
    ];
    const updated_rows_by_id = new Map();
    let search_index_rebuild_calls = 0;

    const mock_database = {
        prepare(sql_query_string) {
            if (sql_query_string.startsWith('SELECT id, analysis FROM images')) {
                return { all: () => stored_image_rows };
            }
            if (sql_query_string.startsWith('UPDATE images SET analysis = ?')) {
                return {
                    run(new_analysis_json, _timestamp, row_id) {
                        updated_rows_by_id.set(row_id, JSON.parse(new_analysis_json));
                    }
                };
            }
            return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
        },
        transaction(transaction_callback) {
            return () => transaction_callback();
        }
    };

    const express_app = express();
    express_app.use(express.json());
    express_app.use(createMaintenanceRouter({
        db: mock_database,
        rootDirectoryPath: process.cwd(),
        CONFIG_PATH: 'config.json',
        getConfig: () => ({ visionModel: 'test-vision-model', embeddingModel: 'test-embed-model' }),
        generateSearchIndex: () => { search_index_rebuild_calls++; },
        loadOvisEmbeddingsCached: () => ({}),
        saveOvisEmbeddingsAndRefreshCache: () => {}
    }));

    const test_server = await startEphemeralHttpServer(express_app);
    try {
        const dedup_response = await fetch(`${test_server.baseUrl}/maintenance/deduplicate-tags`, {
            method: 'POST'
        });
        assert.equal(dedup_response.status, 200);
        const dedup_payload = await dedup_response.json();
        assert.equal(dedup_payload.updatedCount, 2);
        assert.equal(search_index_rebuild_calls, 1);
        assert.deepEqual(updated_rows_by_id.get(1).tags, ['Cyberpunk']);
        assert.deepEqual(updated_rows_by_id.get(1).objects, ['Car']);
        assert.deepEqual(updated_rows_by_id.get(2).objects, ['Tree']);
    } finally {
        await test_server.close();
    }
});

test('imageAndLibraryRoutes sanitizes /rename against path traversal and cascades /images/:id delete to diced_prompts', async () => {
    const temp_directory_path = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-route-test-'));
    const sample_image_path = path.join(temp_directory_path, 'original.jpg');
    fs.writeFileSync(sample_image_path, 'fake-image-bytes');

    const executed_sql_operations = [];
    const mock_records = new Map([
        [10, { id: 10, filename: 'original.jpg', path: sample_image_path }],
        [20, { id: 20, filename: 'missing.jpg', path: path.join(temp_directory_path, 'nonexistent.jpg') }]
    ]);

    const mock_database = {
        prepare(sql_query_string) {
            if (sql_query_string.includes('SELECT COUNT(*) as total FROM images')) {
                return { get: () => ({ total: 5 }) };
            }
            if (sql_query_string.includes('LIMIT ? OFFSET ?')) {
                return {
                    all: (limit_val, offset_val) => [{ id: 10, limit_used: limit_val, offset_used: offset_val }]
                };
            }
            return {
                get(target_id) {
                    return mock_records.get(Number(target_id)) || null;
                },
                run(...bound_params) {
                    executed_sql_operations.push({ sql: sql_query_string.trim(), params: bound_params });
                    return { changes: 1 };
                }
            };
        }
    };

    const express_app = express();
    express_app.use(express.json());
    express_app.use(createImageAndLibraryRouter({
        db: mock_database,
        rootDirectoryPath: temp_directory_path,
        getConfig: () => ({}),
        performImageAnalysis: async () => ({}),
        generateSearchIndex: () => {},
        scheduleSearchIndexRebuild: () => {}
    }));

    const test_server = await startEphemeralHttpServer(express_app);
    try {
        // 1. Missing source file on disk returns 404 instead of crashing on fs.renameSync
        const missing_file_response = await fetch(`${test_server.baseUrl}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 20, newFilename: 'renamed.jpg' })
        });
        assert.equal(missing_file_response.status, 404);

        // 2. Path traversal attempt (`../../escaped:bad?.jpg`) is stripped to basename & sanitized inside original folder
        const traversal_rename_response = await fetch(`${test_server.baseUrl}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 10, newFilename: '../../escaped:bad?.jpg' })
        });
        assert.equal(traversal_rename_response.status, 200);
        const rename_payload = await traversal_rename_response.json();
        assert.equal(rename_payload.newFilename, 'escapedbad.jpg');
        assert.equal(path.dirname(rename_payload.newPath), temp_directory_path);
        assert.equal(fs.existsSync(rename_payload.newPath), true);

        // 3. DELETE /images/:id deletes from diced_prompts BEFORE deleting from images
        executed_sql_operations.length = 0;
        const delete_response = await fetch(`${test_server.baseUrl}/images/10`, {
            method: 'DELETE'
        });
        assert.equal(delete_response.status, 200);
        assert.equal(executed_sql_operations.length, 2);
        assert.match(executed_sql_operations[0].sql, /^DELETE FROM diced_prompts WHERE image_id = \?/);
        assert.match(executed_sql_operations[1].sql, /^DELETE FROM images WHERE id = \?/);

        // 4. GET /images?page=-2&limit=0 clamps page >= 1 and limit >= 1 (never Infinity totalPages or negative OFFSET)
        const clamped_images_response = await fetch(`${test_server.baseUrl}/images?page=-2&limit=0`);
        assert.equal(clamped_images_response.status, 200);
        const clamped_images_payload = await clamped_images_response.json();
        assert.equal(clamped_images_payload.page, 1);
        assert.equal(clamped_images_payload.limit, 1);
        assert.equal(clamped_images_payload.totalPages, 5);
        assert.equal(clamped_images_payload.images[0].offset_used, 0);

        // 5. GET /thumbnails/id_177.avif returns 200 with fallback placeholder AVIF for nonexistent image
        const missing_thumbnail_response = await fetch(`${test_server.baseUrl}/thumbnails/id_177.avif`);
        assert.equal(missing_thumbnail_response.status, 200);
        assert.equal(missing_thumbnail_response.headers.get('content-type'), 'image/avif');
        const fallback_bytes = await missing_thumbnail_response.arrayBuffer();
        assert.ok(fallback_bytes.byteLength > 100);
    } finally {
        await test_server.close();
        fs.rmSync(temp_directory_path, { recursive: true, force: true });
    }
});

test('layaAndOvisRoutes /api/ovis/find-similar uses contiguous Float32Array ranking and excludes target image', async () => {
    const mock_embeddings_map = {
        '1': [1, 0, 0],
        '2': [0.9, 0.1, 0],
        '3': [0, 1, 0],
        '4': [-1, 0, 0]
    };
    const contiguous_table = buildContiguousVectorData(mock_embeddings_map);
    const mock_rows_by_id = new Map([
        [1, { id: 1, filename: 'target.jpg', path: 'C:/target.jpg', analysis: JSON.stringify({ summary: 'target' }) }],
        [2, { id: 2, filename: 'close.jpg', path: 'C:/close.jpg', analysis: JSON.stringify({ summary: 'close' }) }],
        [3, { id: 3, filename: 'ortho.jpg', path: 'C:/ortho.jpg', analysis: JSON.stringify({ summary: 'ortho' }) }],
        [4, { id: 4, filename: 'opposite.jpg', path: 'C:/opposite.jpg', analysis: JSON.stringify({ summary: 'opposite' }) }]
    ]);

    const mock_database = {
        prepare(sql_query_string) {
            if (sql_query_string.includes('WHERE id = ?')) {
                return { get: (id_arg) => mock_rows_by_id.get(Number(id_arg)) || null };
            }
            if (sql_query_string.includes('WHERE id IN')) {
                return {
                    all: (...ids) => ids.map(id_arg => mock_rows_by_id.get(Number(id_arg))).filter(Boolean)
                };
            }
            return { get: () => null, all: () => [] };
        }
    };

    const express_app = express();
    express_app.use(express.json());
    express_app.use(createLayaAndOvisRouter({
        db: mock_database,
        loadOvisEmbeddingsCached: () => mock_embeddings_map,
        loadOvisContiguousTableCached: () => contiguous_table,
        saveOvisEmbeddingsAndRefreshCache: () => {},
        generateSearchIndex: () => {},
        normalizeQueryVectorToFloat32,
        computeContiguousCpuDotProducts
    }));

    const test_server = await startEphemeralHttpServer(express_app);
    try {
        const response = await fetch(`${test_server.baseUrl}/api/ovis/find-similar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_id: 1, limit: 3 })
        });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.target_image_id, 1);
        assert.equal(payload.total_compared_count, 4);
        assert.equal(payload.similar_images.length, 3);
        assert.deepEqual(payload.similar_images.map(item => item.id), [2, 3, 4]);
        assert.ok(payload.similar_images[0].similarity_score > payload.similar_images[1].similarity_score);
        assert.ok(payload.similar_images[1].similarity_score > payload.similar_images[2].similarity_score);
    } finally {
        await test_server.close();
    }
});

test('maintenanceRoutes /validate-database cascades duplicate and missing-file deletes cleanly', async () => {
    const temp_directory_path = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-validate-test-'));
    const existing_image_path = path.join(temp_directory_path, 'keep.jpg');
    fs.writeFileSync(existing_image_path, 'img-data');

    const db_rows = [
        // Inferior duplicate (missing width/height)
        { id: 1, filename: 'keep.jpg', path: existing_image_path, width: null, height: null, analysis: '{}', updated_at: '2026-01-01' },
        // Superior duplicate (has dimensions + analysis)
        { id: 2, filename: 'keep.jpg', path: existing_image_path, width: 100, height: 100, analysis: '{"summary":"good"}', updated_at: '2026-01-02' },
        // Missing file on disk
        { id: 3, filename: 'gone.jpg', path: path.join(temp_directory_path, 'gone.jpg'), width: 100, height: 100, analysis: '{}', updated_at: '2026-01-03' }
    ];
    const deleted_diced_image_ids = [];
    const deleted_image_ids = [];

    const mock_database = {
        prepare(sql_query_string) {
            if (sql_query_string.startsWith('SELECT') && sql_query_string.includes('images')) {
                return {
                    all: () => db_rows.filter(row => !deleted_image_ids.includes(row.id))
                };
            }
            if (sql_query_string.startsWith('DELETE FROM diced_prompts WHERE image_id = ?')) {
                return { run: (id_arg) => { deleted_diced_image_ids.push(Number(id_arg)); return { changes: 1 }; } };
            }
            if (sql_query_string.startsWith('DELETE FROM images WHERE id = ?')) {
                return { run: (id_arg) => { deleted_image_ids.push(Number(id_arg)); return { changes: 1 }; } };
            }
            return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
        },
        transaction(fn) {
            return (arg) => fn(arg);
        }
    };

    const express_app = express();
    express_app.use(express.json());
    express_app.use(createMaintenanceRouter({
        db: mock_database,
        rootDirectoryPath: temp_directory_path,
        CONFIG_PATH: path.join(temp_directory_path, 'config.json'),
        getConfig: () => ({}),
        generateSearchIndex: () => {},
        loadOvisEmbeddingsCached: () => ({}),
        saveOvisEmbeddingsAndRefreshCache: () => {}
    }));

    const test_server = await startEphemeralHttpServer(express_app);
    try {
        const validate_response = await fetch(`${test_server.baseUrl}/validate-database`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                options: {
                    removeMissing: true,
                    regenThumbnails: false,
                    repairMetadata: false,
                    reanalyze: false,
                    validateDicedPrompts: true,
                    pruneOrphanedEmbeddings: true
                }
            })
        });
        assert.equal(validate_response.status, 200);
        const validate_payload = await validate_response.json();
        assert.equal(validate_payload.results.duplicatesRemoved, 1);
        assert.equal(validate_payload.results.missing, 1);
        assert.equal(typeof validate_payload.results.dicedValid, 'number');
        assert.equal(typeof validate_payload.results.orphanedEmbeddingsFound, 'number');
        assert.deepEqual(deleted_diced_image_ids, [1, 3]);
        assert.deepEqual(deleted_image_ids, [1, 3]);
    } finally {
        await test_server.close();
        fs.rmSync(temp_directory_path, { recursive: true, force: true });
    }
});
