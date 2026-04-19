'use strict';

/**
 * ticket-api 共享纯函数：取值、JSON 安全解析、列表去重、模板存储、
 * 表头大小写兼容查询、payload 数组提取、地区项归一化、列表请求体清洗、
 * payload meta 摘要等。
 *
 * 这些函数原本散落在 business-api/ticket-api.js 顶部约 200 行；它们既会
 * 被 strickland 工单链路用到，也会被 mercury 售后链路与物流地区链路用到，
 * 抽到这里方便后续 modules 独立 require，主 client 也只需要复用它们的
 * 默认导出，避免子模块再各自复制粘贴。
 */

function pickValue(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSafely(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function dedupeBodies(list = []) {
  const seen = new Set();
  return list.filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getListTemplateStore() {
  if (!global.__pddListTemplates) global.__pddListTemplates = {};
  return global.__pddListTemplates;
}

function getShopListTemplates(shopId) {
  const store = getListTemplateStore();
  if (!store[shopId]) store[shopId] = {};
  return store[shopId];
}

function normalizeTemplateKey(value) {
  return String(value || '').trim();
}

function bodyContainsText(body, text) {
  if (!isPlainObject(body)) return false;
  const keyword = String(text || '').trim();
  if (!keyword) return false;
  try {
    return JSON.stringify(body).includes(keyword);
  } catch {
    return false;
  }
}

function pickHeaderCaseInsensitive(headers, keys = []) {
  if (!headers || typeof headers !== 'object') return '';
  const lowerMap = Object.keys(headers).reduce((acc, key) => {
    acc[String(key).toLowerCase()] = headers[key];
    return acc;
  }, {});
  for (const key of keys) {
    const value = lowerMap[String(key).toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function extractArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.result,
    payload.data,
    payload.list,
    payload.regions,
    payload.regionList,
    payload?.result?.list,
    payload?.result?.regions,
    payload?.data?.list,
    payload?.data?.regions
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function normalizeRegionItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = pickValue(raw, [
    'id',
    'regionId',
    'region_id',
    'areaId',
    'area_id',
    'code',
    'value'
  ], '');
  const name = pickValue(raw, [
    'name',
    'regionName',
    'region_name',
    'areaName',
    'area_name',
    'label',
    'text',
    'value'
  ], '');
  const trimmedName = String(name || '').trim();
  let trimmedId = String(id ?? '').trim();
  if (typeof id === 'number' && Number.isFinite(id)) trimmedId = String(id);
  if (trimmedId && !/^\d+$/.test(trimmedId)) trimmedId = '';
  if (!trimmedId) return null;
  return { id: trimmedId, name: trimmedName || trimmedId };
}

function normalizeListRequestBody(body, forwardedFields = {}) {
  if (!isPlainObject(body)) return body;
  const next = { ...body };

  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(forwardedFields, key);
  const timeKeys = ['createStartTime', 'createEndTime', 'create_start_time', 'create_end_time'];
  const callerProvidedTime = timeKeys.some(hasOwn);
  if (!callerProvidedTime) {
    timeKeys.forEach(key => {
      if (key in next) delete next[key];
    });
  }

  const arrayFilterKeys = ['serviceStatus', 'service_status', 'problemType', 'problem_type'];
  arrayFilterKeys.forEach(key => {
    if (hasOwn(key)) return;
    const value = next[key];
    if (!Array.isArray(value)) return;
    const cleaned = value
      .filter(item => item !== null && item !== undefined && String(item).trim() !== '')
      .map(item => (/^\d+$/.test(String(item)) ? Number(item) : item));
    if (!cleaned.length) {
      delete next[key];
    } else {
      next[key] = cleaned;
    }
  });

  Object.keys(next).forEach(key => {
    if (next[key] === null || next[key] === undefined) delete next[key];
  });

  return next;
}

function buildPayloadMeta(payload) {
  const meta = {
    type: Array.isArray(payload) ? 'array' : typeof payload,
    topKeys: [],
    resultType: '',
    resultKeys: [],
    dataType: '',
    dataKeys: [],
  };
  if (!payload || typeof payload !== 'object') return meta;
  if (!Array.isArray(payload)) {
    meta.topKeys = Object.keys(payload);
  }
  const result = payload?.result;
  meta.resultType = Array.isArray(result) ? 'array' : typeof result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    meta.resultKeys = Object.keys(result);
  }
  const data = payload?.data;
  meta.dataType = Array.isArray(data) ? 'array' : typeof data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    meta.dataKeys = Object.keys(data);
  }
  return meta;
}

module.exports = {
  pickValue,
  isPlainObject,
  parseJsonSafely,
  dedupeBodies,
  getListTemplateStore,
  getShopListTemplates,
  normalizeTemplateKey,
  bodyContainsText,
  pickHeaderCaseInsensitive,
  extractArrayFromPayload,
  normalizeRegionItem,
  normalizeListRequestBody,
  buildPayloadMeta,
};
