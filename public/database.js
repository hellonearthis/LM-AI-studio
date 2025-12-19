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
        if (!response.ok) throw new Error('Failed to load images');

        allImages = (await response.json()).map(img => {
            if (typeof img.analysis === 'string') {
                try { img.analysis = JSON.parse(img.analysis || '{}'); } catch (e) { img.analysis = {}; }
            }
            return img;
        });
        loadingDb.style.display = 'none';

        // Update the entry count in the header
        const dbCount = document.getElementById('dbCount');
        if (dbCount) dbCount.textContent = allImages.length;

        // Handle empty database case
        if (allImages.length === 0) {
            dbGrid.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No images saved yet.</p>';
            return;
        }

        // Create Sentinel for Infinite Scroll (if not already there)
        let sentinel = document.getElementById('scroll-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'scroll-sentinel';
            sentinel.style.width = '100%';
            sentinel.style.height = '20px';
            dbGrid.parentNode.appendChild(sentinel);
        }

        // Setup Intersection Observer
        setupIntersectionObserver(sentinel);

        // Initial render
        renderBatch();

    } catch (error) {
        console.error('Error:', error);
        loadingDb.style.display = 'block';
        loadingDb.textContent = 'Error loading database. Please check console.';
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
    // Parse stored JSON data (handle if already parsed or string)
    let analysis = img.analysis;
    if (typeof analysis === 'string') {
        try { analysis = JSON.parse(analysis || '{}'); } catch (e) { analysis = {}; }
    } else {
        analysis = analysis || {};
    }

    let metadata = img.metadata;
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata || '{}'); } catch (e) { metadata = {}; }
    } else {
        metadata = metadata || {};
    }
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
            <div class="tags-section">
                <div class="tags-container" style="margin-bottom: 0.5rem;">
                    <strong style="font-size: 0.75rem; color: var(--text-secondary); margin-right: 0.5rem;">Objects:</strong>
                    ${(analysis.objects || []).map(obj => `<span class="tag editable" data-id="${img.id}" data-type="objects" data-tag="${obj}" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399; cursor: context-menu;">${obj}</span>`).join('')}
                    <button class="add-tag-btn" data-id="${img.id}" data-type="objects" title="Add Object">+</button>
                </div>
                <div class="tags-container">
                    <strong style="font-size: 0.75rem; color: var(--text-secondary); margin-right: 0.5rem;">Tags:</strong>
                    ${(analysis.tags || []).map(tag => `<span class="tag editable" data-id="${img.id}" data-type="tags" data-tag="${tag}" style="cursor: context-menu;">${tag}</span>`).join('')}
                    ${analysis.scene_type ? `<span class="tag" style="background-color: rgba(129, 140, 248, 0.2); color: #818cf8;">${analysis.scene_type}</span>` : ''}
                    <button class="add-tag-btn" data-id="${img.id}" data-type="tags" title="Add Tag">+</button>
                </div>
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
// CONTEXT MENU & TAG MANAGEMENT
// ============================================================================
const contextMenu = document.getElementById('contextMenu');
let ctxTarget = null; // { id, tag, type, card }

function showContextMenu(e, id, type, tag = null, card = null) {
    ctxTarget = { id, type, tag, card };
    contextMenu.style.display = 'block';

    // Position menu
    const menuWidth = 180;
    const menuHeight = type === 'thumbnail' ? 60 : 120;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) x -= menuWidth;
    if (y + menuHeight > window.innerHeight) y -= menuHeight;

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    // Show/hide relevant items
    document.getElementById('ctxRegenThumb').style.display = type === 'thumbnail' ? 'block' : 'none';
    document.getElementById('ctxEdit').style.display = type === 'tag' ? 'block' : 'none';
    document.getElementById('ctxDelete').style.display = type === 'tag' ? 'block' : 'none';

    const dividers = contextMenu.querySelectorAll('.context-menu-divider');
    dividers.forEach(d => d.style.display = type === 'tag' ? 'block' : 'none');
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
    ctxTarget = null;
}

document.addEventListener('click', hideContextMenu);

document.addEventListener('contextmenu', (e) => {
    // Thumbnail Right-Click
    const thumb = e.target.closest('.thumbnail-preview');
    if (thumb) {
        e.preventDefault();
        const card = thumb.closest('.card');
        const id = card.dataset.id;
        showContextMenu(e, id, 'thumbnail', null, card);
        return;
    }

    // Tag Right-Click
    const tagEl = e.target.closest('.tag.editable');
    if (tagEl) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e, tagEl.dataset.id, 'tag', tagEl.dataset.tag);
        return;
    }

    hideContextMenu();
});

// Click delegation for Add Tag button
dbGrid.addEventListener('click', (e) => {
    if (e.target.closest('.add-tag-btn')) {
        const btn = e.target.closest('.add-tag-btn');
        const id = btn.dataset.id;
        const type = btn.dataset.type;
        addTag(id, type);
    }
});

