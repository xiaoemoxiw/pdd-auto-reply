const { session } = require('electron');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_VIOLATION_URL = `${PDD_BASE}/pg/violation_list/mall_manage?msfrom=mms_sidenav`;
const VIOLATION_TYPE_URL = '/genji/gosling/mallViolationAppeal/query/queryViolationType';
const VIOLATION_RECORD_URL = '/genji/gosling/mallViolationAppeal/query/queryAppealRecord';
const VIOLATION_RECORD_DETAIL_URL = '/genji/gosling/mallViolationAppeal/query/queryAppealRecordDetail';

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

class ViolationApiClient {
  constructor(shopId, options = {}) {
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._getViolationUrl = options.getViolationUrl || (() => DEFAULT_VIOLATION_URL);
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
    for (let i = list.length - 1; i >= 0; i--) {
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
      Referer: trafficHeaders.Referer || this._getViolationUrl() || DEFAULT_VIOLATION_URL,
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
        message: payload.error_msg || payload.errorMsg || payload.message || '违规管理接口失败',
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
    this._log(`[违规管理接口] ${method} ${urlPath} -> ${response.status}`);
    if (this._isLoginPageResponse(response, text)) {
      throw new Error('违规管理页面登录已失效，请重新导入 Token 或刷新登录态');
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

  _looksLikeViolationRecord(item) {
    if (!isPlainObject(item)) return false;
    const keys = Object.keys(item);
    return keys.some(key => [
      'violationAppealSn',
      'violation_appeal_sn',
      'violationType',
      'violation_type',
      'violationTypeStr',
      'appealStatus',
      'appeal_status',
      'violationId',
      'violation_id',
      'violationSn',
      'violation_sn',
      'noticeSn',
      'notice_sn',
      'createdAt',
      'noticeTime'
    ].includes(key));
  }

  _looksLikeViolationDetail(item) {
    if (!isPlainObject(item)) return false;
    const keys = Object.keys(item);
    return keys.some(key => [
      'violationAppealSn',
      'violation_appeal_sn',
      'violationType',
      'violation_type',
      'violationTypeStr',
      'appealStatus',
      'appeal_status',
      'appealEndTime',
      'punishMeasureOptions',
      'violationInfo',
      'violationNotes',
      'orderMmsExcelUrl',
      'appealTemplateUrl',
      'structureAppealFileUrl'
    ].includes(key));
  }

  _extractListFromPayload(payload, visited = new Set()) {
    if (!payload || typeof payload !== 'object') return [];
    if (visited.has(payload)) return [];
    visited.add(payload);
    if (Array.isArray(payload)) {
      if (!payload.length) return [];
      if (payload.some(item => this._looksLikeViolationRecord(item))) {
        return payload.filter(item => this._looksLikeViolationRecord(item));
      }
      for (const item of payload) {
        const nested = this._extractListFromPayload(item, visited);
        if (nested.length) return nested;
      }
      return [];
    }
    const directCandidates = [
      payload?.result?.data,
      payload?.result?.list,
      payload?.result?.records,
      payload?.data?.data,
      payload?.data?.list,
      payload?.data?.records,
      payload?.list,
      payload?.records,
      payload?.data,
      payload?.result
    ];
    for (const candidate of directCandidates) {
      if (Array.isArray(candidate) && candidate.some(item => this._looksLikeViolationRecord(item))) {
        return candidate.filter(item => this._looksLikeViolationRecord(item));
      }
    }
    for (const value of Object.values(payload)) {
      const nested = this._extractListFromPayload(value, visited);
      if (nested.length) return nested;
    }
    return [];
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
      if (this._looksLikeViolationDetail(candidate) || this._looksLikeViolationRecord(candidate)) {
        return candidate;
      }
    }
    for (const value of Object.values(payload)) {
      const nested = this._extractDetailFromPayload(value, visited);
      if (nested) return nested;
    }
    return null;
  }

  _extractTotalFromPayload(payload, fallbackTotal = 0) {
    const total = Number(
      payload?.result?.total
      ?? payload?.result?.count
      ?? payload?.result?.totalCount
      ?? payload?.data?.total
      ?? payload?.data?.count
      ?? payload?.data?.totalCount
      ?? payload?.total
      ?? payload?.count
      ?? payload?.totalCount
      ?? fallbackTotal
    );
    return Number.isFinite(total) ? total : fallbackTotal;
  }

  _normalizeTypeMap(payload) {
    const typeMap = {};
    const candidates = [payload?.result, payload?.data, payload];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        candidate.forEach(item => {
          const key = String(pickValue(item, ['id', 'code', 'value', 'violationType', 'violation_type'], '') || '').trim();
          const label = String(pickValue(item, ['label', 'name', 'desc', 'text', 'violationTypeStr', 'violation_type_str'], '') || '').trim();
          if (key && label) typeMap[key] = label;
        });
      } else if (isPlainObject(candidate)) {
        Object.entries(candidate).forEach(([key, value]) => {
          if (isPlainObject(value)) {
            const label = String(pickValue(value, ['label', 'name', 'desc', 'text'], '') || '').trim();
            if (label) typeMap[String(key)] = label;
            return;
          }
          const label = String(value || '').trim();
          if (label) typeMap[String(key)] = label;
        });
      }
      if (Object.keys(typeMap).length) {
        return typeMap;
      }
    }
    return typeMap;
  }

