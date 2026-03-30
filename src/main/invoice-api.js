const { session } = require('electron');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_INVOICE_URL = `${PDD_BASE}/invoice/center?msfrom=mms_sidenav`;

function pickValue(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

class InvoiceApiClient {
  constructor(shopId, options = {}) {
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._getInvoiceUrl = options.getInvoiceUrl || (() => DEFAULT_INVOICE_URL);
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
      Referer: trafficHeaders.Referer || this._getInvoiceUrl() || DEFAULT_INVOICE_URL,
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
        message: payload.error_msg || payload.errorMsg || payload.message || '待开票接口失败',
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
    this._log(`[待开票接口] ${method} ${urlPath} -> ${response.status}`);
    if (this._isLoginPageResponse(response, text)) {
      throw new Error('待开票页面登录已失效，请重新导入 Token 或刷新登录态');
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

  _normalizeOverview(stats = {}, quickFilter = {}, mallControl = {}, verifyInfo = {}, extra = {}) {
    return {
      pendingNum: Number(stats.pending_num || 0),
      invoicedNum: Number(stats.invoiced_num || 0),
      applyingNum: Number(stats.applying_num || 0),
      invoiceAmount: Number(stats.invoice_amount || 0),
      quickPendingTotal: Number(quickFilter.total || 0),
      qualityPendingTotal: Number(quickFilter.quality_total || 0),
      normalPendingTotal: Number(quickFilter.normal_total || 0),
      nationalInvoiceConfirmTotal: Number(quickFilter.national_invoice_confirm_total || 0),
      mallControlInfo: mallControl || {},
      verifyInfo: verifyInfo || {},
      showInvoiceMarkTab: !!extra.showInvoiceMarkTab,
      isThirdPartySubMall: !!extra.isThirdPartySubMall,
    };
  }

  _normalizeListItem(item = {}) {
    const orderStatus = pickValue(item, ['order_status_desc', 'order_status_text', 'order_status_name', 'order_status'], '');
    const afterSalesStatus = pickValue(item, ['after_sales_status_desc', 'after_sales_status_text', 'refund_status_desc', 'after_sales_status'], '');
    const invoiceMode = pickValue(item, ['invoice_mode_desc', 'invoice_mode_name', 'invoice_mode_text', 'invoice_mode'], '');
    const invoiceType = pickValue(item, ['invoice_type_desc', 'invoice_type_name', 'invoice_type_text', 'invoice_type'], '');
    const letterheadType = pickValue(item, ['letterhead_type_desc', 'letterhead_type_name', 'title_type_desc', 'letterhead_type'], '');
    const serialNo = pickValue(item, ['serial_no', 'serialNo', 'id'], '');
    const orderSn = pickValue(item, ['order_sn', 'orderSn', 'order_no', 'orderNo'], '');
    return {
      serialNo: String(serialNo || ''),
      orderSn: String(orderSn || ''),
      shopName: String(pickValue(item, ['mall_name', 'shop_name', 'store_name'], '')),
      orderStatus: String(orderStatus || ''),
      afterSalesStatus: String(afterSalesStatus || ''),
      applyTime: Number(pickValue(item, ['apply_time', 'applyTime', 'created_at', 'create_time'], 0) || 0),
      invoiceAmount: Number(pickValue(item, ['invoice_amount', 'amount', 'sum_amount'], 0) || 0),
      invoiceMode: String(invoiceMode || ''),
      invoiceType: String(invoiceType || ''),
      letterheadType: String(letterheadType || ''),
      letterhead: String(pickValue(item, ['letterhead', 'invoice_title', 'title_name'], '')),
      invoiceDisplayStatus: Number(pickValue(item, ['invoice_display_status', 'display_status', 'status'], 0) || 0),
      raw: item,
    };
  }

  async getOverview() {
    const [statsPayload, quickFilterPayload, mallControlPayload, verifyPayload, markTabPayload, thirdPartyPayload] = await Promise.all([
      this._request('POST', '/omaisms/invoice/invoice_statistic', {}),
      this._request('POST', '/omaisms/invoice/invoice_quick_filter', {}),
      this._request('POST', '/orderinvoice/mall/mallControlInfo', {}),
      this._request('POST', '/voice/api/mms/invoice/mall/verify2', {}),
      this._request('POST', '/orderinvoice/mall/showInvoiceMarkTab', {}),
      this._request('POST', '/omaisms/invoice/is_third_party_entity_sub_mall', {}),
    ]);
    return this._normalizeOverview(
      statsPayload?.result || {},
      quickFilterPayload?.result || {},
      mallControlPayload?.result || {},
      verifyPayload?.result || {},
      {
        showInvoiceMarkTab: markTabPayload?.result,
        isThirdPartySubMall: thirdPartyPayload?.result,
      }
    );
  }

  async getList(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 10));
    const keyword = String(params.keyword || '').trim();
    const body = {
      invoice_mode_list: null,
      invalid_status: '',
      letterhead: '',
      invoice_display_status: Number(params.invoiceDisplayStatus ?? 0),
      order_status: '',
      page_size: pageSize,
      serial_no: keyword,
      after_sales_status: '',
      letterhead_type: '',
      page_no: pageNo,
      invoice_type: '',
      invoice_kind: '',
      invoice_waybill_no: '',
      file_status: '',
      order_sn: keyword,
    };
    const payload = await this._request('POST', '/omaisms/invoice/invoice_list', body);
    const result = payload?.result || {};
    const list = Array.isArray(result.list) ? result.list.map(item => this._normalizeListItem(item)) : [];
    return {
      pageNo,
      pageSize,
      total: Number(result.total || 0),
      list,
    };
  }
}

module.exports = { InvoiceApiClient };
