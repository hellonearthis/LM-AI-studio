/**
 * ============================================================================
 * MODULE: searchFilters.js — Pure Functional Core for Search Filtering & Sorting
 * ============================================================================
 *
 * WHAT: Implements 100% pure, deterministic data transformations for filtering
 *       image records, sorting search results, ranking autocomplete candidates,
 *       extracting catalog facets, and computing state transitions.
 * WHY:  Isolates all search domain logic from DOM manipulation and global browser
 *       state so every filter/sort/ranking path is reproducible and testable in Node.js.
 */

/**
 * WHAT: Extracts sorted, deduplicated lists of all tags and objects across the image collection.
 * WHY:  Populates the autocomplete catalog deterministically without mutating any image record.
 *
 * @param {readonly Record<string, any>[]} all_image_records - Full collection of image records.
 * @returns {{ readonly sorted_unique_tags: readonly string[], readonly sorted_unique_objects: readonly string[] }}
 */
export function extractUniqueTagsAndObjectsCatalog(all_image_records) {
    if (!Array.isArray(all_image_records)) {
        return { sorted_unique_tags: [], sorted_unique_objects: [] };
    }

    const unique_tags_set = new Set();
    const unique_objects_set = new Set();

    for (const image_record of all_image_records) {
        const analysis_record = image_record?.analysis || {};
        if (Array.isArray(analysis_record.tags)) {
            for (const tag_string of analysis_record.tags) {
                if (typeof tag_string === 'string' && tag_string.trim()) {
                    unique_tags_set.add(tag_string);
                }
            }
        }
        if (Array.isArray(analysis_record.objects)) {
            for (const object_string of analysis_record.objects) {
                if (typeof object_string === 'string' && object_string.trim()) {
                    unique_objects_set.add(object_string);
                }
            }
        }
    }

    return {
        sorted_unique_tags: Array.from(unique_tags_set).sort(),
        sorted_unique_objects: Array.from(unique_objects_set).sort()
    };
}

/**
 * WHAT: Evaluates whether a single image record satisfies the selected tag and object chips.
 * WHY:  Supports both `'AND'` (every selected tag AND object chip must exist on the image) and
 *       `'OR'` (at least one selected tag OR object chip must exist on the image) logic modes.
 *
 * @param {Readonly<Record<string, any>>} image_record - Candidate image record.
 * @param {readonly string[]} selected_tags_lowercase - Lowercased selected tag chips.
 * @param {readonly string[]} selected_objects_lowercase - Lowercased selected object chips.
 * @param {'AND' | 'OR' | 'and' | 'or'} tag_filter_mode - Logical combination mode.
 * @returns {boolean} True when the image record satisfies the chip criteria.
 */
export function evaluateTagAndObjectChipMatch(
    image_record,
    selected_tags_lowercase,
    selected_objects_lowercase,
    tag_filter_mode = 'AND'
) {
    if (selected_tags_lowercase.length === 0 && selected_objects_lowercase.length === 0) {
        return true;
    }

    const analysis_record = image_record?.analysis || {};
    const image_tags_lowercase = (analysis_record.tags || []).map(tag_string => String(tag_string).toLowerCase());
    const image_objects_lowercase = (analysis_record.objects || []).map(object_string => String(object_string).toLowerCase());

    const active_chip_requirements = [
        ...selected_tags_lowercase.map(required_tag_name => ({
            required_token: required_tag_name,
            candidate_pool: image_tags_lowercase
        })),
        ...selected_objects_lowercase.map(required_object_name => ({
            required_token: required_object_name,
            candidate_pool: image_objects_lowercase
        }))
    ];

    const normalized_mode = String(tag_filter_mode || 'AND').toUpperCase();
    if (normalized_mode === 'AND') {
        return active_chip_requirements.every(requirement =>
            requirement.candidate_pool.includes(requirement.required_token)
        );
    }

    return active_chip_requirements.some(requirement =>
        requirement.candidate_pool.includes(requirement.required_token)
    );
}

