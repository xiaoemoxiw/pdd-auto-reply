const {
  createMailDetailWindow,
  getMailDetailWindow,
  setMailDetailToolbarHeight,
  loadMailDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
} = require('./mail-detail-window');

function buildMailDetailUrl(params = {}) {
  const messageId = String(params?.messageId || params?.id || '').trim();
  const type = String(params?.type || params?.contentType || '').trim();
  let targetUrl = String(params?.url || '').trim() || 'https://mms.pinduoduo.com/other/mail/mailDetail';
  if (!targetUrl) return '';
  if (!messageId) return '';
  try {
    const url = new URL(targetUrl);
    url.searchParams.set('id', messageId);
    if (type) url.searchParams.set('type', type);
    targetUrl = url.toString();
  } catch {}
  return targetUrl;
}

function isDetailWindowSender(event) {
  const win = getMailDetailWindow();
  if (!win || win.isDestroyed()) return false;
  return win.webContents && event.sender && win.webContents.id === event.sender.id;
}

function registerMailDetailWindowIpc({
  ipcMain,
  store
}) {
  ipcMain.handle('mail-open-detail-window', async (event, params = {}) => {
    try {
      const url = buildMailDetailUrl(params);
      if (!url) return { error: '缺少站内信详情链接或 messageId' };
      const shopId = String(params?.shopId || '').trim();

      const win = await createMailDetailWindow();
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };
      try {
        if (typeof win.setParentWindow === 'function') win.setParentWindow(null);
      } catch {}

      const res = loadMailDetailUrl(store, shopId, url);
      if (res && res.error) return res;
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('mail-detail-set-toolbar-height', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    setMailDetailToolbarHeight(params?.height);
    return { ok: true };
  });

  ipcMain.handle('mail-detail-navigate', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadMailDetailUrl(store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('mail-detail-back', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goBack();
  });

  ipcMain.handle('mail-detail-forward', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goForward();
  });

  ipcMain.handle('mail-detail-reload', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return reload();
  });

  ipcMain.handle('mail-detail-get-state', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return { ok: true, state: getViewState() };
  });
}

module.exports = {
  registerMailDetailWindowIpc
};
