// D3 is loaded as UMD, so it attaches to window.d3
import "d3";
const d3 = window.d3;
import * as duckdb from "@duckdb/duckdb-wasm";

// Configuration
// Define bundles manually to point to local files relative to scope.html
const MANUAL_BUNDLES = {
  mvp: {
    mainModule: "/libs/duckdb/duckdb-mvp.wasm",
    mainWorker: "/libs/duckdb/duckdb-browser-mvp.worker.js",
  },
  eh: {
    mainModule: "/libs/duckdb/duckdb-eh.wasm",
    mainWorker: "/libs/duckdb/duckdb-browser-eh.worker.js",
  },
};

// State
let db = null;
let points = [];
let transform = d3.zoomIdentity;
let currentTooltip = null;

// DOM Elements
const canvas = d3.select("#vizCanvas");
const context = canvas.node().getContext("2d");
const overlay = document.getElementById("scopeOverlay");

// Colors
const colorScale = d3.scaleOrdinal(d3.schemeTableau10);

// Initialize
init();

let currentDataSource = 'parquet';
let isVizSetup = false;

// We declare these globally so they can be updated dynamically when the data source changes
let xScale, yScale, zoom;

async function init() {
  try {
    overlay.querySelector("h3").textContent = "Initializing Database...";

    // ==========================================
    // 1. DuckDB WebAssembly Setup
    // ==========================================
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    console.log("[Viz] Using bundle:", bundle);

    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // ==========================================
    // 2. Load DuckDB Parquet Files
    // ==========================================
    overlay.querySelector("h3").textContent = "Loading Parquet Files...";
    const BASE_URL = "http://localhost:3000";
    await db.registerFileURL("input.parquet", `${BASE_URL}/ls-data/input/input.parquet`, duckdb.DuckDBDataProtocol.HTTP, false);
    await db.registerFileURL("scopes.parquet", `${BASE_URL}/ls-data/input/scopes/scopes-001.parquet`, duckdb.DuckDBDataProtocol.HTTP, false);

    // Initial Load
    await loadDataAndRender('parquet');

    // ==========================================
    // 3. Setup UI Toggle Listeners
    // ==========================================
    const toggleParquetBtn = document.getElementById('toggleParquetBtn');
    const toggleDbBtn = document.getElementById('toggleDbBtn');

    toggleParquetBtn.addEventListener('click', () => {
        if (currentDataSource === 'parquet') return;
        toggleParquetBtn.style.background = 'var(--accent)';
        toggleParquetBtn.style.color = 'white';
        toggleDbBtn.style.background = 'transparent';
        toggleDbBtn.style.color = 'var(--text-primary)';
        loadDataAndRender('parquet');
    });

    toggleDbBtn.addEventListener('click', () => {
        if (currentDataSource === 'db') return;
        toggleDbBtn.style.background = 'var(--accent)';
        toggleDbBtn.style.color = 'white';
        toggleParquetBtn.style.background = 'transparent';
        toggleParquetBtn.style.color = 'var(--text-primary)';
        loadDataAndRender('db');
    });

  } catch (err) {
    console.error(err);
    overlay.innerHTML = `
            <h3>Initialization Failed</h3>
            <p style="color: #ff6b6b">${err.message}</p>
            <p>Check console for details.</p>
            <button onclick="location.reload()" class="primary-btn">Retry</button>
        `;
  }
}

async function loadDataAndRender(source) {
    currentDataSource = source;
    overlay.style.display = "flex";
    overlay.querySelector("h3").textContent = "Loading Data Points...";

    if (source === 'parquet') {
        const conn = await db.connect();
        const query = `
            SELECT 
                s.x, s.y, s.cluster, s.label,
                i.path, i.filename, i.id
            FROM 'scopes.parquet' s
            JOIN 'input.parquet' i ON s.ls_index = i.id
            WHERE s.deleted = false
        `;
        const result = await conn.query(query);
        await conn.close();
        points = result.toArray().map((row) => row.toJSON());
    } else if (source === 'db') {
        const response = await fetch('http://localhost:3000/api/scope/db-data');
        points = await response.json();
    }

    console.log(`[Viz] Loaded ${points.length} points from ${source}`);
    
    // Update the UI explicitly so the user knows how many images they are seeing
    const countDisplay = document.getElementById('pointCountDisplay');
    if (countDisplay) {
        countDisplay.textContent = `(${points.length.toLocaleString()} items)`;
    }

    // If visualizing for the first time, attach all event listeners
    if (!isVizSetup) {
        setupViz();
        isVizSetup = true;
    } else {
        // Otherwise just update the D3 mathematical domains for the new points and redraw
        updateScalesAndRender();
    }

    overlay.style.display = "none";
}

