/**
 * Prompt Dicer Review Queue Sampling & Calibration Analytics
 *
 * WHAT: Pure deterministic stratified / uncertainty review queue ordering and
 *       append-only calibration analytics computation.
 * WHY: Keeps review sampling and histogram math isolated and 100% pure.
 */

// WHAT: First-sitting target counts for bootstrapping calibrated grounding cutoffs, edge recall, and Laya fine-tuning.
// WHY: Aligns calibration dashboard progress indicators directly with statistically useful sample thresholds.
export const REVIEW_SITTING_TARGETS = Object.freeze({
    grounding: 200,
    edge_check: 300,
    slot_check: 300,
    missing_edge: 50
});

/**
 * WHAT: Computes a deterministic unit score in [0, 1) from a string key and explicit integer seed.
 * WHY: Provides reproducible pseudo-random ordering within stratified buckets without impure `Math.random()` state.
 */
function deterministic_unit_hash(item_key_string, seed_integer = 1) {
    const combined_key = `${Number(seed_integer) || 0}::${String(item_key_string || '')}`;
    let fnv_accumulator = 2166136261;
    for (let char_position = 0; char_position < combined_key.length; char_position++) {
        fnv_accumulator ^= combined_key.charCodeAt(char_position);
        fnv_accumulator = Math.imul(fnv_accumulator, 16777619);
    }
    return ((fnv_accumulator >>> 0) % 100000) / 100000;
}

/**
 * WHAT: Orders candidate review cards using stratified sampling (Pass 1) or uncertainty sampling (post-tune) and quietly injects ~5% repeat checks.
 * WHY: Keeps untuned Laya confidence from distorting first-pass sampling across slots/sources/prompt lengths while catching ambiguous definitions via self-consistency checks.
 */
export function build_stratified_review_queue_order(
    candidate_cards_collection = [],
    repeat_pool_cards = [],
    queue_options = {}
) {
    const safe_candidates = Array.isArray(candidate_cards_collection) ? candidate_cards_collection : [];
    const safe_repeats = Array.isArray(repeat_pool_cards) ? repeat_pool_cards : [];
    const ordering_mode = queue_options.ordering === 'uncertainty' ? 'uncertainty' : 'stratified';
    const queue_limit = Math.max(1, Math.min(200, Number(queue_options.limit) || 40));
    const repeat_fraction = Number.isFinite(queue_options.repeat_fraction)
        ? Math.max(0, Math.min(0.25, Number(queue_options.repeat_fraction)))
        : 0.05;
    const explicit_seed = Number(queue_options.seed) || 1;

    let base_ordered_cards = [];

    if (ordering_mode === 'uncertainty') {
        base_ordered_cards = safe_candidates
            .map(card => ({
                card,
                uncertainty_distance: Math.abs((Number.isFinite(Number(card.model_confidence)) ? Number(card.model_confidence) : 0.5) - 0.5),
                tie_hash: deterministic_unit_hash(card.card_key || card.item_id, explicit_seed)
            }))
            .toSorted((alpha, beta) => {
                if (alpha.uncertainty_distance !== beta.uncertainty_distance) {
                    return alpha.uncertainty_distance - beta.uncertainty_distance;
                }
                return alpha.tie_hash - beta.tie_hash;
            })
            .map(entry => entry.card);
    } else {
        const strata_buckets_map = new Map();
        for (const card of safe_candidates) {
            const stratum = String(card.stratum_key || `${card.card_type || 'unknown'}::${card.slot || 'other'}::${card.source || 'prompt_extraction'}::${card.length_bucket || 'medium'}`);
            if (!strata_buckets_map.has(stratum)) {
                strata_buckets_map.set(stratum, []);
            }
            strata_buckets_map.get(stratum).push(card);
        }

        const ordered_strata_queues = Array.from(strata_buckets_map.entries())
            .toSorted((first_entry, second_entry) =>
                deterministic_unit_hash(first_entry[0], explicit_seed) - deterministic_unit_hash(second_entry[0], explicit_seed)
            )
            .map(([, bucket_cards]) =>
                bucket_cards.toSorted((alpha, beta) =>
                    deterministic_unit_hash(alpha.card_key || alpha.item_id, explicit_seed) - deterministic_unit_hash(beta.card_key || beta.item_id, explicit_seed)
                )
            );

        let bucket_offset = 0;
        let exhausted_all_buckets = false;
        while (!exhausted_all_buckets && base_ordered_cards.length < queue_limit) {
            exhausted_all_buckets = true;
            for (const single_bucket of ordered_strata_queues) {
                if (bucket_offset < single_bucket.length) {
                    base_ordered_cards.push(single_bucket[bucket_offset]);
                    exhausted_all_buckets = false;
                    if (base_ordered_cards.length >= queue_limit) break;
                }
            }
            bucket_offset++;
        }
    }

    const sliced_base_cards = base_ordered_cards.slice(0, queue_limit);

    if (safe_repeats.length === 0 || repeat_fraction <= 0) {
        return Object.freeze(sliced_base_cards.map(card => Object.freeze({ ...card, is_repeat_check: false })));
    }

    const target_repeat_count = sliced_base_cards.length >= 10
        ? Math.max(1, Math.round(sliced_base_cards.length * repeat_fraction))
        : (safe_repeats.length >= 1 && sliced_base_cards.length >= 5 && deterministic_unit_hash('repeat_gate', explicit_seed) < repeat_fraction * 4 ? 1 : 0);

    if (target_repeat_count === 0) {
        return Object.freeze(sliced_base_cards.map(card => Object.freeze({ ...card, is_repeat_check: false })));
    }

    const sorted_repeats = safe_repeats
        .toSorted((alpha, beta) =>
            deterministic_unit_hash(alpha.card_key || alpha.item_id, explicit_seed + 17)
            - deterministic_unit_hash(beta.card_key || beta.item_id, explicit_seed + 17)
        )
        .slice(0, Math.min(target_repeat_count, safe_repeats.length));

    const combined_queue = [...sliced_base_cards.map(card => Object.freeze({ ...card, is_repeat_check: false }))];
    const spacing_interval = Math.max(2, Math.floor(combined_queue.length / (sorted_repeats.length + 1)));

    for (let repeat_index = 0; repeat_index < sorted_repeats.length; repeat_index++) {
        const repeat_card = Object.freeze({
            ...sorted_repeats[repeat_index],
            is_repeat_check: true
        });
        const insert_position = Math.min(combined_queue.length, (repeat_index + 1) * spacing_interval);
        combined_queue.splice(insert_position, 0, repeat_card);
    }

    return Object.freeze(combined_queue.slice(0, queue_limit));
}

