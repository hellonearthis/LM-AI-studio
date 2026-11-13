
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_LIBS = path.join(__dirname, '../public/libs');

['duckdb', 'd3', 'arrow'].forEach(library_directory_name => {
    const target_library_directory = path.join(PUBLIC_LIBS, library_directory_name);
    if (!fs.existsSync(target_library_directory)) {
        fs.mkdirSync(target_library_directory, { recursive: true });
    }
});

// WHAT: Copies a single browser-vendored library asset from node_modules to public/libs.
// WHY: Serves local WASM and UMD/ESM dependencies offline without relying on external CDNs.
function copyFile(source_file_path, destination_file_path) {
    if (fs.existsSync(source_file_path)) {
        fs.copyFileSync(source_file_path, destination_file_path);
        console.log(`Copied file: ${path.basename(destination_file_path)}`);
    } else {
        console.warn(`Missing source: ${source_file_path}`);
    }
}

// WHAT: Recursively copies an entire library folder so relative ESM imports resolve intact.
// WHY: Packages like Apache Arrow and FlatBuffers reference sibling modules via relative paths.
function copyDir(source_directory_path, destination_directory_path) {
    if (!fs.existsSync(destination_directory_path)) {
        fs.mkdirSync(destination_directory_path, { recursive: true });
    }

    const directory_entries = fs.readdirSync(source_directory_path, { withFileTypes: true });
    for (const directory_entry of directory_entries) {
        const entry_source_path = path.join(source_directory_path, directory_entry.name);
        const entry_destination_path = path.join(destination_directory_path, directory_entry.name);

        if (directory_entry.isDirectory()) {
            copyDir(entry_source_path, entry_destination_path);
        } else {
            fs.copyFileSync(entry_source_path, entry_destination_path);
        }
    }
    console.log(`Copied directory: ${source_directory_path} -> ${destination_directory_path}`);
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
