// ============================================================================
// PRETEXT LAYOUT ENGINE - Shared Module
// ============================================================================
// WHAT: Pure mathematical text measurement and zero-reflow card layout engine.
// WHY: Measuring DOM elements via getBoundingClientRect() or offsetHeight causes
//      forced synchronous layout thrashing (CLS) across hundreds of database cards.
//      Pretext separates preparation (~0.04ms) from layout arithmetic (~0.0002ms),
//      enabling instantaneous virtual list rendering without browser reflow.
//
// PROTOCOL COMPLIANCE:
// 1. "can_be_long" Protocol: Descriptive, unabbreviated semantic identifiers.
// 2. "Tutorial Protocol": Comprehensive WHAT and WHY instructional documentation.
// 3. Pure Functional Architecture: Pure arithmetic layout transformations.
// ============================================================================

import { prepare, layout } from './libs/pretext/layout.js';
import { defineMasonryGridLanes } from "https://cdn.jsdelivr.net/npm/@schalkneethling/masonry-gridlanes-wc@0.1.0/+esm";

// ============================================================================
// CONFIGURATION (IMMUTABLE CONSTANTS)
// ============================================================================

// WHAT: Explicit typographic specifications matching CSS font rendering.
// WHY: Pretext's Canvas text measurement requires exact font families and pixel sizes
//      to compute line wrap points that perfectly match browser text rasterization.
export const TYPOGRAPHY_FONT_SPECIFICATIONS = Object.freeze({
    database: '16px Numans',
    search:   '14.4px Numans',
});

// WHAT: Line heights in pixels derived from CSS line-height: 1.6 multiplier.
// WHY: 16px * 1.6 = 25.6px for database cards; 14.4px * 1.6 = 23.04px for search cards.
export const TYPOGRAPHY_LINE_HEIGHT_PIXELS = Object.freeze({
    database: 25.6,
    search:   23.04,
});

// ============================================================================
// INTERNAL TYPOGRAPHY PREPARATION CACHE
// ============================================================================

// WHAT: Bounded Least-Recently-Used cache container for prepared text layout handles.
// WHY: Avoids unbounded memory growth when scrolling through thousands of database items.
const MAXIMUM_PREPARED_TEXT_CACHE_ENTRIES_COUNT = 2000;
const prepared_text_handles_cache_map = new Map();

let is_pretext_engine_ready = false;

// ============================================================================
// PURE FUNCTIONAL LAYOUT TRANSFORMATIONS
// ============================================================================

/**
 * WHAT: Retrieves a cached PreparedText handle or allocates a fresh arithmetic handle.
 * WHY: The prepare() arithmetic step parses glyph advance widths once (~0.04ms).
 *      Subsequent layout calculations at varying container widths take ~0.0002ms.
 * 
 * @param {string} text_content_string - The raw text block to measure.
 * @param {string} font_specification_string - The exact CSS font string (e.g., '16px Numans').
 * @returns {Object} The internal Pretext PreparedText arithmetic handle.
 */
export function get_or_create_prepared_text_handle(text_content_string, font_specification_string) {
    const composite_cache_lookup_key = `${font_specification_string}|${text_content_string}`;

    // WHAT: Checking if the handle already exists in the memory cache.
    // WHY: Bypasses glyph advance width re-calculation for previously measured strings.
    if (prepared_text_handles_cache_map.has(composite_cache_lookup_key)) {
        return prepared_text_handles_cache_map.get(composite_cache_lookup_key);
    }

    // WHAT: Evicting the oldest cache key if capacity exceeds 2,000 entries.
    // WHY: Prevents unbounded memory usage during extensive scrolling across 10,000+ images.
    if (prepared_text_handles_cache_map.size >= MAXIMUM_PREPARED_TEXT_CACHE_ENTRIES_COUNT) {
        const oldest_cache_entry_key = prepared_text_handles_cache_map.keys().next().value;
        prepared_text_handles_cache_map.delete(oldest_cache_entry_key);
    }

    const freshly_prepared_handle = prepare(text_content_string, font_specification_string);
    prepared_text_handles_cache_map.set(composite_cache_lookup_key, freshly_prepared_handle);
    return freshly_prepared_handle;
}

/**
 * WHAT: Pure mathematical calculation of text height for a given container width.
 * WHY: Calculates exact line breaks and total pixel heights without inserting DOM nodes.
 * 
 * @param {string} text_content_string - The summary or description text.
 * @param {number} maximum_container_width_pixels - The card text container width in pixels.
 * @param {'database'|'search'} page_context_identifier - Specifies typographic styling rules.
 * @returns {{ height: number, lineCount: number }} Computed pixel height and line count.
 */
