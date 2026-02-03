// ============================================================================
// SEARCH PAGE LOGIC
// ============================================================================

const searchQuery = document.getElementById('searchQuery');
const sceneType = document.getElementById('sceneType');
const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const searchLogicToggle = document.getElementById('searchLogicToggle');
const logicLabel = document.getElementById('logicLabel');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const resultsCount = document.getElementById('resultsCount');
const API_BASE_URL = 'http://localhost:3000';

// Toggle Label Update
searchLogicToggle.addEventListener('change', () => {
    logicLabel.textContent = searchLogicToggle.checked ? 'Match Any (OR)' : 'Match All (AND)';
});

// State
let allImages = [];
let fuse = null;
let isInitialized = false;

// State for pagination
let filteredImages = [];
let currentIndex = 0;
let selectedIds = new Set();
const BATCH_SIZE = 50;
let observer = null;
const sentinel = document.getElementById('scroll-sentinel');

// Initialize Search Page
async function initSearch() {
    if (isInitialized) return;

    try {
        searchBtn.disabled = true;
        searchBtn.textContent = 'Loading Index...';

        // Fetch images only (Force runtime indexing to avoid stale index issues)
        const imagesRes = await fetch(`${API_BASE_URL}/images?t=${Date.now()}`);
        const imagesData = await imagesRes.json();

        // Handle both old array format and new object format { images: [], ... }
        const imagesList = Array.isArray(imagesData) ? imagesData : imagesData.images;

        allImages = imagesList.map(img => {
            if (typeof img.analysis === 'string') {
                try { img.analysis = JSON.parse(img.analysis || '{}'); } catch (e) { img.analysis = {}; }
            }
            return img;
        });

        // Initialize Fuse.js
        const options = {
            includeScore: true,
            threshold: 0.2, // Stricter matching (0.0 = perfect, 1.0 = anything)
            ignoreLocation: true,
            // useExtendedSearch: true, // Disabled: causing "match all" behavior with some queries
            keys: [
                { name: 'filename', weight: 1 },
                { name: 'analysis.summary', weight: 1 },
                { name: 'analysis.objects', weight: 2 },
                { name: 'analysis.tags', weight: 2 }
            ]
        };

        // Prepare data for Fuse
        const indexedImages = allImages.map(img => {
            // Ensure analysis is an object
            return { ...img, analysis: img.analysis || {} };
        });

        // Debug: Check index data
        if (indexedImages.length > 0) {
            console.log('[DEBUG] First indexed item:', JSON.stringify(indexedImages[0].analysis));
        }

        // Runtime Indexing
        console.log('[DEBUG] Creating Fuse index with', indexedImages.length, 'items');
        fuse = new Fuse(indexedImages, options);

        isInitialized = true;

        // Initial search to populate list
        performSearch();

    } catch (error) {
        console.error('Failed to initialize search:', error);
        searchResults.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary);">Failed to load search index.</div>';
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search Images';
    }
}

async function refreshData() {
    try {
        const res = await fetch(`${API_BASE_URL}/images?t=${Date.now()}`);
        const data = await res.json();

        const imagesList = Array.isArray(data) ? data : data.images;

        allImages = imagesList.map(img => {
            if (typeof img.analysis === 'string') {
                try { img.analysis = JSON.parse(img.analysis || '{}'); } catch (e) { img.analysis = {}; }
            }
            return img;
        });

        if (fuse) {
            const indexedImages = allImages.map(img => ({ ...img, analysis: img.analysis || {} }));
            fuse.setCollection(indexedImages);
        }

        performSearch();
    } catch (e) {
        console.error('Failed to refresh data:', e);
    }
}


