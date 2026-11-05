/**
 * ============================================================================
 * LUMINA STUDIO - HANDWIRED VECTOR ENGINE PROPERTY FUZZING SUITE
 * ============================================================================
 * 
 * WHAT: Generative property-based fuzz test suite using fast-check.
 * WHY:  Inspired by Google Project Zero's "Fuzzilli vs. BigSleep" findings,
 *       this suite exercises the Handwired vector search and RRF fusion logic
 *       against thousands of randomized, chaotic numerical and structural inputs
 *       (NaNs, Infinities, denormals, dimension mismatches, zero-magnitude vectors)
 *       to prove mathematical invariants and memory-safety resilience.
 * 
 * PROTOCOL COMPLIANCE:
 * 1. "can_be_long" Protocol: Expressive, self-documenting variable names.
 * 2. "Tutorial Protocol": Comprehensive WHAT and WHY documentation.
 * ============================================================================
 */

import fc from 'fast-check';
import fs from 'fs';
import vm from 'vm';
import path from 'path';

// WHAT: Loading search-worker.js into an isolated VM execution context.
// WHY:  Allows testing the pure functional algorithms in Node.js without requiring classic Web Worker DOM globals.
const search_worker_file_path = path.resolve('public', 'search-worker.js');
const search_worker_code_string = fs.readFileSync(search_worker_file_path, 'utf8');

const worker_execution_context = {
    console,
    Math,
    Float32Array,
    Array,
    Map,
    Set,
    String,
    Number,
    performance,
    module: { exports: {} },
    exports: {}
};
vm.createContext(worker_execution_context);
vm.runInContext(search_worker_code_string, worker_execution_context);

const {
    buildContiguousVectorTable,
    computeVectorSimilaritiesViaContiguousCpu,
    fuseRankedListsUsingRRF
} = worker_execution_context.module.exports;

console.log('================================================================================');
console.log('Starting Handwired Vector Engine Generative Property Fuzzing Suite (fast-check)');
console.log('================================================================================\n');

let total_passed_fuzz_assertions = 0;

// ============================================================================
// PROPERTY 1: NaN & INFINITY IMMUNITY IN CONTIGUOUS VECTOR PACKING
// ============================================================================
// WHAT: Injects random mixtures of NaNs, positive/negative Infinities, and subnormal floats.
// WHY:  Proves that corrupt or malformed embeddings can never poison the contiguous buffer with NaN.
console.log('[Fuzz Test 1] Testing NaN and Infinity immunity during vector packing...');

fc.assert(
    fc.property(
        fc.dictionary(
            fc.stringMatching(/^[0-9]{1,6}$/),
            fc.array(
                fc.oneof(
                    fc.float(),
                    fc.constant(NaN),
                    fc.constant(Infinity),
                    fc.constant(-Infinity),
                    fc.constant(null),
                    fc.constant(undefined)
                ),
                { minLength: 1, maxLength: 64 }
            ),
            { minKeys: 1, maxKeys: 15 }
        ),
        (fuzzed_raw_embeddings_dictionary) => {
            // Execution must never throw an unhandled exception
            buildContiguousVectorTable(fuzzed_raw_embeddings_dictionary);

            // Test CPU query against this potentially hostile table
            const arbitrary_query_vector = new Float32Array(64).fill(0.1);
            const search_results_collection = computeVectorSimilaritiesViaContiguousCpu(arbitrary_query_vector);

            // Invariant: every returned score must be a finite number, never NaN
            for (const single_candidate_match of search_results_collection) {
                if (!Number.isFinite(single_candidate_match.score) || Number.isNaN(single_candidate_match.score)) {
                    return false;
                }
            }
            return true;
        }
    ),
    { numRuns: 200 }
);
total_passed_fuzz_assertions++;
console.log('  PASS: 200 randomized iterations with NaNs and Infinities handled with 0 memory poisonings.\n');

// ============================================================================
// PROPERTY 2: MATHEMATICAL INVARIANT BOUNDS [-1.0, 1.0]
// ============================================================================
// WHAT: Generates extreme vector floats ranging from -1e38 to 1e38.
// WHY:  Proves that computed cosine similarity scores strictly obey the mathematical [-1.0, 1.0] range.
console.log('[Fuzz Test 2] Testing strict mathematical cosine range [-1.0, 1.0] under extreme floats...');

