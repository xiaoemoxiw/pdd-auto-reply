const { shell } = require('electron');
const chatApiCacheStore = require('./chat-api-cache-store');

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
  getTicketApiClient,
  getViolationApiClient,
  getDeductionApiClient,
  getApiShopAvailabilityStatus,
  setApiTrafficEntries
}) {
  const verboseLogging = process.env.NODE_ENV === 'development' || process.env.PDD_VERBOSE_LOG === '1';

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

  function getBusinessUnavailableMessage(shop) {
    const availabilityStatus = getApiShopAvailabilityStatus(shop);
    if (availabilityStatus === 'expired' || availabilityStatus === 'invalid') {
      return '会话已过期，请重新登录';
    }
    if (availabilityStatus !== 'online') {
      return '店铺未验证在线，请先完成登录校验';
    }
    return '店铺当前不可用';
  }

  function buildTicketStatusCountSummary(result = {}) {
    const rawList = Array.isArray(result?.list) ? result.list : [];
    const normalized = rawList
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const label = String(
          item.statusDesc
          || item.status_desc
          || item.name
          || item.label
          || item.text
          || item.status
          || item.code
          || ''
        ).trim();
        const count = Number(
          item.count
          ?? item.num
          ?? item.total
          ?? item.value
          ?? 0
        );
        return {
          label,
          count: Number.isFinite(count) ? count : 0
        };
      })
      .filter(Boolean);
    return {
      itemCount: normalized.length,
      totalCount: normalized.reduce((sum, item) => sum + Number(item.count || 0), 0),
      items: normalized.slice(0, 10)
    };
  }

  function buildInvoiceOverviewSummary(result = {}) {
    return {
      pendingNum: Number(result?.pendingNum || 0),
      invoicedNum: Number(result?.invoicedNum || 0),
      applyingNum: Number(result?.applyingNum || 0),
      invoiceAmount: Number(result?.invoiceAmount || 0),
      quickPendingTotal: Number(result?.quickPendingTotal || 0),
      qualityPendingTotal: Number(result?.qualityPendingTotal || 0),
      normalPendingTotal: Number(result?.normalPendingTotal || 0),
      showInvoiceMarkTab: !!result?.showInvoiceMarkTab,
      isThirdPartySubMall: !!result?.isThirdPartySubMall,
    };
  }

  function buildInvoiceListSummary(result = {}) {
    const rawList = Array.isArray(result?.list) ? result.list : [];
    return {
      pageNo: Number(result?.pageNo || 1),
      pageSize: Number(result?.pageSize || rawList.length || 0),
      total: Number(result?.total || 0),
      sample: rawList.slice(0, 3).map(item => ({
        serialNo: String(item?.serialNo || ''),
        orderSn: String(item?.orderSn || ''),
        orderStatus: String(item?.orderStatus || ''),
        invoiceApplyStatus: String(item?.invoiceApplyStatus || ''),
        invoiceDisplayStatus: Number(item?.invoiceDisplayStatus || 0),
      }))
    };
  }

  function buildViolationListSummary(result = {}) {
    const rawList = Array.isArray(result?.list) ? result.list : [];
    const sample = rawList.slice(0, 3).map(item => ({
      violationAppealSn: String(
        item?.violationAppealSn
        || item?.violation_appeal_sn
        || item?.noticeSn
        || item?.notice_sn
        || item?.serialNo
        || item?.serial_no
        || ''
      ),
      violationType: String(
        item?.violationTypeStr
        || item?.violation_type_str
        || item?.violationType
        || item?.violation_type
        || ''
      ),
      appealStatus: String(
        item?.appealStatusStr
        || item?.appeal_status_str
        || item?.appealStatus
        || item?.appeal_status
        || ''
      ),
      noticeTime: String(
        item?.noticeTime
        || item?.notice_time
        || item?.violationTime
        || item?.violation_time
        || ''
      )
    }));
    return {
      pageNo: Number(result?.pageNo || 1),
      pageSize: Number(result?.pageSize || rawList.length || 0),
      total: Number(result?.total || 0),
      typeCount: result?.typeMap && typeof result.typeMap === 'object'
        ? Object.keys(result.typeMap).length
        : 0,
      sample
    };
  }

  function shouldRetryViolationList(error) {
    const message = String(buildApiErrorMessage(error) || '').toLowerCase();
    return message.includes('会话已过期')
      || message.includes('登录已失效')
      || message.includes('auth')
      || message.includes('login');
  }

  async function invokePageApiWithRetry(shopId, request, options = {}) {
    try {
      return await request();
    } catch (error) {
      if (!shouldRetryViolationList(error) || options.allowInitSessionRetry !== true) {
        throw error;
      }
      console.log(`[PDD接口:${shopId}] 显式允许页面重试，准备 initSession(true): ${options.source || 'unknown'}`);
      await getApiClient(shopId).initSession(true, {
        source: String(options.source || 'unknown')
      });
      return request();
    }
  }

  function buildReadonlyTicketRequestOptions(source) {
    return {
      allowPageRequest: false,
      source: String(source || 'ticket-readonly')
    };
  }

  function buildWriteTicketRequestOptions(source) {
    return {
      source: String(source || 'ticket-write')
    };
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

  ipcMain.handle('probe-safe-business-apis', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const probeOptions = {
      invoiceOverview: params?.probes?.invoiceOverview !== false,
      invoiceList: params?.probes?.invoiceList === true,
      ticketStatusCount: params?.probes?.ticketStatusCount === true,
      violationList: params?.probes?.violationList === true,
    };
    const invoice = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.invoiceOverview
    };
    const invoiceList = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.invoiceList
    };
    const ticket = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.ticketStatusCount
    };
    const violationList = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.violationList
    };

    if (probeOptions.invoiceOverview) {
      try {
        const result = await getInvoiceApiClient(shopId).getOverview();
        invoice.success = true;
        invoice.summary = buildInvoiceOverviewSummary(result);
      } catch (error) {
        invoice.error = buildApiErrorMessage(error);
      }
    }

    if (probeOptions.invoiceList) {
      try {
        const result = await getInvoiceApiClient(shopId).getList({
          pageNo: 1,
          pageSize: 5
        });
        invoiceList.success = true;
        invoiceList.summary = buildInvoiceListSummary(result);
      } catch (error) {
        invoiceList.error = buildApiErrorMessage(error);
      }
    }

    if (probeOptions.ticketStatusCount) {
      try {
        const result = await getTicketApiClient(shopId).getStatusCount({
          allowPageRequest: false
        });
        ticket.success = true;
        ticket.summary = buildTicketStatusCountSummary(result);
      } catch (error) {
        ticket.error = buildApiErrorMessage(error);
      }
    }

    if (probeOptions.violationList) {
      try {
        const result = await getViolationApiClient(shopId).getList({
          pageNo: 1,
          pageSize: 5
        });
        violationList.success = true;
        violationList.summary = buildViolationListSummary(result);
      } catch (error) {
        violationList.error = buildApiErrorMessage(error);
      }
    }

    return {
      shopId,
      success: invoice.success || invoiceList.success || ticket.success || violationList.success,
      invoice,
      invoiceList,
      ticket
      ,
      violationList
    };
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

  ipcMain.handle('api-get-goods-card', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.url && !params.goodsId) return { error: '缺少商品链接' };
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

  ipcMain.handle('api-get-invite-order-state', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getInviteOrderState(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-invite-order-sku-options', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.itemId && !params.goodsId) return { error: '缺少商品标识' };
    try {
      return await getApiClient(shopId).getInviteOrderSkuOptions(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-add-invite-order-item', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.itemId) return { error: '缺少商品标识' };
    try {
      return await getApiClient(shopId).addInviteOrderItem(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-clear-invite-order-items', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).clearInviteOrderItems(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-submit-invite-order', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).submitInviteOrder(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-submit-invite-follow', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).submitInviteFollow(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-get-small-payment-info', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).getSmallPaymentInfo(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-submit-small-payment', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).submitSmallPayment(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
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

  ipcMain.handle('get-api-traffic', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return [];
    return getApiTrafficByScope(shopId);
  });

  ipcMain.handle('mail-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const failures = [];
      if (!targetShops.length) {
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        return {
          userId: 0,
          totalNum: 0,
          unreadNum: 0,
          categories: [],
          msgBoxCount: 0,
          innerMsgCount: 0,
          normalTotal: 0,
          customSubMsgTypeList: [],
          failures,
        };
      }
      try {
        const results = await Promise.all(targetShops.map(async shop => {
          try {
            const result = await invokePageApiWithRetry(shop.id, () => getMailApiClient(shop.id).getOverview());
            return {
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              result,
            };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return null;
          }
        }));
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        const categoryMap = new Map();
        let totalNum = 0;
        let unreadNum = 0;
        let msgBoxCount = 0;
        let innerMsgCount = 0;
        let normalTotal = 0;
        const customSubMsgTypeSet = new Set();
        results.filter(Boolean).forEach(entry => {
          const result = entry?.result || {};
          totalNum += Number(result.totalNum || 0);
          unreadNum += Number(result.unreadNum || 0);
          msgBoxCount += Number(result.msgBoxCount || 0);
          innerMsgCount += Number(result.innerMsgCount || 0);
          normalTotal += Number(result.normalTotal || 0);
          const categories = Array.isArray(result.categories) ? result.categories : [];
          categories.forEach(item => {
            const key = Number(item?.contentType);
            if (!Number.isFinite(key)) return;
            const prev = categoryMap.get(key) || {
              contentType: key,
              label: item?.label || `类型 ${key}`,
              unreadCount: 0,
              totalCount: 0,
            };
            prev.unreadCount += Number(item?.unreadCount || 0);
            if (item?.totalCount !== null && item?.totalCount !== undefined) {
              prev.totalCount += Number(item.totalCount || 0);
            } else {
              prev.totalCount = null;
            }
            categoryMap.set(key, prev);
          });
          const customList = Array.isArray(result.customSubMsgTypeList) ? result.customSubMsgTypeList : [];
          customList.forEach(item => {
            const text = String(item || '').trim();
            if (text) customSubMsgTypeSet.add(text);
          });
        });
        const categories = Array.from(categoryMap.values()).sort((a, b) => Number(a.contentType || 0) - Number(b.contentType || 0));
        return {
          userId: 0,
          totalNum,
          unreadNum,
          categories,
          msgBoxCount,
          innerMsgCount,
          normalTotal,
          customSubMsgTypeList: Array.from(customSubMsgTypeSet),
          failures,
        };
      } catch (error) {
        return { error: buildApiErrorMessage(error) };
      }
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getMailApiClient(shopId).getOverview());
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('mail-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const failures = [];
      const contentType = Number(params.contentType ?? -1);
      const hasReadStatus = params.readStatus === 0 || params.readStatus === 1 || params.readStatus === '0' || params.readStatus === '1';
      const pageSize = 50;
      const maxPages = Math.max(1, Math.min(100, Number(params.maxPages || 50)));
      if (!targetShops.length) {
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        return {
          contentType,
          pageNum: 1,
          size: pageSize,
          totalCount: 0,
          list: [],
          failures,
        };
      }
      try {
        const resultGroups = await Promise.all(targetShops.map(async shop => {
          try {
            let pageNum = 1;
            let totalCount = 0;
            let combined = [];
            while (pageNum <= maxPages) {
              const result = await invokePageApiWithRetry(shop.id, () => getMailApiClient(shop.id).getList({
                ...params,
                pageNum,
                size: pageSize,
              }));
              const list = Array.isArray(result?.list) ? result.list : [];
              totalCount = Math.max(totalCount, Number(result?.totalCount || 0));
              combined = combined.concat(list.map(item => ({
                ...item,
                shopId: shop.id,
                shopName: item.shopName || shop.name || '未知店铺',
              })));
              if (!list.length) break;
              if (totalCount && combined.length >= totalCount) break;
              pageNum += 1;
            }
            return {
              totalCount: Math.max(totalCount, combined.length),
              list: combined,
            };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { totalCount: 0, list: [] };
          }
        }));
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        const merged = resultGroups
          .flatMap(group => group.list || [])
          .sort((a, b) => Number(b.sendTime || 0) - Number(a.sendTime || 0));
        if (!merged.length && failures.length) {
          const summary = failures
            .slice(0, 3)
            .map(item => `${item.shopName || item.shopId}：${item.message}`)
            .join('；');
          return { error: summary ? `站内信列表加载失败：${summary}` : '站内信列表加载失败' };
        }
        return {
          contentType,
          pageNum: 1,
          size: merged.length,
          totalCount: merged.length,
          list: merged,
          failures,
        };
      } catch (error) {
        return { error: buildApiErrorMessage(error) };
      }
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getMailApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('mail-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.messageId) return { error: '缺少 messageId' };
    try {
      return await invokePageApiWithRetry(shopId, () => getMailApiClient(shopId).getDetail(params.messageId));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await invokePageApiWithRetry(shopId, () => getInvoiceApiClient(shopId).getOverview());
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      if (!targetShops.length) {
        return { error: '显示所有店铺时，没有已验证在线的店铺可用于待开票列表' };
      }
      const failures = [];
      try {
        const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
        const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 20));
        const resultGroups = await Promise.all(targetShops.map(async shop => {
          try {
            const result = await invokePageApiWithRetry(shop.id, () => getInvoiceApiClient(shop.id).getList({
              ...params,
              pageNo,
              pageSize,
            }));
            const list = Array.isArray(result?.list) ? result.list : [];
            const decorated = list.map(item => ({
              ...item,
              shopId: shop.id,
              shopName: item.shopName || shop.name || '未知店铺',
            }));
            return {
              total: Number(result?.total || 0),
              list: decorated,
            };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { total: 0, list: [] };
          }
        }));
        const merged = resultGroups
          .flatMap(group => group.list)
          .sort((a, b) => Number(b.applyTime || 0) - Number(a.applyTime || 0));
        if (!merged.length && failures.length) {
          const summary = failures
            .slice(0, 3)
            .map(item => `${item.shopName || item.shopId}：${item.message}`)
            .join('；');
          return { error: `待开票列表加载失败，共 ${failures.length} 个店铺失败：${summary}` };
        }
        return {
          pageNo,
          pageSize,
          total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
          list: merged,
        };
      } catch (error) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `待开票列表加载失败：${summary}` : buildApiErrorMessage(error) };
      }
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getInvoiceApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单号' };
    try {
      return await invokePageApiWithRetry(shopId, () => getInvoiceApiClient(shopId).getDetail(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-submit-record', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await invokePageApiWithRetry(
        shopId,
        () => getInvoiceApiClient(shopId).submitInvoiceRecord(params),
        { allowInitSessionRetry: true, source: 'invoice-submit-record' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('deduction-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const failures = [];
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      if (!targetShops.length) {
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        return { list: [], failures };
      }
      const resultGroups = await Promise.all(targetShops.map(async shop => {
        try {
          const result = await invokePageApiWithRetry(shop.id, () => getDeductionApiClient(shop.id).getList(forwardedParams));
          const list = Array.isArray(result?.list) ? result.list : [];
          const decorated = list.map(item => ({
            ...item,
            shopId: shop.id,
            shopName: item.shopName || shop.name || '未知店铺',
          }));
          return {
            totals: result?.totals || null,
            list: decorated,
          };
        } catch (error) {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未知店铺',
            message: buildApiErrorMessage(error),
          });
          return { totals: null, list: [] };
        }
      }));
      skippedShops.forEach(shop => {
        failures.push({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        });
      });
      const merged = resultGroups.flatMap(group => group.list || []);
      if (!merged.length && failures.length) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `扣款列表加载失败：${summary}` : '扣款列表加载失败' };
      }
      const totals = resultGroups.reduce((acc, group) => {
        const src = group?.totals;
        if (!src || typeof src !== 'object') return acc;
        acc.delayShip += Number(src.delayShip || 0);
        acc.outOfStock += Number(src.outOfStock || 0);
        acc.fakeShipTrack += Number(src.fakeShipTrack || 0);
        return acc;
      }, { delayShip: 0, outOfStock: 0, fakeShipTrack: 0 });
      return { totals, list: merged, failures };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getDeductionApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('ticket-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
      const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        return { pageNo, pageSize, total: 0, list: [], failures };
      }

      const failures = [];
      const parseTimeToMs = (value) => {
        if (value === undefined || value === null || value === '') return 0;
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
        const date = new Date(String(value));
        const ms = date.getTime();
        return Number.isNaN(ms) ? 0 : ms;
      };
      const pickSortTime = (item) => parseTimeToMs(
        item?.updateTime
        ?? item?.update_time
        ?? item?.updatedAt
        ?? item?.updated_at
        ?? item?.createTime
        ?? item?.create_time
        ?? item?.createdAt
        ?? item?.created_at
      );

      const resultGroups = await Promise.all(targetShops.map(async shop => {
        try {
          const forwardedParams = { ...params };
          if ('shopId' in forwardedParams) delete forwardedParams.shopId;
          const result = await invokePageApiWithRetry(shop.id, () => getTicketApiClient(shop.id).getList({
            ...forwardedParams,
            pageNo,
            pageSize,
          }, buildReadonlyTicketRequestOptions('ticket-get-list')));
          const list = Array.isArray(result?.list) ? result.list : [];
          const decorated = list.map(item => ({
            ...item,
            shopId: shop.id,
            shopName: item.shopName || shop.name || '未知店铺',
          }));
          return { total: Number(result?.total || 0), list: decorated };
        } catch (error) {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未知店铺',
            message: buildApiErrorMessage(error),
          });
          return { total: 0, list: [] };
        }
      }));

      skippedShops.forEach(shop => {
        failures.push({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        });
      });

      const merged = resultGroups.flatMap(group => group.list || []);
      merged.sort((a, b) => pickSortTime(b) - pickSortTime(a));
      if (!merged.length && failures.length) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `工单列表加载失败：${summary}` : '工单列表加载失败' };
      }
      return {
        pageNo,
        pageSize,
        total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
        list: merged,
        failures,
      };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getList(
        params,
        buildReadonlyTicketRequestOptions('ticket-get-list')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
        const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 50));
        return { pageNo, pageSize, total: 0, list: [], failures };
      }
      const failures = [];
      const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
      const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 50));
      const debug = params?.debug === true;

      const parseTimeToMs = (value) => {
        if (value === undefined || value === null || value === '') return 0;
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
        const date = new Date(String(value));
        const ms = date.getTime();
        return Number.isNaN(ms) ? 0 : ms;
      };

      const pickSortTime = (item) => parseTimeToMs(
        item?.updatedAt
        ?? item?.updated_at
        ?? item?.updateTime
        ?? item?.update_time
        ?? item?.modifyTime
        ?? item?.modify_time
        ?? item?.applyTime
        ?? item?.apply_time
        ?? item?.createdAt
        ?? item?.created_at
        ?? item?.createTime
        ?? item?.create_time
      );

      try {
        const resultGroups = await Promise.all(targetShops.map(async shop => {
          try {
            const forwardedParams = { ...params };
            if ('shopId' in forwardedParams) delete forwardedParams.shopId;
            const result = await invokePageApiWithRetry(shop.id, () => getTicketApiClient(shop.id).getRefundList({
              ...forwardedParams,
              pageNo,
              pageSize,
            }, buildReadonlyTicketRequestOptions('aftersale-get-list')));
            const list = Array.isArray(result?.list) ? result.list : [];
            const decorated = list.map(item => ({
              ...item,
              shopId: shop.id,
              shopName: item.shopName || shop.name || '未知店铺',
            }));
            return { total: Number(result?.total || 0), list: decorated, payloadMeta: result?.payloadMeta || null, requestBody: result?.requestBody || null };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { total: 0, list: [] };
          }
        }));
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });

        const merged = resultGroups
          .flatMap(group => group.list)
          .sort((a, b) => pickSortTime(b) - pickSortTime(a));

        const response = {
          pageNo,
          pageSize,
          total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
          list: merged,
          failures,
        };
        if (debug) {
          const samples = resultGroups
            .map((group, idx) => ({ group, shop: targetShops[idx] }))
            .slice(0, 6)
            .map(item => ({
              shopId: item.shop?.id,
              shopName: item.shop?.name || '未命名店铺',
              total: Number(item.group?.total || 0),
              listLen: Array.isArray(item.group?.list) ? item.group.list.length : 0,
              requestBodyKeys: item.group?.requestBody && typeof item.group.requestBody === 'object' ? Object.keys(item.group.requestBody) : [],
              payloadMeta: item.group?.payloadMeta || null,
            }));
          response.debug = {
            shopCount: targetShops.length,
            failuresCount: failures.length,
            samples,
          };
        }
        return response;
      } catch (error) {
        return { pageNo, pageSize, total: 0, list: [], failures, error: buildApiErrorMessage(error) };
      }
    }
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRefundList(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-list')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-regions', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRegionChildren(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-regions')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-shipping-companies', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getShippingCompanyList(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-shipping-companies')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-shipping-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    if (!params.orderSn && !params.order_sn && !params.orderNo && !params.order_no) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getChatShippingDetail(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-shipping-detail')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-list-refund-addresses', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).listRefundAddresses(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-list-refund-addresses')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-approve-return-goods', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).approveReturnGoods(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-approve-return-goods')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-approve-return-goods' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-approve-resend', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).approveResend(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-approve-resend')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-approve-resend' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-agree-refund-precheck', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).agreeRefundPreCheck(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-agree-refund-precheck')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-precheck', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundPreCheck(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-precheck')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-get-form-info', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? params.bizId
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundGetFormInfo(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-get-form-info')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-get-negotiate-info', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRejectRefundNegotiateInfo(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-get-negotiate-info')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-submit', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).rejectRefundSubmit(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-reject-refund-submit')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-reject-refund-submit' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-get-reasons', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundGetReasons(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-get-reasons')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-validate', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundValidate(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-validate')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-merchant-refuse', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).merchantAfterSalesRefuse(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-merchant-refuse')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-merchant-refuse' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    const statusLabels = {
      waitSellerHandle: '待商家处理',
      platformHandling: '平台处理中',
      waitBuyerHandle: '待买家处理',
      returnedWaitHandle: '退货待处理',
      expireIn24HoursWaitHandle: '即将逾期',
    };

    const mergeCounts = (target, countsObj) => {
      const next = { ...(target || {}) };
      if (!countsObj || typeof countsObj !== 'object') return next;
      Object.keys(countsObj).forEach(key => {
        const count = Number(countsObj[key] || 0);
        if (Number.isFinite(count)) {
          next[key] = Number(next[key] || 0) + count;
        }
      });
      return next;
    };

    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));

      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        return { shopId, counts: {}, total: 0, statusLabels, failures };
      }
      const failures = [];
      try {
        const results = await Promise.all(targetShops.map(async shop => {
          try {
            const result = await invokePageApiWithRetry(shop.id, () => getTicketApiClient(shop.id).getRefundCount(
              {},
              buildReadonlyTicketRequestOptions('aftersale-get-overview')
            ));
            return { shopId: shop.id, shopName: shop.name || '未命名店铺', countsObj: result?.counts || {} };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { shopId: shop.id, shopName: shop.name || '未命名店铺', countsObj: {} };
          }
        }));

        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });

        const counts = results.reduce((acc, item) => mergeCounts(acc, item.countsObj), {});
        const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
        return { shopId, counts, total, statusLabels, failures };
      } catch (error) {
        return { shopId, counts: {}, total: 0, statusLabels, failures, error: buildApiErrorMessage(error) };
      }
    }

    try {
      const result = await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRefundCount(
        {},
        buildReadonlyTicketRequestOptions('aftersale-get-overview')
      ));
      const counts = result?.counts || {};
      const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
      return { shopId, counts, total, statusLabels, failures: [] };
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('ticket-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.instanceId && !params.instance_id && !params.ticketNo && !params.ticket_no && !params.todoId && !params.todo_id && !params.id) {
      return { error: '缺少工单实例 ID' };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getDetail(
        params,
        buildReadonlyTicketRequestOptions('ticket-get-detail')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('violation-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
      const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        return { pageNo, pageSize, total: 0, list: [], typeMap: {}, failures };
      }

      const failures = [];
      const parseTimeToMs = (value) => {
        if (value === undefined || value === null || value === '') return 0;
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
        const date = new Date(String(value));
        const ms = date.getTime();
        return Number.isNaN(ms) ? 0 : ms;
      };
      const pickSortTime = (item) => parseTimeToMs(
        item?.noticeTime
        ?? item?.notice_time
        ?? item?.violationTime
        ?? item?.violation_time
        ?? item?.punishTime
        ?? item?.punish_time
        ?? item?.appealEndTime
        ?? item?.appeal_end_time
        ?? item?.updateTime
        ?? item?.update_time
        ?? item?.gmtModified
        ?? item?.gmtCreate
        ?? item?.createTime
        ?? item?.createdAt
      );

      const resultGroups = await Promise.all(targetShops.map(async shop => {
        try {
          const forwardedParams = { ...params };
          if ('shopId' in forwardedParams) delete forwardedParams.shopId;
          const result = await invokePageApiWithRetry(shop.id, () => getViolationApiClient(shop.id).getList({
            ...forwardedParams,
            pageNo,
            pageSize,
          }));
          const list = Array.isArray(result?.list) ? result.list : [];
          const decorated = list.map(item => ({
            ...item,
            shopId: shop.id,
            shopName: item.shopName || item.mallName || shop.name || '未知店铺',
          }));
          const typeMap = result?.typeMap && typeof result.typeMap === 'object' ? result.typeMap : {};
          return { total: Number(result?.total || 0), list: decorated, typeMap };
        } catch (error) {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: buildApiErrorMessage(error),
          });
          return { total: 0, list: [], typeMap: {} };
        }
      }));

      skippedShops.forEach(shop => {
        failures.push({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        });
      });

      const merged = resultGroups.flatMap(group => group.list || []);
      merged.sort((a, b) => pickSortTime(b) - pickSortTime(a));
      const typeMap = resultGroups.reduce((acc, group) => Object.assign(acc, group.typeMap || {}), {});
      if (!merged.length && failures.length) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `违规管理列表加载失败：${summary}` : '违规管理列表加载失败' };
      }
      return {
        pageNo,
        pageSize,
        total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
        list: merged,
        typeMap,
        failures,
      };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getViolationApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('violation-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.violationAppealSn && !params.violation_appeal_sn && !params.violationNo && !params.noticeSn && !params.notice_sn) {
      return { error: '缺少违规单号' };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getViolationApiClient(shopId).getDetail(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
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

  ipcMain.handle('open-external-url', async (event, input) => {
    const url = String(input?.url || input || '').trim();
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return { error: '无效链接' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = {
  registerApiIpc
};
