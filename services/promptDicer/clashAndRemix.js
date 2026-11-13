/**
 * Prompt Dicer Clash Detection, Remix Assembly & Constraint Transplant Solver
 *
 * Pure functional algorithms for transitive continuity clash detection,
 * slot-ordered prompt remix assembly, influence closure, beam search,
 * and round-trip verification.
 */

import { execute_heuristic_offline_dicing, assemble_pass_c_master_record, build_heuristic_influences_for_master_record } from "../promptDicerService.js";

/**
 * WHAT: Detects 1-hop AND multi-hop transitive continuity clashes across remixed ingredients and influence chains.
 * WHY: When a user swaps an ingredient (e.g. rain -> wet surfaces -> reflections vs dry desert dust),
 *      propagating downstream target_ingredient states catches both direct and chained contradictions cleanly.
 * 
 * @param {ReadonlyArray<Object>} selected_ingredients_collection - Active ingredients in the remix.
 * @param {ReadonlyArray<Object>} ingredient_influences_collection - Directed influence edges with state tags.
 * @param {Object} detection_options - Optional `{ max_hops }` (default `3`).
 * @returns {ReadonlyArray<Object>} List of detected direct and transitive continuity clash warnings.
 */
export function detect_ingredient_clashes(
    selected_ingredients_collection,
    ingredient_influences_collection,
    detection_options = {}
) {
    if (!Array.isArray(ingredient_influences_collection) || ingredient_influences_collection.length === 0) {
        return Object.freeze([]);
    }

    const max_hops = Math.max(1, Math.min(6, Number(detection_options.max_hops) || 3));
    const safe_selected = Array.isArray(selected_ingredients_collection) ? selected_ingredients_collection : [];

    const active_ingredient_identifiers_set = new Set(
        safe_selected.map(ingredient_record => ingredient_record.ingredient_id).filter(Boolean)
    );
    const active_ingredient_texts_set = new Set(
        safe_selected.map(ingredient_record => (ingredient_record.text || '').toLowerCase().trim()).filter(Boolean)
    );

    const resolve_source_label = (influence_record) =>
        influence_record.source_text || influence_record.source_ingredient_id || 'ingredient';
    const resolve_target_label = (influence_record) =>
        influence_record.target_text || influence_record.target_ingredient_id || 'target';

    // 1. Seed queue with direct 1-hop active influences
    const bfs_queue = [];
    const visited_edge_keys = new Set();
    const propagated_state_claims = [];

    for (let edge_index = 0; edge_index < ingredient_influences_collection.length; edge_index++) {
        const influence_record = ingredient_influences_collection[edge_index];
        const matches_active_source = (
            (influence_record.source_ingredient_id && active_ingredient_identifiers_set.has(influence_record.source_ingredient_id)) ||
            (influence_record.source_text && active_ingredient_texts_set.has(influence_record.source_text.toLowerCase().trim()))
        );

        if (matches_active_source) {
            const seed_label = resolve_source_label(influence_record);
            const target_label = resolve_target_label(influence_record);
            const claim_record = Object.freeze({
                ...influence_record,
                claim_id: `${edge_index}@hop1`,
                hop_depth: 1,
                chain_path: Object.freeze([seed_label, target_label])
            });
            propagated_state_claims.push(claim_record);
            bfs_queue.push(claim_record);
            visited_edge_keys.add(`${edge_index}:${influence_record.source_ingredient_id || seed_label}`);
        }
    }

    // 2. Bounded BFS traversal following target_ingredient_id / target_text -> downstream source edges
    let queue_cursor = 0;
    while (queue_cursor < bfs_queue.length) {
        const current_claim = bfs_queue[queue_cursor++];
        if (current_claim.hop_depth >= max_hops) continue;

        const next_hop_depth = current_claim.hop_depth + 1;
        const upstream_target_id = current_claim.target_ingredient_id || null;
        const upstream_target_text = (current_claim.target_text || '').toLowerCase().trim();

        for (let edge_index = 0; edge_index < ingredient_influences_collection.length; edge_index++) {
            const candidate_edge = ingredient_influences_collection[edge_index];
            const candidate_source_id = candidate_edge.source_ingredient_id || null;
            const candidate_source_text = (candidate_edge.source_text || '').toLowerCase().trim();

            const links_from_upstream_target = (
                (upstream_target_id && candidate_source_id && candidate_source_id === upstream_target_id) ||
                (upstream_target_text && candidate_source_text && candidate_source_text === upstream_target_text)
            );
            if (!links_from_upstream_target) continue;

            const edge_visit_key = `${edge_index}:${candidate_source_id || candidate_source_text}`;
            if (visited_edge_keys.has(edge_visit_key)) continue;
            visited_edge_keys.add(edge_visit_key);

            const downstream_claim = Object.freeze({
                ...candidate_edge,
                claim_id: `${edge_index}@hop${next_hop_depth}`,
                hop_depth: next_hop_depth,
                chain_path: Object.freeze([...current_claim.chain_path, resolve_target_label(candidate_edge)])
            });
            propagated_state_claims.push(downstream_claim);
            bfs_queue.push(downstream_claim);
        }
    }

    // 3. Pairwise state contradiction checks across direct + propagated claims
    const detected_clashes_collection = [];
    const seen_clash_pairs = new Set();

    for (let index_first = 0; index_first < propagated_state_claims.length; index_first++) {
        const primary_claim = propagated_state_claims[index_first];

        for (let index_second = index_first + 1; index_second < propagated_state_claims.length; index_second++) {
            const secondary_claim = propagated_state_claims[index_second];
            if (primary_claim.state_key !== secondary_claim.state_key) continue;

            const is_direct_contradiction = (
                primary_claim.applied_state_value === secondary_claim.clashes_with_value ||
                secondary_claim.applied_state_value === primary_claim.clashes_with_value
            );
            if (!is_direct_contradiction) continue;

            const pair_values = [primary_claim.applied_state_value, secondary_claim.applied_state_value].sort();
            const pair_dedupe_key = `${primary_claim.state_key}::${pair_values[0]}::${pair_values[1]}`;
            if (seen_clash_pairs.has(pair_dedupe_key)) continue;
            seen_clash_pairs.add(pair_dedupe_key);

            const max_claim_hop = Math.max(primary_claim.hop_depth, secondary_claim.hop_depth);
            const is_transitive = max_claim_hop > 1;
            const active_chain = primary_claim.hop_depth >= secondary_claim.hop_depth
                ? primary_claim.chain_path
                : secondary_claim.chain_path;
            const chain_suffix = is_transitive ? ` via chain (${active_chain.join(' → ')})` : '';

            detected_clashes_collection.push(Object.freeze({
                clash_type: is_transitive ? 'transitive_state_contradiction' : 'state_contradiction',
                state_key: primary_claim.state_key,
                source_ingredient_alpha: primary_claim.source_ingredient_id,
                applied_value_alpha: primary_claim.applied_state_value,
                source_ingredient_beta: secondary_claim.source_ingredient_id,
                applied_value_beta: secondary_claim.applied_state_value,
                hop_depth: max_claim_hop,
                is_transitive,
                chain_path: active_chain,
                severity: 'warning',
                remediation_advice: `Conflict on '${primary_claim.state_key}': '${primary_claim.applied_state_value}' clashes with '${secondary_claim.applied_state_value}'${chain_suffix}. Consider isolating subject scope or removing one modifier.`
            }));
        }
    }

    return Object.freeze(detected_clashes_collection);
}

