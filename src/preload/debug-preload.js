const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('debugApi', {
  onNetworkLog: (cb) => ipcRenderer.on('network-log', (_, d) => cb(d)),
  onNetworkMessageDetected: (cb) => ipcRenderer.on('network-message-detected', (_, d) => cb(d)),
  onApiTraffic: (cb) => ipcRenderer.on('api-traffic', (_, d) => cb(d)),
  onAutoReplySent: (cb) => ipcRenderer.on('auto-reply-sent', (_, d) => cb(d)),
  onSystemLog: (cb) => ipcRenderer.on('system-log', (_, d) => cb(d)),
});
