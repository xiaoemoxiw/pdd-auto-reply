const { session } = require('electron');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_DELAY_SHIP_URL = `${PDD_BASE}/pg/deduciton_detail/record?msfrom=mms_sidenav`;
const DEFAULT_OUT_OF_STOCK_URL = `${PDD_BASE}/pg/deduciton_detail/stock`;
const DEFAULT_FAKE_SHIP_TRACK_URL = `${PDD_BASE}/pg/deduciton_detail/fake`;

const DELAY_SHIP_LIST_URL = '/genji/poppy/overtimeShipment/query/chargeList';
const OUT_OF_STOCK_LIST_URL = '/genji/poppy/stockout/query/stockoutList';
const FAKE_SHIP_TRACK_LIST_URL = '/genji/poppy/fakeShipment/query/fakeShipmentList';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

function parseTimeToMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
  const date = new Date(String(value));
  const ms = date.getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

class DeductionApiClient {
  constructor(shopId, options = {}) {
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
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

  _getDefaultReferer(urlPart) {
    if (String(urlPart || '').includes(OUT_OF_STOCK_LIST_URL) || String(urlPart || '').includes('/deduciton_detail/stock')) {
      return DEFAULT_OUT_OF_STOCK_URL;
    }
    if (String(urlPart || '').includes(FAKE_SHIP_TRACK_LIST_URL) || String(urlPart || '').includes('/deduciton_detail/fake')) {
      return DEFAULT_FAKE_SHIP_TRACK_URL;
    }
    return DEFAULT_DELAY_SHIP_URL;
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
      Referer: trafficHeaders.Referer || this._getDefaultReferer(urlPart),
      Origin: PDD_BASE,
      ...extraHeaders,
    };
    if (cookie) headers.cookie = cookie;
    const ua = String(shop?.userAgent || tokenInfo?.userAgent || '').replace('pdd_webview', '').trim();
    headers['user-agent'] = ua || DEFAULT_UA;
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

  _normalizeBusinessError(payload, fallbackMessage) {
    if (!payload || typeof payload !== 'object') return null;
    const success = payload.success;
    const errorCode = Number(payload.error_code ?? payload.errorCode ?? payload.code ?? 0);
    if (success === false || (errorCode && errorCode !== 1000000)) {
      return {
        code: errorCode,
        message: payload.error_msg || payload.errorMsg || payload.message || fallbackMessage || '扣款接口失败',
      };
    }
    return null;
  }

  _isLoginPageResponse(response, text) {
    const finalUrl = String(response?.url || '');
    if (finalUrl.includes('/login')) return true;
    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return false;
    const snippet = typeof text === 'string' ? text.slice(0, 900).toLowerCase() : '';
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
    this._log(`[扣款接口] ${method} ${urlPath} -> ${response.status}`);
    if (this._isLoginPageResponse(response, text)) {
      throw new Error('扣款页面登录已失效，请重新导入 Token 或刷新登录态');
    }
    if (!response.ok) {
      throw new Error(typeof payload === 'object'
        ? payload?.error_msg || payload?.errorMsg || payload?.message || `HTTP ${response.status}`
        : `HTTP ${response.status}: ${String(text).slice(0, 200)}`);
    }
    const businessError = this._normalizeBusinessError(payload, '扣款接口失败');
    if (businessError) {
      const error = new Error(businessError.message);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  _normalizeListItem(category, item) {
    const shop = this._getShopInfo();
    const shopName = shop?.name || shop?.mallName || '未知店铺';
    const orderSn = String(pickValue(item, ['orderSn', 'order_sn', 'orderNo', 'order_no', 'orderId', 'order_id'], '') || '').trim();
    const goodsId = String(pickValue(item, ['goodsId', 'goods_id', 'productId', 'product_id', 'skuId', 'sku_id'], '') || '').trim();
    const goodsName = String(pickValue(item, ['goodsName', 'goods_name', 'productName', 'product_name', 'title', 'name'], '') || '').trim();
    const promiseTime = pickValue(item, [
      'promiseShippingTime',
      'promise_shipping_time',
      'promiseTime',
      'promise_time',
      'promisedAt',
      'promisedTime',
      'commitTime',
      'commit_time',
      'confirmTime',
      'confirm_time',
      'expectedShipTime',
      'expected_ship_time'
    ], '');
    const shipTime = pickValue(item, [
      'shippingTime',
      'shipping_time',
      'shipTime',
      'ship_time',
      'deliveryTime',
      'delivery_time',
      'sendTime',
      'send_time',
      'shippedAt',
      'shipped_at'
    ], '');
    const expressNo = String(pickValue(item, [
      'expressNo',
      'express_no',
      'trackingNo',
      'tracking_no',
      'waybillNo',
      'waybill_no',
      'shippingId',
      'shipping_id',
      'deliveryNo',
      'delivery_no'
    ], '') || '').trim();
    const violationType = String(pickValue(item, [
      'violationType',
      'violation_type',
      'punishType',
      'punish_type',
      'type',
      'deductionType',
      'deductType',
      'penaltyType'
    ], '') || '').trim();
    const amount = String(pickValue(item, [
      'chargeAmount',
      'charge_amount',
      'amountText',
      'amount',
      'deductAmount',
      'deduct_amount',
      'money',
      'moneyText'
    ], '') || '').trim();
    const deductionTime = pickValue(item, [
      'chargeTime',
      'charge_time',
      'deductionTime',
      'deductTime',
      'deduct_time',
      'createdAtText',
      'createdAt',
      'created_at'
    ], '');
    const reason = String(pickValue(item, [
      'chargeReason',
      'charge_reason',
      'reason',
      'deductReason',
      'deductionReason',
      'remark',
      'punishReason'
    ], '') || '').trim();
    const deductionType = category === 'fakeShipTrack'
      ? '虚假发货'
      : category === 'outOfStock'
        ? '缺货'
        : '延迟发货';
    return {
      shopId: this.shopId,
      shopName,
      deductionType,
      category,
      orderSn: orderSn || '-',
      goodsId: goodsId || '-',
      goodsName: goodsName || '-',
      promiseTime: promiseTime || '-',
      shipTime: shipTime || '-',
      expressNo: expressNo || '-',
      violationType: violationType || '-',
      amountText: amount || '-',
      deductionTime: deductionTime || '-',
      reason: reason || '-',
      raw: item || null,
    };
  }

  _buildListParams(params = {}, urlPart) {
    const now = Date.now();
    const template = this._getTrafficRequestBody(urlPart) || {};
    const pageNum = Math.max(1, Number(params.pageNum || params.page_no || params.pageNo || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    const endTime = Number(params.endTime || params.end_time || template.endTime || template.end_time || now);
    const startTime = Number(params.startTime || params.start_time || template.startTime || template.start_time || (endTime - 30 * 24 * 3600 * 1000));
    const orderSn = String(params.orderSn || params.order_sn || template.orderSn || template.order_sn || '').trim();
    return {
      ...template,
      pageNum,
      pageSize,
      endTime,
      startTime,
      orderSn,
    };
  }

  _pickListItemSortTime(item) {
    return parseTimeToMs(
      item?.deductionTime
      || item?.raw?.chargeTime
      || item?.raw?.charge_time
      || item?.raw?.deductionTime
      || item?.raw?.deductTime
      || item?.raw?.deduct_time
      || item?.raw?.createdAt
      || item?.raw?.created_at
      || item?.shipTime
      || item?.promiseTime
    );
  }

  async _getListBy(category, urlPart, params = {}) {
    const normalizedPageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
    let pageNum = Math.max(1, Number(params.pageNum || params.page_no || params.pageNo || 1));
    let total = 0;
    const normalizedList = [];

    while (true) {
      const body = this._buildListParams({ ...params, pageNum, pageSize: normalizedPageSize }, urlPart);
      const payload = await this._request('POST', urlPart, body);
      const pageTotal = Number(payload?.result?.total || 0);
      const pageList = Array.isArray(payload?.result?.data) ? payload.result.data : [];

      if (!total) total = pageTotal;
      if (!pageList.length) break;

      normalizedList.push(...pageList.map(item => this._normalizeListItem(category, item)));
      if (normalizedList.length >= pageTotal || pageList.length < normalizedPageSize) break;
      pageNum += 1;
    }

    normalizedList.sort((a, b) => this._pickListItemSortTime(b) - this._pickListItemSortTime(a));
    return {
      total,
      list: normalizedList
    };
  }

  async getList(params = {}) {
    const filter = String(params.filter || params.deductionFilter || params.category || '').trim();
    const normalizedFilter = ['delayShip', 'outOfStock', 'fakeShipTrack'].includes(filter) ? filter : '';

    if (normalizedFilter === 'delayShip') {
      const result = await this._getListBy('delayShip', DELAY_SHIP_LIST_URL, params);
      return { ...result, list: result.list };
    }
    if (normalizedFilter === 'outOfStock') {
      const result = await this._getListBy('outOfStock', OUT_OF_STOCK_LIST_URL, params);
      return { ...result, list: result.list };
    }
    if (normalizedFilter === 'fakeShipTrack') {
      const result = await this._getListBy('fakeShipTrack', FAKE_SHIP_TRACK_LIST_URL, params);
      return { ...result, list: result.list };
    }

    const [delayShip, outOfStock, fakeShipTrack] = await Promise.all([
      this._getListBy('delayShip', DELAY_SHIP_LIST_URL, params),
      this._getListBy('outOfStock', OUT_OF_STOCK_LIST_URL, params),
      this._getListBy('fakeShipTrack', FAKE_SHIP_TRACK_LIST_URL, params),
    ]);
    return {
      totals: {
        delayShip: delayShip.total || 0,
        outOfStock: outOfStock.total || 0,
        fakeShipTrack: fakeShipTrack.total || 0,
      },
      list: [...delayShip.list, ...outOfStock.list, ...fakeShipTrack.list]
    };
  }
}

module.exports = {
  DeductionApiClient,
  DELAY_SHIP_LIST_URL,
  OUT_OF_STOCK_LIST_URL,
  FAKE_SHIP_TRACK_LIST_URL
};
