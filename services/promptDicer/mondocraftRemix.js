/**
 * Mondocraft-Inspired Pure Functional Remix Engine
 *
 * Ports four core innovations from Mondocraft (`prompt_remix.py`, `prompt_nlp.py`, `server.py`)
 * into Pure Functional JavaScript for Lumina Prompt Dicer:
 * 1. Near-Copy Family Clustering (`cluster_near_copy_prompt_families`, `deduplicate_candidate_pool_by_family`)
 * 2. Rejection Memory & Staleness Rotation (`MONDOCRAFT_REMIX_MEMORY_LIMIT = 48`, `compute_candidate_staleness_score`)
 * 3. Keeper / Success 3x Weighting (`compute_source_success_weight_multiplier`, `compute_keeper_weighted_bonus`)
 * 4. In-Place Span Editing with Article/Case Repair & Dream Modes (`apply_in_place_prompt_edits`, `apply_dream_mode_transformation`)
 *
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * All variables use descriptive long names without shorthand. Every function and key branch
 * includes WHAT and WHY comments. Pure functional invariants apply throughout: no classes,
 * no module-level mutable state, and frozen immutable return structures.
 */

export const MONDOCRAFT_REMIX_MEMORY_LIMIT = 48;
export const MONDOCRAFT_OPENING_WORD_COUNT = 6;

export const ALLOWED_REMIX_STYLE_MODES = Object.freeze([
    'clauses',
    'sentence',
    'swap',
    'crossover',
    'metamorph',
    'chimera',
    'fractal',
    'portal',
    'kaleidoscope'
]);

const CONTINUATION_ENDING_WORDS_SET = new Set([
    'a', 'an', 'the', 'of', 'and', 'or', 'nor', 'but', 'with', 'without', 'in', 'on', 'at', 'to',
    'for', 'from', 'by', 'into', 'onto', 'under', 'over', 'through', 'between', 'as', 'that',
    'which', 'who', 'whose', 'while', 'where', 'when', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'her', 'his', 'their', 'its', 'our', 'my', 'your', 'this', 'these', 'those'
]);

const NEGATIVE_GUARD_WORDS_SET = new Set(['no', 'without', 'not', 'never', 'zero']);

const METAMORPH_TEMPLATES = Object.freeze([
    'slowly melting into',
    'dissolving into',
    'unfolding into',
    'blossoming into',
    'half transformed into',
    'liquefying into',
    'turning inside out into',
    'unravelling into'
]);

const FRACTAL_TEMPLATES = Object.freeze([
    'made of countless tiny {}',
    'built from thousands of miniature {}',
    'assembled from swarming tiny {}',
    'tiled with endlessly repeating {}',
    'woven from a million microscopic {}'
]);

const PORTAL_TEMPLATES = Object.freeze([
    'torn open to reveal {}',
    'split open onto {}',
    'peeled back to reveal {}',
    'cracked open to reveal {}',
    'unzipped to reveal {}'
]);

const IRREGULAR_ENGLISH_PLURALS = Object.freeze({
    man: 'men',
    woman: 'women',
    child: 'children',
    mouse: 'mice',
    goose: 'geese',
    foot: 'feet',
    tooth: 'teeth',
    person: 'people',
    leaf: 'leaves',
    wolf: 'wolves',
    knife: 'knives',
    life: 'lives',
    wife: 'wives',
    shelf: 'shelves',
    half: 'halves',
    calf: 'calves',
    loaf: 'loaves',
    thief: 'thieves',
    elf: 'elves',
    fish: 'fish',
    sheep: 'sheep',
    deer: 'deer',
    cactus: 'cacti',
    fungus: 'fungi',
    hero: 'heroes',
    potato: 'potatoes',
    tomato: 'tomatoes',
    echo: 'echoes',
    volcano: 'volcanoes',
    mosquito: 'mosquitoes',
    torpedo: 'torpedoes'
});

const NON_MAN_SUFFIX_WORDS = new Set([
    'human', 'shaman', 'talisman', 'caiman', 'ottoman', 'german', 'roman', 'walkman'
]);

const EMOJI_SEQUENCE_REGEX = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

// ============================================================================
// 1. NEAR-COPY FAMILY CLUSTERING (MONDOCRAFT prompt_families PORT)
// ============================================================================

/**
 * WHAT: Checks whether two consecutive non-empty lines continue the same grammatical phrase.
 * WHY: Prevents hard line wraps mid-sentence from being treated as separate prompt clauses.
 */
function should_join_wrapped_lines(previous_line_text, next_line_text) {
    if (!previous_line_text || !next_line_text) return false;
    const last_character = previous_line_text[previous_line_text.length - 1];
    if ('.!?;:…'.includes(last_character)) return false;
    if (',(&+/-–—'.includes(last_character)) return true;

    const first_character_next = next_line_text[0];
    if (/^[a-z]/.test(first_character_next)) return true;

    const trailing_words = previous_line_text.split(/\s+/);
    const trailing_word = (trailing_words[trailing_words.length - 1] || '').toLowerCase();
    return CONTINUATION_ENDING_WORDS_SET.has(trailing_word);
}

/**
 * WHAT: Normalizes multi-line prompts by collapsing inner spaces, dropping blank lines, and joining wrapped sentences.
 * WHY: Ensures consistent phrase comparison and in-place span editing regardless of source formatting.
 *
 * @param {string} raw_prompt_text - Input prompt text.
 * @returns {string} Tidied prompt text.
 */
export function tidy_prompt_whitespace(raw_prompt_text = '') {
    const cleaned_lines = String(raw_prompt_text || '')
        .split(/\r?\n/)
        .map(single_line => single_line.trim().replace(/\s+/g, ' '))
        .filter(Boolean);

    const merged_lines = [];
    for (const current_line of cleaned_lines) {
        if (
            merged_lines.length > 0
            && should_join_wrapped_lines(merged_lines[merged_lines.length - 1], current_line)
        ) {
            merged_lines[merged_lines.length - 1] = `${merged_lines[merged_lines.length - 1]} ${current_line}`;
        } else {
            merged_lines.push(current_line);
        }
    }

    return merged_lines.join('\n');
}

/**
 * WHAT: Strips non-word punctuation from a single token while preserving emoji sequences intact.
 * WHY: Allows "fox🦊," to normalize cleanly to "fox🦊" without breaking Unicode clusters.
 */
function normalize_word_token_preserving_emoji(raw_token_text) {
    const emoji_matches = Array.from(String(raw_token_text || '').matchAll(EMOJI_SEQUENCE_REGEX));
    if (emoji_matches.length === 0) {
        return String(raw_token_text || '').replace(/[^\p{L}\p{N}_]+/gu, '');
    }

    const token_segments = [];
    let scan_position = 0;
    for (const emoji_match of emoji_matches) {
        const prefix_slice = raw_token_text.slice(scan_position, emoji_match.index).replace(/[^\p{L}\p{N}_]+/gu, '');
        token_segments.push(prefix_slice, emoji_match[0]);
        scan_position = emoji_match.index + emoji_match[0].length;
    }
    const suffix_slice = raw_token_text.slice(scan_position).replace(/[^\p{L}\p{N}_]+/gu, '');
    token_segments.push(suffix_slice);
    return token_segments.join('');
}

/**
 * WHAT: Extracts normalized lowercase word tokens (including emoji) from any prompt or ingredient phrase.
 * WHY: Provides a deterministic bag/sequence representation for near-duplicate clustering and opening checks.
 *
 * @param {string} raw_prompt_text - Raw prompt or phrase text.
 * @returns {ReadonlyArray<string>} Immutable array of normalized lowercase word tokens.
 */
