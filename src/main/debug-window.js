const { BrowserWindow } = require('electron');
const path = require('path');

let debugWindow = null;

function createDebugWindow(parent) {
  if (debugWindow) {
    debugWindow.focus();
    return debugWindow;
  }

  debugWindow = new BrowserWindow({
    width: 720,
    height: 520,
    minWidth: 480,
    minHeight: 320,
    parent,
    title: '调试面板 · 网络抓包',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'debug-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  debugWindow.loadFile(path.join(__dirname, '..', 'renderer', 'debug.html'));

  debugWindow.on('closed', () => {
    debugWindow = null;
  });

  return debugWindow;
}

function getDebugWindow() {
  return debugWindow;
}

function sendToDebug(channel, data) {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send(channel, data);
  }
}

module.exports = { createDebugWindow, getDebugWindow, sendToDebug };
