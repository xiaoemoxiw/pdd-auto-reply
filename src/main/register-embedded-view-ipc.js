function registerEmbeddedViewIpc({
  ipcMain,
  store,
  getCurrentView,
  setCurrentView,
  getShopManager,
  isEmbeddedPddView,
  isMailPageUrl,
  isInvoicePageUrl,
  isViolationPageUrl,
  isTicketPageUrl,
  isChatPageUrl,
  getPddMailUrl,
  getPddInvoiceUrl,
  getPddViolationUrl,
  getPddTicketUrl,
  getPddChatUrl,
  getEmbeddedViewUrl
}) {
  ipcMain.handle('reload-pdd', () => {
    const view = getShopManager()?.getActiveView();
    if (!view) return;
    view.webContents.loadURL(getEmbeddedViewUrl(getCurrentView()));
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

  ipcMain.handle('get-current-url', () => {
    const view = getShopManager()?.getActiveView();
    return view ? view.webContents.getURL() : '';
  });

  ipcMain.handle('navigate-pdd', (event, url) => {
    const view = getShopManager()?.getActiveView();
    if (view) view.webContents.loadURL(url);
  });

  ipcMain.handle('switch-view', (event, view) => {
    setCurrentView(view);
    const shopManager = getShopManager();
    if (isEmbeddedPddView(view)) {
      const activeView = shopManager?.getActiveView();
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
        if (view === 'chat' && !isChatPageUrl(currentUrl)) {
          activeView.webContents.loadURL(getPddChatUrl());
        }
      }
    } else if (shopManager) {
      shopManager.hideActiveView();
    }
    return true;
  });

  ipcMain.handle('get-current-view', () => getCurrentView());
}

module.exports = {
  registerEmbeddedViewIpc
};
