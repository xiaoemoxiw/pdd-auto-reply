// 邀请下单 modal（含规格选择子 modal、邀请关注按钮）业务 API + 入口编排
//
// UI 已迁移到：
//   - src/renderer/vue/modals/ModalApiInviteOrder.vue（双面板：左侧店铺商品 + 搜索，右侧已选清单 + 合计）
//   - src/renderer/vue/modals/ModalApiInviteOrderSpec.vue（规格选择子 modal）
//
// 本文件保留：
// - apiGetInviteOrderState / apiGetInviteOrderSkuOptions / apiAddInviteOrderItem
//   / apiClearInviteOrderItems / apiSubmitInviteOrder / apiSubmitInviteFollow 的 IPC 封装；
// - 数据规整（snapshot / sku options 归一化）；
// - btnApiInviteOrder 入口绑定 + 邀请关注按钮独立处理；
// - 提交成功后 appendApiLocalServiceMessage + refreshApiAfterMessageSent 联动。
//
// 通过 window.inviteOrderModule 暴露给 Vue 组件复用。
(function () {
  let apiInviteFollowSubmitting = false;

  // 子 modal（规格选择）添加成功后，需要把新的 snapshot 推给主 modal 刷新；
  // 用一个简单订阅器解耦，避免组件之间直接相互引用。
  const snapshotListeners = new Set();
  function onInviteOrderSnapshot(listener) {
    if (typeof listener !== 'function') return () => {};
    snapshotListeners.add(listener);
    return () => snapshotListeners.delete(listener);
  }
  function emitInviteOrderSnapshot(snapshot) {
    snapshotListeners.forEach(fn => {
      try { fn(snapshot); } catch {}
    });
  }

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

  function showApiSideOrderToast(message) {
    const fn = helpers().showApiSideOrderToast;
    if (typeof fn === 'function') fn(message);
  }

  function getApiActiveSession() {
    return callRuntime('getApiActiveSession') || null;
  }

  function appendApiLocalServiceMessage(payload = {}) {
    return callRuntime('appendApiLocalServiceMessage', payload);
  }

  function refreshApiAfterMessageSent(payload = {}) {
    return callRuntime('refreshApiAfterMessageSent', payload);
  }

  function getApiConversationFollowStatus(session = null) {
    if (typeof window.getApiConversationFollowStatus === 'function') {
      return window.getApiConversationFollowStatus(session);
    }
    return { visible: false, text: '' };
  }

  // ---------- 数据归一化 ----------

  function normalizeApiInviteOrderSnapshot(result = {}) {
    const goodsItems = Array.isArray(result?.goodsItems)
      ? result.goodsItems.filter(item => item && typeof item === 'object')
      : [];
    const selectedItems = Array.isArray(result?.selectedItems)
      ? result.selectedItems.filter(item => item && typeof item === 'object')
      : [];
    const selectedCount = Number.isFinite(Number(result?.selectedCount))
      ? Number(result.selectedCount)
      : selectedItems.length;
    const totalText = String(result?.totalText || result?.totalPriceText || '').trim() || '¥0.00';
    const emptyText = String(result?.emptyText || '').trim();
    const statusText = String(result?.statusText || '').trim()
      || emptyText
      || (selectedCount > 0 ? `已选 ${selectedCount} 件商品，可直接发送给买家` : '未添加任何商品，请从左侧列表选择商品');
    return {
      goodsItems,
      selectedItems,
      selectedCount,
      totalText,
      statusText,
      canClear: selectedCount > 0,
      source: String(result?.source || '').trim(),
    };
  }

  function normalizeApiInviteOrderSkuOptionsResult(result = {}) {
    const skuOptions = Array.isArray(result?.skuOptions)
      ? result.skuOptions
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
          skuId: String(item?.skuId || '').trim(),
          label: String(item?.label || item?.detailLabel || `规格 ${index + 1}`).trim(),
          detailLabel: String(item?.detailLabel || item?.label || `规格 ${index + 1}`).trim(),
          priceText: String(item?.priceText || '').trim(),
          stockText: String(item?.stockText || '').trim(),
          disabled: Boolean(item?.disabled),
        }))
        .filter(item => item.skuId)
      : [];
    const fallbackSelectedSkuId = skuOptions.find(item => !item.disabled)?.skuId || '';
    return {
      goodsId: String(result?.goodsId || '').trim(),
      title: String(result?.title || '').trim() || '商品',
      imageUrl: String(result?.imageUrl || '').trim(),
      priceText: String(result?.priceText || '').trim(),
      optionLabel: String(result?.optionLabel || '').trim() || '规格',
      skuOptions,
      selectedSkuId: String(result?.selectedSkuId || '').trim() || fallbackSelectedSkuId,
    };
  }

  // ---------- IPC 封装（返回归一化数据，错误转 throw） ----------

  async function loadInviteOrderSnapshot({ keyword = '', refreshOpen = true } = {}) {
    const state = getState();
    const activeSession = getApiActiveSession();
    if (!state.apiActiveSessionId || !activeSession) {
      throw new Error('请先选择一个接口会话');
    }
    if (!window.pddApi?.apiGetInviteOrderState) {
      throw new Error('当前版本缺少邀请下单能力');
    }
    const result = await window.pddApi.apiGetInviteOrderState({
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      session: activeSession,
      keyword: String(keyword || '').trim(),
      refreshOpen: refreshOpen !== false,
    });
    if (!result || result.error) {
      throw new Error(result?.error || '读取邀请下单弹窗失败');
    }
    return normalizeApiInviteOrderSnapshot(result);
  }

  async function loadInviteOrderSkuOptions(item = {}) {
    const state = getState();
    const activeSession = getApiActiveSession();
    const itemId = String(item?.itemId || '').trim();
    if (!activeSession || !itemId) throw new Error('缺少商品信息');
    if (!window.pddApi?.apiGetInviteOrderSkuOptions) {
      throw new Error('当前版本缺少邀请下单规格能力');
    }
    const result = await window.pddApi.apiGetInviteOrderSkuOptions({
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      session: activeSession,
      itemId,
    });
    if (!result || result.error) {
      throw new Error(result?.error || '读取邀请下单规格失败');
    }
    return normalizeApiInviteOrderSkuOptionsResult(result);
  }

  async function addInviteOrderItem({ itemId, skuId } = {}) {
    if (!window.pddApi?.apiAddInviteOrderItem) throw new Error('当前版本缺少邀请下单添加能力');
    const state = getState();
    const activeSession = getApiActiveSession();
    if (!activeSession || !itemId || !skuId) throw new Error('缺少添加参数');
    const result = await window.pddApi.apiAddInviteOrderItem({
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      session: activeSession,
      itemId,
      skuId,
    });
    if (!result || result.error) throw new Error(result?.error || '加入邀请下单清单失败');
    return normalizeApiInviteOrderSnapshot(result);
  }

  async function clearInviteOrderItems() {
    if (!window.pddApi?.apiClearInviteOrderItems) throw new Error('当前版本缺少邀请下单清空能力');
    const state = getState();
    const activeSession = getApiActiveSession();
    if (!activeSession) throw new Error('请先选择一个接口会话');
    const result = await window.pddApi.apiClearInviteOrderItems({
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      session: activeSession,
    });
    if (!result || result.error) throw new Error(result?.error || '清空邀请下单清单失败');
    return normalizeApiInviteOrderSnapshot(result);
  }

  function buildInviteOrderPreviewCard(snapshot = {}) {
    const selectedItems = Array.isArray(snapshot?.selectedItems) ? snapshot.selectedItems : [];
    const firstItem = selectedItems[0] || {};
    const title = String(firstItem.title || firstItem.text || '已选商品').trim() || '已选商品';
    const specMatch = title.match(/（(.+?)）$/);
    const displayTitle = specMatch ? title.replace(/（.+?）$/, '').trim() : title;
    const specText = specMatch ? specMatch[1].trim() : '';
    return {
      messageText: '亲，喜欢的话，您可点击"发起拼单"完成支付',
      title: displayTitle || title,
      specText,
      imageUrl: String(firstItem.imageUrl || '').trim(),
      priceText: String(firstItem.priceText || '').trim(),
      totalText: String(snapshot.totalText || '').trim() || '¥0.00',
      count: Math.max(1, Number(snapshot.selectedCount || selectedItems.length || 1) || 1),
    };
  }

  async function submitInviteOrder(snapshot = {}) {
    const state = getState();
    const activeSession = getApiActiveSession();
    if (!activeSession || !state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return { success: false, error: 'no-session' };
    }
    if (!Number(snapshot?.selectedCount || 0)) {
      setApiHint('请先选择至少一个商品');
      return { success: false, error: 'no-items' };
    }
    if (!window.pddApi?.apiSubmitInviteOrder) {
      setApiHint('当前版本缺少邀请下单发送能力');
      return { success: false, error: 'no-submit-api' };
    }
    try {
      recordApiSyncState(
        '邀请下单弹窗',
        `会话：${activeSession.customerName || activeSession.customerId || state.apiActiveSessionId}；商品数：${snapshot.selectedCount}`,
      );
      const result = await window.pddApi.apiSubmitInviteOrder({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        session: activeSession,
      });
      if (!result || result.error) {
        const message = result?.error || '发送邀请下单失败';
        setApiHint(message);
        showApiSideOrderToast(message);
        return { success: false, error: message };
      }
      const previewCard = buildInviteOrderPreviewCard(snapshot);
      const syntheticKey = `invite-order::${state.apiActiveSessionShopId}::${state.apiActiveSessionId}::${Date.now()}`;
      appendApiLocalServiceMessage({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        text: previewCard.messageText,
        inviteOrderCard: previewCard,
        syntheticKey,
        timestamp: Date.now(),
      });
      await refreshApiAfterMessageSent({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        syntheticKey,
      });
      const message = result?.message || '邀请下单已发送';
      setApiHint(message);
      showApiSideOrderToast(message);
      return { success: true, message };
    } catch (error) {
      const message = error?.message || '发送邀请下单失败';
      setApiHint(message);
      showApiSideOrderToast(message);
      return { success: false, error: message };
    }
  }

  // ---------- 入口编排 ----------

  function openApiInviteOrderModal() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    if (!window.vueBridge?.openModal) return;
    window.vueBridge.openModal('modalApiInviteOrder', {});
  }

  function closeApiInviteOrderModal() {
    if (window.vueBridge?.closeModal) {
      window.vueBridge.closeModal('modalApiInviteOrderSpec');
      window.vueBridge.closeModal('modalApiInviteOrder');
    }
  }

  function closeApiInviteOrderSpecModal() {
    if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiInviteOrderSpec');
  }

  function openApiInviteOrderSpecModal(item = {}) {
    if (!window.vueBridge?.openModal) return;
    window.vueBridge.openModal('modalApiInviteOrderSpec', { item });
  }

  // ---------- 邀请关注（独立按钮，不弹 modal） ----------

  async function handleApiInviteFollowClick() {
    const session = getApiActiveSession();
    if (!session) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    const followStatus = getApiConversationFollowStatus(session);
    if (followStatus.visible && followStatus.text) {
      setApiHint('当前买家已关注本店，无需再次邀请');
      return;
    }
    if (apiInviteFollowSubmitting) {
      setApiHint('邀请关注发送中，请稍候');
      return;
    }
    if (!window.pddApi?.apiSubmitInviteFollow) {
      setApiHint('当前版本缺少邀请关注能力');
      return;
    }
    const state = getState();
    apiInviteFollowSubmitting = true;
    try {
      recordApiSyncState(
        '邀请关注',
        `会话：${session.customerName || session.customerId || state.apiActiveSessionId}`,
      );
      const result = await window.pddApi.apiSubmitInviteFollow({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        session,
      });
      if (!result || result.error) {
        throw new Error(result?.error || '发送邀请关注失败');
      }
      await refreshApiAfterMessageSent({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
      });
      setApiHint(result?.message || '邀请关注已发送，正在同步最新消息');
      showApiSideOrderToast(result?.message || '邀请关注已发送');
    } catch (error) {
      setApiHint(error?.message || '发送邀请关注失败');
      showApiSideOrderToast(error?.message || '发送邀请关注失败');
    } finally {
      apiInviteFollowSubmitting = false;
    }
  }

  function bindInviteOrderModule() {
    document.getElementById('btnApiInviteFollow')?.addEventListener('click', handleApiInviteFollowClick);
    document.getElementById('btnApiInviteOrder')?.addEventListener('click', openApiInviteOrderModal);
  }

  window.openApiInviteOrderModal = openApiInviteOrderModal;
  window.closeApiInviteOrderModal = closeApiInviteOrderModal;
  window.closeApiInviteOrderSpecModal = closeApiInviteOrderSpecModal;

  window.inviteOrderModule = Object.assign(window.inviteOrderModule || {}, {
    loadInviteOrderSnapshot,
    loadInviteOrderSkuOptions,
    addInviteOrderItem,
    clearInviteOrderItems,
    submitInviteOrder,
    openApiInviteOrderSpecModal,
    closeApiInviteOrderSpecModal,
    onInviteOrderSnapshot,
    emitInviteOrderSnapshot,
    setApiHint,
    showApiSideOrderToast,
  });

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('chat-api-invite-order', bindInviteOrderModule);
  } else {
    bindInviteOrderModule();
  }
})();
