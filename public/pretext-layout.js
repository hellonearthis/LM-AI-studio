// ============================================================================
// PRETEXT LAYOUT ENGINE - Shared Module
// ============================================================================
// Wraps @chenglou/pretext for high-performance text measurement across
// the app's card-based UI. Avoids expensive DOM reflows when laying out
// many cards with variable-length summary text.
//
// Usage:
//   await PretextLayout.init();
//   const height = PretextLayout.measureText(summaryText, containerWidthPx);

import { prepare, layout } from './libs/pretext/layout.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Font must exactly match CSS rendering for accurate measurement.
// Body uses: font-family: 'Numans', sans-serif; line-height: 1.6
// Database cards: summary inherits body font at ~16px (no override)
// Search cards: summary uses font-size: 0.9rem ≈ 14.4px
const FONTS = {
    database: '16px Numans',
    search:   '14.4px Numans',
};

// CSS line-height: 1.6 → for 16px font = 25.6px, for 14.4px = 23.04px
const LINE_HEIGHTS = {
    database: 25.6,
    search:   23.04,
};

// ============================================================================
// STATE
// ============================================================================

let _ready = false;

// In-memory cache: key = `${text}|${font}`, value = PreparedText handle
// WeakRef not needed since these are lightweight numeric arrays.
// Limit cache size to avoid unbounded growth.
const MAX_CACHE_SIZE = 2000;
const _prepareCache = new Map();

// ============================================================================
// PUBLIC API
// ============================================================================

const PretextLayout = {

    /**
     * Initialize pretext. Waits for fonts to load before first measurement
     * so canvas measureText uses the correct font metrics.
     */
    async init() {
        if (_ready) return;

        try {
            // Wait for Google Fonts (Numans) to finish loading
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
                console.log('[Pretext] Fonts loaded, engine ready.');
            }
            _ready = true;
        } catch (err) {
            console.warn('[Pretext] Font wait failed, proceeding anyway:', err);
            _ready = true;
        }
    },

    /**
     * Measure the rendered height of a text block at a given container width.
     *
     * @param {string} text - The text content to measure.
     * @param {number} maxWidth - The container width in pixels.
     * @param {'database'|'search'} context - Which page context (determines font/lineHeight).
     * @returns {{ height: number, lineCount: number }}
     */
    measureText(text, maxWidth, context = 'database') {
        if (!text || !maxWidth || maxWidth <= 0) {
            return { height: 0, lineCount: 0 };
        }

        const font = FONTS[context] || FONTS.database;
        const lineHeight = LINE_HEIGHTS[context] || LINE_HEIGHTS.database;

        // Get or create prepared handle (the expensive one-time step)
        const prepared = _getPrepared(text, font);

        // Layout is pure arithmetic - very fast (~0.0002ms)
        return layout(prepared, maxWidth, lineHeight);
    },

    /**
     * Measure a batch of items and return a Map of id → height.
     *
     * @param {Array<{id: string|number, text: string}>} items - Items to measure.
     * @param {number} maxWidth - Container width in pixels.
     * @param {'database'|'search'} context - Page context.
     * @returns {Map<string, number>} Map of id → computed height.
     */
    measureBatch(items, maxWidth, context = 'database') {
        const heights = new Map();
        for (const item of items) {
            const result = this.measureText(item.text, maxWidth, context);
            heights.set(String(item.id), result.height);
        }
        return heights;
    },

    /**
     * Whether the engine is initialized and ready.
     */
    get ready() {
        return _ready;
    },
};

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Get a cached PreparedText handle, or create one.
 * The prepare() call is the expensive step (~0.04ms per text).
 * Once prepared, layout() calls are nearly free.
 */
function _getPrepared(text, font) {
    const key = `${font}|${text}`;

    if (_prepareCache.has(key)) {
        return _prepareCache.get(key);
    }

    // Evict oldest entries if cache is full
    if (_prepareCache.size >= MAX_CACHE_SIZE) {
        const firstKey = _prepareCache.keys().next().value;
        _prepareCache.delete(firstKey);
    }

    const prepared = prepare(text, font);
    _prepareCache.set(key, prepared);
    return prepared;
}

// ============================================================================
// EXPORT
// ============================================================================
// Attach to window for use by non-module scripts (database.js, search.js)
window.PretextLayout = PretextLayout;

export default PretextLayout;
