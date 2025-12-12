
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_LIBS = path.join(__dirname, '../public/libs');

['duckdb', 'd3', 'arrow'].forEach(dir => {
    const p = path.join(PUBLIC_LIBS, dir);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

function copyFile(src, dest) {
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied file: ${path.basename(dest)}`);
    } else {
        console.warn(`Missing source: ${src}`);
    }
}

function copyDir(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
    console.log(`Copied directory: ${src} -> ${dest}`);
}

// 1. DuckDB
const DUCK_SRC = path.join(__dirname, '../node_modules/@duckdb/duckdb-wasm/dist');
const DUCK_DEST = path.join(PUBLIC_LIBS, 'duckdb');

copyFile(path.join(DUCK_SRC, 'duckdb-mvp.wasm'), path.join(DUCK_DEST, 'duckdb-mvp.wasm'));
copyFile(path.join(DUCK_SRC, 'duckdb-eh.wasm'), path.join(DUCK_DEST, 'duckdb-eh.wasm'));
copyFile(path.join(DUCK_SRC, 'duckdb-browser-mvp.worker.js'), path.join(DUCK_DEST, 'duckdb-browser-mvp.worker.js'));
copyFile(path.join(DUCK_SRC, 'duckdb-browser-eh.worker.js'), path.join(DUCK_DEST, 'duckdb-browser-eh.worker.js'));
copyFile(path.join(DUCK_SRC, 'duckdb-browser.mjs'), path.join(DUCK_DEST, 'index.js'));


// 2. Apache Arrow
// Fix: Copy the ENTIRE directory to support relative imports in ESM build
const ARROW_SRC = path.join(__dirname, '../node_modules/apache-arrow');
const ARROW_DEST = path.join(PUBLIC_LIBS, 'arrow');
copyDir(ARROW_SRC, ARROW_DEST);


// 3. D3
const D3_SRC = path.join(__dirname, '../node_modules/d3/dist');
copyFile(path.join(D3_SRC, 'd3.min.js'), path.join(PUBLIC_LIBS, 'd3/d3.min.js'));

// 4. tslib (Required by Arrow)
const TSLIB_SRC = path.join(__dirname, '../node_modules/tslib');
const TSLIB_DEST = path.join(PUBLIC_LIBS, 'tslib');
if (!fs.existsSync(TSLIB_DEST)) fs.mkdirSync(TSLIB_DEST, { recursive: true });
copyFile(path.join(TSLIB_SRC, 'tslib.es6.js'), path.join(TSLIB_DEST, 'index.js'));

// 5. flatbuffers (Required by Arrow)
const FB_SRC = path.join(__dirname, '../node_modules/flatbuffers/mjs');
const FB_DEST = path.join(PUBLIC_LIBS, 'flatbuffers');
// Copy the entire directory because flatbuffers.js (the entry) imports sibling files relatively
copyDir(FB_SRC, FB_DEST);
