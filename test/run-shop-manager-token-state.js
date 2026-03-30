const assert = require('assert');
const { app } = require('electron');
const { ShopManager } = require('../src/main/shop-manager');

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

async function run() {
  const store = new MemoryStore({
    shops: [
      { id: 'shop_a', loginMethod: 'token' },
      { id: 'shop_b', loginMethod: 'token' },
    ],
    shopTokens: {},
  });
  const manager = new ShopManager(null, store);

  const rawOnlyTokenInfo = manager._buildTokenInfo({
    windowsAppShopToken: 'raw-token-only',
    userAgent: 'ua-1',
    pddid: 'pddid-1',
  });

  manager._saveTokenInfo('shop_a', rawOnlyTokenInfo);

  assert.deepStrictEqual(store.get('shopTokens.shop_a'), {
    token: '',
    mallId: '',
    userId: '',
    raw: 'raw-token-only',
    userAgent: 'ua-1',
    pddid: 'pddid-1',
  });
  assert.strictEqual(global.__pddTokens.shop_a.raw, 'raw-token-only');

  global.__pddTokens = {};
  const restored = manager.restoreAllTokenInfo();
  assert.strictEqual(restored, 1);
  assert.strictEqual(global.__pddTokens.shop_a.raw, 'raw-token-only');
  assert.strictEqual(global.__pddTokens.shop_a.userAgent, 'ua-1');

  manager.clearTokenInfo('shop_a');
  assert.strictEqual(store.get('shopTokens.shop_a'), undefined);
  assert.strictEqual(global.__pddTokens.shop_a, undefined);
}

app.whenReady().then(async () => {
  try {
    await run();
    console.log('shop-manager token state test passed');
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

app.on('window-all-closed', event => {
  event.preventDefault();
});
