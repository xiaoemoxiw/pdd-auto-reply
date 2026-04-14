const { BrowserWindow, BrowserView, shell } = require('electron');
const path = require('path');

const detailWindowContexts = new Map();
const detailWindowKeyToId = new Map();
const sessionChromeUaMap = new WeakMap();
const DEFAULT_TOOLBAR_HEIGHT = 44;
const DEFAULT_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function applySessionChromeUserAgent(ses, userAgent) {
  if (!ses) return;
  const ua = String(userAgent || '').trim();
  if (!ua) return;
  try {
    if (typeof ses.setUserAgent === 'function') {
      ses.setUserAgent(ua);
    }
  } catch {}

  const existing = sessionChromeUaMap.get(ses);
  if (existing) {
    existing.ua = ua;
    return;
  }
  sessionChromeUaMap.set(ses, { ua });
  if (!ses.webRequest || typeof ses.webRequest.onBeforeSendHeaders !== 'function') return;

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details?.requestHeaders || {};
    const targetUrl = String(details?.url || '');
    try {
      const hostname = new URL(targetUrl).hostname;
      if (!hostname.endsWith('.pinduoduo.com')) return callback({ requestHeaders: headers });
    } catch {
      return callback({ requestHeaders: headers });
    }
    const current = sessionChromeUaMap.get(ses);
    const nextUa = current?.ua || ua;
    headers['User-Agent'] = nextUa;
    headers['sec-ch-ua'] = '"Chromium";v="122", "Google Chrome";v="122", "Not(A:Brand";v="99"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: headers });
  });
}

function isMerchantUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.endsWith('.pinduoduo.com');
  } catch {
    return true;
  }
}

function getShopPartition(shopId) {
  const id = String(shopId || '').trim();
  if (!id) return undefined;
  return `persist:pdd-${id}`;
}

function getShopUserAgent(store, shopId) {
  const id = String(shopId || '').trim();
  const shops = store?.get('shops') || [];
  const shop = Array.isArray(shops) ? shops.find(s => String(s?.id || '').trim() === id) : null;
  const ua = String(shop?.userAgent || '').trim();
  const lower = ua.toLowerCase();
  const isChromeLike = ua && lower.includes('chrome/') && !lower.includes('electron/');
  return isChromeLike ? ua : DEFAULT_CHROME_UA;
}

function resolveContext(target) {
  if (!target) return null;
  if (target.window && target.window.webContents) {
    return detailWindowContexts.get(target.window.webContents.id) || null;
  }
  if (target.webContents && typeof target.setBrowserView === 'function') {
    return detailWindowContexts.get(target.webContents.id) || null;
  }
  return null;
}

function removeContextReuseKey(context) {
  if (!context?.reuseKey) return;
  const currentId = detailWindowKeyToId.get(context.reuseKey);
  if (currentId === context.window?.webContents?.id) {
    detailWindowKeyToId.delete(context.reuseKey);
  }
  context.reuseKey = '';
}

function setContextReuseKey(context, reuseKey) {
  if (!context) return;
  const nextKey = String(reuseKey || '').trim();
  if ((context.reuseKey || '') === nextKey) return;
  removeContextReuseKey(context);
  if (!nextKey) return;
  detailWindowKeyToId.set(nextKey, context.window.webContents.id);
  context.reuseKey = nextKey;
}

function cleanupContext(context) {
  if (!context || context.cleanedUp) return;
  context.cleanedUp = true;
  removeContextReuseKey(context);
  destroyView(context);
  const windowId = context.window?.webContents?.id;
  if (windowId) {
    detailWindowContexts.delete(windowId);
  }
}

function getContextByReuseKey(reuseKey) {
  const key = String(reuseKey || '').trim();
  if (!key) return null;
  const windowId = detailWindowKeyToId.get(key);
  if (!windowId) return null;
  const context = detailWindowContexts.get(windowId) || null;
  const win = context?.window;
  if (!context || !win || win.isDestroyed()) {
    if (key) detailWindowKeyToId.delete(key);
    if (context) cleanupContext(context);
    return null;
  }
  return context;
}

function getMailDetailWindowContextByWebContents(webContents) {
  const win = BrowserWindow.fromWebContents(webContents);
  return resolveContext(win);
}

function sendState(target, payload = {}) {
  const context = resolveContext(target) || target;
  const win = context?.window;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('mail-detail-window-state', payload);
}

function getViewState(target) {
  const context = resolveContext(target) || target;
  const view = context?.view;
  if (!view) {
    return {
      url: '',
      title: '',
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    };
  }
  const wc = view.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    isLoading: wc.isLoading()
  };
}

function resizeView(target) {
  const context = resolveContext(target) || target;
  const win = context?.window;
  const view = context?.view;
  if (!win || win.isDestroyed() || !view) return;
  const bounds = win.getContentBounds();
  const top = Math.max(0, Number(context.toolbarHeight || 0));
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height - top);
  view.setBounds({ x: 0, y: top, width, height });
}

function destroyView(target) {
  const context = resolveContext(target) || target;
  const view = context?.view;
  if (view) {
    try {
      const wc = view.webContents;
      wc.removeAllListeners();
      wc.close({ waitForBeforeUnload: false });
    } catch {}
  }
  if (context) {
    context.view = null;
    context.activeShopId = '';
  }
}

