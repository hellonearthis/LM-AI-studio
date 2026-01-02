import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock the server.js logic
const PROMPTS_FILE = path.join(__dirname, '..', 'qwen_vl3_porompts.json');
console.log('Reading file:', PROMPTS_FILE);

try {
    if (fs.existsSync(PROMPTS_FILE)) {
        const rawData = fs.readFileSync(PROMPTS_FILE, 'utf8');
        const json = JSON.parse(rawData);

        let qwenPrompts = {};
        if (json.qwenvl) {
            Object.entries(json.qwenvl).forEach(([key, value]) => {
                const cleanKey = key.replace(/[^\w\s]/g, '').trim();
                qwenPrompts[cleanKey] = value;
                console.log(`Original: "${key}" -> Clean: "${cleanKey}"`);
            });
        }

        console.log('\n--- Final Keys ---');
        console.log(Object.keys(qwenPrompts));

        // Validation
        const expectedKeys = [
            "Tags", "Simple Description", "Detailed Description",
            "Ultra Detailed Description", "Cinematic Description",
            "Detailed Analysis", "Video Summary", "Short Story", "Prompt Refine  Expand"
        ];

        // Note: "Prompt Refine & Expand" -> "Prompt Refine  Expand" because & is not \w or \s.
        // I might need to adjust the regex if I want to keep '&'.
        // The user keys are:
        // "??? Tags"
        // "??? Simple Description"
        // "?? Cinematic Description"
        // "?? Prompt Refine & Expand" 

        // My regex `/[^\w\s]/g` removes `&`.
        // Let's see if that matters. The dropdown has "Prompt Refine & Expand".
        // The regex will make the key "Prompt Refine  Expand" (double space).
        // This effectively BREAKS the match with the dropdown value "Prompt Refine & Expand".

        // I NEED TO FIX THE REGEX to allow '&' or just strip '?' and emojis.

    } else {
        console.error('File not found');
    }
} catch (err) {
    console.error('Error:', err);
}