/**
 * WHAT: Computes score histograms, Laya confidence calibration bands, Pass D recall estimates, and sitting targets from append-only `review_events`.
 * WHY: Answers the key calibration unknowns (caption/ingredient cutoffs, untuned vs. fine-tuned Laya calibration, missing edge rate) without heuristics.
 */
export function compute_calibration_and_grounding_analytics(review_events_rows = [], _analytics_options = {}) {
    const safe_events = Array.isArray(review_events_rows) ? review_events_rows : [];
    const non_skipped_events = safe_events.filter(event_row => event_row && event_row.label !== 'skipped');

    const histogram_bins_spec = [
        { label: '0.00–0.05', min: -1, max: 0.05 },
        { label: '0.05–0.10', min: 0.05, max: 0.10 },
        { label: '0.10–0.15', min: 0.10, max: 0.15 },
        { label: '0.15–0.20', min: 0.15, max: 0.20 },
        { label: '0.20–0.25', min: 0.20, max: 0.25 },
        { label: '0.25–0.30', min: 0.25, max: 0.30 },
        { label: '0.30–0.35', min: 0.30, max: 0.35 },
        { label: '0.35–0.40', min: 0.35, max: 0.40 },
        { label: '0.40–0.45', min: 0.40, max: 0.45 },
        { label: '0.45+', min: 0.45, max: 2.0 }
    ];

    const build_histogram = (card_type_filter, label_keys) => {
        const bins = histogram_bins_spec.map(bin_def => {
            const counts = {};
            for (const key of label_keys) counts[key] = 0;
            return { ...bin_def, counts };
        });

        for (const event_row of non_skipped_events) {
            if (event_row.card_type !== card_type_filter) continue;
            const score = Number(event_row.model_confidence);
            if (!Number.isFinite(score)) continue;
            if (!label_keys.includes(event_row.label)) continue;
            const matched_bin = bins.find(bin_item => score >= bin_item.min && score < bin_item.max) || bins[bins.length - 1];
            matched_bin.counts[event_row.label] += 1;
        }

        return Object.freeze(bins.map(bin_item => Object.freeze({
            range_label: bin_item.label,
            min: bin_item.min,
            max: bin_item.max,
            counts: Object.freeze(bin_item.counts)
        })));
    };

    const caption_histogram = build_histogram('grounding_caption', ['grounded', 'borderline', 'mismatched']);
    const ingredient_histogram = build_histogram('grounding_ingredient', ['present', 'absent']);

    const band_specs = [
        { band_label: '0.00–0.40', min: 0, max: 0.40 },
        { band_label: '0.40–0.55', min: 0.40, max: 0.55 },
        { band_label: '0.55–0.70', min: 0.55, max: 0.70 },
        { band_label: '0.70–0.85', min: 0.70, max: 0.85 },
        { band_label: '0.85–1.00', min: 0.85, max: 1.01 }
    ];
    const band_accumulators = band_specs.map(spec => ({
        ...spec,
        total_count: 0,
        correct_count: 0,
        confidence_sum: 0
    }));

    for (const event_row of non_skipped_events) {
        if (event_row.card_type !== 'edge_check' && event_row.card_type !== 'slot_check') continue;
        const confidence = Number(event_row.model_confidence);
        if (!Number.isFinite(confidence)) continue;

        const is_positive_match = (
            (event_row.card_type === 'edge_check' && event_row.label === 'confirmed')
            || (event_row.card_type === 'slot_check' && event_row.label === 'correct')
        );
        const matched_band = band_accumulators.find(band => confidence >= band.min && confidence < band.max)
            || band_accumulators[band_accumulators.length - 1];
        matched_band.total_count += 1;
        if (is_positive_match) matched_band.correct_count += 1;
        matched_band.confidence_sum += confidence;
    }

    const laya_calibration_bands = Object.freeze(band_accumulators.map(band => Object.freeze({
        band_label: band.band_label,
        sample_count: band.total_count,
        avg_confidence: band.total_count > 0 ? Number((band.confidence_sum / band.total_count).toFixed(3)) : null,
        empirical_accuracy: band.total_count > 0 ? Number((band.correct_count / band.total_count).toFixed(3)) : null
    })));

    const missing_edge_prompts_set = new Set();
    let newly_discovered_edges_count = 0;
    let confirmed_edges_count = 0;
    let rejected_edges_count = 0;

    for (const event_row of non_skipped_events) {
        if (Number(event_row.is_repeat_check) === 1) continue;
        if (event_row.card_type === 'missing_edge') {
            missing_edge_prompts_set.add(event_row.prompt_id);
            if (event_row.label === 'added_edge') {
                newly_discovered_edges_count += 1;
            }
        } else if (event_row.card_type === 'edge_check') {
            if (event_row.label === 'confirmed') confirmed_edges_count += 1;
            else if (event_row.label === 'rejected') rejected_edges_count += 1;
        }
    }

    const recall_denominator = confirmed_edges_count + newly_discovered_edges_count;
    const estimated_edge_recall = recall_denominator > 0
        ? Number((confirmed_edges_count / recall_denominator).toFixed(3))
        : null;

    const first_label_by_item = new Map();
    const repeat_events_list = [];
    for (const event_row of non_skipped_events) {
        const key = `${event_row.card_type}::${event_row.item_type}::${event_row.item_id}`;
        if (Number(event_row.is_repeat_check) === 1) {
            repeat_events_list.push({ key, label: event_row.label });
        } else if (!first_label_by_item.has(key)) {
            first_label_by_item.set(key, event_row.label);
        }
    }
    let paired_repeats = 0;
    let matched_repeats = 0;
    for (const repeat_item of repeat_events_list) {
        if (!first_label_by_item.has(repeat_item.key)) continue;
        paired_repeats += 1;
        if (first_label_by_item.get(repeat_item.key) === repeat_item.label) {
            matched_repeats += 1;
        }
    }

    let grounding_count = 0;
    let slot_check_count = 0;
    let train_events_count = 0;
    let holdout_events_count = 0;

    for (const event_row of non_skipped_events) {
        if (event_row.dataset_split === 'holdout') holdout_events_count += 1;
        else train_events_count += 1;

        if (Number(event_row.is_repeat_check) === 1) continue;
        if (event_row.card_type === 'grounding_caption' || event_row.card_type === 'grounding_ingredient') {
            grounding_count += 1;
        } else if (event_row.card_type === 'slot_check') {
            slot_check_count += 1;
        }
    }

    return Object.freeze({
        total_events: non_skipped_events.length,
        train_events_count,
        holdout_events_count,
        grounding_caption_histogram: Object.freeze({
            bins: caption_histogram,
            cutoffs: Object.freeze({ grounded_min: 0.28, borderline_min: 0.18 })
        }),
        grounding_ingredient_histogram: Object.freeze({
            bins: ingredient_histogram,
            cutoffs: Object.freeze({ grounded_min: 0.24, borderline_min: 0.16 })
        }),
        laya_calibration_bands,
        edge_recall_estimate: Object.freeze({
            sampled_prompts_count: missing_edge_prompts_set.size,
            confirmed_edges_count,
            rejected_edges_count,
            newly_discovered_edges_count,
            estimated_recall: estimated_edge_recall
        }),
        repeat_consistency: Object.freeze({
            paired_repeats,
            matched_repeats,
            agreement_rate: paired_repeats > 0 ? Number((matched_repeats / paired_repeats).toFixed(3)) : null
        }),
        sitting_progress: Object.freeze({
            grounding: Object.freeze({ current: grounding_count, target: REVIEW_SITTING_TARGETS.grounding }),
            edge_check: Object.freeze({ current: confirmed_edges_count + rejected_edges_count, target: REVIEW_SITTING_TARGETS.edge_check }),
            slot_check: Object.freeze({ current: slot_check_count, target: REVIEW_SITTING_TARGETS.slot_check }),
            missing_edge: Object.freeze({ current: missing_edge_prompts_set.size, target: REVIEW_SITTING_TARGETS.missing_edge })
        })
    });
}