export function extract_normalized_prompt_words(raw_prompt_text = '') {
    const split_tokens = String(raw_prompt_text || '').trim().split(/\s+/).filter(Boolean);
    const normalized_words = split_tokens
        .map(token_item => normalize_word_token_preserving_emoji(token_item).toLowerCase())
        .filter(Boolean);
    return Object.freeze(normalized_words);
}

/**
 * WHAT: Computes cached similarity features (word array, word counts map, 3-gram set, 2-gram set).
 * WHY: Enables fast near-copy comparisons across candidate pools without recomputing n-grams repeatedly.
 *
 * @param {string|ReadonlyArray<string>} words_or_text - Source phrase or normalized word list.
 * @returns {Object} Frozen feature bundle.
 */
export function build_prompt_similarity_features(words_or_text = '') {
    const word_tokens = Array.isArray(words_or_text)
        ? words_or_text.map(token_item => String(token_item || '').toLowerCase()).filter(Boolean)
        : Array.from(extract_normalized_prompt_words(words_or_text));

    const word_counts_map = new Map();
    for (const word_token of word_tokens) {
        word_counts_map.set(word_token, (word_counts_map.get(word_token) || 0) + 1);
    }

    const trigrams_set = new Set();
    for (let word_index = 0; word_index <= word_tokens.length - 3; word_index++) {
        trigrams_set.add(`${word_tokens[word_index]}\u0000${word_tokens[word_index + 1]}\u0000${word_tokens[word_index + 2]}`);
    }

    const bigrams_set = new Set();
    for (let word_index = 0; word_index <= word_tokens.length - 2; word_index++) {
        bigrams_set.add(`${word_tokens[word_index]}\u0000${word_tokens[word_index + 1]}`);
    }

    return Object.freeze({
        words: Object.freeze(word_tokens),
        word_counts_map,
        trigrams_set,
        bigrams_set
    });
}

/**
 * WHAT: Computes contiguous matching block lengths recursively across two token slices.
 * WHY: Mirrors Python `difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()` deterministically in pure JS.
 */
function sum_matching_block_lengths(
    tokens_alpha,
    start_alpha,
    end_alpha,
    tokens_beta,
    start_beta,
    end_beta
) {
    if (start_alpha >= end_alpha || start_beta >= end_beta) {
        return 0;
    }

    let best_start_alpha = start_alpha;
    let best_start_beta = start_beta;
    let best_block_length = 0;

    // WHAT: Dynamic row tracking longest matching run ending at each beta index.
    // WHY: Purely local array avoids allocating full O(M*N) matrices on long prompts.
    let previous_run_lengths = new Map();
    for (let index_alpha = start_alpha; index_alpha < end_alpha; index_alpha++) {
        const current_token_alpha = tokens_alpha[index_alpha];
        const next_run_lengths = new Map();
        for (let index_beta = start_beta; index_beta < end_beta; index_beta++) {
            if (current_token_alpha === tokens_beta[index_beta]) {
                const run_length = (previous_run_lengths.get(index_beta - 1) || 0) + 1;
                next_run_lengths.set(index_beta, run_length);
                if (run_length > best_block_length) {
                    best_block_length = run_length;
                    best_start_alpha = index_alpha - run_length + 1;
                    best_start_beta = index_beta - run_length + 1;
                }
            }
        }
        previous_run_lengths = next_run_lengths;
    }

    if (best_block_length === 0) {
        return 0;
    }

    const left_matched_count = sum_matching_block_lengths(
        tokens_alpha,
        start_alpha,
        best_start_alpha,
        tokens_beta,
        start_beta,
        best_start_beta
    );
    const right_matched_count = sum_matching_block_lengths(
        tokens_alpha,
        best_start_alpha + best_block_length,
        end_alpha,
        tokens_beta,
        best_start_beta + best_block_length,
        end_beta
    );
    return left_matched_count + best_block_length + right_matched_count;
}

/**
 * WHAT: Calculates the SequenceMatcher similarity ratio `[0..1]` between two token sequences.
 * WHY: Detects near-copy rewrites that keep word order mostly intact.
 *
 * @param {ReadonlyArray<string>} tokens_alpha - First token list.
 * @param {ReadonlyArray<string>} tokens_beta - Second token list.
 * @returns {number} Similarity ratio between 0 and 1.
 */
export function compute_sequence_matcher_ratio(tokens_alpha = [], tokens_beta = []) {
    const length_sum = tokens_alpha.length + tokens_beta.length;
    if (length_sum === 0) return 1.0;
    const total_matching = sum_matching_block_lengths(
        tokens_alpha,
        0,
        tokens_alpha.length,
        tokens_beta,
        0,
        tokens_beta.length
    );
    return (2 * total_matching) / length_sum;
}

/**
 * WHAT: Counts overlapping elements between two Sets without allocating intermediate merged Sets.
 * WHY: Keeps pairwise n-gram comparison fast and allocation-light.
 */
function count_shared_set_members(set_alpha, set_beta) {
    const [smaller_set, larger_set] = set_alpha.size <= set_beta.size
        ? [set_alpha, set_beta]
        : [set_beta, set_alpha];
    let shared_count = 0;
    for (const item_value of smaller_set) {
        if (larger_set.has(item_value)) shared_count += 1;
    }
    return shared_count;
}

/**
 * WHAT: Determines if two precomputed feature bundles represent near-copy prompts or ingredient phrases.
 * WHY: Detects minor edits, reordered clauses, and short variations (Mondocraft `near_features` port).
 *
 * @param {Object} features_alpha - First feature bundle.
 * @param {Object} features_beta - Second feature bundle.
 * @returns {boolean} True when both items belong in the same near-copy family.
 */
export function are_near_copy_features(features_alpha, features_beta) {
    const words_alpha = features_alpha?.words || [];
    const words_beta = features_beta?.words || [];
    if (words_alpha.length === 0 || words_beta.length === 0) {
        return false;
    }

    const trigrams_alpha = features_alpha.trigrams_set;
    const trigrams_beta = features_beta.trigrams_set;
    if (trigrams_alpha.size > 0 && trigrams_beta.size > 0) {
        const shared_trigrams = count_shared_set_members(trigrams_alpha, trigrams_beta);
        if (shared_trigrams > 0) {
            const min_trigram_size = Math.min(trigrams_alpha.size, trigrams_beta.size);
            const union_trigram_size = trigrams_alpha.size + trigrams_beta.size - shared_trigrams;
            if (
                shared_trigrams / min_trigram_size >= 0.9
                || shared_trigrams / union_trigram_size >= 0.75
                || (Math.max(words_alpha.length, words_beta.length) <= 5 && shared_trigrams >= 1)
            ) {
                return true;
            }
        }
    }

    // WHAT: Checking 2-gram overlap when at least one side is a short 2-3 word ingredient phrase.
    // WHY: Atomic Lumina ingredients like "3200K tungsten key" vs "3200K tungsten light" have fewer than 3 words or 1 trigram.
    if (words_alpha.length <= 4 && words_beta.length <= 4) {
        const bigrams_alpha = features_alpha.bigrams_set;
        const bigrams_beta = features_beta.bigrams_set;
        if (bigrams_alpha.size > 0 && bigrams_beta.size > 0) {
            const shared_bigrams = count_shared_set_members(bigrams_alpha, bigrams_beta);
            if (shared_bigrams / Math.min(bigrams_alpha.size, bigrams_beta.size) >= 0.85) {
                const length_ratio_short = (2 * Math.min(words_alpha.length, words_beta.length)) / (words_alpha.length + words_beta.length);
                if (length_ratio_short >= 0.65) {
                    return true;
                }
            }
        }
    }

    const total_word_length = words_alpha.length + words_beta.length;
    if ((2 * Math.min(words_alpha.length, words_beta.length)) / total_word_length < 0.8) {
        return false;
    }

    let multiset_overlap = 0;
    for (const [word_token, count_alpha] of features_alpha.word_counts_map.entries()) {
        const count_beta = features_beta.word_counts_map.get(word_token) || 0;
        multiset_overlap += Math.min(count_alpha, count_beta);
    }
    if ((2 * multiset_overlap) / total_word_length < 0.8) {
        return false;
    }

    return compute_sequence_matcher_ratio(words_alpha, words_beta) >= 0.8;
}

