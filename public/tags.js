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
// WHY: Pure transformation returning an ordered array without mutating source statistics.
function computeFilteredAndSortedTaxonomyData() {
    const raw_taxonomy_items_collection = all_taxonomy_statistics[active_taxonomy_tab_name] || [];
    const search_filter_query_lowercase = (taxonomy_search_input_element.value || '').toLowerCase();
    const sort_method_selection = document.getElementById('sortMethod').value;

    // Pure filter transformation
    const filtered_taxonomy_items_collection = raw_taxonomy_items_collection.filter(
        single_taxonomy_item => single_taxonomy_item.name.toLowerCase().includes(search_filter_query_lowercase)
    );

    // Non-mutating sorting via toSorted or slice().sort()
    return filtered_taxonomy_items_collection.slice().sort((first_item, second_item) => {
        if (sort_method_selection === 'count') {
            // Count descending, then alphabetical name ascending
            return second_item.count - first_item.count || first_item.name.localeCompare(second_item.name);
        }
        // Name alphabetical ascending
        return first_item.name.localeCompare(second_item.name);
    });
}

// ============================================================================
// RENDERING DISPATCHER
// ============================================================================

// WHAT: Directs the filtered taxonomy items to either the cloud or list renderer.
// WHY: Keeps UI rendering decoupled from user filter and tab interactions.
window.renderCurrentTaxonomyView = function () {
    const processed_taxonomy_items_collection = computeFilteredAndSortedTaxonomyData();

    if (processed_taxonomy_items_collection.length === 0) {
        taxonomy_content_container_element.innerHTML = (
            '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">' +
            'No matching taxonomy terms found.' +
            '</div>'
        );
        return;
    }

    if (active_visualization_view_type === 'cloud') {
        renderTagCloudVisualization(processed_taxonomy_items_collection);
    } else {
        renderTagAlphabeticalList(processed_taxonomy_items_collection);
    }
};

// Real-time search query listener
taxonomy_search_input_element.addEventListener('input', () => {
    renderCurrentTaxonomyView();
});

// ============================================================================
// RENDERERS (TAG CLOUD AND LIST)
// ============================================================================

// WHAT: Computes proportional font sizing and opacity weights for tag cloud display.
// WHY: Highlights dominant thematic concepts at a glance via visual hierarchy.
function renderTagCloudVisualization(taxonomy_items_collection) {
    const frequency_counts_collection = taxonomy_items_collection.map(single_item => single_item.count);
    const maximum_frequency_count = Math.max(...frequency_counts_collection);
    const minimum_frequency_count = Math.min(...frequency_counts_collection);
    const minimum_font_size_rem = 0.8;
    const maximum_font_size_rem = 2.5;

    const rendered_cloud_items_html = taxonomy_items_collection.map(single_taxonomy_item => {
        // Linear interpolation for font size
        let calculated_font_size_rem = minimum_font_size_rem;
        if (maximum_frequency_count > minimum_frequency_count) {
            const frequency_ratio = (
                (single_taxonomy_item.count - minimum_frequency_count) /
                (maximum_frequency_count - minimum_frequency_count)
            );
            calculated_font_size_rem = minimum_font_size_rem + frequency_ratio * (maximum_font_size_rem - minimum_font_size_rem);
        }

        const thematic_accent_color = (
            active_taxonomy_tab_name === 'objects'
                ? 'var(--accent-secondary, #34d399)'
                : 'var(--accent)'
        );

        const calculated_opacity_factor = (
            0.7 + ((calculated_font_size_rem - minimum_font_size_rem) / (maximum_font_size_rem - minimum_font_size_rem)) * 0.3
        );

        const target_taxonomy_type = active_taxonomy_tab_name === 'objects' ? 'object' : 'tag';

        return `
            <a href="search.html?tag=${encodeURIComponent(single_taxonomy_item.name)}&type=${target_taxonomy_type}" 
               class="tag-cloud-item" 
               style="font-size: ${calculated_font_size_rem}rem; opacity: ${calculated_opacity_factor}; color: ${thematic_accent_color};">
               ${single_taxonomy_item.name}
               <span class="count-badge">${single_taxonomy_item.count}</span>
            </a>
        `;
    }).join('');

    taxonomy_content_container_element.innerHTML = `<div class="tag-cloud-container">${rendered_cloud_items_html}</div>`;
}

