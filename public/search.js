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

// Search Function
async function performSearch() {
    const query = {
        query: searchQuery.value,
        searchLogic: searchLogicToggle.checked ? 'OR' : 'AND',
        sceneType: sceneType.value,
        startDate: startDate.value,
        endDate: endDate.value
    };

    try {
        searchBtn.disabled = true;
        searchBtn.textContent = 'Searching...';

        const response = await fetch(`${API_BASE_URL}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(query)
        });

        if (!response.ok) throw new Error('Search failed');

        const results = await response.json();
        // Store results globally for local editing access
        window.currentSearchResults = results;
        displayResults(results);

    } catch (error) {
        console.error('Search error:', error);
        alert('Search failed: ' + error.message);
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search Images';
    }
}

// Display Results
function displayResults(images) {
    resultsCount.textContent = `Found ${images.length} results`;

    if (images.length === 0) {
        searchResults.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-secondary);">No images found matching your criteria.</div>';
        return;
    }

    searchResults.innerHTML = images.map(img => {
        let analysis = {};
        try {
            analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis) : (img.analysis || {});
        } catch (e) {
            console.error('Failed to parse analysis for image', img.id, e);
        }

        const date = new Date(img.created_at).toLocaleDateString();

        // Determine thumbnail path
        let displayPath;
        if (img.path && img.path.endsWith('.avif')) {
            displayPath = img.path.includes('thumbnails/') ? img.path : `thumbnails/${img.path}`;
        } else {
            const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
            displayPath = `thumbnails/${filenameBase}.avif`;
        }

        // Get objects and tags
        const objects = analysis.objects || [];
        const tags = analysis.tags || [];

        return `
            <div class="card" data-id="${img.id}">
                <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
                    <img src="${displayPath}" 
                         data-fullpath="${img.path}"
                         class="thumbnail-preview"
                         onerror="this.style.display='none'"
                         style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px; cursor: pointer;"
                         title="Click to view full size">
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <h3 class="file-link" data-path="${img.path}" style="margin: 0; color: var(--accent); font-size: 1rem; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Show in folder">${img.filename}</h3>
                            <button class="delete-btn" data-id="${img.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.2s;">X</button>
                        </div>
                        <small style="color: var(--text-secondary);">${date}</small>
                        <div style="margin-top: 0.25rem;">
                            <span class="badge" style="font-size: 0.7rem;">${analysis.scene_type || 'Unknown'}</span>
                        </div>
                    </div>
                </div>
                
                <p style="font-size: 0.9rem; color: var(--text-primary); margin-bottom: 1rem; line-height: 1.4;">
                    ${analysis.summary || 'No summary available'}
                </p>
                
                <div class="tags-section">
                    <div class="tags-container" style="margin-bottom: 0.5rem;">
                        <strong style="font-size: 0.75rem; color: var(--text-secondary); margin-right: 0.5rem;">Objects:</strong>
                        ${objects.slice(0, 10).map(obj => `<span class="tag editable" data-id="${img.id}" data-type="objects" data-tag="${obj}" style="cursor: context-menu; font-size: 0.75rem; background-color: rgba(16, 185, 129, 0.2); color: #34d399;">${obj}</span>`).join('')}
                        <button class="add-tag-btn" data-id="${img.id}" data-type="objects" title="Add Object">+</button>
                    </div>
                    <div class="tags-container">
                        <strong style="font-size: 0.75rem; color: var(--text-secondary); margin-right: 0.5rem;">Tags:</strong>
                        ${tags.slice(0, 10).map(tag => `<span class="tag editable" data-id="${img.id}" data-type="tags" data-tag="${tag}" style="cursor: context-menu; font-size: 0.75rem;">${tag}</span>`).join('')}
                        <button class="add-tag-btn" data-id="${img.id}" data-type="tags" title="Add Tag">+</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Global Event Listeners for Search Results (Delegation)
searchResults.addEventListener('click', (e) => {
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

// Context Menu Delegation
searchResults.addEventListener('contextmenu', (e) => {
    const tagEl = e.target.closest('.tag.editable');
    if (tagEl) {
        e.preventDefault();
        console.log('Right-click detected on tag:', tagEl.dataset.tag);
        showContextMenu(e, tagEl.dataset.id, tagEl.dataset.tag, tagEl.dataset.type);
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
let ctxTarget = null; // { id, tag, type }

function showContextMenu(e, id, tag, type) {
    ctxTarget = { id, tag, type };
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
    ctxTarget = null;
}

// Global click to hide context menu
document.addEventListener('click', hideContextMenu);

// Context Menu Actions
document.getElementById('ctxEdit').addEventListener('click', () => {
    if (!ctxTarget) return;
    const { id, tag, type } = ctxTarget;
    hideContextMenu();

    showTagInputModal(`Edit ${type.slice(0, -1)}`, tag, (newTag) => {
        if (newTag && newTag.trim() !== tag) {
            updateTag(id, type, tag, newTag.trim(), 'edit');
        }
    });
});

document.getElementById('ctxDelete').addEventListener('click', () => {
    if (!ctxTarget) return;
    const { id, tag, type } = ctxTarget;
    hideContextMenu();

    // We already have a delete modal for images, maybe we should use a custom one here too for consistency?
    // User said deleting tags worked (using confirm), so let's stick to confirm for now unless requested.
    // Actually, let's allow the native confirm for now as they said "can delete tags".
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

    // Use setTimeout to ensure focus applies after render cycle
    setTimeout(() => {
        input.focus();
        input.select();
    }, 10);

    const cleanup = () => {
        modal.remove();
        document.removeEventListener('keydown', keyHandler);
    };

    const save = () => {
        const val = input.value;
        cleanup();
        callback(val);
    };

    saveBtn.onclick = save;
    cancelBtn.onclick = cleanup;

    // Handle Enter and Escape on the input
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            save();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cleanup();
        }
    });

    // Global Escape handler (for closing modal without focusing input)
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };
    document.addEventListener('keydown', escHandler);

    // Ensure cleanup removes the escape handler
    const originalCleanup = cleanup;
    const enhancedCleanup = () => {
        document.removeEventListener('keydown', escHandler);
        modal.remove();
    };

    // Re-assign cleanup
    saveBtn.onclick = () => { const val = input.value; enhancedCleanup(); callback(val); };
    cancelBtn.onclick = enhancedCleanup;

    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) enhancedCleanup();
    };
}

// Custom Confirmation Modal (Replaces native confirm)
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
        const image = window.currentSearchResults.find(img => img.id == id);
        if (!image) throw new Error('Image not found in local cache');

        // Handle analysis correctly whether it's string or object
        let analysis = typeof image.analysis === 'string'
            ? JSON.parse(image.analysis || '{}')
            : (image.analysis || {});

        let list = analysis[type] || [];

        if (action === 'edit') {
            const idx = list.indexOf(oldTag);
            console.log(`[UPDATE-TAG] Edit action. Type: ${type}, Old: "${oldTag}", New: "${newTag}", Index: ${idx}`, list);
            if (idx !== -1) list[idx] = newTag;
            else console.warn(`[UPDATE-TAG] Tag "${oldTag}" not found in list!`);
        } else if (action === 'delete') {
            list = list.filter(t => t !== oldTag);
        } else if (action === 'add') {
            if (!list.includes(newTag)) list.push(newTag);
        }

        analysis[type] = list; // Update the list

        // Send update
        const response = await fetch(`${API_BASE_URL}/update-tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, analysis })
        });

        if (!response.ok) throw new Error('Update failed');

        // Update local cache - store as string to match initial load format if that's how it comes
        image.analysis = JSON.stringify(analysis);

        // Refresh search to show changes
        await performSearch();

    } catch (error) {
        console.error('Tag update error:', error);
        alert('Failed to update tags: ' + error.message);
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search Images';
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
