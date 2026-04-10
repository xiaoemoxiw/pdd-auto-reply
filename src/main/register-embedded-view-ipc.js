function registerEmbeddedViewIpc({
  ipcMain,
  store,
  getMainWindow,
  getCurrentView,
  setCurrentView,
  getShopManager,
  isEmbeddedPddView,
  isMailPageUrl,
  isInvoicePageUrl,
  isViolationPageUrl,
  isTicketPageUrl,
  isAfterSalePageUrl,
  isChatPageUrl,
  getPddMailUrl,
  getPddInvoiceUrl,
  getPddViolationUrl,
  getPddTicketUrl,
  getPddAfterSaleUrl,
  getPddChatUrl,
  getEmbeddedViewUrl
}) {
  function sendPageFailure(payload = {}) {
    const mainWindow = getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('pdd-page-failed', payload);
  }

  function ensureActiveView(targetView = getCurrentView()) {
    const shopManager = getShopManager();
    if (!shopManager) {
      sendPageFailure({
        view: targetView,
        reason: 'shop-manager-unavailable',
        errorDescription: '店铺管理器未初始化'
      });
      return { shopManager: null, activeView: null };
    }
    let activeView = shopManager.getActiveView();
    if (!activeView && isEmbeddedPddView(targetView)) {
      shopManager.syncActiveShopSelection({ showView: true });
      activeView = shopManager.getActiveView();
    }
    if (!activeView && isEmbeddedPddView(targetView)) {
      sendPageFailure({
        view: targetView,
        reason: shopManager.getActiveShopId?.() ? 'missing-view' : 'no-active-shop',
        errorDescription: shopManager.getActiveShopId?.()
          ? '当前店铺嵌入页未初始化，请刷新或重新切换店铺'
          : '当前没有可用店铺，请先选择在线店铺'
      });
    }
    return { shopManager, activeView };
  }

  ipcMain.handle('reload-pdd', () => {
    const { activeView } = ensureActiveView(getCurrentView());
    if (!activeView) return false;
    activeView.webContents.loadURL(getEmbeddedViewUrl(getCurrentView()));
    return true;
  });

  ipcMain.handle('get-chat-url', () => store.get('chatUrl'));
  ipcMain.handle('set-chat-url', (event, url) => {
    store.set('chatUrl', url);
    return true;
  });

  ipcMain.handle('get-mail-url', () => store.get('mailUrl'));
  ipcMain.handle('set-mail-url', (event, url) => {
    store.set('mailUrl', url);
    return true;
  });

  ipcMain.handle('get-invoice-url', () => store.get('invoiceUrl'));
  ipcMain.handle('set-invoice-url', (event, url) => {
    store.set('invoiceUrl', url);
    return true;
  });

  ipcMain.handle('get-violation-url', () => store.get('violationUrl'));
  ipcMain.handle('set-violation-url', (event, url) => {
    store.set('violationUrl', url);
    return true;
  });

  ipcMain.handle('get-ticket-url', () => store.get('ticketUrl'));
  ipcMain.handle('set-ticket-url', (event, url) => {
    store.set('ticketUrl', url);
    return true;
  });

  ipcMain.handle('get-aftersale-url', () => store.get('aftersaleUrl'));
  ipcMain.handle('set-aftersale-url', (event, url) => {
    store.set('aftersaleUrl', url);
    return true;
  });

  ipcMain.handle('get-current-url', () => {
    const view = getShopManager()?.getActiveView();
    return view ? view.webContents.getURL() : '';
  });

  ipcMain.handle('navigate-pdd', (event, url) => {
    const { activeView } = ensureActiveView(getCurrentView());
    if (!activeView) return false;
    activeView.webContents.loadURL(url);
    return true;
  });

  ipcMain.handle('switch-view', (event, view) => {
    setCurrentView(view);
    if (isEmbeddedPddView(view)) {
      const { shopManager, activeView } = ensureActiveView(view);
      if (shopManager) shopManager.showActiveView();
      if (activeView) {
        const currentUrl = activeView.webContents.getURL();
        if (view === 'mail' && !isMailPageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddMailUrl());
        }
        if (view === 'invoice' && !isInvoicePageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddInvoiceUrl());
        }
        if (view === 'violation' && !isViolationPageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddViolationUrl());
        }
        if (view === 'ticket' && !isTicketPageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddTicketUrl());
        }
        if (view === 'aftersale' && !isAfterSalePageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddAfterSaleUrl());
        }
        if (view === 'chat' && !isChatPageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddChatUrl());
        }
        return true;
      }
      return false;
    }
    const { shopManager } = ensureActiveView(view);
    if (shopManager) {
      shopManager.hideActiveView();
    }
    return true;
  });

  ipcMain.handle('get-current-view', () => getCurrentView());

  ipcMain.handle('open-invoice-order-overlay', async (event, params = {}) => {
    const orderSn = String(params.orderSn || params.order_sn || '').trim();
    const serialNo = String(params.serialNo || params.serial_no || '').trim();
    const topOffset = Math.max(0, Number(params.topOffset || 0));
    const { shopManager, activeView } = ensureActiveView('invoice');
    if (!shopManager || !activeView) return { error: '当前店铺嵌入页未初始化' };
    const base = getPddInvoiceUrl();
    let targetUrl = base;
    try {
      const url = new URL(base);
      if (orderSn) url.searchParams.set('order_sn', orderSn);
      if (serialNo) url.searchParams.set('serial_no', serialNo);
      url.searchParams.set('msfrom', url.searchParams.get('msfrom') || 'mms_sidenav');
      targetUrl = url.toString();
    } catch {}
    if (typeof shopManager.showActiveViewOverlay === 'function') {
      shopManager.showActiveViewOverlay(topOffset);
    } else {
      shopManager.showActiveView();
    }
    activeView.webContents.loadURL(targetUrl);
    return { ok: true };
  });

  ipcMain.handle('close-embedded-overlay', () => {
    const shopManager = getShopManager();
    if (shopManager) shopManager.hideActiveView();
    return true;
  });
}

module.exports = {
  registerEmbeddedViewIpc
};
