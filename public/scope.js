// ============================================================================
// Lumina Studio - Scope Map (Multimodal UMAP & EVoC Cluster Visualizer)
// 
// WHAT: An interactive WebGL/Canvas visualizer for exploring high-dimensional image
//       embedding spaces projected into 2D via UMAP and grouped via EVoC/HDBSCAN.
// WHY: Exploring thousands of visual assets spatially allows users to visually detect
//       latent patterns, style shifts, and semantic clusters across their dataset.
//
// PROTOCOL COMPLIANCE:
// 1. "can_be_long" Variable Naming: Zero single-letter or abbreviated identifiers.
// 2. "Tutorial Protocol": Comprehensive instructional WHAT and WHY documentation.
// ============================================================================

// D3 is loaded as UMD, attaching to window.d3
import "d3";
const d3 = window.d3;
import { createScopeClusterSidebarController } from "./modules/scopeClusterSidebar.js";
import {
  getClusterColour,
  normalizeCoordinatePointRecords,
  buildClusterSummaryCatalog,
  filterClusterSummariesBySearch,
  filterPointsBySelectedClusters,
  formatClusterFilterSummaryText,
  formatPointCountDisplayText,
  computeSquareCoverCropMetrics,
  computeThumbnailFrameMetrics
} from "./modules/scopeCore.js";

// ============================================================================
// Global Application State Variables
// ============================================================================
// WHAT: Core state containers for coordinate collection, zoom, and selection.
// WHY: Preserves global access across decoupled animation frames, interaction handlers, and UI panels.
let dataset_coordinate_points_collection = [];
let d3_canvas_zoom_transform = d3.zoomIdentity;
let active_hovered_tooltip_point = null;

// Visual canvas selection and 2D drawing context
const d3_visualization_canvas_selection = d3.select("#vizCanvas");
const canvas_rendering_context_2d = d3_visualization_canvas_selection.node().getContext("2d");
const scope_loading_overlay_element = document.getElementById("scopeOverlay");

let is_visualization_initialized = false;

// D3 scale functions and interactive zoom behavior handler
let d3_horizontal_linear_scale = null;
let d3_vertical_linear_scale = null;
let d3_zoom_behavior_handler = null;

// ============================================================================
// Multi-Tier Thumbnail Caching and Spatial Configuration
// ============================================================================
// WHAT: Configuration constants controlling lazy-loading, tile sizes, and memory thresholds.
// WHY: Rendering over 11,000 uncompressed thumbnails concurrently would exhaust browser heap memory.
//      We downsample out-of-viewport or distant images into lightweight 64px canvas tiles (~16KB each),
//      upgrading to high-resolution assets only when the user zooms in past a crispness threshold.
const LOW_RESOLUTION_TILE_SIZE_PIXELS = 64;
const HIGH_RESOLUTION_SWITCH_THRESHOLD_PIXELS = 72;
const MAXIMUM_HIGH_RESOLUTION_CACHE_ENTRIES = 500;
const MAXIMUM_CONCURRENT_THUMBNAIL_LOADS = 32;

// Memory caches and asynchronous request queue
const low_resolution_tile_cache_by_image_id = new Map();
const high_resolution_image_cache_by_image_id = new Map();
const pending_thumbnail_load_queue = [];
let thumbnail_loads_in_flight_count = 0;

// Interactive cluster filter state and viewport geometry caches
let visible_filtered_points = [];
let rendered_point_hit_boxes = [];
let is_render_frame_scheduled = false;
let show_thumbnails_enabled = true;
let base_thumbnail_size_pixels = 16;
let spatial_spread_multiplier = 2.5;

// ============================================================================
// Initialization Sequence
// ============================================================================
// WHAT: Kickstarts the application lifecycle as soon as the module loads.
// WHY: Automatically begins downloading WebAssembly modules and mounting UI listeners.
initializeScopeVisualizer();

