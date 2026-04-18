// 退款 / 售后 / 售后申请相关的纯函数集合：从混杂的 PDD 业务字段里挑出
// 文本/数字/布尔候选、识别发货状态、退货包运费状态、申请售后请求体构造等。
// 函数都不依赖运行时上下文，业务侧（refund-orders 模块/PddApiClient facade）通过
// thin wrapper 调用。

const goodsParsers = require('./goods-parsers');
const commonParsers = require('./common-parsers');

function normalizeRefundAmountByKeys(sources = [], keys = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const rawValue = source[key];
      if (rawValue === undefined || rawValue === null || rawValue === '') continue;
      if (typeof rawValue === 'string') {
        const text = rawValue.trim();
        if (!text) continue;
        if (text.includes('¥')) return text;
        if (text.includes('.')) {
          const decimal = Number(text);
          if (Number.isFinite(decimal) && decimal > 0) return `¥${decimal.toFixed(2)}`;
        }
        const integer = Number(text);
        if (Number.isFinite(integer) && integer > 0) return `¥${(integer / 100).toFixed(2)}`;
        continue;
      }
      const numeric = Number(rawValue);
      if (Number.isFinite(numeric) && numeric > 0) {
        return `¥${(numeric / 100).toFixed(2)}`;
      }
    }
  }
  return '';
}

function pickRefundText(sources = [], keys = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return goodsParsers.decodeGoodsText(value);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return '';
}

function pickRefundNumber(sources = [], keys = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const numeric = Number(source[key]);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
  }
  return 0;
}

function pickRefundBoolean(sources = [], keys = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value > 0;
      const text = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes', 'y', 'shipped', 'delivered'].includes(text)) return true;
      if (['0', 'false', 'no', 'n', 'unshipped', 'pending'].includes(text)) return false;
    }
  }
  return null;
}

function normalizeSystemNoticeComparableText(text = '') {
  return String(text || '')
    .trim()
    .replace(/^[\[【]\s*/, '')
    .replace(/\s*[\]】]$/, '')
    .trim();
}

function isRefundDefaultSellerNoteText(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /帮您申请退款，您看可以吗.*点击下方卡片按钮/,
    /帮您申请退货退款，您看可以吗.*点击下方卡片按钮/,
    /帮您申请补寄，您看可以吗.*点击下方卡片按钮/,
  ].some(pattern => pattern.test(source));
}

function isRefundPendingNoticeText(text = '') {
  return normalizeSystemNoticeComparableText(text) === '消费者已同意您发起的退款申请，请及时处理';
}

function isRefundSuccessNoticeText(text = '') {
  const normalized = normalizeSystemNoticeComparableText(text);
  return normalized === '退款成功通知' || normalized === '退款成功';
}

