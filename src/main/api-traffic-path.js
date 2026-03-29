const path = require('path');
const { app } = require('electron');

function getApiTrafficLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'api-traffic-log.jsonl');
}

function getLegacyApiTrafficLogPath() {
  return path.join(__dirname, '..', '..', 'test', 'api-traffic-log.jsonl');
}

module.exports = {
  getApiTrafficLogPath,
  getLegacyApiTrafficLogPath,
};
