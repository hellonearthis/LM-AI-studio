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
// TOAST NOTIFICATIONS
// ============================================================================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;

    // Choose icon
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `
        <span style="font-size: 1.2rem;">${icon}</span>
        <span>${message}</span>
    `;

    document.body.appendChild(toast);

    // Auto remove
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s forwards';
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}

// ============================================================================
// MAIN FUNCTION - LOAD DATABASE
// ============================================================================
// ============================================================================
// MAIN FUNCTION - LOAD DATABASE (INFINITE SCROLL)
// ============================================================================
const API_BASE_URL = 'http://localhost:3000';

// State for infinite scroll
let imagesData = [];
let currentPage = 1;
const PAGE_SIZE = 50;
let totalImages = 0;
let isLoading = false;
let hasMore = true;
let isSelectionMode = false;
let selectedIds = new Set();
let observer = null;

/**
 * Initializes the database viewer.
 * - Resets all pagination state.
 * - Clears the current grid.
 * - Triggers the first page load via `loadNextPage()`.
 */
async function initDatabase() {
    try {
        // Reset state
        imagesData = [];
        currentPage = 1;
        isLoading = false;
        hasMore = true;
        dbGrid.innerHTML = '';

        loadingDb.style.display = 'block';
        loadingDb.textContent = 'Loading database...';

        await loadNextPage();

    } catch (error) {
        console.error('Error:', error);
        loadingDb.style.display = 'block';
        loadingDb.textContent = 'Error loading database. Please check console.';
    }
}

/**
 * Loads the next page of images from the server.
 * - Checks if already loading or if no more pages exist.
 * - Appends new data to `imagesData` cache.
 * - Renders the new batch of images to the DOM.
 * - Updates the sentinel for infinite scrolling.
 */
async function loadNextPage() {
    if (isLoading || !hasMore) return;

    isLoading = true;
    console.log(`[DB] Fetching page ${currentPage}...`);

    try {
        const sortSelect = document.getElementById('sortSelect');
        const sort = sortSelect ? sortSelect.value : 'recent_update';

        const response = await fetch(`${API_BASE_URL}/images?page=${currentPage}&limit=${PAGE_SIZE}&sort=${sort}`);
        if (!response.ok) throw new Error('Failed to load images');

        const data = await response.json();
        const newImages = data.images.map(img => {
            if (typeof img.analysis === 'string') {
                try { img.analysis = JSON.parse(img.analysis || '{}'); } catch (e) { img.analysis = {}; }
            }
            return img;
        });

        imagesData.push(...newImages); // Keep local cache in sync for tag updates

        totalImages = data.total;
        hasMore = currentPage < data.totalPages;

        // Update the entry count in the header
        const dbCount = document.getElementById('dbCount');
        if (dbCount) dbCount.textContent = totalImages;

        if (totalImages === 0) {
            dbGrid.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No images saved yet.</p>';
            loadingDb.style.display = 'none';
            return;
        }

        renderBatch(newImages);

        currentPage++;
        loadingDb.style.display = 'none';

        // Setup Sentinel if it's the first page
        if (currentPage === 2) {
            setupSentinel();
        }

    } catch (err) {
        console.error('[DB] Page Load Error:', err);
    } finally {
        isLoading = false;
    }
}

function setupSentinel() {
    let sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'scroll-sentinel';
        sentinel.style.width = '100%';
        sentinel.style.height = '100px'; // Larger sentinel
        sentinel.style.marginTop = '20px';
        dbGrid.parentNode.appendChild(sentinel);
    }
    setupIntersectionObserver(sentinel);
}

function renderBatch(newImages) {
    // Generate HTML for batch
    const batchHtml = newImages.map(img => createCardHtml(img)).join('');
    // Append to grid
    dbGrid.insertAdjacentHTML('beforeend', batchHtml);
}



function setupIntersectionObserver(sentinel) {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !isLoading && hasMore) {
            loadNextPage();
        }
    }, { rootMargin: '400px' }); // Load early

    observer.observe(sentinel);
}

