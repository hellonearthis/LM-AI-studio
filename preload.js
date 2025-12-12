import { contextBridge, ipcRenderer } from 'electron';

console.log('Preload script loaded');

contextBridge.exposeInMainWorld('electronAPI', {
    selectImageFile: () => ipcRenderer.invoke('select-image-file'),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    getImagesFromFolder: (folderPath) => ipcRenderer.invoke('get-images-from-folder', folderPath),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
    trashFile: (filePath) => ipcRenderer.invoke('trash-file', filePath),
    openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
