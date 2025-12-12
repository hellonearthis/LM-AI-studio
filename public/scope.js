
// D3 is loaded as UMD, so it attaches to window.d3
import 'd3';
const d3 = window.d3;
import * as duckdb from '@duckdb/duckdb-wasm';

// Configuration
// Define bundles manually to point to local files relative to scope.html
const MANUAL_BUNDLES = {
    mvp: {
        mainModule: '/libs/duckdb/duckdb-mvp.wasm',
        mainWorker: '/libs/duckdb/duckdb-browser-mvp.worker.js',
    },
    eh: {
        mainModule: '/libs/duckdb/duckdb-eh.wasm',
        mainWorker: '/libs/duckdb/duckdb-browser-eh.worker.js',
    },
};

// State
let db = null;
let points = [];
let transform = d3.zoomIdentity;
let currentTooltip = null;

// DOM Elements
const canvas = d3.select('#vizCanvas');
const context = canvas.node().getContext('2d');
const overlay = document.getElementById('scopeOverlay');

// Colors
const colorScale = d3.scaleOrdinal(d3.schemeTableau10);

// Initialize
init();

async function init() {
    try {
        overlay.querySelector('h3').textContent = 'Initializing Database...';

        // 1. Setup DuckDB with Manual Bundle
        // We select the best bundle (mvp or eh) based on browser support
        const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);

        console.log('[Viz] Using bundle:', bundle);

        const worker = new Worker(bundle.mainWorker);
        const logger = new duckdb.ConsoleLogger();
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

        // 2. Load Data
        overlay.querySelector('h3').textContent = 'Loading Parquet Files...';

        // Use HTTP localhost to bypass file:// restrictions
        const BASE_URL = 'http://localhost:3000';

        await db.registerFileURL('input.parquet', `${BASE_URL}/ls-data/input/input.parquet`, duckdb.DuckDBDataProtocol.HTTP, false);
        await db.registerFileURL('scopes.parquet', `${BASE_URL}/ls-data/input/scopes/scopes-001.parquet`, duckdb.DuckDBDataProtocol.HTTP, false);

        // 3. Query Data
        overlay.querySelector('h3').textContent = 'Running Query...';
        const conn = await db.connect();

        const query = `
            SELECT 
                s.x, s.y, s.cluster, s.label,
                i.path, i.filename
            FROM 'scopes.parquet' s
            JOIN 'input.parquet' i ON s.ls_index = i.id
            WHERE s.deleted = false
        `;

        const result = await conn.query(query);
        await conn.close();

        // Convert Arrow Table to Array
        points = result.toArray().map(row => row.toJSON());

        console.log(`[Viz] Loaded ${points.length} points`);

        // 4. Setup D3
        setupViz();

        overlay.style.display = 'none';

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

function setupViz() {
    const width = canvas.node().clientWidth;
    const height = canvas.node().clientHeight;

    canvas.attr('width', width).attr('height', height);

    // Scales
    const xExtent = d3.extent(points, p => p.x);
    const yExtent = d3.extent(points, p => p.y);

    // Add 5% padding
    const xPadding = (xExtent[1] - xExtent[0]) * 0.05;
    const yPadding = (yExtent[1] - yExtent[0]) * 0.05;

    const xScale = d3.scaleLinear()
        .domain([xExtent[0] - xPadding, xExtent[1] + xPadding])
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
        .range([height, 0]);

    // Zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 20])
        .on('zoom', (event) => {
            transform = event.transform;
            render(xScale, yScale);
        });

    canvas.call(zoom);

    // Initial Render
    render(xScale, yScale);

    // Resize
    window.addEventListener('resize', () => {
        const w = canvas.node().parentNode.clientWidth;
        const h = canvas.node().parentNode.clientHeight;
        canvas.attr('width', w).attr('height', h);
        xScale.range([0, w]);
        yScale.range([h, 0]);
        render(xScale, yScale);
    });

    // Interaction
    canvas.on('mousemove', (event) => {
        const [mx, my] = d3.pointer(event);
        const tx = transform.invertX(mx);
        const ty = transform.invertY(my); // Data space coordinates (unscaled)

        // Wait, xScale/yScale are already screening them? 
        // No, scale(domain) -> range (screen).

        // If we want to find point:
        // Point P is at (p.x, p.y) in data space.
        // Screen position is transform(scale(p.x), scale(p.y)).

        // So we scan points:
        let closest = null;
        let minDist = Infinity;

        for (const p of points) {
            // Apply scale first, then transform
            const sx = xScale(p.x);
            const sy = yScale(p.y);

            const px = transform.applyX(sx);
            const py = transform.applyY(sy);

            const dist = Math.hypot(px - mx, py - my);
            if (dist < 20 && dist < minDist) {
                minDist = dist;
                closest = p;
            }
        }

        if (closest) {
            showTooltip(closest, event.pageX, event.pageY);
        } else {
            hideTooltip();
        }
    });

    canvas.on('click', (event) => {
        if (currentTooltip && window.electronAPI) {
            window.electronAPI.showInFolder(currentTooltip.path);
        }
    });

    // UI Buttons
    d3.select('#zoomInBtn').on('click', () => canvas.transition().call(zoom.scaleBy, 1.2));
    d3.select('#zoomOutBtn').on('click', () => canvas.transition().call(zoom.scaleBy, 0.8));
    d3.select('#resetBtn').on('click', () => canvas.transition().call(zoom.transform, d3.zoomIdentity));

    d3.select('#syncBtn').on('click', async () => {
        const btn = document.getElementById('syncBtn');
        btn.textContent = 'Syncing...';
        btn.disabled = true;

        try {
            await fetch('http://localhost:3000/api/sync-ls', { method: 'POST' });
            location.reload();
        } catch (e) {
            alert("Sync failed: " + e.message);
            btn.textContent = 'Sync Data';
            btn.disabled = false;
        }
    });
}

function render(xScale, yScale) {
    const width = canvas.attr('width');
    const height = canvas.attr('height');

    context.save();
    context.clearRect(0, 0, width, height);

    context.translate(transform.x, transform.y);
    context.scale(transform.k, transform.k);

    points.forEach(p => {
        const px = xScale(p.x);
        const py = yScale(p.y);

        // Optimization: Skip off-screen points
        // In local transforms, we might want to check bounds
        // but for <10k points, simple render is fine.

        context.beginPath();
        context.arc(px, py, 4 / transform.k, 0, 2 * Math.PI); // Keep dot size constant-ish or shrink? 
        // 4 / transform.k makes them get smaller as you zoom in 
        // We usually want constant screen size:
        const r = 3 / transform.k; // This makes them effectively smaller in data space as we zoom in (constant screen pixels)
        // Wait. context.scale scales everything including radius.
        // So radius 3 becomes 3*k.
        // If we want constant screen size of 3px: radius = 3 / k.
        context.arc(px, py, Math.max(0.5, 3 / transform.k), 0, 2 * Math.PI);

        context.fillStyle = colorScale(p.cluster);
        context.fill();
    });

    context.restore();
}

function showTooltip(point, px, py) {
    const tooltip = document.getElementById('vizTooltip');
    const img = document.getElementById('tooltipImg');
    const txt = document.getElementById('tooltipText');

    tooltip.style.display = 'flex';
    tooltip.style.left = (px + 15) + 'px';
    tooltip.style.top = (py + 15) + 'px';

    txt.textContent = point.label || point.filename;

    // Thumbnail Logic (Using Server Proxy helps bypass file:// if needed, but local file access works in Electron usually)
    // Actually, serving thumbnails via server is safer.
    // Server has /thumbnails/:filename endpoint? Just static /public/thumbnails
    // Check server.js: app.get('/thumbnail/:filename'...)

    const thumbName = point.filename.substring(0, point.filename.lastIndexOf('.')) + '.avif';
    img.src = `http://localhost:3000/thumbnail/${thumbName}`;

    currentTooltip = point;
    canvas.style.cursor = 'pointer';
}

function hideTooltip() {
    document.getElementById('vizTooltip').style.display = 'none';
    currentTooltip = null;
    canvas.style.cursor = 'grab';
}
