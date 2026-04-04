# Settings Page (`settings.html`)

The Settings page allows you to configure the core behavior of the application, specifically the integration with LM Studio and other system preferences.

## Key Features

- **LM Studio Integration**:
  - **Refresh Models**: Reloads the list of available models from the connected LM Studio instance.
  - **Vision Model**: Choose the AI model used to "see" and describe your images (e.g., Qwen-VL, Gemma-4).
  - **Connectivity Status**: The system monitors the model's load state in LM Studio. Indicators in the Search sidebar show if it is **🟢 Loaded** or **⚪ Ready to Load**.
  - **Embedding Model**: Choose the model used to convert text and image concepts into vectors for "Semantic Search".
  - **Auto-detect**: Intelligent fallback that picks the best available model if no specific selection is made.

- **Diagnostics**:
  - Displays current configuration and connection status for troubleshooting.

## Usage

1. **Connect**: Ensure LM Studio is running and the server is accessible.
2. **Refresh**: Click "Refresh Models" to fetch the currently loaded models.
3. **Select Models**: Choose your preferred Vision and Embedding models, or leave them on "Auto-detect".
4. **Save**: Click "Save Changes" to apply your configuration.
