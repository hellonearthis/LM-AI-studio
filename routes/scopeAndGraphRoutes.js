import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

// WHAT: Creates an Express router for /api/scope/*, /api/clusters/*, and /api/graph/* endpoints.
// WHY: Isolates EVoC cluster queries and DuckDB GraphMemory Python bridge calls from server.js.
export function createScopeAndGraphRouter({ db, rootDirectoryPath }) {
    const router = express.Router();

    // WHAT: Serving SQLite database cluster coordinates joined with Toponymy topics and Laya semantic themes.
    // WHY: Used by scope.js ("Evoc DB" toggle) to render 2D scatter plots colored by semantic cluster topics.
    router.get('/api/scope/db-data', (http_incoming_request, http_server_response) => {
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
    router.get('/api/clusters/themes', (http_incoming_request, http_server_response) => {
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
    router.get('/api/clusters/:cluster_identifier/images', (http_incoming_request, http_server_response) => {
        try {
            const target_cluster_identifier = parseInt(http_incoming_request.params.cluster_identifier, 10);
            if (Number.isNaN(target_cluster_identifier)) {
                return http_server_response.status(400).json({ error: 'Valid numeric cluster_identifier is required.' });
            }
            const parsed_page_number = parseInt(http_incoming_request.query.page, 10);
            const parsed_limit_number = parseInt(http_incoming_request.query.limit, 10);
            const request_page_number = Number.isFinite(parsed_page_number) && parsed_page_number > 0 ? parsed_page_number : 1;
            const request_limit_number = Number.isFinite(parsed_limit_number) && parsed_limit_number > 0 ? Math.min(200, parsed_limit_number) : 50;
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

            const python_executable_path = fs.existsSync(path.join(rootDirectoryPath, 'venv', 'Scripts', 'python.exe'))
                ? path.join(rootDirectoryPath, 'venv', 'Scripts', 'python.exe')
                : 'python';
            const script_file_path = path.join(rootDirectoryPath, 'scripts', 'associative_retrieval.py');

            const subprocess_instance = spawn(python_executable_path, [script_file_path, ...cli_arguments_array]);
            let accumulated_standard_output_buffer = '';
            let accumulated_standard_error_buffer = '';

            subprocess_instance.on('error', (spawn_error) => {
                reject_promise(new Error(`Failed to spawn GraphMemory Python process: ${spawn_error.message}`));
            });

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
    router.get('/api/graph/associative-related', async (http_incoming_request, http_server_response) => {
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
    router.get('/api/graph/subgraph', async (http_incoming_request, http_server_response) => {
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
    router.get('/api/graph/bridges', async (http_incoming_request, http_server_response) => {
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

    return router;
}