/**
 * WHAT: Compares two raw text strings directly to check whether they are near-copies.
 * WHY: Convenience wrapper for single-pair rejection checks and candidate deduplication.
 */
export function are_near_copy_prompts(text_alpha = '', text_beta = '') {
    return are_near_copy_features(
        build_prompt_similarity_features(text_alpha),
        build_prompt_similarity_features(text_beta)
    );
}

/**
 * WHAT: Groups texts into connected near-copy families where each family ID is its first member's index.
 * WHY: Prevents saving N slight variations of a prompt or ingredient from flooding Transplant beams.
 *
 * @param {ReadonlyArray<string>} texts_collection - Prompt or ingredient texts.
 * @returns {ReadonlyArray<number>} Frozen array mapping each input index to its canonical family ID.
 */
export function cluster_near_copy_prompt_families(texts_collection = []) {
    const safe_texts = Array.isArray(texts_collection) ? texts_collection : [];
    if (safe_texts.length === 0) return Object.freeze([]);

    const normalized_keys = safe_texts.map(raw_text =>
        extract_normalized_prompt_words(raw_text).join(' ')
    );

    const first_occurrence_by_key = new Map();
    const features_by_unique_key = new Map();
    for (let item_index = 0; item_index < normalized_keys.length; item_index++) {
        const normalized_key = normalized_keys[item_index];
        if (!first_occurrence_by_key.has(normalized_key)) {
            first_occurrence_by_key.set(normalized_key, item_index);
            features_by_unique_key.set(
                normalized_key,
                build_prompt_similarity_features(normalized_key ? normalized_key.split(' ') : [])
            );
        }
    }

    // Transient local union-find array confined strictly inside this pure function
    const parent_pointers = Array.from({ length: normalized_keys.length }, (_, slot_index) => slot_index);

    const resolve_family_root = (node_index) => {
        let cursor_index = node_index;
        while (parent_pointers[cursor_index] !== cursor_index) {
            parent_pointers[cursor_index] = parent_pointers[parent_pointers[cursor_index]];
            cursor_index = parent_pointers[cursor_index];
        }
        return cursor_index;
    };

    const union_family_roots = (index_alpha, index_beta) => {
        const root_alpha = resolve_family_root(index_alpha);
        const root_beta = resolve_family_root(index_beta);
        if (root_alpha !== root_beta) {
            const smaller_root = Math.min(root_alpha, root_beta);
            const larger_root = Math.max(root_alpha, root_beta);
            parent_pointers[larger_root] = smaller_root;
        }
    };

    const unique_non_empty_keys = Array.from(first_occurrence_by_key.keys()).filter(Boolean);
    for (let unique_index_first = 0; unique_index_first < unique_non_empty_keys.length; unique_index_first++) {
        const key_first = unique_non_empty_keys[unique_index_first];
        const features_first = features_by_unique_key.get(key_first);
        const rep_index_first = first_occurrence_by_key.get(key_first);

        for (let unique_index_second = unique_index_first + 1; unique_index_second < unique_non_empty_keys.length; unique_index_second++) {
            const key_second = unique_non_empty_keys[unique_index_second];
            const features_second = features_by_unique_key.get(key_second);
            const is_linked = key_first < key_second
                ? are_near_copy_features(features_first, features_second)
                : are_near_copy_features(features_second, features_first);

            if (is_linked) {
                union_family_roots(rep_index_first, first_occurrence_by_key.get(key_second));
            }
        }
    }

    // Merge identical exact non-empty duplicates first so every copy shares its first occurrence index
    for (let item_index = 0; item_index < normalized_keys.length; item_index++) {
        const normalized_key = normalized_keys[item_index];
        if (!normalized_key) continue;
        const first_index = first_occurrence_by_key.get(normalized_key);
        union_family_roots(first_index, item_index);
    }

    return Object.freeze(parent_pointers.map((_, item_index) => resolve_family_root(item_index)));
}

// ============================================================================
// 2. SUCCESS / KEEPER WEIGHTING (MONDOCRAFT hits[i] > 0 -> 3x PORT)
// ============================================================================

/**
 * WHAT: Returns Mondocraft's 3x selection weight multiplier for keeper, reviewed, or favored sources.
 * WHY: Proven visual winners participate 3x as strongly without completely excluding unreviewed options.
 *
 * @param {Object} candidate_or_prompt_record - Candidate ingredient or prompt summary record.
 * @returns {number} 3.0 for keepers/reviewed items, otherwise 1.0.
 */
export function compute_source_success_weight_multiplier(candidate_or_prompt_record) {
    if (!candidate_or_prompt_record) return 1.0;
    const keeper_count = Number(
        candidate_or_prompt_record.keeper_count ?? candidate_or_prompt_record.success_count ?? 0
    );
    const has_keeper_signal = keeper_count > 0
        || Boolean(candidate_or_prompt_record.is_keeper)
        || Boolean(candidate_or_prompt_record.is_reviewed);
    return has_keeper_signal ? 3.0 : 1.0;
}

/**
 * WHAT: Computes a deterministic FNV-1a unit fraction in (0.05, 0.999) for seeded variation scoring.
 * WHY: Replaces Python `rng.random()` cleanly inside pure functional JS without side-effect RNG state.
 */
function compute_deterministic_unit_hash(seed_key_string) {
    let fnv_accumulator = 2166136261;
    for (let char_index = 0; char_index < seed_key_string.length; char_index++) {
        fnv_accumulator ^= seed_key_string.charCodeAt(char_index);
        fnv_accumulator = Math.imul(fnv_accumulator, 16777619);
    }
    const raw_fraction = ((fnv_accumulator >>> 0) % 10000) / 10000;
    return 0.05 + raw_fraction * 0.949;
}

/**
 * WHAT: Computes the additive Transplant score bonus from Mondocraft 3x keeper/success weighting.
 * WHY: Biases beam selection toward proven keeper images/prompts while supporting seeded exploration (`u ** (1 / weight)`).
 *
 * @param {Object} candidate_ingredient - Candidate ingredient record.
 * @param {number} variation_seed - Deterministic roll seed (0 for deterministic ranking).
 * @returns {number} Keeper-weighted score contribution.
 */
export function compute_keeper_weighted_bonus(candidate_ingredient, variation_seed = 0) {
    const multiplier = compute_source_success_weight_multiplier(candidate_ingredient);
    const base_keeper_bonus = multiplier >= 3.0 ? 2.25 : 0;

    if (!(Number(variation_seed) > 0)) {
        return Number(base_keeper_bonus.toFixed(4));
    }

    const unit_random = compute_deterministic_unit_hash(
        `${variation_seed}::${candidate_ingredient?.text || ''}::${candidate_ingredient?.prompt_id || ''}`
    );
    const weighted_roll_bonus = Math.pow(unit_random, 1 / multiplier) * 1.5;
    return Number((base_keeper_bonus + weighted_roll_bonus).toFixed(4));
}

/**
 * WHAT: Filters active near-copies, collapses duplicate phrase families per slot, and annotates source prompt family diversity.
 * WHY: Prevents near-identical saved prompts from flooding Transplant beam candidates (Mondocraft family deduplication).
 *
 * @param {ReadonlyArray<Object>} candidate_ingredients_collection - Candidate pool for a target slot.
 * @param {ReadonlyArray<Object>} active_ingredients_collection - Currently active ingredients in the beam state.
 * @returns {ReadonlyArray<Object>} Deduplicated and family-annotated immutable candidate list.
 */
