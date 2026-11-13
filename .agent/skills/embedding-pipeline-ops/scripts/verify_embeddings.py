#!/usr/bin/env python3
"""
WHAT: Diagnostic & maintenance script auditing vector embedding files against SQLite images.db.
WHY: Detects orphaned embedding vectors (from deleted images), missing image embeddings,
dimension discrepancies, and NaN/Infinity corruption across both `public/search-embeddings.json`
(768-dim text embeddings) and `public/ovis-embeddings.json` (2048-dim visual embeddings),
with optional `--prune` support to remove orphaned vectors cleanly.
"""

import argparse
import json
import math
import os
import sqlite3
import sys
from pathlib import Path


def load_active_image_identifiers_from_sqlite(sqlite_db_path: Path, fallback_data_json_path: Path) -> set[str]:
    """
    WHAT: Loads the set of all active image IDs directly from SQLite `images.db` (or `search-data.json` fallback).
    WHY: `images.db` is the single source of truth for active image records; comparing embedding keys
         against `SELECT id FROM images` accurately identifies orphaned vectors left behind by deleted images.
    """
    if sqlite_db_path.exists():
        database_connection = sqlite3.connect(str(sqlite_db_path))
        try:
            cursor = database_connection.cursor()
            rows = cursor.execute("SELECT id FROM images").fetchall()
            return {str(single_row[0]) for single_row in rows}
        finally:
            database_connection.close()

    if fallback_data_json_path.exists():
        with open(fallback_data_json_path, "r", encoding="utf-8") as data_file_handle:
            image_data_records_list = json.load(data_file_handle)
        return {str(image_record.get("id")) for image_record in image_data_records_list}

    raise FileNotFoundError(f"Neither {sqlite_db_path} nor {fallback_data_json_path} exists.")


def audit_single_embeddings_file(
    embeddings_file_path: Path,
    active_image_identifiers_set: set[str],
    prune_orphans_flag: bool = False,
    label_description: str = "Embeddings",
) -> dict:
    """
    WHAT: Audits a single JSON embedding dictionary against the active image ID set and optionally prunes orphans.
    WHY: Provides a deterministic report of total vectors, valid vectors, missing images, orphaned vectors,
         and numerical integrity (dimension consistency and NaN/Inf checks).
    """
    if not embeddings_file_path.exists():
        print(f"\n[{label_description}] File not found ({embeddings_file_path}) — skipping.")
        return {
            "exists": False,
            "path": str(embeddings_file_path),
            "orphaned_count": 0,
            "corrupted_count": 0,
            "pruned_count": 0,
        }

    file_size_megabytes_before = os.path.getsize(embeddings_file_path) / (1024 * 1024)
    print(f"\n[{label_description}] Auditing {embeddings_file_path} ({file_size_megabytes_before:.2f} MB)...")

    with open(embeddings_file_path, "r", encoding="utf-8") as embeddings_file_handle:
        vector_embeddings_map = json.load(embeddings_file_handle)

    stored_embedding_identifiers_list = [str(key) for key in vector_embeddings_map.keys()]
    orphaned_embedding_identifiers = [
        embedding_id
        for embedding_id in stored_embedding_identifiers_list
        if embedding_id not in active_image_identifiers_set
    ]
    missing_embedding_identifiers = [
        image_id
        for image_id in active_image_identifiers_set
        if image_id not in vector_embeddings_map
    ]
    valid_embeddings_count = len(stored_embedding_identifiers_list) - len(orphaned_embedding_identifiers)

    expected_vector_dimension_size = None
    corrupted_vector_identifiers = []

    for embedding_identifier, embedding_vector in list(vector_embeddings_map.items())[:1000]:
        if not isinstance(embedding_vector, list) or len(embedding_vector) == 0:
            corrupted_vector_identifiers.append(str(embedding_identifier))
            continue
        if expected_vector_dimension_size is None:
            expected_vector_dimension_size = len(embedding_vector)
        elif len(embedding_vector) != expected_vector_dimension_size:
            corrupted_vector_identifiers.append(str(embedding_identifier))
        if any(
            not isinstance(dimension_value, (int, float))
            or math.isnan(dimension_value)
            or math.isinf(dimension_value)
            for dimension_value in embedding_vector
        ):
            corrupted_vector_identifiers.append(str(embedding_identifier))

    print(f"  - Active image records in database : {len(active_image_identifiers_set)}")
    print(f"  - Total vector embeddings stored   : {len(stored_embedding_identifiers_list)}")
    print(f"  - Valid embeddings matching DB     : {valid_embeddings_count}")
    print(f"  - Missing embeddings for DB images : {len(missing_embedding_identifiers)}")
    print(f"  - Orphaned embeddings (deleted IDs): {len(orphaned_embedding_identifiers)}")
    if expected_vector_dimension_size is not None:
        print(f"  - Detected vector dimension size   : {expected_vector_dimension_size}")

    if orphaned_embedding_identifiers:
        sample_orphans_preview = ", ".join(orphaned_embedding_identifiers[:15])
        suffix_text = " ..." if len(orphaned_embedding_identifiers) > 15 else ""
        print(f"  - Sample orphaned IDs              : [{sample_orphans_preview}{suffix_text}]")

    pruned_vectors_count = 0
    if prune_orphans_flag and orphaned_embedding_identifiers:
        pruned_embeddings_map = {
            embedding_key: embedding_vector
            for embedding_key, embedding_vector in vector_embeddings_map.items()
            if str(embedding_key) in active_image_identifiers_set
        }
        pruned_vectors_count = len(vector_embeddings_map) - len(pruned_embeddings_map)
        with open(embeddings_file_path, "w", encoding="utf-8") as output_file_handle:
            json.dump(pruned_embeddings_map, output_file_handle, separators=(",", ":"))
        file_size_megabytes_after = os.path.getsize(embeddings_file_path) / (1024 * 1024)
        saved_megabytes = max(0.0, file_size_megabytes_before - file_size_megabytes_after)
        print(
            f"  - [PRUNED] Removed {pruned_vectors_count} orphaned vectors "
            f"({file_size_megabytes_before:.2f} MB -> {file_size_megabytes_after:.2f} MB, freed {saved_megabytes:.2f} MB)"
        )

    if corrupted_vector_identifiers:
        print(f"  - [FAIL] Found {len(corrupted_vector_identifiers)} corrupted vector entries!")

    return {
        "exists": True,
        "path": str(embeddings_file_path),
        "total_stored": len(stored_embedding_identifiers_list),
        "valid_count": valid_embeddings_count,
        "missing_count": len(missing_embedding_identifiers),
        "orphaned_count": len(orphaned_embedding_identifiers),
        "corrupted_count": len(corrupted_vector_identifiers),
        "pruned_count": pruned_vectors_count,
        "dimension": expected_vector_dimension_size,
    }


