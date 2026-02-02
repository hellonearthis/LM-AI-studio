
import Database from 'better-sqlite3';

const db = new Database('images.db', { readonly: true });

console.log('--- Database Duplicate Check ---');

// 1. Check for duplicates by Path (Case Insensitive for Windows)
const allImages = db.prepare('SELECT id, path, width, height, file_hash FROM images').all();
const pathMap = new Map();
let duplicatePaths = 0;

allImages.forEach(img => {
    const normalizedPath = img.path.toLowerCase();
    if (pathMap.has(normalizedPath)) {
        duplicatePaths++;
        const prev = pathMap.get(normalizedPath);
        console.log(`Duplicate Path Found:`);
        console.log(`  Reference: ID ${prev.id} | ${prev.path} | ${prev.width}x${prev.height}`);
        console.log(`  Duplicate: ID ${img.id}  | ${img.path} | ${img.width}x${img.height}`);
    } else {
        pathMap.set(normalizedPath, img);
    }
});

console.log(`\nTotal duplicate paths (case-insensitive): ${duplicatePaths}`);

// 2. Check for duplicates by Hash
// (It's okay to have duplicates by hash if paths are legitimately different files, but good to know)
const hashMap = new Map();
let duplicateHashes = 0;

allImages.forEach(img => {
    if (!img.file_hash) return;
    if (hashMap.has(img.file_hash)) {
        // Only count if paths are also effectively the same or if it looks suspicious
        // duplicateHashes++; 
        // We'll just count strictly same content
    } else {
        hashMap.set(img.file_hash, img);
    }
});

// 3. Count "N/A" equivalent rows (null width/height)
const naCount = db.prepare('SELECT COUNT(*) as count FROM images WHERE width IS NULL OR height IS NULL').get().count;
console.log(`\nEntries with missing dimensions (N/A): ${naCount}`);

console.log('Done.');
