# ============================================================================
# Lumina Studio - EVoC Clustering & UMAP Dimensionality Reduction Pipeline
#
# WHAT: Command-line data pipeline that clusters high-dimensional image embeddings
#       using EVoC (or HDBSCAN fallback) and projects them into 2D via UMAP.
# WHY: High-dimensional visual embeddings (e.g. 2048-dim Ovis or 768-dim CLIP)
#       cannot be directly visualized on screen. Projecting them into a calibrated 2D
#       manifold allows macroscopic interactive exploration in the Scope visualizer.
#
# PROTOCOL COMPLIANCE:
# 1. "can_be_long" Variable Naming: Zero shorthand abbreviations or single-letter variables.
# 2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
# ============================================================================

import os
import sys
import json
import sqlite3
import time
import argparse
import numpy as np
import umap

# WHAT: Conditional import of EVoC clustering with HDBSCAN fallback.
# WHY: EVoC provides state-of-the-art tree-based evolutionary clustering specifically
#      tuned for vision and language embeddings; if EVoC native dependencies are not
#      installed, falling back to standard HDBSCAN ensures zero disruption to pipeline flow.
try:
    import evoc
    IS_EVOC_CLUSTERING_ENGINE_AVAILABLE = True
except ImportError:
    import hdbscan
    IS_EVOC_CLUSTERING_ENGINE_AVAILABLE = False