// WHAT: Initializes sidebar controls, sets up display parameters, and loads dataset coordinates from SQLite.
// WHY: Coordinates the initialization sequence and falls back to an error recovery screen on failure.
async function initializeScopeVisualizer() {
  try {
    scope_loading_overlay_element.querySelector("h3").textContent = "Loading Coordinate Data...";

    // ------------------------------------------------------------------------
    // Step 1: Wire Up Sidebar Display and Cluster Controls
    // ------------------------------------------------------------------------
    // WHAT: Configures UI sliders, dropdown toggles, and cluster filter handlers.
    // WHY: Prepares interactive listeners so that user actions respond immediately once data lands.
    const {
        setupDisplayAndClusterFilterControls,
        rebuildClusterFilterList
    } = createScopeClusterSidebarController({
        getAllPoints: () => dataset_coordinate_points_collection,
        getFilteredPoints: () => visible_filtered_points,
        setFilteredPoints: (next_points) => { visible_filtered_points = next_points; },
        getShowThumbnails: () => show_thumbnails_enabled,
        setShowThumbnails: (enabled) => { show_thumbnails_enabled = enabled; },
        setBaseThumbnailSize: (size_px) => { base_thumbnail_size_pixels = size_px; },
        setSpatialSpread: (spread) => { spatial_spread_multiplier = spread; },
        scheduleRender: scheduleVisualizationRenderFrame,
        getActiveContextMenuPoint: () => active_context_menu_point,
        hideContextMenu,
        hideTooltip
    });
    window.__scopeRebuildClusterFilterList = rebuildClusterFilterList;
    setupDisplayAndClusterFilterControls();

    // ------------------------------------------------------------------------
    // Step 2: Fetch Coordinate Data and Render
    // ------------------------------------------------------------------------
    // WHAT: Ingests UMAP coordinate points directly from SQLite images.db.
    // WHY: Provides instant visualization of our local multimodal Python embeddings pipeline.
    await loadDataAndRenderVisualization();

  } catch (scope_initialization_error) {
    // WHAT: Error recovery display explaining initialization failure.
    // WHY: Provides clear diagnostic information and a one-click reload button if loading fails.
    console.error("[Scope Visualizer] Initialization encountered an unhandled error:", scope_initialization_error);
    scope_loading_overlay_element.innerHTML = `
      <h3>Initialization Failed</h3>
      <p id="scopeInitErrorText" style="color: #ff6b6b"></p>
      <p>Check developer console for technical stack trace.</p>
      <button onclick="location.reload()" class="primary-btn">Retry Initialization</button>
    `;
    const scope_init_error_text = document.getElementById('scopeInitErrorText');
    if (scope_init_error_text) {
      scope_init_error_text.textContent = scope_initialization_error?.message || String(scope_initialization_error);
    }
  }
}

// ============================================================================
// Data Ingestion & Normalization Engine
// ============================================================================
// WHAT: Queries coordinates and cluster IDs from the SQLite REST API.
// WHY: Ingests all active image points and normalizes heterogeneous records into a unified structure.
async function loadDataAndRenderVisualization() {
  scope_loading_overlay_element.style.display = "flex";
  scope_loading_overlay_element.querySelector("h3").textContent = "Loading Coordinate Points...";

  // WHAT: Fetches EVoC clustering and UMAP 2D coordinates computed by evoc_pipeline.py from SQLite images.db.
  // WHY: Provides instant visualization of our local multimodal Python embeddings pipeline.
  const sqlite_database_api_response = await fetch('http://localhost:3000/api/scope/db-data');
  if (!sqlite_database_api_response.ok) {
    throw new Error(`Scope DB data request failed with HTTP ${sqlite_database_api_response.status}`);
  }
  const parsed_scope_payload = await sqlite_database_api_response.json();
  const raw_coordinate_records = Array.isArray(parsed_scope_payload) ? parsed_scope_payload : [];

  // WHAT: Type-casts numeric coordinates, identifiers, and cluster IDs to standard JavaScript numbers.
  // WHY: Guarantees numeric primitives without NaN or string values for Canvas transformations.
  dataset_coordinate_points_collection = normalizeCoordinatePointRecords(raw_coordinate_records);

  console.log(`[Scope Visualizer] Successfully ingested ${dataset_coordinate_points_collection.length} coordinate records from SQLite database`);

  // WHAT: Aggregates unique clusters and resets multi-select checkboxes.
  // WHY: Fresh cluster counts and labels are calculated based on the ingested records.
  if (window.__scopeRebuildClusterFilterList) window.__scopeRebuildClusterFilterList();

  if (!is_visualization_initialized) {
    // WHAT: Attaches canvas event listeners on the first data ingestion.
    // WHY: Prevents duplicate event listeners from stacking up across data reloads.
    setupVisualizationCanvasAndInteractions();
    is_visualization_initialized = true;
  } else {
    // WHAT: Updates the mathematical domain boundaries and redraws canvas.
    // WHY: Dynamically fits newly loaded coordinate bounds to the canvas viewport.
    updateScalesAndRenderVisualization();
  }

  scope_loading_overlay_element.style.display = "none";
}

