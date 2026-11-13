/**
 * Test & Verification Script for Laya Integration in Image Analysis Studio
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

import Database from 'better-sqlite3';
import { laya_client_instance } from '../services/layaClient.js';

// WHAT: Main verification function testing database integrity, Laya client, and EVoC cluster queries.
// WHY: Ensures all newly added schema tables, indices, and client methods execute without error.
async function runVerificationSuite() {
    console.log('======================================================');
    console.log('Running Image Analysis Studio + Laya Decision Engine Test Suite');
    console.log('======================================================\n');

    // Step 1: Verify SQLite Database tables
    console.log('[1/4] Checking SQLite Database Schema & Tables...');
    const sqlite_database_connection = new Database('images.db');
    
    const required_table_names = ['images', 'image_clusters', 'image_coordinates', 'cluster_themes', 'image_facets'];
    for (const table_name of required_table_names) {
        const table_row_count = sqlite_database_connection.prepare(`SELECT COUNT(*) as total FROM ${table_name}`).get()?.total;
        console.log(`  ✓ Table '${table_name}' verified: ${table_row_count} rows`);
    }

    // Step 2: Test Joined Cluster Theme & Facet Query
    console.log('\n[2/4] Testing Joined Cluster Theme Query...');
    const sample_joined_query = `
        SELECT 
            images.id, 
            images.filename, 
            image_clusters.cluster_label, 
            cluster_themes.theme_name,
            cluster_themes.confidence as cluster_confidence,
            image_facets.medium as facet_medium
        FROM images
        JOIN image_clusters ON images.id = image_clusters.image_id
        LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
        LEFT JOIN image_facets ON images.id = image_facets.image_id
        LIMIT 5
    `;
    const sample_clustered_images = sqlite_database_connection.prepare(sample_joined_query).all();
    console.log(`  ✓ Successfully fetched ${sample_clustered_images.length} sample joined records:`);
    sample_clustered_images.forEach(image_record => {
        console.log(`    - ID ${image_record.id} [Cluster ${image_record.cluster_label}]: Theme = "${image_record.theme_name || 'unthemed'}" (${image_record.filename})`);
    });

    // Step 3: Test Scope Coordinates with Theme Labels
    console.log('\n[3/4] Testing Data Map (/api/scope/db-data) Joined Coordinates Query...');
    const scope_coordinates_query = `
        SELECT 
            image_coordinates.x, 
            image_coordinates.y, 
            image_clusters.cluster_label AS cluster, 
            COALESCE(cluster_themes.theme_name, 'Cluster ' || image_clusters.cluster_label) AS label, 
            images.filename
        FROM image_coordinates
        JOIN image_clusters ON image_coordinates.image_id = image_clusters.image_id
        LEFT JOIN cluster_themes ON image_clusters.cluster_label = cluster_themes.cluster_label
        JOIN images ON image_coordinates.image_id = images.id
        LIMIT 5
    `;
    const sample_coordinate_points = sqlite_database_connection.prepare(scope_coordinates_query).all();
    console.log(`  ✓ Successfully fetched ${sample_coordinate_points.length} sample coordinate points for Data Map:`);
    sample_coordinate_points.forEach(coordinate_point => {
        console.log(`    - (${coordinate_point.x.toFixed(2)}, ${coordinate_point.y.toFixed(2)}) -> ${coordinate_point.label} (${coordinate_point.filename})`);
    });

    // Step 4: Test Laya Microservice Health Probe
    console.log('\n[4/4] Checking Laya Decision Engine Microservice Connection...');
    const is_microservice_online = await laya_client_instance.checkServerHealth(true);
    if (is_microservice_online) {
        console.log(`  ✓ Laya microservice is ONLINE on ${laya_client_instance.active_endpoint_url} (Device: ${laya_client_instance.active_device_name})`);
    } else {
        console.log(`  ℹ Laya microservice is currently OFFLINE on port 8765 (Start it with start_laya_server.bat when running live classifications).`);
    }

    sqlite_database_connection.close();
    console.log('\n======================================================');
    console.log('Verification Suite Completed Successfully!');
    console.log('======================================================');
    process.exit(0);
}

runVerificationSuite().catch(verification_error => {
    console.error('Test Suite Failed:', verification_error);
    process.exit(1);
});
