const { BrowserWindow, shell } = require('electron');
const { appendWindowCloseDebugLog } = require('./window-close-debug-log');
const {
  DEFAULT_PAGE_CHROME_UA,
  resolveStoredShopProfile,
  applySessionPddPageProfile
} = require('./pdd-request-profile');

const infoWindowContexts = new Map();
const infoWindowKeyToId = new Map();

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

function getDisplayPath(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
  } catch {
    return text;
  }
}

async function injectPathOverlay(win, url) {
  if (!win || win.isDestroyed()) return;
  const displayPath = getDisplayPath(url);
  if (!displayPath) return;
  try {
    await win.webContents.executeJavaScript(`
      (() => {
        const displayPath = ${JSON.stringify(displayPath)};
        const overlayId = '__pddViolationPathOverlay';
        const backBtnId = '__pddViolationPathOverlayBackBtn';
        const inputId = '__pddViolationPathOverlayInput';
        let overlay = document.getElementById(overlayId);
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = overlayId;
          Object.assign(overlay.style, {
            position: 'fixed',
            top: '10px',
            left: '76px',
            right: '220px',
            zIndex: '2147483647',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          });
          const backBtn = document.createElement('button');
          backBtn.id = backBtnId;
          backBtn.type = 'button';
          backBtn.textContent = '←';
          backBtn.title = '返回上一页';
          Object.assign(backBtn.style, {
            width: '32px',
            minWidth: '32px',
            height: '32px',
            borderRadius: '8px',
            border: '1px solid #d9dce3',
            background: 'rgba(255,255,255,0.96)',
            color: '#111827',
            fontSize: '14px',
            lineHeight: '30px',
            textAlign: 'center',
            boxShadow: '0 2px 8px rgba(15, 23, 42, 0.12)',
            pointerEvents: 'auto',
            cursor: 'pointer'
          });
          backBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
              history.back();
            } catch {}
          });
          const input = document.createElement('input');
          input.id = inputId;
          input.readOnly = true;
          input.tabIndex = -1;
          Object.assign(input.style, {
            width: '100%',
            height: '32px',
            padding: '0 12px',
            borderRadius: '8px',
            border: '1px solid #d9dce3',
            background: 'rgba(255,255,255,0.96)',
            color: '#111827',
            fontSize: '12px',
            lineHeight: '32px',
            boxShadow: '0 2px 8px rgba(15, 23, 42, 0.12)',
            pointerEvents: 'auto'
          });
          overlay.appendChild(backBtn);
          overlay.appendChild(input);
          const mount = document.body || document.documentElement;
          if (!mount) return false;
          mount.appendChild(overlay);
        }
        const backBtn = document.getElementById(backBtnId);
        const input = document.getElementById(inputId);
        if (!backBtn || !input) return false;
        const canGoBack = history.length > 1;
        backBtn.disabled = !canGoBack;
        backBtn.style.opacity = canGoBack ? '1' : '0.45';
        backBtn.style.cursor = canGoBack ? 'pointer' : 'not-allowed';
        input.value = displayPath;
        input.title = displayPath;
        return true;
      })()
    `, true);
  } catch {}
}

function resolveContext(target) {
  if (!target) return null;
  if (target.window && target.window.webContents) {
    return infoWindowContexts.get(target.window.webContents.id) || null;
  }
  if (target.webContents && typeof target.setBrowserView === 'function') {
    return infoWindowContexts.get(target.webContents.id) || null;
  }
  return null;
}

function removeContextReuseKey(context) {
  if (!context?.reuseKey) return;
  const currentId = infoWindowKeyToId.get(context.reuseKey);
  if (currentId === context.windowId) {
    infoWindowKeyToId.delete(context.reuseKey);
  }
  context.reuseKey = '';
}

function setContextReuseKey(context, reuseKey) {
  if (!context) return;
  const nextKey = String(reuseKey || '').trim();
  if ((context.reuseKey || '') === nextKey) return;
  removeContextReuseKey(context);
  if (!nextKey) return;
  infoWindowKeyToId.set(nextKey, context.windowId);
  context.reuseKey = nextKey;
}

