const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('afterSaleDetailWindowApi', {
  setToolbarHeight: (height) => ipcRenderer.invoke('aftersale-detail-set-toolbar-height', { height }),
  navigate: (url) => ipcRenderer.invoke('aftersale-detail-navigate', { url }),
  goBack: () => ipcRenderer.invoke('aftersale-detail-back'),
  goForward: () => ipcRenderer.invoke('aftersale-detail-forward'),
  reload: () => ipcRenderer.invoke('aftersale-detail-reload'),
  getState: () => ipcRenderer.invoke('aftersale-detail-get-state'),
  onState: (cb) => ipcRenderer.on('aftersale-detail-state', (_, d) => cb(d)),
});