/**
 * Generates the HTML for a single image card.
 * @param {Object} img - The image object containing metadata and analysis.
 * @returns {string} The HTML string for the card.
 */
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
    const width = img.width || metadata.ImageWidth || metadata.ExifImageWidth || metadata.PixelXDimension || 'N/A';
    const height = img.height || metadata.ImageHeight || metadata.ExifImageHeight || metadata.PixelYDimension || 'N/A';

    // Format full metadata
    const metadataStr = Object.entries(metadata)
        .filter(([key]) => !['ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight'].includes(key))
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n');

    // Thumbnail path logic
    const filenameBase = img.filename.substring(0, img.filename.lastIndexOf('.')) || img.filename;
    const displayPath = `thumbnails/${filenameBase}.avif`;

    const fullPath = img.path;
    const isSelected = selectedIds.has(String(img.id));

    return `
        <div class="card ${isSelected ? 'selected' : ''}" data-id="${img.id}">
            <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
                <!--Thumbnail Image -->
                <img src="${displayPath}" 
                        data-fullpath="${fullPath}"
                        class="thumbnail-preview"
                        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                        style="width: 100px; height: 100px; object-fit: cover; border-radius: 6px; cursor: pointer;"
                        title="Click to view full size">
                <!-- Fallback -->
                <div class="thumb-fallback" style="display: none; width: 100px; height: 100px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; flex-direction: column; align-items: center; justify-content: center; gap: 0.25rem; font-size: 0.7rem; color: var(--text-secondary); text-align: center; padding: 0.5rem;">
                    <span>No Preview</span>
                    <button class="regen-thumb-btn" data-id="${img.id}" style="background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); cursor: pointer; border-radius: 4px; padding: 2px 6px; font-size: 0.65rem;" title="Regenerate Thumbnail">
                        🔄 Regen
                    </button>
                </div>
                <!-- Image Info -->
                <div style="flex: 1;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <div style="flex: 1; min-width: 0;">
                            <h2 class="card-filename file-link" data-path="${img.path}" style="margin: 0; border: none; font-size: 1.1rem; cursor: pointer; color: var(--accent); text-decoration: none; display: block;" title="${(metadataStr || 'No extra metadata').replace(/"/g, '&quot;')}">${img.filename}</h2>
                            <small style="color: var(--text-secondary);">${date} • ${width}w ${height}h</small>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-end;">
                            <button class="delete-btn" data-id="${img.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.2s;" title="Delete Image">X</button>
                            <!-- Selection Checkbox -->
                            <div style="display: flex; align-items: center; gap: 0.25rem;">
                                <input type="checkbox" class="card-select-cb" data-id="${img.id}" ${isSelected ? 'checked' : ''} style="cursor: pointer; transform: scale(1.2);">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- AI Summary Section -->
            <div class="analysis-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <h3 style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">AI Summary</h3>
                    <button class="copy-btn" data-text="${(analysis.summary || '').replace(/"/g, '&quot;')}" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; cursor: pointer; font-size: 0.65rem; white-space: nowrap;" title="Copy to clipboard">Copy</button>
                </div>
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

// Handle Regenerate Thumbnail and Copy Click (Delegated)
dbGrid.addEventListener('click', async (e) => {
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

    if (e.target.classList.contains('regen-thumb-btn')) {
        const btn = e.target;
        const id = btn.dataset.id;

        btn.disabled = true;
        btn.textContent = '...';

        try {
            const response = await fetch(`${API_BASE_URL}/regenerate-thumbnail`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });

            if (response.ok) {
                const data = await response.json();
                // Find grid item and update image src to force reload
                const card = btn.closest('.card');
                const img = card.querySelector('.thumbnail-preview');
                const fallback = card.querySelector('.thumb-fallback');

                // Add timestamp to force browser cache bypass
                img.src = `${data.thumbPath}?t=${Date.now()}`;
                img.style.display = 'block';
                fallback.style.display = 'none';

            } else {
                showToast('Failed to regenerate thumbnail', 'error');
            }
        } catch (err) {
            console.error('Regen error:', err);
            showToast('Error regenerating thumbnail', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '🔄 Regen';
        }
    }
});

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
            showToast('Failed to load image', 'error');
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
        showToast(`Image File Not Found!\nPath: ${imagePath}`, 'error');
    }
}

// [Deleted old deleteFromDatabase - see new implementation below]

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
        showToast('This feature requires Electron.', 'error');
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
        const confirmed = await showModal(
            'Run Database Check?',
            'This will:\n1. Remove entries for missing files\n2. Regenerate missing thumbnails\n3. Fix basic data issues',
            true
        );

        if (!confirmed) return;

        validateBtn.disabled = true;
        validationStatus.style.display = 'block';
        validationText.textContent = 'Running integrity check...';
        validationProgressBar.style.width = '30%'; // Fake progress start

        try {
            const response = await fetch(`${API_BASE_URL}/validate-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reanalyze: false }) // Default to false for speed
            });

            if (!response.ok) throw new Error('Validation failed');

            const data = await response.json();
            const res = data.results;

            validationProgressBar.style.width = '100%';

            let message = `<strong>Check Complete</strong><br>`;
            if (res.missing > 0) message += `🗑️ Removed ${res.missing} missing files<br>`;
            if (res.fixedThumbnails > 0) message += `🖼️ Fixed ${res.fixedThumbnails} thumbnails<br>`;
            if (res.errors.length > 0) message += `⚠️ ${res.errors.length} errors occurred`;

            if (res.missing === 0 && res.fixedThumbnails === 0 && res.errors.length === 0) {
                message += "✅ Database is healthy!";
            }

            validationText.innerHTML = message;

            // Refresh grid if changes were made
            if (res.missing > 0 || res.fixedThumbnails > 0) {
                setTimeout(() => {
                    initDatabase(); // Reload current view
                }, 1000);
            }

        } catch (err) {
            console.error('Validation error:', err);
            validationText.textContent = 'Error: ' + err.message;
            validationProgressBar.style.backgroundColor = '#ef4444';
        } finally {
            validateBtn.disabled = false;
        }
    });
}

