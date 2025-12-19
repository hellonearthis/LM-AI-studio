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
// ============================================================================
// MAIN FUNCTION - LOAD DATABASE (INFINITE SCROLL)
// ============================================================================
const API_BASE_URL = 'http://localhost:3000';

// State for infinite scroll
let allImages = [];
let currentIndex = 0;
const BATCH_SIZE = 50;
let observer = null;

// Fetches all saved images from the database
async function initDatabase() {
    try {
        // Reset state
        allImages = [];
        currentIndex = 0;
        dbGrid.innerHTML = ''; // Clear grid

        // Fetch all images from the server
        loadingDb.style.display = 'block';
        const response = await fetch(`${API_BASE_URL}/images`);
        if (!response.ok) throw new Error('Failed to fetch images');

        allImages = await response.json();
        loadingDb.style.display = 'none';

        // Update the entry count in the header
        const dbCount = document.getElementById('dbCount');
        if (dbCount) dbCount.textContent = allImages.length;

        // Handle empty database case
        if (allImages.length === 0) {
            dbGrid.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No images saved yet.</p>';
            return;
        }

        // Create Sentinel for Infinite Scroll
        const sentinel = document.createElement('div');
        sentinel.id = 'scroll-sentinel';
        sentinel.style.width = '100%';
        sentinel.style.height = '20px';
        dbGrid.parentNode.appendChild(sentinel); // Append outside grid or ensure grid handles full width

        // Setup Intersection Observer
        setupIntersectionObserver(sentinel);

        // Initial render
        renderBatch();

    } catch (error) {
        console.error('Error:', error);
        loadingDb.textContent = 'Error loading database.';
    }
}

function setupIntersectionObserver(sentinel) {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            renderBatch();
        }
    }, { rootMargin: '200px' }); // Load before reaching bottom

    observer.observe(sentinel);
}

function renderBatch() {
    if (currentIndex >= allImages.length) return;

    const batch = allImages.slice(currentIndex, currentIndex + BATCH_SIZE);

    // Generate HTML for batch
    const batchHtml = batch.map(img => createCardHtml(img)).join('');

    // Append to grid
    dbGrid.insertAdjacentHTML('beforeend', batchHtml);

    // Update index
    currentIndex += batch.length;

    // Attach handlers for NEW elements only? 
    // Actually, simple way is to rely on event delegation or re-attach. 
    // Re-attaching to all might be heavy, let's use global delegation or careful attachment.
    // The existing code attaches to all .delete-btn. Let's scope it to the new batch or switch to delegation.
    // For safety and minimal refactor of handlers, let's just re-run the attachment logic but only for new items?
    // Optimization: Delegation is better. Let's switch delete buttons to delegation.
}