function setupViz() {
  // Grab the physical pixel dimensions of the canvas element on the screen
  const width = canvas.node().clientWidth;
  const height = canvas.node().clientHeight;

  // Set the internal drawing buffer size of the canvas to match its physical CSS size
  canvas.attr("width", width).attr("height", height);

  // ==========================================
  // Mathematics & Scales
  // ==========================================
  // d3.extent finds the minimum and maximum boundaries of our data points.
  // For example, xExtent might be [-50.4, 212.8], establishing the range of our mathematical cluster.
  const xExtent = d3.extent(points, (p) => p.x);
  const yExtent = d3.extent(points, (p) => p.y);

  // We add 5% padding to the maximums and minimums so that dots on the extreme edges don't get cut off
  const xPadding = (xExtent[1] - xExtent[0]) * 0.05;
  const yPadding = (yExtent[1] - yExtent[0]) * 0.05;

  // D3 Scales translate mathematical coordinate space into physical screen pixels mapping.
  // 'domain' is the raw math data (e.g., -50 to 200). 'range' is the screen pixels (e.g., 0 to 1920 pixels).
  xScale = d3
    .scaleLinear()
    .domain([xExtent[0] - xPadding, xExtent[1] + xPadding])
    .range([0, width]);

  // Notice the 'range' for Y is flipped ([height, 0]), because in Math, Y=0 is bottom, but in CSS, Y=0 is top.
  yScale = d3
    .scaleLinear()
    .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
    .range([height, 0]);

  // ==========================================
  // Zoom Behavior
  // ==========================================
  // We attach a D3 zoom handler. It listens to scroll-wheels and mouse-drags.
  zoom = d3
    .zoom()
    .scaleExtent([1, 20]) // Change from 0.5 to 1: Users can't zoom out past the full map view.
    .translateExtent([[0, 0], [width, height]]) // Lock pan scrolling strictly to canvas bounds so clusters don't leave screen.
    .on("zoom", (event) => {
      // Whenever a zoom/pan event fires, it gives us a new 'transform' matrix (a configuration of Scale, X offset, and Y offset).
      // We save this global transform state, and then redraw the entire canvas with it.
      transform = event.transform;
      render(xScale, yScale);
    });

  // Attach the zoom event listeners securely to the canvas 
  canvas.call(zoom);

  // Do the very first paint of the scatterplot
  render(xScale, yScale);

  // ==========================================
  // Resize Handler
  // ==========================================
  window.addEventListener("resize", () => {
    // Upon window resize, we grab the NEW dimensions...
    const w = canvas.node().parentNode.clientWidth;
    const h = canvas.node().parentNode.clientHeight;
    canvas.attr("width", w).attr("height", h);
    
    // ...update our scale pixel ranges to map to the new dimensions...
    xScale.range([0, w]);
    yScale.range([h, 0]);
    
    // ...and redraw the map.
    render(xScale, yScale);
  });

  // ==========================================
  // Mouse Interaction (Hover Detection)
  // ==========================================
  canvas.on("mousemove", (event) => {
    // d3.pointer gets the [x, y] pixel coordinates of the mouse on the physical canvas
    const [mx, my] = d3.pointer(event);
    
    // transform.invertX/Y takes those screen pixels and translates them backwards 
    // through the current zoom/pan offset into base (unzoomed) screen pixels.
    const tx = transform.invertX(mx);
    const ty = transform.invertY(my);

    // We'll scan through every point to find which one is closest to our mouse pointer
    let closest = null;
    let minDist = Infinity;

    for (const p of points) {
      // Step 1: Base Screen Coordinates
      // Convert the raw math coordinate (p.x) into base screen pixels using our scale.
      const sx = xScale(p.x);
      const sy = yScale(p.y);

      // Step 2: Current Screen Coordinates
      // Apply the user's current zoom and pan offset so we know exactly where the dot is being drawn RIGHT NOW.
      const px = transform.applyX(sx);
      const py = transform.applyY(sy);

      // Step 3: Distance Measurement
      // Math.hypot calculates the precise diagonal distance between the mouse (mx, my) and the point (px, py)
      const dist = Math.hypot(px - mx, py - my);
      
      // If the distance is less than 20 pixels AND it's the closest one we've seen so far, we save it.
      if (dist < 20 && dist < minDist) {
        minDist = dist;
        closest = p;
      }
    }

    // If we successfully found a point within the 20-pixel hover radius...
    if (closest) {
      // Call our custom showTooltip function, passing the data point and the exact mouse coordinates
      showTooltip(closest, mx, my);
    } else {
      // Otherwise, the mouse isn't near any point, so we hide the tooltip
      hideTooltip();
    }
  });

  // Next, we setup a "click" event listener specifically on the map canvas
  canvas.on("click", (event) => {
    // We check if there's currently an active tooltip (meaning they clicked ON a point)
    // AND we check if we have access to 'window.electronAPI' (meaning the app is running natively, not just in a regular browser)
    if (currentTooltip && window.electronAPI) {
      // We instruct our Electron backend to open the computer's file explorer right where this image lives
      window.electronAPI.showInFolder(currentTooltip.path);
    }
  });

  // ==========================================
  // UI Buttons setup for Zoom and Sync
  // ==========================================
  
  // When the Zoom In button is clicked...
  d3.select("#zoomInBtn").on("click", () =>
    // We transition the canvas smoothly, multiplying its current zoom scale by 1.2
    canvas.transition().call(zoom.scaleBy, 1.2),
  );
  
  // When the Zoom Out button is clicked...
  d3.select("#zoomOutBtn").on("click", () =>
    // We transition the canvas smoothly, multiplying its current zoom scale by 0.8
    canvas.transition().call(zoom.scaleBy, 0.8),
  );
  
  // When the Reset button is clicked...
  d3.select("#resetBtn").on("click", () =>
    // We apply "d3.zoomIdentity", which resets to the default 1x zoom level and returns the pan to center
    canvas.transition().call(zoom.transform, d3.zoomIdentity),
  );

  // When the Sync Data button is clicked...
  d3.select("#syncBtn").on("click", async () => {
    const btn = document.getElementById("syncBtn");
    
    // Give the user visual feedback that it's working and prevent duplicate spam clicks
    btn.textContent = "Syncing...";
    btn.disabled = true;

    try {
      // We ping our backend server and tell it to trigger the Python sync script
      await fetch("http://localhost:3000/api/sync-ls", { method: "POST" });
      
      // If the sync succeeds, we refresh the entire page to pull in the newly generated data files
      location.reload();
    } catch (e) {
      // If something goes wrong, we throw up an alert box...
      alert("Sync failed: " + e.message);
      
      // ...and restore the button so the user can try again
      btn.textContent = "Sync Data";
      btn.disabled = false;
    }
  });
}