def execute_clustering_and_projection_pipeline():
    # ------------------------------------------------------------------------
    # Command Line Interface Argument Parsing
    # ------------------------------------------------------------------------
    # WHAT: Configures CLI arguments for database path, embeddings source, and UMAP dispersion.
    # WHY: Allows batch execution and parameter tuning (such as spread and min_dist) directly from scripts or shell runners.
    command_line_argument_parser = argparse.ArgumentParser(description='Lumina EVoC + UMAP Manifold Pipeline')
    command_line_argument_parser.add_argument('--db', type=str, default='images.db', help='Path to SQLite target database')
    command_line_argument_parser.add_argument('--embeddings', type=str, default='public/search-embeddings.json', help='Path to embeddings JSON vector file')
    command_line_argument_parser.add_argument('--min_dist', type=float, default=0.45, help='UMAP minimum distance between points (higher = more spread)')
    command_line_argument_parser.add_argument('--spread', type=float, default=1.5, help='UMAP scale factor for embedding space spread')
    parsed_command_line_arguments = command_line_argument_parser.parse_args()

    target_sqlite_database_file_path = parsed_command_line_arguments.db
    target_embeddings_json_file_path = parsed_command_line_arguments.embeddings
    umap_minimum_distance_hyperparameter = parsed_command_line_arguments.min_dist
    umap_spatial_spread_hyperparameter = parsed_command_line_arguments.spread

    print("[*] Starting Lumina Data Analysis Pipeline...")
    print(f"[*] Target SQLite Database: {target_sqlite_database_file_path}")
    print(f"[*] Source Embeddings JSON: {target_embeddings_json_file_path}")
    print(f"[*] Spatial Dispersion Hyperparameters: min_dist={umap_minimum_distance_hyperparameter}, spread={umap_spatial_spread_hyperparameter}")

    # ------------------------------------------------------------------------
    # Step 1: Ingest High-Dimensional Vector Embeddings
    # ------------------------------------------------------------------------
    # WHAT: Verifies file existence and parses the serialized vector map from disk.
    # WHY: Embeddings form the core feature space for all subsequent mathematical clustering and projection.
    if not os.path.exists(target_embeddings_json_file_path):
        print(f"[!] Error: Embeddings file not found at {target_embeddings_json_file_path}")
        sys.exit(1)

    print("[*] Loading embeddings vector dictionary from disk...")
    load_operation_start_timestamp_seconds = time.time()
    with open(target_embeddings_json_file_path, "r", encoding="utf-8") as embeddings_json_file_handle:
        serialized_embeddings_dictionary = json.load(embeddings_json_file_handle)

    extracted_image_identifiers_list = list(serialized_embeddings_dictionary.keys())
    embedding_feature_vectors_list = [serialized_embeddings_dictionary[image_identifier_key] for image_identifier_key in extracted_image_identifiers_list]
    embedding_feature_matrix_numpy = np.array(embedding_feature_vectors_list, dtype=np.float32)

    total_vector_dimensions_count = embedding_feature_matrix_numpy.shape[1]
    elapsed_load_duration_seconds = time.time() - load_operation_start_timestamp_seconds
    print(f"[*] Loaded {len(extracted_image_identifiers_list)} embeddings (dimensions: {total_vector_dimensions_count}) in {elapsed_load_duration_seconds:.2f}s")

    # ------------------------------------------------------------------------
    # Step 2: High-Dimensional Manifold Clustering (EVoC / HDBSCAN)
    # ------------------------------------------------------------------------
    # WHAT: Groups semantic embeddings into distinct thematic clusters based on density and topological connectivity.
    # WHY: Unsupervised clustering detects natural categories in the dataset without human labeling.
    clustering_operation_start_timestamp_seconds = time.time()
    if IS_EVOC_CLUSTERING_ENGINE_AVAILABLE:
        print("[*] Initializing EVoC evolutionary clustering engine...")
        evoc_clustering_engine_instance = evoc.EVoC()
        assigned_cluster_labels_array = evoc_clustering_engine_instance.fit_predict(embedding_feature_matrix_numpy)
        clustering_algorithm_display_name = "EVoC"
    else:
        print("[*] Initializing HDBSCAN density clustering engine (fallback)...")
        hdbscan_clustering_engine_instance = hdbscan.HDBSCAN(min_cluster_size=15, metric='euclidean')
        assigned_cluster_labels_array = hdbscan_clustering_engine_instance.fit_predict(embedding_feature_matrix_numpy)
        clustering_algorithm_display_name = "HDBSCAN"

    unique_discovered_clusters_count = len(set(assigned_cluster_labels_array)) - (1 if -1 in assigned_cluster_labels_array else 0)
    unclustered_noise_items_count = list(assigned_cluster_labels_array).count(-1)
    elapsed_clustering_duration_seconds = time.time() - clustering_operation_start_timestamp_seconds
    print(f"[*] {clustering_algorithm_display_name}: Discovered {unique_discovered_clusters_count} clusters (Noise: {unclustered_noise_items_count}) in {elapsed_clustering_duration_seconds:.2f}s")

    # ------------------------------------------------------------------------
    # Step 3: UMAP 2D Dimensionality Reduction
    # ------------------------------------------------------------------------
    # WHAT: Projects the multi-thousand-dimensional embedding manifold into 2D Cartesian coordinates (x, y).
    # WHY: UMAP preserves both local neighborhood affinities and global topological structure,
    #      placing semantically similar images close to one another on screen.
    print(f"[*] Initializing UMAP projection (2D, min_dist={umap_minimum_distance_hyperparameter}, spread={umap_spatial_spread_hyperparameter})...")
    umap_projection_start_timestamp_seconds = time.time()
    umap_dimensionality_reduction_model = umap.UMAP(
        n_components=2,
        random_state=42,
        n_neighbors=15,
        min_dist=umap_minimum_distance_hyperparameter,
        spread=umap_spatial_spread_hyperparameter
    )
    projected_2d_coordinates_array = umap_dimensionality_reduction_model.fit_transform(embedding_feature_matrix_numpy)
    elapsed_umap_duration_seconds = time.time() - umap_projection_start_timestamp_seconds
    print(f"[*] UMAP: 2D projection completed in {elapsed_umap_duration_seconds:.2f}s")

    # ------------------------------------------------------------------------
    # Step 4: Persist Results to SQLite Database (images.db)
    # ------------------------------------------------------------------------
    # WHAT: Writes cluster IDs and projected coordinates into image_clusters and image_coordinates tables.
    # WHY: Decouples analysis from visualization; the Scope web app queries these precomputed coordinates instantly.
    print(f"[*] Persisting results to SQLite database at {target_sqlite_database_file_path}...")
    try:
        sqlite_database_connection = sqlite3.connect(target_sqlite_database_file_path)
        sqlite_database_cursor = sqlite_database_connection.cursor()

        # Ensure database tables exist
        sqlite_database_cursor.execute('''
            CREATE TABLE IF NOT EXISTS image_clusters (
                image_id INTEGER PRIMARY KEY,
                cluster_label INTEGER
            )
        ''')
        sqlite_database_cursor.execute('''
            CREATE TABLE IF NOT EXISTS image_coordinates (
                image_id INTEGER PRIMARY KEY,
                x REAL,
                y REAL
            )
        ''')

        # Batch insert cluster labels
        cluster_database_insertion_records = [
            (int(single_image_identifier), int(single_cluster_label))
            for single_image_identifier, single_cluster_label in zip(extracted_image_identifiers_list, assigned_cluster_labels_array)
        ]
        sqlite_database_cursor.executemany(
            'INSERT OR REPLACE INTO image_clusters (image_id, cluster_label) VALUES (?, ?)',
            cluster_database_insertion_records
        )

        # Batch insert 2D coordinates
        coordinate_database_insertion_records = [
            (int(single_image_identifier), float(projected_coordinate_x), float(projected_coordinate_y))
            for single_image_identifier, (projected_coordinate_x, projected_coordinate_y) in zip(extracted_image_identifiers_list, projected_2d_coordinates_array)
        ]
        sqlite_database_cursor.executemany(
            'INSERT OR REPLACE INTO image_coordinates (image_id, x, y) VALUES (?, ?, ?)',
            coordinate_database_insertion_records
        )

        sqlite_database_connection.commit()
        sqlite_database_connection.close()
        print("[*] SQLite database successfully updated with clustering and coordinate records!")
        print("[*] Lumina analysis pipeline finished.")

    except Exception as database_operation_exception:
        print(f"[!] SQLite Database Error: {database_operation_exception}")
        sys.exit(1)


if __name__ == "__main__":
    execute_clustering_and_projection_pipeline()
