const { shell } = require('electron');
const { createApiSharedHelpers } = require('./shared/api-shared-helpers');
const { registerChatIpc } = require('./api/register-chat-ipc');
const { registerOrderIpc } = require('./api/register-order-ipc');
const { registerMailIpc } = require('./api/register-mail-ipc');
const { registerInvoiceIpc } = require('./api/register-invoice-ipc');
const { registerDeductionIpc } = require('./api/register-deduction-ipc');
const { registerViolationIpc } = require('./api/register-violation-ipc');
const { registerTicketIpc } = require('./api/register-ticket-ipc');

function registerApiIpc({
  ipcMain,
  dialog,
  store,
  API_ALL_SHOPS,
  getMainWindow,
  getShopManager,
  getApiClient,
  getApiSessionsByScope,
  uploadImageViaPddPage,
  getApiShopList,
  destroyApiClient,
  getApiTrafficByScope,
  getMailApiClient,
  getInvoiceApiClient,
  getTicketApiClient,
  getViolationApiClient,
  getDeductionApiClient,
  getApiShopAvailabilityStatus,
  setApiTrafficEntries
}) {
  // shared helpers 由 chat / order / mail / invoice / deduction / violation /
  // ticket 等多组 channel 共用，统一在 ./shared/api-shared-helpers.js 通过
  // 工厂构造，避免每个 register-xxx-ipc.js 各自复制粘贴。
  const sharedHelpers = createApiSharedHelpers({
    store,
    API_ALL_SHOPS,
    getShopManager,
    getApiClient,
    getApiShopAvailabilityStatus,
  });

  const { resolveShopId, buildApiErrorMessage } = sharedHelpers;

  registerChatIpc({
    ipcMain,
    dialog,
    store,
    sharedHelpers,
    getMainWindow,
    getApiClient,
    getApiSessionsByScope,
    uploadImageViaPddPage,
    getApiShopList,
    destroyApiClient,
    getApiShopAvailabilityStatus,
  });
  registerOrderIpc({ ipcMain, sharedHelpers, getApiClient });
  registerMailIpc({ ipcMain, sharedHelpers, getMailApiClient, getApiShopList });
  registerInvoiceIpc({ ipcMain, sharedHelpers, getInvoiceApiClient, getApiShopList });
  registerDeductionIpc({ ipcMain, sharedHelpers, getDeductionApiClient, getApiShopList });
  registerViolationIpc({ ipcMain, sharedHelpers, getViolationApiClient, getApiShopList });
  registerTicketIpc({ ipcMain, sharedHelpers, getTicketApiClient, getApiShopList });

  function buildTicketStatusCountSummary(result = {}) {
    const rawList = Array.isArray(result?.list) ? result.list : [];
    const normalized = rawList
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const label = String(
          item.statusDesc
          || item.status_desc
          || item.name
          || item.label
          || item.text
          || item.status
          || item.code
          || ''
        ).trim();
        const count = Number(
          item.count
          ?? item.num
          ?? item.total
          ?? item.value
          ?? 0
        );
        return {
          label,
          count: Number.isFinite(count) ? count : 0
        };
      })
      .filter(Boolean);
    return {
      itemCount: normalized.length,
      totalCount: normalized.reduce((sum, item) => sum + Number(item.count || 0), 0),
      items: normalized.slice(0, 10)
    };
  }

  function buildInvoiceOverviewSummary(result = {}) {
    return {
      pendingNum: Number(result?.pendingNum || 0),
      invoicedNum: Number(result?.invoicedNum || 0),
      applyingNum: Number(result?.applyingNum || 0),
      invoiceAmount: Number(result?.invoiceAmount || 0),
      quickPendingTotal: Number(result?.quickPendingTotal || 0),
      qualityPendingTotal: Number(result?.qualityPendingTotal || 0),
      normalPendingTotal: Number(result?.normalPendingTotal || 0),
      showInvoiceMarkTab: !!result?.showInvoiceMarkTab,
      isThirdPartySubMall: !!result?.isThirdPartySubMall,
    };
  }

  function buildInvoiceListSummary(result = {}) {
    const rawList = Array.isArray(result?.list) ? result.list : [];
    return {
      pageNo: Number(result?.pageNo || 1),
      pageSize: Number(result?.pageSize || rawList.length || 0),
      total: Number(result?.total || 0),
      sample: rawList.slice(0, 3).map(item => ({
        serialNo: String(item?.serialNo || ''),
        orderSn: String(item?.orderSn || ''),
        orderStatus: String(item?.orderStatus || ''),
        invoiceApplyStatus: String(item?.invoiceApplyStatus || ''),
        invoiceDisplayStatus: Number(item?.invoiceDisplayStatus || 0),
      }))
    };
  }

  function buildViolationListSummary(result = {}) {
    const rawList = Array.isArray(result?.list) ? result.list : [];
    const sample = rawList.slice(0, 3).map(item => ({
      violationAppealSn: String(
        item?.violationAppealSn
        || item?.violation_appeal_sn
        || item?.noticeSn
        || item?.notice_sn
        || item?.serialNo
        || item?.serial_no
        || ''
      ),
      violationType: String(
        item?.violationTypeStr
        || item?.violation_type_str
        || item?.violationType
        || item?.violation_type
        || ''
      ),
      appealStatus: String(
        item?.appealStatusStr
        || item?.appeal_status_str
        || item?.appealStatus
        || item?.appeal_status
        || ''
      ),
      noticeTime: String(
        item?.noticeTime
        || item?.notice_time
        || item?.violationTime
        || item?.violation_time
        || ''
      )
    }));
    return {
      pageNo: Number(result?.pageNo || 1),
      pageSize: Number(result?.pageSize || rawList.length || 0),
      total: Number(result?.total || 0),
      typeCount: result?.typeMap && typeof result.typeMap === 'object'
        ? Object.keys(result.typeMap).length
        : 0,
      sample
    };
  }

  ipcMain.handle('probe-safe-business-apis', async (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return { error: '没有可用店铺' };
    if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
    const probeOptions = {
      invoiceOverview: params?.probes?.invoiceOverview !== false,
      invoiceList: params?.probes?.invoiceList === true,
      ticketStatusCount: params?.probes?.ticketStatusCount === true,
      violationList: params?.probes?.violationList === true,
    };
    const invoice = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.invoiceOverview
    };
    const invoiceList = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.invoiceList
    };
    const ticket = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.ticketStatusCount
    };
    const violationList = {
      success: false,
      error: '',
      summary: null,
      skipped: !probeOptions.violationList
    };

    if (probeOptions.invoiceOverview) {
      try {
        const result = await getInvoiceApiClient(shopId).getOverview();
        invoice.success = true;
        invoice.summary = buildInvoiceOverviewSummary(result);
      } catch (error) {
        invoice.error = buildApiErrorMessage(error);
      }
    }

    if (probeOptions.invoiceList) {
      try {
        const result = await getInvoiceApiClient(shopId).getList({
          pageNo: 1,
          pageSize: 5
        });
        invoiceList.success = true;
        invoiceList.summary = buildInvoiceListSummary(result);
      } catch (error) {
        invoiceList.error = buildApiErrorMessage(error);
      }
    }

    if (probeOptions.ticketStatusCount) {
      try {
        const result = await getTicketApiClient(shopId).getStatusCount({
          allowPageRequest: false
        });
        ticket.success = true;
        ticket.summary = buildTicketStatusCountSummary(result);
      } catch (error) {
        ticket.error = buildApiErrorMessage(error);
      }
    }

    if (probeOptions.violationList) {
      try {
        const result = await getViolationApiClient(shopId).getList({
          pageNo: 1,
          pageSize: 5
        });
        violationList.success = true;
        violationList.summary = buildViolationListSummary(result);
      } catch (error) {
        violationList.error = buildApiErrorMessage(error);
      }
    }

    return {
      shopId,
      success: invoice.success || invoiceList.success || ticket.success || violationList.success,
      invoice,
      invoiceList,
      ticket
      ,
      violationList
    };
  });

  ipcMain.handle('get-api-traffic', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return [];
    return getApiTrafficByScope(shopId);
  });

  ipcMain.handle('clear-api-traffic', (event, params = {}) => {
    const shopId = resolveShopId(params);
    if (!shopId) return false;
    if (shopId === API_ALL_SHOPS) {
      getApiShopList(API_ALL_SHOPS).forEach(shop => setApiTrafficEntries(shop.id, []));
      return true;
    }
    setApiTrafficEntries(shopId, []);
    return true;
  });

  ipcMain.handle('open-external-url', async (event, input) => {
    const url = String(input?.url || input || '').trim();
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return { error: '无效链接' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return { error: buildApiErrorMessage(error) };
    }
  });
}

module.exports = {
  registerApiIpc
};
