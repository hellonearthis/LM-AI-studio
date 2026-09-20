/**
 * Search Index Rebuild Script
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

import Database from 'better-sqlite3';
import Fuse from 'fuse.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const current_module_filename = fileURLToPath(import.meta.url);
const current_module_directory = path.dirname(current_module_filename);
const project_root_directory = path.resolve(current_module_directory, '..');

// WHAT: Generates the Fuse.js search index and lightweight search-data.json with cluster themes and facets.
// WHY: Ensures instant keyword and hybrid search capability across all 11,369 images with Laya metadata.
function rebuildIndex() {
    console.log('[INDEX] Connecting to database images.db...');
    const sqlite_database = new Database(path.join(project_root_directory, 'images.db'));

    const sql_joined_query = `
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
    const image_records = sqlite_database.prepare(sql_joined_query).all();
    console.log(`[INDEX] Loaded ${image_records.length} records. Processing JSON analysis fields...`);

    const formatted_search_data = image_records.map(current_image_record => {
        let parsed_analysis_object = {};
        try {
            parsed_analysis_object = typeof current_image_record.analysis === 'string'
                ? JSON.parse(current_image_record.analysis)
                : (current_image_record.analysis || {});
        } catch (json_parsing_error) { /* ignore */ }

        return {
            ...current_image_record,
            analysis: parsed_analysis_object
        };
    });

    console.log('[INDEX] Building Fuse.js index structure...');
    const fuse_index = Fuse.createIndex(
        [
            { name: 'filename', weight: 1 },
            { name: 'analysis.summary', weight: 1 },
            { name: 'analysis.objects', weight: 2 },
            { name: 'analysis.tags', weight: 2 },
            { name: 'theme_name', weight: 1.5 },
            { name: 'facet_medium', weight: 1 },
            { name: 'facet_mood', weight: 1 }
        ],
        formatted_search_data
    );

    const index_output_file_path = path.join(project_root_directory, 'public', 'search-index.json');
    const data_output_file_path = path.join(project_root_directory, 'public', 'search-data.json');

    fs.writeFileSync(index_output_file_path, JSON.stringify(fuse_index.toJSON()));
    fs.writeFileSync(data_output_file_path, JSON.stringify(formatted_search_data));

    console.log(`[INDEX] Index successfully written to: ${index_output_file_path}`);
    console.log(`[INDEX] Data successfully written to: ${data_output_file_path}`);
    sqlite_database.close();
    process.exit(0);
}

rebuildIndex();
