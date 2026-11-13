// ============================================================================
// LUMINA STUDIO - TAG & OBJECT TAXONOMY VIEWER
// ============================================================================
// WHAT: Visual exploration dashboard for dataset tags and detected visual objects.
// WHY: Allows researchers and creators to inspect the vocabulary distribution of their
//      image library via interactive tag clouds and alphabetized frequency lists.
//
// PROTOCOL COMPLIANCE:
// 1. "can_be_long" Protocol: Expressive semantic variable naming without shorthand.
// 2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
// 3. Pure Functional Architecture: Non-mutating reductions and transformations.
// ============================================================================

import {
    filterAndSortTaxonomyItems,
    buildTagCloudHtml,
    buildTagListHtml
} from './modules/tagsCore.js';

const API_BASE_URL = 'http://localhost:3000';

// ============================================================================
// APPLICATION STATE
// ============================================================================
let all_taxonomy_statistics = { tags: [], objects: [] };
let active_taxonomy_tab_name = 'tags'; // 'tags' or 'objects'
let active_visualization_view_type = 'cloud'; // 'cloud' or 'list'

// ============================================================================
// DOM ELEMENT BINDINGS
// ============================================================================
const taxonomy_content_container_element = document.getElementById('contentArea');
const taxonomy_search_input_element = document.getElementById('tagSearch');
const total_tags_count_badge_element = document.getElementById('tagsCount');
const total_objects_count_badge_element = document.getElementById('objectsCount');

// ============================================================================
// INITIALIZATION
// ============================================================================

// WHAT: Fetches complete taxonomy frequency statistics from the local Express server.
// WHY: Populates initial badge counts and triggers the default cloud view on page load.
async function initializeTagStudioDashboard() {
    try {
        const stats_http_response = await fetch(`${API_BASE_URL}/stats`);
        if (!stats_http_response.ok) {
            throw new Error('Failed to load dataset statistics from server.');
        }

        const parsed_stats_payload = await stats_http_response.json();
        all_taxonomy_statistics = parsed_stats_payload;

        total_tags_count_badge_element.textContent = parsed_stats_payload.tags.length;
        total_objects_count_badge_element.textContent = parsed_stats_payload.objects.length;

        renderCurrentTaxonomyView();

    } catch (dashboard_initialization_error) {
        console.error('Tag studio initialization failed:', dashboard_initialization_error);
        taxonomy_content_container_element.innerHTML = (
            '<div style="text-align: center; color: var(--danger);">' +
            'Failed to load tags. Is the local AI studio server running?' +
            '</div>'
        );
    }
}

// ============================================================================
// VIEW AND TAB SWITCHING CONTROLLERS
// ============================================================================

// WHAT: Switches between general descriptive tags and concrete detected objects.
// WHY: Allows the user to isolate semantic concepts from physical object labels.
window.switchTab = function (selected_taxonomy_tab_name) {
    active_taxonomy_tab_name = selected_taxonomy_tab_name;

    // Update active tab buttons
    document.querySelectorAll('.tab-btn').forEach(single_tab_button_element => {
        single_tab_button_element.classList.remove('active');
    });

    const active_tab_target_identifier = selected_taxonomy_tab_name === 'tags' ? 'tabTags' : 'tabObjects';
    document.getElementById(active_tab_target_identifier).classList.add('active');

    renderCurrentTaxonomyView();
};

// WHAT: Switches the presentation layout between an atmospheric word cloud and an ordered list.
// WHY: Clouds provide immediate visual weight of common terms; lists facilitate precise lookups.
window.switchView = function (selected_view_type_name) {
    active_visualization_view_type = selected_view_type_name;

    // Update active view buttons
    document.querySelectorAll('.view-btn').forEach(single_view_button_element => {
        single_view_button_element.classList.remove('active');
    });

    const active_view_target_identifier = selected_view_type_name === 'cloud' ? 'viewCloud' : 'viewList';
    document.getElementById(active_view_target_identifier).classList.add('active');

    // Update layout CSS class
    taxonomy_content_container_element.className = `${selected_view_type_name}-view`;

    renderCurrentTaxonomyView();
};

// ============================================================================
// PURE DATA PROCESSING (FILTERING AND SORTING)
// ============================================================================

// WHAT: Filters active taxonomy terms by search query and sorts them by frequency or name.
// WHY: Delegates to pure helper in tagsCore.js.
function computeFilteredAndSortedTaxonomyData() {
    const raw_taxonomy_items_collection = all_taxonomy_statistics[active_taxonomy_tab_name] || [];
    const search_filter_query = taxonomy_search_input_element.value || '';
    const sort_method_selection = document.getElementById('sortMethod').value;
    return filterAndSortTaxonomyItems(raw_taxonomy_items_collection, search_filter_query, sort_method_selection);
}

// ============================================================================
// RENDERING DISPATCHER
// ============================================================================

// WHAT: Directs the filtered taxonomy items to either the cloud or list renderer.
// WHY: Keeps UI rendering decoupled from user filter and tab interactions.
function renderCurrentTaxonomyView() {
    const processed_taxonomy_items_collection = computeFilteredAndSortedTaxonomyData();
    const alphabet_navigation_container_element = document.getElementById('alphabetNav');

    if (processed_taxonomy_items_collection.length === 0) {
        if (alphabet_navigation_container_element) {
            alphabet_navigation_container_element.style.display = 'none';
        }
        taxonomy_content_container_element.innerHTML = (
            '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">' +
            'No matching taxonomy terms found.' +
            '</div>'
        );
        return;
    }

    if (active_visualization_view_type === 'cloud') {
        if (alphabet_navigation_container_element) {
            alphabet_navigation_container_element.style.display = 'none';
        }
        taxonomy_content_container_element.innerHTML = buildTagCloudHtml(
            processed_taxonomy_items_collection,
            active_taxonomy_tab_name
        );
    } else {
        const active_sort_method = document.getElementById('sortMethod').value;
        const list_presentation = buildTagListHtml(
            processed_taxonomy_items_collection,
            active_taxonomy_tab_name,
            active_sort_method
        );
        if (alphabet_navigation_container_element) {
            alphabet_navigation_container_element.style.display = list_presentation.showAlphabetNav ? 'block' : 'none';
            if (list_presentation.showAlphabetNav) {
                alphabet_navigation_container_element.innerHTML = list_presentation.alphabetNavHtml;
            }
        }
        taxonomy_content_container_element.innerHTML = list_presentation.listHtml;
    }
}
window.renderCurrentTaxonomyView = renderCurrentTaxonomyView;
window.renderCurrentView = renderCurrentTaxonomyView;

// Real-time search query listener
taxonomy_search_input_element.addEventListener('input', () => {
    renderCurrentTaxonomyView();
});

// WHAT: Initiates initial dashboard loading on script execution.
// WHY: Ensures immediate rendering when the HTML document loads.
initializeTagStudioDashboard();
