/**
 * Ovis-Omni Multimodal Engine Integration Test Script
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

import { ovis_omni_client_instance } from '../services/ovisOmniClient.js';

/**
 * WHAT: Verifies connectivity and taxonomy configuration for the Ovis-Omni multimodal microservice.
 * WHY: Provides a quick CLI diagnostic check before running dataset-scale embedding or classification passes.
 */
async function execute_ovis_integration_verification() {
    console.log('======================================================================');
    console.log('Lumina - Ovis-Omni Multimodal Engine Diagnostic Verification');
    console.log('======================================================================\n');

    // WHAT: Probing the Ovis-Omni microservice on port 8082.
    // WHY: Verifies whether the dedicated FastAPI CUDA microservice is actively running.
    console.log('[STEP 1] Probing Ovis-Omni Microservice on http://127.0.0.1:8082/health...');
    const is_microservice_online = await ovis_omni_client_instance.checkHealth(true);

    if (is_microservice_online) {
        console.log('  -> Status: ONLINE');
        console.log(`  -> Endpoint: ${ovis_omni_client_instance.active_endpoint_url}`);
        console.log(`  -> Hardware Device: ${ovis_omni_client_instance.detected_hardware_device_name}`);
        console.log(`  -> Embedding Vector Dimensions: ${ovis_omni_client_instance.embedding_vector_dimensions}`);
    } else {
        console.log('  -> Status: OFFLINE');
        console.log('  -> Note: To launch the CUDA microservice, run "start_ovis_server.bat" or "npm run ovis:serve".');
    }

    // WHAT: Verifying configured visual taxonomies.
    // WHY: Ensures zero-shot classification candidate label sets are properly structured.
    console.log('\n[STEP 2] Verifying Zero-Shot Classification Taxonomies...');
    const configured_taxonomy_facet_names = Object.keys(ovis_omni_client_instance.standard_classification_taxonomies);
    for (const facet_name_string of configured_taxonomy_facet_names) {
        const candidate_labels_list = ovis_omni_client_instance.standard_classification_taxonomies[facet_name_string];
        console.log(`  -> Facet "${facet_name_string}": ${candidate_labels_list.length} candidate categories configured.`);
    }

    console.log('\n======================================================================');
    console.log('Diagnostic Check Complete.');
    console.log('======================================================================');
}

execute_ovis_integration_verification().catch((test_execution_error) => {
    console.error('[TEST-ERROR] Failure during Ovis integration check:', test_execution_error);
    process.exit(1);
});
