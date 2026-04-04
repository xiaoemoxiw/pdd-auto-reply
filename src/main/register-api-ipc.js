function registerApiIpc({
  ipcMain,
  dialog,
  store,
  API_ALL_SHOPS,
  getMainWindow,
  getShopManager,
  getApiClient,
  getApiSessionsByScope,
  uploadImageViaPddPage,
  getApiShopList,
  destroyApiClient,
  getApiTrafficByScope,
  getMailApiClient,
  getInvoiceApiClient,
  setApiTrafficEntries
}) {
  function getActiveShopId() {
    return getShopManager()?.getActiveShopId();
  }

  function resolveShopId(params = {}) {
    return params.shopId || getActiveShopId();
  }

  function buildApiErrorMessage(error) {
    const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null;
    const payloadMessage = payload
      ? String(
        payload.error_msg
        || payload.errorMsg
        || payload.message
        || payload.msg
        || payload?.result?.error_msg
        || payload?.result?.errorMsg
        || payload?.result?.message
        || payload?.data?.error_msg
        || payload?.data?.errorMsg
        || payload?.data?.message
        || ''
      ).trim()
      : '';
    const payloadCode = payload
      ? String(
        payload.error_code
        || payload.code
        || payload.err_no
        || payload.errno
        || payload?.result?.error_code
        || payload?.result?.code
        || payload?.data?.error_code
        || payload?.data?.code
        || ''
      ).trim()
      : '';
    const fallbackMessage = String(error?.message || '').trim() || 'API 请求失败';
    if (payloadMessage && payloadCode) return `${payloadMessage}（${payloadCode}）`;
    if (payloadMessage) return payloadMessage;
    if (payloadCode && fallbackMessage === 'API 请求失败') return `${fallbackMessage}（${payloadCode}）`;
    return fallbackMessage;
  }

  function getLastApiSessionSelection() {
    const selection = store.get('lastApiSessionSelection') || null;
    if (!selection?.shopId || !selection?.sessionId) return null;
    return {
      shopId: String(selection.shopId),
      sessionId: String(selection.sessionId),
      customerName: selection.customerName || '',
      updatedAt: Number(selection.updatedAt || 0)
    };
  }

  ipcMain.handle('api-get-token-status', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有活跃店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    return getApiClient(shopId).getTokenStatus();
  });

  ipcMain.handle('api-init-session', async () => {
    const shopId = getActiveShopId();
    if (!shopId) return { error: '没有活跃店铺' };
    try {
      return await getApiClient(shopId).initSession(true);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-test-connection', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有活跃店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      return await getApiClient(shopId).testConnection();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-sessions', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      const sessions = await getApiSessionsByScope(shopId, params.page || 1, params.pageSize || 20);
      console.log(`[PDD接口:${shopId}] api-get-sessions 返回 ${Array.isArray(sessions) ? sessions.length : 0} 条`);
      return sessions;
    } catch (error) {
      console.log(`[PDD接口:${shopId}] api-get-sessions 失败: ${error.message}`);
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-messages', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getSessionMessages(
        params.session || params.sessionId,
        params.page || 1,
        params.pageSize || 30
      );
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-goods-card', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.url) return { error: '缺少商品链接' };
    try {
      return await getApiClient(shopId).getGoodsCard(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-refund-orders', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getRefundOrders(params.session || params.sessionId);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-submit-refund-apply', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).submitRefundApply(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-side-orders', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getSideOrders(params.session || params.sessionId, params.tab);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-order-remark', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).getOrderRemark(params.orderSn, params.source);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-order-remark-tags', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getApiClient(shopId).getOrderRemarkTagOptions(Boolean(params.force));
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-save-order-remark', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).saveOrderRemark(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-update-order-price', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).updateOrderPrice(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-send-message', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.text) return { error: '缺少发送内容' };
    try {
      return await getApiClient(shopId).sendMessage(params.session || params.sessionId, params.text);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-select-image', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('api-select-video', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'] }]
    });
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('api-send-image', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.filePath) return { error: '缺少图片路径' };
    const client = getApiClient(shopId);
    try {
      return await client.sendImage(params.session || params.sessionId, params.filePath);
    } catch (error) {
      if (error.step === 'upload' && /ERR_BLOCKED_BY_CLIENT/i.test(error.message || '')) {
        try {
          const uploadResult = await uploadImageViaPddPage(shopId, params.filePath);
          const imageUrl = uploadResult?.processed_url || uploadResult?.url;
          return await client.sendImageUrl(params.session || params.sessionId, imageUrl, {
            filePath: params.filePath,
            uploadBaseUrl: uploadResult?.uploadBaseUrl || 'embedded-pdd-page'
          });
        } catch (fallbackError) {
          return {
            error: fallbackError.message,
            step: 'upload-fallback',
            attempts: Array.isArray(error.attempts) ? error.attempts : [],
            imageUrl: '',
            uploadBaseUrl: 'embedded-pdd-page'
          };
        }
      }
      return {
        error: error.message,
        step: error.step || '',
        attempts: Array.isArray(error.attempts) ? error.attempts : [],
        imageUrl: error.imageUrl || '',
        uploadBaseUrl: error.uploadBaseUrl || ''
      };
    }
  });

  ipcMain.handle('api-get-video-library', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getApiClient(shopId).getVideoLibrary(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-send-video', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    const videoUrl = String(params.videoUrl || params.url || '').trim();
    if (!videoUrl) return { error: '缺少视频地址' };
    try {
      return await getApiClient(shopId).sendVideoUrl(params.session || params.sessionId, videoUrl, params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-upload-video', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.filePath) return { error: '缺少视频路径' };
    try {
      const uploadResult = await uploadImageViaPddPage(shopId, params.filePath);
      const client = getApiClient(shopId);
      const fileDetail = await client.waitVideoFileReady({
        fileId: uploadResult?.file_id || uploadResult?.id,
        fileUrl: uploadResult?.file_url || uploadResult?.url || uploadResult?.processed_url || uploadResult?.download_url,
        timeoutMs: params.timeoutMs,
      });
      return {
        success: true,
        ...fileDetail,
      };
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-mark-latest-conversations', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getApiClient(shopId).markLatestConversations(params.size || 100);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-start-polling', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      if (!targetShops.length) {
        return { error: '显示所有店铺时，没有已恢复 Token 的店铺可用于接口轮询' };
      }
      targetShops.forEach(shop => getApiClient(shop.id).startPolling());
      return { ok: true, shopId, count: targetShops.length };
    }
    getApiClient(shopId).startPolling();
    return { ok: true, shopId };
  });

  ipcMain.handle('api-stop-polling', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS);
      targetShops.forEach(shop => destroyApiClient(shop.id));
      return { ok: true, shopId, count: targetShops.length };
    }
    destroyApiClient(shopId);
    return { ok: true, shopId };
  });

  ipcMain.handle('get-api-traffic', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return [];
    return getApiTrafficByScope(shopId);
  });

  ipcMain.handle('mail-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getMailApiClient(shopId).getOverview();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('mail-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getMailApiClient(shopId).getList(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('mail-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.messageId) return { error: '缺少 messageId' };
    try {
      return await getMailApiClient(shopId).getDetail(params.messageId);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('invoice-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getInvoiceApiClient(shopId).getOverview();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('invoice-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getInvoiceApiClient(shopId).getList(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('clear-api-traffic', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return false;
    if (shopId === API_ALL_SHOPS) {
      getApiShopList(API_ALL_SHOPS).forEach(shop => setApiTrafficEntries(shop.id, []));
      return true;
    }
    setApiTrafficEntries(shopId, []);
    return true;
  });

  ipcMain.handle('get-api-starred-sessions', () => store.get('apiStarredSessions') || []);

  ipcMain.handle('get-last-api-session-selection', () => getLastApiSessionSelection());

  ipcMain.handle('set-last-api-session-selection', (event, selection = {}) => {
    const shopId = String(selection.shopId || '').trim();
    const sessionId = String(selection.sessionId || '').trim();
    if (!shopId || !sessionId) {
      store.delete('lastApiSessionSelection');
      return null;
    }
    const nextSelection = {
      shopId,
      sessionId,
      customerName: selection.customerName || '',
      updatedAt: Date.now()
    };
    store.set('lastApiSessionSelection', nextSelection);
    return nextSelection;
  });

  ipcMain.handle('clear-last-api-session-selection', () => {
    store.delete('lastApiSessionSelection');
    return true;
  });

  ipcMain.handle('toggle-api-starred-session', (event, session = {}) => {
    const sessions = store.get('apiStarredSessions') || [];
    const sessionKey = String(session.sessionKey || `${session.shopId || ''}::${session.sessionId || ''}`);
    if (!session.shopId || !session.sessionId || !sessionKey) {
      return { error: '缺少收藏会话标识', sessions };
    }
    const currentIndex = sessions.findIndex(item => item.sessionKey === sessionKey);
    if (currentIndex >= 0) {
      sessions.splice(currentIndex, 1);
      store.set('apiStarredSessions', sessions);
      return { starred: false, sessions };
    }
    const nextSession = {
      sessionKey,
      shopId: session.shopId,
      sessionId: session.sessionId,
      shopName: session.shopName || '',
      customerName: session.customerName || '',
      customerId: session.customerId || '',
      customerAvatar: session.customerAvatar || '',
      lastMessage: session.lastMessage || '',
      lastMessageTime: session.lastMessageTime || 0,
      lastMessageActor: session.lastMessageActor || '',
      lastMessageIsFromBuyer: session.lastMessageIsFromBuyer === true,
      unreadCount: session.unreadCount || 0,
      orderId: session.orderId || '',
      updatedAt: Date.now()
    };
    sessions.unshift(nextSession);
    store.set('apiStarredSessions', sessions);
    return { starred: true, sessions };
  });
}

module.exports = {
  registerApiIpc
};