// ============================================================================
// SELECTION & BATCH ANALYSIS
// ============================================================================
const selectMissingBtn = document.getElementById('selectMissingBtn');
const unselectAllBtn = document.getElementById('unselectAllBtn');
const processSelectedBtn = document.getElementById('processSelectedBtn');
const dbPromptType = document.getElementById('dbPromptType');

// Custom Modal Elements
const customModal = document.getElementById('customModal');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalConfirm = document.getElementById('modalConfirm');
const modalHasCancel = document.getElementById('modalHasCancel');

// Helper: Custom Modal
function showModal(title, message, isConfirm = false) {
    return new Promise((resolve) => {
        if (!customModal) {
            // Fallback if modal elements aren't found (shouldn't happen)
            if (isConfirm) resolve(confirm(message));
            else { showToast(message, 'info'); resolve(true); }
            return;
        }

        modalTitle.textContent = title;
        modalMessage.innerHTML = message.replace(/\n/g, '<br>'); // Support simple line breaks

        modalHasCancel.style.display = isConfirm ? 'block' : 'none';
        modalConfirm.textContent = isConfirm ? 'Confirm' : 'OK';

        customModal.style.display = 'flex';

        const handleConfirm = () => {
            cleanup();
            resolve(true);
        };

        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            modalConfirm.removeEventListener('click', handleConfirm);
            modalHasCancel.removeEventListener('click', handleCancel);
            customModal.style.display = 'none';
        };

        modalConfirm.addEventListener('click', handleConfirm);
        modalHasCancel.addEventListener('click', handleCancel);
    });
}

// 1. Select Missing
if (selectMissingBtn) {
    selectMissingBtn.addEventListener('click', () => {
        let count = 0;
        imagesData.forEach(img => {
            let analysis = {};
            try {
                analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis) : (img.analysis || {});
            } catch (e) { }

            // Criteria: Missing Summary OR Missing Tags OR Missing Objects OR Missing Resolution
            if (!analysis.summary || !analysis.tags || analysis.tags.length === 0 || !analysis.objects || analysis.objects.length === 0 || !img.width || !img.height) {
                selectedIds.add(String(img.id));
                count++;

                // Updates visual check
                const checkbox = document.querySelector(`.card-select-cb[data-id="${img.id}"]`);
                if (checkbox) checkbox.checked = true;

                const card = document.querySelector(`.card[data-id="${img.id}"]`);
                if (card) card.classList.add('selected');
            }
        });

        if (count > 0) {
            updateProcessButton();
            // Optional: Removed success alert to be less intrusive
        } else {
            showModal('Auto-Selection', 'No loaded images found with missing data.');
        }
    });
}

// 2. Unselect All
if (unselectAllBtn) {
    unselectAllBtn.addEventListener('click', () => {
        selectedIds.clear();
        document.querySelectorAll('.card-select-cb').forEach(cb => cb.checked = false);
        document.querySelectorAll('.card.selected').forEach(card => card.classList.remove('selected'));
        updateProcessButton();
    });
}

