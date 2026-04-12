const { BrowserWindow, BrowserView, shell } = require('electron');
const { getShopUserAgent, applySessionChromeUserAgent } = require('./pdd-chrome-ua');

let infoWindow = null;
let infoView = null;
let activeShopId = '';

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

function setViewUserAgent(store, shopId, view) {
  const ua = getShopUserAgent(store, shopId);
  view.__pddUserAgent = ua;
  if (ua) view.webContents.setUserAgent(ua);
  applySessionChromeUserAgent(view.webContents.session, ua);
}

function resizeView() {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (!infoView) return;
  const bounds = infoWindow.getContentBounds();
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  infoView.setBounds({ x: 0, y: 0, width, height });
}

function destroyView() {
  if (infoView) {
    try {
      const wc = infoView.webContents;
      wc.removeAllListeners();
      wc.close({ waitForBeforeUnload: false });
    } catch {}
  }
  infoView = null;
  activeShopId = '';
}

function ensureView(store, shopId) {
  const nextShopId = String(shopId || '').trim();
  if (infoView && activeShopId && activeShopId === nextShopId) {
    return infoView;
  }
  destroyView();

  infoView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getShopPartition(nextShopId),
      webgl: false
    }
  });
  activeShopId = nextShopId;

  setViewUserAgent(store, nextShopId, infoView);

  infoView.webContents.on('will-navigate', (event, url) => {
    if (!isMerchantUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  infoView.webContents.setWindowOpenHandler(({ url }) => {
    if (url?.startsWith('http')) {
      if (isMerchantUrl(url)) {
        const ua = infoView?.__pddUserAgent;
        if (ua) infoView.webContents.loadURL(url, { userAgent: ua });
        else infoView.webContents.loadURL(url);
      } else {
        shell.openExternal(url);
      }
    }
    return { action: 'deny' };
  });

  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.setBrowserView(infoView);
    infoView.setAutoResize({ width: true, height: true });
    resizeView();
  }

  return infoView;
}

async function createViolationInfoWindow() {
  if (infoWindow) {
    if (infoWindow.isMinimized()) infoWindow.restore();
    if (!infoWindow.isVisible()) infoWindow.show();
    infoWindow.focus();
    return infoWindow;
  }

  infoWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: '违规详情',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  try {
    await infoWindow.loadURL('about:blank');
  } catch (err) {
    if (infoWindow && !infoWindow.isDestroyed()) {
      infoWindow.destroy();
    }
    infoWindow = null;
    throw err;
  }

  infoWindow.on('resize', () => {
    resizeView();
  });

  infoWindow.on('closed', () => {
    destroyView();
    infoWindow = null;
  });

  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.show();
    infoWindow.focus();
  }

  return infoWindow;
}

function getViolationInfoWindow() {
  return infoWindow;
}

function loadViolationInfoUrl(store, shopId, url) {
  if (!infoWindow || infoWindow.isDestroyed()) {
    return { error: '详情窗口不可用' };
  }
  const targetShopId = String(shopId || '').trim() || activeShopId;
  const targetUrl = String(url || '').trim();
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return { error: '无效链接' };
  }
  const view = ensureView(store, targetShopId);
  infoWindow.setBrowserView(view);
  resizeView();
  const ua = view?.__pddUserAgent;
  if (ua) view.webContents.loadURL(targetUrl, { userAgent: ua });
  else view.webContents.loadURL(targetUrl);
  return { ok: true };
}

module.exports = {
  createViolationInfoWindow,
  getViolationInfoWindow,
  loadViolationInfoUrl
};
