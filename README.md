# 🎨 Lumina - AI Image Analysis Studio

An Electron-based desktop application that uses local AI (via LM Studio) to analyze images, extract metadata, and build a searchable database of your visual content.

> **Ai Joke** 🤖  
> Why did the neural network become an artist?  
> Because it had so many *layers* to express!

---

## ✨ Features

- **AI-Powered Analysis**: Uses LM Studio's vision models (like Qwen-VL) to generate descriptions, detect objects, and tag images.
- **Customizable Prompts**: Choose from multiple analysis modes (Detailed, Cinematic, Video Summary) or define your own via `qwen_vl3_prompts.json`.
- **ComfyUI Integration**: Automatically extracts and displays ComfyUI workflow and prompt data from PNG metadata.
- **Improved Performance**: Infinite scroll and server-side pagination ensure fluid browsing even with thousands of images.
- **Advanced Fuzzy Search**: Typos? No problem. Find images instantly with weighted fuzzy matching (Fuse.js).
- **Smart Filtering**: Filter search results by **Scene Type** (Indoor, Outdoor, Portrait, etc.) and **Date Range**.
- **Batch Processing**: Select multiple images to analyze efficiently. Use **"Select Missing"** to target unanalyzed content.
- **Automated Database Repair**: Prune missing records, regenerate deleted thumbnails, and heal broken data.
- **Inline Tag Management**: Edit, delete, and add tags directly from search results or the database browser via right-click.
- **Robust Thumbnailing**: Efficient AVIF thumbnail generation with automatic background regeneration.

---

## 🛠️ Setup

### Prerequisites

1. **Node.js** (v18 or higher)
2. **LM Studio** running locally with a vision-capable model (e.g., Qwen-VL, LLaVA)
3. **Python 3.12+** (Optional, for Latent Scope integration)

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

# Start Latent Scope Server (Optional - for Map Page)
npm run ls:serve
```

> **Note**: Make sure LM Studio is running on port 1234 with a vision model loaded before starting analysis.

---

## 📖 Usage

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

1. Navigate to the **Database** page via the sidebar.
2. Browse all analyzed images with thumbnails.
3. **Batch Actions**: Use the sidebar to select images and run batch analysis (e.g., "Select Missing" -> "Process").
4. **Validate Database**: Click the 🛠️ button to scan for integrity issues.

### Searching

1. Navigate to the **Search** page.
2. **Text Search**: Enter keywords to search descriptions, objects, and tags. **Fuzzy search** handles typos.
3. **Filters**:
   - **Scene Type**: Filter by Indoor, Outdoor, Portrait, Landscape, Urban, Nature.
   - **Date Range**: Restrict results to a specific timeframe.
4. **Search Logic**: Toggle between **Match All (AND)** and **Match Any (OR)** logic.
5. **Inline Tag Management**: Right-click any tag/object to edit or delete it. Click `+` to add new tags.
6. **Results**: Results are automatically sorted by **Most Recently Updated** first.

### Tags & Objects

1. Click **Tags** to explore your metadata.
2. Toggle between **Tags** and **Objects** tabs.
3. Switch between **Cloud View** (visual) and **List View** (detailed).
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
├── qwen_vl3_prompts.json  # Config file for custom AI analysis prompts
├── public/
│   ├── index.html          # Analysis page
│   ├── database.html       # Database browser
│   ├── search.html         # Search interface
│   ├── app.js              # Main application logic
│   ├── search.js           # Search page logic
│   ├── style.css           # Global styles
│   └── thumbnails/         # Generated AVIF thumbnails
├── images.db               # SQLite database (auto-created)
└── package.json
```

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LM_STUDIO_URL` | `http://localhost:1234/v1/chat/completions` | LM Studio API endpoint |
| `PORT` | `3000` | Express server port |

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
