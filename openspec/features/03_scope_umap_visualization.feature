@domain @scope @visualization
Feature: Scope Map Multimodal UMAP and DuckDB Analytics Visualization
  As an exploratory data researcher
  I want to interactively inspect high-dimensional image clusters projected into 2D space
  So that visual dataset patterns, style clusters, and anomalies are visible at a glance

  Background:
    Given local WebAssembly binary assets are available for the `duckdb_wasm_bridge`
    And a visual dataset contains projected UMAP 2D coordinates and cluster assignments

  Rule: DuckDB WebAssembly ingests local columnar files without external network calls

    @SCOPE-01
    Scenario: DuckDB WebAssembly registers local Parquet file buffer into virtual memory
      Given a binary buffer representing the image embeddings Parquet dataset
      When the `duckdb_wasm_bridge` registers the file in DuckDB virtual storage
      Then analytical SQL queries execute directly against the columnar tables
      And no outbound HTTP network traffic is generated

  Rule: Canvas coordinate transformations deterministically project data bounds to pixel space

    @SCOPE-02
    Scenario: Mathematical transformation maps normalized 2D data points to viewport coordinates
      Given a bounding domain of normalized coordinates spanning -10.0 to +10.0
      When the coordinate projection maps a point to a canvas with 1920 by 1080 resolution
      Then screen pixel coordinates are calculated deterministically via linear scaling
      And input dataset point collections remain immutable throughout the render cycle

    @SCOPE-03
    Scenario Outline: Viewport coordinate projection under zooming transformations
      Given a normalized data coordinate pair <data_x> and <data_y>
      When applying a zoom scale transformation factor of <zoom_scale>
      Then transformed canvas pixels fall within expected screen boundaries <pixel_boundary>
      And canvas redraw maintains constant memory allocation

      Examples:
        | data_x | data_y | zoom_scale | pixel_boundary |
        | 0.0    | 0.0    | 1.0        | "center_canvas"|
        | -5.0   | -5.0   | 2.0        | "upper_quadrant"|
        | 5.0    | 5.0    | 0.5        | "lower_quadrant"|