// Search Function
function performSearch() {
    if (!isInitialized) return;

    console.log('[DEBUG] performSearch called, query:', searchQuery.value);

    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching...';

    const queryText = searchQuery.value.trim();
    const typeFilter = sceneType.value;
    const startFilter = startDate.value;
    const endFilter = endDate.value;

    let results = [];

    // 1. Fuse.js Search (if query exists)
    if (queryText && fuse) {
        console.log('[DEBUG] Searching Fuse for:', queryText);
        const fuseResults = fuse.search(queryText);
        console.log('[DEBUG] Fuse found:', fuseResults.length, 'matches');
        results = fuseResults.map(res => res.item);
    } else {
        // If no query, show everything
        results = [...allImages];
    }

    // 2. Apply Filters (Client-Side)
    results = results.filter(img => {
        if (typeFilter !== 'all') {
            const scene = img.analysis.scene_type || '';
            if (scene.toLowerCase() !== typeFilter.toLowerCase()) return false;
        }

        const imgDate = new Date(img.created_at);
        if (startFilter) {
            if (imgDate < new Date(startFilter)) return false;
        }
        if (endFilter) {
            const end = new Date(endFilter);
            end.setHours(23, 59, 59);
            if (imgDate > end) return false;
        }

        return true;
    });

    // 2.5 Sort Results (Default: Recent Updates)
    results.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        const updateA = a.updated_at ? new Date(a.updated_at).getTime() : dateA;
        const updateB = b.updated_at ? new Date(b.updated_at).getTime() : dateB;

        return updateB - updateA;
    });

    // 3. Reset Pagination and Display
    window.currentSearchResults = results; // Store for tag updates
    filteredImages = results;
    currentIndex = 0;
    searchResults.innerHTML = '';

    resultsCount.textContent = `Found ${results.length} results`;

    if (results.length === 0) {
        searchResults.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-secondary);">No images found matching your criteria.</div>';
    } else {
        setupIntersectionObserver();
        renderBatch();
    }

    searchBtn.disabled = false;
    searchBtn.textContent = 'Search Images';
}

function setupIntersectionObserver() {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            renderBatch();
        }
    }, { rootMargin: '400px' });

    if (sentinel) observer.observe(sentinel);
}

function renderBatch() {
    if (currentIndex >= filteredImages.length) {
        if (observer) observer.disconnect();
        return;
    }

    const batch = filteredImages.slice(currentIndex, currentIndex + BATCH_SIZE);
    const batchHtml = batch.map(img => createResultHtml(img)).join('');

    searchResults.insertAdjacentHTML('beforeend', batchHtml);
    currentIndex += batch.length;
}

