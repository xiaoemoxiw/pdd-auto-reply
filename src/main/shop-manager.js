const { BrowserView, BrowserWindow, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  DEFAULT_PAGE_CHROME_UA,
  resolveStoredShopProfile,
  applySessionPddPageProfile
} = require('./pdd-request-profile');

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
    this.getCurrentView = options.getCurrentView || (() => '');
    this._pendingQRShopId = null;     // 扫码登录中的临时 shopId
    this._shopInfoTimer = null;
    this._shopInfoFetchingShopId = '';
    this._overlayTopOffset = 0;
    this._overlayVisible = false;
    this._importValidationQueue = [];   // 导入后串行校验队列（concurrency = 1）
    this._importValidationRunning = false;
  }

  // ---- BrowserView 生命周期 ----

  _getPartition(shopId) {
    return `persist:pddv2-${shopId}`;
  }

  _getChatUrl() {
    return this.store.get('chatUrl') || PDD_CHAT_URL;
  }

  _getMainCookieWarmupUrls(options = {}) {
    const homeUrl = PDD_HOME_URL;
    const loginRedirectUrl = `${PDD_LOGIN_URL}?redirectUrl=${encodeURIComponent(homeUrl)}`;
    const urls = [homeUrl, loginRedirectUrl];
    if (options.includeChatWarmup === true) {
      const chatUrl = this._getChatUrl() || PDD_CHAT_URL;
      urls.push(chatUrl);
    }
    return Array.from(new Set(urls.filter(Boolean)));
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

    await this._resetSessionCookies(ses);

    return this._seedSessionWithTokenData(ses, tokenData, { httpOnly: true });
  }

  async _resetSessionCookies(ses) {
    if (!ses) return 0;
    let removed = 0;
    const cookies = await ses.cookies.get({});
    for (const cookie of cookies) {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      if (!domain || !domain.endsWith('pinduoduo.com')) continue;
      try {
        await ses.cookies.remove(`https://${domain}${cookie.path || '/'}`, cookie.name);
        removed++;
      } catch {}
    }
    return removed;
  }

  async _seedSessionWithTokenData(ses, tokenData = {}, options = {}) {
    if (!ses) return 0;
    const httpOnly = options.httpOnly !== false;
    let cookieCount = 0;
    for (const cookieStr of (tokenData.mallCookies || [])) {
      const eqIdx = cookieStr.indexOf('=');
      if (eqIdx < 0) continue;
      const name = cookieStr.slice(0, eqIdx);
      const value = cookieStr.slice(eqIdx + 1);
      const cookieVariants = [
        {
          url: 'https://mms.pinduoduo.com',
          name,
          value,
          domain: '.pinduoduo.com',
          path: '/',
          secure: true,
          httpOnly
        },
        {
          url: 'https://mms.pinduoduo.com',
          name,
          value,
          path: '/',
          secure: true,
          httpOnly
        }
      ];
      const variants = name === 'PASS_ID' ? cookieVariants : [cookieVariants[0]];
      for (const variant of variants) {
        try {
          await ses.cookies.set(variant);
          cookieCount++;
        } catch {}
      }
    }
    return cookieCount;
  }

  async _getSessionPassIdScopes(ses) {
    if (!ses) return [];
    const cookies = await ses.cookies.get({});
    return Array.from(new Set(
      cookies
        .filter(item => item.name === 'PASS_ID')
        .map(item => `PASS_ID@${String(item.domain || '').replace(/^\./, '') || 'host-only'}`)
    ));
  }

  _getManagedTokenData(shopId) {
    if (!shopId) return null;
    if (this.tokenFileStore && typeof this.tokenFileStore.findRecordByShopId === 'function') {
      return this.tokenFileStore.findRecordByShopId(shopId)?.tokenData || null;
    }
    return null;
  }

  async _collectMainCookieContextResult(ses, win = null) {
    const allCookies = await ses.cookies.get({});
    const cookies = allCookies.filter(item => {
      const domain = String(item.domain || '').replace(/^\./, '');
      return domain.endsWith('pinduoduo.com');
    });
    const cookieNames = Array.from(new Set(cookies.map(item => item.name)));
    const cookieScopes = Array.from(new Set(
      cookies
        .filter(item => ['PASS_ID', '_nano_fp', 'rckk'].includes(item.name))
        .map(item => `${item.name}@${String(item.domain || '').replace(/^\./, '') || 'host-only'}`)
    ));
    const hasPassId = cookies.some(item => item.name === 'PASS_ID');
    const hasNanoFp = cookies.some(item => item.name === '_nano_fp');
    const hasRckk = cookies.some(item => item.name === 'rckk');
    return {
      ready: hasPassId && hasNanoFp && hasRckk,
      cookieNames,
      cookieScopes,
      hasPassId,
      hasNanoFp,
      hasRckk,
      currentUrl: win && !win.isDestroyed() ? win.webContents.getURL() : '',
    };
  }

  async _waitForMainCookieContext(ses, win, options = {}) {
    const waitTimeoutMs = Math.max(3000, Number(options.waitTimeoutMs || 30000));
    const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs || 500));
    let result = {
      ready: false,
      cookieNames: [],
      cookieScopes: [],
      hasPassId: false,
      hasNanoFp: false,
      hasRckk: false,
      currentUrl: '',
    };
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      result = await this._collectMainCookieContextResult(ses, win);
      if (result.ready) break;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return result;
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

  _extractImportedShopMetaFromTokenData(tokenData = {}, preferredMallId = '') {
    const targetMallId = String(preferredMallId || '').trim();
    const importedMallName = String(
      tokenData?.mallName
      || tokenData?.mall_name
      || tokenData?.shopName
      || tokenData?.shop_name
      || ''
    ).trim();
    const shopEntries = Array.isArray(tokenData?.shops)
      ? tokenData.shops.filter(item => item && typeof item === 'object')
      : [];
    const normalizeMeta = (item = {}) => ({
      mallId: String(item.mallId || targetMallId || '').trim(),
      mallName: String(item.mallName || item.mall_name || importedMallName || '').trim(),
      loginStatus: String(item.loginStatus || item.login_status || '').trim()
    });
    const matchedShop = targetMallId
      ? shopEntries.find(item => String(item.mallId || '').trim() === targetMallId)
      : null;
    if (matchedShop) {
      return normalizeMeta(matchedShop);
    }
    if (shopEntries.length === 1) {
      return normalizeMeta(shopEntries[0]);
    }
    if (importedMallName) {
      return {
        mallId: targetMallId,
        mallName: importedMallName,
        loginStatus: ''
      };
    }
    const firstNamedShop = shopEntries.find(item => String(item.mallName || item.mall_name || '').trim());
    if (firstNamedShop) {
      return normalizeMeta(firstNamedShop);
    }
    return null;
  }

  _buildShopFromTokenRecord(record, previousShop = {}) {
    const previousName = previousShop.name || '';
    const importedShopMeta = this._extractImportedShopMetaFromTokenData(
      record?.tokenData,
      record?.tokenInfo?.mallId || previousShop.mallId || ''
    );
    const importedMallName = String(importedShopMeta?.mallName || '').trim();
    const autoNames = [
      '扫码登录中...',
      previousShop.mallId ? `店铺 ${previousShop.mallId}` : '',
      previousShop.id ? `店铺 ${previousShop.id.slice(-6)}` : '',
      previousShop.id ? `新店铺 ${previousShop.id.slice(-6)}` : ''
    ].filter(Boolean);
    const name = !previousName || autoNames.includes(previousName)
      ? (importedMallName || (record.tokenInfo.mallId ? `店铺 ${record.tokenInfo.mallId}` : previousName || `店铺 ${record.shopId.slice(-6)}`))
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
    const normalizedShopNameStatus = (hasRealShopName || this._hasRealShopName(importedMallName))
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
    const applyTokens = options.applyTokens !== false;
    const forceApplyTokens = options.forceApplyTokens === true;
    const showView = options.showView === true || (options.showView !== false && broadcast && !!this.mainWindow);
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

      if (shouldRefresh && applyTokens) {
        cookieCountByShopId[record.shopId] = await this._applyTokenDataToSession(record.shopId, record.tokenData);
        const view = this.views.get(record.shopId);
        if (view) {
          const pageProfile = resolveStoredShopProfile(this.store, record.shopId, {
            fallbackUserAgent: DEFAULT_PAGE_CHROME_UA,
            chromeOnly: true
          });
          view.__pddUserAgent = pageProfile.userAgent;
          if (pageProfile.userAgent) {
            view.webContents.setUserAgent(pageProfile.userAgent);
          }
          applySessionPddPageProfile(view.webContents.session, {
            userAgent: pageProfile.userAgent,
            tokenInfo: pageProfile.tokenInfo,
            clientHintsProfile: 'page'
          });
        }
        this.onTokenUpdated(record.shopId);
      }
      if (shouldRefresh) {
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
      showView
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

    // 禁用 WebRTC，并屏蔽内嵌拼多多页自己的通知，只保留应用主进程通知
    view.webContents.session.setPermissionCheckHandler((wc, permission) => {
      if (permission === 'notifications') return false;
      if (permission === 'media' || permission === 'geolocation') return false;
      return true;
    });
    view.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission === 'notifications') return callback(false);
      if (permission === 'media' || permission === 'geolocation') return callback(false);
      callback(true);
    });

    const pageProfile = resolveStoredShopProfile(this.store, shopId, {
      fallbackUserAgent: DEFAULT_PAGE_CHROME_UA,
      chromeOnly: true
    });
    view.__pddUserAgent = pageProfile.userAgent;
    if (pageProfile.userAgent) {
      view.webContents.setUserAgent(pageProfile.userAgent);
    }
    applySessionPddPageProfile(view.webContents.session, {
      userAgent: pageProfile.userAgent,
      tokenInfo: pageProfile.tokenInfo,
      clientHintsProfile: 'page'
    });

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
          if (view.__pddUserAgent) view.webContents.loadURL(url, { userAgent: view.__pddUserAgent });
          else view.webContents.loadURL(url);
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
        this.mainWindow.webContents.send('pdd-page-loaded', {
          shopId,
          currentView: this.getCurrentView(),
          url
        });
      }
      setTimeout(() => this.onDetectChat(view, shopId), 2000);
    });

    view.webContents.on('did-start-loading', () => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-page-loading', {
          shopId,
          currentView: this.getCurrentView(),
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
        this.mainWindow.webContents.send('pdd-navigated', {
          shopId,
          currentView: this.getCurrentView(),
          url
        });
      }
      this.onInjectScript(view);
      setTimeout(() => this.onDetectChat(view, shopId), 2000);
    });

    view.webContents.on('did-navigate', (event, url) => {
      if (this.activeShopId === shopId) {
        this.mainWindow.webContents.send('pdd-navigated', {
          shopId,
          currentView: this.getCurrentView(),
          url
        });
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

    // 如果 view 还没加载过内容，优先加载后台首页，避免默认拉起聊天运行时
    const currentUrl = view.webContents.getURL();
    if (loadUrl) {
      view.webContents.loadURL(loadUrl);
    } else if (!currentUrl || currentUrl === 'about:blank') {
      view.webContents.loadURL(PDD_HOME_URL);
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
      try {
        const currentUrl = view.webContents.getURL();
        if (currentUrl && currentUrl !== 'about:blank') {
          view.webContents.loadURL('about:blank');
        }
      } catch {}
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
      if (!importedShopIds.length) {
        if (imported.hasShopMetadata) {
          return {
            error: imported.eligibleShopCount > 0
              ? '文件中的“已登录”店铺缺少可用 PASS_ID，未导入任何店铺'
              : '文件中没有“已登录”的店铺，未导入任何店铺',
            fileName: imported.fileName,
            sourceFileName,
            importedCount: 0,
            eligibleShopCount: imported.eligibleShopCount || 0,
            skippedShopCount: imported.skippedShopCount || 0,
            skippedNoPassCookieCount: imported.skippedNoPassCookieCount || 0
          };
        }
        return { error: 'Token 文件中未解析到可导入店铺', fileName: imported.fileName, sourceFileName };
      }
      const { shops, cookieCountByShopId, createdShopIds } = await this.syncShopsFromTokenFiles({
        broadcast: true,
        applyTokens: false,
        showView: false
      });
      const targetShopId = importedShopIds.find(shopId => createdShopIds.includes(shopId)) || importedShopIds[0] || '';
      const targetShop = shops.find(shop => shop.id === targetShopId) || null;
      const createdCount = importedShopIds.filter(shopId => createdShopIds.includes(shopId)).length;
      const refreshedCount = importedShopIds.length - createdCount;
      const created = createdCount > 0;
      for (const shopId of importedShopIds) {
        if (!createdShopIds.includes(shopId)) continue;
        const createdShop = shops.find(shop => shop.id === shopId);
        if (createdShop) {
          this.mainWindow.webContents.send('shop-added', { shop: createdShop });
        }
      }
      const validationResult = this.enqueueShopValidationOnImport(importedShopIds);
      const validationScheduledCount = Number(validationResult?.scheduled || 0);
      this.onLog(`[PDD助手] Token 文件已导入(不自动建立网页会话): ${sourceFileName}, 导入 ${importedShopIds.length || 0} 家店铺；已排队接口校验 ${validationScheduledCount} 家，按导入顺序逐个校验`);
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
        profileRefreshDeferred: !!targetShopId,
        silentImportOnly: false,
        apiValidationDeferred: false,
        apiValidationScheduled: true,
        apiValidationScheduledCount: validationScheduledCount,
        mainCookieContextReady: false,
        mainCookieContextError: '',
        mainCookieContext: null,
        hasShopMetadata: !!imported.hasShopMetadata,
        eligibleShopCount: imported.eligibleShopCount || 0,
        skippedShopCount: imported.skippedShopCount || 0,
        skippedNoPassCookieCount: imported.skippedNoPassCookieCount || 0,
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

    await this._resetSessionCookies(ses);

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

    const shop = {
      id: shopId,
      name: (() => {
        const importedShopMeta = this._extractImportedShopMetaFromTokenData(tokenData, mallId);
        const importedMallName = String(importedShopMeta?.mallName || '').trim();
        return importedMallName || (mallId ? `店铺 ${mallId}` : `店铺 ${shopId.slice(-6)}`);
      })(),
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

    const profileRefreshResult = await this.refreshShopProfile(shopId);
    if (profileRefreshResult?.success) {
      this.syncActiveShopSelection({
        preferredShopId: shopId,
        showView: false,
        emitEvent: true
      });
    }

    this.mainWindow.webContents.send('shop-added', { shop });
    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 导入完成: ${cookieCount} Cookie, mallId=${mallId}, shopId=${shopId}`);

    return {
      shopId,
      cookieCount,
      mallId,
      mainCookieContextReady: !!profileRefreshResult?.success,
      mainCookieContextError: profileRefreshResult?.success ? '' : (profileRefreshResult?.error || ''),
      mainCookieContext: profileRefreshResult?.mainCookieContext || null,
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

    const nextTokenInfo = this._buildTokenInfo({
      ...tokenData,
      userAgent: tokenData.userAgent || shop?.userAgent || ''
    }, mallId || shop?.mallId || '', userId, tokenStr);
    this._saveTokenInfo(shopId, nextTokenInfo);

    // 更新内存中 BrowserView 的 UA
    const view = this.views.get(shopId);
    if (view) {
      const pageProfile = resolveStoredShopProfile(this.store, shopId, {
        fallbackUserAgent: DEFAULT_PAGE_CHROME_UA,
        chromeOnly: true
      });
      view.__pddUserAgent = pageProfile.userAgent;
      if (pageProfile.userAgent) {
        view.webContents.setUserAgent(pageProfile.userAgent);
      }
      applySessionPddPageProfile(view.webContents.session, {
        userAgent: pageProfile.userAgent,
        tokenInfo: nextTokenInfo,
        clientHintsProfile: 'page'
      });
    }

    this.onTokenUpdated(shopId);

    const profileRefreshResult = await this.refreshShopProfile(shopId);
    if (profileRefreshResult?.success) {
      this.syncActiveShopSelection({
        preferredShopId: shopId,
        showView: false,
        emitEvent: true
      });
    }

    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 已刷新: shopId=${shopId}, ${cookieCount} Cookie`);

    return {
      shopId,
      cookieCount,
      mallId,
      refreshed: true,
      mainCookieContextReady: !!profileRefreshResult?.success,
      mainCookieContextError: profileRefreshResult?.success ? '' : (profileRefreshResult?.error || ''),
      mainCookieContext: profileRefreshResult?.mainCookieContext || null
    };
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

  _getManagedImportedShopMeta(shopId) {
    if (!shopId || !this.tokenFileStore || typeof this.tokenFileStore.findRecordByShopId !== 'function') {
      return null;
    }
    const record = this.tokenFileStore.findRecordByShopId(shopId);
    const shopMeta = this._extractImportedShopMetaFromTokenData(
      record?.tokenData,
      record?.tokenInfo?.mallId || ''
    );
    if (!shopMeta || typeof shopMeta !== 'object') return null;
    return {
      mallId: String(shopMeta.mallId || record?.tokenInfo?.mallId || '').trim(),
      mallName: String(shopMeta.mallName || '').trim(),
      loginStatus: String(shopMeta.loginStatus || '').trim()
    };
  }

  async _hydrateMainCookieContext(shopId, options = {}) {
    const shop = this._getShop(shopId);
    if (!shopId || !shop) return null;
    const ses = session.fromPartition(this._getPartition(shopId));
    const waitTimeoutMs = Math.max(3000, Number(options.waitTimeoutMs || 30000));
    const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs || 500));

    this._updateMainCookieContextState(shopId, {
      mainCookieContextReady: false,
      mainCookieContextError: '',
      mainCookieContextUpdatedAt: Number(shop.mainCookieContextUpdatedAt || 0),
      mainCookieContextUrl: '',
      mainCookieContextCookieNames: [],
      mainCookieContextHasPassId: false,
      mainCookieContextHasNanoFp: false,
      mainCookieContextHasRckk: false,
      mainCookieContextFallbackUrl: '',
      mainCookieContextFallbackCookieNames: [],
    });

    let result = {
      ready: false,
      cookieNames: [],
      cookieScopes: [],
      hasPassId: false,
      hasNanoFp: false,
      hasRckk: false,
      currentUrl: '',
      entryUrl: '',
      attemptedEntryUrls: [],
    };
    let win = null;

    try {
      const managedTokenData = this._getManagedTokenData(shopId);
      const passIdScopesBeforeSeed = await this._getSessionPassIdScopes(ses);
      if (!passIdScopesBeforeSeed.length && managedTokenData) {
        result.seededCookieCount = await this._seedSessionWithTokenData(ses, managedTokenData, {
          httpOnly: true
        });
      }
      result.passIdScopesBeforeSeed = passIdScopesBeforeSeed;
      result.passIdScopesAfterSeed = await this._getSessionPassIdScopes(ses);

      win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          partition: this._getPartition(shopId),
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });

      const pageProfile = resolveStoredShopProfile(this.store, shopId, {
        fallbackUserAgent: DEFAULT_PAGE_CHROME_UA,
        chromeOnly: true
      });
      applySessionPddPageProfile(win.webContents.session, {
        userAgent: pageProfile.userAgent,
        tokenInfo: pageProfile.tokenInfo,
        clientHintsProfile: 'page'
      });
      if (pageProfile.userAgent) {
        win.webContents.setUserAgent(pageProfile.userAgent);
      }

      const warmupUrls = this._getMainCookieWarmupUrls(options);
      const perAttemptWaitTimeoutMs = Math.max(8000, Math.round(waitTimeoutMs / Math.max(1, warmupUrls.length)));
      for (const entryUrl of warmupUrls) {
        result.attemptedEntryUrls = Array.from(new Set([...(result.attemptedEntryUrls || []), entryUrl]));
        await win.loadURL(entryUrl);
        const passIdScopesBeforeWarmup = await this._getSessionPassIdScopes(ses);
        result = {
          ...(await this._waitForMainCookieContext(ses, win, {
            waitTimeoutMs: perAttemptWaitTimeoutMs,
            pollIntervalMs
          })),
          entryUrl,
          passIdScopesBeforeWarmup,
          passIdScopesBeforeSeed: result.passIdScopesBeforeSeed,
          passIdScopesAfterSeed: result.passIdScopesAfterSeed,
          seededCookieCount: Number(result.seededCookieCount || 0),
          attemptedEntryUrls: result.attemptedEntryUrls
        };
        if (result.ready) break;
      }
      if (!result.ready) {
        result = {
          ...result,
          error: '主站 Cookie 上下文未完整建立'
        };
      }

      this._updateMainCookieContextState(shopId, {
        mainCookieContextReady: result.ready,
        mainCookieContextUpdatedAt: Date.now(),
        mainCookieContextError: result.ready ? '' : (result.error || '主站 Cookie 上下文未完整建立'),
        mainCookieContextUrl: result.currentUrl || '',
        mainCookieContextCookieNames: Array.isArray(result.cookieNames) ? result.cookieNames : [],
        mainCookieContextHasPassId: !!result.hasPassId,
        mainCookieContextHasNanoFp: !!result.hasNanoFp,
        mainCookieContextHasRckk: !!result.hasRckk,
        mainCookieContextFallbackUrl: '',
        mainCookieContextFallbackCookieNames: [],
      });
      this.onLog(
        `[PDD助手] 主 Cookie 上下文${result.ready ? '已建立' : '未完整建立'}: ${shop.name || shopId}`,
        {
          shopId,
          hasPassId: result.hasPassId,
          hasNanoFp: result.hasNanoFp,
          hasRckk: result.hasRckk,
          cookieNames: result.cookieNames,
          cookieScopes: result.cookieScopes,
          entryUrl: result.entryUrl,
          attemptedEntryUrls: result.attemptedEntryUrls,
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
        mainCookieContextUrl: result.currentUrl || '',
        mainCookieContextCookieNames: Array.isArray(result.cookieNames) ? result.cookieNames : [],
        mainCookieContextHasPassId: !!result.hasPassId,
        mainCookieContextHasNanoFp: !!result.hasNanoFp,
        mainCookieContextHasRckk: !!result.hasRckk,
        mainCookieContextFallbackUrl: '',
        mainCookieContextFallbackCookieNames: [],
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
    if (this._shopInfoFetchingShopId) return null;
    const client = this.getApiClient(shopId);
    if (!client) return null;
    const importedShopMeta = this._getManagedImportedShopMeta(shopId);
    const usesImportedMallName = !!importedShopMeta;
    this._shopInfoFetchingShopId = shopId;
    this._updateShopInfoState(shopId, {
      shopInfoStatus: 'fetching',
      shopInfoLastAttemptAt: Date.now(),
      shopInfoError: ''
    });
    try {
      const mainCookieContext = await this._hydrateMainCookieContext(shopId);
      if (!mainCookieContext?.ready) {
        throw new Error(mainCookieContext?.error || '等待 `_nano_fp/rckk` 超时');
      }
      if (usesImportedMallName) {
        const [mallInfoResult, userInfoResult, credentialInfoResult] = await Promise.allSettled([
          client.getMallInfo({ suppressAuthExpired: true }),
          client.getUserInfo({ suppressAuthExpired: true }),
          client.getCredentialInfo({ suppressAuthExpired: true })
        ]);
        const mallInfo = mallInfoResult.status === 'fulfilled' ? mallInfoResult.value : {};
        const userInfo = userInfoResult.status === 'fulfilled' ? userInfoResult.value : {};
        const credentialInfo = credentialInfoResult.status === 'fulfilled' ? credentialInfoResult.value : {};
        const hasValidationSignal = !!(
          mallInfo?.mallId
          || mallInfo?.mallName
          || credentialInfo?.mallId
          || credentialInfo?.mallName
          || credentialInfo?.companyName
          || userInfo?.mallId
          || userInfo?.userId
          || userInfo?.nickname
          || userInfo?.username
        );
        if (!hasValidationSignal) {
          throw new Error('接口未验证通过');
        }
        const importedMallName = importedShopMeta?.mallName || '';
        const fetchedMallName = String(mallInfo?.mallName || credentialInfo?.mallName || '').trim();
        const resolvedMallName = this._hasRealShopName(importedMallName) ? importedMallName : fetchedMallName;
        const hasMallName = this._hasRealShopName(resolvedMallName || '');
        const shop = this._applyShopProfile(shopId, {
          mallId: importedShopMeta?.mallId || mallInfo?.mallId || credentialInfo?.mallId || userInfo?.mallId || '',
          mallName: resolvedMallName,
          account: userInfo?.nickname || userInfo?.username || '',
          category: mallInfo?.category || '',
        }, {
          shopInfoStatus: hasMallName ? 'done' : 'partial',
          shopInfoError: hasMallName ? '' : '已验证接口 Token 可用，待补全店铺名称',
          shopNameStatus: hasMallName ? 'resolved' : 'missing'
        });
        if (shop) {
          this.onLog(`[PDD助手] 已通过纯接口校验店铺 Token: ${shop.name || shop.id}`);
        }
        return shop;
      }
      const initResult = await client.initSession(true, {
        source: 'shop-manager:verify-token'
      });
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
    if (this._shopInfoFetchingShopId && this._shopInfoFetchingShopId !== targetShopId) {
      return {
        success: false,
        fetching: true,
        error: `正在获取 ${this._shopInfoFetchingShopId} 的店铺信息，请稍候`
      };
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
        shopNameStatus: nextShop?.shopNameStatus || 'pending',
        mainCookieContext: nextShop ? {
          ready: !!nextShop.mainCookieContextReady,
          error: nextShop.mainCookieContextError || '',
          url: nextShop.mainCookieContextUrl || '',
          cookieNames: nextShop.mainCookieContextCookieNames || [],
          hasPassId: !!nextShop.mainCookieContextHasPassId,
          hasNanoFp: !!nextShop.mainCookieContextHasNanoFp,
          hasRckk: !!nextShop.mainCookieContextHasRckk
        } : null
      };
    }
    return {
      success: true,
      shopId: targetShopId,
      shop,
      status: nextShop?.shopInfoStatus || 'done',
      shopInfoStatus: nextShop?.shopInfoStatus || 'done',
      availabilityStatus: nextShop?.availabilityStatus || nextShop?.status || 'online',
      shopNameStatus: nextShop?.shopNameStatus || 'resolved',
      mainCookieContext: nextShop ? {
        ready: !!nextShop.mainCookieContextReady,
        error: nextShop.mainCookieContextError || '',
        url: nextShop.mainCookieContextUrl || '',
        cookieNames: nextShop.mainCookieContextCookieNames || [],
        hasPassId: !!nextShop.mainCookieContextHasPassId,
        hasNanoFp: !!nextShop.mainCookieContextHasNanoFp,
        hasRckk: !!nextShop.mainCookieContextHasRckk
      } : null
    };
  }

  // 把导入的店铺塞进串行校验队列（concurrency = 1，按入队顺序一家一家跑）。
  // 入队前先把历史 expired 状态归到 offline（渲染层显示为"待验证"），
  // 避免导入了新 token 后还显示旧的 Token过期。
  // fire-and-forget：调用方不需要 await。
  enqueueShopValidationOnImport(shopIds = []) {
    const ids = Array.from(new Set(
      (Array.isArray(shopIds) ? shopIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    ));
    if (!ids.length) return { scheduled: 0 };
    let scheduled = 0;
    for (const shopId of ids) {
      this._resetShopForRevalidation(shopId);
      if (!this._importValidationQueue.includes(shopId)) {
        this._importValidationQueue.push(shopId);
        scheduled += 1;
      }
    }
    if (scheduled > 0) {
      this.onLog(`[PDD助手] 已排队接口校验 ${scheduled} 家店铺，将按导入顺序逐个校验`);
    }
    this._runImportValidationLoop().catch(() => {});
    return { scheduled };
  }

  // 把店铺重置为"待校验"状态，避免重新导入时残留历史 expired。
  _resetShopForRevalidation(shopId) {
    if (!shopId) return;
    const shops = this.store.get('shops') || [];
    const shop = shops.find(item => item.id === shopId);
    if (!shop) return;
    const patch = {};
    if (shop.availabilityStatus === 'expired' || shop.status === 'expired') {
      patch.availabilityStatus = 'offline';
      patch.status = 'offline';
    }
    const infoStatus = shop.shopInfoStatus || '';
    if (infoStatus === 'failed' || infoStatus === 'expired') {
      patch.shopInfoStatus = 'pending';
      patch.shopInfoError = '';
    }
    if (Object.keys(patch).length) {
      this._updateShopInfoState(shopId, patch);
    }
  }

  async _runImportValidationLoop() {
    if (this._importValidationRunning) return;
    this._importValidationRunning = true;
    try {
      while (this._importValidationQueue.length) {
        const shopId = this._importValidationQueue.shift();
        if (!shopId) continue;
        // refreshShopProfile 内部用 _shopInfoFetchingShopId 互斥；
        // 如果用户正手动跑同名/异名校验，等待短暂后重试同一个 shopId，最多 30 次（约 30s）。
        let attempts = 0;
        while (attempts < 30) {
          let result;
          try {
            result = await this.refreshShopProfile(shopId);
          } catch (error) {
            result = { success: false, error: error?.message || String(error) };
          }
          if (!result?.fetching) break;
          attempts += 1;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally {
      this._importValidationRunning = false;
    }
  }

  async safeValidateShops(shopIds = []) {
    const normalizedShopIds = Array.from(new Set(
      (Array.isArray(shopIds) ? shopIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    ));
    const validatedShopIds = [];
    const successShopIds = [];
    const failed = [];

    for (const shopId of normalizedShopIds) {
      validatedShopIds.push(shopId);
      try {
        const result = await this.refreshShopProfile(shopId);
        if (result?.success) {
          successShopIds.push(shopId);
          continue;
        }
        failed.push({
          shopId,
          error: result?.error || '店铺信息获取失败'
        });
      } catch (error) {
        failed.push({
          shopId,
          error: error?.message || String(error)
        });
      }
    }

    return {
      shopIds: validatedShopIds,
      successShopIds,
      failed,
      successCount: successShopIds.length,
      failedCount: failed.length
    };
  }

  async probeShopAuth(shopId) {
    const targetShopId = shopId || this.getActiveShopId();
    if (!targetShopId) {
      return { success: false, error: '未找到店铺' };
    }
    const client = this.getApiClient(targetShopId);
    if (!client || typeof client.probeCommonMallInfoRequest !== 'function') {
      return { success: false, shopId: targetShopId, error: '店铺接口客户端未初始化' };
    }
    try {
      const result = await client.probeCommonMallInfoRequest();
      return {
        success: !!result?.success,
        shopId: targetShopId,
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        shopId: targetShopId,
        error: error?.message || String(error),
      };
    }
  }

  _pickNextPendingShopForProfile() {
    const shops = this.store.get('shops') || [];
    return shops.find(shop => shop.loginMethod === 'token' && !shop.shopInfoFetchedAt && (shop.shopInfoStatus || 'pending') === 'pending') || null;
  }

  startShopInfoHydrationLoop(intervalMs = 5000) {
    if (this._shopInfoTimer) return;
    const run = async () => {
      this._shopInfoTimer = null;
      if (this._shopInfoFetchingShopId) {
        this._shopInfoTimer = setTimeout(run, intervalMs);
        return;
      }
      const nextShop = this._pickNextPendingShopForProfile();
      if (!nextShop) {
        return;
      }
      try {
        await this._fetchAndApplyShopProfile(nextShop.id);
      } finally {
        if (this._pickNextPendingShopForProfile()) {
          this._shopInfoTimer = setTimeout(run, intervalMs);
        }
      }
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

  clearPersistedSessionsForShops(shopIds = []) {
    const uniqueShopIds = Array.from(new Set(
      (Array.isArray(shopIds) ? shopIds : [])
        .map(shopId => String(shopId || '').trim())
        .filter(Boolean)
    ));
    for (const shopId of uniqueShopIds) {
      this._clearShopSession(shopId);
      this.store.delete(`shopCookies.${shopId}`);
    }
    return uniqueShopIds.length;
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
