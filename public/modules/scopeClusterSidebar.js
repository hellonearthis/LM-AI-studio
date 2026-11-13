/**
 * Scope Cluster Filter & Display Controls Sidebar Controller
 *
 * Isolated UI controller extracted from public/scope.js.
 */

import {
    getClusterColour,
    buildClusterSummaryCatalog,
    filterClusterSummariesBySearch,
    filterPointsBySelectedClusters,
    formatClusterFilterSummaryText,
    formatPointCountDisplayText
} from "./scopeCore.js";

// WHAT: Creates the sidebar controller managing cluster filtering, search, and canvas display sliders.
// WHY: Keeps D3/Canvas rendering in scope.js focused on WebGL/2D drawing and zoom math.
export function createScopeClusterSidebarController({
    getAllPoints,
    getFilteredPoints,
    setFilteredPoints,
    getShowThumbnails,
    setShowThumbnails,
    setBaseThumbnailSize,
    setSpatialSpread,
    scheduleRender,
    getActiveContextMenuPoint,
    hideContextMenu,
    hideTooltip
}) {
    let selected_cluster_identifiers = new Set();
    let cluster_summary_collection = [];

    // ============================================================================
    // WHAT: Configures UI slider controls, search-filtered multi-select checkboxes, and context actions.
    // WHY: Gives the user precise control over thumbnail size, spatial dispersion, and cluster isolation.
    function setupDisplayAndClusterFilterControls() {
      const show_thumbnails_checkbox = document.getElementById("showThumbnailsCheckbox");
      const thumbnail_size_slider = document.getElementById("thumbnailSizeSlider");
      const cluster_filter_button = document.getElementById("clusterFilterButton");
      const cluster_filter_panel = document.getElementById("clusterFilterPanel");
      const cluster_filter_dropdown = document.getElementById("clusterFilterDropdown");
      const cluster_filter_search_input = document.getElementById("clusterFilterSearchInput");
      const spatial_spacing_slider = document.getElementById("spatialSpacingSlider");

      show_thumbnails_checkbox.addEventListener("change", () => {
        setShowThumbnails(show_thumbnails_checkbox.checked);
        thumbnail_size_slider.disabled = !getShowThumbnails();
        scheduleRender();
      });

      thumbnail_size_slider.addEventListener("input", () => {
        setBaseThumbnailSize(Number(thumbnail_size_slider.value));
        scheduleRender();
      });

      if (spatial_spacing_slider) {
        spatial_spacing_slider.addEventListener("input", () => {
          setSpatialSpread(Number(spatial_spacing_slider.value));
          scheduleRender();
        });
      }

      // Open / close the cluster selection panel
      cluster_filter_button.addEventListener("click", (button_click_event) => {
        button_click_event.stopPropagation();
        const should_open_filter_panel = cluster_filter_panel.hidden;
        cluster_filter_panel.hidden = !should_open_filter_panel;
        cluster_filter_button.setAttribute("aria-expanded", String(should_open_filter_panel));
        if (should_open_filter_panel) cluster_filter_search_input.focus();
      });

      // Close dropdown panel upon clicking outside or pressing Escape
      document.addEventListener("click", (document_click_event) => {
        if (!cluster_filter_dropdown.contains(document_click_event.target)) {
          cluster_filter_panel.hidden = true;
          cluster_filter_button.setAttribute("aria-expanded", "false");
        }
      });

      document.addEventListener("keydown", (keyboard_event) => {
        if (keyboard_event.key === "Escape") {
          cluster_filter_panel.hidden = true;
          cluster_filter_button.setAttribute("aria-expanded", "false");
        }
      });

      // WHAT: Select All / Select None operate strictly on currently filtered rows.
      // WHY: When searching (e.g. for "landscape"), users can batch-select or batch-deselect just the search matches.
      document.getElementById("clusterSelectAllButton").addEventListener("click", () => {
        for (const listed_cluster_entry of getClustersMatchingSearch()) {
          selected_cluster_identifiers.add(listed_cluster_entry.cluster_identifier);
        }
        renderClusterFilterRows();
        applyClusterFilter();
      });

      document.getElementById("clusterSelectNoneButton").addEventListener("click", () => {
        for (const listed_cluster_entry of getClustersMatchingSearch()) {
          selected_cluster_identifiers.delete(listed_cluster_entry.cluster_identifier);
        }
        renderClusterFilterRows();
        applyClusterFilter();
      });

      cluster_filter_search_input.addEventListener("input", renderClusterFilterRows);

      // ------------------------------------------------------------------------
      // Context Menu Action Listeners
      // ------------------------------------------------------------------------
      const context_menu_hide_cluster_button = document.getElementById("contextMenuHideClusterBtn");
      const context_menu_isolate_cluster_button = document.getElementById("contextMenuIsolateClusterBtn");
      const context_menu_open_file_button = document.getElementById("contextMenuOpenFileBtn");

      if (context_menu_hide_cluster_button) {
        context_menu_hide_cluster_button.addEventListener("click", () => {
          const current_context_menu_point = getActiveContextMenuPoint();
          if (current_context_menu_point) {
            selected_cluster_identifiers.delete(current_context_menu_point.cluster);
            renderClusterFilterRows();
            applyClusterFilter();
          }
          hideContextMenu();
        });
      }

      if (context_menu_isolate_cluster_button) {
        context_menu_isolate_cluster_button.addEventListener("click", () => {
          const current_context_menu_point = getActiveContextMenuPoint();
          if (current_context_menu_point) {
            selected_cluster_identifiers.clear();
            selected_cluster_identifiers.add(current_context_menu_point.cluster);
            renderClusterFilterRows();
            applyClusterFilter();
          }
          hideContextMenu();
        });
      }

      if (context_menu_open_file_button) {
        context_menu_open_file_button.addEventListener("click", () => {
          const current_context_menu_point = getActiveContextMenuPoint();
          if (current_context_menu_point && window.electronAPI) {
            window.electronAPI.showInFolder(current_context_menu_point.path);
          }
          hideContextMenu();
        });
      }

      // Dismiss context menu upon outside click or Escape
      document.addEventListener("click", (document_click_event) => {
        const context_menu_element = document.getElementById("scopeContextMenu");
        if (context_menu_element && !context_menu_element.contains(document_click_event.target)) {
          hideContextMenu();
        }
      });

      document.addEventListener("keydown", (keyboard_event) => {
        if (keyboard_event.key === "Escape") {
          hideContextMenu();
        }
      });
    }

    // ============================================================================
    // Cluster Aggregation & Multi-Select Filter List
    // ============================================================================
    // WHAT: Groups points by cluster ID, computes image counts, sorts by frequency, and selects all.
    // WHY: Sorting by image count surfaces large thematic clusters first for intuitive exploration.
    function rebuildClusterFilterList() {
      cluster_summary_collection = buildClusterSummaryCatalog(getAllPoints());
      selected_cluster_identifiers = new Set(cluster_summary_collection.map((cluster_entry) => cluster_entry.cluster_identifier));

      document.getElementById("clusterFilterSearchInput").value = "";
      renderClusterFilterRows();
      applyClusterFilter();
    }

    // WHAT: Filters `cluster_summary_collection` against the user's search input by label or cluster ID.
    // WHY: Allows users to quickly isolate thematic clusters across 260+ EVoC groups.
    function getClustersMatchingSearch() {
      return filterClusterSummariesBySearch(
        cluster_summary_collection,
        document.getElementById("clusterFilterSearchInput").value
      );
    }

    // WHAT: Renders the checkbox rows inside the cluster filter dropdown using a DocumentFragment.
    // WHY: Batching DOM insertion via DocumentFragment prevents layout thrashing when rendering 260+ cluster rows.
    function renderClusterFilterRows() {
      const cluster_filter_list_element = document.getElementById("clusterFilterList");
      const rows_document_fragment = document.createDocumentFragment();

      for (const cluster_entry of getClustersMatchingSearch()) {
        const row_label_element = document.createElement("label");
        row_label_element.className = "cluster-filter-row";
        row_label_element.title = `Cluster ${cluster_entry.cluster_identifier}`;

        const row_checkbox_element = document.createElement("input");
        row_checkbox_element.type = "checkbox";
        row_checkbox_element.checked = selected_cluster_identifiers.has(cluster_entry.cluster_identifier);
        row_checkbox_element.addEventListener("change", () => {
          if (row_checkbox_element.checked) {
            selected_cluster_identifiers.add(cluster_entry.cluster_identifier);
          } else {
            selected_cluster_identifiers.delete(cluster_entry.cluster_identifier);
          }
          applyClusterFilter();
        });

        const colour_swatch_element = document.createElement("span");
        colour_swatch_element.className = "cluster-colour-swatch";
        colour_swatch_element.style.background = getClusterColour(cluster_entry.cluster_identifier);

        const label_text_element = document.createElement("span");
        label_text_element.className = "cluster-row-label";
        label_text_element.textContent = cluster_entry.display_label;

        const count_text_element = document.createElement("span");
        count_text_element.className = "cluster-row-count";
        count_text_element.textContent = cluster_entry.image_count.toLocaleString();

        row_label_element.append(row_checkbox_element, colour_swatch_element, label_text_element, count_text_element);
        rows_document_fragment.appendChild(row_label_element);
      }

      cluster_filter_list_element.replaceChildren(rows_document_fragment);
    }

    // WHAT: Filters visible points against the selected cluster Set, updates item counts, and triggers redraw.
    // WHY: Mathematical scale domains remain constant so visible images stay spatially pinned during filtering.
    function applyClusterFilter() {
      setFilteredPoints(filterPointsBySelectedClusters(
        getAllPoints(),
        selected_cluster_identifiers
      ));

      const total_cluster_count = cluster_summary_collection.length;
      const selected_cluster_count = cluster_summary_collection.filter((cluster_entry) =>
        selected_cluster_identifiers.has(cluster_entry.cluster_identifier)
      ).length;

      document.getElementById("clusterFilterSummary").textContent = formatClusterFilterSummaryText(
        total_cluster_count,
        selected_cluster_count
      );

      const point_count_display_element = document.getElementById("pointCountDisplay");
      if (point_count_display_element) {
        point_count_display_element.textContent = formatPointCountDisplayText(
          getFilteredPoints().length,
          getAllPoints().length
        );
      }

      hideTooltip();
      scheduleRender();
    }


    return {
        setupDisplayAndClusterFilterControls,
        rebuildClusterFilterList
    };
}
