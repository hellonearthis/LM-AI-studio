"""
===============================================================================
LUMINA STUDIO - GRAPHMEMORY ASSOCIATIVE RETRIEVAL ENGINE
===============================================================================

WHAT: Multi-hop associative retrieval engine powered by DuckDB GraphMemory
      and NetworkX graph analytics.

WHY:  Standard vector retrieval only performs direct 1-to-1 cosine nearest-neighbor
      matching. Associative retrieval traverses the knowledge graph across
      multiple hops:
      1. Image -> Tags, Facets, and EVoC Cluster Topics -> Neighboring Images.
      2. Computes associative resonance scores based on shared conceptual density.
      3. Extracts subgraphs for interactive visual inspection of semantic relationships.
      4. Detects cluster bridges: concepts and images that connect distant thematic clusters.

PROTOCOL COMPLIANCE:
1. "can_be_long" Protocol: Descriptive, semantically unambiguous identifier names.
2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
3. Pure Functional Transformations: Pure query parameterization and result projection.
===============================================================================
"""

import os
import sys
import json
import time
import uuid
import argparse
from typing import Dict, List, Any, Optional
import duckdb

# Reconfigure standard output encoding for clean console reporting
sys.stdout.reconfigure(encoding="utf-8")

# Canonical namespace matching build_graph_memory.py
LUMINA_STUDIO_GRAPH_NAMESPACE_UUID = uuid.uuid5(uuid.NAMESPACE_DNS, "lumina.studio.graphmemory")
DEFAULT_GRAPH_MEMORY_DATABASE_PATH = "graph_memory.duckdb"


def compute_deterministic_image_uuid(image_numerical_identifier: int) -> str:
    """
    WHAT: Derives the deterministic UUID string for a given numeric image ID.
    WHY:  Matches the exact node UUID generation logic used during graph construction.
    """
    unique_composite_string_key = f"image:{str(image_numerical_identifier).strip().lower()}"
    return str(uuid.uuid5(LUMINA_STUDIO_GRAPH_NAMESPACE_UUID, unique_composite_string_key))


def compute_deterministic_topic_uuid(cluster_label_integer: int) -> str:
    """
    WHAT: Derives the deterministic UUID string for a given EVoC cluster label.
    WHY:  Enables direct lookup of cluster topic nodes in DuckDB GraphMemory.
    """
    unique_composite_string_key = f"topic:{str(cluster_label_integer).strip().lower()}"
    return str(uuid.uuid5(LUMINA_STUDIO_GRAPH_NAMESPACE_UUID, unique_composite_string_key))


def execute_multi_hop_associative_search(
    duckdb_connection_instance: duckdb.DuckDBPyConnection,
    target_image_identifier: int,
    maximum_results_limit: int = 24
) -> List[Dict[str, Any]]:
    """
    WHAT: Queries the DuckDB knowledge graph for images sharing high associative resonance.
    WHY:  Traverses from target image -> connected concepts -> neighbor images sharing those concepts.
          Weights edges (topics: 1.2, tags: 1.0, facets: 0.8) to rank conceptually resonant images.
    """
    target_image_uuid_string = compute_deterministic_image_uuid(target_image_identifier)

    associative_retrieval_sql_query = """
        SELECT 
            candidate_edge.source_id AS neighbor_image_uuid,
            COUNT(DISTINCT source_edge.target_id) AS shared_concepts_count,
            SUM(source_edge.weight * candidate_edge.weight) AS associative_resonance_score,
            candidate_node.properties AS candidate_image_properties_json,
            LIST(DISTINCT COALESCE(
                concept_node.properties->>'name',
                concept_node.properties->>'value',
                concept_node.properties->>'title'
            )) AS shared_concept_names_list
        FROM edges source_edge
        JOIN edges candidate_edge 
          ON source_edge.target_id = candidate_edge.target_id 
         AND source_edge.source_id != candidate_edge.source_id
        JOIN nodes candidate_node 
          ON candidate_edge.source_id = candidate_node.id
        JOIN nodes concept_node 
          ON source_edge.target_id = concept_node.id
        WHERE source_edge.source_id = ?::UUID
          AND candidate_node.type = 'Image'
        GROUP BY candidate_edge.source_id, candidate_node.properties
        ORDER BY associative_resonance_score DESC, shared_concepts_count DESC
        LIMIT ?
    """

    raw_query_results = duckdb_connection_instance.execute(
        associative_retrieval_sql_query,
        [target_image_uuid_string, maximum_results_limit]
    ).fetchall()

    transformed_results_collection: List[Dict[str, Any]] = []
    for (
        neighbor_image_uuid,
        shared_concepts_count,
        associative_resonance_score,
        candidate_image_properties_json,
        shared_concept_names_list
    ) in raw_query_results:
        parsed_properties_dictionary = json.loads(candidate_image_properties_json)
        transformed_results_collection.append({
            "image_id": parsed_properties_dictionary.get("image_id"),
            "filename": parsed_properties_dictionary.get("filename"),
            "path": parsed_properties_dictionary.get("path"),
            "summary": parsed_properties_dictionary.get("summary"),
            "cluster_label": parsed_properties_dictionary.get("cluster_label"),
            "resonance_score": round(float(associative_resonance_score), 3),
            "shared_concepts_count": int(shared_concepts_count),
            "shared_concepts": shared_concept_names_list
        })

    return transformed_results_collection


