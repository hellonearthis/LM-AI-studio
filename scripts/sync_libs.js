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

function copyRecursiveSync(src, dest, extensions) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    
    if (isDirectory) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach((child) => {
            copyRecursiveSync(path.join(src, child), path.join(dest, child), extensions);
        });
    } else if (exists) {
        // Filter by extensions if provided (mainly to avoid copying gigabytes of unrelated repo files)
        if (extensions) {
            const ext = path.extname(src);
            if (!extensions.includes(ext)) return;
        }

        const destDir = path.dirname(dest);
        if (!fs.existsSync(destDir)) {
             fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(src, dest);
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
} catch (err) {
    console.error('❌ Failed to sync libraries:', err);
    process.exit(1);
}
