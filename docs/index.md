# Analysis Page (`index.html`)

The Analysis page is the primary entry point for **Lumina - AI Image Analysis Studio**. It allows users to upload images, configure analysis parameters, and view real-time results.

## Key Features

- **Image Upload**:
  - **Single/Multiple Images**: Select specific files for analysis.
  - **Folder Upload**: Process entire directories of images at once.

- **Analysis Configuration**:
  - **AI Analysis Mode**: Choose the level of detail for image descriptions (e.g., Detailed Analysis, Cinematic, Video Summary).
  - **Model-Specific Optimization**: The system automatically detects your active Vision Model (selected in Settings) and applies optimized prompting strategies (e.g., Qwen-specific vs. Gemma-specific) to ensure high-quality, formatted results without loops or hallucinations.
  - **Custom Tags**: Add user-defined tags that will be applied to all processed images in the current batch.

- **Status & Progress**:
  - Real-time progress bar showing percentage completion.
  - Sidebar status indicators tracking processed, added, updated, existing, and error counts.

- **Interactive Results**:
  - **Floating Copy Button**: AI summaries feature an inline interactive "Copy" button that flows with the text for efficient access.
  - **Inline Tag Management**: Edit or delete tags and objects directly by right-clicking on specific items.

- **Results Display**:
  - **Preview**: Shows the currently analyzed image.
  - **Metadata**: Displays extracted file information.
  - **AI Analysis**: Shows the generated description and insights.

## Usage

1. **Select Mode**: Choose your desired AI Analysis Mode from the dropdown.
2. **Add Tags (Optional)**: Enter any custom tags relative to the batch.
3. **Load Images**: Click "Choose Image" for specific files or "Load Folder" for a directory.
4. **Monitor Progress**: Watch the progress bar and status area for updates.