// ============================================================================
// Canvas Setup, Mathematical Scales & User Interactions
// ============================================================================
// WHAT: Sets up D3 linear scales, canvas buffer dimensions, zoom gestures, and mouse event handlers.
// WHY: Bridges abstract mathematical coordinate space (e.g. [-15.2, 45.8]) with physical screen pixels.
function setupVisualizationCanvasAndInteractions() {
  const canvas_client_width_pixels = d3_visualization_canvas_selection.node().clientWidth;
  const canvas_client_height_pixels = d3_visualization_canvas_selection.node().clientHeight;

  // Set physical drawing buffer size to avoid bitmap scaling artifacts
  d3_visualization_canvas_selection.attr("width", canvas_client_width_pixels).attr("height", canvas_client_height_pixels);

  // ------------------------------------------------------------------------
  // Mathematical Scale Computation
  // ------------------------------------------------------------------------
  // WHAT: Calculates the bounding box of all points and adds a 5% margin.
  // WHY: Ensures data points along the outer perimeter do not clip against the canvas edge.
  const horizontal_coordinate_boundary_extent = d3.extent(dataset_coordinate_points_collection, (coordinate_point_record) => coordinate_point_record.x);
  const vertical_coordinate_boundary_extent = d3.extent(dataset_coordinate_points_collection, (coordinate_point_record) => coordinate_point_record.y);

  const horizontal_boundary_padding_margin = (horizontal_coordinate_boundary_extent[1] - horizontal_coordinate_boundary_extent[0]) * 0.05;
  const vertical_boundary_padding_margin = (vertical_coordinate_boundary_extent[1] - vertical_coordinate_boundary_extent[0]) * 0.05;

  d3_horizontal_linear_scale = d3
    .scaleLinear()
    .domain([horizontal_coordinate_boundary_extent[0] - horizontal_boundary_padding_margin, horizontal_coordinate_boundary_extent[1] + horizontal_boundary_padding_margin])
    .range([0, canvas_client_width_pixels]);

  // Invert vertical range because screen coordinate Y=0 is top, whereas mathematical Y increases upwards
  d3_vertical_linear_scale = d3
    .scaleLinear()
    .domain([vertical_coordinate_boundary_extent[0] - vertical_boundary_padding_margin, vertical_coordinate_boundary_extent[1] + vertical_boundary_padding_margin])
    .range([canvas_client_height_pixels, 0]);

  // ------------------------------------------------------------------------
  // Interactive D3 Zoom Handler
  // ------------------------------------------------------------------------
  // WHAT: Binds zoom and pan behaviors with an expanded scale range (0.05x deep zoom out to 100x deep zoom in).
  // WHY: High point density requires extreme zoom-out to perceive global galaxy structure,
  //      and deep zoom-in to inspect individual images and micro-clusters without overlap.
  d3_zoom_behavior_handler = d3
    .zoom()
    .scaleExtent([0.05, 100])
    .on("zoom", (canvas_zoom_event) => {
      d3_canvas_zoom_transform = canvas_zoom_event.transform;
      renderVisualizationFrame(d3_horizontal_linear_scale, d3_vertical_linear_scale);
    });

  d3_visualization_canvas_selection.call(d3_zoom_behavior_handler);

  // Initial canvas paint
  renderVisualizationFrame(d3_horizontal_linear_scale, d3_vertical_linear_scale);

  // ------------------------------------------------------------------------
  // Window Resizing Listener
  // ------------------------------------------------------------------------
  // WHAT: Responds to browser viewport dimension changes by resizing the canvas and recalculating scale ranges.
  // WHY: Keeps visual elements properly proportioned and avoids blurry stretching when the window resizes.
  window.addEventListener("resize", () => {
    const resized_parent_container_width_pixels = d3_visualization_canvas_selection.node().parentNode.clientWidth;
    const resized_parent_container_height_pixels = d3_visualization_canvas_selection.node().parentNode.clientHeight;
    d3_visualization_canvas_selection.attr("width", resized_parent_container_width_pixels).attr("height", resized_parent_container_height_pixels);

    d3_horizontal_linear_scale.range([0, resized_parent_container_width_pixels]);
    d3_vertical_linear_scale.range([resized_parent_container_height_pixels, 0]);

    renderVisualizationFrame(d3_horizontal_linear_scale, d3_vertical_linear_scale);
  });

  // ------------------------------------------------------------------------
  // Mouse Hover Detection (Hit Testing)
  // ------------------------------------------------------------------------
  // WHAT: Detects the uppermost image thumbnail directly beneath the user's cursor.
  // WHY: Thumbnail cards overlap; iterating backwards over the rendered hit-box array
  //      guarantees we highlight the top-most visible element rather than an obscured layer.
  d3_visualization_canvas_selection.on("mousemove", (mouse_movement_event) => {
    const [cursor_pixel_position_x, cursor_pixel_position_y] = d3.pointer(mouse_movement_event);

    let closest_detected_point_under_cursor = null;
    for (let hit_box_index = rendered_point_hit_boxes.length - 1; hit_box_index >= 0; hit_box_index--) {
      const candidate_hit_box = rendered_point_hit_boxes[hit_box_index];
      if (
        cursor_pixel_position_x >= candidate_hit_box.left && cursor_pixel_position_x <= candidate_hit_box.left + candidate_hit_box.size &&
        cursor_pixel_position_y >= candidate_hit_box.top && cursor_pixel_position_y <= candidate_hit_box.top + candidate_hit_box.size
      ) {
        closest_detected_point_under_cursor = candidate_hit_box.point;
        break;
      }
    }

    if (closest_detected_point_under_cursor) {
      showTooltip(closest_detected_point_under_cursor, cursor_pixel_position_x, cursor_pixel_position_y);
    } else {
      hideTooltip();
    }
  });

  // ------------------------------------------------------------------------
  // Left-Click Interactivity
  // ------------------------------------------------------------------------
  // WHAT: Left-clicking an active thumbnail triggers Electron's native file explorer highlight.
  // WHY: Allows the user to jump directly to the original file on their local disk from the visualization.
  d3_visualization_canvas_selection.on("click", () => {
    hideContextMenu();
    if (active_hovered_tooltip_point && window.electronAPI) {
      window.electronAPI.showInFolder(active_hovered_tooltip_point.path);
    }
  });

  // ------------------------------------------------------------------------
  // Right-Click Context Menu
  // ------------------------------------------------------------------------
  // WHAT: Opens a contextual menu over the right-clicked thumbnail offering cluster isolation or hiding.
  // WHY: Streamlines dataset curation by letting users hide noisy clusters directly from the map.
  d3_visualization_canvas_selection.on("contextmenu", (context_menu_pointer_event) => {
    context_menu_pointer_event.preventDefault();
    const [cursor_pixel_position_x, cursor_pixel_position_y] = d3.pointer(context_menu_pointer_event);

    let right_clicked_point_under_cursor = null;
    for (let hit_box_index = rendered_point_hit_boxes.length - 1; hit_box_index >= 0; hit_box_index--) {
      const candidate_hit_box = rendered_point_hit_boxes[hit_box_index];
      if (
        cursor_pixel_position_x >= candidate_hit_box.left && cursor_pixel_position_x <= candidate_hit_box.left + candidate_hit_box.size &&
        cursor_pixel_position_y >= candidate_hit_box.top && cursor_pixel_position_y <= candidate_hit_box.top + candidate_hit_box.size
      ) {
        right_clicked_point_under_cursor = candidate_hit_box.point;
        break;
      }
    }

    if (right_clicked_point_under_cursor) {
      showContextMenu(right_clicked_point_under_cursor, cursor_pixel_position_x, cursor_pixel_position_y);
    } else {
      hideContextMenu();
    }
  });

  // ------------------------------------------------------------------------
  // Zoom & Sync UI Buttons
  // ------------------------------------------------------------------------
  // WHAT: Connects hardware zoom in/out/reset buttons to D3 smooth transition animations.
  // WHY: Offers accessible controls for mouse-wheel-less environments (e.g. trackpads or touchscreens).
  d3.select("#zoomInBtn").on("click", () =>
    d3_visualization_canvas_selection.transition().call(d3_zoom_behavior_handler.scaleBy, 1.2),
  );

  d3.select("#zoomOutBtn").on("click", () =>
    d3_visualization_canvas_selection.transition().call(d3_zoom_behavior_handler.scaleBy, 0.8),
  );

  d3.select("#resetBtn").on("click", () =>
    d3_visualization_canvas_selection.transition().call(d3_zoom_behavior_handler.transform, d3.zoomIdentity),
  );
}

