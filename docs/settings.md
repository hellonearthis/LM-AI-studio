# Settings Page (`settings.html`)

The Settings page allows you to configure the core behavior of the application, manage connections to local AI microservices (`llama-server.exe` and Laya), and run map analysis pipelines.

## Key Features

- **Local AI Microservices (`llama.cpp`)**:
  - **Vision Model (Port 8080)**: Choose the active multimodal vision model used to analyze and describe images (e.g., Qwen 3.5 9B or Qwen3-VL-4B).
  - **Embedding Model (Port 8081)**: Choose the model used to convert text and visual descriptions into 768-dimensional vectors for Semantic and Hybrid Search (e.g., `nomic-embed-text-v1.5`).
  - **Connectivity Status**: Real-time status indicators show whether servers are **🟢 Online/Loaded** or **⚪ Offline/Standby**.
  - **Auto-detect**: Automatically discovers available models from the running `llama-server` instances.

- **Laya Decision Engine (Port 8765)**:
  - Probes the status of the ModernBERT fast classifier microservice.
  - Enables sub-15ms multi-faceted image tagging and query intent routing.

- **Data Map Analysis (EVoC Pipeline)**:
  - **Run Map Analysis**: Triggers unsupervised clustering and UMAP 2D projection using existing embeddings.
  - Synchronizes cluster coordinates and thematic labels for the Data Map visualization.

- **Diagnostics**:
  - Displays resolved model IDs, configuration sources (Settings, ENV, or Auto-detect), and endpoint URLs for troubleshooting.

## Usage

1. **Verify Services**: Ensure `Start App.bat` has initialized the Vision (8080), Embeddings (8081), and Laya (8765) servers.
2. **Refresh**: Click "Refresh Models" to probe connected services.
3. **Select Models**: Pick custom model overrides or keep "Auto-detect".
4. **Save**: Click "Save Changes" to persist preferences in `config.json`.
