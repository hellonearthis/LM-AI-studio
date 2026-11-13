/**
 * Ovis-Omni Dataset & Database Execution Pipeline Script
 * 
 * WHAT: Command-line pipeline to process your dataset and images.db using Ovis-Omni.
 * WHY: Allows batch execution directly from the terminal with real-time progress indicators,
 *      supporting both full multimodal embedding generation and zero-shot facet classification.
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ovis_omni_client_instance } from '../services/ovisOmniClient.js';

const current_module_filename = fileURLToPath(import.meta.url);
const current_module_directory = path.dirname(current_module_filename);
const project_root_directory = path.resolve(current_module_directory, '..');

// ============================================================================
// MAIN EXECUTION ENGINE
// ============================================================================

/**
 * WHAT: Executes the end-to-end Ovis-Omni zero-shot facet classification and 2048-d embedding pipeline.
 * WHY: Synchronizes unclassified images in `images.db` and `public/ovis-embeddings.json` with fault-tolerant logging.
 */
async function run_ovis_dataset_pipeline() {
    console.log('======================================================================');
    console.log('Lumina - Ovis-Omni Dataset & Database Pipeline Runner');
    console.log('======================================================================\n');

    // Parse CLI arguments: --mode=embed | --mode=classify | --mode=all
    const command_line_arguments = process.argv.slice(2);
    const mode_argument_entry = command_line_arguments.find(argument_string => argument_string.startsWith('--mode='));
    const execution_mode_name = mode_argument_entry ? mode_argument_entry.split('=')[1].toLowerCase() : 'all';

    console.log(`Execution Mode Selected: [${execution_mode_name.toUpperCase()}]`);
    console.log('Options: --mode=embed | --mode=classify | --mode=all\n');

    // Step 1: Health Check on Ovis Microservice (Port 8082)
    console.log('[STEP 1/3] Verifying Ovis-Omni Microservice on port 8082...');
    const is_ovis_microservice_online = await ovis_omni_client_instance.checkHealth(true);

    if (!is_ovis_microservice_online) {
        console.error('\n[ERROR] Ovis-Omni microservice is OFFLINE or still loading weights.');
        console.error('Please ensure you have launched the service in a separate terminal via:');
        console.error('    start_ovis_server.bat');
        console.error('    or: npm run ovis:serve\n');
        process.exit(1);
    }

    console.log(`  -> Microservice Online on ${ovis_omni_client_instance.active_endpoint_url}`);
    console.log(`  -> Target Hardware: ${ovis_omni_client_instance.detected_hardware_device_name}`);
    console.log(`  -> Vector Dimensions: ${ovis_omni_client_instance.embedding_vector_dimensions}\n`);

    // Step 2: Open SQLite images.db
    console.log('[STEP 2/3] Opening SQLite database (images.db)...');
    const sqlite_database_file_path = path.join(project_root_directory, 'images.db');
    if (!fs.existsSync(sqlite_database_file_path)) {
        console.error(`[ERROR] Database file not found at ${sqlite_database_file_path}`);
        process.exit(1);
    }

    const sqlite_database_connection = new Database(sqlite_database_file_path);
    const total_registered_images_records = sqlite_database_connection.prepare('SELECT id, filename, path FROM images').all();
    console.log(`  -> Found ${total_registered_images_records.length} total registered image assets.\n`);

    // Step 3: Execute Selected Pipelines
    console.log('[STEP 3/3] Executing pipeline operations...\n');
    const pipeline_failed_records_collection = [];

    // PIPELINE A: ZERO-SHOT VISUAL FACET CLASSIFICATION
    if (execution_mode_name === 'classify' || execution_mode_name === 'all') {
        console.log('--- [PIPELINE A: Zero-Shot Visual Classification (image_facets)] ---');

        const insert_or_replace_facet_statement = sqlite_database_connection.prepare(`
            INSERT OR REPLACE INTO image_facets (
                image_id, medium, mood, composition, detail_score,
                confidence_medium, confidence_mood, confidence_composition
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Find images that do not yet have facets
        const unclassified_facet_records = sqlite_database_connection.prepare(`
            SELECT images.id, images.filename, images.path 
            FROM images
            LEFT JOIN image_facets ON images.id = image_facets.image_id
            WHERE image_facets.image_id IS NULL
        `).all();

        console.log(`Identified ${unclassified_facet_records.length} images requiring zero-shot facet classification.`);

        let successfully_classified_images_count = 0;
        let skipped_missing_images_count = 0;
        let failed_classification_images_count = 0;
        const start_time_milliseconds = Date.now();

        for (const candidate_image_record of unclassified_facet_records) {
            const physical_image_file_path = candidate_image_record.path;

            if (!fs.existsSync(physical_image_file_path)) {
                skipped_missing_images_count++;
                continue;
            }

            // WHAT: Log the start of processing for the current image immediately.
            // WHY: Prevents the console from appearing frozen while large images or first-time label warmup computes.
            const candidate_step_number = successfully_classified_images_count + skipped_missing_images_count + failed_classification_images_count + 1;
            process.stdout.write(`  [${candidate_step_number}/${unclassified_facet_records.length}] Processing: ${candidate_image_record.filename}... `);

            try {
                // Classify medium, mood, and composition using Ovis-Omni zero-shot
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

                insert_or_replace_facet_statement.run(
                    candidate_image_record.id,
                    medium_classification_result.top_label,
                    mood_classification_result.top_label,
                    composition_classification_result.top_label,
                    1.0,
                    medium_classification_result.top_confidence,
                    mood_classification_result.top_confidence,
                    composition_classification_result.top_confidence
                );

                successfully_classified_images_count++;
                const processed_total_classified = successfully_classified_images_count + skipped_missing_images_count + failed_classification_images_count;
                const percentage_completed = ((processed_total_classified / unclassified_facet_records.length) * 100).toFixed(1);
                const elapsed_seconds = (Date.now() - start_time_milliseconds) / 1000;
                const images_per_second = successfully_classified_images_count / (elapsed_seconds || 1);
                const remaining_images = unclassified_facet_records.length - processed_total_classified;
                const estimated_remaining_seconds = Math.round(remaining_images / (images_per_second || 0.01));
                const estimated_minutes_display = Math.floor(estimated_remaining_seconds / 60);
                const estimated_seconds_display = estimated_remaining_seconds % 60;

                // WHAT: Complete the inline line with results, confidence, speed, and ETA
                // WHY: Provides immediate feedback without leaving the terminal hanging
                console.log(`DONE (${percentage_completed}%) [${images_per_second.toFixed(1)} img/s, ETA: ${estimated_minutes_display}m ${estimated_seconds_display}s] -> ${medium_classification_result.top_label} / ${mood_classification_result.top_label}`);
            } catch (single_classification_error) {
                failed_classification_images_count++;
                pipeline_failed_records_collection.push({
                    phase: 'classification',
                    image_id: candidate_image_record.id,
                    filename: candidate_image_record.filename,
                    path: candidate_image_record.path,
                    error_message: single_classification_error.message,
                    timestamp: new Date().toISOString()
                });
                console.log(`FAILED: ${single_classification_error.message}`);
            }
        }

        console.log(`\nClassification Complete: Saved ${successfully_classified_images_count} new image facets to SQLite.\n`);
    }

    // PIPELINE B: MULTIMODAL 2048-DIM EMBEDDING GENERATION
    if (execution_mode_name === 'embed' || execution_mode_name === 'all') {
        console.log('--- [PIPELINE B: Multimodal Raw-Image Vector Generation (ovis-embeddings.json)] ---');

        const OVIS_EMBEDDINGS_FILE_PATH = path.join(project_root_directory, 'public', 'ovis-embeddings.json');
        let existing_ovis_embeddings_map = {};

        if (fs.existsSync(OVIS_EMBEDDINGS_FILE_PATH)) {
            try {
                existing_ovis_embeddings_map = JSON.parse(fs.readFileSync(OVIS_EMBEDDINGS_FILE_PATH, 'utf8'));
                console.log(`Resume Mode: Found ${Object.keys(existing_ovis_embeddings_map).length} existing cached embeddings.`);
            } catch (json_parse_error) {
                console.warn('Existing ovis-embeddings.json was unreadable. Starting a fresh vector file.');
            }
        }

        let successfully_vectorized_images_count = 0;
        let skipped_already_vectorized_count = 0;
        let missing_physical_files_count = 0;
        let candidate_image_index = 0;
        const total_images_to_process = total_registered_images_records.length;
        const embedding_start_time_milliseconds = Date.now();

        for (const candidate_image_record of total_registered_images_records) {
            candidate_image_index++;
            const image_record_id_string = String(candidate_image_record.id);

            // Skip if already embedded
            if (existing_ovis_embeddings_map[image_record_id_string]) {
                skipped_already_vectorized_count++;
                continue;
            }

            if (!fs.existsSync(candidate_image_record.path)) {
                missing_physical_files_count++;
                continue;
            }

            try {
                const generated_image_vector = await ovis_omni_client_instance.generateImageEmbedding(candidate_image_record.path);
                existing_ovis_embeddings_map[image_record_id_string] = generated_image_vector;
                successfully_vectorized_images_count++;

                const percentage_completed = ((candidate_image_index / total_images_to_process) * 100).toFixed(1);
                const elapsed_seconds = (Date.now() - embedding_start_time_milliseconds) / 1000;
                const images_per_second = successfully_vectorized_images_count / (elapsed_seconds || 1);
                const remaining_images = total_images_to_process - candidate_image_index;
                const estimated_remaining_seconds = Math.round(remaining_images / (images_per_second || 0.01));
                const estimated_minutes_display = Math.floor(estimated_remaining_seconds / 60);
                const estimated_seconds_display = estimated_remaining_seconds % 60;

                // WHAT: Display real-time progress counter [X/Total] with speed and ETA
                // WHY: Enables the user to see exact progress like [1/11452] through the entire dataset
                console.log(`  [${candidate_image_index}/${total_images_to_process}] (${percentage_completed}%) | Speed: ${images_per_second.toFixed(1)} img/s | ETA: ${estimated_minutes_display}m ${estimated_seconds_display}s | Vectorized: ${candidate_image_record.filename}`);

                // Checkpoint write every 25 images to guard against power cuts
                if (successfully_vectorized_images_count % 25 === 0) {
                    fs.writeFileSync(OVIS_EMBEDDINGS_FILE_PATH, JSON.stringify(existing_ovis_embeddings_map));
                }
            } catch (single_image_embedding_error) {
                pipeline_failed_records_collection.push({
                    phase: 'embedding',
                    image_id: candidate_image_record.id,
                    filename: candidate_image_record.filename,
                    path: candidate_image_record.path,
                    error_message: single_image_embedding_error.message,
                    timestamp: new Date().toISOString()
                });
                console.warn(`  [WARNING] Embedding failed for image ID ${candidate_image_record.id}:`, single_image_embedding_error.message);
            }
        }

        // Final persistent save
        fs.writeFileSync(OVIS_EMBEDDINGS_FILE_PATH, JSON.stringify(existing_ovis_embeddings_map));
        console.log(`\nVector Generation Complete: Saved ${Object.keys(existing_ovis_embeddings_map).length} total 2048-dim vectors to public/ovis-embeddings.json.`);
    }

    // WHAT: Writing all failed records into a structured log file (logs/ovis_failed_items.json).
    // WHY: Provides an audit trail of any corrupt images, missing files, or network timeouts
    //      and allows immediate differential re-tries without rescanning the entire database.
    const logs_directory_path = path.join(project_root_directory, 'logs');
    if (!fs.existsSync(logs_directory_path)) {
        fs.mkdirSync(logs_directory_path, { recursive: true });
    }

    const failed_log_file_path = path.join(logs_directory_path, 'ovis_failed_items.json');
    if (pipeline_failed_records_collection.length > 0) {
        fs.writeFileSync(failed_log_file_path, JSON.stringify(pipeline_failed_records_collection, null, 2));
        console.log(`\n⚠️  [FAILED ITEMS LOG]: Encountered ${pipeline_failed_records_collection.length} errors.`);
        console.log(`    Detailed log saved to: logs/ovis_failed_items.json`);
        console.log(`    To retry failed items: simply restart the Ovis server and re-run npm run ovis:pipeline (it automatically picks up unclassified/missing items)`);
    } else {
        if (fs.existsSync(failed_log_file_path)) {
            try { fs.unlinkSync(failed_log_file_path); } catch (unlink_error) {}
        }
        console.log(`\n✨ Perfect Run: 0 failed items. All processed records saved successfully.`);
    }

    console.log('\n======================================================================');
    console.log('Pipeline execution finished successfully.');
    console.log('======================================================================');
}

run_ovis_dataset_pipeline().catch((pipeline_fatal_error) => {
    console.error('\n[FATAL] Pipeline runner encountered an unhandled error:', pipeline_fatal_error);
    process.exit(1);
});