/**
 * WHAT: Composes a clean generation prompt from a curated set of ingredients and portable consequences.
 * WHY: When remixing, user-selected ingredients and carried consequence descriptions are assembled
 *      into a coherent text prompt formatted for image or video diffusion models.
 * 
 * @param {ReadonlyArray<Object>} selected_ingredients_collection - Selected ingredient records.
 * @param {ReadonlyArray<Object>} active_consequences_collection - Consequence description strings.
 * @param {Object} remix_options - Configuration options (e.g., include_observable_replacements).
 * @returns {string} Fully formatted remixed prompt string.
 */
export function assemble_remixed_prompt_text(
    selected_ingredients_collection,
    active_consequences_collection = [],
    remix_options = {}
) {
    const use_observable_replacements = remix_options.include_observable_replacements ?? true;

    const slot_presentation_priority = [
        'setting',
        'framing',
        'lens',
        'camera_motion',
        'subject_appearance',
        'expression_or_pose',
        'action',
        'weather_or_matter',
        'lighting',
        'palette',
        'film_stock_or_medium',
        'mood',
        'audio',
        'other'
    ];

    const prompt_clauses_collection = [];

    for (const slot_name of slot_presentation_priority) {
        const ingredients_in_slot = selected_ingredients_collection.filter(ingredient_record => {
            const replacement_slot = ingredient_record.observable_replacement?.replacement_slot || ingredient_record.replacement_slot;
            if (ingredient_record.kind === 'pretext_term' && use_observable_replacements && replacement_slot) {
                return replacement_slot === slot_name;
            }
            return ingredient_record.slot === slot_name;
        });

        for (const ingredient_record of ingredients_in_slot) {
            const replacement_text = ingredient_record.observable_replacement?.text || ingredient_record.observable_replacement_text;
            if (ingredient_record.kind === 'pretext_term' && use_observable_replacements && replacement_text) {
                prompt_clauses_collection.push(replacement_text);
            } else {
                prompt_clauses_collection.push(ingredient_record.text);
            }
        }
    }

    for (const consequence_text of active_consequences_collection) {
        if (typeof consequence_text === 'string' && consequence_text.trim().length > 0) {
            prompt_clauses_collection.push(consequence_text.trim());
        }
    }

    const unique_clauses = Array.from(new Set(prompt_clauses_collection.filter(Boolean)));
    return unique_clauses.join(', ');
}

