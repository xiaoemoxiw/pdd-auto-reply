'use strict';

// 会话/对话相关的纯解析与归一化函数。
// 涉及消息角色判定的函数都依赖 mallId, 由调用方通过参数传入。

const messageParsers = require('./message-parsers');

function extractSessionPreviewText(item) {
  const previewSource = {
    content: item?.last_msg,
    text: item?.last_message,
    msg_content: item?.latest_msg,
    message: item?.content,
    body: item?.summary,
    msg: item?.preview,
    extra: {
      text: item?.last_msg_text || item?.msg_text,
    },
    ext: {
      text: item?.snippet,
    },
    template_name: item?.last_msg?.template_name || item?.last_message?.template_name || item?.latest_msg?.template_name || item?.template_name,
    templateName: item?.last_msg?.templateName || item?.last_message?.templateName || item?.latest_msg?.templateName || item?.templateName,
    show_auto: item?.last_msg?.show_auto ?? item?.last_message?.show_auto ?? item?.latest_msg?.show_auto ?? item?.show_auto,
    showAuto: item?.last_msg?.showAuto ?? item?.last_message?.showAuto ?? item?.latest_msg?.showAuto ?? item?.showAuto,
    biz_context: item?.last_msg?.biz_context || item?.last_message?.biz_context || item?.latest_msg?.biz_context || item?.biz_context,
    bizContext: item?.last_msg?.bizContext || item?.last_message?.bizContext || item?.latest_msg?.bizContext || item?.bizContext,
    push_biz_context: item?.last_msg?.push_biz_context || item?.last_message?.push_biz_context || item?.latest_msg?.push_biz_context || item?.push_biz_context,
    pushBizContext: item?.last_msg?.pushBizContext || item?.last_message?.pushBizContext || item?.latest_msg?.pushBizContext || item?.pushBizContext,
  };
  return messageParsers.extractMessageText(previewSource);
}

function extractSessionPreviewTime(item) {
  const candidates = [
    item?.last_msg_time,
    item?.update_time,
    item?.last_time,
    item?.ts,
    item?.last_msg?.send_time,
    item?.last_msg?.time,
    item?.last_msg?.ts,
    item?.last_message?.send_time,
    item?.last_message?.time,
    item?.latest_msg?.send_time,
    item?.latest_msg?.time,
    item?.content?.send_time,
    item?.content?.time,
  ];
  return candidates.find(value => value !== undefined && value !== null && value !== '') || 0;
}

function getSessionDedupKey(session = {}) {
  if (!session || typeof session !== 'object') return '';
  return String(
    session.customerId
    || session.userUid
    || session.raw?.customer_id
    || session.raw?.buyer_id
    || session.raw?.user_info?.uid
    || session.sessionId
    || session.explicitSessionId
    || session.conversationId
    || session.chatId
    || session.rawId
    || ''
  ).trim();
}

function mergeSessionEntries(existing = {}, incoming = {}) {
  const existingTime = Number(existing?.lastMessageTime || 0) || 0;
  const incomingTime = Number(incoming?.lastMessageTime || 0) || 0;
  const preferIncoming = incomingTime >= existingTime;
  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  return {
    ...secondary,
    ...primary,
    customerName: primary.customerName || secondary.customerName || '',
    customerAvatar: primary.customerAvatar || secondary.customerAvatar || '',
    lastMessage: primary.lastMessage || secondary.lastMessage || '',
    lastMessageActor: primary.lastMessageActor || secondary.lastMessageActor || '',
    unreadCount: Math.max(Number(existing?.unreadCount || 0) || 0, Number(incoming?.unreadCount || 0) || 0),
    waitTime: Math.max(Number(existing?.waitTime || 0) || 0, Number(incoming?.waitTime || 0) || 0),
    groupNumber: Math.max(Number(existing?.groupNumber || 0) || 0, Number(incoming?.groupNumber || 0) || 0),
    group_number: Math.max(Number(existing?.group_number || 0) || 0, Number(incoming?.group_number || 0) || 0),
    raw: primary.raw || secondary.raw || null,
  };
}

function dedupeSessionList(sessions = []) {
  const map = new Map();
  (Array.isArray(sessions) ? sessions : []).forEach(session => {
    if (!session || typeof session !== 'object') return;
    const dedupKey = getSessionDedupKey(session);
    if (!dedupKey) return;
    const existing = map.get(dedupKey);
    if (!existing) {
      map.set(dedupKey, session);
      return;
    }
    map.set(dedupKey, mergeSessionEntries(existing, session));
  });
  return Array.from(map.values());
}

