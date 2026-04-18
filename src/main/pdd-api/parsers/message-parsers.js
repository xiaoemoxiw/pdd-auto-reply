'use strict';

// 消息相关的纯解析函数。
// PddApiClient 通过 thin wrapper 转发, 涉及 mallId/trusteeshipInfo/readMark 等
// 实例侧的数据由调用方通过参数 (mallId / options) 传入, 函数本身不依赖任何
// 实例状态, 也不发起 IO。
//
// 注意: 外部直接传递 mallId 字符串 (PddApiClient._getMallId() || '')。

const goodsParsers = require('./goods-parsers');
const refundParsers = require('./refund-parsers');

function normalizeComparableMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isRobotManagedTextMessage(item = {}) {
  const templateName = String(item?.template_name || item?.templateName || '').trim();
  const showAuto = item?.show_auto === true || item?.showAuto === true;
  return templateName === 'mall_robot_text_msg' || showAuto;
}

function extractStructuredMessageEntryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return goodsParsers.pickGoodsText([
    entry?.text,
    entry?.content,
    entry?.message,
    entry?.msg,
    entry?.title,
    entry?.label,
    entry?.name,
    entry?.desc,
    entry?.value,
  ]);
}

function extractStructuredMessageText(item = {}) {
  const info = item?.info && typeof item.info === 'object' ? item.info : {};
  const infoData = info?.data && typeof info.data === 'object' ? info.data : {};
  const systemInfo = item?.system && typeof item.system === 'object' ? item.system : {};
  const pushBizContext = item?.push_biz_context && typeof item.push_biz_context === 'object' ? item.push_biz_context : {};
  const directText = goodsParsers.pickGoodsText([
    info?.mall_content,
    info?.merchant_content,
    info?.content,
    info?.text,
    info?.title,
    infoData?.mall_content,
    infoData?.content,
    infoData?.text,
    infoData?.title,
    info?.label,
    info?.desc,
    info?.tip,
    info?.message,
    systemInfo?.text,
    systemInfo?.content,
    pushBizContext?.replace_content,
    pushBizContext?.replaceContent,
  ]);
  if (directText) return directText;
  const entryLists = [
    Array.isArray(info?.item_content) ? info.item_content : [],
    Array.isArray(info?.mall_item_content) ? info.mall_item_content : [],
    Array.isArray(info?.items) ? info.items : [],
  ];
  for (const list of entryLists) {
    const entryText = list
      .map(entry => extractStructuredMessageEntryText(entry))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (entryText) return entryText;
  }
  return '';
}

function extractMessageReadState(item = {}) {
  const candidates = [
    item?.is_read,
    item?.isRead,
    item?.read_status,
    item?.readStatus,
    item?.read_state,
    item?.readState,
    item?.extra?.is_read,
    item?.extra?.isRead,
    item?.extra?.read_status,
    item?.extra?.readStatus,
    item?.extra?.read_state,
    item?.extra?.readState,
    item?.ext?.is_read,
    item?.ext?.isRead,
    item?.ext?.read_status,
    item?.ext?.readStatus,
    item?.ext?.read_state,
    item?.ext?.readState,
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean') return value ? 'read' : 'unread';
    if (typeof value === 'number') return value > 0 ? 'read' : 'unread';
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) continue;
      if (['1', 'true', 'read', 'has_read', 'already_read', '已读'].includes(normalized)) return 'read';
      if (['0', 'false', 'unread', 'not_read', '未读'].includes(normalized)) return 'unread';
    }
  }
  return '';
}

function findMessageArray(payload) {
  const directCandidates = [
    payload?.data?.msg_list,
    payload?.data?.messages,
    payload?.result?.data?.msg_list,
    payload?.result?.data?.messages,
    payload?.result?.data?.list,
    payload?.result?.msg_list,
    payload?.result?.messages,
    payload?.result?.list,
    payload?.msg_list,
    payload?.messages,
    payload?.data?.list,
  ];
  const directList = directCandidates.find(item => Array.isArray(item) && item.length);
  if (directList) return directList;
  const queue = [payload];
  const visited = new Set();
  const candidateKeys = new Set([
    'msg_list',
    'message_list',
    'messages',
    'msg_info',
    'chat_msg',
    'im_msg',
    'recv_msg',
    'new_msg',
    'data',
    'result',
    'list',
    'items',
    'records',
    'response',
    'conversations',
    'conv_list',
    'chat_list',
    'msg_data',
    'message_data',
  ]);
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      if (current.length && current.some(item => item && typeof item === 'object')) {
        return current;
      }
      continue;
    }
    Object.keys(current).forEach(key => {
      if (!candidateKeys.has(key)) return;
      queue.push(current[key]);
    });
  }
  return directCandidates.find(Array.isArray) || [];
}