// Factor out result HTML generation (similar to card creation in database.js)
function createResultHtml(img) {
    // Helper to escape HTML special characters
    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

    const date = new Date(img.created_at).toLocaleDateString();

    let displayPath;
    if (img.path && img.path.endsWith('.avif')) {
        displayPath = img.path.includes('thumbnails/') ? img.path : `thumbnails/${img.path}`;
    } else {
        const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
        displayPath = `thumbnails/${filenameBase}.avif`;
    }

    const analysis = img.analysis || {};
    const objects = analysis.objects || [];
    const tags = analysis.tags || [];
    const isSelected = selectedIds.has(String(img.id));

    return `
        <div class="card ${isSelected ? 'selected' : ''}" data-id="${img.id}" style="position: relative;">
            <div style="position: absolute; top: 0.75rem; right: 0.75rem; z-index: 5;">
                <input type="checkbox" class="card-select-cb" data-id="${img.id}" ${isSelected ? 'checked' : ''} style="transform: scale(1.3); cursor: pointer;">
            </div>
            <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; padding-right: 1.5rem;">
                <img src="${escapeHtml(displayPath)}" 
                     data-fullpath="${escapeHtml(img.path)}"
                     class="thumbnail-preview"
                     onerror="this.style.display='none'"
                     style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px; cursor: pointer;"
                     title="Click to view full size">
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <h3 class="file-link" data-path="${escapeHtml(img.path)}" style="margin: 0; color: var(--accent); font-size: 1rem; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Show in folder">${escapeHtml(img.filename)}</h3>
                        <button class="delete-btn" data-id="${img.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.7rem; transition: all 0.2s; margin-left: 0.5rem;">X</button>
                    </div>
                    <small style="color: var(--text-secondary);">${date}</small>
                    <div style="margin-top: 0.25rem;">
                        <span class="badge" style="font-size: 0.7rem;">${escapeHtml(analysis.scene_type) || 'Unknown'}</span>
                    </div>
                </div>
            </div>
            
            <div style="display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 1rem;">
                <p style="font-size: 0.9rem; color: var(--text-primary); margin: 0; line-height: 1.4; flex: 1;">
                    ${escapeHtml(analysis.summary) || 'No summary available'}
                </p>
                <button class="copy-btn" data-text="${escapeHtml(analysis.summary || '')}" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.75rem; white-space: nowrap;" title="Copy to clipboard">Copy</button>
            </div>
            
            <div class="tags-section">
                <div class="tags-container" style="margin-bottom: 0.5rem;">
                    <strong style="font-size: 0.75rem; color: var(--text-secondary); margin-right: 0.5rem;">Objects:</strong>
                    ${objects.map(obj => `<span class="tag editable" data-id="${img.id}" data-type="objects" data-tag="${escapeHtml(obj)}" style="cursor: context-menu; font-size: 0.75rem; background-color: rgba(16, 185, 129, 0.2); color: #34d399;">${escapeHtml(obj)}</span>`).join('')}
                    <button class="add-tag-btn" data-id="${img.id}" data-type="objects" title="Add Object">+</button>
                </div>
                <div class="tags-container">
                    <strong style="font-size: 0.75rem; color: var(--text-secondary); margin-right: 0.5rem;">Tags:</strong>
                    ${tags.map(tag => `<span class="tag editable" data-id="${img.id}" data-type="tags" data-tag="${escapeHtml(tag)}" style="cursor: context-menu; font-size: 0.75rem;">${escapeHtml(tag)}</span>`).join('')}
                    <button class="add-tag-btn" data-id="${img.id}" data-type="tags" title="Add Tag">+</button>
                </div>
            </div>
        </div>
    `;
}

// Override Load Stats to also init search
const originalLoadStats = loadStats;
loadStats = async function () {
    await originalLoadStats();
    initSearch();
}

// Display Results
// Display Results removed, replaced by renderBatch and createResultHtml

// Global Event Listeners for Search Results (Delegation)
searchResults.addEventListener('click', (e) => {
    // Copy Button Click
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
        e.stopPropagation();
        const text = copyBtn.dataset.text;
        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                copyBtn.style.borderColor = 'var(--accent)';
                copyBtn.style.color = 'var(--accent)';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.borderColor = 'var(--border)';
                    copyBtn.style.color = 'var(--text-secondary)';
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy to clipboard', err);
            });
        }
        return;
    }

    // Thumbnail Click
    // Thumbnail Click
    if (e.target.classList.contains('thumbnail-preview')) {
        e.stopPropagation();
        const fullPath = e.target.dataset.fullpath;
        if (fullPath) showImagePreview(fullPath);
    }

    // Delete Button Click
    if (e.target.closest('.delete-btn')) {
        e.stopPropagation();
        const btn = e.target.closest('.delete-btn');
        const id = btn.dataset.id;

        // To support disk delete, we need the full path.
        const card = btn.closest('.card');
        const fullPath = card.querySelector('.file-link').dataset.path;

        showDeleteModal(id, fullPath, card);
    }

    // Add Tag Button Click
    if (e.target.closest('.add-tag-btn')) {
        e.stopPropagation();
        const btn = e.target.closest('.add-tag-btn');
        const id = btn.dataset.id;
        const type = btn.dataset.type; // 'tags' or 'objects'
        addTag(id, type);
    }
});

