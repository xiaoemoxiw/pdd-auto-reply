const { PddBusinessApiClient, DEFAULT_PDD_BASE } = require('./pdd-business-api-client');

const PDD_BASE = DEFAULT_PDD_BASE;
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

class DeductionApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    super(shopId, {
      ...options,
      errorLabel: '扣款接口',
      loginExpiredMessage: '扣款页面登录已失效，请重新导入 Token 或刷新登录态',
      // 扣款相关三个 tab 各自有专属落地页 referer，需要按 urlPart 动态选择。
      getRefererUrl: (urlPart) => DeductionApiClient._resolveDefaultReferer(urlPart),
    });
  }

  static _resolveDefaultReferer(urlPart) {
    const path = String(urlPart || '');
    if (path.includes(OUT_OF_STOCK_LIST_URL) || path.includes('/deduciton_detail/stock')) {
      return DEFAULT_OUT_OF_STOCK_URL;
    }
    if (path.includes(FAKE_SHIP_TRACK_LIST_URL) || path.includes('/deduciton_detail/fake')) {
      return DEFAULT_FAKE_SHIP_TRACK_URL;
    }
    return DEFAULT_DELAY_SHIP_URL;
  }

  // 仅在 user-agent 为空时回填默认 UA，避免 deduction 后端拒空 UA；其余字段全部走基座默认。
  async _buildHeaders(urlPart, extraHeaders = {}) {
    const headers = await super._buildHeaders(urlPart, extraHeaders);
    if (!headers['user-agent']) {
      headers['user-agent'] = DEFAULT_UA;
    }
    return headers;
  }

  _getTrafficRequestBody(urlPart) {
    const requestBody = this._findLatestTraffic(urlPart)?.requestBody;
    if (isPlainObject(requestBody)) return { ...requestBody };
    const parsed = parseJsonSafely(requestBody);
    return isPlainObject(parsed) ? parsed : null;
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
