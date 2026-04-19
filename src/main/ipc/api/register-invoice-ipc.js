'use strict';

/**
 * 待开票域 IPC 注册器：负责 invoice-get-overview / invoice-get-list /
 * invoice-get-detail / invoice-submit-record。
 *
 * 单店铺直接走 InvoiceApiClient；API_ALL_SHOPS 时按 apiReadyOnly 过滤店铺，
 * 并发抓取后按 applyTime 倒序合并。submit-record 显式允许 initSession 重试，
 * 因为 anti_content 老化时这条写接口必须刷新会话才能成功。
 */
function registerInvoiceIpc({
  ipcMain,
  sharedHelpers,
  getInvoiceApiClient,
  getApiShopList,
}) {
  const {
    API_ALL_SHOPS,
    resolveShopId,
    buildApiErrorMessage,
    invokePageApiWithRetry,
  } = sharedHelpers;

  ipcMain.handle('invoice-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await invokePageApiWithRetry(shopId, () => getInvoiceApiClient(shopId).getOverview());
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      if (!targetShops.length) {
        return { error: '显示所有店铺时，没有已验证在线的店铺可用于待开票列表' };
      }
      const failures = [];
      try {
        const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
        const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 20));
        const resultGroups = await Promise.all(targetShops.map(async shop => {
          try {
            const result = await invokePageApiWithRetry(shop.id, () => getInvoiceApiClient(shop.id).getList({
              ...params,
              pageNo,
              pageSize,
            }));
            const list = Array.isArray(result?.list) ? result.list : [];
            const decorated = list.map(item => ({
              ...item,
              shopId: shop.id,
              shopName: item.shopName || shop.name || '未知店铺',
            }));
            return {
              total: Number(result?.total || 0),
              list: decorated,
            };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { total: 0, list: [] };
          }
        }));
        const merged = resultGroups
          .flatMap(group => group.list)
          .sort((a, b) => Number(b.applyTime || 0) - Number(a.applyTime || 0));
        if (!merged.length && failures.length) {
          const summary = failures
            .slice(0, 3)
            .map(item => `${item.shopName || item.shopId}：${item.message}`)
            .join('；');
          return { error: `待开票列表加载失败，共 ${failures.length} 个店铺失败：${summary}` };
        }
        return {
          pageNo,
          pageSize,
          total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
          list: merged,
        };
      } catch (error) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `待开票列表加载失败：${summary}` : buildApiErrorMessage(error) };
      }
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getInvoiceApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.orderSn && !params.order_sn) return { error: '缺少订单号' };
    try {
      return await invokePageApiWithRetry(shopId, () => getInvoiceApiClient(shopId).getDetail(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('invoice-submit-record', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    try {
      return await invokePageApiWithRetry(
        shopId,
        () => getInvoiceApiClient(shopId).submitInvoiceRecord(params),
        { allowInitSessionRetry: true, source: 'invoice-submit-record' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = { registerInvoiceIpc };
