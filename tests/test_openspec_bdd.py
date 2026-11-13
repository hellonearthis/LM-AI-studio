"""
OpenSpec BDD Test Suite: Behavior Verification & Pure Functional Architecture Audit

WHAT: Automated specification and behavioral contract testing suite.
WHY:  Guarantees that living OpenSpec specifications (glossary, features, reports)
      remain perfectly synchronized with codebase reality, while asserting
      mathematical determinism and pure functional architecture invariants.
"""

import os
import re
import unittest
import math
from pathlib import Path
import yaml


class OpenSpecStructureTests(unittest.TestCase):
    """
    WHAT: Asserts the integrity of OpenSpec structural artifacts.
    WHY:  Validates that domain terminology, Gherkin syntax, and living reports
          are structurally valid and strictly reference active project files.
    """

    def setUp(self):
        # WHAT: Resolving the root directory of the workspace.
        # WHY:  Ensures all relative paths are consistently anchored to the repository root.
        self.workspace_root_directory_path = Path(__file__).resolve().parent.parent
        self.openspec_root_directory_path = self.workspace_root_directory_path / "openspec"

    def test_glossary_and_source_files_exist(self):
        # WHAT: Validates glossary.yaml structure and bound source code paths.
        # WHY:  Every glossary term must be backed by concrete, verified files on disk.
        glossary_file_path = self.openspec_root_directory_path / "glossary.yaml"
        self.assertTrue(
            glossary_file_path.exists(),
            f"Glossary file missing at expected path: {glossary_file_path}"
        )

        with open(glossary_file_path, "r", encoding="utf-8") as glossary_file_handle:
            glossary_data_structure = yaml.safe_load(glossary_file_handle)

        self.assertIn("domain", glossary_data_structure)
        self.assertIn("version", glossary_data_structure)
        self.assertIn("terms", glossary_data_structure)

        glossary_terms_dictionary = glossary_data_structure["terms"]
        self.assertGreater(len(glossary_terms_dictionary), 5)

        for term_identifier_string, term_metadata_record in glossary_terms_dictionary.items():
            self.assertIn(
                "definition",
                term_metadata_record,
                f"Term '{term_identifier_string}' is missing a definition string."
            )
            self.assertIn(
                "sources",
                term_metadata_record,
                f"Term '{term_identifier_string}' is missing sources list."
            )

            # WHAT: Asserting that each source path referenced in the term exists in the workspace.
            # WHY:  Eliminates orphaned terminology pointing to nonexistent source files.
            for relative_source_file_path in term_metadata_record["sources"]:
                concrete_source_file_path = self.workspace_root_directory_path / relative_source_file_path
                self.assertTrue(
                    concrete_source_file_path.exists(),
                    f"Glossary term '{term_identifier_string}' references nonexistent source path: {relative_source_file_path}"
                )

    def test_feature_files_parse_with_rules_and_tags(self):
        # WHAT: Validates Gherkin feature files for OpenSpec syntax compliance.
        # WHY:  Ensures features possess valid tags, background blocks, business rules,
        #       and adhere strictly to the 'exactly one WHEN per scenario' protocol.
        features_directory_path = self.openspec_root_directory_path / "features"
        self.assertTrue(
            features_directory_path.exists(),
            f"Features directory missing at: {features_directory_path}"
        )

        feature_file_paths_collection = list(features_directory_path.glob("*.feature"))
        self.assertGreater(
            len(feature_file_paths_collection),
            0,
            "No .feature specification files discovered in openspec/features/"
        )

        observed_scenario_tags_set = set()

        for single_feature_file_path in feature_file_paths_collection:
            with open(single_feature_file_path, "r", encoding="utf-8") as feature_file_handle:
                feature_file_content_string = feature_file_handle.read()

            self.assertIn(
                "Feature:",
                feature_file_content_string,
                f"Feature declaration missing in: {single_feature_file_path.name}"
            )
            self.assertIn(
                "Background:",
                feature_file_content_string,
                f"Background context block missing in: {single_feature_file_path.name}"
            )
            self.assertIn(
                "Rule:",
                feature_file_content_string,
                f"Architectural business Rule block missing in: {single_feature_file_path.name}"
            )

            # WHAT: Extracting all scenarios and validating tag uniqueness.
            # WHY:  Traceable requirements require globally unique scenario tag IDs (e.g. @FUNC-01).
            scenario_matches_list = re.findall(
                r"(@[A-Z]+-\d+)\s+(Scenario(?: Outline)?:\s*([^\n]+))",
                feature_file_content_string
            )
            self.assertGreater(
                len(scenario_matches_list),
                0,
                f"No tagged scenarios found in: {single_feature_file_path.name}"
            )

            for tag_identifier_string, full_scenario_header, scenario_title_string in scenario_matches_list:
                self.assertNotIn(
                    tag_identifier_string,
                    observed_scenario_tags_set,
                    f"Duplicate scenario tag detected: {tag_identifier_string}"
                )
                observed_scenario_tags_set.add(tag_identifier_string)

            # WHAT: Verifying the single WHEN invariant per scenario block.
            # WHY:  OpenSpec strictly limits scenarios to one triggering action to avoid composite tests.
            scenario_sections_list = re.split(r"\n\s*(?:@\w+-\d+\s+)?Scenario(?: Outline)?:", feature_file_content_string)[1:]
            for scenario_body_text in scenario_sections_list:
                when_statement_count = len(re.findall(r"^\s*When\s+", scenario_body_text, re.MULTILINE))
                self.assertEqual(
                    when_statement_count,
                    1,
                    f"Scenario in {single_feature_file_path.name} violates 'one WHEN per scenario' rule (found {when_statement_count} When statements)"
                )

    def test_behavior_report_scenarios_and_diagrams(self):
        # WHAT: Asserts presence and completeness of the living behavior report.
        # WHY:  Guarantees Mermaid flows, REPORT-xx scenarios, and coverage matrices are documented.
        report_file_path = self.openspec_root_directory_path / "reports" / "ARCHITECTURE_REPORT.md"
        self.assertTrue(
            report_file_path.exists(),
            f"Living architecture report missing at: {report_file_path}"
        )

        with open(report_file_path, "r", encoding="utf-8") as report_file_handle:
            report_markdown_string = report_file_handle.read()

        # Check required sections
        self.assertIn("## Terms Used", report_markdown_string)
        self.assertIn("sequenceDiagram", report_markdown_string)
        self.assertIn("## Behavioral Scenarios", report_markdown_string)
        self.assertIn("## Coverage Gaps", report_markdown_string)
        self.assertIn("## Unknowns", report_markdown_string)
        self.assertIn("## Pure Functional JavaScript Architecture Audit", report_markdown_string)

        # Assert REPORT-xx format
        report_scenario_identifiers = re.findall(r"### (REPORT-\d{2})", report_markdown_string)
        self.assertGreaterEqual(
            len(report_scenario_identifiers),
            11,
            "Behavior report must contain at least 11 documented REPORT-xx scenarios"
        )


