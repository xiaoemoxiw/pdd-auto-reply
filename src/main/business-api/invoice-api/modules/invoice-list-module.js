'use strict';

/**
 * 待开票数据读取模块。
 *
 * 拆出来的目的是把"看数据"和"提交录入发票"的两条链路解耦：
 * - 概览：6 个 mms 接口并行（统计 / 快筛 / 控制信息 / 审核信息 / 标记 Tab / 三方店铺）；
 * - 列表：拼成 omaisms/invoice/invoice_list 的 17 个固定字段请求体；
 * - 详情：mangkhut/mms/orderDetail + cambridge 是否可提交校验。
 *
 * 详情有 2 分钟内存缓存 + 同 orderSn 串行 in-flight + 全局 1.5s 节流，
 * 这些状态属于"读取链路"自身，因此模块自己持有，不再放在主 client 上。
 */

const {
  normalizeOverview,
  normalizeListItem,
  normalizeDetail,
  sleep,
} = require('../parsers/invoice-parsers');

class InvoiceListModule {
  constructor(client) {
    this.client = client;
    this._detailCache = new Map();
    this._detailPending = new Map();
    this._detailThrottle = Promise.resolve();
    this._lastDetailRequestAt = 0;
  }

  async getOverview() {
    const client = this.client;
    const [statsPayload, quickFilterPayload, mallControlPayload, verifyPayload, markTabPayload, thirdPartyPayload] = await Promise.all([
      client._request('POST', '/omaisms/invoice/invoice_statistic', {}),
      client._request('POST', '/omaisms/invoice/invoice_quick_filter', {}),
      client._request('POST', '/orderinvoice/mall/mallControlInfo', {}),
      client._request('POST', '/voice/api/mms/invoice/mall/verify2', {}),
      client._request('POST', '/orderinvoice/mall/showInvoiceMarkTab', {}),
      client._request('POST', '/omaisms/invoice/is_third_party_entity_sub_mall', {}),
    ]);
    return normalizeOverview(
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
      invoice_way: '',
      invoice_waybill_no: '',
      file_status: '',
      subsidy_type: Number(params.subsidyType ?? 0),
      order_sn: keyword,
    };
    const payload = await this.client._request('POST', '/omaisms/invoice/invoice_list', body);
    const result = payload?.result || {};
    const list = Array.isArray(result.list) ? result.list.map(normalizeListItem) : [];
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
    const cached = this._detailCache.get(orderSn) || null;
    if (cached && Date.now() - Number(cached.at || 0) < 2 * 60 * 1000) {
      return cached.value;
    }

    const pending = this._detailPending.get(orderSn);
    if (pending) return pending;

    const task = (async () => {
      const throttle = this._detailThrottle.then(async () => {
        const now = Date.now();
        const diff = now - this._lastDetailRequestAt;
        if (diff < 1500) {
          await sleep(1500 - diff);
        }
        this._lastDetailRequestAt = Date.now();
      });
      this._detailThrottle = throttle.catch(() => {});
      await throttle;

      const detailPayload = await this._requestOrderDetailWithRetry(orderSn);
      const detail = normalizeDetail(detailPayload?.result || {});

      const submitCheckPayload = await Promise.allSettled([
        this.client._request('POST', '/cambridge/api/duoDuoRuleSecret/checkAvailableToSubmitInvoiceRecord', {})
      ]);

      const result = {
        orderSn,
        canSubmit: submitCheckPayload[0].status === 'fulfilled'
          ? !!submitCheckPayload[0].value?.result
          : null,
        detail
      };
      this._detailCache.set(orderSn, { at: Date.now(), value: result });
      return result;
    })();

    this._detailPending.set(orderSn, task);
    try {
      return await task;
    } finally {
      this._detailPending.delete(orderSn);
    }
  }

  async _requestOrderDetailWithRetry(orderSn) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.client._request('POST', '/mangkhut/mms/orderDetail', { orderSn, source: 'MMS' });
      } catch (error) {
        lastError = error;
        const message = String(error?.message || '');
        const shouldRetry = message.includes('操作太过频繁') || message.includes('太过频繁') || message.includes('频繁');
        if (!shouldRetry || attempt >= 4) {
          throw error;
        }
        const base = 2000 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 320);
        await sleep(base + jitter);
      }
    }
    throw lastError || new Error('加载订单详情失败');
  }
}

module.exports = { InvoiceListModule };
