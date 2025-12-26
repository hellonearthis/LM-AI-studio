

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const BASE_URL = 'http://localhost:3000';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create a dummy image buffer (1x1 red pixel)
const redPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKwAEQAAAABJRU5ErkJggg==', 'base64');
const base64Image = `data:image/png;base64,${redPixel.toString('base64')}`;
const testHash = crypto.createHash('sha256').update(redPixel).digest('hex');

async function testThumbnail() {
    console.log('\n--- Testing Thumbnail Generation ---');
    const res = await fetch(`${BASE_URL}/create-thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            imageData: base64Image,
            filename: 'test_thumb.png'
        })
    });
    const data = await res.json();
    console.log('Response:', data);
    if (!data.success) throw new Error('Thumbnail generation failed');
}

async function testDeduplication() {
    console.log('\n--- Testing Deduplication ---');

    // 1. Save File First Time
    console.log('Saving file 1...');
    const res1 = await fetch(`${BASE_URL}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: 'test_dedup_1.png',
            path: `C:\\Test\\Image1.png`,
            file_hash: testHash,
            metadata: {},
            analysis: { tags: ['test'] }
        })
    });
    const data1 = await res1.json();
    console.log('Save 1:', data1);

    // 2. Save Same File (Different Path, Same Hash)
    console.log('Saving file 2 (Duplicate Content)...');
    const res2 = await fetch(`${BASE_URL}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: 'test_dedup_2.png',
            path: `C:\\Test\\Image2.png`,
            file_hash: testHash, // Same hash
            metadata: {},
            analysis: { tags: ['test'] }
        })
    });
    const data2 = await res2.json();
    console.log('Save 2:', data2);

    if (data2.duplicate) {
        console.log('SUCCESS: Duplicate detected!');
    } else {
        console.error('FAILURE: Duplicate NOT detected.');
    }
}

async function run() {
    try {
        await testThumbnail();
        await testDeduplication();
        console.log('\nAll tests passed.');
    } catch (e) {
        console.error('\nTest Failed:', e);
    }
}

run();