// 3. Handle Individual Selection (Delegated from Grid)
dbGrid.addEventListener('change', (e) => {
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

    // Show/Hide Unselect All Button
    if (unselectAllBtn) {
        unselectAllBtn.style.display = count > 0 ? 'block' : 'none';
    }
}

// 4. Process Selected
if (processSelectedBtn) {
    processSelectedBtn.addEventListener('click', async () => {
        if (selectedIds.size === 0) return;

        if (!await showModal('Confirm Processing', `Re-analyze ${selectedIds.size} images with mode: "<strong>${dbPromptType.value}</strong>"?`, true)) {
            return;
        }

        processSelectedBtn.disabled = true;
        processSelectedBtn.textContent = 'Processing...';

        // Cancellation support
        let isCancelled = false;
        const closeBtn = document.getElementById('closeStatus');
        const cancelHandler = () => { isCancelled = true; };
        if (closeBtn) closeBtn.addEventListener('click', cancelHandler, { once: true });

        try {
            const ids = Array.from(selectedIds);
            const promptType = dbPromptType.value;
            const total = ids.length;
            let successCount = 0;
            let failedCount = 0;
            const errors = [];

            // Show status
            validationStatus.style.display = 'block';
            validationText.textContent = `Starting batch processing...`;
            validationProgressBar.style.width = '0%';

            for (let i = 0; i < total; i++) {
                if (isCancelled) {
                    validationText.textContent = 'Processing cancelled.';
                    break;
                }

                validationText.textContent = `Processing image ${i + 1} of ${total}...`;

                try {
                    const id = ids[i];
                    // Sequential Request
                    const response = await fetch(`${API_BASE_URL}/batch-analyze`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: [id], promptType })
                    });

                    if (!response.ok) throw new Error('API request failed');

                    const result = await response.json();

                    if (result.success > 0 && result.updatedImages && result.updatedImages.length > 0) {
                        successCount++;
                        const updated = result.updatedImages[0];

                        // Update Local Cache
                        const localImg = imagesData.find(img => img.id == updated.id);
                        if (localImg) {
                            localImg.analysis = updated.analysis;
                            localImg.updated_at = updated.updated_at;
                            if (updated.width) localImg.width = updated.width;
                            if (updated.height) localImg.height = updated.height;
                            if (updated.size) localImg.size = updated.size;

                            // Update DOM
                            const existingCard = document.querySelector(`.card[data-id="${updated.id}"]`);
                            if (existingCard) {
                                const newCardHtml = createCardHtml(localImg);
                                const temp = document.createElement('div');
                                temp.innerHTML = newCardHtml;
                                existingCard.replaceWith(temp.firstElementChild);
                            }
                        }
                    } else {
                        failedCount++;
                        if (result.errors) errors.push(...result.errors);
                    }

                } catch (err) {
                    console.error(`Error processing ID ${ids[i]}:`, err);
                    failedCount++;
                    errors.push(`${ids[i]}: ${err.message}`);
                }

                // Update Progress Bar
                const percent = Math.round(((i + 1) / total) * 100);
                validationProgressBar.style.width = `${percent}%`;
            }

            validationProgressBar.style.width = '100%';
            validationText.innerHTML = `
                <strong>Batch Complete!</strong><br>
                Success: ${successCount} | Failed: ${failedCount}
                ${isCancelled ? '<br>(Cancelled)' : ''}
            `;

            // Auto-close if success
            if (successCount > 0 && failedCount === 0 && !isCancelled) {
                setTimeout(() => {
                    validationStatus.style.display = 'none';
                    validationProgressBar.style.width = '0%';
                }, 4000);
            }

            // Auto-Deselect
            if (!isCancelled) {
                if (unselectAllBtn) {
                    unselectAllBtn.click();
                } else {
                    selectedIds.clear();
                    document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
                    document.querySelectorAll('.card-select-cb').forEach(cb => cb.checked = false);
                    updateProcessButton();
                }
            }

        } catch (error) {
            console.error('Batch Process Error:', error);
            validationText.textContent = 'Error: ' + error.message;
            validationProgressBar.style.backgroundColor = '#ef4444';
        } finally {
            if (closeBtn) closeBtn.removeEventListener('click', cancelHandler);
            updateProcessButton();
            processSelectedBtn.disabled = false;
            processSelectedBtn.textContent = 'Process';
        }
    });
}

