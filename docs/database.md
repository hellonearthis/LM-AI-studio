# Database Page (`database.html`)

The Database page serves as the central hub for managing your collection of analyzed images. It provides a grid view of your library with powerful batch processing and management tools.

## Key Features

- **Image Grid**: Displays all analyzed images with thumbnails.
- **Batch Actions**:
  - **Select Missing**: Automatically selects images that are missing specific analysis data.
  - **Process Selected**: triggers analysis for all currently selected items using the sidebar configuration.
  - **Prompt Selection**: Choose the specific analysis type for batch processing.

- **Management Tools**:
  - **Integrity Check**: Scans the database for consistency and valid file paths.
  - **Context Menu**: Right-click on any image to:
    - *Regenerate Thumbnail*: Re-create the thumbnail image.
    - *Edit Tag/Object*: Modify associated metadata.
    - *Delete Tag/Object*: Remove specific metadata.
    - *Rename File*: Rename the physical file and update the database record.

- **Sidebar Information**:
  - Displays the total count of images in the database.
  - Shows validation status and progress for integrity checks.

## Usage

1. **View Library**: Scroll through the grid to view your analyzed images.
2. **Batch Process**:
   - Select a prompt type from the sidebar.
   - Click "Select Missing" to find incomplete entries.
   - Click "Process" to run the analysis on selected items.
3. **Manage Files**: Right-click an image to access management options like renaming or regenerating thumbnails.
