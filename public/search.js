// ============================================================================
// SEARCH PAGE LOGIC
// ============================================================================

const searchQuery = document.getElementById('searchQuery');
const sceneType = document.getElementById('sceneType');
const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const resultsCount = document.getElementById('resultsCount');
const API_BASE_URL = 'http://localhost:3000';

// Search Function
async function performSearch() {
    const query = {
        query: searchQuery.value,
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
        const analysis = JSON.parse(img.analysis || '{}');
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
            <div class="card">
                <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
                    <img src="${displayPath}" 
                         data-fullpath="${img.path}"
                         class="thumbnail-preview"
                         onerror="this.style.display='none'"
                         style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px; cursor: pointer;"
                         title="Click to view full size">
                    <div>
                        <h3 style="margin: 0; color: var(--accent); font-size: 1rem;">${img.filename}</h3>
                        <small style="color: var(--text-secondary);">${date}</small>
                        <div style="margin-top: 0.25rem;">
                            <span class="badge" style="font-size: 0.7rem;">${analysis.scene_type || 'Unknown'}</span>
                        </div>
                    </div>
                </div>
                
                <p style="font-size: 0.9rem; color: var(--text-primary); margin-bottom: 1rem; line-height: 1.4;">
                    ${analysis.summary || 'No summary available'}
                </p>
                
                <div class="tags-container">
                    ${objects.slice(0, 5).map(obj => `<span class="tag" style="font-size: 0.75rem; background-color: rgba(16, 185, 129, 0.2); color: #34d399;">${obj}</span>`).join('')}
                    ${tags.slice(0, 5).map(tag => `<span class="tag" style="font-size: 0.75rem;">${tag}</span>`).join('')}
                </div>
            </div>
        `;
    }).join('');

    // Attach click handlers for image preview
    document.querySelectorAll('.thumbnail-preview').forEach(thumbnail => {
        thumbnail.addEventListener('click', (e) => {
            e.stopPropagation();
            const fullPath = e.target.dataset.fullpath;
            if (fullPath) {
                showImagePreview(fullPath);
            }
        });
    });
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

        // Prevent clicks on image from closing modal (optional, but user asked for click to close)
        // User request: "clicking it should close it"
        // So we REMOVE the stopPropagation on the image click
        // img.addEventListener('click', (e) => {
        //     e.stopPropagation();
        // });

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
