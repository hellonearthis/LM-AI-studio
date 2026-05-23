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

// WHAT: Escapes special characters within a given string that have semantic meaning in HTML.
// WHY: We replace characters like '&', '<', '>', '"', and "'" with their corresponding HTML safe entity values.
// This prevents the web browser from interpreting user-supplied or AI-generated string fields as HTML code,
// thereby neutralizing potential Cross-Site Scripting (XSS) code injection attempts.
function escapeHtmlCharacters(input_string_to_be_escaped) {
    if (!input_string_to_be_escaped) {
        return '';
    }
    return String(input_string_to_be_escaped)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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

        // Initialize pretext measuring engine (waits for font load)
        if (window.PretextLayout) {
            await window.PretextLayout.init();
        }

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

/**
 * Sets up an invisible 'sentinel' element at the bottom of the grid.
 * When this element enters the viewport, the IntersectionObserver triggers 
 * the next page of results to load, creating an 'infinite scroll' effect.
 */
function setupSentinel() {
    let scrollSentinel = document.getElementById('scroll-sentinel');
    if (!scrollSentinel) {
        scrollSentinel = document.createElement('div');
        scrollSentinel.id = 'scroll-sentinel';
        scrollSentinel.style.width = '100%';
        scrollSentinel.style.height = '100px'; // Tall enough to trigger reliably
        scrollSentinel.style.marginTop = '20px';
        dbGrid.parentNode.appendChild(scrollSentinel);
    }
    setupIntersectionObserver(scrollSentinel);
}

/**
 * Renders a list of image objects into the DOM.
 * This function handles two critical performance tasks:
 * 1. Pre-measuring text height via Pretext to prevent layout shifts.
 * 2. Applying intelligent lazy loading to optimize LCP.
 */
function renderBatch(newImages) {
    // PRE-MEASUREMENT STEP (The 'Why'):
    // We use PretextLayout to calculate exactly how many pixels of height the 
    // AI summary text will need BEFORE we actually put it in the DOM. 
    // This allows the masonry grid to calculate the correct card positions 
    // instantly, preventing the page from 'jumping' as text renders.
    let summaryHeightsMap = new Map();
    if (window.PretextLayout && window.PretextLayout.ready) {
        const gridWidth = dbGrid.offsetWidth > 0 ? dbGrid.offsetWidth : 1000;
        // Calculate responsive column count to match CSS breakpoints
        const colCount = Math.max(1, Math.floor((gridWidth + 16) / (320 + 16)));
        const actualCardWidth = (gridWidth - (colCount - 1) * 16) / colCount;
        const textWidth = actualCardWidth - 24; // Account for card padding (0.75rem * 2)

        const textItemsToMeasure = newImages.map(img => {
            const analysis = (typeof img.analysis === 'string')
                ? JSON.parse(img.analysis || '{}') : (img.analysis || {});
            return { id: img.id, text: analysis.summary || '' };
        });

        summaryHeightsMap = window.PretextLayout.measureBatch(textItemsToMeasure, textWidth, 'database');
    }

    // HTML GENERATION STEP:
    // We map over our image data and convert each record into a string of HTML.
    const batchHtml = newImages.map((img, index) => {
        const measuredHeight = summaryHeightsMap.get(String(img.id));
        
        // INTELLIGENT LOADING (The 'Why'):
        // Images at the top of the first page are visible immediately (LCP). 
        // We set the first image to 'fetchpriority=high' and the first row to 'loading=eager'
        // so the browser downloads them instantly rather than waiting for JS to finish.
        const isPriorityImage = (currentPage === 1 && index === 0);
        const isEagerLoad = (currentPage === 1 && index < 4);
        
        return createCardHtml(img, measuredHeight, isPriorityImage, isEagerLoad);
    }).join('');

    // Final DOM injection
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
// Helper: Measure pretext height for a single card update
function measureSingleCardHeight(img, context = 'database') {
    if (!window.PretextLayout || !window.PretextLayout.ready) return undefined;
    let analysis = img.analysis;
    if (typeof analysis === 'string') {
        try { analysis = JSON.parse(analysis || '{}'); } catch (e) { analysis = {}; }
    }
    analysis = analysis || {};
    const summaryText = analysis.summary || '';
    if (!summaryText) return undefined;

    let textWidth = 296; // Safe fallback
    const existingCard = document.querySelector(`.card[data-id="${img.id}"]`);
    if (existingCard && existingCard.clientWidth > 0) {
        textWidth = existingCard.clientWidth - 24;
    } else {
        const gridWidth = dbGrid.offsetWidth > 0 ? dbGrid.offsetWidth : 1000;
        const colCount = Math.max(1, Math.floor((gridWidth + 16) / (320 + 16)));
        const actualCardWidth = (gridWidth - (colCount - 1) * 16) / colCount;
        textWidth = actualCardWidth - 24;
    }
    const result = window.PretextLayout.measureText(summaryText, textWidth, context);
    return result.height;
}

const BRICKS_GRADS = ['purple', 'blue', 'green', 'orange', 'pink'];
function getCardGrad(id) {
    const numericId = typeof id === 'string' ? id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : id;
    return BRICKS_GRADS[numericId % BRICKS_GRADS.length];
}

function createCardHtml(img, summaryHeight, isPriority = false, isEager = false) {
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

    // Thumbnail path logic (ID-based)
    const timeStamp = img.updated_at ? new Date(img.updated_at).getTime() : (img.created_at ? new Date(img.created_at).getTime() : '');
    const displayPath = `thumbnails/id_${img.id}.avif${timeStamp ? '?t=' + timeStamp : ''}`;

    const fullPath = img.path;
    const isSelected = selectedIds.has(String(img.id));

    return `
        <div class="card ${isSelected ? 'selected' : ''}" data-id="${img.id}" data-grad="${getCardGrad(img.id)}">
            <div class="card-inner">
                <!-- FRONT FACE -->
                <div class="card-front">
                    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
                        <!--Thumbnail Image -->
                        <img src="${displayPath}" 
                                data-fullpath="${fullPath}"
                                class="thumbnail-preview"
                                loading="${isEager ? 'eager' : 'lazy'}"
                                decoding="async"
                                ${isPriority ? 'fetchpriority="high"' : ''}
                                width="100"
                                height="100"
                                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                                style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px; cursor: pointer;"
                                title="Click to view full size">
                        <!-- Fallback -->
                        <div class="thumb-fallback" style="display: none; width: 100px; height: 100px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; flex-direction: column; align-items: center; justify-content: center; gap: 0.25rem; font-size: 0.7rem; color: var(--text-secondary); text-align: center; padding: 0.5rem;">
                            <span>No Preview</span>
                            <button class="regen-thumb-btn" data-id="${img.id}" style="background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); cursor: pointer; border-radius: 4px; padding: 2px 6px; font-size: 0.65rem;" title="Regenerate Thumbnail">
                                🔄 Regen
                            </button>
                        </div>
                        <!-- Image Info -->
                        <div style="flex: 1; min-width: 0;">
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
                    <div class="analysis-section" style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                            <h3 style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">AI Summary</h3>
                            <button class="copy-btn" data-text="${(analysis.summary || '').replace(/"/g, '&quot;')}" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; cursor: pointer; font-size: 0.65rem; white-space: nowrap;" title="Copy to clipboard">Copy</button>
                        </div>
                        <p class="${summaryHeight ? 'pretext-measured' : ''}" style="margin: 0; font-size: 0.9rem; color: var(--text-primary); line-height: 1.5; ${summaryHeight ? ` min-height: ${summaryHeight}px;` : ''}">${analysis.summary || 'No summary'}</p>
                    </div>

                    <div style="margin-top: 1rem; text-align: right;">
                        <span style="font-size: 0.7rem; color: var(--text-secondary); opacity: 0.6;">Click card to reveal details ↻</span>
                    </div>
                </div>

                <!-- BACK FACE -->
                <div class="card-back">
                    <div class="tags-section">
                        <div class="tags-container" style="margin-bottom: 1rem;">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Detected Objects:</strong>
                            ${(analysis.objects || []).map(obj => `<span class="tag editable" data-id="${img.id}" data-type="objects" data-tag="${obj}" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399; cursor: pointer; font-size: 0.75rem; margin-bottom: 4px;" title="Click to search, Right-click to edit">${obj}</span>`).join('')}
                            <button class="add-tag-btn" data-id="${img.id}" data-type="objects" title="Add Object">+</button>
                        </div>
                        <div class="tags-container">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Image Tags:</strong>
                            ${(analysis.tags || []).map(tag => `<span class="tag editable" data-id="${img.id}" data-type="tags" data-tag="${tag}" style="cursor: pointer; font-size: 0.75rem; margin-bottom: 4px;" title="Click to search, Right-click to edit">${tag}</span>`).join('')}
                            ${analysis.scene_type ? `<span class="tag" style="background-color: rgba(129, 140, 248, 0.2); color: #818cf8; font-size: 0.75rem; margin-bottom: 4px;">${analysis.scene_type}</span>` : ''}
                            <button class="add-tag-btn" data-id="${img.id}" data-type="tags" title="Add Tag">+</button>
                        </div>
                    </div>

                    <div style="margin-top: 2rem; text-align: center;">
                        <span style="font-size: 0.75rem; color: var(--accent); cursor: pointer; padding: 0.5rem; border: 1px solid var(--accent); border-radius: 6px;" onclick="this.closest('.card').classList.remove('flipped')">Back to Summary</span>
                    </div>
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
        return;
    }
    
    // Tag Click (Redirect to Search)
    const tagEl = e.target.closest('.tag.editable');
    if (tagEl) {
        e.stopPropagation();
        const tagText = tagEl.dataset.tag;
        const dataType = tagEl.dataset.type; // 'tags' or 'objects'
        if (tagText) {
            const searchType = dataType === 'objects' ? 'object' : 'tag';
            window.location.href = `search.html?tag=${encodeURIComponent(tagText)}&type=${searchType}`;
        }
        return;
    }

    // NEW: Card Flip Toggle
    const card = e.target.closest('.card');
    if (card) {
        // Only flip if we didn't click an interactive element
        const isInteractive = e.target.closest('button, input, .file-link, .tag, .thumbnail-preview');
        if (!isInteractive) {
            card.classList.toggle('flipped');
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

        // Create hint element
        const hint = document.createElement('div');
        hint.textContent = 'PRESS ANY KEY or Click anywhere TO EXIT';
        hint.style.cssText = `
            position: absolute;
            top: 2rem;
            left: 50%;
            transform: translateX(-50%);
            color: rgba(255,255,255,0.5);
            font-size: 0.9rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            pointer-events: none;
            background: rgba(0,0,0,0.3);
            padding: 0.5rem 1rem;
            border-radius: 20px;
        `;
        modal.appendChild(hint);

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

async function showIntegrityCheckModal() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);';

        modal.innerHTML = `
            <div style="background: var(--bg-secondary); padding: 2.5rem; border-radius: 16px; border: 1px solid var(--border); max-width: 450px; width: 90%; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <h3 style="margin: 0 0 1.5rem 0; color: var(--accent); font-size: 1.5rem; display: flex; align-items: center; gap: 0.75rem;">
                    <span>🛡️</span> Database Integrity Check
                </h3>
                
                <p style="color: var(--text-secondary); margin-bottom: 2rem; font-size: 0.95rem; line-height: 1.5;">
                    Select the tasks you would like to perform during the maintenance pass:
                </p>

                <div style="display: flex; flex-direction: column; gap: 1.25rem; margin-bottom: 2.5rem;">
                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s; hover: background: rgba(255,255,255,10.05);">
                        <input type="checkbox" id="icRemoveMissing" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Remove Missing Files</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Delete database records for files no longer on disk.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRepairMetadata" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Repair Metadata</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Fix missing dimensions, resolution, and file size data.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRegenThumb" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Regenerate Thumbnails</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Rebuild missing thumbnails using the new unique ID scheme.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 1rem; border-radius: 8px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2);">
                        <input type="checkbox" id="icPurgeThumb" style="width: 18px; height: 18px; accent-color: #ef4444;">
                        <div>
                            <div style="color: #ef4444; font-weight: 600;">Purge Legacy Thumbnails</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Wipe all old thumbnails to fix collisions. (Recommended)</div>
                        </div>
                    </label>
                </div>

                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="icCancelBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.6rem 1.25rem; border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                    <button id="icRunBtn" style="background: var(--accent); border: none; color: white; padding: 0.6rem 2rem; border-radius: 8px; cursor: pointer; font-weight: 600;">Run Check</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('#icCancelBtn').onclick = () => {
            modal.remove();
            resolve(null);
        };

        modal.querySelector('#icRunBtn').onclick = () => {
            const options = {
                removeMissing: modal.querySelector('#icRemoveMissing').checked,
                repairMetadata: modal.querySelector('#icRepairMetadata').checked,
                regenThumbnails: modal.querySelector('#icRegenThumb').checked,
                purgeThumbnails: modal.querySelector('#icPurgeThumb').checked
            };
            modal.remove();
            resolve(options);
        };
    });
}

if (validateBtn) {
    validateBtn.addEventListener('click', async () => {
        const options = await showIntegrityCheckModal();
        if (!options) return;

        validateBtn.disabled = true;
        const originalText = validateBtn.innerHTML;
        validateBtn.innerHTML = '🔄 Checking...';

        let validateInterval;

        if (validationStatus) {
            validationStatus.style.display = 'block';
            validationText.textContent = 'Starting integrity check...';
            validationProgressBar.style.width = '2%';

            validateInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/validate-status`);
                    if (statusRes.ok) {
                        const statusData = await statusRes.json();
                        validationText.textContent = statusData.status;
                        validationProgressBar.style.width = `${Math.max(2, statusData.progress)}%`;
                    }
                } catch(e) {}
            }, 250);
        }

        try {
            const res = await fetch(`${API_BASE_URL}/validate-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ options, reanalyze: false })
            });

            if (validateInterval) clearInterval(validateInterval);

            if (!res.ok) throw new Error('Validation failed');

            const data = await res.json();
            const r = data.results;

            if (validationProgressBar) validationProgressBar.style.width = '100%';

            let message = `<strong>Check Complete</strong><br>`;
            if (r.purged > 0) message += `🔥 Purged ${r.purged} legacy thumbnails<br>`;
            if (r.duplicatesRemoved > 0) message += `🧹 Removed ${r.duplicatesRemoved} duplicates<br>`;
            if (r.metadataRepaired > 0) message += `🔧 Repaired ${r.metadataRepaired} metadata<br>`;
            if (r.missing > 0) message += `🗑️ Removed ${r.missing} missing files<br>`;
            if (r.fixedThumbnails > 0) message += `🖼️ Fixed ${r.fixedThumbnails} thumbnails<br>`;
            if (r.errors.length > 0) message += `⚠️ ${r.errors.length} errors occurred`;

            if (r.purged === 0 && r.duplicatesRemoved === 0 && r.metadataRepaired === 0 && r.missing === 0 && r.fixedThumbnails === 0 && r.errors.length === 0) {
                message += "✅ Database is healthy!";
            }

            validationText.innerHTML = message;
            
            // Auto-hide after 5 seconds if successful
            setTimeout(() => {
                if (validationStatus.style.display === 'block' && !message.includes('Error')) {
                    validationStatus.style.display = 'none';
                    validationProgressBar.style.width = '0%';
                }
            }, 5000);

            // Refresh grid if changes were made
            if (r.missing > 0 || r.fixedThumbnails > 0 || r.purged > 0) {
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
            validateBtn.innerHTML = originalText;
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
// WHAT: Opens, configures, and displays the app-wide general message modal dialog.
// WHY: This central overlay modal is used for notifications or basic binary confirm prompts. By escaping the
// message using `escapeHtmlCharacters` before replacing line breaks with `<br>` tags, we guarantee XSS safety
// while still supporting multi-line spacing structure in the dialogue.
function showModal(modal_dialogue_header_title_text, modal_dialogue_body_message_text, is_confirmation_prompt_boolean = false) {
    return new Promise((promise_resolution_handler_function) => {
        if (!customModal) {
            // WHAT: Fallback logic using native alerts/confirms if the custom modal elements are not found in the DOM.
            // WHY: Ensures the application remains functional even in anomalous visual states.
            if (is_confirmation_prompt_boolean) {
                promise_resolution_handler_function(confirm(modal_dialogue_body_message_text));
            } else {
                showToast(modal_dialogue_body_message_text, 'info');
                promise_resolution_handler_function(true);
            }
            return;
        }

        // WHAT: Assigning the text parameters and escaping inputs to shield the element from script injections.
        // WHY: Escaping ensures any dynamic data or error messages inside the body are rendered safely.
        modalTitle.textContent = modal_dialogue_header_title_text;
        
        const escaped_modal_dialogue_body_message_text = escapeHtmlCharacters(modal_dialogue_body_message_text);
        modalMessage.innerHTML = escaped_modal_dialogue_body_message_text.replace(/\n/g, '<br>');

        modalHasCancel.style.display = is_confirmation_prompt_boolean ? 'block' : 'none';
        modalConfirm.textContent = is_confirmation_prompt_boolean ? 'Confirm' : 'OK';

        customModal.style.display = 'flex';

        // WHAT: Defining click event handlers for confirming or cancelling the modal choice.
        // WHY: The handlers close the dialogue and return the user's action through the promise scope.
        const confirm_selection_action_handler_function = () => {
            cleanup_modal_and_remove_event_listeners();
            promise_resolution_handler_function(true);
        };

        const cancel_selection_action_handler_function = () => {
            cleanup_modal_and_remove_event_listeners();
            promise_resolution_handler_function(false);
        };

        // WHAT: Dismantling click listeners and hiding the custom modal layout node.
        // WHY: Teardowns ensure no event trigger conflicts occur when the dialog is re-opened.
        const cleanup_modal_and_remove_event_listeners = () => {
            modalConfirm.removeEventListener('click', confirm_selection_action_handler_function);
            modalHasCancel.removeEventListener('click', cancel_selection_action_handler_function);
            customModal.style.display = 'none';
        };

        modalConfirm.addEventListener('click', confirm_selection_action_handler_function);
        modalHasCancel.addEventListener('click', cancel_selection_action_handler_function);
    });
}

/**
 * @function showBulkRenameModal
 * @description Creates and manages a custom HTML overlay for bulk renaming files.
 * Why a custom modal? Modern Electron environments often block native prompt() for security.
 * A custom UI also allows us to show the user exactly which files are targeted.
 * 
 * @param {Set} selectedIdsSet - A set of Image IDs currently selected in the UI.
 * @param {Array} imagesArray - The full local cache of image objects to pull filenames from.
 */
// WHAT: Creates, configures, and displays the batch rename modal dialogue.
// WHY: Batch file renames are high-impact metadata operations. We construct a scrollable visual list of targeted
// filenames. To prevent XSS injection, all targeted filenames and recent rename chip values are HTML-escaped
// using `escapeHtmlCharacters` before rendering. All variables are written according to the `can_be_long` protocol.
function showBulkRenameModal(selected_image_ids_set, cached_images_metadata_array) {
    return new Promise((promise_resolution_handler_function) => {
        // WHAT: Creating the modal container backdrop overlay element.
        // WHY: Overlays isolate user attention and block background document interactions.
        const bulk_rename_backdrop_element = document.createElement('div');
        bulk_rename_backdrop_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        // WHAT: Converting set IDs to human-readable filenames and escaping each to block script injection.
        // WHY: Filenames are loaded dynamically from filesystems and databases, presenting an XSS threat if rendered unescaped.
        const retrieved_target_filenames_list = Array.from(selected_image_ids_set).map((each_image_id_string) => {
            const matched_image_metadata_object = cached_images_metadata_array.find((each_cached_image) => {
                return String(each_cached_image.id) === each_image_id_string;
            });
            const filename_string_value = matched_image_metadata_object ? matched_image_metadata_object.filename : `Record ID: ${each_image_id_string}`;
            return escapeHtmlCharacters(filename_string_value);
        });

        // WHAT: Building scrollable list item HTML tags safely.
        // WHY: Limits preview list to 100 entries to prevent memory and DOM lag on large batch operations.
        const compiled_preview_list_items_html_string = retrieved_target_filenames_list.slice(0, 100).map((escaped_filename_item) => `
            <li style="padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-secondary); font-size: 0.85rem; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                📄 ${escaped_filename_item}
            </li>
        `).join('');

        const compiled_overflow_indicator_html_string = retrieved_target_filenames_list.length > 100 
            ? `<li style="padding: 0.25rem 0; color: var(--accent); font-size: 0.8rem; text-align: center;">...and ${retrieved_target_filenames_list.length - 100} more</li>` 
            : '';

        bulk_rename_backdrop_element.innerHTML = `
            <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 450px; width: 90%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5);">
                <h3 style="margin: 0 0 0.5rem 0; color: var(--text-primary); font-size: 1.25rem;">Bulk Rename</h3>
                <p style="margin: 0 0 1rem 0; color: var(--text-secondary); font-size: 0.9rem;">You are renaming ${selected_image_ids_set.size} file(s) in this batch.</p>
                
                <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem; margin-bottom: 1.5rem; max-height: 150px; overflow-y: auto;">
                    <ul style="list-style: none; padding: 0; margin: 0;">
                        ${compiled_preview_list_items_html_string}
                        ${compiled_overflow_indicator_html_string}
                    </ul>
                </div>

                <div style="margin-bottom: 1.5rem; text-align: left;">
                    <label style="display: block; color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.5rem;">New Base Name (e.g. "holiday")</label>

                    ${(() => {
                        const list_of_recent_renames_array = getRecentRenames();
                        if (list_of_recent_renames_array.length === 0) {
                            return '';
                        }
                        return `
                            <div id="recentRenamesContainer" style="margin-bottom: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px dashed rgba(167, 139, 250, 0.3);">
                                <span style="font-size: 0.7rem; color: var(--accent); width: 100%; margin-bottom: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Recent:</span>
                                ${list_of_recent_renames_array.map((each_recent_name_string) => {
                                    const escaped_recent_name_string = escapeHtmlCharacters(each_recent_name_string);
                                    return `
                                        <span class="recent-rename-chip" 
                                              style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); color: #c4b5fd; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s;"
                                              onmouseover="this.style.background='rgba(139, 92, 246, 0.3)'; this.style.borderColor='var(--accent)';"
                                              onmouseout="this.style.background='rgba(139, 92, 246, 0.15)'; this.style.borderColor='rgba(139, 92, 246, 0.3)';"
                                              onclick="document.getElementById('renameBaseInput').value = '${escaped_recent_name_string.replace(/'/g, "\\'")}'; document.getElementById('renameBaseInput').focus();">
                                            ${escaped_recent_name_string}
                                        </span>
                                    `;
                                }).join('')}
                            </div>
                        `;
                    })()}

                    <input type="text" id="renameBaseInput" placeholder="Enter base name..." style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-color); color: var(--text-primary); font-size: 1rem; outline: none;">
                    <p style="margin: 0.5rem 0 0 0; color: var(--text-secondary); font-size: 0.75rem;">Sequence logic: holiday_001, holiday_002, etc.</p>
                </div>

                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="cancelRenameBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; transition: all 0.2s;">Cancel</button>
                    <button id="goRenameBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Go</button>
                </div>
            </div>
        `;

        document.body.appendChild(bulk_rename_backdrop_element);

        const text_input_field_element = bulk_rename_backdrop_element.querySelector('#renameBaseInput');
        const confirm_action_button_element = bulk_rename_backdrop_element.querySelector('#goRenameBtn');
        const cancel_action_button_element = bulk_rename_backdrop_element.querySelector('#cancelRenameBtn');

        // WHAT: Automatically focusing the input text field after display rendering delay.
        // WHY: Guides user navigation seamlessly to start typing without requiring manual cursor clicks.
        setTimeout(() => {
            text_input_field_element.focus();
        }, 50);

        // WHAT: Standardizing modal closing logic and cleanups.
        // WHY: Removes structural events and element trees from active page memories when resolving promises.
        const close_modal_and_resolve_promise_action = (final_entered_value_string) => {
            document.removeEventListener('keydown', keyboard_event_handler_function);
            bulk_rename_backdrop_element.remove();
            promise_resolution_handler_function(final_entered_value_string);
        };

        const validate_and_submit_changes_action = () => {
            const trimmed_input_value_string = text_input_field_element.value.trim();
            if (trimmed_input_value_string) {
                close_modal_and_resolve_promise_action(trimmed_input_value_string);
            } else {
                // Flash border color in red to denote missing required text field values
                text_input_field_element.style.border = '1px solid #ef4444';
                setTimeout(() => {
                    text_input_field_element.style.border = '1px solid var(--border)';
                }, 1000);
            }
        };

        confirm_action_button_element.onclick = validate_and_submit_changes_action;
        cancel_action_button_element.onclick = () => {
            close_modal_and_resolve_promise_action(null);
        };

        // WHAT: Capturing general keystrokes specifically inside document contexts.
        // WHY: Intercepts Escape and Enter keypress mappings for accessible navigation controls.
        const keyboard_event_handler_function = (keyboard_event_object) => {
            if (keyboard_event_object.key === 'Escape') {
                keyboard_event_object.preventDefault();
                close_modal_and_resolve_promise_action(null);
            } else if (keyboard_event_object.key === 'Enter') {
                keyboard_event_object.preventDefault();
                validate_and_submit_changes_action();
            }
        };

        document.addEventListener('keydown', keyboard_event_handler_function);
        
        cancel_action_button_element.onmouseover = () => {
            cancel_action_button_element.style.background = 'rgba(255,255,255,0.05)';
        };
        cancel_action_button_element.onmouseout = () => {
            cancel_action_button_element.style.background = 'transparent';
        };
        confirm_action_button_element.onmouseover = () => {
            confirm_action_button_element.style.filter = 'brightness(1.1)';
        };
        confirm_action_button_element.onmouseout = () => {
            confirm_action_button_element.style.filter = 'brightness(1)';
        };
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

    const bulkRenameBtn = document.getElementById('bulkRenameBtn');
    if (bulkRenameBtn) {
        bulkRenameBtn.disabled = count === 0;
        bulkRenameBtn.style.opacity = count === 0 ? '0.5' : '1';
    }

    // Show/Hide Unselect All Button
    if (unselectAllBtn) {
        unselectAllBtn.style.display = count > 0 ? 'block' : 'none';
    }
}

// ============================================================================
// BULK RENAME HANDLER
// ============================================================================
/**
 * Attached to the "Bulk Rename" button. This triggers the multi-file rename
 * workflow using our custom modal to collect the base name from the user.
 * 
 * Flow:
 * 1. Collect Base Name (UI Modal)
 * 2. Send IDs + BaseName to Server (/bulk-rename)
 * 3. Clearing selection and refreshing view on success.
 */
const bulkRenameBtn = document.getElementById('bulkRenameBtn');
if (bulkRenameBtn) {
    bulkRenameBtn.addEventListener('click', async () => {
        // Guard: Don't do anything if no files are selected
        if (selectedIds.size === 0) return;

        /**
         * STEP 1: UI INTERACTION
         * We trigger our custom modal to ask for the naming prefix (e.g. "beach")
         */
        const selectedBaseName = await showBulkRenameModal(selectedIds, imagesData);
        
        // If the user cancelled the modal or entered an empty string, we exit
        if (!selectedBaseName || !selectedBaseName.trim()) {
            return; 
        }

        // Disable button during network request to prevent double-clicks
        bulkRenameBtn.disabled = true;
        const previousButtonLabel = bulkRenameBtn.textContent;
        bulkRenameBtn.textContent = 'Renaming Files...';

        try {
            /**
             * STEP 2: SERVER COMMUNICATION
             * We send the Array of selected IDs and the sanitized name to our Express backend.
             */
            const renameRequest = await fetch(`${API_BASE_URL}/bulk-rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: Array.from(selectedIds),
                    baseName: selectedBaseName.trim()
                })
            });

            const renameResponseData = await renameRequest.json();
            
            if (renameRequest.ok && renameResponseData.success) {
                /**
                 * STEP 3: SUCCESS FEEDBACK
                 * Notify user, clear selection, and trigger a full database reload
                 * so the UI immediately reflects the new filenames.
                 */
                saveRecentRename(selectedBaseName.trim());
                showToast(renameResponseData.message || 'Successfully renamed files', 'success');
                
                selectedIds.clear(); // Important: Deselect everything after the batch move
                updateProcessButton(); // Reset sidebar state
                initDatabase(); // Reload the whole grid (uses local cache + fetch)
            } else {
                // Specific error from backend logic (e.g. file collision)
                showToast(renameResponseData.error || 'Failed to bulk rename', 'error');
            }
        } catch (commError) {
            console.error('Bulk rename network failure:', commError);
            showToast('Unable to reach the server for renaming.', 'error');
        } finally {
            // Restore button state
            bulkRenameBtn.disabled = false;
            bulkRenameBtn.textContent = previousButtonLabel;
        }
    });
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
                                const newCardHtml = createCardHtml(localImg, measureSingleCardHeight(localImg));
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

