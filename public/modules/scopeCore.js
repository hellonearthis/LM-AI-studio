// ============================================================================
// LUMINA STUDIO - SCOPE MAP PURE FUNCTIONAL CORE
// ============================================================================
// WHAT: Pure colour generation, DuckDB record normalization, cluster summary
//       aggregation, filter predicates, and canvas crop/zoom geometry math.
// WHY: Separates deterministic mathematical and data transformations from
//      D3 canvas rendering, DuckDB-WASM I/O, and DOM event listeners in `scope.js`.
// ============================================================================

// WHAT: Produces a distinct, aesthetically balanced colour for every cluster identifier.
// WHY: Stepping the hue by the golden angle (~137.508 degrees) distributes 260+ EVoC
//      cluster IDs across the 360-degree colour wheel without repeating palettes.
export function getClusterColour(cluster_identifier) {
    if (cluster_identifier === -1 || cluster_identifier === null || cluster_identifier === undefined) {
        return '#6b7280';
    }
    const golden_angle_hue_degrees = (Number(cluster_identifier) * 137.508) % 360;
    return `hsl(${golden_angle_hue_degrees.toFixed(1)}, 75%, 60%)`;
}

// WHAT: Type-casts numeric coordinates, identifiers, and cluster IDs to standard JS numbers.
// WHY: DuckDB-WASM yields BigInt values for int64 columns, which cannot be compared directly
//      with Number primitives or serialized cleanly to JSON.
export function normalizeCoordinatePointRecords(raw_coordinate_points_collection) {
    return (Array.isArray(raw_coordinate_points_collection) ? raw_coordinate_points_collection : []).map(
        (raw_coordinate_point_record) => ({
            ...raw_coordinate_point_record,
            x: Number(raw_coordinate_point_record.x),
            y: Number(raw_coordinate_point_record.y),
            id: Number(raw_coordinate_point_record.id),
            cluster: (raw_coordinate_point_record.cluster === null || raw_coordinate_point_record.cluster === undefined)
                ? -1
                : Number(raw_coordinate_point_record.cluster)
        })
    );
}

// WHAT: Aggregates coordinate points by cluster ID, counts members, and sorts largest-first.
// WHY: Surfacing high-density thematic clusters at the top of the filter list speeds exploration.
export function buildClusterSummaryCatalog(coordinate_points_collection) {
    const cluster_summary_by_identifier = new Map();
    for (const current_point_record of coordinate_points_collection) {
        const existing_entry = cluster_summary_by_identifier.get(current_point_record.cluster);
        if (!existing_entry) {
            const is_noise_cluster = current_point_record.cluster === -1;
            cluster_summary_by_identifier.set(current_point_record.cluster, {
                cluster_identifier: current_point_record.cluster,
                display_label: is_noise_cluster
                    ? 'Unclustered (noise)'
                    : String(current_point_record.label || `Cluster ${current_point_record.cluster}`).replace(/_/g, ' '),
                image_count: 1
            });
        } else {
            existing_entry.image_count += 1;
        }
    }

    return [...cluster_summary_by_identifier.values()].sort(
        (first_cluster_entry, second_cluster_entry) => second_cluster_entry.image_count - first_cluster_entry.image_count
    );
}

// WHAT: Filters cluster summaries against a user search string by label or exact cluster ID.
// WHY: Pure search predicate makes cluster dropdown filtering deterministic and testable.
export function filterClusterSummariesBySearch(cluster_summary_collection, raw_search_query) {
    const search_text_lowercase = String(raw_search_query || '').trim().toLowerCase();
    if (!search_text_lowercase) {
        return cluster_summary_collection;
    }
    return cluster_summary_collection.filter((cluster_entry) =>
        cluster_entry.display_label.toLowerCase().includes(search_text_lowercase) ||
        String(cluster_entry.cluster_identifier) === search_text_lowercase
    );
}

// WHAT: Filters coordinate points to those whose cluster identifier is in the selected Set.
// WHY: Isolates cluster visibility filtering from D3 scale domains and canvas redraws.
export function filterPointsBySelectedClusters(coordinate_points_collection, selected_cluster_identifiers) {
    return coordinate_points_collection.filter((current_point_record) =>
        selected_cluster_identifiers.has(current_point_record.cluster)
    );
}

// WHAT: Formats the compact cluster selection summary label ("All (N)", "None", or "X of N").
// WHY: Keeps UI status string formatting pure and consistent.
export function formatClusterFilterSummaryText(total_cluster_count, selected_cluster_count) {
    if (selected_cluster_count === total_cluster_count) {
        return `All (${total_cluster_count})`;
    }
    if (selected_cluster_count === 0) {
        return 'None';
    }
    return `${selected_cluster_count} of ${total_cluster_count}`;
}

// WHAT: Formats the visible point count status indicator text.
// WHY: Purely formats locale-aware counts for the Scope header badge.
export function formatPointCountDisplayText(visible_points_count, total_points_count) {
    if (visible_points_count === total_points_count) {
        return `(${total_points_count.toLocaleString()} items)`;
    }
    return `(${visible_points_count.toLocaleString()} of ${total_points_count.toLocaleString()} items)`;
}

// WHAT: Computes centered square cover-crop source coordinates for an arbitrary aspect ratio image.
// WHY: Ensures square thumbnails render without stretching or distortion on the 2D canvas.
export function computeSquareCoverCropMetrics(source_image_width_pixels, source_image_height_pixels) {
    if (!source_image_width_pixels || !source_image_height_pixels) {
        return null;
    }
    const square_crop_side_length_pixels = Math.min(source_image_width_pixels, source_image_height_pixels);
    return {
        squareCropSideLengthPixels: square_crop_side_length_pixels,
        cropOffsetHorizontalPixels: (source_image_width_pixels - square_crop_side_length_pixels) / 2,
        cropOffsetVerticalPixels: (source_image_height_pixels - square_crop_side_length_pixels) / 2
    };
}

// WHAT: Computes zoom-scaled thumbnail dimensions, border stroke width, and high-res LOD threshold.
// WHY: Scaling thumbnail size by sqrt(zoom) separates dense clusters smoothly as the user zooms in.
export function computeThumbnailFrameMetrics(base_thumbnail_size_pixels, zoom_scale_k, high_res_threshold_pixels) {
    const on_screen_thumbnail_size_pixels = Math.min(240, Math.max(6, base_thumbnail_size_pixels * Math.sqrt(zoom_scale_k)));
    return {
        onScreenSizePixels: on_screen_thumbnail_size_pixels,
        halfSizePixels: on_screen_thumbnail_size_pixels / 2,
        outlineWidthPixels: Math.min(4, Math.max(1.5, on_screen_thumbnail_size_pixels * 0.07)),
        wantsHighResolutionImages: on_screen_thumbnail_size_pixels > high_res_threshold_pixels
    };
}

