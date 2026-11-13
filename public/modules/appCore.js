// ============================================================================
// LUMINA STUDIO - INGESTION & ANALYSIS PURE FUNCTIONAL CORE
// ============================================================================
// WHAT: Pure data transformation helpers for file encoding, EXIF field
//       extraction, custom tag merging, and batch progress accounting.
// WHY: Isolates testable domain transformations from Electron IPC, fetch,
//      and DOM manipulation inside `public/app.js`.
// ============================================================================

const EXTENSION_TO_MIME_TYPE_MAP = Object.freeze({
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff'
});

// WHAT: Converts a raw image file buffer and filename into a Base64-encoded Data URL.
// WHY: Centralizes MIME extension detection and byte-to-Base64 encoding so single-file and batch
//      ingestion share one deterministic transformation without duplicating lookup tables.
export function buildDataUrlFromBuffer(image_file_name, image_file_buffer) {
    const file_extension = String(image_file_name || '').split('.').slice(-1)[0].toLowerCase();
    const resolved_mime_type = EXTENSION_TO_MIME_TYPE_MAP[file_extension] || 'image/jpeg';
    const image_byte_view = new Uint8Array(image_file_buffer);
    const chunk_size_bytes = 0x8000;
    const binary_chunk_strings = [];
    for (let byte_offset = 0; byte_offset < image_byte_view.length; byte_offset += chunk_size_bytes) {
        const byte_slice = image_byte_view.subarray(byte_offset, byte_offset + chunk_size_bytes);
        binary_chunk_strings.push(String.fromCharCode.apply(null, byte_slice));
    }
    return `data:${resolved_mime_type};base64,${btoa(binary_chunk_strings.join(''))}`;
}

// WHAT: Merges comma-separated user-supplied custom tags into an analysis record without mutating it.
// WHY: Purely combines existing model tags with custom batch tags while preserving deduplication.
export function mergeCustomTagsIntoAnalysis(analysis_record, custom_tags_raw_text) {
    if (!custom_tags_raw_text || !custom_tags_raw_text.trim()) {
        return analysis_record;
    }
    const existing_tags = Array.isArray(analysis_record.tags) ? analysis_record.tags : [];
    const parsed_custom_tags = custom_tags_raw_text
        .split(',')
        .map(tag_text => tag_text.trim())
        .filter(tag_text => tag_text.length > 0);
    const unique_additional_tags = parsed_custom_tags.filter(
        custom_tag => !existing_tags.includes(custom_tag)
    );
    return {
        ...analysis_record,
        tags: [...existing_tags, ...unique_additional_tags]
    };
}

// WHAT: Extracts human-readable EXIF metadata label/value pairs from raw image metadata.
// WHY: Separates metadata field normalization from DOM element construction.
export function extractDisplayableMetadataFields(metadata_record) {
    const safe_metadata = metadata_record || {};
    const candidate_fields = [
        { label: 'Width', value: safe_metadata.ImageWidth || safe_metadata.ExifImageWidth || safe_metadata.PixelXDimension },
        { label: 'Height', value: safe_metadata.ImageHeight || safe_metadata.ExifImageHeight || safe_metadata.PixelYDimension },
        { label: 'Camera', value: safe_metadata.Make && safe_metadata.Model ? `${safe_metadata.Make} ${safe_metadata.Model}` : null },
        { label: 'Lens', value: safe_metadata.LensModel },
        { label: 'ISO', value: safe_metadata.ISO },
        { label: 'Aperture', value: safe_metadata.FNumber ? `f/${safe_metadata.FNumber}` : null },
        { label: 'Shutter', value: safe_metadata.ExposureTime },
        { label: 'Focal Length', value: safe_metadata.FocalLength ? `${safe_metadata.FocalLength}mm` : null }
    ];
    return candidate_fields.filter(field_entry => Boolean(field_entry.value));
}

// WHAT: Maps an array of file descriptors into the minimal fast-scan payload for `/check-fast-batch`.
// WHY: Avoids sending unneeded file buffers or extra properties over IPC/HTTP.
export function buildFastScanBatchPayload(files_list) {
    return (Array.isArray(files_list) ? files_list : []).map(file_entry => ({
        path: file_entry.path,
        size: file_entry.size,
        mtime: file_entry.mtime
    }));
}

// WHAT: Computes deterministic UI progress strings and percentages for a batch file step.
// WHY: Keeps progress calculation pure and easy to verify independently of DOM updates.
export function computeBatchProgressStats(current_file_index, total_files_count, current_filename) {
    const safe_total = total_files_count > 0 ? total_files_count : 1;
    const percent_complete = Math.round((current_file_index / safe_total) * 100);
    return {
        percent: percent_complete,
        percentText: `${percent_complete}%`,
        currentFileText: `Processing: ${current_filename}`,
        processedText: `${current_file_index + 1}/${total_files_count}`
    };
}

// WHAT: Purely transitions batch summary counters given a single `/save` endpoint response.
// WHY: Eliminates scattered counter increments across branches in `processBatch`.
export function tallyBatchSaveOutcome(current_counters, save_result_payload) {
    const safe_result = save_result_payload || {};
    if (safe_result.new) {
        return { ...current_counters, addedCount: current_counters.addedCount + 1 };
    }
    if (safe_result.updated) {
        return { ...current_counters, updatedCount: current_counters.updatedCount + 1 };
    }
    if (safe_result.duplicate) {
        return { ...current_counters, existingCount: current_counters.existingCount + 1 };
    }
    return { ...current_counters, addedCount: current_counters.addedCount + 1 };
}