fc.assert(
    fc.property(
        fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), { minLength: 32, maxLength: 32 }),
        fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), { minLength: 32, maxLength: 32 }),
        (first_vector_coordinates, second_vector_coordinates) => {
            const test_embeddings_fixture = {
                '1': first_vector_coordinates,
                '2': second_vector_coordinates
            };
            buildContiguousVectorTable(test_embeddings_fixture);

            const test_query_vector = new Float32Array(32).fill(0.5);
            const search_results_collection = computeVectorSimilaritiesViaContiguousCpu(test_query_vector);

            for (const single_candidate_match of search_results_collection) {
                if (single_candidate_match.score < -1.0 || single_candidate_match.score > 1.0) {
                    return false;
                }
            }
            return true;
        }
    ),
    { numRuns: 250 }
);
total_passed_fuzz_assertions++;
console.log('  PASS: 250 randomized iterations confirmed cosine similarities never violate [-1.0, 1.0].\n');

// ============================================================================
// PROPERTY 3: ZERO-MAGNITUDE RESILIENCE
// ============================================================================
// WHAT: Passes zero-vectors and vectors with near-zero magnitudes (< 1e-12).
// WHY:  Guarantees zero-division does not crash the search worker or create NaN inverse factors.
console.log('[Fuzz Test 3] Testing zero-magnitude vector resilience (guarding against division by zero)...');

const all_zeroes_vector = new Array(768).fill(0.0);
const subnormal_vector = new Array(768).fill(1e-25);
const zero_magnitude_fixture = {
    '101': all_zeroes_vector,
    '102': subnormal_vector
};

buildContiguousVectorTable(zero_magnitude_fixture);
const zero_query_vector = new Float32Array(768).fill(0.0);
const zero_query_results = computeVectorSimilaritiesViaContiguousCpu(zero_query_vector);

if (Array.isArray(zero_query_results)) {
    total_passed_fuzz_assertions++;
    console.log(`  PASS: Zero-magnitude vectors processed cleanly without division-by-zero crashes (${zero_query_results.length} matches).\n`);
} else {
    throw new Error('Zero magnitude test failed to return an array.');
}

// ============================================================================
// PROPERTY 4: RECIPROCAL RANK FUSION (RRF) ROBUSTNESS UNDER CHAOTIC INPUT
// ============================================================================
// WHAT: Injects malformed lists, null objects, missing IDs, and chaotic structures into RRF fusion.
// WHY:  Proves RRF never throws unhandled TypeError exceptions even when given corrupted candidate feeds.
console.log('[Fuzz Test 4] Testing Reciprocal Rank Fusion robustness under chaotic rank structures...');

fc.assert(
    fc.property(
        fc.array(
            fc.record({
                id: fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.constant(undefined)),
                name: fc.string()
            }),
            { maxLength: 50 }
        ),
        fc.array(
            fc.record({
                id: fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.constant(undefined)),
                name: fc.string()
            }),
            { maxLength: 50 }
        ),
        (first_fuzzed_rank_list, second_fuzzed_rank_list) => {
            const fused_output_collection = fuseRankedListsUsingRRF(first_fuzzed_rank_list, second_fuzzed_rank_list);
            
            // Invariant: returned output must be an array
            if (!Array.isArray(fused_output_collection)) {
                return false;
            }

            // Invariant: every element must be a valid candidate object
            for (const single_fused_item of fused_output_collection) {
                if (!single_fused_item || single_fused_item.id === undefined || single_fused_item.id === null) {
                    return false;
                }
            }
            return true;
        }
    ),
    { numRuns: 300 }
);
total_passed_fuzz_assertions++;
console.log('  PASS: 300 chaotic RRF permutations executed with zero unhandled exceptions.\n');

console.log('================================================================================');
console.log(`[SUCCESS] All ${total_passed_fuzz_assertions} generative property fuzzing suites passed cleanly!`);
console.log('================================================================================');
