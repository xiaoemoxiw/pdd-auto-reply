const { app } = require('electron');
const { getApiTrafficIndexPath, getApiTrafficLogPath } = require('../src/main/traffic/api-traffic-path');
const { rebuildApiTrafficIndexFromLog } = require('../src/main/traffic/api-traffic-recorder');

async function main() {
  const indexData = rebuildApiTrafficIndexFromLog();
  console.log(JSON.stringify({
    logPath: getApiTrafficLogPath(),
    indexPath: getApiTrafficIndexPath(),
    shopCount: Object.keys(indexData.byShop || {}).length,
  }, null, 2));
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(error => {
    console.error(error.message);
    app.exit(1);
  });