function resolveRefundOrderShippingInfo(sources = []) {
  const trackingNo = pickRefundText(sources, [
    'tracking_no',
    'trackingNo',
    'waybill_no',
    'waybillNo',
    'express_no',
    'expressNo',
    'express_number',
    'expressNumber',
    'logistics_no',
    'logisticsNo',
    'shipping_no',
    'shippingNo',
    'mail_no',
    'mailNo',
    'invoice_waybill_no',
  ]);
  const shippingStateText = pickRefundText(sources, [
    'refund_shipping_state',
    'shippingState',
    'shipping_state',
  ]);
  const shippingStatusText = pickRefundText(sources, [
    'order_status_desc',
    'order_status_text',
    'order_status_name',
    'order_status',
    'shipping_status_desc',
    'shipping_status_text',
    'shipping_status',
    'delivery_status_desc',
    'delivery_status_text',
    'delivery_status',
    'express_status_desc',
    'express_status_text',
    'express_status',
    'logistics_status_desc',
    'logistics_status_text',
    'logistics_status',
    'statusDesc',
    'status_desc',
  ]);
  const shippedFlag = pickRefundBoolean(sources, [
    'has_tracking_no',
    'hasTrackingNo',
    'has_waybill',
    'hasWaybill',
    'has_logistics',
    'hasLogistics',
    'has_express',
    'hasExpress',
    'has_shipping',
    'hasShipping',
    'is_shipped',
    'isShipped',
    'shipped',
  ]);
  const unshippedFlag = pickRefundBoolean(sources, [
    'unshipped',
    'is_unshipped',
    'isUnshipped',
    'wait_ship',
    'waitShip',
  ]);
  const mergedStatusText = `${shippingStateText} ${shippingStatusText}`.replace(/\s+/g, '');
  if (trackingNo) {
    return {
      shippingState: 'shipped',
      shippingStatusText: shippingStatusText || '已发货',
      trackingNo,
      isShipped: true,
    };
  }
  if (/^shipped$/i.test(shippingStateText) || shippingStateText === '已发货') {
    return {
      shippingState: 'shipped',
      shippingStatusText: shippingStatusText || shippingStateText || '已发货',
      trackingNo: '',
      isShipped: true,
    };
  }
  if (/^unshipped$/i.test(shippingStateText) || shippingStateText === '未发货') {
    return {
      shippingState: 'unshipped',
      shippingStatusText: shippingStatusText || shippingStateText || '未发货',
      trackingNo: '',
      isShipped: false,
    };
  }
  if (shippedFlag === true) {
    return {
      shippingState: 'shipped',
      shippingStatusText: shippingStatusText || '已发货',
      trackingNo: '',
      isShipped: true,
    };
  }
  if (unshippedFlag === true) {
    return {
      shippingState: 'unshipped',
      shippingStatusText: shippingStatusText || '未发货',
      trackingNo: '',
      isShipped: false,
    };
  }
  if (/(已发货|运输中|待收货|已签收|已收货|派送中|配送中|揽收|物流)/.test(mergedStatusText)) {
    return {
      shippingState: 'shipped',
      shippingStatusText: shippingStatusText || '已发货',
      trackingNo: '',
      isShipped: true,
    };
  }
  if (/(未发货|待发货|待揽收|待出库|待配送|未揽件)/.test(mergedStatusText)) {
    return {
      shippingState: 'unshipped',
      shippingStatusText: shippingStatusText || '未发货',
      trackingNo: '',
      isShipped: false,
    };
  }
  return {
    shippingState: '',
    shippingStatusText,
    trackingNo: '',
    isShipped: false,
  };
}

function resolveRefundOrderStatusText(sources = []) {
  return pickRefundText(sources, [
    'orderStatusStr',
    'order_status_str',
    'order_status_desc',
    'order_status_text',
    'order_status_name',
    'order_status',
    'statusDesc',
    'status_desc',
    'statusText',
    'status_text',
    'shippingStatusText',
    'shipping_status_text',
    'shippingStatus',
    'shipping_status',
    'payStatusDesc',
    'pay_status_desc',
    'payStatusText',
    'pay_status_text',
  ]);
}

function isRefundOrderEligible(order = {}) {
  const mergedStatusText = [
    order?.orderStatusText,
    order?.shippingStatusText,
    order?.shippingState,
  ].filter(Boolean).join(' ').replace(/\s+/g, '');
  if (!mergedStatusText) {
    return order?.shippingState === 'unshipped' || order?.shippingState === 'shipped';
  }
  if (/(待支付|待付款|未支付|未付款|付款中|待成团|未成团)/.test(mergedStatusText)) {
    return false;
  }
  if (/(已签收|已收货|交易成功|已完成|已关闭|已取消|退款成功|已退款|售后完成|退款中止)/.test(mergedStatusText)) {
    return false;
  }
  return /(待发货|未发货|待揽收|待出库|待配送|未揽件|待收货|已发货|运输中|派送中|配送中|揽收|物流)/.test(mergedStatusText)
    || order?.shippingState === 'unshipped'
    || order?.shippingState === 'shipped';
}

