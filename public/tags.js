
const API_BASE_URL = 'http://localhost:3000';

// State
let allStats = { tags: [], objects: [] };
let currentTab = 'tags'; // 'tags' or 'objects'
let currentView = 'cloud'; // 'cloud', 'list'

// DOM Elements
const contentArea = document.getElementById('contentArea');
const tagSearch = document.getElementById('tagSearch');
const tagsCount = document.getElementById('tagsCount');
const objectsCount = document.getElementById('objectsCount');

// Initialize
async function init() {
    try {
        const response = await fetch(`${API_BASE_URL}/stats`);
        if (!response.ok) throw new Error('Failed to load stats');

        const data = await response.json();
        allStats = data;

        tagsCount.textContent = data.tags.length;
        objectsCount.textContent = data.objects.length;

        renderCurrentView();

    } catch (error) {
        console.error('Error:', error);
        contentArea.innerHTML = '<div style="text-align: center; color: var(--danger);">Failed to load tags. Is the server running?</div>';
    }
}

// Switch Tabs
window.switchTab = function (tab) {
    currentTab = tab;

    // Update UI
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(tab === 'tags' ? 'tabTags' : 'tabObjects').classList.add('active');

    renderCurrentView();
}

// Switch View Type
window.switchView = function (view) {
    currentView = view;

    // Update UI
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(view === 'cloud' ? 'viewCloud' : 'viewList').classList.add('active');

    // Update container class for styling
    contentArea.className = `${view}-view`;

    renderCurrentView();
}

// Filter and Sort Data
function getProcessedData() {
    const rawData = allStats[currentTab];
    const searchTerm = tagSearch.value.toLowerCase();
    const sortMethod = document.getElementById('sortMethod').value;

    // Filter
    let filtered = rawData.filter(item => item.name.toLowerCase().includes(searchTerm));

    // Sort
    return filtered.sort((a, b) => {
        if (sortMethod === 'count') {
            // Count descending, then name ascending
            return b.count - a.count || a.name.localeCompare(b.name);
        } else {
            // Name ascending
            return a.name.localeCompare(b.name);
        }
    });
}

// Render
window.renderCurrentView = function () {
    const data = getProcessedData();

    if (data.length === 0) {
        contentArea.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No matches found</div>';
        return;
    }

    if (currentView === 'cloud') {
        renderCloud(data);
    } else {
        renderList(data);
    }
}

// Search Listener
tagSearch.addEventListener('input', () => {
    renderCurrentView();
});

// Renderers
function renderCloud(data) {
    // Calculate sizing range
    const maxCount = Math.max(...data.map(d => d.count));
    const minCount = Math.min(...data.map(d => d.count));
    const minSize = 0.8; // rem
    const maxSize = 2.5; // rem

    const html = data.map(item => {
        // Linear interpolation for size
        let size = minSize;
        if (maxCount > minCount) {
            size = minSize + ((item.count - minCount) / (maxCount - minCount)) * (maxSize - minSize);
        }

        const color = currentTab === 'objects' ? 'var(--accent-secondary, #34d399)' : 'var(--accent)';
        const opacity = 0.7 + ((size - minSize) / (maxSize - minSize)) * 0.3; // More frequent = more opaque

        return `
            <a href="search.html?tag=${encodeURIComponent(item.name)}" 
               class="tag-cloud-item" 
               style="font-size: ${size}rem; opacity: ${opacity}; color: ${color};">
               ${item.name}
               <span class="count-badge">${item.count}</span>
            </a>
        `;
    }).join('');

    contentArea.innerHTML = `<div class="tag-cloud-container">${html}</div>`;
}

function renderList(data) {
    const sortMethod = document.getElementById('sortMethod').value;
    const alphabetNav = document.getElementById('alphabetNav');

    // Group by first letter if alphabetical sort
    if (sortMethod === 'name') {
        const grouped = {};
        const letters = [];

        data.forEach(item => {
            const firstLetter = item.name.charAt(0).toUpperCase();
            if (!grouped[firstLetter]) {
                grouped[firstLetter] = [];
                letters.push(firstLetter);
            }
            grouped[firstLetter].push(item);
        });

        // Populate alphabet nav
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        alphabetNav.innerHTML = alphabet.map(letter => {
            const hasItems = letters.includes(letter);
            return `<a href="#letter-${letter}" 
                       style="display: inline-block; padding: 0.25rem 0.5rem; margin: 0.15rem; 
                              text-decoration: none; border-radius: 4px; font-weight: 500;
                              ${hasItems
                    ? 'color: var(--accent); cursor: pointer;'
                    : 'color: var(--text-secondary); opacity: 0.4; pointer-events: none;'
                }"
                       ${hasItems ? '' : 'tabindex="-1"'}>${letter}</a>`;
        }).join('');
        alphabetNav.style.display = 'block';

        // Build grouped HTML
        let html = '';
        letters.sort().forEach(letter => {
            html += `<div id="letter-${letter}" style="margin-bottom: 1.5rem;">
                <h3 style="color: var(--accent); margin-bottom: 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border);">${letter}</h3>
                <div class="tag-list-container">
                    ${grouped[letter].map(item => `
                        <div class="tag-list-item">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: 500; font-size: 1.1rem;">${item.name}</span>
                                <span class="badge">${item.count} images</span>
                            </div>
                            <div style="margin-top: 0.5rem; display: flex; justify-content: flex-end;">
                                <a href="search.html?tag=${encodeURIComponent(item.name)}" class="btn-sm">View Images →</a>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        });

        contentArea.innerHTML = html;
    } else {
        // Hide alphabet nav for non-alphabetical sort
        alphabetNav.style.display = 'none';

        // Standard list render
        const html = data.map(item => `
            <div class="tag-list-item">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 500; font-size: 1.1rem;">${item.name}</span>
                    <span class="badge">${item.count} images</span>
                </div>
                <div style="margin-top: 0.5rem; display: flex; justify-content: flex-end;">
                    <a href="search.html?tag=${encodeURIComponent(item.name)}" class="btn-sm">View Images →</a>
                </div>
            </div>
        `).join('');

        contentArea.innerHTML = `<div class="tag-list-container">${html}</div>`;
    }
}

// Start
init();