function isSystemNoticeText(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  if (refundParsers.isRefundPendingNoticeText(source) || refundParsers.isRefundSuccessNoticeText(source)) return true;
  return [
    /您接待过此消费者/,
    /机器人已暂停接待/,
    /机器人未找到对应(?:的)?回复/,
    /立即恢复接待/,
    /为避免插嘴/,
    /为避免插播/,
    /为避免抢答/,
    /当前用户来自/,
    /商品详情页/,
    /订单已超承诺发货时间/,
    /请人工跟进/,
  ].some(pattern => pattern.test(source));
}

function extractPendingConfirmMessageText(item = {}, fallbackText = '', latestTrusteeshipInfo = null) {
  const raw = item && typeof item === 'object' ? item : {};
  const templateName = String(raw?.template_name || raw?.templateName || '').trim();
  const showAuto = raw?.show_auto === true || raw?.showAuto === true;
  if (templateName !== 'mall_robot_text_msg' && !showAuto) return '';

  const normalizedFallback = normalizeComparableMessageText(fallbackText);
  const fallbackLooksBroken = !normalizedFallback
    || /^\d+$/.test(normalizedFallback)
    || normalizedFallback.length <= 4;
  const pendingInfo = latestTrusteeshipInfo && typeof latestTrusteeshipInfo === 'object'
    ? latestTrusteeshipInfo
    : null;
  const pendingConfirmData = pendingInfo?.pendingConfirmData;
  const showText = normalizeComparableMessageText(pendingConfirmData?.showText || '');
  if (!showText) return '';

  const consumerMessageId = String(
    raw?.biz_context?.consumer_msg_id
    || raw?.bizContext?.consumer_msg_id
    || raw?.bizContext?.consumerMsgId
    || raw?.push_biz_context?.consumer_msg_id
    || raw?.pushBizContext?.consumer_msg_id
    || ''
  ).trim();
  const referenceConsumerMessageId = String(
    pendingConfirmData?.referenceConsumerMessageId
    || pendingConfirmData?.refConsumerMessageId
    || ''
  ).trim();
  if (consumerMessageId && referenceConsumerMessageId && consumerMessageId === referenceConsumerMessageId) {
    return showText;
  }
  return fallbackLooksBroken ? showText : '';
}

function extractMessageText(item, options = {}) {
  const candidates = [
    item?.content,
    item?.text,
    item?.msg_content,
    item?.message,
    item?.body,
    item?.msg_text,
    item?.msg,
    item?.extra?.text,
    item?.ext?.text,
  ];
  let directText = '';
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      directText = value;
      break;
    }
    if (value && typeof value === 'object') {
      const nestedText = [
        value.text,
        value.content,
        value.message,
        value.msg,
        value.title,
      ].find(entry => typeof entry === 'string' && entry.trim());
      if (nestedText) {
        directText = nestedText;
        break;
      }
    }
  }
  const structuredText = directText ? '' : extractStructuredMessageText(item);
  const extractedText = String(directText || structuredText || '').trim();
  const pendingConfirmText = extractPendingConfirmMessageText(
    item,
    extractedText,
    options?.latestTrusteeshipInfo || null,
  );
  return pendingConfirmText || extractedText;
}

function isInviteOrderTemplateMessage(item = {}) {
  const templateName = String(item?.template_name || item?.templateName || '').trim();
  if (templateName === 'substitute_order_v2' || templateName === 'substitute_order_v3') return true;
  if (templateName) return false;
  const messageType = Number(
    item?.type
    ?? item?.msg_type
    ?? item?.message_type
    ?? item?.content_type
    ?? -1
  );
  const sourceText = extractMessageText(item);
  if (refundParsers.isRefundPendingNoticeText(sourceText) || refundParsers.isRefundSuccessNoticeText(sourceText)) {
    return false;
  }
  const info = item?.info && typeof item.info === 'object' ? item.info : {};
  const infoData = info?.data && typeof info.data === 'object' ? info.data : {};
  const goodsInfoList = [
    infoData?.goods_info_list,
    infoData?.goodsInfoList,
    infoData?.goods_list,
    infoData?.goodsList,
    info?.goods_info_list,
    info?.goodsInfoList,
    info?.goods_list,
    info?.goodsList,
  ].find(Array.isArray) || [];
  return messageType === 64 && !!(
    goodsInfoList.length
    && goodsInfoList.some(entry => entry && typeof entry === 'object')
  );
}

