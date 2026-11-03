"""
===============================================================================
LUMINA STUDIO - GRAPHMEMORY KNOWLEDGE GRAPH BUILDER PIPELINE
===============================================================================

WHAT: Ingests multimodal image records, EVoC cluster topics, artistic facets,
      and semantic 768-dimensional vector embeddings from images.db and
      public/search-embeddings.json into an embedded DuckDB GraphMemory database
      (graph_memory.duckdb).

WHY:  Standard vector retrieval only performs direct 1-to-1 cosine nearest-neighbor
      matching. By lifting images, semantic clusters, descriptive tags, and
      aesthetic facets into a typed heterogeneous Knowledge Graph:
      1. Multi-hop associative retrieval traverses from an image to its semantic
         topics, artistic facets, and related tags.
      2. Graph analytics (Personalized PageRank) uncover resonant visual relationships
         across different clusters that share underlying artistic or conceptual DNA.
      3. Cluster bridge exploration identifies intermediate concepts linking distant
         thematic regions of the latent space.

PROTOCOL COMPLIANCE:
1. "can_be_long" Protocol: Descriptive, semantically unambiguous identifier names.
2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
3. Pure Functional Transformations: Isolated data extraction and batch construction.
===============================================================================
"""

import os
import sys
import time
import json
import uuid
import sqlite3
from typing import Dict, List, Tuple, Any, Set
from collections import Counter
import pyarrow as pa
from graphmemory import GraphMemory

# Reconfigure standard output encoding for clean console reporting
sys.stdout.reconfigure(encoding="utf-8")

# Canonical namespace for deterministic, idempotent UUID generation
LUMINA_STUDIO_GRAPH_NAMESPACE_UUID = uuid.uuid5(uuid.NAMESPACE_DNS, "lumina.studio.graphmemory")
VECTOR_EMBEDDING_DIMENSIONS_COUNT = 768
MINIMUM_TAG_FREQUENCY_THRESHOLD = 3
TARGET_DUCKDB_DATABASE_FILE_PATH = "graph_memory.duckdb"
SQLITE_DATABASE_FILE_PATH = "images.db"
EMBEDDINGS_JSON_FILE_PATH = "public/search-embeddings.json"


def generate_deterministic_node_uuid(node_type_category_name: str, primary_entity_identifier: Any) -> uuid.UUID:
    """
    WHAT: Generates a deterministic UUIDv5 identifier anchored to the Lumina Studio namespace.
    WHY:  Guarantees that re-running the build pipeline always produces identical, reproducible
          node and edge keys across both Python and JavaScript interfaces without duplicate collisions.
    """
    unique_composite_string_key = f"{node_type_category_name}:{str(primary_entity_identifier).strip().lower()}"
    return uuid.uuid5(LUMINA_STUDIO_GRAPH_NAMESPACE_UUID, unique_composite_string_key)


def generate_deterministic_edge_uuid(
    source_node_unique_uuid: uuid.UUID,
    target_node_unique_uuid: uuid.UUID,
    relationship_type_string: str
) -> uuid.UUID:
    """
    WHAT: Generates a deterministic UUIDv5 identifier for a directed relationship edge.
    WHY:  Prevents duplicate edges between the same source, target, and relationship semantic type.
    """
    composite_edge_string_key = f"{source_node_unique_uuid}:{target_node_unique_uuid}:{relationship_type_string}"
    return uuid.uuid5(LUMINA_STUDIO_GRAPH_NAMESPACE_UUID, composite_edge_string_key)


def extract_database_records_and_taxonomies(sqlite_connection_instance: sqlite3.Connection) -> Dict[str, Any]:
    """
    WHAT: Extracts images, cluster assignments, cluster topics, and aesthetic facets from SQLite.
    WHY:  Normalizes heterogeneous relational tables into pure memory records ready for graph ingestion.
    """
    sqlite_cursor = sqlite_connection_instance.cursor()

    # 1. Fetch images with analysis JSON
    sqlite_cursor.execute("SELECT id, filename, path, analysis FROM images WHERE analysis IS NOT NULL")
    raw_image_database_rows = sqlite_cursor.fetchall()

    # 2. Fetch cluster assignments
    sqlite_cursor.execute("SELECT image_id, cluster_label FROM image_clusters")
    image_cluster_mapping_dictionary = {row[0]: row[1] for row in sqlite_cursor.fetchall()}

    # 3. Fetch cluster topics
    sqlite_cursor.execute("SELECT cluster_label, topic_title, keyphrases_json FROM image_cluster_topics")
    cluster_topics_mapping_dictionary = {
        row[0]: {
            "topic_title": row[1],
            "keyphrases": json.loads(row[2]) if row[2] else []
        }
        for row in sqlite_cursor.fetchall()
    }

    # 4. Fetch image facets
    sqlite_cursor.execute("SELECT image_id, medium, mood, composition, detail_score FROM image_facets")
    image_facets_mapping_dictionary = {
        row[0]: {
            "medium": row[1],
            "mood": row[2],
            "composition": row[3],
            "detail_score": row[4]
        }
        for row in sqlite_cursor.fetchall()
    }

    return {
        "raw_images": raw_image_database_rows,
        "image_clusters": image_cluster_mapping_dictionary,
        "cluster_topics": cluster_topics_mapping_dictionary,
        "image_facets": image_facets_mapping_dictionary
    }


