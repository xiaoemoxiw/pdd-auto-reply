'use strict';

/**
 * 工单（strickland 客服处理）列表 / 状态计数 / 详情模块。
 *
 * 拼多多工单列表接口字段在不同店铺、不同活动间会有差异，所以这里保留了：
 * - 多套请求体候选（template / 抓包模板 / 默认分页变体）；
 * - 候选 response 的递归扫描（result / data / list / records 等位置都可能命中）；
 * - 响应里 `_looksLikeTicketRecord` / `_looksLikeTicketDetail` 模糊判定，
 *   保证拿到的对象是工单而不是嵌在响应里的其它聚合数据。
 *
 * 这套兼容逻辑只服务 strickland 域，与 mercury 售后无关，所以独立成一个
 * module。模板存储仍走全局 __pddListTemplates，方便后续 captureAs 抓包写入。
 */

const {
  pickValue,
  isPlainObject,
  dedupeBodies,
  getShopListTemplates,
  normalizeTemplateKey,
  bodyContainsText,
  normalizeListRequestBody,
  buildPayloadMeta,
} = require('../parsers/ticket-helpers');

const TICKET_LIST_URL = '/strickland/sop/mms/todoList';
const TICKET_DETAIL_URL = '/strickland/sop/mms/detail';
const TICKET_STATUS_COUNT_URL = '/strickland/sop/mms/statusCount';

const TICKET_RECORD_HINT_KEYS = [
  'instanceId',
  'instance_id',
  'todoId',
  'todo_id',
  'workOrderId',
  'work_order_id',
  'workOrderSn',
  'work_order_sn',
  'ticketId',
  'ticket_id',
  'id',
  'orderSn',
  'order_sn',
  'problemTitle',
  'problem_title',
  'title',
  'goodsName',
  'goods_name',
  'status',
  'statusStr',
  'status_str',
  'serviceStatus',
  'service_status',
  'externalDisplayName',
  'external_display_name',
];

const TICKET_DETAIL_HINT_KEYS = [
  'problemTitle',
  'status',
  'orderSn',
  'thumbUrl',
  'goodsName',
  'goodsNumber',
  'goodsPrice',
  'merchantAmount',
  'orderStatusStr',
  'afterSalesStatusDesc',
  'reverseTrackingNumber',
  'todoDetail'
];

function looksLikeTicketRecord(item) {
  if (!isPlainObject(item)) return false;
  return TICKET_RECORD_HINT_KEYS.some(key => key in item);
}

function looksLikeTicketDetail(item) {
  if (!isPlainObject(item)) return false;
  return TICKET_DETAIL_HINT_KEYS.some(key => key in item);
}

function extractListFromPayload(payload, visited = new Set()) {
  if (!payload || typeof payload !== 'object') return [];
  if (visited.has(payload)) return [];
  visited.add(payload);
  if (Array.isArray(payload)) {
    if (!payload.length) return [];
    if (payload.some(item => looksLikeTicketRecord(item))) {
      return payload.filter(item => looksLikeTicketRecord(item));
    }
    if (payload.some(item => isPlainObject(item))) {
      return payload.filter(item => isPlainObject(item));
    }
    for (const item of payload) {
      const nested = extractListFromPayload(item, visited);
      if (nested.length) return nested;
    }
    return [];
  }
  const directCandidates = [
    payload?.result?.dataList,
    payload?.result?.list,
    payload?.result?.records,
    payload?.data?.dataList,
    payload?.data?.list,
    payload?.data?.records,
    payload?.list,
    payload?.records,
    payload?.data,
    payload?.result
  ];
  for (const candidate of directCandidates) {
    if (Array.isArray(candidate) && candidate.some(item => looksLikeTicketRecord(item))) {
      return candidate.filter(item => looksLikeTicketRecord(item));
    }
    if (Array.isArray(candidate) && candidate.some(item => isPlainObject(item))) {
      return candidate.filter(item => isPlainObject(item));
    }
  }
  for (const value of Object.values(payload)) {
    const nested = extractListFromPayload(value, visited);
    if (nested.length) return nested;
  }
  return [];
}

function extractTotalFromPayload(payload, fallbackTotal = 0) {
  const total = Number(
    payload?.result?.total
    ?? payload?.result?.totalCount
    ?? payload?.result?.count
    ?? payload?.result?.totalNum
    ?? payload?.data?.total
    ?? payload?.data?.totalCount
    ?? payload?.data?.count
    ?? payload?.total
    ?? payload?.totalCount
    ?? payload?.count
    ?? fallbackTotal
  );
  return Number.isFinite(total) ? total : fallbackTotal;
}

