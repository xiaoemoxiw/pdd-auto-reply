const { BrowserView, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const PDD_CHAT_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html';
const PDD_LOGIN_URL = 'https://mms.pinduoduo.com/login';
const PDD_BASE_URL = 'https://mms.pinduoduo.com';

const TOOLBAR_HEIGHT = 48;
const SIDEBAR_WIDTH = 180;
const STATUSBAR_HEIGHT = 24;
const CHAT_BAR_HEIGHT = 36;

class ShopManager {
  constructor(mainWindow, store, options = {}) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.tokenFileStore = options.tokenFileStore || null;
    this.views = new Map();           // shopId -> BrowserView
    this.activeShopId = null;
    this.onLog = options.onLog || (() => {});
    this.onInjectScript = options.onInjectScript || (() => {});
    this.onNetworkMonitor = options.onNetworkMonitor || (() => {});
    this.onDetectChat = options.onDetectChat || (() => {});
    this.onTokenUpdated = options.onTokenUpdated || (() => {});
    this.getApiClient = options.getApiClient || (() => null);
    this._pendingQRShopId = null;     // 扫码登录中的临时 shopId
    this._shopInfoTimer = null;
    this._shopInfoFetchingShopId = '';
  }

  // ---- BrowserView 生命周期 ----

  _getPartition(shopId) {
    return `persist:pdd-${shopId}`;
  }

  _getChatUrl() {
    return this.store.get('chatUrl') || PDD_CHAT_URL;
  }

  _getTokenStoreKey(shopId) {
    return `shopTokens.${shopId}`;
  }

  _buildTokenInfo(tokenData = {}, mallId = '', userId = '', tokenStr = '') {
    return {
      token: tokenStr || '',
      mallId: mallId ? String(mallId) : '',
      userId: userId || '',
      raw: tokenData.windowsAppShopToken || '',
      userAgent: tokenData.userAgent || '',
      pddid: tokenData.pddid || ''
    };
  }

  _decodeWindowsAppShopToken(tokenData = {}) {
    let mallId = '';
    let userId = '';
    let token = '';
    if (tokenData.windowsAppShopToken) {
      try {
        const decoded = JSON.parse(Buffer.from(tokenData.windowsAppShopToken, 'base64').toString());
        mallId = decoded.m ? String(decoded.m) : '';
        userId = decoded.u ? String(decoded.u) : '';
        token = decoded.t || '';
      } catch {}
    }
    return { mallId, userId, token };
  }

  _analyzeTokenData(tokenData = {}, tokenInfo = null) {
    const resolvedTokenInfo = tokenInfo || this._decodeWindowsAppShopToken(tokenData);
    const passIds = Array.isArray(tokenData.mallCookies)
      ? tokenData.mallCookies
        .filter(cookieStr => typeof cookieStr === 'string' && cookieStr.startsWith('PASS_ID='))
        .map(cookieStr => {
          const eqIdx = cookieStr.indexOf('=');
          return eqIdx >= 0 ? cookieStr.slice(eqIdx + 1) : '';
        })
        .filter(Boolean)
      : [];
    const uniquePassIds = new Set(passIds);
    const passIdentityKeys = new Set();
    for (const passId of uniquePassIds) {
      const matched = passId.match(/_(\d+)_(\d+)$/);
      if (!matched) continue;
      passIdentityKeys.add(`${matched[1]}:${matched[2]}`);
    }
    const tokenIdentityKey = resolvedTokenInfo.mallId && resolvedTokenInfo.userId
      ? `${resolvedTokenInfo.mallId}:${resolvedTokenInfo.userId}`
      : '';
    return {
      passIdCount: uniquePassIds.size,
      passIdIdentityCount: passIdentityKeys.size,
      tokenMallId: resolvedTokenInfo.mallId || '',
      tokenUserId: resolvedTokenInfo.userId || '',
      tokenMatchesPassId: tokenIdentityKey ? passIdentityKeys.has(tokenIdentityKey) : false,
      multiPassIdSingleToken: passIdentityKeys.size > 1 && !!resolvedTokenInfo.mallId
    };
  }

  _saveTokenInfo(shopId, tokenInfo) {
    if (!shopId || !tokenInfo) return null;
    const normalized = {
      token: tokenInfo.token || '',
      mallId: tokenInfo.mallId ? String(tokenInfo.mallId) : '',
      userId: tokenInfo.userId || '',
      raw: tokenInfo.raw || '',
      userAgent: tokenInfo.userAgent || '',
      pddid: tokenInfo.pddid || ''
    };
    if (!normalized.raw && !normalized.token && !normalized.mallId && !normalized.userAgent && !normalized.pddid) {
      this.clearTokenInfo(shopId);
      return null;
    }
    if (!global.__pddTokens) global.__pddTokens = {};
    global.__pddTokens[shopId] = normalized;
    this.store.set(this._getTokenStoreKey(shopId), normalized);
    return normalized;
  }

  restoreAllTokenInfo() {
    const shops = this.store.get('shops') || [];
    global.__pddTokens = {};
    let restored = 0;
    for (const shop of shops) {
      const tokenInfo = this.store.get(this._getTokenStoreKey(shop.id));
      if (!tokenInfo) continue;
      if (this._saveTokenInfo(shop.id, tokenInfo)) {
        restored++;
      }
    }
    if (restored > 0) {
      this.onLog(`[PDD助手] 已恢复 ${restored} 个店铺 Token`);
    }
    return restored;
  }

  clearTokenInfo(shopId) {
    if (global.__pddTokens) {
      delete global.__pddTokens[shopId];
    }
    this.store.delete(this._getTokenStoreKey(shopId));
  }

  async _applyTokenDataToSession(shopId, tokenData = {}) {
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

    return cookieCount;
  }

  _hasRealShopName(name = '') {
    const text = String(name || '').trim();
    if (!text) return false;
    if (text.startsWith('店铺 ') || text.startsWith('新店铺 ')) return false;
    if (text === '扫码登录中...') return false;
    if (text.includes('拼多多商家后台')) return false;
    return true;
  }

  _buildShopFromTokenRecord(record, previousShop = {}) {
    const previousName = previousShop.name || '';
    const autoNames = [
      '扫码登录中...',
      previousShop.mallId ? `店铺 ${previousShop.mallId}` : '',
      previousShop.id ? `店铺 ${previousShop.id.slice(-6)}` : '',
      previousShop.id ? `新店铺 ${previousShop.id.slice(-6)}` : ''
    ].filter(Boolean);
    const name = !previousName || autoNames.includes(previousName)
      ? (record.tokenInfo.mallId ? `店铺 ${record.tokenInfo.mallId}` : previousName || `店铺 ${record.shopId.slice(-6)}`)
      : previousName;
    const hasRealShopName = this._hasRealShopName(previousName);
    const inheritedFetchedAt = hasRealShopName ? Number(previousShop.shopInfoFetchedAt || 0) : 0;
    const inheritedStatus = inheritedFetchedAt ? 'done' : 'pending';
    const previousInfoStatus = previousShop.shopInfoStatus || '';
    const normalizedInfoStatus = previousInfoStatus === 'fetching'
      ? 'pending'
      : (inheritedFetchedAt ? previousInfoStatus || inheritedStatus : (
        ['expired', 'failed'].includes(previousInfoStatus) ? previousInfoStatus : inheritedStatus
      ));
    const normalizedShopStatus = inheritedFetchedAt
      ? (previousShop.status || 'online')
      : ((previousShop.status === 'expired' || previousInfoStatus === 'expired') ? 'expired' : 'offline');

    return {
      id: record.shopId,
      name,
      account: previousShop.account || '',
      mallId: record.tokenInfo.mallId || previousShop.mallId || '',
      group: previousShop.group || '',
      remark: previousShop.remark || '',
      status: normalizedShopStatus,
      loginMethod: 'token',
      userAgent: record.tokenInfo.userAgent || previousShop.userAgent || '',
      bindTime: previousShop.bindTime || record.bindTime,
      category: previousShop.category || '待分类',
      balance: Number(previousShop.balance || 0),
      tokenFileName: record.fileName,
      tokenUpdatedAt: record.updatedAt,
      shopInfoStatus: normalizedInfoStatus || 'pending',
      shopInfoFetchedAt: inheritedFetchedAt,
      shopInfoLastAttemptAt: Number(previousShop.shopInfoLastAttemptAt || 0),
      shopInfoError: inheritedFetchedAt ? '' : (previousShop.shopInfoError || '')
    };
  }

  _disposeView(shopId) {
    const view = this.views.get(shopId);
    if (!view) return;
    if (this.activeShopId === shopId && this.mainWindow) {
      try { this.mainWindow.removeBrowserView(view); } catch {}
    }
    try { view.webContents.close(); } catch {}
    this.views.delete(shopId);
  }

  isSelectableShop(shop) {
    if (!shop?.id) return false;
    return !(shop.loginMethod === 'token' && shop.status === 'expired');
  }

  getPreferredActiveShopId(shops = this.getShopList(), preferredShopId = '') {
    const list = Array.isArray(shops) ? shops.filter(shop => shop?.id) : [];
    const candidateIds = [preferredShopId, this.activeShopId, this.store.get('activeShopId')].filter(Boolean);
    for (const candidateId of candidateIds) {
      const shop = list.find(item => item.id === candidateId);
      if (this.isSelectableShop(shop)) return candidateId;
    }
    return list.find(shop => this.isSelectableShop(shop))?.id || '';
  }

  syncActiveShopSelection(options = {}) {
    const shops = Array.isArray(options.shops) ? options.shops : this.getShopList();
    const targetShopId = this.getPreferredActiveShopId(shops, options.preferredShopId || '');
    if (!targetShopId) {
      if (this.activeShopId && this.views.has(this.activeShopId) && this.mainWindow) {
        try { this.mainWindow.removeBrowserView(this.views.get(this.activeShopId)); } catch {}
      }
      this.activeShopId = null;
      this.store.set('activeShopId', '');
      return null;
    }
    if (targetShopId === this.activeShopId) {
      this.store.set('activeShopId', targetShopId);
      return shops.find(item => item.id === targetShopId) || this._getShop(targetShopId) || null;
    }
    if (options.showView && this.mainWindow) {
      this.switchTo(targetShopId, options.loadUrl || null);
      return shops.find(item => item.id === targetShopId) || this._getShop(targetShopId) || null;
    }
    this.activeShopId = targetShopId;
    this.store.set('activeShopId', targetShopId);
    const nextShop = shops.find(item => item.id === targetShopId) || this._getShop(targetShopId) || null;
    if (options.emitEvent && this.mainWindow && nextShop) {
      this.mainWindow.webContents.send('shop-switched', { shopId: targetShopId, shop: nextShop });
    }
    return nextShop;
  }

  async syncShopsFromTokenFiles(options = {}) {
    if (!this.tokenFileStore) {
      return this.getShopList();
    }

    const broadcast = options.broadcast !== false;
    const forceApplyTokens = options.forceApplyTokens === true;
    const previousShops = this.store.get('shops') || [];
    const previousById = new Map(previousShops.map(shop => [shop.id, shop]));
    const previousByMallId = new Map(previousShops.filter(shop => shop.mallId).map(shop => [String(shop.mallId), shop]));
    const previousFiles = this.store.get('shopTokenFiles') || {};
    const records = this.tokenFileStore.listTokenRecords();
    const nextFiles = {};
    const nextShops = [];
    const cookieCountByShopId = {};
    const createdShopIds = [];
    const refreshedShopIds = [];
    const removedShopIds = new Set([
      ...Object.keys(previousFiles),
      ...previousShops.map(shop => shop.id)
    ]);

    for (const record of records) {
      removedShopIds.delete(record.shopId);
      const previousShop = previousById.get(record.shopId) || previousByMallId.get(record.tokenInfo.mallId) || {};
      const nextShop = this._buildShopFromTokenRecord(record, previousShop);
      nextShops.push(nextShop);
      nextFiles[record.shopId] = {
        fileName: record.fileName,
        filePath: record.filePath,
        updatedAt: record.updatedAt
      };

      const previousFile = previousFiles[record.shopId];
      const shouldRefresh = forceApplyTokens || !previousFile
        || previousFile.updatedAt !== record.updatedAt
        || previousFile.filePath !== record.filePath;

      this._saveTokenInfo(record.shopId, this._buildTokenInfo({
        ...record.tokenData,
        userAgent: nextShop.userAgent
      }, nextShop.mallId, record.tokenInfo.userId, record.tokenInfo.token));

      if (shouldRefresh) {
        cookieCountByShopId[record.shopId] = await this._applyTokenDataToSession(record.shopId, record.tokenData);
        const view = this.views.get(record.shopId);
        if (view && nextShop.userAgent) {
          view.webContents.setUserAgent(nextShop.userAgent);
        }
        this.onTokenUpdated(record.shopId);
        if (previousFile) refreshedShopIds.push(record.shopId);
        else createdShopIds.push(record.shopId);
      }
    }

    for (const shopId of removedShopIds) {
      this._disposeView(shopId);
      this.clearTokenInfo(shopId);
      this.store.delete(`shopCookies.${shopId}`);
      this.onTokenUpdated(shopId);
    }

    this.store.set('shopTokenFiles', nextFiles);
    this.store.set('shops', nextShops);
    const previousActiveShopId = this.activeShopId || this.store.get('activeShopId') || '';
    this.syncActiveShopSelection({
      shops: nextShops,
      preferredShopId: previousActiveShopId,
      showView: broadcast && !!this.mainWindow
    });

    if (broadcast && this.mainWindow) {
      this.mainWindow.webContents.send('shop-list-updated', { shops: nextShops });
    }

    return {
      shops: nextShops,
      cookieCountByShopId,
      createdShopIds,
      refreshedShopIds
    };
  }

  saveShopMetadata(shops = []) {
    const currentShops = this.store.get('shops') || [];
    const updates = new Map((shops || []).map(shop => [shop.id, shop]));
    const merged = currentShops.map(shop => {
      const next = updates.get(shop.id);
      if (!next) return shop;
      return {
        ...shop,
        name: next.name || shop.name,
        account: next.account || '',
        group: next.group || '',
        remark: next.remark || '',
        category: next.category || shop.category,
        balance: Number(next.balance || 0),
        status: next.status || shop.status
      };
    });
    this.store.set('shops', merged);
    if (this.mainWindow) {
      this.mainWindow.webContents.send('shop-list-updated', { shops: merged });
    }
    return true;
  }

  _isMerchantUrl(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname.endsWith('.pinduoduo.com');
    } catch {
      return true;
    }
  }

  _createView(shopId) {
    const shop = this._getShop(shopId);
    const view = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'pdd-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        partition: this._getPartition(shopId),
        webgl: false
      }
    });

    // 禁用 WebRTC（消除 STUN 服务器解析错误，PDD 语音客服功能不影响自动回复）
    view.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission === 'media' || permission === 'geolocation') return callback(false);
      callback(true);
    });

    if (shop?.userAgent) {
      view.webContents.setUserAgent(shop.userAgent);
    }

    // 拦截页面内导航，非商家后台域名的链接用系统浏览器打开
    view.webContents.on('will-navigate', (event, url) => {
      if (!this._isMerchantUrl(url)) {
        event.preventDefault();
        this.onLog(`[店铺:${shop?.name || shopId}] 外部链接用浏览器打开: ${url}`);
        shell.openExternal(url);
      }
    });

    // 拦截新窗口请求，商家后台链接在当前 view 加载，其他用系统浏览器打开
    view.webContents.setWindowOpenHandler(({ url }) => {
      this.onLog(`[店铺:${shop?.name || shopId}] 拦截新窗口: ${url}`);
      if (url?.startsWith('http')) {
        if (this._isMerchantUrl(url)) {
          this.mainWindow.webContents.send('pdd-navigated', { url, fromPopup: true });
          view.webContents.loadURL(url);
        } else {
          shell.openExternal(url);
        }
      }
      return { action: 'deny' };
    });

    // dom-ready 比 did-finish-load 更早，在子资源加载前就注入引导抑制
    view.webContents.on('dom-ready', () => {
      ShopManager._suppressGuides(view);
    });

    view.webContents.on('did-finish-load', () => {
      const url = view.webContents.getURL();

      if (url.includes('/other/404')) {
        this.onLog(`[店铺:${shop?.name || shopId}] 检测到 404，跳转客服页面`);
        this.store.set('chatUrl', '');
        const fallback = url.includes('chat-merchant') ? PDD_BASE_URL : PDD_CHAT_URL;
        view.webContents.loadURL(fallback);
        return;
      }

      this.onInjectScript(view);
      ShopManager._suppressGuides(view);
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-page-loaded', { url });
      }
      setTimeout(() => this.onDetectChat(view, shopId), 2000);
    });

    view.webContents.on('did-navigate-in-page', (event, url) => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-navigated', { url });
      }
      this.onInjectScript(view);
      ShopManager._suppressGuides(view);
      setTimeout(() => this.onDetectChat(view, shopId), 2000);
    });

    view.webContents.on('did-navigate', (event, url) => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-navigated', { url });
      }

      // 扫码登录检测：从登录页跳转到非登录页，说明登录成功
      if (this._pendingQRShopId === shopId && !url.includes('/login')) {
        this._onQRLoginSuccess(shopId, url);
      }
    });

    this.views.set(shopId, view);
    this.onNetworkMonitor(view, shopId);
    return view;
  }

  getOrCreateView(shopId) {
    if (this.views.has(shopId)) return this.views.get(shopId);
    return this._createView(shopId);
  }

  getActiveView() {
    if (!this.activeShopId) return null;
    return this.views.get(this.activeShopId) || null;
  }

  getActiveShop() {
    if (!this.activeShopId) return null;
    return this._getShop(this.activeShopId);
  }

  getActiveShopId() {
    return this.activeShopId;
  }

  // ---- 店铺切换 ----

  switchTo(shopId, loadUrl = null) {
    const shop = this._getShop(shopId);
    if (!shop) return false;
    if (!this.isSelectableShop(shop)) return false;

    // 先移除当前 view
    if (this.activeShopId && this.views.has(this.activeShopId)) {
      try { this.mainWindow.removeBrowserView(this.views.get(this.activeShopId)); } catch {}
    }

    const view = this.getOrCreateView(shopId);
    this.activeShopId = shopId;
    this.store.set('activeShopId', shopId);

    this.mainWindow.setBrowserView(view);
    this._resizeView(view);

    // 如果 view 还没加载过内容，加载客服页面
    const currentUrl = view.webContents.getURL();
    if (loadUrl) {
      view.webContents.loadURL(loadUrl);
    } else if (!currentUrl || currentUrl === 'about:blank') {
      view.webContents.loadURL(this._getChatUrl());
    }

    this.mainWindow.webContents.send('shop-switched', { shopId, shop });
    this.onLog(`[PDD助手] 已切换到店铺: ${shop.name}`);
    return true;
  }

  showActiveView() {
    if (!this.activeShopId) return;
    const view = this.views.get(this.activeShopId);
    if (view) {
      this.mainWindow.setBrowserView(view);
      this._resizeView(view);
    }
  }

  hideActiveView() {
    if (!this.activeShopId) return;
    const view = this.views.get(this.activeShopId);
    if (view) {
      try { this.mainWindow.removeBrowserView(view); } catch {}
    }
  }

  resizeActiveView() {
    if (!this.activeShopId) return;
    const view = this.views.get(this.activeShopId);
    if (view) this._resizeView(view);
  }

  _resizeView(view) {
    const bounds = this.mainWindow.getContentBounds();
    view.setBounds({
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_HEIGHT + CHAT_BAR_HEIGHT,
      width: bounds.width - SIDEBAR_WIDTH,
      height: bounds.height - TOOLBAR_HEIGHT - CHAT_BAR_HEIGHT - STATUSBAR_HEIGHT
    });
  }

  // ---- 添加店铺: Token 导入 ----

  async addByToken(filePath) {
    if (this.tokenFileStore) {
      if (!filePath) {
        const { canceled, filePaths } = await dialog.showOpenDialog(this.mainWindow, {
          title: '选择 Token 文件',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile']
        });
        if (canceled || !filePaths.length) return { canceled: true };
        filePath = filePaths[0];
      }

      const sourceFileName = path.basename(filePath);
      const imported = this.tokenFileStore.importTokenFile(filePath);
      const tokenAnalysis = this._analyzeTokenData(imported.tokenData, imported.tokenInfo);
      const importedShopIds = Array.isArray(imported.records) ? imported.records.map(record => record.shopId) : [];
      const { shops, cookieCountByShopId, createdShopIds } = await this.syncShopsFromTokenFiles({ broadcast: true });
      const targetShopId = importedShopIds.find(shopId => createdShopIds.includes(shopId)) || importedShopIds[0] || '';
      const targetShop = shops.find(shop => shop.id === targetShopId) || null;
      const createdCount = importedShopIds.filter(shopId => createdShopIds.includes(shopId)).length;
      const refreshedCount = importedShopIds.length - createdCount;
      const created = createdCount > 0;
      if (targetShop) {
        this.switchTo(targetShop.id);
        this._detectShopName(targetShop.id);
      }
      for (const shopId of importedShopIds) {
        if (!createdShopIds.includes(shopId)) continue;
        const createdShop = shops.find(shop => shop.id === shopId);
        if (createdShop) {
          this.mainWindow.webContents.send('shop-added', { shop: createdShop });
        }
      }
      if (importedShopIds.length > 1) {
        if (targetShopId) {
          this._fetchAndApplyShopProfile(targetShopId).catch(() => {});
        }
        this.startShopInfoHydrationLoop(5000);
      } else if (targetShopId) {
        this._fetchAndApplyShopProfile(targetShopId).catch(() => {});
      }
      this.onLog(`[PDD助手] Token 文件已纳入管理: ${sourceFileName}, 导入 ${importedShopIds.length || 0} 家店铺`);
      return {
        shopId: targetShopId,
        cookieCount: importedShopIds.reduce((sum, shopId) => sum + Number(cookieCountByShopId[shopId] || 0), 0),
        mallId: targetShop?.mallId || imported.tokenInfo.mallId || '',
        refreshed: createdCount === 0,
        created,
        fileName: imported.fileName,
        sourceFileName,
        shopName: targetShop?.name || '',
        shopCount: shops.length,
        importedCount: importedShopIds.length,
        createdCount,
        refreshedCount,
        multiShopImport: importedShopIds.length > 1,
        passIdCount: tokenAnalysis.passIdCount,
        passIdIdentityCount: tokenAnalysis.passIdIdentityCount,
        tokenMatchesPassId: tokenAnalysis.tokenMatchesPassId,
        multiPassIdSingleToken: tokenAnalysis.multiPassIdSingleToken && importedShopIds.length <= 1
      };
    }

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

    // 解码 mallId 用于去重
    const decodedToken = this._decodeWindowsAppShopToken(tokenData);
    const mallId = decodedToken.mallId || null;
    const userId = decodedToken.userId || null;
    const tokenStr = decodedToken.token || null;
    const tokenAnalysis = this._analyzeTokenData(tokenData, decodedToken);

    // 检查是否已有相同 mallId 的店铺
    const shops = this.store.get('shops') || [];
    const existing = mallId ? shops.find(s => s.mallId === mallId) : null;
    if (existing) {
      // 更新已有店铺的 Cookie
      const refreshed = await this._refreshTokenForShop(existing.id, tokenData, mallId, userId, tokenStr);
      return {
        ...refreshed,
        passIdCount: tokenAnalysis.passIdCount,
        passIdIdentityCount: tokenAnalysis.passIdIdentityCount,
        tokenMatchesPassId: tokenAnalysis.tokenMatchesPassId,
        multiPassIdSingleToken: tokenAnalysis.multiPassIdSingleToken
      };
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

    this._saveTokenInfo(shopId, this._buildTokenInfo(tokenData, mallId, userId, tokenStr));

    this.switchTo(shopId);

    // 页面加载后尝试检测店铺名称
    this._detectShopName(shopId);
    this._fetchAndApplyShopProfile(shopId).catch(() => {});

    this.mainWindow.webContents.send('shop-added', { shop });
    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 导入完成: ${cookieCount} Cookie, mallId=${mallId}, shopId=${shopId}`);

    return {
      shopId,
      cookieCount,
      mallId,
      passIdCount: tokenAnalysis.passIdCount,
      passIdIdentityCount: tokenAnalysis.passIdIdentityCount,
      tokenMatchesPassId: tokenAnalysis.tokenMatchesPassId,
      multiPassIdSingleToken: tokenAnalysis.multiPassIdSingleToken
    };
  }

  async _refreshTokenForShop(shopId, tokenData, mallId, userId, tokenStr) {
    const cookieCount = await this._applyTokenDataToSession(shopId, tokenData);

    // 更新 UA
    const shops = this.store.get('shops') || [];
    const shop = shops.find(s => s.id === shopId);
    if (shop && tokenData.userAgent) {
      shop.userAgent = tokenData.userAgent;
      shop.status = 'online';
      this.store.set('shops', shops);
    }

    // 更新内存中 BrowserView 的 UA
    const view = this.views.get(shopId);
    if (view && tokenData.userAgent) {
      view.webContents.setUserAgent(tokenData.userAgent);
    }

    this._saveTokenInfo(shopId, this._buildTokenInfo({
      ...tokenData,
      userAgent: tokenData.userAgent || shop?.userAgent || ''
    }, mallId || shop?.mallId || '', userId, tokenStr));
    this.onTokenUpdated(shopId);

    this.switchTo(shopId);
    if (view) view.webContents.loadURL(this._getChatUrl());
    this._fetchAndApplyShopProfile(shopId).catch(() => {});

    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 已刷新: shopId=${shopId}, ${cookieCount} Cookie`);

    return { shopId, cookieCount, mallId, refreshed: true };
  }

  // ---- 添加店铺: 扫码登录 ----

  async addByQRCode() {
    if (this.tokenFileStore) {
      return { error: '当前店铺管理仅支持 Token 文件模式' };
    }

    const shopId = 'shop_' + Date.now();

    const shop = {
      id: shopId,
      name: '扫码登录中...',
      account: '',
      mallId: '',
      group: '',
      remark: '',
      status: 'offline',
      loginMethod: 'qrcode',
      userAgent: '',
      bindTime: new Date().toISOString().split('T')[0],
      category: '待分类',
      balance: 0
    };

    const shops = this.store.get('shops') || [];
    shops.push(shop);
    this.store.set('shops', shops);

    this._pendingQRShopId = shopId;
    this.switchTo(shopId, PDD_LOGIN_URL);

    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog('[PDD助手] 请扫描二维码登录新店铺');

    return { shopId, waitingForLogin: true };
  }

  _onQRLoginSuccess(shopId, url) {
    this._pendingQRShopId = null;

    const shops = this.store.get('shops') || [];
    const shop = shops.find(s => s.id === shopId);
    const view = this.views.get(shopId);
    if (shop) {
      shop.status = 'online';
      shop.name = `新店铺 ${shopId.slice(-6)}`;
      shop.userAgent = view?.webContents.getUserAgent() || shop.userAgent || '';
      this.store.set('shops', shops);
    }

    this._detectShopName(shopId);
    this._fetchAndApplyShopProfile(shopId).catch(() => {});

    this.mainWindow.webContents.send('shop-login-success', { shopId, shop });
    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] 扫码登录成功: shopId=${shopId}`);
  }

  // 从页面上检测店铺名称
  _detectShopName(shopId) {
    const view = this.views.get(shopId);
    if (!view) return;

    const detect = () => {
      view.webContents.executeJavaScript(`
        (function() {
          // 尝试从页面 title 或常见位置获取店铺名
          var mallName = '';
          // 拼多多商家后台通常在 cookie 或页面某处有店铺名称
          var el = document.querySelector('.shop-name, .mall-name, [class*="shopName"], [class*="mallName"]');
          if (el) mallName = el.textContent.trim();
          if (!mallName) {
            var title = document.title || '';
            if (title && !title.includes('登录') && !title.includes('拼多多商家后台')) mallName = title;
          }
          return mallName;
        })()
      `).then(name => {
        if (name) this._updateShopName(shopId, name);
      }).catch(() => {});
    };

    setTimeout(detect, 3000);
    setTimeout(detect, 8000);
  }

  _updateShopName(shopId, name) {
    const shops = this.store.get('shops') || [];
    const shop = shops.find(s => s.id === shopId);
    if (!shop || (shop.name && !shop.name.startsWith('店铺 ') && !shop.name.startsWith('新店铺 ') && shop.name !== '扫码登录中...')) return;
    shop.name = name;
    this.store.set('shops', shops);
    this.mainWindow.webContents.send('shop-list-updated', { shops });
  }

  _updateShopInfoState(shopId, patch = {}) {
    const shops = this.store.get('shops') || [];
    const shop = shops.find(item => item.id === shopId);
    if (!shop) return null;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (shop[key] === value) continue;
      shop[key] = value;
      changed = true;
    }
    if (changed) {
      this.store.set('shops', shops);
      this.mainWindow?.webContents.send('shop-list-updated', { shops });
    }
    return shop;
  }

  _isAuthExpiredError(error) {
    const code = Number(error?.errorCode || error?.statusCode || 0);
    return !!error?.authExpired || [40001, 43001, 43002].includes(code);
  }

  _applyShopProfile(shopId, profile = {}) {
    if (!shopId || !profile || typeof profile !== 'object') return null;
    const shops = this.store.get('shops') || [];
    const shop = shops.find(item => item.id === shopId);
    if (!shop) return null;
    const nextName = profile.mallName || shop.name || '';
    const nextAccount = profile.account || shop.account || '';
    const nextMallId = profile.mallId ? String(profile.mallId) : (shop.mallId || '');
    const nextCategory = profile.category || shop.category || '';
    let changed = false;
    if (nextName && nextName !== shop.name) {
      shop.name = nextName;
      changed = true;
    }
    if (nextAccount !== shop.account) {
      shop.account = nextAccount;
      changed = true;
    }
    if (nextMallId && nextMallId !== shop.mallId) {
      shop.mallId = nextMallId;
      changed = true;
    }
    if (nextCategory && nextCategory !== shop.category) {
      shop.category = nextCategory;
      changed = true;
    }
    shop.shopInfoStatus = 'done';
    shop.shopInfoFetchedAt = Date.now();
    shop.shopInfoError = '';
    if (shop.status !== 'online') {
      shop.status = 'online';
    }
    changed = true;
    if (changed) {
      this.store.set('shops', shops);
      this.mainWindow?.webContents.send('shop-list-updated', { shops });
    }
    return shop;
  }

  async _fetchAndApplyShopProfile(shopId) {
    if (!shopId) return null;
    if (this._shopInfoFetchingShopId === shopId) return null;
    const client = this.getApiClient(shopId);
    if (!client) return null;
    this._shopInfoFetchingShopId = shopId;
    this._updateShopInfoState(shopId, {
      shopInfoStatus: 'fetching',
      shopInfoLastAttemptAt: Date.now(),
      shopInfoError: ''
    });
    try {
      await client.initSession(true);
      const profile = await client.getShopProfile(true);
      const hasMallName = !!String(profile?.mallName || '').trim();
      if (!hasMallName) {
        throw new Error('接口未返回真实店铺名称');
      }
      const shop = this._applyShopProfile(shopId, profile);
      if (shop) {
        this.onLog(`[PDD助手] 已通过接口刷新店铺信息: ${shop.name || shop.id}`);
      }
      return shop;
    } catch (error) {
      const authExpired = this._isAuthExpiredError(error);
      this._updateShopInfoState(shopId, {
        shopInfoStatus: authExpired ? 'expired' : 'failed',
        shopInfoError: error.message || String(error),
        ...(authExpired ? { status: 'expired' } : {})
      });
      this.onLog(`[PDD助手] 通过接口获取店铺信息失败: ${shopId}, ${error.message || error}`);
      return null;
    } finally {
      if (this._shopInfoFetchingShopId === shopId) {
        this._shopInfoFetchingShopId = '';
      }
    }
  }

  async refreshShopProfile(shopId) {
    const targetShopId = shopId || this.getActiveShopId();
    if (!targetShopId) {
      return { success: false, error: '未找到店铺' };
    }
    if (this._shopInfoFetchingShopId === targetShopId) {
      return { success: false, fetching: true, error: '店铺信息获取中，请稍候' };
    }
    const shop = await this._fetchAndApplyShopProfile(targetShopId);
    const nextShop = (this.store.get('shops') || []).find(item => item.id === targetShopId) || null;
    if (!shop) {
      return {
        success: false,
        shopId: targetShopId,
        error: nextShop?.shopInfoError || '店铺信息获取失败',
        status: nextShop?.shopInfoStatus || 'failed'
      };
    }
    return {
      success: true,
      shopId: targetShopId,
      shop,
      status: nextShop?.shopInfoStatus || 'done'
    };
  }

  _pickNextPendingShopForProfile() {
    const shops = this.store.get('shops') || [];
    return shops.find(shop => shop.loginMethod === 'token' && !shop.shopInfoFetchedAt && (shop.shopInfoStatus || 'pending') === 'pending') || null;
  }

  startShopInfoHydrationLoop(intervalMs = 5000) {
    if (this._shopInfoTimer) return;
    const run = async () => {
      const nextShop = this._pickNextPendingShopForProfile();
      if (!nextShop) {
        this._shopInfoTimer = null;
        return;
      }
      this._shopInfoTimer = setTimeout(run, intervalMs);
      await this._fetchAndApplyShopProfile(nextShop.id);
    };
    this._shopInfoTimer = setTimeout(run, intervalMs);
  }

  stopShopInfoHydrationLoop() {
    if (!this._shopInfoTimer) return;
    clearTimeout(this._shopInfoTimer);
    this._shopInfoTimer = null;
  }

  // ---- 店铺管理 ----

  removeShop(shopId) {
    if (this.tokenFileStore) {
      const removed = this.tokenFileStore.removeTokenFile(shopId);
      if (!removed) return false;
      this._disposeView(shopId);
      this.clearTokenInfo(shopId);
      this.store.delete(`shopCookies.${shopId}`);
      this.onTokenUpdated(shopId);
      this.syncShopsFromTokenFiles({ broadcast: true }).catch(err => {
        this.onLog(`[PDD助手] 同步 Token 店铺失败: ${err.message}`);
      });
      return true;
    }

    // 不能删除当前活跃且唯一的店铺...或者可以
    const view = this.views.get(shopId);
    if (view) {
      if (this.activeShopId === shopId) {
        try { this.mainWindow.removeBrowserView(view); } catch {}
      }
      view.webContents.close();
      this.views.delete(shopId);
    }

    // 清除 partition 数据
    const ses = session.fromPartition(this._getPartition(shopId));
    ses.clearStorageData().catch(() => {});

    let shops = this.store.get('shops') || [];
    shops = shops.filter(s => s.id !== shopId);
    this.store.set('shops', shops);

    // 如果删除的是当前活跃店铺，切换到下一个
    if (this.activeShopId === shopId) {
      this.activeShopId = null;
      this.syncActiveShopSelection({
        shops,
        showView: shops.length > 0
      });
    }

    this.mainWindow.webContents.send('shop-list-updated', { shops });
    this.onTokenUpdated(shopId);
    this.clearTokenInfo(shopId);
    return true;
  }

  getShopList() {
    return this.store.get('shops') || [];
  }

  // ---- Cookie 持久化 ----

  async saveCookies(shopId) {
    const view = this.views.get(shopId);
    if (!view) return;
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
    for (const shopId of this.views.keys()) {
      await this.saveCookies(shopId);
    }
  }

  // ---- 弹窗自动关闭（主进程驱动，结果可见） ----

  static _suppressGuides(view) {
    if (!view || view.webContents.isDestroyed()) return;
    if (view._guideScanTimer) clearInterval(view._guideScanTimer);
    if (view._guideScanTimeouts) view._guideScanTimeouts.forEach(t => clearTimeout(t));

    const wc = view.webContents;

    // 不再用 CSS 隐藏 .layer —— 改为扫描脚本主动点击关闭按钮

    // localStorage 预写（一次性）
    wc.executeJavaScript(`(function(){
      if (window.__PDD_LS_SEEDED__) return;
      window.__PDD_LS_SEEDED__ = true;
      ['guide_finished','guideFinished','guide_showed','guide_closed',
       'has_shown_guide','hasShownGuide','chat_guide_done','chatGuideDone',
       'newbie_guide_done','newbieGuideDone','feature_guide_done',
       'onboarding_complete','onboardingComplete','guide_step_done',
       'im_guide_done','imGuideDone','merchant_guide_done',
       'chat_guide_closed','chatGuideClosed','function_guide_done'
      ].forEach(function(k){ try{localStorage.setItem(k,'1');sessionStorage.setItem(k,'1');}catch(e){} });
    })()`).catch(() => {});

    const SCAN_JS = `(function(){
      var DISMISS = ['我知道了','知道了','我知道啦','不再提示','关闭引导','跳过','下次再说','暂不设置'];
      var r = { clicked: 0, actions: [] };

      // 策略1: 点击关闭图标（close-icon / close-btn 等）
      var closeSelectors = '.close-icon, .close-btn, .dialog-close, .modal-close, [class*="close-icon"], [class*="closeIcon"]';
      document.querySelectorAll(closeSelectors).forEach(function(el) {
        var rect = el.getBoundingClientRect();
        if (rect.width < 3 || rect.height < 3) return;
        el.click();
        r.clicked++;
        r.actions.push('close-icon:' + (el.className||'').toString().slice(0,30) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
      });

      // 策略2: 移除高 z-index 的全屏遮罩层和弹窗内容
      document.querySelectorAll('.layer').forEach(function(el) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          el.remove();
          r.clicked++;
          r.actions.push('remove:.layer');
        }
      });

      // 策略3: 移除 position:fixed 的高 z-index 弹窗内容（排除 React Portal 根容器）
      document.querySelectorAll('*').forEach(function(el) {
        var cs = getComputedStyle(el);
        var zi = parseInt(cs.zIndex) || 0;
        if (cs.position !== 'fixed' || zi < 3000 || el.offsetWidth < 10) return;
        if (el === document.body || el === document.documentElement) return;
        // 排除 React Portal 根容器（body 直接子元素，无 class，随机数字 ID）
        if (el.parentElement === document.body && !el.className && /^0\\.\\d+$/.test(el.id)) return;
        el.remove();
        r.clicked++;
        r.actions.push('remove:fixed-z' + zi + ':' + el.tagName + '.' + (el.className||'').toString().slice(0,25));
      });

      // 策略4: 文本匹配兜底（针对传统弹窗按钮）
      if (r.clicked === 0) {
        var all = document.querySelectorAll('button, [role="button"], div, span, a');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var t = (el.innerText || el.textContent || '').replace(/[\\s\\u00a0]+/g, '').trim();
          if (t.length === 0 || t.length > 10) continue;
          var hit = false;
          for (var j = 0; j < DISMISS.length; j++) {
            if (t === DISMISS[j]) { hit = true; break; }
          }
          if (!hit) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          el.click();
          r.clicked++;
          r.actions.push('text-click:' + t + '<' + el.tagName + '>');
          break;
        }
      }

      return r;
    })()`;

    let scanCount = 0;
    const doScan = async () => {
      if (wc.isDestroyed()) { clearInterval(view._guideScanTimer); return; }
      scanCount++;
      try {
        const r = await wc.executeJavaScript(SCAN_JS);
        if (r.clicked > 0) {
          console.log(`[PDD助手] 自动关闭弹窗(${r.clicked}项): [${r.actions.join(', ')}] (第${scanCount}次扫描)`);
        } else if (scanCount <= 5) {
          console.log(`[PDD助手] 弹窗扫描#${scanCount}: 页面干净`);
        }
      } catch (err) {
        console.error(`[PDD助手] 弹窗扫描失败:`, err.message);
      }
    };

    view._guideScanTimeouts = [
      setTimeout(doScan, 500),
      setTimeout(doScan, 1500),
      setTimeout(doScan, 3000),
      setTimeout(doScan, 5000)
    ];

    // 持续扫描（每 2 秒，最多 60 秒）
    view._guideScanTimer = setInterval(() => {
      if (scanCount >= 30) { clearInterval(view._guideScanTimer); return; }
      doScan();
    }, 2000);
  }

  // ---- 内部辅助 ----

  _getShop(shopId) {
    const shops = this.store.get('shops') || [];
    return shops.find(s => s.id === shopId) || null;
  }
}

module.exports = { ShopManager };
