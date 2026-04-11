const { BrowserWindow, BrowserView, shell } = require('electron');
const path = require('path');

let detailWindow = null;
let detailView = null;
let activeShopId = '';
let toolbarHeight = 44;
const sessionChromeUaMap = new WeakMap();

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
  if (ua) return ua;
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
}

function sendState(payload = {}) {
  if (!detailWindow || detailWindow.isDestroyed()) return;
  detailWindow.webContents.send('ticket-todo-detail-state', payload);
}

function getViewState() {
  if (!detailView) {
    return {
      url: '',
      title: '',
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    };
  }
  const wc = detailView.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    isLoading: wc.isLoading()
  };
}

function resizeView() {
  if (!detailWindow || detailWindow.isDestroyed()) return;
  if (!detailView) return;
  const bounds = detailWindow.getContentBounds();
  const top = Math.max(0, Number(toolbarHeight || 0));
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height - top);
  detailView.setBounds({ x: 0, y: top, width, height });
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

function destroyView() {
  if (detailView) {
    try {
      const wc = detailView.webContents;
      wc.removeAllListeners();
      wc.close({ waitForBeforeUnload: false });
    } catch {}
  }
  detailView = null;
  activeShopId = '';
}

function ensureView(store, shopId) {
  const nextShopId = String(shopId || '').trim();
  if (detailView && activeShopId && activeShopId === nextShopId) {
    return detailView;
  }
  destroyView();

  detailView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getShopPartition(nextShopId),
      webgl: false
    }
  });
  activeShopId = nextShopId;

  const userAgent = getShopUserAgent(store, nextShopId);
  detailView.__pddUserAgent = userAgent;
  if (userAgent) detailView.webContents.setUserAgent(userAgent);
  applySessionChromeUserAgent(detailView.webContents.session, userAgent);

  detailView.webContents.on('will-navigate', (event, url) => {
    if (!isMerchantUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  detailView.webContents.setWindowOpenHandler(({ url }) => {
    if (url?.startsWith('http')) {
      if (isMerchantUrl(url)) {
        const ua = detailView?.__pddUserAgent;
        if (ua) detailView.webContents.loadURL(url, { userAgent: ua });
        else detailView.webContents.loadURL(url);
      } else {
        shell.openExternal(url);
      }
    }
    return { action: 'deny' };
  });

  detailView.webContents.on('did-start-loading', () => {
    sendState(getViewState());
  });

  detailView.webContents.on('did-finish-load', () => {
    sendState(getViewState());
    dismissNonChromePrompt(detailView, detailView.webContents.getURL());
  });

  detailView.webContents.on('did-navigate', () => {
    sendState(getViewState());
    dismissNonChromePrompt(detailView, detailView.webContents.getURL());
  });

  detailView.webContents.on('did-navigate-in-page', () => {
    sendState(getViewState());
    dismissNonChromePrompt(detailView, detailView.webContents.getURL());
  });

  detailView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3 || isMainFrame === false) return;
    sendState({
      ...getViewState(),
      errorCode,
      errorDescription: errorDescription || '页面加载失败',
      url: validatedURL || (detailView ? detailView.webContents.getURL() : '')
    });
  });

  if (detailWindow && !detailWindow.isDestroyed()) {
    detailWindow.setBrowserView(detailView);
    detailView.setAutoResize({ width: true, height: true });
    resizeView();
    sendState(getViewState());
  }

  return detailView;
}

async function createTicketTodoDetailWindow() {
  if (detailWindow) {
    if (detailWindow.isMinimized()) detailWindow.restore();
    if (!detailWindow.isVisible()) detailWindow.show();
    return detailWindow;
  }

  detailWindow = new BrowserWindow({
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

  try {
    await detailWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ticket-todo-detail-window.html'));
  } catch (err) {
    if (detailWindow && !detailWindow.isDestroyed()) {
      detailWindow.destroy();
    }
    detailWindow = null;
    throw err;
  }

  detailWindow.on('resize', () => {
    resizeView();
  });

  detailWindow.on('closed', () => {
    destroyView();
    detailWindow = null;
  });

  return detailWindow;
}

function getTicketTodoDetailWindow() {
  return detailWindow;
}

function setTicketTodoDetailToolbarHeight(height) {
  const next = Number(height);
  if (!Number.isFinite(next) || next <= 0) return;
  toolbarHeight = Math.min(160, Math.max(32, Math.round(next)));
  resizeView();
}

function loadTicketTodoDetailUrl(store, shopId, url) {
  if (!detailWindow || detailWindow.isDestroyed()) {
    return { error: '详情窗口不可用' };
  }
  const targetShopId = String(shopId || '').trim() || activeShopId;
  const targetUrl = String(url || '').trim();
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return { error: '无效链接' };
  }
  const view = ensureView(store, targetShopId);
  detailWindow.setBrowserView(view);
  resizeView();
  const ua = view?.__pddUserAgent;
  if (ua) view.webContents.loadURL(targetUrl, { userAgent: ua });
  else view.webContents.loadURL(targetUrl);
  return { ok: true };
}

function goBack() {
  if (!detailView) return { error: '页面未就绪' };
  if (detailView.webContents.canGoBack()) detailView.webContents.goBack();
  return { ok: true };
}

function goForward() {
  if (!detailView) return { error: '页面未就绪' };
  if (detailView.webContents.canGoForward()) detailView.webContents.goForward();
  return { ok: true };
}

function reload() {
  if (!detailView) return { error: '页面未就绪' };
  detailView.webContents.reload();
  return { ok: true };
}

module.exports = {
  createTicketTodoDetailWindow,
  getTicketTodoDetailWindow,
  setTicketTodoDetailToolbarHeight,
  loadTicketTodoDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
};