// ============================================================================
// Domain Recalculation & Smooth Reset
// ============================================================================
// WHAT: Recomputes the D3 linear scale domains to frame a freshly ingested dataset.
// WHY: Resets the viewport gracefully via a 750ms D3 transition to prevent abrupt camera jumps.
function updateScalesAndRenderVisualization() {
  const canvas_bounding_width_pixels = d3_visualization_canvas_selection.node().clientWidth;
  const canvas_bounding_height_pixels = d3_visualization_canvas_selection.node().clientHeight;

  d3_visualization_canvas_selection.attr("width", canvas_bounding_width_pixels).attr("height", canvas_bounding_height_pixels);

  if (dataset_coordinate_points_collection.length === 0) {
    canvas_rendering_context_2d.clearRect(0, 0, canvas_bounding_width_pixels, canvas_bounding_height_pixels);
    return;
  }

  const horizontal_coordinate_boundary_extent = d3.extent(dataset_coordinate_points_collection, (coordinate_point_record) => coordinate_point_record.x);
  const vertical_coordinate_boundary_extent = d3.extent(dataset_coordinate_points_collection, (coordinate_point_record) => coordinate_point_record.y);

  const horizontal_boundary_padding_margin = (horizontal_coordinate_boundary_extent[1] - horizontal_coordinate_boundary_extent[0]) * 0.05;
  const vertical_boundary_padding_margin = (vertical_coordinate_boundary_extent[1] - vertical_coordinate_boundary_extent[0]) * 0.05;

  d3_horizontal_linear_scale.domain([horizontal_coordinate_boundary_extent[0] - horizontal_boundary_padding_margin, horizontal_coordinate_boundary_extent[1] + horizontal_boundary_padding_margin]).range([0, canvas_bounding_width_pixels]);
  d3_vertical_linear_scale.domain([vertical_coordinate_boundary_extent[0] - vertical_boundary_padding_margin, vertical_coordinate_boundary_extent[1] + vertical_boundary_padding_margin]).range([canvas_bounding_height_pixels, 0]);

  d3_visualization_canvas_selection.transition().duration(750).call(d3_zoom_behavior_handler.transform, d3.zoomIdentity);
}