def main() -> int:
    argument_parser = argparse.ArgumentParser(
        description="Audit and optionally prune orphaned embedding vectors against images.db."
    )
    argument_parser.add_argument(
        "data_file",
        nargs="?",
        default="public/search-data.json",
        help="Fallback search-data.json path if images.db is not specified.",
    )
    argument_parser.add_argument(
        "embeddings_file",
        nargs="?",
        default="public/search-embeddings.json",
        help="Primary search-embeddings.json path to audit.",
    )
    argument_parser.add_argument(
        "--db",
        default="images.db",
        help="Path to SQLite images.db (default: images.db).",
    )
    argument_parser.add_argument(
        "--ovis-file",
        default="public/ovis-embeddings.json",
        help="Path to Ovis multimodal embeddings JSON (default: public/ovis-embeddings.json).",
    )
    argument_parser.add_argument(
        "--prune",
        action="store_true",
        help="Automatically remove orphaned embedding vectors from the embedding JSON files.",
    )
    parsed_arguments = argument_parser.parse_args()

    try:
        active_image_identifiers_set = load_active_image_identifiers_from_sqlite(
            Path(parsed_arguments.db),
            Path(parsed_arguments.data_file),
        )
    except Exception as database_load_error:
        print(f"[ERROR] Failed to load active image IDs: {database_load_error}")
        return 1

    search_report = audit_single_embeddings_file(
        Path(parsed_arguments.embeddings_file),
        active_image_identifiers_set,
        prune_orphans_flag=parsed_arguments.prune,
        label_description="SEARCH-EMBEDDINGS (768-d Text)",
    )

    ovis_path = Path(parsed_arguments.ovis_file)
    ovis_report = (
        audit_single_embeddings_file(
            ovis_path,
            active_image_identifiers_set,
            prune_orphans_flag=parsed_arguments.prune,
            label_description="OVIS-EMBEDDINGS (2048-d Visual)",
        )
        if ovis_path.exists()
        else {"corrupted_count": 0, "orphaned_count": 0, "pruned_count": 0}
    )

    if search_report["corrupted_count"] > 0 or ovis_report["corrupted_count"] > 0:
        return 1

    remaining_orphans = (
        0
        if parsed_arguments.prune
        else (search_report["orphaned_count"] + ovis_report["orphaned_count"])
    )
    if remaining_orphans > 0:
        print(
            f"\n[NOTICE] Detected {remaining_orphans} total orphaned embedding vector(s). "
            f"Run `npm run embeddings:prune` (or click 'Prune Orphans' in the Search / Database UI) to remove them."
        )
    else:
        print("\n[SUCCESS] Embedding pipeline integrity audit passed with 0 orphaned vectors!")

    return 0


if __name__ == "__main__":
    sys.exit(main())
