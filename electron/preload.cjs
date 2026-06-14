// Minimal, safe bridge between the renderer and the main process for auto-update.
// contextIsolation is on, so the renderer only ever sees these few methods.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitedeck', {
  isElectron: true,
  // Ask the main process to check GitHub Releases for a newer version.
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // Quit and run the downloaded installer.
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  // The most recent update status, so a renderer that subscribes late still catches up.
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  // Subscribe to update lifecycle events; returns an unsubscribe function.
  onUpdateStatus: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});