def extract_entity_neighborhood_subgraph(
    duckdb_connection_instance: duckdb.DuckDBPyConnection,
    center_image_identifier: int,
    maximum_neighbors_per_concept: int = 5
) -> Dict[str, Any]:
    """
    WHAT: Extracts an ego-network subgraph around a target image for visual inspection.
    WHY:  Returns nodes (Image, Topics, Tags, Facets) and directed edges formatted for D3/canvas graphs.
    """
    center_image_uuid_string = compute_deterministic_image_uuid(center_image_identifier)

    # 1. Fetch center image node
    center_node_row = duckdb_connection_instance.execute(
        "SELECT id, type, properties FROM nodes WHERE id = ?::UUID",
        [center_image_uuid_string]
    ).fetchone()

    if not center_node_row:
        return {"nodes": [], "edges": []}

    subgraph_nodes_dictionary: Dict[str, Dict[str, Any]] = {}
    subgraph_edges_collection: List[Dict[str, Any]] = []

    subgraph_nodes_dictionary[str(center_node_row[0])] = {
        "id": str(center_node_row[0]),
        "type": center_node_row[1],
        "properties": json.loads(center_node_row[2]),
        "is_center": True
    }

    # 2. Fetch directly connected concept nodes
    direct_concepts_rows = duckdb_connection_instance.execute(
        """
        SELECT 
            edges.id AS edge_id,
            edges.relation,
            edges.weight,
            nodes.id AS concept_id,
            nodes.type AS concept_type,
            nodes.properties AS concept_properties
        FROM edges
        JOIN nodes ON edges.target_id = nodes.id
        WHERE edges.source_id = ?::UUID
        """,
        [center_image_uuid_string]
    ).fetchall()

    for edge_id, relation_string, edge_weight, concept_id, concept_type, concept_props_json in direct_concepts_rows:
        concept_uuid_string = str(concept_id)
        if concept_uuid_string not in subgraph_nodes_dictionary:
            subgraph_nodes_dictionary[concept_uuid_string] = {
                "id": concept_uuid_string,
                "type": concept_type,
                "properties": json.loads(concept_props_json),
                "is_center": False
            }

        subgraph_edges_collection.append({
            "id": str(edge_id),
            "source": center_image_uuid_string,
            "target": concept_uuid_string,
            "relation": relation_string,
            "weight": float(edge_weight)
        })

        # 3. For each concept, fetch up to maximum_neighbors_per_concept peer images
        peer_images_rows = duckdb_connection_instance.execute(
            """
            SELECT 
                edges.id AS edge_id,
                edges.relation,
                edges.weight,
                nodes.id AS peer_image_id,
                nodes.properties AS peer_image_properties
            FROM edges
            JOIN nodes ON edges.source_id = nodes.id
            WHERE edges.target_id = ?::UUID
              AND edges.source_id != ?::UUID
              AND nodes.type = 'Image'
            LIMIT ?
            """,
            [concept_uuid_string, center_image_uuid_string, maximum_neighbors_per_concept]
        ).fetchall()

        for peer_edge_id, peer_relation, peer_weight, peer_image_id, peer_props_json in peer_images_rows:
            peer_uuid_string = str(peer_image_id)
            if peer_uuid_string not in subgraph_nodes_dictionary:
                subgraph_nodes_dictionary[peer_uuid_string] = {
                    "id": peer_uuid_string,
                    "type": "Image",
                    "properties": json.loads(peer_props_json),
                    "is_center": False
                }

            subgraph_edges_collection.append({
                "id": str(peer_edge_id),
                "source": peer_uuid_string,
                "target": concept_uuid_string,
                "relation": peer_relation,
                "weight": float(peer_weight)
            })

    return {
        "nodes": list(subgraph_nodes_dictionary.values()),
        "edges": subgraph_edges_collection
    }


