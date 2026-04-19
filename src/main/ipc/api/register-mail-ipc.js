'use strict';

/**
 * 站内信域 IPC 注册器：负责 mail-get-overview / mail-get-list / mail-get-detail。
 *
 * 单店铺直接走 MailApiClient；API_ALL_SHOPS 时按 apiReadyOnly 过滤店铺：
 * - overview 聚合 categories / msgBoxCount / customSubMsgTypeList 等汇总字段；
 * - list 按 sendTime 倒序合并，分页大小固定 50，最多 maxPages（默认 50）页防止飘走；
 * - detail 直接转发给指定店铺。
 */
function registerMailIpc({
  ipcMain,
  sharedHelpers,
  getMailApiClient,
  getApiShopList,
}) {
  const {
    API_ALL_SHOPS,
    resolveShopId,
    buildApiErrorMessage,
    getBusinessUnavailableMessage,
    invokePageApiWithRetry,
  } = sharedHelpers;

  ipcMain.handle('mail-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const failures = [];
      if (!targetShops.length) {
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        return {
          userId: 0,
          totalNum: 0,
          unreadNum: 0,
          categories: [],
          msgBoxCount: 0,
          innerMsgCount: 0,
          normalTotal: 0,
          customSubMsgTypeList: [],
          failures,
        };
      }
      try {
        const results = await Promise.all(targetShops.map(async shop => {
          try {
            const result = await invokePageApiWithRetry(shop.id, () => getMailApiClient(shop.id).getOverview());
            return {
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              result,
            };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return null;
          }
        }));
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        const categoryMap = new Map();
        let totalNum = 0;
        let unreadNum = 0;
        let msgBoxCount = 0;
        let innerMsgCount = 0;
        let normalTotal = 0;
        const customSubMsgTypeSet = new Set();
        results.filter(Boolean).forEach(entry => {
          const result = entry?.result || {};
          totalNum += Number(result.totalNum || 0);
          unreadNum += Number(result.unreadNum || 0);
          msgBoxCount += Number(result.msgBoxCount || 0);
          innerMsgCount += Number(result.innerMsgCount || 0);
          normalTotal += Number(result.normalTotal || 0);
          const categories = Array.isArray(result.categories) ? result.categories : [];
          categories.forEach(item => {
            const key = Number(item?.contentType);
            if (!Number.isFinite(key)) return;
            const prev = categoryMap.get(key) || {
              contentType: key,
              label: item?.label || `类型 ${key}`,
              unreadCount: 0,
              totalCount: 0,
            };
            prev.unreadCount += Number(item?.unreadCount || 0);
            if (item?.totalCount !== null && item?.totalCount !== undefined) {
              prev.totalCount += Number(item.totalCount || 0);
            } else {
              prev.totalCount = null;
            }
            categoryMap.set(key, prev);
          });
          const customList = Array.isArray(result.customSubMsgTypeList) ? result.customSubMsgTypeList : [];
          customList.forEach(item => {
            const text = String(item || '').trim();
            if (text) customSubMsgTypeSet.add(text);
          });
        });
        const categories = Array.from(categoryMap.values()).sort((a, b) => Number(a.contentType || 0) - Number(b.contentType || 0));
        return {
          userId: 0,
          totalNum,
          unreadNum,
          categories,
          msgBoxCount,
          innerMsgCount,
          normalTotal,
          customSubMsgTypeList: Array.from(customSubMsgTypeSet),
          failures,
        };
      } catch (error) {
        return { error: buildApiErrorMessage(error) };
      }
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getMailApiClient(shopId).getOverview());
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('mail-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      const failures = [];
      const contentType = Number(params.contentType ?? -1);
      const pageSize = 50;
      const maxPages = Math.max(1, Math.min(100, Number(params.maxPages || 50)));
      if (!targetShops.length) {
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        return {
          contentType,
          pageNum: 1,
          size: pageSize,
          totalCount: 0,
          list: [],
          failures,
        };
      }
      try {
        const resultGroups = await Promise.all(targetShops.map(async shop => {
          try {
            let pageNum = 1;
            let totalCount = 0;
            let combined = [];
            while (pageNum <= maxPages) {
              const result = await invokePageApiWithRetry(shop.id, () => getMailApiClient(shop.id).getList({
                ...params,
                pageNum,
                size: pageSize,
              }));
              const list = Array.isArray(result?.list) ? result.list : [];
              totalCount = Math.max(totalCount, Number(result?.totalCount || 0));
              combined = combined.concat(list.map(item => ({
                ...item,
                shopId: shop.id,
                shopName: item.shopName || shop.name || '未知店铺',
              })));
              if (!list.length) break;
              if (totalCount && combined.length >= totalCount) break;
              pageNum += 1;
            }
            return {
              totalCount: Math.max(totalCount, combined.length),
              list: combined,
            };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { totalCount: 0, list: [] };
          }
        }));
        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });
        const merged = resultGroups
          .flatMap(group => group.list || [])
          .sort((a, b) => Number(b.sendTime || 0) - Number(a.sendTime || 0));
        if (!merged.length && failures.length) {
          const summary = failures
            .slice(0, 3)
            .map(item => `${item.shopName || item.shopId}：${item.message}`)
            .join('；');
          return { error: summary ? `站内信列表加载失败：${summary}` : '站内信列表加载失败' };
        }
        return {
          contentType,
          pageNum: 1,
          size: merged.length,
          totalCount: merged.length,
          list: merged,
          failures,
        };
      } catch (error) {
        return { error: buildApiErrorMessage(error) };
      }
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getMailApiClient(shopId).getList(params));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('mail-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.messageId) return { error: '缺少 messageId' };
    try {
      return await invokePageApiWithRetry(shopId, () => getMailApiClient(shopId).getDetail(params.messageId));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = { registerMailIpc };
