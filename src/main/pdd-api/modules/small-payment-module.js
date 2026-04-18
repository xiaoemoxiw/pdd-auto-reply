'use strict';

// 小额打款业务模块。负责拉取小额打款上下文（限额 / 历史 / 模板）以及
// 提交真实打款请求。提交模板的发现既会扫描运行期 API 抓包，也会兜底到
// 持久化模板；具体纯函数（模板归一化、refundType 推断等）已下沉到
// small-payment-parsers，这里只编排副作用流程。

const commonParsers = require('../parsers/common-parsers');
const smallPaymentParsers = require('../parsers/small-payment-parsers');

class SmallPaymentModule {
  constructor(client) {
    this.client = client;
  }

  collectPersistedSubmitTemplates(desiredType = '') {
    const persistedTemplate = this.client._getSmallPaymentSubmitTemplate();
    if (!persistedTemplate || typeof persistedTemplate !== 'object') {
      return [];
    }
    const normalizedDesired = smallPaymentParsers.normalizeSmallPaymentTemplateLabel(desiredType);
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (template) => {
      const normalizedTemplate = smallPaymentParsers.normalizeSmallPaymentTemplateEntry(template);
      if (!normalizedTemplate) return;
      const key = `${normalizedTemplate.method}:${normalizedTemplate.url}:${normalizedTemplate.requestBody}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(normalizedTemplate);
    };
    if (persistedTemplate.latest || persistedTemplate.byLabel || persistedTemplate.byRefundType) {
      if (normalizedDesired) {
        pushCandidate(persistedTemplate.byLabel?.[normalizedDesired]);
      }
      pushCandidate(persistedTemplate.latest);
      Object.values(persistedTemplate.byLabel || {}).forEach(pushCandidate);
      Object.values(persistedTemplate.byRefundType || {}).forEach(pushCandidate);
      return candidates;
    }
    pushCandidate(persistedTemplate);
    return candidates;
  }

  getLatestSubmitTemplate(orderSn = '', options = {}) {
    const client = this.client;
    const normalizedOrderSn = String(orderSn || '').trim();
    const desiredType = smallPaymentParsers.normalizeSmallPaymentTemplateLabel(options?.desiredType);
    const trafficEntries = client._getApiTrafficEntries();
    let fallbackTrafficTemplate = null;
    for (let i = trafficEntries.length - 1; i >= 0; i--) {
      const entry = trafficEntries[i];
      if (String(entry?.method || 'GET').toUpperCase() !== 'POST') continue;
      const url = String(entry?.url || '');
      if (!url.includes('/mercury/')) continue;
      if ([
        '/mercury/micro_transfer/detail',
        '/mercury/micro_transfer/queryTips',
        '/mercury/play_money/check',
      ].some(part => url.includes(part))) {
        continue;
      }
      const body = commonParsers.safeParseJson(entry?.requestBody);
      if (!smallPaymentParsers.isSmallPaymentSubmitBody(body, normalizedOrderSn)) {
        continue;
      }
      if (!fallbackTrafficTemplate) {
        fallbackTrafficTemplate = entry;
      }
      if (!desiredType || smallPaymentParsers.inferSmallPaymentTemplateLabelFromBody(body) === desiredType) {
        return entry;
      }
    }
    if (fallbackTrafficTemplate) {
      return fallbackTrafficTemplate;
    }
    const persistedCandidates = this.collectPersistedSubmitTemplates(desiredType);
    let fallbackPersistedTemplate = null;
    for (const template of persistedCandidates) {
      const persistedBody = commonParsers.safeParseJson(template?.requestBody);
      if (!smallPaymentParsers.isSmallPaymentSubmitBody(persistedBody, normalizedOrderSn)) {
        continue;
      }
      if (!fallbackPersistedTemplate) {
        fallbackPersistedTemplate = template;
      }
      if (!desiredType || smallPaymentParsers.inferSmallPaymentTemplateLabelFromBody(persistedBody) === desiredType) {
        return template;
      }
    }
    return fallbackPersistedTemplate;
  }

  async getSmallPaymentInfo(params = {}) {
    const client = this.client;
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const mallId = Number(params?.mallId || params?.mall_id || client._getMallId() || 0);
    const tipsBody = { orderSn: normalizedOrderSn };
    if (Number.isFinite(mallId) && mallId > 0) {
      tipsBody.mallId = mallId;
    }
    const [detailPayload, checkPayload, tipsPayload] = await Promise.all([
      client._requestRefundOrderPageApi('/mercury/micro_transfer/detail', { orderSn: normalizedOrderSn }),
      client._requestRefundOrderPageApi('/mercury/play_money/check', { orderSn: normalizedOrderSn }),
      client._requestRefundOrderPageApi('/mercury/micro_transfer/queryTips', tipsBody),
    ]);
    const businessError = client._normalizeBusinessError(detailPayload)
      || client._normalizeBusinessError(checkPayload)
      || client._normalizeBusinessError(tipsPayload);
    if (businessError) {
      throw new Error(businessError.message || '获取小额打款信息失败');
    }
    const detailList = Array.isArray(detailPayload?.result) ? detailPayload.result : [];
    const checkResult = checkPayload?.result && typeof checkPayload.result === 'object' ? checkPayload.result : {};
    const tipsResult = tipsPayload?.result && typeof tipsPayload.result === 'object' ? tipsPayload.result : {};
    const freight = tipsResult?.freightDTO && typeof tipsResult.freightDTO === 'object' ? tipsResult.freightDTO : {};
    const successNum = Math.max(0, Number(freight?.successNum || 0) || 0);
    const processingNum = Math.max(0, Number(freight?.processingNum || 0) || 0);
    const waitHandleNum = Math.max(0, Number(freight?.waitHandleNum || 0) || 0);
    const usedTimes = Math.max(detailList.length, successNum + processingNum + waitHandleNum);
    const maxTimes = 3;
    const remainingTimes = Math.max(0, maxTimes - usedTimes);
    const limitAmountFen = Math.max(0, Number(checkResult?.limitAmount || 0) || 0);
    const transferCode = String(checkResult?.transferCode || '').trim();
    const transferDesc = String(checkResult?.transferDesc || '').trim();
    const desiredType = smallPaymentParsers.normalizeSmallPaymentTemplateLabel(
      params?.refundType ?? params?.refund_type ?? params?.type
    );
    const submitTemplate = this.getLatestSubmitTemplate(normalizedOrderSn, { desiredType });
    const submitTemplateMeta = smallPaymentParsers.analyzeSmallPaymentSubmitTemplate(submitTemplate);
    const tipList = Array.isArray(tipsResult?.tipVOList) ? tipsResult.tipVOList : [];
    const confirmTipList = Array.isArray(tipsResult?.confirmTipVOList) ? tipsResult.confirmTipVOList : [];
    const standardTipList = Array.isArray(tipsResult?.standardTipVOList) ? tipsResult.standardTipVOList : [];
    const collectedTips = [...tipList, ...confirmTipList, ...standardTipList]
      .map(item => (item && typeof item === 'object')
        ? String(item.content || item.desc || item.tip || item.text || '').trim()
        : String(item || '').trim())
      .filter(Boolean);
    return {
      success: true,
      orderSn: normalizedOrderSn,
      mallId: Number.isFinite(mallId) && mallId > 0 ? mallId : null,
      limitAmountFen,
      limitAmount: limitAmountFen > 0 ? client._formatSideOrderAmount(limitAmountFen).replace(/^¥/, '') : '',
      transferType: Number.isFinite(Number(checkResult?.transferType)) ? Number(checkResult.transferType) : null,
      playMoneyPattern: Number.isFinite(Number(checkResult?.playMoneyPattern)) ? Number(checkResult.playMoneyPattern) : null,
      channel: Number.isFinite(Number(checkResult?.channel)) ? Number(checkResult.channel) : null,
      needChargePlayMoney: Boolean(checkResult?.needChargePlayMoney),
      transferCode: transferCode || null,
      transferDesc: transferDesc || null,
      canSubmit: limitAmountFen > 0 && remainingTimes > 0 && (!transferCode || Boolean(checkResult?.needChargePlayMoney)),
      submitTemplateReady: !!submitTemplate,
      submitTemplateUrl: submitTemplate?.url || '',
      submitTemplateMeta: submitTemplateMeta.ready ? submitTemplateMeta : null,
      maxTimes,
      usedTimes,
      remainingTimes,
      history: {
        successNum,
        processingNum,
        waitHandleNum,
        successAmountFen: Math.max(0, Number(freight?.successTotalAmount || 0) || 0),
        processingAmountFen: Math.max(0, Number(freight?.processingTotalAmount || 0) || 0),
        waitHandleAmountFen: Math.max(0, Number(freight?.waitHandleTotalAmount || 0) || 0),
      },
      showNotSignedTips: Boolean(tipsResult?.showNotSignedTips),
      tips: collectedTips,
      detailList: client._cloneJson(detailList),
      raw: {
        check: client._cloneJson(checkResult),
        tips: client._cloneJson(tipsResult),
      },
    };
  }

  async submitSmallPayment(params = {}) {
    const client = this.client;
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const playMoneyAmount = Number.isFinite(Number(params?.playMoneyAmountFen))
      ? Math.max(0, Math.round(Number(params.playMoneyAmountFen)))
      : client._parseOrderPriceYuanToFen(params?.playMoneyAmount || params?.amount);
    if (!playMoneyAmount) {
      throw new Error('缺少打款金额');
    }
    const remarks = String(params?.remarks ?? params?.remark ?? params?.message ?? '').trim();
    if (!remarks) {
      throw new Error('缺少留言内容');
    }
    const info = await this.getSmallPaymentInfo({
      orderSn: normalizedOrderSn,
      mallId: params?.mallId || params?.mall_id,
    });
    if (Number(info?.limitAmountFen || 0) > 0 && playMoneyAmount > Number(info.limitAmountFen || 0)) {
      throw new Error('打款金额不能超过单次上限');
    }
    const submitTemplate = this.getLatestSubmitTemplate(normalizedOrderSn);
    if (!submitTemplate) {
      throw new Error('当前店铺尚未捕获小额打款真实提交模板');
    }
    const templateBody = commonParsers.safeParseJson(submitTemplate?.requestBody);
    const submitTemplateMeta = smallPaymentParsers.analyzeSmallPaymentSubmitTemplate(submitTemplate);
    const refundType = smallPaymentParsers.normalizeSmallPaymentRefundType(
      params?.refundType ?? params?.refund_type ?? params?.type,
      {
        detailList: info?.detailList,
        templateBody,
        submitTemplateMeta,
      }
    );
    const chargeType = Number.isFinite(Number(params?.chargeType))
      ? Math.max(0, Math.round(Number(params.chargeType)))
      : Math.max(0, Number(
        submitTemplateMeta?.snapshot?.chargeType
        ?? commonParsers.readObjectPath(templateBody, submitTemplateMeta?.recognizedFields?.chargeField)
        ?? templateBody?.chargeType
        ?? templateBody?.charge_type
        ?? info?.channel
        ?? 4
      ) || 0);
    const requestBody = smallPaymentParsers.buildSmallPaymentSubmitRequestBody({
      templateBody,
      submitTemplateMeta,
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      remarks,
      chargeType,
    });
    client._log('[API] 提交小额打款', {
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      chargeType,
      hasRemarks: !!remarks,
    });
    const payload = await client._requestRefundOrderPageApi('/mercury/play_money/create', requestBody);
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      const error = new Error(businessError.message || '提交小额打款失败');
      error.errorCode = businessError.code;
      error.payload = payload;
      throw error;
    }
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    const cashierShortUrl = String(result?.link || '').trim();
    return {
      success: true,
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      chargeType,
      requestBody: client._cloneJson(requestBody),
      response: client._cloneJson(payload),
      chargeSn: String(result?.chargeSn || '').trim(),
      chargeStatus: Number.isFinite(Number(result?.status)) ? Number(result.status) : null,
      transferCode: result?.transferCode ?? null,
      cashierShortUrl,
      cashierUrl: cashierShortUrl ? `https://mms.pinduoduo.com/cashier/?orderSn=${cashierShortUrl}` : '',
    };
  }
}

module.exports = { SmallPaymentModule };
