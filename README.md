# 🎨 Lumina - AI Image Analysis Studio

An Electron-based desktop application that uses local AI (via LM Studio) to analyze images, extract metadata, and build a searchable database of your visual content.

> **Dad Joke Corner** 🤖  
> Why did the AI artist get kicked out of the gallery?  
> Because every time someone asked about the artwork, it just kept saying "I made this up!"

---

## ✨ Features

- **AI-Powered Analysis**: Uses LM Studio's vision models to generate descriptions, detect objects, and tag images
- **ComfyUI Integration**: Automatically extracts and displays ComfyUI workflow and prompt data from PNG metadata
- **Smart Duplicate Detection**: Content-based hashing prevents duplicates while allowing metadata updates
- **Batch Processing**: Process entire folders of images at once
- **Searchable Database**: Find images by tags, scene type, date, or text search
- **AVIF Thumbnails**: Efficient 80x80 thumbnail generation for fast browsing

---

## 🛠️ Setup

### Prerequisites

1. **Node.js** (v18 or higher)
2. **LM Studio** running locally with a vision-capable model (e.g., LLaVA, Qwen-VL)

### Installation

```bash
# Clone the repository
git clone https://github.com/hellonearthis/LM-AI-studio.git
cd LM-AI-studio

# Install dependencies
npm install

# Create a .env file (optional)
echo "LM_STUDIO_URL=http://localhost:1234/v1/chat/completions" > .env
```

### Running the App

```bash
# Start the Electron app
npm start

# Or for development mode
npm run dev
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
3. Progress is shown in the sidebar with counts for added/updated/existing/errors

### Viewing the Database

1. Navigate to the **Database** page via the sidebar
2. Browse all analyzed images with thumbnails
3. Click on a filename to reveal the file in Explorer
4. Use the preview button to view the full image

### Searching

1. Navigate to the **Search** page
2. Enter keywords to search descriptions
3. Filter by tags or scene type
4. Set date ranges to narrow results

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