/**
 * WHAT: Filters a list of image records against an explicit, immutable snapshot of filter criteria.
 * WHY:  Replaces impure DOM-reading filter loops with a single deterministic pure transformation
 *       covering tags, objects, negative terms, scene type, date range, completeness status,
 *       EVoC theme, and Laya facets.
 *
 * @param {readonly Record<string, any>[]} base_image_records - Input list of candidate image records.
 * @param {Readonly<{
 *   selected_tags?: Iterable<string>,
 *   selected_objects?: Iterable<string>,
 *   tag_filter_mode?: 'AND' | 'OR' | 'and' | 'or',
 *   exclude_terms_raw?: string,
 *   scene_type?: string,
 *   date_from?: string,
 *   date_to?: string,
 *   data_status?: string,
 *   theme_filter?: string,
 *   facet_medium?: string,
 *   facet_mood?: string,
 *   facet_composition?: string
 * }>} filter_criteria_snapshot - Explicit filter configuration.
 * @returns {Record<string, any>[]} New filtered array of image records.
 */
export function filterImageRecordsByCriteria(base_image_records, filter_criteria_snapshot = {}) {
    if (!Array.isArray(base_image_records)) {
        return [];
    }

    const selected_tags_lowercase = Array.from(filter_criteria_snapshot.selected_tags || [])
        .map(tag_item => String(tag_item).toLowerCase());
    const selected_objects_lowercase = Array.from(filter_criteria_snapshot.selected_objects || [])
        .map(object_item => String(object_item).toLowerCase());
    const tag_filter_mode = filter_criteria_snapshot.tag_filter_mode || 'AND';

    const negative_terms_list = String(filter_criteria_snapshot.exclude_terms_raw || '')
        .toLowerCase()
        .split(/[\s,]+/)
        .map(term_string => term_string.trim())
        .filter(term_string => term_string.length > 0);

    const raw_scene_type = String(filter_criteria_snapshot.scene_type || '').trim();
    const scene_type_filter_lowercase = (raw_scene_type && raw_scene_type.toLowerCase() !== 'all')
        ? raw_scene_type.toLowerCase()
        : '';

    const start_date_boundary = filter_criteria_snapshot.date_from
        ? new Date(filter_criteria_snapshot.date_from)
        : null;
    const end_date_boundary = filter_criteria_snapshot.date_to
        ? (() => {
            const end_of_day_date = new Date(filter_criteria_snapshot.date_to);
            end_of_day_date.setHours(23, 59, 59, 999);
            return end_of_day_date;
        })()
        : null;

    const raw_data_status = String(filter_criteria_snapshot.data_status || 'all').trim();
    const data_status_filter = raw_data_status === 'all' ? '' : raw_data_status;

    const normalize_facet_value = (raw_value) => {
        const trimmed_value = String(raw_value || '').trim();
        return (trimmed_value && trimmed_value !== 'all') ? trimmed_value : '';
    };

    const theme_filter = normalize_facet_value(filter_criteria_snapshot.theme_filter);
    const facet_medium_filter = normalize_facet_value(filter_criteria_snapshot.facet_medium);
    const facet_mood_filter = normalize_facet_value(filter_criteria_snapshot.facet_mood);
    const facet_composition_filter = normalize_facet_value(filter_criteria_snapshot.facet_composition);

    return base_image_records.filter(image_record => {
        const analysis_record = image_record?.analysis || {};

        // 1. Tag & Object Chips (AND / OR)
        if (!evaluateTagAndObjectChipMatch(
            image_record,
            selected_tags_lowercase,
            selected_objects_lowercase,
            tag_filter_mode
        )) {
            return false;
        }

        // 2. Negative / Excluded Terms
        if (negative_terms_list.length > 0) {
            const combined_searchable_text = [
                image_record?.filename || '',
                analysis_record.summary || '',
                ...(analysis_record.objects || []),
                ...(analysis_record.tags || []),
                analysis_record.scene_type || ''
            ].join(' ').toLowerCase();

            const contains_excluded_term = negative_terms_list.some(excluded_term =>
                combined_searchable_text.includes(excluded_term)
            );
            if (contains_excluded_term) {
                return false;
            }
        }

        // 3. Scene Type (case-insensitive)
        if (scene_type_filter_lowercase) {
            const candidate_scene_lowercase = String(analysis_record.scene_type || '').toLowerCase();
            if (candidate_scene_lowercase !== scene_type_filter_lowercase) {
                return false;
            }
        }

        // 4. Date Range
        if (start_date_boundary || end_date_boundary) {
            const image_creation_date = new Date(image_record?.created_at || 0);
            if (start_date_boundary && image_creation_date < start_date_boundary) return false;
            if (end_date_boundary && image_creation_date > end_date_boundary) return false;
        }

        // 5. Data Completeness / Hygiene Status
        if (data_status_filter) {
            const has_tags = Array.isArray(analysis_record.tags) && analysis_record.tags.length > 0;
            const has_objects = Array.isArray(analysis_record.objects) && analysis_record.objects.length > 0;
            const has_scene = Boolean(analysis_record.scene_type && String(analysis_record.scene_type).toLowerCase() !== 'unknown');
            const has_summary = Boolean(
                analysis_record.summary &&
                analysis_record.summary.trim().length > 0 &&
                analysis_record.summary !== 'No summary available'
            );

            if ((data_status_filter === 'missing-any' || data_status_filter === 'incomplete') && (has_tags && has_objects && has_scene && has_summary)) return false;
            if (data_status_filter === 'complete' && (!has_tags || !has_objects || !has_summary)) return false;
            if ((data_status_filter === 'missing-tags' || data_status_filter === 'no_tags') && has_tags) return false;
            if ((data_status_filter === 'missing-objects' || data_status_filter === 'no_objects') && has_objects) return false;
            if (data_status_filter === 'missing-badge' && has_scene) return false;
            if ((data_status_filter === 'missing-summary' || data_status_filter === 'no_summary') && has_summary) return false;
        }

        // 6. Laya EVoC Cluster Theme & Visual Facets
        if (theme_filter && (image_record?.theme_name || '') !== theme_filter) return false;
        if (facet_medium_filter && (image_record?.facet_medium || '') !== facet_medium_filter) return false;
        if (facet_mood_filter && (image_record?.facet_mood || '') !== facet_mood_filter) return false;
        if (facet_composition_filter && (image_record?.facet_composition || '') !== facet_composition_filter) return false;

        return true;
    });
}