// ============================================================================
// Render Frame Scheduler (RAF Debouncer)
// ============================================================================
// WHAT: Coalesces multiple asynchronous thumbnail load events into a single requestAnimationFrame callback.
// WHY: As dozens of image tiles resolve concurrently, redrawing 11,000 items on every single image load
//      would choke the main thread; synchronizing to 60fps delivers butter-smooth 16.6ms frame budgets.
function scheduleVisualizationRenderFrame() {
  if (is_render_frame_scheduled) return;
  is_render_frame_scheduled = true;
  requestAnimationFrame(() => {
    is_render_frame_scheduled = false;
    renderVisualizationFrame(d3_horizontal_linear_scale, d3_vertical_linear_scale);
  });
}

// ============================================================================
// Core Frame Renderer (Viewport Culling & Canvas Drawing)
// ============================================================================
// WHAT: Draws the visible filtered points as either geometric dots or square thumbnails with cluster outlines.
// WHY: High-performance 2D canvas drawing with viewport culling ensures fluid 60 FPS even with 11k+ items.
function renderVisualizationFrame(horizontal_scale_function, vertical_scale_function) {
  if (!horizontal_scale_function || !vertical_scale_function) return;

  const canvas_width_pixels = Number(d3_visualization_canvas_selection.attr("width"));
  const canvas_height_pixels = Number(d3_visualization_canvas_selection.attr("height"));

  // Clear previous frame
  canvas_rendering_context_2d.clearRect(0, 0, canvas_width_pixels, canvas_height_pixels);

  // WHAT: Dynamic thumbnail sizing using square-root scaling based on current zoom magnification.
  // WHY: Scaling thumbnail size by sqrt(zoom) allows images to grow as you zoom in without expanding
  //      as fast as physical distance between points, allowing crowded clusters to visually separate cleanly.
  const {
    onScreenSizePixels: on_screen_thumbnail_size_pixels,
    halfSizePixels: half_thumbnail_size_pixels,
    outlineWidthPixels: outline_width_pixels,
    wantsHighResolutionImages: wants_high_resolution_images
  } = computeThumbnailFrameMetrics(base_thumbnail_size_pixels, d3_canvas_zoom_transform.k, HIGH_RESOLUTION_SWITCH_THRESHOLD_PIXELS);

  const next_frame_hit_boxes = [];
  const canvas_half_width_pixels = canvas_width_pixels / 2;
  const canvas_half_height_pixels = canvas_height_pixels / 2;

  for (const current_point_record of visible_filtered_points) {
    // WHAT: Projects data coordinates, applies radial spatial dispersion from canvas center, and applies pan/zoom.
    // WHY: Expanding points outward from the screen center alleviates thumbnail crowding in dense clusters.
    const base_unzoomed_horizontal_pixel_position = horizontal_scale_function(current_point_record.x);
    const base_unzoomed_vertical_pixel_position = vertical_scale_function(current_point_record.y);

    const spread_adjusted_horizontal_coordinate = canvas_half_width_pixels + (base_unzoomed_horizontal_pixel_position - canvas_half_width_pixels) * spatial_spread_multiplier;
    const spread_adjusted_vertical_coordinate = canvas_half_height_pixels + (base_unzoomed_vertical_pixel_position - canvas_half_height_pixels) * spatial_spread_multiplier;

    const screen_projected_center_x = d3_canvas_zoom_transform.applyX(spread_adjusted_horizontal_coordinate);
    const screen_projected_center_y = d3_canvas_zoom_transform.applyY(spread_adjusted_vertical_coordinate);
    const cluster_assigned_colour = getClusterColour(current_point_record.cluster);

    if (!show_thumbnails_enabled) {
      // WHAT: Simplified high-speed dot rendering mode.
      // WHY: Ideal for high-level macroscopic inspection of cluster structures with minimum GPU workload.
      if (screen_projected_center_x < -4 || screen_projected_center_y < -4 || screen_projected_center_x > canvas_width_pixels + 4 || screen_projected_center_y > canvas_height_pixels + 4) {
        continue;
      }
      canvas_rendering_context_2d.beginPath();
      canvas_rendering_context_2d.arc(screen_projected_center_x, screen_projected_center_y, 3, 0, 2 * Math.PI);
      canvas_rendering_context_2d.fillStyle = cluster_assigned_colour;
      canvas_rendering_context_2d.fill();
      next_frame_hit_boxes.push({ point: current_point_record, left: screen_projected_center_x - 6, top: screen_projected_center_y - 6, size: 12 });
      continue;
    }

    const thumbnail_bounding_left_pixels = screen_projected_center_x - half_thumbnail_size_pixels;
    const thumbnail_bounding_top_pixels = screen_projected_center_y - half_thumbnail_size_pixels;

    // WHAT: Viewport frustum culling.
    // WHY: Skipping images outside the visible viewport prevents wasted GPU texture draws and decoding.
    if (
      thumbnail_bounding_left_pixels > canvas_width_pixels || thumbnail_bounding_top_pixels > canvas_height_pixels ||
      thumbnail_bounding_left_pixels + on_screen_thumbnail_size_pixels < 0 || thumbnail_bounding_top_pixels + on_screen_thumbnail_size_pixels < 0
    ) {
      continue;
    }

    // WHAT: Retrieves cached image representation (high-resolution image or low-resolution canvas tile).
    // WHY: Provides instant visual representation without stalling the browser pipeline.
    let drawable_image_source_element = null;
    if (wants_high_resolution_images) {
      const high_resolution_cache_entry = requestHighResolutionImage(current_point_record.id);
      if (high_resolution_cache_entry.status === "loaded") {
        drawable_image_source_element = high_resolution_cache_entry.image;
      }
    }
    if (!drawable_image_source_element) {
      const low_resolution_cache_entry = requestLowResolutionTile(current_point_record.id);
      if (low_resolution_cache_entry.status === "loaded") {
        drawable_image_source_element = low_resolution_cache_entry.tile_canvas;
      }
    }

    if (drawable_image_source_element) {
      drawCoverCroppedImage(drawable_image_source_element, thumbnail_bounding_left_pixels, thumbnail_bounding_top_pixels, on_screen_thumbnail_size_pixels);
    } else {
      // Semi-transparent cluster-tinted placeholder rectangle while thumbnail is loading
      canvas_rendering_context_2d.globalAlpha = 0.35;
      canvas_rendering_context_2d.fillStyle = cluster_assigned_colour;
      canvas_rendering_context_2d.fillRect(thumbnail_bounding_left_pixels, thumbnail_bounding_top_pixels, on_screen_thumbnail_size_pixels, on_screen_thumbnail_size_pixels);
      canvas_rendering_context_2d.globalAlpha = 1;
    }

    // WHAT: Vibrant border stroke tinted with the EVoC cluster colour.
    // WHY: Preserves visual clustering identity even when displaying diverse image content.
    canvas_rendering_context_2d.lineWidth = outline_width_pixels;
    canvas_rendering_context_2d.strokeStyle = cluster_assigned_colour;
    canvas_rendering_context_2d.strokeRect(thumbnail_bounding_left_pixels, thumbnail_bounding_top_pixels, on_screen_thumbnail_size_pixels, on_screen_thumbnail_size_pixels);

    next_frame_hit_boxes.push({
      point: current_point_record,
      left: thumbnail_bounding_left_pixels,
      top: thumbnail_bounding_top_pixels,
      size: on_screen_thumbnail_size_pixels,
    });
  }

  rendered_point_hit_boxes = next_frame_hit_boxes;
}