function cleanupContext(context) {
  if (!context || context.cleanedUp) return;
  context.cleanedUp = true;
  removeContextReuseKey(context);
  const windowId = context.windowId;
  if (windowId) {
    infoWindowContexts.delete(windowId);
  }
}

function getContextByReuseKey(reuseKey) {
  const key = String(reuseKey || '').trim();
  if (!key) return null;
  const windowId = infoWindowKeyToId.get(key);
  if (!windowId) return null;
  const context = infoWindowContexts.get(windowId) || null;
  const win = context?.window;
  if (!context || !win || win.isDestroyed()) {
    if (key) infoWindowKeyToId.delete(key);
    if (context) cleanupContext(context);
    return null;
  }
  return context;
}

async function createViolationInfoWindow(options = {}) {
  const reuseKey = String(options?.reuseKey || '').trim();
  const existingContext = getContextByReuseKey(reuseKey);
  if (existingContext?.window && !existingContext.window.isDestroyed()) {
    if (existingContext.window.isMinimized()) existingContext.window.restore();
    if (!existingContext.window.isVisible()) existingContext.window.show();
    existingContext.window.focus();
    return { win: existingContext.window, reused: true };
  }

  const shopId = String(options?.shopId || '').trim();
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: '违规详情',
    show: false,
    webPreferences: {
      partition: getShopPartition(shopId),
      contextIsolation: true,
      nodeIntegration: false,
      webgl: false
    }
  });

  const context = {
    windowId: win.webContents.id,
    window: win,
    activeShopId: shopId,
    reuseKey: '',
    cleanedUp: false
  };
  infoWindowContexts.set(context.windowId, context);
  setContextReuseKey(context, reuseKey);
  appendWindowCloseDebugLog({
    source: 'violation-info-window',
    event: 'created',
    windowId: context.windowId,
    reuseKey,
    shopId
  });

  const userAgent = getShopUserAgent(options?.store, shopId);
  if (userAgent) win.webContents.setUserAgent(userAgent);
  applySessionPddPageProfile(win.webContents.session, {
    userAgent,
    tokenInfo: resolveStoredShopProfile(options?.store, shopId).tokenInfo,
    clientHintsProfile: 'page'
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isMerchantUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on('did-finish-load', () => {
    injectPathOverlay(win, win.webContents.getURL());
  });

  win.webContents.on('did-navigate', (_event, nextUrl) => {
    injectPathOverlay(win, nextUrl);
  });

  win.webContents.on('did-navigate-in-page', (_event, nextUrl) => {
    injectPathOverlay(win, nextUrl);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url?.startsWith('http')) {
      if (isMerchantUrl(url)) {
        const ua = getShopUserAgent(options?.store, context.activeShopId);
        if (ua) win.webContents.loadURL(url, { userAgent: ua });
        else win.webContents.loadURL(url);
      } else {
        shell.openExternal(url);
      }
    }
    return { action: 'deny' };
  });

  win.on('close', () => {
    appendWindowCloseDebugLog({
      source: 'violation-info-window',
      event: 'close',
      windowId: context.windowId,
      reuseKey: context.reuseKey,
      aliveCount: infoWindowContexts.size
    });
  });

  win.on('closed', () => {
    appendWindowCloseDebugLog({
      source: 'violation-info-window',
      event: 'closed',
      windowId: context.windowId,
      reuseKey: context.reuseKey,
      aliveCountBeforeCleanup: infoWindowContexts.size
    });
    cleanupContext(context);
  });

  return { win, reused: false };
}

function loadViolationInfoUrl(target, store, shopId, url) {
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
  context.activeShopId = targetShopId;
  const ua = getShopUserAgent(store, targetShopId);
  if (ua) win.webContents.loadURL(targetUrl, { userAgent: ua });
  else win.webContents.loadURL(targetUrl);
  return { ok: true };
}

module.exports = {
  createViolationInfoWindow,
  loadViolationInfoUrl
};
