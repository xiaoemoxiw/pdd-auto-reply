// 小额打款 modal（补运费 / 补差价 / 其他）业务 API + 入口编排
//
// UI（订单选择器、表单、状态卡片、tips 区）已迁移到：
//   - src/renderer/vue/modals/ModalApiSmallPaymentOrderSelect.vue
//   - src/renderer/vue/modals/ModalApiSmallPayment.vue
//
// 本文件保留：
// - 候选订单的获取（基于 side order store + ensure 异步刷新）；
// - 类型 meta（补运费 / 补差价 / 其他）与默认留言；
// - 金额输入校验（input/blur 两段 clamp，受 info.limitAmount 与订单 baseAmount 约束）；
// - apiGetSmallPaymentInfo / apiSubmitSmallPayment 的 IPC 封装；
// - btnApiSmallPayment 入口绑定 + 决定先弹 selector 还是直接弹表单；
// - 提交成功后的 cashierUrl 跳转 + switchView 联动。
//
// 通过 window.smallPaymentModule 暴露给 Vue 组件复用。
(function () {
  const NOTE_MAX_LENGTH = 60;
  const MAX_TIMES = 3;

  function getRuntime() {
    return window.__chatApiModuleAccess || {};
  }

  function getState() {
    const runtime = getRuntime();
    if (typeof runtime.getState === 'function') return runtime.getState() || {};
    return {};
  }

  function callRuntime(name, ...args) {
    const runtime = getRuntime();
    const fn = runtime[name];
    if (typeof fn === 'function') return fn(...args);
    return undefined;
  }

  function helpers() {
    return window.__chatApiModuleHelpers || {};
  }

  function setApiHint(text) {
    const fn = helpers().setApiHint;
    if (typeof fn === 'function') fn(text);
  }

  function recordApiSyncState(label, detail = '') {
    const fn = helpers().recordApiSyncState;
    if (typeof fn === 'function') fn(label, detail);
  }

  function getApiSideOrderItem(orderKey = '') {
    const fn = helpers().getApiSideOrderItem;
    return typeof fn === 'function' ? fn(orderKey) : null;
  }

  function showApiSideOrderToast(message) {
    const fn = helpers().showApiSideOrderToast;
    if (typeof fn === 'function') fn(message);
  }

  function closeApiSideOrderPriceEditor() {
    const fn = helpers().closeApiSideOrderPriceEditor;
    if (typeof fn === 'function') fn();
  }

  function resetApiSideOrderRemarkEditorFlags() {
    const fn = helpers().resetApiSideOrderRemarkEditorFlags;
    if (typeof fn === 'function') fn();
  }

  function formatApiSideOrderMoneyNumber(value) {
    const fn = helpers().formatApiSideOrderMoneyNumber;
    return typeof fn === 'function' ? fn(value) : '';
  }

  function getApiSideOrderPriceBaseAmount(order = {}) {
    const fn = helpers().getApiSideOrderPriceBaseAmount;
    return typeof fn === 'function' ? fn(order) : 0;
  }

  function ensureApiSideOrderSessionScope() {
    const fn = helpers().ensureApiSideOrderSessionScope;
    if (typeof fn === 'function') fn();
  }

  function getApiSideOrderSession() {
    const fn = helpers().getApiSideOrderSession;
    return typeof fn === 'function' ? fn() : null;
  }

  function getApiSideOrderEntry(tab = 'personal') {
    const fn = helpers().getApiSideOrderEntry;
    return typeof fn === 'function' ? fn(tab) : { items: [] };
  }

  function loadApiSideOrders(tab = 'personal') {
    const fn = helpers().loadApiSideOrders;
    return typeof fn === 'function' ? fn(tab) : Promise.resolve();
  }

  function getApiSideOrderStore() {
    const fn = helpers().getApiSideOrderStore;
    return typeof fn === 'function' ? fn() : {};
  }

  function getApiSessionKey(...args) {
    const fn = helpers().getApiSessionKey || window.getApiSessionKey;
    return typeof fn === 'function' ? fn(...args) : '';
  }

  function normalizeApiRefundAmountInputValue(value) {
    const fn = helpers().normalizeApiRefundAmountInputValue;
    return typeof fn === 'function' ? fn(value) : '';
  }

  function formatApiRefundAmountInputValue(value) {
    const fn = helpers().formatApiRefundAmountInputValue;
    return typeof fn === 'function' ? fn(value) : '';
  }

  // ---------- 业务规则 ----------

  function getApiSmallPaymentTypeMeta(type = 'shipping') {
    if (type === 'difference') {
      return { label: '补差价', refundType: null, notePlaceholder: '已补差价给您，请查收' };
    }
    if (type === 'other') {
      return { label: '其他', refundType: 2, notePlaceholder: '已补偿给您，请查收' };
    }
    return { label: '补运费', refundType: null, notePlaceholder: '已补运费给您，请查收' };
  }

  function getApiSmallPaymentOrderQuantity(order = {}) {
    const detailText = String(order?.detailText || '').trim();
    const match = detailText.match(/(?:^|\s)x\s*(\d+)\s*$/i);
    return match ? `x ${match[1]}` : '';
  }

  function getApiSmallPaymentMaxAmount(order = {}, info = null) {
    const infoLimitAmount = Number(info?.limitAmount || 0);
    if (Number.isFinite(infoLimitAmount) && infoLimitAmount > 0) return infoLimitAmount;
    return Math.max(0, getApiSideOrderPriceBaseAmount(order));
  }

  function clampApiSmallPaymentAmountInputValue(value, options = {}) {
    const normalized = options.formatted
      ? formatApiRefundAmountInputValue(value)
      : normalizeApiRefundAmountInputValue(value);
    if (!normalized) return '';
    const maxAmount = getApiSmallPaymentMaxAmount(options.order || {}, options.info || null);
    if (!maxAmount) return normalized;
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) return '';
    const bounded = Math.min(Math.max(numeric, 0), maxAmount);
    return options.formatted
      ? formatApiRefundAmountInputValue(bounded)
      : normalizeApiRefundAmountInputValue(bounded);
  }

  // ---------- 候选订单 ----------

  function getApiSmallPaymentCandidateOrders() {
    const store = getApiSideOrderStore();
    const items = Array.isArray(store?.personal?.items) ? store.personal.items : [];
    return items.filter(item => item && item.key && (item.orderId || item.orderSn));
  }

  async function ensureApiSmallPaymentCandidateOrders() {
    const existing = getApiSmallPaymentCandidateOrders();
    if (existing.length) return existing;
    const state = getState();
    if (!state.apiActiveSessionId || !state.apiActiveSessionShopId) return [];
    ensureApiSideOrderSessionScope();
    const session = getApiSideOrderSession();
    if (!session) return [];
    const entry = getApiSideOrderEntry('personal');
    entry.cacheKey = `${getApiSessionKey(session.shopId, session.sessionId)}::personal`;
    entry.loading = true;
    entry.error = '';
    await loadApiSideOrders('personal');
    return getApiSmallPaymentCandidateOrders();
  }

  // ---------- IPC 封装 ----------

  async function loadApiSmallPaymentInfo({ shopId, orderSn } = {}) {
    if (!window.pddApi?.apiGetSmallPaymentInfo || !shopId || !orderSn) {
      return { canSubmit: false, transferDesc: '当前环境不支持小额打款信息查询' };
    }
    try {
      const result = await window.pddApi.apiGetSmallPaymentInfo({ shopId, orderSn });
      if (!result || result.error) {
        const message = result?.error || '获取小额打款信息失败';
        setApiHint(message);
        return { canSubmit: false, transferDesc: message };
      }
      return result;
    } catch (error) {
      const message = error?.message || '获取小额打款信息失败';
      setApiHint(message);
      return { canSubmit: false, transferDesc: message };
    }
  }

  async function submitApiSmallPayment(payload = {}) {
    const order = payload.order || {};
    const info = payload.info || null;
    const state = getState();
    if (!order?.orderId && !order?.orderSn) {
      showApiSideOrderToast('未找到对应订单');
      return { success: false, error: 'no-order' };
    }
    const type = payload.type || 'shipping';
    const meta = getApiSmallPaymentTypeMeta(type);
    const amountText = clampApiSmallPaymentAmountInputValue(payload.amountText, {
      order,
      info,
      formatted: true,
    });
    if (!amountText) {
      setApiHint('请输入正确的打款金额');
      return { success: false, error: 'no-amount', amountText: '' };
    }
    const noteText = String(payload.noteText || '').trim() || meta.notePlaceholder;
    recordApiSyncState(
      '小额打款弹窗',
      `订单：${order.orderId || order.orderSn || '-'}；类型：${meta.label}；金额：¥${amountText}；留言：${noteText}`,
    );
    if (info?.submitTemplateReady === false && !info?.transferDesc) {
      setApiHint('当前店铺尚未捕获小额打款真实提交模板，请先在后台页面完成一次小额打款');
      showApiSideOrderToast('未捕获真实提交模板');
      return { success: false, error: 'no-template' };
    }
    if (!window.pddApi?.apiSubmitSmallPayment) {
      setApiHint('当前版本缺少小额打款提交能力');
      showApiSideOrderToast('提交能力不可用');
      return { success: false, error: 'no-submit-api' };
    }
    try {
      const submitResult = await window.pddApi.apiSubmitSmallPayment({
        shopId: state.apiActiveSessionShopId,
        orderSn: order.orderId || order.orderSn,
        amount: amountText,
        refundType: meta.refundType ?? type,
        remarks: noteText,
        chargeType: info?.channel || undefined,
      });
      if (!submitResult || submitResult.error) {
        const message = submitResult?.error || '提交小额打款失败';
        setApiHint(message);
        showApiSideOrderToast(message);
        return { success: false, error: message };
      }
      if (submitResult.cashierUrl) {
        if (window.pddApi?.navigatePdd) {
          try { await window.pddApi.navigatePdd(submitResult.cashierUrl); } catch {}
        }
        showApiSideOrderToast('已跳转到后台收银台');
        setApiHint('已创建小额打款，请在后台收银台完成支付');
        try { await callRuntime('switchView', 'chat'); } catch {}
        return { success: true, navigated: true, amountText };
      }
      setApiHint('小额打款已提交成功');
      showApiSideOrderToast('小额打款已提交');
      return { success: true, navigated: false, amountText };
    } catch (error) {
      const message = error?.message || '提交小额打款失败';
      setApiHint(message);
      showApiSideOrderToast(message);
      return { success: false, error: message };
    }
  }

  // ---------- 入口编排 ----------

  function openApiSmallPaymentModalWith(orderKey) {
    if (!window.vueBridge?.openModal) return;
    const order = getApiSideOrderItem(String(orderKey || ''));
    if (!order) {
      showApiSideOrderToast('未找到对应订单');
      return;
    }
    closeApiSideOrderPriceEditor();
    resetApiSideOrderRemarkEditorFlags();
    if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiSmallPaymentOrderSelect');
    window.vueBridge.openModal('modalApiSmallPayment', { order });
  }

  function openApiSmallPaymentOrderSelectModal(candidates) {
    if (!window.vueBridge?.openModal) return;
    window.vueBridge.openModal('modalApiSmallPaymentOrderSelect', {
      candidates: Array.isArray(candidates) ? candidates : [],
    });
  }

  async function openApiSmallPaymentOrderSelector(options = {}) {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    const preferredOrderKey = String(options?.orderKey || '').trim();
    const orders = await ensureApiSmallPaymentCandidateOrders();
    if (!orders.length) {
      setApiHint('当前会话暂无可选订单');
      showApiSideOrderToast('当前会话暂无可选订单');
      return;
    }
    if (preferredOrderKey) {
      const matched = orders.find(item => String(item?.key || '') === preferredOrderKey);
      if (matched) {
        openApiSmallPaymentModalWith(matched.key);
        return;
      }
    }
    if (orders.length === 1) {
      openApiSmallPaymentModalWith(orders[0]?.key || '');
      return;
    }
    openApiSmallPaymentOrderSelectModal(orders);
  }

  function closeApiSmallPaymentOrderSelector() {
    if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiSmallPaymentOrderSelect');
  }

  function openApiSmallPaymentModal(orderKey = '') {
    const normalized = String(orderKey || '').trim();
    if (!normalized) {
      void openApiSmallPaymentOrderSelector();
      return;
    }
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    openApiSmallPaymentModalWith(normalized);
  }

  function closeApiSmallPaymentModal() {
    if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiSmallPayment');
  }

  function selectApiSmallPaymentOrder(orderKey = '') {
    const next = getApiSideOrderItem(String(orderKey || '').trim());
    if (!next) {
      showApiSideOrderToast('未找到对应订单');
      return null;
    }
    return next;
  }

  function reopenApiSmallPaymentOrderSelector() {
    closeApiSmallPaymentModal();
    void openApiSmallPaymentOrderSelector();
  }

  function bindSmallPaymentModule() {
    document.getElementById('btnApiSmallPayment')?.addEventListener('click', () => {
      void openApiSmallPaymentOrderSelector();
    });
  }

  // 兼容外部入口：原生侧 chat-api-module / 主进程侧脚本可能调用这些
  window.openApiSmallPaymentOrderSelector = openApiSmallPaymentOrderSelector;
  window.closeApiSmallPaymentOrderSelector = closeApiSmallPaymentOrderSelector;
  window.openApiSmallPaymentModal = openApiSmallPaymentModal;
  window.closeApiSmallPaymentModal = closeApiSmallPaymentModal;

  window.smallPaymentModule = Object.assign(window.smallPaymentModule || {}, {
    constants: {
      NOTE_MAX_LENGTH,
      MAX_TIMES,
    },
    getApiSmallPaymentTypeMeta,
    getApiSmallPaymentOrderQuantity,
    getApiSmallPaymentMaxAmount,
    clampApiSmallPaymentAmountInputValue,
    formatApiSideOrderMoneyNumber,
    getApiSideOrderPriceBaseAmount,
    selectApiSmallPaymentOrder,
    reopenApiSmallPaymentOrderSelector,
    loadApiSmallPaymentInfo,
    submitApiSmallPayment,
    setApiHint,
    showApiSideOrderToast,
  });

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('chat-api-small-payment', bindSmallPaymentModule);
  } else {
    bindSmallPaymentModule();
  }
})();