// ============================================================================
// Aspect Ratio Cropping Engine (Cover Mode)
// ============================================================================
// WHAT: Draws the center-cropped square from an arbitrary aspect ratio image into a target square.
// WHY: Arbitrary photography dimensions would stretch or distort; square cover cropping preserves
//      composition aesthetics and ensures neat visual alignment across the entire map.
function drawCoverCroppedImage(image_source_element, destination_canvas_left_offset_pixels, destination_canvas_top_offset_pixels, destination_bounding_box_dimension_pixels) {
  const source_image_width_pixels = image_source_element.naturalWidth || image_source_element.width;
  const source_image_height_pixels = image_source_element.naturalHeight || image_source_element.height;
  const crop_metrics = computeSquareCoverCropMetrics(source_image_width_pixels, source_image_height_pixels);
  if (!crop_metrics) return;

  canvas_rendering_context_2d.drawImage(
    image_source_element,
    crop_metrics.cropOffsetHorizontalPixels,
    crop_metrics.cropOffsetVerticalPixels,
    crop_metrics.squareCropSideLengthPixels,
    crop_metrics.squareCropSideLengthPixels,
    destination_canvas_left_offset_pixels,
    destination_canvas_top_offset_pixels,
    destination_bounding_box_dimension_pixels,
    destination_bounding_box_dimension_pixels
  );
}

// ============================================================================
// Multi-Tier Caching & Asynchronous Queue Dispatcher
// ============================================================================
// WHAT: Fetches low-resolution 64px square tiles and high-resolution images asynchronously with LRU eviction.
// WHY: Throttling concurrent downloads avoids saturating the HTTP server while delivering maximum rendering smoothness.

function requestLowResolutionTile(image_identifier) {
  let low_resolution_cache_entry = low_resolution_tile_cache_by_image_id.get(image_identifier);
  if (!low_resolution_cache_entry) {
    low_resolution_cache_entry = { status: "queued", tile_canvas: null };
    low_resolution_tile_cache_by_image_id.set(image_identifier, low_resolution_cache_entry);
    pending_thumbnail_load_queue.push({ image_identifier, resolution_tier: "low" });
    pumpThumbnailLoadQueue();
  }
  return low_resolution_cache_entry;
}

