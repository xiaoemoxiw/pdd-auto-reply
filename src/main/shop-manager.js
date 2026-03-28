/**
 * 店铺管理模块
 * 管理多店铺的 Cookie/Token 持久化和基本信息。
 * BrowserView 已移除，聊天界面由 Vue.js 自建 UI 提供。
 */

const { session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const PDD_BASE_URL = 'https://mms.pinduoduo.com';

class ShopManager {
  constructor(mainWindow, store, options = {}) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.activeShopId = null;
    this.onLog = options.onLog || (() => {});
    // 保留回调接口以兼容现有调用方
    this.onInjectScript = options.onInjectScript || (() => {});
    this.onNetworkMonitor = options.onNetworkMonitor || (() => {});
    this.onDetectChat = options.onDetectChat || (() => {});
    // 兼容旧代码引用 views
    this.views = new Map();
  }

  _getPartition(shopId) {
    return `persist:pdd-${shopId}`;
  }

  getActiveView() {
    return null;
  }

  getActiveShop() {
    if (!this.activeShopId) return null;
    return this._getShop(this.activeShopId);
  }

  getActiveShopId() {
    return this.activeShopId;
  }

  // ---- 店铺切换 ----

  switchTo(shopId) {
    const shop = this._getShop(shopId);
    if (!shop) return false;

    this.activeShopId = shopId;
    this.store.set('activeShopId', shopId);

    this.mainWindow.webContents.send('shop-switched', { shopId, shop });
    this.onLog(`[PDD助手] 已切换到店铺: ${shop.name}`);
    return true;
  }

  showActiveView() {}
  hideActiveView() {}
  resizeActiveView() {}

  // ---- 添加店铺: Token 导入 ----

  async addByToken(filePath) {
    if (!filePath) {
      const { canceled, filePaths } = await dialog.showOpenDialog(this.mainWindow, {
        title: '选择 Token 文件',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (canceled || !filePaths.length) return { canceled: true };
      filePath = filePaths[0];
    }

    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const tokenData = JSON.parse(raw);

    let mallId = null, userId = null, tokenStr = null;
    if (tokenData.windowsAppShopToken) {
      try {
        const decoded = JSON.parse(Buffer.from(tokenData.windowsAppShopToken, 'base64').toString());
        mallId = String(decoded.m);
        userId = decoded.u;
        tokenStr = decoded.t;
      } catch {}
    }

    const shops = this.store.get('shops') || [];
    const existing = mallId ? shops.find(s => s.mallId === mallId) : null;
    if (existing) {
      return await this._refreshTokenForShop(existing.id, tokenData, mallId, userId, tokenStr);
    }

    const shopId = 'shop_' + Date.now();
    const partition = this._getPartition(shopId);
    const ses = session.fromPartition(partition);

    await ses.clearStorageData();
    await ses.clearCache();

    let cookieCount = 0;
    for (const cookieStr of (tokenData.mallCookies || [])) {
      const eqIdx = cookieStr.indexOf('=');
      if (eqIdx < 0) continue;
      await ses.cookies.set({
        url: 'https://mms.pinduoduo.com',
        name: cookieStr.slice(0, eqIdx),
        value: cookieStr.slice(eqIdx + 1),
        domain: '.pinduoduo.com',
        path: '/',
        secure: true,
        httpOnly: true
      });
      cookieCount++;
    }

    if (tokenData.pddid) {
      await ses.cookies.set({
        url: 'https://mms.pinduoduo.com',
        name: 'pddid',
        value: tokenData.pddid,
        domain: '.pinduoduo.com',
        path: '/'
      });
      cookieCount++;
    }

    const shop = {
      id: shopId,
      name: mallId ? `店铺 ${mallId}` : `店铺 ${shopId.slice(-6)}`,
      account: '',
      mallId: mallId || '',
      group: '',
      remark: '',
      status: 'online',
      loginMethod: 'token',
      userAgent: tokenData.userAgent || '',
      bindTime: new Date().toISOString().split('T')[0],
      category: '待分类',
      balance: 0
    };

    shops.push(shop);
    this.store.set('shops', shops);

    if (!global.__pddTokens) global.__pddTokens = {};
    if (mallId) {
      global.__pddTokens[shopId] = {
        token: tokenStr,
        mallId,
        userId,
        raw: tokenData.windowsAppShopToken,
        userAgent: tokenData.userAgent || ''
      };
    }

    this.switchTo(shopId);

    this.mainWindow.webContents.send('shop-added', { shop });
    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 导入完成: ${cookieCount} Cookie, mallId=${mallId}, shopId=${shopId}`);

    return { shopId, cookieCount, mallId };
  }

  async _refreshTokenForShop(shopId, tokenData, mallId, userId, tokenStr) {
    const partition = this._getPartition(shopId);
    const ses = session.fromPartition(partition);

    await ses.clearStorageData();
    await ses.clearCache();

    let cookieCount = 0;
    for (const cookieStr of (tokenData.mallCookies || [])) {
      const eqIdx = cookieStr.indexOf('=');
      if (eqIdx < 0) continue;
      await ses.cookies.set({
        url: 'https://mms.pinduoduo.com',
        name: cookieStr.slice(0, eqIdx),
        value: cookieStr.slice(eqIdx + 1),
        domain: '.pinduoduo.com',
        path: '/',
        secure: true,
        httpOnly: true
      });
      cookieCount++;
    }

    if (tokenData.pddid) {
      await ses.cookies.set({
        url: 'https://mms.pinduoduo.com',
        name: 'pddid',
        value: tokenData.pddid,
        domain: '.pinduoduo.com',
        path: '/'
      });
      cookieCount++;
    }

    const shops = this.store.get('shops') || [];
    const shop = shops.find(s => s.id === shopId);
    if (shop && tokenData.userAgent) {
      shop.userAgent = tokenData.userAgent;
      shop.status = 'online';
      this.store.set('shops', shops);
    }

    if (!global.__pddTokens) global.__pddTokens = {};
    global.__pddTokens[shopId] = { token: tokenStr, mallId, userId, raw: tokenData.windowsAppShopToken, userAgent: tokenData.userAgent || '' };

    this.switchTo(shopId);

    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 已刷新: shopId=${shopId}, ${cookieCount} Cookie`);

    return { shopId, cookieCount, mallId, refreshed: true };
  }

  // ---- 添加店铺: 扫码登录（保留但简化） ----

  async addByQRCode() {
    return { error: '扫码登录需要 BrowserView，当前为 API 模式，请使用 Token 导入' };
  }

  // ---- 店铺管理 ----

  removeShop(shopId) {
    const ses = session.fromPartition(this._getPartition(shopId));
    ses.clearStorageData().catch(() => {});

    let shops = this.store.get('shops') || [];
    shops = shops.filter(s => s.id !== shopId);
    this.store.set('shops', shops);

    if (this.activeShopId === shopId) {
      this.activeShopId = null;
      if (shops.length > 0) {
        this.switchTo(shops[0].id);
      } else {
        this.store.set('activeShopId', '');
      }
    }

    this.mainWindow.webContents.send('shop-list-updated', { shops });
    if (global.__pddTokens) delete global.__pddTokens[shopId];
    return true;
  }

  getShopList() {
    return this.store.get('shops') || [];
  }

  // ---- Cookie 持久化 ----

  async saveCookies(shopId) {
    try {
      const ses = session.fromPartition(this._getPartition(shopId));
      const cookies = await ses.cookies.get({ domain: '.pinduoduo.com' });
      const key = `shopCookies.${shopId}`;
      this.store.set(key, cookies.map(c => ({
        url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite
      })));
    } catch (err) {
      this.onLog(`[PDD助手] 保存 Cookie 失败(${shopId}): ${err.message}`);
    }
  }

  async restoreCookies(shopId) {
    const key = `shopCookies.${shopId}`;
    const cookies = this.store.get(key);
    if (!cookies?.length) return;

    const ses = session.fromPartition(this._getPartition(shopId));
    let restored = 0;
    for (const cookie of cookies) {
      try {
        await ses.cookies.set(cookie);
        restored++;
      } catch {}
    }
    this.onLog(`[PDD助手] 已恢复 ${restored}/${cookies.length} Cookie(${shopId})`);
  }

  async saveAllCookies() {
    const shops = this.store.get('shops') || [];
    for (const shop of shops) {
      await this.saveCookies(shop.id);
    }
  }

  // ---- 内部辅助 ----

  _getShop(shopId) {
    const shops = this.store.get('shops') || [];
    return shops.find(s => s.id === shopId) || null;
  }
}

module.exports = { ShopManager };
