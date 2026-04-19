'use strict';

/**
 * IPC 注册器共享工具集。
 *
 * 这些工具原本散落在 register-api-ipc.js 内部闭包中，但 mail / invoice /
 * deduction / ticket / violation 这几组 channel 都重复用到，把它们抽出来才能
 * 让各业务域的 register-xxx-ipc.js 真正独立。
 *
 * 通过工厂函数 createApiSharedHelpers(deps) 完成依赖注入：getShopManager /
 * getApiClient / getApiShopAvailabilityStatus / store / API_ALL_SHOPS 都由
 * 调用方在 register-api-ipc.js 顶层传入，避免子模块再各自 import 共享接线层。
 */
function createApiSharedHelpers(deps = {}) {
  const {
    store,
    API_ALL_SHOPS,
    getShopManager,
    getApiClient,
    getApiShopAvailabilityStatus,
  } = deps;

  function getActiveShopId() {
    return getShopManager()?.getActiveShopId();
  }

  function resolveShopId(params = {}) {
    return params.shopId || getActiveShopId();
  }

  function buildApiErrorMessage(error) {
    const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null;
    const payloadMessage = payload
      ? String(
        payload.error_msg
        || payload.errorMsg
        || payload.message
        || payload.msg
        || payload?.result?.error_msg
        || payload?.result?.errorMsg
        || payload?.result?.message
        || payload?.data?.error_msg
        || payload?.data?.errorMsg
        || payload?.data?.message
        || ''
      ).trim()
      : '';
    const payloadCode = payload
      ? String(
        payload.error_code
        || payload.code
        || payload.err_no
        || payload.errno
        || payload?.result?.error_code
        || payload?.result?.code
        || payload?.data?.error_code
        || payload?.data?.code
        || ''
      ).trim()
      : '';
    const fallbackMessage = String(error?.message || '').trim() || 'API 请求失败';
    if (payloadMessage && payloadCode) return `${payloadMessage}（${payloadCode}）`;
    if (payloadMessage) return payloadMessage;
    if (payloadCode && fallbackMessage === 'API 请求失败') return `${fallbackMessage}（${payloadCode}）`;
    return fallbackMessage;
  }

  function getBusinessUnavailableMessage(shop) {
    const availabilityStatus = getApiShopAvailabilityStatus(shop);
    if (availabilityStatus === 'expired' || availabilityStatus === 'invalid') {
      return '会话已过期，请重新登录';
    }
    if (availabilityStatus !== 'online') {
      return '店铺未验证在线，请先完成登录校验';
    }
    return '店铺当前不可用';
  }

  // 历史名字保留为 shouldRetryViolationList，但实际所有 page-api 重试都用它
  // 来判断是否值得显式 initSession(true)。改名风险大于收益，先保持兼容。
  function shouldRetryViolationList(error) {
    const message = String(buildApiErrorMessage(error) || '').toLowerCase();
    return message.includes('会话已过期')
      || message.includes('登录已失效')
      || message.includes('auth')
      || message.includes('login');
  }

  async function invokePageApiWithRetry(shopId, request, options = {}) {
    try {
      return await request();
    } catch (error) {
      if (!shouldRetryViolationList(error) || options.allowInitSessionRetry !== true) {
        throw error;
      }
      console.log(`[PDD接口:${shopId}] 显式允许页面重试，准备 initSession(true): ${options.source || 'unknown'}`);
      await getApiClient(shopId).initSession(true, {
        source: String(options.source || 'unknown'),
      });
      return request();
    }
  }

  return {
    store,
    API_ALL_SHOPS,
    getActiveShopId,
    resolveShopId,
    buildApiErrorMessage,
    getBusinessUnavailableMessage,
    shouldRetryViolationList,
    invokePageApiWithRetry,
  };
}

module.exports = { createApiSharedHelpers };
