'use strict';

/**
 * 订单 / 退款 / 邀请下单 / 小额付款 / 订单备注 / 订单价格域 IPC 注册器。
 *
 * 这里所有 channel 都走 chat 同一个 PddApiClient（getApiClient(shopId)），
 * 但与会话拉取、消息收发、媒体上传等 chat 主链路逻辑不同：
 * - 都是面向「单条订单 / 单个会话」的辅助操作；
 * - 不涉及 polling / 推送 / 媒体文件流；
 * - 只依赖 sharedHelpers 里的 resolveShopId / buildApiErrorMessage。
 *
 * 把这一组单独拆出来，是为了让 register-chat-ipc.js 真正只负责会话/消息主线，
 * 同时把订单类业务边界单独标出来，便于以后再继续按域拆。
 */
function registerOrderIpc({
  ipcMain,
  sharedHelpers,
  getApiClient,
}) {
  const { resolveShopId, buildApiErrorMessage } = sharedHelpers;

  ipcMain.handle('api-get-goods-card', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.url && !params.goodsId) return { error: '缺少商品链接' };
    try {
      return await getApiClient(shopId).getGoodsCard(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-refund-orders', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getRefundOrders(params.session || params.sessionId);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-submit-refund-apply', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).submitRefundApply(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-side-orders', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getSideOrders(params.session || params.sessionId, params.tab);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-invite-order-state', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).getInviteOrderState(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-invite-order-sku-options', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.itemId && !params.goodsId) return { error: '缺少商品标识' };
    try {
      return await getApiClient(shopId).getInviteOrderSkuOptions(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-add-invite-order-item', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    if (!params.itemId) return { error: '缺少商品标识' };
    try {
      return await getApiClient(shopId).addInviteOrderItem(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-clear-invite-order-items', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).clearInviteOrderItems(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-submit-invite-order', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).submitInviteOrder(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-submit-invite-follow', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.sessionId) return { error: '缺少 sessionId' };
    try {
      return await getApiClient(shopId).submitInviteFollow(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-get-small-payment-info', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).getSmallPaymentInfo(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-submit-small-payment', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).submitSmallPayment(params);
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('api-get-order-remark', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).getOrderRemark(params.orderSn, params.source);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-get-order-remark-tags', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await getApiClient(shopId).getOrderRemarkTagOptions(Boolean(params.force));
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-save-order-remark', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).saveOrderRemark(params);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('api-update-order-price', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn) return { error: '缺少订单编号' };
    try {
      return await getApiClient(shopId).updateOrderPrice(params);
    } catch (error) {
      return { error: error.message };
    }
  });
}

module.exports = { registerOrderIpc };
