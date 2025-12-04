// ============================================================================
// IMAGE ANALYSIS STUDIO - DATABASE VIEWER
// ============================================================================
// This file handles loading and displaying saved image analyses from the
// database, including thumbnails, metadata, and AI analysis results.

// ============================================================================
// DOM ELEMENT REFERENCES
// ============================================================================
const dbGrid = document.getElementById('dbGrid');
const loadingDb = document.getElementById('loadingDb');

// ============================================================================
// MAIN FUNCTION - LOAD DATABASE
// ============================================================================
const API_BASE_URL = 'http://localhost:3000';

// Fetches all saved images from the database and displays them in a grid
async function loadDatabase() {
    try {
        // Fetch all images from the server
        const response = await fetch(`${API_BASE_URL}/images`);
        if (!response.ok) throw new Error('Failed to fetch images');

        const images = await response.json();
        loadingDb.style.display = 'none';

        // Update the entry count in the header
        const dbCount = document.getElementById('dbCount');
        if (dbCount) dbCount.textContent = images.length;

        // Handle empty database case
        if (images.length === 0) {
            dbGrid.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No images saved yet.</p>';
            return;
        }

        // ====================================================================
        // RENDER IMAGE CARDS
        // ====================================================================
        // Build HTML for each image entry
        dbGrid.innerHTML = images.map(img => {
            // Parse stored JSON data
            const analysis = JSON.parse(img.analysis || '{}');
            const metadata = JSON.parse(img.metadata || '{}');
            const date = new Date(img.created_at).toLocaleDateString();

            // Extract key metadata fields for display
            const width = metadata.ImageWidth || metadata.ExifImageWidth || metadata.PixelXDimension || 'N/A';
            const height = metadata.ImageHeight || metadata.ExifImageHeight || metadata.PixelYDimension || 'N/A';

            // ----------------------------------------------------------------
            // DETERMINE THUMBNAIL PATH
            // ----------------------------------------------------------------
            // If the path already ends in .avif, use it directly
            // Otherwise, construct the path assuming a .avif thumbnail exists
            let displayPath;
            if (img.path && img.path.endsWith('.avif')) {
                displayPath = img.path.includes('thumbnails/') ? img.path : `thumbnails/${img.path}`;
            } else {
                // Assume the thumbnail exists with the same name but .avif extension
                const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
                displayPath = `thumbnails/${filenameBase}.avif`;
            }

            const fullPath = img.path;

            // ----------------------------------------------------------------
            // BUILD CARD HTML
            // ----------------------------------------------------------------
            return `
                <div class="card" data-id="${img.id}">
                    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
                        <!--Thumbnail Image -->
                        <img src="${displayPath}" 
                             data-fullpath="${fullPath}"
                             class="thumbnail-preview"
                             onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                             style="width: 100px; height: 100px; object-fit: cover; border-radius: 6px; cursor: pointer;"
                             title="Click to view full size">
                        <!-- Fallback for missing thumbnail -->
                        <div style="display: none; width: 100px; height: 100px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; align-items: center; justify-content: center; font-size: 0.7rem; color: var(--text-secondary); text-align: center; padding: 0.5rem;">
                            No Preview
                        </div>
                        <!-- Image Info -->
                        <div style="flex: 1;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1; min-width: 0;">
                                    <h2 class="file-link" data-path="${img.path}" style="margin: 0; border: none; font-size: 1.1rem; cursor: pointer; color: var(--accent); text-decoration: none;" title="Click to show in folder">${img.filename}</h2>
                                    <small style="color: var(--text-secondary);">${date} • ${width}w ${height}h</small>
                                </div>
                                <div style="display: flex; gap: 0.5rem; align-items: flex-start;">
                                    <button class="delete-btn" data-id="${img.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.2s;">X</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- AI Summary Section -->
                    <div class="analysis-section">
                        <h3 style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">AI Summary</h3>
                        <p style="margin: 0;">${analysis.summary || 'No summary'}</p>
                    </div>

                    <!-- Tags Section -->
                    <div class="tags-container">
                        ${(analysis.tags || []).map(tag => `<span class="tag">#${tag}</span>`).join('')}
                        ${analysis.scene_type ? `<span class="tag" style="background-color: rgba(129, 140, 248, 0.2); color: #818cf8;">${analysis.scene_type}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        // ====================================================================
        // ATTACH DELETE HANDLERS
        // ====================================================================
        // Add click event listeners to all delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                const card = document.querySelector(`.card[data-id="${id}"]`);
                // Get full path from the file link data attribute
                const fullPath = card.querySelector('.file-link').dataset.path;

                // ----------------------------------------------------------------
                // CREATE CONFIRMATION MODAL
                // ----------------------------------------------------------------
                // Build a custom modal instead of using browser's confirm()
                const modal = document.createElement('div');
                modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';
                modal.innerHTML = `
                    <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 500px; width: 90%;">
                        <h2 style="margin: 0 0 1rem 0; color: var(--text-primary);">Delete Image</h2>
                        <p style="margin: 0 0 1.5rem 0; color: var(--text-secondary);">How would you like to delete this image?</p>
                        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                            <button id="deleteDbBtn" style="background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Delete from Database Only</button>
                            <button id="deleteDiskBtn" style="background: #ef4444; border: none; color: white; padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 600;">Delete from Computer & Database</button>
                            <button id="cancelBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.75rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem;">Cancel</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);

                // ----------------------------------------------------------------
                // HANDLE MODAL ACTIONS
                // ----------------------------------------------------------------
                // Cancel button - just close the modal
                modal.querySelector('#cancelBtn').onclick = () => modal.remove();

                // Delete from Database Only
                modal.querySelector('#deleteDbBtn').onclick = async () => {
                    modal.remove();
                    await deleteFromDatabase(id, card);
                };

                // Delete from Computer & Database
                modal.querySelector('#deleteDiskBtn').onclick = async () => {
                    if (!window.electronAPI || !window.electronAPI.trashFile) {
                        alert('Error: Electron API not available for file operations.');
                        return;
                    }

                    try {
                        // 1. Move to trash
                        await window.electronAPI.trashFile(fullPath);

                        // 2. Delete from database
                        modal.remove();
                        await deleteFromDatabase(id, card);

                    } catch (error) {
                        console.error('Error deleting file from disk:', error);
                        alert(`Failed to delete file from computer: ${error.message}`);
                        modal.remove();
                    }
                };

                // Close modal if user clicks the background
                modal.onclick = (e) => {
                    if (e.target === modal) modal.remove();
                };
            });
        });

        // ====================================================================
        // ATTACH THUMBNAIL CLICK HANDLERS FOR IMAGE PREVIEW
        // ====================================================================
        document.querySelectorAll('.thumbnail-preview').forEach(thumbnail => {
            thumbnail.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent any parent click handlers
                const fullPath = e.target.dataset.fullpath;
                if (fullPath) {
                    showImagePreview(fullPath);
                }
            });
        });

    } catch (error) {
        console.error('Error:', error);
        loadingDb.textContent = 'Error loading database.';
    }
}