function ensureView(target, store, shopId) {
  const context = resolveContext(target) || target;
  if (!context) return null;
  const nextShopId = String(shopId || '').trim();
  if (context.view && context.activeShopId && context.activeShopId === nextShopId) {
    return context.view;
  }
  destroyView(context);

  context.view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getShopPartition(nextShopId),
      webgl: false
    }
  });
  context.activeShopId = nextShopId;

  const view = context.view;
  const userAgent = getShopUserAgent(store, nextShopId);
  view.__pddUserAgent = userAgent;
  if (userAgent) view.webContents.setUserAgent(userAgent);
  applySessionChromeUserAgent(view.webContents.session, userAgent);

  view.webContents.on('will-navigate', (event, url) => {
    if (!isMerchantUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    const currentView = context.view;
    if (url?.startsWith('http')) {
      if (isMerchantUrl(url)) {
        const ua = currentView?.__pddUserAgent;
        if (ua) currentView?.webContents.loadURL(url, { userAgent: ua });
        else currentView?.webContents.loadURL(url);
      } else {
        shell.openExternal(url);
      }
    }
    return { action: 'deny' };
  });

  view.webContents.on('did-start-loading', () => {
    sendState(context, getViewState(context));
  });

  view.webContents.on('did-finish-load', () => {
    sendState(context, getViewState(context));
  });

  view.webContents.on('did-navigate', () => {
    sendState(context, getViewState(context));
  });

  view.webContents.on('did-navigate-in-page', () => {
    sendState(context, getViewState(context));
  });

  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3 || isMainFrame === false) return;
    sendState(context, {
      ...getViewState(context),
      errorCode,
      errorDescription: errorDescription || '页面加载失败',
      url: validatedURL || (context.view ? context.view.webContents.getURL() : '')
    });
  });

  const win = context.window;
  if (win && !win.isDestroyed()) {
    win.setBrowserView(view);
    view.setAutoResize({ width: true, height: true });
    resizeView(context);
    sendState(context, getViewState(context));
  }

  return view;
}

async function createMailDetailWindow(options = {}) {
  const reuseKey = String(options?.reuseKey || '').trim();
  const existingContext = getContextByReuseKey(reuseKey);
  if (existingContext?.window && !existingContext.window.isDestroyed()) {
    if (existingContext.window.isMinimized()) existingContext.window.restore();
    if (!existingContext.window.isVisible()) existingContext.window.show();
    existingContext.window.focus();
    return { win: existingContext.window, reused: true };
  }

  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: '站内信详情',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'mail-detail-window-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const context = {
    window: win,
    view: null,
    activeShopId: '',
    toolbarHeight: DEFAULT_TOOLBAR_HEIGHT,
    reuseKey: '',
    cleanedUp: false
  };
  detailWindowContexts.set(win.webContents.id, context);
  setContextReuseKey(context, reuseKey);

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'mail-detail-window.html'));
  } catch (err) {
    cleanupContext(context);
    if (!win.isDestroyed()) {
      win.destroy();
    }
    throw err;
  }

  win.on('resize', () => {
    resizeView(context);
  });

  win.on('closed', () => {
    cleanupContext(context);
  });

  return { win, reused: false };
}

function setMailDetailToolbarHeight(target, height) {
  const context = resolveContext(target) || target;
  if (!context) return { error: '无效窗口' };
  const next = Number(height);
  if (!Number.isFinite(next) || next <= 0) return { error: '无效高度' };
  context.toolbarHeight = Math.min(160, Math.max(32, Math.round(next)));
  resizeView(context);
  return { ok: true };
}

function loadMailDetailUrl(target, store, shopId, url) {
  const context = resolveContext(target) || target;
  const win = context?.window;
  if (!context || !win || win.isDestroyed()) {
    return { error: '详情窗口不可用' };
  }
  const targetShopId = String(shopId || '').trim() || context.activeShopId;
  const targetUrl = String(url || '').trim();
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return { error: '无效链接' };
  }
  const view = ensureView(context, store, targetShopId);
  if (!view) return { error: '详情视图创建失败' };
  win.setBrowserView(view);
  resizeView(context);
  const ua = view.__pddUserAgent;
  if (ua) view.webContents.loadURL(targetUrl, { userAgent: ua });
  else view.webContents.loadURL(targetUrl);
  return { ok: true };
}

function goBack(target) {
  const context = resolveContext(target) || target;
  if (!context?.view) return { error: '页面未就绪' };
  if (context.view.webContents.canGoBack()) context.view.webContents.goBack();
  return { ok: true };
}

function goForward(target) {
  const context = resolveContext(target) || target;
  if (!context?.view) return { error: '页面未就绪' };
  if (context.view.webContents.canGoForward()) context.view.webContents.goForward();
  return { ok: true };
}

function reload(target) {
  const context = resolveContext(target) || target;
  if (!context?.view) return { error: '页面未就绪' };
  context.view.webContents.reload();
  return { ok: true };
}

module.exports = {
  createMailDetailWindow,
  getMailDetailWindowContextByWebContents,
  setMailDetailToolbarHeight,
  loadMailDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
};
