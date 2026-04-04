
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../images.db');
const db = new Database(dbPath);

console.log(`Contents of images.db being processed...`);

// Helper function (same as in server.js)
function deduplicateTags(analysis) {
    if (!analysis) return 0;
    
    // Helper: Normalize by removing plurals, brackets, and extra spaces
    const normalize = (s) => String(s).trim().toLowerCase().replace(/[\[\]\(\)\{\}]/g, '').replace(/\s+/g, ' ').trim().replace(/s$/, '');

    let removed = 0;

    if (Array.isArray(analysis.objects)) {
        const originalObjects = [...analysis.objects];
        // Initial cleaning
        let objects = analysis.objects
            .map(o => String(o).trim())
            .filter(o => o.length > 0 && o.length < 100 && o.split(/\s+/).length <= 8);

        // Case-insensitive distinct
        const seen = new Set();
        analysis.objects = objects.filter(o => {
            const norm = normalize(o);
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });
        removed += (originalObjects.length - analysis.objects.length);
    }
    
    if (Array.isArray(analysis.tags)) {
        const originalTags = [...analysis.tags];
        // 1. Initial cleaning (Length and Word Count limits)
        let tags = analysis.tags
            .map(t => String(t).trim())
            .filter(t => t.length > 0 && t.length < 120 && t.split(/\s+/).length <= 10);

        // 2. Case-insensitive and Plural-insensitive deduplication
        const seen = new Set();
        tags = tags.filter(t => {
            const norm = normalize(t);
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });

        // 3. Substring / Recursive pruning:
        tags.sort((a, b) => a.length - b.length); 

        const finalTags = [];
        for (const tag of tags) {
            const normTag = normalize(tag);
            const isRedundant = finalTags.some(existing => {
                const normExisting = normalize(existing);
                if (normTag.length > 5 && normExisting.length > 5) {
                    if (normTag.includes(normExisting) || normExisting.includes(normTag)) return true;
                }
                return false;
            });
            if (!isRedundant) finalTags.push(tag);
        }

        analysis.tags = finalTags;

        // 4. Remove tags that are already represented as objects
        if (Array.isArray(analysis.objects)) {
            const objectNorms = new Set(analysis.objects.map(normalize));
            analysis.tags = analysis.tags.filter(tag => !objectNorms.has(normalize(tag)));
        }

        removed += (originalTags.length - analysis.tags.length);
    }

    return removed;
}

try {
    const images = db.prepare('SELECT id, filename, analysis FROM images').all();
    let updatedCount = 0;
    let totalRemoved = 0;

    const updateStmt = db.prepare('UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?');

    const transaction = db.transaction(() => {
        const now = new Date().toISOString();

        for (const img of images) {
            let analysis = {};
            try {
                analysis = typeof img.analysis === 'string' ? JSON.parse(img.analysis) : (img.analysis || {});
            } catch (e) { continue; }

            if (!analysis.tags || !analysis.objects) continue;

            const originalTags = JSON.stringify(analysis.tags);
            const removed = deduplicateTags(analysis);
            const newTags = JSON.stringify(analysis.tags);

            if (removed > 0) {
                updateStmt.run(JSON.stringify(analysis), now, img.id);
                updatedCount++;
                totalRemoved += removed;
                console.log(`[CLEANUP] ${img.filename}: Removed ${removed} duplicate tags.`);
            }
        }
    });

    transaction();

    console.log(`\n---------------------------------------------------`);
    console.log(`Cleanup Complete.`);
    console.log(`Images updated: ${updatedCount}`);
    console.log(`Total duplicate tags removed: ${totalRemoved}`);
    console.log(`---------------------------------------------------`);

} catch (err) {
    console.error('Error:', err);
}
