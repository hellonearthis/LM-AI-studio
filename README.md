# 🎨 Lumina - AI Image Analysis Studio

An Electron-based desktop application that uses local AI (via `llama-server.exe`) to analyze images, extract metadata, and build a searchable database of your visual content.

## 🚀 Quick Start

The fastest way to launch the entire studio with all AI services is via **`Start App.bat`**:

```bat
# Launches Vision (port 8080), Embeddings (port 8081), Laya (port 8765), and Electron:
Start App.bat
```

`Start App.bat` automatically probes each microservice and launches missing backends in separate command windows before booting the Electron app.

Alternatively, you can start services manually:
1. **Launch Local AI Servers**:
   - `start_llama_server.bat` (Multimodal Vision on port `8080`)
   - `start_llama_embeddings.bat` (Nomic Embeddings on port `8081`)
   - `start_laya_server.bat` (Laya Fast Classifier on port `8765`)
2. **Install & Run**:
   ```bash
   npm install
   npm start
   ```
3. **Configure**: Go to **Settings ⚙️** to review detected models or select custom model overrides.
4. **Analyze**: Click "Choose Image" or "Load Folder" to begin your AI-powered library.

> **Ai Joke** 🤖  
> Why did the neural network become an artist?  
> Because it had so many *layers* to express!

---

## 🦙 Local AI Inference: llama.cpp (`llama-server.exe`)

