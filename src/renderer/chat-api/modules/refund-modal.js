// 退款 modal 业务 API + 入口编排
//
// UI（订单选择器、退款表单、动态字段、提交按钮）已迁移到：
//   - src/renderer/vue/modals/ModalApiRefundOrderSelect.vue
//   - src/renderer/vue/modals/ModalApiRefund.vue
//
// 本文件保留：
// - 候选订单的提取 / 归一化 / 去重 / 资格过滤等 *业务规则*；
// - 退款类型 meta（默认话术、字段标签、是否允许"补寄/退货退款"）；
// - 金额输入校验（input/blur 两段 clamp）；
// - 与 chat-api-module 的会话/消息上下文桥接；
// - btnApiRefund 入口绑定 + 远程拉单 + 决定先弹 selector 还是直接弹表单；
// - 提交 IPC（apiSubmitRefundApply）的统一入口和成功后会话刷新。
//
// 通过 window.refundModule 暴露给 Vue 组件复用，不让组件直接散调 pddApi 或 helpers。
(function () {
  const API_REFUND_DEFAULT_NOTE = '亲亲，这边帮您申请退款，您看可以吗？若同意可以点击下方卡片按钮哦～';
  const API_RETURN_REFUND_DEFAULT_NOTE = '亲亲，这边帮您申请退货退款，您看可以吗？若同意可以点击下方卡片按钮哦～';
  const API_RESEND_DEFAULT_NOTE = '亲亲，这边帮您申请补寄，您看可以吗？若同意可以点击下方卡片按钮哦～';

  let apiRefundOrderCandidates = [];

  function getRuntime() {
    return window.__chatApiModuleAccess || {};
  }

  function getState() {
    const runtime = getRuntime();
    if (typeof runtime.getState === 'function') {
      return runtime.getState() || {};
    }
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

  function getApiActiveSession() {
    return callRuntime('getApiActiveSession') || null;
  }

  function loadApiSessions(...args) {
    return callRuntime('loadApiSessions', ...args);
  }

  function openApiSession(...args) {
    return callRuntime('openApiSession', ...args);
  }

  function pickApiRefundText(sources, keys) {
    const fn = helpers().pickApiRefundText;
    return typeof fn === 'function' ? fn(sources, keys) : '';
  }

  function pickApiRefundNumber(sources, keys) {
    const fn = helpers().pickApiRefundNumber;
    return typeof fn === 'function' ? fn(sources, keys) : 0;
  }

  function pickApiDisplayAfterSalesStatus(sources) {
    const fn = helpers().pickApiDisplayAfterSalesStatus;
    return typeof fn === 'function' ? fn(sources) : '';
  }

  function resolveApiRefundShippingInfo(sources) {
    const fn = helpers().resolveApiRefundShippingInfo;
    return typeof fn === 'function'
      ? fn(sources)
      : { trackingNo: '', shippingState: '', shippingStatusText: '', isShipped: false };
  }

  function resolveApiRefundOrderStatusText(sources) {
    const fn = helpers().resolveApiRefundOrderStatusText;
    return typeof fn === 'function' ? fn(sources) : '';
  }

  function formatApiRefundAmount(value) {
    const fn = helpers().formatApiRefundAmount;
    return typeof fn === 'function' ? fn(value) : '';
  }

  function formatApiRefundPaidText(value) {
    const fn = helpers().formatApiRefundPaidText;
    return typeof fn === 'function' ? fn(value) : '';
  }

  function normalizeApiRefundAmountByKeys(sources, keys) {
    const fn = helpers().normalizeApiRefundAmountByKeys;
    return typeof fn === 'function' ? fn(sources, keys) : '';
  }

  function normalizeApiRefundAmountText(value) {
    const fn = helpers().normalizeApiRefundAmountText;
    return typeof fn === 'function' ? fn(value) : '';
  }

  function normalizeApiRefundAmountInputValue(value) {
    const fn = helpers().normalizeApiRefundAmountInputValue;
    return typeof fn === 'function' ? fn(value) : '';
  }

  function clampApiRefundAmountInputValue(value, options = {}) {
    const fn = helpers().clampApiRefundAmountInputValue;
    return typeof fn === 'function' ? fn(value, options) : String(value || '');
  }

  function extractApiGoodsLinkInfo(message) {
    const fn = helpers().extractApiGoodsLinkInfo;
    return typeof fn === 'function' ? fn(message) : null;
  }

  function buildApiGoodsCardFallback(linkInfo, message, session) {
    const fn = helpers().buildApiGoodsCardFallback;
    return typeof fn === 'function' ? fn(linkInfo, message, session) : null;
  }

  // 退款资格过滤：仅对"已支付且未结束 / 还未签收完成"的订单允许售后

  function isApiRefundOrderEligible(order = {}) {
    const mergedStatusText = [
      order?.orderStatusText,
      order?.shippingStatusText,
      order?.shippingState,
    ].filter(Boolean).join(' ').replace(/\s+/g, '');
    if (!mergedStatusText) {
      return order?.shippingState === 'unshipped' || order?.shippingState === 'shipped';
    }
    if (/(待支付|待付款|未支付|未付款|付款中|待成团|未成团)/.test(mergedStatusText)) return false;
    if (/(已签收|已收货|交易成功|已完成|已关闭|已取消|退款成功|已退款|售后完成|退款中止)/.test(mergedStatusText)) return false;
    return /(待发货|未发货|待揽收|待出库|待配送|未揽件|待收货|已发货|运输中|派送中|配送中|揽收|物流)/.test(mergedStatusText)
      || order?.shippingState === 'unshipped'
      || order?.shippingState === 'shipped';
  }

  function filterEligibleApiRefundOrders(list = []) {
    return (Array.isArray(list) ? list : []).filter(order => isApiRefundOrderEligible(order));
  }

  function normalizeApiRefundOrderContext(order = {}, fallback = {}, index = 0) {
    const sources = [
      order,
      order?.raw,
      order?.orderGoodsList,
      order?.order_goods_list,
      order?.goods_info,
      order?.goodsInfo,
      order?.goods,
      order?.order_info,
      order?.orderInfo,
      order?.logistics_info,
      order?.logisticsInfo,
      order?.logistics,
      order?.delivery_info,
      order?.deliveryInfo,
      order?.delivery,
      order?.express_info,
      order?.expressInfo,
      order?.express,
      order?.shipping_info,
      order?.shippingInfo,
      order?.shipping,
      order?.transport_info,
      order?.transportInfo,
      order?.transport,
      order?.raw?.logistics_info,
      order?.raw?.logisticsInfo,
      order?.raw?.logistics,
      order?.raw?.delivery_info,
      order?.raw?.deliveryInfo,
      order?.raw?.delivery,
      order?.raw?.express_info,
      order?.raw?.expressInfo,
      order?.raw?.express,
      order?.raw?.shipping_info,
      order?.raw?.shippingInfo,
      order?.raw?.shipping,
      fallback?.goodsInfo,
      fallback?.raw?.goods_info,
      fallback?.raw?.goods,
      fallback?.raw,
      fallback,
    ].filter(Boolean);
    const orderId = String(
      pickApiRefundText(sources, ['order_id', 'order_sn', 'orderSn', 'parent_order_sn', 'mall_order_sn', 'orderId'])
      || fallback?.orderId
      || ''
    ).trim();
    const title = pickApiRefundText(sources, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'item_title', 'itemTitle', 'title'])
      || fallback?.title
      || `订单 ${index + 1}`;
    const imageUrl = pickApiRefundText(sources, ['imageUrl', 'image_url', 'thumb_url', 'hd_thumb_url', 'goods_thumb_url', 'thumbUrl', 'hdThumbUrl', 'goodsThumbUrl', 'pic_url']);
    const rawAmountText = pickApiRefundText(sources, ['amountText']);
    const amountText = normalizeApiRefundAmountByKeys(rawAmountText ? [{ amountText: rawAmountText }] : [], ['amountText'])
      || normalizeApiRefundAmountByKeys(sources, ['order_amount', 'orderAmount', 'pay_amount', 'refund_amount', 'amount', 'order_price', 'price'])
      || normalizeApiRefundAmountText(pickApiRefundText(sources, ['priceText', 'price_text']))
      || formatApiRefundAmount(pickApiRefundNumber(sources, ['goodsPrice', 'min_price', 'group_price']))
      || '待确认';
    const quantityValue = pickApiRefundText(sources, ['quantity', 'num', 'count', 'goods_count', 'goodsNumber', 'buy_num', 'buyNum']) || String(pickApiRefundNumber(sources, ['quantity', 'num', 'count', 'goods_count', 'goodsNumber', 'buy_num', 'buyNum']) || '').trim();
    const specText = pickApiRefundText(sources, ['specText', 'spec_text', 'spec', 'sku_spec', 'skuSpec', 'spec_desc', 'specDesc', 'sub_name', 'subName']);
    const afterSalesStatus = pickApiDisplayAfterSalesStatus(sources);
    const normalizedQuantity = String(quantityValue || '').replace(/^x/i, '').trim();
    const detailText = pickApiRefundText(sources, ['detailText', 'detail_text']) || (normalizedQuantity && specText
      ? `${specText} x${normalizedQuantity}`
      : (specText || (normalizedQuantity ? `x${normalizedQuantity}` : '所拍规格待确认')));
    const shippingInfo = resolveApiRefundShippingInfo(sources);
    const orderStatusText = resolveApiRefundOrderStatusText(sources);
    const key = `${orderId || 'order'}::${title}::${index}`;
    return {
      key,
      orderId: orderId || '-',
      title,
      imageUrl,
      amountText,
      detailText,
      afterSalesStatus,
      orderStatusText,
      trackingNo: shippingInfo.trackingNo,
      shippingState: shippingInfo.shippingState,
      shippingStatusText: shippingInfo.shippingStatusText,
      isShipped: shippingInfo.isShipped,
    };
  }

  function getApiRefundContext(session = {}) {
    return normalizeApiRefundOrderContext(session, {
      orderId: session?.orderId || '',
      title: '当前会话暂无订单商品信息',
    }, 0);
  }

  function getApiRefundOrderCandidatesFromMessages(session = {}, messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const result = [];
    list.forEach((message, index) => {
      const linkInfo = extractApiGoodsLinkInfo(message);
      const fallbackCard = linkInfo ? buildApiGoodsCardFallback(linkInfo, message, session) : null;
      const rawSources = [
        message?.extra,
        message?.raw?.extra,
        message?.raw,
        fallbackCard,
      ].filter(Boolean);
      if (!rawSources.length) return;
      const hasOrderHint = rawSources.some(item => looksLikeApiRefundOrderNode(item));
      if (!hasOrderHint && !fallbackCard?.title && !fallbackCard?.imageUrl) return;
      result.push(normalizeApiRefundOrderContext({
        ...fallbackCard,
        ...message?.raw,
        ...message?.extra,
        order_id: pickApiRefundText(rawSources, ['order_id', 'order_sn', 'parent_order_sn', 'mall_order_sn']) || session?.orderId || '',
      }, session, index));
    });
    return result;
  }

  function getApiRefundOrderCandidatesFromTraffic(session = {}, entries = []) {
    const list = Array.isArray(entries) ? entries : [];
    const bucket = [];
    const visited = new WeakSet();
    list
      .filter(entry => {
        const url = String(entry?.url || '');
        return /order|goods|trade|pay|after/i.test(url);
      })
      .slice(0, 20)
      .forEach(entry => {
        collectApiRefundOrderNodes(entry?.responseBody, bucket, visited);
        collectApiRefundOrderNodes(entry?.requestBody, bucket, visited);
      });
    return bucket.map((item, index) => normalizeApiRefundOrderContext(item, session, index));
  }

  function looksLikeApiRefundOrderNode(node = {}) {
    if (!node || typeof node !== 'object') return false;
    return [
      'order_id',
      'order_sn',
      'parent_order_sn',
      'mall_order_sn',
      'orderId',
    ].some(key => {
      const value = node[key];
      return value !== undefined && value !== null && String(value).trim() !== '';
    });
  }

  function collectApiRefundOrderNodes(node, bucket, visited, depth = 0) {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) {
      node.slice(0, 20).forEach(item => collectApiRefundOrderNodes(item, bucket, visited, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (looksLikeApiRefundOrderNode(node)) {
      bucket.push(node);
    }
    Object.values(node).forEach(value => {
      if (value && typeof value === 'object') {
        collectApiRefundOrderNodes(value, bucket, visited, depth + 1);
      }
    });
  }

  function getApiRefundOrderCandidates(session = {}) {
    const state = getState();
    const bucket = [];
    const visited = new WeakSet();
    [
      session?.goodsInfo,
      session?.raw?.goods_info,
      session?.raw?.goods,
      session?.raw?.orders,
      session?.raw?.order_list,
      session?.raw?.orderList,
      session?.raw?.order_info,
      session?.raw?.orderInfo,
      session?.raw,
    ].forEach(source => collectApiRefundOrderNodes(source, bucket, visited));
    const normalized = bucket.map((item, index) => normalizeApiRefundOrderContext(item, session, index))
      .concat(getApiRefundOrderCandidatesFromMessages(session, state.apiMessages || []))
      .concat(getApiRefundOrderCandidatesFromTraffic(session, state.apiTrafficEntries || []));
    return dedupeApiRefundOrders(normalized, session);
  }

  function dedupeApiRefundOrders(list = [], session = {}) {
    const deduped = [];
    const seen = new Set();
    list.forEach(item => {
      if (!item?.orderId || item.orderId === '-') return;
      const signature = [item.orderId, item.title, item.imageUrl, item.amountText].join('::');
      if (!signature.replace(/[:\-]/g, '')) return;
      if (seen.has(signature)) return;
      seen.add(signature);
      deduped.push(item);
    });
    if (!deduped.length) {
      const fallback = getApiRefundContext(session);
      if (fallback?.orderId && fallback.orderId !== '-') {
        deduped.push(fallback);
      }
    }
    return deduped;
  }

  function getApiRefundTypeMeta(type = 'refund') {
    if (type === 'returnRefund') {
      return {
        actionText: '退货退款',
        reasonLabel: '退款原因',
        amountLabel: '退款金额',
        defaultNote: API_RETURN_REFUND_DEFAULT_NOTE,
        noteHint: '请友好说明您希望消费者申请退货退款的意愿，避免产生误解和纠纷',
      };
    }
    if (type === 'resend') {
      return {
        actionText: '补寄',
        reasonLabel: '申请原因',
        amountLabel: '',
        defaultNote: API_RESEND_DEFAULT_NOTE,
        noteHint: '请友好说明您希望消费者申请补寄的意愿，避免产生误解和纠纷',
      };
    }
    return {
      actionText: '退款',
      reasonLabel: '退款原因',
      amountLabel: '退款金额',
      defaultNote: API_REFUND_DEFAULT_NOTE,
      noteHint: '请友好说明您希望消费者申请退款的意愿，避免产生误解和纠纷',
    };
  }

  function isApiRefundTypeAllowed(type = 'refund', context = null) {
    if (!context?.isShipped && ['returnRefund', 'resend'].includes(type)) return false;
    return true;
  }

  function shouldShowApiRefundReceiptStatus(type, context) {
    return type === 'refund' && !!context?.isShipped;
  }

  // ---------- 入口编排 ----------

  function showApiRefundOrderEmptyHint() {
    const toastEl = document.getElementById('toastMsg');
    if (toastEl) {
      toastEl.textContent = '90天内无有效订单';
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 2000);
    }
    setApiHint('90天内无有效订单');
  }

  function openApiRefundModalWith(order, options = {}) {
    if (!window.vueBridge?.openModal) return;
    window.vueBridge.openModal('modalApiRefund', {
      order,
      candidates: apiRefundOrderCandidates,
      allowOrderReselect: typeof options.allowOrderReselect === 'boolean'
        ? options.allowOrderReselect
        : apiRefundOrderCandidates.length > 1,
    });
  }

  function openApiRefundOrderSelectModal() {
    if (!window.vueBridge?.openModal) return;
    window.vueBridge.openModal('modalApiRefundOrderSelect', {
      candidates: apiRefundOrderCandidates,
    });
  }

  async function openApiRefundOrderSelector() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    const session = getApiActiveSession() || {
      sessionId: state.apiActiveSessionId,
      shopId: state.apiActiveSessionShopId,
      customerName: state.apiActiveSessionName,
      orderId: state.apiActiveSessionId,
    };
    let remoteOrders = [];
    if (window.pddApi?.apiGetRefundOrders) {
      try {
        const result = await window.pddApi.apiGetRefundOrders({
          shopId: state.apiActiveSessionShopId,
          sessionId: state.apiActiveSessionId,
          session,
        });
        if (Array.isArray(result)) {
          remoteOrders = result.map((item, index) => normalizeApiRefundOrderContext(item, session, index));
        }
      } catch {}
    }
    apiRefundOrderCandidates = filterEligibleApiRefundOrders(dedupeApiRefundOrders(
      remoteOrders.concat(getApiRefundOrderCandidates(session)),
      session
    ));
    if (!apiRefundOrderCandidates.length) {
      showApiRefundOrderEmptyHint();
      return;
    }
    if (apiRefundOrderCandidates.length === 1) {
      openApiRefundModalWith(apiRefundOrderCandidates[0], { allowOrderReselect: false });
      return;
    }
    openApiRefundOrderSelectModal();
  }

  function selectApiRefundOrder(order) {
    if (!order) return;
    if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiRefundOrderSelect');
    openApiRefundModalWith(order, { allowOrderReselect: true });
  }

  function reopenApiRefundOrderSelector() {
    if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiRefund');
    openApiRefundOrderSelectModal();
  }

  // ---------- 提交 IPC ----------

  async function submitApiRefund(payload = {}) {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return { success: false, error: 'no-session' };
    }
    const refundType = payload.type || 'refund';
    const orderContext = payload.orderContext || {};
    const reason = String(payload.reasonText || '').trim();
    if (!reason) {
      setApiHint('请选择退款原因');
      return { success: false, error: 'no-reason' };
    }
    const receiptStatus = shouldShowApiRefundReceiptStatus(refundType, orderContext)
      ? String(payload.receiptStatus || '')
      : '';
    if (shouldShowApiRefundReceiptStatus(refundType, orderContext) && !receiptStatus) {
      setApiHint('请选择收货状态');
      return { success: false, error: 'no-receipt-status' };
    }
    const amountText = refundType === 'resend' ? '' : String(payload.amountText || '').trim();
    if (refundType !== 'resend' && !amountText) {
      setApiHint('请输入正确的退款金额');
      return { success: false, error: 'no-amount' };
    }
    const noteText = String(payload.noteText || '').trim();
    const meta = getApiRefundTypeMeta(refundType);
    const manualEditedNote = noteText !== meta.defaultNote;
    const actionText = meta.actionText;
    const amountDetail = refundType === 'resend' ? '' : (amountText ? `；金额：${amountText}` : '');
    const orderDetail = orderContext?.orderId && orderContext.orderId !== '-' ? `；订单：${orderContext.orderId}` : '';
    const receiptStatusText = receiptStatus === 'received'
      ? '已收到货'
      : (receiptStatus === 'not_received' ? '未收到货' : '');
    const receiptDetail = receiptStatusText ? `；收货状态：${receiptStatusText}` : '';
    recordApiSyncState('退款弹窗', `类型：${actionText}${orderDetail}${receiptDetail}；原因：${reason}${amountDetail}`);
    setApiHint(`正在提交${actionText}申请，请稍候...`);
    const activeSession = getApiActiveSession();
    const refundAmountFen = refundType === 'resend'
      ? 0
      : Math.max(0, Math.round(Number(amountText || 0) * 100));
    try {
      const result = await window.pddApi.apiSubmitRefundApply({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        session: activeSession || undefined,
        orderSn: orderContext?.orderId || '',
        type: refundType,
        receiptStatus,
        reason,
        questionType: payload.questionType || undefined,
        refundAmount: amountText,
        refundAmountFen,
        message: noteText,
        manualEditedNote,
      });
      if (result?.error) {
        recordApiSyncState('售后失败', result.error);
        setApiHint(`申请售后失败：${result.error}`);
        return { success: false, error: result.error };
      }
      recordApiSyncState('售后成功', `类型：${actionText}${orderDetail}；等待 websocket 回流`);
      setApiHint(`${actionText}申请已提交，正在等待原生消息回流...`);
      try {
        await loadApiSessions({ keepCurrent: true });
        if (activeSession?.sessionId || state.apiActiveSessionId) {
          await openApiSession(
            activeSession?.sessionId || state.apiActiveSessionId,
            activeSession?.customerName || state.apiActiveSessionName || '',
            state.apiActiveSessionShopId,
            { keepCurrent: true }
          );
        }
      } catch {}
      return { success: true };
    } catch (err) {
      const message = err?.message || String(err);
      recordApiSyncState('售后异常', message);
      setApiHint(`申请售后失败：${message}`);
      return { success: false, error: message };
    }
  }

  function bindRefundModule() {
    document.getElementById('btnApiRefund')?.addEventListener('click', openApiRefundOrderSelector);
  }

  window.refundModule = Object.assign(window.refundModule || {}, {
    constants: {
      DEFAULT_NOTE: API_REFUND_DEFAULT_NOTE,
      RETURN_REFUND_DEFAULT_NOTE: API_RETURN_REFUND_DEFAULT_NOTE,
      RESEND_DEFAULT_NOTE: API_RESEND_DEFAULT_NOTE,
    },
    getApiRefundTypeMeta,
    isApiRefundTypeAllowed,
    shouldShowApiRefundReceiptStatus,
    formatApiRefundPaidText,
    normalizeApiRefundAmountInputValue,
    clampApiRefundAmountInputValue,
    selectApiRefundOrder,
    reopenApiRefundOrderSelector,
    submitApiRefund,
    setApiHint,
  });

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('chat-api-refund', bindRefundModule);
  } else {
    bindRefundModule();
  }
})();
