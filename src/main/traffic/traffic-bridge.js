'use strict';

// 抓包数据 -> 业务运行时 的桥接层。
// 历史上这一组函数全部散落在 main.js，承担"页面抓包条目进来后，
// 解析成会话列表 / 通知消息 / 已读位点 / 退款卡片 等结构，再回灌到
// apiSessionStore、渲染层、桌面通知"的工作。它们既不是纯流量记录
// （那是 api-traffic-recorder/network-monitor 的职责），也不是 PDD
// 业务请求（那是 pdd-api 模块的职责），属于"接口抓取与业务回灌"
// 的中间层，统一收口在本文件，便于后续维护。
//
// 模块本身不持有 Electron / store 等外部依赖，所有外部能力（取 client、
// 取 traffic、写 session 快照、派发渲染层消息、发桌面通知、调试通道、
// 日志开关）通过 createTrafficBridge(deps) 注入；模块内部仅维护两份
// 去重缓存：会话签名缓存（按 shop 隔离）与通知消息 dedup 集合
// （跨 shop 共享，按 shop:session:msgId 组合去重）。

function createTrafficBridge(deps = {}) {
  const {
    getApiClient,
    getApiTraffic,
    getApiSessionSnapshot,
    setApiSessionSnapshot,
    enqueueRendererApiSessionUpdate,
    updateShopStatus,
    getShopDisplayName,
    notifyApiMessage,
    getMainWindow,
    sendToDebug,
    isVerboseRuntimeLoggingEnabled,
  } = deps;

  // 会话列表抓包签名缓存：避免同一份 latest_conversations 重复回灌
  const sessionSignatureCache = new Map(); // shopId -> signature
  // 通知消息去重：跨 shop 共享，按 "shop::session::msgId|timestamp" 去重
  const messageDedupSet = new Set();
  const MESSAGE_DEDUP_LIMIT = 500;

  function safeParseCapturedBody(text) {
    if (!text || typeof text !== 'string') return null;
    const source = String(text).trim();
    if (!source) return null;
    try {
      return JSON.parse(source);
    } catch {
      if (!source.includes('=') || source.startsWith('<')) {
        return null;
      }
      try {
        const params = new URLSearchParams(source);
        const result = {};
        let hasEntry = false;
        for (const [key, rawValue] of params.entries()) {
          hasEntry = true;
          const value = String(rawValue || '').trim();
          let parsedValue = value;
          if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
            try {
              parsedValue = JSON.parse(value);
            } catch {}
          }
          if (Object.prototype.hasOwnProperty.call(result, key)) {
            if (Array.isArray(result[key])) {
              result[key].push(parsedValue);
            } else {
              result[key] = [result[key], parsedValue];
            }
          } else {
            result[key] = parsedValue;
          }
        }
        return hasEntry ? result : null;
      } catch {
        return null;
      }
    }
  }

  function buildApiSessionTrafficSignature(sessions = []) {
    if (!Array.isArray(sessions)) return '';
    return sessions.map(item => [
      item.sessionId || '',
      item.lastMessageTime || 0,
      item.unreadCount || 0,
      item.waitTime || 0,
      item.lastMessage || '',
    ].join(':')).join('|');
  }

  function getApiRefundTemplateFallbackText() {
    return '亲亲，这边帮您申请退款，您看可以吗？若同意可以点击下方卡片按钮哦～';
  }

  function extractApiSessionsFromTraffic(shopId) {
    if (!shopId) return [];
    const client = getApiClient(shopId);
    if (!client) return [];
    const traffic = getApiTraffic(shopId);
    const urlParts = ['/plateau/chat/latest_conversations', '/plateau/conv_list/status'];
    for (const urlPart of urlParts) {
      for (let i = traffic.length - 1; i >= 0; i--) {
        const entry = traffic[i];
        if (!String(entry?.url || '').includes(urlPart) || !entry?.responseBody) continue;
        try {
          const sessions = client._parseSessionList(entry.responseBody);
          if (Array.isArray(sessions) && sessions.length > 0) {
            return setApiSessionSnapshot(shopId, sessions, `traffic-fallback:${urlPart}`);
          }
        } catch {}
      }
    }
    return [];
  }

  function pushApiSessionsFromTraffic(shopId, entry) {
    if (!shopId || !entry?.url) return;
    const url = String(entry.url || '');
    if (!url.includes('/plateau/chat/latest_conversations') && !url.includes('/plateau/conv_list/status')) {
      return;
    }
    const client = getApiClient(shopId);
    if (!client || !entry.responseBody) return;
    try {
      const sessions = client._parseSessionList(entry.responseBody);
      if (!Array.isArray(sessions) || sessions.length === 0) return;
      const signature = buildApiSessionTrafficSignature(sessions);
      if (sessionSignatureCache.get(shopId) === signature) return;
      sessionSignatureCache.set(shopId, signature);
      client._sessionCache = sessions;
      setApiSessionSnapshot(shopId, sessions, 'traffic');
      updateShopStatus(shopId, 'online');
      enqueueRendererApiSessionUpdate(shopId, sessions, 'traffic');
      if (isVerboseRuntimeLoggingEnabled()) {
        console.log(`[PDD接口:${shopId}] 已从页面抓包同步会话: ${sessions.length}`);
      }
    } catch (error) {
      console.log(`[PDD接口:${shopId}] 页面抓包解析会话失败: ${error.message}`);
    }
  }

  function getTrafficNotifyPayload(entry = {}) {
    const decodedFrame = entry?.decodedFrame && typeof entry.decodedFrame === 'object' ? entry.decodedFrame : null;
    return decodedFrame?.notifyPayload && typeof decodedFrame.notifyPayload === 'object'
      ? decodedFrame.notifyPayload
      : null;
  }

  function extractTrafficNotifyMessages(notifyPayload = {}) {
    const records = [];
    const pushDataList = Array.isArray(notifyPayload?.push_data?.data) ? notifyPayload.push_data.data : [];
    pushDataList.forEach(item => {
      const message = item?.message && typeof item.message === 'object'
        ? item.message
        : (item && typeof item === 'object' ? item : null);
      if (!message) return;
      records.push({
        message,
        sourceType: 'push-data',
        notifyResponse: String(notifyPayload?.response || '').trim(),
        requestId: String(notifyPayload?.request_id || '').trim(),
      });
    });
    if (notifyPayload?.message && typeof notifyPayload.message === 'object') {
      records.push({
        message: notifyPayload.message,
        sourceType: 'direct-message',
        notifyResponse: String(notifyPayload?.response || '').trim(),
        requestId: String(notifyPayload?.request_id || '').trim(),
      });
    }
    return records;
  }

  function normalizeTrafficNotifyText(value = '') {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(value)) {
      return value.map(item => normalizeTrafficNotifyText(item)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }
    if (typeof value === 'object') {
      const preferredText = normalizeTrafficNotifyText(
        value.text
        || value.content
        || value.message
        || value.msg
        || value.title
        || value.label
        || value.name
        || value.desc
        || value.value
        || ''
      );
      if (preferredText) return preferredText;
      return Object.values(value)
        .map(item => normalizeTrafficNotifyText(item))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return '';
  }

  function extractTrafficNotifyEntryText(entry = {}) {
    if (!entry || typeof entry !== 'object') return '';
    return normalizeTrafficNotifyText(
      entry?.text
      || entry?.content
      || entry?.message
      || entry?.msg
      || entry?.title
      || entry?.label
      || entry?.name
      || entry?.desc
      || entry?.value
      || ''
    );
  }

  function extractTrafficStructuredMessageText(rawMessage = {}) {
    const info = rawMessage?.info && typeof rawMessage.info === 'object' ? rawMessage.info : {};
    const systemInfo = rawMessage?.system && typeof rawMessage.system === 'object' ? rawMessage.system : {};
    const pushBizContext = rawMessage?.push_biz_context && typeof rawMessage.push_biz_context === 'object'
      ? rawMessage.push_biz_context
      : {};
    const directText = normalizeTrafficNotifyText(
      info?.mall_content
      || info?.merchant_content
      || info?.content
      || info?.text
      || info?.title
      || info?.label
      || info?.desc
      || info?.tip
      || info?.message
      || systemInfo?.text
      || systemInfo?.content
      || pushBizContext?.replace_content
      || pushBizContext?.replaceContent
      || ''
    );
    if (directText) return directText;
    const entryLists = [
      Array.isArray(info?.item_content) ? info.item_content : [],
      Array.isArray(info?.mall_item_content) ? info.mall_item_content : [],
      Array.isArray(info?.items) ? info.items : [],
    ];
    for (const list of entryLists) {
      const entryText = list.map(entry => extractTrafficNotifyEntryText(entry)).filter(Boolean).join(' ').trim();
      if (entryText) return entryText;
    }
    return '';
  }

  function buildRefundCardStateDebugPayload(message = {}) {
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    if (String(info.card_id || '').trim() !== 'ask_refund_apply') return null;
    const state = info?.state && typeof info.state === 'object' ? info.state : {};
    const itemRows = (Array.isArray(info?.item_list) ? info.item_list : [])
      .map(item => {
        const label = normalizeTrafficNotifyText(item?.left || item?.label || item?.name || '');
        const value = Array.isArray(item?.right)
          ? item.right.map(entry => normalizeTrafficNotifyText(entry?.text || entry?.value || '')).filter(Boolean).join(' ')
          : '';
        if (!label && !value) return null;
        return { label, value };
      })
      .filter(Boolean);
    const buttonTexts = (Array.isArray(info?.button_list) ? info.button_list : [])
      .map(item => normalizeTrafficNotifyText(
        item?.text || item?.title || item?.label || item?.button_text || item?.buttonText || item?.name || ''
      ))
      .filter(Boolean);
    return {
      shopId: message.shopId || '',
      sessionId: message.sessionId || '',
      messageId: message.messageId || '',
      timestamp: Number(message?.timestamp || 0) || Date.now(),
      type: Number(raw?.type ?? -1),
      templateName: String(raw?.template_name || message?.templateName || '').trim(),
      cardId: String(info.card_id || '').trim(),
      title: normalizeTrafficNotifyText(info?.title || message?.refundCard?.title || ''),
      content: normalizeTrafficNotifyText(message?.content || raw?.content || ''),
      footerText: normalizeTrafficNotifyText(message?.refundCard?.footerText || ''),
      stateStatus: state?.status ?? '',
      stateExpireText: normalizeTrafficNotifyText(state?.expire_text || ''),
      stateText: normalizeTrafficNotifyText(state?.text || state?.desc || state?.label || ''),
      stateKeys: Object.keys(state),
      buttonTexts,
      itemRows,
    };
  }

  function buildRefundCardFromNotify(rawMessage = {}) {
    const info = rawMessage?.info && typeof rawMessage.info === 'object' ? rawMessage.info : {};
    if (String(info.card_id || '').trim() !== 'ask_refund_apply') return null;
    const goodsInfo = info?.goods_info && typeof info.goods_info === 'object' ? info.goods_info : {};
    const displayState = info?.mstate && typeof info.mstate === 'object'
      ? info.mstate
      : (info?.state && typeof info.state === 'object' ? info.state : {});
    const itemList = Array.isArray(info?.item_list) ? info.item_list : [];
    const rows = itemList.map(item => {
      const label = normalizeTrafficNotifyText(item?.left || item?.label || item?.name || '');
      const values = Array.isArray(item?.right)
        ? item.right.map(entry => normalizeTrafficNotifyText(entry?.text || entry?.value || '')).filter(Boolean)
        : [];
      return { label, value: values.join(' ') };
    });
    const findRowValue = (...keywords) => {
      const row = rows.find(item => keywords.some(keyword => item.label.includes(keyword)));
      return row?.value || '';
    };
    const resolveFooterText = () => {
      const explicitText = normalizeTrafficNotifyText(
        displayState?.text || displayState?.desc || displayState?.label || displayState?.expire_text || ''
      );
      if (explicitText && explicitText !== '已过期') return explicitText;
      const statusValue = Number(displayState?.status);
      if (statusValue === 2) return '消费者已同意';
      if (statusValue === 3) return '消费者已拒绝';
      return '等待消费者确认';
    };
    const amountFen = Number(goodsInfo?.total_amount || 0) || 0;
    return {
      localKey: String(rawMessage?.msg_id || rawMessage?.message_id || ''),
      orderSn: String(goodsInfo?.order_sequence_no || ''),
      title: normalizeTrafficNotifyText(info?.title || '') || '商家想帮您申请快捷退款',
      actionText: findRowValue('申请类型') || '退款',
      goodsTitle: normalizeTrafficNotifyText(goodsInfo?.goods_name || '') || '订单商品',
      imageUrl: normalizeTrafficNotifyText(goodsInfo?.goods_thumb_url || ''),
      specText: [normalizeTrafficNotifyText(goodsInfo?.extra || ''), goodsInfo?.count ? `x${goodsInfo.count}` : ''].filter(Boolean).join(' '),
      reasonText: findRowValue('申请原因') || '其他原因',
      amountText: findRowValue('退款金额') || (amountFen > 0 ? `¥${(amountFen / 100).toFixed(2)}` : ''),
      noteText: findRowValue('申请说明') || '商家代消费者填写售后单',
      contactText: findRowValue('联系方式'),
      footerText: resolveFooterText(),
    };
  }

  function buildRefundStatusUpdateFromNotify(rawMessage = {}) {
    const messageType = Number(rawMessage?.type ?? -1);
    const data = rawMessage?.data && typeof rawMessage.data === 'object' ? rawMessage.data : {};
    if (messageType !== 90) return null;
    const targetMessageId = String(data?.msg_id || '').trim();
    const statusValue = Number(data?.status);
    const statusText = normalizeTrafficNotifyText(data?.text || '');
    if (!targetMessageId || !Number.isFinite(statusValue)) return null;
    if (statusValue === 2) {
      return {
        kind: 'refund-pending',
        targetMessageId,
        status: statusValue,
        displayText: '消费者已同意您发起的退款申请，请及时处理',
      };
    }
    if (statusValue === 3) {
      return {
        kind: 'refund-rejected',
        targetMessageId,
        status: statusValue,
        displayText: statusText || '消费者已拒绝',
      };
    }
    return null;
  }

  function normalizeApiTrafficNotifyMessage(shopId, rawMessage = {}, options = {}) {
    const fromRole = String(rawMessage?.from?.role || '').trim();
    const toRole = String(rawMessage?.to?.role || '').trim();
    const isFromBuyer = fromRole === 'user' || toRole === 'mall_cs' || toRole === 'mall';
    const messageData = rawMessage?.data && typeof rawMessage.data === 'object' ? rawMessage.data : {};
    const sessionId = String(
      rawMessage?.session_id
      || rawMessage?.sessionId
      || rawMessage?.conversation_id
      || rawMessage?.conversationId
      || rawMessage?.chat_id
      || rawMessage?.chatId
      || messageData?.session_id
      || messageData?.sessionId
      || messageData?.conversation_id
      || messageData?.conversationId
      || messageData?.chat_id
      || messageData?.chatId
      || (
        isFromBuyer
          ? (rawMessage?.from?.uid || rawMessage?.to?.uid || '')
          : (rawMessage?.to?.uid || rawMessage?.from?.uid || '')
      )
      || messageData?.user_id
      || messageData?.uid
      || messageData?.customer_id
      || rawMessage?.buyer_id
      || rawMessage?.customer_id
    ).trim();
    if (!sessionId) return null;
    const messageType = Number(rawMessage?.type ?? -1);
    const templateName = String(rawMessage?.template_name || options?.notifyResponse || '').trim();
    const defaultContent = templateName === 'apply_after_sales_for_customer_automatic_message'
      ? getApiRefundTemplateFallbackText()
      : '';
    const content = normalizeTrafficNotifyText(
      rawMessage?.content
      || extractTrafficStructuredMessageText(rawMessage)
      || rawMessage?.push_biz_context?.replace_content
      || rawMessage?.push_biz_context?.replaceContent
      || rawMessage?.data?.content
      || defaultContent
    ) || defaultContent;
    const refundCard = messageType === 19 ? buildRefundCardFromNotify(rawMessage) : null;
    const refundStatusUpdate = buildRefundStatusUpdateFromNotify(rawMessage);
    const normalizedContent = content || normalizeTrafficNotifyText(refundStatusUpdate?.displayText || '');
    if (!normalizedContent && !refundCard && !refundStatusUpdate) return null;
    const customerId = String(
      messageData?.customer_id
      || messageData?.buyer_id
      || messageData?.user_id
      || messageData?.uid
      || rawMessage?.buyer_id
      || rawMessage?.customer_id
      || (isFromBuyer ? rawMessage?.from?.uid : rawMessage?.to?.uid)
      || ''
    ).trim();
    return {
      shopId,
      sessionId,
      customer: customerId,
      messageId: String(rawMessage?.msg_id || rawMessage?.message_id || ''),
      timestamp: Number(rawMessage?.ts || 0) * 1000 || Date.now(),
      isFromBuyer,
      senderName: isFromBuyer ? '买家' : getShopDisplayName(shopId),
      readState: '',
      content: normalizedContent,
      templateName,
      refundCard,
      refundStatusUpdate,
      trafficSourceType: String(options?.sourceType || '').trim(),
      notifyRequestId: String(options?.requestId || '').trim(),
      raw: rawMessage,
    };
  }

  function extractApiTrafficReadMarkUpdate(shopId, entry) {
    if (!shopId || !entry) return null;
    const notifyPayload = getTrafficNotifyPayload(entry);
    if (!notifyPayload || String(notifyPayload?.response || '') !== 'mall_system_msg') return null;
    if (Number(notifyPayload?.message?.type) !== 20) return null;
    const data = notifyPayload?.message?.data;
    if (!data || typeof data !== 'object') return null;
    const sessionId = String(data?.user_id || data?.uid || '').trim();
    const userLastRead = String(data?.user_last_read || data?.userLastRead || '').trim();
    if (!sessionId || !userLastRead) return null;
    return {
      shopId,
      sessionId,
      userLastRead,
      minSupportedMsgId: String(data?.min_supported_msg_id || data?.minSupportedMsgId || '').trim(),
      source: 'traffic-notify',
      requestId: String(notifyPayload?.request_id || '').trim(),
    };
  }

  function updateApiSessionSnapshotWithMessages(shopId, messages = []) {
    if (!shopId || !Array.isArray(messages) || !messages.length) return null;
    const currentSessions = getApiSessionSnapshot(shopId);
    const existingMap = new Map(
      currentSessions
        .filter(session => session && session.sessionId)
        .map(session => [String(session.sessionId), session])
    );
    let changed = false;
    const groupedMessages = new Map();
    messages.forEach(message => {
      const sessionId = String(message?.sessionId || '').trim();
      if (!sessionId) return;
      const bucket = groupedMessages.get(sessionId) || [];
      bucket.push(message);
      groupedMessages.set(sessionId, bucket);
    });
    const nextSessions = currentSessions.map(session => {
      const matched = groupedMessages.get(String(session?.sessionId || '')) || [];
      if (!matched.length) return session;
      const latest = matched.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)).slice(-1)[0];
      changed = true;
      return {
        ...session,
        lastMessage: String(latest?.content || latest?.refundCard?.title || session?.lastMessage || '').trim(),
        lastMessageTime: Number(latest?.timestamp || session?.lastMessageTime || 0),
        unreadCount: Math.max(Number(session?.unreadCount || 0) || 0, latest?.isFromBuyer ? 1 : 0),
      };
    });
    groupedMessages.forEach((matched, sessionId) => {
      if (existingMap.has(sessionId) || !matched.length) return;
      const latest = matched.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)).slice(-1)[0];
      changed = true;
      nextSessions.unshift({
        shopId,
        sessionId,
        customerId: String(latest?.customer || sessionId).trim(),
        customerName: String(latest?.customer || '').trim(),
        shopName: getShopDisplayName(shopId),
        lastMessage: String(latest?.content || latest?.refundCard?.title || '').trim() || '新消息',
        lastMessageTime: Number(latest?.timestamp || Date.now()),
        unreadCount: latest?.isFromBuyer ? 1 : 0,
        waitTime: 0,
        isTimeout: false,
        lastMessageActor: latest?.isFromBuyer ? 'buyer' : 'seller',
        lastMessageIsFromBuyer: latest?.isFromBuyer === true,
        raw: latest?.raw || {},
      });
    });
    if (!changed) return null;
    const sortedSessions = nextSessions
      .slice()
      .sort((a, b) => Number(b?.lastMessageTime || 0) - Number(a?.lastMessageTime || 0));
    setApiSessionSnapshot(shopId, sortedSessions, 'traffic-notify');
    return sortedSessions;
  }

  function pushApiMessagesFromTraffic(shopId, entry) {
    if (!shopId || !entry) return;
    const readMarkUpdate = extractApiTrafficReadMarkUpdate(shopId, entry);
    if (readMarkUpdate) {
      const win = getMainWindow?.();
      win?.webContents?.send?.('api-read-mark-updated', readMarkUpdate);
      sendToDebug('api-read-mark-updated', readMarkUpdate);
    }
    const notifyPayload = getTrafficNotifyPayload(entry);
    const notifyMessages = extractTrafficNotifyMessages(notifyPayload);
    if (!notifyMessages.length) return;
    const normalizedMessages = notifyMessages
      .map(item => normalizeApiTrafficNotifyMessage(shopId, item?.message || {}, item))
      .filter(Boolean);
    if (!normalizedMessages.length) return;
    const dedupedMessages = normalizedMessages.filter(message => {
      const key = `${shopId}::${message.sessionId}::${message.messageId || message.timestamp}`;
      if (messageDedupSet.has(key)) return false;
      messageDedupSet.add(key);
      if (messageDedupSet.size > MESSAGE_DEDUP_LIMIT) {
        const firstKey = messageDedupSet.values().next().value;
        if (firstKey) messageDedupSet.delete(firstKey);
      }
      return true;
    });
    if (!dedupedMessages.length) return;
    const nextSessions = updateApiSessionSnapshotWithMessages(shopId, dedupedMessages);
    if (nextSessions) {
      enqueueRendererApiSessionUpdate(shopId, nextSessions, 'traffic-notify');
    }
    const win = getMainWindow?.();
    dedupedMessages.forEach(message => {
      const refundCardStateDebug = buildRefundCardStateDebugPayload(message);
      if (refundCardStateDebug) {
        sendToDebug('api-refund-card-state', refundCardStateDebug);
        if (isVerboseRuntimeLoggingEnabled()) {
          console.log(
            `[PDD接口:${shopId}] 快捷退款卡片状态`,
            JSON.stringify({
              sessionId: refundCardStateDebug.sessionId,
              messageId: refundCardStateDebug.messageId,
              stateStatus: refundCardStateDebug.stateStatus,
              stateExpireText: refundCardStateDebug.stateExpireText,
              stateText: refundCardStateDebug.stateText,
              buttonTexts: refundCardStateDebug.buttonTexts,
            })
          );
        }
      }
      const payload = {
        shopId,
        sessionId: message.sessionId,
        customer: message.customer,
        session: nextSessions?.find(item => String(item?.sessionId || '') === String(message.sessionId || '')) || null,
        source: 'traffic-notify',
        messages: [message],
      };
      win?.webContents?.send?.('api-new-message', payload);
      notifyApiMessage({
        ...payload,
        messageId: message.messageId || '',
        text: message.content || message.text || '',
      });
      sendToDebug('api-new-message', { shopId, sessionId: message.sessionId, source: 'traffic-notify', messageId: message.messageId || '' });
    });
  }

  // 店铺销毁/重置时调用，清掉这条 shop 在 bridge 内部维护的去重缓存。
  function clearShopState(shopId) {
    if (!shopId) return;
    sessionSignatureCache.delete(shopId);
    const prefix = `${shopId}::`;
    for (const key of Array.from(messageDedupSet)) {
      if (key.startsWith(prefix)) {
        messageDedupSet.delete(key);
      }
    }
  }

  return {
    safeParseCapturedBody,
    extractApiSessionsFromTraffic,
    pushApiSessionsFromTraffic,
    pushApiMessagesFromTraffic,
    extractApiTrafficReadMarkUpdate,
    clearShopState,
  };
}

module.exports = { createTrafficBridge };