export function deduplicate_candidate_pool_by_family(
    candidate_ingredients_collection = [],
    active_ingredients_collection = []
) {
    const safe_candidates = Array.isArray(candidate_ingredients_collection) ? candidate_ingredients_collection : [];
    const safe_active = Array.isArray(active_ingredients_collection) ? active_ingredients_collection : [];
    if (safe_candidates.length === 0) return Object.freeze([]);

    const active_features_list = safe_active
        .map(item => build_prompt_similarity_features(item?.text || ''))
        .filter(feature_item => feature_item.words.length > 0);

    // 1. Exclude exact or near-copy duplicates of already active ingredients
    const non_active_candidates = safe_candidates.filter(candidate_item => {
        if (!candidate_item || !candidate_item.text) return false;
        const candidate_features = build_prompt_similarity_features(candidate_item.text);
        return !active_features_list.some(active_features =>
            are_near_copy_features(candidate_features, active_features)
        );
    });
    if (non_active_candidates.length === 0) return Object.freeze([]);

    // 2. Cluster candidates by phrase text AND by source prompt family
    const phrase_families = cluster_near_copy_prompt_families(
        non_active_candidates.map(candidate_item => candidate_item.text || '')
    );
    const source_texts = non_active_candidates.map(
        candidate_item => candidate_item.source_raw_prompt || candidate_item.prompt_id || candidate_item.text || ''
    );
    const source_families = cluster_near_copy_prompt_families(source_texts);

    // 3. Pick best representative per (slot, phrase_family_id) ordered by keeper weight, cluster match, usage
    const candidate_preference_score = (candidate_item) => (
        (compute_source_success_weight_multiplier(candidate_item) * 100)
        + (candidate_item.cluster_match ? 50 : 0)
        + (candidate_item.kind === 'physical_anchor' ? 15 : 0)
        + Math.min(20, Number(candidate_item.usage_count || 1))
    );

    const best_by_phrase_family = new Map();
    non_active_candidates.forEach((candidate_item, candidate_index) => {
        const phrase_family_key = `${candidate_item.slot || 'other'}::${phrase_families[candidate_index]}`;
        const annotated_record = {
            ...candidate_item,
            phrase_family_id: `phrfam_${phrase_families[candidate_index]}`,
            source_family_id: `srcfam_${source_families[candidate_index]}`
        };

        const existing_best = best_by_phrase_family.get(phrase_family_key);
        if (
            !existing_best
            || candidate_preference_score(annotated_record) > candidate_preference_score(existing_best)
        ) {
            best_by_phrase_family.set(phrase_family_key, annotated_record);
        }
    });

    // 4. Assign source_family_rank (0 = first pick from that prompt family, 1 = second, etc.)
    const unique_phrase_candidates = Array.from(best_by_phrase_family.values()).toSorted(
        (alpha_item, beta_item) => candidate_preference_score(beta_item) - candidate_preference_score(alpha_item)
    );

    const seen_count_by_source_family = new Map();
    const annotated_results = unique_phrase_candidates.map(candidate_item => {
        const family_key = candidate_item.source_family_id;
        const prior_count = seen_count_by_source_family.get(family_key) || 0;
        seen_count_by_source_family.set(family_key, prior_count + 1);
        return Object.freeze({
            ...candidate_item,
            source_family_rank: prior_count
        });
    });

    return Object.freeze(annotated_results);
}

// ============================================================================
// 3. REJECTION MEMORY & STALENESS ROTATION (MONDOCRAFT _REMIX_MEMORY PORT)
// ============================================================================

/**
 * WHAT: Extracts the normalized leading 6-word opening signature of a prompt draft.
 * WHY: Prevents consecutive remixes from opening with the same visible phrasing (`_REMIX_OPENING_WORDS = 6`).
 *
 * @param {string} draft_text - Full prompt draft string.
 * @returns {string} Space-joined first 6 normalized words.
 */
export function extract_remix_opening_signature(draft_text = '') {
    return extract_normalized_prompt_words(draft_text)
        .slice(0, MONDOCRAFT_OPENING_WORD_COUNT)
        .join(' ');
}

/**
 * WHAT: Checks whether a candidate ingredient or assembled beam draft is excluded by permanent rejection history.
 * WHY: Honors Mondocraft `remix_rejections` so rejected combinations or swapped pieces do not immediately return.
 *
 * @param {string|Object} candidate_text_or_plan - Either a candidate ingredient, a draft string, or a beam plan object.
 * @param {ReadonlyArray<string|Object>} rejected_records_collection - Recorded rejections from SQLite.
 * @returns {boolean} True when the candidate or plan matches a stored rejection.
 */
export function is_candidate_rejected_by_memory(candidate_text_or_plan, rejected_records_collection = []) {
    if (!Array.isArray(rejected_records_collection) || rejected_records_collection.length === 0) {
        return false;
    }

    const is_string_input = typeof candidate_text_or_plan === 'string';
    const is_beam_plan_input = !is_string_input
        && candidate_text_or_plan
        && Array.isArray(candidate_text_or_plan.selected_ingredients);

    const draft_text_to_check = is_string_input
        ? candidate_text_or_plan
        : (candidate_text_or_plan?.assembled_text || '');
    const normalized_draft_key = draft_text_to_check
        ? extract_normalized_prompt_words(draft_text_to_check).join(' ')
        : '';

    const candidate_ingredient_text_lower = (!is_string_input && !is_beam_plan_input)
        ? String(candidate_text_or_plan?.text || '').toLowerCase().trim()
        : '';
    const candidate_swapped_texts_set = is_beam_plan_input && Array.isArray(candidate_text_or_plan.swapped_slots)
        ? new Set(
            candidate_text_or_plan.swapped_slots
                .map(swap_item => String(swap_item?.chosen_text || '').toLowerCase().trim())
                .filter(Boolean)
        )
        : new Set();

    for (const rejection_entry of rejected_records_collection) {
        const rejected_draft_text = typeof rejection_entry === 'string'
            ? rejection_entry
            : (rejection_entry?.draft_text || '');
        const rejected_ingredient_list = (!rejection_entry || typeof rejection_entry === 'string')
            ? []
            : (Array.isArray(rejection_entry.rejected_ingredient_texts)
                ? rejection_entry.rejected_ingredient_texts.map(item => String(item || '').toLowerCase().trim()).filter(Boolean)
                : []);

        if (candidate_ingredient_text_lower) {
            if (rejected_ingredient_list.length === 1 && rejected_ingredient_list[0] === candidate_ingredient_text_lower) {
                return true;
            }
            if (
                rejected_draft_text
                && rejected_draft_text.toLowerCase().trim() === candidate_ingredient_text_lower
            ) {
                return true;
            }
            continue;
        }

        if (normalized_draft_key && rejected_draft_text) {
            const rejected_normalized_key = extract_normalized_prompt_words(rejected_draft_text).join(' ');
            if (
                normalized_draft_key === rejected_normalized_key
                || are_near_copy_prompts(draft_text_to_check, rejected_draft_text)
            ) {
                return true;
            }
        }

        if (
            candidate_swapped_texts_set.size > 0
            && rejected_ingredient_list.length > 0
            && rejected_ingredient_list.length === candidate_swapped_texts_set.size
            && rejected_ingredient_list.every(rejected_piece => candidate_swapped_texts_set.has(rejected_piece))
        ) {
            return true;
        }
    }

    return false;
}

/**
 * WHAT: Scores how fresh a candidate ingredient or beam plan is relative to the last 48 live remixes.
 * WHY: Penalizes repeated 6-word openings, recently swapped texts, and recently tapped source families (`_freshest_remixes`).
 *
 * @param {Object} candidate_item - Either a candidate ingredient or finalized beam plan object.
 * @param {ReadonlyArray<Object>} recent_memory_collection - Recent remix records (ordered newest first, up to 48).
 * @returns {Object} Frozen `{ staleness_ages, minimum_age, recency_penalty, freshness_bonus }`.
 */
