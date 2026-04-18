const {
  createMailDetailWindow,
  getMailDetailWindowContextByWebContents,
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

function buildMailDetailWindowReuseKey(params = {}, url = '') {
  const shopId = String(params?.shopId || params?.shop_id || '').trim();
  const messageId = String(params?.messageId || params?.id || '').trim();
  const type = String(params?.type || params?.contentType || '').trim();
  if (shopId && messageId && type) return `shop:${shopId}:msg:${messageId}:type:${type}`;
  if (messageId && type) return `msg:${messageId}:type:${type}`;
  if (shopId && messageId) return `shop:${shopId}:msg:${messageId}`;
  if (messageId) return `msg:${messageId}`;
  const targetUrl = String(url || '').trim();
  return shopId && targetUrl ? `shop:${shopId}:url:${targetUrl}` : (targetUrl ? `url:${targetUrl}` : '');
}

function registerMailDetailWindowIpc({
  ipcMain,
  store,
  getMainWindow
}) {
  ipcMain.handle('mail-open-detail-window', async (event, params = {}) => {
    try {
      const url = buildMailDetailUrl(params);
      if (!url) return { error: '缺少站内信详情链接或 messageId' };
      const shopId = String(params?.shopId || '').trim();

      const mainWindow = getMainWindow?.();
      const { win, reused } = await createMailDetailWindow({
        reuseKey: buildMailDetailWindowReuseKey(params, url)
      });
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };

      const res = loadMailDetailUrl(win, store, shopId, url);
      if (res && res.error) return res;
      if (!reused && mainWindow && !mainWindow.isDestroyed()) {
        try {
          const [mainX, mainY] = mainWindow.getPosition();
          win.setPosition(mainX + 40, mainY + 40);
        } catch {}
      }
      win.show();
      win.focus();
      return { ok: true, reused: reused === true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('mail-detail-set-toolbar-height', async (event, params = {}) => {
    return setMailDetailToolbarHeight(getMailDetailWindowContextByWebContents(event.sender), params?.height);
  });

  ipcMain.handle('mail-detail-navigate', async (event, params = {}) => {
    const context = getMailDetailWindowContextByWebContents(event.sender);
    if (!context?.window || context.window.isDestroyed()) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadMailDetailUrl(context, store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('mail-detail-back', async (event) => {
    return goBack(getMailDetailWindowContextByWebContents(event.sender));
  });

  ipcMain.handle('mail-detail-forward', async (event) => {
    return goForward(getMailDetailWindowContextByWebContents(event.sender));
  });

  ipcMain.handle('mail-detail-reload', async (event) => {
    return reload(getMailDetailWindowContextByWebContents(event.sender));
  });

  ipcMain.handle('mail-detail-get-state', async (event) => {
    return { ok: true, state: getViewState(getMailDetailWindowContextByWebContents(event.sender)) };
  });
}

module.exports = {
  registerMailDetailWindowIpc
};
