---
name: ipc-bridge-auditor
description: Audit and scaffold Electron Inter-Process Communication (IPC) channels across main.js, preload.cjs, and renderer scripts. Use when adding new native desktop capabilities, auditing file path security, preventing path traversal vulnerabilities, or exposing new APIs across the Electron context isolation boundary.
---

# Electron IPC Bridge Auditor Skill

A security and architecture skill for creating, auditing, and maintaining Inter-Process Communication (IPC) bridges between the Electron Main process and Renderer contexts in LM AI Studio.

---

## Security & Context Isolation Rules

The application enforces `contextIsolation: true` and `nodeIntegration: false` in [main.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/main.js):
1. **No Raw Node Primitives in Renderer**: Never expose raw `fs`, `child_process`, or `path` to `window`.
2. **Context Bridge Only**: All native features must pass through `contextBridge.exposeInMainWorld('electronAPI', ...)` inside [preload.cjs](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/preload.cjs).
3. **Path Traversal Guards**: Every file operation handler in [main.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/main.js) (e.g. `readFile`, `showInFolder`, `deleteFile`) must validate that paths are well-formed and do not escape intended directories.

---

## Workflow: Adding or Auditing an IPC Channel

### Step 1: Run IPC Channel Audit
Execute the bundled channel scanner to identify exposed vs. unhandled channels:
```bash
python .agent/skills/ipc-bridge-auditor/scripts/audit_ipc_channels.py
```

### Step 2: Implement Handler in Main Process
In [main.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/main.js), register using `ipcMain.handle`:
```javascript
// WHAT: Handling native desktop file action requested from renderer.
// WHY: Main process executes privileged OS calls on behalf of the sandboxed UI.
ipcMain.handle('channel-name', async (event, requested_file_path_string) => {
    // Validate arguments before execution
    if (!requested_file_path_string || typeof requested_file_path_string !== 'string') {
        throw new Error('Invalid file path provided');
    }
    // Perform operation safely
});
```

### Step 3: Expose Bridge in Preload
In [preload.cjs](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/preload.cjs), add the typed wrapper:
```javascript
contextBridge.exposeInMainWorld('electronAPI', {
    channelAction: (file_path) => ipcRenderer.invoke('channel-name', file_path),
    // ...
});
```

### Step 4: Consume in Renderer
Call via `window.electronAPI.channelAction(...)` with proper error handling and UI fallback.
