'use strict';

/**
 * 物流地址、物流公司、聊天页物流详情查询模块。
 *
 * 退货地址联动需要"省/市/区"三级地区接口，售后页又需要可选的物流公司
 * 列表，聊天页商品卡片旁的"已发货"状态来自 /chats/shippingDetail；这三件
 * 事都不在工单/售后单的核心读写链路上，但又共用同一个 TicketApiClient
 * 的 _request（共享 Token / Cookie / 重试逻辑），因此放在同一个 client 下。
 *
 * 模块自带本地缓存：
 * - 地区按 parentId 缓存（应用内一直有效，主类销毁时连同 client 一起释放）；
 * - 物流公司按 ttlMs 缓存（默认 6 小时），避免短时间内重复请求物流目录。
 */

const {
  pickValue,
  isPlainObject,
  extractArrayFromPayload,
  normalizeRegionItem,
} = require('../parsers/ticket-helpers');

const PDD_BASE = 'https://mms.pinduoduo.com';
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;
const REGION_GET_URL = '/latitude/order/region/get';
const SHIPPING_COMPANY_LIST_URL = '/express_base/shipping_list/mms';

class ShippingModule {
  constructor(client) {
    this.client = client;
    this._regionCache = new Map();
    this._shippingCompanyCache = null;
    this._shippingCompanyCacheAt = 0;
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
    const payload = await this.client._request('GET', urlPath, null, {}, options);
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

    const payload = await this.client._request('GET', SHIPPING_COMPANY_LIST_URL, null, {}, options);
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
    const payload = await this.client._request('GET', urlPath, null, { Referer: CHAT_URL }, options);
    return { payload, result: payload?.result ?? null };
  }
}

module.exports = {
  ShippingModule,
  REGION_GET_URL,
  SHIPPING_COMPANY_LIST_URL,
};
