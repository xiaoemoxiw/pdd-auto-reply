function registerShopIpc({
  ipcMain,
  store,
  getShopManager,
  getCurrentView,
  isEmbeddedPddView,
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
    const switched = shopManager.switchTo(shopId);
    if (switched && !isEmbeddedPddView?.(getCurrentView?.())) {
      shopManager.hideActiveView();
    }
    return switched;
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
      const result = await shopManager.syncShopsFromTokenFiles({ broadcast: false });
      return Array.isArray(result?.shops) ? result.shops : result;
    }
    return store.get('shops');
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
