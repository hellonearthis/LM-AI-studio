# Lumina AI Studio - Scripts & Data Pipelines

This directory contains Python and Node.js scripts used for data synchronization, AI analysis, and semantic mapping.

---

## 🛠️ Core Pipelines

### 1. `evoc_pipeline.py` (Automated via UI)
This is the primary engine for the **Data Map**. It performs high-level clustering and 2D spatial projection.
- **What it does**: 
    1. Loads AI embeddings from `public/search-embeddings.json`.
    2. Runs **EVoC** to find thematic "neighborhoods" in your data.
    3. Runs **UMAP** to calculate (x, y) coordinates for the 2D map.
    4. Updates the `image_clusters` and `image_coordinates` tables in `images.db`.
- **Usage (UI)**: Go to **Settings > Data Mapping Tools** and click "Run Map Analysis".
- **Usage (CLI)**:
    ```bash
    python scripts/evoc_pipeline.py --db images.db --embeddings public/search-embeddings.json
    ```

### 2. `sync_ls.py`
Synchronizes your local SQLite database with Latent Scope's native Parquet format.
- **What it does**: Exports image metadata and analysis into `ls-data/input.parquet`.
- **Usage (CLI)**:
    ```bash
    python scripts/sync_ls.py
    ```

---

## 🔧 Maintenance & Debugging

### `cleanup_tags.js`
- **Purpose**: Deduplicates and sanitizes the tags stored in the `images` table.
- **Usage**: `node scripts/cleanup_tags.js`

### `setup_libs.js`
- **Purpose**: Downloads and initializes the large DuckDB WebAssembly binaries required for the map visualization.
- **Usage**: `node scripts/setup_libs.js`

### `inspect_parquet.py`
- **Purpose**: Quick utility to print the schema and first few rows of a `.parquet` file for debugging data alignment issues.

---

## 📋 Requirements
Most Python scripts require the following libraries:
```bash
pip install pandas numpy sqlite3 umap-learn evoc h5py pyarrow
```
*Note: Latent Scope integration specifically requires `pyarrow` for Parquet support.*
