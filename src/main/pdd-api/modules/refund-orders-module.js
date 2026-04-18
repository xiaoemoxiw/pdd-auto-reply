'use strict';

// 退款 / 售后订单模块。
// 涵盖：售后订单列表抓取（接口 / DOM / 抓包三路兜底）、订单售后状态拼接、
// 申请退款（getRefundApplyInfo / submitRefundApply）、聊天页确认提示。
// 模块通过构造函数注入 PddApiClient，复用其 _request / _requestInPddPage /
// _executeInPddPage / _post 等会话能力，纯解析直接调用 refund-parsers。

const refundParsers = require('../parsers/refund-parsers');
const messageParsers = require('../parsers/message-parsers');

class RefundOrdersModule {
  constructor(client) {
    this.client = client;
  }

  async fetchAfterSalesDetailMap(orderSns = []) {
    const client = this.client;
    const validOrderSns = [...new Set((Array.isArray(orderSns) ? orderSns : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!validOrderSns.length) return {};
    const antiContent = client._getLatestAntiContent();
    const payload = await client._requestRefundOrderPageApi('/mercury/chat/afterSales/queryList', antiContent
      ? { orderSns: validOrderSns, anti_content: antiContent }
      : { orderSns: validOrderSns });
    return refundParsers.extractAfterSalesDetailMapFromPayload(payload);
  }

  async attachAfterSalesStatus(orders = []) {
    const client = this.client;
    const orderSns = orders.map(item => String(item?.orderId || item?.orderSn || '').trim()).filter(Boolean);
    if (!orderSns.length) return orders;
    let detailMap = {};
    try {
      detailMap = await this.fetchAfterSalesDetailMap(orderSns);
    } catch (error) {
      client._log('[API] 售后状态查询失败', { message: error.message });
    }
    return orders.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || '').trim();
      const detail = detailMap[orderSn] && typeof detailMap[orderSn] === 'object'
        ? detailMap[orderSn]
        : {};
      return {
        ...order,
        ...detail,
        afterSalesStatus: detail.afterSalesStatus || order?.afterSalesStatus || '',
      };
    });
  }

  extractRefundOrdersFromTraffic(sessionMeta = {}) {
    const client = this.client;
    const bucket = [];
    const visited = new WeakSet();
    client._getApiTrafficEntries()
      .filter(entry => /order|goods|trade|pay|after/i.test(String(entry?.url || '')))
      .slice(-30)
      .forEach(entry => {
        const requestBody = typeof entry?.requestBody === 'string' ? client._safeParseJson(entry.requestBody) : entry?.requestBody;
        const responseBody = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
        refundParsers.collectRefundOrderNodes(requestBody, bucket, visited);
        refundParsers.collectRefundOrderNodes(responseBody, bucket, visited);
      });
    return bucket.map((item, index) => refundParsers.normalizeRefundOrder(item, sessionMeta, index));
  }

  async extractRefundOrdersFromPageApis(sessionMeta = {}, options = {}) {
    const client = this.client;
    const eligibleOnly = options?.eligibleOnly !== false;
    const uid = refundParsers.getRefundOrderUid(sessionMeta);
    if (!uid) return null;
    const quantityPayload = await client._requestRefundOrderPageApi('/latitude/order/userOrderQuantity', { uid });
    const quantityResult = quantityPayload?.result || {};
    const totalCount = Number(quantityResult?.sum || 0) || 0;
    if (totalCount <= 0) {
      return [];
    }
    const orderPayload = await client._requestRefundOrderPageApi('/latitude/order/userAllOrder', {
      pageNo: 1,
      pageSize: Math.min(Math.max(totalCount, 10), 50),
      showHistory: true,
      uid,
    });
    const orders = Array.isArray(orderPayload?.result?.orders) ? orderPayload.result.orders : [];
    const normalizedOrders = await this.attachAfterSalesStatus(refundParsers.dedupeRefundOrders(orders, sessionMeta));
    const normalized = eligibleOnly
      ? refundParsers.filterEligibleRefundOrders(normalizedOrders)
      : normalizedOrders;
    if (normalized.length) {
      return normalized;
    }
    const unshippedCount = Number(quantityResult?.unshipped || 0) || 0;
    if (unshippedCount > 0) {
      const unshippedPayload = await client._requestRefundOrderPageApi('/latitude/order/userUnshippedOrder', {
        pageNo: 1,
        pageSize: Math.min(Math.max(unshippedCount, 10), 50),
        uid,
      });
      const unshippedOrders = Array.isArray(unshippedPayload?.result?.orders) ? unshippedPayload.result.orders : [];
      const normalizedUnshippedOrders = await this.attachAfterSalesStatus(refundParsers.dedupeRefundOrders(
          unshippedOrders.map(item => ({
            ...(item || {}),
            refund_shipping_state: 'unshipped',
          })),
          sessionMeta
        ));
      return eligibleOnly
        ? refundParsers.filterEligibleRefundOrders(normalizedUnshippedOrders)
        : normalizedUnshippedOrders;
    }
    return [];
  }

  async extractAftersaleOrdersFromPageApis(sessionMeta = {}) {
    const client = this.client;
    const uid = refundParsers.getRefundOrderUid(sessionMeta);
    if (!uid) return null;
    const orderPayload = await client._requestRefundOrderPageApi('/latitude/order/userRefundOrder', {
      pageNo: 1,
      pageSize: 50,
      uid,
    });
    const orders = Array.isArray(orderPayload?.result?.orders) ? orderPayload.result.orders : [];
    if (!orders.length) return [];
    return refundParsers.dedupeRefundOrders(orders, sessionMeta);
  }

  async extractRefundOrdersFromDom(sessionMeta = {}) {
    const client = this.client;
    if (typeof client._executeInPddPage !== 'function') return [];
    const target = {
      customerName: String(sessionMeta?.customerName || sessionMeta?.raw?.nick || sessionMeta?.raw?.nickname || '').trim(),
      orderId: String(sessionMeta?.orderId || '').trim(),
      customerId: String(sessionMeta?.customerId || sessionMeta?.raw?.customer_id || sessionMeta?.raw?.buyer_id || '').trim(),
    };
    const result = await client._executeInPddPage(`
      (async () => {
        const target = ${JSON.stringify(target)};
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const isVisible = el => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 20 && rect.height > 20 && el.offsetParent !== null;
        };
        const getText = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
        const maybeClickConversation = async () => {
          const keywords = [target.orderId, target.customerName, target.customerId].filter(Boolean);
          if (!keywords.length) return false;
          const nodes = Array.from(document.querySelectorAll('div, li, section, article, a, button'));
          const candidate = nodes.find(el => {
            if (!isVisible(el)) return false;
            const rect = el.getBoundingClientRect();
            if (rect.left > window.innerWidth * 0.45 || rect.width < 120 || rect.height < 28) return false;
            const text = getText(el);
            if (!text || text.length > 300) return false;
            return keywords.some(keyword => keyword && text.includes(keyword));
          });
          if (!candidate) return false;
          candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          candidate.click();
          candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          await sleep(500);
          return true;
        };
        await maybeClickConversation();
        const containers = Array.from(document.querySelectorAll(
          '.right-panel, .order-panel, .customer-info, [class*="right-panel"], [class*="orderInfo"], [class*="goodsInfo"], [class*="order-panel"], [class*="customer-info"]'
        )).filter(isVisible);
        const container = containers.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return (rectB.left + rectB.width) - (rectA.left + rectA.width);
        })[0] || document.body;
        const orderPattern = /订单号[:：]?\\s*([0-9-]{10,})/;
        const pricePattern = /¥\\s*\\d+(?:\\.\\d+)?/;
        const nodes = Array.from(container.querySelectorAll('div, li, section, article')).filter(isVisible);
        const items = [];
        const seen = new Set();
        nodes.forEach((node, index) => {
          const text = getText(node);
          if (!text || text.length > 800) return;
          const orderMatch = text.match(orderPattern);
          if (!orderMatch?.[1]) return;
          const orderId = orderMatch[1];
          if (seen.has(orderId)) return;
          const rect = node.getBoundingClientRect();
          if (rect.width < 160 || rect.height < 50) return;
          const titleEl = node.querySelector('[class*="title"], [class*="name"], strong, h3, h4, h5');
          const img = node.querySelector('img');
          const titleText = getText(titleEl) || (img?.getAttribute('alt') || '').trim();
          const priceMatch = text.match(pricePattern);
          const quantityMatch = text.match(/x\\s*\\d+/i);
          items.push({
            orderId,
            title: titleText || ('订单 ' + (index + 1)),
            imageUrl: img?.src || '',
            amountText: priceMatch?.[0] || '待确认',
            detailText: quantityMatch?.[0] || '消费者订单',
          });
          seen.add(orderId);
        });
        return items;
      })()
    `, { source: 'refund-orders:dom-extract' });
    return Array.isArray(result) ? result : [];
  }

  async getRefundOrders(sessionRef) {
    const client = this.client;
    const sessionMeta = client._normalizeSessionMeta(sessionRef);
    try {
      const pageOrders = await this.extractRefundOrdersFromPageApis(sessionMeta);
      if (Array.isArray(pageOrders)) {
        return refundParsers.filterEligibleRefundOrders(pageOrders);
      }
    } catch (error) {
      client._log('[API] 售后订单接口查询失败', { message: error.message });
    }
    try {
      const domOrders = await this.extractRefundOrdersFromDom(sessionMeta);
      const normalizedDomOrders = refundParsers.filterEligibleRefundOrders(refundParsers.dedupeRefundOrders(domOrders, sessionMeta));
      if (normalizedDomOrders.length) {
        return normalizedDomOrders;
      }
    } catch (error) {
      client._log('[API] 售后订单 DOM 提取失败', { message: error.message });
    }
    const bucket = [];
    const visited = new WeakSet();
    [
      sessionMeta?.goodsInfo,
      sessionMeta?.raw?.goods_info,
      sessionMeta?.raw?.goods,
      sessionMeta?.raw?.orders,
      sessionMeta?.raw?.order_list,
      sessionMeta?.raw?.orderList,
      sessionMeta?.raw?.order_info,
      sessionMeta?.raw?.orderInfo,
      sessionMeta?.raw,
    ].forEach(source => refundParsers.collectRefundOrderNodes(source, bucket, visited));
    let messages = [];
    try {
      messages = await client.getSessionMessages(sessionMeta, 1, 50);
    } catch (error) {
      client._log('[API] 售后订单消息回退失败', { message: error.message });
    }
    const merged = bucket
      .map((item, index) => refundParsers.normalizeRefundOrder(item, sessionMeta, index))
      .concat(refundParsers.extractRefundOrdersFromMessages(sessionMeta, messages))
      .concat(this.extractRefundOrdersFromTraffic(sessionMeta));
    return refundParsers.filterEligibleRefundOrders(refundParsers.dedupeRefundOrders(merged, sessionMeta));
  }

  async requestRefundApplyApi(urlPath, body = {}, method = 'POST') {
    const client = this.client;
    const normalizedMethod = String(method || 'POST').toUpperCase();
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
    };
    if (normalizedMethod === 'GET') {
      delete headers['content-type'];
    }
    if (typeof client._requestInPddPage === 'function') {
      return client._requestInPddPage({
        method: normalizedMethod,
        url: urlPath,
        source: 'refund-apply:page-request',
        headers,
        body: normalizedMethod === 'GET' ? null : JSON.stringify(body || {}),
      });
    }
    if (normalizedMethod === 'GET') {
      return client._request('GET', urlPath, null, headers);
    }
    return client._post(urlPath, body || {}, headers);
  }

  async confirmRefundApplyConversationMessage(sessionRef, options = {}) {
    const client = this.client;
    const attempts = Math.max(1, Number(options.attempts || 6));
    const delayMs = Math.max(0, Number(options.delayMs || 800));
    const pageSize = Math.max(20, Number(options.pageSize || 30));
    const sentAtMs = Number(options.sentAtMs || Date.now());
    const expectedText = messageParsers.normalizeComparableMessageText(options.expectedText || '');
    for (let index = 0; index < attempts; index++) {
      const messages = await client.getSessionMessages(sessionRef, 1, pageSize);
      const matched = messages.find(message => {
        const actor = messageParsers.getMessageActor(message?.raw || message, client._getMallId() || '');
        if (actor === 'buyer' || actor === 'system') return false;
        const timestampMs = client._normalizeTimestampMs(message.timestamp);
        if (timestampMs && (timestampMs < sentAtMs - 15000 || timestampMs > Date.now() + 60000)) {
          return false;
        }
        const messageText = messageParsers.normalizeComparableMessageText(message.content);
        if (expectedText && messageText && messageText === expectedText) return true;
        if (/快捷退款|申请退款|退货退款|待消费者确认/.test(messageText || '')) return true;
        return !!timestampMs && timestampMs >= sentAtMs - 15000;
      });
      if (matched) {
        return {
          confirmed: true,
          messageId: String(matched.messageId || ''),
          timestamp: matched.timestamp || 0,
          content: String(matched.content || ''),
        };
      }
      if (index < attempts - 1) {
        await client._sleep(delayMs);
      }
    }
    return { confirmed: false };
  }

  async getRefundApplyInfo(orderSn) {
    const client = this.client;
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const payload = await this.requestRefundApplyApi('/plateau/message/ask_refund_apply/infoV2', {
      order_sn: normalizedOrderSn,
    });
    return client._cloneJson(payload);
  }

  async submitRefundApply(params = {}) {
    const client = this.client;
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const afterSalesType = refundParsers.normalizeRefundApplyType(params?.type || params?.afterSalesType || params?.after_sales_type);
    const infoPayload = await this.getRefundApplyInfo(normalizedOrderSn);
    const info = infoPayload?.result && typeof infoPayload.result === 'object' ? infoPayload.result : {};
    const shopProfile = await client.getShopProfile().catch(() => ({}));
    if (afterSalesType !== 1) {
      throw new Error('当前仅已接通“退款”申请接口');
    }
    const refundAmountFen = Number.isFinite(Number(params?.refundAmountFen))
      ? Math.max(0, Math.round(Number(params.refundAmountFen)))
      : client._parseOrderPriceYuanToFen(params?.refundAmount || params?.amount);
    const maxRefundAmountFen = Number(info?.total_amount || 0);
    if (!refundAmountFen) {
      throw new Error('缺少退款金额');
    }
    if (maxRefundAmountFen > 0 && refundAmountFen > maxRefundAmountFen) {
      throw new Error('退款金额不能超过订单实付金额');
    }
    const requestReposeInfo = refundParsers.resolveRefundApplyReposeInfo(infoPayload, {
      ...params,
      reposeInfo: {
        ...(params?.reposeInfo && typeof params.reposeInfo === 'object' ? params.reposeInfo : {}),
        mobile: params?.reposeInfo?.mobile ?? info?.mobile ?? info?.phone ?? shopProfile?.mobile ?? null,
      },
    });
    const requestBody = {
      order_sn: normalizedOrderSn,
      after_sales_type: afterSalesType,
      user_ship_status: refundParsers.normalizeRefundApplyShipStatus(params?.userShipStatus || params?.user_ship_status || params?.receiptStatus),
      question_type: refundParsers.resolveRefundApplyQuestionType(params),
      refund_amount: refundAmountFen,
      reposeInfo: requestReposeInfo,
      message: String(params?.message || '').trim(),
      manualEditedNote: Boolean(params?.manualEditedNote),
      send_card_before_message: refundParsers.normalizeRefundApplyFlag(info?.send_card_before_message, true),
    };
    if (!requestBody.message && refundParsers.normalizeRefundApplyFlag(info?.need_show_message_box, false)) {
      throw new Error('缺少留言内容');
    }
    client._log('[API] 提交申请售后', {
      orderSn: normalizedOrderSn,
      afterSalesType: requestBody.after_sales_type,
      questionType: requestBody.question_type,
      refundAmountFen,
      userShipStatus: requestBody.user_ship_status,
      hasMessage: !!requestBody.message,
    });
    const sentAtMs = Date.now();
    const payload = await this.requestRefundApplyApi('/plateau/message/ask_refund_apply/send', requestBody);
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      const error = new Error(businessError.message);
      error.errorCode = businessError.code;
      error.payload = payload;
      throw error;
    }
    const sessionRef = params.session || params.sessionId || normalizedOrderSn;
    const conversationConfirm = sessionRef
      ? await this.confirmRefundApplyConversationMessage(sessionRef, {
          sentAtMs,
          expectedText: requestBody.message,
        }).catch(() => ({ confirmed: false }))
      : { confirmed: false };
    return {
      success: true,
      orderSn: normalizedOrderSn,
      afterSalesType: requestBody.after_sales_type,
      questionType: requestBody.question_type,
      refundAmountFen,
      requestBody: client._cloneJson(requestBody),
      reposeInfo: client._cloneJson(requestReposeInfo),
      response: payload,
      info: client._cloneJson(info),
      messageConfirmed: !!conversationConfirm.confirmed,
      confirmedMessageId: conversationConfirm.messageId || '',
      confirmedMessageText: conversationConfirm.content || '',
    };
  }
}

module.exports = { RefundOrdersModule };