def find_bridges_between_clusters(
    duckdb_connection_instance: duckdb.DuckDBPyConnection,
    first_cluster_label: int,
    second_cluster_label: int,
    maximum_bridge_results_limit: int = 15
) -> Dict[str, Any]:
    """
    WHAT: Identifies shared tags, facets, and bridge images linking two distinct visual clusters.
    WHY:  Helps users understand transitional visual themes that span across different EVoC clusters.
    """
    first_topic_uuid_string = compute_deterministic_topic_uuid(first_cluster_label)
    second_topic_uuid_string = compute_deterministic_topic_uuid(second_cluster_label)

    # Find shared concept nodes connected to images from both clusters
    shared_bridging_concepts_sql = """
        SELECT 
            concept_node.id AS concept_uuid,
            concept_node.type AS concept_type,
            concept_node.properties AS concept_properties_json,
            COUNT(DISTINCT first_image_edge.source_id) AS first_cluster_image_count,
            COUNT(DISTINCT second_image_edge.source_id) AS second_cluster_image_count
        FROM edges first_topic_edge
        JOIN edges first_image_edge ON first_topic_edge.source_id = first_image_edge.source_id
        JOIN nodes concept_node ON first_image_edge.target_id = concept_node.id
        JOIN edges second_image_edge ON concept_node.id = second_image_edge.target_id
        JOIN edges second_topic_edge ON second_image_edge.source_id = second_topic_edge.source_id
        WHERE first_topic_edge.target_id = ?::UUID
          AND second_topic_edge.target_id = ?::UUID
          AND concept_node.type IN ('Tag', 'Facet')
        GROUP BY concept_node.id, concept_node.type, concept_node.properties
        ORDER BY (COUNT(DISTINCT first_image_edge.source_id) + COUNT(DISTINCT second_image_edge.source_id)) DESC
        LIMIT ?
    """

    bridging_concept_rows = duckdb_connection_instance.execute(
        shared_bridging_concepts_sql,
        [first_topic_uuid_string, second_topic_uuid_string, maximum_bridge_results_limit]
    ).fetchall()

    bridging_concepts_collection = []
    for concept_uuid, concept_type, props_json, count1, count2 in bridging_concept_rows:
        parsed_props = json.loads(props_json)
        display_label = parsed_props.get("name") or parsed_props.get("value") or str(concept_uuid)
        bridging_concepts_collection.append({
            "concept_type": concept_type,
            "label": display_label,
            "first_cluster_occurrences": count1,
            "second_cluster_occurrences": count2
        })

    return {
        "first_cluster_label": first_cluster_label,
        "second_cluster_label": second_cluster_label,
        "bridging_concepts": bridging_concepts_collection
    }


def parse_command_line_arguments() -> argparse.Namespace:
    """
    WHAT: Configures command-line options for associative search and analysis tasks.
    WHY:  Provides clean programmatic invocation from Node.js child processes and terminal workflows.
    """
    argument_parser = argparse.ArgumentParser(
        description="Lumina Studio GraphMemory Multi-Hop Associative Retrieval CLI"
    )
    argument_parser.add_argument(
        "--database",
        type=str,
        default=DEFAULT_GRAPH_MEMORY_DATABASE_PATH,
        help="Path to the graph_memory.duckdb database file."
    )
    argument_parser.add_argument(
        "--image",
        type=int,
        help="Primary numerical image ID to find associative neighbors for."
    )
    argument_parser.add_argument(
        "--subgraph",
        type=int,
        help="Primary numerical image ID to extract an interactive neighborhood subgraph for."
    )
    argument_parser.add_argument(
        "--bridges",
        nargs=2,
        type=int,
        metavar=("CLUSTER_A", "CLUSTER_B"),
        help="Find bridging concepts connecting two distinct EVoC cluster numbers."
    )
    argument_parser.add_argument(
        "--limit",
        type=int,
        default=24,
        help="Maximum results limit for associative neighbors."
    )
    return argument_parser.parse_args()


def main() -> None:
    """
    WHAT: Main CLI entrypoint parsing arguments, executing queries, and streaming JSON to stdout.
    WHY:  Allows seamless piping into Node.js server endpoints and test harnesses.
    """
    command_arguments = parse_command_line_arguments()

    if not os.path.exists(command_arguments.database):
        error_payload = {
            "error": f"GraphMemory database not found at: {command_arguments.database}. Please run scripts/build_graph_memory.py first."
        }
        print(json.dumps(error_payload))
        sys.exit(1)

    duckdb_connection_instance = duckdb.connect(command_arguments.database, read_only=True)

    try:
        if command_arguments.image is not None:
            retrieval_results = execute_multi_hop_associative_search(
                duckdb_connection_instance,
                command_arguments.image,
                command_arguments.limit
            )
            print(json.dumps({
                "target_image_id": command_arguments.image,
                "total_results": len(retrieval_results),
                "associative_neighbors": retrieval_results
            }, ensure_ascii=False, indent=2))

        elif command_arguments.subgraph is not None:
            subgraph_result = extract_entity_neighborhood_subgraph(
                duckdb_connection_instance,
                command_arguments.subgraph
            )
            print(json.dumps(subgraph_result, ensure_ascii=False, indent=2))

        elif command_arguments.bridges is not None:
            first_cluster_label, second_cluster_label = command_arguments.bridges
            bridges_result = find_bridges_between_clusters(
                duckdb_connection_instance,
                first_cluster_label,
                second_cluster_label,
                command_arguments.limit
            )
            print(json.dumps(bridges_result, ensure_ascii=False, indent=2))

        else:
            print(json.dumps({
                "error": "No action specified. Please provide --image <id>, --subgraph <id>, or --bridges <c1> <c2>."
            }))
            sys.exit(1)

    finally:
        duckdb_connection_instance.close()


if __name__ == "__main__":
    main()