  _buildListBodies(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const keyword = String(params.keyword || '').trim();
    const status = String(params.status || params.appealStatus || '').trim();
    const violationType = String(params.violationType || params.type || '').trim();
    const trafficBody = this._getTrafficRequestBody(VIOLATION_RECORD_URL);
    const bodies = [];
    if (trafficBody) {
      const nextBody = { ...trafficBody };
      const pageKeys = ['pageNo', 'page_no', 'pageNum', 'page_num', 'page', 'currentPage'];
      const sizeKeys = ['pageSize', 'page_size', 'size', 'limit'];
      pageKeys.forEach(key => {
        if (key in nextBody) nextBody[key] = pageNo;
      });
      sizeKeys.forEach(key => {
        if (key in nextBody) nextBody[key] = pageSize;
      });
      if ('keyword' in nextBody) nextBody.keyword = keyword;
      if ('serialNo' in nextBody) nextBody.serialNo = keyword;
      if ('violationAppealSn' in nextBody) nextBody.violationAppealSn = keyword;
      if ('noticeSn' in nextBody) nextBody.noticeSn = keyword;
      if ('appealStatus' in nextBody) nextBody.appealStatus = status;
      if ('violationType' in nextBody) nextBody.violationType = violationType;
      bodies.push(nextBody);
    }
    bodies.push(
      {},
      { pageNo, pageSize },
      { page_no: pageNo, page_size: pageSize },
      { pageNum: pageNo, pageSize },
      { page_num: pageNo, page_size: pageSize },
      { currentPage: pageNo, pageSize },
      { page: pageNo, size: pageSize },
      {
        pageNo,
        pageSize,
        appealStatus: status || '',
        violationType: violationType || '',
        violationAppealSn: keyword,
        noticeSn: keyword
      },
      {
        page_no: pageNo,
        page_size: pageSize,
        appeal_status: status || '',
        violation_type: violationType || '',
        violation_appeal_sn: keyword,
        notice_sn: keyword
      }
    );
    return dedupeBodies(bodies.filter(item => isPlainObject(item)));
  }