// ============================================================================

// ============================================================================
// 8. CONSTRAINT TRANSPLANT, INFLUENCE CLOSURE & ROUND-TRIP VERIFICATION
// ============================================================================

// WHAT: Default slots locked when loading a base prompt for slot transplantation.
// WHY: Preserves core character identity, pose, action, and lens optics while allowing atmosphere and environment swaps.
export const DEFAULT_TRANSPLANT_LOCKED_SLOTS = Object.freeze([
    'subject_appearance',
    'expression_or_pose',
    'action',
    'lens'
]);

// WHAT: Environment and camera slots eligible for empty-slot enrichment when swaps leave budget remaining.
// WHY: Sparse base prompts benefit from coherent weather, lighting, setting, or medium additions without mutating locked core subjects.
export const ENVIRONMENT_AND_CAMERA_FILL_SLOTS = Object.freeze([
    'weather_or_matter',
    'lighting',
    'setting',
    'framing',
    'palette',
    'film_stock_or_medium',
    'camera_motion'
]);

/**
 * WHAT: Normalizes ingredient identity comparison keys across disparate database prompts.
 * WHY: Cross-prompt candidate pools often have overlapping `ing_001` local IDs, so comparing `(prompt_id, ingredient_id)` plus normalized text prevents false collisions.
 */
function build_ingredient_identity_signature(ingredient_record) {
    const prompt_identifier = ingredient_record?.prompt_id ? String(ingredient_record.prompt_id) : '';
    const local_identifier = ingredient_record?.ingredient_id ? String(ingredient_record.ingredient_id) : '';
    const normalized_text = String(ingredient_record?.text || '').toLowerCase().trim();
    return `${prompt_identifier}::${local_identifier}::${normalized_text}`;
}

/**
 * WHAT: Checks whether a given influence edge originates from a specific ingredient record.
 * WHY: Matches by prompt-scoped ID or normalized source phrase so cross-prompt influences link accurately.
 */
function does_influence_originate_from_ingredient(influence_record, ingredient_record) {
    if (!influence_record || !ingredient_record) return false;
    if (influence_record.prompt_id && ingredient_record.prompt_id && influence_record.prompt_id !== ingredient_record.prompt_id) {
        return false;
    }
    const matches_by_id = Boolean(
        influence_record.source_ingredient_id
        && ingredient_record.ingredient_id
        && influence_record.source_ingredient_id === ingredient_record.ingredient_id
    );
    const source_phrase = String(influence_record.source_text || '').toLowerCase().trim();
    const ingredient_phrase = String(ingredient_record.text || '').toLowerCase().trim();
    const matches_by_text = Boolean(source_phrase && ingredient_phrase && source_phrase === ingredient_phrase);
    return matches_by_id || matches_by_text;
}

/**
 * WHAT: Resolves forward downstream effects and prunes orphaned receivers using the Pass D influence graph.
 * WHY: Keeps remixed combinations physically coherent—pulling in implied effects (e.g. heavy rain -> wet cobblestones)
 *      into unlocked slots and removing dangling unlocked receivers when their supporting upstream cause is removed.
 *
 * @param {ReadonlyArray<Object>} selected_ingredients_collection - Current active ingredients.
 * @param {ReadonlyArray<Object>} known_influences_collection - Directed Pass D influence edges.
 * @param {ReadonlyArray<Object>} candidate_ingredients_catalog - Available catalog ingredients for resolving downstream targets.
 * @param {Object} closure_options - Optional `{ locked_slots, removed_ingredients, max_hops }`.
 * @returns {Object} Frozen closure result `{ ingredients, consequences, pulled_effects, pruned_orphans, active_influences }`.
 */