// WHAT: Renders items as an alphabetized or count-sorted list with letter jump navigation.
// WHY: Provides structured, accessible scanning when searching for specific vocabulary items.
function renderTagAlphabeticalList(taxonomy_items_collection) {
    const active_sort_method = document.getElementById('sortMethod').value;
    const alphabet_navigation_container_element = document.getElementById('alphabetNav');

    if (active_sort_method === 'name') {
        // WHAT: Pure grouping reduction mapping first letters to collections without in-place mutation.
        // WHY: Pure functional reduction builds immutable lookup tables without array.push side effects.
        const letter_grouping_record = taxonomy_items_collection.reduce((accumulator_record, current_taxonomy_item) => {
            const initial_letter_uppercase = current_taxonomy_item.name.charAt(0).toUpperCase();
            const existing_items_for_letter = accumulator_record[initial_letter_uppercase] || [];
            return {
                ...accumulator_record,
                [initial_letter_uppercase]: [...existing_items_for_letter, current_taxonomy_item]
            };
        }, {});

        const unique_initial_letters_collection = Object.keys(letter_grouping_record).sort();

        // Populate alphabet quick-jump bar
        const full_english_alphabet_characters_list = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        alphabet_navigation_container_element.innerHTML = full_english_alphabet_characters_list.map(single_alphabet_letter => {
            const has_matching_items = unique_initial_letters_collection.includes(single_alphabet_letter);
            return `<a href="#letter-${single_alphabet_letter}" 
                       style="display: inline-block; padding: 0.25rem 0.5rem; margin: 0.15rem; 
                              text-decoration: none; border-radius: 4px; font-weight: 500;
                              ${has_matching_items
                                  ? 'color: var(--accent); cursor: pointer;'
                                  : 'color: var(--text-secondary); opacity: 0.4; pointer-events: none;'
                              }"
                       ${has_matching_items ? '' : 'tabindex="-1"'}>${single_alphabet_letter}</a>`;
        }).join('');
        alphabet_navigation_container_element.style.display = 'block';

        // Build alphabetized section cards
        const rendered_alphabetical_groups_html = unique_initial_letters_collection.map(single_initial_letter => `
            <div id="letter-${single_initial_letter}" style="margin-bottom: 1.5rem;">
                <h3 style="color: var(--accent); margin-bottom: 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border);">${single_initial_letter}</h3>
                <div class="tag-list-container">
                    ${letter_grouping_record[single_initial_letter].map(single_item_record => `
                        <div class="tag-list-item">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: 500; font-size: 1.1rem;">${single_item_record.name}</span>
                                <span class="badge">${single_item_record.count} images</span>
                            </div>
                            <div style="margin-top: 0.5rem; display: flex; justify-content: flex-end;">
                                <a href="search.html?tag=${encodeURIComponent(single_item_record.name)}&type=${active_taxonomy_tab_name === 'objects' ? 'object' : 'tag'}" class="btn-sm">View Images →</a>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');

        taxonomy_content_container_element.innerHTML = rendered_alphabetical_groups_html;
    } else {
        // Hide alphabet quick-jump bar when sorted by count
        alphabet_navigation_container_element.style.display = 'none';

        const rendered_flat_items_html = taxonomy_items_collection.map(single_taxonomy_item => `
            <div class="tag-list-item">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 500; font-size: 1.1rem;">${single_taxonomy_item.name}</span>
                    <span class="badge">${single_taxonomy_item.count} images</span>
                </div>
                <div style="margin-top: 0.5rem; display: flex; justify-content: flex-end;">
                    <a href="search.html?tag=${encodeURIComponent(single_taxonomy_item.name)}&type=${active_taxonomy_tab_name === 'objects' ? 'object' : 'tag'}" class="btn-sm">View Images →</a>
                </div>
            </div>
        `).join('');

        taxonomy_content_container_element.innerHTML = `<div class="tag-list-container">${rendered_flat_items_html}</div>`;
    }
}

// WHAT: Initiates initial dashboard loading on script execution.
// WHY: Ensures immediate rendering when the HTML document loads.
initializeTagStudioDashboard();
