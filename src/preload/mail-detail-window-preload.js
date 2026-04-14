const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailDetailWindowApi', {
  setToolbarHeight: (height) => ipcRenderer.invoke('mail-detail-set-toolbar-height', { height }),
  navigate: (url) => ipcRenderer.invoke('mail-detail-navigate', { url }),
  goBack: () => ipcRenderer.invoke('mail-detail-back'),
  goForward: () => ipcRenderer.invoke('mail-detail-forward'),
  reload: () => ipcRenderer.invoke('mail-detail-reload'),
  getState: () => ipcRenderer.invoke('mail-detail-get-state'),
  onState: (cb) => ipcRenderer.on('mail-detail-window-state', (_, d) => cb(d)),
});
