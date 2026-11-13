/**
 * Server Embedding Vector Audit & Orphan Pruning
 *
 * WHAT: Pure set-difference audit helpers plus isolated file-system pruning
 *       for `search-embeddings.json` and `ovis-embeddings.json`.
 * WHY: Keeps orphan-detection logic pure and removes ~185 lines of audit boilerplate from `server.js`.
 */

import fs from 'fs';
import path from 'path';

// WHAT: Purely computes orphaned keys and missing image count given stored embedding keys and active DB IDs.
// WHY: Separates set-difference math from disk I/O so it can be unit-tested without mocks.
export function computeEmbeddingKeyAudit(stored_key_set, active_database_image_id_set) {
    const orphaned_keys = [];
    for (const stored_key of stored_key_set) {
        if (!active_database_image_id_set.has(stored_key)) {
            orphaned_keys.push(stored_key);
        }
    }

    let missing_count = 0;
    for (const active_id of active_database_image_id_set) {
        if (!stored_key_set.has(active_id)) {
            missing_count += 1;
        }
    }

    const total_stored_count = stored_key_set.size;
    return {
        totalStoredCount: total_stored_count,
        orphanedKeys: orphaned_keys,
        orphanedCount: orphaned_keys.length,
        validCount: total_stored_count - orphaned_keys.length,
        missingCount: missing_count
    };
}

// WHAT: Purely filters an embedding dictionary to retain only keys present in the active database ID set.
// WHY: Produces a fresh dictionary without mutating the cached in-memory map.
export function pruneEmbeddingMapByActiveIds(raw_embeddings_map, active_database_image_id_set) {
    return Object.entries(raw_embeddings_map || {}).reduce(
        (accumulator, [embedding_id, vector_values]) => {
            if (active_database_image_id_set.has(String(embedding_id))) {
                accumulator[embedding_id] = vector_values;
            }
            return accumulator;
        },
        {}
    );
}

