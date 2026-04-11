const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('invoiceOrderDetailWindowApi', {
  setToolbarHeight: (height) => ipcRenderer.invoke('invoice-order-detail-set-toolbar-height', { height }),
  navigate: (url) => ipcRenderer.invoke('invoice-order-detail-navigate', { url }),
  goBack: () => ipcRenderer.invoke('invoice-order-detail-back'),
  goForward: () => ipcRenderer.invoke('invoice-order-detail-forward'),
  reload: () => ipcRenderer.invoke('invoice-order-detail-reload'),
  getState: () => ipcRenderer.invoke('invoice-order-detail-get-state'),
  onState: (cb) => ipcRenderer.on('invoice-order-detail-state', (_, d) => cb(d)),
});

