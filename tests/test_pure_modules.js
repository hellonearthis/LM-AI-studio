import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
    buildDataUrlFromBuffer,
    mergeCustomTagsIntoAnalysis,
    extractDisplayableMetadataFields,
    buildFastScanBatchPayload,
    computeBatchProgressStats,
    tallyBatchSaveOutcome
} from '../public/modules/appCore.js';

import {
    buildUserConfigurationPayload,
    buildModelLoadRequestPayload,
    formatModelLoadStatusPresentation,
    formatLayaStatusPresentation,
    formatStreamingLogChunkHtml
} from '../public/modules/settingsCore.js';

import {
    getClusterColour,
    normalizeCoordinatePointRecords,
    buildClusterSummaryCatalog,
    filterClusterSummariesBySearch,
    filterPointsBySelectedClusters,
    computeSquareCoverCropMetrics,
    computeThumbnailFrameMetrics
} from '../public/modules/scopeCore.js';

import {
    buildRemixPromptThumbnailHtml,
    buildClosureTraceBannerHtml,
    buildRoundTripBadgeMeta,
    buildSittingProgressHtml,
    buildHighlightedPromptTokensHtml,
    buildGroundingHistogramSvg,
    buildLayaCalibrationSvg
} from '../public/modules/dicerRenderers.js';

import {
    repairTruncatedJson,
    deduplicateTagsPure
} from '../services/server/analysisHelpers.js';

import {
    computeEmbeddingKeyAudit,
    pruneEmbeddingMapByActiveIds
} from '../services/server/embeddingAudit.js';

import {
    filterAndSortTaxonomyItems,
    buildTagCloudHtml,
    buildTagListHtml
} from '../public/modules/tagsCore.js';

import {
    computeCardPixelWidthFromGridWidth,
    computeTriangularPrismRadiusPixels,
    computeNextPrismSpinDegrees,
    getCardGrad,
    escapeCardHtmlText,
    extractDicedPromptMasterRecord,
    createCardHtml
} from '../public/modules/databaseCardRenderers.js';

function loadVectorMathInSandbox() {
    const vector_math_source = fs.readFileSync(new URL('../public/modules/vectorMath.js', import.meta.url), 'utf8');
    const sandbox_context = {
        Float32Array,
        Int32Array,
        Math,
        Set,
        Map,
        Array,
        Number,
        Object,
        self: {},
        module: { exports: {} }
    };
    vm.runInNewContext(vector_math_source, sandbox_context);
    return sandbox_context.module.exports;
}

const vector_math = loadVectorMathInSandbox();

test('appCore pure transformations handle data URLs, custom tags, metadata, and batch tallies', () => {
    const data_url = buildDataUrlFromBuffer('sample.png', new Uint8Array([65, 66]).buffer);
    assert.equal(data_url, 'data:image/png;base64,QUI=');

    const merged = mergeCustomTagsIntoAnalysis({ tags: ['portrait', 'neon'] }, 'neon, rain , cyberpunk');
    assert.deepEqual(merged.tags, ['portrait', 'neon', 'rain', 'cyberpunk']);

    const metadata_fields = extractDisplayableMetadataFields({ ImageWidth: 1920, ISO: 400, FNumber: 2.8 });
    assert.equal(metadata_fields.length, 3);

    const batch_payload = buildFastScanBatchPayload([
        { path: 'C:/a.png', size: 123, mtime: 456 }
    ]);
    assert.deepEqual(batch_payload, [{ path: 'C:/a.png', size: 123, mtime: 456 }]);

    const progress = computeBatchProgressStats(3, 5, 'a.png');
    assert.equal(progress.percent, 60);

    const tally = tallyBatchSaveOutcome({ addedCount: 1, updatedCount: 0, duplicateCount: 0, errorCount: 0 }, { new: true });
    assert.deepEqual(tally, { addedCount: 2, updatedCount: 0, duplicateCount: 0, errorCount: 0 });
});

