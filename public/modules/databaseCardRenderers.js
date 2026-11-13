/**
 * Pure Tri-Face Prism Geometry & Card HTML Renderers for `public/database.js`.
 *
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * Pure deterministic calculations and XSS-escaped HTML builders with zero DOM or module-state coupling.
 */

import {
    escapeHtmlCharacters,
    extractDicedPromptMasterRecord,
    renderDicedPromptBackDetailsHtml,
    buildCardThumbnailBlockHtml,
    buildCardBackIdentityHeaderHtml
} from './cardCore.js';

const escapeCardHtmlText = escapeHtmlCharacters;

export {
    escapeCardHtmlText,
    extractDicedPromptMasterRecord,
    renderDicedPromptBackDetailsHtml,
    buildCardThumbnailBlockHtml,
    buildCardBackIdentityHeaderHtml
};

export function computeCardPixelWidthFromGridWidth(grid_container_pixel_width) {
    const safe_grid_width = Number(grid_container_pixel_width) > 0 ? Number(grid_container_pixel_width) : 1000;
    const responsive_column_count = Math.max(1, Math.floor((safe_grid_width + 16) / (420 + 16)));
    return (safe_grid_width - (responsive_column_count - 1) * 16) / responsive_column_count;
}

/**
 * WHAT: Computes the inscribed radius (apothem) of an equilateral 3-sided card prism.
 * WHY: Placing each 120-degree face outward by `W / (2 * sqrt(3))` and pulling `.card-inner` back by `-r` keeps the active card face flush at `Z = 0` so text stays razor-sharp while adjacent edges meet cleanly during 3D spins.
 */
export function computeTriangularPrismRadiusPixels(card_width_pixels) {
    const safe_card_width_pixels = Number(card_width_pixels) > 0 ? Number(card_width_pixels) : 320;
    return Math.round(safe_card_width_pixels * 0.2886751346 * 100) / 100;
}

/**
 * WHAT: Pure state transition that computes the cumulative Y-axis spin angle for a 3-sided card.
 * WHY: Modular 120-degree steps (`1 -> 2 -> 3 -> 1` adds `-120deg` each step, while `2 -> 1` or `3 -> 2` adds `+120deg`) prevent backwards rewinding when cycling from Side 3 back to Side 1.
 */
export function computeNextPrismSpinDegrees(current_spin_degrees, current_side, target_side) {
    const side_to_step_index = { '1': 0, '2': 1, '3': 2 };
    const safe_current_spin_degrees = Number.isFinite(Number(current_spin_degrees)) ? Number(current_spin_degrees) : 0;
    const current_step_index = side_to_step_index[String(current_side)] ?? 0;
    const target_step_index = side_to_step_index[String(target_side)] ?? 0;
    const clockwise_step_difference = (target_step_index - current_step_index + 3) % 3;

    if (clockwise_step_difference === 0) {
        return safe_current_spin_degrees;
    }

    const rotation_delta_degrees = clockwise_step_difference === 1 ? -120 : 120;
    return safe_current_spin_degrees + rotation_delta_degrees;
}

/**
 * WHAT: Synchronizes the CSS custom property `--prism-r` on `dbGrid` with the live rendered card width.
 * WHY: Ensures all cards in the grid share an exact 3D prism radius even before their first click or after responsive column changes.
 */

export const BRICKS_GRADS = ['purple', 'blue', 'green', 'orange', 'pink'];
export function getCardGrad(id) {
    const numericId = typeof id === 'string' ? id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : id;
    return BRICKS_GRADS[numericId % BRICKS_GRADS.length];
}

