const path = require('path');
const { app } = require('electron');
const packageJson = require('../../package.json');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_LOG_FOLDER = path.join('artifacts', 'api-traffic');
const APP_DATA_LOG_FOLDER = 'logs';
const API_TRAFFIC_LOG_FILE = 'api-traffic-log.jsonl';
const API_TRAFFIC_INDEX_FILE = 'api-traffic-index.json';

function getApiTrafficStorageDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), APP_DATA_LOG_FOLDER);
  }
  return path.join(REPO_ROOT, REPO_LOG_FOLDER);
}

function getApiTrafficLogPath() {
  return path.join(getApiTrafficStorageDir(), API_TRAFFIC_LOG_FILE);
}

function getApiTrafficIndexPath() {
  return path.join(getApiTrafficStorageDir(), API_TRAFFIC_INDEX_FILE);
}

function getLegacyApiTrafficLogPaths() {
  return Array.from(new Set([
    path.join(app.getPath('userData'), APP_DATA_LOG_FOLDER, API_TRAFFIC_LOG_FILE),
    path.join(app.getPath('appData'), packageJson.productName || '', APP_DATA_LOG_FOLDER, API_TRAFFIC_LOG_FILE),
    path.join(app.getPath('appData'), packageJson.name || '', APP_DATA_LOG_FOLDER, API_TRAFFIC_LOG_FILE),
  ].filter(Boolean))).filter(filePath => filePath !== getApiTrafficLogPath());
}

function getLegacyApiTrafficIndexPaths() {
  return Array.from(new Set([
    path.join(app.getPath('userData'), APP_DATA_LOG_FOLDER, API_TRAFFIC_INDEX_FILE),
    path.join(app.getPath('appData'), packageJson.productName || '', APP_DATA_LOG_FOLDER, API_TRAFFIC_INDEX_FILE),
    path.join(app.getPath('appData'), packageJson.name || '', APP_DATA_LOG_FOLDER, API_TRAFFIC_INDEX_FILE),
  ].filter(Boolean))).filter(filePath => filePath !== getApiTrafficIndexPath());
}

module.exports = {
  getApiTrafficIndexPath,
  getLegacyApiTrafficIndexPaths,
  getLegacyApiTrafficLogPaths,
  getApiTrafficLogPath,
  getApiTrafficStorageDir,
};