export function resolve_ingredient_influence_closure(
    selected_ingredients_collection = [],
    known_influences_collection = [],
    candidate_ingredients_catalog = [],
    closure_options = {}
) {
    const safe_selected = Array.isArray(selected_ingredients_collection) ? selected_ingredients_collection : [];
    const safe_influences = Array.isArray(known_influences_collection) ? known_influences_collection : [];
    const safe_catalog = Array.isArray(candidate_ingredients_catalog) ? candidate_ingredients_catalog : [];
    const locked_slots_set = new Set(
        Array.isArray(closure_options.locked_slots) ? closure_options.locked_slots : []
    );
    const removed_ingredients_list = Array.isArray(closure_options.removed_ingredients)
        ? closure_options.removed_ingredients
        : [];
    const max_hops = Math.max(1, Math.min(4, Number(closure_options.max_hops) || 2));

    // WHAT: Step 1 — Prune orphaned unlocked receivers whose sole supporting upstream cause was removed.
    // WHY: Dropping "heavy rain" must also clear previously auto-pulled "glistening pavement" unless another active cause still justifies it.
    const surviving_after_pruning = [];
    const pruned_orphans_log = [];

    for (const active_ingredient of safe_selected) {
        const is_closure_derived = active_ingredient?.provenance === 'influence_closure';
        const is_slot_locked = locked_slots_set.has(active_ingredient?.slot || 'other');
        const supporting_signatures = Array.isArray(active_ingredient?.supported_by_causes)
            ? active_ingredient.supported_by_causes
            : [];

        if (!is_closure_derived || is_slot_locked || supporting_signatures.length === 0) {
            surviving_after_pruning.push(active_ingredient);
            continue;
        }

        const remaining_active_pool = safe_selected.filter(
            candidate_other => build_ingredient_identity_signature(candidate_other) !== build_ingredient_identity_signature(active_ingredient)
        );
        const still_has_active_supporter = supporting_signatures.some(supporter_sig =>
            remaining_active_pool.some(remaining_item => build_ingredient_identity_signature(remaining_item) === supporter_sig)
        );

        const supported_cause_was_explicitly_removed = removed_ingredients_list.some(removed_item =>
            supporting_signatures.includes(build_ingredient_identity_signature(removed_item))
        );

        if (!still_has_active_supporter || supported_cause_was_explicitly_removed && !still_has_active_supporter) {
            pruned_orphans_log.push(Object.freeze({
                text: active_ingredient.text,
                slot: active_ingredient.slot || 'other',
                reason: 'supporting_cause_removed'
            }));
        } else {
            surviving_after_pruning.push(active_ingredient);
        }
    }

    // WHAT: Index catalog ingredients by `(prompt_id, ingredient_id)` and lowercase text to resolve downstream target recipes.
    // WHY: Allows BFS edges storing target IDs to pull concrete cataloged ingredient records into unlocked slots.
    const catalog_lookup_by_prompt_and_id = new Map();
    const catalog_lookup_by_text = new Map();
    for (const catalog_entry of safe_catalog) {
        if (!catalog_entry || !catalog_entry.text) continue;
        if (catalog_entry.prompt_id && catalog_entry.ingredient_id) {
            catalog_lookup_by_prompt_and_id.set(`${catalog_entry.prompt_id}::${catalog_entry.ingredient_id}`, catalog_entry);
        }
        const lower_catalog_text = String(catalog_entry.text).toLowerCase().trim();
        if (!catalog_lookup_by_text.has(lower_catalog_text)) {
            catalog_lookup_by_text.set(lower_catalog_text, catalog_entry);
        }
    }

    // WHAT: Step 2 — Bounded BFS forward pull from active ingredients across compatible Pass D edges.
    // WHY: Automatically pulls unrepresented downstream effects into unlocked slots (or emits portable consequence clauses if locked).
    const working_ingredients_list = [...surviving_after_pruning];
    const pulled_effects_log = [];
    const collected_consequences = [];
    const bfs_frontier = surviving_after_pruning.map(item => ({ ingredient: item, depth: 0 }));
    const visited_edge_tokens = new Set();

    let frontier_cursor = 0;
    while (frontier_cursor < bfs_frontier.length) {
        const current_node = bfs_frontier[frontier_cursor++];
        if (current_node.depth >= max_hops) continue;

        const cause_signature = build_ingredient_identity_signature(current_node.ingredient);

        for (let edge_index = 0; edge_index < safe_influences.length; edge_index++) {
            const influence_edge = safe_influences[edge_index];
            if (!does_influence_originate_from_ingredient(influence_edge, current_node.ingredient)) {
                continue;
            }

            const visit_token = `${cause_signature}->${edge_index}`;
            if (visited_edge_tokens.has(visit_token)) continue;
            visited_edge_tokens.add(visit_token);

            const scoped_target_key = (influence_edge.prompt_id || current_node.ingredient.prompt_id) && influence_edge.target_ingredient_id
                ? `${influence_edge.prompt_id || current_node.ingredient.prompt_id}::${influence_edge.target_ingredient_id}`
                : '';
            const normalized_target_text = String(influence_edge.target_text || '').toLowerCase().trim();

            const matched_target_ingredient = (scoped_target_key && catalog_lookup_by_prompt_and_id.get(scoped_target_key))
                || (normalized_target_text && catalog_lookup_by_text.get(normalized_target_text))
                || null;

            if (!matched_target_ingredient || !matched_target_ingredient.text) {
                const consequence_phrase = String(influence_edge.consequence_description || '').trim();
                if (consequence_phrase && !collected_consequences.includes(consequence_phrase)) {
                    collected_consequences.push(consequence_phrase);
                }
                continue;
            }

            const target_lower_text = String(matched_target_ingredient.text).toLowerCase().trim();
            const existing_target_index = working_ingredients_list.findIndex(
                item => String(item.text || '').toLowerCase().trim() === target_lower_text
            );

            if (existing_target_index >= 0) {
                continue;
            }

            const target_slot = matched_target_ingredient.slot || 'other';
            if (locked_slots_set.has(target_slot)) {
                const consequence_phrase = String(influence_edge.consequence_description || '').trim();
                if (consequence_phrase && !collected_consequences.includes(consequence_phrase)) {
                    collected_consequences.push(consequence_phrase);
                }
                continue;
            }

            const candidate_pulled_ingredient = Object.freeze({
                ...matched_target_ingredient,
                provenance: 'influence_closure',
                supported_by_causes: Object.freeze([cause_signature])
            });

            // Reject auto-pull if it would introduce any hard continuity clash against the working set
            const candidate_with_target = [...working_ingredients_list, candidate_pulled_ingredient];
            const resulting_clashes = detect_ingredient_clashes(candidate_with_target, safe_influences);
            if (resulting_clashes.length > 0) {
                continue;
            }

            working_ingredients_list.push(candidate_pulled_ingredient);
            pulled_effects_log.push(Object.freeze({
                text: candidate_pulled_ingredient.text,
                slot: target_slot,
                from_cause: current_node.ingredient.text,
                state_key: influence_edge.state_key || null,
                applied_state_value: influence_edge.applied_state_value || null
            }));

            bfs_frontier.push({
                ingredient: candidate_pulled_ingredient,
                depth: current_node.depth + 1
            });
        }
    }

    const active_ingredient_ids_set = new Set(working_ingredients_list.map(item => item.ingredient_id).filter(Boolean));
    const active_ingredient_texts_set = new Set(working_ingredients_list.map(item => String(item.text || '').toLowerCase().trim()));
    const relevant_active_influences = safe_influences.filter(inf =>
        (inf.source_ingredient_id && active_ingredient_ids_set.has(inf.source_ingredient_id))
        || (inf.source_text && active_ingredient_texts_set.has(String(inf.source_text).toLowerCase().trim()))
    );

    return Object.freeze({
        ingredients: Object.freeze(working_ingredients_list),
        consequences: Object.freeze(collected_consequences),
        pulled_effects: Object.freeze(pulled_effects_log),
        pruned_orphans: Object.freeze(pruned_orphans_log),
        active_influences: Object.freeze(relevant_active_influences)
    });
}

