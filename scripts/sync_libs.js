import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicLibsDir = path.join(__dirname, '..', 'public', 'libs');
const nodeModulesDir = path.join(__dirname, '..', 'node_modules');

// Define exactly which files/folders are required for the standalone frontend
const filesToSync = [
    { src: 'fuse.js/dist/fuse.min.js', dest: 'fuse.min.js', type: 'file' },
    { src: 'd3/dist/d3.min.js', dest: 'd3/d3.min.js', type: 'file' },
    { src: '@duckdb/duckdb-wasm/dist', dest: 'duckdb', type: 'dir', extensions: ['.js', '.wasm'] },
    { src: 'apache-arrow', dest: 'arrow', type: 'dir', extensions: ['.js', '.mjs', '.ts'] },
    { src: 'tslib/tslib.js', dest: 'tslib/index.js', type: 'file' },
    { src: 'flatbuffers/js', dest: 'flatbuffers', type: 'dir', extensions: ['.js', '.ts'] },
    { src: '@chenglou/pretext/dist', dest: 'pretext', type: 'dir', extensions: ['.js'] }
];

console.log('🔄 Syncing UI libraries from node_modules to public/libs...');

// WHAT: Recursively copies required frontend library files filtered by allowed file extensions.
// WHY: Keeps `public/libs` lean by skipping docs, sourcemaps, and unused source files from node_modules.
function copyRecursiveSync(source_path, destination_path, allowed_extensions) {
    const source_exists = fs.existsSync(source_path);
    const source_stats = source_exists && fs.statSync(source_path);
    const is_directory = source_exists && source_stats.isDirectory();

    if (is_directory) {
        if (!fs.existsSync(destination_path)) {
            fs.mkdirSync(destination_path, { recursive: true });
        }
        fs.readdirSync(source_path).forEach((child_entry_name) => {
            copyRecursiveSync(
                path.join(source_path, child_entry_name),
                path.join(destination_path, child_entry_name),
                allowed_extensions
            );
        });
    } else if (source_exists) {
        if (allowed_extensions) {
            const file_extension = path.extname(source_path);
            if (!allowed_extensions.includes(file_extension)) return;
        }

        const destination_parent_directory = path.dirname(destination_path);
        if (!fs.existsSync(destination_parent_directory)) {
            fs.mkdirSync(destination_parent_directory, { recursive: true });
        }
        fs.copyFileSync(source_path, destination_path);
    }
}

try {
    // Create the libs directory if it doesn't exist
    if (!fs.existsSync(publicLibsDir)) {
        fs.mkdirSync(publicLibsDir, { recursive: true });
    }

    // Iterate and safely copy mapped files
    filesToSync.forEach(mapping => {
        const sourcePath = path.join(nodeModulesDir, mapping.src);
        const destPath = path.join(publicLibsDir, mapping.dest);

        if (!fs.existsSync(sourcePath)) {
            console.warn(`[WARN] Source missing: ${sourcePath}. Did you forget to run npm install?`);
            return;
        }

        if (mapping.type === 'file') {
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(sourcePath, destPath);
        } else if (mapping.type === 'dir') {
            copyRecursiveSync(sourcePath, destPath, mapping.extensions);
        }

        console.log(`✅ Synced: ${mapping.dest}`);
    });

    console.log('🎉 Library sync complete! Frontend UI files are up to date.');
} catch (library_sync_error) {
    console.error('❌ Failed to sync libraries:', library_sync_error);
    process.exit(1);
}
