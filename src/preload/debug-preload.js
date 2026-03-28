const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('debugApi', {
  onNetworkLog: (cb) => ipcRenderer.on('network-log', (_, d) => cb(d)),
  onNetworkMessageDetected: (cb) => ipcRenderer.on('network-message-detected', (_, d) => cb(d)),
  onAutoReplySent: (cb) => ipcRenderer.on('auto-reply-sent', (_, d) => cb(d)),
  onSystemLog: (cb) => ipcRenderer.on('system-log', (_, d) => cb(d)),
  // API 抓包
  onApiCapture: (cb) => ipcRenderer.on('api-capture', (_, d) => cb(d)),
  getApiCaptureList: () => ipcRenderer.invoke('api-capture-list'),
  getApiCaptureDetail: (id) => ipcRenderer.invoke('api-capture-detail', id),
  getApiCaptureCategories: () => ipcRenderer.invoke('api-capture-categories'),
  exportApiCaptures: (category) => ipcRenderer.invoke('api-capture-export', category),
  clearApiCaptures: () => ipcRenderer.invoke('api-capture-clear'),
  getApiCaptureLogDir: () => ipcRenderer.invoke('api-capture-log-dir'),
});
