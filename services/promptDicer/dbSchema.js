/**
 * Prompt Dicer SQLite Schema & Pure Row Helpers
 *
 * TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
 * Pure schema initialization and deterministic row/bucket helpers extracted from promptDicerDb.js.
 */


/**
 * WHAT: Initializes database tables, indices, and the `images.diced_prompt` column for the Prompt Dicer.
 * WHY: Structured storage of prompts, subjects, atomic ingredients, and directed influence edges
 *      in SQLite provides fast local querying, while storing `diced_prompt` directly on the `images`
 *      table and inside `images.analysis` guarantees every image entry in `images.db` carries its
 *      complete Pass A–D Master Record.
 * 
 * @param {Object} database_connection - Active better-sqlite3 database instance.
 */
export function initialize_prompt_dicer_tables(database_connection) {
    // WHAT: Creating the diced_prompts, diced_ingredients, and diced_influences tables.
    // WHY: Keeps high-level prompt metadata, physicality metrics, slot ingredients, and influence edges indexed.
    database_connection.exec(`
        CREATE TABLE IF NOT EXISTS diced_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_id TEXT UNIQUE NOT NULL,
            image_id INTEGER,
            media_type TEXT NOT NULL DEFAULT 'image',
            raw_prompt TEXT NOT NULL,
            physical_anchor_count INTEGER NOT NULL DEFAULT 0,
            pretext_term_count INTEGER NOT NULL DEFAULT 0,
            physicality_ratio REAL NOT NULL DEFAULT 0.0,
            master_record_json TEXT NOT NULL,
            influences_json TEXT,
            is_reviewed INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_diced_prompts_prompt_id ON diced_prompts(prompt_id);
        CREATE INDEX IF NOT EXISTS idx_diced_prompts_image_id ON diced_prompts(image_id);
        CREATE INDEX IF NOT EXISTS idx_diced_prompts_physicality_ratio ON diced_prompts(physicality_ratio);

        CREATE TABLE IF NOT EXISTS diced_ingredients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_id TEXT NOT NULL,
            ingredient_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'prompt_extraction',
            text TEXT NOT NULL,
            slot TEXT NOT NULL,
            bound_to_subject_id TEXT,
            measured_number REAL,
            measured_unit TEXT,
            observable_replacement_text TEXT,
            replacement_slot TEXT,
            is_reviewed INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (prompt_id) REFERENCES diced_prompts(prompt_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_diced_ingredients_prompt_id ON diced_ingredients(prompt_id);
        CREATE INDEX IF NOT EXISTS idx_diced_ingredients_slot ON diced_ingredients(slot);
        CREATE INDEX IF NOT EXISTS idx_diced_ingredients_kind ON diced_ingredients(kind);

        CREATE TABLE IF NOT EXISTS diced_influences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_id TEXT NOT NULL,
            source_ingredient_id TEXT NOT NULL,
            target_ingredient_id TEXT NOT NULL,
            interaction_type TEXT NOT NULL,
            portable_target_slot TEXT NOT NULL,
            target_subject_scope TEXT NOT NULL,
            consequence_description TEXT NOT NULL,
            state_key TEXT NOT NULL,
            applied_state_value TEXT NOT NULL,
            clashes_with_value TEXT NOT NULL,
            is_verified INTEGER NOT NULL DEFAULT 0,
            is_reviewed INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (prompt_id) REFERENCES diced_prompts(prompt_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_diced_influences_prompt_id ON diced_influences(prompt_id);
        CREATE INDEX IF NOT EXISTS idx_diced_influences_state_key ON diced_influences(state_key);

        CREATE TABLE IF NOT EXISTS review_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_type TEXT NOT NULL,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            prompt_id TEXT NOT NULL,
            image_id INTEGER,
            label TEXT NOT NULL,
            corrected_value_json TEXT,
            reviewer TEXT NOT NULL DEFAULT 'curator',
            model_confidence REAL,
            model_version TEXT,
            dataset_split TEXT NOT NULL DEFAULT 'train',
            is_repeat_check INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (prompt_id) REFERENCES diced_prompts(prompt_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_review_events_prompt_id ON review_events(prompt_id);
        CREATE INDEX IF NOT EXISTS idx_review_events_card_type ON review_events(card_type);
        CREATE INDEX IF NOT EXISTS idx_review_events_item ON review_events(item_type, item_id);
        CREATE INDEX IF NOT EXISTS idx_review_events_split ON review_events(dataset_split);
    `);

    // WHAT: Ensuring migrated columns exist on legacy `images`, `diced_prompts`, `diced_ingredients`, and `diced_influences` tables.
    // WHY: Allows per-item `is_reviewed` tracking and Ovis provenance on existing databases without manual table rebuilds.
    try {
        const existing_image_columns = database_connection.prepare('PRAGMA table_info(images)').all();
        if (Array.isArray(existing_image_columns) && existing_image_columns.length > 0) {
            const has_diced_prompt_column = existing_image_columns.some(
                column_info => column_info.name === 'diced_prompt'
            );
            if (!has_diced_prompt_column) {
                database_connection.exec('ALTER TABLE images ADD COLUMN diced_prompt TEXT');
            }
        }
    } catch (migration_probe_error) {
        // Ignore if `images` table does not exist in an isolated unit test database
    }

    try {
        const existing_prompt_columns = database_connection.prepare('PRAGMA table_info(diced_prompts)').all();
        if (Array.isArray(existing_prompt_columns) && existing_prompt_columns.length > 0) {
            if (!existing_prompt_columns.some(column_info => column_info.name === 'is_reviewed')) {
                database_connection.exec('ALTER TABLE diced_prompts ADD COLUMN is_reviewed INTEGER NOT NULL DEFAULT 0');
            }
            database_connection.exec('CREATE INDEX IF NOT EXISTS idx_diced_prompts_is_reviewed ON diced_prompts(is_reviewed)');
        }
    } catch (prompt_migration_error) {
        // Ignore if schema cannot be altered
    }

    try {
        const existing_ingredient_columns = database_connection.prepare('PRAGMA table_info(diced_ingredients)').all();
        if (Array.isArray(existing_ingredient_columns) && existing_ingredient_columns.length > 0) {
            if (!existing_ingredient_columns.some(column_info => column_info.name === 'source')) {
                database_connection.exec("ALTER TABLE diced_ingredients ADD COLUMN source TEXT NOT NULL DEFAULT 'prompt_extraction'");
            }
            if (!existing_ingredient_columns.some(column_info => column_info.name === 'is_reviewed')) {
                database_connection.exec('ALTER TABLE diced_ingredients ADD COLUMN is_reviewed INTEGER NOT NULL DEFAULT 0');
            }
            database_connection.exec('CREATE INDEX IF NOT EXISTS idx_diced_ingredients_source ON diced_ingredients(source)');
            database_connection.exec('CREATE INDEX IF NOT EXISTS idx_diced_ingredients_is_reviewed ON diced_ingredients(is_reviewed)');
        }
    } catch (ingredient_migration_error) {
        // Ignore if schema cannot be altered
    }

    try {
        const existing_influence_columns = database_connection.prepare('PRAGMA table_info(diced_influences)').all();
        if (Array.isArray(existing_influence_columns) && existing_influence_columns.length > 0) {
            if (!existing_influence_columns.some(column_info => column_info.name === 'is_reviewed')) {
                database_connection.exec('ALTER TABLE diced_influences ADD COLUMN is_reviewed INTEGER NOT NULL DEFAULT 0');
            }
            database_connection.exec('CREATE INDEX IF NOT EXISTS idx_diced_influences_is_reviewed ON diced_influences(is_reviewed)');
        }
    } catch (influence_migration_error) {
        // Ignore if schema cannot be altered
    }
}

