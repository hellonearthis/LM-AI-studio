/**
 * ============================================================================
 * TESTS: Pure Functional Core Unit Tests for cardCore.js & searchFilters.js
 * ============================================================================
 *
 * WHAT: Verifies determinism, immutability, XSS escaping, tag deduplication,
 *       filter combinations, sorting, autocomplete ranking, and state transitions.
 * WHY:  Ensures the extracted pure modules work identically in Node.js without
 *       any browser DOM or network mocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeHtmlCharacters,
    normalizeTagComparisonToken,
    deduplicateAndNormalizeAnalysisRecord,
    computeCardGradientVariant,
    calculatePretextCardTextWidth,
    buildSearchResultCardHtml
} from '../public/modules/cardCore.js';

import {
    extractUniqueTagsAndObjectsCatalog,
    filterImageRecordsByCriteria,
    sortFilteredImageRecords,
    rankTagAutocompleteMatches,
    extractSimilarImageSearchState,
    computeUpdatedRecentRenamesList,
    formatDetectedIntentFilterDescriptions
} from '../public/modules/searchFilters.js';

test('escapeHtmlCharacters escapes XSS vectors safely', () => {
    const raw_payload = `<script>alert("xss")</script> & 'quote'`;
    const escaped_payload = escapeHtmlCharacters(raw_payload);
    assert.equal(
        escaped_payload,
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#039;quote&#039;'
    );
    assert.equal(escapeHtmlCharacters(null), '');
    assert.equal(escapeHtmlCharacters(undefined), '');
});

test('deduplicateAndNormalizeAnalysisRecord removes duplicates without mutating inputs', () => {
    const frozen_input_analysis = Object.freeze({
        summary: 'A neon cyberpunk street',
        scene_type: 'Outdoor',
        objects: Object.freeze(['Neon Sign', 'neon-sign', 'Car', 'cars']),
        tags: Object.freeze(['Cyberpunk', 'cyber-punk', 'Car', 'Night'])
    });

    const normalized_analysis = deduplicateAndNormalizeAnalysisRecord(frozen_input_analysis);

    assert.equal(normalizeTagComparisonToken('Neon-Sign'), 'neonsign');
    assert.deepEqual(normalized_analysis.objects, ['Neon Sign', 'Car']);
    assert.deepEqual(normalized_analysis.tags, ['cyber-punk', 'Night']);
    assert.deepEqual(frozen_input_analysis.objects, ['Neon Sign', 'neon-sign', 'Car', 'cars']);
});

test('buildSearchResultCardHtml renders escaped attributes and expected classes', () => {
    const sample_image_record = {
        id: 42,
        filename: 'test<"img">.png',
        path: 'C:\\Images\\test.png',
        created_at: '2026-01-15T12:00:00Z',
        theme_name: 'neon_city',
        facet_medium: 'digital_art',
        facet_mood: 'moody_dark',
        analysis: {
            scene_type: 'Outdoor',
            summary: 'Rainy street <scene>',
            objects: ['umbrella'],
            tags: ['rain']
        }
    };

    const rendered_html = buildSearchResultCardHtml(sample_image_record, {
        summary_height_pixels: 72,
        is_selected: true,
        is_priority_lcp: true,
        is_eager_loaded: true,
        formatted_date_string: '2026-01-15'
    });

    assert.match(rendered_html, /class="card selected"/);
    assert.match(rendered_html, /data-side="1"/);
    assert.match(rendered_html, /data-spin-deg="0"/);
    assert.match(rendered_html, /data-face="1"/);
    assert.match(rendered_html, /data-face="2"/);
    assert.match(rendered_html, /data-face="3"/);
    assert.match(rendered_html, /card-back-tags/);
    assert.match(rendered_html, /card-back-dicer/);
    assert.match(rendered_html, /card-side-pill/);
    assert.equal(computeCardGradientVariant(42), 'green');
    assert.match(rendered_html, /fetchpriority="high"/);
    assert.match(rendered_html, /loading="eager"/);
    assert.match(rendered_html, /min-height: 72px;/);
    assert.match(rendered_html, /test&lt;&quot;img&quot;&gt;\.png/);
    assert.match(rendered_html, /Rainy street &lt;scene&gt;/);
    assert.ok(calculatePretextCardTextWidth(1000, 0) > 120);
});

test('buildSearchResultCardHtml renders tri-face prism with populated diced prompt master record', () => {
    const sample_diced_image_record = {
        id: 99,
        filename: 'cyberpunk_character.png',
        path: 'C:\\Images\\cyberpunk_character.png',
        analysis: {
            summary: 'A futuristic cyber warrior standing under rain.',
            tags: ['cyberpunk', 'rain'],
            objects: ['warrior', 'katana']
        },
        diced_prompt: {
            prompt_id: 'PRM-0099',
            metrics: {
                physicality_ratio: 0.85,
                physical_anchor_count: 8,
                pretext_term_count: 1
            },
            subjects: [
                {
                    subject_id: 'S1',
                    role_label: 'Cyber Warrior',
                    theta_role: 'AGENT',
                    verb_action: 'holding katana'
                }
            ],
            ingredients: [
                {
                    slot: 'subject',
                    text: 'cyber warrior with chrome arm',
                    kind: 'physical_anchor',
                    bound_to_subject_id: 'S1'
                },
                {
                    slot: 'prop',
                    text: 'plasma katana blade',
                    kind: 'physical_anchor',
                    measured_value: { number: '1.2', unit: 'm' }
                }
            ],
            influences: [
                {
                    source_subject_id: 'S1',
                    target_slot: 'prop',
                    effect_description: 'wields weapon'
                }
            ]
        }
    };

    const rendered_card_html = buildSearchResultCardHtml(sample_diced_image_record, {
        summary_height_pixels: 50,
        is_selected: false
    });

    // Face 1: Front Summary
    assert.match(rendered_card_html, /data-face="1"/);
    assert.match(rendered_card_html, /cyberpunk_character\.png/);
    assert.match(rendered_card_html, /A futuristic cyber warrior standing under rain\./);

    // Face 2: Tags & Objects
    assert.match(rendered_card_html, /data-face="2"/);
    assert.match(rendered_card_html, /class="card-back card-back-face card-back-tags"/);
    assert.match(rendered_card_html, /data-tag="cyberpunk"/);
    assert.match(rendered_card_html, /data-tag="katana"/);

    // Face 3: Diced Prompt Master Record
    assert.match(rendered_card_html, /data-face="3"/);
    assert.match(rendered_card_html, /class="card-back card-back-face card-back-dicer"/);
    assert.match(rendered_card_html, /PRM-0099/);
    assert.match(rendered_card_html, /85% Concrete/i);
    assert.match(rendered_card_html, /Cyber Warrior/);
    assert.match(rendered_card_html, /plasma katana blade/);
    assert.match(rendered_card_html, /\[1\.2 m\]/);

    // Side pills for prism faces
    assert.match(rendered_card_html, /data-target-side="3"/);
    assert.match(rendered_card_html, /data-target-side="1"/);
});

test('filterImageRecordsByCriteria handles AND/OR chips, negative terms, facets, and hygiene status', () => {
    const sample_records = [
        {
            id: 1,
            filename: 'cyber_alley.png',
            created_at: '2026-05-01T10:00:00Z',
            theme_name: 'neon_city',
            facet_medium: 'digital_art',
            facet_mood: 'moody',
            facet_composition: 'wide_shot',
            analysis: {
                scene_type: 'Outdoor',
                summary: 'Neon alley in rain',
                tags: ['neon', 'rain'],
                objects: ['sign']
            }
        },
        {
            id: 2,
            filename: 'sunny_cat.png',
            created_at: '2026-05-02T10:00:00Z',
            theme_name: 'pets',
            facet_medium: 'photograph',
            facet_mood: 'bright',
            facet_composition: 'close_up',
            analysis: {
                scene_type: 'Indoor',
                summary: 'Cat sleeping on sofa',
                tags: ['cat', 'cozy'],
                objects: ['sofa']
            }
        },
        {
            id: 3,
            filename: 'incomplete_sketch.png',
            created_at: '2026-05-03T10:00:00Z',
            analysis: {
                scene_type: 'Unknown',
                summary: '',
                tags: [],
                objects: []
            }
        }
    ];

    const and_filtered = filterImageRecordsByCriteria(sample_records, {
        selected_tags: ['neon', 'rain'],
        tag_filter_mode: 'AND'
    });
    assert.deepEqual(and_filtered.map(record => record.id), [1]);

    const or_filtered = filterImageRecordsByCriteria(sample_records, {
        selected_tags: ['neon', 'cat'],
        tag_filter_mode: 'OR'
    });
    assert.deepEqual(or_filtered.map(record => record.id), [1, 2]);

    const excluded_filtered = filterImageRecordsByCriteria(sample_records, {
        exclude_terms_raw: 'sofa'
    });
    assert.deepEqual(excluded_filtered.map(record => record.id), [1, 3]);

    const facet_filtered = filterImageRecordsByCriteria(sample_records, {
        theme_filter: 'neon_city',
        facet_medium: 'digital_art'
    });
    assert.deepEqual(facet_filtered.map(record => record.id), [1]);

    const missing_summary_filtered = filterImageRecordsByCriteria(sample_records, {
        data_status: 'missing-summary'
    });
    assert.deepEqual(missing_summary_filtered.map(record => record.id), [3]);

    const catalog = extractUniqueTagsAndObjectsCatalog(sample_records);
    assert.deepEqual(catalog.sorted_unique_tags, ['cat', 'cozy', 'neon', 'rain']);
    assert.deepEqual(catalog.sorted_unique_objects, ['sign', 'sofa']);
});

test('sortFilteredImageRecords never mutates input array and sorts deterministically', () => {
    const original_records = Object.freeze([
        { id: 10, filename: 'b.png', created_at: '2026-01-01T00:00:00Z' },
        { id: 20, filename: 'a.png', created_at: '2026-03-01T00:00:00Z' }
    ]);

    const sorted_oldest = sortFilteredImageRecords(original_records, 'oldest', false);
    const sorted_newest = sortFilteredImageRecords(original_records, 'newest', false);
    const sorted_relevance = sortFilteredImageRecords(original_records, 'relevance', true);

    assert.deepEqual(sorted_oldest.map(record => record.id), [10, 20]);
    assert.deepEqual(sorted_newest.map(record => record.id), [20, 10]);
    assert.deepEqual(sorted_relevance.map(record => record.id), [10, 20]);
    assert.deepEqual(original_records.map(record => record.id), [10, 20]);
});

test('rankTagAutocompleteMatches, extractSimilarImageSearchState, computeUpdatedRecentRenamesList, and formatDetectedIntentFilterDescriptions', () => {
    const matches = rankTagAutocompleteMatches(
        [{ name: 'cyberpunk', count: 12 }, { name: 'neon', count: 5 }],
        [{ name: 'cybernetic arm', count: 3 }],
        new Set(['cyberpunk']),
        new Set(),
        'cyber',
        10
    );
    assert.deepEqual(matches, [{ name: 'cybernetic arm', count: 3, type: 'object' }]);

    const similar_state = extractSimilarImageSearchState({
        analysis: JSON.stringify({
            tags: ['a', 'b'],
            objects: ['obj1'],
            summary: 'one two three four five six seven eight'
        })
    });
    assert.deepEqual(similar_state.tags_to_select, ['a', 'b']);
    assert.deepEqual(similar_state.objects_to_select, ['obj1']);
    assert.equal(similar_state.truncated_summary_query, 'one two three four five six');

    const next_renames = computeUpdatedRecentRenamesList(['alpha', 'beta'], 'beta', 10);
    assert.deepEqual(next_renames, ['beta', 'alpha']);

    const intent_descriptions = formatDetectedIntentFilterDescriptions({
        suggested_filters: {
            medium: 'oil_painting',
            mood: 'serene_calm'
        }
    });
    assert.deepEqual(intent_descriptions, ['Medium: oil painting', 'Mood: serene calm']);
});