/**
 * WHAT: Scores an individual transplant candidate against current active ingredients using pure soft criteria.
 * WHY: Prefers visually cluster-compatible, physically concrete, graph-connected replacements without hidden state.
 */
function score_transplant_candidate(candidate_ingredient, current_ingredients, influences_collection, variation_seed = 0) {
    const cluster_bonus = candidate_ingredient.cluster_match ? 3.0 : 0;
    const neighbor_bonus = candidate_ingredient.vector_neighbor_match ? 2.0 : 0;
    const concreteness_bonus = candidate_ingredient.kind === 'physical_anchor' ? 1.5 : 0;
    const usage_bonus = 0.5 * Math.min(1, Math.log10((Number(candidate_ingredient.usage_count) || 1) + 1));

    const current_texts_set = new Set(current_ingredients.map(item => String(item.text || '').toLowerCase().trim()));
    const current_ids_set = new Set(current_ingredients.map(item => item.ingredient_id).filter(Boolean));

    const has_synergy_edge = (Array.isArray(influences_collection) ? influences_collection : []).some(edge => {
        const from_candidate = does_influence_originate_from_ingredient(edge, candidate_ingredient)
            && (current_ids_set.has(edge.target_ingredient_id) || current_texts_set.has(String(edge.target_text || '').toLowerCase().trim()));
        const to_candidate = (current_ids_set.has(edge.source_ingredient_id) || current_texts_set.has(String(edge.source_text || '').toLowerCase().trim()))
            && (edge.target_ingredient_id === candidate_ingredient.ingredient_id || String(edge.target_text || '').toLowerCase().trim() === String(candidate_ingredient.text || '').toLowerCase().trim());
        return from_candidate || to_candidate;
    });
    const synergy_bonus = has_synergy_edge ? 1.5 : 0;

    // WHAT: Computing a deterministic FNV-1a micro-perturbation controlled by `variation_seed`.
    // WHY: Lets "Another Variation" explore fresh compatible candidates while staying reproducible for a given seed.
    const seed_tiebreaker = Number(variation_seed) > 0
        ? (() => {
            const key_string = `${variation_seed}::${candidate_ingredient.text || ''}`;
            let hash_value = 2166136261;
            for (let character_position = 0; character_position < key_string.length; character_position++) {
                hash_value ^= key_string.charCodeAt(character_position);
                hash_value = Math.imul(hash_value, 16777619);
            }
            return (((hash_value >>> 0) % 1000) / 1000) * 1.25;
        })()
        : 0;

    return Number((cluster_bonus + neighbor_bonus + concreteness_bonus + usage_bonus + synergy_bonus + seed_tiebreaker).toFixed(4));
}

