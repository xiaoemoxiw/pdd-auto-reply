'use strict';

// 订单备注相关的纯解析/格式化函数。
// PddApiClient 通过 thin wrapper 转发, 涉及缓存或业务错误归一化等需要实例状态
// 的方法仍保留在主类。
const refundParsers = require('./refund-parsers');

const ORDER_REMARK_TAG_LABELS = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  BLUE: '蓝色',
  PURPLE: '紫色',
};

function formatOrderRemarkDateTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

function formatOrderRemarkMeta(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

function extractOrderRemarkText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(item => extractOrderRemarkText(item)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object') return '';
  return refundParsers.pickRefundText([value], [
    'note',
    'content',
    'text',
    'remark',
    'desc',
    'message',
    'value',
  ]);
}

function normalizeOrderRemarkTag(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!normalized) return '';
  if (['0', 'NULL', 'UNDEFINED', 'FALSE', 'NONE'].includes(normalized)) {
    return '';
  }
  return normalized;
}

function isOrderRemarkSaveIntervalError(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return false;
  return /两次备注间隔时长需大于1秒|备注间隔时长需大于1秒|间隔时长需大于1秒/.test(message);
}

function isOrderRemarkSaveMatched(remark = {}, note = '', tag = '') {
  return extractOrderRemarkText(remark?.note) === extractOrderRemarkText(note)
    && normalizeOrderRemarkTag(remark?.tag) === normalizeOrderRemarkTag(tag);
}

function maskOrderRemarkOrderSn(orderSn) {
  const normalizedOrderSn = String(orderSn || '').trim();
  if (!normalizedOrderSn) return '';
  if (normalizedOrderSn.length <= 8) return normalizedOrderSn;
  return `${normalizedOrderSn.slice(0, 4)}***${normalizedOrderSn.slice(-4)}`;
}

function summarizeOrderRemarkRequest(urlPath, body = {}, via = 'direct') {
  const normalizedNote = extractOrderRemarkText(body?.note);
  return {
    urlPath: String(urlPath || ''),
    via,
    orderSn: maskOrderRemarkOrderSn(body?.orderSn),
    hasNote: normalizedNote.length > 0,
    noteLength: normalizedNote.length,
    tag: normalizeOrderRemarkTag(body?.tag),
    source: Number(body?.source) > 0 ? Number(body.source) : 1,
  };
}

function getOrderRemarkTagName(tag, tagOptionsCache = null) {
  const normalizedTag = normalizeOrderRemarkTag(tag);
  if (!normalizedTag) return '';
  const cachedName = tagOptionsCache?.[normalizedTag];
  if (cachedName) return String(cachedName).trim();
  return ORDER_REMARK_TAG_LABELS[normalizedTag] || '';
}

function normalizeOrderRemarkTagOptions(payload = {}) {
  const source = payload?.result && typeof payload.result === 'object'
    ? payload.result
    : (payload && typeof payload === 'object' ? payload : {});
  const entries = Object.entries(source)
    .map(([value, label]) => [String(value || '').trim().toUpperCase(), String(label || '').trim()])
    .filter(([value, label]) => value && label);
  const preferredOrder = ['RED', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE'];
  const ordered = [
    ...preferredOrder.filter(key => entries.some(([value]) => value === key)),
    ...entries.map(([value]) => value).filter(value => !preferredOrder.includes(value)),
  ];
  return ordered.reduce((result, key) => {
    const matched = entries.find(([value]) => value === key);
    if (matched) result[key] = matched[1];
    return result;
  }, {});
}

module.exports = {
  ORDER_REMARK_TAG_LABELS,
  formatOrderRemarkDateTime,
  formatOrderRemarkMeta,
  extractOrderRemarkText,
  normalizeOrderRemarkTag,
  isOrderRemarkSaveIntervalError,
  isOrderRemarkSaveMatched,
  maskOrderRemarkOrderSn,
  summarizeOrderRemarkRequest,
  getOrderRemarkTagName,
  normalizeOrderRemarkTagOptions,
};