// WHAT: Enqueues a high-resolution thumbnail fetch with Least-Recently-Used (LRU) cache eviction.
// WHY: Caps memory consumption at `MAXIMUM_HIGH_RESOLUTION_CACHE_ENTRIES` while keeping zoomed-in images crisp.
function requestHighResolutionImage(image_identifier) {
  let high_resolution_cache_entry = high_resolution_image_cache_by_image_id.get(image_identifier);
  if (high_resolution_cache_entry) {
    // Refresh position in Map to designate as most recently used (LRU)
    high_resolution_image_cache_by_image_id.delete(image_identifier);
    high_resolution_image_cache_by_image_id.set(image_identifier, high_resolution_cache_entry);
    return high_resolution_cache_entry;
  }

  high_resolution_cache_entry = { status: "queued", image: null };
  high_resolution_image_cache_by_image_id.set(image_identifier, high_resolution_cache_entry);
  pending_thumbnail_load_queue.push({ image_identifier, resolution_tier: "high" });

  // Evict least recently used entries if cache exceeds boundary
  while (high_resolution_image_cache_by_image_id.size > MAXIMUM_HIGH_RESOLUTION_CACHE_ENTRIES) {
    const least_recently_used_identifier = high_resolution_image_cache_by_image_id.keys().next().value;
    high_resolution_image_cache_by_image_id.delete(least_recently_used_identifier);
  }

  pumpThumbnailLoadQueue();
  return high_resolution_cache_entry;
}

function pumpThumbnailLoadQueue() {
  while (thumbnail_loads_in_flight_count < MAXIMUM_CONCURRENT_THUMBNAIL_LOADS && pending_thumbnail_load_queue.length > 0) {
    // WHAT: LIFO queue popping (fetching from the end of array).
    // WHY: Images queued most recently correspond to where the user's camera currently sits,
    //      ensuring the active viewport receives highest download priority over previously scrolled regions.
    const next_load_request = pending_thumbnail_load_queue.pop();
    const is_high_resolution_request = next_load_request.resolution_tier === "high";
    const target_cache_entry = is_high_resolution_request
      ? high_resolution_image_cache_by_image_id.get(next_load_request.image_identifier)
      : low_resolution_tile_cache_by_image_id.get(next_load_request.image_identifier);

    if (!target_cache_entry || target_cache_entry.status !== "queued") continue;

    target_cache_entry.status = "loading";
    thumbnail_loads_in_flight_count++;

    const thumbnail_image_element = new Image();
    thumbnail_image_element.decoding = "async";

    thumbnail_image_element.onload = () => {
      thumbnail_loads_in_flight_count--;
      if (is_high_resolution_request) {
        target_cache_entry.image = thumbnail_image_element;
      } else {
        // WHAT: Downsamples full thumbnail into an offscreen 64px square canvas and discards large image element.
        // WHY: Releasing the full bitmap from memory allows retaining 11,000 low-res tiles indefinitely with minimal RAM.
        const offscreen_tile_canvas_element = document.createElement("canvas");
        offscreen_tile_canvas_element.width = LOW_RESOLUTION_TILE_SIZE_PIXELS;
        offscreen_tile_canvas_element.height = LOW_RESOLUTION_TILE_SIZE_PIXELS;
        const offscreen_tile_drawing_context = offscreen_tile_canvas_element.getContext("2d");
        const square_crop_side_length_pixels = Math.min(thumbnail_image_element.naturalWidth, thumbnail_image_element.naturalHeight);
        offscreen_tile_drawing_context.drawImage(
          thumbnail_image_element,
          (thumbnail_image_element.naturalWidth - square_crop_side_length_pixels) / 2,
          (thumbnail_image_element.naturalHeight - square_crop_side_length_pixels) / 2,
          square_crop_side_length_pixels, square_crop_side_length_pixels,
          0, 0, LOW_RESOLUTION_TILE_SIZE_PIXELS, LOW_RESOLUTION_TILE_SIZE_PIXELS
        );
        target_cache_entry.tile_canvas = offscreen_tile_canvas_element;
      }

      target_cache_entry.status = "loaded";
      scheduleVisualizationRenderFrame();
      pumpThumbnailLoadQueue();
    };

    thumbnail_image_element.onerror = () => {
      // WHAT: Sets failed status and drains the queue.
      // WHY: Missing files gracefully remain as cluster-coloured placeholder squares without infinite retry loops.
      thumbnail_loads_in_flight_count--;
      target_cache_entry.status = "failed";
      pumpThumbnailLoadQueue();
    };

    thumbnail_image_element.src = `thumbnails/id_${next_load_request.image_identifier}.avif`;
  }
}

