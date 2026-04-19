'use strict';

/**
 * 扣款管理域 IPC 注册器：负责 deduction-get-list。
 *
 * 单店铺直接走 DeductionApiClient；API_ALL_SHOPS 时按 apiReadyOnly 过滤店铺，
 * 并发抓取后合并 list 与 totals（延迟发货 / 缺货 / 虚假发货），
 * 未在线店铺统一汇入 failures。
 */
function registerDeductionIpc({
  ipcMain,
  sharedHelpers,
  getDeductionApiClient,
  getApiShopList,
}) {
  const {
    API_ALL_SHOPS,
    resolveShopId,
    buildApiErrorMessage,
    getBusinessUnavailableMessage,
    invokePageApiWithRetry,
  } = sharedHelpers;

  ipcMain.handle('deduction-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const failures = [];
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      if (!targetShops.length) {
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        return { list: [], failures };
      }
      const resultGroups = await Promise.all(targetShops.map(async shop => {
        try {
          const result = await invokePageApiWithRetry(shop.id, () => getDeductionApiClient(shop.id).getList(forwardedParams));
          const list = Array.isArray(result?.list) ? result.list : [];
          const decorated = list.map(item => ({
            ...item,
            shopId: shop.id,
            shopName: item.shopName || shop.name || '未知店铺',
          }));
          return {
            totals: result?.totals || null,
            list: decorated,
          };
        } catch (error) {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未知店铺',
            message: buildApiErrorMessage(error),
          });
          return { totals: null, list: [] };
        }
      }));
      skippedShops.forEach(shop => {
        failures.push({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        });
      });
      const merged = resultGroups.flatMap(group => group.list || []);
      if (!merged.length && failures.length) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `扣款列表加载失败：${summary}` : '扣款列表加载失败' };
      }
      const totals = resultGroups.reduce((acc, group) => {
        const src = group?.totals;
        if (!src || typeof src !== 'object') return acc;
        acc.delayShip += Number(src.delayShip || 0);
        acc.outOfStock += Number(src.outOfStock || 0);
        acc.fakeShipTrack += Number(src.fakeShipTrack || 0);
        return acc;
      }, { delayShip: 0, outOfStock: 0, fakeShipTrack: 0 });
      return { totals, list: merged, failures };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getDeductionApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = { registerDeductionIpc };
