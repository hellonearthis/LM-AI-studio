
import sqlite3
import pandas as pd
import json
import os
import sys

# Configuration
DB_PATH = 'images.db'
LS_DATA_DIR = 'ls-data'
LS_PROJECT_ID = 'image_analysis'

# Ensure data directory exists
if not os.path.exists(LS_DATA_DIR):
    os.makedirs(LS_DATA_DIR)

def sync_data():
    print(f"Connecting to database: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    
    # Fetch data
    query = "SELECT id, filename, path, analysis, metadata, created_at FROM images"
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    print(f"Fetched {len(df)} records.")
    
    if len(df) == 0:
        print("No data found. Exiting.")
        return

    # Process data for Latent Scope
    # We need a 'text' column for embedding. We'll combine summary + tags + objects.
    
    texts = []
    
    for index, row in df.iterrows():
        try:
            analysis = json.loads(row['analysis']) if row['analysis'] else {}
            
            summary = analysis.get('summary', '')
            tags = " ".join(analysis.get('tags', []))
            objects = " ".join(analysis.get('objects', []))
            scene = analysis.get('scene_type', '')
            
            # Create a rich text representation
            text = f"{summary}\nTags: {tags}\nObjects: {objects}\nScene: {scene}"
            texts.append(text)
            
        except Exception as e:
            print(f"Error parsing row {row['id']}: {e}")
            texts.append("")

    df['text'] = texts
    
    # Save to Parquet for Latent Scope
    output_path = os.path.join(LS_DATA_DIR, 'input.parquet')
    df.to_parquet(output_path)
    print(f"Data exported to {output_path}")
    
    # Initialize Latent Scope if not already done (basic check)
    # Ideally we'd use the python API, but for now we'll rely on the user running ls-serve
    # or subsequent commands.
    
    print("\nTo visualize this data in Latent Scope:")
    print("1. Run: ls-serve")
    print("2. Go to http://localhost:5001")
    print("3. Create a new scope using 'ls-data/input.parquet'")

if __name__ == "__main__":
    sync_data()