// Show Delete Modal (matches database.js)
function showDeleteModal(id, fullPath, cardElement) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';
    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 500px; width: 90%;">
            <h2 style="margin: 0 0 1rem 0; color: var(--text-primary);">Delete Image</h2>
            <p style="margin: 0 0 1.5rem 0; color: var(--text-secondary);">How would you like to delete this image?</p>
            <div style="display: flex; flex-direction: column; gap: 1rem;">
                <button id="deleteDbBtn" style="background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Delete from Database Only</button>
                <button id="cancelBtn" style="background: #a1f0f0ff;border:2px solid var(--border);color: #240d00ff; font-size:2rem;font-weight:700;padding:1.75rem 1.75rem;border-radius:6px;cursor:pointer;margin-top:0.5rem;">Cancel</button>
                <button id="deleteDiskBtn" style="background: #ef4444; border: none; color: white; padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 600;">Delete from Computer & Database</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Cancel
    modal.querySelector('#cancelBtn').onclick = () => modal.remove();

    // DB Only
    modal.querySelector('#deleteDbBtn').onclick = async () => {
        modal.remove();
        await deleteFromDatabase(id, cardElement);
    };

    // Disk & DB
    modal.querySelector('#deleteDiskBtn').onclick = async () => {
        if (!window.electronAPI || !window.electronAPI.trashFile) {
            alert('Error: Electron API not available for file operations.');
            return;
        }

        try {
            await window.electronAPI.trashFile(fullPath);
            modal.remove();
            await deleteFromDatabase(id, cardElement);
        } catch (error) {
            console.error('Error deleting file from disk:', error);
            alert(`Failed to delete file from computer: ${error.message}`);
            modal.remove();
        }
    };

    // Close on background click
    modal.onclick = (e) => {
        if (e.target === modal) modal.remove();
    };
}

// Perform DB Deletion
async function deleteFromDatabase(id, cardElement) {
    try {
        const response = await fetch(`${API_BASE_URL}/images/${id}`, {
            method: 'DELETE'
        });

        if (response.ok || response.status === 404) {
            cardElement.style.opacity = '0';
            setTimeout(() => cardElement.remove(), 300);

            // Update count
            const countText = resultsCount.textContent;
            const currentCount = parseInt(countText.match(/\d+/)[0]);
            resultsCount.textContent = `Found ${Math.max(0, currentCount - 1)} results`;
        } else {
            alert('Failed to delete entry from database');
        }
    } catch (error) {
        console.error('Error deleting from DB:', error);
        alert('Failed to delete entry from database: ' + error.message);
    }
}

// ============================================================================
// TAG MANAGEMENT
// ============================================================================

const contextMenu = document.getElementById('contextMenu');
let ctxTarget = null; // { id, tag, type, card }

function showContextMenu(e, id, type, tag = null, card = null) {
    console.log('[DEBUG] showContextMenu called:', { id, type, tag });
    ctxTarget = { id, type, tag, card };
    contextMenu.style.display = 'block';



    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    // Show/Hide Items
    const regenItem = document.getElementById('ctxRegenThumb');
    const editItem = document.getElementById('ctxEdit');
    const deleteItem = document.getElementById('ctxDelete');
    const renameItem = document.getElementById('ctxRename');

    if (type === 'thumbnail') {
        regenItem.style.display = 'block';
        editItem.style.display = 'none';
        deleteItem.style.display = 'none';
        if (renameItem) renameItem.style.display = 'none';
    } else if (type === 'file') {
        regenItem.style.display = 'none';
        editItem.style.display = 'none';
        deleteItem.style.display = 'none';
        if (renameItem) renameItem.style.display = 'block';
    } else {
        regenItem.style.display = 'none';
        editItem.style.display = 'block';
        deleteItem.style.display = 'block';
        if (renameItem) renameItem.style.display = 'none';
    }
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
    ctxTarget = null;
}

// Global click to hide context menu
document.addEventListener('click', (e) => {
    hideContextMenu();
});