test('settingsCore pure builders and formatters escape HTML and preserve contextLength', () => {
    const config_payload = buildUserConfigurationPayload('qwen.gguf', 'embed.gguf', '32', '8192');
    assert.equal(config_payload.gpuLayers, '32');
    assert.equal(config_payload.contextLength, 8192);
    assert.equal(config_payload.visionModel, 'qwen.gguf');
    assert.equal(config_payload.embeddingModel, 'embed.gguf');

    const load_payload = buildModelLoadRequestPayload('qwen.gguf', '16', '4096');
    assert.deepEqual(load_payload, { model_identifier: 'qwen.gguf', config: { gpu_offload: '16', context_length: 4096 } });

    const model_status = formatModelLoadStatusPresentation(true, 'qwen.gguf');
    assert.match(model_status.text, /Model Loaded/);

    const laya_status = formatLayaStatusPresentation({ status: 'online', device: 'cuda', endpoint: 'http://localhost:8765', cluster_themes_count: 3, classified_facets_count: 10 });
    assert.match(laya_status.titleText, /cuda/);
    assert.equal(laya_status.enableBatchButton, true);

    const escaped_log = formatStreamingLogChunkHtml('<script>alert(1)</script>');
    assert.equal(escaped_log, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('scopeCore normalizes points, filters clusters, and computes aspect-cover crop metrics', () => {
    assert.equal(getClusterColour(-1), '#6b7280');
    assert.match(getClusterColour(0), /^hsl\(/);

    const normalized = normalizeCoordinatePointRecords([
        { id: 1, x: 10, y: 20, cluster: '2', filename: 'a.jpg', width: 100, height: 100 },
        { id: 2, x: 30, y: 40, cluster: 5, filename: 'b.jpg', width: 200, height: 100 }
    ]);
    assert.equal(normalized[0].cluster, 2);

    const summaries = buildClusterSummaryCatalog(normalized);
    assert.equal(summaries.length, 2);
    assert.equal(filterClusterSummariesBySearch(summaries, '5').length, 1);

    const selected_points = filterPointsBySelectedClusters(normalized, new Set([2]));
    assert.equal(selected_points.length, 1);
    assert.equal(selected_points[0].id, 1);

    const crop = computeSquareCoverCropMetrics(200, 100);
    assert.deepEqual(crop, { squareCropSideLengthPixels: 100, cropOffsetHorizontalPixels: 50, cropOffsetVerticalPixels: 0 });

    const frame = computeThumbnailFrameMetrics(40, 1, 50);
    assert.equal(frame.onScreenSizePixels, 40);
    assert.equal(frame.halfSizePixels, 20);
    assert.equal(frame.wantsHighResolutionImages, false);
});

test('dicerRenderers generates safe escaped HTML and SVG markup', () => {
    const thumb_html = buildRemixPromptThumbnailHtml({ image_id: 42, updated_at: '100', raw_prompt: 'neon <bad>' });
    assert.match(thumb_html, /thumbnails\/id_42\.avif\?t=100/);
    assert.ok(!thumb_html.includes('<bad>'));

    const banner_html = buildClosureTraceBannerHtml({
        pulled_effects: [{ slot: 'lighting', text: 'neon <glow>', reason: 'implied' }],
        pruned_orphans: []
    }, []);
    assert.match(banner_html, /&lt;glow&gt;/);

    const badge = buildRoundTripBadgeMeta({ verified: true, preserved_slot_count: 3, total_planned_slots: 3 });
    assert.equal(badge.visible, true);
    assert.match(badge.text, /3\/3 slots/);

    const progress_html = buildSittingProgressHtml({
        grounding: { current: 2, target: 5 },
        edge_check: { current: 1, target: 10 },
        slot_check: { current: 0, target: 10 },
        missing_edge: { current: 0, target: 10 }
    });
    assert.match(progress_html, /40%/);

    const tokens_html = buildHighlightedPromptTokensHtml({
        raw_prompt: 'neon rain',
        ingredients: [{ text: 'rain', slot: 'weather_or_matter', ingredient_id: 'ing_1' }],
        target_ingredient_id: 'ing_1'
    });
    assert.match(tokens_html, /neon rain/);
    assert.match(tokens_html, /review-slot-token-active/);

    const hist_svg = buildGroundingHistogramSvg(
        'Cosine',
        { bins: [{ label: '0.8', counts: { ok: 3 } }] },
        [{ key: 'ok', label: 'OK', color: '#4ade80' }]
    );
    assert.match(hist_svg, /<svg/);

    const cal_svg = buildLayaCalibrationSvg([{ band_label: '0.8', empirical_accuracy: 0.75, avg_confidence: 0.8, sample_count: 4 }]);
    assert.match(cal_svg, /<svg/);
});

test('vectorMath performs contiguous Float32 normalization, dot products, and RRF fusion', () => {
    const contiguous = vector_math.buildContiguousVectorData({
        '10': [3, 4],
        '20': [0, 1]
    });
    assert.equal(contiguous.dimensionsCount, 2);
    assert.equal(contiguous.vectorsCount, 2);

    const norm_query = vector_math.normalizeQueryVectorToFloat32([0, 5], 2);
    assert.ok(Math.abs(norm_query[1] - 1) < 1e-5);

    const scored = vector_math.computeContiguousCpuDotProducts(
        contiguous.buffer,
        contiguous.dimensionsCount,
        contiguous.vectorsCount,
        contiguous.indexedIdentifiers,
        norm_query,
        0.0,
        (id) => ({ id })
    );
    assert.equal(scored[0].item.id, '20');
    assert.ok(scored[0].score > scored[1].score);

    const fused = vector_math.fuseRankedListsPure(
        [{ id: 10 }, { id: 20 }],
        [{ id: 20 }, { id: 30 }],
        60
    );
    assert.equal(fused.length, 3);
    assert.equal(fused[0].id, 20);
});

test('server analysisHelpers and embeddingAudit perform pure JSON repair, tag dedup, and orphan auditing', () => {
    const repaired = repairTruncatedJson('{"tags": ["a", "b"');
    assert.deepEqual(JSON.parse(repaired), { tags: ['a', 'b'] });

    const repaired_with_escaped_quotes_and_brackets = repairTruncatedJson('{"summary": "A \\"neon\\" [scene] {test", "tags": ["x"');
    assert.deepEqual(JSON.parse(repaired_with_escaped_quotes_and_brackets), {
        summary: 'A "neon" [scene] {test',
        tags: ['x']
    });

    const deduped = deduplicateTagsPure({ tags: ['Neon', 'neon', 'Cyberpunk', '  '] });
    assert.deepEqual(deduped.tags, ['Neon', 'Cyberpunk']);

    const audit = computeEmbeddingKeyAudit(new Set(['1', '99']), new Set(['1', '2']));
    assert.deepEqual(audit.orphanedKeys, ['99']);
    assert.equal(audit.missingCount, 1);

    const pruned = pruneEmbeddingMapByActiveIds({ '1': [0.1], '99': [0.2] }, new Set(['1', '2']));
    assert.deepEqual(pruned, { '1': [0.1] });
});

test('tagsCore filters, sorts, and renders escaped tag cloud and alphabetical list HTML', () => {
    const sample_items = [
        { name: 'zebra', count: 2 },
        { name: 'apple<tag>', count: 10 },
        { name: 'apricot', count: 5 }
    ];
    const filtered_sorted = filterAndSortTaxonomyItems(sample_items, 'ap', 'count');
    assert.equal(filtered_sorted.length, 2);
    assert.equal(filtered_sorted[0].name, 'apple<tag>');

    const cloud_html = buildTagCloudHtml(filtered_sorted, 'tags');
    assert.match(cloud_html, /apple&lt;tag&gt;/);
    assert.ok(!cloud_html.includes('apple<tag>'));

    const alpha_list = buildTagListHtml(filtered_sorted, 'objects', 'name');
    assert.equal(alpha_list.showAlphabetNav, true);
    assert.match(alpha_list.alphabetNavHtml, /href="#letter-A"/);
    assert.match(alpha_list.listHtml, /type=object/);
});

test('databaseCardRenderers computes prism geometry and renders escaped tri-face card HTML', () => {
    const card_width = computeCardPixelWidthFromGridWidth(1000);
    assert.ok(card_width >= 420);

    const apothem = computeTriangularPrismRadiusPixels(300);
    assert.ok(apothem > 80 && apothem < 90);

    const next_spin = computeNextPrismSpinDegrees(0, '1', '2');
    assert.equal(next_spin, -120);

    assert.ok(['purple', 'blue', 'green', 'orange', 'pink'].includes(getCardGrad(42)));
    assert.equal(escapeCardHtmlText('<b>hi</b>'), '&lt;b&gt;hi&lt;/b&gt;');

    const extracted = extractDicedPromptMasterRecord({
        diced_prompt: JSON.stringify({ raw_prompt: 'neon city', metrics: { physicality_ratio: 0.8 } })
    }, {});
    assert.equal(extracted.raw_prompt, 'neon city');

    const card_html = createCardHtml({
        id: 42,
        filename: 'neon<1>.png',
        path: 'C:/img/neon"quote.png',
        analysis: JSON.stringify({ summary: 'Neon <script>alert(1)</script> rain', tags: ['neon'] })
    }, 80, true, true, true);
    assert.match(card_html, /neon&lt;1&gt;\.png/);
    assert.match(card_html, /neon&quot;quote\.png/);
    assert.match(card_html, /Neon &lt;script&gt;alert\(1\)&lt;\/script&gt; rain/);
    assert.ok(!card_html.includes('<script>alert(1)</script>'));
    assert.match(card_html, /checked/);
});