function extractSessionCreatedTime(item) {
  const candidates = [
    item?.create_time,
    item?.created_at,
    item?.createdAt,
    item?.createTime,
    item?.ctime,
    item?.context?.create_time,
    item?.context?.created_at,
    item?.session_create_time,
    item?.conversation_create_time,
    item?.first_msg_time,
    item?.first_message_time,
  ];
  return candidates.find(value => value !== undefined && value !== null && value !== '') || 0;
}

function extractSessionLastMessageActor(item = {}, mallId = '') {
  const context = {
    customer_id: item?.customer_id,
    buyer_id: item?.buyer_id,
    uid: item?.user_info?.uid,
    user_info: item?.user_info,
    from: item?.from,
    to: item?.to,
  };
  const candidates = [
    item?.last_msg,
    item?.last_message,
    item?.latest_msg,
    item?.content,
    item?.preview,
    item,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const actor = messageParsers.getMessageActor({ ...context, ...candidate }, mallId);
    if (actor !== 'unknown') return actor;
  }
  return 'unknown';
}

function normalizeTimestampMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? num * 1000 : num;
}

function isTodayTimestamp(value) {
  const ms = normalizeTimestampMs(value);
  if (!ms) return false;
  const date = new Date(ms);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function getRecentSessionStartMs() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return startOfToday - 24 * 60 * 60 * 1000;
}

function isWithinRecentTwoDaysTimestamp(value) {
  const ms = normalizeTimestampMs(value);
  if (!ms) return false;
  return ms >= getRecentSessionStartMs();
}

function hasPendingReplySession(session = {}) {
  const lastMessageActor = String(session?.lastMessageActor || '').toLowerCase();
  const lastMessageIsFromBuyer = session?.lastMessageIsFromBuyer === true || lastMessageActor === 'buyer';
  const waitValue = Number(session?.waitTime || 0);
  const hasPendingIndicators = (
    (Number.isFinite(waitValue) && waitValue > 0)
    || session?.isTimeout
    || Number(session?.unreadCount || 0) > 0
  );
  if (lastMessageIsFromBuyer) return hasPendingIndicators;
  if (lastMessageActor === 'seller') return false;
  return hasPendingIndicators;
}

function filterDisplaySessions(sessions = []) {
  return sessions
    .filter(session => (
      isWithinRecentTwoDaysTimestamp(session?.lastMessageTime)
      || isWithinRecentTwoDaysTimestamp(session?.createdAt)
    ))
    .sort((a, b) => {
      const leftTime = normalizeTimestampMs(a?.lastMessageTime || a?.createdAt || 0);
      const rightTime = normalizeTimestampMs(b?.lastMessageTime || b?.createdAt || 0);
      return rightTime - leftTime;
    });
}

function sortDisplaySessions(sessions = []) {
  return (Array.isArray(sessions) ? sessions.slice() : []).sort((a, b) => {
    const leftTime = normalizeTimestampMs(a?.lastMessageTime || a?.createdAt || 0);
    const rightTime = normalizeTimestampMs(b?.lastMessageTime || b?.createdAt || 0);
    return rightTime - leftTime;
  });
}

function pickPendingBuyerMessage(messages = [], buyerIds = [], sessionMeta = {}, mallId = '') {
  const sorted = Array.isArray(messages)
    ? messages.slice().sort((a, b) => normalizeTimestampMs(a?.timestamp) - normalizeTimestampMs(b?.timestamp))
    : [];
  let latestBuyerMessage = null;
  const comparableBuyerIds = Array.isArray(buyerIds)
    ? buyerIds.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const previewText = messageParsers.normalizeComparableMessageText(extractSessionPreviewText(sessionMeta));
  for (const item of sorted) {
    const actor = String(item?.actor || messageParsers.getMessageActor(item?.raw || item, mallId) || '').toLowerCase();
    const senderId = String(item?.senderId || item?.raw?.from_uid || item?.raw?.sender_id || item?.raw?.from_id || item?.raw?.from?.uid || '').trim();
    const isBuyerMessage = actor === 'buyer' || (!!senderId && comparableBuyerIds.includes(senderId));
    const isSellerMessage = actor === 'seller';
    const text = String(item?.content || '').trim();
    const normalizedText = messageParsers.normalizeComparableMessageText(text);
    const matchesPreview = !!previewText && !!normalizedText && normalizedText === previewText;
    if (!text || actor === 'system') continue;
    if (isSellerMessage) {
      latestBuyerMessage = null;
      continue;
    }
    if (isBuyerMessage || (actor === 'unknown' && matchesPreview)) {
      latestBuyerMessage = item;
    }
  }
  return latestBuyerMessage;
}

