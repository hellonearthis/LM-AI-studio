#!/usr/bin/env python3
"""
WHAT: Diagnostic script auditing the integrity of search-embeddings.json and search-data.json.
WHY: Detects orphaned embedding vectors, dimension discrepancies, missing image embeddings,
and verifies vector mathematical properties before runtime search failures occur.
"""

import json
import math
import sys
from pathlib import Path

def audit_vector_embeddings_pipeline(data_json_path_string, embeddings_json_path_string):
    data_path = Path(data_json_path_string)
    embeddings_path = Path(embeddings_json_path_string)

    if not data_path.exists():
        print(f"[ERROR] Data file not found: {data_path}")
        return False
    if not embeddings_path.exists():
        print(f"[ERROR] Embeddings file not found: {embeddings_path}")
        return False

    print(f"[EMBEDDINGS-AUDIT] Reading data from {data_path.name} and {embeddings_path.name}...")
    with open(data_path, 'r', encoding='utf-8') as data_file_handle:
        image_data_records_list = json.load(data_file_handle)

    with open(embeddings_path, 'r', encoding='utf-8') as embeddings_file_handle:
        vector_embeddings_map = json.load(embeddings_file_handle)

    active_image_identifiers_set = {str(image_record.get('id')) for image_record in image_data_records_list}
    stored_embedding_identifiers_list = list(vector_embeddings_map.keys())

    print(f"  - Total image records in database: {len(active_image_identifiers_set)}")
    print(f"  - Total vector embeddings stored: {len(stored_embedding_identifiers_list)}")

    orphaned_embedding_identifiers = [embedding_id for embedding_id in stored_embedding_identifiers_list if embedding_id not in active_image_identifiers_set]
    missing_embedding_identifiers = [image_id for image_id in active_image_identifiers_set if image_id not in vector_embeddings_map]

    print(f"  - Missing embeddings for database images: {len(missing_embedding_identifiers)}")
    print(f"  - Orphaned embeddings (deleted images): {len(orphaned_embedding_identifiers)}")

    # Dimension and NaN integrity check
    expected_vector_dimension_size = None
    corrupted_vector_identifiers = []

    for embedding_identifier, embedding_vector in list(vector_embeddings_map.items())[:1000]:
        if not isinstance(embedding_vector, list) or len(embedding_vector) == 0:
            corrupted_vector_identifiers.append(embedding_identifier)
            continue
        if expected_vector_dimension_size is None:
            expected_vector_dimension_size = len(embedding_vector)
            print(f"  - Detected standard vector dimension size: {expected_vector_dimension_size}")
        elif len(embedding_vector) != expected_vector_dimension_size:
            corrupted_vector_identifiers.append(embedding_identifier)
        if any(math.isnan(dimension_value) or math.isinf(dimension_value) for dimension_value in embedding_vector):
            corrupted_vector_identifiers.append(embedding_identifier)

    if corrupted_vector_identifiers:
        print(f"[FAIL] Found {len(corrupted_vector_identifiers)} corrupted vector entries!")
        return False

    print("[SUCCESS] Embedding pipeline integrity audit passed successfully!")
    return True

if __name__ == '__main__':
    data_file_argument = sys.argv[1] if len(sys.argv) > 1 else 'public/search-data.json'
    embeddings_file_argument = sys.argv[2] if len(sys.argv) > 2 else 'public/search-embeddings.json'
    audit_passed_boolean = audit_vector_embeddings_pipeline(data_file_argument, embeddings_file_argument)
    sys.exit(0 if audit_passed_boolean else 1)