function createCardHtml(img) {
    // Parse stored JSON data
    const analysis = JSON.parse(img.analysis || '{}');
    const metadata = JSON.parse(img.metadata || '{}');
    const date = new Date(img.created_at).toLocaleDateString();

    // Extract key metadata fields for display
    const width = metadata.ImageWidth || metadata.ExifImageWidth || metadata.PixelXDimension || 'N/A';
    const height = metadata.ImageHeight || metadata.ExifImageHeight || metadata.PixelYDimension || 'N/A';

    // Format full metadata
    const metadataStr = Object.entries(metadata)
        .filter(([key]) => !['ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight'].includes(key))
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n');

    // Thumbnail path logic
    let displayPath;
    if (img.path && img.path.endsWith('.avif')) {
        displayPath = img.path.includes('thumbnails/') ? img.path : `thumbnails/${img.path}`;
    } else {
        const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
        displayPath = `thumbnails/${filenameBase}.avif`;
    }

    const fullPath = img.path;

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
                <!-- Fallback -->
                <div style="display: none; width: 100px; height: 100px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; align-items: center; justify-content: center; font-size: 0.7rem; color: var(--text-secondary); text-align: center; padding: 0.5rem;">
                    No Preview
                </div>
                <!-- Image Info -->
                <div style="flex: 1;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <div style="flex: 1; min-width: 0;">
                            <h2 class="file-link" data-path="${img.path}" style="margin: 0; border: none; font-size: 1.1rem; cursor: pointer; color: var(--accent); text-decoration: none;" title="${metadataStr || 'No extra metadata'}">${img.filename}</h2>
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
                ${(analysis.objects || []).map(obj => `<span class="tag" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399;">${obj}</span>`).join('')}
                ${(analysis.tags || []).map(tag => `<span class="tag">${tag}</span>`).join('')}
                ${analysis.scene_type ? `<span class="tag" style="background-color: rgba(129, 140, 248, 0.2); color: #818cf8;">${analysis.scene_type}</span>` : ''}
            </div>
        </div>
    `;
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
        // img.addEventListener('click', (e) => {
        //     e.stopPropagation();
        // });

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
// IMAGE PREVIEW HANDLER
// ============================================================================
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('thumbnail-preview')) {
        const fullPath = e.target.dataset.fullpath;
        if (fullPath) {
            showImagePreview(fullPath);
        }
    }
});

// ============================================================================
// DATABASE VALIDATION HANDLER
// ============================================================================
const validateBtn = document.getElementById('validateBtn');
const validationStatus = document.getElementById('validationStatus');
const validationText = document.getElementById('validationText');
const validationProgressBar = document.getElementById('validationProgressBar');
const closeStatus = document.getElementById('closeStatus');

if (validateBtn) {
    validateBtn.addEventListener('click', async () => {
        const reanalyze = confirm('Validate Database?\n\nThis will:\n1. Check for missing image files and remove from DB.\n2. Fix missing thumbnails.\n\nWould you also like to identify images with missing AI data? (Note: Bulk AI re-analysis is currently not automated to prevent cost/time issues, but status will be reported.)');

        try {
            validateBtn.disabled = true;
            validateBtn.innerHTML = '<span>⏳</span> Validating...';

            validationStatus.style.display = 'block';
            validationText.textContent = 'Contacting server...';
            validationProgressBar.style.width = '20%';

            const response = await fetch(`${API_BASE_URL}/validate-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reanalyze: false }) // Passing false for now, can be extended
            });

            if (!response.ok) throw new Error('Validation failed on server');

            validationProgressBar.style.width = '80%';
            const data = await response.json();

            validationProgressBar.style.width = '100%';
            const res = data.results;

            validationText.innerHTML = `
                <strong>Validation Complete!</strong><br>
                Total processed: ${res.total} | 
                Missing files removed: ${res.missing} | 
                Thumbnails fixed: ${res.fixedThumbnails}
                ${res.errors.length > 0 ? `<br><small style="color: #ef4444;">Errors: ${res.errors.length}</small>` : ''}
            `;

            // Refresh database if something changed
            if (res.missing > 0 || res.fixedThumbnails > 0) {
                setTimeout(() => initDatabase(), 1500);
            }

        } catch (error) {
            console.error('Validation error:', error);
            validationText.textContent = 'Error: ' + error.message;
            validationProgressBar.style.backgroundColor = '#ef4444';
        } finally {
            validateBtn.disabled = false;
            validateBtn.innerHTML = '<span>🛠️</span> Validate Database';
        }
    });
}

if (closeStatus) {
    closeStatus.addEventListener('click', () => {
        validationStatus.style.display = 'none';
        validationProgressBar.style.width = '0%';
        validationProgressBar.style.backgroundColor = 'var(--accent)';
    });
}

// ============================================================================
// CONTEXT MENU & THUMBNAIL REGEN
// ============================================================================
const contextMenu = document.getElementById('contextMenu');
let ctxTarget = null; // { id, type, card }

function showContextMenu(e, id, type, card) {
    ctxTarget = { id, type, card };
    contextMenu.style.display = 'block';

    // Position menu
    const menuWidth = 180;
    const menuHeight = 50;
    let x = e.clientX;
    let y = e.clientY;

    // Boundary checks
    if (x + menuWidth > window.innerWidth) x -= menuWidth;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
    ctxTarget = null;
}

document.addEventListener('click', hideContextMenu);

document.addEventListener('contextmenu', (e) => {
    const thumb = e.target.closest('.thumbnail-preview');
    if (thumb) {
        e.preventDefault();
        const card = thumb.closest('.card');
        const id = card.dataset.id;
        showContextMenu(e, id, 'thumbnail', card);
    } else {
        hideContextMenu();
    }
});

document.getElementById('ctxRegenThumb').addEventListener('click', async () => {
    if (!ctxTarget || ctxTarget.type !== 'thumbnail') return;
    const { id, card } = ctxTarget;
    hideContextMenu();
    await regenerateThumbnail(id, card);
});

async function regenerateThumbnail(id, cardElement) {
    try {
        const thumbImg = cardElement.querySelector('.thumbnail-preview');
        thumbImg.style.opacity = '0.5';

        const response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        if (!response.ok) throw new Error('Regeneration failed');

        const data = await response.json();

        // Refresh the image by appending a timestamp to bypass cache
        if (data.thumbPath) {
            thumbImg.src = `${data.thumbPath}?t=${Date.now()}`;
        }

    } catch (error) {
        console.error('Thumbnail regeneration error:', error);
        alert('Failed to regenerate thumbnail: ' + error.message);
    } finally {
        const thumbImg = cardElement.querySelector('.thumbnail-preview');
        if (thumbImg) thumbImg.style.opacity = '1';
    }
}

// ============================================================================
// INITIALIZE
// ============================================================================
// Load the database when the page loads
initDatabase();