function updateScalesAndRender() {
    const width = canvas.node().clientWidth;
    const height = canvas.node().clientHeight;

    canvas.attr("width", width).attr("height", height);

    if (points.length === 0) {
        context.clearRect(0, 0, width, height);
        return;
    }

    const xExtent = d3.extent(points, (p) => p.x);
    const yExtent = d3.extent(points, (p) => p.y);

    const xPadding = (xExtent[1] - xExtent[0]) * 0.05;
    const yPadding = (yExtent[1] - yExtent[0]) * 0.05;

    xScale.domain([xExtent[0] - xPadding, xExtent[1] + xPadding]).range([0, width]);
    yScale.domain([yExtent[0] - yPadding, yExtent[1] + yPadding]).range([height, 0]);

    // Update zoom translation boundaries so they match the resize
    zoom.translateExtent([[0, 0], [width, height]]);

    // Reset zoom transform to identity
    canvas.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
}

function render(xScale, yScale) {
  // Grab current dimensions for clearing the canvas
  const width = canvas.attr("width");
  const height = canvas.attr("height");

  // context.save() pushes the current unrotated, unscaled base state of the canvas onto a stack.
  // We do this because we're about to artificially shift the entire drawing board.
  context.save();
  
  // Wipe the canvas clean for a fresh frame
  context.clearRect(0, 0, width, height);

  // Apply the global Zoom/Pan Transformation to the Canvas itself.
  // Instead of recalculating new math for 10,000 points individually, 
  // we shift the entire drawing context by the exact pan amount (transform.x, transform.y),
  // and scale the entire drawing context by the zoom amount (transform.k).
  context.translate(transform.x, transform.y);
  context.scale(transform.k, transform.k);

  // Now we iterate through every data point and draw it using base screen coordinates.
  points.forEach((p) => {
    // Get base pixel location
    const px = xScale(p.x);
    const py = yScale(p.y);

    context.beginPath();
    
    // We want the dots to remain roughly the same size on the user's screen no matter how far they zoom in.
    // Because we invoked context.scale() earlier, the canvas automatically magnifies everything we draw by transform.k.
    // To counteract this, we DIVIDE the draw radius by transform.k.
    // E.g., if zoomed in 10x, we draw the dot 10x smaller. The canvas multiplies it by 10x, resulting in a perfect dot.
    // Math.max ensures the dot never totally vanishes (setting a minimum bound of 0.5 logical pixels).
    const radius = Math.max(0.5, 3 / transform.k);
    
    // Draw the circle arc (x, y, radius, startAngle, endAngle)
    context.arc(px, py, radius, 0, 2 * Math.PI);

    // Color it based on what cluster group it belongs to using D3's color mapper
    context.fillStyle = colorScale(p.cluster);
    
    // Fill in the ink
    context.fill();
  });

  // context.restore() pops the unrotated, unscaled state back, 
  // effectively undoing the translate and scale so we don't accidentally double-apply it on the next frame.
  context.restore();
}