export function compute_candidate_staleness_score(candidate_item, recent_memory_collection = []) {
    const capped_recent = Array.isArray(recent_memory_collection)
        ? recent_memory_collection.slice(0, MONDOCRAFT_REMIX_MEMORY_LIMIT)
        : [];
    const memory_depth = capped_recent.length;
    if (memory_depth === 0) {
        return Object.freeze({
            staleness_ages: Object.freeze([0]),
            minimum_age: 0,
            recency_penalty: 0,
            freshness_bonus: 0
        });
    }

    const last_seen_age_by_key = new Map();
    for (let age_index = 0; age_index < memory_depth; age_index++) {
        const memory_entry = capped_recent[age_index];
        if (!memory_entry) continue;

        const opening_sig = memory_entry.opening_signature
            || extract_remix_opening_signature(memory_entry.draft_text || '');
        if (opening_sig && !last_seen_age_by_key.has(`open:${opening_sig}`)) {
            last_seen_age_by_key.set(`open:${opening_sig}`, age_index);
        }

        const source_ids = Array.isArray(memory_entry.source_prompt_ids)
            ? memory_entry.source_prompt_ids
            : [];
        for (const source_identifier of source_ids) {
            if (source_identifier && !last_seen_age_by_key.has(`fam:${source_identifier}`)) {
                last_seen_age_by_key.set(`fam:${source_identifier}`, age_index);
            }
        }

        const family_ids = Array.isArray(memory_entry.source_family_ids)
            ? memory_entry.source_family_ids
            : [];
        for (const family_identifier of family_ids) {
            if (family_identifier && !last_seen_age_by_key.has(`fam:${family_identifier}`)) {
                last_seen_age_by_key.set(`fam:${family_identifier}`, age_index);
            }
        }

        const swapped_texts = Array.isArray(memory_entry.swapped_texts)
            ? memory_entry.swapped_texts
            : [];
        for (const swapped_phrase of swapped_texts) {
            const lower_phrase = String(swapped_phrase || '').toLowerCase().trim();
            if (lower_phrase && !last_seen_age_by_key.has(`ing:${lower_phrase}`)) {
                last_seen_age_by_key.set(`ing:${lower_phrase}`, age_index);
            }
        }
    }

    const candidate_lookup_keys = [];
    if (candidate_item?.assembled_text) {
        const opening_sig = extract_remix_opening_signature(candidate_item.assembled_text);
        if (opening_sig) candidate_lookup_keys.push(`open:${opening_sig}`);
    }
    if (candidate_item?.text) {
        candidate_lookup_keys.push(`ing:${String(candidate_item.text).toLowerCase().trim()}`);
    }
    if (candidate_item?.source_family_id) {
        candidate_lookup_keys.push(`fam:${candidate_item.source_family_id}`);
    }
    if (candidate_item?.prompt_id) {
        candidate_lookup_keys.push(`fam:${candidate_item.prompt_id}`);
    }
    if (Array.isArray(candidate_item?.swapped_slots)) {
        for (const swap_record of candidate_item.swapped_slots) {
            if (swap_record?.chosen_text) {
                candidate_lookup_keys.push(`ing:${String(swap_record.chosen_text).toLowerCase().trim()}`);
            }
            if (swap_record?.chosen_source_prompt) {
                candidate_lookup_keys.push(`fam:${swap_record.chosen_source_prompt}`);
            }
        }
    }

    if (candidate_lookup_keys.length === 0) {
        return Object.freeze({
            staleness_ages: Object.freeze([memory_depth]),
            minimum_age: memory_depth,
            recency_penalty: 0,
            freshness_bonus: 0.75
        });
    }

    const staleness_ages = candidate_lookup_keys
        .map(lookup_key => (last_seen_age_by_key.has(lookup_key) ? last_seen_age_by_key.get(lookup_key) : memory_depth))
        .toSorted((age_alpha, age_beta) => age_alpha - age_beta);

    const minimum_age = staleness_ages[0];
    const was_seen_recently = minimum_age < memory_depth;
    const recency_penalty = was_seen_recently
        ? Number((-2.5 * ((memory_depth - minimum_age) / Math.max(1, memory_depth))).toFixed(4))
        : 0;
    const freshness_bonus = was_seen_recently ? 0 : 0.75;

    return Object.freeze({
        staleness_ages: Object.freeze(staleness_ages),
        minimum_age,
        recency_penalty,
        freshness_bonus
    });
}

/**
 * WHAT: Lexicographically compares two sorted age vectors (preferring oldest minimum age first).
 * WHY: Direct functional port of Mondocraft `_freshest_remixes` tuple comparison.
 */
function compare_staleness_vectors_descending(ages_alpha, ages_beta) {
    const compare_length = Math.max(ages_alpha.length, ages_beta.length);
    for (let position_index = 0; position_index < compare_length; position_index++) {
        const value_alpha = ages_alpha[position_index] ?? Infinity;
        const value_beta = ages_beta[position_index] ?? Infinity;
        if (value_alpha !== value_beta) {
            return value_beta - value_alpha;
        }
    }
    return 0;
}

/**
 * WHAT: Ranks surviving beam plans by staleness rotation and net beam score.
 * WHY: Ensures consecutive Transplant clicks cycle through unseen openings and families before repeating.
 *
 * @param {ReadonlyArray<Object>} beam_plans_collection - Surviving finalized beam plans.
 * @param {ReadonlyArray<Object>} recent_memory_collection - Recent remix history (up to 48).
 * @returns {ReadonlyArray<Object>} Re-ranked frozen plans array.
 */
export function select_freshest_beam_candidates(beam_plans_collection = [], recent_memory_collection = []) {
    const safe_plans = Array.isArray(beam_plans_collection) ? beam_plans_collection : [];
    if (safe_plans.length <= 1 || !Array.isArray(recent_memory_collection) || recent_memory_collection.length === 0) {
        return Object.freeze([...safe_plans]);
    }

    const enriched_with_staleness = safe_plans.map(plan_record => {
        const staleness_metrics = compute_candidate_staleness_score(plan_record, recent_memory_collection);
        const adjusted_score = Number(
            ((Number(plan_record.score) || 0) + staleness_metrics.recency_penalty + staleness_metrics.freshness_bonus).toFixed(4)
        );
        return {
            plan_record: Object.freeze({
                ...plan_record,
                score: adjusted_score,
                staleness_minimum_age: staleness_metrics.minimum_age
            }),
            staleness_ages: staleness_metrics.staleness_ages,
            adjusted_score
        };
    });

    const sorted_entries = enriched_with_staleness.toSorted((entry_alpha, entry_beta) => {
        const clash_delta = (entry_alpha.plan_record.clashes?.length || 0) - (entry_beta.plan_record.clashes?.length || 0);
        if (clash_delta !== 0) return clash_delta;

        const age_order = compare_staleness_vectors_descending(entry_alpha.staleness_ages, entry_beta.staleness_ages);
        if (age_order !== 0) return age_order;

        return entry_beta.adjusted_score - entry_alpha.adjusted_score;
    });

    return Object.freeze(sorted_entries.map(entry_item => entry_item.plan_record));
}

// ============================================================================
// 4. IN-PLACE SPAN EDITING, GRAMMAR REPAIR & DREAM MODES (prompt_nlp.py PORT)
// ============================================================================

/**
 * WHAT: Selects `"a"` or `"an"` for the first alphabetic word past emoji and leading digits.
 * WHY: Prevents broken grammar like "a amber sunset" or "an uniform" after in-place swaps (`_article` port).
 *
 * @param {string} phrase_text - Replacement phrase.
 * @returns {'a'|'an'} Correct English indefinite article.
 */
