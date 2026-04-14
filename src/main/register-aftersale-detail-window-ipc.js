const {
  createAfterSaleDetailWindow,
  getAfterSaleDetailWindowContextByWebContents,
  setAfterSaleDetailToolbarHeight,
  loadAfterSaleDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
} = require('./aftersale-detail-window');

function buildAfterSaleDetailUrl(params = {}) {
  const instanceId = String(params?.instanceId || '').trim();
  if (!instanceId) return '';
  const orderNo = String(params?.orderNo || params?.orderSn || '').trim();
  const id = encodeURIComponent(instanceId);
  if (orderNo) {
    return `https://mms.pinduoduo.com/aftersales-ssr/detail?id=${id}&orderSn=${encodeURIComponent(orderNo)}`;
  }
  return `https://mms.pinduoduo.com/aftersales-ssr/detail?id=${id}`;
}

function buildAfterSaleDetailWindowReuseKey(params = {}, url = '') {
  const shopId = String(params?.shopId || params?.shop_id || '').trim();
  const instanceId = String(params?.instanceId || '').trim();
  const orderNo = String(params?.orderNo || params?.orderSn || '').trim();
  if (shopId && instanceId && orderNo) return `shop:${shopId}:instance:${instanceId}:order:${orderNo}`;
  if (instanceId && orderNo) return `instance:${instanceId}:order:${orderNo}`;
  if (shopId && instanceId) return `shop:${shopId}:instance:${instanceId}`;
  if (instanceId) return `instance:${instanceId}`;
  const targetUrl = String(url || '').trim();
  return shopId && targetUrl ? `shop:${shopId}:url:${targetUrl}` : (targetUrl ? `url:${targetUrl}` : '');
}

function registerAfterSaleDetailWindowIpc({
  ipcMain,
  store,
  getMainWindow
}) {
  ipcMain.handle('aftersale-open-detail-window', async (event, params = {}) => {
    try {
      const url = String(params?.url || '').trim() || buildAfterSaleDetailUrl(params);
      if (!url) return { error: '缺少详情链接' };
      const shopId = String(params?.shopId || '').trim();

      const mainWindow = getMainWindow?.();
      const { win, reused } = await createAfterSaleDetailWindow({
        reuseKey: buildAfterSaleDetailWindowReuseKey(params, url)
      });
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };

      const res = loadAfterSaleDetailUrl(win, store, shopId, url);
      if (res && res.error) return res;
      if (!reused && mainWindow && !mainWindow.isDestroyed()) {
        try {
          const [mainX, mainY] = mainWindow.getPosition();
          win.setPosition(mainX + 56, mainY + 56);
        } catch {}
      }
      win.show();
      win.focus();
      return { ok: true, reused: reused === true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('aftersale-detail-set-toolbar-height', async (event, params = {}) => {
    return setAfterSaleDetailToolbarHeight(getAfterSaleDetailWindowContextByWebContents(event.sender), params?.height);
  });

  ipcMain.handle('aftersale-detail-navigate', async (event, params = {}) => {
    const context = getAfterSaleDetailWindowContextByWebContents(event.sender);
    if (!context?.window || context.window.isDestroyed()) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadAfterSaleDetailUrl(context, store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('aftersale-detail-back', async (event) => {
    return goBack(getAfterSaleDetailWindowContextByWebContents(event.sender));
  });

  ipcMain.handle('aftersale-detail-forward', async (event) => {
    return goForward(getAfterSaleDetailWindowContextByWebContents(event.sender));
  });

  ipcMain.handle('aftersale-detail-reload', async (event) => {
    return reload(getAfterSaleDetailWindowContextByWebContents(event.sender));
  });

  ipcMain.handle('aftersale-detail-get-state', async (event) => {
    return { ok: true, state: getViewState(getAfterSaleDetailWindowContextByWebContents(event.sender)) };
  });
}

module.exports = {
  registerAfterSaleDetailWindowIpc
};
