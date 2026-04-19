'use strict';

const chatApiCacheStore = require('../../chat-api-cache-store');

/**
 * Chat 主链路 IPC 注册器：会话拉取、消息收发、媒体上传、轮询、收藏与
 * 上次会话选择持久化。
 *
 * 这一层不直接依赖 mail / invoice / ticket 等业务客户端，关心的只是：
 * - PddApiClient（getApiClient）—— 单店铺的会话/消息/媒体能力；
 * - getApiSessionsByScope / getApiShopList —— 跨店铺聚合与按域选店；
 * - uploadImageViaPddPage —— 浏览器侧兜底图片上传；
 * - destroyApiClient —— stop polling 时复用 client 析构逻辑；
 * - dialog + getMainWindow —— 选择本地图片/视频和 polling 回包广播；
 * - chatApiCacheStore + store —— 会话/消息缓存以及 starred / last selection。
 *
 * 所有跨店铺判断都通过 sharedHelpers.API_ALL_SHOPS / resolveShopId 完成，
 * 与 mail / invoice / ticket 等子模块保持一致的 shopId 处理路径。
 */
function registerChatIpc({
  ipcMain,
  dialog,
  store,
  sharedHelpers,
  getMainWindow,
  getApiClient,
  getApiSessionsByScope,
  uploadImageViaPddPage,
  getApiShopList,
  destroyApiClient,
  getApiShopAvailabilityStatus,
}) {
  const {
    API_ALL_SHOPS,
    resolveShopId,
    buildApiErrorMessage,
  } = sharedHelpers;

  const verboseLogging = process.env.NODE_ENV === 'development' || process.env.PDD_VERBOSE_LOG === '1';

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

  ipcMain.handle('api-init-session', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有活跃店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      console.log(`[PDD接口:${shopId}] 显式调用 api-init-session: ${String(params?.source || 'renderer-manual')}`);
      return await getApiClient(shopId).initSession(true, {
        source: String(params?.source || 'renderer-manual')
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-test-connection', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有活跃店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      return await getApiClient(shopId).testConnection({
        initializeSession: params?.initializeSession === true
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-sessions', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      const sessions = await getApiSessionsByScope(shopId, params.page || 1, params.pageSize || 20, params);
      if (verboseLogging) {
        console.log(`[PDD接口:${shopId}] api-get-sessions 返回 ${Array.isArray(sessions) ? sessions.length : 0} 条`);
      }
      return sessions;
    } catch (error) {
      console.log(`[PDD接口:${shopId}] api-get-sessions 失败: ${error.message}`);
      return { error: error.message };
    }
  });

  ipcMain.handle('api-find-session-by-order-sn', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    const orderSn = String(params.orderSn || params.order_sn || '').trim();
    if (!shopId) return { error: '没有可用店铺' };
    if (!orderSn) return { error: '缺少订单号' };
    const targetShops = getApiShopList(shopId, { apiReadyOnly: shopId === API_ALL_SHOPS });
    if (!targetShops.length) {
      return { error: '没有可用店铺' };
    }
    const failures = [];
    for (const shop of targetShops) {
      try {
        const session = await getApiClient(shop.id).findSessionByOrderSn(orderSn, {
          pageLimit: params.pageLimit,
          pageSize: params.pageSize,
        });
        if (session?.sessionId) {
          return {
            ...session,
            shopId: shop.id,
            shopName: session.shopName || shop.name || '未知店铺',
            shopStatus: getApiShopAvailabilityStatus(shop),
          };
        }
      } catch (error) {
        failures.push({
          shopId: shop.id,
          shopName: shop.name || shop.id,
          message: error.message || '查找失败',
        });
      }
    }
    if (failures.length && shopId !== API_ALL_SHOPS) {
      return { error: failures[0]?.message || '未找到对应订单会话' };
    }
    return { error: '未找到对应订单会话' };
  });

  ipcMain.handle('api-get-messages', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      // 允许首次 init：依赖 initSession 内部 sticky 标志，已 init 过的店铺不会重复加载 chat-merchant。
      // polling（_pollMessagesForSession）仍保留 allowInitSession:false，杜绝隐式后台拉起 chat-merchant。
      const result = await getApiClient(shopId).getSessionMessages(
        params.session || params.sessionId,
        params.page || 1,
        params.pageSize || 30,
        { allowInitSession: true }
      );
      // 仅在第一页成功返回有效列表时落盘，避免分页加载历史时把当前页覆盖进缓存
      if (Array.isArray(result) && result.length && Number(params.page || 1) === 1) {
        chatApiCacheStore.scheduleWriteMessages(shopId, String(params.sessionId), result);
      }
      return result;
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-cached-sessions', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId || shopId === API_ALL_SHOPS) {
      // 显示所有店铺时让渲染层自行按已知 shopId 列表调用，避免主进程不必要的合并复杂度
      return null;
    }
    return chatApiCacheStore.readSessions(shopId);
  });

  ipcMain.handle('api-get-cached-messages', (event, params = {}) => {
    const shopId = String(params?.shopId || '').trim();
    const sessionId = String(params?.sessionId || '').trim();
    if (!shopId || !sessionId) return null;
    return chatApiCacheStore.readMessages(shopId, sessionId);
  });

  ipcMain.handle('api-send-message', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.text) return { error: '缺少发送内容' };
    try {
      return await getApiClient(shopId).sendManualMessage(params.session || params.sessionId, params.text, {
        manualSource: 'renderer-manual',
      });
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
          const uploadResult = await uploadImageViaPddPage(shopId, params.filePath, {
            source: 'api-send-image:upload-fallback'
          });
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
      const uploadResult = await uploadImageViaPddPage(shopId, params.filePath, {
        source: 'api-upload-video:page-upload'
      });
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

  ipcMain.handle('api-start-polling', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      if (!targetShops.length) {
        return { error: '显示所有店铺时，没有已验证在线的店铺可用于接口轮询' };
      }
      targetShops.forEach(shop => getApiClient(shop.id).startPolling());
      const bootstrapResults = await Promise.allSettled(targetShops.map(async shop => {
        const sessions = await getApiClient(shop.id).getSessionList(1, 100);
        const normalizedSessions = Array.isArray(sessions)
          ? sessions
            .filter(item => item && item.sessionId)
            .map(item => ({
              ...item,
              shopId: shop.id,
              shopName: item?.shopName || item?.mallName || shop.name || '未知店铺',
            }))
          : [];
        if (normalizedSessions.length) {
          getMainWindow()?.webContents.send('api-session-updated', {
            shopId: shop.id,
            sessions: normalizedSessions,
          });
        }
        return {
          shopId: shop.id,
          count: normalizedSessions.length,
        };
      }));
      const successCount = bootstrapResults.filter(item => item.status === 'fulfilled').length;
      const sessionCount = bootstrapResults.reduce((sum, item) => (
        item.status === 'fulfilled' ? sum + Number(item.value?.count || 0) : sum
      ), 0);
      return { ok: true, shopId, count: targetShops.length, bootstrapCount: successCount, sessionCount };
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

module.exports = { registerChatIpc };