def compute_filtered_tag_frequencies(raw_image_database_rows: List[Tuple]) -> Dict[str, int]:
    """
    WHAT: Counts occurrences of all tags across the image dataset and filters out singleton noise.
    WHY:  Pruning tags occurring less than MINIMUM_TAG_FREQUENCY_THRESHOLD eliminates misspellings
          and rare tokens, producing a high-density, highly-connected knowledge graph.
    """
    tag_frequency_accumulator = Counter()
    for _, _, _, raw_analysis_json_string in raw_image_database_rows:
        try:
            analysis_data_record = json.loads(raw_analysis_json_string)
            tags_list = analysis_data_record.get("tags", [])
            if isinstance(tags_list, list):
                for single_raw_tag_string in tags_list:
                    normalized_tag_string = single_raw_tag_string.strip().lower()
                    if normalized_tag_string:
                        tag_frequency_accumulator[normalized_tag_string] += 1
        except Exception:
            continue

    filtered_tag_frequencies_dictionary = {
        tag_string: occurrence_count
        for tag_string, occurrence_count in tag_frequency_accumulator.items()
        if occurrence_count >= MINIMUM_TAG_FREQUENCY_THRESHOLD
    }
    return filtered_tag_frequencies_dictionary


def build_and_populate_graph_memory() -> None:
    """
    WHAT: Main orchestration procedure constructing the DuckDB GraphMemory database.
    WHY:  Executes the full pipeline: schema creation, node extraction, edge linking,
          vector embedding attachment, and high-performance PyArrow batch insertion.
    """
    execution_start_timestamp = time.time()
    print("=" * 80)
    print("Starting Lumina Studio GraphMemory Construction Pipeline")
    print("=" * 80)

    # WHAT: Removing pre-existing DuckDB file to guarantee a clean, idempotent build.
    # WHY:  Avoids appending duplicate rows or stale schema fragments from prior runs.
    if os.path.exists(TARGET_DUCKDB_DATABASE_FILE_PATH):
        print(f"[*] Removing existing database file: {TARGET_DUCKDB_DATABASE_FILE_PATH}")
        os.remove(TARGET_DUCKDB_DATABASE_FILE_PATH)

    # 1. Connect to SQLite database
    print(f"[*] Connecting to SQLite database: {SQLITE_DATABASE_FILE_PATH}")
    sqlite_connection_instance = sqlite3.connect(SQLITE_DATABASE_FILE_PATH)
    database_extraction_payload = extract_database_records_and_taxonomies(sqlite_connection_instance)
    sqlite_connection_instance.close()

    raw_images = database_extraction_payload["raw_images"]
    image_clusters = database_extraction_payload["image_clusters"]
    cluster_topics = database_extraction_payload["cluster_topics"]
    image_facets = database_extraction_payload["image_facets"]
    print(f"[*] Extracted {len(raw_images)} images, {len(cluster_topics)} topics, and {len(image_facets)} facet rows.")

    # 2. Filter frequent tags
    filtered_tag_frequencies = compute_filtered_tag_frequencies(raw_images)
    print(f"[*] Selected {len(filtered_tag_frequencies)} high-signal tags with frequency >= {MINIMUM_TAG_FREQUENCY_THRESHOLD}.")

    # 3. Load 768-dimensional vector embeddings
    embeddings_dictionary = {}
    if os.path.exists(EMBEDDINGS_JSON_FILE_PATH):
        print(f"[*] Loading 768-dimensional vector embeddings from: {EMBEDDINGS_JSON_FILE_PATH}")
        embeddings_load_start_time = time.time()
        with open(EMBEDDINGS_JSON_FILE_PATH, "r", encoding="utf-8") as embeddings_file_handle:
            embeddings_dictionary = json.load(embeddings_file_handle)
        print(f"[*] Loaded {len(embeddings_dictionary)} vector embeddings in {time.time() - embeddings_load_start_time:.2f}s.")
    else:
        print(f"[!] Warning: Embeddings file {EMBEDDINGS_JSON_FILE_PATH} not found; proceeding without image vectors.")

    # 4. Initialize GraphMemory DuckDB engine
    print(f"[*] Initializing GraphMemory with vector length {VECTOR_EMBEDDING_DIMENSIONS_COUNT} and cosine distance...")
    graph_memory_instance = GraphMemory(
        database=TARGET_DUCKDB_DATABASE_FILE_PATH,
        vector_length=VECTOR_EMBEDDING_DIMENSIONS_COUNT,
        distance_metric="cosine"
    )

    # =========================================================================
    # A. PREPARE ALL GRAPH NODES
    # =========================================================================
    print("[*] Assembling typed knowledge graph nodes...")
    all_node_identifiers_list = []
    all_node_types_list = []
    all_node_properties_json_list = []
    all_node_vectors_list = []

    # Map of facet identifier to deterministic UUID
    facet_node_uuid_lookup = {}

    # Map of tag string to deterministic UUID
    tag_node_uuid_lookup = {}

    # Map of cluster label to deterministic UUID
    topic_node_uuid_lookup = {}

    # --- Topic Nodes ---
    for cluster_label_integer, topic_metadata_record in cluster_topics.items():
        topic_uuid = generate_deterministic_node_uuid("topic", cluster_label_integer)
        topic_node_uuid_lookup[cluster_label_integer] = topic_uuid
        topic_properties_dictionary = {
            "cluster_label": cluster_label_integer,
            "title": topic_metadata_record["topic_title"],
            "keyphrases": topic_metadata_record["keyphrases"]
        }
        all_node_identifiers_list.append(str(topic_uuid))
        all_node_types_list.append("Topic")
        all_node_properties_json_list.append(json.dumps(topic_properties_dictionary, ensure_ascii=False))
        all_node_vectors_list.append(None)

    # --- Tag Nodes ---
    for normalized_tag_string, tag_frequency_count in filtered_tag_frequencies.items():
        tag_uuid = generate_deterministic_node_uuid("tag", normalized_tag_string)
        tag_node_uuid_lookup[normalized_tag_string] = tag_uuid
        tag_properties_dictionary = {
            "name": normalized_tag_string,
            "frequency": tag_frequency_count
        }
        all_node_identifiers_list.append(str(tag_uuid))
        all_node_types_list.append("Tag")
        all_node_properties_json_list.append(json.dumps(tag_properties_dictionary, ensure_ascii=False))
        all_node_vectors_list.append(None)

    # --- Facet Nodes (Medium and Mood) ---
    distinct_mediums_set = set()
    distinct_moods_set = set()
    for facet_record in image_facets.values():
        if facet_record.get("medium"):
            distinct_mediums_set.add(facet_record["medium"].strip())
        if facet_record.get("mood"):
            distinct_moods_set.add(facet_record["mood"].strip())

    for distinct_medium_string in distinct_mediums_set:
        medium_facet_uuid = generate_deterministic_node_uuid("facet_medium", distinct_medium_string)
        facet_node_uuid_lookup[f"medium:{distinct_medium_string}"] = medium_facet_uuid
        facet_properties_dictionary = {
            "category": "medium",
            "value": distinct_medium_string
        }
        all_node_identifiers_list.append(str(medium_facet_uuid))
        all_node_types_list.append("Facet")
        all_node_properties_json_list.append(json.dumps(facet_properties_dictionary, ensure_ascii=False))
        all_node_vectors_list.append(None)

    for distinct_mood_string in distinct_moods_set:
        mood_facet_uuid = generate_deterministic_node_uuid("facet_mood", distinct_mood_string)
        facet_node_uuid_lookup[f"mood:{distinct_mood_string}"] = mood_facet_uuid
        facet_properties_dictionary = {
            "category": "mood",
            "value": distinct_mood_string
        }
        all_node_identifiers_list.append(str(mood_facet_uuid))
        all_node_types_list.append("Facet")
        all_node_properties_json_list.append(json.dumps(facet_properties_dictionary, ensure_ascii=False))
        all_node_vectors_list.append(None)

    # --- Image Nodes ---
    image_node_uuid_lookup = {}
    for image_identifier_integer, filename_string, relative_path_string, raw_analysis_json_string in raw_images:
        image_uuid = generate_deterministic_node_uuid("image", image_identifier_integer)
        image_node_uuid_lookup[image_identifier_integer] = image_uuid

        summary_text_string = ""
        try:
            parsed_analysis = json.loads(raw_analysis_json_string)
            summary_text_string = parsed_analysis.get("summary", "")
        except Exception:
            pass

        image_properties_dictionary = {
            "image_id": image_identifier_integer,
            "filename": filename_string,
            "path": relative_path_string,
            "summary": summary_text_string,
            "cluster_label": image_clusters.get(image_identifier_integer, -1)
        }

        # Check for matching 768-dim embedding vector
        string_id_key = str(image_identifier_integer)
        image_vector_coordinates_list = embeddings_dictionary.get(string_id_key)

        all_node_identifiers_list.append(str(image_uuid))
        all_node_types_list.append("Image")
        all_node_properties_json_list.append(json.dumps(image_properties_dictionary, ensure_ascii=False))
        all_node_vectors_list.append(image_vector_coordinates_list)

    total_nodes_count = len(all_node_identifiers_list)
    print(f"[*] Prepared {total_nodes_count:,} total nodes for insertion.")

    # =========================================================================
    # B. PREPARE ALL GRAPH EDGES
    # =========================================================================
    print("[*] Assembling typed relationship edges...")
    all_edge_identifiers_list = []
    all_edge_source_ids_list = []
    all_edge_target_ids_list = []
    all_edge_relations_list = []
    all_edge_weights_list = []
    seen_edge_identifiers_set: Set[uuid.UUID] = set()

    def record_directed_graph_edge(
        source_node_uuid: uuid.UUID,
        target_node_uuid: uuid.UUID,
        relationship_name_string: str,
        relationship_numerical_weight: float
    ) -> None:
        edge_uuid = generate_deterministic_edge_uuid(source_node_uuid, target_node_uuid, relationship_name_string)
        if edge_uuid in seen_edge_identifiers_set:
            return
        seen_edge_identifiers_set.add(edge_uuid)
        all_edge_identifiers_list.append(str(edge_uuid))
        all_edge_source_ids_list.append(str(source_node_uuid))
        all_edge_target_ids_list.append(str(target_node_uuid))
        all_edge_relations_list.append(relationship_name_string)
        all_edge_weights_list.append(float(relationship_numerical_weight))

    # 1. Image -> Topic Edges (BELONGS_TO_TOPIC)
    for image_identifier_integer, cluster_label_integer in image_clusters.items():
        if cluster_label_integer in topic_node_uuid_lookup and image_identifier_integer in image_node_uuid_lookup:
            source_image_uuid = image_node_uuid_lookup[image_identifier_integer]
            target_topic_uuid = topic_node_uuid_lookup[cluster_label_integer]
            record_directed_graph_edge(source_image_uuid, target_topic_uuid, "BELONGS_TO_TOPIC", 1.2)

    # 2. Image -> Tag Edges (TAGGED_WITH)
    for image_identifier_integer, _, _, raw_analysis_json_string in raw_images:
        source_image_uuid = image_node_uuid_lookup.get(image_identifier_integer)
        if not source_image_uuid:
            continue
        try:
            parsed_analysis = json.loads(raw_analysis_json_string)
            image_tags_list = parsed_analysis.get("tags", [])
            if isinstance(image_tags_list, list):
                for single_tag_string in image_tags_list:
                    normalized_tag_string = single_tag_string.strip().lower()
                    target_tag_uuid = tag_node_uuid_lookup.get(normalized_tag_string)
                    if target_tag_uuid:
                        record_directed_graph_edge(source_image_uuid, target_tag_uuid, "TAGGED_WITH", 1.0)
        except Exception:
            continue

    # 3. Image -> Facet Edges (EXHIBITS_MEDIUM, EXHIBITS_MOOD)
    for image_identifier_integer, facet_record in image_facets.items():
        source_image_uuid = image_node_uuid_lookup.get(image_identifier_integer)
        if not source_image_uuid:
            continue

        raw_medium_string = facet_record.get("medium")
        if raw_medium_string:
            medium_lookup_key = f"medium:{raw_medium_string.strip()}"
            target_medium_uuid = facet_node_uuid_lookup.get(medium_lookup_key)
            if target_medium_uuid:
                record_directed_graph_edge(source_image_uuid, target_medium_uuid, "EXHIBITS_MEDIUM", 0.8)

        raw_mood_string = facet_record.get("mood")
        if raw_mood_string:
            mood_lookup_key = f"mood:{raw_mood_string.strip()}"
            target_mood_uuid = facet_node_uuid_lookup.get(mood_lookup_key)
            if target_mood_uuid:
                record_directed_graph_edge(source_image_uuid, target_mood_uuid, "EXHIBITS_MOOD", 0.8)

    # 4. Topic -> Tag Edges (CHARACTERISTIC_KEYPHRASE)
    for cluster_label_integer, topic_metadata_record in cluster_topics.items():
        source_topic_uuid = topic_node_uuid_lookup.get(cluster_label_integer)
        if not source_topic_uuid:
            continue
        for keyphrase_string in topic_metadata_record.get("keyphrases", []):
            normalized_keyphrase = keyphrase_string.strip().lower()
            target_tag_uuid = tag_node_uuid_lookup.get(normalized_keyphrase)
            if target_tag_uuid:
                record_directed_graph_edge(source_topic_uuid, target_tag_uuid, "CHARACTERISTIC_KEYPHRASE", 1.5)

    total_edges_count = len(all_edge_identifiers_list)
    print(f"[*] Prepared {total_edges_count:,} total relationship edges.")

    # =========================================================================
    # C. HIGH-PERFORMANCE PYARROW BATCH INGESTION INTO DUCKDB
    # =========================================================================
    print("[*] Ingesting nodes batch into DuckDB via PyArrow table...")
    nodes_ingest_start_time = time.time()
    nodes_arrow_table = pa.Table.from_arrays([
        pa.array(all_node_identifiers_list, type=pa.string()),
        pa.array(all_node_types_list, type=pa.string()),
        pa.array(all_node_properties_json_list, type=pa.string()),
        pa.array(all_node_vectors_list, type=pa.list_(pa.float32(), VECTOR_EMBEDDING_DIMENSIONS_COUNT))
    ], names=["id", "type", "properties", "vector"])

    duckdb_active_cursor = graph_memory_instance.cursor()
    duckdb_active_cursor.execute("INSERT INTO nodes SELECT id::UUID, type, properties, vector FROM nodes_arrow_table")
    print(f"[*] Nodes batch inserted in {time.time() - nodes_ingest_start_time:.2f}s.")

    print("[*] Ingesting edges batch into DuckDB via PyArrow table...")
    edges_ingest_start_time = time.time()
    edges_arrow_table = pa.Table.from_arrays([
        pa.array(all_edge_identifiers_list, type=pa.string()),
        pa.array(all_edge_source_ids_list, type=pa.string()),
        pa.array(all_edge_target_ids_list, type=pa.string()),
        pa.array(all_edge_relations_list, type=pa.string()),
        pa.array(all_edge_weights_list, type=pa.float32())
    ], names=["id", "source_id", "target_id", "relation", "weight"])

    duckdb_active_cursor.execute(
        "INSERT INTO edges SELECT id::UUID, source_id::UUID, target_id::UUID, relation, weight FROM edges_arrow_table"
    )
    print(f"[*] Edges batch inserted in {time.time() - edges_ingest_start_time:.2f}s.")

    # =========================================================================
    # D. VERIFICATION & INDEX CREATION
    # =========================================================================
    print("[*] Verifying DuckDB row counts and index structures...")
    verified_nodes_count = duckdb_active_cursor.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    verified_edges_count = duckdb_active_cursor.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    verified_vectors_count = duckdb_active_cursor.execute("SELECT COUNT(*) FROM nodes WHERE vector IS NOT NULL").fetchone()[0]

    print(f"[*] Verification summary:")
    print(f"    - Stored Nodes:   {verified_nodes_count:,}")
    print(f"    - Stored Edges:   {verified_edges_count:,}")
    print(f"    - Stored Vectors: {verified_vectors_count:,} (768 dimensions)")

    print("[*] Building GraphMemory indexes (HNSW and Full-Text Search)...")
    try:
        graph_memory_instance.create_index()
        print("[*] Graph indexes built successfully.")
    except Exception as index_creation_exception:
        print(f"[!] Note on index creation: {index_creation_exception}")

    graph_memory_instance.close()

    total_pipeline_duration_seconds = time.time() - execution_start_timestamp
    print("=" * 80)
    print(f"[SUCCESS] GraphMemory database generated in {total_pipeline_duration_seconds:.2f} seconds.")
    print(f"Target Database File: {os.path.abspath(TARGET_DUCKDB_DATABASE_FILE_PATH)}")
    print("=" * 80)


if __name__ == "__main__":
    build_and_populate_graph_memory()