// ============================================================================
// Tooltip Presentation Logic
// ============================================================================
// WHAT: Positions and updates the hover card displaying filename, cluster theme, and thumbnail preview.
// WHY: Provides immediate semantic context when hovering over data clusters.
function showTooltip(hovered_coordinate_point_record, cursor_pixel_position_x, cursor_pixel_position_y) {
  const tooltip_container_element = document.getElementById("vizTooltip");
  const tooltip_image_element = document.getElementById("tooltipImg");
  const tooltip_text_container_element = document.getElementById("tooltipText");

  const cluster_theme_display_text = hovered_coordinate_point_record.label
    ? `🏷️ ${hovered_coordinate_point_record.label.replace(/_/g, ' ')}`
    : `Cluster ${hovered_coordinate_point_record.cluster}`;

  const theme_label_div = document.createElement("div");
  theme_label_div.style.cssText = "font-weight: 600; color: #c084fc; margin-bottom: 2px;";
  theme_label_div.textContent = cluster_theme_display_text;

  const filename_label_div = document.createElement("div");
  filename_label_div.style.cssText = "font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;";
  filename_label_div.textContent = String(hovered_coordinate_point_record.filename || "");

  tooltip_text_container_element.replaceChildren(theme_label_div, filename_label_div);

  tooltip_image_element.src = `thumbnails/id_${hovered_coordinate_point_record.id}.avif`;
  tooltip_container_element.style.display = "flex";

  const tooltip_bounding_client_rect = tooltip_container_element.getBoundingClientRect();
  const visualization_canvas_element = document.getElementById("vizCanvas");
  const canvas_client_width_pixels = visualization_canvas_element.clientWidth;
  const canvas_client_height_pixels = visualization_canvas_element.clientHeight;

  // WHAT: Calculates tooltip position with boundary collision detection and automatic inversion.
  // WHY: Prevents the tooltip from clipping outside the right or bottom canvas boundaries.
  let tooltip_computed_left_pixel_position = cursor_pixel_position_x + 16;
  let tooltip_computed_top_pixel_position = cursor_pixel_position_y + 16;

  if (tooltip_computed_left_pixel_position + tooltip_bounding_client_rect.width > canvas_client_width_pixels) {
    tooltip_computed_left_pixel_position = Math.max(10, cursor_pixel_position_x - tooltip_bounding_client_rect.width - 16);
  }

  if (tooltip_computed_top_pixel_position + tooltip_bounding_client_rect.height > canvas_client_height_pixels) {
    tooltip_computed_top_pixel_position = Math.max(10, cursor_pixel_position_y - tooltip_bounding_client_rect.height - 16);
  }

  tooltip_container_element.style.left = tooltip_computed_left_pixel_position + "px";
  tooltip_container_element.style.top = tooltip_computed_top_pixel_position + "px";

  active_hovered_tooltip_point = hovered_coordinate_point_record;
  d3_visualization_canvas_selection.node().style.cursor = "pointer";
}

// WHAT: Hides the hover tooltip and restores the default canvas grab cursor.
// WHY: Clears hover state immediately when the pointer leaves all rendered hit boxes.
function hideTooltip() {
  document.getElementById("vizTooltip").style.display = "none";
  active_hovered_tooltip_point = null;
  d3_visualization_canvas_selection.node().style.cursor = "grab";
}

// ============================================================================
// Context Menu Presentation Logic
// ============================================================================
// WHAT: Mounts the custom right-click context menu offering cluster filtering and file opening actions.
// WHY: Desktop users expect contextual actions right at their cursor position without searching top menus.
let active_context_menu_point = null;

function showContextMenu(clicked_coordinate_point_record, cursor_pixel_position_x, cursor_pixel_position_y) {
  active_context_menu_point = clicked_coordinate_point_record;
  const context_menu_element = document.getElementById("scopeContextMenu");
  const context_menu_header = document.getElementById("contextMenuHeader");

  const cluster_label_display = clicked_coordinate_point_record.label
    ? `🏷️ ${clicked_coordinate_point_record.label.replace(/_/g, ' ')}`
    : `Cluster ${clicked_coordinate_point_record.cluster}`;
  context_menu_header.textContent = cluster_label_display;

  context_menu_element.style.display = "flex";

  const visualization_canvas_element = document.getElementById("vizCanvas");
  const canvas_client_width_pixels = visualization_canvas_element.clientWidth;
  const canvas_client_height_pixels = visualization_canvas_element.clientHeight;
  const context_menu_bounding_rect = context_menu_element.getBoundingClientRect();

  let context_menu_left_pixel_position = cursor_pixel_position_x + 4;
  let context_menu_top_pixel_position = cursor_pixel_position_y + 4;

  if (context_menu_left_pixel_position + context_menu_bounding_rect.width > canvas_client_width_pixels) {
    context_menu_left_pixel_position = Math.max(10, cursor_pixel_position_x - context_menu_bounding_rect.width - 4);
  }
  if (context_menu_top_pixel_position + context_menu_bounding_rect.height > canvas_client_height_pixels) {
    context_menu_top_pixel_position = Math.max(10, cursor_pixel_position_y - context_menu_bounding_rect.height - 4);
  }

  context_menu_element.style.left = context_menu_left_pixel_position + "px";
  context_menu_element.style.top = context_menu_top_pixel_position + "px";
}

// WHAT: Dismisses the custom right-click context menu and clears its active point reference.
// WHY: Ensures stale context menu state does not linger after an action, outside click, or Escape key press.
function hideContextMenu() {
  const context_menu_element = document.getElementById("scopeContextMenu");
  if (context_menu_element) {
    context_menu_element.style.display = "none";
  }
  active_context_menu_point = null;
}

// ============================================================================
// Cluster Filter Dropdown & Display Controls