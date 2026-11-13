# Image Analysis Studio Database (`images.db`)

This document provides a complete overview of the local SQLite database schema (`images.db`) that manages the image assets, analytical metadata, and mapped clustering coordinates for Lumina.

## 🗄️ Entity-Relationship Diagram

```mermaid
erDiagram
    IMAGES ||--o| IMAGE_CLUSTERS : "has cluster (1:1)"
    IMAGES ||--o| IMAGE_COORDINATES : "has coordinates (1:1)"
    IMAGES ||--o| IMAGE_FACETS : "has facets (1:1)"

    IMAGES {
        INTEGER id PK "Auto-incrementing primary key"
        TEXT filename "Filename of the image"
        TEXT path UK "Absolute or relative physical path (Unique)"
        TEXT file_hash "Hash signature for deduplication"
        TEXT metadata "JSON string of extracted EXIF/basic metadata"
        TEXT analysis "JSON or text payload of AI image analysis/tags"
        TEXT created_at "Timestamp of addition"
        TEXT updated_at "Timestamp of last modification"
        INTEGER width "Image pixel width"
        INTEGER height "Image pixel height"
        INTEGER size "Image file size in bytes"
        INTEGER mtime "Last modified timestamp of the file"
    }

    IMAGE_CLUSTERS {
        INTEGER image_id PK "Foreign Key referencing IMAGES.id"
        INTEGER cluster_label "Numerical ID identifying the AI grouping/cluster"
    }

    IMAGE_COORDINATES {
        INTEGER image_id PK "Foreign Key referencing IMAGES.id"
        REAL x "X-axis projection coordinate (e.g., UMAP/t-SNE)"
        REAL y "Y-axis projection coordinate (e.g., UMAP/t-SNE)"
    }

    IMAGE_FACETS {
        INTEGER image_id PK "Foreign Key referencing IMAGES.id (ON DELETE CASCADE)"
        TEXT medium "Laya classified visual artistic medium"
        TEXT mood "Laya classified visual/emotional mood"
        TEXT composition "Laya classified composition and camera framing"
        REAL detail_score "Laya continuous score of description completeness"
        REAL confidence_medium "Classification confidence for medium"
        REAL confidence_mood "Classification confidence for mood"
        REAL confidence_composition "Classification confidence for framing"
        TIMESTAMP updated_at "Timestamp of classification"
    }
```

## 📋 Tables Overview

### 1. `images`
This is the core table that tracks all physical image files successfully ingested into the studio. It stores both standard file-system metadata and the rich AI analysis generated via multimodal vision inference (`llama-server.exe` running Qwen 3.5 VL).

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | INTEGER | `PRIMARY KEY`, `AUTOINCREMENT` | Unique identifier for each image. |
| `filename` | TEXT | `NOT NULL` | The name of the file (e.g., `image1.png`). |
| `path` | TEXT | `UNIQUE` | The relative or absolute path to the file. Used to prevent duplicate imports and pull thumbnails. |
| `file_hash` | TEXT | | A hash string used to identify physical file changes and prevent deduplication errors. |
| `metadata` | TEXT | | System stringified details (often EXIF data or basic properties). |
| `analysis` | TEXT | | The textual descriptions or AI-generated tagging output representing the visual content. |
| `created_at` | TEXT | `DEFAULT CURRENT_TIMESTAMP` | Automatically registers when the image record was created. |
| `updated_at` | TEXT | | Tracking for when the record was last altered via re-scan or analysis change. |
| `width` | INTEGER | | Source image's physical canvas width in pixels. |
| `height` | INTEGER | | Source image's physical canvas height in pixels. |
| `size` | INTEGER | | File storage size mapping (in bytes). |
| `mtime` | INTEGER | | The native filesystem 'Modified Time' for tracking file system updates. |

### 2. `image_facets`
A structured taxonomic table populated at lightning speed (~10–30ms/record) by either the **Laya Decision Engine** (via text analysis, port 8765) or the **Ovis-Omni Multimodal Engine** (via direct zero-shot raw image inference, port 8082).
- **Indices**: Dedicated B-Tree indices on `medium`, `mood`, and `composition` for instant faceted filtering.
- **Foreign Key**: `image_id` references `images(id)` with `ON DELETE CASCADE`.
- **Zero-Shot Direct Visual Classification**: Ovis-Omni enables classifying newly ingested images into these facets before running any generative text descriptions.

| Column | Type | Description |
| :--- | :--- | :--- |
| `image_id` | INTEGER PRIMARY KEY | 1:1 Foreign Key to `images.id`. |
| `medium` | TEXT | Visual category: `photography`, `three_dimensional_render`, `digital_art`, `traditional_art`, `sculpture_craft`, `diagram_typography`. |
| `mood` | TEXT | Emotional tone: `dark_and_moody`, `bright_and_vibrant`, `minimalist_serene`, `whimsical_playful`, `dramatic_cinematic`. |
| `composition` | TEXT | Framing: `close_up_macro`, `medium_shot`, `wide_establishing`, `birds_eye_aerial`, `worms_eye_low_angle`. |
| `detail_score` | REAL | Caption completeness score (0.0 to 1.0). |
| `confidence_medium` | REAL | Softmax confidence score for medium classification. |
| `confidence_mood` | REAL | Softmax confidence score for mood classification. |
| `confidence_composition` | REAL | Softmax confidence score for composition classification. |
| `updated_at` | TIMESTAMP | Last classification timestamp (`DEFAULT CURRENT_TIMESTAMP`). |

### 3. `image_clusters`
A lightweight relationship table representing unsupervised clustering assignments applied to the dataset via the EVoC algorithm. 
- **Management**: Automatically updated by the **"Run Map Analysis"** tool in the Settings page.
- **`image_id`** (`INTEGER PRIMARY KEY`): A 1:1 map directly back to `images.id`. 
- **`cluster_label`** (`INTEGER`): An assigned categorical grouping index (e.g., `0`, `1`, `2`) calculated by the EVoC clustering engine. `-1` represents noise/unclustered items.

### 4. `image_coordinates`
A specialized table managing the 2D floating-point visualization vectors utilized by your Data Map (`scope.html`/`scope.js` exports).
- **Management**: Automatically updated by the **"Run Map Analysis"** tool in the Settings page.
- **`image_id`** (`INTEGER PRIMARY KEY`): A 1:1 map directly back to `images.id`.
- **`x`** (`REAL`): The horizontal Cartesian projection coordinate generated via UMAP dimensionality reduction on embeddings.
- **`y`** (`REAL`): The vertical Cartesian projection coordinate.

### 5. `sqlite_sequence`
This table is an internal tracking mechanism automatically generated and maintained by the SQLite engine itself.
- It contains internal configuration (`name`, `seq`) specifically used to track the latest `AUTOINCREMENT` running integer on the `id` column for the `images` table. It does not contain user-facing data.