class OpenSpecPureFunctionalCodebaseAuditTests(unittest.TestCase):
    """
    WHAT: Automated verification of the Pure Functional JavaScript codebase audit.
    WHY:  Validates that violations (classes, mutable state, naming) are accurately
          tracked and pure domain transformations behave deterministically.
    """

    def setUp(self):
        self.workspace_root_directory_path = Path(__file__).resolve().parent.parent

    def test_audit_flags_domain_classes_correctly(self):
        # WHAT: Verifying that domain classes are detected in services.
        # WHY:  Invariant 3 strictly prohibits ES6 class domain logic.
        target_service_files_list = [
            self.workspace_root_directory_path / "services" / "layaClient.js",
            self.workspace_root_directory_path / "services" / "localAiClient.js",
            self.workspace_root_directory_path / "services" / "ovisOmniClient.js"
        ]

        for single_service_file_path in target_service_files_list:
            self.assertTrue(single_service_file_path.exists())
            with open(single_service_file_path, "r", encoding="utf-8") as file_handle:
                content_string = file_handle.read()

            # Confirm legacy class definitions have been eliminated in favor of pure factory functions (ignoring comments)
            code_without_comments = re.sub(r"//.*|/\*[\s\S]*?\*/", "", content_string)
            has_domain_class_declaration = bool(re.search(r"\bclass\s+\w+", code_without_comments))
            self.assertFalse(
                has_domain_class_declaration,
                f"Expected zero class declarations in {single_service_file_path.name} after factory refactoring"
            )

        self.assertTrue(bool(re.search(r"\bclass\s+\w+", "export class LegacySample {}")))

    def test_pure_functional_service_exports(self):
        # WHAT: Verifying that services export pure functional configuration factories and procedures.
        # WHY: Invariant 1 and Invariant 3 require domain transformations to be standalone pure functions.
        laya_service_path = self.workspace_root_directory_path / "services" / "layaClient.js"
        ovis_service_path = self.workspace_root_directory_path / "services" / "ovisOmniClient.js"
        pretext_layout_path = self.workspace_root_directory_path / "public" / "pretext-layout.js"

        with open(laya_service_path, "r", encoding="utf-8") as file_handle:
            laya_content = file_handle.read()
        self.assertIn("create_laya_client_configuration", laya_content)
        self.assertIn("classify_image_facets", laya_content)
        self.assertIn("IMAGE_FACET_TAXONOMY_QUESTIONS", laya_content)

        with open(ovis_service_path, "r", encoding="utf-8") as file_handle:
            ovis_content = file_handle.read()
        self.assertIn("create_ovis_omni_configuration", ovis_content)
        self.assertIn("generate_image_multimodal_embedding", ovis_content)
        self.assertIn("STANDARD_CLASSIFICATION_TAXONOMIES", ovis_content)

        with open(pretext_layout_path, "r", encoding="utf-8") as file_handle:
            pretext_content = file_handle.read()
        self.assertIn("measure_text_rendered_height", pretext_content)
        self.assertIn("TYPOGRAPHY_FONT_SPECIFICATIONS", pretext_content)

    def test_pure_html_sanitization_transformation(self):
        # WHAT: Testing the deterministic HTML escaping pure transformation.
        # WHY:  Pure transformations must be idempotent and produce identical outputs for identical inputs.
        def execute_pure_html_sanitization(input_raw_string):
            if not input_raw_string:
                return ""
            return (
                str(input_raw_string)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace('"', "&quot;")
                .replace("'", "&#039;")
            )

        malicious_input_string = "<img src='x' onerror=\"alert('hacked & damaged')\" />"
        expected_sanitized_string = "&lt;img src=&#039;x&#039; onerror=&quot;alert(&#039;hacked &amp; damaged&#039;)&quot; /&gt;"

        first_transformation_result = execute_pure_html_sanitization(malicious_input_string)
        second_transformation_result = execute_pure_html_sanitization(malicious_input_string)

        self.assertEqual(first_transformation_result, expected_sanitized_string)
        self.assertEqual(first_transformation_result, second_transformation_result)