/**
 * WHAT: Sorts a filtered list of image records without mutating the input array.
 * WHY:  Guarantees immutability by cloning the array via `.slice()` before applying the
 *       requested ordering (`'relevance'`, `'newest'`, `'oldest'`, `'date_desc'`, `'date_asc'`, `'name_asc'`, `'name_desc'`).
 *
 * @param {readonly Record<string, any>[]} filtered_image_records - Unsorted or relevance-ranked image records.
 * @param {string} sort_mode_name - Requested sort mode.
 * @param {boolean} has_active_search_query - Whether a text search query produced relevance scores.
 * @returns {Record<string, any>[]} Newly sorted array of image records.
 */
export function sortFilteredImageRecords(
    filtered_image_records,
    sort_mode_name = 'relevance',
    has_active_search_query = false
) {
    if (!Array.isArray(filtered_image_records)) {
        return [];
    }

    if (sort_mode_name === 'relevance' && has_active_search_query) {
        return filtered_image_records.slice();
    }

    return filtered_image_records.slice().sort((first_image, second_image) => {
        const first_created_timestamp = new Date(first_image?.created_at || 0).getTime();
        const second_created_timestamp = new Date(second_image?.created_at || 0).getTime();
        const first_updated_timestamp = first_image?.updated_at
            ? new Date(first_image.updated_at).getTime()
            : first_created_timestamp;
        const second_updated_timestamp = second_image?.updated_at
            ? new Date(second_image.updated_at).getTime()
            : second_created_timestamp;

        if (sort_mode_name === 'oldest' || sort_mode_name === 'date_asc') {
            const creation_time_delta = first_created_timestamp - second_created_timestamp;
            if (creation_time_delta !== 0) return creation_time_delta;
            return (Number(first_image?.id) || 0) - (Number(second_image?.id) || 0);
        }

        if (sort_mode_name === 'name_asc') {
            return String(first_image?.filename || '').localeCompare(String(second_image?.filename || ''));
        }

        if (sort_mode_name === 'name_desc') {
            return String(second_image?.filename || '').localeCompare(String(first_image?.filename || ''));
        }

        // Default ('newest', 'date_desc', or 'relevance' fallback without active query)
        const update_time_delta = second_updated_timestamp - first_updated_timestamp;
        if (update_time_delta !== 0) return update_time_delta;
        return (Number(second_image?.id) || 0) - (Number(first_image?.id) || 0);
    });
}

