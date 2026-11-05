"""
===============================================================================
LUMINA STUDIO - GRAPHMEMORY PROPERTY FUZZING SUITE (HYPOTHESIS)
===============================================================================

WHAT: Generative property-based fuzz testing suite using Hypothesis.
WHY:  Validates that GraphMemory retrieval algorithms, UUIDv5 deterministic
      generation, and DuckDB analytical queries operate without unhandled exceptions
      or memory corruption when presented with arbitrary, hostile, or chaotic inputs
      (boundary integers, negative cluster IDs, chaotic strings, unicode anomalies).

PROTOCOL COMPLIANCE:
1. "can_be_long" Protocol: Expressive semantic variable names.
2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
===============================================================================
"""

import sys
import uuid
import unittest
from pathlib import Path
from hypothesis import given, settings, strategies as st
import duckdb

# Anchoring path to project root
WORKSPACE_ROOT_DIRECTORY_PATH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT_DIRECTORY_PATH))

from scripts.build_graph_memory import (
    generate_deterministic_node_uuid,
    generate_deterministic_edge_uuid,
    LUMINA_STUDIO_GRAPH_NAMESPACE_UUID
)
from scripts.associative_retrieval import (
    compute_deterministic_image_uuid,
    compute_deterministic_topic_uuid,
    execute_multi_hop_associative_search,
    find_bridges_between_clusters
)


class GraphMemoryHypothesisPropertyFuzzTests(unittest.TestCase):
    """
    WHAT: Hypothesis property fuzzing tests exercising GraphMemory invariants.
    WHY:  Proves system resilience under randomized chaotic input spaces.
    """

    @classmethod
    def setUpClass(cls):
        cls.graph_database_file_path = WORKSPACE_ROOT_DIRECTORY_PATH / "graph_memory.duckdb"
        if cls.graph_database_file_path.exists():
            cls.duckdb_readonly_connection = duckdb.connect(str(cls.graph_database_file_path), read_only=True)
        else:
            cls.duckdb_readonly_connection = None

    @classmethod
    def tearDownClass(cls):
        if cls.duckdb_readonly_connection:
            cls.duckdb_readonly_connection.close()

    # =========================================================================
    # PROPERTY 1: DETERMINISTIC UUIDv5 IDEMPOTENCE & RFC 4122 COMPLIANCE
    # =========================================================================
    # WHAT: Fuzzes arbitrary unicode strings, control characters, and integer representations.
    # WHY:  UUIDv5 generation must remain strictly deterministic and never crash on arbitrary text.
    @given(st.text(min_size=0, max_size=500), st.text(min_size=0, max_size=500))
    @settings(max_examples=250)
    def test_fuzz_uuid_generation_determinism_and_rfc4122(self, entity_category_text, raw_entity_identifier_text):
        first_generated_uuid = generate_deterministic_node_uuid(entity_category_text, raw_entity_identifier_text)
        second_generated_uuid = generate_deterministic_node_uuid(entity_category_text, raw_entity_identifier_text)

        # Invariant 1: Idempotency (same inputs always yield identical UUID)
        self.assertEqual(first_generated_uuid, second_generated_uuid)

        # Invariant 2: Version 5 RFC 4122 compliance
        self.assertEqual(first_generated_uuid.version, 5)

        # Invariant 3: String representation is a standard 36-char hyphenated UUID
        self.assertEqual(len(str(first_generated_uuid)), 36)

    # =========================================================================
    # PROPERTY 2: ARBITRARY INTEGER IMAGE RETRIEVAL SAFETY
    # =========================================================================
    # WHAT: Fuzzes image queries with negative, zero, and huge 64-bit integer values.
    # WHY:  Queries for non-existent or extreme IDs must return clean empty lists, never crashing DuckDB.
    @given(st.integers(min_value=-1000000000, max_value=1000000000000), st.integers(min_value=1, max_value=50))
    @settings(max_examples=100)
    def test_fuzz_associative_search_arbitrary_image_identifiers(self, arbitrary_image_id, maximum_limit):
        if not self.duckdb_readonly_connection:
            self.skipTest("graph_memory.duckdb not found")

        retrieval_results = execute_multi_hop_associative_search(
            self.duckdb_readonly_connection,
            target_image_identifier=arbitrary_image_id,
            maximum_results_limit=maximum_limit
        )

        # Invariant 1: Must always return a list
        self.assertIsInstance(retrieval_results, list)

        # Invariant 2: If matches are found, resonance scores must be descending
        if len(retrieval_results) > 1:
            extracted_scores_list = [r["resonance_score"] for r in retrieval_results]
            self.assertEqual(extracted_scores_list, sorted(extracted_scores_list, reverse=True))

    # =========================================================================
    # PROPERTY 3: CHAOTIC CLUSTER BRIDGING BOUNDARIES
    # =========================================================================
    # WHAT: Fuzzes cluster bridge queries with random integer pairs.
    # WHY:  Proves cluster bridging logic returns structured dictionaries without DuckDB query panics.
    @given(
        st.integers(min_value=-1000, max_value=5000),
        st.integers(min_value=-1000, max_value=5000),
        st.integers(min_value=1, max_value=30)
    )
    @settings(max_examples=100)
    def test_fuzz_cluster_bridges_boundary_coordinates(self, cluster_alpha_integer, cluster_beta_integer, results_limit):
        if not self.duckdb_readonly_connection:
            self.skipTest("graph_memory.duckdb not found")

        bridges_result_dictionary = find_bridges_between_clusters(
            self.duckdb_readonly_connection,
            first_cluster_label=cluster_alpha_integer,
            second_cluster_label=cluster_beta_integer,
            maximum_bridge_results_limit=results_limit
        )

        # Invariant: Must return dictionary with declared schema
        self.assertIn("first_cluster_label", bridges_result_dictionary)
        self.assertIn("second_cluster_label", bridges_result_dictionary)
        self.assertIn("bridging_concepts", bridges_result_dictionary)
        self.assertIsInstance(bridges_result_dictionary["bridging_concepts"], list)


if __name__ == "__main__":
    unittest.main()