/**
 * WHY: Keeps evaluation holdout sets strictly isolated from training exports across benchmark iterations.
 * 
 * @param {string} prompt_identifier - Unique prompt identifier (e.g. `prm_00042`).
 * @param {number} holdout_ratio - Fraction in [0, 0.9] assigned to holdout (default `0.2`).
 * @returns {'train'|'holdout'} Deterministic split label.
 */
export function assign_deterministic_dataset_split(prompt_identifier, holdout_ratio = 0.2) {
    const clamped_ratio = Math.max(0, Math.min(0.9, Number(holdout_ratio) || 0));
    if (clamped_ratio === 0) return 'train';

    const normalized_key = String(prompt_identifier || '');
    let fnv_hash_accumulator = 2166136261;
    for (let char_index = 0; char_index < normalized_key.length; char_index++) {
        fnv_hash_accumulator ^= normalized_key.charCodeAt(char_index);
        fnv_hash_accumulator = Math.imul(fnv_hash_accumulator, 16777619);
    }
    const normalized_unit_bucket = ((fnv_hash_accumulator >>> 0) % 10000) / 10000;
    return normalized_unit_bucket < clamped_ratio ? 'holdout' : 'train';
}

/**
 * WHAT: Classifies raw prompt word length into discrete stratification buckets (`short`, `medium`, `long`).
 * WHY: Ensures first-pass stratified review sampling spreads labels evenly across concise and detailed captions.
 */
export function classify_prompt_length_bucket(raw_prompt_text) {
    const word_count = String(raw_prompt_text || '').trim().split(/\s+/).filter(Boolean).length;
    if (word_count < 15) return 'short';
    if (word_count <= 45) return 'medium';
    return 'long';
}

/**
 * WHAT: Safely parses `images.diced_prompt` / `master_record_json` to read visual grounding metadata if present.
 * WHY: Surfaces stored 2048-dim Ovis grounding scores directly on review cards when available.
 */
export function extract_visual_grounding_metadata(raw_diced_prompt_json) {
    if (!raw_diced_prompt_json || typeof raw_diced_prompt_json !== 'string') return null;
    try {
        const parsed = JSON.parse(raw_diced_prompt_json);
        return parsed?.visual_grounding || null;
    } catch (parse_error) {
        return null;
    }
}
