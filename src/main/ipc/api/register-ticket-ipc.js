'use strict';

/**
 * 工单 + 售后域 IPC 注册器。
 *
 * 把原 register-api-ipc.js 中的 ticket-get-list / ticket-get-detail / 一组
 * aftersale-* channel 全部收口。这里所有 channel 共享两类调用约定：
 * - 只读读接口走 buildReadonlyTicketRequestOptions（allowPageRequest: false），
 *   失败不落 page-fallback；
 * - 写接口（如 approve / reject submit / merchant-refuse）走 buildWriteTicketRequestOptions，
 *   并在 invokePageApiWithRetry 中显式开 allowInitSessionRetry，避免 anti_content
 *   老化时直接 fail。
 *
 * 多店铺聚合（API_ALL_SHOPS）的 ticket-get-list / aftersale-get-list /
 * aftersale-get-overview 三组接口都走「apiReadyOnly 过滤 + 并发 + 时间倒序合并 +
 * 失败汇入 failures」的统一模式。
 */
function registerTicketIpc({
  ipcMain,
  sharedHelpers,
  getTicketApiClient,
  getApiShopList,
}) {
  const {
    API_ALL_SHOPS,
    resolveShopId,
    buildApiErrorMessage,
    getBusinessUnavailableMessage,
    invokePageApiWithRetry,
  } = sharedHelpers;

  function buildReadonlyTicketRequestOptions(source) {
    return {
      allowPageRequest: false,
      source: String(source || 'ticket-readonly'),
    };
  }

  function buildWriteTicketRequestOptions(source) {
    return {
      source: String(source || 'ticket-write'),
    };
  }

  ipcMain.handle('ticket-get-list', async (event, params = {}) => {
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
        return { pageNo, pageSize, total: 0, list: [], failures };
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
        item?.updateTime
        ?? item?.update_time
        ?? item?.updatedAt
        ?? item?.updated_at
        ?? item?.createTime
        ?? item?.create_time
        ?? item?.createdAt
        ?? item?.created_at
      );

      const resultGroups = await Promise.all(targetShops.map(async shop => {
        try {
          const forwardedParams = { ...params };
          if ('shopId' in forwardedParams) delete forwardedParams.shopId;
          const result = await invokePageApiWithRetry(shop.id, () => getTicketApiClient(shop.id).getList({
            ...forwardedParams,
            pageNo,
            pageSize,
          }, buildReadonlyTicketRequestOptions('ticket-get-list')));
          const list = Array.isArray(result?.list) ? result.list : [];
          const decorated = list.map(item => ({
            ...item,
            shopId: shop.id,
            shopName: item.shopName || shop.name || '未知店铺',
          }));
          return { total: Number(result?.total || 0), list: decorated };
        } catch (error) {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未知店铺',
            message: buildApiErrorMessage(error),
          });
          return { total: 0, list: [] };
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
      if (!merged.length && failures.length) {
        const summary = failures
          .slice(0, 3)
          .map(item => `${item.shopName || item.shopId}：${item.message}`)
          .join('；');
        return { error: summary ? `工单列表加载失败：${summary}` : '工单列表加载失败' };
      }
      return {
        pageNo,
        pageSize,
        total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
        list: merged,
        failures,
      };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getList(
        params,
        buildReadonlyTicketRequestOptions('ticket-get-list')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-list', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));
      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
        const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 50));
        return { pageNo, pageSize, total: 0, list: [], failures };
      }
      const failures = [];
      const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
      const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 50));
      const debug = params?.debug === true;

      const parseTimeToMs = (value) => {
        if (value === undefined || value === null || value === '') return 0;
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
        const date = new Date(String(value));
        const ms = date.getTime();
        return Number.isNaN(ms) ? 0 : ms;
      };

      const pickSortTime = (item) => parseTimeToMs(
        item?.updatedAt
        ?? item?.updated_at
        ?? item?.updateTime
        ?? item?.update_time
        ?? item?.modifyTime
        ?? item?.modify_time
        ?? item?.applyTime
        ?? item?.apply_time
        ?? item?.createdAt
        ?? item?.created_at
        ?? item?.createTime
        ?? item?.create_time
      );

      try {
        const resultGroups = await Promise.all(targetShops.map(async shop => {
          try {
            const forwardedParams = { ...params };
            if ('shopId' in forwardedParams) delete forwardedParams.shopId;
            const result = await invokePageApiWithRetry(shop.id, () => getTicketApiClient(shop.id).getRefundList({
              ...forwardedParams,
              pageNo,
              pageSize,
            }, buildReadonlyTicketRequestOptions('aftersale-get-list')));
            const list = Array.isArray(result?.list) ? result.list : [];
            const decorated = list.map(item => ({
              ...item,
              shopId: shop.id,
              shopName: item.shopName || shop.name || '未知店铺',
            }));
            return { total: Number(result?.total || 0), list: decorated, payloadMeta: result?.payloadMeta || null, requestBody: result?.requestBody || null };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { total: 0, list: [] };
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
          .flatMap(group => group.list)
          .sort((a, b) => pickSortTime(b) - pickSortTime(a));

        const response = {
          pageNo,
          pageSize,
          total: resultGroups.reduce((sum, group) => sum + Number(group.total || 0), 0),
          list: merged,
          failures,
        };
        if (debug) {
          const samples = resultGroups
            .map((group, idx) => ({ group, shop: targetShops[idx] }))
            .slice(0, 6)
            .map(item => ({
              shopId: item.shop?.id,
              shopName: item.shop?.name || '未命名店铺',
              total: Number(item.group?.total || 0),
              listLen: Array.isArray(item.group?.list) ? item.group.list.length : 0,
              requestBodyKeys: item.group?.requestBody && typeof item.group.requestBody === 'object' ? Object.keys(item.group.requestBody) : [],
              payloadMeta: item.group?.payloadMeta || null,
            }));
          response.debug = {
            shopCount: targetShops.length,
            failuresCount: failures.length,
            samples,
          };
        }
        return response;
      } catch (error) {
        return { pageNo, pageSize, total: 0, list: [], failures, error: buildApiErrorMessage(error) };
      }
    }
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRefundList(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-list')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-regions', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRegionChildren(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-regions')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-shipping-companies', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getShippingCompanyList(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-shipping-companies')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-shipping-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    if (!params.orderSn && !params.order_sn && !params.orderNo && !params.order_no) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getChatShippingDetail(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-get-shipping-detail')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-list-refund-addresses', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).listRefundAddresses(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-list-refund-addresses')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-approve-return-goods', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).approveReturnGoods(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-approve-return-goods')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-approve-return-goods' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-approve-resend', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).approveResend(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-approve-resend')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-approve-resend' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-agree-refund-precheck', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).agreeRefundPreCheck(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-agree-refund-precheck')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-precheck', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundPreCheck(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-precheck')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-get-form-info', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? params.bizId
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundGetFormInfo(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-get-form-info')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-get-negotiate-info', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRejectRefundNegotiateInfo(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-get-negotiate-info')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-submit', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).rejectRefundSubmit(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-reject-refund-submit')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-reject-refund-submit' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-get-reasons', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundGetReasons(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-get-reasons')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-reject-refund-validate', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).rejectRefundValidate(
        forwardedParams,
        buildReadonlyTicketRequestOptions('aftersale-reject-refund-validate')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-merchant-refuse', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const instanceId = String(
      params.instanceId
      ?? params.afterSalesId
      ?? params.after_sales_id
      ?? params.id
      ?? ''
    ).trim();
    if (!instanceId) return { error: '缺少售后单ID' };
    const orderSn = String(params.orderSn ?? params.order_sn ?? params.orderNo ?? params.order_no ?? '').trim();
    if (!orderSn) return { error: '缺少订单号' };
    const version = Number(params.version ?? 0);
    if (!Number.isFinite(version) || version <= 0) return { error: '缺少版本号' };
    try {
      const forwardedParams = { ...params };
      if ('shopId' in forwardedParams) delete forwardedParams.shopId;
      return await invokePageApiWithRetry(
        shopId,
        () => getTicketApiClient(shopId).merchantAfterSalesRefuse(
          forwardedParams,
          buildWriteTicketRequestOptions('aftersale-merchant-refuse')
        ),
        { allowInitSessionRetry: true, source: 'aftersale-merchant-refuse' }
      );
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('aftersale-get-overview', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    const statusLabels = {
      waitSellerHandle: '待商家处理',
      platformHandling: '平台处理中',
      waitBuyerHandle: '待买家处理',
      returnedWaitHandle: '退货待处理',
      expireIn24HoursWaitHandle: '即将逾期',
    };

    const mergeCounts = (target, countsObj) => {
      const next = { ...(target || {}) };
      if (!countsObj || typeof countsObj !== 'object') return next;
      Object.keys(countsObj).forEach(key => {
        const count = Number(countsObj[key] || 0);
        if (Number.isFinite(count)) {
          next[key] = Number(next[key] || 0) + count;
        }
      });
      return next;
    };

    if (shopId === API_ALL_SHOPS) {
      const targetShops = getApiShopList(API_ALL_SHOPS, { apiReadyOnly: true });
      const allShops = getApiShopList(API_ALL_SHOPS);
      const skippedShops = allShops.filter(shop => !targetShops.some(target => target.id === shop.id));

      if (!targetShops.length) {
        const failures = skippedShops.map(shop => ({
          shopId: shop.id,
          shopName: shop.name || '未命名店铺',
          message: getBusinessUnavailableMessage(shop),
        }));
        return { shopId, counts: {}, total: 0, statusLabels, failures };
      }
      const failures = [];
      try {
        const results = await Promise.all(targetShops.map(async shop => {
          try {
            const result = await invokePageApiWithRetry(shop.id, () => getTicketApiClient(shop.id).getRefundCount(
              {},
              buildReadonlyTicketRequestOptions('aftersale-get-overview')
            ));
            return { shopId: shop.id, shopName: shop.name || '未命名店铺', countsObj: result?.counts || {} };
          } catch (error) {
            failures.push({
              shopId: shop.id,
              shopName: shop.name || '未命名店铺',
              message: buildApiErrorMessage(error),
            });
            return { shopId: shop.id, shopName: shop.name || '未命名店铺', countsObj: {} };
          }
        }));

        skippedShops.forEach(shop => {
          failures.push({
            shopId: shop.id,
            shopName: shop.name || '未命名店铺',
            message: getBusinessUnavailableMessage(shop),
          });
        });

        const counts = results.reduce((acc, item) => mergeCounts(acc, item.countsObj), {});
        const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
        return { shopId, counts, total, statusLabels, failures };
      } catch (error) {
        return { shopId, counts: {}, total: 0, statusLabels, failures, error: buildApiErrorMessage(error) };
      }
    }

    try {
      const result = await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getRefundCount(
        {},
        buildReadonlyTicketRequestOptions('aftersale-get-overview')
      ));
      const counts = result?.counts || {};
      const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
      return { shopId, counts, total, statusLabels, failures: [] };
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });

  ipcMain.handle('ticket-get-detail', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (!params.instanceId && !params.instance_id && !params.ticketNo && !params.ticket_no && !params.todoId && !params.todo_id && !params.id) {
      return { error: '缺少工单实例 ID' };
    }
    try {
      return await invokePageApiWithRetry(shopId, () => getTicketApiClient(shopId).getDetail(
        params,
        buildReadonlyTicketRequestOptions('ticket-get-detail')
      ));
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = { registerTicketIpc };