function filterEligibleRefundOrders(orders = []) {
  return (Array.isArray(orders) ? orders : []).filter(order => isRefundOrderEligible(order));
}

function normalizeRefundShippingBenefitStatus(value, { legacyGifted = false } = {}) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) return '未赠送';
    if (value === 1) return legacyGifted ? '已赠送' : '商家承担';
    if (value === 2) return '包运费';
    return String(value);
  }
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.toLowerCase();
  if (['0', 'false', 'no', 'n', 'unshipped', 'not_gifted', 'none', '未赠送'].includes(normalized)) {
    return '未赠送';
  }
  if (legacyGifted && ['1', 'true', 'yes', 'y', 'shipped', 'gifted', 'presented', '已赠送'].includes(normalized)) {
    return '已赠送';
  }
  if (['1', '商家承担'].includes(normalized)) {
    return '商家承担';
  }
  if (['2', '包运费'].includes(normalized)) {
    return '包运费';
  }
  if (['已赠送'].includes(normalized)) {
    return legacyGifted ? '已赠送' : text;
  }
  return text;
}

function resolveRefundShippingBenefitText(sources = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const compensateCandidates = [
      source.compensate,
      source.compensateInfo,
      source.pendingCompensate,
    ];
    for (const candidate of compensateCandidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const hasStatusKey = ['status', 'compensateStatus', 'compensate_status']
        .some(key => Object.prototype.hasOwnProperty.call(candidate, key));
      if (hasStatusKey && candidate.status === null) {
        return '未赠送';
      }
      if (hasStatusKey && candidate.compensateStatus === null) {
        return '未赠送';
      }
      if (hasStatusKey && candidate.compensate_status === null) {
        return '未赠送';
      }
      const statusText = normalizeRefundShippingBenefitStatus(
        candidate.status ?? candidate.compensateStatus ?? candidate.compensate_status,
      );
      if (statusText) return statusText;
      const directText = normalizeRefundShippingBenefitStatus(
        candidate.text ?? candidate.desc ?? candidate.note,
      );
      if (directText) return directText;
    }
    const tagLists = [
      source.workbenchOrderTagNew,
      source.workbench_order_tag_new,
      source.workbenchOrderTag,
      source.workbench_order_tag,
    ];
    for (const tagList of tagLists) {
      if (!Array.isArray(tagList) || !tagList.length) continue;
      for (const tag of tagList) {
        if (!tag || typeof tag !== 'object') continue;
        const labelText = String(tag.text ?? tag.label ?? tag.name ?? tag.desc ?? '').trim();
        const matched = /退货包运费|包运费/.test(labelText) || Number(tag.type) === 2;
        if (!matched) continue;
        const statusText = normalizeRefundShippingBenefitStatus(
          tag.status ?? tag.statusText ?? tag.status_text ?? tag.value,
        );
        if (statusText) return statusText;
      }
    }
  }
  const freightResponsibilityText = pickRefundText(sources, [
    'freightResponsibilityText',
    'freight_responsibility_text',
    'freightResponsibilityDesc',
    'freight_responsibility_desc',
    'freightResponsibility',
    'freight_responsibility',
  ]);
  const normalizedFreightResponsibilityText = normalizeRefundShippingBenefitStatus(freightResponsibilityText);
  if (normalizedFreightResponsibilityText) {
    return normalizedFreightResponsibilityText;
  }
  const rawText = pickRefundText(sources, [
    'refundShippingText',
    'refund_shipping_text',
    'refundShippingDesc',
    'refund_shipping_desc',
    'refundShippingStateDesc',
    'refund_shipping_state_desc',
    'refundShippingStatusDesc',
    'refund_shipping_status_desc',
    'refundShippingBenefitText',
    'refund_shipping_benefit_text',
    'refundShippingBenefitDesc',
    'refund_shipping_benefit_desc',
    'refundShippingBenefitStateDesc',
    'refund_shipping_benefit_state_desc',
    'refundShippingInsuranceText',
    'refund_shipping_insurance_text',
    'refundShippingInsuranceDesc',
    'refund_shipping_insurance_desc',
    'refundShippingInsuranceStateDesc',
    'refund_shipping_insurance_state_desc',
    'refundShippingInsuranceStatusDesc',
    'refund_shipping_insurance_status_desc',
    'refundShippingState',
    'refund_shipping_state',
    'refundShippingBenefit',
    'refund_shipping_benefit',
    'refundShippingInsurance',
    'refund_shipping_insurance',
  ]);
  const text = normalizeRefundShippingBenefitStatus(rawText, { legacyGifted: true });
  if (text) {
    return text;
  }
  const giftedFlag = pickRefundBoolean(sources, [
    'refundShippingBenefit',
    'refund_shipping_benefit',
    'refundShippingInsurance',
    'refund_shipping_insurance',
    'refundShippingGifted',
    'refund_shipping_gifted',
    'refundShippingInsured',
    'refund_shipping_insured',
    'hasRefundShippingBenefit',
    'has_refund_shipping_benefit',
    'hasRefundShippingInsurance',
    'has_refund_shipping_insurance',
  ]);
  if (giftedFlag === true) return '已赠送';
  if (giftedFlag === false) return '未赠送';
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (!key || value === undefined || value === null) continue;
      const keyText = String(key).toLowerCase();
      const freightResponsibilityMatched = /freight.*responsibility|responsibility.*freight|freight_responsibility/i.test(keyText);
      if (freightResponsibilityMatched) {
        const normalizedValue = normalizeRefundShippingBenefitStatus(value);
        if (normalizedValue) return normalizedValue;
      }
      const keyMatched = /(refund.*ship|ship.*refund|refund_shipping|shipping_refund)/i.test(keyText)
        && /(benefit|insurance|state|status|desc|text)/i.test(keyText);
      if (!keyMatched) continue;
      if (typeof value === 'boolean') {
        return value ? '已赠送' : '未赠送';
      }
      const normalizedValue = normalizeRefundShippingBenefitStatus(value, { legacyGifted: true });
      if (normalizedValue) return normalizedValue;
    }
  }
  return '';
}