/**
 * WHAT: Filters and ranks tag and object autocomplete candidates matching a user's partial query string.
 * WHY:  Accepts either `{ name, count }` objects (from `/stats`) or plain strings, excludes already-selected
 *       chips, and returns up to `maximum_results_limit` immutable candidate objects without touching the DOM.
 *
 * @param {readonly ({ readonly name: string, readonly count?: number } | string)[]} known_tags_list - Known tags.
 * @param {readonly ({ readonly name: string, readonly count?: number } | string)[]} known_objects_list - Known objects.
 * @param {ReadonlySet<string>} selected_tags_set - Currently selected tag chips.
 * @param {ReadonlySet<string>} selected_objects_set - Currently selected object chips.
 * @param {string} raw_query_string - Current text inside the tag filter input.
 * @param {number} [maximum_results_limit=15] - Maximum candidates to return.
 * @returns {readonly { readonly name: string, readonly count: number, readonly type: 'tag' | 'object' }[]}
 */
export function rankTagAutocompleteMatches(
    known_tags_list,
    known_objects_list,
    selected_tags_set,
    selected_objects_set,
    raw_query_string,
    maximum_results_limit = 15
) {
    const normalized_query = String(raw_query_string || '').trim().toLowerCase();
    if (!normalized_query) {
        return [];
    }

    const normalize_entry = (raw_entry, entry_type) => {
        if (typeof raw_entry === 'string') {
            return { name: raw_entry, count: 0, type: entry_type };
        }
        return {
            name: String(raw_entry?.name || ''),
            count: Number(raw_entry?.count) || 0,
            type: entry_type
        };
    };

    const combined_catalog = [
        ...(known_tags_list || []).map(tag_entry => normalize_entry(tag_entry, 'tag')),
        ...(known_objects_list || []).map(object_entry => normalize_entry(object_entry, 'object'))
    ];

    return combined_catalog
        .filter(candidate_item => {
            if (!candidate_item.name) return false;
            if (candidate_item.type === 'tag' && selected_tags_set && selected_tags_set.has(candidate_item.name)) {
                return false;
            }
            if (candidate_item.type === 'object' && selected_objects_set && selected_objects_set.has(candidate_item.name)) {
                return false;
            }
            return candidate_item.name.toLowerCase().includes(normalized_query);
        })
        .slice(0, maximum_results_limit);
}

/**
 * WHAT: Extracts the target filter state ("Find Similar") from a source image record.
 * WHY:  Separates parsing `source_image_record.analysis` (whether stored as a JSON string
 *       or an object) and truncating the summary to 6 words from mutating UI controls.
 *
 * @param {Readonly<Record<string, any>> | null | undefined} source_image_record - Source image to match.
 * @returns {{
 *   readonly tags_to_select: readonly string[],
 *   readonly objects_to_select: readonly string[],
 *   readonly truncated_summary_query: string,
 *   readonly parsed_analysis_record: Record<string, any>
 * }}
 */