/**
 * WHAT: Solves K-slot transplantation into a base prompt using hard clash pruning, soft beam search, and Influence Closure.
 * WHY: Automates safe ingredient swapping across unlocked slots while honoring locked subject/lens slots and catching physical contradictions.
 *
 * @param {ReadonlyArray<Object>} base_ingredients_collection - Starting base prompt ingredients.
 * @param {Object} candidate_pools_by_slot - Mapping `{ [slot_name]: Array<Ingredient> }` of catalog candidates.
 * @param {ReadonlyArray<Object>} influences_collection - Known Pass D influence edges across active & candidate items.
 * @param {Object} transplant_options - `{ locked_slots, swap_count, allow_empty_fills, beam_width, variation_seed }`.
 * @returns {Object} Frozen winning plan and top beam alternatives.
 */
export function solve_constraint_transplant_beam(
    base_ingredients_collection = [],
    candidate_pools_by_slot = {},
    influences_collection = [],
    transplant_options = {}
) {
    const safe_base = Array.isArray(base_ingredients_collection) ? base_ingredients_collection : [];
    const safe_influences = Array.isArray(influences_collection) ? influences_collection : [];
    const locked_slots_set = new Set(
        Array.isArray(transplant_options.locked_slots)
            ? transplant_options.locked_slots
            : DEFAULT_TRANSPLANT_LOCKED_SLOTS
    );
    const requested_swap_count = Math.max(1, Math.min(8, Number(transplant_options.swap_count) || 2));
    const allow_empty_fills = transplant_options.allow_empty_fills !== false;
    const beam_width = Math.max(1, Math.min(12, Number(transplant_options.beam_width) || 5));
    const variation_seed = Number(transplant_options.variation_seed) || 0;

    // WHAT: Identify populated unlocked slots first, then eligible empty unlocked environment/camera slots.
    // WHY: Prioritizes swapping existing unlocked slots up to K, filling empty atmosphere slots only when remaining K budget exists.
    const populated_unlocked_slots = Array.from(new Set(
        safe_base
            .map(item => item.slot || 'other')
            .filter(slot_name => !locked_slots_set.has(slot_name) && Array.isArray(candidate_pools_by_slot[slot_name]) && candidate_pools_by_slot[slot_name].length > 0)
    ));

    const populated_slot_set = new Set(safe_base.map(item => item.slot || 'other'));
    const empty_fill_slots = allow_empty_fills
        ? ENVIRONMENT_AND_CAMERA_FILL_SLOTS.filter(slot_name =>
            !locked_slots_set.has(slot_name)
            && !populated_slot_set.has(slot_name)
            && Array.isArray(candidate_pools_by_slot[slot_name])
            && candidate_pools_by_slot[slot_name].some(cand => cand.cluster_match || cand.kind === 'physical_anchor')
        )
        : [];

    const ordered_target_slots = [...populated_unlocked_slots, ...empty_fill_slots].slice(0, requested_swap_count);
    const flattened_catalog = Object.values(candidate_pools_by_slot).flat();

    if (ordered_target_slots.length === 0) {
        const base_closure = resolve_ingredient_influence_closure(
            safe_base,
            safe_influences,
            flattened_catalog,
            { locked_slots: Array.from(locked_slots_set) }
        );
        return Object.freeze({
            selected_ingredients: base_closure.ingredients,
            consequences: base_closure.consequences,
            swapped_slots: Object.freeze([]),
            pulled_effects: base_closure.pulled_effects,
            pruned_orphans: base_closure.pruned_orphans,
            score: 0,
            clashes: detect_ingredient_clashes(base_closure.ingredients, safe_influences),
            beam_candidates: Object.freeze([])
        });
    }

    // Initialize beam state with the untouched base ingredients
    let current_beam = [{
        ingredients: safe_base,
        removed_ingredients: [],
        swapped_slots: [],
        score: 0
    }];

    for (const target_slot of ordered_target_slots) {
        const slot_candidates_raw = candidate_pools_by_slot[target_slot] || [];
        const next_beam_pool = [];

        for (const beam_state of current_beam) {
            const active_texts_lower = new Set(beam_state.ingredients.map(item => String(item.text || '').toLowerCase().trim()));
            const slot_existing_items = beam_state.ingredients.filter(item => (item.slot || 'other') === target_slot);
            const remaining_other_items = beam_state.ingredients.filter(item => (item.slot || 'other') !== target_slot);

            // Rank candidates dynamically against this partial beam state
            const scored_candidates = slot_candidates_raw
                .filter(candidate => candidate && candidate.text && !active_texts_lower.has(String(candidate.text).toLowerCase().trim()))
                .map(candidate => ({
                    candidate,
                    step_score: score_transplant_candidate(candidate, remaining_other_items, safe_influences, variation_seed)
                }))
                .toSorted((first_entry, second_entry) => second_entry.step_score - first_entry.step_score)
                .slice(0, Math.max(beam_width * 3, 12));

            for (const { candidate, step_score } of scored_candidates) {
                const stamped_candidate = Object.freeze({
                    ...candidate,
                    provenance: 'constraint_transplant'
                });
                const trial_ingredients = [...remaining_other_items, stamped_candidate];
                const step_clashes = detect_ingredient_clashes(trial_ingredients, safe_influences);

                // Hard clash rule: strictly prune conflicting branches
                if (step_clashes.length > 0) {
                    continue;
                }

                next_beam_pool.push({
                    ingredients: trial_ingredients,
                    removed_ingredients: [...beam_state.removed_ingredients, ...slot_existing_items],
                    swapped_slots: [
                        ...beam_state.swapped_slots,
                        Object.freeze({
                            slot: target_slot,
                            replaced_texts: Object.freeze(slot_existing_items.map(item => item.text)),
                            chosen_text: stamped_candidate.text,
                            chosen_source_prompt: stamped_candidate.prompt_id || null,
                            step_score
                        })
                    ],
                    score: Number((beam_state.score + step_score).toFixed(4))
                });
            }

            // Fallback: keep current beam state unchanged if every candidate clashed
            if (scored_candidates.length === 0 || next_beam_pool.length === 0) {
                next_beam_pool.push(beam_state);
            }
        }

        // Deduplicate identical text sets and retain top `beam_width` hypotheses
        const unique_signatures = new Set();
        const pruned_sorted_beam = [];
        for (const candidate_state of next_beam_pool.toSorted((alpha, beta) => beta.score - alpha.score)) {
            const state_signature = candidate_state.ingredients
                .map(item => String(item.text || '').toLowerCase().trim())
                .toSorted()
                .join('|');
            if (!unique_signatures.has(state_signature)) {
                unique_signatures.add(state_signature);
                pruned_sorted_beam.push(candidate_state);
                if (pruned_sorted_beam.length >= beam_width) break;
            }
        }
        if (pruned_sorted_beam.length > 0) {
            current_beam = pruned_sorted_beam;
        }
    }

    // Apply #3 Influence Closure to each surviving beam hypothesis and pick highest clash-free score
    const finalized_plans = current_beam.map(beam_state => {
        const closure_result = resolve_ingredient_influence_closure(
            beam_state.ingredients,
            safe_influences,
            flattened_catalog,
            {
                locked_slots: Array.from(locked_slots_set),
                removed_ingredients: beam_state.removed_ingredients
            }
        );
        const final_clashes = detect_ingredient_clashes(closure_result.ingredients, safe_influences);
        const net_score = Number((beam_state.score - final_clashes.length * 100).toFixed(4));

        return Object.freeze({
            selected_ingredients: closure_result.ingredients,
            consequences: closure_result.consequences,
            swapped_slots: Object.freeze(beam_state.swapped_slots),
            pulled_effects: closure_result.pulled_effects,
            pruned_orphans: closure_result.pruned_orphans,
            score: net_score,
            clashes: final_clashes
        });
    }).toSorted((alpha, beta) => beta.score - alpha.score);

    const winning_plan = finalized_plans[0];
    return Object.freeze({
        ...winning_plan,
        beam_candidates: Object.freeze(finalized_plans)
    });
}

