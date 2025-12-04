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
                         onerror="this.style.display='none'"
                         style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px;">
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
                    ${objects.slice(0, 5).map(obj => `<span class="tag" style="font-size: 0.75rem; background-color: rgba(129, 140, 248, 0.2); color: #818cf8;">${obj}</span>`).join('')}
                    ${tags.slice(0, 5).map(tag => `<span class="tag" style="font-size: 0.75rem;">#${tag}</span>`).join('')}
                </div>
            </div>
        `;
    }).join('');
}

// Event Listeners
searchBtn.addEventListener('click', performSearch);

// Allow Enter key to search
searchQuery.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
});
