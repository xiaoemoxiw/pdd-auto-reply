const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'artifacts', 'window-debug');
const LOG_PATH = path.join(LOG_DIR, 'window-close-log.jsonl');

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendWindowCloseDebugLog(payload = {}) {
  try {
    ensureLogDir();
    const record = {
      time: new Date().toISOString(),
      ...payload
    };
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {}
}

function getWindowCloseDebugLogPath() {
  return LOG_PATH;
}

module.exports = {
  appendWindowCloseDebugLog,
  getWindowCloseDebugLogPath
};
