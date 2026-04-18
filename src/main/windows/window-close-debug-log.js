const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getLogDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'window-debug');
  }
  return path.join(__dirname, '..', '..', 'artifacts', 'window-debug');
}

function getLogPath() {
  return path.join(getLogDir(), 'window-close-log.jsonl');
}

function ensureLogDir() {
  fs.mkdirSync(getLogDir(), { recursive: true });
}

function appendWindowCloseDebugLog(payload = {}) {
  try {
    ensureLogDir();
    const record = {
      time: new Date().toISOString(),
      ...payload
    };
    fs.appendFileSync(getLogPath(), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {}
}

function getWindowCloseDebugLogPath() {
  return getLogPath();
}

module.exports = {
  appendWindowCloseDebugLog,
  getWindowCloseDebugLogPath
};
