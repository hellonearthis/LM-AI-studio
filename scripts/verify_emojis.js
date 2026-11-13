import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock the server.js logic
const PROMPTS_FILE = path.join(__dirname, '..', 'qwen_vl3_prompts.json');
console.log('Reading file:', PROMPTS_FILE);

// WHAT: Checking whether prompt keys strip emoji prefixes cleanly without losing ampersands.
// WHY: Ensures UI dropdown labels like "Prompt Refine & Expand" align with sanitized dictionary keys.
try {
    if (fs.existsSync(PROMPTS_FILE)) {
        const rawData = fs.readFileSync(PROMPTS_FILE, 'utf8');
        const json = JSON.parse(rawData);

        const qwenPrompts = json.qwenvl
            ? Object.entries(json.qwenvl).reduce((accumulated_prompts, [raw_key, prompt_value]) => {
                const cleaned_key = raw_key.replace(/[^\w\s&]/g, '').replace(/\s+/g, ' ').trim();
                console.log(`Original: "${raw_key}" -> Clean: "${cleaned_key}"`);
                return { ...accumulated_prompts, [cleaned_key]: prompt_value };
            }, {})
            : {};

        console.log('\n--- Final Keys ---');
        console.log(Object.keys(qwenPrompts));

        // Validation
        const expectedKeys = [
            "Tags", "Simple Description", "Detailed Description",
            "Ultra Detailed Description", "Cinematic Description",
            "Detailed Analysis", "Video Summary", "Short Story", "Prompt Refine & Expand"
        ];

        const missingKeys = expectedKeys.filter(expected_key => !(expected_key in qwenPrompts));
        if (missingKeys.length > 0) {
            console.error('Missing expected prompt keys:', missingKeys);
            process.exitCode = 1;
        } else {
            console.log('All expected prompt keys verified.');
        }

    } else {
        console.error('File not found');
    }
} catch (verification_error) {
    console.error('Error:', verification_error);
}
