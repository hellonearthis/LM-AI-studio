# 🎨 Lumina - AI Image Analysis Studio

An Electron-based desktop application that uses local AI (via LM Studio) to analyze images, extract metadata, and build a searchable database of your visual content.

> **Ai Joke** 🤖  
> Why did the neural network become an artist?  
> Because it had so many *layers* to express!

---

## ✨ Features

- **AI-Powered Analysis**: Uses LM Studio's vision models to generate descriptions, detect objects, and tag images. Supports **AVIF, WebP, and PNG** formats via automatic conversion to JPEG.
- **ComfyUI Integration**: Automatically extracts and displays ComfyUI workflow and prompt data from PNG metadata.
- **Improved Performance**: Infinite scroll and server-side pagination ensure fluid browsing even with thousands of images.
- **Advanced Fuzzy Search**: Typos? No problem. Find images instantly with weighted fuzzy matching (Fuse.js).
- **Automated Database Repair**: Prune missing records, regenerate deleted thumbnails, and **optionally re-analyze images** with missing AI data.
- **Inline Tag Management**: Edit, delete, and add tags directly from search results or the database browser via right-click.
- **Robust Thumbnailing**: Efficient AVIF thumbnail generation with automatic background regeneration for existing records.

---

## 🛠️ Setup

### Prerequisites

1. **Node.js** (v18 or higher)
2. **LM Studio** running locally with a vision-capable model (e.g., LLaVA, Qwen-VL)
3. **Python 3.12+** (for Latent Scope integration)

> **Why LM Studio?**  
> LM Studio makes it easy to run the latest AI vision-to-text models locally. New models can be downloaded and swapped in without changing any code—just load a compatible vision model and start analyzing!

### Installation

```bash
# Clone the repository
git clone https://github.com/hellonearthis/LM-AI-studio.git
cd LM-AI-studio

# Install Node dependencies
npm install

# Setup Latent Scope (Python venv)   <<<<<<<   Optional  for latent Scope  >>>>>>>
npm run ls:setup

# Create a .env file (optional)
echo "LM_STUDIO_URL=http://localhost:1234/v1/chat/completions" > .env
```

### Running the App

```bash
# Start the Electron app
npm start

# OR for development mode
npm run dev

# Start Latent Scope Server (Required for Map Page)  <<<<<<<   Optional    >>>>>>>
npm run ls:serve
```

> **Note**: Make sure LM Studio is running on port 1234 with a vision model loaded before starting the app.

---

## 📖 Usage

### Analyzing Single Images

1. Click **"Choose Image"** to open the file picker
2. Select one or more images (PNG, JPG, WEBP supported)
3. Wait for the AI analysis to complete
4. View the results: Summary, Objects, Tags, and Metadata

### Batch Processing Folders

1. Click **"Load Folder"** to select a directory
2. The app will scan for all images and process them sequentially
3. Progress is shown in the sidebar with counts for added/updated/existing/errors:
   - **Added**: New image files not previously in the database.
   - **Updated**: Files found in the database (by path) but with changed content (hash mismatch) or new metadata.
   - **Existing**: Identical files (same path and hash) that required no changes.

### Viewing the Database

1. Navigate to the **Database** page via the sidebar
2. Browse all analyzed images with thumbnails
3. Click on a filename to reveal the file in Explorer
4. Use the preview button to view the full image
5. **Validate Database**: Click the 🛠️ button to scan for missing files, prune dead records, and heal broken thumbnails

### Searching

1. Navigate to the **Search** page
2. Enter keywords to search descriptions. **Fuzzy search** handles typos (e.g., "ocian" finds "ocean")
3. **Weighted Results**: Matches in object lists and tags rank higher than general descriptions
4. **Toggle AND/OR mode**: Use the switch to match ALL terms or ANY term
5. Filter by tags or scene type
6. Set date ranges to narrow results
7. **Right-click tags** to edit or delete them inline
8. Click the **+** button to add new tags to any image
9. **Click any filename** to open it in your file explorer
10. **Paginated Results**: Large result sets are loaded in batches as you scroll for continuous performance

### Tags & Objects

1. Click **Tags** to explore your metadata
2. Toggle between **Tags** and **Objects** tabs
3. Switch between **Cloud View** (visual) and **List View** (detailed)
4. Sort by frequency or **alphabetical order** with A-Z navigation links
5. Click any letter to jump directly to that section

### Data Map (Latent Scope)

1. Ensure the visualization server is running: `npm run ls:serve`
2. Go to the **Map (β)** page
3. Click **Sync Data** to export your latest database to the map
4. Interact with the embedded map or click **Open in Browser** for a full-screen experience
5. Discover semantic clusters and relationships in your image library

---

## 🗂️ Project Structure

```
LM-AI-studio/
├── main.js           # Electron main process
├── preload.cjs       # Electron preload script (IPC bridge)
├── server.js         # Express backend + SQLite database
├── public/
│   ├── index.html    # Analysis page
│   ├── database.html # Database browser
│   ├── search.html   # Search interface
│   ├── app.js        # Main application logic
│   ├── database.js   # Database page logic
│   ├── search.js     # Search page logic
│   ├── style.css     # Global styles
│   └── thumbnails/   # Generated AVIF thumbnails
├── images.db         # SQLite database (auto-created)
└── package.json
```

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LM_STUDIO_URL` | `http://localhost:1234/v1/chat/completions` | LM Studio API endpoint |
| `PORT` | `3000` | Express server port |

---

## 📝 License

ISC

---

## 🙏 Acknowledgments

- [LM Studio](https://lmstudio.ai/) for local AI inference
- [Electron](https://www.electronjs.org/) for cross-platform desktop apps
- [Sharp](https://sharp.pixelplumbing.com/) for image processing
- [exifr](https://github.com/MikeKovarik/exifr) for metadata extraction
- [Fuse.js](https://fusejs.io/) for powerful fuzzy search capabilities
- [Latent Scope](https://github.com/enjalot/latent-scope) by enjalot for semantic visualization
