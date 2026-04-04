import os
import sys
import json
import sqlite3
import time
import argparse
import numpy as np
import umap
import evoc

def main():
    parser = argparse.ArgumentParser(description='Lumina EVoC + UMAP Pipeline')
    parser.add_argument('--db', type=str, default='images.db', help='Path to SQLite database')
    parser.add_argument('--embeddings', type=str, default='public/search-embeddings.json', help='Path to embeddings JSON')
    args = parser.parse_args()

    db_path = args.db
    embeddings_path = args.embeddings

    print(f"[*] Starting Lumina Data Analysis Pipeline...")
    print(f"[*] Database: {db_path}")
    print(f"[*] Embeddings: {embeddings_path}")

    # 1. Load Embeddings
    if not os.path.exists(embeddings_path):
        print(f"[!] Error: Embeddings file not found at {embeddings_path}")
        sys.exit(1)

    print("[*] Loading embeddings...")
    start_load = time.time()
    with open(embeddings_path, "r") as f:
        data = json.load(f)
    
    image_ids = list(data.keys())
    embeddings = [data[k] for k in image_ids]
    embeddings_np = np.array(embeddings, dtype=np.float32)
    print(f"[*] Loaded {len(image_ids)} embeddings (dim: {embeddings_np.shape[1]}) in {time.time() - start_load:.2f}s")

    # 2. EVoC Clustering
    print("[*] Initializing EVoC clustering...")
    clusterer = evoc.EVoC()
    start_evoc = time.time()
    cluster_labels = clusterer.fit_predict(embeddings_np)
    
    unique_clusters = len(set(cluster_labels)) - (1 if -1 in cluster_labels else 0)
    noise_count = list(cluster_labels).count(-1)
    print(f"[*] EVoC: Found {unique_clusters} clusters (Noise: {noise_count}) in {time.time() - start_evoc:.2f}s")

    # 3. UMAP Projection
    print("[*] Initializing UMAP projection (2D)...")
    start_umap = time.time()
    # Default parameters from generate_coordinates.py
    reducer = umap.UMAP(n_components=2, random_state=42, n_neighbors=15, min_dist=0.1)
    coords = reducer.fit_transform(embeddings_np)
    print(f"[*] UMAP: Projection finished in {time.time() - start_umap:.2f}s")

    # 4. Save to Database
    print(f"[*] Saving results to {db_path}...")
    try:
        con = sqlite3.connect(db_path)
        cur = con.cursor()
        
        # Ensure tables exist
        cur.execute('''
            CREATE TABLE IF NOT EXISTS image_clusters (
                image_id INTEGER PRIMARY KEY,
                cluster_label INTEGER
            )
        ''')
        cur.execute('''
            CREATE TABLE IF NOT EXISTS image_coordinates (
                image_id INTEGER PRIMARY KEY,
                x REAL,
                y REAL
            )
        ''')

        # Batch Insert Clusters
        cluster_data = [(int(img_id), int(lbl)) for img_id, lbl in zip(image_ids, cluster_labels)]
        cur.executemany('INSERT OR REPLACE INTO image_clusters (image_id, cluster_label) VALUES (?, ?)', cluster_data)
        
        # Batch Insert Coordinates
        coord_data = [(int(img_id), float(x), float(y)) for img_id, (x, y) in zip(image_ids, coords)]
        cur.executemany('INSERT OR REPLACE INTO image_coordinates (image_id, x, y) VALUES (?, ?, ?)', coord_data)

        con.commit()
        con.close()
        print("[*] Database updated successfully!")
        print("[*] Pipeline complete.")
        
    except Exception as e:
        print(f"[!] Database Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