// Context Menu Actions
document.getElementById('ctxRegenThumb').addEventListener('click', async () => {
    if (!ctxTarget || ctxTarget.type !== 'thumbnail') return;
    const { id, card } = ctxTarget;
    hideContextMenu();
    await regenerateThumbnail(id, card);
});

document.getElementById('ctxEdit').addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.type !== 'tag') return;
    const { id, tag, type } = ctxTarget;
    // Note: type here is 'tag' but we need 'tags' or 'objects'. 
    // In search.js we used dataset.type which we've now added to createCardHtml.
    // Wait, in showContextMenu above I pass 'tag' as the type of context. 
    // I need to know if it's 'tags' or 'objects'.
    // Let's refine showContextMenu to accept context_type too.
    hideContextMenu();

    // Re-finding the element to get the specific type (tags/objects)
    const tagEl = document.querySelector(`.tag.editable[data-id="${id}"][data-tag="${tag}"]`);
    const realType = tagEl ? tagEl.dataset.type : 'tags';

    showTagInputModal(`Edit ${realType.slice(0, -1)}`, tag, (newTag) => {
        if (newTag && newTag.trim() && newTag.trim() !== tag) {
            updateTag(id, realType, tag, newTag.trim(), 'edit');
        }
    });
});

document.getElementById('ctxDelete').addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.type !== 'tag') return;
    const { id, tag } = ctxTarget;
    hideContextMenu();

    const tagEl = document.querySelector(`.tag.editable[data-id="${id}"][data-tag="${tag}"]`);
    const realType = tagEl ? tagEl.dataset.type : 'tags';

    showConfirmModal(`Delete "${tag}"?`, () => {
        updateTag(id, realType, tag, null, 'delete');
    });
});

async function addTag(id, type) {
    showTagInputModal(`Add new ${type.slice(0, -1)}`, '', (newTag) => {
        if (newTag && newTag.trim()) {
            updateTag(id, type, null, newTag.trim(), 'add');
        }
    });
}

// Update Tag Backend Call
async function updateTag(id, type, oldTag, newTag, action) {
    try {
        const image = allImages.find(img => img.id == id);
        if (!image) throw new Error('Image not found in local cache');

        let analysis = image.analysis || {};
        let list = analysis[type] || [];

        if (action === 'edit') {
            const idx = list.indexOf(oldTag);
            if (idx !== -1) list[idx] = newTag;
        } else if (action === 'delete') {
            list = list.filter(t => t !== oldTag);
        } else if (action === 'add') {
            if (!list.includes(newTag)) list.push(newTag);
        }

        analysis[type] = list;
        image.analysis = analysis; // Keep local cache in sync

        const response = await fetch(`${API_BASE_URL}/update-tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, analysis })
        });

        if (!response.ok) throw new Error('Update failed');

        // In-Place UI Update
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            const newHtml = createCardHtml(image);
            card.outerHTML = newHtml;
        }

    } catch (error) {
        console.error('Tag update error:', error);
        alert('Failed to update tags: ' + error.message);
    }
}

// Custom Input Modal (Replaces prompt)
function showTagInputModal(title, initialValue, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${title}</h3>
            <input type="text" id="modalInput" value="${initialValue || ''}" style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: #1f2937; color: white; margin-bottom: 1.5rem;">
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelModalBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveModalBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('#modalInput');
    const saveBtn = modal.querySelector('#saveModalBtn');
    const cancelBtn = modal.querySelector('#cancelModalBtn');

    // Define keyHandler FIRST (only handles Escape at document level)
    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };
    document.addEventListener('keydown', keyHandler);

    // Define cleanup AFTER keyHandler
    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const save = () => {
        const val = input.value;
        cleanup();
        callback(val);
    };

    // Focus input after render
    setTimeout(() => {
        input.focus();
        input.select();
    }, 10);

    saveBtn.onclick = save;
    cancelBtn.onclick = cleanup;

    // Handle Enter on the input specifically (not document-wide)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
        }
    });

    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };
}

// Custom Confirmation Modal
function showConfirmModal(message, onConfirm) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%; text-align: center;">
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1.1rem;">${message}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="cancelConfirmBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="okConfirmBtn" style="background: #ef4444; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Delete</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const okBtn = modal.querySelector('#okConfirmBtn');
    const cancelBtn = modal.querySelector('#cancelConfirmBtn');

    setTimeout(() => okBtn.focus(), 10);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const keyHandler = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            cleanup();
            onConfirm();
        } else if (e.key === 'Escape') {
            cleanup();
        }
    };

    document.addEventListener('keydown', keyHandler);
    okBtn.onclick = () => { cleanup(); onConfirm(); };
    cancelBtn.onclick = cleanup;
    modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

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