export function createCardHtml(img, summaryHeight, isPriority = false, isEager = false, isSelected = false) {
    // Parse stored JSON data (handle if already parsed or string)
    let analysis = img.analysis;
    if (typeof analysis === 'string') {
        try { analysis = JSON.parse(analysis || '{}'); } catch (e) { analysis = {}; }
    } else {
        analysis = analysis || {};
    }

    const diced_master_record = extractDicedPromptMasterRecord(img, analysis);

    let metadata = img.metadata;
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata || '{}'); } catch (e) { metadata = {}; }
    } else {
        metadata = metadata || {};
    }
    const date = new Date(img.created_at).toLocaleDateString();

    // Extract key metadata fields for display
    const width = img.width || metadata.ImageWidth || metadata.ExifImageWidth || metadata.PixelXDimension || 'N/A';
    const height = img.height || metadata.ImageHeight || metadata.ExifImageHeight || metadata.PixelYDimension || 'N/A';

    // Format full metadata
    const metadataStr = Object.entries(metadata)
        .filter(([key]) => !['ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight'].includes(key))
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n');

    // Thumbnail path logic (ID-based)
    const timeStamp = img.updated_at ? new Date(img.updated_at).getTime() : (img.created_at ? new Date(img.created_at).getTime() : '');
    const displayPath = `thumbnails/id_${img.id}.avif${timeStamp ? '?t=' + timeStamp : ''}`;

    const fullPath = img.path;
    // Selection flag passed explicitly for purity.
    const front_thumbnail_html = buildCardThumbnailBlockHtml({
        image_id: img.id,
        display_path: displayPath,
        full_path: fullPath,
        filename_text: img.filename || '',
        size_pixels: 100,
        is_eager: isEager,
        is_priority: isPriority
    });
    const back_identity_header_html = buildCardBackIdentityHeaderHtml({
        image_id: img.id,
        display_path: displayPath,
        full_path: fullPath,
        filename_text: img.filename || '',
        metadata_tooltip: metadataStr || 'No extra metadata',
        date_text: date,
        width_text: width,
        height_text: height,
        is_eager: isEager
    });

    return `
        <div class="card ${isSelected ? 'selected' : ''}" data-id="${img.id}" data-side="1" data-spin-deg="0" style="--spin-deg: 0deg;" data-grad="${getCardGrad(img.id)}">
            <div class="card-inner">
                <!-- SIDE 1: FRONT FACE (ORIGINAL CLEAN LAYOUT) -->
                <div class="card-front" data-face="1">
                    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
                        <!--Thumbnail Image -->
                        ${front_thumbnail_html}
                        <!-- Image Info -->
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1; min-width: 0;">
                                    <h2 class="card-filename file-link" data-path="${escapeCardHtmlText(img.path || '')}" style="margin: 0; border: none; font-size: 1.1rem; cursor: pointer; color: var(--accent); text-decoration: none; display: block;" title="${escapeCardHtmlText(metadataStr || 'No extra metadata')}">${escapeCardHtmlText(img.filename || '')}</h2>
                                    <small style="color: var(--text-secondary);">${escapeCardHtmlText(date)} • ${escapeCardHtmlText(width)}w ${escapeCardHtmlText(height)}h</small>
                                </div>
                                <div style="display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-end;">
                                    <button class="delete-btn" data-id="${img.id}" style="background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 0.25rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.2s;" title="Delete Image">X</button>
                                    <!-- Selection Checkbox -->
                                    <label class="card-select-target" title="Select image">
                                        <input type="checkbox" class="card-select-cb" data-id="${img.id}" aria-label="Select ${escapeCardHtmlText(img.filename || 'image')}" ${isSelected ? 'checked' : ''}>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- AI Summary Section -->
                    <div class="analysis-section" style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                            <h3 style="font-size: 0.9rem; color: var(--text-secondary); margin: 0;">AI Summary</h3>
                            <button class="copy-btn" data-text="${escapeCardHtmlText(analysis.summary || '')}" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; cursor: pointer; font-size: 0.65rem; white-space: nowrap;" title="Copy to clipboard">Copy</button>
                        </div>
                        <p class="image-summary ${summaryHeight ? 'pretext-measured' : ''}" style="margin: 0; font-size: 0.9rem; color: var(--text-primary); line-height: 1.5; ${summaryHeight ? ` min-height: ${summaryHeight}px;` : ''}">${escapeCardHtmlText(analysis.summary || 'No summary')}</p>
                    </div>

                    <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.68rem; color: var(--text-secondary); opacity: 0.55;">1/3 • Summary</span>
                        <span style="font-size: 0.7rem; color: var(--text-secondary); opacity: 0.65;">Click card: Tags → Diced Prompt ↻</span>
                    </div>
                </div>

                <!-- SIDE 2: TAGS & OBJECTS (3D PRISM FACE AT 120deg) -->
                <div class="card-back card-back-face card-back-tags" data-face="2">
                    ${back_identity_header_html}
                    <div class="tags-section" style="flex: 1;">
                        <div class="tags-container" style="margin-bottom: 1rem;">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Detected Objects:</strong>
                            ${(analysis.objects || []).map(obj => `<span class="tag editable" data-id="${img.id}" data-type="objects" data-tag="${obj}" style="background-color: rgba(16, 185, 129, 0.2); color: #34d399; cursor: pointer; font-size: 0.75rem; margin-bottom: 4px;" title="Click to search, Right-click to edit">${obj}</span>`).join('')}
                            <button class="add-tag-btn" data-id="${img.id}" data-type="objects" title="Add Object">+</button>
                        </div>
                        <div class="tags-container">
                            <strong style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Image Tags:</strong>
                            ${(analysis.tags || []).map(tag => `<span class="tag editable" data-id="${img.id}" data-type="tags" data-tag="${tag}" style="cursor: pointer; font-size: 0.75rem; margin-bottom: 4px;" title="Click to search, Right-click to edit">${tag}</span>`).join('')}
                            ${analysis.scene_type ? `<span class="tag" style="background-color: rgba(129, 140, 248, 0.2); color: #818cf8; font-size: 0.75rem; margin-bottom: 4px;">${analysis.scene_type}</span>` : ''}
                            <button class="add-tag-btn" data-id="${img.id}" data-type="tags" title="Add Tag">+</button>
                        </div>
                    </div>
                    <div style="margin-top: 1rem; text-align: center;">
                        <button class="card-side-pill" data-target-side="3" style="border-color: rgba(56, 189, 248, 0.5); color: #38bdf8;">Next: Diced Prompt (3/3) ↻</button>
                    </div>
                </div>

                <!-- SIDE 3: DICED PROMPT MASTER RECORD (3D PRISM FACE AT 240deg) -->
                <div class="card-back card-back-face card-back-dicer" data-face="3">
                    ${back_identity_header_html}
                    ${renderDicedPromptBackDetailsHtml(img, diced_master_record)}
                    <div style="margin-top: 0.85rem; text-align: center;">
                        <button class="card-side-pill" data-target-side="1" style="border-color: var(--accent); color: var(--accent);">Back to Summary (1/3) ↻</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

