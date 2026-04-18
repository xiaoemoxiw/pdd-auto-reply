'use strict';

// 侧栏订单业务模块。覆盖三个 tab：personal（个人订单）、aftersale（售后）、
// pending（店铺待支付）。包含订单卡片归一化、补偿信息合并、售后状态拼接、
// 抓包/页面 API 兜底等所有跟侧栏订单相关的逻辑。模块本身不持有状态，所有
// 依赖通过构造函数注入的 PddApiClient 实例访问。

class SideOrdersModule {
  constructor(client) {
    this.client = client;
  }

  formatDateTime(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const timestamp = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}`;
  }

  buildSources(item = {}, fallback = {}) {
    return [
      item,
      item?.raw,
      item?.orderGoodsList,
      item?.order_goods_list,
      item?.goods_info,
      item?.goodsInfo,
      item?.goods,
      item?.order_info,
      item?.orderInfo,
      item?.afterSalesInfo,
      item?.after_sales_info,
      item?.compensate,
      item?.compensateInfo,
      item?.pendingCompensate,
      item?.raw?.afterSalesInfo,
      item?.raw?.after_sales_info,
      item?.raw?.compensate,
      item?.raw?.compensateInfo,
      item?.raw?.pendingCompensate,
      fallback?.goodsInfo,
      fallback?.raw?.goods_info,
      fallback?.raw?.goods,
      fallback?.raw,
      fallback,
    ].filter(Boolean);
  }

  resolveHeadline(tab = 'personal', sources = []) {
    const client = this.client;
    const afterSalesStatus = client._pickDisplayAfterSalesStatus(sources);
    const orderStatusText = client._pickRefundText(sources, [
      'orderStatusStr',
      'order_status_str',
      'order_status_desc',
      'order_status_text',
      'statusDesc',
      'status_desc',
      'statusText',
      'status_text',
      'shippingStatusText',
      'shipping_status_text',
      'shippingStatus',
      'shipping_status',
    ]);
    const compensateText = client._pickRefundText(sources, [
      'pendingCompensateText',
      'pending_compensate_text',
      'detail',
      'text',
      'desc',
    ]);
    if (tab === 'aftersale') {
      return client._mergeSideOrderStatusTexts(orderStatusText, afterSalesStatus) || afterSalesStatus || orderStatusText || '售后处理中';
    }
    if (tab === 'pending') {
      return [orderStatusText, compensateText].filter(Boolean).join('，') || orderStatusText || '店铺待支付';
    }
    return client._mergeSideOrderStatusTexts(orderStatusText, afterSalesStatus) || orderStatusText || '订单状态待确认';
  }

  isPendingLikeOrder(sources = []) {
    const client = this.client;
    const mergedStatusText = [
      this.resolveHeadline('personal', sources),
      client._pickRefundText(sources, [
        'orderStatusStr',
        'order_status_str',
        'order_status_desc',
        'order_status_text',
        'statusDesc',
        'status_desc',
        'statusText',
        'status_text',
        'shippingStatusText',
        'shipping_status_text',
        'payStatusDesc',
        'pay_status_desc',
        'payStatusText',
        'pay_status_text',
      ]),
    ].filter(Boolean).join(' ').replace(/\s+/g, '');
    return /(待支付|待付款|未支付|未付款|付款中|待成团|未成团)/.test(mergedStatusText);
  }

  buildMetaRows(tab = 'personal', sources = []) {
    const client = this.client;
    const rows = [];
    const orderTimeText = this.formatDateTime(client._pickRefundNumber(sources, ['orderTime', 'order_time', 'createdAt', 'created_at']));
    const afterSalesStatus = client._pickDisplayAfterSalesStatus(sources);
    const compensateText = client._pickRefundText(sources, [
      'pendingCompensateText',
      'pending_compensate_text',
      'detail',
      'text',
      'desc',
    ]);
    const refundShippingBenefitText = client._resolveRefundShippingBenefitText(sources);
    const shippingInfo = client._resolveRefundOrderShippingInfo(sources);
    const showRefundShippingAfterOrderTime = tab === 'personal' && refundShippingBenefitText;
    if (orderTimeText) {
      rows.push({ label: '下单时间', value: orderTimeText });
    }
    if (showRefundShippingAfterOrderTime) {
      rows.push({ label: '退货包运费', value: refundShippingBenefitText });
    }
    if (afterSalesStatus) {
      rows.push({ label: '售后状态', value: afterSalesStatus });
    }
    if (tab === 'pending' && compensateText) {
      rows.push({ label: '待支付说明', value: compensateText });
    } else if (!showRefundShippingAfterOrderTime && refundShippingBenefitText) {
      rows.push({ label: '退货包运费', value: refundShippingBenefitText });
    }
    if (shippingInfo.shippingStatusText) {
      rows.push({ label: '物流状态', value: shippingInfo.shippingStatusText });
    } else if (shippingInfo.trackingNo) {
      rows.push({ label: '物流单号', value: shippingInfo.trackingNo });
    }
    return rows.slice(0, 4);
  }

  formatAmount(value, { negative = false } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return '';
    return `${negative ? '-' : ''}¥${(numeric / 100).toFixed(2)}`;
  }

  resolveDiscountText(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of ['merchantDiscount', 'discountAmount', 'totalDiscount']) {
        if (source[key] === undefined || source[key] === null || source[key] === '') continue;
        const numeric = Number(source[key]);
        if (Number.isFinite(numeric) && numeric >= 0) {
          return this.formatAmount(numeric, { negative: true });
        }
      }
    }
    return '-¥0.00';
  }

  resolveManualPriceInfo(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const manualDiscount = Number(
        source.manualDiscount
        ?? source.manual_discount
        ?? source.goodsDiscount
        ?? source.goods_discount
        ?? ''
      );
      const orderAmount = Number(
        source.orderAmount
        ?? source.order_amount
        ?? source.pay_amount
        ?? source.amount
        ?? ''
      );
      const shippingAmount = Number(
        source.shippingAmount
        ?? source.shipping_amount
        ?? 0
      );
      if (!Number.isFinite(manualDiscount) || manualDiscount <= 0) continue;
      if (!Number.isFinite(orderAmount) || orderAmount < 0) continue;
      const originalAmount = Math.max(0, orderAmount + manualDiscount);
      const discount = originalAmount > 0
        ? Number(((orderAmount / originalAmount) * 10).toFixed(2))
        : 0;
      return {
        applied: true,
        originalAmount,
        currentAmount: Math.max(0, orderAmount),
        discountAmount: Math.max(0, manualDiscount),
        shippingFee: Math.max(0, shippingAmount),
        discount,
      };
    }
    return {
      applied: false,
      originalAmount: 0,
      currentAmount: 0,
      discountAmount: 0,
      shippingFee: 0,
      discount: 0,
    };
  }

  resolvePendingCountdown(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const rawOrderTime = source.orderTime ?? source.order_time ?? source.createdAt ?? source.created_at;
      const numeric = Number(rawOrderTime);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      const orderTimeMs = numeric > 1e12 ? numeric : numeric * 1000;
      const countdownEndTime = orderTimeMs + 24 * 60 * 60 * 1000;
      const remainMs = Math.max(0, countdownEndTime - Date.now());
      const totalSeconds = Math.floor(remainMs / 1000);
      const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      return {
        countdownEndTime,
        countdownText: `${hours}:${minutes}:${seconds}`,
      };
    }
    return {
      countdownEndTime: 0,
      countdownText: '',
    };
  }

  buildSummaryRows(tab = 'personal', sources = [], amountText = '') {
    const rows = [];
    rows.push({
      label: '店铺优惠抵扣',
      value: this.resolveDiscountText(sources),
      tone: 'muted',
    });
    if (amountText) {
      rows.push({
        label: tab === 'pending' ? '待支付金额' : '实收',
        value: amountText,
        tone: 'danger',
      });
    }
    return rows.slice(0, 2);
  }

  shouldShowAddressAction(tab = 'personal', sources = []) {
    if (tab !== 'personal') return false;
    const client = this.client;
    const statusText = [
      this.resolveHeadline(tab, sources),
      client._pickRefundText(sources, [
        'orderStatusStr',
        'order_status_str',
        'order_status_desc',
        'order_status_text',
        'statusDesc',
        'status_desc',
        'statusText',
        'status_text',
      ]),
    ].filter(Boolean).join(' ');
    return /待发货|已发货/.test(statusText);
  }

  resolveAddressInfo(sources = []) {
    const client = this.client;
    const receiverName = client._pickRefundText(sources, [
      'receiverName',
      'receiver_name',
      'consignee',
      'consigneeName',
      'consignee_name',
      'userName',
      'user_name',
      'name',
    ]);
    const receiverPhone = client._pickRefundText(sources, [
      'receiverMobile',
      'receiver_mobile',
      'receiverPhone',
      'receiver_phone',
      'mobile',
      'phone',
      'tel',
      'telephone',
    ]);
    const areaParts = [
      client._pickRefundText(sources, ['provinceName', 'province_name']),
      client._pickRefundText(sources, ['cityName', 'city_name']),
      client._pickRefundText(sources, ['districtName', 'district_name']),
      client._pickRefundText(sources, ['townName', 'town_name']),
      client._pickRefundText(sources, ['streetName', 'street_name']),
    ].filter(Boolean);
    const areaText = areaParts.filter((part, index) => areaParts.indexOf(part) === index).join('');
    const detailText = client._pickRefundText(sources, [
      'address',
      'addressDetail',
      'address_detail',
      'detailAddress',
      'detail_address',
      'receiverAddress',
      'receiver_address',
    ]);
    const addressText = [areaText, detailText].filter(Boolean).join('');
    const fullText = [
      receiverName ? `收货人：${receiverName}` : '',
      receiverPhone ? `联系电话：${receiverPhone}` : '',
      addressText ? `收货地址：${addressText}` : '',
    ].filter(Boolean).join('\n');
    return {
      receiverName,
      receiverPhone,
      addressText,
      fullText,
    };
  }

  buildActionTags(tab = 'personal', sources = []) {
    const client = this.client;
    const tags = [];
    if (tab === 'pending' || (tab === 'personal' && this.isPendingLikeOrder(sources))) {
      const manualPriceInfo = this.resolveManualPriceInfo(sources);
      tags.push('备注');
      if (!manualPriceInfo.applied) {
        tags.push('改价');
      }
      return tags;
    }
    const shippingInfo = client._resolveRefundOrderShippingInfo(sources);
    const manualPriceInfo = this.resolveManualPriceInfo(sources);
    if (this.shouldShowAddressAction(tab, sources)) {
      tags.push('地址');
    }
    tags.push('备注');
    if (tab === 'personal') {
      tags.push('小额打款');
    }
    if (shippingInfo.isShipped || shippingInfo.trackingNo) {
      tags.push('物流信息');
    }
    if (client._pickRefundBoolean(sources, ['showGoodsInstructEntrance', 'show_goods_instruct_entrance'])) {
      tags.push('查看说明书');
    }
    if (client._pickRefundBoolean(sources, ['showExtraPackageTool', 'show_extra_package_tool'])) {
      tags.push('新增额外包裹');
    }
    const statusText = client._pickRefundText(sources, ['orderStatusStr', 'order_status_str']);
    if (!manualPriceInfo.applied && (tab === 'pending' || /待支付/.test(statusText))) {
      tags.push('改价');
    }
    return [...new Set(tags)].slice(0, 6);
  }

  normalizeCard(item = {}, fallback = {}, tab = 'personal', index = 0) {
    const client = this.client;
    const sources = this.buildSources(item, fallback);
    const manualPriceInfo = this.resolveManualPriceInfo(sources);
    const addressInfo = this.resolveAddressInfo(sources);
    const goodsInfo = Array.isArray(item?.orderGoodsList)
      ? (item.orderGoodsList[0] || {})
      : (item?.orderGoodsList || item?.goodsInfo || item?.goods_info || item?.raw?.orderGoodsList || {});
    const orderId = client._pickRefundText(sources, ['order_id', 'order_sn', 'orderSn', 'parent_order_sn', 'mall_order_sn', 'orderId'])
      || String(fallback?.orderId || '').trim();
    const title = client._pickRefundText(sources, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'item_title', 'itemTitle', 'title'])
      || fallback?.title
      || `订单 ${index + 1}`;
    const imageUrl = client._pickRefundText(sources, ['imageUrl', 'image_url', 'thumb_url', 'hd_thumb_url', 'goods_thumb_url', 'thumbUrl', 'hdThumbUrl', 'goodsThumbUrl', 'pic_url']);
    const amountText = client._normalizeRefundAmountByKeys(sources, ['order_amount', 'orderAmount', 'pay_amount', 'refund_amount', 'amount', 'order_price', 'price'])
      || client._pickRefundText(sources, ['priceText', 'price_text'])
      || client._normalizeGoodsPrice(client._pickRefundNumber(sources, ['goodsPrice', 'min_price', 'group_price']))
      || '';
    const quantityValue = client._pickRefundText(
      [goodsInfo, ...sources],
      ['goodsNumber', 'quantity', 'num', 'count', 'goods_count', 'buy_num', 'buyNum'],
    );
    const specText = client._pickRefundText(
      [goodsInfo, ...sources],
      ['spec', 'specText', 'spec_text', 'sku_spec', 'skuSpec', 'spec_desc', 'specDesc', 'sub_name', 'subName'],
    );
    const normalizedQuantity = String(quantityValue || '').replace(/^x/i, '').trim();
    const detailText = client._pickRefundText([item, goodsInfo, ...sources], ['detailText', 'detail_text']) || (normalizedQuantity && specText
      ? `${specText} x${normalizedQuantity}`
      : (specText || (normalizedQuantity ? `x${normalizedQuantity}` : '所拍规格待确认')));
    const pendingCountdown = tab === 'pending'
      ? this.resolvePendingCountdown(sources)
      : { countdownEndTime: 0, countdownText: '' };
    const remarkNote = client._extractOrderRemarkText(client._pickRefundText(sources, ['note']));
    const remarkTag = client._normalizeOrderRemarkTag(client._pickRefundText(sources, ['tag']));
    const remarkTagName = client._pickRefundText(sources, ['tagName', 'tag_name']);
    const cachedRemark = client._getOrderRemarkCache(orderId);
    if (orderId && (remarkNote || remarkTag || remarkTagName)) {
      client._setOrderRemarkCache(orderId, {
        note: remarkNote,
        tag: remarkTag,
        tagName: remarkTagName,
      });
    }
    return {
      key: `${tab}::${orderId || 'order'}::${index}`,
      orderId: orderId || '-',
      title,
      imageUrl,
      detailText,
      amountText,
      headline: this.resolveHeadline(tab, sources),
      receiverName: addressInfo.receiverName,
      receiverPhone: addressInfo.receiverPhone,
      addressText: addressInfo.addressText,
      addressFullText: addressInfo.fullText,
      countdownEndTime: pendingCountdown.countdownEndTime,
      countdownText: pendingCountdown.countdownText,
      metaRows: this.buildMetaRows(tab, sources),
      summaryRows: this.buildSummaryRows(tab, sources, amountText),
      note: remarkNote || cachedRemark?.note || '',
      noteTag: remarkTag || cachedRemark?.tag || '',
      noteTagName: remarkTagName || cachedRemark?.tagName || '',
      actionTags: this.buildActionTags(tab, sources),
      manualPriceApplied: manualPriceInfo.applied,
      manualPriceOriginalAmount: manualPriceInfo.originalAmount / 100,
      manualPriceDiscount: manualPriceInfo.discount,
      manualPriceDiscountAmount: manualPriceInfo.discountAmount / 100,
      manualPriceShippingFee: manualPriceInfo.shippingFee / 100,
    };
  }

  async extractPendingOrdersFromPageApis(sessionMeta = {}) {
    const client = this.client;
    const uid = client._getRefundOrderUid(sessionMeta);
    if (!uid) return null;
    const pendingPayload = await client._requestRefundOrderPageApi('/latitude/order/userUnfinishedOrder', {
      pageNo: 1,
      pageSize: 50,
      uid,
    });
    const pendingOrders = Array.isArray(pendingPayload?.result?.orders) ? pendingPayload.result.orders : [];
    if (!pendingOrders.length) return [];
    const compensateMap = {};
    const validOrderSns = [...new Set(pendingOrders.map(item => String(item?.orderSn || item?.orderId || '').trim()).filter(Boolean))].slice(0, 20);
    await Promise.all(validOrderSns.map(async orderSn => {
      try {
        const payload = await client._requestRefundOrderPageApi('/latitude/order/orderCompensate', { orderSn });
        const compensatePatch = this.buildCompensatePatch(payload?.result || {});
        if (Object.keys(compensatePatch).length) {
          compensateMap[orderSn] = compensatePatch;
        }
      } catch (error) {
        client._log('[API] 店铺待支付补充查询失败', { orderSn, message: error.message });
      }
    }));
    return client._dedupeRefundOrders(pendingOrders.map(item => {
      const orderSn = String(item?.orderSn || item?.orderId || '').trim();
      return {
        ...(item || {}),
        ...(compensateMap[orderSn] || {}),
      };
    }), sessionMeta);
  }

  getOrderTrafficEntries(urlPart = '', sessionMeta = {}) {
    const client = this.client;
    const uid = client._getRefundOrderUid(sessionMeta);
    return client._getApiTrafficEntries()
      .filter(entry => String(entry?.url || '').includes(urlPart))
      .filter(entry => {
        if (!uid) return true;
        const body = typeof entry?.requestBody === 'string' ? client._safeParseJson(entry.requestBody) : entry?.requestBody;
        const requestUid = String(body?.uid || body?.data?.uid || '').trim();
        return !requestUid || requestUid === uid;
      });
  }

  buildCompensatePatch(result = {}) {
    if (!result || typeof result !== 'object') return {};
    const text = this.client._pickRefundText([result], ['detail', 'text', 'desc']);
    const statusKeys = ['status', 'compensateStatus', 'compensate_status'];
    const hasStatusKey = statusKeys.some(key => Object.prototype.hasOwnProperty.call(result, key));
    const status = result.status ?? result.compensateStatus ?? result.compensate_status;
    const compensate = {};
    if (hasStatusKey) {
      compensate.status = status ?? null;
    } else if (status !== undefined && status !== null && status !== '') {
      compensate.status = status;
    }
    if (text) {
      compensate.text = text;
    }
    if (!Object.keys(compensate).length) return {};
    return {
      pendingCompensateText: text || '',
      pendingCompensate: { ...compensate },
      compensate,
    };
  }

  mergeCompensatePatch(order = {}, patch = {}) {
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
      return order;
    }
    const existingCompensate = order?.compensate && typeof order.compensate === 'object'
      ? order.compensate
      : null;
    const existingPendingCompensate = order?.pendingCompensate && typeof order.pendingCompensate === 'object'
      ? order.pendingCompensate
      : null;
    const mergedCompensate = (patch.compensate && typeof patch.compensate === 'object') || existingCompensate
      ? {
          ...(patch.compensate && typeof patch.compensate === 'object' ? patch.compensate : {}),
          ...(existingCompensate || {}),
        }
      : undefined;
    const mergedPendingCompensate = (patch.pendingCompensate && typeof patch.pendingCompensate === 'object') || existingPendingCompensate
      ? {
          ...(patch.pendingCompensate && typeof patch.pendingCompensate === 'object' ? patch.pendingCompensate : {}),
          ...(existingPendingCompensate || {}),
        }
      : undefined;
    return {
      ...(order || {}),
      ...(patch || {}),
      pendingCompensateText: order?.pendingCompensateText || patch.pendingCompensateText || '',
      ...(mergedPendingCompensate ? { pendingCompensate: mergedPendingCompensate } : {}),
      ...(mergedCompensate ? { compensate: mergedCompensate } : {}),
    };
  }

  extractOrderCompensateMapFromTraffic(sessionMeta = {}) {
    const client = this.client;
    const compensateEntries = this.getOrderTrafficEntries('/latitude/order/orderCompensate', sessionMeta);
    const compensateMap = {};
    for (let i = compensateEntries.length - 1; i >= 0; i -= 1) {
      const requestBody = typeof compensateEntries[i]?.requestBody === 'string'
        ? client._safeParseJson(compensateEntries[i].requestBody)
        : compensateEntries[i]?.requestBody;
      const responseBody = compensateEntries[i]?.responseBody && typeof compensateEntries[i].responseBody === 'object'
        ? compensateEntries[i].responseBody
        : client._safeParseJson(compensateEntries[i]?.responseBody);
      const orderSn = String(requestBody?.orderSn || '').trim();
      const compensatePatch = this.buildCompensatePatch(responseBody?.result || {});
      if (orderSn && Object.keys(compensatePatch).length && !compensateMap[orderSn]) {
        compensateMap[orderSn] = compensatePatch;
      }
    }
    return compensateMap;
  }

  attachOrderCompensateFromTraffic(orders = [], sessionMeta = {}) {
    const list = Array.isArray(orders) ? orders : [];
    if (!list.length) return list;
    const compensateMap = this.extractOrderCompensateMapFromTraffic(sessionMeta);
    if (!Object.keys(compensateMap).length) return list;
    return list.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || order?.order_sn || '').trim();
      if (!orderSn || !compensateMap[orderSn]) return order;
      return this.mergeCompensatePatch(order, compensateMap[orderSn]);
    });
  }

  hasAfterSalesContext(sources = []) {
    const client = this.client;
    if (client._pickDisplayAfterSalesStatus(sources)) return true;
    const afterSalesId = client._pickRefundText(sources, [
      'afterSalesSn',
      'after_sales_sn',
      'refundSn',
      'refund_sn',
      'refundId',
      'refund_id',
      'aftersaleId',
      'aftersale_id',
      'id',
    ]);
    return !!afterSalesId;
  }

  extractAfterSalesStatusMapFromTraffic(orderSns = [], sessionMeta = {}) {
    const client = this.client;
    const validOrderSns = [...new Set((Array.isArray(orderSns) ? orderSns : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!validOrderSns.length) return {};
    const targetSet = new Set(validOrderSns);
    const detailMap = {};
    const entries = this.getOrderTrafficEntries('/mercury/chat/afterSales/queryList', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : client._safeParseJson(entries[i]?.responseBody);
      const currentMap = client._extractAfterSalesDetailMapFromPayload(responseBody);
      Object.entries(currentMap).forEach(([orderSn, detail]) => {
        if (!targetSet.has(String(orderSn)) || detailMap[String(orderSn)]) return;
        detailMap[String(orderSn)] = detail;
      });
      if (validOrderSns.every(orderSn => detailMap[orderSn])) break;
    }
    return detailMap;
  }

  attachAfterSalesStatusFromTraffic(orders = [], sessionMeta = {}) {
    const orderSns = orders.map(item => String(item?.orderId || item?.orderSn || '').trim()).filter(Boolean);
    if (!orderSns.length) return orders;
    const detailMap = this.extractAfterSalesStatusMapFromTraffic(orderSns, sessionMeta);
    return orders.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || '').trim();
      const detail = detailMap[orderSn] && typeof detailMap[orderSn] === 'object'
        ? detailMap[orderSn]
        : {};
      return {
        ...order,
        ...detail,
        afterSalesStatus: order?.afterSalesStatus || detail.afterSalesStatus || '',
      };
    });
  }

  extractPersonalOrdersFromTraffic(sessionMeta = {}) {
    const client = this.client;
    const entries = this.getOrderTrafficEntries('/latitude/order/userAllOrder', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : client._safeParseJson(entries[i]?.responseBody);
      const orders = Array.isArray(responseBody?.result?.orders) ? responseBody.result.orders : [];
      if (!orders.length) continue;
      return this.attachOrderCompensateFromTraffic(
        this.attachAfterSalesStatusFromTraffic(client._dedupeRefundOrders(orders, sessionMeta), sessionMeta),
        sessionMeta,
      );
    }
    return [];
  }

  extractAftersaleOrdersFromTraffic(sessionMeta = {}) {
    const client = this.client;
    const entries = this.getOrderTrafficEntries('/latitude/order/userRefundOrder', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : client._safeParseJson(entries[i]?.responseBody);
      const orders = Array.isArray(responseBody?.result?.orders) ? responseBody.result.orders : [];
      if (!orders.length) continue;
      return this.attachOrderCompensateFromTraffic(client._dedupeRefundOrders(orders, sessionMeta), sessionMeta);
    }
    return [];
  }

  extractPendingOrdersFromTraffic(sessionMeta = {}) {
    const client = this.client;
    const entries = this.getOrderTrafficEntries('/latitude/order/userUnfinishedOrder', sessionMeta);
    let pendingOrders = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : client._safeParseJson(entries[i]?.responseBody);
      const orders = Array.isArray(responseBody?.result?.orders) ? responseBody.result.orders : [];
      if (!orders.length) continue;
      pendingOrders = orders;
      break;
    }
    if (!pendingOrders.length) return [];
    return this.attachOrderCompensateFromTraffic(client._dedupeRefundOrders(pendingOrders, sessionMeta), sessionMeta);
  }

  async getSideOrders(sessionRef, tab = 'personal') {
    const client = this.client;
    const sessionMeta = client._normalizeSessionMeta(sessionRef);
    const normalizedTab = ['personal', 'aftersale', 'pending'].includes(String(tab || ''))
      ? String(tab)
      : 'personal';
    if (normalizedTab === 'pending') {
      let pendingOrders = [];
      try {
        const pagePendingOrders = await this.extractPendingOrdersFromPageApis(sessionMeta);
        if (Array.isArray(pagePendingOrders)) {
          pendingOrders = pagePendingOrders;
        }
      } catch (error) {
        client._log('[API] 侧栏待支付接口查询失败', { message: error.message });
      }
      if (!pendingOrders.length) {
        pendingOrders = this.extractPendingOrdersFromTraffic(sessionMeta);
      }
      if (!Array.isArray(pendingOrders) || !pendingOrders.length) return [];
      return this.attachOrderCompensateFromTraffic(pendingOrders, sessionMeta)
        .map((item, index) => this.normalizeCard(item, sessionMeta, normalizedTab, index));
    }
    if (normalizedTab === 'aftersale') {
      let aftersaleOrders = [];
      try {
        const pageOrders = await client._extractAftersaleOrdersFromPageApis(sessionMeta);
        if (Array.isArray(pageOrders)) {
          aftersaleOrders = pageOrders;
        }
      } catch (error) {
        client._log('[API] 侧栏售后订单接口查询失败', { message: error.message });
      }
      if (!aftersaleOrders.length) {
        aftersaleOrders = this.extractAftersaleOrdersFromTraffic(sessionMeta);
      }
      if (!aftersaleOrders.length) {
        try {
          const fallbackOrders = await client._extractRefundOrdersFromPageApis(sessionMeta, {
            eligibleOnly: false,
          });
          if (Array.isArray(fallbackOrders)) {
            aftersaleOrders = fallbackOrders;
          }
        } catch (error) {
          client._log('[API] 侧栏售后订单回退失败', { message: error.message });
        }
      }
      aftersaleOrders = this.attachOrderCompensateFromTraffic(aftersaleOrders, sessionMeta);
      return aftersaleOrders
        .filter(item => this.hasAfterSalesContext(this.buildSources(item, sessionMeta)))
        .map((item, index) => this.normalizeCard(item, sessionMeta, normalizedTab, index));
    }
    let orders = [];
    try {
      const pageOrders = await client._extractRefundOrdersFromPageApis(sessionMeta, {
        eligibleOnly: false,
      });
      if (Array.isArray(pageOrders)) {
        orders = pageOrders;
      }
    } catch (error) {
      client._log('[API] 侧栏订单接口查询失败', { tab: normalizedTab, message: error.message });
    }
    if (!orders.length) {
      orders = this.extractPersonalOrdersFromTraffic(sessionMeta);
    }
    if (!orders.length) {
      try {
        orders = await client.getRefundOrders(sessionMeta);
      } catch (error) {
        client._log('[API] 侧栏订单回退失败', { tab: normalizedTab, message: error.message });
      }
    }
    orders = this.attachOrderCompensateFromTraffic(orders, sessionMeta);
    const filtered = normalizedTab === 'aftersale'
      ? orders.filter(item => this.hasAfterSalesContext(this.buildSources(item, sessionMeta)))
      : orders;
    return filtered.map((item, index) => this.normalizeCard(item, sessionMeta, normalizedTab, index));
  }
}

module.exports = { SideOrdersModule };
