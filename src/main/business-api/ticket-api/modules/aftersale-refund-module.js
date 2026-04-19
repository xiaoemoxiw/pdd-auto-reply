'use strict';

/**
 * 售后(退款)单模块（Mercury）。
 *
 * 涵盖商家后台售后域全部写操作 + 列表/计数/地址/校验类只读接口：
 * - 列表/统计：getRefundList、getRefundCount、getRefundGroupCount
 * - 退货地址：listRefundAddresses、approveReturnGoods（含 check_address_valid_and_return_address）
 * - 补寄：approveResend
 * - 同意/驳回退款预检：agreeRefundPreCheck、rejectRefundPreCheck
 * - 驳回退款表单：rejectRefundGetFormInfo、rejectRefundSubmit
 * - 协商/原因：getRejectRefundNegotiateInfo、rejectRefundGetReasons
 * - 第三次驳回：rejectRefundValidate、merchantAfterSalesRefuse
 *
 * 模块通过构造函数注入 TicketApiClient，复用其 _request / _getTrafficRequestBody /
 * _getTokenInfo / _getShopInfo，自身只负责 mercury 业务体的拼装与字段校验。
 */

const {
  pickValue,
  isPlainObject,
  buildPayloadMeta,
} = require('../parsers/ticket-helpers');

const REFUND_LIST_URL = '/mercury/mms/afterSales/queryList';
const REFUND_COUNT_URL = '/mercury/mms/afterSales/queryCount';
const REFUND_GROUP_COUNT_URL = '/mercury/mms/afterSales/queryGroupCount';
const AGREE_REFUND_PRECHECK_URL = '/mercury/mms/afterSales/agreeRefundPreCheck';
const REJECT_REFUND_PRECHECK_URL = '/mercury/mms/afterSales/rejectRefundPreCheck';
const REJECT_REFUND_GET_FORM_INFO_URL = '/mercury/mms/afterSales/rejectRefundGetFormInfo';
const REJECT_REFUND_SUBMIT_FORM_DATA_URL = '/mercury/mms/afterSales/rejectRefundSubmitFormData';
const REJECT_REFUND_NEGOTIATE_INFO_URL = '/mercury/negotiate/mms/afterSales/getRejectNegotiateInfo';
const REJECT_REFUND_REASONS_URL = '/mercury/mms/afterSales/rejectRefundReasons';
const REJECT_REFUND_VALIDATE_URL = '/mercury/mms/afterSales/rejectRefund/validate';
const MERCHANT_AFTERSALES_REFUSE_URL = '/mercury/merchant/afterSales/refuse';

class AftersaleRefundModule {
  constructor(client) {
    this.client = client;
  }

