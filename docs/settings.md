# Settings Page (`settings.html`)

The Settings page allows you to configure the core behavior of the application, specifically the integration with LM Studio and other system preferences.

## Key Features

- **LM Studio Integration**:
  - **Refresh Models**: Reloads the list of available models from the connected LM Studio instance.
  - **Vision Model**: Select the specific model to use for image analysis and descriptions (e.g., Qwen-VL, Llava).
  - **Embedding Model**: Select the model used for generating semantic embeddings (e.g., Nomic, Bert).
  - **Auto-detect**: Both model selectors support an "Auto-detect" option for easier configuration.

- **Diagnostics**:
  - Displays current configuration and connection status for troubleshooting.

## Usage

1. **Connect**: Ensure LM Studio is running and the server is accessible.
2. **Refresh**: Click "Refresh Models" to fetch the currently loaded models.
3. **Select Models**: Choose your preferred Vision and Embedding models, or leave them on "Auto-detect".
4. **Save**: Click "Save Changes" to apply your configuration.