// ============================================================================
// IMAGE PREVIEW POPUP
// ============================================================================
// Shows full-size image in a modal overlay
async function showImagePreview(imagePath) {
    try {
        console.log('[IMAGE PREVIEW] Path from database:', imagePath);

        // Read the file using Electron API
        const fileBuffer = await window.electronAPI.readFile(imagePath);
        const blob = new Blob([fileBuffer]);
        const url = URL.createObjectURL(blob);

        // Create modal overlay
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0,0,0,0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            cursor: pointer;
            overflow: hidden;
        `;

        // Create image element
        const img = document.createElement('img');
        img.src = url;
        img.style.cssText = `
            max-width: 95vw;
            max-height: 95vh;
            width: auto;
            height: auto;
            object-fit: contain;
            border-radius: 8px;
            cursor: default;
            box-shadow: 0 0 50px rgba(0,0,0,0.5);
        `;

        // Error handling
        img.onerror = () => {
            console.error('Failed to load image:', imagePath);
            modal.remove();
            URL.revokeObjectURL(url);
            alert('Failed to load image');
        };

        // Prevent clicks on image from closing modal
        img.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        modal.appendChild(img);
        document.body.appendChild(modal);

        // Close on background click
        modal.addEventListener('click', () => {
            modal.remove();
            URL.revokeObjectURL(url);
            document.removeEventListener('keydown', keyHandler);
        });

        // Close on any key press
        const keyHandler = (e) => {
            modal.remove();
            URL.revokeObjectURL(url);
            document.removeEventListener('keydown', keyHandler);
        };
        document.addEventListener('keydown', keyHandler);

    } catch (error) {
        console.error('[IMAGE PREVIEW] Error loading image:', error);
        alert(`Image File Not Found!\n\nPath in database: ${imagePath}\n\nThe file may have been moved or the path may be incorrect.`);
    }
}

// Helper to delete from DB and update UI
async function deleteFromDatabase(id, cardElement) {
    try {
        const response = await fetch(`${API_BASE_URL}/images/${id}`, {
            method: 'DELETE'
        });

        // If deletion was successful, remove the card from UI
        if (response.ok || response.status === 404) {
            cardElement.style.opacity = '0';
            setTimeout(() => cardElement.remove(), 300);

            // Update count
            const dbCount = document.getElementById('dbCount');
            if (dbCount) {
                const current = parseInt(dbCount.textContent) || 0;
                dbCount.textContent = Math.max(0, current - 1);
            }
        } else {
            alert('Failed to delete entry from database');
        }
    } catch (error) {
        console.error('Error deleting from DB:', error);
        alert('Failed to delete entry from database');
    }
}

// ============================================================================
// FILE LINK HANDLER
// ============================================================================
// Allow clicking filenames to show file in folder (Electron integration)
document.addEventListener("click", (e) => {
    const el = e.target.closest(".file-link");
    if (!el) return;

    const fullPath = el.dataset.path;

    // Check if Electron API is available
    if (window.electronAPI && window.electronAPI.showInFolder) {
        window.electronAPI.showInFolder(fullPath);
    } else {
        console.warn('Electron API not available. File path:', fullPath);
        alert('This feature requires Electron. File path: ' + fullPath);
    }
});

// ============================================================================
// INITIALIZE
// ============================================================================
// Load the database when the page loads
loadDatabase();
