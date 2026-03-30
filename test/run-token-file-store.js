const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { ShopManager } = require('../src/main/shop-manager');
const { TokenFileStore } = require('../src/main/token-file-store');

class MemoryStore {
  constructor(initial = {}) {
    this.data = JSON.parse(JSON.stringify(initial));
  }

  get(key) {
    if (!key) return this.data;
    const parts = String(key).split('.');
    let current = this.data;
    for (const part of parts) {
      if (current == null || typeof current !== 'object' || !(part in current)) {
        return undefined;
      }
      current = current[part];
    }
    return current;
  }

  set(key, value) {
    const parts = String(key).split('.');
    let current = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }

  delete(key) {
    const parts = String(key).split('.');
    let current = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object') {
        return;
      }
      current = current[part];
    }
    delete current[parts[parts.length - 1]];
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function run() {
  const sourceDir = createTempDir('pdd-token-source-');
  const managedDir = createTempDir('pdd-token-managed-');
  const samplePath = path.join(__dirname, 'tokens', 'sample-token.json');
  const importedPath = path.join(sourceDir, 'sample-token.json');
  fs.copyFileSync(samplePath, importedPath);

  const store = new MemoryStore({
    shops: [],
    shopTokens: {},
    shopTokenFiles: {},
    shopCookies: {},
  });
  const tokenFileStore = new TokenFileStore(store, { baseDir: managedDir });
  const shopManager = new ShopManager(null, store, { tokenFileStore });

  const bootstrapped = tokenFileStore.bootstrapFromDirectory(sourceDir);
  assert.strictEqual(bootstrapped, 1);

  const firstSync = await shopManager.syncShopsFromTokenFiles({ broadcast: false });
  assert.strictEqual(firstSync.shops.length, 1);
  const firstShop = firstSync.shops[0];
  assert.strictEqual(firstShop.mallId, '504805789');
  assert.strictEqual(firstShop.loginMethod, 'token');
  assert.strictEqual(firstShop.tokenFileName, 'shop_504805789.json');
  assert.strictEqual(store.get('shopTokens.shop_504805789').mallId, '504805789');

  const refreshedToken = JSON.parse(fs.readFileSync(samplePath, 'utf-8').replace(/^\uFEFF/, ''));
  refreshedToken.userAgent = 'updated-user-agent';
  const refreshSourcePath = path.join(sourceDir, 'sample-token-refresh.json');
  fs.writeFileSync(refreshSourcePath, JSON.stringify(refreshedToken, null, 2) + '\n', 'utf-8');
  const imported = tokenFileStore.importTokenFile(refreshSourcePath);
  const secondSync = await shopManager.syncShopsFromTokenFiles({ broadcast: false });
  assert.strictEqual(imported.shopId, 'shop_504805789');
  assert.ok(secondSync.refreshedShopIds.includes('shop_504805789'));
  assert.strictEqual(store.get('shops')[0].userAgent, 'updated-user-agent');

  const thirdSync = await shopManager.syncShopsFromTokenFiles({ broadcast: false, forceApplyTokens: true });
  assert.ok(Object.prototype.hasOwnProperty.call(thirdSync.cookieCountByShopId, 'shop_504805789'));
  assert.ok(thirdSync.cookieCountByShopId.shop_504805789 >= 1);

  assert.strictEqual(tokenFileStore.removeTokenFile('shop_504805789'), true);
  const fourthSync = await shopManager.syncShopsFromTokenFiles({ broadcast: false });
  assert.strictEqual(fourthSync.shops.length, 0);
  assert.strictEqual(store.get('shopTokens.shop_504805789'), undefined);
}

app.whenReady().then(async () => {
  try {
    await run();
    console.log('token-file-store test passed');
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

app.on('window-all-closed', event => {
  event.preventDefault();
});
