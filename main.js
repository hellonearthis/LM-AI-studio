import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import './server.js'; // Start the Express server

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

// WHAT: Creating and configuring the primary Electron desktop application window.
// WHY: Hosting the UI through the local Express server (`http://localhost:3000`) ensures Web Workers,
//      WebGPU shaders, and DuckDB-WASM load under a proper HTTP origin without file:// CORS restrictions.
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        backgroundColor: '#0B0B1A',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    // WHAT: Loading the Studio entry page from the local Express server.
    // WHY: Allows module scripts, workers, and WASM assets to resolve reliably over localhost.
    mainWindow.loadURL('http://localhost:3000/index.html');

    // WHAT: Deferring window visibility until the first paint is ready.
    // WHY: Prevents a jarring white flash before the dark-themed Studio layout finishes rendering.
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ============================================================================
// IPC HANDLERS
// ============================================================================

// Handle file selection for image analysis
ipcMain.handle('select-image-file', async () => {
    const dialog_options = {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif'] }
        ]
    };
    const result = (mainWindow && !mainWindow.isDestroyed())
        ? await dialog.showOpenDialog(mainWindow, dialog_options)
        : await dialog.showOpenDialog(dialog_options);

    if (result.canceled) {
        return [];
    }

    return result.filePaths;
});

// Handle folder selection
ipcMain.handle('select-folder', async () => {
    const dialog_options = {
        properties: ['openDirectory']
    };
    const result = (mainWindow && !mainWindow.isDestroyed())
        ? await dialog.showOpenDialog(mainWindow, dialog_options)
        : await dialog.showOpenDialog(dialog_options);

    if (result.canceled) {
        return null;
    }

    return result.filePaths[0];
});

// Get all images from a folder
// WHAT: Asynchronously scans a folder for supported image files and collects their size and mtime.
// WHY:  Using fs.promises with per-file error handling prevents one unreadable file or broken symlink
//       from aborting the whole folder import and avoids blocking the Electron main thread.
ipcMain.handle('get-images-from-folder', async (_ipc_event, folder_path) => {
    const supported_image_extensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.avif']);

    try {
        const directory_entries = await fs.promises.readdir(folder_path, { withFileTypes: true });
        const candidate_image_filenames = directory_entries
            .filter((directory_entry) => {
                if (!directory_entry.isFile() && !directory_entry.isSymbolicLink()) return false;
                const file_extension = path.extname(directory_entry.name).toLowerCase();
                return supported_image_extensions.has(file_extension);
            })
            .map((directory_entry) => directory_entry.name);

        // WHAT: Process `fs.promises.stat` in bounded batches of 64 to avoid EMFILE / threadpool saturation on huge folders.
        const STAT_CONCURRENCY_LIMIT = 64;
        const settled_image_records = [];
        for (let batch_start = 0; batch_start < candidate_image_filenames.length; batch_start += STAT_CONCURRENCY_LIMIT) {
            const filename_batch = candidate_image_filenames.slice(batch_start, batch_start + STAT_CONCURRENCY_LIMIT);
            const batch_results = await Promise.all(
                filename_batch.map(async (filename) => {
                    const full_file_path = path.join(folder_path, filename);
                    try {
                        const file_stats = await fs.promises.stat(full_file_path);
                        return {
                            path: full_file_path,
                            mtime: file_stats.mtime.getTime(),
                            size: file_stats.size
                        };
                    } catch (single_file_stat_error) {
                        console.warn(`[MAIN] Skipping unreadable file "${full_file_path}":`, single_file_stat_error.message);
                        return null;
                    }
                })
            );
            settled_image_records.push(...batch_results);
        }

        return settled_image_records.filter(Boolean);
    } catch (folder_read_error) {
        console.error('Error reading folder:', folder_read_error);
        return [];
    }
});

// Read file buffer
// WHAT: Asynchronously reads a file buffer for renderer preview modals.
// WHY:  Avoids blocking the Electron main process event loop on large image files.
ipcMain.handle('read-file', async (_ipc_event, file_path) => {
    try {
        return await fs.promises.readFile(file_path);
    } catch (file_read_error) {
        console.error('Error reading file:', file_read_error);
        throw file_read_error;
    }
});

// Get file stats (creation date, modification date, etc.)
// WHAT: Asynchronously retrieves file timestamps and byte size.
// WHY:  Keeps main-process IPC non-blocking during batch metadata repairs.
ipcMain.handle('get-file-stats', async (_ipc_event, file_path) => {
    try {
        const file_stats = await fs.promises.stat(file_path);
        return {
            birthtime: file_stats.birthtime.toISOString(),
            mtime: file_stats.mtime.getTime(),
            size: file_stats.size
        };
    } catch (file_stat_error) {
        console.error('Error getting file stats:', file_stat_error);
        throw file_stat_error;
    }
});

// Show file in folder
ipcMain.handle('show-in-folder', async (event, filePath) => {
    shell.showItemInFolder(filePath);
});

// Move file to trash
ipcMain.handle('trash-file', async (event, filePath) => {
    try {
        await shell.trashItem(filePath);
        return { success: true };
    } catch (error) {
        console.error('Error moving file to trash:', error);
        throw error;
    }
});

// WHAT: Opens an external HTTP/HTTPS link in the user's default system browser.
// WHY: Restricting schemes to http/https prevents untrusted renderer input from invoking local file or custom URI handlers.
ipcMain.handle('open-external', async (event, target_url) => {
    const parsed_url = new URL(String(target_url || ''));
    if (parsed_url.protocol !== 'http:' && parsed_url.protocol !== 'https:') {
        throw new Error(`Blocked unsupported external URL protocol: ${parsed_url.protocol}`);
    }
    await shell.openExternal(parsed_url.toString());
});
