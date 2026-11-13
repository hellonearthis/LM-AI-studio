/**
 * Pure Functional Core for Tag Studio (`public/tags.js`).
 *
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * Pure filtering, sorting, and HTML rendering builders isolated from DOM side effects.
 */

import { escapeHtmlCharacters } from './cardCore.js';

// WHAT: Filters taxonomy items by search query and sorts them by count or alphabetical name.
// WHY: Keeps taxonomy filtering and ordering deterministic and testable without DOM state.
export function filterAndSortTaxonomyItems(taxonomy_items_collection, search_query_text, sort_method_selection) {
    const safe_items = Array.isArray(taxonomy_items_collection) ? taxonomy_items_collection : [];
    const normalized_query = String(search_query_text || '').toLowerCase();

    const filtered_items = safe_items.filter(
        single_taxonomy_item => String(single_taxonomy_item?.name || '').toLowerCase().includes(normalized_query)
    );

    return filtered_items.toSorted((first_item, second_item) => {
        if (sort_method_selection === 'count') {
            return second_item.count - first_item.count || first_item.name.localeCompare(second_item.name);
        }
        return first_item.name.localeCompare(second_item.name);
    });
}

// WHAT: Computes proportional font sizing and opacity weights to build tag cloud HTML.
// WHY: Highlights dominant thematic concepts while keeping cloud rendering pure and XSS-safe.
export function buildTagCloudHtml(taxonomy_items_collection, active_taxonomy_tab_name) {
    let maximum_frequency_count = -Infinity;
    let minimum_frequency_count = Infinity;
    for (const single_item of taxonomy_items_collection) {
        if (single_item.count > maximum_frequency_count) maximum_frequency_count = single_item.count;
        if (single_item.count < minimum_frequency_count) minimum_frequency_count = single_item.count;
    }

    const minimum_font_size_rem = 0.8;
    const maximum_font_size_rem = 2.5;
    const thematic_accent_color = (
        active_taxonomy_tab_name === 'objects'
            ? 'var(--accent-secondary, #34d399)'
            : 'var(--accent)'
    );
    const target_taxonomy_type = active_taxonomy_tab_name === 'objects' ? 'object' : 'tag';

    const rendered_cloud_items_html = taxonomy_items_collection.map(single_taxonomy_item => {
        let calculated_font_size_rem = minimum_font_size_rem;
        if (maximum_frequency_count > minimum_frequency_count) {
            const frequency_ratio = (
                (single_taxonomy_item.count - minimum_frequency_count) /
                (maximum_frequency_count - minimum_frequency_count)
            );
            calculated_font_size_rem = minimum_font_size_rem + frequency_ratio * (maximum_font_size_rem - minimum_font_size_rem);
        }

        const calculated_opacity_factor = (
            0.7 + ((calculated_font_size_rem - minimum_font_size_rem) / (maximum_font_size_rem - minimum_font_size_rem)) * 0.3
        );
        const escaped_taxonomy_name = escapeHtmlCharacters(single_taxonomy_item.name);

        return `
            <a href="search.html?tag=${encodeURIComponent(single_taxonomy_item.name)}&type=${target_taxonomy_type}" 
               class="tag-cloud-item" 
               style="font-size: ${calculated_font_size_rem}rem; opacity: ${calculated_opacity_factor}; color: ${thematic_accent_color};">
               ${escaped_taxonomy_name}
               <span class="count-badge">${single_taxonomy_item.count}</span>
            </a>
        `;
    }).join('');

    return `<div class="tag-cloud-container">${rendered_cloud_items_html}</div>`;
}

// WHAT: Builds the A-Z quick-jump navigation bar HTML from the set of active initial letters.
// WHY: Separates alphabet nav markup generation from DOM element updates.
export function buildAlphabetJumpNavHtml(unique_initial_letters_set) {
    const full_english_alphabet_characters_list = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    return full_english_alphabet_characters_list.map(single_alphabet_letter => {
        const has_matching_items = unique_initial_letters_set.has(single_alphabet_letter);
        return `<a href="#letter-${single_alphabet_letter}" 
                   style="display: inline-block; padding: 0.25rem 0.5rem; margin: 0.15rem; 
                          text-decoration: none; border-radius: 4px; font-weight: 500;
                          ${has_matching_items
                              ? 'color: var(--accent); cursor: pointer;'
                              : 'color: var(--text-secondary); opacity: 0.4; pointer-events: none;'
                          }"
                   ${has_matching_items ? '' : 'tabindex="-1"'}>${single_alphabet_letter}</a>`;
    }).join('');
}

// WHAT: Builds either an alphabet-grouped or count-sorted list HTML string for taxonomy items.
// WHY: Enables pure unit testing of both list layouts without DOM coupling.
export function buildTagListHtml(taxonomy_items_collection, active_taxonomy_tab_name, active_sort_method) {
    const target_taxonomy_type = active_taxonomy_tab_name === 'objects' ? 'object' : 'tag';

    if (active_sort_method === 'name') {
        const letter_grouping_map = new Map();
        for (const current_taxonomy_item of taxonomy_items_collection) {
            const initial_letter_uppercase = String(current_taxonomy_item.name || '').charAt(0).toUpperCase();
            let bucket = letter_grouping_map.get(initial_letter_uppercase);
            if (!bucket) {
                bucket = [];
                letter_grouping_map.set(initial_letter_uppercase, bucket);
            }
            bucket.push(current_taxonomy_item);
        }

        const unique_initial_letters_set = new Set(letter_grouping_map.keys());
        const unique_initial_letters_collection = Array.from(unique_initial_letters_set).sort();
        const alphabet_nav_html = buildAlphabetJumpNavHtml(unique_initial_letters_set);

        const sections_html = unique_initial_letters_collection.map(single_initial_letter => {
            const escaped_letter = escapeHtmlCharacters(single_initial_letter);
            return `
            <div id="letter-${escaped_letter}" style="margin-bottom: 1.5rem;">
                <h3 style="color: var(--accent); margin-bottom: 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border);">${escaped_letter}</h3>
                <div class="tag-list-container">
                    ${letter_grouping_map.get(single_initial_letter).map(single_item_record => `
                        <div class="tag-list-item">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: 500; font-size: 1.1rem;">${escapeHtmlCharacters(single_item_record.name)}</span>
                                <span class="badge">${single_item_record.count} images</span>
                            </div>
                            <div style="margin-top: 0.5rem; display: flex; justify-content: flex-end;">
                                <a href="search.html?tag=${encodeURIComponent(single_item_record.name)}&type=${target_taxonomy_type}" class="btn-sm">View Images →</a>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        }).join('');

        return { showAlphabetNav: true, alphabetNavHtml: alphabet_nav_html, listHtml: sections_html };
    }

    const rendered_flat_items_html = taxonomy_items_collection.map(single_taxonomy_item => `
        <div class="tag-list-item">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 500; font-size: 1.1rem;">${escapeHtmlCharacters(single_taxonomy_item.name)}</span>
                <span class="badge">${single_taxonomy_item.count} images</span>
            </div>
            <div style="margin-top: 0.5rem; display: flex; justify-content: flex-end;">
                <a href="search.html?tag=${encodeURIComponent(single_taxonomy_item.name)}&type=${target_taxonomy_type}" class="btn-sm">View Images →</a>
            </div>
        </div>
    `).join('');

    return {
        showAlphabetNav: false,
        alphabetNavHtml: '',
        listHtml: `<div class="tag-list-container">${rendered_flat_items_html}</div>`
    };
}