/**
 * WHAT: Verifies an assembled prompt string by running it back through the Prompt Dicer and comparing slot & clash integrity.
 * WHY: Catches silently dropped constraints, lost physical anchors, or newly introduced continuity clashes after assembly or stitching.
 *
 * @param {ReadonlyArray<Object>} planned_ingredients_collection - Original planned ingredients before text rendering.
 * @param {string} assembled_prompt_text - The resulting prompt text to re-dice and inspect.
 * @param {Object} verification_options - Optional `{ media_type, include_observable_replacements, precomputed_dicing_result }`.
 * @returns {Object} Frozen verification verdict `{ verified, status, preserved_slot_count, total_planned_slots, missing_slots, missing_anchors, clash_count, round_trip_ratio, execution_mode }`.
 */
export function verify_prompt_round_trip(
    planned_ingredients_collection = [],
    assembled_prompt_text = '',
    verification_options = {}
) {
    const safe_planned = Array.isArray(planned_ingredients_collection) ? planned_ingredients_collection : [];
    const safe_prompt_text = typeof assembled_prompt_text === 'string' ? assembled_prompt_text.trim() : '';
    const media_type = verification_options.media_type === 'video' ? 'video' : 'image';
    const use_replacements = verification_options.include_observable_replacements !== false;

    if (safe_planned.length === 0 || !safe_prompt_text) {
        return Object.freeze({
            verified: false,
            status: 'empty_input',
            preserved_slot_count: 0,
            total_planned_slots: 0,
            missing_slots: Object.freeze([]),
            missing_anchors: Object.freeze([]),
            clash_count: 0,
            round_trip_ratio: 0,
            execution_mode: 'heuristic_offline'
        });
    }

    let re_diced_master_record = verification_options.precomputed_dicing_result?.master_record || null;
    let re_diced_influences = verification_options.precomputed_dicing_result?.influences || null;
    const execution_mode = verification_options.precomputed_dicing_result?.execution_mode || 'heuristic_offline';

    if (!re_diced_master_record) {
        const heuristic_result = execute_heuristic_offline_dicing(safe_prompt_text, media_type);
        const provisional_master = assemble_pass_c_master_record(
            heuristic_result.pass_a,
            heuristic_result.pass_b,
            'prm_roundtrip',
            safe_prompt_text,
            media_type,
            []
        );
        re_diced_influences = build_heuristic_influences_for_master_record(provisional_master);
        re_diced_master_record = assemble_pass_c_master_record(
            heuristic_result.pass_a,
            heuristic_result.pass_b,
            'prm_roundtrip',
            safe_prompt_text,
            media_type,
            re_diced_influences
        );
    }

    const expected_slots_set = new Set();
    const expected_phrase_tokens = [];

    for (const ingredient of safe_planned) {
        const effective_slot = (ingredient.kind === 'pretext_term' && use_replacements && ingredient.observable_replacement?.replacement_slot)
            ? ingredient.observable_replacement.replacement_slot
            : (ingredient.slot || 'other');
        const effective_phrase = (ingredient.kind === 'pretext_term' && use_replacements && (ingredient.observable_replacement?.text || ingredient.observable_replacement_text))
            ? (ingredient.observable_replacement?.text || ingredient.observable_replacement_text)
            : ingredient.text;

        expected_slots_set.add(effective_slot);
        if (effective_phrase && String(effective_phrase).trim().length > 0) {
            expected_phrase_tokens.push({
                slot: effective_slot,
                text: String(effective_phrase).trim()
            });
        }
    }

    const round_trip_slots_set = new Set(re_diced_master_record.ingredients.map(item => item.slot || 'other'));
    const lower_assembled = safe_prompt_text.toLowerCase();
    const round_trip_joined_texts = re_diced_master_record.ingredients.map(item => String(item.text || '').toLowerCase()).join(' | ');

    const missing_slots = Array.from(expected_slots_set).filter(slot_name => {
        if (round_trip_slots_set.has(slot_name)) return false;
        // Tolerate heuristic slot re-bucketing if all planned phrases for that slot remained verbatim in the re-diced output
        const phrases_for_slot = expected_phrase_tokens.filter(entry => entry.slot === slot_name);
        const all_phrases_recovered = phrases_for_slot.length > 0 && phrases_for_slot.every(entry =>
            round_trip_joined_texts.includes(entry.text.toLowerCase()) || lower_assembled.includes(entry.text.toLowerCase())
        );
        return !all_phrases_recovered;
    });

    const missing_anchors = expected_phrase_tokens
        .filter(entry => !lower_assembled.includes(entry.text.toLowerCase()))
        .map(entry => entry.text);

    const round_trip_clashes = detect_ingredient_clashes(
        re_diced_master_record.ingredients,
        re_diced_influences || []
    );

    const preserved_slot_count = expected_slots_set.size - missing_slots.length;
    const verified = missing_slots.length === 0 && missing_anchors.length === 0 && round_trip_clashes.length === 0;

    return Object.freeze({
        verified,
        status: verified ? 'verified' : 'drift_detected',
        preserved_slot_count,
        total_planned_slots: expected_slots_set.size,
        missing_slots: Object.freeze(missing_slots),
        missing_anchors: Object.freeze(missing_anchors),
        clash_count: round_trip_clashes.length,
        clashes: round_trip_clashes,
        round_trip_ratio: re_diced_master_record.metrics?.physicality_ratio ?? 0,
        execution_mode
    });
}
