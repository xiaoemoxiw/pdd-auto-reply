const { screen } = require('electron');
const {
  createTicketTodoDetailWindow,
  loadTicketTodoDetailUrl
} = require('../windows/ticket-todo-detail-window');

function placeWindowRelativeToMain(mainWindow, win) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!win || win.isDestroyed()) return;

  const mainBounds = mainWindow.getBounds();
  const currentBounds = win.getBounds();
  const display = screen.getDisplayMatching(mainBounds);
  const workArea = display?.workArea || display?.bounds;
  if (!workArea) return;

  if (win.isMaximized()) win.unmaximize();

  const gap = 12;
  const maxWidth = Math.max(200, workArea.width);
  const maxHeight = Math.max(200, workArea.height);
  const width = Math.min(currentBounds.width, maxWidth);
  const height = Math.min(currentBounds.height, maxHeight);

  let x = Math.round(mainBounds.x + (mainBounds.width - width) / 2);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));

  const yBelow = mainBounds.y + mainBounds.height + gap;
  const yAbove = mainBounds.y - height - gap;
  let y = yBelow;
  if (yBelow + height > workArea.y + workArea.height) {
    if (yAbove >= workArea.y) {
      y = yAbove;
    } else {
      y = Math.max(workArea.y, workArea.y + workArea.height - height);
    }
  }

  win.setBounds({ x, y, width, height }, false);
}

function extractGoodsIdFromUrl(url = '') {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.searchParams.get('goods_id') || parsed.searchParams.get('goodsId') || '';
  } catch {
    const match = text.match(/[?&]goods_id=(\d+)/i) || text.match(/[?&]goodsId=(\d+)/i);
    return match?.[1] || '';
  }
}

