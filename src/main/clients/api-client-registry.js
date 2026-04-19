'use strict';

/**
 * API Client 注册表。
 *
 * 把原本散落在 main.js 中的 6 套 client 工厂（PddApi / Mail / Invoice / Ticket /
 * Violation / Deduction）收口到一个工厂模块。每套都遵循「getXxxApiClient 复用、
 * destroyXxxApiClient 释放、destroyAll 全量回收」的统一接口。
 *
 * Client 创建所依赖的 main.js 状态与函数（store、shopManager、流量入口、消息回流
 * 等）通过 deps 注入；与 chat client 销毁联动的「业务侧清理」（trafficBridge、
 * apiSessionStore 等）通过 onChatClientDestroyed 回调留在 main.js，避免把业务
 * 域知识下沉到 registry。
 */
function createApiClientRegistry(deps = {}) {
  const {
    PddApiClient,
    MailApiClient,
    InvoiceApiClient,
    TicketApiClient,
    ViolationApiClient,
    DeductionApiClient,
    store,
    sendToDebug,
    getMainWindow,
    getShopManager,
    getApiTraffic,
    getApiSessionSnapshot,
    setApiSessionSnapshot,
    enqueueRendererApiSessionUpdate,
    notifyApiMessage,
    updateShopStatus,
    handleNewCustomerMessage,
    requestViaPddPage,
    ensurePddPageViewReady,
    shouldConsoleLogApiMessage,
    chatApiCacheStore,
    getPddMailUrl,
    getPddInvoiceUrl,
    getPddTicketUrl,
    getPddAfterSaleUrl,
    getPddViolationUrl,
    onChatClientDestroyed,
  } = deps;

  const apiClients = new Map();
  const mailApiClients = new Map();
  const invoiceApiClients = new Map();
  const ticketApiClients = new Map();
  const violationApiClients = new Map();
  const deductionApiClients = new Map();

  function getShopInfoFactory(shopId) {
    return () => {
      const shops = store.get('shops') || [];
      return shops.find(item => item.id === shopId) || null;
    };
  }

  function refreshMainCookieContextFactory(shopId) {
    return (payload = {}) => {
      const shopManager = getShopManager?.();
      return shopManager?._hydrateMainCookieContext?.(shopId, payload) || null;
    };
  }

  function getApiClient(shopId) {
    if (!shopId) return null;
    if (apiClients.has(shopId)) return apiClients.get(shopId);

    const client = new PddApiClient(shopId, {
      onLog(message, extra) {
        sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
        if (message === '[API] Bootstrap检查会话') {
          getMainWindow()?.webContents.send('api-bootstrap-inspect', {
            shopId,
            ...(extra && typeof extra === 'object' ? extra : {}),
          });
        }
        if (!shouldConsoleLogApiMessage(message)) {
          return;
        }
        if (extra && typeof extra === 'object' && Object.keys(extra).length) {
          console.log(`[PDD接口:${shopId}] ${message}`, extra);
        } else {
          console.log(`[PDD接口:${shopId}] ${message}`);
        }
      },
      getShopInfo: getShopInfoFactory(shopId),
      getApiTraffic() {
        return getApiTraffic(shopId);
      },
      getOrderPriceUpdateTemplate() {
        return store.get(`apiOrderPriceUpdateTemplate.${shopId}`) || null;
      },
      setOrderPriceUpdateTemplate(template) {
        if (!template || typeof template !== 'object') return;
        store.set(`apiOrderPriceUpdateTemplate.${shopId}`, template);
      },
      getSmallPaymentSubmitTemplate() {
        return store.get(`apiSmallPaymentSubmitTemplate.${shopId}`) || null;
      },
      refreshMainCookieContext: refreshMainCookieContextFactory(shopId),
      requestInPddPage(request) {
        return requestViaPddPage(shopId, {
          ...(request && typeof request === 'object' ? request : {}),
          source: request?.source || 'pdd-api:page-request',
        });
      },
      async executeInPddPage(script, options = {}) {
        const view = await ensurePddPageViewReady(shopId, {
          source: options?.source || 'pdd-api:execute-in-page',
        });
        return view.webContents.executeJavaScript(String(script || ''), true);
      },
    });

    client.on('authExpired', payload => {
      updateShopStatus(shopId, 'expired');
      getMainWindow()?.webContents.send('api-auth-expired', payload);
      sendToDebug('api-auth-expired', payload);
    });

    client.on('sessionUpdated', sessions => {
      const stableSessions = Array.isArray(sessions) && sessions.length === 0
        ? getApiSessionSnapshot(shopId)
        : setApiSessionSnapshot(shopId, sessions, 'polling');
      if (Array.isArray(stableSessions) && stableSessions.length >= 0) {
        updateShopStatus(shopId, 'online');
      }
      enqueueRendererApiSessionUpdate(shopId, stableSessions, 'polling');
    });

    client.on('newMessage', payload => {
      getMainWindow()?.webContents.send('api-new-message', payload);
      notifyApiMessage({
        ...payload,
        shopId: payload?.shopId || shopId,
      });
      sendToDebug('api-new-message', payload);
      // 把实时推送的消息追加到该会话的磁盘缓存末尾，下次启动可秒开。
      try {
        const cacheShopId = String(payload?.shopId || shopId || '').trim();
        const cacheSessionId = String(payload?.sessionId || '').trim();
        if (cacheShopId && cacheSessionId) {
          chatApiCacheStore.appendIncomingMessage(cacheShopId, cacheSessionId, {
            id: payload?.messageId || '',
            messageId: payload?.messageId || '',
            sessionId: cacheSessionId,
            timestamp: payload?.timestamp || Date.now(),
            content: payload?.text || '',
            senderName: payload?.customer || '',
            senderId: payload?.customerId || '',
            isFromBuyer: true,
            source: 'polling-push',
          });
        }
      } catch (cacheError) {
        console.warn(`[chat-api-cache] 追加实时消息失败: ${cacheError.message}`);
      }
      handleNewCustomerMessage({
        message: payload.text,
        customer: payload.customer,
        conversationId: payload.sessionId,
        sessionId: payload.sessionId,
        messageId: payload.messageId || '',
        session: payload.session || null,
        source: 'api-polling',
        shopId,
      }).catch(error => {
        const message = error?.message || String(error || '未知错误');
        console.error(`[PDD助手] 接口自动回复处理失败: ${message}`);
        getMainWindow()?.webContents.send('auto-reply-error', {
          shopId,
          sessionId: payload.sessionId || '',
          customer: payload.customer || '',
          message: payload.text || '',
          error: message,
          errorCode: error?.errorCode || 0,
        });
        sendToDebug('auto-reply-error', {
          shopId,
          sessionId: payload.sessionId || '',
          error: message,
        });
      });
    });

    client.on('messageSent', payload => {
      getMainWindow()?.webContents.send('api-message-sent', { shopId, ...payload });
      sendToDebug('api-message-sent', { shopId, sessionId: payload.sessionId });
    });

    apiClients.set(shopId, client);
    return client;
  }

  function destroyApiClient(shopId) {
    const client = apiClients.get(shopId);
    if (!client) return;
    client.destroy();
    apiClients.delete(shopId);
    if (typeof onChatClientDestroyed === 'function') {
      try {
        onChatClientDestroyed(shopId);
      } catch (callbackError) {
        console.warn(`[api-client-registry] onChatClientDestroyed 回调失败: ${callbackError?.message || callbackError}`);
      }
    }
  }

  function getMailApiClient(shopId) {
    if (!shopId) return null;
    if (mailApiClients.has(shopId)) return mailApiClients.get(shopId);
    const client = new MailApiClient(shopId, {
      onLog(message, extra) {
        sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
        if (extra && typeof extra === 'object' && Object.keys(extra).length) {
          console.log(`[PDD站内信:${shopId}] ${message}`, extra);
        } else {
          console.log(`[PDD站内信:${shopId}] ${message}`);
        }
      },
      getShopInfo: getShopInfoFactory(shopId),
      getApiTraffic() {
        return getApiTraffic(shopId);
      },
      getMailUrl() {
        return getPddMailUrl();
      },
      refreshMainCookieContext: refreshMainCookieContextFactory(shopId),
    });
    mailApiClients.set(shopId, client);
    return client;
  }

  function destroyMailApiClient(shopId) {
    if (!mailApiClients.has(shopId)) return;
    mailApiClients.delete(shopId);
  }

  function getInvoiceApiClient(shopId) {
    if (!shopId) return null;
    if (invoiceApiClients.has(shopId)) return invoiceApiClients.get(shopId);
    const client = new InvoiceApiClient(shopId, {
      onLog(message, extra) {
        sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
        console.log(`[PDD待开票:${shopId}] ${message}`);
      },
      getShopInfo: getShopInfoFactory(shopId),
      getApiTraffic() {
        return getApiTraffic(shopId);
      },
      getInvoiceUrl() {
        return getPddInvoiceUrl();
      },
      getSubmitConfig() {
        const all = store.get('invoiceSubmitApiConfig') || {};
        return all[shopId] || all.__global || null;
      },
      setSubmitConfig(config) {
        const all = store.get('invoiceSubmitApiConfig') || {};
        all[shopId] = config || null;
        if (config) {
          all.__global = config;
        }
        store.set('invoiceSubmitApiConfig', all);
      },
      refreshMainCookieContext: refreshMainCookieContextFactory(shopId),
    });
    invoiceApiClients.set(shopId, client);
    return client;
  }

  function destroyInvoiceApiClient(shopId) {
    if (!invoiceApiClients.has(shopId)) return;
    invoiceApiClients.delete(shopId);
  }

  function getTicketApiClient(shopId) {
    if (!shopId) return null;
    if (ticketApiClients.has(shopId)) return ticketApiClients.get(shopId);
    const client = new TicketApiClient(shopId, {
      onLog(message, extra) {
        sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
        console.log(`[PDD工单管理:${shopId}] ${message}`);
      },
      getShopInfo: getShopInfoFactory(shopId),
      getApiTraffic() {
        return getApiTraffic(shopId);
      },
      getTicketUrl() {
        return getPddTicketUrl();
      },
      getAfterSaleUrl() {
        return getPddAfterSaleUrl();
      },
      refreshMainCookieContext: refreshMainCookieContextFactory(shopId),
      requestInPddPage(request) {
        return requestViaPddPage(shopId, {
          ...(request && typeof request === 'object' ? request : {}),
          source: request?.source || 'ticket-api:page-request',
        });
      },
    });
    ticketApiClients.set(shopId, client);
    return client;
  }

  function destroyTicketApiClient(shopId) {
    if (!ticketApiClients.has(shopId)) return;
    ticketApiClients.delete(shopId);
  }

  function getViolationApiClient(shopId) {
    if (!shopId) return null;
    if (violationApiClients.has(shopId)) return violationApiClients.get(shopId);
    const client = new ViolationApiClient(shopId, {
      onLog(message, extra) {
        sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
        console.log(`[PDD违规管理:${shopId}] ${message}`);
      },
      getShopInfo: getShopInfoFactory(shopId),
      getApiTraffic() {
        return getApiTraffic(shopId);
      },
      getViolationUrl() {
        return getPddViolationUrl();
      },
      refreshMainCookieContext: refreshMainCookieContextFactory(shopId),
    });
    violationApiClients.set(shopId, client);
    return client;
  }

  function destroyViolationApiClient(shopId) {
    if (!violationApiClients.has(shopId)) return;
    violationApiClients.delete(shopId);
  }

  function getDeductionApiClient(shopId) {
    if (!shopId) return null;
    if (deductionApiClients.has(shopId)) return deductionApiClients.get(shopId);
    const client = new DeductionApiClient(shopId, {
      onLog(message, extra) {
        sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
        console.log(`[PDD扣款管理:${shopId}] ${message}`);
      },
      getShopInfo: getShopInfoFactory(shopId),
      getApiTraffic() {
        return getApiTraffic(shopId);
      },
      refreshMainCookieContext: refreshMainCookieContextFactory(shopId),
    });
    deductionApiClients.set(shopId, client);
    return client;
  }

  function destroyDeductionApiClient(shopId) {
    if (!deductionApiClients.has(shopId)) return;
    deductionApiClients.delete(shopId);
  }

  function destroyAll() {
    for (const shopId of apiClients.keys()) destroyApiClient(shopId);
    for (const shopId of mailApiClients.keys()) destroyMailApiClient(shopId);
    for (const shopId of invoiceApiClients.keys()) destroyInvoiceApiClient(shopId);
    for (const shopId of ticketApiClients.keys()) destroyTicketApiClient(shopId);
    for (const shopId of violationApiClients.keys()) destroyViolationApiClient(shopId);
    for (const shopId of deductionApiClients.keys()) destroyDeductionApiClient(shopId);
  }

  return {
    getApiClient,
    destroyApiClient,
    getMailApiClient,
    destroyMailApiClient,
    getInvoiceApiClient,
    destroyInvoiceApiClient,
    getTicketApiClient,
    destroyTicketApiClient,
    getViolationApiClient,
    destroyViolationApiClient,
    getDeductionApiClient,
    destroyDeductionApiClient,
    destroyAll,
  };
}

module.exports = { createApiClientRegistry };
