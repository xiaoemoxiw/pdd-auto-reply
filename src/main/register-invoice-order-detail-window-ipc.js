const {
  createInvoiceOrderDetailWindow,
  getInvoiceOrderDetailWindow,
  setInvoiceOrderDetailToolbarHeight,
  loadInvoiceOrderDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
} = require('./invoice-order-detail-window');

function buildInvoiceOrderDetailUrl(base, params = {}) {
  const orderSn = String(params?.orderSn || params?.order_sn || '').trim();
  const serialNo = String(params?.serialNo || params?.serial_no || '').trim();
  let targetUrl = String(params?.url || '').trim() || String(base || '').trim();
  if (!targetUrl) return '';
  try {
    const url = new URL(targetUrl);
    if (orderSn) url.searchParams.set('order_sn', orderSn);
    if (serialNo) url.searchParams.set('serial_no', serialNo);
    url.searchParams.set('msfrom', url.searchParams.get('msfrom') || 'mms_sidenav');
    targetUrl = url.toString();
  } catch {}
  return targetUrl;
}

function isDetailWindowSender(event) {
  const win = getInvoiceOrderDetailWindow();
  if (!win || win.isDestroyed()) return false;
  return win.webContents && event.sender && win.webContents.id === event.sender.id;
}

function registerInvoiceOrderDetailWindowIpc({
  ipcMain,
  store,
  getMainWindow,
  getPddInvoiceUrl
}) {
  ipcMain.handle('invoice-open-order-detail-window', async (event, params = {}) => {
    try {
      const shopId = String(params?.shopId || '').trim();
      const base = typeof getPddInvoiceUrl === 'function' ? getPddInvoiceUrl() : '';
      const url = buildInvoiceOrderDetailUrl(base, params);
      if (!url) return { error: '缺少订单详情链接' };

      const mainWindow = getMainWindow?.();
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const win = await createInvoiceOrderDetailWindow(parent);
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };

      const res = loadInvoiceOrderDetailUrl(store, shopId, url);
      if (res && res.error) return res;
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('invoice-order-detail-set-toolbar-height', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    setInvoiceOrderDetailToolbarHeight(params?.height);
    return { ok: true };
  });

  ipcMain.handle('invoice-order-detail-navigate', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadInvoiceOrderDetailUrl(store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('invoice-order-detail-back', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goBack();
  });

  ipcMain.handle('invoice-order-detail-forward', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goForward();
  });

  ipcMain.handle('invoice-order-detail-reload', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return reload();
  });

  ipcMain.handle('invoice-order-detail-get-state', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return { ok: true, state: getViewState() };
  });
}

module.exports = {
  registerInvoiceOrderDetailWindowIpc
};