export function extractSimilarImageSearchState(source_image_record) {
    if (!source_image_record) {
        return {
            tags_to_select: [],
            objects_to_select: [],
            truncated_summary_query: '',
            parsed_analysis_record: {}
        };
    }

    let parsed_analysis_record = source_image_record.analysis || {};
    if (typeof parsed_analysis_record === 'string') {
        try {
            parsed_analysis_record = JSON.parse(parsed_analysis_record || '{}');
        } catch (_json_parse_error) {
            parsed_analysis_record = {};
        }
    }

    const tags_to_select = Array.isArray(parsed_analysis_record.tags)
        ? parsed_analysis_record.tags.slice()
        : [];
    const objects_to_select = Array.isArray(parsed_analysis_record.objects)
        ? parsed_analysis_record.objects.slice()
        : [];
    const raw_summary_string = typeof parsed_analysis_record.summary === 'string'
        ? parsed_analysis_record.summary.trim()
        : '';
    const truncated_summary_query = raw_summary_string
        ? raw_summary_string.split(/\s+/).slice(0, 6).join(' ')
        : '';

    return {
        tags_to_select,
        objects_to_select,
        truncated_summary_query,
        parsed_analysis_record
    };
}

/**
 * WHAT: Computes the next immutable list of recent bulk-rename base names.
 * WHY:  Replaces in-place `.unshift()` and `.slice()` mutations with a pure state transition
 *       `(existing_list, new_name) => next_list`.
 *
 * @param {readonly string[]} existing_recent_renames_list - Previously saved base names.
 * @param {string} new_base_name_string - Newly used base name to record at the front.
 * @param {number} [maximum_history_count=10] - Maximum items to retain.
 * @returns {readonly string[]} Fresh deduplicated array of recent base names.
 */
export function computeUpdatedRecentRenamesList(
    existing_recent_renames_list,
    new_base_name_string,
    maximum_history_count = 10
) {
    const safe_existing_list = Array.isArray(existing_recent_renames_list)
        ? existing_recent_renames_list
        : [];
    const trimmed_new_name = String(new_base_name_string || '').trim();
    if (!trimmed_new_name) {
        return safe_existing_list.slice(0, maximum_history_count);
    }

    const deduplicated_previous_names = safe_existing_list.filter(
        existing_name => existing_name !== trimmed_new_name
    );
    return [trimmed_new_name, ...deduplicated_previous_names].slice(0, maximum_history_count);
}

/**
 * WHAT: Formats detected Laya smart-search intent properties into human-readable badge labels.
 * WHY:  Separates string formatting of intent payloads (`/api/laya/query-intent`) from DOM banner updates.
 *
 * @param {Readonly<Record<string, any>> | null | undefined} intent_payload - Response from `/api/laya/query-intent`.
 * @returns {readonly string[]} Array of formatted filter description strings.
 */
export function formatDetectedIntentFilterDescriptions(intent_payload) {
    if (!intent_payload || typeof intent_payload !== 'object') {
        return [];
    }

    const suggested_filters = intent_payload.suggested_filters || intent_payload;
    const detected_descriptions = [];

    const medium_value = suggested_filters.medium || suggested_filters.facet_medium;
    const mood_value = suggested_filters.mood || suggested_filters.facet_mood;
    const composition_value = suggested_filters.composition || suggested_filters.facet_composition;

    if (medium_value) {
        detected_descriptions.push(`Medium: ${String(medium_value).replace(/_/g, ' ')}`);
    }
    if (mood_value) {
        detected_descriptions.push(`Mood: ${String(mood_value).replace(/_/g, ' ')}`);
    }
    if (composition_value) {
        detected_descriptions.push(`Composition: ${String(composition_value).replace(/_/g, ' ')}`);
    }
    if (Array.isArray(suggested_filters.exclude_terms) && suggested_filters.exclude_terms.length > 0) {
        detected_descriptions.push(`Exclude: -${suggested_filters.exclude_terms.join(', -')}`);
    }

    return detected_descriptions;
}
