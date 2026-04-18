'use strict';

// 小额打款相关的纯解析/归一化函数。
// 涉及实例侧抓包数据 (_getApiTrafficEntries) 与本地持久化模板的方法仍保留在
// PddApiClient, 这里只放纯逻辑。

const commonParsers = require('./common-parsers');

const PDD_BASE = 'https://mms.pinduoduo.com';

function inferSmallPaymentTypeLabel(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.includes('补运费')) return 'shipping';
  if (normalized.includes('补差价')) return 'difference';
  if (normalized.includes('其他') || normalized.includes('补偿')) return 'other';
  return '';
}

function normalizeSmallPaymentTemplateLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['shipping', '补运费'].includes(normalized)) return 'shipping';
  if (['difference', '补差价'].includes(normalized)) return 'difference';
  if (['other', '其他', '2'].includes(normalized)) return 'other';
  return '';
}

function inferSmallPaymentTemplateLabelFromBody(body = {}) {
  const directMatch = [
    body?.transferTypeDesc,
    body?.transfer_type_desc,
    body?.remarks,
    body?.remark,
    body?.leaveMessage,
    body?.leave_message,
  ].map(item => inferSmallPaymentTypeLabel(item)).find(Boolean);
  if (directMatch) {
    return directMatch;
  }
  const refundType = body?.refundType ?? body?.refund_type;
  if (Number(refundType) === 2) {
    return 'other';
  }
  return '';
}

function isSmallPaymentSubmitBody(body = {}, normalizedOrderSn = '') {
  if (!body || typeof body !== 'object') return false;
  const targetOrderSn = String(body?.orderSn || body?.order_sn || '').trim();
  if (!targetOrderSn) return false;
  if (normalizedOrderSn && targetOrderSn !== normalizedOrderSn) return false;
  return [
    body?.playMoneyAmount,
    body?.play_money_amount,
    body?.refundType,
    body?.refund_type,
    body?.remarks,
    body?.remark,
    body?.leaveMessage,
    body?.leave_message,
  ].some(value => value !== undefined && value !== null && value !== '');
}

function normalizeSmallPaymentTemplateEntry(template) {
  if (!template || typeof template !== 'object') {
    return null;
  }
  const parsedBody = commonParsers.safeParseJson(template?.requestBody);
  if (!parsedBody || typeof parsedBody !== 'object') {
    return null;
  }
  return {
    url: template.url || `${PDD_BASE}/mercury/unknown_small_payment_submit`,
    method: template.method || 'POST',
    requestBody: JSON.stringify(parsedBody),
  };
}

function analyzeSmallPaymentSubmitTemplate(templateEntry) {
  const templateBody = commonParsers.safeParseJson(templateEntry?.requestBody);
  if (!templateBody || typeof templateBody !== 'object') {
    return {
      ready: false,
      url: templateEntry?.url || '',
      keys: [],
      recognizedCount: 0,
    };
  }
  const orderField = commonParsers.findObjectPathByCandidates(templateBody, ['orderSn', 'order_sn']);
  const amountField = commonParsers.findObjectPathByCandidates(templateBody, ['playMoneyAmount', 'play_money_amount', 'amount', 'transferAmount', 'transfer_amount']);
  const typeField = commonParsers.findObjectPathByCandidates(templateBody, ['refundType', 'refund_type', 'payType', 'pay_type', 'transferType', 'transfer_type']);
  const noteField = commonParsers.findObjectPathByCandidates(templateBody, ['remarks', 'remark', 'leaveMessage', 'leave_message', 'message']);
  const chargeField = commonParsers.findObjectPathByCandidates(templateBody, ['chargeType', 'charge_type']);
  const mobileField = commonParsers.findObjectPathByCandidates(templateBody, ['mobile', 'userinfo.mobile', 'currentUserInfo.mobile']);
  const recognizedFields = {
    orderField,
    amountField,
    typeField,
    noteField,
    chargeField,
    mobileField,
  };
  const recognizedCount = Object.values(recognizedFields).filter(Boolean).length;
  return {
    ready: true,
    url: templateEntry?.url || '',
    keys: commonParsers.collectObjectKeyPaths(templateBody).slice(0, 60),
    recognizedCount,
    recognizedFields,
    snapshot: commonParsers.cloneJson({
      orderSn: orderField ? commonParsers.readObjectPath(templateBody, orderField) : undefined,
      amount: amountField ? commonParsers.readObjectPath(templateBody, amountField) : undefined,
      type: typeField ? commonParsers.readObjectPath(templateBody, typeField) : undefined,
      note: noteField ? commonParsers.readObjectPath(templateBody, noteField) : undefined,
      chargeType: chargeField ? commonParsers.readObjectPath(templateBody, chargeField) : undefined,
    }),
  };
}

