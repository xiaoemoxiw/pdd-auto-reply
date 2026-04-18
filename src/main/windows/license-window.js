const { BrowserWindow } = require('electron');
const path = require('path');

let licenseWindow = null;

function createLicenseWindow() {
  if (licenseWindow) {
    licenseWindow.focus();
    return licenseWindow;
  }

  licenseWindow = new BrowserWindow({
    width: 460,
    height: 260,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: '软件授权验证',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  licenseWindow.loadFile(path.join(__dirname, '..', 'renderer', 'license.html'));

  licenseWindow.on('closed', () => {
    licenseWindow = null;
  });

  return licenseWindow;
}

function getLicenseWindow() {
  return licenseWindow;
}

function destroyLicenseWindow() {
  if (!licenseWindow) return;
  if (!licenseWindow.isDestroyed()) licenseWindow.close();
}

module.exports = {
  createLicenseWindow,
  getLicenseWindow,
  destroyLicenseWindow
};