function showContextMenu(e, id, type, tag = null, card = null, dataType = null) {
    ctxTarget = { id, type, tag, card, dataType };
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
    document.getElementById('ctxFindSimilar').style.display = (type === 'thumbnail' || type === 'tag') ? 'block' : 'none';
    document.getElementById('ctxSearch').style.display = type === 'tag' ? 'block' : 'none';
    document.getElementById('ctxEdit').style.display = type === 'tag' ? 'block' : 'none';
    document.getElementById('ctxDelete').style.display = type === 'tag' ? 'block' : 'none';

    if (renameItem) {
        renameItem.style.display = (type === 'file' || isFileLink) ? 'block' : 'none';
        if (isFileLink && !tag) ctxTarget.tag = isFileLink.textContent.trim();
    }

    const dividers = contextMenu.querySelectorAll('.context-menu-divider');
    dividers.forEach(d => d.style.display = (type === 'tag' || type === 'thumbnail') ? 'block' : 'none');
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
        showContextMenu(e, tagEl.dataset.id, 'tag', tagEl.dataset.tag, null, tagEl.dataset.type);
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

// Context menu action listeners are located further down in the "Context Menu Actions" section.

// Rename Action
const ctxRename = document.getElementById('ctxRename');
if (ctxRename) {
    ctxRename.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget) return;
        const { id, tag: currentFilename } = ctxTarget;
        hideContextMenu();

        // Strip extension for easier renaming
        const currentBase = currentFilename.substring(0, currentFilename.lastIndexOf('.')) || currentFilename;

        showTagInputModal('Rename File', currentBase, async (newName) => {
            if (!newName || newName === currentBase) return;
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

const ctxFindSimilar = document.getElementById('ctxFindSimilar');
if (ctxFindSimilar) {
    ctxFindSimilar.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget || !ctxTarget.id) return;
        const targetId = ctxTarget.id;
        hideContextMenu();
        window.location.href = `search.html?similar=${targetId}`;
    });
}

