# 🎨 Lumina - AI Image Analysis Studio

An Electron-based desktop application that uses local AI (via LM Studio) to analyze images, extract metadata, and build a searchable database of your visual content.

## 🚀 Quick Start

1.  **Launch LM Studio**: Ensure it's running on port `1234`.
2.  **Install & Run**:
    ```bash
    npm install
    npm start
    ```
3.  **Configure**: Go to **Settings ⚙️** and select your Vision and Embedding models.
4.  **Analyze**: Click "Choose Image" or "Load Folder" to begin your AI-powered library.

> **Ai Joke** 🤖  
> Why did the neural network become an artist?  
> Because it had so many *layers* to express!

---

## ✨ Features

- **AI-Powered Analysis**: Uses LM Studio's vision models (like Qwen-VL) to generate descriptions, detect objects, and tag images.
- **Customizable Prompts**: Choose from multiple analysis modes (Detailed, Cinematic, Video Summary) or define your own via `qwen_vl3_prompts.json`.
- **ComfyUI Integration**: Automatically extracts and displays ComfyUI workflow and prompt data from PNG metadata.
- **Improved Performance**: Infinite scroll and server-side pagination ensure fluid browsing even with thousands of images.
- **Semantic Search**: Go beyond keywords. Search for concepts ("peaceful morning", "cyberpunk vibe") using AI embeddings.
- **Advanced Fuzzy Search**: Typos? No problem. Find images instantly with weighted fuzzy matching.
- **Smart Filtering**: Filter search results by **Scene Type** (Indoor, Outdoor, Portrait, etc.) and **Date Range**.
- **Batch Processing**: Select multiple images to analyze efficiently. Use **"Select Missing"** to target unanalyzed content.
- **Configuration UI**: Easily manage your AI model preferences (Vision & Embeddings) directly from the new **Settings** page.
- **Automated Database Repair**: Prune missing records, regenerate deleted thumbnails, and heal broken data.
- **Inline Tag Management**: Edit, delete, and add tags directly from search results or the database browser via right-click.
- **High-Performance Text Rendering**: Uses [`@chenglou/pretext`](https://github.com/chenglou/pretext) for arithmetic-based text measurement, eliminating DOM reflows and layout shifts during infinite scroll.
- **Robust Thumbnailing**: Efficient **AVIF** thumbnail generation with automatic background regeneration for maximum visual fidelity and minimal file size.
- **Improved UI Layout**: Floating interactive elements (like the **Copy button**) positioned within flowing AI summary text for a cleaner, unified look.

---

## 🛠️ Setup

### Prerequisites

1. **Node.js** (v18 or higher)
2. **LM Studio** running locally (Port 1234)
   - **Vision Model**: (e.g., Qwen-VL, LLaVA) for analyzing images.
   - **Embedding Model**: (e.g., Nomic Embed Text) for Semantic Search.
3. **Python 3.12+** (Optional, for Latent Scope integration)

> **Why LM Studio?**  
> LM Studio makes it easy to run the latest AI models locally. Lumina connects to it automatically.

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
# Start the Electron app
npm start

# OR for development mode
npm run dev

# Start Latent Scope Server (Optional - for Map Page)
npm run ls:serve
```

> **Note**: Start LM Studio (Port 1234) *before* asking Lumina to analyze or embed images.

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
5.  **Rename Files**: Right-click any filename to rename it directly on disk and in the database.

### Searching

1.  Navigate to the **Search** page.
2.  **Semantic Search**: Toggle "Semantic Search" to find images by concept (requires Embeddings).
    - If needed, click **"Generate Data"** to build embeddings for your library.
3.  **Text Search**: Enter keywords to search descriptions, objects, and tags. **Fuzzy search** handles typos.
4.  **Fuzziness Control**: Use the slider to adjust search strictness.
    -   **Exact (0.0)**: Use for precise keyword matching.
    -   **Loose (0.6)**: Use to find related terms or handle significant typos.
5.  **Filters**:
    -   **Scene Type**: Filter by Indoor, Outdoor, Portrait, Landscape, Urban, Nature.
    -   **Date Range**: Restrict results to a specific timeframe.
6.  **Search Logic**: Toggle between **Match All (AND)** and **Match Any (OR)** logic.
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
├── config.json             # (New) User preferences for models
├── public/
│   ├── index.html          # Analysis page
│   ├── database.html       # Database browser
│   ├── search.html         # Search interface
│   ├── settings.html       # (New) Configuration UI
│   ├── app.js              # Main application logic
│   ├── search.js           # Search page logic
│   ├── search-worker.js    # (New) Worker for search & embeddings
│   ├── settings.js         # (New) Settings logic
│   ├── pretext-layout.js   # (New) Pretext measurement wrapper
│   ├── libs/               # Third-party libraries (Fuse.js, Pretext, etc.)
│   ├── style.css           # Global styles
│   └── thumbnails/         # Generated AVIF thumbnails
├── images.db               # SQLite database (auto-created)
└── package.json
```

---

## 🔧 Configuration

You can configure models via the **Settings UI** or by creating a `.env` file (advanced).

| Variable | Description |
|----------|-------------|
| `VISION_MODEL_ID` | Override for the Image Analysis model ID |
| `EMBEDDING_MODEL_ID` | Override for the Semantic Search model ID |
| `LM_STUDIO_URL` | Base URL for LM Studio (default: localhost:1234) |

**Customizing Prompts**: Modify `qwen_vl3_prompts.json` to add or edit the analysis strategies available in the dropdown menu.

---

## 📝 License

ISC

---

## 🙏 Acknowledgments

- [LM Studio](https://lmstudio.ai/) for local AI inference
- [Electron](https://www.electronjs.org/) for cross-platform desktop apps
- [Sharp](https://sharp.pixelplumbing.com/) for image processing
- [exifr](https://github.com/MikeKovarik/exifr) for metadata extraction
- [ComfyUI-QwenVL](https://github.com/1038lab/ComfyUI-QwenVL.git) for Qwen prompt strategies
- [Fuse.js](https://fusejs.io/) for powerful fuzzy search capabilities
- [Latent Scope](https://github.com/enjalot/latent-scope) for semantic visualization
