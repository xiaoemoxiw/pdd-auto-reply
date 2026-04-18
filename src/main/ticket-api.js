const {
  normalizePddUserAgent,
  applyIdentityHeaders,
} = require('./pdd-request-profile');
const { PddBusinessApiClient } = require('./pdd-business-api-client');

const PDD_BASE = 'https://mms.pinduoduo.com';
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;
const DEFAULT_TICKET_URL = `${PDD_BASE}/aftersales/work_order/list?msfrom=mms_sidenav`;
const TICKET_LIST_URL = '/strickland/sop/mms/todoList';
const TICKET_DETAIL_URL = '/strickland/sop/mms/detail';
const TICKET_STATUS_COUNT_URL = '/strickland/sop/mms/statusCount';

// 售后单(退款单) API 常量
const REFUND_LIST_URL = '/mercury/mms/afterSales/queryList';
const REFUND_COUNT_URL = '/mercury/mms/afterSales/queryCount';
const REFUND_GROUP_COUNT_URL = '/mercury/mms/afterSales/queryGroupCount';
const AGREE_REFUND_PRECHECK_URL = '/mercury/mms/afterSales/agreeRefundPreCheck';
const REJECT_REFUND_PRECHECK_URL = '/mercury/mms/afterSales/rejectRefundPreCheck';
const REJECT_REFUND_GET_FORM_INFO_URL = '/mercury/mms/afterSales/rejectRefundGetFormInfo';
const REJECT_REFUND_SUBMIT_FORM_DATA_URL = '/mercury/mms/afterSales/rejectRefundSubmitFormData';
const REJECT_REFUND_NEGOTIATE_INFO_URL = '/mercury/negotiate/mms/afterSales/getRejectNegotiateInfo';
const REJECT_REFUND_REASONS_URL = '/mercury/mms/afterSales/rejectRefundReasons';
const REJECT_REFUND_VALIDATE_URL = '/mercury/mms/afterSales/rejectRefund/validate';
const MERCHANT_AFTERSALES_REFUSE_URL = '/mercury/merchant/afterSales/refuse';
const REGION_GET_URL = '/latitude/order/region/get';
const SHIPPING_COMPANY_LIST_URL = '/express_base/shipping_list/mms';

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

class TicketApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    const getTicketUrl = options.getTicketUrl || (() => DEFAULT_TICKET_URL);
    super(shopId, {
      ...options,
      getRefererUrl: getTicketUrl,
      errorLabel: '工单管理接口',
      loginExpiredMessage: '工单管理页面登录已失效，请重新导入 Token 或刷新登录态'
    });
    this._getTicketUrl = getTicketUrl;
    this._requestInPddPage = typeof options.requestInPddPage === 'function' ? options.requestInPddPage : null;
    this._regionCache = new Map();
    this._shippingCompanyCache = null;
    this._shippingCompanyCacheAt = 0;
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

  async _buildHeaders(urlPart, extraHeaders = {}) {
    const trafficHeaders = this._findLatestTraffic(urlPart)?.requestHeaders || {};
    const referer = pickHeaderCaseInsensitive(trafficHeaders, ['referer', 'Referer']);
    const antiContent = pickHeaderCaseInsensitive(trafficHeaders, ['anti-content', 'anti_content', 'Anti-Content']);
    const csrfToken = pickHeaderCaseInsensitive(trafficHeaders, ['x-csrf-token', 'x-csrftoken', 'x-csrf', 'X-CSRF-Token']);
    const requestedWith = pickHeaderCaseInsensitive(trafficHeaders, ['x-requested-with', 'X-Requested-With']);
    const headers = await super._buildHeaders(urlPart, {
      Referer: referer || this._getTicketUrl() || DEFAULT_TICKET_URL,
      ...extraHeaders
    });
    if (antiContent) headers['anti-content'] = antiContent;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    if (requestedWith) headers['x-requested-with'] = requestedWith;
    return headers;
  }

  async _request(method, urlPath, body, extraHeaders = {}, requestOptions = {}) {
    const source = String(requestOptions?.source || 'ticket-api').trim() || 'ticket-api';
    const allowPageRequest = requestOptions.allowPageRequest !== false;
    const shouldTryPageRequest = allowPageRequest && !!this._requestInPddPage && (
      urlPath === TICKET_LIST_URL
      || urlPath === TICKET_STATUS_COUNT_URL
      || urlPath === TICKET_DETAIL_URL
      || urlPath === REFUND_LIST_URL
      || urlPath === REFUND_COUNT_URL
      || urlPath === REFUND_GROUP_COUNT_URL
      || urlPath.startsWith('/antis/api/refundAddress/')
      || urlPath.startsWith('/mercury/mms/afterSales/')
      || urlPath.startsWith('/mercury/after_sales/')
      || urlPath.startsWith(REGION_GET_URL)
      || urlPath.startsWith('/express_base/')
      || urlPath.startsWith('/express_wbfrontend/')
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
        const ua = normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || '');
        if (ua) baseHeaders['user-agent'] = ua;
        applyIdentityHeaders(baseHeaders, tokenInfo);
        const payload = await this._requestInPddPage({
          url,
          method,
          source,
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
        this._log(`[工单管理接口] PAGE ${method} ${urlPath} -> ${error?.message || 'FAILED'}`, { source });
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
    this._log(`[工单管理接口] ${method} ${urlPath} -> ${response.status}`, { source });
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

  async getRefundList(params = {}, options = {}) {
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
    
    const payload = await this._request('POST', REFUND_LIST_URL, body, {}, options);
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

  async getRefundCount(params = {}, options = {}) {
    const payload = await this._request('POST', REFUND_COUNT_URL, params, {}, options);
    const counts = isPlainObject(payload?.result) ? payload.result : {};
    return { counts, payload };
  }

  async getRefundGroupCount(params = {}) {
    const payload = await this._request('POST', REFUND_GROUP_COUNT_URL, params);
    const counts = isPlainObject(payload?.result) ? payload.result : {};
    return { counts, payload };
  }

  async listRefundAddresses(params = {}, options = {}) {
    const payload = await this._request('POST', '/antis/api/refundAddress/list', params || {}, {}, options);
    const list = Array.isArray(payload?.result) ? payload.result : [];
    return { list, payload };
  }

  async approveReturnGoods(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法同意退货');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法同意退货');

    const versionRaw = pickValue(params, ['version'], '');
    const version = Number(versionRaw || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法同意退货');

    const receiver = String(pickValue(params, ['receiver', 'receiverName', 'receiver_name', 'receiverName'], '') || '').trim();
    if (!receiver) throw new Error('缺少收件人，无法同意退货');

    const receiverPhone = String(pickValue(params, ['receiverPhone', 'receiver_phone', 'phone', 'mobile', 'tel'], '') || '').trim();
    if (!receiverPhone) throw new Error('缺少联系电话，无法同意退货');

    const provinceId = Number(pickValue(params, ['provinceId', 'province_id'], 0));
    const cityId = Number(pickValue(params, ['cityId', 'city_id'], 0));
    const districtId = Number(pickValue(params, ['districtId', 'district_id'], 0));
    if (!Number.isFinite(provinceId) || !Number.isFinite(cityId) || !Number.isFinite(districtId) || provinceId <= 0 || cityId <= 0 || districtId <= 0) {
      throw new Error('缺少省市区信息，无法同意退货');
    }

    const provinceName = String(pickValue(params, ['provinceName', 'province_name'], '') || '').trim();
    const cityName = String(pickValue(params, ['cityName', 'city_name'], '') || '').trim();
    const districtName = String(pickValue(params, ['districtName', 'district_name'], '') || '').trim();
    if (!provinceName || !cityName || !districtName) throw new Error('缺少省市区名称，无法同意退货');

    const refundAddress = String(pickValue(params, ['refundAddress', 'refund_address', 'detailAddress', 'detail_address'], '') || '').trim();
    if (!refundAddress) throw new Error('缺少详细地址，无法同意退货');

    const receiverAddress = String(pickValue(params, ['receiverAddress', 'receiver_address'], '') || '').trim()
      || `${provinceName}${cityName}${districtName}${refundAddress}`;

    const operateDesc = String(pickValue(params, ['operateDesc', 'operate_desc', 'message', 'remark', 'memo'], '') || '').trim();
    if (!operateDesc) throw new Error('缺少留言，无法同意退货');

    const checkUrlPath = '/mercury/after_sales/check_address_valid_and_return_address';
    const checkTemplate = this._getTrafficRequestBody(checkUrlPath);
    const checkBody = isPlainObject(checkTemplate) ? JSON.parse(JSON.stringify(checkTemplate)) : {};
    checkBody.receiverName = receiver;
    checkBody.provinceId = provinceId;
    checkBody.provinceName = provinceName;
    checkBody.cityId = cityId;
    checkBody.cityName = cityName;
    checkBody.districtId = districtId;
    checkBody.districtName = districtName;
    checkBody.refundAddress = refundAddress;
    checkBody.orderSn = orderSn;
    checkBody.id = id;
    const checkPayload = await this._request('POST', checkUrlPath, checkBody, {}, options);
    const checkResult = checkPayload?.result;
    if (checkResult && typeof checkResult === 'object') {
      if (checkResult.refundAddressValid === false) throw new Error('退货地址校验失败');
      if (checkResult.isBadAddress === true) throw new Error('退货地址疑似异常，请检查');
      if (checkResult.isBadReceiver === true) throw new Error('收件人信息疑似异常，请检查');
    }

    const urlPath = '/mercury/mms/afterSales/agreeReturn';
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};
    body.provinceId = provinceId;
    body.provinceName = provinceName;
    body.cityId = cityId;
    body.cityName = cityName;
    body.districtId = districtId;
    body.districtName = districtName;
    body.version = version;
    body.receiver = receiver;
    body.orderSn = orderSn;
    body.receiverPhone = receiverPhone;
    body.receiverAddress = receiverAddress;
    body.refundAddress = refundAddress;
    body.operateDesc = operateDesc;
    body.id = id;
    if (!('addressType' in body)) body.addressType = 1;
    if (!('confirmWeakRemind' in body)) body.confirmWeakRemind = null;

    const payload = await this._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async approveResend(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法同意补寄');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法同意补寄');

    const versionRaw = pickValue(params, ['version'], '');
    const version = Number(versionRaw || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法同意补寄');

    const frontActionRaw = pickValue(params, ['frontAction', 'front_action', 'action'], 1017);
    const frontAction = Number(frontActionRaw || 0);
    if (!Number.isFinite(frontAction) || frontAction <= 0) throw new Error('缺少操作类型，无法同意补寄');

    const urlPath = '/mercury/after_sales/agree_resend';
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();

    body.id = id;
    body.orderSn = orderSn;
    body.version = version;
    body.frontAction = frontAction;
    if (!('uid' in body)) body.uid = null;
    if (!('mallId' in body)) body.mallId = shop?.mallId || tokenInfo?.mallId || '';

    const payload = await this._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async agreeRefundPreCheck(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法进行同意退款预检查');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法进行同意退款预检查');

    const urlPath = AGREE_REFUND_PRECHECK_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    const itemBase = Array.isArray(body?.items) && isPlainObject(body.items[0]) ? { ...body.items[0] } : {};
    itemBase.afterSalesId = id;
    itemBase.orderSn = orderSn;
    if (!('uid' in itemBase)) itemBase.uid = null;
    body.items = [itemBase];

    const payload = await this._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, result, payload };
  }

  async rejectRefundPreCheck(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法进行驳回退款预检查');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法进行驳回退款预检查');

    const versionRaw = pickValue(params, ['version'], '');
    const version = Number(versionRaw || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法进行驳回退款预检查');

    const invokeTypeRaw = pickValue(params, ['invokeType', 'invoke_type'], 0);
    const invokeType = Number(invokeTypeRaw || 0);
    const urlPath = REJECT_REFUND_PRECHECK_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.version = version;
    body.invokeType = Number.isFinite(invokeType) ? invokeType : 0;

    const payload = await this._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, version, result, payload };
  }

  async rejectRefundGetFormInfo(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id', 'bizId', 'biz_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法获取驳回退款表单');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法获取驳回退款表单');

    const bizTypeRaw = pickValue(params, ['bizType', 'biz_type'], 2);
    const bizType = Number(bizTypeRaw || 0);
    const urlPath = REJECT_REFUND_GET_FORM_INFO_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.bizType = Number.isFinite(bizType) && bizType > 0 ? bizType : 2;
    body.bizId = String(pickValue(params, ['bizId', 'biz_id'], String(id)) || String(id)).trim() || String(id);
    body.orderSn = orderSn;
    body.afterSalesId = id;

    const payload = await this._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, result, payload };
  }

  async getRejectRefundNegotiateInfo(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法获取驳回退款协商信息');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法获取驳回退款协商信息');

    const key = String(pickValue(params, ['key'], 'ProMultiSolution') || 'ProMultiSolution').trim() || 'ProMultiSolution';
    const urlPath = REJECT_REFUND_NEGOTIATE_INFO_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.key = key;

    const payload = await this._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, result, payload };
  }

  async rejectRefundSubmit(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id', 'bizId', 'biz_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法提交驳回退款');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法提交驳回退款');

    const formName = String(pickValue(params, ['formName', 'form_name'], '') || '').trim();
    if (!formName) throw new Error('缺少表单名，无法提交驳回退款');

    const formDataList = Array.isArray(params?.formDataList) ? params.formDataList : [];
    if (!formDataList.length) throw new Error('缺少表单内容，无法提交驳回退款');

    const bizTypeRaw = pickValue(params, ['bizType', 'biz_type'], 10);
    const bizType = Number(bizTypeRaw || 0);
    const urlPath = REJECT_REFUND_SUBMIT_FORM_DATA_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.formName = formName;
    body.formDataList = formDataList;
    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.bizType = Number.isFinite(bizType) && bizType > 0 ? bizType : 10;
    body.bizId = String(pickValue(params, ['bizId', 'biz_id'], String(id)) || String(id)).trim() || String(id);

    const payload = await this._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async rejectRefundGetReasons(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法获取驳回原因');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法获取驳回原因');

    const urlPath = REJECT_REFUND_REASONS_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.uid = params?.uid ?? body.uid ?? null;

    if (params.rejectPopupWindowType !== undefined) {
      const rejectPopupWindowType = Number(params.rejectPopupWindowType || 0);
      if (Number.isFinite(rejectPopupWindowType) && rejectPopupWindowType > 0) {
        body.rejectPopupWindowType = rejectPopupWindowType;
      }
    }
    if (params.withHandlingSuggestion !== undefined) {
      body.withHandlingSuggestion = !!params.withHandlingSuggestion;
    }
    if (params.withRejectRequirements !== undefined) {
      body.withRejectRequirements = !!params.withRejectRequirements;
    }
    if (params.rejectReasonCode !== undefined && params.rejectReasonCode !== null && params.rejectReasonCode !== '') {
      const rejectReasonCode = Number(params.rejectReasonCode || 0);
      if (Number.isFinite(rejectReasonCode) && rejectReasonCode > 0) {
        body.rejectReasonCode = rejectReasonCode;
      }
    }

    const payload = await this._request('POST', urlPath, body, {}, options);
    const result = Array.isArray(payload?.result) ? payload.result : [];
    return { ok: true, id, orderSn, result, payload };
  }

  async rejectRefundValidate(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法校验第三次驳回');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法校验第三次驳回');

    const version = Number(pickValue(params, ['version'], 0) || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法校验第三次驳回');

    const reason = String(pickValue(params, ['reason'], '') || '').trim();
    if (!reason) throw new Error('缺少驳回原因文案，无法校验第三次驳回');

    const operateDesc = String(pickValue(params, ['operateDesc', 'operate_desc'], '') || '').trim();
    if (!operateDesc) throw new Error('缺少补充说明，无法校验第三次驳回');

    const rejectReasonCode = Number(pickValue(params, ['rejectReasonCode', 'reject_reason_code'], 0) || 0);
    if (!Number.isFinite(rejectReasonCode) || rejectReasonCode <= 0) throw new Error('缺少驳回原因编码，无法校验第三次驳回');

    const urlPath = REJECT_REFUND_VALIDATE_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.reason = reason;
    body.operateDesc = operateDesc;
    body.images = Array.isArray(params?.images) ? params.images : [];
    body.shipImages = Array.isArray(params?.shipImages) ? params.shipImages : [];
    body.consumerReason = String(pickValue(params, ['consumerReason', 'consumer_reason'], '') || '');
    body.requiredRejectDescs = Array.isArray(params?.requiredRejectDescs) ? params.requiredRejectDescs : [];
    body.rejectReasonCode = rejectReasonCode;
    body.id = id;
    body.mallId = params?.mallId ?? body.mallId ?? null;
    body.version = version;
    body.orderSn = orderSn;
    body.requiredProofs = Array.isArray(params?.requiredProofs) ? params.requiredProofs : [];

    const payload = await this._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async merchantAfterSalesRefuse(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法提交第三次驳回');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法提交第三次驳回');

    const version = Number(pickValue(params, ['version'], 0) || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法提交第三次驳回');

    const reason = String(pickValue(params, ['reason'], '') || '').trim();
    if (!reason) throw new Error('缺少驳回原因文案，无法提交第三次驳回');

    const operateDesc = String(pickValue(params, ['operateDesc', 'operate_desc'], '') || '').trim();
    if (!operateDesc) throw new Error('缺少补充说明，无法提交第三次驳回');

    const rejectReasonCode = Number(pickValue(params, ['rejectReasonCode', 'reject_reason_code'], 0) || 0);
    if (!Number.isFinite(rejectReasonCode) || rejectReasonCode <= 0) throw new Error('缺少驳回原因编码，无法提交第三次驳回');

    const urlPath = MERCHANT_AFTERSALES_REFUSE_URL;
    const template = this._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.reason = reason;
    body.operateDesc = operateDesc;
    body.images = Array.isArray(params?.images) ? params.images : [];
    body.shipImages = Array.isArray(params?.shipImages) ? params.shipImages : [];
    body.consumerReason = String(pickValue(params, ['consumerReason', 'consumer_reason'], '') || '');
    body.requiredRejectDescs = Array.isArray(params?.requiredRejectDescs) ? params.requiredRejectDescs : [];
    body.rejectReasonCode = rejectReasonCode;
    body.id = id;
    body.mallId = params?.mallId ?? body.mallId ?? null;
    body.version = version;
    body.orderSn = orderSn;
    body.requiredProofs = Array.isArray(params?.requiredProofs) ? params.requiredProofs : [];

    const payload = await this._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  // ====== 以下为原有工单(客服处理) API (Strickland) ======

  async getList(params = {}, options = {}) {
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
        const payload = await this._request('POST', TICKET_LIST_URL, body, {}, options);
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

  async getStatusCount(options = {}) {
    const payload = await this._request('POST', TICKET_STATUS_COUNT_URL, {}, {}, options);
    const list = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    return { list, payload };
  }

  async getRegionChildren(params = {}, options = {}) {
    const parentIdRaw = pickValue(params, ['parentId', 'parent_id', 'pid', 'parent'], '0');
    const parentId = String(parentIdRaw ?? '').trim() || '0';
    if (parentId !== '0' && !/^\d+$/.test(parentId)) {
      throw new Error('地区ID异常，请重新选择省市区');
    }
    const cacheKey = parentId;
    if (this._regionCache.has(cacheKey)) {
      return { list: this._regionCache.get(cacheKey) || [] };
    }
    const query = new URLSearchParams();
    query.set('parent_id', parentId);
    const urlPath = `${REGION_GET_URL}?${query.toString()}`;
    const payload = await this._request('GET', urlPath, null, {}, options);
    const rawList = extractArrayFromPayload(payload);
    const list = rawList.map(normalizeRegionItem).filter(Boolean);
    this._regionCache.set(cacheKey, list);
    return { list, payload };
  }

  async getShippingCompanyList(params = {}, options = {}) {
    const ttlMs = Math.max(0, Number(params?.ttlMs || params?.ttl_ms || 0));
    const now = Date.now();
    const ttl = ttlMs > 0 ? ttlMs : 6 * 60 * 60 * 1000;
    if (this._shippingCompanyCache && (now - this._shippingCompanyCacheAt < ttl)) {
      return { list: this._shippingCompanyCache.slice(0) };
    }

    const payload = await this._request('GET', SHIPPING_COMPANY_LIST_URL, null, {}, options);
    let rawList = extractArrayFromPayload(payload);
    if (!rawList.length && isPlainObject(payload?.result)) {
      rawList = extractArrayFromPayload(payload.result);
    }
    if (!rawList.length && isPlainObject(payload?.data)) {
      rawList = extractArrayFromPayload(payload.data);
    }
    if (!rawList.length && isPlainObject(payload?.result?.data)) {
      rawList = extractArrayFromPayload(payload.result.data);
    }

    const normalizeItem = (item) => {
      if (!item || typeof item !== 'object') return null;
      const id = pickValue(item, [
        'id',
        'shipId',
        'ship_id',
        'shippingId',
        'shipping_id',
        'companyId',
        'company_id',
        'code',
        'shipCode',
        'ship_code',
        'shippingCode',
        'shipping_code'
      ], '');
      const name = pickValue(item, [
        'name',
        'shipName',
        'ship_name',
        'shippingName',
        'shipping_name',
        'companyName',
        'company_name',
        'displayName',
        'display_name'
      ], '');
      const value = String(id || name || '').trim();
      const label = String(name || id || '').trim();
      if (!value || !label) return null;
      return { id: value, name: label };
    };

    const list = rawList.map(normalizeItem).filter(Boolean);
    list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    this._shippingCompanyCache = list;
    this._shippingCompanyCacheAt = now;
    return { list, payload };
  }

  async getChatShippingDetail(params = {}, options = {}) {
    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号');
    const queryTypeRaw = Number(pickValue(params, ['queryType', 'query_type'], 1));
    const queryType = Number.isFinite(queryTypeRaw) ? String(queryTypeRaw) : '1';
    const client = String(pickValue(params, ['client'], 'web') || '').trim() || 'web';
    const query = new URLSearchParams();
    query.set('order_sn', orderSn);
    query.set('query_type', queryType);
    query.set('client', client);
    const urlPath = `/chats/shippingDetail?${query.toString()}`;
    const payload = await this._request('GET', urlPath, null, { Referer: CHAT_URL }, options);
    return { payload, result: payload?.result ?? null };
  }

  async getDetail(params = {}, options = {}) {
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
        const payload = await this._request('POST', TICKET_DETAIL_URL, body, {}, options);
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