// Context Menu Event Listener (Handles both Thumbnails and Tags)
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
        showContextMenu(e, tagEl.dataset.id, tagEl.dataset.type, tagEl.dataset.tag);
        return;
    }

    // Filename Right-Click
    const fileLink = e.target.closest('.file-link');
    if (fileLink) {
        e.preventDefault();
        e.stopPropagation();
        const card = fileLink.closest('.card');
        const id = card.dataset.id;
        const filename = fileLink.textContent.trim();
        showContextMenu(e, id, 'file', filename, card);
        console.log('Right clicked file');
        return;
    }

    hideContextMenu();
});

// Rename Action
const ctxRename = document.getElementById('ctxRename');
if (ctxRename) {
    ctxRename.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget) return;
        const { id, tag: currentFilename } = ctxTarget;
        hideContextMenu();

        showTagInputModal('Rename File', currentFilename, async (newName) => {
            if (!newName || newName === currentFilename) return;

            // Basic validation
            if (newName.match(/[<>:"\/\\|?*]/)) {
                alert('Invalid characters in filename. Avoid: < > : " / \\ | ? *');
                return;
            }

            try {
                const res = await fetch(`${API_BASE_URL}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, newFilename: newName })
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || 'Rename failed');
                }

                const data = await res.json();

                // Update UI locally
                const card = document.querySelector(`.card[data-id="${id}"]`);
                if (card) {
                    const fileLink = card.querySelector('.file-link');
                    if (fileLink) {
                        fileLink.textContent = data.newFilename;
                        fileLink.dataset.path = data.newPath;
                    }
                    // Search specific: update cache if needed
                    const img = allImages.find(i => i.id == id);
                    if (img) {
                        img.filename = data.newFilename;
                        img.path = data.newPath;
                    }
                }
            } catch (err) {
                alert('Rename Error: ' + err.message);
            }
        });
    });
}

// Thumbnail Regen Action
document.getElementById('ctxRegenThumb').addEventListener('click', async () => {
    if (!ctxTarget || ctxTarget.type !== 'thumbnail') return;
    const { id, card } = ctxTarget;
    hideContextMenu();
    await regenerateThumbnail(id, card);
});

// Context Menu Actions
document.getElementById('ctxEdit').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent document click from hiding menu before we read ctxTarget
    if (!ctxTarget) return;
    const { id, tag, type } = ctxTarget;
    hideContextMenu();

    showTagInputModal(`Edit ${type.slice(0, -1)}`, tag, (newTag) => {
        if (newTag && newTag.trim() !== tag) {
            updateTag(id, type, tag, newTag.trim(), 'edit');
        }
    });
});

document.getElementById('ctxDelete').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent document click from hiding menu before we read ctxTarget
    if (!ctxTarget) return;
    const { id, tag, type } = ctxTarget;
    hideContextMenu();

    showConfirmModal(`Delete "${tag}"?`, () => {
        updateTag(id, type, tag, null, 'delete');
    });
});

// Add Tag Logic
async function addTag(id, type) {
    showTagInputModal(`Add new ${type.slice(0, -1)}`, '', (newTag) => {
        if (newTag && newTag.trim()) {
            updateTag(id, type, null, newTag.trim(), 'add');
        }
    });
}

// Custom Input Modal (Replaces prompt)
function showTagInputModal(title, initialValue, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${title}</h3>
            <input type="text" id="tagInput" value="${initialValue || ''}" style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); margin-bottom: 1.5rem; font-size: 1rem;">
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelTagBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveTagBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('#tagInput');
    const saveBtn = modal.querySelector('#saveTagBtn');
    const cancelBtn = modal.querySelector('#cancelTagBtn');

    // Global keyboard handler
    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };
    document.addEventListener('keydown', keyHandler);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const save = () => {
        const val = input.value;
        cleanup();
        callback(val);
    };

    // Use setTimeout to ensure focus applies after render cycle
    setTimeout(() => {
        input.focus();
        input.select();
    }, 10);

    saveBtn.onclick = save;
    cancelBtn.onclick = cleanup;

    // Handle Enter on the input
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            save();
        }
    });

    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };
}

// Custom Confirmation Modal (Replaces native confirm)
function showConfirmModal(message, onConfirm, confirmText = 'Delete', confirmColor = '#ef4444') {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%; text-align: center;">
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1.1rem;">${message}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="cancelConfirmBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="okConfirmBtn" style="background: ${confirmColor}; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">${confirmText}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const okBtn = modal.querySelector('#okConfirmBtn');
    const cancelBtn = modal.querySelector('#cancelConfirmBtn');

    // Focus OK button for keyboard accessibility
    setTimeout(() => {
        okBtn.focus();
    }, 10);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const confirmAction = () => {
        cleanup();
        onConfirm();
    };

    okBtn.onclick = confirmAction;
    cancelBtn.onclick = cleanup;

    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) cleanup();
    };

    // Keyboard support
    const keyHandler = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmAction();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cleanup();
        }
    };

    document.addEventListener('keydown', keyHandler);
}

// Update Tag Backend Call
async function updateTag(id, type, oldTag, newTag, action) {
    try {
        // 1. Update master list (allImages)
        const masterImage = allImages.find(img => img.id == id);

        // 2. Update current search results (if exists)
        const resultImage = window.currentSearchResults ? window.currentSearchResults.find(img => img.id == id) : null;

        const image = masterImage || resultImage;
        if (!image) throw new Error('Image not found in any local cache');

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

        analysis[type] = list; // Update the list

        // Update BOTH references to ensure consistency
        if (masterImage) masterImage.analysis = analysis;
        if (resultImage) resultImage.analysis = analysis;

        // Also update filteredImages if it exists (for pagination consistency)
        const filteredImage = filteredImages ? filteredImages.find(img => img.id == id) : null;
        if (filteredImage) filteredImage.analysis = analysis;

        // 3. Send update to server
        const response = await fetch(`${API_BASE_URL}/update-tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, analysis })
        });

        if (!response.ok) throw new Error('Update failed');

        // Update Fuse index collection to reflect new tags/objects
        if (fuse) {
            fuse.setCollection(allImages);
        }

        // Refresh stats list
        loadStats();

        // 4. In-Place UI Update
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            // Re-render only the inner content to preserve card structure if needed, 
            // but createResultHtml returns a full card string.
            // Let's replace the whole card's content or outer if simpler.
            const newHtml = createResultHtml(image);
            card.outerHTML = newHtml;
        } else {
            // Fallback for extreme cases (shouldn't happen if card is visible)
            await performSearch();
        }

    } catch (error) {
        console.error('Tag update error:', error);
        alert('Failed to update tags: ' + error.message);
    }
}


