import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

console.log('Testing Sharp AVIF support...');

try {
    const s = sharp();
    console.log('Sharp version:', await sharp.versions); // Check underlying libvips versions
    console.log('AVIF in formats:', sharp.format.avif);
} catch (e) {
    console.error('Failed to init sharp:', e);
}

// Create a dummy simple image and try to save as AVIF
const testFile = 'test_thumb.avif';
try {
    await sharp({
        create: {
            width: 100,
            height: 100,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 }
        }
    })
        .avif()
        .toFile(testFile);
    console.log('Successfully created test AVIF thumbnail:', testFile);

    // Clean up
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    console.log('Cleanup successful.');

} catch (e) {
    console.error('Failed to create AVIF:', e);
}