function parseSessionIdentity(item = {}, mallId = '') {
  const conversationId = item.conversation_id || item.conversationId || '';
  const chatId = item.chat_id || item.chatId || '';
  const explicitSessionId = item.session_id || item.sessionId || '';
  const rawId = item.id || '';
  const buyerUid = messageParsers.extractBuyerUid(item, mallId);
  const customerId = item.customer_id || item.buyer_id || item?.user_info?.uid || buyerUid || '';
  const userUid = item?.user_info?.uid || item.customer_id || item.buyer_id || buyerUid || '';
  const sessionId = explicitSessionId || conversationId || chatId || rawId || customerId || userUid || '';
  return {
    sessionId,
    explicitSessionId,
    conversationId,
    chatId,
    rawId,
    customerId: customerId || userUid || '',
    userUid: userUid || customerId || '',
  };
}

function pickDisplayText(sources = [], keys = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return '';
}

function resolveBuyerParticipant(item = {}, mallId = '') {
  const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
  const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
  const buyerUid = String(messageParsers.extractBuyerUid(item, mallId) || '');
  if (!buyerUid) return fromObj || toObj || null;
  if (String(fromObj?.uid || '') === buyerUid) return fromObj;
  if (String(toObj?.uid || '') === buyerUid) return toObj;
  return fromObj || toObj || null;
}

function extractSessionCustomerName(item = {}, mallId = '') {
  const userInfo = item?.user_info && typeof item.user_info === 'object' ? item.user_info : null;
  const buyerInfo = item?.buyer && typeof item.buyer === 'object' ? item.buyer : null;
  const customerInfo = item?.customer && typeof item.customer === 'object' ? item.customer : null;
  const participant = resolveBuyerParticipant(item, mallId);
  const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
  const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
  return pickDisplayText(
    [item, userInfo, buyerInfo, customerInfo, participant, fromObj, toObj],
    [
      'nick',
      'nickname',
      'nick_name',
      'buyer_name',
      'buyer_nickname',
      'buyer_nick_name',
      'customer_name',
      'customer_nickname',
      'customer_nick_name',
      'display_name',
      'displayName',
      'name',
    ],
  );
}

function extractSessionCustomerAvatar(item = {}, mallId = '') {
  const userInfo = item?.user_info && typeof item.user_info === 'object' ? item.user_info : null;
  const buyerInfo = item?.buyer && typeof item.buyer === 'object' ? item.buyer : null;
  const customerInfo = item?.customer && typeof item.customer === 'object' ? item.customer : null;
  const participant = resolveBuyerParticipant(item, mallId);
  const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
  const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
  return pickDisplayText(
    [item, userInfo, buyerInfo, customerInfo, participant, fromObj, toObj],
    [
      'avatar',
      'head_img',
      'buyer_avatar',
      'avatar_url',
      'avatarUrl',
    ],
  );
}

function extractMessageSenderName(item = {}, mallId = '') {
  const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
  const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
  const userInfo = item?.user_info && typeof item.user_info === 'object' ? item.user_info : null;
  const participant = messageParsers.isBuyerMessage(item, mallId) ? resolveBuyerParticipant(item, mallId) : fromObj;
  return pickDisplayText(
    [item, participant, fromObj, userInfo, toObj],
    [
      'nick',
      'nickname',
      'nick_name',
      'sender_name',
      'from_name',
      'display_name',
      'displayName',
      'name',
      'csid',
    ],
  );
}

