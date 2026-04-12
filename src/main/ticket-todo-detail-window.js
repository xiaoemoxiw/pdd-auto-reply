const { BrowserWindow, BrowserView, shell } = require('electron');
const path = require('path');
const { getShopUserAgent, applySessionChromeUserAgent } = require('./pdd-chrome-ua');

let detailWindow = null;
let detailView = null;
let activeShopId = '';
let toolbarHeight = 44;

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
  });

  detailView.webContents.on('did-navigate', () => {
    sendState(getViewState());
  });

  detailView.webContents.on('did-navigate-in-page', () => {
    sendState(getViewState());
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
