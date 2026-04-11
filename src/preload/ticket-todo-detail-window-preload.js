const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ticketTodoDetailWindowApi', {
  setToolbarHeight: (height) => ipcRenderer.invoke('ticket-todo-detail-set-toolbar-height', { height }),
  navigate: (url) => ipcRenderer.invoke('ticket-todo-detail-navigate', { url }),
  goBack: () => ipcRenderer.invoke('ticket-todo-detail-back'),
  goForward: () => ipcRenderer.invoke('ticket-todo-detail-forward'),
  reload: () => ipcRenderer.invoke('ticket-todo-detail-reload'),
  getState: () => ipcRenderer.invoke('ticket-todo-detail-get-state'),
  onState: (cb) => ipcRenderer.on('ticket-todo-detail-state', (_, d) => cb(d)),
});