function parseSessionList(payload, mallId = '') {
  const list = payload?.data?.list ||
    payload?.data?.conv_list ||
    payload?.data?.conversation_list ||
    payload?.data?.conversations ||
    payload?.data?.items ||
    payload?.result?.data?.list ||
    payload?.result?.data?.conv_list ||
    payload?.result?.data?.conversation_list ||
    payload?.result?.data?.conversations ||
    payload?.result?.data?.items ||
    payload?.result?.data ||
    payload?.result?.list ||
    payload?.result?.data ||
    payload?.result?.conversations ||
    payload?.result?.items ||
    payload?.conv_list ||
    payload?.conversation_list ||
    payload?.conversations ||
    payload?.data?.conversations ||
    payload?.list ||
    [];

  const sessions = list.map(item => {
    const identity = parseSessionIdentity(item, mallId);
    const lastMessageActor = extractSessionLastMessageActor(item, mallId);
    const customerName = extractSessionCustomerName(item, mallId);
    const customerAvatar = extractSessionCustomerAvatar(item, mallId);
    return {
      sessionId: identity.sessionId,
      explicitSessionId: identity.explicitSessionId,
      conversationId: identity.conversationId,
      chatId: identity.chatId,
      rawId: identity.rawId,
      customerId: identity.customerId,
      userUid: identity.userUid,
      customerName: customerName || '未知客户',
      customerAvatar,
      lastMessage: extractSessionPreviewText(item),
      lastMessageTime: extractSessionPreviewTime(item),
      lastMessageActor,
      lastMessageIsFromBuyer: lastMessageActor === 'buyer',
      createdAt: extractSessionCreatedTime(item),
      unreadCount: item.unread_count || item.unread || item.unread_num || item?.context?.unread || 0,
      isTimeout: item.is_timeout || item.timeout || false,
      waitTime: item.wait_time || item.waiting_time || item.last_unreply_time || 0,
      groupNumber: item.groupNumber ?? item.group_number ?? item?.user_info?.group_number ?? item?.user_info?.groupNumber ?? 0,
      group_number: item.group_number ?? item.groupNumber ?? item?.user_info?.group_number ?? item?.user_info?.groupNumber ?? 0,
      orderId: item.order_id || item.order_sn || '',
      goodsInfo: item.goods_info || item.goods || null,
      csUid: item?.from?.cs_uid || '',
      mallId: item?.from?.mall_id || '',
      mallName: item.mallName || item.mall_name || item?.mall_info?.mall_name || item?.mall_info?.mallName || '',
      isShopMember: typeof item.is_shop_member === 'boolean'
        ? item.is_shop_member
        : (typeof item.isShopMember === 'boolean' ? item.isShopMember : null),
      raw: item,
    };
  });
  return dedupeSessionList(sessions);
}

function describeSessionListPayload(payload) {
  const candidates = {
    dataList: Array.isArray(payload?.data?.list) ? payload.data.list.length : -1,
    dataConvList: Array.isArray(payload?.data?.conv_list) ? payload.data.conv_list.length : -1,
    dataConversations: Array.isArray(payload?.data?.conversations) ? payload.data.conversations.length : -1,
    dataConversationList: Array.isArray(payload?.data?.conversation_list) ? payload.data.conversation_list.length : -1,
    dataItems: Array.isArray(payload?.data?.items) ? payload.data.items.length : -1,
    resultDataList: Array.isArray(payload?.result?.data?.list) ? payload.result.data.list.length : -1,
    resultDataConvList: Array.isArray(payload?.result?.data?.conv_list) ? payload.result.data.conv_list.length : -1,
    resultDataConversations: Array.isArray(payload?.result?.data?.conversations) ? payload.result.data.conversations.length : -1,
    resultList: Array.isArray(payload?.result?.list) ? payload.result.list.length : -1,
    resultConversations: Array.isArray(payload?.result?.conversations) ? payload.result.conversations.length : -1,
    resultItems: Array.isArray(payload?.result?.items) ? payload.result.items.length : -1,
    rootList: Array.isArray(payload?.list) ? payload.list.length : -1,
    rootConvList: Array.isArray(payload?.conv_list) ? payload.conv_list.length : -1,
    rootConversations: Array.isArray(payload?.conversations) ? payload.conversations.length : -1,
  };
  return {
    payloadType: Array.isArray(payload) ? 'array' : typeof payload,
    topKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
    dataKeys: payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data).slice(0, 12) : [],
    resultKeys: payload?.result && typeof payload.result === 'object' ? Object.keys(payload.result).slice(0, 12) : [],
    candidates,
  };
}

function normalizeOrderSn(value) {
  return String(value || '').trim().toLowerCase();
}

function matchSessionByOrderSn(session = {}, orderSn = '') {
  const targetOrderSn = normalizeOrderSn(orderSn);
  if (!targetOrderSn) return false;
  const candidates = [
    session?.orderId,
    session?.orderSn,
    session?.order_sn,
    session?.raw?.order_id,
    session?.raw?.orderId,
    session?.raw?.order_sn,
    session?.raw?.orderSn,
  ].map(value => normalizeOrderSn(value)).filter(Boolean);
  return candidates.includes(targetOrderSn);
}

module.exports = {
  extractSessionPreviewText,
  extractSessionPreviewTime,
  getSessionDedupKey,
  mergeSessionEntries,
  dedupeSessionList,
  extractSessionCreatedTime,
  extractSessionLastMessageActor,
  normalizeTimestampMs,
  isTodayTimestamp,
  getRecentSessionStartMs,
  isWithinRecentTwoDaysTimestamp,
  hasPendingReplySession,
  filterDisplaySessions,
  sortDisplaySessions,
  pickPendingBuyerMessage,
  parseSessionIdentity,
  pickDisplayText,
  resolveBuyerParticipant,
  extractSessionCustomerName,
  extractSessionCustomerAvatar,
  extractMessageSenderName,
  parseSessionList,
  describeSessionListPayload,
  normalizeOrderSn,
  matchSessionByOrderSn,
};