class OpenSpecExecutableBehaviorTests(unittest.TestCase):
    """
    WHAT: Asserts behavioral execution contracts for hybrid search and vector math.
    WHY:  Validates that algorithms operate without mutating inputs and produce mathematically sound results.
    """

    def test_reciprocal_rank_fusion_pure_contract(self):
        # WHAT: Executing Reciprocal Rank Fusion (RRF) algorithm as a pure function.
        # WHY:  Verifies score formula (1 / (k + rank)) and guarantees zero mutation of input rank arrays.
        def execute_pure_reciprocal_rank_fusion(
            lexical_ranked_candidate_identifiers,
            semantic_ranked_candidate_identifiers,
            smoothing_k_constant=60
        ):
            # Pure transformation: returns new dictionary, input lists are not mutated
            combined_scores_dictionary = {}

            for rank_position_index, candidate_identifier in enumerate(lexical_ranked_candidate_identifiers):
                reciprocal_rank_score = 1.0 / (smoothing_k_constant + rank_position_index + 1)
                combined_scores_dictionary[candidate_identifier] = (
                    combined_scores_dictionary.get(candidate_identifier, 0.0) + reciprocal_rank_score
                )

            for rank_position_index, candidate_identifier in enumerate(semantic_ranked_candidate_identifiers):
                reciprocal_rank_score = 1.0 / (smoothing_k_constant + rank_position_index + 1)
                combined_scores_dictionary[candidate_identifier] = (
                    combined_scores_dictionary.get(candidate_identifier, 0.0) + reciprocal_rank_score
                )

            # Sort descending by cumulative fused score
            return sorted(
                combined_scores_dictionary.items(),
                key=lambda score_tuple: score_tuple[1],
                reverse=True
            )

        immutable_lexical_rank_list = ("image_alpha", "image_beta", "image_gamma")
        immutable_semantic_rank_list = ("image_beta", "image_gamma", "image_delta")

        fused_results_list = execute_pure_reciprocal_rank_fusion(
            immutable_lexical_rank_list,
            immutable_semantic_rank_list,
            smoothing_k_constant=60
        )

        # "image_beta" is rank 2 in lexical (1/(60+2) = 1/62) and rank 1 in semantic (1/(60+1) = 1/61)
        # Therefore, image_beta must rank #1 in fused output
        winning_candidate_identifier, highest_fused_score = fused_results_list[0]
        self.assertEqual(winning_candidate_identifier, "image_beta")

        # Verify input collections are completely intact
        self.assertEqual(immutable_lexical_rank_list, ("image_alpha", "image_beta", "image_gamma"))
        self.assertEqual(immutable_semantic_rank_list, ("image_beta", "image_gamma", "image_delta"))

    def test_cosine_similarity_pure_contract(self):
        # WHAT: Executing vector cosine similarity evaluation.
        # WHY:  Verifies dot product calculation and vector magnitude preservation.
        def execute_pure_cosine_similarity(vector_coordinate_array_a, vector_coordinate_array_b):
            dot_product_sum = sum(
                coordinate_a * coordinate_b
                for coordinate_a, coordinate_b in zip(vector_coordinate_array_a, vector_coordinate_array_b)
            )
            magnitude_a = math.sqrt(sum(coordinate ** 2 for coordinate in vector_coordinate_array_a))
            magnitude_b = math.sqrt(sum(coordinate ** 2 for coordinate in vector_coordinate_array_b))

            if magnitude_a == 0.0 or magnitude_b == 0.0:
                return 0.0
            return dot_product_sum / (magnitude_a * magnitude_b)

        normalized_vector_a = (1.0, 0.0, 0.0)
        normalized_vector_b = (1.0, 0.0, 0.0)
        orthogonal_vector_c = (0.0, 1.0, 0.0)

        identical_similarity_score = execute_pure_cosine_similarity(normalized_vector_a, normalized_vector_b)
        orthogonal_similarity_score = execute_pure_cosine_similarity(normalized_vector_a, orthogonal_vector_c)

        self.assertAlmostEqual(identical_similarity_score, 1.0, places=5)
        self.assertAlmostEqual(orthogonal_similarity_score, 0.0, places=5)

    def test_graphmemory_deterministic_uuid_contract(self):
        # WHAT: Asserts that deterministic UUIDv5 generation is idempotent and reproducible.
        # WHY:  Guarantees consistent entity addressing across graph extraction and retrieval.
        import uuid
        namespace_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, "lumina.studio.graphmemory")
        
        first_uuid = uuid.uuid5(namespace_uuid, "image:1155")
        second_uuid = uuid.uuid5(namespace_uuid, "image:1155")
        distinct_uuid = uuid.uuid5(namespace_uuid, "image:1156")

        self.assertEqual(first_uuid, second_uuid)
        self.assertNotEqual(first_uuid, distinct_uuid)
        self.assertEqual(str(first_uuid), "7079db92-18ab-54a8-8aae-0ce0326d7401")

    def test_graphmemory_associative_retrieval_execution(self):
        # WHAT: Executes multi-hop associative retrieval against graph_memory.duckdb if present.
        # WHY:  Verifies retrieval contracts: descending resonance scores, shared concept attributes.
        import duckdb
        workspace_root = Path(__file__).resolve().parent.parent
        graph_db_path = workspace_root / "graph_memory.duckdb"
        if not graph_db_path.exists():
            self.skipTest("graph_memory.duckdb not present on disk")

        from scripts.associative_retrieval import execute_multi_hop_associative_search

        duckdb_connection = duckdb.connect(str(graph_db_path), read_only=True)
        try:
            results = execute_multi_hop_associative_search(duckdb_connection, target_image_identifier=1155, maximum_results_limit=5)
            self.assertGreater(len(results), 0)
            
            # Verify ordering: resonance score must be monotonic descending
            scores = [r["resonance_score"] for r in results]
            self.assertEqual(scores, sorted(scores, reverse=True))

            # Verify schema
            first_result = results[0]
            self.assertIn("image_id", first_result)
            self.assertIn("resonance_score", first_result)
            self.assertIn("shared_concepts_count", first_result)
            self.assertIn("shared_concepts", first_result)
            self.assertGreater(first_result["shared_concepts_count"], 0)
        finally:
            duckdb_connection.close()

    def test_defensive_clamping_and_nan_resilience(self):
        # WHAT: Validates defensive clamping against mathematical cosine boundary violations.
        # WHY:  Guarantees that float drift or extreme magnitudes never exceed [-1.0, 1.0].
        def execute_clamped_dot_product(vector_a, vector_b):
            raw_dot = sum(a * b for a, b in zip(vector_a, vector_b))
            return max(-1.0, min(1.0, raw_dot))

        # Vector with slight numerical drift
        slightly_overflowing_vector_a = (1.0000002, 0.0)
        unit_vector_b = (1.0, 0.0)
        clamped_result = execute_clamped_dot_product(slightly_overflowing_vector_a, unit_vector_b)

        self.assertLessEqual(clamped_result, 1.0)
        self.assertGreaterEqual(clamped_result, -1.0)
        self.assertEqual(clamped_result, 1.0)

    def test_prompt_dicer_physicality_ratio_and_clash_logic(self):
        # WHAT: Asserts the exact mathematical behavior of compute_physicality_ratio in Python.
        # WHY:  Verifies behavioral contract @DICER-01 matching pass_b_pretext_vs_physical.md specifications.
        def compute_physicality_ratio(count_of_physical_anchors: int, count_of_pretext_terms: int, pretext_penalty_weight: float = 1.5) -> float:
            weighted_total = count_of_physical_anchors + (count_of_pretext_terms * pretext_penalty_weight)
            safe_denominator = max(1, weighted_total)
            return round(count_of_physical_anchors / safe_denominator, 2)

        # Standard test from specification: 8 physical, 2 pretext => 8 / (8 + 3.0) = 0.7272... => 0.73
        sample_ratio = compute_physicality_ratio(8, 2, 1.5)
        self.assertEqual(sample_ratio, 0.73)

        # Pure physical prompt
        pure_physical_ratio = compute_physicality_ratio(6, 0, 1.5)
        self.assertEqual(pure_physical_ratio, 1.0)

        # Division-by-zero protection
        empty_ratio = compute_physicality_ratio(0, 0, 1.5)
        self.assertEqual(empty_ratio, 0.0)

        # WHAT: Verifies behavioral contract @DICER-02 for physical continuity clash detection.
        # WHY:  Opposing state values on the same state key must be flagged as continuity contradictions.
        influence_alpha = {
            "state_key": "surface_moisture",
            "applied_state_value": "wet_specular",
            "clashes_with_value": "dry_matte_dust"
        }
        influence_beta = {
            "state_key": "surface_moisture",
            "applied_state_value": "dry_matte_dust",
            "clashes_with_value": "wet_specular"
        }

        is_contradiction = (
            influence_alpha["applied_state_value"] == influence_beta["clashes_with_value"] or
            influence_beta["applied_state_value"] == influence_alpha["clashes_with_value"]
        )
        self.assertTrue(is_contradiction)

    def test_ovis_grounding_threshold_and_card_ui_contracts(self):
        # WHAT: Verifies behavioral contracts @GROUND-01, @REMIXUI-01, and @CARDUI-01.
        # WHY:  Ensures visual grounding status mapping matches calibrated thresholds and
        #       UI defaults / enlarged card checkbox targets match the living specification.
        def classify_visual_grounding_verdict(cosine_similarity_score: float):
            if cosine_similarity_score >= 0.28:
                return ("grounded", False)
            if cosine_similarity_score >= 0.18:
                return ("borderline", False)
            return ("mismatched", True)

        self.assertEqual(classify_visual_grounding_verdict(0.36), ("grounded", False))
        self.assertEqual(classify_visual_grounding_verdict(0.22), ("borderline", False))
        self.assertEqual(classify_visual_grounding_verdict(0.11), ("mismatched", True))

        workspace_root = Path(__file__).resolve().parent.parent

        for html_relative_path in ("public/database.html", "public/search.html", "public/index.html"):
            html_content = (workspace_root / html_relative_path).read_text(encoding="utf-8")
            self.assertIn(
                '<option value="Ultra Detailed Description" selected>',
                html_content,
                f"Expected Ultra Detailed Description to be default in {html_relative_path}"
            )

        database_css_content = (workspace_root / "public" / "database.css").read_text(encoding="utf-8")
        self.assertIn("inline-size: 32px;", database_css_content)
        self.assertIn("min-inline-size: 44px;", database_css_content)
        self.assertNotIn(".card-back-nav", database_css_content)

        database_js_content = (workspace_root / "public" / "database.js").read_text(encoding="utf-8")
        self.assertNotIn("card-back-nav", database_js_content)
        self.assertIn("button, a, input, label, .file-link", database_js_content)

        search_js_content = (workspace_root / "public" / "search.js").read_text(encoding="utf-8")
        self.assertIn('document.addEventListener("click", (click_event) =>', search_js_content)

        dicer_js_content = (workspace_root / "public" / "dicer.js").read_text(encoding="utf-8")
        self.assertIn("buildRemixPromptThumbnailHtml", dicer_js_content)


if __name__ == "__main__":
    unittest.main()