  async getRefundList(params = {}, options = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || params.pageNumber || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 10));

    const body = {
      pageNumber: pageNo,
      pageSize,
      ...params,
    };
    ['pageNo', 'page_no', 'page_size', 'debug', 'templateKey'].forEach(k => delete body[k]);

    const payload = await this.client._request('POST', REFUND_LIST_URL, body, {}, options);
    const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
    const total = payload?.result?.total || 0;

    return {
      pageNo,
      pageSize,
      total,
      list,
      requestBody: body,
      ...(params.debug ? { payloadMeta: buildPayloadMeta(payload) } : {})
    };
  }

  async getRefundCount(params = {}, options = {}) {
    const payload = await this.client._request('POST', REFUND_COUNT_URL, params, {}, options);
    const counts = isPlainObject(payload?.result) ? payload.result : {};
    return { counts, payload };
  }

  async getRefundGroupCount(params = {}) {
    const payload = await this.client._request('POST', REFUND_GROUP_COUNT_URL, params);
    const counts = isPlainObject(payload?.result) ? payload.result : {};
    return { counts, payload };
  }

  async listRefundAddresses(params = {}, options = {}) {
    const payload = await this.client._request('POST', '/antis/api/refundAddress/list', params || {}, {}, options);
    const list = Array.isArray(payload?.result) ? payload.result : [];
    return { list, payload };
  }

  async approveReturnGoods(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法同意退货');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法同意退货');

    const versionRaw = pickValue(params, ['version'], '');
    const version = Number(versionRaw || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法同意退货');

    const receiver = String(pickValue(params, ['receiver', 'receiverName', 'receiver_name', 'receiverName'], '') || '').trim();
    if (!receiver) throw new Error('缺少收件人，无法同意退货');

    const receiverPhone = String(pickValue(params, ['receiverPhone', 'receiver_phone', 'phone', 'mobile', 'tel'], '') || '').trim();
    if (!receiverPhone) throw new Error('缺少联系电话，无法同意退货');

    const provinceId = Number(pickValue(params, ['provinceId', 'province_id'], 0));
    const cityId = Number(pickValue(params, ['cityId', 'city_id'], 0));
    const districtId = Number(pickValue(params, ['districtId', 'district_id'], 0));
    if (!Number.isFinite(provinceId) || !Number.isFinite(cityId) || !Number.isFinite(districtId) || provinceId <= 0 || cityId <= 0 || districtId <= 0) {
      throw new Error('缺少省市区信息，无法同意退货');
    }

    const provinceName = String(pickValue(params, ['provinceName', 'province_name'], '') || '').trim();
    const cityName = String(pickValue(params, ['cityName', 'city_name'], '') || '').trim();
    const districtName = String(pickValue(params, ['districtName', 'district_name'], '') || '').trim();
    if (!provinceName || !cityName || !districtName) throw new Error('缺少省市区名称，无法同意退货');

    const refundAddress = String(pickValue(params, ['refundAddress', 'refund_address', 'detailAddress', 'detail_address'], '') || '').trim();
    if (!refundAddress) throw new Error('缺少详细地址，无法同意退货');

    const receiverAddress = String(pickValue(params, ['receiverAddress', 'receiver_address'], '') || '').trim()
      || `${provinceName}${cityName}${districtName}${refundAddress}`;

    const operateDesc = String(pickValue(params, ['operateDesc', 'operate_desc', 'message', 'remark', 'memo'], '') || '').trim();
    if (!operateDesc) throw new Error('缺少留言，无法同意退货');

    const checkUrlPath = '/mercury/after_sales/check_address_valid_and_return_address';
    const checkTemplate = this.client._getTrafficRequestBody(checkUrlPath);
    const checkBody = isPlainObject(checkTemplate) ? JSON.parse(JSON.stringify(checkTemplate)) : {};
    checkBody.receiverName = receiver;
    checkBody.provinceId = provinceId;
    checkBody.provinceName = provinceName;
    checkBody.cityId = cityId;
    checkBody.cityName = cityName;
    checkBody.districtId = districtId;
    checkBody.districtName = districtName;
    checkBody.refundAddress = refundAddress;
    checkBody.orderSn = orderSn;
    checkBody.id = id;
    const checkPayload = await this.client._request('POST', checkUrlPath, checkBody, {}, options);
    const checkResult = checkPayload?.result;
    if (checkResult && typeof checkResult === 'object') {
      if (checkResult.refundAddressValid === false) throw new Error('退货地址校验失败');
      if (checkResult.isBadAddress === true) throw new Error('退货地址疑似异常，请检查');
      if (checkResult.isBadReceiver === true) throw new Error('收件人信息疑似异常，请检查');
    }

    const urlPath = '/mercury/mms/afterSales/agreeReturn';
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};
    body.provinceId = provinceId;
    body.provinceName = provinceName;
    body.cityId = cityId;
    body.cityName = cityName;
    body.districtId = districtId;
    body.districtName = districtName;
    body.version = version;
    body.receiver = receiver;
    body.orderSn = orderSn;
    body.receiverPhone = receiverPhone;
    body.receiverAddress = receiverAddress;
    body.refundAddress = refundAddress;
    body.operateDesc = operateDesc;
    body.id = id;
    if (!('addressType' in body)) body.addressType = 1;
    if (!('confirmWeakRemind' in body)) body.confirmWeakRemind = null;

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async approveResend(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法同意补寄');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法同意补寄');

    const versionRaw = pickValue(params, ['version'], '');
    const version = Number(versionRaw || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法同意补寄');

    const frontActionRaw = pickValue(params, ['frontAction', 'front_action', 'action'], 1017);
    const frontAction = Number(frontActionRaw || 0);
    if (!Number.isFinite(frontAction) || frontAction <= 0) throw new Error('缺少操作类型，无法同意补寄');

    const urlPath = '/mercury/after_sales/agree_resend';
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};
    const tokenInfo = this.client._getTokenInfo();
    const shop = this.client._getShopInfo();

    body.id = id;
    body.orderSn = orderSn;
    body.version = version;
    body.frontAction = frontAction;
    if (!('uid' in body)) body.uid = null;
    if (!('mallId' in body)) body.mallId = shop?.mallId || tokenInfo?.mallId || '';

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async agreeRefundPreCheck(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法进行同意退款预检查');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法进行同意退款预检查');

    const urlPath = AGREE_REFUND_PRECHECK_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    const itemBase = Array.isArray(body?.items) && isPlainObject(body.items[0]) ? { ...body.items[0] } : {};
    itemBase.afterSalesId = id;
    itemBase.orderSn = orderSn;
    if (!('uid' in itemBase)) itemBase.uid = null;
    body.items = [itemBase];

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, result, payload };
  }

  async rejectRefundPreCheck(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法进行驳回退款预检查');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法进行驳回退款预检查');

    const versionRaw = pickValue(params, ['version'], '');
    const version = Number(versionRaw || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法进行驳回退款预检查');

    const invokeTypeRaw = pickValue(params, ['invokeType', 'invoke_type'], 0);
    const invokeType = Number(invokeTypeRaw || 0);
    const urlPath = REJECT_REFUND_PRECHECK_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.version = version;
    body.invokeType = Number.isFinite(invokeType) ? invokeType : 0;

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, version, result, payload };
  }

  async rejectRefundGetFormInfo(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id', 'bizId', 'biz_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法获取驳回退款表单');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法获取驳回退款表单');

    const bizTypeRaw = pickValue(params, ['bizType', 'biz_type'], 2);
    const bizType = Number(bizTypeRaw || 0);
    const urlPath = REJECT_REFUND_GET_FORM_INFO_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.bizType = Number.isFinite(bizType) && bizType > 0 ? bizType : 2;
    body.bizId = String(pickValue(params, ['bizId', 'biz_id'], String(id)) || String(id)).trim() || String(id);
    body.orderSn = orderSn;
    body.afterSalesId = id;

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, result, payload };
  }

  async getRejectRefundNegotiateInfo(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法获取驳回退款协商信息');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法获取驳回退款协商信息');

    const key = String(pickValue(params, ['key'], 'ProMultiSolution') || 'ProMultiSolution').trim() || 'ProMultiSolution';
    const urlPath = REJECT_REFUND_NEGOTIATE_INFO_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.key = key;

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    const result = isPlainObject(payload?.result) ? payload.result : {};
    return { ok: true, id, orderSn, result, payload };
  }

  async rejectRefundSubmit(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id', 'bizId', 'biz_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法提交驳回退款');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法提交驳回退款');

    const formName = String(pickValue(params, ['formName', 'form_name'], '') || '').trim();
    if (!formName) throw new Error('缺少表单名，无法提交驳回退款');

    const formDataList = Array.isArray(params?.formDataList) ? params.formDataList : [];
    if (!formDataList.length) throw new Error('缺少表单内容，无法提交驳回退款');

    const bizTypeRaw = pickValue(params, ['bizType', 'biz_type'], 10);
    const bizType = Number(bizTypeRaw || 0);
    const urlPath = REJECT_REFUND_SUBMIT_FORM_DATA_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.formName = formName;
    body.formDataList = formDataList;
    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.bizType = Number.isFinite(bizType) && bizType > 0 ? bizType : 10;
    body.bizId = String(pickValue(params, ['bizId', 'biz_id'], String(id)) || String(id)).trim() || String(id);

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async rejectRefundGetReasons(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法获取驳回原因');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法获取驳回原因');

    const urlPath = REJECT_REFUND_REASONS_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.orderSn = orderSn;
    body.afterSalesId = id;
    body.uid = params?.uid ?? body.uid ?? null;

    if (params.rejectPopupWindowType !== undefined) {
      const rejectPopupWindowType = Number(params.rejectPopupWindowType || 0);
      if (Number.isFinite(rejectPopupWindowType) && rejectPopupWindowType > 0) {
        body.rejectPopupWindowType = rejectPopupWindowType;
      }
    }
    if (params.withHandlingSuggestion !== undefined) {
      body.withHandlingSuggestion = !!params.withHandlingSuggestion;
    }
    if (params.withRejectRequirements !== undefined) {
      body.withRejectRequirements = !!params.withRejectRequirements;
    }
    if (params.rejectReasonCode !== undefined && params.rejectReasonCode !== null && params.rejectReasonCode !== '') {
      const rejectReasonCode = Number(params.rejectReasonCode || 0);
      if (Number.isFinite(rejectReasonCode) && rejectReasonCode > 0) {
        body.rejectReasonCode = rejectReasonCode;
      }
    }

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    const result = Array.isArray(payload?.result) ? payload.result : [];
    return { ok: true, id, orderSn, result, payload };
  }

  async rejectRefundValidate(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法校验第三次驳回');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法校验第三次驳回');

    const version = Number(pickValue(params, ['version'], 0) || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法校验第三次驳回');

    const reason = String(pickValue(params, ['reason'], '') || '').trim();
    if (!reason) throw new Error('缺少驳回原因文案，无法校验第三次驳回');

    const operateDesc = String(pickValue(params, ['operateDesc', 'operate_desc'], '') || '').trim();
    if (!operateDesc) throw new Error('缺少补充说明，无法校验第三次驳回');

    const rejectReasonCode = Number(pickValue(params, ['rejectReasonCode', 'reject_reason_code'], 0) || 0);
    if (!Number.isFinite(rejectReasonCode) || rejectReasonCode <= 0) throw new Error('缺少驳回原因编码，无法校验第三次驳回');

    const urlPath = REJECT_REFUND_VALIDATE_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.reason = reason;
    body.operateDesc = operateDesc;
    body.images = Array.isArray(params?.images) ? params.images : [];
    body.shipImages = Array.isArray(params?.shipImages) ? params.shipImages : [];
    body.consumerReason = String(pickValue(params, ['consumerReason', 'consumer_reason'], '') || '');
    body.requiredRejectDescs = Array.isArray(params?.requiredRejectDescs) ? params.requiredRejectDescs : [];
    body.rejectReasonCode = rejectReasonCode;
    body.id = id;
    body.mallId = params?.mallId ?? body.mallId ?? null;
    body.version = version;
    body.orderSn = orderSn;
    body.requiredProofs = Array.isArray(params?.requiredProofs) ? params.requiredProofs : [];

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }

  async merchantAfterSalesRefuse(params = {}, options = {}) {
    const idRaw = pickValue(params, ['id', 'afterSalesId', 'after_sales_id', 'instanceId', 'instance_id'], '');
    const id = Number(idRaw || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('缺少售后单ID，无法提交第三次驳回');

    const orderSn = String(pickValue(params, ['orderSn', 'order_sn', 'orderNo', 'order_no'], '') || '').trim();
    if (!orderSn) throw new Error('缺少订单号，无法提交第三次驳回');

    const version = Number(pickValue(params, ['version'], 0) || 0);
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，无法提交第三次驳回');

    const reason = String(pickValue(params, ['reason'], '') || '').trim();
    if (!reason) throw new Error('缺少驳回原因文案，无法提交第三次驳回');

    const operateDesc = String(pickValue(params, ['operateDesc', 'operate_desc'], '') || '').trim();
    if (!operateDesc) throw new Error('缺少补充说明，无法提交第三次驳回');

    const rejectReasonCode = Number(pickValue(params, ['rejectReasonCode', 'reject_reason_code'], 0) || 0);
    if (!Number.isFinite(rejectReasonCode) || rejectReasonCode <= 0) throw new Error('缺少驳回原因编码，无法提交第三次驳回');

    const urlPath = MERCHANT_AFTERSALES_REFUSE_URL;
    const template = this.client._getTrafficRequestBody(urlPath);
    const body = isPlainObject(template) ? JSON.parse(JSON.stringify(template)) : {};

    body.reason = reason;
    body.operateDesc = operateDesc;
    body.images = Array.isArray(params?.images) ? params.images : [];
    body.shipImages = Array.isArray(params?.shipImages) ? params.shipImages : [];
    body.consumerReason = String(pickValue(params, ['consumerReason', 'consumer_reason'], '') || '');
    body.requiredRejectDescs = Array.isArray(params?.requiredRejectDescs) ? params.requiredRejectDescs : [];
    body.rejectReasonCode = rejectReasonCode;
    body.id = id;
    body.mallId = params?.mallId ?? body.mallId ?? null;
    body.version = version;
    body.orderSn = orderSn;
    body.requiredProofs = Array.isArray(params?.requiredProofs) ? params.requiredProofs : [];

    const payload = await this.client._request('POST', urlPath, body, {}, options);
    return { ok: true, id, orderSn, payload };
  }
}

module.exports = {
  AftersaleRefundModule,
  REFUND_LIST_URL,
  REFUND_COUNT_URL,
  REFUND_GROUP_COUNT_URL,
  AGREE_REFUND_PRECHECK_URL,
  REJECT_REFUND_PRECHECK_URL,
  REJECT_REFUND_GET_FORM_INFO_URL,
  REJECT_REFUND_SUBMIT_FORM_DATA_URL,
  REJECT_REFUND_NEGOTIATE_INFO_URL,
  REJECT_REFUND_REASONS_URL,
  REJECT_REFUND_VALIDATE_URL,
  MERCHANT_AFTERSALES_REFUSE_URL,
};