export function measure_text_rendered_height(
    text_content_string,
    maximum_container_width_pixels,
    page_context_identifier = 'database'
) {
    // WHAT: Guarding against empty, null, or invalid input parameters.
    // WHY: Returns zero height immediately without executing typography preparation routines.
    if (!text_content_string || !maximum_container_width_pixels || maximum_container_width_pixels <= 0) {
        return Object.freeze({ height: 0, lineCount: 0 });
    }

    const resolved_font_specification = (
        TYPOGRAPHY_FONT_SPECIFICATIONS[page_context_identifier] ||
        TYPOGRAPHY_FONT_SPECIFICATIONS.database
    );
    const resolved_line_height_pixels = (
        TYPOGRAPHY_LINE_HEIGHT_PIXELS[page_context_identifier] ||
        TYPOGRAPHY_LINE_HEIGHT_PIXELS.database
    );

    const prepared_typography_handle = get_or_create_prepared_text_handle(
        text_content_string,
        resolved_font_specification
    );

    // WHAT: Invoking Pretext pure arithmetic layout routine.
    // WHY: Executes in ~0.0002ms via linear array scans over pre-calculated character widths.
    const computed_layout_metrics = layout(
        prepared_typography_handle,
        maximum_container_width_pixels,
        resolved_line_height_pixels
    );

    return Object.freeze({
        height: computed_layout_metrics.height,
        lineCount: computed_layout_metrics.lineCount
    });
}

/**
 * WHAT: Pure batch transformation mapping a collection of items to a Map of IDs to heights.
 * WHY: Enables synchronous height assignment for dozens of cards before virtual DOM render.
 * 
 * @param {ReadonlyArray<{id: string|number, text: string}>} batch_items_collection - Items to measure.
 * @param {number} maximum_container_width_pixels - The container width in pixels.
 * @param {'database'|'search'} page_context_identifier - Target context typography.
 * @returns {Map<string, number>} Map linking each item ID string to computed pixel height.
 */
export function measure_batch_card_heights(
    batch_items_collection,
    maximum_container_width_pixels,
    page_context_identifier = 'database'
) {
    const computed_heights_dictionary_map = new Map();

    for (const single_item_record of batch_items_collection) {
        const layout_calculation_result = measure_text_rendered_height(
            single_item_record.text,
            maximum_container_width_pixels,
            page_context_identifier
        );
        computed_heights_dictionary_map.set(String(single_item_record.id), layout_calculation_result.height);
    }

    return computed_heights_dictionary_map;
}

// ============================================================================
// IMPERATIVE SHELL BOUNDARY ADAPTER (BACKWARD COMPATIBILITY)
// ============================================================================

export const PretextLayout = Object.freeze({
    /**
     * WHAT: Initializes Pretext dependencies and awaits font rasterization readiness.
     * WHY: Ensures Google Fonts (Numans) are loaded into the browser before measuring canvas metrics.
     */
    async init() {
        if (is_pretext_engine_ready) {
            return;
        }

        try {
            // Register custom element web component
            defineMasonryGridLanes();

            // WHAT: Waiting for font document readiness.
            // WHY: If canvas measures fonts before Numans finishes loading, fallback glyph metrics
            //      will produce incorrect line break heights, causing layout jitter.
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
                console.log('[Pretext] Numans typography loaded, layout engine ready.');
            }
            is_pretext_engine_ready = true;
        } catch (initialization_error_exception) {
            console.warn('[Pretext] Initialization warning, proceeding with fallback metrics:', initialization_error_exception);
            is_pretext_engine_ready = true;
        }
    },

    measureText(text_content_string, maximum_container_width_pixels, page_context_identifier = 'database') {
        return measure_text_rendered_height(text_content_string, maximum_container_width_pixels, page_context_identifier);
    },

    measureBatch(batch_items_collection, maximum_container_width_pixels, page_context_identifier = 'database') {
        return measure_batch_card_heights(batch_items_collection, maximum_container_width_pixels, page_context_identifier);
    },

    get ready() {
        return is_pretext_engine_ready;
    }
});

// WHAT: Exposing PretextLayout on window for legacy non-module script contexts.
// WHY: database.js and search.js can invoke PretextLayout globally without ES module refactoring.
if (typeof window !== 'undefined') {
    window.PretextLayout = PretextLayout;
}

export default PretextLayout;
