const { session } = require('electron');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_TICKET_URL = `${PDD_BASE}/aftersales/work_order/list?msfrom=mms_sidenav`;
const TICKET_LIST_URL = '/strickland/sop/mms/todoList';
const TICKET_DETAIL_URL = '/strickland/sop/mms/detail';
const TICKET_STATUS_COUNT_URL = '/strickland/sop/mms/statusCount';

// 售后单(退款单) API 常量
const REFUND_LIST_URL = '/mercury/mms/afterSales/queryList';
const REFUND_COUNT_URL = '/mercury/mms/afterSales/queryCount';
const REFUND_GROUP_COUNT_URL = '/mercury/mms/afterSales/queryGroupCount';

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

class TicketApiClient {
  constructor(shopId, options = {}) {
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._getTicketUrl = options.getTicketUrl || (() => DEFAULT_TICKET_URL);
    this._requestInPddPage = typeof options.requestInPddPage === 'function' ? options.requestInPddPage : null;
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

  _findLatestTraffic(urlPart, predicate) {
    const list = this._getApiTrafficEntries();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (!String(item?.url || '').includes(urlPart)) continue;
      if (typeof predicate === 'function' && !predicate(item)) continue;
      return item;
    }
    return null;
  }

  _getTrafficRequestBody(urlPart, predicate) {
    const requestBody = this._findLatestTraffic(urlPart, predicate)?.requestBody;
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
    const referer = pickHeaderCaseInsensitive(trafficHeaders, ['referer', 'Referer']);
    const antiContent = pickHeaderCaseInsensitive(trafficHeaders, ['anti-content', 'anti_content', 'Anti-Content']);
    const csrfToken = pickHeaderCaseInsensitive(trafficHeaders, ['x-csrf-token', 'x-csrftoken', 'x-csrf', 'X-CSRF-Token']);
    const requestedWith = pickHeaderCaseInsensitive(trafficHeaders, ['x-requested-with', 'X-Requested-With']);
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
      Referer: referer || this._getTicketUrl() || DEFAULT_TICKET_URL,
      Origin: PDD_BASE,
      ...extraHeaders,
    };
    if (cookie) headers.cookie = cookie;
    headers['user-agent'] = (shop?.userAgent || tokenInfo?.userAgent || '').replace('pdd_webview', '').trim();
    if (antiContent) headers['anti-content'] = antiContent;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    if (requestedWith) headers['x-requested-with'] = requestedWith;
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
    const shouldTryPageRequest = !!this._requestInPddPage && (
      urlPath === TICKET_LIST_URL
      || urlPath === TICKET_STATUS_COUNT_URL
      || urlPath === TICKET_DETAIL_URL
      || urlPath === REFUND_LIST_URL
      || urlPath === REFUND_COUNT_URL
      || urlPath === REFUND_GROUP_COUNT_URL
    );
    if (shouldTryPageRequest) {
      try {
        const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
        const tokenInfo = this._getTokenInfo();
        const shop = this._getShopInfo();
        const baseHeaders = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
        };
        const ua = (shop?.userAgent || tokenInfo?.userAgent || '').replace('pdd_webview', '').trim();
        if (ua) baseHeaders['user-agent'] = ua;
        if (tokenInfo?.raw) {
          baseHeaders['X-PDD-Token'] = tokenInfo.raw;
          baseHeaders['windows-app-shop-token'] = tokenInfo.raw;
        }
        if (tokenInfo?.pddid) baseHeaders.pddid = tokenInfo.pddid;
        const payload = await this._requestInPddPage({
          url,
          method,
          headers: { ...baseHeaders, ...extraHeaders },
          body: body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
        });
        if (typeof payload === 'string') {
          const snippet = payload.slice(0, 800).toLowerCase();
          if (snippet.includes('<html') || snippet.includes('登录') || snippet.includes('passport') || snippet.includes('扫码')) {
            throw new Error('工单管理页面登录已失效，请重新导入 Token 或刷新登录态');
          }
        }
        const businessError = this._normalizeBusinessError(payload);
        if (businessError) {
          throw new Error(businessError.message);
        }
        return payload;
      } catch (error) {
        this._log(`[工单管理接口] PAGE ${method} ${urlPath} -> ${error?.message || 'FAILED'}`);
      }
    }
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
      if (payload.some(item => isPlainObject(item))) {
        return payload.filter(item => isPlainObject(item));
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
      if (Array.isArray(candidate) && candidate.some(item => isPlainObject(item))) {
        return candidate.filter(item => isPlainObject(item));
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
    const forwardedFields = isPlainObject(params.forwardedFields) ? params.forwardedFields : {};
    const templateBody = isPlainObject(params.templateBody) ? params.templateBody : null;
    const trafficBody = this._getTrafficRequestBody(TICKET_LIST_URL);

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

  // ====== 售后(退款)单 API (Mercury) ====== 

  async getRefundList(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || params.pageNumber || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 10));
    
    // 构造 mercury 请求体
    const body = {
      pageNumber: pageNo,
      pageSize,
      ...params,
    };
    // 清理掉不需要的兼容字段
    ['pageNo', 'page_no', 'page_size', 'debug', 'templateKey'].forEach(k => delete body[k]);
    
    const payload = await this._request('POST', REFUND_LIST_URL, body);
    const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
    const total = payload?.result?.total || 0;
    
    return {
      pageNo,
      pageSize,
      total,
      list,
      requestBody: body,
      ...(params.debug ? { payloadMeta: buildPayloadMeta(payload) } : {})
    };
  }

  async getRefundCount(params = {}) {
    const payload = await this._request('POST', REFUND_COUNT_URL, params);
    const counts = isPlainObject(payload?.result) ? payload.result : {};
    return { counts, payload };
  }

  async getRefundGroupCount(params = {}) {
    const payload = await this._request('POST', REFUND_GROUP_COUNT_URL, params);
    const counts = isPlainObject(payload?.result) ? payload.result : {};
    return { counts, payload };
  }

  // ====== 以下为原有工单(客服处理) API (Strickland) ======

  async getList(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const templateKey = normalizeTemplateKey(params.templateKey || params.template_key);
    const captureAs = normalizeTemplateKey(params.captureAs || params.capture_as);
    const debug = params?.debug === true;

    const templates = getShopListTemplates(this.shopId);
    if (captureAs) {
      const latestTraffic = this._getTrafficRequestBody(TICKET_LIST_URL);
      if (latestTraffic) templates[captureAs] = latestTraffic;
    }

    let templateBody = templateKey ? templates[templateKey] : null;
    if (!templateBody && templateKey) {
      const latestTraffic = this._getTrafficRequestBody(TICKET_LIST_URL);
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

    const bodies = this._buildListBodies({
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
        const payload = await this._request('POST', TICKET_LIST_URL, body);
        const list = this._extractListFromPayload(payload);
        const total = this._extractTotalFromPayload(payload, list.length);
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

  async getStatusCount() {
    const payload = await this._request('POST', TICKET_STATUS_COUNT_URL, {});
    const list = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    return { list, payload };
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
