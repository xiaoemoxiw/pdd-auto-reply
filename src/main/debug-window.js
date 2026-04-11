const { BrowserWindow } = require('electron');
const path = require('path');

let debugWindow = null;

async function createDebugWindow(parent) {
  if (debugWindow) {
    if (debugWindow.isMinimized()) debugWindow.restore();
    if (!debugWindow.isVisible()) debugWindow.show();
    debugWindow.focus();
    return debugWindow;
  }

  const validParent = parent && !parent.isDestroyed() ? parent : undefined;

  debugWindow = new BrowserWindow({
    width: 720,
    height: 520,
    minWidth: 480,
    minHeight: 320,
    parent: validParent,
    title: '调试面板 · 网络抓包',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'debug-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  try {
    await debugWindow.loadFile(path.join(__dirname, '..', 'renderer', 'debug.html'));
  } catch (err) {
    if (debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.destroy();
    }
    debugWindow = null;
    throw err;
  }

  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show();
    debugWindow.focus();
  }

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
