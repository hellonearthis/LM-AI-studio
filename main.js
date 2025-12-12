import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import './server.js'; // Start the Express server

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    // Switch to local server to support workers/WASM properly
    // Wait a brief moment for server to start or assume it's ready (server.js starts fast)
    // In production, we should wait for a 'ready' signal, but for this dev setup, it's fine.
    mainWindow.loadURL('http://localhost:3000/index.html');
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
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif'] }
        ]
    });

    if (result.canceled) {
        return [];
    }

    return result.filePaths;
});

// Handle folder selection
ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (result.canceled) {
        return null;
    }

    return result.filePaths[0];
});

// Get all images from a folder
ipcMain.handle('get-images-from-folder', async (event, folderPath) => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.avif'];

    try {
        const files = fs.readdirSync(folderPath);
        const imagePaths = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return imageExtensions.includes(ext);
            })
            .map(file => {
                const fullPath = path.join(folderPath, file);
                const stats = fs.statSync(fullPath);
                return {
                    path: fullPath,
                    mtime: stats.mtime.getTime()
                };
            });

        return imagePaths;
    } catch (error) {
        console.error('Error reading folder:', error);
        return [];
    }
});

// Read file buffer
ipcMain.handle('read-file', async (event, filePath) => {
    try {
        return fs.readFileSync(filePath);
    } catch (error) {
        console.error('Error reading file:', error);
        throw error;
    }
});

// Get file stats (creation date, modification date, etc.)
ipcMain.handle('get-file-stats', async (event, filePath) => {
    try {
        const stats = fs.statSync(filePath);
        return {
            birthtime: stats.birthtime.toISOString(),
            mtime: stats.mtime.toISOString(),
            size: stats.size
        };
    } catch (error) {
        console.error('Error getting file stats:', error);
        throw error;
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

// Open external URL
ipcMain.handle('open-external', async (event, url) => {
    await shell.openExternal(url);
});