const ctxSearch = document.getElementById('ctxSearch');
if (ctxSearch) {
    ctxSearch.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ctxTarget || !ctxTarget.tag) return;
        
        const query = encodeURIComponent(ctxTarget.tag);
        const dataType = ctxTarget.dataType || 'tags';
        const filterType = dataType === 'objects' ? 'object' : 'tag';
        
        hideContextMenu();

        window.location.href = `search.html?q=${query}&type=${filterType}`;
    });
}

document.getElementById('ctxEdit').addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.type !== 'tag') return;
    const { id, tag, dataType } = ctxTarget;
    hideContextMenu();

    const realType = dataType || 'tags';

    showTagInputModal(`Edit ${realType.slice(0, -1)}`, tag, (newTag) => {
        if (newTag && newTag.trim() && newTag.trim() !== tag) {
            updateTag(id, realType, tag, newTag.trim(), 'edit');
        }
    });
});

document.getElementById('ctxDelete').addEventListener('click', () => {
    if (!ctxTarget || ctxTarget.type !== 'tag') return;
    const { id, tag, dataType } = ctxTarget;
    hideContextMenu();

    const realType = dataType || 'tags';

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
            const newHtml = createCardHtml(image, measureSingleCardHeight(image));
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
// WHAT: Creates and displays a modal dialog prompting the user to input or edit a tag value.
// WHY: We replace native browser prompts with a beautiful, accessible modal dialogue. To ensure security,
// all dynamic parameter strings like the title or initial tag name are HTML-escaped using our central utility
// before being injected into the HTML template, preventing any script injection payloads from executing.
function showTagInputModal(modal_dialogue_title_text, initial_input_field_value_text, tag_submission_callback_function) {
    // WHAT: Creating the modal container element and styling it to cover the entire screen viewport.
    // WHY: A full-screen overlay backdrop blocks underlying interactions and focuses user attention on the input task.
    const tag_input_modal_container_element = document.createElement('div');
    tag_input_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    // WHAT: Safely escaping our inputs and rendering the modal HTML markup structure.
    // WHY: We HTML-escape both the title text and the initial field value using `escapeHtmlCharacters`
    // to shield the application from Cross-Site Scripting (XSS) in case they contain malicious tag strings.
    const escaped_modal_dialogue_title_text = escapeHtmlCharacters(modal_dialogue_title_text);
    const escaped_initial_input_field_value_text = escapeHtmlCharacters(initial_input_field_value_text);

    tag_input_modal_container_element.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${escaped_modal_dialogue_title_text}</h3>
            <input type="text" id="modalInput" value="${escaped_initial_input_field_value_text}" style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: #1f2937; color: white; margin-bottom: 1.5rem;">
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelModalBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveModalBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save</button>
            </div>
        </div>
    `;

    // WHAT: Appending our new modal dialogue structure to the document body.
    // WHY: The element must be attached to the active document DOM tree to render visually.
    document.body.appendChild(tag_input_modal_container_element);

    // WHAT: Querying and retrieving references to the inner interactive modal DOM elements.
    // WHY: We need precise control over the text input and action buttons to wire up click and keystroke behaviors.
    const text_input_field_element = tag_input_modal_container_element.querySelector('#modalInput');
    const save_changes_button_element = tag_input_modal_container_element.querySelector('#saveModalBtn');
    const cancel_changes_button_element = tag_input_modal_container_element.querySelector('#cancelModalBtn');

    // WHAT: Defining the keydown event listener to close the modal dialogue when Escape is pressed.
    // WHY: Pressing the Escape key is a universal web accessibility pattern to close dismissible overlays easily.
    const keyboard_event_handler_function = (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Escape') {
            cleanup_modal_and_remove_event_listeners();
        }
    };
    document.addEventListener('keydown', keyboard_event_handler_function);

    // WHAT: Removing keyboard event listeners and destroying the modal container element from the DOM.
    // WHY: Cleanup prevents memory leaks and ensures that obsolete keyboard listeners do not persist in the global document context.
    const cleanup_modal_and_remove_event_listeners = () => {
        document.removeEventListener('keydown', keyboard_event_handler_function);
        tag_input_modal_container_element.remove();
    };

    // WHAT: Extracting the input text, cleaning up modal DOM structures, and returning the value back through the callback trigger.
    // WHY: We collect the final user input, close the overlay, and invoke the caller's success logic with the entered string.
    const save_input_value_and_trigger_callback = () => {
        const retrieved_input_value_string = text_input_field_element.value;
        cleanup_modal_and_remove_event_listeners();
        tag_submission_callback_function(retrieved_input_value_string);
    };

    // WHAT: Setting a minor delay to focus and highlight the text input field automatically.
    // WHY: Directing user focus to the primary input element immediately upon rendering enhances the overall user experience.
    setTimeout(() => {
        text_input_field_element.focus();
        text_input_field_element.select();
    }, 10);

    save_changes_button_element.onclick = save_input_value_and_trigger_callback;
    cancel_changes_button_element.onclick = cleanup_modal_and_remove_event_listeners;

    // WHAT: Binding an Enter keypress listener specifically on the text input field to submit values directly.
    // WHY: Pressing Enter inside single-line form input fields is a standard user expectation for submitting values quickly.
    text_input_field_element.addEventListener('keydown', (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter') {
            keyboard_event_object.preventDefault();
            save_input_value_and_trigger_callback();
        }
    });

    // WHAT: Binding a click handler on the backdrop itself to dismiss the modal dialogue.
    // WHY: Clicking outside the dialog boundary represents an intuitive, secondary way to dismiss or cancel the modal overlay.
    tag_input_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === tag_input_modal_container_element) {
            cleanup_modal_and_remove_event_listeners();
        }
    };
}

// Custom Confirmation Modal
// WHAT: Creates, styles, and presents a customized double-confirmation modal dialogue overlay.
// WHY: We replace standard browser alert or confirm prompts with beautiful UI elements. By escaping
// all dynamic strings (message and confirm text) using `escapeHtmlCharacters`, we prevent potential
// XSS vulnerabilities if filenames or user metadata contain embedded script blocks.
function showConfirmModal(dialogue_message_text, action_on_confirmation_callback) {
    // WHAT: Creating the modal container backdrop overlay.
    // WHY: Viewport cover creates a clean dark backdrop focusing attention on the choice.
    const confirmation_modal_container_element = document.createElement('div');
    confirmation_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    // WHAT: Safely escaping variable texts to block XSS and rendering the HTML skeleton.
    // WHY: Escaping ensures that even if filenames contain custom script tags, they are rendered safely as textual content.
    const escaped_dialogue_message_text = escapeHtmlCharacters(dialogue_message_text);

    confirmation_modal_container_element.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%; text-align: center;">
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1.1rem;">${escaped_dialogue_message_text}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="cancelConfirmBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="okConfirmBtn" style="background: #ef4444; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Delete</button>
            </div>
        </div>
    `;

    // WHAT: Rendering our dynamic container element to the document viewport structure.
    // WHY: Elements must be added to the live document DOM structure to register visible layout nodes.
    document.body.appendChild(confirmation_modal_container_element);

    const ok_confirmation_action_button_element = confirmation_modal_container_element.querySelector('#okConfirmBtn');
    const cancel_confirmation_action_button_element = confirmation_modal_container_element.querySelector('#cancelConfirmBtn');

    // WHAT: Forcing input focus to the active confirmation trigger button.
    // WHY: Setting default keyboard focus on the main action item ensures quick keyboard-only accessibility.
    setTimeout(() => {
        ok_confirmation_action_button_element.focus();
    }, 10);

    // WHAT: Dismantling the modal overlay and cleaning up registered document keyboard event listeners.
    // WHY: Proper cleanups avoid resource bloats and unreferenced listener remnants in global page scopes.
    const cleanup_modal_and_remove_event_listeners = () => {
        document.removeEventListener('keydown', keyboard_event_handler_function);
        confirmation_modal_container_element.remove();
    };

    // WHAT: Closing the modal first, then launching the supplied success function task.
    // WHY: Executing callbacks after teardowns ensures clean DOM sequences and prevents double-triggers.
    const execute_confirmed_action_callback = () => {
        cleanup_modal_and_remove_event_listeners();
        action_on_confirmation_callback();
    };

    ok_confirmation_action_button_element.onclick = execute_confirmed_action_callback;
    cancel_confirmation_action_button_element.onclick = cleanup_modal_and_remove_event_listeners;

    // WHAT: Permitting modal dismissal via click overlays on the backdrop element.
    // WHY: Off-dialogue clicks represent an intuitive secondary path for dismissing choices.
    confirmation_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === confirmation_modal_container_element) {
            cleanup_modal_and_remove_event_listeners();
        }
    };

    // WHAT: Capturing global Enter and Escape keyboard keystrokes inside the modal dialogue.
    // WHY: Enter triggers swift submission, whereas Escape aborts the overlay safely.
    const keyboard_event_handler_function = (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter') {
            keyboard_event_object.preventDefault();
            execute_confirmed_action_callback();
        } else if (keyboard_event_object.key === 'Escape') {
            keyboard_event_object.preventDefault();
            cleanup_modal_and_remove_event_listeners();
        }
    };

    document.addEventListener('keydown', keyboard_event_handler_function);
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
// Defer init slightly to allow the pretext type="module" script to register
// on window before the first renderBatch runs. Module scripts are deferred
// by spec and execute after inline scripts, so a microtask yield suffices.
Promise.resolve().then(() => {
    // Double-yield: first microtask lets the module script queue,
    // second requestAnimationFrame ensures it has executed.
    requestAnimationFrame(() => initDatabase());
});

// ============================================================================
// STORAGE HELPERS
// ============================================================================
function getRecentRenames() {
    try {
        const stored = localStorage.getItem('recentRenames');
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        return [];
    }
}

function saveRecentRename(name) {
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    let recent = getRecentRenames();
    // Remove if already exists to move it to the top
    recent = recent.filter(r => r !== trimmed);
    recent.unshift(trimmed);
    // Keep only last 10
    recent = recent.slice(0, 10);
    localStorage.setItem('recentRenames', JSON.stringify(recent));
}