// 5. Delete Button Handler (Delegated)
document.addEventListener('click', async (e) => {
    // Check if clicked element is delete button or inside it
    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation(); // Essential!

        const id = deleteBtn.dataset.id;
        if (id) {
            await deleteFromDatabase(id);
        }
    }
});

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
    const isFileLink = e.target.closest('.file-link');
    const renameItem = document.getElementById('ctxRename');

    document.getElementById('ctxRegenThumb').style.display = type === 'thumbnail' ? 'block' : 'none';
    document.getElementById('ctxEdit').style.display = type === 'tag' ? 'block' : 'none';
    document.getElementById('ctxDelete').style.display = type === 'tag' ? 'block' : 'none';

    if (renameItem) {
        renameItem.style.display = (type === 'file' || isFileLink) ? 'block' : 'none';
        if (isFileLink && !tag) ctxTarget.tag = isFileLink.textContent.trim();
    }

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

    // Filename Right-Click
    const fileLink = e.target.closest('.file-link');
    if (fileLink) {
        e.preventDefault();
        e.stopPropagation();
        const card = fileLink.closest('.card');
        const id = card.dataset.id;
        showContextMenu(e, id, 'file', fileLink.textContent.trim(), card);
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
            if (newName.match(/[<>:"\/\\|?*]/)) {
                alert('Invalid characters in filename.');
                return;
            }

            try {
                const res = await fetch(`${API_BASE_URL}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, newFilename: newName })
                });

                if (!res.ok) throw new Error((await res.json()).error || 'Rename failed');

                const data = await res.json();

                // Update UI
                const card = document.querySelector(`.card[data-id="${id}"]`);
                if (card) {
                    const fileLink = card.querySelector('.file-link');
                    if (fileLink) {
                        fileLink.textContent = data.newFilename;
                        fileLink.dataset.path = data.newPath;
                    }
                    const img = imagesData.find(i => i.id == id);
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
    showTagInputModal(`Add new ${type.slice(0, -1)}`, '', (inputValue) => {
        if (inputValue && inputValue.trim()) {
            // Split by comma to support multiple tags
            const tags = inputValue.split(',').map(t => t.trim()).filter(t => t.length > 0);

            tags.forEach(newTag => {
                updateTag(id, type, null, newTag, 'add');
            });

            if (tags.length > 0) {
                showToast(`Added ${tags.length} tag(s)`, 'success');
            }
        }
    });
}

// Update Tag Backend Call
async function updateTag(id, type, oldTag, newTag, action) {
    try {
        const image = imagesData.find(img => img.id == id);
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
        showToast('Failed to update tags: ' + error.message, 'error');
    }
}

async function deleteFromDatabase(id) {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (!card) return;

    // Get filename for context
    const filenameEl = card.querySelector('.card-filename') || card.querySelector('.text-accent'); // Fallback
    const filename = filenameEl ? filenameEl.textContent.trim() : 'Image';

    // 3-Option Delete Modal
    showDeleteOptionsModal(filename, async (action) => {
        if (action === 'cancel') return;

        try {
            const deleteFile = (action === 'delete-file');

            const response = await fetch(`${API_BASE_URL}/delete-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, deleteFile })
            });

            if (!response.ok) throw new Error('Delete failed');

            // Remove from UI
            card.remove();

            // Remove from selection if present
            selectedIds.delete(String(id));
            updateProcessButton();

        } catch (error) {
            console.error('Delete error:', error);
            showToast('Failed to delete: ' + error.message, 'error');
        }
    });
}

function showDeleteOptionsModal(filename, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    modal.innerHTML = `
        <div style="background: var(--card-bg); padding: 1rem; border-radius: 12px; border: 1px solid var(--border); max-width: 500px; width: 90%; text-align: center;">
            <h3 style="margin-top: 0; color: var(--text-primary);">Delete Image?</h3>
            <p style="color: var(--text-secondary); margin-bottom: 1rem;">
                Action for: <strong style="color: var(--accent);">${filename}</strong>
            </p>
            <div style="display: flex; flex-direction: column; gap: 1rem;">
                <button id="btnDbOnly" style="padding: 1rem; border-radius: 8px; border: 1px solid var(--border); background: #a05806ff; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                    <span>🗑️</span> Remove from Database (Keep File)
                </button>
                <button id="btnCancel" style="padding: 1.25rem; border-radius: 8px; border: 1px solid #4fb2a3; background: #4b7e91ff; color: white; cursor: pointer; font-size: 2rem; margin-top: 1rem; margin-bottom: 1rem;">
                    Cancel
                </button>
                <button id="btnDeleteFile" style="padding: 1rem; border-radius: 8px; border: none; background: #991b1b; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 1rem;">
                    <span>⚠️</span> Delete File & Remove from Database
                </button>

            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        modal.remove();
    };

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
            callback('cancel');
        }
    };
    document.addEventListener('keydown', keyHandler);

    modal.querySelector('#btnDbOnly').onclick = () => {
        cleanup();
        callback('delete-db');
    };

    modal.querySelector('#btnDeleteFile').onclick = () => {
        cleanup();
        callback('delete-file');
    };

    modal.querySelector('#btnCancel').onclick = () => {
        cleanup();
        callback('cancel');
    };

    modal.onclick = (e) => {
        if (e.target === modal) {
            cleanup();
            callback('cancel');
        }
    };
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
        console.error('Regenerate error:', error);
        showToast('Failed to regenerate thumbnail: ' + error.message, 'error');
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
