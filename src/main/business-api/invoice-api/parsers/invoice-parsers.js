'use strict';

/**
 * invoice-api 共享解析与字段归一化。
 *
 * 这里集中处理：
 * - 通用字段拾取（pickValue / normalizeMappedText / sleep）
 * - 金额归一化（normalizeInvoiceAmount，分→元兜底）
 * - 一组发票相关枚举的中文文案兜底（订单状态 / 售后状态 / 开票方式 /
 *   开票类型 / 发票种类 / 抬头类型）
 * - 列表 / 详情 / 概览三个面向 IPC 的归一化器
 *
 * 这些都是纯函数，不依赖 InvoiceApiClient 实例，模块按需 require 后即可使用。
 */

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeOverview(stats = {}, quickFilter = {}, mallControl = {}, verifyInfo = {}, extra = {}) {
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

function normalizeListItem(item = {}) {
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
    goodsName: String(pickValue(item, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle'], '')),
    goodsSpec: String(pickValue(item, ['spec', 'goods_spec', 'goodsSpec', 'sku_spec_desc'], '')),
    goodsThumb: String(pickValue(item, [
      'thumb_url',
      'thumbUrl',
      'goods_thumbnail_url',
      'goods_thumb_url',
      'goods_img_url',
      'goods_image_url',
      'goods_image',
    ], '')),
    taxNo: String(pickValue(item, ['payer_register_no', 'tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo', 'duty_paragraph'], '')),
    otherInfo: String(pickValue(item, ['other_info', 'otherInfo'], '')),
    paperReceiverName: String(pickValue(item, ['paper_receiver_name', 'paperReceiverName'], '')),
    paperReceiverMobile: String(pickValue(item, ['paper_receiver_mobile', 'paperReceiverMobile'], '')),
    paperReceiverAddress: String(pickValue(item, ['paper_receiver_address', 'paperReceiverAddress'], '')),
    invoiceDisplayStatus: Number(pickValue(item, ['invoice_display_status', 'display_status', 'status'], 0) || 0),
    raw: item,
  };
}

function normalizeDetail(detail = {}) {
  return {
    orderSn: String(pickValue(detail, ['order_sn', 'orderSn'], '')),
    orderStatus: String(pickValue(detail, ['order_status_str', 'order_status_desc', 'order_status_text', 'order_status'], '')),
    invoiceApplyStatus: String(pickValue(detail, ['invoice_apply_status_str', 'invoice_apply_status_desc'], '')),
    goodsName: String(pickValue(detail, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle'], '')),
    goodsSpec: String(pickValue(detail, ['spec', 'goods_spec', 'goodsSpec', 'sku_spec_desc'], '')),
    goodsThumb: String(pickValue(detail, [
      'thumb_url',
      'thumbUrl',
      'goods_thumbnail_url',
      'goods_thumb_url',
      'goods_img_url',
      'goods_image_url',
      'goods_image',
    ], '')),
    receiveName: String(pickValue(detail, ['receive_name', 'receiver_name', 'consignee', 'receiver'], '')),
    receiveMobile: String(pickValue(detail, ['receive_mobile', 'receiver_mobile', 'mobile'], '')),
    shippingAddress: String(pickValue(detail, ['shipping_address', 'receive_address', 'address'], '')),
    shippingName: String(pickValue(detail, ['shipping_name', 'express_company_name', 'express_name'], '')),
    trackingNumber: String(pickValue(detail, ['tracking_number', 'waybill_no', 'trackingNo'], '')),
    taxNo: String(pickValue(detail, ['tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo', 'duty_paragraph'], '')),
    raw: detail
  };
}

module.exports = {
  pickValue,
  normalizeInvoiceAmount,
  normalizeMappedText,
  resolveOrderStatusText,
  resolveAfterSalesStatusText,
  resolveInvoiceModeText,
  resolveInvoiceTypeText,
  resolveInvoiceKindText,
  resolveLetterheadTypeText,
  sleep,
  normalizeOverview,
  normalizeListItem,
  normalizeDetail,
};
