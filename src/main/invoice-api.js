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

function normalizeInvoiceAmount(value) {
  const raw = value ?? 0;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return 0;
  if (typeof raw === 'string' && raw.includes('.')) return amount;
  return Number.isInteger(amount) ? amount / 100 : amount;
}

function normalizeMappedText(value, map) {
  if (value === undefined || value === null || value === '') return '';
  return map[String(value)] || String(value);
}

function resolveOrderStatusText(item = {}) {
  const text = pickValue(item, ['order_status_desc', 'order_status_text', 'order_status_name', 'order_status_str'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['order_status'], ''), {
    2: '已收货',
  });
}

function resolveAfterSalesStatusText(item = {}) {
  const text = pickValue(item, ['after_sales_status_desc', 'after_sales_status_text', 'refund_status_desc'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['after_sales_status'], ''), {
    0: '正常',
  });
}

function resolveInvoiceModeText(item = {}) {
  const text = pickValue(item, ['invoice_mode_desc', 'invoice_mode_name', 'invoice_mode_text'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['invoice_mode'], ''), {
    0: '自动',
    1: '自动',
    2: '手动',
    3: '手动',
  });
}

function resolveInvoiceTypeText(item = {}) {
  const text = pickValue(item, [
    'invoice_way_desc',
    'invoice_way_name',
    'invoice_way_text',
    'invoice_type_desc',
    'invoice_type_name',
    'invoice_type_text',
  ], '');
  if (text) return String(text);
  const invoiceWay = pickValue(item, ['invoice_way'], '');
  if (invoiceWay !== '') {
    return normalizeMappedText(invoiceWay, {
      0: '电票',
      1: '纸票',
    });
  }
  return normalizeMappedText(pickValue(item, ['invoice_type'], ''), {
    0: '电票',
    1: '纸票',
  });
}

function resolveInvoiceKindText(item = {}) {
  const text = pickValue(item, ['invoice_kind_desc', 'invoice_kind_name', 'invoice_kind_text'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['invoice_kind'], ''), {
    0: '蓝票',
    1: '红票',
  });
}

function resolveLetterheadTypeText(item = {}) {
  const text = pickValue(item, ['letterhead_type_desc', 'letterhead_type_name', 'title_type_desc'], '');
  if (text) return String(text);
  const normalized = normalizeMappedText(pickValue(item, ['letterhead_type'], ''), {
    0: '个人',
    1: '企业',
  });
  if (normalized) return normalized;
  if (pickValue(item, ['payer_register_no', 'tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo'], '')) {
    return '企业';
  }
  return pickValue(item, ['letterhead', 'invoice_title', 'title_name'], '') ? '个人' : '';
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
      invoiceAmount: normalizeInvoiceAmount(stats.invoice_amount || 0),
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
    const serialNo = pickValue(item, ['serial_no', 'serialNo', 'id'], '');
    const orderSn = pickValue(item, ['order_sn', 'orderSn', 'order_no', 'orderNo'], '');
    return {
      serialNo: String(serialNo || ''),
      orderSn: String(orderSn || ''),
      shopName: String(pickValue(item, ['mall_name', 'shop_name', 'store_name'], '')),
      orderStatus: resolveOrderStatusText(item),
      afterSalesStatus: resolveAfterSalesStatusText(item),
      applyTime: Number(pickValue(item, ['apply_time', 'applyTime', 'created_at', 'create_time'], 0) || 0),
      promiseInvoiceTime: Number(pickValue(item, ['promise_invoicing_time', 'promise_invoice_time'], 0) || 0),
      invoiceAmount: normalizeInvoiceAmount(pickValue(item, ['invoice_amount', 'amount', 'sum_amount'], 0) || 0),
      invoiceMode: resolveInvoiceModeText(item),
      invoiceType: resolveInvoiceTypeText(item),
      invoiceKind: resolveInvoiceKindText(item),
      letterheadType: resolveLetterheadTypeText(item),
      letterhead: String(pickValue(item, ['letterhead', 'invoice_title', 'title_name'], '')),
      invoiceDisplayStatus: Number(pickValue(item, ['invoice_display_status', 'display_status', 'status'], 0) || 0),
      raw: item,
    };
  }

  _normalizeDetail(detail = {}) {
    return {
      orderSn: String(pickValue(detail, ['order_sn', 'orderSn'], '')),
      orderStatus: String(pickValue(detail, ['order_status_str', 'order_status_desc', 'order_status_text', 'order_status'], '')),
      invoiceApplyStatus: String(pickValue(detail, ['invoice_apply_status_str', 'invoice_apply_status_desc'], '')),
      goodsName: String(pickValue(detail, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle'], '')),
      goodsSpec: String(pickValue(detail, ['spec', 'goods_spec', 'goodsSpec', 'sku_spec_desc'], '')),
      goodsThumb: String(pickValue(detail, ['goods_thumbnail_url', 'goods_thumb_url', 'goods_img_url', 'goods_image_url', 'goods_image'], '')),
      receiveName: String(pickValue(detail, ['receive_name', 'receiver_name', 'consignee', 'receiver'], '')),
      receiveMobile: String(pickValue(detail, ['receive_mobile', 'receiver_mobile', 'mobile'], '')),
      shippingAddress: String(pickValue(detail, ['shipping_address', 'receive_address', 'address'], '')),
      shippingName: String(pickValue(detail, ['shipping_name', 'express_company_name', 'express_name'], '')),
      trackingNumber: String(pickValue(detail, ['tracking_number', 'waybill_no', 'trackingNo'], '')),
      taxNo: String(pickValue(detail, ['tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo', 'duty_paragraph'], '')),
      raw: detail
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

  async getDetail(params = {}) {
    const orderSn = String(params.orderSn || params.order_sn || '').trim();
    if (!orderSn) {
      throw new Error('缺少订单号');
    }
    const orderDetailPayload = await this._request('POST', '/mangkhut/mms/orderDetail', {
      orderSn,
      source: 'MMS'
    });
    const [submitCheckPayload] = await Promise.allSettled([
      this._request('POST', '/cambridge/api/duoDuoRuleSecret/checkAvailableToSubmitInvoiceRecord', {})
    ]);
    return {
      orderSn,
      canSubmit: submitCheckPayload.status === 'fulfilled'
        ? !!submitCheckPayload.value?.result
        : null,
      detail: this._normalizeDetail(orderDetailPayload?.result || {})
    };
  }
}

module.exports = { InvoiceApiClient };