function looksLikeRefundOrderNode(node = {}) {
  if (!node || typeof node !== 'object') return false;
  return [
    'order_id',
    'order_sn',
    'parent_order_sn',
    'mall_order_sn',
    'orderId',
  ].some(key => {
    const value = node[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

function collectRefundOrderNodes(node, bucket, visited, depth = 0) {
  if (!node || depth > 4) return;
  if (Array.isArray(node)) {
    node.slice(0, 30).forEach(item => collectRefundOrderNodes(item, bucket, visited, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);
  if (looksLikeRefundOrderNode(node)) {
    bucket.push(node);
  }
  Object.values(node).forEach(value => {
    if (value && typeof value === 'object') {
      collectRefundOrderNodes(value, bucket, visited, depth + 1);
    }
  });
}

function normalizeRefundOrder(item = {}, fallback = {}, index = 0) {
  const sources = [
    item,
    item?.raw,
    item?.orderGoodsList,
    item?.order_goods_list,
    item?.goods_info,
    item?.goodsInfo,
    item?.goods,
    item?.order_info,
    item?.orderInfo,
    item?.logistics_info,
    item?.logisticsInfo,
    item?.logistics,
    item?.delivery_info,
    item?.deliveryInfo,
    item?.delivery,
    item?.express_info,
    item?.expressInfo,
    item?.express,
    item?.shipping_info,
    item?.shippingInfo,
    item?.shipping,
    item?.transport_info,
    item?.transportInfo,
    item?.transport,
    item?.raw?.logistics_info,
    item?.raw?.logisticsInfo,
    item?.raw?.logistics,
    item?.raw?.delivery_info,
    item?.raw?.deliveryInfo,
    item?.raw?.delivery,
    item?.raw?.express_info,
    item?.raw?.expressInfo,
    item?.raw?.express,
    item?.raw?.shipping_info,
    item?.raw?.shippingInfo,
    item?.raw?.shipping,
    fallback?.goodsInfo,
    fallback?.raw?.goods_info,
    fallback?.raw?.goods,
    fallback?.raw,
    fallback,
  ].filter(Boolean);
  const orderId = pickRefundText(sources, ['order_id', 'order_sn', 'orderSn', 'parent_order_sn', 'mall_order_sn', 'orderId'])
    || String(fallback?.orderId || '').trim();
  const title = pickRefundText(sources, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'item_title', 'itemTitle', 'goodsName', 'title'])
    || fallback?.title
    || `订单 ${index + 1}`;
  const imageUrl = pickRefundText(sources, ['imageUrl', 'image_url', 'thumb_url', 'hd_thumb_url', 'goods_thumb_url', 'thumbUrl', 'hdThumbUrl', 'goodsThumbUrl', 'pic_url', 'thumbUrl']);
  const amountText = normalizeRefundAmountByKeys(sources, ['order_amount', 'orderAmount', 'pay_amount', 'refund_amount', 'amount', 'order_price', 'price'])
    || pickRefundText(sources, ['priceText', 'price_text'])
    || goodsParsers.normalizeGoodsPrice(pickRefundNumber(sources, ['goodsPrice', 'min_price', 'group_price']))
    || '待确认';
  const quantityValue = pickRefundText(sources, ['quantity', 'num', 'count', 'goods_count', 'goodsNumber', 'buy_num', 'buyNum']);
  const specText = pickRefundText(sources, ['specText', 'spec_text', 'spec', 'sku_spec', 'skuSpec', 'spec_desc', 'specDesc', 'sub_name', 'subName']);
  const normalizedQuantity = String(quantityValue || '').replace(/^x/i, '').trim();
  const detailText = normalizedQuantity && specText
    ? `${specText} x${normalizedQuantity}`
    : (specText || (normalizedQuantity ? `x${normalizedQuantity}` : '所拍规格待确认'));
  const shippingInfo = resolveRefundOrderShippingInfo(sources);
  const orderStatusText = resolveRefundOrderStatusText(sources);
  return {
    key: `${orderId || 'order'}::${title}::${index}`,
    orderId: orderId || '-',
    title,
    imageUrl,
    amountText,
    detailText,
    orderStatusText,
    trackingNo: shippingInfo.trackingNo,
    shippingState: shippingInfo.shippingState,
    shippingStatusText: shippingInfo.shippingStatusText,
    isShipped: shippingInfo.isShipped,
    raw: item,
  };
}

function dedupeRefundOrders(list = [], fallback = {}) {
  const deduped = [];
  const seen = new Set();
  list.forEach((item, index) => {
    const normalized = normalizeRefundOrder(item, fallback, index);
    if (!normalized.orderId || normalized.orderId === '-') return;
    const signature = [normalized.orderId, normalized.title, normalized.imageUrl, normalized.amountText].join('::');
    if (!signature.replace(/[:\-]/g, '')) return;
    if (seen.has(signature)) return;
    seen.add(signature);
    deduped.push(normalized);
  });
  if (!deduped.length) {
    const fallbackOrder = normalizeRefundOrder(fallback, fallback, 0);
    if (fallbackOrder.orderId && fallbackOrder.orderId !== '-') {
      deduped.push(fallbackOrder);
    }
  }
  return deduped;
}

function extractRefundOrdersFromMessages(sessionMeta = {}, messages = []) {
  const bucket = [];
  const visited = new WeakSet();
  (Array.isArray(messages) ? messages : []).forEach(message => {
    collectRefundOrderNodes(message?.extra, bucket, visited);
    collectRefundOrderNodes(message?.raw?.extra, bucket, visited);
    collectRefundOrderNodes(message?.raw, bucket, visited);
  });
  return bucket.map((item, index) => normalizeRefundOrder(item, sessionMeta, index));
}

function extractAfterSalesStatusText(value) {
  if (!value) return '';
  if (Array.isArray(value)) {
    const texts = value
      .map(item => extractAfterSalesStatusText(item))
      .filter(Boolean);
    return [...new Set(texts)].join(' / ');
  }
  if (typeof value !== 'object') return '';
  const text = pickRefundText([value], [
    'statusDesc',
    'status_desc',
    'aftersaleStatusDesc',
    'afterSalesStatusDesc',
    'aftersale_status_desc',
    'after_sales_status_desc',
    'typeDesc',
    'type_desc',
    'afterSalesTypeDesc',
    'after_sales_type_desc',
    'buttonDesc',
    'button_desc',
    'label',
    'desc',
  ]);
  return text || '';
}

function extractAfterSalesDetail(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const candidates = value
      .map(item => extractAfterSalesDetail(item))
      .filter(Boolean)
      .sort((left, right) => {
        const timeDiff = Number(right?._afterSalesSortTime || 0) - Number(left?._afterSalesSortTime || 0);
        if (timeDiff) return timeDiff;
        return Number(right?._afterSalesScore || 0) - Number(left?._afterSalesScore || 0);
      });
    if (!candidates.length) return null;
    return candidates[0];
  }
  if (typeof value !== 'object') return null;
  const nestedLists = [
    value.list,
    value.afterSalesList,
    value.after_sales_list,
    value.records,
    value.items,
  ];
  for (const nested of nestedLists) {
    if (!Array.isArray(nested) || !nested.length) continue;
    const nestedDetail = extractAfterSalesDetail(nested);
    if (nestedDetail) return nestedDetail;
  }
  const detail = commonParsers.cloneJson(value);
  const statusText = pickDisplayAfterSalesStatus([detail]) || extractAfterSalesStatusText(detail);
  const afterSalesId = pickRefundText([detail], [
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
  const sortTime = pickRefundNumber([detail], [
    'updatedAt',
    'updated_at',
    'updateTime',
    'update_time',
    'modifiedAt',
    'modified_at',
    'createdAt',
    'created_at',
    'createTime',
    'create_time',
    'applyTime',
    'apply_time',
  ]);
  const score = (statusText ? 20 : 0) + (afterSalesId ? 10 : 0) + (sortTime ? 5 : 0);
  if (!score) return null;
  return {
    ...detail,
    afterSalesStatus: detail.afterSalesStatus || detail.after_sales_status_desc || detail.afterSalesStatusDesc || statusText || '',
    _afterSalesSortTime: sortTime,
    _afterSalesScore: score,
  };
}

function mapAfterSalesStatusCodeToText(value) {
  const code = String(value || '').trim();
  if (!code || !/^\d+$/.test(code)) return '';
  const map = {
    '0': '无售后',
    '2': '买家申请退款，待商家处理',
    '3': '退货退款，待商家处理',
    '4': '商家同意退款，退款中',
    '5': '未发货，退款成功',
    '6': '驳回退款，待用户处理',
    '7': '已同意退货退款,待用户发货',
    '8': '平台处理中',
    '9': '平台拒绝退款，退款关闭',
    '10': '已发货，退款成功',
    '11': '买家撤销',
    '12': '买家逾期未处理，退款失败',
    '13': '部分退款成功',
    '14': '商家拒绝退款，退款关闭',
    '15': '退货完成，待退款',
    '16': '换货补寄成功',
    '17': '换货补寄失败',
    '18': '换货补寄待用户确认完成',
    '21': '待商家同意维修',
    '22': '待用户确认发货',
    '24': '维修关闭',
    '25': '维修成功',
    '27': '待用户确认收货',
    '31': '已同意拒收退款，待用户拒收',
    '32': '补寄待商家发货',
  };
  return map[code] || '';
}

function pickDisplayAfterSalesStatus(sources = []) {
  const descKeys = [
    'afterSalesStatusDesc',
    'after_sales_status_desc',
    'aftersaleStatusDesc',
    'aftersale_status_desc',
  ];
  const statusKeys = [
    'afterSalesStatus',
    'after_sales_status',
  ];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const descText = pickRefundText([source], descKeys);
    if (descText) return descText;
    const hasAfterSalesContext = descKeys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '')
      || statusKeys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '');
    if (!hasAfterSalesContext) continue;
    const scopedText = pickRefundText([source], ['statusDesc', 'status_desc', 'label', 'desc']);
    if (scopedText && !/^\d+$/.test(scopedText)) return scopedText;
  }
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const statusText = pickRefundText([source], statusKeys);
    if (statusText && !/^\d+$/.test(statusText)) return statusText;
  }
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const statusCode = pickRefundText([source], statusKeys);
    const mappedText = mapAfterSalesStatusCodeToText(statusCode);
    if (mappedText) return mappedText;
  }
  return '';
}

function mergeSideOrderStatusTexts(primary = '', secondary = '') {
  const primaryText = typeof primary === 'string' ? primary.trim() : '';
  const secondaryText = typeof secondary === 'string' ? secondary.trim() : '';
  if (!primaryText) return secondaryText;
  if (!secondaryText) return primaryText;
  const normalize = text => String(text || '').replace(/[，,、/\s]+/g, '');
  if (normalize(primaryText) === normalize(secondaryText)) {
    return primaryText;
  }
  return [primaryText, secondaryText].join('，');
}

function extractAfterSalesDetailMapFromPayload(payload = {}) {
  const map = payload?.result?.orderSn2AfterSalesListMap;
  if (!map || typeof map !== 'object') return {};
  const detailMap = {};
  Object.entries(map).forEach(([orderSn, list]) => {
    const detail = extractAfterSalesDetail(list);
    if (detail) {
      const { _afterSalesSortTime, _afterSalesScore, ...normalizedDetail } = detail;
      detailMap[String(orderSn)] = normalizedDetail;
      return;
    }
    const text = extractAfterSalesStatusText(list);
    if (text) {
      detailMap[String(orderSn)] = {
        afterSalesStatus: text,
      };
    }
  });
  return detailMap;
}

function getRefundOrderUid(sessionMeta = {}) {
  const candidates = [
    sessionMeta?.customerId,
    sessionMeta?.userUid,
    sessionMeta?.raw?.customer_id,
    sessionMeta?.raw?.buyer_id,
    sessionMeta?.raw?.uid,
    sessionMeta?.raw?.to?.uid,
    sessionMeta?.raw?.user_info?.uid,
  ].map(value => String(value || '').trim()).filter(Boolean);
  return candidates[0] || '';
}

function normalizeRefundApplyType(type) {
  const normalized = String(type || '').trim();
  if (!normalized || normalized === 'refund' || normalized === '1') {
    return 1;
  }
  if (normalized === 'returnRefund') {
    throw new Error('当前仅已接通“退款”申请接口，请继续抓取“退货退款”提交请求后再补齐');
  }
  if (normalized === 'resend') {
    throw new Error('当前仅已接通“退款”申请接口，请继续抓取“补寄”提交请求后再补齐');
  }
  throw new Error('暂不支持当前申请类型');
}

function normalizeRefundApplyShipStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (['2', 'received', '已收到货'].includes(normalized)) return 2;
  if (['1', 'not_received', '未收到货', ''].includes(normalized)) return 1;
  return 1;
}

