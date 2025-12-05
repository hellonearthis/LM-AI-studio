const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectImageFile: () => ipcRenderer.invoke('select-image-file'),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    getImagesFromFolder: (folderPath) => ipcRenderer.invoke('get-images-from-folder', folderPath),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
    showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
    trashFile: (filePath) => ipcRenderer.invoke('trash-file', filePath)
});
