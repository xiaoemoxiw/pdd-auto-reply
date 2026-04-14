const { BrowserView, BrowserWindow, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const PDD_CHAT_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html';
const PDD_HOME_URL = 'https://mms.pinduoduo.com/home';
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
    this._overlayTopOffset = 0;
    this._overlayVisible = false;
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

  _getAvailabilityStatus(shop = {}) {
    return shop.availabilityStatus || shop.status || 'offline';
  }

  _getShopNameStatus(shop = {}) {
    if (shop.shopNameStatus) return shop.shopNameStatus;
    return this._hasRealShopName(shop.name || '') ? 'resolved' : 'pending';
  }

  _normalizeShopInfoStatus(status = '', fallback = 'pending') {
    const normalized = String(status || '').trim();
    if (normalized === 'expired') return 'failed';
    if (['pending', 'fetching', 'done', 'partial', 'failed'].includes(normalized)) {
      return normalized;
    }
    return fallback;
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
    const previousInfoStatus = this._normalizeShopInfoStatus(previousShop.shopInfoStatus || '');
    const canInheritFetchedAt = hasRealShopName || ['done', 'partial'].includes(previousInfoStatus);
    const inheritedFetchedAt = canInheritFetchedAt ? Number(previousShop.shopInfoFetchedAt || 0) : 0;
    const inheritedStatus = inheritedFetchedAt ? 'done' : 'pending';
    const normalizedInfoStatus = previousInfoStatus === 'fetching'
      ? 'pending'
      : (inheritedFetchedAt ? previousInfoStatus || inheritedStatus : (
        previousInfoStatus === 'failed' ? previousInfoStatus : inheritedStatus
      ));
    const previousAvailabilityStatus = this._getAvailabilityStatus(previousShop);
    const normalizedShopStatus = inheritedFetchedAt
      ? (previousAvailabilityStatus || 'online')
      : (previousAvailabilityStatus === 'expired' ? 'expired' : 'offline');
    const normalizedShopNameStatus = hasRealShopName
      ? 'resolved'
      : (inheritedFetchedAt ? 'missing' : 'pending');

    return {
      id: record.shopId,
      name,
      account: previousShop.account || '',
      mallId: record.tokenInfo.mallId || previousShop.mallId || '',
      group: previousShop.group || '',
      remark: previousShop.remark || '',
      status: normalizedShopStatus,
      availabilityStatus: normalizedShopStatus,
      shopNameStatus: normalizedShopNameStatus,
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
      shopInfoError: normalizedInfoStatus === 'failed'
        ? (previousShop.shopInfoError || '')
        : ''
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
    return !(shop.loginMethod === 'token' && this._getAvailabilityStatus(shop) === 'expired');
  }

  isUserSelectableShop(shop) {
    return this.isSelectableShop(shop) && this._getAvailabilityStatus(shop) === 'online';
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
    const managedShopIds = new Set(Object.keys(previousFiles));
    const preservedShopIds = new Set(
      previousShops
        .filter(shop => !managedShopIds.has(shop.id))
        .map(shop => shop.id)
    );
    const records = this.tokenFileStore.listTokenRecords();
    const nextFiles = {};
    const managedShops = [];
    const cookieCountByShopId = {};
    const createdShopIds = [];
    const refreshedShopIds = [];
    const removedShopIds = new Set(Object.keys(previousFiles));

    for (const record of records) {
      removedShopIds.delete(record.shopId);
      const previousShop = previousById.get(record.shopId) || previousByMallId.get(record.tokenInfo.mallId) || {};
      if (previousShop?.id && preservedShopIds.has(previousShop.id) && previousShop.loginMethod === 'token') {
        preservedShopIds.delete(previousShop.id);
        if (previousShop.id !== record.shopId) {
          removedShopIds.add(previousShop.id);
        }
      }
      const nextShop = this._buildShopFromTokenRecord(record, previousShop);
      managedShops.push(nextShop);
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

    const preservedShops = previousShops.filter(shop => preservedShopIds.has(shop.id));
    const nextShops = managedShops.length || Object.keys(previousFiles).length
      ? [...preservedShops, ...managedShops]
      : previousShops;

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
        status: next.status || shop.status,
        availabilityStatus: next.availabilityStatus || next.status || shop.availabilityStatus || shop.status,
        shopNameStatus: next.shopNameStatus || shop.shopNameStatus || (this._hasRealShopName(next.name || shop.name || '') ? 'resolved' : 'pending')
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
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-page-loaded', { url });
      }
      setTimeout(() => this.onDetectChat(view, shopId), 2000);
    });

    view.webContents.on('did-start-loading', () => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-page-loading', {
          url: view.webContents.getURL()
        });
      }
    });

    view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3 || isMainFrame === false) return;
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-page-failed', {
          url: validatedURL || view.webContents.getURL(),
          errorCode,
          errorDescription: errorDescription || '页面加载失败'
        });
      }
    });

    view.webContents.on('did-navigate-in-page', (event, url) => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-navigated', { url });
      }
      this.onInjectScript(view);
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

    view.webContents.on('render-process-gone', (event, details = {}) => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-page-failed', {
          url: view.webContents.getURL(),
          reason: 'render-process-gone',
          errorDescription: details.reason || '嵌入页进程已退出'
        });
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
      this._overlayVisible = false;
      this._overlayTopOffset = 0;
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
    this._overlayVisible = false;
  }

  resizeActiveView() {
    if (!this.activeShopId) return;
    const view = this.views.get(this.activeShopId);
    if (view) this._resizeView(view);
  }

  isOverlayVisible() {
    return !!this._overlayVisible;
  }

  showActiveViewOverlay(topOffset = 0) {
    if (!this.activeShopId) return;
    const view = this.views.get(this.activeShopId);
    if (!view) return;
    const normalizedOffset = Math.max(0, Number(topOffset || 0));
    this._overlayTopOffset = normalizedOffset;
    this._overlayVisible = true;
    this.mainWindow.setBrowserView(view);
    this._resizeViewOverlay(view);
  }

  resizeActiveViewOverlay() {
    if (!this._overlayVisible) return;
    if (!this.activeShopId) return;
    const view = this.views.get(this.activeShopId);
    if (!view) return;
    this._resizeViewOverlay(view);
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

  _resizeViewOverlay(view) {
    const bounds = this.mainWindow.getContentBounds();
    const topOffset = Math.max(0, Number(this._overlayTopOffset || 0));
    view.setBounds({
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_HEIGHT + topOffset,
      width: bounds.width - SIDEBAR_WIDTH,
      height: bounds.height - TOOLBAR_HEIGHT - topOffset - STATUSBAR_HEIGHT
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
      status: 'offline',
      availabilityStatus: 'offline',
      shopNameStatus: 'pending',
      loginMethod: 'token',
      userAgent: tokenData.userAgent || '',
      bindTime: new Date().toISOString().split('T')[0],
      category: '待分类',
      balance: 0,
      shopInfoStatus: 'pending',
      shopInfoFetchedAt: 0,
      shopInfoLastAttemptAt: 0,
      shopInfoError: ''
    };

    shops.push(shop);
    this.store.set('shops', shops);

    this._saveTokenInfo(shopId, this._buildTokenInfo(tokenData, mallId, userId, tokenStr));

    this.switchTo(shopId);

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
      shop.status = 'offline';
      shop.availabilityStatus = 'offline';
      if (!shop.shopNameStatus) {
        shop.shopNameStatus = this._hasRealShopName(shop.name || '') ? 'resolved' : 'pending';
      }
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
      availabilityStatus: 'offline',
      shopNameStatus: 'pending',
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
      shop.availabilityStatus = 'online';
      shop.name = `新店铺 ${shopId.slice(-6)}`;
      shop.shopNameStatus = 'pending';
      shop.userAgent = view?.webContents.getUserAgent() || shop.userAgent || '';
      this.store.set('shops', shops);
    }

    this._fetchAndApplyShopProfile(shopId).catch(() => {});

    this.mainWindow.webContents.send('shop-login-success', { shopId, shop });
    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] 扫码登录成功: shopId=${shopId}`);
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
    if (patch.status && !patch.availabilityStatus && shop.availabilityStatus !== patch.status) {
      shop.availabilityStatus = patch.status;
      changed = true;
    }
    if (patch.availabilityStatus && !patch.status && shop.status !== patch.availabilityStatus) {
      shop.status = patch.availabilityStatus;
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

  _applyShopProfile(shopId, profile = {}, options = {}) {
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
    const nextInfoStatus = this._normalizeShopInfoStatus(options.shopInfoStatus || 'done', 'done');
    const nextInfoError = options.shopInfoError || '';
    const nextShopNameStatus = options.shopNameStatus || (this._hasRealShopName(nextName) ? 'resolved' : 'missing');
    const fetchedAt = Number(options.shopInfoFetchedAt || Date.now()) || Date.now();
    if (shop.shopInfoStatus !== nextInfoStatus) {
      shop.shopInfoStatus = nextInfoStatus;
      changed = true;
    }
    if (shop.shopInfoFetchedAt !== fetchedAt) {
      shop.shopInfoFetchedAt = fetchedAt;
      changed = true;
    }
    if (shop.shopInfoError !== nextInfoError) {
      shop.shopInfoError = nextInfoError;
      changed = true;
    }
    if (shop.shopNameStatus !== nextShopNameStatus) {
      shop.shopNameStatus = nextShopNameStatus;
      changed = true;
    }
    if (shop.availabilityStatus !== 'online') {
      shop.availabilityStatus = 'online';
      changed = true;
    }
    if (shop.status !== 'online') {
      shop.status = 'online';
      changed = true;
    }
    if (changed) {
      this.store.set('shops', shops);
      this.mainWindow?.webContents.send('shop-list-updated', { shops });
    }
    return shop;
  }

  _updateMainCookieContextState(shopId, patch = {}) {
    if (!shopId || !patch || typeof patch !== 'object') return null;
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

  async _hydrateMainCookieContext(shopId, options = {}) {
    const shop = this._getShop(shopId);
    if (!shopId || !shop) return null;
    const ses = session.fromPartition(this._getPartition(shopId));
    const waitTimeoutMs = Math.max(3000, Number(options.waitTimeoutMs || 15000));
    const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs || 500));

    this._updateMainCookieContextState(shopId, {
      mainCookieContextReady: false,
      mainCookieContextError: '',
      mainCookieContextUpdatedAt: Number(shop.mainCookieContextUpdatedAt || 0),
    });

    let result = {
      ready: false,
      cookieNames: [],
      hasPassId: false,
      hasNanoFp: false,
      hasRckk: false,
      currentUrl: '',
    };
    let win = null;

    try {
      win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
          partition: this._getPartition(shopId),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      if (shop?.userAgent) {
        win.webContents.setUserAgent(shop.userAgent);
      }

      await win.loadURL(PDD_HOME_URL);
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        const cookies = await ses.cookies.get({ domain: '.pinduoduo.com' });
        const cookieNames = cookies.map(item => item.name);
        const hasPassId = cookieNames.includes('PASS_ID');
        const hasNanoFp = cookieNames.includes('_nano_fp');
        const hasRckk = cookieNames.includes('rckk');
        result = {
          ready: hasPassId && hasNanoFp,
          cookieNames,
          hasPassId,
          hasNanoFp,
          hasRckk,
          currentUrl: win.webContents.getURL(),
        };
        if (result.ready) break;
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }

      this._updateMainCookieContextState(shopId, {
        mainCookieContextReady: result.ready,
        mainCookieContextUpdatedAt: Date.now(),
        mainCookieContextError: result.ready ? '' : '主站 Cookie 上下文未完整建立',
      });
      this.onLog(
        `[PDD助手] 主 Cookie 上下文${result.ready ? '已建立' : '未完整建立'}: ${shop.name || shopId}`,
        {
          shopId,
          hasPassId: result.hasPassId,
          hasNanoFp: result.hasNanoFp,
          hasRckk: result.hasRckk,
          cookieNames: result.cookieNames,
          url: result.currentUrl,
        }
      );
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      this._updateMainCookieContextState(shopId, {
        mainCookieContextReady: false,
        mainCookieContextUpdatedAt: Date.now(),
        mainCookieContextError: message,
      });
      this.onLog(`[PDD助手] 主 Cookie 上下文初始化失败: ${shop.name || shopId}, ${message}`);
      return {
        ...result,
        error: message,
      };
    } finally {
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
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
      await this._hydrateMainCookieContext(shopId);
      const initResult = await client.initSession(true);
      const profile = await client.getShopProfile(true);
      const hasMallName = this._hasRealShopName(profile?.mallName || '');
      const apiSuccessCount = Number(profile?.apiSuccessCount || 0);
      const apiAuthFailedCount = Number(profile?.apiAuthFailedCount || 0);
      const tokenUsable = apiSuccessCount > 0;
      if (!tokenUsable) {
        if (apiAuthFailedCount > 0) {
          const error = new Error('接口认证已失效');
          error.authExpired = true;
          error.errorCode = 43001;
          throw error;
        }
        const errorMessage = initResult?.initialized
          ? '网页登录已进入会话，但接口未验证通过'
          : '店铺信息获取未完成';
        throw new Error(errorMessage);
      }
      const shopInfoStatus = hasMallName ? 'done' : 'partial';
      const shopInfoError = hasMallName ? '' : '已验证接口 Token 可用，待补全店铺名称';
      const shop = this._applyShopProfile(shopId, profile, {
        shopInfoStatus,
        shopInfoError,
        shopNameStatus: hasMallName ? 'resolved' : 'missing'
      });
      if (shop) {
        this.onLog(`[PDD助手] 已通过接口刷新店铺信息: ${shop.name || shop.id}${shopInfoStatus === 'partial' ? '（待补全店铺名称）' : ''}`);
      }
      return shop;
    } catch (error) {
      const authExpired = this._isAuthExpiredError(error);
      this._updateShopInfoState(shopId, {
        shopInfoStatus: 'failed',
        shopInfoError: error.message || String(error),
        ...(authExpired ? { status: 'expired', availabilityStatus: 'expired' } : {})
      });
      this.onLog(`[PDD助手] 通过接口获取店铺信息失败: ${shopId}, ${error.message || error}`);
      return null;
    } finally {
      if (this._shopInfoFetchingShopId === shopId) {
        this._shopInfoFetchingShopId = '';
      }
    }
  }

  async refreshMainCookieContext(shopId, options = {}) {
    const targetShopId = shopId || this.getActiveShopId();
    if (!targetShopId) {
      return { success: false, error: '未找到店铺' };
    }
    const result = await this._hydrateMainCookieContext(targetShopId, options);
    return { success: !!result?.ready, shopId: targetShopId, result };
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
        status: nextShop?.shopInfoStatus || 'failed',
        shopInfoStatus: nextShop?.shopInfoStatus || 'failed',
        availabilityStatus: nextShop?.availabilityStatus || nextShop?.status || 'offline',
        shopNameStatus: nextShop?.shopNameStatus || 'pending'
      };
    }
    return {
      success: true,
      shopId: targetShopId,
      shop,
      status: nextShop?.shopInfoStatus || 'done',
      shopInfoStatus: nextShop?.shopInfoStatus || 'done',
      availabilityStatus: nextShop?.availabilityStatus || nextShop?.status || 'online',
      shopNameStatus: nextShop?.shopNameStatus || 'resolved'
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

  _clearShopSession(shopId) {
    const ses = session.fromPartition(this._getPartition(shopId));
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
  }

  // ---- 店铺管理 ----

  _removeShopWithPersistedData(shopId) {
    if (!shopId) return false;

    const shops = this.store.get('shops') || [];
    const hasShop = shops.some(shop => shop.id === shopId);
    const shopTokenFiles = { ...(this.store.get('shopTokenFiles') || {}) };
    const managedTokenFile = shopTokenFiles[shopId] || null;
    const hasTokenInfo = !!this.store.get(this._getTokenStoreKey(shopId));
    const hasCookies = !!this.store.get(`shopCookies.${shopId}`);
    const hasView = this.views.has(shopId);

    if (!hasShop && !managedTokenFile && !hasTokenInfo && !hasCookies && !hasView) {
      return false;
    }

    if (managedTokenFile?.filePath) {
      try {
        if (fs.existsSync(managedTokenFile.filePath)) {
          fs.unlinkSync(managedTokenFile.filePath);
        }
      } catch (error) {
        this.onLog(`[PDD助手] 删除 Token 文件失败(${shopId}): ${error.message}`);
        return false;
      }
      delete shopTokenFiles[shopId];
      this.store.set('shopTokenFiles', shopTokenFiles);
    }

    this._disposeView(shopId);
    this._clearShopSession(shopId);
    this.clearTokenInfo(shopId);
    this.store.delete(`shopCookies.${shopId}`);

    const nextShops = shops.filter(shop => shop.id !== shopId);
    this.store.set('shops', nextShops);

    if (this.activeShopId === shopId) {
      this.activeShopId = null;
      this.syncActiveShopSelection({
        shops: nextShops,
        showView: nextShops.length > 0
      });
    }

    if (this.mainWindow) {
      this.mainWindow.webContents.send('shop-list-updated', { shops: nextShops });
    }

    this.onTokenUpdated(shopId);
    return true;
  }

  removeShop(shopId) {
    if (this.tokenFileStore) {
      return this._removeShopWithPersistedData(shopId);
    }

    if (!shopId) return false;
    const view = this.views.get(shopId);
    if (!view && !(this.store.get('shops') || []).some(shop => shop.id === shopId)) {
      return false;
    }

    if (view) {
      if (this.activeShopId === shopId) {
        try { this.mainWindow.removeBrowserView(view); } catch {}
      }
      view.webContents.close();
      this.views.delete(shopId);
    }

    this._clearShopSession(shopId);

    let shops = this.store.get('shops') || [];
    shops = shops.filter(s => s.id !== shopId);
    this.store.set('shops', shops);

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
    this.store.delete(`shopCookies.${shopId}`);
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

  // ---- 内部辅助 ----

  _getShop(shopId) {
    const shops = this.store.get('shops') || [];
    return shops.find(s => s.id === shopId) || null;
  }
}

module.exports = { ShopManager };
