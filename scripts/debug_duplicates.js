
import Database from 'better-sqlite3';

// WHAT: Opening the SQLite image catalog in read-only mode to audit duplicate paths and missing dimensions.
// WHY: Read-only access prevents accidental writes while diagnosing filesystem case collisions on Windows.
const images_database = new Database('images.db', { readonly: true });

console.log('--- Database Duplicate Check ---');

// 1. Check for duplicates by Path (Case Insensitive for Windows)
const all_image_records = images_database.prepare('SELECT id, path, width, height, file_hash FROM images').all();
const normalized_path_lookup = new Map();
let duplicate_path_count = 0;

all_image_records.forEach(image_record => {
    const normalized_file_path = image_record.path.toLowerCase();
    if (normalized_path_lookup.has(normalized_file_path)) {
        duplicate_path_count++;
        const existing_reference_record = normalized_path_lookup.get(normalized_file_path);
        console.log(`Duplicate Path Found:`);
        console.log(`  Reference: ID ${existing_reference_record.id} | ${existing_reference_record.path} | ${existing_reference_record.width}x${existing_reference_record.height}`);
        console.log(`  Duplicate: ID ${image_record.id}  | ${image_record.path} | ${image_record.width}x${image_record.height}`);
    } else {
        normalized_path_lookup.set(normalized_file_path, image_record);
    }
});

console.log(`\nTotal duplicate paths (case-insensitive): ${duplicate_path_count}`);

// 2. Check for duplicates by Hash
// WHAT: Grouping image records by SHA-256 content hash for diagnostic inspection.
// WHY: Separate paths can legitimately share identical bytes, so we track the first seen record per hash.
const hash_lookup_map = new Map();

all_image_records.forEach(image_record => {
    if (!image_record.file_hash) return;
    if (!hash_lookup_map.has(image_record.file_hash)) {
        hash_lookup_map.set(image_record.file_hash, image_record);
    }
});

// 3. Count "N/A" equivalent rows (null width/height)
const missing_dimensions_count = images_database.prepare('SELECT COUNT(*) as count FROM images WHERE width IS NULL OR height IS NULL').get().count;
console.log(`\nEntries with missing dimensions (N/A): ${missing_dimensions_count}`);

console.log('Done.');
