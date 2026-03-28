const { BrowserWindow } = require('electron');
const path = require('path');

let settingsWindow = null;

function createSettingsWindow(parent, store) {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    parent,
    modal: true,
    title: '元尾巴 · 自动回复设置',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

module.exports = { createSettingsWindow };
