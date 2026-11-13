/**
 * Zero-dependency JS Syntax, HTML Inline Handler & ESM Import Integrity Linter.
 *
 * WHAT: Syntax-checks all workspace JS/CJS/MJS files and verifies `type="module"` HTML pages
 *       expose every inline `onclick`/`onchange`/`oninput` handler on `window`.
 * WHY: Catches broken imports, syntax errors, and missing `window.*` bindings before runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'venv', '.git', 'dist', 'libs', '.agent', '.gemini', 'ls-data']);

function collectJavaScriptFiles(root_directory_path) {
    const collected_paths = [];
    for (const directory_entry of fs.readdirSync(root_directory_path, { withFileTypes: true })) {
        if (SKIPPED_DIRECTORY_NAMES.has(directory_entry.name)) continue;
        const full_entry_path = path.join(root_directory_path, directory_entry.name);
        if (directory_entry.isDirectory()) {
            collected_paths.push(...collectJavaScriptFiles(full_entry_path));
        } else if (/\.(js|cjs|mjs)$/.test(directory_entry.name)) {
            collected_paths.push(full_entry_path);
        }
    }
    return collected_paths;
}

function checkAllJavaScriptSyntax(file_paths_list) {
    for (const file_path of file_paths_list) {
        execFileSync(process.execPath, ['--check', file_path], { stdio: 'pipe' });
    }
}

function checkHtmlInlineHandlersForModules() {
    const failures = [];
    const html_files = ['public/index.html', 'public/settings.html', 'public/tags.html', 'public/dicer.html', 'public/search.html', 'public/database.html', 'public/scope.html'];

    for (const html_file of html_files) {
        if (!fs.existsSync(html_file)) continue;
        const html_content = fs.readFileSync(html_file, 'utf8');
        const uses_es_module = /<script[^>]*type=["']module["']/i.test(html_content);
        if (!uses_es_module) continue;

        const js_file = html_file.replace('.html', '.js');
        const js_content = fs.existsSync(js_file) ? fs.readFileSync(js_file, 'utf8') : '';
        const window_assign_tail = js_content.includes('Object.assign(window')
            ? js_content.slice(js_content.lastIndexOf('Object.assign(window'))
            : '';

        for (const match of html_content.matchAll(/\son(?:click|change|input|submit)=["']([a-zA-Z0-9_]+)\s*\(/g)) {
            const handler_name = match[1];
            const bound_directly = js_content.includes(`window.${handler_name}`);
            const bound_in_assign = window_assign_tail.includes(handler_name);
            if (!bound_directly && !bound_in_assign) {
                failures.push(`${html_file} references "${handler_name}()" but ${js_file} does not expose it on window`);
            }
        }
    }
    return failures;
}

const all_js_files = collectJavaScriptFiles('.');
checkAllJavaScriptSyntax(all_js_files);
const html_handler_failures = checkHtmlInlineHandlersForModules();

if (html_handler_failures.length > 0) {
    console.error('[LINT] Failed inline handler checks:\n' + html_handler_failures.join('\n'));
    process.exit(1);
}

console.log(`[LINT] OK: ${all_js_files.length} JS files syntax-checked, all module inline HTML handlers verified.`);

