---
name: pretext-masonry-profiler
description: Profile and validate the Pretext text measurement engine and masonry-grid-lanes custom element layout. Use when debugging Cumulative Layout Shift (CLS), tuning card typography, adjusting text widths and padding, or checking pre-calculated card heights against CSS styles in search.html and database.html.
---

# Pretext & Masonry Profiler Skill

A performance and layout engineering skill focused on zero-CLS (Cumulative Layout Shift) rendering using `@chenglou/pretext` and the `<masonry-grid-lanes>` custom element.

---

## Background & Layout Physics

To render thousands of responsive image cards without content jumping or layout thrashing:
1. **Font Readiness**: [public/pretext-layout.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/pretext-layout.js) waits for `document.fonts.ready` so canvas measurements match actual browser font metrics.
2. **Pre-measurement**: Before card strings are injected into the DOM, `PretextLayout.measureBatch()` calculates summary paragraph heights in sub-milliseconds (~0.0002ms per text).
3. **Masonry Packing**: `<masonry-grid-lanes>` receives pre-sized cards and positions them with column lane packing.

If CSS card margins, padding (`24px` horizontal chrome), or font line-heights change without updating [public/pretext-layout.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/pretext-layout.js), calculated heights will diverge from rendered heights.

---

## Diagnostics & Tuning Workflow

### 1. Verifying Font & Metric Alignment
Run the metric alignment script:
```bash
python .agent/skills/pretext-masonry-profiler/scripts/check_layout_metrics.py
```

### 2. Auditing Card Padding & Container Widths
When rendering batches in [public/search.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/search.js) or [public/database.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/database.js):
- `actualCardWidth = (gridWidth - (colCount - 1) * 16) / colCount;`
- `textWidth = actualCardWidth - 24;` (must strictly match CSS card padding: `0.75rem * 2 = 24px`).
- Ensure `text-metrics="pretext"` attribute is set on `<masonry-grid-lanes>`.

### 3. Measuring Single Dynamic Card Edits
When users inline-edit tags or summaries via context menu modals:
- Use `measureSingleCardHeight(image_record, context)` to calculate updated height without requiring full-grid reflow.