function resolveRefundApplyQuestionType(params = {}) {
  const directCode = Number(params?.questionType ?? params?.question_type);
  if (Number.isFinite(directCode) && directCode > 0) {
    return directCode;
  }
  const reasonText = String(params?.reasonText || params?.reason || '').trim();
  const knownMap = {
    '不喜欢、效果不好': 103,
    '不喜欢': 103,
    '其他原因': 111,
  };
  if (knownMap[reasonText]) {
    return knownMap[reasonText];
  }
  throw new Error(`退款原因“${reasonText || '未选择'}”暂未完成真实接口映射，请先使用“不喜欢、效果不好”或继续抓取该原因的请求体`);
}

function buildRefundApplyReposeInfo(params = {}) {
  const raw = params?.reposeInfo && typeof params.reposeInfo === 'object' ? params.reposeInfo : {};
  return {
    userName: raw.userName ?? null,
    mobile: raw.mobile ?? null,
    provinceId: raw.provinceId ?? null,
    provinceName: raw.provinceName ?? null,
    cityId: raw.cityId ?? null,
    cityName: raw.cityName ?? null,
    districtId: raw.districtId ?? null,
    districtName: raw.districtName ?? null,
    address: raw.address ?? null,
    isApply: Boolean(raw.isApply),
    inGray: raw.inGray === undefined ? true : Boolean(raw.inGray),
    orderSn: raw.orderSn ?? null,
    mallId: raw.mallId ?? null,
    uid: raw.uid ?? null,
  };
}