function extractDetailFromPayload(payload, visited = new Set()) {
  if (!payload || typeof payload !== 'object') return null;
  if (visited.has(payload)) return null;
  visited.add(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractDetailFromPayload(item, visited);
      if (nested) return nested;
    }
    return null;
  }
  const directCandidates = [
    payload?.result?.detail,
    payload?.result?.data,
    payload?.result?.record,
    payload?.result,
    payload?.data?.detail,
    payload?.data?.data,
    payload?.data?.record,
    payload?.data,
    payload?.detail,
    payload?.record,
    payload
  ];
  for (const candidate of directCandidates) {
    if (looksLikeTicketDetail(candidate) || looksLikeTicketRecord(candidate)) {
      return candidate;
    }
  }
  for (const value of Object.values(payload)) {
    const nested = extractDetailFromPayload(value, visited);
    if (nested) return nested;
  }
  return null;
}

function buildListBodies(client, params = {}) {
  const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
  const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
  const forwardedFields = isPlainObject(params.forwardedFields) ? params.forwardedFields : {};
  const templateBody = isPlainObject(params.templateBody) ? params.templateBody : null;
  const trafficBody = client._getTrafficRequestBody(TICKET_LIST_URL);

  const applyPagination = (source) => {
    const nextBody = { ...(source || {}) };
    ['pageNo', 'page_no', 'pageNum', 'page_num', 'page', 'currentPage'].forEach(key => {
      if (key in nextBody) nextBody[key] = pageNo;
    });
    ['pageSize', 'page_size', 'size', 'limit'].forEach(key => {
      if (key in nextBody) nextBody[key] = pageSize;
    });
    if (!('pageNo' in nextBody) && !('page_no' in nextBody) && !('pageNum' in nextBody) && !('page_num' in nextBody) && !('page' in nextBody) && !('currentPage' in nextBody)) {
      nextBody.pageNo = pageNo;
    }
    if (!('pageSize' in nextBody) && !('page_size' in nextBody) && !('size' in nextBody) && !('limit' in nextBody)) {
      nextBody.pageSize = pageSize;
    }
    return normalizeListRequestBody(nextBody, forwardedFields);
  };

  const bodies = [];
  if (templateBody) {
    bodies.push(applyPagination({ ...templateBody, ...forwardedFields }));
  }
  if (trafficBody) {
    bodies.push(applyPagination({ ...trafficBody, ...forwardedFields }));
  }
  bodies.push(
    applyPagination({ ...forwardedFields }),
    applyPagination({ pageNum: pageNo, pageSize, ...forwardedFields }),
    applyPagination({ page_no: pageNo, page_size: pageSize, ...forwardedFields }),
    applyPagination({ page: pageNo, size: pageSize, ...forwardedFields })
  );
  return dedupeBodies(bodies.filter(item => isPlainObject(item)));
}

function buildDetailBodies(client, params = {}) {
  const instanceId = String(pickValue(params, [
    'instanceId',
    'instance_id',
    'detailRequestId',
    'detail_request_id',
    'ticketNo',
    'ticket_no',
    'todoId',
    'todo_id',
    'workOrderId',
    'work_order_id',
    'workOrderSn',
    'work_order_sn',
    'ticketId',
    'ticket_id',
    'ticketSn',
    'ticket_sn',
    'taskId',
    'task_id',
    'id'
  ], '') || '').trim();
  if (!instanceId) return [];
  const normalizedId = /^\d+$/.test(instanceId) ? Number(instanceId) : instanceId;
  const trafficBody = client._getTrafficRequestBody(TICKET_DETAIL_URL);
  const bodies = [];
  if (trafficBody) {
    const nextBody = { ...trafficBody };
    ['instanceId', 'instance_id', 'todoId', 'todo_id', 'workOrderId', 'work_order_id', 'ticketId', 'ticket_id', 'taskId', 'task_id', 'id'].forEach(key => {
      if (key in nextBody) nextBody[key] = normalizedId;
    });
    bodies.push(nextBody);
  }
  bodies.push(
    { instanceId: normalizedId },
    { instance_id: normalizedId },
    { todoId: normalizedId },
    { todo_id: normalizedId },
    { workOrderId: normalizedId },
    { work_order_id: normalizedId },
    { workOrderSn: normalizedId },
    { work_order_sn: normalizedId },
    { ticketId: normalizedId },
    { ticket_id: normalizedId },
    { ticketSn: normalizedId },
    { ticket_sn: normalizedId },
    { taskId: normalizedId },
    { task_id: normalizedId },
    { id: normalizedId }
  );
  return dedupeBodies(bodies.filter(item => isPlainObject(item)));
}

