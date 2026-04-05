const { session } = require('electron');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_TICKET_URL = `${PDD_BASE}/aftersales/work_order/list?msfrom=mms_sidenav`;
const TICKET_LIST_URL = '/strickland/sop/mms/todoList';
const TICKET_DETAIL_URL = '/strickland/sop/mms/detail';

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

class TicketApiClient {
  constructor(shopId, options = {}) {
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._getTicketUrl = options.getTicketUrl || (() => DEFAULT_TICKET_URL);
  }

  _log(message, extra) {
    this._onLog(message, extra);
  }

  _getSession() {
    return session.fromPartition(this.partition);
  }

  _getTokenInfo() {
    return (global.__pddTokens && global.__pddTokens[this.shopId]) || null;
  }

  _getApiTrafficEntries() {
    const list = this._getApiTraffic();
    return Array.isArray(list) ? list : [];
  }

  _findLatestTraffic(urlPart) {
    const list = this._getApiTrafficEntries();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (String(list[i]?.url || '').includes(urlPart)) {
        return list[i];
      }
    }
    return null;
  }

  _getTrafficRequestBody(urlPart) {
    const requestBody = this._findLatestTraffic(urlPart)?.requestBody;
    if (isPlainObject(requestBody)) return { ...requestBody };
    const parsed = parseJsonSafely(requestBody);
    return isPlainObject(parsed) ? parsed : null;
  }

  async _getCookieString() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  async _getCookieMap() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.reduce((acc, item) => {
      acc[item.name] = item.value;
      return acc;
    }, {});
  }

  async _buildHeaders(urlPart, extraHeaders = {}) {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    const cookie = await this._getCookieString();
    const cookieMap = await this._getCookieMap();
    const trafficHeaders = this._findLatestTraffic(urlPart)?.requestHeaders || {};
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      Referer: trafficHeaders.Referer || this._getTicketUrl() || DEFAULT_TICKET_URL,
      Origin: PDD_BASE,
      ...extraHeaders,
    };
    if (cookie) headers.cookie = cookie;
    headers['user-agent'] = (shop?.userAgent || tokenInfo?.userAgent || '').replace('pdd_webview', '').trim();
    if (tokenInfo?.raw) {
      headers['X-PDD-Token'] = tokenInfo.raw;
      headers['windows-app-shop-token'] = tokenInfo.raw;
    }
    if (tokenInfo?.pddid) headers.pddid = tokenInfo.pddid;
    if (cookieMap.rckk) headers.etag = cookieMap.rckk;
    if (cookieMap['msfe-pc-cookie-captcha-token']) {
      headers.VerifyAuthToken = cookieMap['msfe-pc-cookie-captcha-token'];
    }
    return headers;
  }

  _parsePayload(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  _normalizeBusinessError(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const success = payload.success;
    const errorCode = Number(payload.error_code ?? payload.errorCode ?? payload.code ?? 0);
    if (success === false || (errorCode && errorCode !== 1000000)) {
      return {
        code: errorCode,
        message: payload.error_msg || payload.errorMsg || payload.message || '工单管理接口失败',
      };
    }
    return null;
  }

  _isLoginPageResponse(response, text) {
    const finalUrl = String(response?.url || '');
    if (finalUrl.includes('/login')) return true;
    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return false;
    const snippet = typeof text === 'string' ? text.slice(0, 800).toLowerCase() : '';
    return snippet.includes('登录') || snippet.includes('login') || snippet.includes('passport') || snippet.includes('扫码');
  }

  async _request(method, urlPath, body, extraHeaders = {}) {
    const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
    const headers = await this._buildHeaders(urlPath, extraHeaders);
    const options = { method, headers };
    if (body !== undefined && body !== null) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await this._getSession().fetch(url, options);
    const text = await response.text();
    const payload = this._parsePayload(text);
    this._log(`[工单管理接口] ${method} ${urlPath} -> ${response.status}`);
    if (this._isLoginPageResponse(response, text)) {
      throw new Error('工单管理页面登录已失效，请重新导入 Token 或刷新登录态');
    }
    if (!response.ok) {
      throw new Error(typeof payload === 'object'
        ? payload?.error_msg || payload?.errorMsg || payload?.message || `HTTP ${response.status}`
        : `HTTP ${response.status}: ${String(text).slice(0, 200)}`);
    }
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message);
    }
    return payload;
  }

  _looksLikeTicketRecord(item) {
    if (!isPlainObject(item)) return false;
    return [
      'instanceId',
      'orderSn',
      'problemTitle',
      'goodsName',
      'status',
      'externalDisplayName',
      'ticketId',
      'workOrderId',
      'workOrderSn'
    ].some(key => key in item);
  }

  _looksLikeTicketDetail(item) {
    if (!isPlainObject(item)) return false;
    return [
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
    ].some(key => key in item);
  }

  _extractListFromPayload(payload, visited = new Set()) {
    if (!payload || typeof payload !== 'object') return [];
    if (visited.has(payload)) return [];
    visited.add(payload);
    if (Array.isArray(payload)) {
      if (!payload.length) return [];
      if (payload.some(item => this._looksLikeTicketRecord(item))) {
        return payload.filter(item => this._looksLikeTicketRecord(item));
      }
      for (const item of payload) {
        const nested = this._extractListFromPayload(item, visited);
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
      if (Array.isArray(candidate) && candidate.some(item => this._looksLikeTicketRecord(item))) {
        return candidate.filter(item => this._looksLikeTicketRecord(item));
      }
    }
    for (const value of Object.values(payload)) {
      const nested = this._extractListFromPayload(value, visited);
      if (nested.length) return nested;
    }
    return [];
  }

  _extractTotalFromPayload(payload, fallbackTotal = 0) {
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

  _extractDetailFromPayload(payload, visited = new Set()) {
    if (!payload || typeof payload !== 'object') return null;
    if (visited.has(payload)) return null;
    visited.add(payload);
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const nested = this._extractDetailFromPayload(item, visited);
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
      if (this._looksLikeTicketDetail(candidate) || this._looksLikeTicketRecord(candidate)) {
        return candidate;
      }
    }
    for (const value of Object.values(payload)) {
      const nested = this._extractDetailFromPayload(value, visited);
      if (nested) return nested;
    }
    return null;
  }

  _buildListBodies(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const trafficBody = this._getTrafficRequestBody(TICKET_LIST_URL);
    const bodies = [];
    if (trafficBody) {
      const nextBody = { ...trafficBody };
      ['pageNo', 'page_no', 'pageNum', 'page_num', 'page', 'currentPage'].forEach(key => {
        if (key in nextBody) nextBody[key] = pageNo;
      });
      ['pageSize', 'page_size', 'size', 'limit'].forEach(key => {
        if (key in nextBody) nextBody[key] = pageSize;
      });
      bodies.push(nextBody);
    }
    bodies.push(
      {},
      { pageNo, pageSize },
      { pageNum: pageNo, pageSize },
      { page_no: pageNo, page_size: pageSize },
      { page: pageNo, size: pageSize }
    );
    return dedupeBodies(bodies.filter(item => isPlainObject(item)));
  }

  _buildDetailBodies(params = {}) {
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
    const trafficBody = this._getTrafficRequestBody(TICKET_DETAIL_URL);
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

  async getList(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const bodies = this._buildListBodies({ ...params, pageNo, pageSize });
    let bestResult = null;
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await this._request('POST', TICKET_LIST_URL, body);
        const list = this._extractListFromPayload(payload);
        const total = this._extractTotalFromPayload(payload, list.length);
        if (!bestResult || list.length > bestResult.list.length) {
          bestResult = { body, list, total };
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
      requestBody: bestResult.body
    };
  }

  async getDetail(params = {}) {
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
    const bodies = this._buildDetailBodies({ ...params, instanceId });
    let bestResult = null;
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await this._request('POST', TICKET_DETAIL_URL, body);
        const detail = this._extractDetailFromPayload(payload);
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

module.exports = { TicketApiClient };
