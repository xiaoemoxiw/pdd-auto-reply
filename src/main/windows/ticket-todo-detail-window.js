const { BrowserWindow, BrowserView, shell } = require('electron');
const path = require('path');
const {
  DEFAULT_PAGE_CHROME_UA,
  resolveStoredShopProfile,
  applySessionPddPageProfile
} = require('../pdd-request-profile');

const detailWindowContexts = new Map();
const detailWindowKeyToId = new Map();
const DEFAULT_TOOLBAR_HEIGHT = 44;

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
  return `persist:pddv2-${id}`;
}

function getShopUserAgent(store, shopId) {
  return resolveStoredShopProfile(store, shopId, {
    fallbackUserAgent: DEFAULT_PAGE_CHROME_UA,
    chromeOnly: true
  }).userAgent;
}

function resolveContext(target) {
  if (!target) return null;
  try {
    if (target.window && !target.window.isDestroyed()) {
      return detailWindowContexts.get(target.window.webContents.id) || null;
    }
  } catch {}
  try {
    if (target.webContents && typeof target.setBrowserView === 'function' && !target.isDestroyed?.()) {
      return detailWindowContexts.get(target.webContents.id) || null;
    }
  } catch {}
  return null;
}

function getContextWindowId(context) {
  const win = context?.window;
  if (!win || win.isDestroyed()) return 0;
  try {
    return win.webContents.id;
  } catch {
    return 0;
  }
}

function removeContextReuseKey(context) {
  if (!context?.reuseKey) return;
  const currentId = detailWindowKeyToId.get(context.reuseKey);
  if (currentId === getContextWindowId(context)) {
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
  const windowId = getContextWindowId(context);
  if (!windowId) return;
  detailWindowKeyToId.set(nextKey, windowId);
  context.reuseKey = nextKey;
}

function cleanupContext(context) {
  if (!context || context.cleanedUp) return;
  context.cleanedUp = true;
  removeContextReuseKey(context);
  destroyView(context);
  const windowId = getContextWindowId(context);
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

function getTicketTodoDetailWindowContextByWebContents(webContents) {
  const win = BrowserWindow.fromWebContents(webContents);
  return resolveContext(win);
}

function sendState(target, payload = {}) {
  const context = resolveContext(target) || target;
  const win = context?.window;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ticket-todo-detail-state', payload);
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

function shouldDismissNonChromePrompt(url) {
  const text = String(url || '').trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    if (!parsed.hostname.endsWith('.pinduoduo.com')) return false;
    return parsed.pathname.includes('/aftersales/work_order/tododetail');
  } catch {
    return false;
  }
}

async function dismissNonChromePrompt(view, url) {
  if (!view || !view.webContents) return;
  if (!shouldDismissNonChromePrompt(url)) return;
  const wc = view.webContents;
  const now = Date.now();
  if (view.__lastDismissAttemptAt && now - view.__lastDismissAttemptAt < 1500) return;
  view.__lastDismissAttemptAt = now;
  try {
    await wc.executeJavaScript(`(() => {
      const text = (s) => String(s || '').replace(/\\s+/g, '');
      const hasKeywords = (s) => {
        const t = text(s);
        return t.includes('非chrome') || t.includes('非Chrome') || t.includes('不是chrome') || t.includes('不是Chrome') || t.includes('浏览器不支持') || t.includes('下载新版Chrome');
      };
      const clickByText = (root) => {
        const nodes = Array.from(root.querySelectorAll('button,a,span,div'));
        const preferred = ['已安装去使用', '继续使用', '去使用', '继续在当前页使用', '我已知晓', '关闭'];
        for (const label of preferred) {
          const node = nodes.find(n => text(n?.innerText).includes(text(label)));
          if (node) {
            const clickable = node.closest('button,a') || node;
            clickable.click();
            return true;
          }
        }
        return false;
      };
      const bodyText = document.body ? document.body.innerText : '';
      if (!hasKeywords(bodyText)) return { ok: false, reason: 'no_prompt' };
      if (clickByText(document)) return { ok: true };
      return { ok: false, reason: 'not_found' };
    })()`, true);
  } catch {}
}

function destroyView(target) {
  const context = resolveContext(target) || target;
  const view = context?.view;
  if (view) {
    const win = context?.window;
    try {
      if (win && !win.isDestroyed()) {
        try {
          win.setBrowserView(null);
        } catch {}
      }
      const wc = view.webContents;
      if (wc && !wc.isDestroyed()) {
        wc.removeAllListeners();
        if (!win || !win.isDestroyed()) {
          wc.close({ waitForBeforeUnload: false });
        }
      }
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
  applySessionPddPageProfile(view.webContents.session, {
    userAgent,
    tokenInfo: resolveStoredShopProfile(store, nextShopId).tokenInfo,
    clientHintsProfile: 'page'
  });

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
    dismissNonChromePrompt(view, view.webContents.getURL());
  });

  view.webContents.on('did-navigate', () => {
    sendState(context, getViewState(context));
    dismissNonChromePrompt(view, view.webContents.getURL());
  });

  view.webContents.on('did-navigate-in-page', () => {
    sendState(context, getViewState(context));
    dismissNonChromePrompt(view, view.webContents.getURL());
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

async function createTicketTodoDetailWindow(options = {}) {
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
    title: '工单处理',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ticket-todo-detail-window-preload.js'),
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
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'ticket-todo-detail-window.html'));
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

function setTicketTodoDetailToolbarHeight(target, height) {
  const context = resolveContext(target) || target;
  if (!context) return { error: '无效窗口' };
  const next = Number(height);
  if (!Number.isFinite(next) || next <= 0) return { error: '无效高度' };
  context.toolbarHeight = Math.min(160, Math.max(32, Math.round(next)));
  resizeView(context);
  return { ok: true };
}

function loadTicketTodoDetailUrl(target, store, shopId, url) {
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
  createTicketTodoDetailWindow,
  getTicketTodoDetailWindowContextByWebContents,
  setTicketTodoDetailToolbarHeight,
  loadTicketTodoDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
};
