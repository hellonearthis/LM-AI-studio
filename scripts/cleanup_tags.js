
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
    if (analysis && analysis.tags && analysis.objects && Array.isArray(analysis.tags) && Array.isArray(analysis.objects)) {
        const objectSet = new Set(analysis.objects.map(o => o.toLowerCase()));
        const originalCount = analysis.tags.length;
        // Filter out tags that are present in objects (case-insensitive)
        analysis.tags = analysis.tags.filter(tag => !objectSet.has(tag.toLowerCase()));

        return originalCount - analysis.tags.length;
    }
    return 0;
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