function resolveSmallPaymentRefundTypeFromTemplate(templateBody, submitTemplateMeta = null) {
  const snapshotType = submitTemplateMeta?.snapshot?.type;
  const templateType = snapshotType !== undefined
    ? snapshotType
    : commonParsers.readObjectPath(templateBody, submitTemplateMeta?.recognizedFields?.typeField);
  if (!Number.isFinite(Number(templateType))) {
    return null;
  }
  const labelCandidates = [
    submitTemplateMeta?.snapshot?.note,
    commonParsers.readObjectPath(templateBody, submitTemplateMeta?.recognizedFields?.noteField),
    templateBody?.transferTypeDesc,
    templateBody?.transfer_type_desc,
    templateBody?.remarks,
    templateBody?.remark,
  ];
  const matchedLabel = labelCandidates
    .map(item => inferSmallPaymentTypeLabel(item))
    .find(Boolean);
  return {
    refundType: Math.max(0, Math.round(Number(templateType))),
    label: matchedLabel || '',
  };
}

function resolveSmallPaymentRefundTypeFromHistory(detailList = [], desiredLabel = '') {
  const normalizedDesired = String(desiredLabel || '').trim();
  if (!normalizedDesired || !Array.isArray(detailList)) {
    return null;
  }
  for (const item of detailList) {
    if (!item || typeof item !== 'object') continue;
    const refundType = item?.refundType ?? item?.refund_type ?? item?.transferType ?? item?.transfer_type;
    if (!Number.isFinite(Number(refundType))) continue;
    const matchedLabel = [
      item?.transferTypeDesc,
      item?.transfer_type_desc,
      item?.remarks,
      item?.remark,
    ].map(text => inferSmallPaymentTypeLabel(text)).find(Boolean);
    if (matchedLabel && matchedLabel === normalizedDesired) {
      return Math.max(0, Math.round(Number(refundType)));
    }
  }
  return null;
}

function normalizeSmallPaymentRefundType(value, options = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('缺少打款类型');
  }
  if (['0', '1', '2'].includes(normalized)) {
    return Number(normalized);
  }
  if (['other', '其他', '2'].includes(normalized)) {
    return 2;
  }
  const desiredLabel = ['difference', '补差价'].includes(normalized)
    ? 'difference'
    : (['shipping', '补运费'].includes(normalized) ? 'shipping' : '');
  if (desiredLabel) {
    const templateResolved = resolveSmallPaymentRefundTypeFromTemplate(
      options?.templateBody,
      options?.submitTemplateMeta
    );
    if (templateResolved?.label === desiredLabel && Number.isFinite(Number(templateResolved?.refundType))) {
      return templateResolved.refundType;
    }
    const historyResolved = resolveSmallPaymentRefundTypeFromHistory(options?.detailList, desiredLabel);
    if (Number.isFinite(Number(historyResolved))) {
      return historyResolved;
    }
    throw new Error(`当前尚未捕获“${desiredLabel === 'shipping' ? '补运费' : '补差价'}”的真实 refundType，请先在嵌入网页完成一次该类型打款`);
  }
  throw new Error(`暂不支持的打款类型：${value}`);
}

function buildSmallPaymentSubmitRequestBody(params = {}) {
  const templateBody = params?.templateBody && typeof params.templateBody === 'object'
    ? commonParsers.cloneJson(params.templateBody)
    : {};
  const recognizedFields = params?.submitTemplateMeta?.recognizedFields || {};
  const writeField = (path, fallbackKey, value) => {
    if (path) {
      commonParsers.writeObjectPath(templateBody, path, value);
    } else {
      templateBody[fallbackKey] = value;
    }
  };
  writeField(recognizedFields.orderField, 'orderSn', params.orderSn);
  writeField(recognizedFields.amountField, 'playMoneyAmount', params.playMoneyAmount);
  writeField(recognizedFields.typeField, 'refundType', params.refundType);
  writeField(recognizedFields.noteField, 'remarks', params.remarks);
  writeField(recognizedFields.chargeField, 'chargeType', params.chargeType);
  return templateBody;
}

module.exports = {
  inferSmallPaymentTypeLabel,
  normalizeSmallPaymentTemplateLabel,
  inferSmallPaymentTemplateLabelFromBody,
  isSmallPaymentSubmitBody,
  normalizeSmallPaymentTemplateEntry,
  analyzeSmallPaymentSubmitTemplate,
  resolveSmallPaymentRefundTypeFromTemplate,
  resolveSmallPaymentRefundTypeFromHistory,
  normalizeSmallPaymentRefundType,
  buildSmallPaymentSubmitRequestBody,
};