class TicketListModule {
  constructor(client) {
    this.client = client;
  }

  async getList(params = {}, options = {}) {
    const client = this.client;
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const templateKey = normalizeTemplateKey(params.templateKey || params.template_key);
    const captureAs = normalizeTemplateKey(params.captureAs || params.capture_as);
    const debug = params?.debug === true;

    const templates = getShopListTemplates(client.shopId);
    if (captureAs) {
      const latestTraffic = client._getTrafficRequestBody(TICKET_LIST_URL);
      if (latestTraffic) templates[captureAs] = latestTraffic;
    }

    let templateBody = templateKey ? templates[templateKey] : null;
    if (!templateBody && templateKey) {
      const latestTraffic = client._getTrafficRequestBody(TICKET_LIST_URL);
      if (latestTraffic && bodyContainsText(latestTraffic, templateKey)) {
        templateBody = latestTraffic;
        templates[templateKey] = latestTraffic;
      }
    }

    const forwardedFields = { ...params };
    [
      'pageNo',
      'page_no',
      'pageNum',
      'page_num',
      'page',
      'currentPage',
      'pageSize',
      'page_size',
      'size',
      'limit',
      'templateKey',
      'template_key',
      'captureAs',
      'capture_as',
      'debug',
    ].forEach(key => {
      if (key in forwardedFields) delete forwardedFields[key];
    });

    const bodies = buildListBodies(client, {
      ...params,
      pageNo,
      pageSize,
      templateBody,
      forwardedFields
    });
    let bestResult = null;
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await client._request('POST', TICKET_LIST_URL, body, {}, options);
        const list = extractListFromPayload(payload);
        const total = extractTotalFromPayload(payload, list.length);
        if (!bestResult || list.length > bestResult.list.length) {
          bestResult = { body, list, total, payloadMeta: debug ? buildPayloadMeta(payload) : null };
        }
        if (list.length > 0) {
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!bestResult && lastError) throw lastError;
    if (!bestResult) {
      return {
        pageNo,
        pageSize,
        total: 0,
        list: [],
        requestBody: {}
      };
    }
    return {
      pageNo,
      pageSize,
      total: bestResult.total,
      list: bestResult.list,
      requestBody: bestResult.body,
      ...(debug ? { payloadMeta: bestResult.payloadMeta } : {})
    };
  }

  async getStatusCount(options = {}) {
    const payload = await this.client._request('POST', TICKET_STATUS_COUNT_URL, {}, {}, options);
    const list = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    return { list, payload };
  }

  async getDetail(params = {}, options = {}) {
    const client = this.client;
    const instanceId = String(pickValue(params, [
      'instanceId',
      'instance_id',
      'detailRequestId',
      'detail_request_id',
      'ticketNo',
      'ticket_no',
      'todoId',
      'todo_id',
      'workOrderId',
      'work_order_id',
      'workOrderSn',
      'work_order_sn',
      'ticketId',
      'ticket_id',
      'ticketSn',
      'ticket_sn',
      'taskId',
      'task_id',
      'id'
    ], '') || '').trim();
    if (!instanceId) {
      throw new Error('缺少工单实例 ID，无法加载工单详情');
    }
    const bodies = buildDetailBodies(client, { ...params, instanceId });
    let bestResult = null;
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await client._request('POST', TICKET_DETAIL_URL, body, {}, options);
        const detail = extractDetailFromPayload(payload);
        if (detail) {
          bestResult = { body, detail };
          break;
        }
        if (!bestResult) {
          bestResult = { body, detail: null };
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!bestResult && lastError) throw lastError;
    return {
      instanceId,
      detail: bestResult?.detail || null,
      requestBody: bestResult?.body || { instanceId }
    };
  }
}

module.exports = {
  TicketListModule,
  TICKET_LIST_URL,
  TICKET_DETAIL_URL,
  TICKET_STATUS_COUNT_URL,
};
