import express from "express";
import fs from "fs";
import path from "path";
import { laya_client_instance } from "../services/layaClient.js";
import { ovis_omni_client_instance } from "../services/ovisOmniClient.js";

// WHAT: Creates an Express router for /api/laya/*, /api/facets/*, /api/ovis/*, and /api/maintenance/generate-ovis-embeddings.
// WHY: Keeps Laya Decision Engine and Ovis-Omni multimodal microservice routing modular.
export function createLayaAndOvisRouter({
    db,
    loadOvisEmbeddingsCached,
    loadOvisContiguousTableCached,
    saveOvisEmbeddingsAndRefreshCache,
    generateSearchIndex,
    normalizeQueryVectorToFloat32,
    computeContiguousCpuDotProducts
}) {
    const router = express.Router();

    // WHAT: Probes the status of the local Laya Decision Engine microservice.
    // WHY: Gives the settings and diagnostics UI immediate feedback on port 8765 reachability and GPU device.
    router.get('/api/laya/status', async (http_incoming_request, http_server_response) => {
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
    router.post('/api/laya/query-intent', async (http_incoming_request, http_server_response) => {
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
    router.post('/api/facets/batch-classify', async (http_incoming_request, http_server_response) => {
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
                if (http_server_response.writableEnded || http_server_response.closed) {
                    console.log('[LAYA] Client disconnected during batch facet classification. Stopping early.');
                    break;
                }
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
    router.get('/api/ovis/health', async (http_incoming_request, http_server_response) => {
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
    router.post('/api/ovis/classify-image', async (http_incoming_request, http_server_response) => {
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
    router.post('/api/ovis/find-similar', async (http_incoming_request, http_server_response) => {
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

            const existing_ovis_embeddings_map = loadOvisEmbeddingsCached() || {};

            // If target image doesn't have an embedding cached, generate it on the fly
            let target_image_vector = existing_ovis_embeddings_map[String(target_image_record.id)];
            if (!target_image_vector) {
                target_image_vector = await ovis_omni_client_instance.generateImageEmbedding(target_image_record.path);
                existing_ovis_embeddings_map[String(target_image_record.id)] = target_image_vector;
                saveOvisEmbeddingsAndRefreshCache(existing_ovis_embeddings_map);
            }

            // WHAT: Computing cosine similarity across all cached 2048-dim Ovis image vectors.
            // WHY: Prefers the mtime-cached contiguous Float32Array buffer for zero-GC linear memory dot products,
            //      with a fallback to direct property iteration when injected without the contiguous helper.
            let similarity_ranking_candidates = [];
            let total_compared_count = 0;

            const contiguous_table = typeof loadOvisContiguousTableCached === 'function'
                ? loadOvisContiguousTableCached()
                : null;

            if (contiguous_table && typeof normalizeQueryVectorToFloat32 === 'function' && typeof computeContiguousCpuDotProducts === 'function') {
                total_compared_count = contiguous_table.vectorsCount;
                const normalized_query_vector = normalizeQueryVectorToFloat32(
                    target_image_vector,
                    contiguous_table.dimensionsCount
                );
                const scored_matches = computeContiguousCpuDotProducts(
                    contiguous_table.buffer,
                    contiguous_table.dimensionsCount,
                    contiguous_table.vectorsCount,
                    contiguous_table.indexedIdentifiers,
                    normalized_query_vector,
                    -1.0,
                    (identifier_str) => (identifier_str === String(target_image_identifier) ? null : identifier_str)
                );
                similarity_ranking_candidates = scored_matches.map(match_entry => ({
                    image_id: parseInt(match_entry.item, 10),
                    similarity_score: match_entry.score
                }));
            } else {
                for (const candidate_identifier_string in existing_ovis_embeddings_map) {
                    total_compared_count++;
                    if (candidate_identifier_string === String(target_image_identifier)) continue;

                    const candidate_vector = existing_ovis_embeddings_map[candidate_identifier_string];
                    if (!Array.isArray(candidate_vector) || candidate_vector.length !== target_image_vector.length) continue;

                    let calculated_dot_product_accumulator = 0.0;
                    for (let vector_dimension_index = 0; vector_dimension_index < target_image_vector.length; vector_dimension_index++) {
                        calculated_dot_product_accumulator += target_image_vector[vector_dimension_index] * candidate_vector[vector_dimension_index];
                    }

                    similarity_ranking_candidates.push({
                        image_id: parseInt(candidate_identifier_string, 10),
                        similarity_score: calculated_dot_product_accumulator
                    });
                }

                similarity_ranking_candidates.sort((first_candidate, second_candidate) => second_candidate.similarity_score - first_candidate.similarity_score);
            }

            const top_ranked_similar_images = similarity_ranking_candidates.slice(0, requested_result_limit);

            // Fetch image metadata for all top results in one batched query
            const top_image_ids = top_ranked_similar_images
                .map(ranking_entry => ranking_entry.image_id)
                .filter(candidate_id => Number.isSafeInteger(candidate_id) && candidate_id > 0);

            const metadata_by_image_id = new Map();
            if (top_image_ids.length > 0) {
                const id_placeholders = top_image_ids.map(() => '?').join(', ');
                const matched_rows = db
                    .prepare(`SELECT id, filename, path, analysis FROM images WHERE id IN (${id_placeholders})`)
                    .all(...top_image_ids);
                for (const matched_row of matched_rows) {
                    metadata_by_image_id.set(matched_row.id, matched_row);
                }
            }

            const enriched_similar_images = [];
            for (const ranking_entry of top_ranked_similar_images) {
                const matched_image_metadata = metadata_by_image_id.get(ranking_entry.image_id);
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
                total_compared_count,
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
    router.post('/api/maintenance/generate-ovis-embeddings', async (http_incoming_request, http_server_response) => {
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

            const existing_ovis_embeddings_map = loadOvisEmbeddingsCached() || {};
            if (Object.keys(existing_ovis_embeddings_map).length > 0) {
                http_server_response.write(`Resume mode: Found ${Object.keys(existing_ovis_embeddings_map).length} existing embeddings. Skipping already processed files.\n`);
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
                        saveOvisEmbeddingsAndRefreshCache(existing_ovis_embeddings_map);
                    }
                } catch (single_image_embedding_error) {
                    failed_images_count++;
                    http_server_response.write(`! Warning on ID ${candidate_image_record.id}: ${single_image_embedding_error.message}\n`);
                }
            }

            // Final save
            saveOvisEmbeddingsAndRefreshCache(existing_ovis_embeddings_map);
            http_server_response.write(`\n[COMPLETE] Successfully generated ${successfully_embedded_images_count} Ovis-Omni visual embeddings (Skipped: ${skipped_existing_images_count}, Errors: ${failed_images_count}).\n`);
            http_server_response.end();

        } catch (batch_generation_error) {
            console.error('[OVIS-MAINTENANCE] Critical error:', batch_generation_error);
            http_server_response.write(`\nCRITICAL ERROR: ${batch_generation_error.message}\n`);
            http_server_response.end();
        }
    });

    return router;
}
