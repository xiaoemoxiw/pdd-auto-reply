'use strict';

/**
 * 违规管理域 IPC 注册器：负责 violation-get-list / violation-get-detail。
 *
 * 单店铺直接走 ViolationApiClient；API_ALL_SHOPS 时按 apiReadyOnly 过滤店铺，
 * 并发抓取后按通知/违规时间倒序合并，未在线的店铺统一汇入 failures。
 */
function registerViolationIpc({
  ipcMain,
  sharedHelpers,
  getViolationApiClient,
  getApiShopList,
}) {
  const {
    API_ALL_SHOPS,
    resolveShopId,
    buildApiErrorMessage,
    getBusinessUnavailableMessage,
    invokePageApiWithRetry,
  } = sharedHelpers;

  ipcMain.handle('violation-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
      const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 100));
      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        return { pageNo, pageSize, total: 0, list: [], typeMap: {}, failures };
      }

      const failures = [];
      const parseTimeToMs = (value) => {
        if (value === undefined || value === null || value === '') return 0;
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
        const date = new Date(String(value));
        const ms = date.getTime();
        return Number.isNaN(ms) ? 0 : ms;
      };
      const pickSortTime = (item) => parseTimeToMs(
        item?.noticeTime
        ?? item?.notice_time
        ?? item?.violationTime
        ?? item?.violation_time
        ?? item?.punishTime
        ?? item?.punish_time
        ?? item?.appealEndTime
        ?? item?.appeal_end_time
        ?? item?.updateTime
        ?? item?.update_time
        ?? item?.gmtModified
        ?? item?.gmtCreate
        ?? item?.createTime
        ?? item?.createdAt
      );

      const resultGroups = await Promise.all(targetShops.map(async shop => {
        try {
          const forwardedParams = { ...params };
          if ('shopId' in forwardedParams) delete forwardedParams.shopId;
          const result = await invokePageApiWithRetry(shop.id, () => getViolationApiClient(shop.id).getList({
            ...forwardedParams,
            pageNo,
            pageSize,
          }));
          const list = Array.isArray(result?.list) ? result.list : [];
          const decorated = list.map(item => ({
            ...item,
            shopId: shop.id,
            shopName: item.shopName || item.mallName || shop.name || '未知店铺',
          }));
          const typeMap = result?.typeMap && typeof result.typeMap === 'object' ? result.typeMap : {};
          return { total: Number(result?.total || 0), list: decorated, typeMap };
        } catch (error) {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: buildApiErrorMessage(error),
          });
          return { total: 0, list: [], typeMap: {} };
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
      merged.sort((a, b) => pickSortTime(b) - pickSortTime(a));
      const typeMap = resultGroups.reduce((acc, group) => Object.assign(acc, group.typeMap || {}), {});
      if (!merged.length && failures.length) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `违规管理列表加载失败：${summary}` : '违规管理列表加载失败' };
      }
      return {
        pageNo,
        pageSize,
        total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
        list: merged,
        typeMap,
        failures,
      };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getViolationApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('violation-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.violationAppealSn && !params.violation_appeal_sn && !params.violationNo && !params.noticeSn && !params.notice_sn) {
      return { error: '缺少违规单号' };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getViolationApiClient(shopId).getDetail(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = { registerViolationIpc };