function dedupeUrls(urls = []) {
  const seen = new Set();
  return urls.filter(item => {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function buildProductDetailWindowUrls(params = {}) {
  const rawUrl = String(params?.url || '').trim();
  const explicitGoodsId = String(params?.goodsId || params?.goods_id || '').trim();
  const goodsId = explicitGoodsId || extractGoodsIdFromUrl(rawUrl);
  const merchantUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : '';
  const urls = dedupeUrls([
    goodsId ? `https://mms.pinduoduo.com/goods/goods_detail?goodsId=${encodeURIComponent(goodsId)}` : '',
    goodsId ? `https://mms.pinduoduo.com/goods/goods_detail?goods_id=${encodeURIComponent(goodsId)}` : '',
    goodsId ? `https://mms.pinduoduo.com/goods/goods_list?goodsId=${encodeURIComponent(goodsId)}` : '',
    goodsId ? `https://mms.pinduoduo.com/goods/goods_list?goods_id=${encodeURIComponent(goodsId)}` : '',
    merchantUrl,
  ]);
  return {
    goodsId,
    urls,
    targetUrl: urls[0] || ''
  };
}

function registerShopIpc({
  ipcMain,
  store,
  getShopManager,
  getMainWindow,
  getCurrentView,
  isEmbeddedPddView,
  getPddHomeUrl,
  getPddChatUrl,
  destroyApiClient,
  destroyMailApiClient,
  destroyInvoiceApiClient,
  destroyTicketApiClient,
  destroyViolationApiClient,
  destroyDeductionApiClient
}) {
  ipcMain.handle('get-active-shop', () => {
    const shopManager = getShopManager();
    if (!shopManager) return null;
    const shop = shopManager.getActiveShop();
    return shop ? { shopId: shopManager.getActiveShopId(), shop } : null;
  });

  ipcMain.handle('switch-shop', (event, shopId) => {
    const shopManager = getShopManager();
    if (!shopManager) return false;
    const shop = shopManager.getShopList().find(item => item.id === shopId);
    if (!shopManager.isUserSelectableShop(shop)) return false;
    if (!isEmbeddedPddView?.(getCurrentView?.())) {
      return !!shopManager.syncActiveShopSelection({
        preferredShopId: shopId,
        showView: false,
        emitEvent: true
      });
    }
    return shopManager.switchTo(shopId);
  });

  ipcMain.handle('open-shop-home', async (event, shopId) => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    const shop = shopManager.getShopList().find(item => item.id === shopId);
    if (!shop?.id) return { error: '店铺不存在' };
    if (!shopManager.isSelectableShop(shop)) {
      return { error: '当前店铺 Token 不可用' };
    }
    let mainCookieContext = null;
    try {
      const warmupResult = await shopManager.refreshMainCookieContext(shopId, {
        reason: 'open-shop-home'
      });
      mainCookieContext = warmupResult?.result || null;
    } catch {}
    const fallbackHomeUrl = typeof getPddHomeUrl === 'function'
      ? getPddHomeUrl()
      : 'https://mms.pinduoduo.com/home';
    const targetUrl = fallbackHomeUrl;
    return createTicketTodoDetailWindow({
      reuseKey: `shop-home:${shopId}`
    }).then(({ win, reused }) => {
      if (!win || win.isDestroyed()) return { error: '后台首页窗口创建失败' };
      try {
        if (typeof win.setParentWindow === 'function') win.setParentWindow(null);
        if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(false);
      } catch {}
      const shopLabel = String(shop.name || shop.mallId || shop.id).trim() || '店铺后台首页';
      win.setTitle(`${shopLabel} - 拼多多后台`);
      const res = loadTicketTodoDetailUrl(win, store, shopId, targetUrl);
      if (res && res.error) return res;
      if (!reused) {
        placeWindowRelativeToMain(getMainWindow?.(), win);
      }
      win.show();
      win.focus();
      return {
        ok: true,
        shopId,
        url: targetUrl,
        reused: reused === true,
        mainCookieContext
      };
    }).catch(error => {
      return { error: error?.message || '打开店铺后台首页失败' };
    });
  });

  ipcMain.handle('open-product-detail-window', async (event, params = {}) => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    const shopId = String(params?.shopId || '').trim();
    if (!shopId) return { error: '缺少店铺信息' };
    const shop = shopManager.getShopList().find(item => item.id === shopId);
    if (!shop?.id) return { error: '店铺不存在' };
    if (!shopManager.isSelectableShop(shop)) {
      return { error: '当前店铺 Token 不可用' };
    }
    const { goodsId, targetUrl } = buildProductDetailWindowUrls(params);
    if (!targetUrl) return { error: '缺少商品链接或商品ID' };
    try {
      const { win, reused } = await createTicketTodoDetailWindow({
        reuseKey: goodsId ? `goods-detail:${shopId}:${goodsId}` : `goods-detail:${shopId}:${targetUrl}`
      });
      if (!win || win.isDestroyed()) return { error: '商品详情窗口创建失败' };
      try {
        if (typeof win.setParentWindow === 'function') win.setParentWindow(null);
        if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(false);
      } catch {}
      const shopLabel = String(shop.name || shop.mallId || shop.id).trim() || '商品详情';
      const titleSuffix = goodsId ? `商品 ${goodsId}` : '商品详情';
      win.setTitle(`${shopLabel} - ${titleSuffix}`);
      const res = loadTicketTodoDetailUrl(win, store, shopId, targetUrl);
      if (res && res.error) return res;
      if (!reused) {
        placeWindowRelativeToMain(getMainWindow?.(), win);
      }
      win.show();
      win.focus();
      return { ok: true, shopId, goodsId, url: targetUrl, reused: reused === true };
    } catch (error) {
      return { error: error?.message || '打开商品详情失败' };
    }
  });

  ipcMain.handle('add-shop-by-token', async () => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    try {
      return await shopManager.addByToken();
    } catch (error) {
      console.error('[PDD助手] Token 添加店铺失败:', error.message);
      return { error: error.message };
    }
  });

  ipcMain.handle('add-shop-by-token-path', async (event, filePath) => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    try {
      return await shopManager.addByToken(filePath);
    } catch (error) {
      console.error('[PDD助手] Token 添加店铺失败:', error.message);
      return { error: error.message };
    }
  });

  ipcMain.handle('add-shop-by-qrcode', async () => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    try {
      return await shopManager.addByQRCode();
    } catch (error) {
      console.error('[PDD助手] 扫码添加店铺失败:', error.message);
      return { error: error.message };
    }
  });

  ipcMain.handle('remove-shop', (event, shopId) => {
    const shopManager = getShopManager();
    if (!shopManager) return false;
    destroyApiClient(shopId);
    destroyMailApiClient(shopId);
    destroyInvoiceApiClient(shopId);
    destroyTicketApiClient(shopId);
    destroyViolationApiClient(shopId);
    destroyDeductionApiClient(shopId);
    return shopManager.removeShop(shopId);
  });

  ipcMain.handle('refresh-shop-profile', async (event, shopId) => {
    const shopManager = getShopManager();
    if (!shopManager) return { success: false, error: '店铺管理器未初始化' };
    try {
      return await shopManager.refreshShopProfile(shopId);
    } catch (error) {
      console.error('[PDD助手] 手动获取店铺信息失败:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('probe-shop-auth', async (event, shopId) => {
    const shopManager = getShopManager();
    if (!shopManager) return { success: false, error: '店铺管理器未初始化' };
    try {
      return await shopManager.probeShopAuth(shopId);
    } catch (error) {
      console.error('[PDD助手] 店铺接口参数诊断失败:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('refresh-main-cookie-context', async (event, params = {}) => {
    const shopManager = getShopManager();
    if (!shopManager) return { success: false, error: '店铺管理器未初始化' };
    const shopId = params?.shopId || shopManager.getActiveShopId();
    if (!shopId) return { success: false, error: '没有活跃店铺' };
    try {
      return await shopManager.refreshMainCookieContext(shopId, params);
    } catch (error) {
      console.error('[PDD助手] 手动刷新主 Cookie 上下文失败:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('import-token-file', async () => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    try {
      return await shopManager.addByToken();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('import-token-from-path', async (event, filePath) => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    try {
      return await shopManager.addByToken(filePath);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('get-token-info', () => {
    const shopId = getShopManager()?.getActiveShopId();
    return global.__pddTokens && shopId ? global.__pddTokens[shopId] || null : null;
  });

  ipcMain.handle('get-shops', async () => {
    const shopManager = getShopManager();
    if (shopManager) {
      return shopManager.getShopList();
    }
    return store.get('shops');
  });

  ipcMain.handle('sync-token-shops', async () => {
    const shopManager = getShopManager();
    if (!shopManager) return { error: '店铺管理器未初始化' };
    const result = await shopManager.syncShopsFromTokenFiles({
      broadcast: false,
      applyTokens: true,
      forceApplyTokens: true,
      showView: false
    });
    const shops = Array.isArray(result?.shops) ? result.shops : [];
    return {
      ...(result && typeof result === 'object' ? result : {}),
      shops
    };
  });

  ipcMain.handle('save-shops', (event, shops) => {
    const shopManager = getShopManager();
    if (shopManager) return shopManager.saveShopMetadata(shops);
    store.set('shops', shops);
    return true;
  });

  ipcMain.handle('get-shop-groups', () => store.get('shopGroups'));

  ipcMain.handle('save-shop-groups', (event, groups) => {
    store.set('shopGroups', groups);
    return true;
  });
}

module.exports = {
  registerShopIpc
};
