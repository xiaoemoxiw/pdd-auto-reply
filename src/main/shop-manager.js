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
    this.views = new Map();           // shopId -> BrowserView
    this.activeShopId = null;
    this.onLog = options.onLog || (() => {});
    this.onInjectScript = options.onInjectScript || (() => {});
    this.onNetworkMonitor = options.onNetworkMonitor || (() => {});
    this.onDetectChat = options.onDetectChat || (() => {});
    this._pendingQRShopId = null;     // 扫码登录中的临时 shopId
  }

  // ---- BrowserView 生命周期 ----

  _getPartition(shopId) {
    return `persist:pdd-${shopId}`;
  }

  _getChatUrl() {
    return this.store.get('chatUrl') || PDD_CHAT_URL;
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
    let mallId = null, userId = null, tokenStr = null;
    if (tokenData.windowsAppShopToken) {
      try {
        const decoded = JSON.parse(Buffer.from(tokenData.windowsAppShopToken, 'base64').toString());
        mallId = String(decoded.m);
        userId = decoded.u;
        tokenStr = decoded.t;
      } catch {}
    }

    // 检查是否已有相同 mallId 的店铺
    const shops = this.store.get('shops') || [];
    const existing = mallId ? shops.find(s => s.mallId === mallId) : null;
    if (existing) {
      // 更新已有店铺的 Cookie
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

    // 保存 token 信息到全局供 API 调用使用
    if (!global.__pddTokens) global.__pddTokens = {};
    if (mallId) {
      global.__pddTokens[shopId] = {
        token: tokenStr,
        mallId,
        userId,
        raw: tokenData.windowsAppShopToken,
        userAgent: tokenData.userAgent || '',
        pddid: tokenData.pddid || ''
      };
    }

    this.switchTo(shopId);

    // 页面加载后尝试检测店铺名称
    this._detectShopName(shopId);

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

    if (!global.__pddTokens) global.__pddTokens = {};
    global.__pddTokens[shopId] = {
      token: tokenStr,
      mallId,
      userId,
      raw: tokenData.windowsAppShopToken,
      userAgent: tokenData.userAgent || shop?.userAgent || '',
      pddid: tokenData.pddid || ''
    };

    this.switchTo(shopId);
    if (view) view.webContents.loadURL(this._getChatUrl());

    this.mainWindow.webContents.send('shop-list-updated', { shops: this.store.get('shops') });
    this.onLog(`[PDD助手] Token 已刷新: shopId=${shopId}, ${cookieCount} Cookie`);

    return { shopId, cookieCount, mallId, refreshed: true };
  }

  // ---- 添加店铺: 扫码登录 ----

  async addByQRCode() {
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
            if (title && !title.includes('登录') && title !== '拼多多商家后台') mallName = title;
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

  // ---- 店铺管理 ----

  removeShop(shopId) {
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
