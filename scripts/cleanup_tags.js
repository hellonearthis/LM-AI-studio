
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const images_database_path = path.join(__dirname, '../images.db');
const images_database = new Database(images_database_path);

console.log(`Contents of images.db being processed...`);

// WHAT: Normalizes, deduplicates, and prunes redundant substring tags and objects from an analysis record.
// WHY: Returns both the cleaned analysis object and the removed item count as a pure transformation
//      so callers never depend on hidden in-place mutations.
function deduplicateTags(analysis_record) {
    if (!analysis_record) {
        return { cleaned_analysis_record: analysis_record, total_removed_count: 0 };
    }

    // WHAT: Normalizing tag text by removing brackets, collapsing whitespace, and stripping trailing plurals.
    // WHY: Ensures variations like "[Sunset]" and "sunsets" collapse into a single canonical entry.
    const normalizeTagToken = (raw_tag_text) => String(raw_tag_text)
        .trim()
        .toLowerCase()
        .replace(/[\[\]\(\)\{\}]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/s$/, '');

    const original_objects_collection = Array.isArray(analysis_record.objects) ? analysis_record.objects : null;
    const deduplicated_objects_collection = original_objects_collection
        ? (() => {
            const seen_object_tokens = new Set();
            return original_objects_collection
                .map(object_label => String(object_label).trim())
                .filter(object_label => object_label.length > 0 && object_label.length < 100 && object_label.split(/\s+/).length <= 8)
                .filter(object_label => {
                    const normalized_token = normalizeTagToken(object_label);
                    if (seen_object_tokens.has(normalized_token)) return false;
                    seen_object_tokens.add(normalized_token);
                    return true;
                });
        })()
        : analysis_record.objects;

    const removed_objects_count = original_objects_collection
        ? (original_objects_collection.length - deduplicated_objects_collection.length)
        : 0;

    const original_tags_collection = Array.isArray(analysis_record.tags) ? analysis_record.tags : null;
    const deduplicated_tags_collection = original_tags_collection
        ? (() => {
            const seen_tag_tokens = new Set();
            const distinct_cleaned_tags = original_tags_collection
                .map(tag_label => String(tag_label).trim())
                .filter(tag_label => tag_label.length > 0 && tag_label.length < 120 && tag_label.split(/\s+/).length <= 10)
                .filter(tag_label => {
                    const normalized_token = normalizeTagToken(tag_label);
                    if (seen_tag_tokens.has(normalized_token)) return false;
                    seen_tag_tokens.add(normalized_token);
                    return true;
                });

            // WHAT: Sorting shortest-first without mutating `distinct_cleaned_tags` before pruning superstrings.
            // WHY: Keeping shorter root tags first lets us drop redundant longer phrases that contain them.
            const sorted_tags_shortest_first = [...distinct_cleaned_tags].sort(
                (first_tag, second_tag) => first_tag.length - second_tag.length
            );

            const pruned_tags_collection = sorted_tags_shortest_first.reduce((accepted_tags, candidate_tag) => {
                const normalized_candidate = normalizeTagToken(candidate_tag);
                const is_redundant_superstring = accepted_tags.some(existing_tag => {
                    const normalized_existing = normalizeTagToken(existing_tag);
                    return (
                        normalized_candidate.length > 5 &&
                        normalized_existing.length > 5 &&
                        (normalized_candidate.includes(normalized_existing) || normalized_existing.includes(normalized_candidate))
                    );
                });
                return is_redundant_superstring ? accepted_tags : [...accepted_tags, candidate_tag];
            }, []);

            if (!Array.isArray(deduplicated_objects_collection)) {
                return pruned_tags_collection;
            }
            const object_token_set = new Set(deduplicated_objects_collection.map(normalizeTagToken));
            return pruned_tags_collection.filter(tag_label => !object_token_set.has(normalizeTagToken(tag_label)));
        })()
        : analysis_record.tags;

    const removed_tags_count = original_tags_collection
        ? (original_tags_collection.length - deduplicated_tags_collection.length)
        : 0;

    return {
        cleaned_analysis_record: {
            ...analysis_record,
            ...(original_objects_collection ? { objects: deduplicated_objects_collection } : {}),
            ...(original_tags_collection ? { tags: deduplicated_tags_collection } : {})
        },
        total_removed_count: removed_objects_count + removed_tags_count
    };
}

try {
    const image_rows_collection = images_database.prepare('SELECT id, filename, analysis FROM images').all();
    let updated_images_count = 0;
    let total_removed_tags_count = 0;

    const update_image_statement = images_database.prepare('UPDATE images SET analysis = ?, updated_at = ? WHERE id = ?');

    // WHAT: Wrapping batch tag cleanup inside a single SQLite transaction.
    // WHY: Ensures atomic commits across all image rows and orders of magnitude faster disk writes.
    const cleanup_transaction = images_database.transaction(() => {
        const current_timestamp_iso = new Date().toISOString();

        for (const image_row of image_rows_collection) {
            let parsed_analysis = {};
            try {
                parsed_analysis = typeof image_row.analysis === 'string'
                    ? JSON.parse(image_row.analysis)
                    : (image_row.analysis || {});
            } catch (json_parse_error) {
                continue;
            }

            if (!parsed_analysis.tags || !parsed_analysis.objects) continue;

            const { cleaned_analysis_record, total_removed_count } = deduplicateTags(parsed_analysis);

            if (total_removed_count > 0) {
                update_image_statement.run(JSON.stringify(cleaned_analysis_record), current_timestamp_iso, image_row.id);
                updated_images_count++;
                total_removed_tags_count += total_removed_count;
                console.log(`[CLEANUP] ${image_row.filename}: Removed ${total_removed_count} duplicate tags.`);
            }
        }
    });

    cleanup_transaction();

    console.log(`\n---------------------------------------------------`);
    console.log(`Cleanup Complete.`);
    console.log(`Images updated: ${updated_images_count}`);
    console.log(`Total duplicate tags removed: ${total_removed_tags_count}`);
    console.log(`---------------------------------------------------`);

} catch (cleanup_execution_error) {
    console.error('Error:', cleanup_execution_error);
}