export function select_indefinite_article(phrase_text = '') {
    const alpha_word_match = String(phrase_text || '').match(/[\p{L}]+/u);
    const first_word = alpha_word_match ? alpha_word_match[0].toLowerCase() : '';
    if (!first_word) return 'a';
    if (/^(uni|use|usu|eu|one|once|ur)/i.test(first_word)) return 'a';
    if (/^([aeiou]|hour|honest|honou?r)/i.test(first_word)) return 'an';
    return 'a';
}

/**
 * WHAT: Recases the first alphabetic letter of a phrase (past any leading spaces or emoji).
 * WHY: Keeps sentence starts capitalized and mid-sentence insertions lowercase cleanly (`_recase` port).
 */
export function recase_first_letter(phrase_text = '', should_uppercase = true) {
    const text_string = String(phrase_text || '');
    const letter_match = text_string.match(/[\p{L}]/u);
    if (!letter_match || letter_match.index === undefined) return text_string;

    const letter_index = letter_match.index;
    const adjusted_char = should_uppercase
        ? text_string[letter_index].toUpperCase()
        : text_string[letter_index].toLowerCase();
    return text_string.slice(0, letter_index) + adjusted_char + text_string.slice(letter_index + 1);
}

/**
 * WHAT: Pluralizes an English singular noun using Mondocraft's irregular lookup and suffix rules.
 * WHY: Powers Fractal dream templates like "made of countless tiny clocks" (`_plural` port).
 */
export function pluralize_english_noun(word_text = '') {
    const trimmed_word = String(word_text || '').trim();
    if (!trimmed_word) return '';
    const lower_word = trimmed_word.toLowerCase();

    let plural_lower = '';
    if (Object.prototype.hasOwnProperty.call(IRREGULAR_ENGLISH_PLURALS, lower_word)) {
        plural_lower = IRREGULAR_ENGLISH_PLURALS[lower_word];
    } else if (lower_word.endsWith('man') && !NON_MAN_SUFFIX_WORDS.has(lower_word)) {
        plural_lower = `${lower_word.slice(0, -3)}men`;
    } else if (/(s|x|z|ch|sh)$/.test(lower_word)) {
        plural_lower = `${lower_word}es`;
    } else if (/[^aeiou]y$/.test(lower_word)) {
        plural_lower = `${lower_word.slice(0, -1)}ies`;
    } else {
        plural_lower = `${lower_word}s`;
    }

    const starts_capitalized = /^[A-Z]/.test(trimmed_word);
    return starts_capitalized
        ? `${plural_lower.charAt(0).toUpperCase()}${plural_lower.slice(1)}`
        : plural_lower;
}

/**
 * WHAT: Strips leading determiners, possessives, or numeric quantifiers and optionally pluralizes the trailing noun.
 * WHY: Turns "a brass telescope" into "brass telescopes" for Fractal/Chimera insertions (`_bare` port).
 */
export function strip_leading_determiners_and_numbers(phrase_text = '', pluralize_head_noun = false) {
    const without_leading = String(phrase_text || '')
        .trim()
        .replace(/^(?:a|an|the|one|two|three|four|five|six|some|my|his|her|their|its|our)\s+/i, '')
        .trim();
    if (!without_leading) return '';

    const normalized_lower = recase_first_letter(without_leading, false);
    if (!pluralize_head_noun) {
        return normalized_lower;
    }

    const trailing_word_match = normalized_lower.match(/([A-Za-z]+)(\s*)$/);
    if (!trailing_word_match) {
        return normalized_lower;
    }
    const base_word = trailing_word_match[1];
    const already_plural = base_word.toLowerCase().endsWith('s') && !base_word.toLowerCase().endsWith('ss');
    if (already_plural) {
        return normalized_lower;
    }

    const head_start_index = trailing_word_match.index;
    return `${normalized_lower.slice(0, head_start_index)}${pluralize_english_noun(base_word)}${trailing_word_match[2]}`;
}

/**
 * WHAT: Determines whether a replacement starting inside `source_text` should omit any redundant leading article.
 * WHY: Prevents "a a weathered owl" when a replacement already brings its own article after a detached article span.
 */
function strip_duplicate_article_if_preceded_by_article(replacement_text, has_preceding_article) {
    const trimmed_replacement = String(replacement_text || '').trim();
    if (!has_preceding_article) return trimmed_replacement;
    return trimmed_replacement.replace(/^(?:a|an)\s+/i, '').trim() || trimmed_replacement;
}

/**
 * WHAT: Builds a span edit `[start_index, end_index, replacement]` while repairing any preceding `"a"/"an"` determiner.
 * WHY: Ports Mondocraft `_edit` to maintain clean English syntax on in-place replacements without full rewrites.
 *
 * @param {string} source_text - Original prompt string.
 * @param {number} target_start_index - Character start offset of replaced span.
 * @param {number} target_end_index - Character end offset of replaced span.
 * @param {string} replacement_text - New phrase to insert.
 * @returns {Object} Frozen edit record `{ start_index, end_index, replacement_text }`.
 */
