

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

// WHAT: Verifies that `/create-thumbnail` accepts a Base64 PNG payload and produces a thumbnail.
// WHY: Confirms the Sharp AVIF thumbnail generation pipeline works end-to-end against a running server.
async function testThumbnail() {
    console.log('\n--- Testing Thumbnail Generation ---');
    const thumbnail_response = await fetch(`${BASE_URL}/create-thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            imageData: base64Image,
            filename: 'test_thumb.png'
        })
    });
    const thumbnail_payload = await thumbnail_response.json();
    console.log('Response:', thumbnail_payload);
    if (!thumbnail_payload.success) throw new Error('Thumbnail generation failed');
}

// WHAT: Verifies that `/save` detects duplicate image content by SHA-256 hash across distinct file paths.
// WHY: Prevents storing duplicate analysis rows when identical images live in different folders.
async function testDeduplication() {
    console.log('\n--- Testing Deduplication ---');

    // 1. Save File First Time
    console.log('Saving file 1...');
    const first_save_response = await fetch(`${BASE_URL}/save`, {
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
    const first_save_payload = await first_save_response.json();
    console.log('Save 1:', first_save_payload);

    // 2. Save Same File (Different Path, Same Hash)
    console.log('Saving file 2 (Duplicate Content)...');
    const second_save_response = await fetch(`${BASE_URL}/save`, {
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
    const second_save_payload = await second_save_response.json();
    console.log('Save 2:', second_save_payload);

    if (second_save_payload.duplicate) {
        console.log('SUCCESS: Duplicate detected!');
    } else {
        console.error('FAILURE: Duplicate NOT detected.');
    }
}

// WHAT: Runs the thumbnail and deduplication integration checks sequentially.
// WHY: Deduplication writes test records to the live endpoint and depends on clean HTTP responses.
async function run() {
    try {
        await testThumbnail();
        await testDeduplication();
        console.log('\nAll tests passed.');
    } catch (backend_test_error) {
        console.error('\nTest Failed:', backend_test_error);
    }
}

run();
