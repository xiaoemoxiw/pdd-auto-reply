const {
  createAfterSaleDetailWindow,
  getAfterSaleDetailWindow,
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

function isDetailWindowSender(event) {
  const win = getAfterSaleDetailWindow();
  if (!win || win.isDestroyed()) return false;
  return win.webContents && event.sender && win.webContents.id === event.sender.id;
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

      const win = await createAfterSaleDetailWindow();
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };

      const res = loadAfterSaleDetailUrl(store, shopId, url);
      if (res && res.error) return res;
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('aftersale-detail-set-toolbar-height', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    setAfterSaleDetailToolbarHeight(params?.height);
    return { ok: true };
  });

  ipcMain.handle('aftersale-detail-navigate', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadAfterSaleDetailUrl(store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('aftersale-detail-back', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goBack();
  });

  ipcMain.handle('aftersale-detail-forward', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goForward();
  });

  ipcMain.handle('aftersale-detail-reload', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return reload();
  });

  ipcMain.handle('aftersale-detail-get-state', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return { ok: true, state: getViewState() };
  });
}

module.exports = {
  registerAfterSaleDetailWindowIpc
};