// WHAT: Audits both `search-embeddings.json` and `ovis-embeddings.json` against `images` in SQLite,
//       optionally pruning orphaned vectors and returning byte/count statistics.
// WHY: Keeps the server's integrity check and `/api/embeddings/*` endpoints sharing one audited implementation.
export function auditEmbeddingStores({
    db,
    baseDir,
    pruneOrphans = false,
    getSearchCache,
    setSearchCache,
    loadOvisEmbeddingsCached,
    saveOvisEmbeddingsAndRefreshCache
}) {
    const search_embeddings_path = path.join(baseDir, 'public', 'search-embeddings.json');
    const ovis_embeddings_path = path.join(baseDir, 'public', 'ovis-embeddings.json');

    const active_database_image_rows = db.prepare('SELECT id FROM images').all();
    const active_database_image_id_set = new Set(
        active_database_image_rows.map(image_row => String(image_row.id))
    );
    const total_database_images_count = active_database_image_id_set.size;

    const search_report = {
        exists: false,
        lastModified: null,
        sizeBytes: 0,
        count: 0,
        validCount: 0,
        orphanedCount: 0,
        missingCount: total_database_images_count,
        prunedCount: 0,
        bytesFreed: 0,
        sampleOrphanedIds: []
    };

    if (fs.existsSync(search_embeddings_path)) {
        try {
            const initial_stats = fs.statSync(search_embeddings_path);
            search_report.exists = true;
            search_report.lastModified = initial_stats.mtime.toISOString();
            search_report.sizeBytes = initial_stats.size;

            let raw_search_map = null;
            let current_search_cache = getSearchCache();
            if (
                current_search_cache.mtimeMs !== initial_stats.mtimeMs ||
                current_search_cache.sizeBytes !== initial_stats.size ||
                current_search_cache.keySet.size === 0
            ) {
                raw_search_map = JSON.parse(fs.readFileSync(search_embeddings_path, 'utf8'));
                const extracted_keys = Object.keys(raw_search_map).map(String);
                current_search_cache = {
                    mtimeMs: initial_stats.mtimeMs,
                    sizeBytes: initial_stats.size,
                    count: extracted_keys.length,
                    keySet: new Set(extracted_keys)
                };
                setSearchCache(current_search_cache);
            }

            const search_audit = computeEmbeddingKeyAudit(current_search_cache.keySet, active_database_image_id_set);
            search_report.count = search_audit.totalStoredCount;
            search_report.orphanedCount = search_audit.orphanedCount;
            search_report.validCount = search_audit.validCount;
            search_report.missingCount = search_audit.missingCount;
            search_report.sampleOrphanedIds = search_audit.orphanedKeys.slice(0, 25);

            if (pruneOrphans && search_audit.orphanedCount > 0) {
                if (!raw_search_map) {
                    raw_search_map = JSON.parse(fs.readFileSync(search_embeddings_path, 'utf8'));
                }
                const pruned_search_map = pruneEmbeddingMapByActiveIds(raw_search_map, active_database_image_id_set);
                fs.writeFileSync(search_embeddings_path, JSON.stringify(pruned_search_map));
                const updated_stats = fs.statSync(search_embeddings_path);
                const updated_keys = Object.keys(pruned_search_map).map(String);
                setSearchCache({
                    mtimeMs: updated_stats.mtimeMs,
                    sizeBytes: updated_stats.size,
                    count: updated_keys.length,
                    keySet: new Set(updated_keys)
                });
                search_report.prunedCount = search_audit.orphanedCount;
                search_report.bytesFreed = Math.max(0, initial_stats.size - updated_stats.size);
                search_report.sizeBytes = updated_stats.size;
                search_report.lastModified = updated_stats.mtime.toISOString();
                search_report.count = updated_keys.length;
                search_report.orphanedCount = 0;
                search_report.sampleOrphanedIds = [];
            }
        } catch (search_audit_error) {
            console.warn('[EMBEDDINGS-AUDIT] Failed to audit search-embeddings.json:', search_audit_error.message);
        }
    } else {
        setSearchCache({ mtimeMs: -1, sizeBytes: -1, count: 0, keySet: new Set() });
    }

    const ovis_report = {
        exists: false,
        sizeBytes: 0,
        count: 0,
        validCount: 0,
        orphanedCount: 0,
        missingCount: total_database_images_count,
        prunedCount: 0,
        bytesFreed: 0,
        sampleOrphanedIds: []
    };

    if (fs.existsSync(ovis_embeddings_path)) {
        try {
            const initial_ovis_stats = fs.statSync(ovis_embeddings_path);
            ovis_report.exists = true;
            ovis_report.sizeBytes = initial_ovis_stats.size;

            const cached_ovis_map = loadOvisEmbeddingsCached();
            const stored_ovis_key_set = new Set(Object.keys(cached_ovis_map).map(String));
            const ovis_audit = computeEmbeddingKeyAudit(stored_ovis_key_set, active_database_image_id_set);

            ovis_report.count = ovis_audit.totalStoredCount;
            ovis_report.orphanedCount = ovis_audit.orphanedCount;
            ovis_report.validCount = ovis_audit.validCount;
            ovis_report.missingCount = ovis_audit.missingCount;
            ovis_report.sampleOrphanedIds = ovis_audit.orphanedKeys.slice(0, 25);

            if (pruneOrphans && ovis_audit.orphanedCount > 0) {
                const pruned_ovis_map = pruneEmbeddingMapByActiveIds(cached_ovis_map, active_database_image_id_set);
                saveOvisEmbeddingsAndRefreshCache(pruned_ovis_map);
                const updated_ovis_stats = fs.statSync(ovis_embeddings_path);
                ovis_report.prunedCount = ovis_audit.orphanedCount;
                ovis_report.bytesFreed = Math.max(0, initial_ovis_stats.size - updated_ovis_stats.size);
                ovis_report.sizeBytes = updated_ovis_stats.size;
                ovis_report.count = Object.keys(pruned_ovis_map).length;
                ovis_report.orphanedCount = 0;
                ovis_report.sampleOrphanedIds = [];
            }
        } catch (ovis_audit_error) {
            console.warn('[EMBEDDINGS-AUDIT] Failed to audit ovis-embeddings.json:', ovis_audit_error.message);
        }
    }

    const total_orphaned_before_prune = (
        (search_report.prunedCount > 0 ? search_report.prunedCount : search_report.orphanedCount)
        + (ovis_report.prunedCount > 0 ? ovis_report.prunedCount : ovis_report.orphanedCount)
    );

    return {
        success: true,
        database_image_count: total_database_images_count,
        total_orphaned_before_prune,
        total_remaining_orphaned: search_report.orphanedCount + ovis_report.orphanedCount,
        total_pruned_count: search_report.prunedCount + ovis_report.prunedCount,
        total_bytes_freed: search_report.bytesFreed + ovis_report.bytesFreed,
        search_embeddings: search_report,
        ovis_embeddings: ovis_report
    };
}