export function build_span_replacement_edit(source_text, target_start_index, target_end_index, replacement_text) {
    const safe_source = String(source_text || '');
    const safe_replacement = String(replacement_text || '').trim();

    const text_before_span = safe_source.slice(0, target_start_index);
    const preceding_article_match = text_before_span.match(/(^|[\s,(["'])(a|an)(\s+)$/i);
    if (preceding_article_match && safe_replacement) {
        const prefix_boundary_length = preceding_article_match[1].length;
        const original_article = preceding_article_match[2];
        const trailing_whitespace = preceding_article_match[3];
        const article_start_index = target_start_index - preceding_article_match[0].length + prefix_boundary_length;
        const cleaned_replacement = strip_duplicate_article_if_preceded_by_article(safe_replacement, true);
        const chosen_article = select_indefinite_article(cleaned_replacement);
        const final_article = /^[A-Z]/.test(original_article)
            ? `${chosen_article.charAt(0).toUpperCase()}${chosen_article.slice(1)}`
            : chosen_article;
        const adjusted_phrase = /^[A-Z][a-z]/.test(cleaned_replacement)
            ? recase_first_letter(cleaned_replacement, false)
            : cleaned_replacement;

        return Object.freeze({
            start_index: article_start_index,
            end_index: target_end_index,
            replacement_text: `${final_article}${trailing_whitespace}${adjusted_phrase}`
        });
    }

    const precedes_sentence_start = target_start_index === 0
        || /[.!?]\s+$|\n$/.test(text_before_span);
    const final_phrase = precedes_sentence_start
        ? recase_first_letter(safe_replacement, true)
        : safe_replacement;

    return Object.freeze({
        start_index: target_start_index,
        end_index: target_end_index,
        replacement_text: final_phrase
    });
}

/**
 * WHAT: Applies sorted non-overlapping span edits to `source_text`, dropping conflicting overlapping drafts.
 * WHY: Direct pure functional port of Mondocraft `_apply(doc, edits)`.
 */
export function apply_non_overlapping_span_edits(source_text, span_edits_collection = []) {
    const base_string = String(source_text || '');
    const sorted_edits = [...(Array.isArray(span_edits_collection) ? span_edits_collection : [])].toSorted(
        (edit_alpha, edit_beta) => (edit_alpha.start_index - edit_beta.start_index) || (edit_alpha.end_index - edit_beta.end_index)
    );

    const output_segments = [];
    let cursor_offset = 0;
    for (const single_edit of sorted_edits) {
        if (!single_edit || single_edit.start_index < cursor_offset) {
            return '';
        }
        output_segments.push(base_string.slice(cursor_offset, single_edit.start_index));
        output_segments.push(single_edit.replacement_text);
        cursor_offset = single_edit.end_index;
    }
    output_segments.push(base_string.slice(cursor_offset));
    return output_segments.join('');
}

/**
 * WHAT: Locates editable phrase occurrences outside weighted bracket syntax (`(tag:1.4)`) and guard words (`no ...`).
 * WHY: Keeps prompt syntax weights and negative guards untouched during Mondocraft-style span replacements.
 */
function find_safe_phrase_span_in_text(source_text, target_phrase) {
    const cleaned_target = String(target_phrase || '').trim();
    if (!source_text || !cleaned_target) return null;

    const escaped_pattern = cleaned_target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match_regex = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped_pattern}(?![\\p{L}\\p{N}_])`, 'giu');

    for (const match_entry of source_text.matchAll(match_regex)) {
        const match_start = match_entry.index;
        const match_end = match_start + match_entry[0].length;
        const before_slice = source_text.slice(0, match_start);

        // Skip matches preceded directly by negative guards like "no ", "without "
        const preceding_word_match = before_slice.match(/([A-Za-z]+)\s+$/);
        if (preceding_word_match && NEGATIVE_GUARD_WORDS_SET.has(preceding_word_match[1].toLowerCase())) {
            continue;
        }

        // Skip matches inside weighted prompt syntax "(...:1.3)"
        const last_open_paren = before_slice.lastIndexOf('(');
        const last_close_paren = before_slice.lastIndexOf(')');
        if (last_open_paren > last_close_paren) {
            const closing_paren = source_text.indexOf(')', match_end);
            if (closing_paren > match_end && /:\s*-?\d+(?:\.\d+)?\s*$/.test(source_text.slice(last_open_paren + 1, closing_paren))) {
                continue;
            }
        }

        return Object.freeze({ start_index: match_start, end_index: match_end });
    }

    return null;
}

/**
 * WHAT: Weaves structured slot ingredients into natural English sentences when no base prose spans match.
 * WHY: Gives `sentence` and Dream modes fluid subject-action-setting grammar instead of flat comma tags.
 */
function weave_ingredients_into_natural_sentence(selected_ingredients_collection, active_consequences_collection, use_observable_replacements) {
    const grouped_phrases = {};
    for (const ingredient_item of selected_ingredients_collection) {
        if (!ingredient_item || !ingredient_item.text) continue;
        const replacement_slot = ingredient_item.observable_replacement?.replacement_slot || ingredient_item.replacement_slot;
        const replacement_text = ingredient_item.observable_replacement?.text || ingredient_item.observable_replacement_text;
        const effective_slot = (ingredient_item.kind === 'pretext_term' && use_observable_replacements && replacement_slot)
            ? replacement_slot
            : (ingredient_item.slot || 'other');
        const effective_text = String((ingredient_item.kind === 'pretext_term' && use_observable_replacements && replacement_text)
            ? replacement_text
            : ingredient_item.text).trim();

        if (!effective_text) continue;
        grouped_phrases[effective_slot] = [...(grouped_phrases[effective_slot] || []), effective_text];
    }

    const join_list = (slot_key) => Array.from(new Set(grouped_phrases[slot_key] || [])).join(', ');
    const framing_text = join_list('framing');
    const lens_text = join_list('lens');
    const motion_text = join_list('camera_motion');
    const subject_text = join_list('subject_appearance');
    const pose_text = join_list('expression_or_pose');
    const action_text = join_list('action');
    const setting_text = join_list('setting');
    const weather_text = join_list('weather_or_matter');
    const lighting_text = join_list('lighting');
    const palette_text = join_list('palette');
    const medium_text = join_list('film_stock_or_medium');
    const mood_text = join_list('mood');
    const audio_text = join_list('audio');
    const other_text = join_list('other');

    const sentences = [];
    const camera_opening = [framing_text, lens_text ? `captured with ${lens_text}` : '', motion_text]
        .filter(Boolean)
        .join(', ');
    const subject_clause = [subject_text, pose_text, action_text].filter(Boolean).join(' ');

    if (camera_opening && subject_clause) {
        sentences.push(`${recase_first_letter(camera_opening, true)} of ${recase_first_letter(subject_clause, false)}${setting_text ? ` in ${setting_text}` : ''}.`);
    } else if (subject_clause) {
        sentences.push(`${recase_first_letter(subject_clause, true)}${setting_text ? ` in ${setting_text}` : ''}.`);
    } else if (camera_opening || setting_text) {
        sentences.push(`${recase_first_letter([camera_opening, setting_text ? `in ${setting_text}` : ''].filter(Boolean).join(' '), true)}.`);
    }

    const atmosphere_parts = [
        weather_text ? `amid ${weather_text}` : '',
        lighting_text ? `illuminated by ${lighting_text}` : '',
        palette_text ? `in a ${palette_text} palette` : ''
    ].filter(Boolean);
    if (atmosphere_parts.length > 0) {
        sentences.push(`${recase_first_letter(atmosphere_parts.join(', '), true)}.`);
    }

    const finish_parts = [medium_text, mood_text, audio_text, other_text].filter(Boolean);
    if (finish_parts.length > 0) {
        sentences.push(`${recase_first_letter(finish_parts.join(', '), true)}.`);
    }

    const safe_consequences = (Array.isArray(active_consequences_collection) ? active_consequences_collection : [])
        .map(item => String(item || '').trim())
        .filter(Boolean);
    if (safe_consequences.length > 0) {
        sentences.push(`${recase_first_letter(Array.from(new Set(safe_consequences)).join(', '), true)}.`);
    }

    return sentences.join(' ').trim();
}

/**
 * WHAT: Performs Mondocraft-style in-place span editing over `base_prompt_text`, or weaves a clean natural sentence fallback.
 * WHY: Preserves narrative prose structure when swapping slots instead of always flattening prompts to comma-separated tags.
 *
 * @param {string} base_prompt_text - Original prompt text before Transplant swaps.
 * @param {ReadonlyArray<Object>} swapped_slots_collection - Slot swaps `{ slot, replaced_texts, chosen_text }`.
 * @param {ReadonlyArray<Object>} selected_ingredients_collection - Final active ingredients.
 * @param {ReadonlyArray<string>} active_consequences_collection - Carried consequence descriptions.
 * @param {Object} remix_options - `{ include_observable_replacements }`.
 * @returns {string} Naturally edited prompt text.
 */
export function apply_in_place_prompt_edits(
    base_prompt_text = '',
    swapped_slots_collection = [],
    selected_ingredients_collection = [],
    active_consequences_collection = [],
    remix_options = {}
) {
    const use_observable_replacements = remix_options.include_observable_replacements ?? true;
    const tidied_base = tidy_prompt_whitespace(base_prompt_text);
    const safe_swaps = Array.isArray(swapped_slots_collection) ? swapped_slots_collection : [];

    if (!tidied_base) {
        return weave_ingredients_into_natural_sentence(
            selected_ingredients_collection,
            active_consequences_collection,
            use_observable_replacements
        );
    }

    const span_edits = [];
    const unanchored_additions = [];

    for (const swap_entry of safe_swaps) {
        const chosen_phrase = String(swap_entry?.chosen_text || '').trim();
        if (!chosen_phrase) continue;
        const replaced_list = Array.isArray(swap_entry?.replaced_texts) ? swap_entry.replaced_texts : [];

        let anchored_any = false;
        for (const original_phrase of replaced_list) {
            const found_span = find_safe_phrase_span_in_text(tidied_base, original_phrase);
            if (found_span) {
                span_edits.push(build_span_replacement_edit(
                    tidied_base,
                    found_span.start_index,
                    found_span.end_index,
                    chosen_phrase
                ));
                anchored_any = true;
                break;
            }
        }
        if (!anchored_any) {
            unanchored_additions.push(chosen_phrase);
        }
    }

    const edited_text = span_edits.length > 0
        ? apply_non_overlapping_span_edits(tidied_base, span_edits)
        : tidied_base;
    const final_base = edited_text || tidied_base;

    // Also include any newly pulled / user-added ingredients or consequences not yet present in `final_base`
    const lower_base = final_base.toLowerCase();
    const missing_extras = [];
    for (const addition_phrase of unanchored_additions) {
        if (!lower_base.includes(addition_phrase.toLowerCase())) {
            missing_extras.push(addition_phrase);
        }
    }
    for (const consequence_phrase of (Array.isArray(active_consequences_collection) ? active_consequences_collection : [])) {
        const trimmed_consequence = String(consequence_phrase || '').trim();
        if (trimmed_consequence && !lower_base.includes(trimmed_consequence.toLowerCase())) {
            missing_extras.push(trimmed_consequence);
        }
    }

    if (missing_extras.length === 0) {
        return final_base;
    }
    const separator = /[.!?]$/.test(final_base) ? ' ' : ', ';
    return `${final_base}${separator}${Array.from(new Set(missing_extras)).join(', ')}.`.replace(/\.\.$/, '.');
}

/**
 * WHAT: Extracts the trailing noun token from a phrase for Chimera hybridization.
 * WHY: Turns "weathered detective" + "barn owl" into "detective-owl hybrid".
 */
function extract_trailing_noun_word(phrase_text = '') {
    const clean_tokens = String(phrase_text || '').trim().replace(/[^\p{L}\s-]/gu, '').split(/\s+/).filter(Boolean);
    return clean_tokens.length > 0 ? clean_tokens[clean_tokens.length - 1].toLowerCase() : '';
}

/**
 * WHAT: Inserts an aside clause `, words,` cleanly right after a target phrase inside `assembled_text`.
 * WHY: Mirrors Mondocraft `_aside` insertion without splitting punctuation or trailing periods.
 */
function insert_aside_after_target_phrase(assembled_text, target_phrase, aside_clause) {
    const span = find_safe_phrase_span_in_text(assembled_text, target_phrase);
    if (!span) {
        return `${assembled_text.replace(/[.,;\s]+$/, '')}, ${aside_clause}.`;
    }
    const trailing_slice = assembled_text.slice(span.end_index).trimStart();
    const needs_closing_comma = trailing_slice.length > 0 && !',.;:!?)]}\n'.includes(trailing_slice[0]);
    const closing_mark = needs_closing_comma ? ',' : '';
    return `${assembled_text.slice(0, span.end_index)}, ${aside_clause}${closing_mark}${assembled_text.slice(span.end_index)}`;
}

/**
 * WHAT: Applies Mondocraft Dream & NLP transformations (`metamorph`, `chimera`, `fractal`, `portal`, `crossover`, `kaleidoscope`, `swap`).
 * WHY: Lets curators push unlocked slots into surreal hybrid compositions beyond literal slot swaps.
 *
 * @param {string} assembled_text - Base sentence or clause text.
 * @param {ReadonlyArray<Object>} selected_ingredients_collection - Active ingredients on the remix canvas.
 * @param {string} style_mode - Target dream or NLP remix style.
 * @param {number} variation_seed - Deterministic template selector seed.
 * @returns {string} Transformed prompt text.
 */
export function apply_dream_mode_transformation(
    assembled_text = '',
    selected_ingredients_collection = [],
    style_mode = 'sentence',
    variation_seed = 0
) {
    const safe_text = String(assembled_text || '').trim();
    const safe_ingredients = Array.isArray(selected_ingredients_collection) ? selected_ingredients_collection : [];
    const normalized_style = String(style_mode || 'sentence').toLowerCase().trim();

    if (!safe_text || normalized_style === 'clauses' || normalized_style === 'sentence' || safe_ingredients.length === 0) {
        return safe_text;
    }

    const pick_deterministic_item = (options_list, salt_label) => {
        if (!Array.isArray(options_list) || options_list.length === 0) return '';
        const fraction = compute_deterministic_unit_hash(`${variation_seed}::${salt_label}::${safe_text}`);
        const picked_index = Math.min(options_list.length - 1, Math.floor(fraction * options_list.length));
        return options_list[picked_index];
    };

    const subject_items = safe_ingredients.filter(item => item.slot === 'subject_appearance' && item.text);
    const environment_items = safe_ingredients.filter(
        item => (item.slot === 'setting' || item.slot === 'weather_or_matter' || item.slot === 'other') && item.text
    );
    const donor_pool = safe_ingredients.filter(
        item => item.text && (item.slot === 'subject_appearance' || item.slot === 'setting' || item.slot === 'weather_or_matter')
    );

    const primary_subject = subject_items[0]?.text || safe_ingredients[0]?.text || '';
    const secondary_donor = donor_pool.find(item => item.text !== primary_subject)?.text
        || environment_items[0]?.text
        || safe_ingredients[safe_ingredients.length - 1]?.text
        || 'obsidian glass';

    if (normalized_style === 'metamorph') {
        const morph_verb = pick_deterministic_item(METAMORPH_TEMPLATES, 'metamorph');
        return insert_aside_after_target_phrase(
            safe_text,
            primary_subject,
            `${morph_verb} ${recase_first_letter(secondary_donor, false)}`
        );
    }

    if (normalized_style === 'chimera') {
        const noun_alpha = extract_trailing_noun_word(primary_subject) || 'creature';
        const noun_beta = extract_trailing_noun_word(secondary_donor);
        if (!noun_beta || noun_alpha === noun_beta) {
            return insert_aside_after_target_phrase(safe_text, primary_subject, `fused into a dual-form chimera with ${recase_first_letter(secondary_donor, false)}`);
        }
        const chimera_phrase = `${noun_alpha}-${noun_beta} hybrid`;
        const primary_span = find_safe_phrase_span_in_text(safe_text, primary_subject);
        if (primary_span) {
            const replaced_core = primary_subject.replace(new RegExp(`${noun_alpha}$`, 'i'), chimera_phrase);
            const span_edit = build_span_replacement_edit(safe_text, primary_span.start_index, primary_span.end_index, replaced_core);
            return apply_non_overlapping_span_edits(safe_text, [span_edit]) || safe_text;
        }
        return `${safe_text.replace(/[.,;\s]+$/, '')}, rendered as ${select_indefinite_article(chimera_phrase)} ${chimera_phrase}.`;
    }

    if (normalized_style === 'fractal') {
        const fractal_template = pick_deterministic_item(FRACTAL_TEMPLATES, 'fractal');
        const plural_donor = strip_leading_determiners_and_numbers(secondary_donor, true) || 'shards';
        return insert_aside_after_target_phrase(
            safe_text,
            primary_subject,
            fractal_template.replace('{}', plural_donor)
        );
    }

    if (normalized_style === 'portal') {
        const portal_template = pick_deterministic_item(PORTAL_TEMPLATES, 'portal');
        const portal_target = environment_items[0]?.text || primary_subject;
        const revealed_thing = recase_first_letter(secondary_donor, false);
        return insert_aside_after_target_phrase(
            safe_text,
            portal_target,
            portal_template.replace('{}', revealed_thing)
        );
    }

    if (normalized_style === 'crossover') {
        if (!secondary_donor || secondary_donor === primary_subject) return safe_text;
        const joiner = pick_deterministic_item(['alongside', 'paired with'], 'crossover');
        const target_span = find_safe_phrase_span_in_text(safe_text, primary_subject);
        if (!target_span) {
            return `${safe_text.replace(/[.,;\s]+$/, '')} ${joiner} ${recase_first_letter(secondary_donor, false)}.`;
        }
        return `${safe_text.slice(0, target_span.end_index)} ${joiner} ${recase_first_letter(secondary_donor, false)}${safe_text.slice(target_span.end_index)}`;
    }

    // 'swap' and 'kaleidoscope' preserve the in-place edited natural sentence flow
    return safe_text;
}