function isSystemNoticeMessage(item = {}) {
  const sourceText = extractMessageText(item);
  if (refundParsers.isRefundDefaultSellerNoteText(sourceText)) return false;
  if (isRobotManagedTextMessage(item)) return false;
  const messageType = Number(
    item?.type
    ?? item?.msg_type
    ?? item?.message_type
    ?? item?.content_type
    ?? -1
  );
  const cardId = String(item?.info?.card_id || '').trim();
  if (messageType === 19 && cardId === 'ask_refund_apply') return false;
  if (isInviteOrderTemplateMessage(item)) return false;
  if (messageType === 31 || messageType === 90) return true;
  const templateName = String(item?.template_name || item?.templateName || '').trim();
  if (templateName) return true;
  const systemInfo = item?.system;
  if (systemInfo && typeof systemInfo === 'object' && Object.keys(systemInfo).length) return true;
  return isSystemNoticeText(sourceText);
}

function getMessageActor(item = {}, mallId = '') {
  if (isSystemNoticeMessage(item)) return 'system';
  const role = String(
    item.role ||
    item.msg_from ||
    item.from_type ||
    item.sender_role ||
    item?.from?.role ||
    item?.sender?.role ||
    item?.to?.role ||
    ''
  ).toLowerCase();
  if (['buyer', 'customer', 'user', '1', '0'].includes(role)) return 'buyer';
  if (['system', 'robot', 'bot', 'notice', 'tips', '99'].includes(role)) return 'system';
  if (['seller', 'service', 'kf', 'agent', 'mall_cs', '2', '3', '4'].includes(role)) return 'seller';
  if (item.is_buyer || item.is_buyer === 1 || item.sender_type === 1 || item.sender_type === 0) return 'buyer';
  if (item.is_robot || item.is_system) return 'system';
  if (item.is_seller) return 'seller';

  const normalizedMallId = String(mallId || '');
  const fromUid = String(item?.from?.uid || item.from_uid || item.sender_id || item.from_id || '');
  const toUid = String(item?.to?.uid || item.to_uid || '');
  const buyerUidCandidates = [
    item?.customer_id,
    item?.buyer_id,
    item?.uid,
    item?.user_info?.uid,
  ].map(value => String(value || '')).filter(Boolean);

  if (normalizedMallId && (fromUid === normalizedMallId || String(item?.from?.mall_id || '') === normalizedMallId)) return 'seller';
  if (normalizedMallId && (toUid === normalizedMallId || String(item?.to?.mall_id || '') === normalizedMallId)) return 'buyer';
  if (fromUid && buyerUidCandidates.includes(fromUid)) return 'buyer';
  if (toUid && buyerUidCandidates.includes(toUid)) return 'seller';
  return 'unknown';
}

function isBuyerMessage(item, mallId = '') {
  return getMessageActor(item, mallId) === 'buyer';
}

function extractBuyerUid(item = {}, mallId = '') {
  const directCandidates = [
    item.customer_id,
    item.buyer_id,
    item?.user_info?.uid,
    item.uid,
  ].map(value => String(value || '')).filter(Boolean);
  if (directCandidates.length) return directCandidates[0];
  const normalizedMallId = String(mallId || '');
  const fromUid = String(item?.from?.uid || item.from_uid || '');
  const toUid = String(item?.to?.uid || item.to_uid || '');
  const fromRole = String(item?.from?.role || '').toLowerCase();
  const toRole = String(item?.to?.role || '').toLowerCase();
  if (['buyer', 'customer', 'user'].includes(fromRole) && fromUid) return fromUid;
  if (['buyer', 'customer', 'user'].includes(toRole) && toUid) return toUid;
  if (normalizedMallId) {
    if (fromUid && fromUid === normalizedMallId && toUid) return toUid;
    if (toUid && toUid === normalizedMallId && fromUid) return fromUid;
    if (String(item?.from?.mall_id || '') === normalizedMallId && toUid) return toUid;
    if (String(item?.to?.mall_id || '') === normalizedMallId && fromUid) return fromUid;
  }
  return toUid || fromUid || '';
}

module.exports = {
  normalizeComparableMessageText,
  isRobotManagedTextMessage,
  extractStructuredMessageEntryText,
  extractStructuredMessageText,
  extractMessageReadState,
  findMessageArray,
  isSystemNoticeText,
  extractPendingConfirmMessageText,
  extractMessageText,
  isInviteOrderTemplateMessage,
  isSystemNoticeMessage,
  getMessageActor,
  isBuyerMessage,
  extractBuyerUid,
};