function showTooltip(point, px, py) {
  // 'point' is the data object containing filename, cluster, label, etc.
  // 'px' and 'py' are the x and y coordinates of the mouse pointer relative to the canvas.

  const tooltip = document.getElementById("vizTooltip");
  const img = document.getElementById("tooltipImg");
  const txt = document.getElementById("tooltipText");

  // Set the text label for the tooltip.
  txt.textContent = point.label || point.filename;

  // Construct the thumbnail URL using the unique ID
  // Check both 'id' (DB) and 'db_id' (alias) or just 'id'
  const thumbId = point.id;
  img.src = `http://localhost:3000/thumbnails/id_${thumbId}.avif`;

  // Make the tooltip visible so its dimensions can be measured
  tooltip.style.display = "flex";

  // 'rect' contains the actual rendered width and height of the tooltip
  const rect = tooltip.getBoundingClientRect();

  // Get the canvas element to determine our drawing boundaries
  const canvasEl = document.getElementById("vizCanvas");
  const canvasWidth = canvasEl.clientWidth;
  const canvasHeight = canvasEl.clientHeight;

  // Start with a default position: 16 pixels to the right, and 16 pixels below the cursor
  let left = px + 16;
  let top = py + 16;

  // Check if placing it 16px to the right pushes it past the RIGHT edge of the canvas.
  // 'left + rect.width' calculates the right-most edge of the tooltip.
  if (left + rect.width > canvasWidth) {
    // If it overflows the right edge, we flip it to the LEFT side of the cursor.
    // 'px - rect.width - 16' places the right edge of the tooltip 16px left of the cursor.
    // Math.max(10, ...) ensures that if the tooltip flips left, it doesn't fall off the left side of the window (maintaining a 10px safety margin).
    left = Math.max(10, px - rect.width - 16);
  }

  // Check if placing it 16px below pushes it past the BOTTOM edge of the canvas.
  // 'top + rect.height' calculates the bottom-most edge of the tooltip.
  if (top + rect.height > canvasHeight) {
    // If it overflows the bottom edge, we flip it ABOVE the cursor.
    // 'py - rect.height - 16' places the bottom edge of the tooltip 16px above the cursor.
    // Math.max(10, ...) ensures it doesn't fall off the top side of the window.
    top = Math.max(10, py - rect.height - 16);
  }

  // Apply the final calculated positioning to the tooltip's CSS properties
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";

  // Store the active point in a global variable in case the user clicks on it
  currentTooltip = point;

  // Change the mouse cursor to a pointer to indicate interactivity
  canvas.style.cursor = "pointer";
}

function hideTooltip() {
  document.getElementById("vizTooltip").style.display = "none";
  currentTooltip = null;
  canvas.style.cursor = "grab";
}