// ============================================================================
// IMAGE PREVIEW POPUP
// ============================================================================
// Shows full-size image in a modal overlay
async function showImagePreview(imagePath) {
    try {
        console.log('[IMAGE PREVIEW] Path from search:', imagePath);

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

        modal.appendChild(img);
        document.body.appendChild(modal);

        // Close on background click (and image click since we removed stopPropagation)
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
        alert(`Image File Not Found!\n\nPath: ${imagePath}\n\nThe file may have been moved or the path may be incorrect.`);
    }
}

// Load Stats
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE_URL}/stats`);
        if (!response.ok) throw new Error('Failed to fetch stats');

        const stats = await response.json();

        // Render Tags
        const topTagsList = document.getElementById('topTagsList');
        if (stats.tags.length === 0) {
            topTagsList.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No tags found</span>';
        } else {
            topTagsList.innerHTML = stats.tags.slice(0, 20).map(tag => `
                <span class="tag" style="cursor: pointer;" onclick="setSearchQuery('${tag.name}')">
                    #${tag.name} <span style="opacity: 0.6; font-size: 0.8em;">(${tag.count})</span>
                </span>
            `).join('');
        }

        // Render Objects
        const topObjectsList = document.getElementById('topObjectsList');
        if (stats.objects.length === 0) {
            topObjectsList.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.9rem;">No objects found</span>';
        } else {
            topObjectsList.innerHTML = stats.objects.slice(0, 20).map(obj => `
                <span class="tag" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399; cursor: pointer;" onclick="setSearchQuery('${obj.name}')">
                    ${obj.name} <span style="opacity: 0.6; font-size: 0.8em;">(${obj.count})</span>
                </span>
            `).join('');
        }

    } catch (error) {
        console.error('Error loading stats:', error);
        document.getElementById('topTagsList').innerHTML = '<span style="color: var(--text-secondary);">Error loading tags</span>';
        document.getElementById('topObjectsList').innerHTML = '<span style="color: var(--text-secondary);">Error loading objects</span>';
    }
}

// Regenerate Thumbnail Logic
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

// Helper to set search query from tag click
window.setSearchQuery = (term) => {
    searchQuery.value = term;
    performSearch();
};

// Event Listeners
searchBtn.addEventListener('click', performSearch);

// Allow Enter key to search
searchQuery.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
});

// Initialize
loadStats();
initSearch();

// Check for URL parameters (e.g. from Tags page)
const urlParams = new URLSearchParams(window.location.search);
const tagParam = urlParams.get('tag');

if (tagParam) {
    searchQuery.value = tagParam;
    performSearch();
}

// File Link Handler (Show in Folder)
document.addEventListener("click", (e) => {
    const el = e.target.closest(".file-link");
    if (!el) return;

    const fullPath = el.dataset.path;

    if (window.electronAPI && window.electronAPI.showInFolder) {
        window.electronAPI.showInFolder(fullPath);
    } else {
        console.warn('Electron API not available. File path:', fullPath);
        alert('This feature requires Electron. File path: ' + fullPath);
    }
});

// ============================================================================
// BATCH CONTROLS & SELECTION LOGIC
// ============================================================================

const selectMissingBtn = document.getElementById('selectMissingBtn');
const unselectAllBtn = document.getElementById('unselectAllBtn');
const processSelectedBtn = document.getElementById('processSelectedBtn');
const dbPromptType = document.getElementById('dbPromptType');
const validateBtn = document.getElementById('validateBtn');
const validationStatus = document.getElementById('validationStatus');
const validationText = document.getElementById('validationText');
const validationProgressBar = document.getElementById('validationProgressBar');
const closeStatus = document.getElementById('closeStatus');


// Checkbox Delegation
searchResults.addEventListener('change', (e) => {
    if (e.target.classList.contains('card-select-cb')) {
        const id = e.target.dataset.id;
        const card = e.target.closest('.card');
        if (e.target.checked) {
            selectedIds.add(String(id));
            if (card) card.classList.add('selected');
        } else {
            selectedIds.delete(String(id));
            if (card) card.classList.remove('selected');
        }
        updateProcessButton();
    }
});

function updateProcessButton() {
    const count = selectedIds.size;
    if (processSelectedBtn) {
        processSelectedBtn.textContent = `Process (${count})`;
        processSelectedBtn.disabled = count === 0;
        processSelectedBtn.style.opacity = count === 0 ? '0.5' : '1';
    }
    if (unselectAllBtn) {
        unselectAllBtn.style.display = count > 0 ? 'block' : 'none';
    }
}

// 1. Select Missing
if (selectMissingBtn) {
    selectMissingBtn.addEventListener('click', () => {
        let count = 0;
        filteredImages.forEach(img => {
            const analysis = img.analysis || {};
            if (!analysis.summary || !analysis.tags || analysis.tags.length === 0 || !analysis.objects || analysis.objects.length === 0) {
                selectedIds.add(String(img.id));
                count++;

                const cb = document.querySelector(`.card-select-cb[data-id="${img.id}"]`);
                if (cb) cb.checked = true;
                const card = document.querySelector(`.card[data-id="${img.id}"]`);
                if (card) card.classList.add('selected');
            }
        });

        if (count > 0) updateProcessButton();
        else alert('No visible images found with missing data.');
    });
}

// 2. Unselect All
if (unselectAllBtn) {
    unselectAllBtn.addEventListener('click', () => {
        selectedIds.clear();
        document.querySelectorAll('.card-select-cb').forEach(cb => cb.checked = false);
        document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
        updateProcessButton();
    });
}

// 3. Process Selected
if (processSelectedBtn) {
    processSelectedBtn.addEventListener('click', () => {
        if (selectedIds.size === 0) return;

        showConfirmModal(`Re-analyze ${selectedIds.size} images with mode: "${dbPromptType.value}"?`, async () => {

            processSelectedBtn.disabled = true;
            processSelectedBtn.textContent = 'Processing...';

            const ids = Array.from(selectedIds);
            const promptType = dbPromptType.value;
            const total = ids.length;
            let successCount = 0;
            let failedCount = 0;

            if (validationStatus) {
                validationStatus.style.display = 'block';
                validationText.textContent = 'Starting batch...';
                validationProgressBar.style.width = '0%';
            }

            for (let i = 0; i < total; i++) {
                if (validationText) validationText.textContent = `Processing image ${i + 1} of ${total}...`;

                try {
                    const response = await fetch(`${API_BASE_URL}/batch-analyze`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: [ids[i]], promptType })
                    });

                    if (response.ok) successCount++;
                    else failedCount++;
                } catch (e) {
                    console.error(e);
                    failedCount++;
                }
                if (validationProgressBar) validationProgressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
            }

            if (validationText) validationText.textContent = `Batch Complete! Success: ${successCount}`;

            selectedIds.clear();
            await refreshData();
            updateProcessButton();

            setTimeout(() => {
                if (validationStatus) validationStatus.style.display = 'none';
            }, 2000);

        }, 'Start Batch', 'var(--accent)');
    });
}

// 4. Validate (Integrity Check)
if (validateBtn) {
    validateBtn.addEventListener('click', () => {
        showConfirmModal('Run database integrity check?\n\nThis will:\n1. Remove duplicates & missing files\n2. Repair metadata & dimensions\n3. Regenerate thumbnails', async () => {

            if (validationStatus) {
                validationStatus.style.display = 'block';
                validationText.textContent = 'Running check...';
                validationProgressBar.style.width = '30%';
            }

            try {
                const res = await fetch(`${API_BASE_URL}/validate-database`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reanalyze: false })
                });
                const data = await res.json();
                const r = data.results;

                if (validationProgressBar) validationProgressBar.style.width = '100%';

                let message = `<strong>Check Complete</strong><br>`;
                if (r.duplicatesRemoved > 0) message += `🧹 Removed ${r.duplicatesRemoved} duplicates<br>`;
                if (r.metadataRepaired > 0) message += `🔧 Repaired ${r.metadataRepaired} metadata<br>`;
                if (r.missing > 0) message += `🗑️ Removed ${r.missing} missing files<br>`;
                if (r.fixedThumbnails > 0) message += `🖼️ Fixed ${r.fixedThumbnails} thumbnails<br>`;
                if (r.errors.length > 0) message += `⚠️ ${r.errors.length} errors occurred`;

                if (r.duplicatesRemoved === 0 && r.metadataRepaired === 0 && r.missing === 0 && r.fixedThumbnails === 0 && r.errors.length === 0) {
                    message += "✅ Database is healthy!";
                }

                if (validationText) validationText.innerHTML = message;

                await refreshData();

                // Keep status visible longer if we did something
                const delay = (r.duplicatesRemoved > 0 || r.metadataRepaired > 0 || r.missing > 0) ? 5000 : 3000;

                setTimeout(() => {
                    if (validationStatus) validationStatus.style.display = 'none';
                }, delay);
            } catch (e) {
                alert('Check failed: ' + e.message);
                if (validationStatus) validationStatus.style.display = 'none';
            }
        }, 'Run Check', 'var(--accent)');
    });
}

if (closeStatus) {
    closeStatus.addEventListener('click', () => {
        validationStatus.style.display = 'none';
    });
}