  _buildDetailBodies(params = {}) {
    const violationAppealSn = String(pickValue(params, [
      'violationAppealSn',
      'violation_appeal_sn',
      'violationNo',
      'noticeSn',
      'notice_sn',
      'serialNo',
      'serial_no'
    ], '') || '').trim();
    const violationType = String(pickValue(params, ['violationType', 'violation_type', 'type'], '') || '').trim();
    const trafficBody = this._getTrafficRequestBody(VIOLATION_RECORD_DETAIL_URL);
    const bodies = [];
    if (trafficBody) {
      const nextBody = { ...trafficBody };
      if ('violationAppealSn' in nextBody) nextBody.violationAppealSn = violationAppealSn;
      if ('violation_appeal_sn' in nextBody) nextBody.violation_appeal_sn = violationAppealSn;
      if ('noticeSn' in nextBody) nextBody.noticeSn = violationAppealSn;
      if ('notice_sn' in nextBody) nextBody.notice_sn = violationAppealSn;
      if ('serialNo' in nextBody) nextBody.serialNo = violationAppealSn;
      if ('serial_no' in nextBody) nextBody.serial_no = violationAppealSn;
      if ('violationType' in nextBody) nextBody.violationType = violationType;
      if ('violation_type' in nextBody) nextBody.violation_type = violationType;
      bodies.push(nextBody);
    }
    bodies.push(
      { violationAppealSn, violationType },
      { violationAppealSn },
      { noticeSn: violationAppealSn, violationType },
      { serialNo: violationAppealSn, violationType },
      { violation_appeal_sn: violationAppealSn, violation_type: violationType },
      { violation_appeal_sn: violationAppealSn },
      { notice_sn: violationAppealSn, violation_type: violationType },
      { serial_no: violationAppealSn, violation_type: violationType }
    );
    return dedupeBodies(
      bodies
        .filter(item => isPlainObject(item))
        .filter(item => Object.values(item).some(value => String(value || '').trim()))
    );
  }

  async _requestBestListPayload(params = {}) {
    const bodies = this._buildListBodies(params);
    let bestSuccess = null;
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await this._request('POST', VIOLATION_RECORD_URL, body);
        const list = this._extractListFromPayload(payload);
        const total = this._extractTotalFromPayload(payload, list.length);
        if (!bestSuccess || list.length > bestSuccess.list.length) {
          bestSuccess = { payload, body, list, total };
        }
        if (list.length > 0) {
          return bestSuccess;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (bestSuccess) return bestSuccess;
    throw lastError || new Error('加载违规管理列表失败');
  }

  async _requestBestDetailPayload(params = {}) {
    const bodies = this._buildDetailBodies(params);
    let bestSuccess = null;
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await this._request('POST', VIOLATION_RECORD_DETAIL_URL, body);
        const detail = this._extractDetailFromPayload(payload);
        if (!bestSuccess || detail) {
          bestSuccess = { payload, body, detail };
        }
        if (detail) {
          return bestSuccess;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (bestSuccess) return bestSuccess;
    throw lastError || new Error('加载违规详情失败');
  }

  async getTypeMap() {
    const trafficBody = this._getTrafficRequestBody(VIOLATION_TYPE_URL);
    const bodies = dedupeBodies([trafficBody || {}, {}]);
    let lastError = null;
    for (const body of bodies) {
      try {
        const payload = await this._request('POST', VIOLATION_TYPE_URL, body);
        const typeMap = this._normalizeTypeMap(payload);
        return typeMap;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return {};
  }

  async getList(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const [typeMap, recordResult] = await Promise.all([
      this.getTypeMap().catch(() => ({})),
      this._requestBestListPayload({ ...params, pageNo, pageSize })
    ]);
    return {
      pageNo,
      pageSize,
      total: recordResult.total,
      list: recordResult.list,
      typeMap,
      requestBody: recordResult.body
    };
  }

  async getDetail(params = {}) {
    const violationAppealSn = String(pickValue(params, [
      'violationAppealSn',
      'violation_appeal_sn',
      'violationNo',
      'noticeSn',
      'notice_sn',
      'serialNo',
      'serial_no'
    ], '') || '').trim();
    if (!violationAppealSn) {
      throw new Error('缺少违规单号，无法加载违规详情');
    }
    const [typeMap, detailResult] = await Promise.all([
      this.getTypeMap().catch(() => ({})),
      this._requestBestDetailPayload(params)
    ]);
    return {
      violationAppealSn,
      typeMap,
      detail: detailResult.detail || null,
      requestBody: detailResult.body
    };
  }
}

module.exports = { ViolationApiClient };
