/**
 * Prompt Dicer Database Tests (Executed inside Electron runtime)
 * 
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables follow semantic, long naming conventions without shorthand abbreviations.
 * Functions and logic branches contain WHAT and WHY annotations explaining the mechanics.
 */

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

/**
 * WHAT: Executes the end-to-end Prompt Dicer SQLite repository verification suite inside Electron's Node ABI.
 * WHY: Verifies schema initialization, transactional persistence, Ovis facet enrichment, review queue cards,
 *      append-only calibration events, and repair jobs against the compiled `better-sqlite3` native addon.
 */
async function execute_database_test_suite() {
    console.log('[PROMPT-DICER-DB-TEST] Starting database repository validation in Electron runtime...');

    // Dynamically import ESM promptDicerDb module
    const {
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
        update_diced_prompt_review_status,
        assign_deterministic_dataset_split,
        export_active_learning_dataset_jsonl,
        fetch_relevant_influences_for_ingredients,
        fetch_transplant_candidate_pools,
        build_review_queue_cards,
        append_review_event_and_sync_item,
        get_calibration_dashboard_summary
    } = await import('../services/promptDicerDb.js');

    const in_memory_database = new Database(':memory:');
    
    // Create base images table for foreign key tests
    in_memory_database.exec(`
        CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT,
            metadata TEXT,
            analysis TEXT
        );
        INSERT INTO images (id, filename, metadata, analysis) 
        VALUES (1, 'sample.jpg', '{"prompt": "A sample prompt"}', '{"summary": "A detailed visual summary."}');
    `);

    // 1. Table initialization
    initialize_prompt_dicer_tables(in_memory_database);
    console.log('[PROMPT-DICER-DB-TEST] ✓ Tables initialized successfully.');

    // 2. Mock master record and influences
    const mock_master_record = {
        prompt_id: 'prm_test_001',
        media_type: 'video',
        raw_prompt: 'A detective in heavy rain under 3200K sodium streetlamp.',
        metrics: {
            physical_anchor_count: 3,
            pretext_term_count: 1,
            physicality_ratio: 0.67
        },
        subjects: [
            {
                subject_id: 'subject_1',
                role_label: 'detective',
                source_reference_tag: null,
                requires_reference_image: false,
                theta_role: 'AGENT',
                verb_action: 'standing',
                instrument: null,
                target_subject_id: null,
                speech_state: 'locked_silent'
            }
        ],
        ambiguous_clauses: [],
        ingredients: [
            {
                ingredient_id: 'ing_1',
                kind: 'physical_anchor',
                text: 'detective',
                slot: 'subject_appearance',
                bound_to_subject_id: 'subject_1',
                measured_value: null
            },
            {
                ingredient_id: 'ing_2',
                kind: 'physical_anchor',
                text: 'heavy rain',
                slot: 'weather_or_matter',
                bound_to_subject_id: null,
                measured_value: null
            },
            {
                ingredient_id: 'ing_3',
                kind: 'physical_anchor',
                text: '3200K sodium streetlamp',
                slot: 'lighting',
                bound_to_subject_id: null,
                measured_value: { number: 3200, unit: 'K' }
            },
            {
                ingredient_id: 'ing_4',
                kind: 'pretext_term',
                text: 'cinematic',
                slot: 'mood',
                bound_to_subject_id: null,
                observable_replacement: {
                    text: 'anamorphic flare',
                    replacement_slot: 'lens'
                }
            }
        ]
    };

    const mock_influences = [
        {
            source_ingredient_id: 'ing_2',
            target_ingredient_id: 'ing_1',
            interaction_type: 'surface_physical',
            portable_target_slot: 'subject_appearance',
            target_subject_scope: 'same_subject_only',
            consequence_description: 'darkened wet fabric',
            state_key: 'surface_moisture',
            applied_state_value: 'wet_specular',
            clashes_with_value: 'dry_matte_dust'
        }
    ];

    // 3. Save diced record
    const save_result = save_diced_prompt_record(
        in_memory_database,
        mock_master_record,
        mock_influences,
        1
    );

    assert.equal(save_result.success, true);
    assert.equal(save_result.prompt_id, 'prm_test_001');
    assert.equal(save_result.ingredient_count, 4);
    assert.equal(save_result.influence_count, 1);

    // Verify synchronization onto the `images` table row (`images.diced_prompt` and `images.analysis.diced_prompt`)
    const updated_image_row = in_memory_database.prepare('SELECT diced_prompt, analysis FROM images WHERE id = 1').get();
    assert.ok(updated_image_row.diced_prompt, 'images.diced_prompt should be populated');
    const parsed_image_diced_prompt = JSON.parse(updated_image_row.diced_prompt);
    assert.equal(parsed_image_diced_prompt.prompt_id, 'prm_test_001');
    assert.equal(parsed_image_diced_prompt.ingredients.length, 4);
    const parsed_image_analysis = JSON.parse(updated_image_row.analysis);
    assert.ok(parsed_image_analysis.diced_prompt, 'images.analysis.diced_prompt should be populated');
    assert.equal(parsed_image_analysis.diced_prompt.prompt_id, 'prm_test_001');
    console.log('[PROMPT-DICER-DB-TEST] ✓ Master record saved transactionally and synced onto images row.');

    // 4. Retrieve by identifier
    const retrieved_record = get_diced_prompt_by_identifier(in_memory_database, 'prm_test_001');
    assert.ok(retrieved_record);
    assert.equal(retrieved_record.prompt_id, 'prm_test_001');
    assert.equal(retrieved_record.ingredients.length, 4);
    assert.equal(retrieved_record.influences.length, 1);
    assert.equal(retrieved_record.influences[0].state_key, 'surface_moisture');
    console.log('[PROMPT-DICER-DB-TEST] ✓ Record retrieved with relations intact.');

    // 5. Query by slot
    const lighting_ingredients = get_ingredients_catalog_by_slot(in_memory_database, 'lighting');
    assert.equal(lighting_ingredients.length, 1);
    assert.equal(lighting_ingredients[0].text, '3200K sodium streetlamp');
    console.log('[PROMPT-DICER-DB-TEST] ✓ Slot query returned matching ingredients.');

    // 6. Pagination check
    const all_prompts = get_all_diced_prompts(in_memory_database, 10, 0);
    assert.equal(all_prompts.length, 1);
    assert.equal(all_prompts[0].prompt_id, 'prm_test_001');

    // 7. Update review status
    const update_status_result = update_diced_prompt_review_status(in_memory_database, 'prm_test_001', true);
    assert.equal(update_status_result, true);

    // 8. Export active learning dataset
    const jsonl_dataset = export_active_learning_dataset_jsonl(in_memory_database);
    assert.equal(jsonl_dataset.length, 1);
    const parsed_jsonl_row = JSON.parse(jsonl_dataset[0]);
    assert.equal(parsed_jsonl_row.label, 1);
    assert.equal(parsed_jsonl_row.source_text, 'heavy rain');
    assert.equal(parsed_jsonl_row.target_text, 'detective');
    assert.equal(parsed_jsonl_row.state_key, 'surface_moisture');
    console.log('[PROMPT-DICER-DB-TEST] ✓ Active learning JSONL dataset exported.');

    // 9. Validate & detect stale description updates + missing entries
    in_memory_database.exec(`
        INSERT INTO images (id, filename, metadata, analysis)
        VALUES (2, 'new_image.jpg', '{}', '{"summary": "A wide shot on 50mm lens of a neon street in fog."}');
    `);
    const updated_stale_summary = JSON.stringify({
        summary: 'Close-up portrait under 5600K daylight with shallow depth of field.',
        diced_prompt: parsed_image_diced_prompt
    });
    in_memory_database.prepare(`UPDATE images SET metadata = '{}', analysis = ? WHERE id = 1`).run(updated_stale_summary);

    const validation_result = await validate_and_repair_diced_prompts(in_memory_database, {
        force_heuristic: true
    });
    assert.equal(validation_result.total_images, 2);
    assert.equal(validation_result.stale_re_diced_count, 1, 'Image 1 updated description should be re-diced as stale');
    assert.equal(validation_result.missing_repaired_count, 1, 'Image 2 missing diced prompt should be repaired');

    const refreshed_image_1 = get_diced_prompt_by_identifier(in_memory_database, 'prm_00001');
    assert.ok(refreshed_image_1);
    assert.ok(refreshed_image_1.raw_prompt.includes('5600K daylight'));
    const stats_summary = get_diced_catalog_statistics(in_memory_database);
    assert.equal(stats_summary.total_prompts, 2);
    assert.ok(stats_summary.unique_ingredients >= 2);
    console.log('[PROMPT-DICER-DB-TEST] ✓ Validation detected stale & missing entries and repaired both.');

    // 10. Ovis-Omni integration tests: image_facets slot fallback, image_clusters compatibility, and visual grounding
    in_memory_database.exec(`
        CREATE TABLE image_facets (
            image_id INTEGER PRIMARY KEY,
            medium TEXT,
            mood TEXT,
            composition TEXT,
            detail_score REAL,
            confidence_medium REAL,
            confidence_mood REAL,
            confidence_composition REAL
        );
        CREATE TABLE image_clusters (
            image_id INTEGER,
            cluster_label TEXT
        );
        INSERT INTO images (id, filename, metadata, analysis)
        VALUES (3, 'neighbor_shot.jpg', '{}', '{"summary": "Warm tungsten streetlamp in fog with wet cobblestones."}');
        INSERT INTO image_facets (image_id, medium, mood, composition, detail_score, confidence_medium, confidence_mood, confidence_composition)
        VALUES (2, 'digital_art', 'dramatic_cinematic', 'wide_landscape', 0.72, 0.81, 0.77, 0.69);
        INSERT INTO image_clusters (image_id, cluster_label) VALUES (1, 'cluster_noir'), (3, 'cluster_noir');
    `);

    const enriched_image_2 = await dice_and_save_image_record(
        in_memory_database,
        {
            id: 2,
            filename: 'new_image.jpg',
            metadata: '{}',
            analysis: '{"summary": "A neon street alley at night."}'
        },
        { force_heuristic: true }
    );
    assert.ok(
        enriched_image_2.master_record.ingredients.some(item => item.source === 'ovis_facet' && item.slot === 'film_stock_or_medium'),
        'image_facets should fill missing film_stock_or_medium slot with ovis_facet provenance'
    );

    await dice_and_save_image_record(
        in_memory_database,
        in_memory_database.prepare('SELECT * FROM images WHERE id = 3').get(),
        { force_heuristic: true }
    );

    const compatible_suggestions = get_visually_compatible_ingredients(in_memory_database, {
        reference_image_ids: [1],
        limit: 50
    });
    assert.equal(compatible_suggestions.visual_ranking_active, true);
    assert.deepEqual([...compatible_suggestions.cluster_labels_used], ['cluster_noir']);
    assert.ok(compatible_suggestions.ingredients.length >= 1);

    const grounding_verdict = await evaluate_caption_visual_grounding_for_image(
        { id: 1, filename: 'sample.jpg', path: '' },
        'Close-up portrait under daylight.',
        {
            ovis_client: {
                checkHealth: async () => true,
                generateTextEmbedding: async (text_value) => {
                    if (String(text_value).includes('missing')) return [-0.8, 0.6];
                    return [0.6, 0.8];
                }
            },
            cached_ovis_embeddings_map: { '1': [0.6, 0.8] },
            ingredients: [
                { ingredient_id: 'ing_present', text: 'Close-up portrait', slot: 'framing', kind: 'physical_anchor' },
                { ingredient_id: 'ing_missing', text: 'missing neon dragon', slot: 'subject_appearance', kind: 'physical_anchor' }
            ]
        }
    );
    assert.equal(grounding_verdict.checked, true);
    assert.equal(grounding_verdict.grounding_status, 'grounded');
    assert.equal(grounding_verdict.used_cached_image_vector, true);
    assert.equal(grounding_verdict.missing_ingredients.length, 1);
    assert.equal(grounding_verdict.missing_ingredients[0].ingredient_id, 'ing_missing');

    // Verify ovis_enriched_count separation and idempotent second validation pass
    const first_sync_summary = await validate_and_repair_diced_prompts(in_memory_database, {
        force_heuristic: true,
        sync_ovis_facets: true
    });
    const second_sync_summary = await validate_and_repair_diced_prompts(in_memory_database, {
        force_heuristic: true,
        sync_ovis_facets: true
    });
    assert.equal(second_sync_summary.desynced_repaired_count, 0);
    assert.equal(second_sync_summary.ovis_enriched_count, 0);
    assert.equal(second_sync_summary.valid_count, first_sync_summary.total_images);

    // Verify reviewed_only + deterministic train/holdout split export controls
    const unreviewed_only_rows = export_active_learning_dataset_jsonl(in_memory_database, { reviewed_only: true });
    assert.equal(unreviewed_only_rows.length, 0, 'Zero rows have is_reviewed=1 right now, so reviewed_only must return empty');

    const prompt_1_split = assign_deterministic_dataset_split('prm_00001', 0.2);
    assert.equal(assign_deterministic_dataset_split('prm_00001', 0.2), prompt_1_split);
    const all_export_rows = export_active_learning_dataset_jsonl(in_memory_database, { reviewed_only: false, split: 'all' });
    const train_export_rows = export_active_learning_dataset_jsonl(in_memory_database, { reviewed_only: false, split: 'train' });
    const holdout_export_rows = export_active_learning_dataset_jsonl(in_memory_database, { reviewed_only: false, split: 'holdout' });
    assert.equal(train_export_rows.length + holdout_export_rows.length, all_export_rows.length);

    // Verify Phase 1 SQLite graph & transplant candidate pool loaders
    const base_record = get_diced_prompt_by_identifier(in_memory_database, 'prm_00001');
    const candidate_bundle = fetch_transplant_candidate_pools(
        in_memory_database,
        base_record.ingredients.map(item => ({ ...item, prompt_id: base_record.prompt_id })),
        { locked_slots: ['subject_appearance', 'lens'], per_slot_limit: 10 }
    );
    assert.equal(candidate_bundle.candidate_pools_by_slot.subject_appearance, undefined, 'Locked slots must not generate swap pools');
    assert.ok(candidate_bundle.candidate_pools_by_slot.lighting !== undefined, 'Unlocked lighting slot should build a candidate pool');
    const graph_edges = fetch_relevant_influences_for_ingredients(
        in_memory_database,
        base_record.ingredients.map(item => ({ ...item, prompt_id: base_record.prompt_id }))
    );
    assert.ok(Array.isArray(graph_edges.influences) && Array.isArray(graph_edges.target_ingredients));

    console.log('[PROMPT-DICER-DB-TEST] ✓ Ovis-Omni facets, per-ingredient grounding, idempotent sync, holdout export, Phase 1 pools, and EVoC checks passed.');

    // 11. Single-question review queue, append-only review_events, per-item is_reviewed export & calibration dashboard
    const initial_review_queue = build_review_queue_cards(in_memory_database, {
        card_type: 'all',
        ordering: 'stratified',
        limit: 40,
        seed: 7
    });
    assert.ok(initial_review_queue.cards.length > 0, 'Review queue should generate single-question cards');
    assert.ok(
        initial_review_queue.cards.some(card => card.card_type === 'edge_check'),
        'Review queue should include edge_check cards for stored influences'
    );
    assert.ok(
        initial_review_queue.cards.some(card => card.card_type === 'slot_check'),
        'Review queue should include slot_check cards for extracted ingredients'
    );

    // Record per-item edge confirmation via append-only review_events
    const first_edge_card = initial_review_queue.cards.find(card => card.card_type === 'edge_check');
    const edge_event_result = append_review_event_and_sync_item(in_memory_database, {
        card_type: 'edge_check',
        item_type: first_edge_card.item_type,
        item_id: first_edge_card.item_id,
        prompt_id: first_edge_card.prompt_id,
        image_id: first_edge_card.image_id,
        label: 'confirmed',
        model_confidence: 0.78,
        model_version: 'laya-v1-test',
        reviewer: 'qa_tester'
    });
    assert.equal(edge_event_result.success, true);

    // Per-item reviewed export must now return that confirmed influence even while other items stay unreviewed
    const per_item_reviewed_export = export_active_learning_dataset_jsonl(in_memory_database, { reviewed_only: true, split: 'all' });
    assert.ok(
        per_item_reviewed_export.length >= 1,
        'reviewed_only export must include individual edges marked is_reviewed=1 via review_events'
    );

    // Record slot correction and missing_edge probe discovery
    const first_slot_card = initial_review_queue.cards.find(card => card.card_type === 'slot_check');
    append_review_event_and_sync_item(in_memory_database, {
        card_type: 'slot_check',
        item_type: first_slot_card.item_type,
        item_id: first_slot_card.item_id,
        prompt_id: first_slot_card.prompt_id,
        image_id: first_slot_card.image_id,
        label: 'corrected_slot',
        corrected_value: { new_slot: 'mood' },
        model_confidence: 0.42,
        model_version: 'ovis-facet-fallback'
    });

    const ing_id_num = Number(String(first_slot_card.item_id).split(':')[1]);
    const updated_ing_row = in_memory_database.prepare('SELECT slot, is_reviewed FROM diced_ingredients WHERE id = ?').get(ing_id_num);
    assert.equal(updated_ing_row.slot, 'mood');
    assert.equal(updated_ing_row.is_reviewed, 1);

    append_review_event_and_sync_item(in_memory_database, {
        card_type: 'missing_edge',
        item_type: 'missing_edge_probe',
        item_id: base_record.prompt_id,
        prompt_id: base_record.prompt_id,
        image_id: 1,
        label: 'added_edge',
        corrected_value: {
            source_ingredient_id: base_record.ingredients[0].ingredient_id,
            target_ingredient_id: base_record.ingredients[1]?.ingredient_id || base_record.ingredients[0].ingredient_id,
            state_key: 'lighting_tint',
            applied_state_value: 'warm_daylight'
        },
        model_confidence: null,
        model_version: 'heuristic-pass-d'
    });

    // Append a repeat-check event matching the confirmed edge to test intra-rater agreement calculation
    append_review_event_and_sync_item(in_memory_database, {
        card_type: 'edge_check',
        item_type: first_edge_card.item_type,
        item_id: first_edge_card.item_id,
        prompt_id: first_edge_card.prompt_id,
        image_id: first_edge_card.image_id,
        label: 'confirmed',
        model_confidence: 0.78,
        model_version: 'laya-v1-test',
        is_repeat_check: true
    });

    const calibration_summary = get_calibration_dashboard_summary(in_memory_database);
    assert.equal(calibration_summary.edge_recall_estimate.confirmed_edges_count, 1);
    assert.equal(calibration_summary.edge_recall_estimate.newly_discovered_edges_count, 1);
    assert.equal(calibration_summary.edge_recall_estimate.estimated_recall, 0.5);
    assert.equal(calibration_summary.repeat_consistency.paired_repeats, 1);
    assert.equal(calibration_summary.repeat_consistency.agreement_rate, 1);
    console.log('[PROMPT-DICER-DB-TEST] ✓ Review queue, append-only review_events, per-item reviewed export, and calibration summary passed.');

    in_memory_database.close();
    console.log('[PROMPT-DICER-DB-TEST] ALL DATABASE REPOSITORY TESTS PASSED SUCCESSFULLY.');
    process.exit(0);
}

execute_database_test_suite().catch((test_error) => {
    console.error('[PROMPT-DICER-DB-TEST] FAILED:', test_error);
    process.exit(1);
});

