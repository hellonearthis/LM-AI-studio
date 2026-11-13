/**
 * Server Analysis & Tag Deduplication Helpers
 *
 * WHAT: Pure JSON truncation repair and tag/object normalization functions.
 * WHY: Keeps vision-response cleanup deterministic and testable outside Express routes.
 */

// WHAT: Repairs truncated JSON strings emitted when local LLMs hit token limits.
// WHY: Closes unterminated strings, balances open brackets/braces, and strips trailing commas.
export function repairTruncatedJson(raw_json_string) {
    if (!raw_json_string || typeof raw_json_string !== 'string') return '{}';

    let repaired_text = raw_json_string.trim();
    if (repaired_text.endsWith('}')) return repaired_text;

    console.log('[REPAIR] Attempting to fix truncated JSON...');

    // WHAT: Tracks string literal state and escape sequences while scanning structural brackets.
    // WHY: Escaped quotes (`\"`) and brackets (`{`, `[`, `}`, `]`) inside JSON string values must not
    //      corrupt quote parity or push false delimiters onto the structural bracket stack.
    const bracket_stack = [];
    let is_inside_string_literal = false;
    let is_previous_char_backslash = false;

    for (let char_index = 0; char_index < repaired_text.length; char_index++) {
        const current_char = repaired_text[char_index];
        if (is_previous_char_backslash) {
            is_previous_char_backslash = false;
            continue;
        }
        if (current_char === '\\' && is_inside_string_literal) {
            is_previous_char_backslash = true;
            continue;
        }
        if (current_char === '"') {
            is_inside_string_literal = !is_inside_string_literal;
            continue;
        }
        if (!is_inside_string_literal) {
            if (current_char === '{' || current_char === '[') {
                bracket_stack.push(current_char);
            } else if (current_char === '}' || current_char === ']') {
                bracket_stack.pop();
            }
        }
    }

    if (is_inside_string_literal) {
        if (is_previous_char_backslash) {
            repaired_text = repaired_text.slice(0, -1);
        }
        repaired_text += '"';
    }

    while (bracket_stack.length > 0) {
        const unclosed_opener = bracket_stack.pop();
        if (unclosed_opener === '{') repaired_text += '}';
        else if (unclosed_opener === '[') repaired_text += ']';
    }

    repaired_text = repaired_text.replace(/,\s*([\]}])/g, '$1');

    try {
        JSON.parse(repaired_text);
        console.log('[REPAIR] Success!');
        return repaired_text;
    } catch (parse_error) {
        console.warn('[REPAIR] Failed to fully repair JSON:', parse_error.message);
        const last_brace_index = repaired_text.lastIndexOf('}');
        if (last_brace_index !== -1) {
            return repaired_text.substring(0, last_brace_index + 1);
        }
        return '{}';
    }
}

function normalizeTokenForDeduplication(raw_token) {
    return String(raw_token)
        .trim()
        .toLowerCase()
        .replace(/[\[\]\(\)\{\}]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/s$/, '');
}

// WHAT: Returns a new analysis object with normalized, deduplicated `objects` and `tags` arrays.
// WHY: Vision models frequently emit plural/singular variants or tags that duplicate detected objects.
export function deduplicateTagsPure(analysis_record) {
    if (!analysis_record || typeof analysis_record !== 'object') {
        return analysis_record;
    }

    let next_objects = analysis_record.objects;
    if (Array.isArray(analysis_record.objects)) {
        const seen_object_tokens = new Set();
        next_objects = analysis_record.objects
            .map(object_item => String(object_item).trim())
            .filter(object_item => object_item.length > 0 && object_item.length < 100 && object_item.split(/\s+/).length <= 8)
            .filter(object_item => {
                const normalized_token = normalizeTokenForDeduplication(object_item);
                if (seen_object_tokens.has(normalized_token)) return false;
                seen_object_tokens.add(normalized_token);
                return true;
            });
    }

    let next_tags = analysis_record.tags;
    if (Array.isArray(analysis_record.tags)) {
        const seen_tag_tokens = new Set();
        const distinct_tags = analysis_record.tags
            .map(tag_item => String(tag_item).trim())
            .filter(tag_item => tag_item.length > 0 && tag_item.length < 120 && tag_item.split(/\s+/).length <= 10)
            .filter(tag_item => {
                const normalized_token = normalizeTokenForDeduplication(tag_item);
                if (seen_tag_tokens.has(normalized_token)) return false;
                seen_tag_tokens.add(normalized_token);
                return true;
            })
            .toSorted((first_tag, second_tag) => first_tag.length - second_tag.length);

        const pruned_tags = [];
        for (const candidate_tag of distinct_tags) {
            const normalized_candidate = normalizeTokenForDeduplication(candidate_tag);
            const is_redundant = pruned_tags.some(existing_tag => {
                const normalized_existing = normalizeTokenForDeduplication(existing_tag);
                if (normalized_candidate.length > 5 && normalized_existing.length > 5) {
                    return normalized_candidate.includes(normalized_existing) || normalized_existing.includes(normalized_candidate);
                }
                return false;
            });
            if (!is_redundant) {
                pruned_tags.push(candidate_tag);
            }
        }

        if (Array.isArray(next_objects)) {
            const object_token_set = new Set(next_objects.map(normalizeTokenForDeduplication));
            next_tags = pruned_tags.filter(tag_item => !object_token_set.has(normalizeTokenForDeduplication(tag_item)));
        } else {
            next_tags = pruned_tags;
        }
    }

    return {
        ...analysis_record,
        ...(Array.isArray(next_objects) ? { objects: next_objects } : {}),
        ...(Array.isArray(next_tags) ? { tags: next_tags } : {})
    };
}

// WHAT: Thin compatibility wrapper that applies `deduplicateTagsPure` to mutable caller records.
// WHY: Preserves existing `deduplicateTags(analysis)` call sites in `server.js` while keeping core logic pure.
export function deduplicateTags(analysis_record) {
    if (!analysis_record || typeof analysis_record !== 'object') return;
    const cleaned_record = deduplicateTagsPure(analysis_record);
    if (Array.isArray(cleaned_record.objects)) {
        analysis_record.objects = cleaned_record.objects;
    }
    if (Array.isArray(cleaned_record.tags)) {
        analysis_record.tags = cleaned_record.tags;
    }
}