function resolveRefundApplyReposeInfo(infoPayload = {}, params = {}) {
  const info = infoPayload?.result && typeof infoPayload.result === 'object'
    ? infoPayload.result
    : (infoPayload && typeof infoPayload === 'object' ? infoPayload : {});
  const infoReposeInfo = info?.reposeInfo && typeof info.reposeInfo === 'object' ? info.reposeInfo : {};
  return buildRefundApplyReposeInfo({
    reposeInfo: {
      userName: infoReposeInfo.userName ?? info.userName ?? null,
      mobile: infoReposeInfo.mobile ?? info.mobile ?? info.phone ?? null,
      provinceId: infoReposeInfo.provinceId ?? info.provinceId ?? null,
      provinceName: infoReposeInfo.provinceName ?? info.provinceName ?? null,
      cityId: infoReposeInfo.cityId ?? info.cityId ?? null,
      cityName: infoReposeInfo.cityName ?? info.cityName ?? null,
      districtId: infoReposeInfo.districtId ?? info.districtId ?? null,
      districtName: infoReposeInfo.districtName ?? info.districtName ?? null,
      address: infoReposeInfo.address ?? info.address ?? null,
      isApply: infoReposeInfo.isApply ?? info.isApply ?? false,
      inGray: infoReposeInfo.inGray ?? info.inGray ?? true,
      orderSn: infoReposeInfo.orderSn ?? info.orderSn ?? params?.orderSn ?? params?.order_sn ?? null,
      mallId: infoReposeInfo.mallId ?? info.mallId ?? null,
      uid: infoReposeInfo.uid ?? info.uid ?? null,
      ...(params?.reposeInfo && typeof params.reposeInfo === 'object' ? params.reposeInfo : {}),
    },
  });
}

function normalizeRefundApplyFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return defaultValue;
}

module.exports = {
  normalizeRefundAmountByKeys,
  pickRefundText,
  pickRefundNumber,
  pickRefundBoolean,
  normalizeSystemNoticeComparableText,
  isRefundDefaultSellerNoteText,
  isRefundPendingNoticeText,
  isRefundSuccessNoticeText,
  resolveRefundOrderShippingInfo,
  resolveRefundOrderStatusText,
  isRefundOrderEligible,
  filterEligibleRefundOrders,
  normalizeRefundShippingBenefitStatus,
  resolveRefundShippingBenefitText,
  looksLikeRefundOrderNode,
  collectRefundOrderNodes,
  normalizeRefundOrder,
  dedupeRefundOrders,
  extractRefundOrdersFromMessages,
  extractAfterSalesStatusText,
  extractAfterSalesDetail,
  mapAfterSalesStatusCodeToText,
  pickDisplayAfterSalesStatus,
  mergeSideOrderStatusTexts,
  extractAfterSalesDetailMapFromPayload,
  getRefundOrderUid,
  normalizeRefundApplyType,
  normalizeRefundApplyShipStatus,
  resolveRefundApplyQuestionType,
  buildRefundApplyReposeInfo,
  resolveRefundApplyReposeInfo,
  normalizeRefundApplyFlag,
};