Lumina is powered directly by local inference through [`llama.cpp`](https://github.com/ggerganov/llama.cpp)'s high-performance `llama-server.exe`, decoupling the app from external dependencies or cloud APIs.

```mermaid
graph LR
    subgraph "LM AI Studio (Port 3000)"
        App["Electron / Express Backend"]
    end

    subgraph "llama.cpp Microservices"
        VisionServer["llama-server (Port 8080)<br/>Qwen 3.5 9B / 4B Multimodal<br/>--mmproj --flash-attn --reasoning off"]
        EmbedServer["llama-server (Port 8081)<br/>Nomic Embed Text v1.5<br/>--embedding -c 2048"]
    end

    App -->|Image Analysis (POST /v1/chat/completions)| VisionServer
    App -->|Vector Generation (POST /v1/embeddings)| EmbedServer
```

### 1. Multimodal Vision Server (Port `8080`)
- **Default Launcher**: `start_llama_server.bat`
- **Default Model**: **Qwen 3.5 9B** (`Qwen3.5-9B-Q4_K_M.gguf`) paired with multimodal projector (`mmproj-Qwen3.5-9B-BF16.gguf`).
- **Low-VRAM Alternative**: `start_llama_vision_4b.bat` runs **Qwen3-VL-4B Instruct** requiring only ~2.5 GB VRAM for background tasks or smaller GPUs.
- **Key Flags & Optimizations**:
  - `-ngl 99`: Full GPU layer offloading for maximum throughput.
  - `--flash-attn on`: Flash Attention enabled for reduced memory bandwidth.
  - `--reasoning off` and `--reasoning-budget 0`: Strips internal hidden reasoning tokens (`<think>...</think>`), avoiding 1,200+ wasted tokens and dropping latency from ~45 seconds down to **~1.4 seconds**.
  - **Sharp Pre-Processing**: The backend automatically downscales ultra-high-resolution images (clamped to max 1344×1344) prior to submission, reducing vision token consumption from 4,200+ tokens to ~1,000 tokens while preserving visual fidelity.

### 2. Dedicated Text Embeddings Server (Port `8081`)
- **Launcher**: `start_llama_embeddings.bat`
- **Model**: **Nomic Embed Text v1.5** (`nomic-embed-text-v1.5.f16.gguf`) with `--embedding` mode enabled.
- **Role**: Computes dense 768-dimensional vector representations of image descriptions, summaries, and search queries.
- **Integration**: Powers **Semantic Search**, **Hybrid RRF (Reciprocal Rank Fusion)** search, and **EVoC / Latent Scope** dimensionality reduction.

---

## ⚡ Fast Classifier & Decision Engine: Laya

Lumina integrates [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya), a non-autoregressive System 1 decision engine based on **ModernBERT**.

```mermaid
graph LR
    subgraph "Lumina Core"
        Express["Express Backend"]
        SearchUI["Search Interface"]
    end

    subgraph "Laya Decision Microservice (Port 8765)"
        LayaEngine["ModernBERT Decision Engine<br/>FastAPI / CUDA"]
    end

    subgraph "SQLite Persistence"
        DB[("images.db<br/>image_facets table")]
    end

    Express -->|Batch Classification (~10ms/record)| LayaEngine
    LayaEngine -->|Medium, Mood, Framing, Score| DB
    SearchUI -->|Query Intent Analysis| LayaEngine
```

- **Launcher**: `start_laya_server.bat` (runs Uvicorn on `http://127.0.0.1:8765`).
- **Ultra-Fast Speed**: Operates at **~5–15ms per classification** — over 100× faster than generative LLMs.
- **Taxonomic Image Facet Tagging**:
  Laya evaluates four core dimensions and saves them to the `image_facets` table:
  1. **Visual Medium**: Photography, 3D CGI render, digital art, traditional art, sculpture/craft, or diagram/typography.
  2. **Visual Mood**: Dark & moody, bright & vibrant, minimalist & serene, whimsical & playful, or dramatic & cinematic.
  3. **Composition & Framing**: Close-up macro, medium shot, wide establishing, bird's eye aerial, or worm's eye low angle.
  4. **Caption Completeness**: Continuous score (0.0 to 1.0) evaluating how thoroughly the visual prompt was answered.
- **Search Query Intent Routing (`/api/laya/query-intent`)**:
  When users submit queries, Laya parses semantic intent in real time, detecting whether the user is querying a style, medium, emotional tone, or specific subject, and dynamically tunes search scoring.
- **EVoC Cluster Theming**:
  Categorizes unsupervised UMAP coordinate clusters into human-readable thematic categories for the Data Map.

## ✨ Features

- **Unified Lumina Navigation**: A consistent sidebar architecture across all pages (**Analysis, Database, Search, Tags, Map, Settings**).
- **Model Selection & Status**: Switch between different Vision models (Qwen, Gemma-4, etc.) in Settings. Monitor real-time status (**🟢 Loaded**, **⚪ Standby**) directly in the sidebar on any page.
- **Enhanced Data Filtering**: Use the **Data Status** filter to find images missing tags, objects, summary, or scene badges.
- **Automatic Tag Cleaning**: System automatically strips brackets `[] () {}` and deduplicates tags/objects for a cleaner library.
- **Model-Specific Optimization**: Automatically uses optimized prompt strategies for different model architectures (e.g., Qwen vs. Gemma-4) to prevent hallucinations and loops.
- **ComfyUI Integration**: Automatically extracts and displays ComfyUI workflow and prompt data from PNG metadata.
- **Tag & Object Filter System**: A dedicated pre-filtering layer with autocomplete. Select multiple exact tags or objects as 'bubbles' to refine your search before keywords are even applied.
- **Find Similar Discovery**: Right-click any image or tag to instantly find related content. Uses a specialized similarity engine to match tags, objects, and descriptions.
- **Improved Performance**: High-speed initialization and optimized infinite scroll (with rendering locks) ensure fluid browsing and no duplicate images even with thousands of results.
- **Semantic Search**: Go beyond keywords. Search for concepts ("peaceful morning", "cyberpunk vibe") using AI embeddings.
- **Hybrid RRF Search**: Combines keyword and semantic results using **Reciprocal Rank Fusion** — inspired by [Exa's Canon architecture](https://exa.ai/blog/composing-a-search-engine). Best of both worlds: exact matches *and* conceptual understanding in a single ranked list.
- **Advanced Fuzzy Search**: Typos? No problem. Find images instantly with weighted fuzzy matching.
- **Smart Filtering**: Filter search results by **Scene Type** (Indoor, Outdoor, Portrait, etc.) and **Date Range**.
- **Batch Processing**: Select multiple images to analyze efficiently. Use **"Select Missing"** to target unanalyzed content.
- **Bulk Rename & Re-Indexing**: Select a batch of files and rename them using a shared base name (e.g., `coffee`). The system includes a **Recent Renames** dropdown to quickly reuse previous naming schemes, automatically fills gaps in existing sequences, and ensures no numerical collisions across different file extensions.
- **Configuration UI**: Easily manage your AI model preferences (Vision & Embeddings) directly from the **Settings** page.
- **Automated Database Repair**: Prune missing records, regenerate deleted thumbnails, and heal broken data.
- **Inline Tag Management**: Edit, delete, and add tags directly from search results or the database browser via right-click.
- **Intelligent Image Loading (🚀 New!)**: Optimized for Largest Contentful Paint (LCP). The first few images of any view use `eager` loading and `high` fetch priority to appear instantly, while subsequent content uses `lazy` loading and `async` decoding to maintain smooth scrolling and save bandwidth.
- **Stable Row-by-Row CSS Grid Layout**: Both Search and Database views use native CSS Grid with flex column stretching. Cards flow stably row-by-row without odd column shifting, jumping, or flickering during batch loading and infinite scrolling.
- **Persistent Text Rendering**: Fully integrated with [`@chenglou/pretext`](https://github.com/chenglou/pretext) for arithmetic-based text measurement. This ensures pixel-perfect card heights and eliminates layout shifts during infinite scroll by pre-calculating the summary height before the card is even rendered.
- **Tag Discovery Row**: A new, horizontal "Discover Tags & Objects" row on the Search page. Features horizontal chip clouds for rapid browsing and a **toggleable visibility** state that persists across sessions.
- **Robust Thumbnailing**: Efficient **AVIF** thumbnail generation with automatic background regeneration for maximum visual fidelity and minimal file size.
- **Improved UI Layout**: Floating interactive elements (like the **Copy button**) positioned within flowing AI summary text for a cleaner, unified look.

---

## 🛠️ Setup

### Prerequisites

1. **Node.js** (v18 or higher)
2. **Local AI Server**:
   * **llama-server.exe** (Default port `8080`, PR #26508 standard `9931`) with `--mmproj` projector for multimodal vision.
   - **Vision Model**: (e.g., Qwen 3.5 VL) for analyzing images.
   - **Embedding Model**: (e.g., Nomic Embed Text) for Semantic Search.
3. **Python 3.12+** (Optional, for Latent Scope integration)

> **Dynamic Server Discovery:**  
> Lumina automatically probes `llama-server` on ports `8080` and `9931`, checking model capabilities for vision (`multimodal`) and embeddings without requiring hardcoded configuration.

### Installation

```bash
# Clone the repository
git clone https://github.com/hellonearthis/LM-AI-studio.git
cd LM-AI-studio

# Install Node dependencies
npm install

# Setup Latent Scope (Python venv)   <<<<<<<   Optional  for latent Scope  >>>>>>>
npm run ls:setup
```

### Running the App

```bash
# 1. Start your local AI server (1-click launcher for llama-server)
start_llama_server.bat

# 2. Start the Electron app
npm start

# OR for development mode
npm run dev

# Start Latent Scope Server (Optional - for Map Page)
npm run ls:serve
```

> **Note**: Ensure `llama-server.exe` (port 8080) is running before analyzing or embedding images.

## ⚙️ How it Works (Automation)
The project uses a custom automation system to keep the frontend high-performance and lightweight:
- **Dependency Sync**: Instead of manually managing frontend libraries, the app uses a `postinstall` script (`scripts/sync_libs.js`) to automatically copy required vendor files (Fuse.js, D3, etc.) from `node_modules` into `public/libs` every time you run `npm install`.
- **Zero-Bundler Design**: This ensures the Electron app remains simple and human-readable while still benefiting from modern NPM version management.

---

## 📖 Usage

### Configuration (New!)
Navigate to the **Settings ⚙️** page to select your AI models.
- **Vision Model**: Used for analyzing text descriptions from images.
- **Embedding Model**: Used for enabling "Semantic Search" capabilities.
- *Selections are saved locally and persist across restarts.*

### Analyzing Single Images

1. Click **"Choose Image"** to open the file picker.
2. Select your preferred **Analysis Mode** (e.g., Detailed Description, Cinematic, Video Summary) or define custom keyphrases.
3. Select one or more images (PNG, JPG, WEBP supported).
4. Wait for the AI analysis to complete. Results (Summary, Objects, Tags) will appear automatically.

### Batch Processing Folders

1. Click **"Load Folder"** to select a directory.
2. The app will scan for all images and process them sequentially.
3. Progress is shown in the sidebar with counts for added/updated/existing/errors.

### Viewing the Database

1.  Navigate to the **Database** page via the sidebar.
2.  Browse all analyzed images with thumbnails.
3.  **Batch Actions**: Use the sidebar to select images and run batch analysis (e.g., "Select Missing" -> "Process").
4.  **Validate Database**: Click the 🛠️ button to scan for integrity issues (deduplication, missing metadata, regeneration).
5.  **Rename Files**: Right-click any filename to rename it directly on disk, or use the **"Bulk Rename"** button to re-index an entire selection.
    - **Recent Renames**: A quick-access dropdown allows you to instantly reuse your most frequent naming conventions.
    - **Gap Filling**: If your folder has `img_001` and `img_003`, the renamer will automatically find and fill `img_002` first.
    - **Cross-Extension Safety**: The system prevents number collisions even if you mix `.jpg`, `.png`, and `.webp` files.
6.  **Find Similar**: Right-click any thumbnail or tag to launch a discovery search for visually and conceptually related images.

### Searching

1.  **Unified Batch Actions**: The sidebar now provides consistent controls for **Selective Re-Analysis**, **Bulk Renaming**, and **Integrity Checks** across both the Database and Search views.
2.  **Tag & Object Filters**: Use the specialized filter input to select exact tags or objects. 
    - **Autocomplete**: Start typing to see suggestions from your entire library.
    - **Filter Chips**: Selected items appear as removable bubbles.
    - **Search Logic**: Toggle between **Match All (AND)** and **Match Any (OR)** to refine how multiple filters interact.
3.  **Find Similar**: Use the right-click menu to enter "Discovery Mode" for a specific image. Click the banner to reset the search.
4.  **Semantic Search**: Toggle "Semantic" to find images by concept (requires Embeddings).
    - If needed, click **"Generate Data"** to build embeddings for your library.
    - Uses a **text embedding model** via `llama-server` (e.g. `nomic-embed-text-v1.5`). The model is resolved by priority: Settings config → `.env` variable → auto-detect.
    - The status line below the button shows the embedding count, file size, and last updated date.
    - Embeddings are also reused by the **EVoC pipeline** (Settings → Run Map Analysis) for clustering and the Data Map visualization.
5.  **Hybrid Search (⚡ New!)**: When embeddings are available, Hybrid mode is auto-selected. It runs keyword *and* semantic search simultaneously, then merges results using **Reciprocal Rank Fusion (RRF)** for the best of both worlds.
6.  **Text Search**: Enter keywords to search descriptions and filenames. This works *alongside* your active tag filters for multi-layered discovery.
6.  **Fuzziness Control**: Use the slider to adjust search strictness.
    -   **Exact (0.0)**: Use for precise keyword matching.
    -   **Loose (0.6)**: Use to find related terms or handle significant typos.
7.  **Filters**:
    -   **Scene Type**: Filter by Indoor, Outdoor, Portrait, Landscape, Urban, Nature.
    -   **Date Range**: Restrict results to a specific timeframe.
7.  **Inline Tag Management**: Right-click any tag/object to edit or delete it. Click `+` to add new tags (supports comma-separated multiple tags).
8.  **Results**: Results are automatically sorted by **Most Recently Updated** first.

### Tags & Objects

1. Navigate to the **Tags** page to see a frequency cloud of all extracted metadata.
2. Click any tag to start a search for it.
3. Use the **Discovery** tab to find related concepts.
4. Sort by frequency or **alphabetical order** with A-Z navigation.

### Data Map (Latent Scope)

1. Ensure the visualization server is running: `npm run ls:serve`
2. Go to the **Map (β)** page.
3. Click **Sync Data** to export your latest database.
4. Explore semantic clusters of your image library.

---

## 🗂️ Project Structure

```
LM-AI-studio/
├── main.js                 # Electron main process
├── preload.cjs             # Electron preload script
├── server.js               # Express backend + SQLite database
├── qwen_vl3_prompts.json   # Config file for custom AI analysis prompts
├── config.json             # User preferences for models
├── public/
│   ├── index.html          # Analysis page
│   ├── database.html       # Database browser
│   ├── search.html         # Search interface
│   ├── settings.html       # Configuration UI
│   ├── app.js              # Main application logic
│   ├── search.js           # Search page logic
│   ├── search-worker.js    # Worker for search & embeddings
│   ├── settings.js         # Settings logic
│   ├── pretext-layout.js   # Pretext measurement wrapper
│   ├── libs/               # Auto-generated third-party libraries (sync via npm)
│   ├── style.css           # Global styles
│   └── thumbnails/         # Generated AVIF thumbnails
├── scripts/
│   ├── sync_libs.js        # Automated script to sync NPM libs to public/libs
│   └── serve_ls.bat        # Helper to launch Latent Scope
├── images.db               # SQLite database (auto-created)
└── package.json
```

---

## 🔧 Configuration & Microservices

You can configure models via the **Settings UI** or by creating a `.env` file (advanced).

| Variable | Default Port / URL | Description |
|----------|--------------------|-------------|
| `LOCAL_AI_URL` | `http://127.0.0.1:8080` | Base URL for the multimodal vision `llama-server.exe` |
| `EMBEDDING_SERVER_URL` | `http://127.0.0.1:8081` | Base URL for the text embeddings `llama-server.exe` |
| `LAYA_SERVER_URL` | `http://127.0.0.1:8765` | Base URL for the Laya ModernBERT fast classifier microservice |
| `VISION_MODEL_ID` | `qwen3.5-9b` | Model alias/ID for multimodal image analysis |
| `EMBEDDING_MODEL_ID` | `nomic-embed-text-v1.5` | Model alias/ID for 768-dim semantic search embeddings |

**Customizing Prompts**: Modify `qwen_vl3_prompts.json` to add or edit the analysis strategies available in the dropdown menu.

---

## 📦 Building for Windows

Lumina is configured with `electron-builder` to package the app into a standalone Windows installer (`.exe`). This process handles natively compiling dependencies like `better-sqlite3` and `sharp` so they run outside of the development environment.

To generate the setup file:
```bash
npm run build
```
Once complete, the installer will be located in the automatically created `dist/` folder.

---

## 📝 License

ISC

---

## 🙏 Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) for high-performance, GPU-accelerated local AI inference
- [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya) for high-speed ModernBERT decision engine & classification
- [Electron](https://www.electronjs.org/) for cross-platform desktop apps
- [Sharp](https://sharp.pixelplumbing.com/) for high-speed image processing & AVIF compression
- [exifr](https://github.com/MikeKovarik/exifr) for camera metadata extraction
- [ComfyUI-QwenVL](https://github.com/1038lab/ComfyUI-QwenVL.git) for prompt strategies
- [Fuse.js](https://fusejs.io/) for client-side fuzzy search
- [Latent Scope](https://github.com/enjalot/latent-scope) for semantic cluster map visualization
