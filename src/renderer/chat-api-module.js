(function () {
  let initialized = false;
  let apiPendingReplyTicker = null;
  let apiPendingReplySignature = '';
  let apiActivePendingReplySignature = '';
  let apiRefundOrderCandidates = [];
  let apiRefundSelectedOrder = null;
  let apiRefundAllowOrderReselect = true;
  let apiRefundCustomAmount = '';
  let apiSideOrderSessionKey = '';
  let apiSideOrderCountdownTimer = null;
  const apiSideOrderStore = {
    personal: { cacheKey: '', loading: false, stale: false, error: '', items: [] },
    aftersale: { cacheKey: '', loading: false, stale: false, error: '', items: [] },
    pending: { cacheKey: '', loading: false, stale: false, error: '', items: [] },
  };
  const API_REFUND_DEFAULT_NOTE = '亲亲，这边帮您申请退款，您看可以吗？若同意可以点击下方卡片按钮哦～';
  const API_RETURN_REFUND_DEFAULT_NOTE = '亲亲，这边帮您申请退货退款，您看可以吗？若同意可以点击下方卡片按钮哦～';
  const API_RESEND_DEFAULT_NOTE = '亲亲，这边帮您申请补寄，您看可以吗？若同意可以点击下方卡片按钮哦～';
  const API_ORDER_REMARK_MAX_LENGTH = 300;
  const API_ORDER_REMARK_TAG_ORDER = ['RED', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE'];
  const API_ORDER_REMARK_TAG_LABELS = {
    RED: '红色',
    YELLOW: '黄色',
    GREEN: '绿色',
    BLUE: '蓝色',
    PURPLE: '紫色',
  };
  let apiSideOrderRemarkState = {
    visible: false,
    loading: false,
    saving: false,
    orderKey: '',
    orderId: '',
    note: '',
    tag: '',
    autoAppendMeta: true,
    error: '',
    tags: { ...API_ORDER_REMARK_TAG_LABELS },
  };

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
    if (typeof fn === 'function') {
      return fn(...args);
    }
    return undefined;
  }

  function esc(value) {
    return callRuntime('esc', value) || '';
  }

  function addLog(message, type) {
    return callRuntime('addLog', message, type);
  }

  function formatApiDateTime(value) {
    return callRuntime('formatApiDateTime', value) || '';
  }

  function getApiTimeMs(value) {
    return callRuntime('getApiTimeMs', value) || 0;
  }

  function getApiActiveSession() {
    return callRuntime('getApiActiveSession') || null;
  }

  function loadQuickPhrases() {
    return callRuntime('loadQuickPhrases');
  }

  function formatApiListTime(value) {
    return callRuntime('formatApiListTime', value) || '';
  }

  function getApiSessionKey(sessionOrShopId, maybeSessionId = '') {
    return callRuntime('getApiSessionKey', sessionOrShopId, maybeSessionId) || '';
  }

  function emitRendererDebug(scope, message, extra = {}) {
    return callRuntime('emitRendererDebug', scope, message, extra);
  }

  function getApiSelectedShop() {
    return callRuntime('getApiSelectedShop') || null;
  }

  function getApiScopedSessions() {
    return callRuntime('getApiScopedSessions') || [];
  }

  function getLatestApiSessionsForDisplay() {
    return callRuntime('getLatestApiSessionsForDisplay') || [];
  }

  function getStarredApiSessionsForDisplay() {
    return callRuntime('getStarredApiSessionsForDisplay') || [];
  }

  function getVisibleApiSessions() {
    return callRuntime('getVisibleApiSessions') || [];
  }

  function hasApiPendingReply(session = {}) {
    return !!callRuntime('hasApiPendingReply', session);
  }

  function formatApiPendingReplyText(session = {}) {
    return callRuntime('formatApiPendingReplyText', session) || '';
  }

  function getApiConversationFollowStatus(session = null) {
    const status = callRuntime('getApiConversationFollowStatus', session);
    if (status && typeof status === 'object') return status;
    return {
      text: session ? '已关注本店' : '未选择会话',
      highlighted: false,
    };
  }

  function applyApiChatFollowStatus(session = null) {
    const followStatusEl = document.getElementById('apiChatFollowStatus');
    if (!followStatusEl) return;
    const followStatus = getApiConversationFollowStatus(session);
    followStatusEl.textContent = followStatus.text || (session ? '已关注本店' : '未选择会话');
    followStatusEl.classList.toggle('is-unread', !!followStatus.highlighted);
  }

  function resetApiSideOrderStore() {
    apiSideOrderRemarkState = {
      ...apiSideOrderRemarkState,
      visible: false,
      loading: false,
      saving: false,
      orderKey: '',
      orderId: '',
      note: '',
      tag: '',
      error: '',
    };
    Object.values(apiSideOrderStore).forEach(entry => {
      entry.cacheKey = '';
      entry.loading = false;
      entry.stale = false;
      entry.error = '';
      entry.items = [];
    });
  }

  function invalidateApiSideOrders() {
    Object.values(apiSideOrderStore).forEach(entry => {
      if (entry.items.length) {
        entry.stale = true;
      } else {
        entry.cacheKey = '';
      }
      entry.loading = false;
      entry.error = '';
    });
  }

  function getApiSideOrderEntry(tab = 'personal') {
    if (apiSideOrderStore[tab]) return apiSideOrderStore[tab];
    return apiSideOrderStore.personal;
  }

  function hasApiSideOrderPendingSpec(items = []) {
    return (Array.isArray(items) ? items : []).some(item => String(item?.detailText || '').trim() === '所拍规格待确认');
  }

  function getApiSideOrderEmptyText(tab = 'personal') {
    return {
      personal: '近90天无订单，更早订单请在管理后台查看',
      aftersale: '近90天无售后订单，更早记录请在管理后台查看',
      pending: '暂无待支付订单，请在管理后台查看',
    }[tab] || '暂无可展示数据';
  }

  function getApiSideOrderLoadingText(tab = 'personal') {
    return {
      personal: '正在读取个人订单...',
      aftersale: '正在读取售后订单...',
      pending: '正在读取店铺待支付...',
    }[tab] || '正在读取订单数据...';
  }

  function ensureApiSideOrderSessionScope() {
    const state = getState();
    const nextKey = getApiSessionKey(state.apiActiveSessionShopId, state.apiActiveSessionId);
    if (nextKey !== apiSideOrderSessionKey) {
      apiSideOrderSessionKey = nextKey;
      resetApiSideOrderStore();
    }
    return nextKey;
  }

  function getApiSideOrderSession() {
    const state = getState();
    if (!state.apiActiveSessionId || !state.apiActiveSessionShopId) return null;
    return getApiActiveSession() || {
      sessionId: state.apiActiveSessionId,
      shopId: state.apiActiveSessionShopId,
      customerName: state.apiActiveSessionName || '',
      orderId: state.apiActiveSessionId,
    };
  }

  function buildApiSideOrderMetaRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).map(item => `
      <div class="api-side-order-card-row">
        <span class="api-side-order-card-row-label">${esc(item?.label || '')}</span>
        <span class="api-side-order-card-row-value">${esc(item?.value || '')}</span>
      </div>
    `).join('');
  }

  function buildApiSideOrderSummaryRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).map(item => `
      <div class="api-side-order-card-summary-row${item?.tone === 'danger' ? ' is-danger' : ''}">
        <span>${esc(item?.label || '')}</span>
        <strong>${esc(item?.value || '')}</strong>
      </div>
    `).join('');
  }

  function showApiSideOrderToast(message) {
    if (typeof window.qaToast === 'function') {
      window.qaToast(message);
      return;
    }
    const toastEl = document.getElementById('toastMsg');
    if (toastEl) {
      toastEl.textContent = message;
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 2000);
      return;
    }
    setApiHint(message);
  }

  function getApiSideOrderItem(orderKey = '') {
    const normalizedKey = String(orderKey || '').trim();
    if (!normalizedKey) return null;
    const entries = Object.values(apiSideOrderStore);
    for (const entry of entries) {
      const matched = (Array.isArray(entry?.items) ? entry.items : []).find(item => String(item?.key || '') === normalizedKey);
      if (matched) return matched;
    }
    return null;
  }

  function normalizeApiOrderRemarkTags(tags = {}) {
    const source = tags && typeof tags === 'object' ? tags : {};
    const orderedKeys = [
      ...API_ORDER_REMARK_TAG_ORDER.filter(key => source[key]),
      ...Object.keys(source).filter(key => source[key] && !API_ORDER_REMARK_TAG_ORDER.includes(key)),
    ];
    if (!orderedKeys.length) {
      return { ...API_ORDER_REMARK_TAG_LABELS };
    }
    return orderedKeys.reduce((result, key) => {
      result[key] = String(source[key] || '').trim() || API_ORDER_REMARK_TAG_LABELS[key] || key;
      return result;
    }, {});
  }

  function normalizeApiOrderRemarkTagValue(value = '') {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized) return '';
    if (['0', 'NULL', 'UNDEFINED', 'FALSE', 'NONE'].includes(normalized)) {
      return '';
    }
    return normalized;
  }

  function resolveApiOrderRemarkDotColor(tag = '', tagName = '') {
    const normalized = String(tag || '').trim().toLowerCase();
    if (['red', 'yellow', 'green', 'blue', 'purple'].includes(normalized)) return normalized;
    const label = String(tagName || '').trim();
    if (!label) return '';
    if (label.includes('紫')) return 'purple';
    if (label.includes('红')) return 'red';
    if (label.includes('黄')) return 'yellow';
    if (label.includes('绿')) return 'green';
    if (label.includes('蓝')) return 'blue';
    const lower = label.toLowerCase();
    if (lower.includes('purple')) return 'purple';
    if (lower.includes('red')) return 'red';
    if (lower.includes('yellow')) return 'yellow';
    if (lower.includes('green')) return 'green';
    if (lower.includes('blue')) return 'blue';
    return '';
  }

  function buildApiSideOrderRemarkCopyText(order = {}) {
    const tag = normalizeApiOrderRemarkTagValue(order?.noteTag);
    const note = String(order?.note || '').trim();
    if (!tag && !note) return '';
    const tagOptions = normalizeApiOrderRemarkTags(apiSideOrderRemarkState.tags);
    const tagName = String(order?.noteTagName || '').trim() || tagOptions[tag] || API_ORDER_REMARK_TAG_LABELS[tag] || '';
    if (tagName && note) return `${tagName} ${note}`.trim();
    return (tagName || note).trim();
  }

  function renderApiSideOrderRemarkEditor(order = {}) {
    const state = apiSideOrderRemarkState;
    if (!state.visible || String(state.orderKey || '') !== String(order?.key || '')) return '';
    const tagOptions = normalizeApiOrderRemarkTags(state.tags);
    const selectedTag = normalizeApiOrderRemarkTagValue(state.tag);
    const selectedTagName = tagOptions[selectedTag] || API_ORDER_REMARK_TAG_LABELS[selectedTag] || '';
    const note = String(state.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH);
    const colorButtonsHtml = Object.entries(tagOptions).map(([value, label]) => `
      <button
        type="button"
        class="api-side-order-remark-color${selectedTag === value ? ' active' : ''}"
        data-api-side-remark-color="${esc(value)}"
      >
        <span class="api-side-order-remark-color-dot is-${esc(value.toLowerCase())}"></span>
        <span>${esc(label)}</span>
      </button>
    `).join('');
    const loadingHtml = state.loading ? '<div class="api-side-order-remark-status">正在读取备注...</div>' : '';
    const errorHtml = state.error ? `<div class="api-side-order-remark-status is-error">${esc(state.error)}</div>` : '';
    return `
      <div class="api-side-order-remark-popup">
        <div class="api-side-order-remark-title">备注</div>
        ${loadingHtml}
        ${errorHtml}
        <div class="api-side-order-remark-colors">${colorButtonsHtml}</div>
        <div class="api-side-order-remark-editor${selectedTag ? ' has-tag' : ''}">
          ${selectedTagName ? `
            <div class="api-side-order-remark-chip-row">
              <button type="button" class="api-side-order-remark-chip" data-api-side-remark-clear-tag="1">
                <span class="api-side-order-remark-color-dot is-${esc(selectedTag.toLowerCase())}"></span>
                <span>${esc(selectedTagName)}</span>
                <span>&times;</span>
              </button>
            </div>
          ` : ''}
          <textarea
            class="api-side-order-remark-textarea"
            data-api-side-remark-textarea="1"
            maxlength="${API_ORDER_REMARK_MAX_LENGTH}"
            placeholder="如需新增，请填写备注"
            ${state.loading || state.saving ? 'disabled' : ''}
          >${esc(note)}</textarea>
          <div class="api-side-order-remark-count" data-api-side-remark-count="1">${note.length} / ${API_ORDER_REMARK_MAX_LENGTH}</div>
        </div>
        <div class="api-side-order-remark-footer">
          <label class="api-side-order-remark-check">
            <input type="checkbox" data-api-side-remark-auto-meta="1" ${state.autoAppendMeta ? 'checked' : ''} ${state.saving ? 'disabled' : ''}>
            <span>保存时自动添加备注账号和时间</span>
          </label>
          <div class="api-side-order-remark-buttons">
            <button type="button" class="api-side-order-remark-btn is-primary" data-api-side-remark-save="1" ${state.loading || state.saving ? 'disabled' : ''}>${state.saving ? '保存中...' : '保存'}</button>
            <button type="button" class="api-side-order-remark-btn" data-api-side-remark-cancel="1" ${state.saving ? 'disabled' : ''}>取消</button>
          </div>
        </div>
      </div>
    `;
  }

  function isApiOrderRemarkHandlerMissing(error) {
    const message = String(error?.message || error || '');
    return /No handler registered for 'api-get-order-remark'|No handler registered for 'api-get-order-remark-tags'|No handler registered for 'api-save-order-remark'/i.test(message);
  }

  function renderApiSideOrderRemarkSummary(order = {}) {
    const tag = normalizeApiOrderRemarkTagValue(order?.noteTag);
    const note = String(order?.note || '').trim();
    if (!tag && !note) return '';
    const tagOptions = normalizeApiOrderRemarkTags(apiSideOrderRemarkState.tags);
    const tagName = String(order?.noteTagName || '').trim() || tagOptions[tag] || API_ORDER_REMARK_TAG_LABELS[tag] || '';
    const dotColor = resolveApiOrderRemarkDotColor(tag, tagName);
    const tagHtml = tagName
      ? `
        <span class="api-side-order-remark-summary-inline-tag">
          ${dotColor ? `<span class="api-side-order-remark-color-dot is-${esc(dotColor)}"></span>` : ''}
          <span>${esc(tagName)}</span>
        </span>
      `
      : '';
    const noteHtml = note
      ? `<span class="api-side-order-remark-summary-text" title="${esc(note)}">${esc(note)}</span>`
      : '';
    const copyHtml = note
      ? `<button type="button" class="api-side-order-card-copy api-side-order-remark-summary-copy" title="复制备注内容" data-api-side-copy-remark="1">复制</button>`
      : '';
    return `
      <div class="api-side-order-remark-summary">
        <div class="api-side-order-remark-summary-main">
          ${tagHtml}
          ${noteHtml}
        </div>
        ${copyHtml}
      </div>
    `;
  }

  function renderApiSideOrderCard(order = {}) {
    const actionTags = Array.isArray(order?.actionTags) ? order.actionTags : [];
    const metaRowsHtml = buildApiSideOrderMetaRows(order?.metaRows || []);
    const summaryRowsHtml = buildApiSideOrderSummaryRows(order?.summaryRows || []);
    const countdownHtml = order?.countdownEndTime
      ? `<span class="api-side-order-card-countdown" data-api-side-countdown-end="${esc(order.countdownEndTime)}">${esc(order?.countdownText || '')}</span>`
      : '';
    const actionTagsHtml = actionTags.length
      ? `<div class="api-side-order-card-actions">${actionTags.map(tag => {
          const label = String(tag || '').trim();
          if (label === '备注') {
            return `<button type="button" class="api-side-order-card-action is-button" data-api-side-action="remark" data-api-side-order-key="${esc(order?.key || '')}">${esc(label)}</button>`;
          }
          return `<span class="api-side-order-card-action">${esc(label)}</span>`;
        }).join('')}</div>`
      : '';
    return `
      <div class="api-side-order-card" data-api-side-order-key="${esc(order?.key || '')}" data-api-side-order-id="${esc(order?.orderId || '')}">
        <div class="api-side-order-card-head">
          <div class="api-side-order-card-status-wrap">
            <div class="api-side-order-card-status">${esc(order?.headline || '订单状态待确认')}</div>
            ${countdownHtml}
          </div>
          <button class="api-side-order-card-copy" title="复制订单编号" data-api-side-copy-order-id="${esc(order?.orderId || '')}">复制</button>
        </div>
        <div class="api-side-order-card-meta">
          <div class="api-side-order-card-row">
            <span class="api-side-order-card-row-label">订单编号</span>
            <span class="api-side-order-card-row-value">${esc(order?.orderId || '-')}</span>
          </div>
          ${metaRowsHtml}
        </div>
        <div class="api-side-order-card-goods">
          <div class="api-side-order-card-media">
            ${order?.imageUrl ? `<img src="${esc(order.imageUrl)}" alt="${esc(order?.title || '订单商品')}">` : '<span>商品</span>'}
          </div>
          <div class="api-side-order-card-main">
            <div class="api-side-order-card-title">${esc(order?.title || '订单商品')}</div>
            <div class="api-side-order-card-detail">${esc(order?.detailText || '所拍规格待确认')}</div>
            <div class="api-side-order-card-price">${esc(order?.amountText || '待确认')}</div>
          </div>
        </div>
        ${summaryRowsHtml ? `<div class="api-side-order-card-summary">${summaryRowsHtml}</div>` : ''}
        ${renderApiSideOrderRemarkSummary(order)}
        ${actionTagsHtml}
        ${renderApiSideOrderRemarkEditor(order)}
      </div>
    `;
  }

  function formatApiSideOrderCountdown(endTime) {
    const numeric = Number(endTime || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const remainMs = Math.max(0, numeric - Date.now());
    const totalSeconds = Math.floor(remainMs / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `剩余支付时间 ${hours}:${minutes}:${seconds}`;
  }

  function syncApiSideOrderCountdowns() {
    const nodes = Array.from(document.querySelectorAll('[data-api-side-countdown-end]'));
    nodes.forEach(node => {
      node.textContent = formatApiSideOrderCountdown(node.dataset.apiSideCountdownEnd);
    });
    if (apiSideOrderCountdownTimer) {
      clearInterval(apiSideOrderCountdownTimer);
      apiSideOrderCountdownTimer = null;
    }
    if (!nodes.length) return;
    apiSideOrderCountdownTimer = setInterval(() => {
      const nextNodes = Array.from(document.querySelectorAll('[data-api-side-countdown-end]'));
      if (!nextNodes.length) {
        clearInterval(apiSideOrderCountdownTimer);
        apiSideOrderCountdownTimer = null;
        return;
      }
      nextNodes.forEach(node => {
        node.textContent = formatApiSideOrderCountdown(node.dataset.apiSideCountdownEnd);
      });
    }, 1000);
  }

  async function loadApiSideOrders(tab = 'personal') {
    const entry = getApiSideOrderEntry(tab);
    const session = getApiSideOrderSession();
    if (!session) return;
    const state = getState();
    const cacheKey = entry.cacheKey;
    const hadItems = Array.isArray(entry.items) && entry.items.length > 0;
    try {
      if (!window.pddApi?.apiGetSideOrders) {
        throw new Error('当前版本尚未提供订单侧栏接口');
      }
      const result = await window.pddApi.apiGetSideOrders({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        session,
        tab,
      });
      if (entry.cacheKey !== cacheKey) return;
      if (!Array.isArray(result)) {
        throw new Error(result?.error || '读取订单数据失败');
      }
      entry.items = result;
      entry.stale = false;
      entry.error = '';
    } catch (error) {
      if (entry.cacheKey !== cacheKey) return;
      entry.stale = false;
      if (!hadItems) {
        entry.items = [];
        entry.error = error?.message || '读取订单数据失败';
      }
    } finally {
      if (entry.cacheKey === cacheKey) {
        entry.loading = false;
        renderApiSideOrders();
      }
    }
  }

  function renderApiSideOrders() {
    const listEl = document.getElementById('apiSideOrderList');
    const emptyEl = document.getElementById('apiSideOrderEmpty');
    if (!listEl || !emptyEl) return;
    const state = getState();
    const tab = String(state.apiSideTab || 'personal');
    if (tab === 'sync') {
      listEl.innerHTML = '';
      return;
    }
    ensureApiSideOrderSessionScope();
    const session = getApiSideOrderSession();
    if (!session) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = '请先选择一个接口会话';
      return;
    }
    const entry = getApiSideOrderEntry(tab);
    const cacheKey = `${getApiSessionKey(session.shopId, session.sessionId)}::${tab}`;
    const shouldReload = (!entry.loading) && (
      entry.cacheKey !== cacheKey
      || entry.stale
      || hasApiSideOrderPendingSpec(entry.items)
    );
    if (shouldReload) {
      entry.cacheKey = cacheKey;
      entry.loading = true;
      entry.error = '';
      if (!entry.items.length) {
        listEl.innerHTML = '';
        emptyEl.style.display = 'block';
        emptyEl.textContent = getApiSideOrderLoadingText(tab);
      }
      void loadApiSideOrders(tab);
      if (!entry.items.length) return;
    }
    if (entry.loading && !entry.items.length) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = getApiSideOrderLoadingText(tab);
      return;
    }
    if (entry.error && !entry.items.length) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = entry.error;
      return;
    }
    if (!entry.items.length) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = getApiSideOrderEmptyText(tab);
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = entry.items.map(renderApiSideOrderCard).join('');
    syncApiSideOrderCountdowns();
  }

  async function openApiSideOrderRemark(orderKey = '') {
    const order = getApiSideOrderItem(orderKey);
    if (!order) {
      showApiSideOrderToast('未找到对应订单');
      return;
    }
    if (apiSideOrderRemarkState.visible && apiSideOrderRemarkState.orderKey === orderKey && !apiSideOrderRemarkState.loading) {
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        visible: false,
        loading: false,
        saving: false,
        error: '',
      };
      renderApiSideOrders();
      return;
    }
    apiSideOrderRemarkState = {
      ...apiSideOrderRemarkState,
      visible: true,
      loading: true,
      saving: false,
      orderKey: String(order.key || ''),
      orderId: String(order.orderId || ''),
      note: String(order.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH),
      tag: normalizeApiOrderRemarkTagValue(order.noteTag),
      error: '',
    };
    renderApiSideOrders();
    const state = getState();
    try {
      const [remarkResult, tagsResult] = await Promise.all([
        window.pddApi?.apiGetOrderRemark?.({
          shopId: state.apiActiveSessionShopId,
          orderSn: order.orderId,
          source: 1,
        }),
        window.pddApi?.apiGetOrderRemarkTags?.({
          shopId: state.apiActiveSessionShopId,
        }),
      ]);
      if (apiSideOrderRemarkState.orderKey !== String(order.key || '')) return;
      const nextNote = String(remarkResult?.note || order.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH);
      const nextTag = normalizeApiOrderRemarkTagValue(remarkResult?.tag || order.noteTag || '');
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        visible: true,
        loading: false,
        note: nextNote,
        tag: nextTag,
        tags: normalizeApiOrderRemarkTags(tagsResult?.error ? apiSideOrderRemarkState.tags : tagsResult),
        error: remarkResult?.error || tagsResult?.error || '',
      };
    } catch (error) {
      if (apiSideOrderRemarkState.orderKey !== String(order.key || '')) return;
      if (isApiOrderRemarkHandlerMissing(error)) {
        apiSideOrderRemarkState = {
          ...apiSideOrderRemarkState,
          visible: true,
          loading: false,
          tags: { ...API_ORDER_REMARK_TAG_LABELS },
          error: '',
        };
        renderApiSideOrders();
        showApiSideOrderToast('备注接口已更新，请重启应用后启用读取与保存');
        return;
      }
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        visible: true,
        loading: false,
        error: error?.message || '读取备注失败',
      };
    }
    renderApiSideOrders();
  }

  function applyApiSideOrderRemark(orderId = '', remark = {}) {
    const normalizedOrderId = String(orderId || '').trim();
    if (!normalizedOrderId) return;
    Object.values(apiSideOrderStore).forEach(entry => {
      entry.items = (Array.isArray(entry.items) ? entry.items : []).map(item => {
        if (String(item?.orderId || '').trim() !== normalizedOrderId) return item;
        return {
          ...item,
          note: String(remark?.note || ''),
          noteTag: normalizeApiOrderRemarkTagValue(remark?.tag),
          noteTagName: String(remark?.tagName || '').trim(),
        };
      });
    });
  }

  async function saveApiSideOrderRemark() {
    const state = getState();
    const order = getApiSideOrderItem(apiSideOrderRemarkState.orderKey);
    if (!order) {
      showApiSideOrderToast('未找到对应订单');
      return;
    }
    if (!window.pddApi?.apiSaveOrderRemark) {
      showApiSideOrderToast('当前版本尚未提供备注保存接口');
      return;
    }
    apiSideOrderRemarkState = {
      ...apiSideOrderRemarkState,
      saving: true,
      error: '',
    };
    renderApiSideOrders();
    try {
      const result = await window.pddApi.apiSaveOrderRemark({
        shopId: state.apiActiveSessionShopId,
        orderSn: order.orderId,
        note: String(apiSideOrderRemarkState.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH),
        tag: normalizeApiOrderRemarkTagValue(apiSideOrderRemarkState.tag),
        source: 1,
        autoAppendMeta: !!apiSideOrderRemarkState.autoAppendMeta,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      applyApiSideOrderRemark(order.orderId, result);
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        visible: false,
        loading: false,
        saving: false,
        orderKey: '',
        orderId: '',
        note: '',
        tag: '',
        error: '',
      };
      renderApiSideOrders();
      showApiSideOrderToast('备注保存成功');
    } catch (error) {
      if (isApiOrderRemarkHandlerMissing(error)) {
        apiSideOrderRemarkState = {
          ...apiSideOrderRemarkState,
          saving: false,
          error: '',
        };
        renderApiSideOrders();
        showApiSideOrderToast('请重启应用后再保存备注');
        return;
      }
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        saving: false,
        error: error?.message || '保存备注失败',
      };
      renderApiSideOrders();
    }
  }

  function handleApiSideOrderListInput(event) {
    const textarea = event.target.closest('[data-api-side-remark-textarea]');
    if (!textarea) return;
    const value = String(textarea.value || '').slice(0, API_ORDER_REMARK_MAX_LENGTH);
    if (textarea.value !== value) {
      textarea.value = value;
    }
    apiSideOrderRemarkState = {
      ...apiSideOrderRemarkState,
      note: value,
    };
    const countEl = textarea.closest('.api-side-order-remark-editor')?.querySelector('[data-api-side-remark-count]');
    if (countEl) {
      countEl.textContent = `${value.length} / ${API_ORDER_REMARK_MAX_LENGTH}`;
    }
  }

  function handleApiSideOrderListChange(event) {
    const checkbox = event.target.closest('[data-api-side-remark-auto-meta]');
    if (!checkbox) return;
    apiSideOrderRemarkState = {
      ...apiSideOrderRemarkState,
      autoAppendMeta: !!checkbox.checked,
    };
  }

  async function handleApiSideOrderListClick(event) {
    const button = event.target.closest('[data-api-side-copy-order-id]');
    if (button) {
      const orderId = String(button.dataset.apiSideCopyOrderId || '').trim();
      if (!orderId) return;
      try {
        await navigator.clipboard.writeText(orderId);
        showApiSideOrderToast('复制成功');
      } catch {
        setApiHint(`订单号：${orderId}`);
      }
      return;
    }
    const remarkCopy = event.target.closest('[data-api-side-copy-remark]');
    if (remarkCopy) {
      const orderKey = remarkCopy.closest('[data-api-side-order-key]')?.dataset?.apiSideOrderKey || '';
      const order = getApiSideOrderItem(orderKey);
      const text = buildApiSideOrderRemarkCopyText(order);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showApiSideOrderToast('已复制粘贴板！');
      } catch {
        setApiHint(text);
      }
      return;
    }
    const remarkTrigger = event.target.closest('[data-api-side-action="remark"]');
    if (remarkTrigger) {
      await openApiSideOrderRemark(remarkTrigger.dataset.apiSideOrderKey || '');
      return;
    }
    const tagButton = event.target.closest('[data-api-side-remark-color]');
    if (tagButton) {
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        tag: normalizeApiOrderRemarkTagValue(tagButton.dataset.apiSideRemarkColor),
      };
      renderApiSideOrders();
      return;
    }
    if (event.target.closest('[data-api-side-remark-clear-tag]')) {
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        tag: '',
      };
      renderApiSideOrders();
      return;
    }
    if (event.target.closest('[data-api-side-remark-cancel]')) {
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        visible: false,
        loading: false,
        saving: false,
        orderKey: '',
        orderId: '',
        note: '',
        tag: '',
        error: '',
      };
      renderApiSideOrders();
      return;
    }
    if (event.target.closest('[data-api-side-remark-save]')) {
      await saveApiSideOrderRemark();
    }
  }

  function openApiSession(sessionId, customerName, shopId, options) {
    return callRuntime('openApiSession', sessionId, customerName, shopId, options);
  }

  function loadApiSessions(options = {}) {
    return callRuntime('loadApiSessions', options);
  }

  function loadApiTraffic(shopId) {
    return callRuntime('loadApiTraffic', shopId);
  }

  function loadApiTokenStatus(shopId) {
    return callRuntime('loadApiTokenStatus', shopId);
  }

  function getApiStatusShopId(preferActiveSession = true) {
    return callRuntime('getApiStatusShopId', preferActiveSession) || '';
  }

  function clearApiActiveSession() {
    return callRuntime('clearApiActiveSession');
  }

  function recordApiSyncState(label, detail = '') {
    return callRuntime('recordApiSyncState', label, detail);
  }

  function clearApiPendingReplyState(payload = {}) {
    return callRuntime('clearApiPendingReplyState', payload);
  }

  function appendApiLocalServiceMessage(payload = {}) {
    return callRuntime('appendApiLocalServiceMessage', payload);
  }

  function refreshApiAfterMessageSent(payload = {}) {
    return callRuntime('refreshApiAfterMessageSent', payload);
  }

  function mergeApiSessionsForShop(shopId, sessions = []) {
    return callRuntime('mergeApiSessionsForShop', shopId, sessions);
  }

  function renderApiStatus() {
    return callRuntime('renderApiStatus');
  }

  function getApiAuthHintText() {
    return callRuntime('getApiAuthHintText') || '';
  }

  function setApiSelectedShopId(value) {
    return callRuntime('setApiSelectedShopId', value);
  }

  function setApiSessionKeyword(value) {
    return callRuntime('setApiSessionKeyword', value);
  }

  function setApiSessionTab(value) {
    return callRuntime('setApiSessionTab', value);
  }

  function setApiSideTab(value) {
    return callRuntime('setApiSideTab', value);
  }

  function setApiStarredSessions(value) {
    return callRuntime('setApiStarredSessions', value);
  }

  function setApiTokenStatus(value) {
    return callRuntime('setApiTokenStatus', value);
  }

  function setApiHint(text) {
    const hintEl = document.getElementById('apiComposerHint');
    if (!hintEl) return;
    hintEl.textContent = text;
  }

  function pickApiRefundText(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return '';
  }

  function pickApiRefundNumber(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const numeric = Number(source[key]);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
      }
    }
    return 0;
  }

  function pickApiRefundBoolean(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value > 0;
        const text = String(value).trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'shipped', 'delivered'].includes(text)) return true;
        if (['0', 'false', 'no', 'n', 'unshipped', 'pending'].includes(text)) return false;
      }
    }
    return null;
  }

  function resolveApiRefundShippingInfo(sources = []) {
    const trackingNo = pickApiRefundText(sources, [
      'tracking_no',
      'trackingNo',
      'waybill_no',
      'waybillNo',
      'express_no',
      'expressNo',
      'express_number',
      'expressNumber',
      'logistics_no',
      'logisticsNo',
      'shipping_no',
      'shippingNo',
      'mail_no',
      'mailNo',
      'invoice_waybill_no',
    ]);
    const shippingStateText = pickApiRefundText(sources, [
      'shippingState',
      'shipping_state',
      'refund_shipping_state',
    ]);
    const shippingStatusText = pickApiRefundText(sources, [
      'order_status_desc',
      'order_status_text',
      'order_status_name',
      'order_status',
      'shipping_status_desc',
      'shipping_status_text',
      'shipping_status',
      'delivery_status_desc',
      'delivery_status_text',
      'delivery_status',
      'express_status_desc',
      'express_status_text',
      'express_status',
      'logistics_status_desc',
      'logistics_status_text',
      'logistics_status',
      'statusDesc',
      'status_desc',
    ]);
    const shippedFlag = pickApiRefundBoolean(sources, [
      'has_tracking_no',
      'hasTrackingNo',
      'has_waybill',
      'hasWaybill',
      'has_logistics',
      'hasLogistics',
      'has_express',
      'hasExpress',
      'has_shipping',
      'hasShipping',
      'is_shipped',
      'isShipped',
      'shipped',
    ]);
    const unshippedFlag = pickApiRefundBoolean(sources, [
      'unshipped',
      'is_unshipped',
      'isUnshipped',
      'wait_ship',
      'waitShip',
    ]);
    const mergedStatusText = `${shippingStateText} ${shippingStatusText}`.replace(/\s+/g, '');
    if (trackingNo) {
      return {
        shippingState: 'shipped',
        shippingStatusText: shippingStatusText || '已发货',
        trackingNo,
        isShipped: true,
      };
    }
    if (/^shipped$/i.test(shippingStateText) || shippingStateText === '已发货') {
      return {
        shippingState: 'shipped',
        shippingStatusText: shippingStatusText || shippingStateText || '已发货',
        trackingNo: '',
        isShipped: true,
      };
    }
    if (/^unshipped$/i.test(shippingStateText) || shippingStateText === '未发货') {
      return {
        shippingState: 'unshipped',
        shippingStatusText: shippingStatusText || shippingStateText || '未发货',
        trackingNo: '',
        isShipped: false,
      };
    }
    if (shippedFlag === true) {
      return {
        shippingState: 'shipped',
        shippingStatusText: shippingStatusText || '已发货',
        trackingNo: '',
        isShipped: true,
      };
    }
    if (unshippedFlag === true) {
      return {
        shippingState: 'unshipped',
        shippingStatusText: shippingStatusText || '未发货',
        trackingNo: '',
        isShipped: false,
      };
    }
    if (/(已发货|运输中|待收货|已签收|已收货|派送中|配送中|揽收|物流)/.test(mergedStatusText)) {
      return {
        shippingState: 'shipped',
        shippingStatusText: shippingStatusText || '已发货',
        trackingNo: '',
        isShipped: true,
      };
    }
    if (/(未发货|待发货|待揽收|待出库|待配送|未揽件)/.test(mergedStatusText)) {
      return {
        shippingState: 'unshipped',
        shippingStatusText: shippingStatusText || '未发货',
        trackingNo: '',
        isShipped: false,
      };
    }
    return {
      shippingState: '',
      shippingStatusText,
      trackingNo: '',
      isShipped: false,
    };
  }

  function formatApiRefundAmount(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return '';
      if (/^¥/.test(text)) return text;
      const numeric = Number(text.replace(/[^\d.-]/g, ''));
      if (Number.isFinite(numeric) && numeric > 0) return formatApiRefundAmount(numeric);
      return text;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const amount = Number.isInteger(numeric) && numeric >= 1000 ? numeric / 100 : numeric;
    return `¥ ${amount.toFixed(2)}`;
  }

  function normalizeApiRefundAmountInputValue(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const sanitized = text.replace(/[^\d.]/g, '');
    if (!sanitized) return '';
    const parts = sanitized.split('.');
    const integerPart = (parts.shift() || '').replace(/^0+(?=\d)/, '');
    const decimalPart = parts.join('').slice(0, 2);
    const normalizedIntegerPart = integerPart || '0';
    return decimalPart ? `${normalizedIntegerPart}.${decimalPart}` : normalizedIntegerPart;
  }

  function formatApiRefundAmountInputValue(value) {
    const normalized = normalizeApiRefundAmountInputValue(value);
    if (!normalized) return '';
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    return numeric.toFixed(2);
  }

  function getApiRefundMaxAmountInputValue(context = getSelectedApiRefundContext()) {
    return formatApiRefundAmountInputValue(context?.amountText);
  }

  function clampApiRefundAmountInputValue(value, options = {}) {
    const normalized = options.formatted
      ? formatApiRefundAmountInputValue(value)
      : normalizeApiRefundAmountInputValue(value);
    if (!normalized) return '';
    const maxAmount = getApiRefundMaxAmountInputValue(options.context);
    if (!maxAmount) return normalized;
    const numeric = Number(normalized);
    const maxNumeric = Number(maxAmount);
    if (!Number.isFinite(numeric) || !Number.isFinite(maxNumeric)) return normalized;
    if (numeric > maxNumeric) {
      return options.formatted ? maxAmount : normalizeApiRefundAmountInputValue(maxAmount);
    }
    return normalized;
  }

  function normalizeApiRefundAmountByKeys(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const rawValue = source[key];
        if (rawValue === undefined || rawValue === null || rawValue === '') continue;
        if (typeof rawValue === 'string') {
          const text = rawValue.trim();
          if (!text) continue;
          if (/^¥/.test(text)) return text;
          if (text.includes('.')) {
            const decimal = Number(text);
            if (Number.isFinite(decimal) && decimal > 0) return `¥ ${decimal.toFixed(2)}`;
          }
          const integer = Number(text);
          if (Number.isFinite(integer) && integer > 0) return `¥ ${(integer / 100).toFixed(2)}`;
          continue;
        }
        const numeric = Number(rawValue);
        if (Number.isFinite(numeric) && numeric > 0) {
          return `¥ ${(numeric / 100).toFixed(2)}`;
        }
      }
    }
    return '';
  }

  function normalizeApiRefundAmountText(value) {
    if (value === undefined || value === null || value === '') return '';
    const text = String(value).trim();
    if (!text) return '';
    if (/^¥/.test(text)) return text;
    const formatted = formatApiRefundAmount(text);
    return formatted || text;
  }

  function formatApiRefundPaidText(value) {
    const amountText = String(value || '').trim();
    return amountText ? `实付：${amountText}` : '实付待确认';
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
    const afterSalesStatus = pickApiRefundText(sources, ['afterSalesStatus', 'after_sales_status', 'afterSalesStatusDesc', 'after_sales_status_desc']);
    const normalizedQuantity = String(quantityValue || '').replace(/^x/i, '').trim();
    const detailText = pickApiRefundText(sources, ['detailText', 'detail_text']) || (normalizedQuantity && specText
      ? `${specText} x${normalizedQuantity}`
      : (specText || (normalizedQuantity ? `x${normalizedQuantity}` : '所拍规格待确认')));
    const shippingInfo = resolveApiRefundShippingInfo(sources);
    const key = `${orderId || 'order'}::${title}::${index}`;
    return {
      key,
      orderId: orderId || '-',
      title,
      imageUrl,
      amountText,
      detailText,
      afterSalesStatus,
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

  function renderApiRefundOrderSelector() {
    const listEl = document.getElementById('apiRefundOrderList');
    const emptyEl = document.getElementById('apiRefundOrderEmpty');
    if (!listEl || !emptyEl) return;
    listEl.classList.toggle('is-scrollable', apiRefundOrderCandidates.length > 2);
    if (!apiRefundOrderCandidates.length) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = apiRefundOrderCandidates.map(order => `
      <div class="api-refund-order-select-item">
        <div class="api-refund-order-select-media">
          ${order.imageUrl ? `<img src="${esc(order.imageUrl)}" alt="${esc(order.title || '订单商品')}">` : '<span>商品</span>'}
        </div>
        <div class="api-refund-order-select-main">
          <div class="api-refund-order-select-id">订单号：${esc(order.orderId || '-')}</div>
          <div class="api-refund-order-select-title">${esc(order.title || '订单商品')}</div>
          <div class="api-refund-order-select-detail">${esc(order.detailText || '所拍规格待确认')}</div>
          <div class="api-refund-order-select-price">${esc(formatApiRefundPaidText(order.amountText))}</div>
          ${order.afterSalesStatus ? `<div class="api-refund-order-select-status">售后：${esc(order.afterSalesStatus)}</div>` : ''}
        </div>
        <div class="api-refund-order-select-action">
          <button class="btn btn-primary" type="button" data-api-refund-order-key="${esc(order.key)}">选择订单</button>
        </div>
      </div>
    `).join('');
  }

  function updateApiRefundNoteCount() {
    const textarea = document.getElementById('apiRefundNote');
    const counter = document.getElementById('apiRefundNoteCount');
    if (!textarea || !counter) return;
    counter.textContent = `${textarea.value.length} / 200`;
  }

  function showApiRefundOrderEmptyHint() {
    const toastEl = document.getElementById('toastMsg');
    if (toastEl) {
      toastEl.textContent = '90天内无有效订单';
      toastEl.classList.add('show');
      setTimeout(() => {
        toastEl.classList.remove('show');
      }, 2000);
    }
    setApiHint('90天内无有效订单');
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
      amountText: '',
      defaultNote: API_REFUND_DEFAULT_NOTE,
      noteHint: '请友好说明您希望消费者申请退款的意愿，避免产生误解和纠纷',
    };
  }

  function getCurrentApiRefundType() {
    return document.querySelector('input[name="apiRefundType"]:checked')?.value || 'refund';
  }

  function getCurrentApiRefundReceiptStatus() {
    return document.querySelector('input[name="apiRefundReceiptStatus"]:checked')?.value || '';
  }

  function getSelectedApiRefundContext() {
    return apiRefundSelectedOrder || getApiRefundContext(getApiActiveSession() || getState());
  }

  function isApiRefundTypeAllowed(type = 'refund', context = getSelectedApiRefundContext()) {
    if (!context?.isShipped && ['returnRefund', 'resend'].includes(type)) {
      return false;
    }
    return true;
  }

  function syncApiRefundTypeAvailability(context = getSelectedApiRefundContext()) {
    const typeInputs = Array.from(document.querySelectorAll('input[name="apiRefundType"]'));
    typeInputs.forEach(input => {
      const disabled = !isApiRefundTypeAllowed(input.value, context);
      input.disabled = disabled;
      input.closest('.api-refund-radio')?.classList.toggle('is-disabled', disabled);
    });
    if (!isApiRefundTypeAllowed(getCurrentApiRefundType(), context)) {
      const refundTypeInput = document.querySelector('input[name="apiRefundType"][value="refund"]');
      if (refundTypeInput) refundTypeInput.checked = true;
    }
  }

  function shouldShowApiRefundReceiptStatus(type = getCurrentApiRefundType(), context = getSelectedApiRefundContext()) {
    return type === 'refund' && !!context?.isShipped;
  }

  function syncApiRefundReceiptStatusVisibility(options = {}) {
    const type = options.type || getCurrentApiRefundType();
    const context = options.context || getSelectedApiRefundContext();
    const group = document.getElementById('apiRefundReceiptStatusGroup');
    if (!group) return;
    const visible = shouldShowApiRefundReceiptStatus(type, context);
    group.style.display = visible ? '' : 'none';
    if (!visible) {
      document.querySelectorAll('input[name="apiRefundReceiptStatus"]').forEach(input => {
        input.checked = false;
      });
    }
  }

  function syncApiRefundFormByType(options = {}) {
    const context = options.context || getSelectedApiRefundContext();
    syncApiRefundTypeAvailability(context);
    const type = isApiRefundTypeAllowed(options.type || getCurrentApiRefundType(), context)
      ? (options.type || getCurrentApiRefundType())
      : 'refund';
    const meta = getApiRefundTypeMeta(type);
    const reasonLabel = document.getElementById('apiRefundReasonLabel');
    const reasonPlaceholder = document.getElementById('apiRefundReasonPlaceholder');
    const amountGroup = document.getElementById('apiRefundAmountGroup');
    const amountLabel = document.getElementById('apiRefundAmountLabel');
    const amountInput = document.getElementById('apiRefundAmount');
    const noteInput = document.getElementById('apiRefundNote');
    const noteHint = document.getElementById('apiRefundNoteHint');
    const nextAmountText = type === 'resend'
      ? ''
      : clampApiRefundAmountInputValue(
        apiRefundCustomAmount || normalizeApiRefundAmountInputValue(context.amountText),
        { context }
      );
    if (reasonLabel) {
      reasonLabel.innerHTML = `<span class="api-refund-required">*</span>${meta.reasonLabel}`;
    }
    if (reasonPlaceholder) {
      reasonPlaceholder.textContent = `请选择${meta.reasonLabel}`;
    }
    if (amountGroup) {
      amountGroup.style.display = type === 'resend' ? 'none' : '';
    }
    if (amountLabel) {
      amountLabel.innerHTML = `<span class="api-refund-required">*</span>${meta.amountLabel}`;
    }
    if (amountInput) {
      amountInput.disabled = type === 'resend';
      amountInput.placeholder = nextAmountText ? '' : '请输入退款金额';
      amountInput.value = type === 'resend' ? '' : nextAmountText;
    }
    if (type !== 'resend') {
      apiRefundCustomAmount = nextAmountText;
    }
    if (noteHint) {
      noteHint.textContent = meta.noteHint;
    }
    if (noteInput) {
      const previousDefaults = [API_REFUND_DEFAULT_NOTE, API_RETURN_REFUND_DEFAULT_NOTE, API_RESEND_DEFAULT_NOTE, ''];
      if (options.forceNote || previousDefaults.includes(noteInput.value.trim())) {
        noteInput.value = meta.defaultNote;
      }
    }
    syncApiRefundReceiptStatusVisibility({ type, context });
    updateApiRefundNoteCount();
  }

  function fillApiRefundModal(order = {}) {
    const context = order?.key ? order : getApiRefundContext(order);
    apiRefundSelectedOrder = context;
    const image = document.getElementById('apiRefundGoodsImage');
    const placeholder = document.getElementById('apiRefundGoodsPlaceholder');
    const orderIdEl = document.getElementById('apiRefundOrderId');
    const titleEl = document.getElementById('apiRefundGoodsTitle');
    const priceEl = document.getElementById('apiRefundGoodsPrice');
    const amountInput = document.getElementById('apiRefundAmount');
    const reasonSelect = document.getElementById('apiRefundReason');
    const noteInput = document.getElementById('apiRefundNote');
    const refundTypeInput = document.querySelector('input[name="apiRefundType"][value="refund"]');
    apiRefundCustomAmount = clampApiRefundAmountInputValue(context.amountText, { context });
    if (orderIdEl) orderIdEl.textContent = `订单编号：${context.orderId}`;
    if (titleEl) titleEl.textContent = context.title;
    if (priceEl) priceEl.textContent = formatApiRefundPaidText(context.amountText);
    if (amountInput) amountInput.value = apiRefundCustomAmount;
    if (reasonSelect) reasonSelect.value = '';
    if (noteInput) noteInput.value = API_REFUND_DEFAULT_NOTE;
    if (refundTypeInput) refundTypeInput.checked = true;
    document.querySelectorAll('input[name="apiRefundReceiptStatus"]').forEach(input => {
      input.checked = false;
    });
    if (image) {
      image.src = context.imageUrl || '';
      image.style.display = context.imageUrl ? 'block' : 'none';
    }
    if (placeholder) placeholder.style.display = context.imageUrl ? 'none' : 'inline';
    syncApiRefundFormByType({ context, forceNote: true });
  }

  function syncApiRefundBackButton() {
    const backButton = document.getElementById('btnApiRefundBack');
    if (!backButton) return;
    backButton.style.display = apiRefundAllowOrderReselect ? '' : 'none';
  }

  function openApiRefundModal(order = null, options = {}) {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    apiRefundAllowOrderReselect = typeof options.allowOrderReselect === 'boolean'
      ? options.allowOrderReselect
      : apiRefundOrderCandidates.length > 1;
    fillApiRefundModal(order || getSelectedApiRefundContext());
    syncApiRefundBackButton();
    window.showModal?.('modalApiRefund');
  }

  function closeApiRefundModal() {
    window.hideModal?.('modalApiRefund');
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
    apiRefundOrderCandidates = dedupeApiRefundOrders(
      remoteOrders.concat(getApiRefundOrderCandidates(session)),
      session
    );
    if (!apiRefundOrderCandidates.length) {
      apiRefundSelectedOrder = null;
      closeApiRefundOrderSelector();
      showApiRefundOrderEmptyHint();
      return;
    }
    if (apiRefundOrderCandidates.length === 1) {
      apiRefundSelectedOrder = apiRefundOrderCandidates[0] || null;
      closeApiRefundOrderSelector();
      openApiRefundModal(apiRefundSelectedOrder, { allowOrderReselect: false });
      return;
    }
    apiRefundSelectedOrder = apiRefundOrderCandidates[0] || null;
    renderApiRefundOrderSelector();
    window.showModal?.('modalApiRefundOrderSelect');
  }

  function closeApiRefundOrderSelector() {
    window.hideModal?.('modalApiRefundOrderSelect');
  }

  function handleApiRefundOrderSelection(event) {
    const button = event.target.closest('[data-api-refund-order-key]');
    if (!button) return;
    const key = String(button.dataset.apiRefundOrderKey || '');
    const selected = apiRefundOrderCandidates.find(item => item.key === key);
    if (!selected) return;
    apiRefundSelectedOrder = selected;
    closeApiRefundOrderSelector();
    openApiRefundModal(selected, { allowOrderReselect: true });
  }

  function handleApiRefundBack() {
    closeApiRefundModal();
    openApiRefundOrderSelector();
  }

  function handleApiRefundSubmit() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      closeApiRefundModal();
      return;
    }
    const refundType = getCurrentApiRefundType();
    const reasonSelect = document.getElementById('apiRefundReason');
    const selectedReason = reasonSelect?.selectedOptions?.[0] || null;
    const reason = String(selectedReason?.value || '').trim()
      ? String(selectedReason?.textContent || selectedReason.value).trim()
      : '';
    if (!reason) {
      setApiHint('请选择退款原因');
      return;
    }
    const orderContext = getSelectedApiRefundContext();
    const receiptStatus = shouldShowApiRefundReceiptStatus(refundType, orderContext)
      ? getCurrentApiRefundReceiptStatus()
      : '';
    if (shouldShowApiRefundReceiptStatus(refundType, orderContext) && !receiptStatus) {
      setApiHint('请选择收货状态');
      return;
    }
    let amountText = '';
    if (refundType !== 'resend') {
      amountText = clampApiRefundAmountInputValue(document.getElementById('apiRefundAmount')?.value, {
        context: orderContext,
        formatted: true,
      });
      if (!amountText) {
        setApiHint('请输入正确的退款金额');
        return;
      }
      apiRefundCustomAmount = amountText;
      const amountInput = document.getElementById('apiRefundAmount');
      if (amountInput) amountInput.value = amountText;
    }
    const noteText = String(document.getElementById('apiRefundNote')?.value || '').trim();
    const input = document.getElementById('apiMessageInput');
    if (input && noteText) {
      input.value = noteText;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    const actionText = getApiRefundTypeMeta(refundType).actionText;
    const amountDetail = refundType === 'resend' ? '' : (amountText ? `；金额：${amountText}` : '');
    const orderDetail = orderContext?.orderId && orderContext.orderId !== '-' ? `；订单：${orderContext.orderId}` : '';
    const receiptStatusText = receiptStatus === 'received'
      ? '已收到货'
      : (receiptStatus === 'not_received' ? '未收到货' : '');
    const receiptDetail = receiptStatusText ? `；收货状态：${receiptStatusText}` : '';
    recordApiSyncState('退款弹窗', `类型：${actionText}${orderDetail}${receiptDetail}；原因：${reason}${amountDetail}`);
    closeApiRefundModal();
    setApiHint(`已生成${actionText}留言，请确认后发送`);
  }

  function getApiMessageReadState(message = {}) {
    const normalized = String(message?.readState || '').toLowerCase();
    if (normalized === 'read') return 'read';
    if (normalized === 'unread') return 'unread';
    const candidates = [
      message?.raw?.is_read,
      message?.raw?.isRead,
      message?.raw?.read_status,
      message?.raw?.readStatus,
      message?.raw?.read_state,
      message?.raw?.readState,
    ];
    for (const value of candidates) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'boolean') return value ? 'read' : 'unread';
      if (typeof value === 'number') return value > 0 ? 'read' : 'unread';
      const text = String(value).trim().toLowerCase();
      if (['1', 'true', 'read', '已读'].includes(text)) return 'read';
      if (['0', 'false', 'unread', '未读'].includes(text)) return 'unread';
    }
    return '';
  }

  function extractApiGoodsLinkInfo(message = {}) {
    const rawText = [
      message?.content,
      message?.raw?.content,
      message?.raw?.msg_content,
    ].filter(Boolean).join('\n');
    const match = rawText.match(/https?:\/\/(?:mobile\.)?yangkeduo\.com\/(?:goods2?|goods)\.html\?[^ \n]+/i)
      || rawText.match(/https?:\/\/(?:mobile\.)?yangkeduo\.com\/poros\/h5[^ \n]*goods_id=\d+[^ \n]*/i);
    if (!match?.[0]) return null;
    const url = match[0].replace(/&amp;/gi, '&');
    const goodsIdMatch = url.match(/[?&]goods_id=(\d+)/i) || url.match(/[?&]goodsId=(\d+)/i);
    const goodsId = goodsIdMatch?.[1] || '';
    return {
      url,
      goodsId,
      cacheKey: goodsId || url,
    };
  }

  function pickApiGoodsText(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return '';
  }

  function pickApiGoodsNumber(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
      }
    }
    return 0;
  }

  function formatApiGoodsPrice(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return '';
      if (text.includes('¥')) return text;
      const numeric = Number(text);
      if (!Number.isNaN(numeric)) return formatApiGoodsPrice(numeric);
      return text;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const amount = Number.isInteger(numeric) && numeric >= 1000 ? numeric / 100 : numeric;
    return `¥${amount.toFixed(2)}`;
  }

  function normalizeApiGoodsCard(card = {}, fallback = {}) {
    const goodsId = String(card.goodsId || fallback.goodsId || '');
    return {
      goodsId,
      url: String(card.url || fallback.url || ''),
      title: String(card.title || fallback.title || '拼多多商品'),
      imageUrl: String(card.imageUrl || fallback.imageUrl || ''),
      priceText: String(card.priceText || fallback.priceText || ''),
      groupText: String(card.groupText || fallback.groupText || '2人团'),
      specText: String(card.specText || fallback.specText || '查看商品规格'),
    };
  }

  function buildApiGoodsCardFallback(linkInfo, message = {}, session = {}) {
    const sources = [
      message?.extra,
      message?.raw?.extra,
      message?.raw,
      session?.goodsInfo,
      session?.raw?.goods_info,
      session?.raw?.goods,
    ].filter(Boolean);
    const priceText = pickApiGoodsText(sources, ['priceText', 'price_text', 'price'])
      || formatApiGoodsPrice(pickApiGoodsNumber(sources, ['group_price', 'min_group_price', 'price', 'min_price']));
    const groupRawText = pickApiGoodsText(sources, ['groupText', 'group_text', 'groupLabel', 'group_label', 'group_order_type_desc', 'group_desc']);
    const groupCount = pickApiGoodsNumber(sources, ['customer_num', 'group_member_count', 'group_count']);
    return normalizeApiGoodsCard({
      goodsId: linkInfo?.goodsId || pickApiGoodsText(sources, ['goods_id', 'goodsId', 'id']),
      url: linkInfo?.url || '',
      title: pickApiGoodsText(sources, ['title', 'goods_name', 'goodsName', 'name']) || '拼多多商品',
      imageUrl: pickApiGoodsText(sources, ['imageUrl', 'image_url', 'thumb_url', 'hd_thumb_url', 'goods_thumb_url', 'pic_url']),
      priceText,
      groupText: groupRawText || (groupCount > 0 ? `${groupCount}人团` : '2人团'),
      specText: '查看商品规格',
    });
  }

  function renderApiGoodsCardHtml(card = {}) {
    const imageHtml = card.imageUrl
      ? `<img class="api-goods-card-image" src="${esc(card.imageUrl)}" alt="${esc(card.title || '商品主图')}">`
      : '<div class="api-goods-card-image-placeholder">商品</div>';
    const goodsIdLabel = card.goodsId ? `商品ID：${card.goodsId}` : '拼多多商品';
    const priceHtml = card.priceText
      ? `<div class="api-goods-card-price-row"><span class="api-goods-card-price">${esc(card.priceText)}</span><span class="api-goods-card-group">${esc(card.groupText ? `/${card.groupText}` : '')}</span></div>`
      : (card.groupText ? `<div class="api-goods-card-price-row"><span class="api-goods-card-group">${esc(card.groupText)}</span></div>` : '');
    return `<div class="api-message-bubble api-goods-card-bubble">
      <div class="api-goods-card-top">
        <span class="api-goods-card-id">${esc(goodsIdLabel)}</span>
        ${card.goodsId ? `<button class="api-goods-card-copy" type="button" data-goods-id="${esc(card.goodsId)}">复制</button>` : ''}
      </div>
      <div class="api-goods-card-divider"></div>
      <div class="api-goods-card-body">
        ${imageHtml}
        <div class="api-goods-card-main">
          <div class="api-goods-card-title">${esc(card.title || '拼多多商品')}</div>
          ${priceHtml}
          <span class="api-goods-card-spec">${esc(card.specText || '查看商品规格')}</span>
        </div>
      </div>
    </div>`;
  }

  async function ensureApiGoodsCardLoaded(linkInfo, fallbackCard) {
    const state = getState();
    const cache = state.apiGoodsCardCache;
    const pending = state.apiGoodsCardPending;
    if (!linkInfo?.url || !cache || !pending || cache.has(linkInfo.cacheKey) || pending.has(linkInfo.cacheKey)) return;
    if (!window.pddApi?.apiGetGoodsCard) return;
    pending.add(linkInfo.cacheKey);
    try {
      const result = await window.pddApi.apiGetGoodsCard({
        shopId: state.apiActiveSessionShopId,
        url: linkInfo.url,
        goodsId: linkInfo.goodsId,
        fallback: fallbackCard,
      });
      cache.set(linkInfo.cacheKey, normalizeApiGoodsCard(result, fallbackCard));
    } catch {
      cache.set(linkInfo.cacheKey, normalizeApiGoodsCard({}, fallbackCard));
    } finally {
      pending.delete(linkInfo.cacheKey);
      if (getState().apiHasUserSelectedSession) renderApiMessages();
    }
  }

  function shouldShowApiMessageDivider(currentTimestamp, previousTimestamp) {
    const currentMs = getApiTimeMs(currentTimestamp);
    if (!currentMs) return false;
    if (!previousTimestamp) return true;
    const previousMs = getApiTimeMs(previousTimestamp);
    if (!previousMs) return true;
    const currentDate = new Date(currentMs);
    const previousDate = new Date(previousMs);
    const isSameDay = currentDate.getFullYear() === previousDate.getFullYear()
      && currentDate.getMonth() === previousDate.getMonth()
      && currentDate.getDate() === previousDate.getDate();
    if (!isSameDay) return true;
    return currentMs - previousMs >= 5 * 60 * 1000;
  }

  function toggleApiEmojiPanel(forceVisible) {
    const panel = document.getElementById('apiEmojiPanel');
    const button = document.getElementById('btnApiEmojiToggle');
    if (!panel || !button) return false;
    const visible = typeof forceVisible === 'boolean' ? forceVisible : !panel.classList.contains('visible');
    panel.classList.toggle('visible', visible);
    button.classList.toggle('active', visible);
    if (visible) {
      requestAnimationFrame(syncApiEmojiPanelPosition);
    }
    return visible;
  }

  function syncApiEmojiPanelPosition() {
    const panel = document.getElementById('apiEmojiPanel');
    const button = document.getElementById('btnApiEmojiToggle');
    if (!panel || !button || !panel.classList.contains('visible')) return;
    const rect = button.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 310;
    const maxLeft = Math.max(12, window.innerWidth - panelWidth - 12);
    const left = Math.min(Math.max(12, rect.left - 8), maxLeft);
    const top = Math.max(12, rect.top - panel.offsetHeight - 14);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function insertApiMessageText(text) {
    const input = document.getElementById('apiMessageInput');
    if (!input || !text) return;
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
    const value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    input.focus();
    const cursor = start + text.length;
    input.setSelectionRange(cursor, cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function renderApiPddEmojiHtml(text = '') {
    const source = String(text || '');
    if (!source) return '';
    const emojiMap = getState().API_EMOJI_MAP || new Map();
    const pattern = /\[([^[\]]+)\]/g;
    let lastIndex = 0;
    let html = '';
    source.replace(pattern, (match, name, offset) => {
      html += esc(source.slice(lastIndex, offset));
      const item = emojiMap.get(name);
      html += item
        ? `<span class="api-inline-emoji" title="${esc(match)}">${esc(item.preview)}</span>`
        : esc(match);
      lastIndex = offset + match.length;
      return match;
    });
    html += esc(source.slice(lastIndex));
    return html;
  }

  function renderApiEmojiPanel() {
    const grid = document.getElementById('apiEmojiGrid');
    if (!grid) return;
    const emojis = getState().API_EMOJIS || [];
    grid.innerHTML = emojis
      .map(item => `<button class="api-emoji-item" type="button" data-emoji-value="[${item.name}]" data-emoji-name="${item.name}" title="${item.name}">${item.previewImage ? `<img class="api-emoji-image" src="${esc(item.previewImage)}" alt="${esc(item.name)}">` : `<span class="api-emoji-glyph">${esc(item.preview)}</span>`}</button>`)
      .join('');
    grid.querySelectorAll('.api-emoji-item').forEach(item => {
      item.addEventListener('click', event => {
        event.stopPropagation();
        insertApiMessageText(item.dataset.emojiValue || '');
        toggleApiEmojiPanel(false);
      });
    });
  }

  function renderApiEmptyStateHtml({ title = '', subtitle = '', detail = '' } = {}) {
    const safeTitle = esc(title || '');
    const safeSubtitle = esc(subtitle || '');
    const safeDetail = esc(detail || '');
    return `<div class="api-empty api-empty-illustrated">
      <div class="api-empty-visual" aria-hidden="true">
        <span class="api-empty-spark api-empty-spark-left"></span>
        <span class="api-empty-spark api-empty-spark-top"></span>
        <span class="api-empty-spark api-empty-spark-right"></span>
        <span class="api-empty-bubble api-empty-bubble-back"><span class="api-empty-bubble-lines"></span></span>
        <span class="api-empty-bubble api-empty-bubble-front">?</span>
      </div>
      <div class="api-empty-title">${safeTitle}</div>
      ${safeSubtitle ? `<div class="api-empty-subtitle">${safeSubtitle}</div>` : ''}
      ${safeDetail ? `<div class="api-empty-detail">${safeDetail}</div>` : ''}
    </div>`;
  }

  function renderApiMessages() {
    try {
      const state = getState();
      const container = document.getElementById('apiMessageList');
      const mainInner = document.querySelector('.api-chat-main-inner');
      const activeSession = state.apiHasUserSelectedSession ? getApiActiveSession() : null;
      const hasActiveSession = !!(state.apiHasUserSelectedSession && state.apiActiveSessionId && activeSession);
      const shopName = activeSession?.shopName || (state.shops || []).find(item => item.id === state.apiActiveSessionShopId)?.name || '未选择店铺';
      const unreadCount = Number(activeSession?.unreadCount || 0);
      const serviceAvatar = state.apiTokenStatus?.serviceAvatar || '';
      document.getElementById('apiChatCustomerName').textContent = state.apiActiveSessionName || '未选择客户';
      document.getElementById('btnApiStar').textContent = state.isApiSessionStarred?.(activeSession || {}) ? '取消收藏' : '收藏';
      applyApiChatFollowStatus(activeSession);
      document.querySelector('.api-conversation-actions')?.classList.toggle('hidden', !hasActiveSession);
      mainInner?.classList.toggle('is-empty-session', !hasActiveSession);

      if (!hasActiveSession) {
        const visibleSessions = state.getVisibleApiSessions ? state.getVisibleApiSessions() : [];
        const loadError = state.apiSessionLoadError || '';
        const authHint = state.apiTokenStatus?.authHint || '';
        if (loadError || authHint) {
          container.innerHTML = renderApiEmptyStateHtml({
            title: '当前无法加载接口会话',
            subtitle: loadError || authHint,
            detail: visibleSessions.length ? '请稍后重试，或重新选择左侧会话。' : '请先检查店铺认证状态后再重试。'
          });
          return;
        }
        if (visibleSessions.length) {
          container.innerHTML = renderApiEmptyStateHtml({
            title: '请点击左侧会话与买家聊天',
            subtitle: '将窗口最大化即可看到所有会话列表'
          });
          return;
        }
        container.innerHTML = renderApiEmptyStateHtml({
          title: '暂无接口会话',
          subtitle: '请先点击“接口连通测试”或刷新接口会话'
        });
        return;
      }

      if (!(state.apiMessages || []).length) {
        container.innerHTML = renderApiEmptyStateHtml({
          title: '当前会话暂无消息',
          subtitle: '可继续等待买家消息，或手动发送一条新消息',
          detail: '如果刚切换会话，也可能是接口消息仍在加载中。'
        });
        return;
      }

      const sortedMessages = state.apiMessages.slice().sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      let previousTimestamp = 0;
      container.innerHTML = sortedMessages.map((message, index) => {
        const isBuyer = !!message.isFromBuyer;
        const buyerAvatar = activeSession?.customerAvatar || '';
        const sellerText = (shopName || state.apiTokenStatus?.mallName || '主账号').slice(0, 4);
        const avatarHtml = isBuyer
          ? (buyerAvatar ? `<img src="${esc(buyerAvatar)}" alt="">` : esc((state.apiActiveSessionName || '客户').slice(0, 2)))
          : (serviceAvatar ? `<img src="${esc(serviceAvatar)}" alt="">` : esc(sellerText));
        const senderName = shopName || message.senderName || '主账号';
        const readState = isBuyer ? '' : getApiMessageReadState(message);
        const statusText = readState === 'read' ? '已读' : readState === 'unread' ? '未读' : '';
        const metaHtml = isBuyer ? '' : `<div class="api-message-meta"><span class="api-message-sender">${esc(senderName)}</span></div>`;
        const imageUrl = getApiImageMessageUrl(message);
        const goodsLinkInfo = isBuyer ? extractApiGoodsLinkInfo(message) : null;
        const fallbackGoodsCard = goodsLinkInfo ? buildApiGoodsCardFallback(goodsLinkInfo, message, activeSession) : null;
        const cachedGoodsCard = goodsLinkInfo ? state.apiGoodsCardCache?.get(goodsLinkInfo.cacheKey) : null;
        const goodsCard = goodsLinkInfo ? normalizeApiGoodsCard(cachedGoodsCard || {}, fallbackGoodsCard || {}) : null;
        if (goodsLinkInfo && fallbackGoodsCard) {
          void ensureApiGoodsCardLoaded(goodsLinkInfo, fallbackGoodsCard);
        }
        const imageMessage = isApiImageMessage(message);
        const bubbleHtml = goodsLinkInfo
          ? renderApiGoodsCardHtml(goodsCard)
          : imageMessage
            ? `<div class="api-message-bubble"><div class="api-message-content">${imageUrl ? `<img class="api-message-image" src="${esc(imageUrl)}" alt="图片消息">` : '[图片消息]'}</div></div>`
            : `<div class="api-message-bubble"><div class="api-message-content">${renderApiPddEmojiHtml(message.content || '')}</div></div>`;
        const copyButtonHtml = isBuyer && !goodsLinkInfo && !imageMessage && String(message.content || '').trim()
          ? `<button class="api-message-copy" type="button" data-message-index="${index}">复制</button>`
          : '';
        const footerHtml = !isBuyer
          ? `<div class="api-message-row-meta">${statusText ? `<span class="api-message-status ${readState}">${statusText}</span>` : ''}</div>`
          : '';
        const divider = shouldShowApiMessageDivider(message.timestamp, previousTimestamp)
          ? `<div class="api-message-divider">${esc(formatApiDateTime(message.timestamp))}</div>`
          : '';
        previousTimestamp = message.timestamp;
        return `${divider}<div class="api-message-item ${isBuyer ? 'buyer' : 'service'}">
          <div class="api-message-avatar">${avatarHtml}</div>
          <div class="api-message-body">
            ${metaHtml}
            <div class="api-message-row">
              ${isBuyer ? `${bubbleHtml}${copyButtonHtml}` : `${footerHtml}${bubbleHtml}`}
            </div>
          </div>
        </div>`;
      }).join('');
      container.querySelectorAll('.api-message-copy').forEach(button => {
        button.addEventListener('click', async event => {
          event.stopPropagation();
          const messageIndex = Number(button.dataset.messageIndex);
          const text = String(sortedMessages[messageIndex]?.content || '');
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
            showApiSideOrderToast('已成功复制到剪贴板!');
          } catch {
            showApiSideOrderToast('复制失败，请稍后重试');
          }
        });
      });
      container.querySelectorAll('.api-goods-card-copy').forEach(button => {
        button.addEventListener('click', async event => {
          event.stopPropagation();
          const goodsId = String(button.dataset.goodsId || '');
          if (!goodsId) return;
          try {
            await navigator.clipboard.writeText(goodsId);
            setApiHint('已复制商品ID');
          } catch {
            setApiHint('复制失败，请稍后重试');
          }
        });
      });
      container.scrollTop = container.scrollHeight;
    } catch (error) {
      const container = document.getElementById('apiMessageList');
      if (container) {
        container.innerHTML = renderApiEmptyStateHtml({
          title: '聊天内容渲染失败',
          subtitle: error.message || '请稍后重试'
        });
      }
      addLog(`渲染客户对话失败: ${error.message || error}`, 'error');
    }
  }

  function isApiImageMessage(message = {}) {
    const msgType = String(message?.msgType || message?.raw?.msg_type || message?.raw?.message_type || '').toLowerCase();
    if (['2', 'image', 'img', 'pic', 'picture'].includes(msgType)) return true;
    const extraType = String(message?.extra?.type || message?.raw?.extra?.type || message?.raw?.ext?.type || '').toLowerCase();
    if (['image', 'img', 'pic', 'picture'].includes(extraType)) return true;
    const rawContent = `${message?.content || ''} ${message?.raw?.content || ''} ${message?.raw?.msg_content || ''}`.toLowerCase();
    if (/\[(图片|image)\]/.test(rawContent)) return true;
    if (/picture_url/.test(rawContent)) return true;
    if (/https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?/.test(rawContent)) return true;
    return false;
  }

  function getApiImageMessageUrl(message = {}) {
    const candidates = [
      message?.extra?.url,
      message?.extra?.picture_url,
      message?.raw?.extra?.url,
      message?.raw?.extra?.picture_url,
      message?.raw?.ext?.url,
      message?.raw?.ext?.picture_url,
    ].filter(Boolean);
    if (candidates.length) return candidates[0];
    const rawText = `${message?.content || ''} ${message?.raw?.content || ''} ${message?.raw?.msg_content || ''}`;
    const urlMatch = rawText.match(/https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?/i);
    if (urlMatch) return urlMatch[0];
    const jsonMatch = rawText.match(/\{[^{}]*"picture_url"\s*:\s*"([^"]+)"[^{}]*\}/);
    return jsonMatch?.[1] || '';
  }

  function renderApiPhrasePanel() {
    const body = document.getElementById('apiPhrasePanelBody');
    if (!body) return;
    const grouped = {};
    (getState().quickPhrases || []).forEach(item => {
      const category = item.category || '通用';
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(item);
    });

    let html = '';
    for (const [category, items] of Object.entries(grouped)) {
      html += `<div class="phrase-category">${esc(category)}</div>`;
      items.forEach(item => {
        html += `<div class="phrase-item" data-text="${esc(item.text)}">${esc(item.text)}</div>`;
      });
    }
    body.innerHTML = html || '<div style="padding:20px;text-align:center;color:#bbb">暂无快捷短语</div>';

    body.querySelectorAll('.phrase-item').forEach(item => {
      item.addEventListener('click', () => {
        const input = document.getElementById('apiMessageInput');
        if (!input) return;
        input.value = item.dataset.text;
        input.focus();
        setApiHint('已将快捷短语填入接口发送输入框');
      });
    });
  }

  function buildApiPendingReplySignature(sessions = []) {
    return sessions.map(session => `${getApiSessionKey(session)}:${formatApiPendingReplyText(session)}`).join('||');
  }

  function buildApiActivePendingReplySignature() {
    const state = getState();
    if (state.currentView !== 'chat-api' || !state.apiHasUserSelectedSession) return '';
    const activeSession = getApiActiveSession();
    if (!activeSession) return '';
    const followStatus = getApiConversationFollowStatus(activeSession);
    return `${getApiSessionKey(activeSession)}:${followStatus.text || ''}:${followStatus.highlighted ? 1 : 0}`;
  }

  function startApiPendingReplyTicker() {
    if (apiPendingReplyTicker) return;
    apiPendingReplySignature = buildApiPendingReplySignature(getVisibleApiSessions());
    apiActivePendingReplySignature = buildApiActivePendingReplySignature();
    apiPendingReplyTicker = window.setInterval(() => {
      const state = getState();
      if (state.currentView !== 'chat-api') {
        apiPendingReplySignature = '';
        apiActivePendingReplySignature = '';
        return;
      }
      const nextSignature = buildApiPendingReplySignature(getVisibleApiSessions());
      if (nextSignature && nextSignature !== apiPendingReplySignature) {
        apiPendingReplySignature = nextSignature;
        renderApiSessions();
      }
      const nextActiveSignature = buildApiActivePendingReplySignature();
      if (nextActiveSignature === apiActivePendingReplySignature) return;
      apiActivePendingReplySignature = nextActiveSignature;
      applyApiChatFollowStatus(state.apiHasUserSelectedSession ? getApiActiveSession() : null);
    }, 1000);
  }

  function renderApiShopHeader() {
    const state = getState();
    const avatarEl = document.getElementById('apiShopAvatar');
    const selectedShop = getApiSelectedShop();
    const sessionShop = (state.shops || []).find(item => item.id === state.apiActiveSessionShopId) || null;
    const title = state.apiSelectedShopId === state.API_ALL_SHOPS
      ? '全部店铺会话'
      : (selectedShop?.name || '未命名店铺');
    const meta = state.apiSelectedShopId === state.API_ALL_SHOPS
      ? `已接入 ${state.shops?.length || 0} 家店铺，左侧展示所有店铺的咨询客户会话`
      : `当前筛选 ${selectedShop?.name || '店铺'}，右侧优先展示当前会话所属店铺信息`;
    document.getElementById('apiShopName').textContent = title;
    document.getElementById('apiShopHeaderMeta').textContent = meta;
    document.getElementById('apiShopCurrentText').textContent = `当前：${state.apiSelectedShopId === state.API_ALL_SHOPS ? '显示所有店铺' : `仅看 ${selectedShop?.name || '店铺'}`}`;
    if (state.apiTokenStatus?.serviceAvatar && sessionShop && sessionShop.id === state.apiTokenStatus.shopId) {
      avatarEl.innerHTML = `<img src="${esc(state.apiTokenStatus.serviceAvatar)}" alt="">`;
    } else {
      avatarEl.textContent = (state.apiSelectedShopId === state.API_ALL_SHOPS ? '全部店铺' : title).slice(0, 6);
    }
  }

  async function syncApiSelectionWithFilter() {
    const sessions = getVisibleApiSessions();
    const state = getState();
    const currentKey = getApiSessionKey(state.apiActiveSessionShopId, state.apiActiveSessionId);
    const currentVisible = sessions.find(item => item.sessionKey === currentKey);
    renderApiSessions();
    if (currentVisible) return;
    clearApiActiveSession();
    renderApiMessages();
    await loadApiTokenStatus(getApiStatusShopId(false));
    await loadApiTraffic(getApiStatusShopId(true));
  }

  function renderApiSessions() {
    const container = document.getElementById('apiSessionList');
    try {
      const state = getState();
      const latestSessions = getLatestApiSessionsForDisplay();
      const starredSessions = getStarredApiSessionsForDisplay();
      const sessions = state.apiSessionTab === 'starred' ? starredSessions : latestSessions;
      emitRendererDebug('chat-api', 'renderApiSessions', {
        currentView: state.currentView,
        apiSessionTab: state.apiSessionTab,
        activeShopId: state.activeShopId,
        apiSelectedShopId: state.apiSelectedShopId,
        totalSessions: state.apiSessions?.length || 0,
        latestCount: latestSessions.length,
        starredCount: starredSessions.length,
        visibleCount: sessions.length,
        keyword: state.apiSessionKeyword || ''
      });
      const unreadTotal = getApiScopedSessions().reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);
      document.getElementById('apiLatestSessionCount').textContent = String(latestSessions.length);
      document.getElementById('apiStarredSessionCount').textContent = String(starredSessions.length);
      document.getElementById('apiSessionSummary').textContent = state.apiSessionTab === 'starred'
        ? `已收藏 ${starredSessions.length} 条会话`
        : `${sessions.length}/${getApiScopedSessions().length} 条会话`;
      document.getElementById('apiTodoHint').textContent = unreadTotal > 0
        ? `当前有 ${unreadTotal} 条未读待处理消息`
        : (state.apiSessionTab === 'starred' ? '当前没有收藏会话' : '当前没有待处理接口会话');
      document.getElementById('apiSidebarLatest').classList.toggle('active', state.apiSessionTab === 'latest');
      document.getElementById('apiSidebarStarred').classList.toggle('active', state.apiSessionTab === 'starred');
      renderApiShopHeader();
      if (!sessions.length) {
        const emptyText = state.apiSessionTab === 'starred'
          ? '暂无收藏会话，可在右侧按钮中添加收藏。'
          : (state.apiSessionLoadError || '暂无接口会话数据，请先操作嵌入网页或刷新接口会话。');
        container.innerHTML = `<div class="api-empty">${esc(emptyText)}</div>`;
        apiPendingReplySignature = '';
        emitRendererDebug('chat-api', 'renderApiSessions empty-dom', { htmlLength: container.innerHTML.length });
        return;
      }

      container.innerHTML = sessions.map(session => {
        const active = getApiSessionKey(session) === getApiSessionKey(state.apiActiveSessionShopId, state.apiActiveSessionId);
        const unread = Number(session.unreadCount || 0);
        const pendingReply = hasApiPendingReply(session);
        const pendingReplyText = pendingReply ? formatApiPendingReplyText(session) : '';
        const avatarHtml = session.customerAvatar ? `<img src="${esc(session.customerAvatar)}" alt="">` : '';
        return `<div class="api-session-item ${active ? 'active' : ''} ${pendingReply ? 'reply-pending' : ''} ${unread > 0 ? 'has-unread' : ''}" data-session-id="${esc(session.sessionId)}" data-shop-id="${esc(session.shopId)}" data-customer-name="${esc(session.customerName || '')}">
          <div class="api-session-avatar">${avatarHtml}</div>
          <div class="api-session-main">
            <div class="api-session-item-title">
              <div class="api-session-item-info-row">
                <div class="api-session-item-name">
                  <span class="api-session-item-name-text">${esc(session.customerName || session.customerId || '未知客户')}</span>
                  ${unread > 0 ? `<span class="api-unread-badge">${unread}</span>` : ''}
                </div>
                <div class="api-session-shop">
                  <span class="api-session-shop-tag">${esc(session.shopName || '未命名店铺')}</span>
                </div>
              </div>
              <div class="api-session-time-group">
                <span class="api-session-item-time">${formatApiListTime(session.lastMessageTime)}</span>
              </div>
            </div>
            <div class="api-session-item-text">${renderApiPddEmojiHtml(session.lastMessage || '暂无消息')}</div>
            ${pendingReplyText ? `<span class="api-session-item-wait">${esc(pendingReplyText)}</span>` : ''}
          </div>
        </div>`;
      }).join('');
      emitRendererDebug('chat-api', 'renderApiSessions dom-ready', {
        itemCount: container.querySelectorAll('.api-session-item').length,
        htmlLength: container.innerHTML.length
      });

      container.querySelectorAll('.api-session-item').forEach(item => {
        item.addEventListener('click', async () => {
          await openApiSession(item.dataset.sessionId, item.dataset.customerName, item.dataset.shopId);
        });
      });
      apiPendingReplySignature = buildApiPendingReplySignature(sessions);
      container.querySelectorAll('.api-session-star').forEach(button => {
        button.addEventListener('click', async event => {
          event.stopPropagation();
          const session = getVisibleApiSessions().find(item => item.sessionKey === button.dataset.sessionKey);
          if (!session) return;
          const result = await window.pddApi.toggleApiStarredSession(session);
          if (!result?.error) {
            setApiStarredSessions(Array.isArray(result.sessions) ? result.sessions : null);
            renderApiSessions();
            renderApiMessages();
            setApiHint(result.starred ? '已收藏当前会话' : '已取消收藏会话');
          }
        });
      });
    } catch (error) {
      emitRendererDebug('chat-api', 'renderApiSessions error', {
        message: error.message,
        stack: error.stack
      });
      container.innerHTML = `<div class="api-empty">渲染会话列表失败：${esc(error.message || '未知错误')}</div>`;
    }
  }

  async function handleApiOrderInfo() {
    await loadApiTraffic(getApiStatusShopId(true));
    setApiHint('右侧已更新最新订单辅助信息，可结合抓包继续补接口。');
  }

  async function handleApiProductInfo() {
    await loadApiTraffic(getApiStatusShopId(true));
    setApiHint('商品信息区已预留，后续可继续从抓包中补真实接口。');
  }

  async function handleApiSendMessage() {
    const state = getState();
    const text = document.getElementById('apiMessageInput')?.value.trim() || '';
    const activeSession = getApiActiveSession();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    if (!text) {
      setApiHint('请输入要发送的消息');
      return;
    }
    recordApiSyncState('消息发送', `会话：${state.apiActiveSessionName || state.apiActiveSessionId}`);
    const result = await window.pddApi.apiSendMessage({
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      session: activeSession || undefined,
      text,
    });
    if (result?.error) {
      recordApiSyncState('发送失败', result.error);
      setApiHint(`接口发送失败：${result.error}`);
      return;
    }
    const successPayload = {
      ...result,
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      text,
    };
    recordApiSyncState('发送成功', `会话：${state.apiActiveSessionName || state.apiActiveSessionId}`);
    clearApiPendingReplyState(successPayload);
    appendApiLocalServiceMessage(successPayload);
    const input = document.getElementById('apiMessageInput');
    if (input) input.value = '';
    setApiHint('接口发送成功，正在同步最新消息');
  }

  async function handleApiSendImage() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    toggleApiEmojiPanel(false);
    recordApiSyncState('选择图片', `会话：${state.apiActiveSessionName || state.apiActiveSessionId}`);
    const selected = await window.pddApi.apiSelectImage();
    if (selected?.canceled) {
      recordApiSyncState('图片取消', '用户取消选择图片');
      setApiHint('已取消选择图片');
      return;
    }
    if (!selected?.filePath) {
      recordApiSyncState('图片失败', '未拿到图片路径');
      setApiHint('未选择图片文件');
      return;
    }
    const fileName = String(selected.filePath).split(/[\\/]/).pop() || '图片';
    recordApiSyncState('图片上传', `文件：${fileName}`);
    setApiHint('正在上传并发送图片，请稍候...');
    const result = await window.pddApi.apiSendImage({
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      session: getApiActiveSession() || undefined,
      filePath: selected.filePath,
    });
    if (result?.error) {
      const attemptText = Array.isArray(result?.attempts) && result.attempts.length
        ? result.attempts.map(item => `${item.baseUrl} → ${item.error}`).join('；')
        : '';
      const detail = [
        result?.step ? `阶段：${result.step}` : '',
        result?.uploadBaseUrl ? `上传域：${result.uploadBaseUrl}` : '',
        attemptText,
        result?.error || ''
      ].filter(Boolean).join('；');
      recordApiSyncState('图片失败', detail || '图片发送失败');
      setApiHint(`图片发送失败：${detail || result.error}`);
      return;
    }
    recordApiSyncState('图片发送', `${fileName}${result?.uploadBaseUrl ? `，上传域：${result.uploadBaseUrl}` : ''}`);
    setApiHint('图片已发送，正在同步最新消息');
  }

  async function handleApiTransfer() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    await window.pddApi.apiMarkLatestConversations({ shopId: state.apiActiveSessionShopId, size: 100 });
    await loadApiTraffic(state.apiActiveSessionShopId);
    setApiHint('已模拟执行会话处理动作，当前先复用已读链路。');
  }

  async function handleApiRisk() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    try {
      await navigator.clipboard.writeText(state.apiActiveSessionId);
      setApiHint(`已复制会话ID：${state.apiActiveSessionId}`);
    } catch {
      setApiHint(`会话ID：${state.apiActiveSessionId}`);
    }
  }

  async function handleApiStar() {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    const activeSession = getApiActiveSession();
    const result = await window.pddApi.toggleApiStarredSession(activeSession || {
      shopId: state.apiActiveSessionShopId,
      sessionId: state.apiActiveSessionId,
      customerName: state.apiActiveSessionName,
    });
    if (result?.error) {
      setApiHint(result.error);
      return;
    }
    setApiStarredSessions(Array.isArray(result.sessions) ? result.sessions : null);
    renderApiSessions();
    renderApiMessages();
    setApiHint(result.starred ? '已收藏当前会话' : '已取消收藏当前会话');
  }

  function handleApiMessageInputKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      document.getElementById('btnApiSendMessage')?.click();
    }
  }

  async function handleApiSessionUpdated(payload) {
    const state = getState();
    emitRendererDebug('chat-api', 'onApiSessionUpdated', {
      currentView: state.currentView,
      payloadShopId: payload?.shopId || '',
      payloadCount: Array.isArray(payload?.sessions) ? payload.sessions.length : -1,
      apiSelectedShopId: state.apiSelectedShopId,
      beforeCount: state.apiSessions?.length || 0
    });
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    if (Array.isArray(payload?.sessions) && payload.sessions.length > 0) {
      mergeApiSessionsForShop(payload.shopId, payload.sessions);
    }
    if (Array.isArray(payload?.sessions)) {
      await syncApiSelectionWithFilter();
      callRuntime('renderApiSideCards');
    }
    if (getState().currentView === 'chat-api') {
      await loadApiTraffic(getApiStatusShopId(true));
    }
  }

  async function handleApiNewMessage(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    await loadApiTraffic(getApiStatusShopId(true));
    const nextState = getState();
    if (String(payload?.sessionId || '') === String(nextState.apiActiveSessionId) && String(payload?.shopId || '') === String(nextState.apiActiveSessionShopId || '')) {
      await openApiSession(nextState.apiActiveSessionId, nextState.apiActiveSessionName || payload.customer || '', nextState.apiActiveSessionShopId);
    } else {
      await loadApiSessions({ keepCurrent: true });
    }
    setApiHint(`收到接口新消息：${payload?.customer || '未知客户'}`);
  }

  async function handleApiMessageSent(payload) {
    await refreshApiAfterMessageSent(payload);
  }

  function handleApiAuthExpired(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    setApiTokenStatus({
      ...(state.apiTokenStatus || {}),
      authExpired: true,
      authState: payload?.authState || 'expired',
      authHint: payload?.errorMsg || '',
    });
    renderApiStatus();
    setApiHint(payload?.errorMsg || getApiAuthHintText() || '接口认证已过期，请重新导入 Token 或刷新登录态');
  }

  function bindChatApiModule() {
    if (initialized) return;
    initialized = true;
    window.__chatApiModuleBound = true;

    renderApiEmojiPanel();
    startApiPendingReplyTicker();

    document.getElementById('apiShopFilter')?.addEventListener('change', async event => {
      const state = getState();
      setApiSelectedShopId(event.target.value || state.API_ALL_SHOPS);
      await callRuntime('loadApiChatView', { keepCurrent: true });
      const nextState = getState();
      setApiHint(nextState.apiSelectedShopId === nextState.API_ALL_SHOPS ? '已切换为显示所有店铺会话' : '已切换店铺会话范围');
    });

    document.getElementById('btnApiRefreshSessions')?.addEventListener('click', async () => {
      await loadApiSessions({ keepCurrent: true });
      await loadApiTraffic(getApiStatusShopId(true));
      setApiHint('已刷新接口会话');
    });

    document.getElementById('apiSessionSearch')?.addEventListener('input', event => {
      setApiSessionKeyword(event.target.value || '');
      syncApiSelectionWithFilter();
    });

    document.getElementById('apiSessionSearch')?.addEventListener('keydown', async event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        document.getElementById('btnApiPlus')?.click();
      }
    });

    document.getElementById('apiSidebarLatest')?.addEventListener('click', () => {
      setApiSessionTab('latest');
      syncApiSelectionWithFilter();
    });

    document.getElementById('apiSidebarStarred')?.addEventListener('click', () => {
      setApiSessionTab('starred');
      syncApiSelectionWithFilter();
    });

    document.querySelectorAll('.api-side-tab').forEach(button => {
      button.addEventListener('click', () => {
        setApiSideTab(button.dataset.apiSideTab || 'personal');
        callRuntime('renderApiSideCards');
      });
    });
    document.getElementById('apiSideOrderList')?.addEventListener('click', handleApiSideOrderListClick);
    document.getElementById('apiSideOrderList')?.addEventListener('input', handleApiSideOrderListInput);
    document.getElementById('apiSideOrderList')?.addEventListener('change', handleApiSideOrderListChange);

    document.getElementById('btnApiPlus')?.addEventListener('click', async () => {
      const keyword = String(getState().apiSessionKeyword || '').trim().toLowerCase();
      if (!keyword) {
        setApiHint('请输入订单号、客户名或会话关键词');
        return;
      }
      const target = getLatestApiSessionsForDisplay().find(session => {
        const orderText = String(session.orderId || '').toLowerCase();
        return orderText === keyword
          || String(session.sessionId || '').toLowerCase() === keyword
          || String(session.customerId || '').toLowerCase() === keyword
          || String(session.customerName || '').toLowerCase().includes(keyword);
      });
      if (!target) {
        setApiHint('当前列表未找到匹配会话，可先刷新会话再尝试搜索');
        return;
      }
      setApiSessionTab('latest');
      await openApiSession(target.sessionId, target.customerName, target.shopId);
      setApiHint(`已定位会话：${target.customerName || target.customerId || target.sessionId}`);
    });

    document.getElementById('apiLoadMoreSessions')?.addEventListener('click', async () => {
      await loadApiSessions({ keepCurrent: true });
      setApiHint('已按当前筛选范围刷新会话列表');
    });

    document.getElementById('btnApiReloadTraffic')?.addEventListener('click', async () => {
      await loadApiTraffic(getApiStatusShopId(true));
      setApiHint('已刷新服务助手与接口记录');
    });

    document.getElementById('btnApiOrderInfo')?.addEventListener('click', handleApiOrderInfo);
    document.getElementById('btnApiProductInfo')?.addEventListener('click', handleApiProductInfo);
    document.getElementById('btnApiSendMessage')?.addEventListener('click', handleApiSendMessage);
    document.getElementById('btnApiSendImage')?.addEventListener('click', handleApiSendImage);
    document.getElementById('btnApiTransfer')?.addEventListener('click', handleApiTransfer);
    document.getElementById('btnApiRisk')?.addEventListener('click', handleApiRisk);
    document.getElementById('btnApiStar')?.addEventListener('click', handleApiStar);
    document.getElementById('btnApiRefund')?.addEventListener('click', openApiRefundOrderSelector);
    document.getElementById('apiRefundOrderList')?.addEventListener('click', handleApiRefundOrderSelection);
    document.getElementById('btnApiRefundBack')?.addEventListener('click', handleApiRefundBack);
    document.getElementById('btnApiRefundSubmit')?.addEventListener('click', handleApiRefundSubmit);
    document.getElementById('apiRefundNote')?.addEventListener('input', updateApiRefundNoteCount);
    document.getElementById('apiRefundAmount')?.addEventListener('input', event => {
      const nextValue = clampApiRefundAmountInputValue(event.target?.value);
      apiRefundCustomAmount = nextValue;
      if (event.target && event.target.value !== nextValue) {
        event.target.value = nextValue;
      }
    });
    document.getElementById('apiRefundAmount')?.addEventListener('blur', event => {
      const nextValue = clampApiRefundAmountInputValue(event.target?.value, { formatted: true });
      apiRefundCustomAmount = nextValue;
      if (event.target) {
        event.target.value = nextValue;
      }
    });
    document.querySelectorAll('input[name="apiRefundType"]').forEach(input => {
      input.addEventListener('change', () => {
        syncApiRefundFormByType();
      });
    });
    document.getElementById('apiMessageInput')?.addEventListener('keydown', handleApiMessageInputKeydown);

    document.getElementById('btnApiQuickReply')?.addEventListener('click', async () => {
      const panel = document.getElementById('apiPhrasePanel');
      toggleApiEmojiPanel(false);
      panel.classList.toggle('visible');
      if (panel.classList.contains('visible')) {
        await loadQuickPhrases();
        renderApiPhrasePanel();
      }
    });

    document.getElementById('btnApiTogglePhrases')?.addEventListener('click', async () => {
      const panel = document.getElementById('apiPhrasePanel');
      toggleApiEmojiPanel(false);
      panel.classList.toggle('visible');
      if (panel.classList.contains('visible')) {
        await loadQuickPhrases();
        renderApiPhrasePanel();
      }
    });

    document.getElementById('btnApiEmojiToggle')?.addEventListener('click', event => {
      event.stopPropagation();
      document.getElementById('apiPhrasePanel')?.classList.remove('visible');
      toggleApiEmojiPanel();
    });

    document.getElementById('apiEmojiPanel')?.addEventListener('click', event => {
      event.stopPropagation();
    });

    document.addEventListener('click', event => {
      const panel = document.getElementById('apiEmojiPanel');
      const button = document.getElementById('btnApiEmojiToggle');
      if (!panel || !button) return;
      if (panel.contains(event.target) || button.contains(event.target)) return;
      toggleApiEmojiPanel(false);
    });

    window.addEventListener('resize', () => {
      syncApiEmojiPanelPosition();
    });

    window.pddApi.onApiSessionUpdated(handleApiSessionUpdated);
    window.pddApi.onApiNewMessage(handleApiNewMessage);
    window.pddApi.onApiMessageSent(handleApiMessageSent);
    window.pddApi.onApiAuthExpired(handleApiAuthExpired);
    renderApiSideOrders();
  }

  window.setApiHint = setApiHint;
  window.toggleApiEmojiPanel = toggleApiEmojiPanel;
  window.syncApiEmojiPanelPosition = syncApiEmojiPanelPosition;
  window.insertApiMessageText = insertApiMessageText;
  window.renderApiPddEmojiHtml = renderApiPddEmojiHtml;
  window.renderApiEmojiPanel = renderApiEmojiPanel;
  window.renderApiShopHeader = renderApiShopHeader;
  window.renderApiSessions = renderApiSessions;
  window.renderApiMessages = renderApiMessages;
  window.renderApiPhrasePanel = renderApiPhrasePanel;
  window.renderApiSideOrders = renderApiSideOrders;
  window.invalidateApiSideOrders = invalidateApiSideOrders;
  window.syncApiSelectionWithFilter = syncApiSelectionWithFilter;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('chat-api-module', bindChatApiModule);
  } else {
    bindChatApiModule();
  }
})();
