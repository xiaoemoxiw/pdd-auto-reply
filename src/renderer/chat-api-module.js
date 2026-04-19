(function () {
  let initialized = false;
  let apiPendingReplyTicker = null;
  let apiPendingReplySignature = '';
  let apiActivePendingReplySignature = '';
  let apiSessionListRenderSignature = '';
  let apiPendingSessionUpdateTimer = null;
  let apiPendingSessionUpdateNeedsTrafficRefresh = false;
  let apiPendingSessionUpdateHint = '';
  // 退款 modal 的 4 个状态变量已迁出至
  // src/renderer/chat-api/modules/refund-modal.js
  // 邀请下单 modal / 邀请关注按钮的状态已迁出至
  // src/renderer/chat-api/modules/invite-order-modal.js
  let apiSideOrderSessionKey = '';
  let apiSideOrderCountdownTimer = null;
  // 商品规格 modal 状态已迁出至
  // src/renderer/chat-api/modules/goods-spec-modal.js
  const apiGoodsSourceDebugPrintedKeys = new Set();
  const apiSideOrderStore = {
    personal: { cacheKey: '', loading: false, stale: false, error: '', items: [] },
    aftersale: { cacheKey: '', loading: false, stale: false, error: '', items: [] },
    pending: { cacheKey: '', loading: false, stale: false, error: '', items: [] },
  };
  // 退款 / 退货退款 / 补寄三种默认话术常量随退款 modal 一起迁出至
  // src/renderer/chat-api/modules/refund-modal.js
  const API_SESSION_UPDATE_BATCH_DELAY_MS = 320;
  const API_SESSION_INITIAL_BATCH_DELAY_MS = 1200;
  const API_ORDER_REMARK_MAX_LENGTH = 300;
  const API_ORDER_REMARK_TAG_ORDER = ['RED', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE'];
  const API_ORDER_REMARK_TAG_LABELS = {
    RED: '红色',
    YELLOW: '黄色',
    GREEN: '绿色',
    BLUE: '蓝色',
    PURPLE: '紫色',
  };
  const API_SIDE_ORDER_PRICE_MIN_DISCOUNT = 1;
  const API_SIDE_ORDER_PRICE_MAX_DISCOUNT = 10;
  const API_SIDE_ORDER_PRICE_ERROR_TEXT = '您仅可对订单进行一次改价操作，且优惠折扣不能低于1折';
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
  let apiSideOrderPriceState = {
    visible: false,
    saving: false,
    orderKey: '',
    orderId: '',
    originalAmount: 0,
    shippingFee: 0,
    discount: '',
    amount: '',
    error: '',
    previewAmount: 0,
    hasChange: false,
  };
  const apiPendingSessionUpdates = new Map();
  const apiPendingSessionUpserts = new Map();

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
    if (!value) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function addLog(text, type = 'info') {
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = text;
    console.log(`[${type}] ${text}`);
  }

  function getApiTimeMs(value) {
    if (!value) return 0;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : 0;
    }
    const num = Number(value);
    if (Number.isFinite(num) && num) {
      return num < 1e12 ? num * 1000 : num;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return 0;
      const fallback = new Date(text).getTime();
      if (Number.isFinite(fallback)) return fallback;
      const normalized = text
        .replace(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(:\d{2})?/, '$1T$2$3');
      const ms = new Date(normalized).getTime();
      return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
  }

  function formatApiDateTime(value) {
    const ms = getApiTimeMs(value);
    if (!ms) return '';
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function formatApiListTime(value) {
    const num = Number(value);
    if (!num) return '-';
    const ms = num < 1e12 ? num * 1000 : num;
    const date = new Date(ms);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    if (sameDay) {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function getApiActiveSession() {
    return callRuntime('getApiActiveSession') || null;
  }

  function loadQuickPhrases() {
    return callRuntime('loadQuickPhrases');
  }

  function getApiSessionKey(sessionOrShopId, maybeSessionId = '') {
    if (typeof sessionOrShopId === 'object' && sessionOrShopId) {
      return `${sessionOrShopId.shopId || ''}::${sessionOrShopId.sessionId || ''}`;
    }
    return `${sessionOrShopId || ''}::${maybeSessionId || ''}`;
  }

  function emitRendererDebug(scope, message, extra = {}) {
    if (!window.pddApi?.debugLog) return;
    window.pddApi.debugLog({ scope, message, extra });
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

  function getApiSelectableShops() {
    return callRuntime('getApiSelectableShops') || [];
  }

  function getApiSessionLastMessageActor(session = {}) {
    const actor = String(session.lastMessageActor || '').toLowerCase();
    if (actor) return actor;
    const raw = session?.raw && typeof session.raw === 'object' ? session.raw : null;
    const context = {
      customer_id: session.customerId || raw?.customer_id,
      buyer_id: session.customerId || raw?.buyer_id,
      user_info: raw?.user_info,
      from: raw?.from,
      to: raw?.to,
    };
    const candidates = [
      raw?.last_msg,
      raw?.last_message,
      raw?.latest_msg,
      raw?.content,
      raw,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const role = String(
        candidate.role
        || candidate.msg_from
        || candidate.from_type
        || candidate.sender_role
        || candidate?.from?.role
        || candidate?.sender?.role
        || candidate?.to?.role
        || ''
      ).toLowerCase();
      if (['buyer', 'customer', 'user', '1', '0'].includes(role)) return 'buyer';
      if (['system', 'robot', 'bot', 'notice', 'tips', '99'].includes(role)) return 'system';
      if (['seller', 'service', 'kf', 'agent', 'mall_cs', '2', '3', '4'].includes(role)) return 'seller';
      const merged = { ...context, ...candidate };
      if (merged.is_buyer || merged.is_buyer === 1 || merged.sender_type === 1 || merged.sender_type === 0) return 'buyer';
      if (merged.is_robot || merged.is_system) return 'system';
      if (merged.is_seller) return 'seller';
    }
    return 'unknown';
  }

  function isApiSessionLastMessageFromBuyer(session = {}) {
    if (session.lastMessageIsFromBuyer === true) return true;
    return getApiSessionLastMessageActor(session) === 'buyer';
  }

  function getApiPendingReplyElapsedMs(session = {}) {
    const lastMessageMs = getApiTimeMs(session.lastMessageTime);
    if (lastMessageMs > 0) {
      return Math.max(0, Date.now() - lastMessageMs);
    }
    const waitValue = Number(session.waitTime || 0);
    if (!(waitValue > 0)) return 0;
    if (waitValue > 1e12) {
      return Math.max(0, Date.now() - waitValue);
    }
    if (waitValue > 1e9) {
      return Math.max(0, Date.now() - waitValue * 1000);
    }
    if (waitValue > 100000) {
      return Math.max(0, waitValue);
    }
    if (waitValue > 1440) {
      return Math.max(0, waitValue * 1000);
    }
    return Math.max(0, waitValue * 60000);
  }

  function getApiPendingReplyDisplayState(session = {}) {
    const unreadCount = Number(session.unreadCount || 0);
    const waitValue = Number(session.waitTime || 0);
    const pending = isApiSessionLastMessageFromBuyer(session) && (unreadCount > 0 || waitValue > 0 || !!session.isTimeout);
    if (!pending) {
      return { pending: false, countdownSeconds: 0, waitMinutes: 0 };
    }
    const elapsedMs = getApiPendingReplyElapsedMs(session);
    if (!elapsedMs) {
      return { pending: false, countdownSeconds: 0, waitMinutes: 0 };
    }
    const timeoutMs = 180 * 1000;
    if (elapsedMs < timeoutMs) {
      return {
        pending: true,
        countdownSeconds: Math.ceil((timeoutMs - elapsedMs) / 1000),
        waitMinutes: 0,
      };
    }
    return {
      pending: true,
      countdownSeconds: 0,
      waitMinutes: Math.max(3, Math.floor(elapsedMs / 60000)),
    };
  }

  function getApiPendingReplyMinutes(session = {}) {
    return getApiPendingReplyDisplayState(session).waitMinutes || 0;
  }

  function hasApiPendingReply(session = {}) {
    return !!getApiPendingReplyDisplayState(session).pending;
  }

  function formatApiPendingReplyText(session = {}) {
    const pendingState = getApiPendingReplyDisplayState(session);
    if (!pendingState.pending) return '';
    if (pendingState.countdownSeconds > 0) {
      return `${pendingState.countdownSeconds}秒后超时`;
    }
    const waitMinutes = pendingState.waitMinutes || 0;
    if (waitMinutes <= 0) return '';
    if (waitMinutes > 60) {
      return `已等待${Math.floor(waitMinutes / 60)}小时`;
    }
    return `已等待${waitMinutes}分钟`;
  }

  function getApiConversationFollowStatus(session = null) {
    if (!session) {
      return { text: '', highlighted: false, visible: false };
    }
    const pendingReplyText = formatApiPendingReplyText(session);
    if (pendingReplyText) {
      return { text: pendingReplyText, highlighted: true, visible: true };
    }
    const isShopMember = typeof session.isShopMember === 'boolean'
      ? session.isShopMember
      : (typeof session.is_shop_member === 'boolean' ? session.is_shop_member : null);
    return {
      text: isShopMember === true ? '已关注本店' : '',
      highlighted: false,
      visible: isShopMember === true,
    };
  }

  function formatApiTime(value) {
    const num = Number(value);
    if (!num) return '-';
    const ms = num < 1e12 ? num * 1000 : num;
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  function formatApiDate(value) {
    const num = Number(value);
    if (!num) return '';
    const ms = num < 1e12 ? num * 1000 : num;
    const date = new Date(ms);
    return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日`;
  }

  function formatApiAmount(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : '¥0.00';
  }

  function getApiSessionVisibleStartMs() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return startOfToday - 24 * 60 * 60 * 1000;
  }

  function isApiSessionWithinRecentDays(session = {}) {
    return getApiTimeMs(session.lastMessageTime) >= getApiSessionVisibleStartMs();
  }

  function getApiSessionDedupKey(session = {}) {
    const raw = session?.raw && typeof session.raw === 'object' ? session.raw : {};
    const shopId = String(session?.shopId || '').trim();
    const identity = String(
      session?.customerId
      || session?.userUid
      || raw?.customer_id
      || raw?.buyer_id
      || raw?.user_info?.uid
      || session?.sessionId
      || session?.explicitSessionId
      || session?.conversationId
      || session?.chatId
      || session?.rawId
      || ''
    ).trim();
    return `${shopId}::${identity}`;
  }

  function normalizeApiVideoItem(item = {}) {
    if (!item || typeof item !== 'object') return null;
    const normalized = {
      id: Number(item.id || item.fileId || 0) || 0,
      name: String(item.name || item.fileName || '').trim(),
      extension: String(item.extension || '').trim(),
      url: String(item.url || item.videoUrl || '').trim(),
      coverUrl: String(item.coverUrl || item.videoCoverUrl || item.video_cover_url || '').trim(),
      duration: Number(item.duration || item.videoDuration || 0) || 0,
      width: Number(item.width || 0) || 0,
      height: Number(item.height || 0) || 0,
      size: Number(item.size || 0) || 0,
      checkStatus: Number(item.checkStatus || item.check_status || 0) || 0,
    };
    if (!normalized.url && !normalized.id) return null;
    return normalized;
  }

  function buildApiSyntheticRefundMessageKey(payload = {}) {
    const refundCard = payload?.refundCard && typeof payload.refundCard === 'object' ? payload.refundCard : {};
    return [
      String(payload.shopId || ''),
      String(payload.sessionId || ''),
      String(refundCard.localKey || ''),
      String(refundCard.orderSn || ''),
      String(refundCard.actionText || ''),
      String(refundCard.amountText || '')
    ].join('::');
  }

  function formatApiCacheRelativeTime(ms) {
    const numeric = Number(ms || 0);
    if (!numeric) return '刚刚';
    const diff = Date.now() - numeric;
    if (diff < 0) return '刚刚';
    if (diff < 30 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 3600000))} 小时前`;
    return `${Math.max(1, Math.round(diff / 86400000))} 天前`;
  }

  function isUnknownApiCustomerName(value = '') {
    return ['未知客户', '未知', '客户', '未选择客户'].includes(String(value || '').trim());
  }

  function pickApiDisplayText(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = String(source[key] || '').trim();
        if (!value) continue;
        if (keys.includes('customerName') && isUnknownApiCustomerName(value)) continue;
        return value;
      }
    }
    return '';
  }

  function getShopAvailabilityStatus(shop) {
    return shop?.availabilityStatus || shop?.status || 'offline';
  }

  function isApiSelectableShop(shop) {
    const availabilityStatus = getShopAvailabilityStatus(shop);
    if (!shop?.id) return false;
    if (availabilityStatus === 'expired' || availabilityStatus === 'invalid') return false;
    return shop.loginMethod !== 'token' || availabilityStatus === 'online' || !!shop?.tokenFileName;
  }

  function matchApiSessionKeyword(session, keyword) {
    if (!keyword) return true;
    const text = [
      session.customerName,
      session.customerId,
      session.sessionId,
      session.lastMessage,
      session.orderId,
      session.shopName
    ].join(' ').toLowerCase();
    return text.includes(keyword);
  }

  function pickApiSessionCustomerName(session = {}) {
    const raw = session.raw && typeof session.raw === 'object' ? session.raw : {};
    const userInfo = raw.user_info && typeof raw.user_info === 'object' ? raw.user_info : {};
    const buyerInfo = raw.buyer && typeof raw.buyer === 'object' ? raw.buyer : {};
    const customerInfo = raw.customer && typeof raw.customer === 'object' ? raw.customer : {};
    const fromObj = raw.from && typeof raw.from === 'object' ? raw.from : {};
    const toObj = raw.to && typeof raw.to === 'object' ? raw.to : {};
    const buyerUid = String(
      session.customerId
      || raw.customer_id
      || raw.buyer_id
      || userInfo.uid
      || raw.uid
      || ''
    ).trim();
    const participant = buyerUid && String(fromObj.uid || '').trim() === buyerUid
      ? fromObj
      : (buyerUid && String(toObj.uid || '').trim() === buyerUid ? toObj : (fromObj.uid ? fromObj : toObj));
    return pickApiDisplayText(
      [session, raw, userInfo, buyerInfo, customerInfo, participant, fromObj, toObj],
      [
        'customerName',
        'displayName',
        'nick',
        'nickname',
        'nick_name',
        'buyer_name',
        'buyer_nickname',
        'buyer_nick_name',
        'customer_name',
        'customer_nickname',
        'customer_nick_name',
        'display_name',
        'name',
      ]
    );
  }

  function buildApiSession(session = {}) {
    const state = getState();
    const shopsList = Array.isArray(state.shops) ? state.shops : [];
    const shop = shopsList.find(item => item.id === session.shopId) || null;
    const shopId = session.shopId || shop?.id || state.apiActiveSessionShopId || state.activeShopId || '';
    const lastMessageActor = getApiSessionLastMessageActor(session);
    const mallName = session.mallName || session.raw?.mallName || session.raw?.mall_name || '';
    const preferredShopName = ['未命名店铺', '未知店铺'].includes(String(session.shopName || '').trim())
      ? ''
      : session.shopName;
    const customerName = pickApiSessionCustomerName(session);
    return {
      ...session,
      shopId,
      mallName,
      customerName,
      dedupKey: getApiSessionDedupKey({ ...session, shopId }),
      isShopMember: typeof session.isShopMember === 'boolean'
        ? session.isShopMember
        : (typeof session.is_shop_member === 'boolean'
          ? session.is_shop_member
          : (typeof session.raw?.is_shop_member === 'boolean'
            ? session.raw.is_shop_member
            : null)),
      shopName: preferredShopName || mallName || shop?.name || '未命名店铺',
      sessionKey: getApiSessionKey(shopId, session.sessionId),
      lastMessageActor,
      lastMessageIsFromBuyer: session.lastMessageIsFromBuyer === true || lastMessageActor === 'buyer',
    };
  }
  window.buildApiSession = buildApiSession;

  function getApiSessionSyncSignature(session = {}) {
    const normalized = buildApiSession(session);
    return [
      normalized.shopId || '',
      normalized.sessionId || '',
      normalized.lastMessageTime || 0,
      normalized.lastMessageActor || '',
      normalized.unreadCount || 0,
      normalized.waitTime || 0,
      normalized.lastMessage || '',
    ].join('::');
  }
  window.getApiSessionSyncSignature = getApiSessionSyncSignature;

  function getApiSessionRealtimeSortTime(session = {}) {
    const normalized = buildApiSession(session);
    return Number(normalized.updatedAt || normalized.lastMessageTime || 0) || 0;
  }
  window.getApiSessionRealtimeSortTime = getApiSessionRealtimeSortTime;

  function hasApiSessionRealtimeChange(existingSession = null, nextSession = null) {
    if (!existingSession) return true;
    return getApiSessionSyncSignature(existingSession) !== getApiSessionSyncSignature(nextSession);
  }
  window.hasApiSessionRealtimeChange = hasApiSessionRealtimeChange;

  function dedupeApiSessions(list = []) {
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach(session => {
      const normalized = buildApiSession(session);
      if (!normalized.shopId || !normalized.sessionId) return;
      const dedupKey = normalized.dedupKey || getApiSessionDedupKey(normalized);
      const existing = map.get(dedupKey);
      if (!existing) {
        map.set(dedupKey, normalized);
        return;
      }
      const existingTime = Number(existing.lastMessageTime || 0) || 0;
      const incomingTime = Number(normalized.lastMessageTime || 0) || 0;
      const primary = incomingTime >= existingTime ? normalized : existing;
      const secondary = primary === normalized ? existing : normalized;
      map.set(dedupKey, buildApiSession({
        ...secondary,
        ...primary,
        customerName: primary.customerName || secondary.customerName || '',
        customerAvatar: primary.customerAvatar || secondary.customerAvatar || '',
        lastMessage: primary.lastMessage || secondary.lastMessage || '',
        unreadCount: Math.max(Number(existing.unreadCount || 0) || 0, Number(normalized.unreadCount || 0) || 0),
        waitTime: Math.max(Number(existing.waitTime || 0) || 0, Number(normalized.waitTime || 0) || 0),
      }));
    });
    return Array.from(map.values());
  }
  window.dedupeApiSessions = dedupeApiSessions;

  function applyApiChatFollowStatus(session = null) {
    const followStatusEl = document.getElementById('apiChatFollowStatus');
    if (!followStatusEl) return;
    const followStatus = getApiConversationFollowStatus(session);
    const isVisible = followStatus.visible !== false;
    followStatusEl.hidden = !isVisible;
    followStatusEl.style.display = isVisible ? '' : 'none';
    followStatusEl.textContent = followStatus.text || '';
    followStatusEl.classList.toggle('is-unread', !!followStatus.highlighted);
  }

  function resetApiSideOrderStore() {
    window.closeApiSmallPaymentModal?.({ silent: true });
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
    apiSideOrderPriceState = {
      ...apiSideOrderPriceState,
      visible: false,
      saving: false,
      orderKey: '',
      orderId: '',
      originalAmount: 0,
      discount: '',
      amount: '',
      error: '',
      previewAmount: 0,
      hasChange: false,
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
      personal: '近90天无订单，更早订单请在管理后台查看',
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

  function normalizeApiSideOrderDecimalInput(value = '', decimals = 2) {
    const raw = String(value ?? '').replace(/[^\d.]/g, '');
    if (!raw) return '';
    const dotIndex = raw.indexOf('.');
    if (dotIndex === -1) return raw;
    const integer = raw.slice(0, dotIndex) || '0';
    const decimal = raw.slice(dotIndex + 1).replace(/\./g, '').slice(0, decimals);
    return `${integer}.${decimal}`;
  }

  function formatApiSideOrderMoneyNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return numeric.toFixed(2);
  }

  function formatApiSideOrderDiscountNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return numeric.toFixed(2).replace(/\.?0+$/, '');
  }

  function parseApiSideOrderMoneyValue(value = '') {
    const numeric = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(numeric)) return 0;
    return numeric;
  }

  function formatApiSideOrderSummaryMoney(value = 0, { negative = false } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return negative ? '-¥0.00' : '¥0.00';
    const normalized = Math.max(0, numeric);
    return `${negative ? '-' : ''}¥${normalized.toFixed(2)}`;
  }

  function buildApiSideOrderPriceMetrics(payload = {}) {
    const originalAmount = Math.max(0, Number(payload.originalAmount) || 0);
    const shippingFee = Math.max(0, Number(payload.shippingFee) || 0);
    const source = payload.source === 'amount' ? 'amount' : 'discount';
    let discount = normalizeApiSideOrderDecimalInput(payload.discount, 2);
    let amount = normalizeApiSideOrderDecimalInput(payload.amount, 2);
    if (source === 'discount') {
      const discountValue = Number(discount);
      if (discount && Number.isFinite(discountValue)) {
        const boundedDiscount = Math.min(discountValue, API_SIDE_ORDER_PRICE_MAX_DISCOUNT);
        discount = boundedDiscount === discountValue
          ? discount
          : formatApiSideOrderDiscountNumber(boundedDiscount);
        amount = formatApiSideOrderMoneyNumber(originalAmount * (1 - boundedDiscount / 10));
      } else {
        amount = '';
      }
    } else {
      const amountValue = Number(amount);
      if (amount && Number.isFinite(amountValue) && originalAmount > 0) {
        const boundedAmount = Math.min(Math.max(amountValue, 0), originalAmount);
        amount = formatApiSideOrderMoneyNumber(boundedAmount);
        const discountValue = (1 - boundedAmount / originalAmount) * 10;
        discount = formatApiSideOrderDiscountNumber(discountValue);
      } else {
        discount = '';
      }
    }
    const discountValue = Number(discount);
    const amountValue = Number(amount);
    const hasDiscount = discount !== '' && Number.isFinite(discountValue);
    const hasAmount = amount !== '' && Number.isFinite(amountValue);
    const invalidDiscount = hasDiscount && discountValue <= API_SIDE_ORDER_PRICE_MIN_DISCOUNT;
    const previewAmount = hasAmount
      ? Math.max(0, originalAmount - amountValue + shippingFee)
      : Math.max(0, originalAmount + shippingFee);
    return {
      discount,
      amount,
      error: invalidDiscount ? API_SIDE_ORDER_PRICE_ERROR_TEXT : '',
      previewAmount,
      hasChange: hasAmount && amountValue > 0,
    };
  }

  function getApiSideOrderPriceBaseAmount(order = {}) {
    const savedBaseAmount = Number(order?.manualPriceOriginalAmount);
    if (order?.manualPriceApplied && Number.isFinite(savedBaseAmount) && savedBaseAmount > 0) {
      return savedBaseAmount;
    }
    return Math.max(0, parseApiSideOrderMoneyValue(order?.amountText));
  }

  function closeApiSideOrderPriceEditor() {
    apiSideOrderPriceState = {
      ...apiSideOrderPriceState,
      visible: false,
      saving: false,
      orderKey: '',
      orderId: '',
      originalAmount: 0,
      discount: '',
      amount: '',
      error: '',
      previewAmount: 0,
      hasChange: false,
    };
  }

  function getApiSideOrderSummaryConfig(order = {}) {
    const rows = Array.isArray(order?.summaryRows) ? order.summaryRows : [];
    let receiveIndex = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]?.tone === 'danger') {
        receiveIndex = index;
        break;
      }
    }
    const normalRows = receiveIndex >= 0 ? rows.slice(0, receiveIndex) : rows;
    const receiveRow = receiveIndex >= 0
      ? rows[receiveIndex]
      : {
          label: '实收',
          value: formatApiSideOrderSummaryMoney(getApiSideOrderPriceBaseAmount(order)),
          tone: 'danger',
        };
    return {
      normalRows,
      receiveRow,
    };
  }

  function renderApiSideOrderSummaryRow(row = {}) {
    return `
      <div class="api-side-order-card-summary-row${row?.tone === 'danger' ? ' is-danger' : ''}">
        <span>${esc(row?.label || '')}</span>
        <strong>${esc(row?.value || '')}</strong>
      </div>
    `;
  }

  function renderApiSideOrderPriceEditor(order = {}) {
    const isVisible = apiSideOrderPriceState.visible && String(apiSideOrderPriceState.orderKey || '') === String(order?.key || '');
    if (!isVisible) return '';
    const state = apiSideOrderPriceState;
    const tipHtml = `<div class="api-side-order-price-error${state.error ? ' is-danger' : ''}" data-api-side-price-error="1">${esc(API_SIDE_ORDER_PRICE_ERROR_TEXT)}</div>`;
    return `
      <div class="api-side-order-price-editor" data-api-side-price-editor="1">
        <div class="api-side-order-card-summary-row api-side-order-card-summary-row--edit">
          <span>手工改价</span>
          <div class="api-side-order-price-formula">
            <input
              type="text"
              class="api-side-order-price-input is-discount"
              value="${esc(state.discount)}"
              inputmode="decimal"
              placeholder="0"
              ${state.saving ? 'disabled' : ''}
              data-api-side-price-discount="1"
            >
            <span class="api-side-order-price-unit">折</span>
            <span class="api-side-order-price-equal">=</span>
            <span class="api-side-order-price-prefix">-</span>
            <input
              type="text"
              class="api-side-order-price-input is-amount"
              value="${esc(state.amount)}"
              inputmode="decimal"
              placeholder="0.00"
              ${state.saving ? 'disabled' : ''}
              data-api-side-price-amount="1"
            >
            <span class="api-side-order-price-unit">元</span>
          </div>
        </div>
        ${tipHtml}
        <div class="api-side-order-card-summary-row api-side-order-card-summary-row--edit">
          <span>配送费用</span>
          <div class="api-side-order-price-shipping">
            <span class="api-side-order-price-prefix">¥</span>
            <input
              type="text"
              class="api-side-order-price-input is-disabled"
              value="${esc(formatApiSideOrderMoneyNumber(state.shippingFee))}"
              disabled
              data-api-side-price-shipping="1"
            >
          </div>
        </div>
      </div>
    `;
  }

  function renderApiSideOrderPriceActions(order = {}) {
    const isVisible = apiSideOrderPriceState.visible && String(apiSideOrderPriceState.orderKey || '') === String(order?.key || '');
    if (!isVisible) return '';
    return `
      <div class="api-side-order-price-actions">
        <button type="button" class="api-side-order-remark-btn is-primary is-compact" data-api-side-price-save="1" ${apiSideOrderPriceState.saving || apiSideOrderPriceState.error || !apiSideOrderPriceState.hasChange ? 'disabled' : ''}>${apiSideOrderPriceState.saving ? '保存中...' : '保存'}</button>
        <button type="button" class="api-side-order-remark-btn is-compact" data-api-side-price-cancel="1" ${apiSideOrderPriceState.saving ? 'disabled' : ''}>取消</button>
      </div>
    `;
  }

  function renderApiSideOrderPriceSummary(order = {}) {
    const { normalRows, receiveRow } = getApiSideOrderSummaryConfig(order);
    const baseAmount = getApiSideOrderPriceBaseAmount(order);
    const savedDiscountAmount = Number(order?.manualPriceDiscountAmount);
    const savedShippingFee = Math.max(0, Number(order?.manualPriceShippingFee) || 0);
    const isEditing = apiSideOrderPriceState.visible && String(apiSideOrderPriceState.orderKey || '') === String(order?.key || '');
    const receiveValue = isEditing
      ? String(receiveRow?.value || '')
      : (order?.manualPriceApplied
        ? formatApiSideOrderSummaryMoney(baseAmount - (Number.isFinite(savedDiscountAmount) ? Math.max(0, savedDiscountAmount) : 0) + savedShippingFee)
        : String(receiveRow?.value || ''));
    const parts = normalRows.map(renderApiSideOrderSummaryRow);
    if (isEditing) {
      parts.push(renderApiSideOrderPriceEditor(order));
    } else if (order?.manualPriceApplied) {
      parts.push(renderApiSideOrderSummaryRow({
        label: '手工改价',
        value: `${esc(formatApiSideOrderDiscountNumber(order?.manualPriceDiscount || 0))}折 = ${esc(formatApiSideOrderSummaryMoney(savedDiscountAmount, { negative: true }))}`,
      }));
      parts.push(renderApiSideOrderSummaryRow({
        label: '配送费用',
        value: formatApiSideOrderSummaryMoney(savedShippingFee),
      }));
    }
    parts.push(`
      <div class="api-side-order-card-summary-row is-danger">
        <span>${esc(receiveRow?.label || '实收')}</span>
        <strong data-api-side-price-receive="1">${esc(receiveValue || '¥0.00')}</strong>
      </div>
    `);
    return `<div class="api-side-order-card-summary">${parts.join('')}</div>`;
  }

  function syncApiSideOrderPriceEditorDom(orderKey = '') {
    const normalizedOrderKey = String(orderKey || '');
    if (!normalizedOrderKey || !apiSideOrderPriceState.visible || apiSideOrderPriceState.orderKey !== normalizedOrderKey) return;
    const cardEl = document.querySelector(`.api-side-order-card[data-api-side-order-key="${CSS.escape(normalizedOrderKey)}"]`);
    if (!cardEl) return;
    const discountInput = cardEl.querySelector('[data-api-side-price-discount]');
    const amountInput = cardEl.querySelector('[data-api-side-price-amount]');
    const errorEl = cardEl.querySelector('[data-api-side-price-error]');
    const saveButton = cardEl.querySelector('[data-api-side-price-save]');
    if (discountInput) discountInput.value = apiSideOrderPriceState.discount;
    if (amountInput) amountInput.value = apiSideOrderPriceState.amount;
    if (errorEl) {
      errorEl.textContent = API_SIDE_ORDER_PRICE_ERROR_TEXT;
      errorEl.classList.toggle('is-danger', !!apiSideOrderPriceState.error);
    }
    if (saveButton) {
      saveButton.disabled = !!apiSideOrderPriceState.saving || !!apiSideOrderPriceState.error || !apiSideOrderPriceState.hasChange;
    }
  }

  function setApiSideOrderPriceValue(source = 'discount', rawValue = '') {
    if (!apiSideOrderPriceState.visible || !apiSideOrderPriceState.orderKey) return;
    const nextState = buildApiSideOrderPriceMetrics({
      originalAmount: apiSideOrderPriceState.originalAmount,
      shippingFee: apiSideOrderPriceState.shippingFee,
      discount: source === 'discount' ? rawValue : apiSideOrderPriceState.discount,
      amount: source === 'amount' ? rawValue : apiSideOrderPriceState.amount,
      source,
    });
    apiSideOrderPriceState = {
      ...apiSideOrderPriceState,
      ...nextState,
    };
    syncApiSideOrderPriceEditorDom(apiSideOrderPriceState.orderKey);
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

  function buildApiSideOrderAddressCopyText(order = {}) {
    const fullText = String(order?.addressFullText || '').trim();
    if (fullText) return fullText;
    const receiverName = String(order?.receiverName || '').trim();
    const receiverPhone = String(order?.receiverPhone || '').trim();
    const addressText = String(order?.addressText || '').trim();
    return [
      receiverName ? `收货人：${receiverName}` : '',
      receiverPhone ? `联系电话：${receiverPhone}` : '',
      addressText ? `收货地址：${addressText}` : '',
    ].filter(Boolean).join('\n');
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

  function isApiSideOrderPendingLike(order = {}) {
    const mergedStatusText = [
      order?.headline,
      order?.orderStatusText,
      order?.shippingStatusText,
      order?.shippingState,
    ].filter(Boolean).join(' ').replace(/\s+/g, '');
    return /(待支付|待付款|未支付|未付款|付款中|待成团|未成团)/.test(mergedStatusText);
  }

  function renderApiSideOrderCard(order = {}, tab = 'personal') {
    const actionTags = Array.isArray(order?.actionTags) ? order.actionTags : [];
    const visibleActionTags = (tab === 'pending' || (tab === 'personal' && isApiSideOrderPendingLike(order)))
      ? actionTags.filter(tag => ['备注', '改价'].includes(String(tag || '').trim()))
      : actionTags;
    const metaRowsHtml = buildApiSideOrderMetaRows(order?.metaRows || []);
    const summaryRowsHtml = renderApiSideOrderPriceSummary(order);
    const isPriceEditing = apiSideOrderPriceState.visible && String(apiSideOrderPriceState.orderKey || '') === String(order?.key || '');
    const countdownHtml = order?.countdownEndTime
      ? `<span class="api-side-order-card-countdown" data-api-side-countdown-end="${esc(order.countdownEndTime)}">${esc(order?.countdownText || '')}</span>`
      : '';
    const actionTagsHtml = !isPriceEditing && visibleActionTags.length
      ? `<div class="api-side-order-card-actions">${visibleActionTags.map(tag => {
          const label = String(tag || '').trim();
          if (label === '地址') {
            return `<button type="button" class="api-side-order-card-action is-button" data-api-side-action="address" data-api-side-order-key="${esc(order?.key || '')}">${esc(label)}</button>`;
          }
          if (label === '备注') {
            return `<button type="button" class="api-side-order-card-action is-button" data-api-side-action="remark" data-api-side-order-key="${esc(order?.key || '')}">${esc(label)}</button>`;
          }
          if (label === '小额打款') {
            return `<button type="button" class="api-side-order-card-action is-button" data-api-side-action="small-payment" data-api-side-order-key="${esc(order?.key || '')}">${esc(label)}</button>`;
          }
          if (label === '改价' && !order?.manualPriceApplied) {
            return `<button type="button" class="api-side-order-card-action is-button" data-api-side-action="price" data-api-side-order-key="${esc(order?.key || '')}">${esc(label)}</button>`;
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
        ${summaryRowsHtml}
        ${renderApiSideOrderRemarkSummary(order)}
        ${renderApiSideOrderPriceActions(order)}
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
    const showEmpty = (text) => {
      listEl.style.display = 'none';
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = text;
    };
    const showList = (html) => {
      listEl.style.display = 'flex';
      emptyEl.style.display = 'none';
      listEl.innerHTML = html;
    };
    const state = getState();
    const tab = String(state.apiSideTab || 'personal');
    if (tab === 'sync') {
      listEl.innerHTML = '';
      return;
    }
    ensureApiSideOrderSessionScope();
    const session = getApiSideOrderSession();
    if (!session) {
      showEmpty('请先选择一个接口会话');
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
      entry.loading = false;
      entry.error = '';
      if (!entry.items.length) {
        showEmpty('侧栏订单与退款信息已暂停自动加载，请先稳定查看消息。');
        return;
      }
    }
    if (entry.loading && !entry.items.length) {
      showEmpty(getApiSideOrderLoadingText(tab));
      return;
    }
    if (entry.error && !entry.items.length) {
      showEmpty(entry.error);
      return;
    }
    if (!entry.items.length) {
      showEmpty(getApiSideOrderEmptyText(tab));
      return;
    }
    showList(entry.items.map(item => renderApiSideOrderCard(item, tab)).join(''));
    syncApiSideOrderCountdowns();
  }

  async function openApiSideOrderRemark(orderKey = '') {
    const order = getApiSideOrderItem(orderKey);
    if (!order) {
      showApiSideOrderToast('未找到对应订单');
      return;
    }
    closeApiSideOrderPriceEditor();
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

  function applyApiSideOrderPrice(orderId = '', payload = {}) {
    const normalizedOrderId = String(orderId || '').trim();
    if (!normalizedOrderId) return;
    Object.values(apiSideOrderStore).forEach(entry => {
      entry.items = (Array.isArray(entry.items) ? entry.items : []).map(item => {
        if (String(item?.orderId || '').trim() !== normalizedOrderId) return item;
        const actionTags = Array.isArray(item?.actionTags) ? item.actionTags.filter(tag => String(tag || '').trim() !== '改价') : [];
        return {
          ...item,
          manualPriceApplied: true,
          manualPriceOriginalAmount: Number(payload.originalAmount) || 0,
          manualPriceDiscount: Number(payload.discount) || 0,
          manualPriceDiscountAmount: Number(payload.discountAmount ?? payload.amount) || 0,
          manualPriceShippingFee: Math.max(0, Number(payload.shippingFee) || 0),
          amountText: formatApiSideOrderSummaryMoney(Number(payload.receiveAmount) || 0),
          actionTags,
        };
      });
    });
  }

  function replaceApiSideOrderItem(orderId = '', nextOrder = null) {
    const normalizedOrderId = String(orderId || '').trim();
    if (!normalizedOrderId || !nextOrder || typeof nextOrder !== 'object') return false;
    let replaced = false;
    Object.values(apiSideOrderStore).forEach(entry => {
      entry.items = (Array.isArray(entry.items) ? entry.items : []).map(item => {
        if (String(item?.orderId || '').trim() !== normalizedOrderId) return item;
        replaced = true;
        return {
          ...item,
          ...nextOrder,
          key: item?.key || nextOrder?.key || item?.orderId || normalizedOrderId,
        };
      });
    });
    return replaced;
  }

  function openApiSideOrderPrice(orderKey = '') {
    const order = getApiSideOrderItem(orderKey);
    if (!order) {
      showApiSideOrderToast('未找到对应订单');
      return;
    }
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
    if (apiSideOrderPriceState.visible && apiSideOrderPriceState.orderKey === orderKey) {
      closeApiSideOrderPriceEditor();
      renderApiSideOrders();
      return;
    }
    const originalAmount = getApiSideOrderPriceBaseAmount(order);
    const hasSavedAmount = !!order?.manualPriceApplied;
    const initialDiscount = hasSavedAmount ? order?.manualPriceDiscount : '9.5';
    const nextState = buildApiSideOrderPriceMetrics({
      originalAmount,
      shippingFee: 0,
      discount: initialDiscount,
      amount: hasSavedAmount ? order?.manualPriceDiscountAmount : '',
      source: hasSavedAmount ? 'amount' : 'discount',
    });
    apiSideOrderPriceState = {
      ...apiSideOrderPriceState,
      visible: true,
      saving: false,
      orderKey: String(order.key || ''),
      orderId: String(order.orderId || ''),
      originalAmount,
      shippingFee: 0,
      ...nextState,
    };
    renderApiSideOrders();
  }

  async function saveApiSideOrderPrice() {
    const state = getState();
    const order = getApiSideOrderItem(apiSideOrderPriceState.orderKey);
    if (!order) {
      showApiSideOrderToast('未找到对应订单');
      return;
    }
    if (!window.pddApi?.apiUpdateOrderPrice) {
      showApiSideOrderToast('当前版本尚未提供改价接口');
      return;
    }
    if (apiSideOrderPriceState.error || !apiSideOrderPriceState.hasChange) {
      showApiSideOrderToast(apiSideOrderPriceState.error || '请先输入有效改价信息');
      return;
    }
    apiSideOrderPriceState = {
      ...apiSideOrderPriceState,
      saving: true,
      error: '',
    };
    renderApiSideOrders();
    try {
      const result = await window.pddApi.apiUpdateOrderPrice({
        shopId: state.apiActiveSessionShopId,
        sessionId: state.apiActiveSessionId,
        session: getApiSideOrderSession(),
        tab: state.apiSideTab || 'pending',
        orderSn: order.orderId,
        discount: Number(apiSideOrderPriceState.discount),
        amount: Number(apiSideOrderPriceState.amount),
        originalAmount: Number(apiSideOrderPriceState.originalAmount),
        shippingFee: Number(apiSideOrderPriceState.shippingFee),
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      const replaced = replaceApiSideOrderItem(order.orderId, result?.verifiedCard);
      if (!replaced) {
        applyApiSideOrderPrice(order.orderId, {
          originalAmount: result?.originalAmount ?? apiSideOrderPriceState.originalAmount,
          shippingFee: result?.shippingFee ?? apiSideOrderPriceState.shippingFee,
          discount: result?.discount ?? apiSideOrderPriceState.discount,
          discountAmount: result?.discountAmount ?? apiSideOrderPriceState.amount,
          receiveAmount: result?.receiveAmount ?? apiSideOrderPriceState.previewAmount,
        });
      }
      const currentEntry = getApiSideOrderEntry(state.apiSideTab || 'pending');
      currentEntry.stale = true;
      closeApiSideOrderPriceEditor();
      renderApiSideOrders();
      showApiSideOrderToast('改价保存成功');
    } catch (error) {
      showApiSideOrderToast(error?.message || '改价保存失败');
      apiSideOrderPriceState = {
        ...apiSideOrderPriceState,
        saving: false,
      };
      renderApiSideOrders();
    }
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
    if (textarea) {
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
      return;
    }
    const discountInput = event.target.closest('[data-api-side-price-discount]');
    if (discountInput) {
      setApiSideOrderPriceValue('discount', discountInput.value);
      return;
    }
    const amountInput = event.target.closest('[data-api-side-price-amount]');
    if (amountInput) {
      setApiSideOrderPriceValue('amount', amountInput.value);
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
    const addressTrigger = event.target.closest('[data-api-side-action="address"]');
    if (addressTrigger) {
      const order = getApiSideOrderItem(addressTrigger.dataset.apiSideOrderKey || '');
      if (!order) {
        showApiSideOrderToast('未找到对应订单');
        return;
      }
      const text = buildApiSideOrderAddressCopyText(order);
      if (!text) {
        showApiSideOrderToast('暂无地址信息');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        showApiSideOrderToast('地址已复制');
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
    const smallPaymentTrigger = event.target.closest('[data-api-side-action="small-payment"]');
    if (smallPaymentTrigger) {
      window.openApiSmallPaymentModal?.(smallPaymentTrigger.dataset.apiSideOrderKey || '');
      return;
    }
    const priceTrigger = event.target.closest('[data-api-side-action="price"]');
    if (priceTrigger) {
      openApiSideOrderPrice(priceTrigger.dataset.apiSideOrderKey || '');
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
      return;
    }
    if (event.target.closest('[data-api-side-price-cancel]')) {
      closeApiSideOrderPriceEditor();
      renderApiSideOrders();
      return;
    }
    if (event.target.closest('[data-api-side-price-save]')) {
      saveApiSideOrderPrice();
    }
  }

  function openApiSession(sessionId, customerName, shopId, options) {
    return callRuntime('openApiSession', sessionId, customerName, shopId, options);
  }

  function loadApiSessions(options = {}) {
    return callRuntime('loadApiSessions', options);
  }

  function findLocalApiSessionByKeyword(keyword = '') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return null;
    return getLatestApiSessionsForDisplay().find(session => {
      const orderText = String(session?.orderId || session?.orderSn || '').trim().toLowerCase();
      return orderText === normalizedKeyword
        || String(session?.sessionId || '').trim().toLowerCase() === normalizedKeyword
        || String(session?.customerId || '').trim().toLowerCase() === normalizedKeyword
        || String(session?.customerName || '').trim().toLowerCase().includes(normalizedKeyword);
    }) || null;
  }

  function prependApiSearchSession(session = {}) {
    const shopId = String(session?.shopId || '').trim();
    const sessionId = String(session?.sessionId || '').trim();
    if (!shopId || !sessionId) return;
    const state = getState();
    const preservedSessions = Array.isArray(state.apiSessions)
      ? state.apiSessions.filter(item => !(String(item?.shopId || '') === shopId && String(item?.sessionId || '') === sessionId))
      : [];
    mergeApiSessionsForShop(shopId, [session, ...preservedSessions.filter(item => String(item?.shopId || '') === shopId)]);
    setApiPinnedSearchSession(session);
  }

  async function handleApiSessionSearchSubmit() {
    const state = getState();
    const rawKeyword = String(state.apiSessionKeyword || '').trim();
    const normalizedKeyword = rawKeyword.toLowerCase();
    if (!rawKeyword) {
      setApiHint('请输入订单号、客户名或会话关键词');
      return;
    }
    const localTarget = findLocalApiSessionByKeyword(rawKeyword);
    if (localTarget) {
      setApiPinnedSearchSession(localTarget);
      setApiSessionTab('latest');
      await openApiSession(localTarget.sessionId, localTarget.customerName, localTarget.shopId);
      setApiHint(`已定位会话：${localTarget.customerName || localTarget.customerId || localTarget.sessionId}`);
      return;
    }
    const result = await window.pddApi.apiFindSessionByOrderSn({
      shopId: state.API_ALL_SHOPS,
      orderSn: rawKeyword,
      pageSize: 50,
      pageLimit: 4,
    });
    if (!result?.sessionId) {
      if (result?.error) {
        setApiHint(result.error);
        return;
      }
      setApiHint(normalizedKeyword ? '未查询到相关会话！' : '请输入订单号');
      return;
    }
    prependApiSearchSession(result);
    setApiSessionTab('latest');
    await openApiSession(result.sessionId, result.customerName, result.shopId, {
      forceRefresh: true,
    });
    setApiHint(`已按订单号打开会话：${result.customerName || result.customerId || result.sessionId}`);
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

  function getApiSessionGroupNumber(session = {}) {
    const rawValue = session.groupNumber
      ?? session.group_number
      ?? session.raw?.groupNumber
      ?? session.raw?.group_number;
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }

  function getApiSessionGenderValue(session = {}) {
    const candidates = [
      session.gender,
      session.raw?.gender,
      session.sex,
      session.raw?.sex,
      session.raw?.buyer_gender,
      session.raw?.buyerGender,
      session.raw?.buyer_sex,
      session.raw?.buyerSex,
      session.raw?.user_info?.gender,
      session.raw?.user_info?.sex,
      session.raw?.user_info?.buyer_gender,
      session.raw?.user_info?.buyerGender,
      session.raw?.user_info?.buyer_sex,
      session.raw?.user_info?.buyerSex,
    ];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || candidate === '') continue;
      const normalized = String(candidate).trim().toLowerCase();
      if (normalized === '0' || normalized === 'female' || normalized === 'woman' || normalized === 'girl' || normalized === '女') {
        return 'female';
      }
      if (normalized === '1' || normalized === 'male' || normalized === 'man' || normalized === 'boy' || normalized === '男') {
        return 'male';
      }
    }
    return 'unknown';
  }

  function applyApiConversationMeta(session = null) {
    const orderCountEl = document.getElementById('apiChatOrderCount');
    const genderEl = document.getElementById('apiChatGender');
    if (orderCountEl) {
      const orderCount = session ? Math.max(0, getApiSessionGroupNumber(session)) : 0;
      if (orderCount > 1) {
        orderCountEl.textContent = `下单数 ${orderCount}`;
        orderCountEl.hidden = false;
      } else {
        orderCountEl.hidden = true;
      }
    }
    if (!genderEl) return;
    const genderValue = session ? getApiSessionGenderValue(session) : 'unknown';
    genderEl.classList.remove('is-female', 'is-male', 'is-unknown');
    if (genderValue === 'female') {
      genderEl.textContent = '女';
      genderEl.classList.add('is-female');
      genderEl.hidden = false;
      return;
    }
    if (genderValue === 'male') {
      genderEl.textContent = '男';
      genderEl.classList.add('is-male');
      genderEl.hidden = false;
      return;
    }
    genderEl.hidden = true;
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
    const result = callRuntime('appendApiLocalServiceMessage', payload);
    renderApiMessages();
    return result;
  }

  function refreshApiAfterMessageSent(payload = {}) {
    return callRuntime('refreshApiAfterMessageSent', payload);
  }

  function applyApiReadMarkUpdate(payload = {}) {
    return callRuntime('applyApiReadMarkUpdate', payload);
  }

  function mergeApiSessionsForShop(shopId, sessions = []) {
    return callRuntime('mergeApiSessionsForShop', shopId, sessions);
  }

  function upsertApiSession(session = {}) {
    return callRuntime('upsertApiSession', session);
  }

  function setApiPinnedSearchSession(session = null) {
    return callRuntime('setApiPinnedSearchSession', session);
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

  function pickApiDisplayAfterSalesStatus(sources = []) {
    const descKeys = [
      'afterSalesStatusDesc',
      'after_sales_status_desc',
      'aftersaleStatusDesc',
      'aftersale_status_desc',
    ];
    const statusKeys = [
      'afterSalesStatus',
      'after_sales_status',
    ];
    function mapAfterSalesStatusCodeToText(value) {
      const code = String(value || '').trim();
      if (!code || !/^\d+$/.test(code)) return '';
      const map = {
        '0': '无售后',
        '2': '买家申请退款，待商家处理',
        '3': '退货退款，待商家处理',
        '4': '商家同意退款，退款中',
        '5': '未发货，退款成功',
        '6': '驳回退款，待用户处理',
        '7': '已同意退货退款,待用户发货',
        '8': '平台处理中',
        '9': '平台拒绝退款，退款关闭',
        '10': '已发货，退款成功',
        '11': '买家撤销',
        '12': '买家逾期未处理，退款失败',
        '13': '部分退款成功',
        '14': '商家拒绝退款，退款关闭',
        '15': '退货完成，待退款',
        '16': '换货补寄成功',
        '17': '换货补寄失败',
        '18': '换货补寄待用户确认完成',
        '21': '待商家同意维修',
        '22': '待用户确认发货',
        '24': '维修关闭',
        '25': '维修成功',
        '27': '待用户确认收货',
        '31': '已同意拒收退款，待用户拒收',
        '32': '补寄待商家发货',
      };
      return map[code] || '';
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const descText = pickApiRefundText([source], descKeys);
      if (descText) return descText;
      const hasAfterSalesContext = descKeys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '')
        || statusKeys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '');
      if (!hasAfterSalesContext) continue;
      const scopedText = pickApiRefundText([source], ['statusDesc', 'status_desc', 'label', 'desc']);
      if (scopedText && !/^\d+$/.test(scopedText)) return scopedText;
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const statusText = pickApiRefundText([source], statusKeys);
      if (statusText && !/^\d+$/.test(statusText)) return statusText;
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const statusCode = pickApiRefundText([source], statusKeys);
      const mappedText = mapAfterSalesStatusCodeToText(statusCode);
      if (mappedText) return mappedText;
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

  function resolveApiRefundOrderStatusText(sources = []) {
    return pickApiRefundText(sources, [
      'orderStatusStr',
      'order_status_str',
      'order_status_desc',
      'order_status_text',
      'order_status_name',
      'order_status',
      'statusDesc',
      'status_desc',
      'statusText',
      'status_text',
      'shippingStatusText',
      'shipping_status_text',
      'shippingStatus',
      'shipping_status',
      'payStatusDesc',
      'pay_status_desc',
      'payStatusText',
      'pay_status_text',
    ]);
  }

  // isApiRefundOrderEligible / filterEligibleApiRefundOrders 仅退款 modal 自身使用，
  // 已随 modal 一起迁出至 src/renderer/chat-api/modules/refund-modal.js

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

  // 退款 modal 已迁出至 src/renderer/chat-api/modules/refund-modal.js
  // 这里保留 getApiRefundMaxAmountInputValue / clampApiRefundAmountInputValue 供
  // 渲染层与 modal 共用，但默认 context 改为 null（modal 内的调用都会显式传入 context）
  function getApiRefundMaxAmountInputValue(context = null) {
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

  function getApiRefundCardTitle(type = 'refund') {
    if (type === 'returnRefund') return '商家想帮您申请退货退款';
    if (type === 'resend') return '商家想帮您申请补寄';
    return '商家想帮您申请快捷退款';
  }

  function normalizeApiRefundCardAmountText(value) {
    if (value === undefined || value === null || value === '') return '';
    const text = String(value).trim();
    if (!text) return '';
    if (/^¥/.test(text)) return text.replace(/^¥\s+/, '¥');
    const numericText = text.replace(/[^\d.-]/g, '');
    if (/^\d+$/.test(numericText)) {
      const fenValue = Number(numericText);
      if (Number.isFinite(fenValue) && fenValue > 0) {
        return `¥${(fenValue / 100).toFixed(2)}`;
      }
    }
    const numeric = Number(numericText);
    if (Number.isFinite(numeric) && numeric > 0) {
      return `¥${numeric.toFixed(2)}`;
    }
    const amountText = normalizeApiRefundAmountText(value);
    return amountText.replace(/^¥\s+/, '¥');
  }

  function resolveApiRefundCardFooterText(state = {}, fallbackText = '') {
    const statusValue = Number(state?.status);
    const normalizedFallback = String(
      fallbackText
      || state?.text
      || state?.desc
      || state?.label
      || state?.expire_text
      || ''
    ).trim();
    if (normalizedFallback && normalizedFallback !== '已过期') {
      return normalizedFallback;
    }
    if (statusValue === 2) return '消费者已同意';
    if (statusValue === 3) return '消费者已拒绝';
    if (statusValue === 0 || statusValue === 1) {
      return '等待消费者确认';
    }
    return normalizedFallback || '等待消费者确认';
  }

  function resolveApiRefundStatusFooterText(kind = '', displayText = '', fallbackText = '') {
    const normalizedFallback = String(fallbackText || '').trim();
    const normalizedDisplay = String(displayText || '').trim();
    if (normalizedFallback) return normalizedFallback;
    if (kind === 'refund-pending') return '消费者已同意';
    if (kind === 'refund-rejected') return normalizedDisplay || '消费者已拒绝';
    if (kind === 'refund-success') return normalizedDisplay || '退款成功';
    return normalizedDisplay;
  }

  function normalizeApiSystemComparableText(text = '') {
    return String(text || '')
      .trim()
      .replace(/^[\[【]\s*/, '')
      .replace(/\s*[\]】]$/, '')
      .trim();
  }

  function isApiRefundPendingNoticeText(text = '') {
    return normalizeApiSystemComparableText(text) === '消费者已同意您发起的退款申请，请及时处理';
  }

  function isApiRefundSuccessNoticeText(text = '') {
    const normalized = normalizeApiSystemComparableText(text);
    return normalized === '退款成功通知' || normalized === '退款成功';
  }

  function getApiRefundStatusUpdateMeta(message = {}) {
    const directMeta = message?.refundStatusUpdate && typeof message.refundStatusUpdate === 'object'
      ? message.refundStatusUpdate
      : null;
    if (directMeta) {
      const kind = String(directMeta.kind || '').trim();
      if (kind) {
        const displayText = String(directMeta.displayText || '').trim();
        const footerText = resolveApiRefundStatusFooterText(
          kind,
          displayText,
          directMeta.footerText
        );
        return {
          kind,
          targetMessageId: String(directMeta.targetMessageId || '').trim(),
          status: Number(directMeta.status ?? ''),
          displayText,
          footerText,
        };
      }
    }
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const data = raw?.data && typeof raw.data === 'object' ? raw.data : {};
    const messageType = Number(raw?.type ?? message?.type ?? -1);
    if (messageType === 90) {
      const targetMessageId = String(data?.msg_id || '').trim();
      const statusValue = Number(data?.status);
      const statusText = String(data?.text || '').trim();
      if (targetMessageId && statusValue === 2) {
        return {
          kind: 'refund-pending',
          targetMessageId,
          status: statusValue,
          displayText: '消费者已同意您发起的退款申请，请及时处理',
          footerText: resolveApiRefundStatusFooterText('refund-pending', '消费者已同意您发起的退款申请，请及时处理', statusText),
        };
      }
      if (targetMessageId && statusValue === 3) {
        return {
          kind: 'refund-rejected',
          targetMessageId,
          status: statusValue,
          displayText: statusText || '消费者已拒绝',
          footerText: resolveApiRefundStatusFooterText('refund-rejected', statusText || '消费者已拒绝', statusText),
        };
      }
    }
    const source = getApiSystemNoticeText(message) || String(message?.content || raw?.content || '').trim();
    if (isApiRefundPendingNoticeText(source)) {
      return {
        kind: 'refund-pending',
        targetMessageId: '',
        status: 2,
        displayText: '消费者已同意您发起的退款申请，请及时处理',
        footerText: '消费者已同意',
      };
    }
    if (isApiRefundSuccessNoticeText(source)) {
      return {
        kind: 'refund-success',
        targetMessageId: '',
        status: 3,
        displayText: '退款成功',
        footerText: '退款成功',
      };
    }
    return null;
  }

  function extractApiStructuredNoticeEntryText(entry = {}) {
    if (!entry || typeof entry !== 'object') return '';
    return String(
      entry?.text
      || entry?.content
      || entry?.message
      || entry?.msg
      || entry?.title
      || entry?.label
      || entry?.name
      || entry?.desc
      || entry?.value
      || ''
    ).trim();
  }

  function getApiSystemNoticeText(messageOrText = '') {
    if (typeof messageOrText === 'string') return messageOrText.trim();
    const raw = messageOrText?.raw && typeof messageOrText.raw === 'object' ? messageOrText.raw : {};
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    const directText = [
      messageOrText?.content,
      raw?.content,
      raw?.msg_content,
      raw?.text,
      raw?.message,
      info?.mall_content,
      info?.merchant_content,
      info?.content,
      info?.text,
      info?.title,
      info?.label,
      info?.desc,
      info?.tip,
      info?.message,
      messageOrText?.extra?.text,
      raw?.extra?.text,
      raw?.ext?.text,
    ].filter(Boolean).map(item => String(item || '').trim()).find(Boolean);
    if (directText) return directText;
    const entryLists = [
      Array.isArray(info?.item_content) ? info.item_content : [],
      Array.isArray(info?.mall_item_content) ? info.mall_item_content : [],
      Array.isArray(info?.items) ? info.items : [],
    ];
    for (const list of entryLists) {
      const entryText = list.map(entry => extractApiStructuredNoticeEntryText(entry)).filter(Boolean).join(' ').trim();
      if (entryText) return entryText;
    }
    return [
      messageOrText?.content,
      raw?.content,
      raw?.msg_content,
      raw?.text,
      raw?.message,
      info?.mall_content,
      messageOrText?.extra?.text,
      raw?.extra?.text,
      raw?.ext?.text,
    ].filter(Boolean).map(item => String(item || '').trim()).find(Boolean) || '';
  }

  function normalizeApiSystemActionText(text = '') {
    return String(text || '')
      .trim()
      .replace(/^>>\s*/, '')
      .replace(/\s*<<$/, '')
      .trim();
  }

  function isApiUnmatchedReplyNoticeMessage(message = {}) {
    return /机器人未找到对应(?:的)?回复/.test(getApiSystemNoticeText(message));
  }

  function isApiGoodsSourceNoticeMessage(message = {}) {
    const source = getApiSystemNoticeText(message);
    return /当前用户来自/.test(source) && /商品详情页/.test(source);
  }

  function debugApiGoodsSourceMessage(message = {}, session = {}, extra = {}) {
    const sourceText = getApiSystemNoticeText(message);
    if (!isApiGoodsSourceNoticeMessage(message)) return;
    const sessionKey = getApiSessionKey(session || {});
    const messageId = String(
      message?.messageId
      || message?.msgId
      || message?.msg_id
      || message?.id
      || message?.raw?.msg_id
      || message?.raw?.message_id
      || ''
    ).trim();
    const signature = [
      sessionKey,
      messageId,
      String(message?.timestamp || ''),
      sourceText,
    ].join('::');
    if (apiGoodsSourceDebugPrintedKeys.has(signature)) return;
    apiGoodsSourceDebugPrintedKeys.add(signature);
    if (apiGoodsSourceDebugPrintedKeys.size > 50) {
      const firstKey = apiGoodsSourceDebugPrintedKeys.values().next().value;
      if (firstKey) apiGoodsSourceDebugPrintedKeys.delete(firstKey);
    }
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    const infoData = info?.data && typeof info.data === 'object' ? info.data : {};
    const payload = {
      sessionKey,
      customer: String(session?.customerName || session?.displayName || '').trim(),
      sourceText,
      messageMeta: {
        messageId,
        timestamp: Number(message?.timestamp || 0) || 0,
        type: Number(raw?.type ?? message?.type ?? -1),
        templateName: String(raw?.template_name || raw?.templateName || message?.templateName || '').trim(),
        content: String(message?.content || raw?.content || raw?.msg_content || '').trim(),
      },
      goodsLinkInfo: extra?.goodsLinkInfo || null,
      resolvedCard: extra?.goodsCard || null,
      messageExtra: message?.extra || null,
      rawInfo: info,
      rawInfoData: infoData,
      rawExtra: raw?.extra || null,
      rawBizContext: raw?.biz_context || raw?.bizContext || null,
      sessionGoodsInfo: session?.goodsInfo || null,
      sessionRawGoodsInfo: session?.raw?.goods_info || null,
      sessionRawGoods: session?.raw?.goods || null,
    };
    emitRendererDebug('chat-api', 'goods-source-message-debug', payload);
    recordApiSyncState('商品来源调试', `${payload.customer || sessionKey || '未知会话'} 已输出原始数据`);
  }

  function pickApiGoodsTextWithExclusions(sources = [], keys = [], exclusions = []) {
    const isExcluded = text => {
      const normalized = String(text || '').trim();
      if (!normalized) return true;
      return exclusions.some(rule => {
        if (!rule) return false;
        if (rule instanceof RegExp) return rule.test(normalized);
        return normalized === String(rule).trim();
      });
    };
    const extractText = (value, preferredKeys = [], seen = new Set()) => {
      if (typeof value === 'string' && value.trim()) {
        return isExcluded(value) ? '' : value.trim();
      }
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (!value || typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const matched = extractText(item, preferredKeys, seen);
          if (matched) return matched;
        }
        return '';
      }
      for (const key of preferredKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const matched = extractText(value[key], preferredKeys, seen);
        if (matched) return matched;
      }
      for (const item of Object.values(value)) {
        const matched = extractText(item, preferredKeys, seen);
        if (matched) return matched;
      }
      return '';
    };
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const matched = extractText(source[key], ['title', 'name', 'text', 'content', 'url', 'src', 'imageUrl', 'image_url']);
        if (matched) return matched;
      }
    }
    return '';
  }

  function getApiRefundSystemNoticeKind(message = {}) {
    const statusMeta = getApiRefundStatusUpdateMeta(message);
    if (statusMeta?.kind && statusMeta.kind !== 'refund-rejected') return statusMeta.kind;
    const source = getApiSystemNoticeText(message);
    if (!source) return '';
    if (isApiRefundPendingNoticeText(source)) return 'refund-pending';
    if (isApiRefundSuccessNoticeText(source)) return 'refund-success';
    return '';
  }

  function getApiRefundSystemNoticeDisplayText(message = {}) {
    const statusMeta = getApiRefundStatusUpdateMeta(message);
    if (statusMeta?.displayText) return statusMeta.displayText;
    const source = getApiSystemNoticeText(message);
    const kind = getApiRefundSystemNoticeKind(message);
    if (kind === 'refund-pending') return '消费者已同意您发起的退款申请，请及时处理';
    if (kind === 'refund-success') return '退款成功';
    return source;
  }

  function isApiInviteOrderTemplateMessage(message = {}) {
    const raw = message?.raw && typeof message.raw === 'object'
      ? message.raw
      : (message && typeof message === 'object' ? message : {});
    const templateName = String(raw?.template_name || raw?.templateName || message?.template_name || message?.templateName || '').trim();
    if (templateName === 'substitute_order_v2' || templateName === 'substitute_order_v3') return true;
    if (templateName) return false;
    const messageType = Number(
      raw?.type
      ?? raw?.msg_type
      ?? raw?.message_type
      ?? raw?.content_type
      ?? message?.type
      ?? message?.msgType
      ?? -1
    );
    const sourceText = getApiSystemNoticeText({ ...message, raw });
    if (isApiRefundPendingNoticeText(sourceText) || isApiRefundSuccessNoticeText(sourceText)) {
      return false;
    }
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    const infoData = info?.data && typeof info.data === 'object' ? info.data : {};
    const goodsInfoList = [
      infoData?.goods_info_list,
      infoData?.goodsInfoList,
      infoData?.goods_list,
      infoData?.goodsList,
      info?.goods_info_list,
      info?.goodsInfoList,
      info?.goods_list,
      info?.goodsList,
    ].find(Array.isArray) || [];
    return messageType === 64 && !!(
      goodsInfoList.length
      && goodsInfoList.some(entry => entry && typeof entry === 'object')
    );
  }

  function renderApiRefundSystemNoticeCardHtml(message = {}, options = {}) {
    const kind = getApiRefundSystemNoticeKind(message);
    if (!kind) return '';
    const card = findApiMatchedRefundCard(options.sortedMessages, {
      targetMessageId: getApiRefundStatusUpdateMeta(message)?.targetMessageId,
      messageIndex: options.messageIndex,
      activeSession: options.activeSession,
    });
    const displayText = getApiRefundSystemNoticeDisplayText(message);
    if (!card) {
      if (kind === 'refund-success') {
        return `<div class="api-system-refund-card success">
          <div class="api-system-refund-card-success-head">
            <span class="api-system-refund-card-success-icon" aria-hidden="true"></span>
            <span>${esc(displayText)}</span>
          </div>
        </div>`;
      }
      return `<div class="api-system-refund-card pending">
        <div class="api-system-refund-card-header">${esc(displayText)}</div>
      </div>`;
    }
    const imageHtml = card.imageUrl
      ? `<img class="api-system-refund-card-media" src="${esc(card.imageUrl)}" alt="${esc(card.goodsTitle || '商品主图')}">`
      : `<div class="api-system-refund-card-media-placeholder">商品</div>`;
    if (kind === 'refund-success') {
      return `<div class="api-system-refund-card success">
        <div class="api-system-refund-card-success-head">
          <span class="api-system-refund-card-success-icon" aria-hidden="true"></span>
          <span>退款成功</span>
        </div>
        <div class="api-system-refund-card-goods">
          ${imageHtml}
          <div class="api-system-refund-card-main">
            <div class="api-system-refund-card-goods-title">${esc(card.goodsTitle || '订单商品')}</div>
            <div class="api-system-refund-card-success-meta">
              ${card.specText ? `<div class="api-system-refund-card-spec">${esc(card.specText)}</div>` : ''}
              <div class="api-system-refund-card-success-actual">实收：${esc(card.amountText || '--')}</div>
            </div>
          </div>
        </div>
        <div class="api-system-refund-card-success-footer">
          <div class="api-system-refund-card-success-amount">
            <span class="api-system-refund-card-success-amount-label">退款金额</span>
            <span class="api-system-refund-card-success-amount-value">${esc(card.amountText || '--')}</span>
          </div>
          <span class="api-system-refund-card-success-button">查看订单售后详情</span>
        </div>
      </div>`;
    }
    return renderApiRefundCardHtml(card, {
      headerText: displayText,
      actionButtonLabel: '去处理',
    });
  }

  function isApiSystemNoticeMessage(message = {}) {
    const source = getApiSystemNoticeText(message);
    if (isApiRefundDefaultSellerNoteText(source)) return false;
    if (extractApiRefundCard(message)) return false;
    if (isApiInviteOrderTemplateMessage(message)) return false;
    if (isApiRobotManagedMessage(message)) return false;
    if (String(message.actor || '').toLowerCase() === 'system' || message.isSystem) return true;
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const messageType = Number(raw?.type ?? message?.type ?? -1);
    if (messageType === 31 || messageType === 90) return true;
    if (String(raw?.template_name || raw?.templateName || '').trim()) return true;
    if (raw?.system && typeof raw.system === 'object' && Object.keys(raw.system).length) return true;
    if (!source) return false;
    if (isApiRefundPendingNoticeText(source) || isApiRefundSuccessNoticeText(source)) return true;
    return [
      /您接待过此消费者/,
      /机器人已暂停接待/,
      /机器人未找到对应(?:的)?回复/,
      /立即恢复接待/,
      /为避免插嘴/,
      /为避免插播/,
      /为避免抢答/,
      /当前用户来自/,
      /商品详情页/,
      /订单已超承诺发货时间/,
      /请人工跟进/,
    ].some(pattern => pattern.test(source));
  }

  function isApiRobotManagedMessage(message = {}) {
    if (!message || message.isFromBuyer) return false;
    if (message?.isRobotManaged === true) return true;
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const templateName = String(raw?.template_name || raw?.templateName || '').trim();
    const showAuto = raw?.show_auto === true || raw?.showAuto === true;
    return templateName === 'mall_robot_text_msg' || showAuto;
  }

  function isApiRefundDefaultSellerNoteText(text = '') {
    const source = String(text || '').trim();
    if (!source) return false;
    return [
      /帮您申请退款，您看可以吗.*点击下方卡片按钮/,
      /帮您申请退货退款，您看可以吗.*点击下方卡片按钮/,
      /帮您申请补寄，您看可以吗.*点击下方卡片按钮/,
    ].some(pattern => pattern.test(source));
  }

  function getApiSystemPromptContext(sortedMessages = [], messageIndex = -1) {
    const activeSession = getApiActiveSession() || {};
    const state = getState();
    const currentMessage = sortedMessages[messageIndex] || {};
    const customer = String(activeSession.customerName || activeSession.displayName || state.apiActiveSessionName || '').trim();
    const previousBuyerMessage = sortedMessages
      .slice(0, messageIndex)
      .reverse()
      .find(item => !isApiSystemNoticeMessage(item) && item.isFromBuyer && String(item.content || '').trim());
    return {
      customer,
      message: String(previousBuyerMessage?.content || '').trim(),
      systemText: getApiSystemNoticeText(currentMessage),
    };
  }

  async function handleApiSystemAction(action = '', messageIndex = -1, sortedMessages = []) {
    if (action !== 'create-rule') return;
    const state = getState();
    const context = getApiSystemPromptContext(sortedMessages, messageIndex);
    try {
      if (state.currentView !== 'qa') {
        await callRuntime('switchView', 'qa');
      }
      if (typeof window.openQAUnmatchedFromContext !== 'function') {
        setApiHint('未找到规则入口');
        return;
      }
      const result = await window.openQAUnmatchedFromContext({
        customer: context.customer,
        message: context.message,
      });
      if (result?.matched || result?.prefilled) {
        setApiHint('已打开规则编辑');
      } else {
        setApiHint('未定位到对应消息，请手动补充规则');
      }
    } catch (error) {
      setApiHint('打开规则入口失败');
      addLog(`打开规则入口失败: ${error.message || error}`, 'error');
    }
  }

  function buildApiSystemActionHtml(actionText = '', options = {}) {
    const normalized = normalizeApiSystemActionText(actionText);
    if (!normalized) return '';
    const source = getApiSystemNoticeText(options.message);
    if (
      /^点击添加$/.test(normalized)
      && /机器人未找到对应(?:的)?回复/.test(source)
      && Number.isInteger(options.messageIndex)
      && options.messageIndex >= 0
    ) {
      return `<button class="api-message-system-action api-message-system-action-button" type="button" data-system-action="create-rule" data-message-index="${options.messageIndex}">${esc(normalized)}</button>`;
    }
    return `<span class="api-message-system-action">${renderApiPddEmojiHtml(normalized)}</span>`;
  }

  function renderApiSystemMessageHtml(messageOrText = '', options = {}) {
    const source = getApiSystemNoticeText(messageOrText);
    if (!source) return '';
    const refundNoticeKind = getApiRefundSystemNoticeKind(messageOrText);
    if (refundNoticeKind) {
      return renderApiRefundSystemNoticeCardHtml(messageOrText, options);
    }
    const actionPattern = /(>>[^<>\n]+<<|点击(?:添加|【[^】\n]+】))/g;
    const normalizedSource = source.replace(/^(\s*>>[^<>\n]+<<\s*)+/, '').trim();
    const target = normalizedSource || source;
    const actionMatch = target.match(actionPattern);
    if (actionMatch) {
      const actionText = actionMatch[0];
      const actionIndex = target.indexOf(actionText);
      const prefix = actionIndex >= 0 ? target.slice(0, actionIndex) : target;
      const suffix = actionIndex >= 0 ? target.slice(actionIndex + actionText.length) : '';
      return [
        prefix ? `<span class="api-message-system-main">${renderApiPddEmojiHtml(prefix)}</span>` : '',
        buildApiSystemActionHtml(actionText, options),
        suffix ? `<span class="api-message-system-main">${renderApiPddEmojiHtml(suffix)}</span>` : '',
      ].join('');
    }
    return `<span class="api-message-system-main">${renderApiPddEmojiHtml(target)}</span>`;
  }

  function findApiMatchedRefundCard(sortedMessages = [], options = {}) {
    const targetMessageId = String(options?.targetMessageId || '').trim();
    if (targetMessageId && Array.isArray(sortedMessages)) {
      for (const candidate of sortedMessages) {
        const card = extractApiRefundCard(candidate, options?.activeSession || {});
        if (card && String(card.localKey || '').trim() === targetMessageId) {
          return card;
        }
      }
    }
    const messageIndex = Number.isInteger(options?.messageIndex) ? options.messageIndex : -1;
    if (!Array.isArray(sortedMessages) || messageIndex < 0) return null;
    for (let distance = 0; distance <= 6; distance++) {
      const candidateIndexes = distance === 0
        ? [messageIndex]
        : [messageIndex - distance, messageIndex + distance];
      for (const candidateIndex of candidateIndexes) {
        if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= sortedMessages.length) continue;
        const card = extractApiRefundCard(sortedMessages[candidateIndex], options?.activeSession || {});
        if (card) return card;
      }
    }
    return null;
  }

  function findApiRefundStatusUpdateForCard(sortedMessages = [], options = {}) {
    const targetMessageId = String(options?.targetMessageId || '').trim();
    if (!Array.isArray(sortedMessages) || !sortedMessages.length) return null;
    if (targetMessageId) {
      for (const message of sortedMessages) {
        const statusMeta = getApiRefundStatusUpdateMeta(message);
        if (statusMeta && String(statusMeta.targetMessageId || '').trim() === targetMessageId) {
          return statusMeta;
        }
      }
    }
    const cardIndex = Number.isInteger(options?.cardIndex) ? options.cardIndex : -1;
    if (cardIndex < 0) return null;
    for (let distance = 1; distance <= 6; distance++) {
      const nextIndex = cardIndex + distance;
      if (nextIndex >= sortedMessages.length) break;
      const candidate = sortedMessages[nextIndex];
      const statusMeta = getApiRefundStatusUpdateMeta(candidate);
      if (statusMeta) return statusMeta;
      const anotherCard = extractApiRefundCard(candidate, options?.activeSession || {});
      if (anotherCard) break;
    }
    return null;
  }

  function applyApiRefundStatusToCard(card = {}, sortedMessages = [], options = {}) {
    if (!card || typeof card !== 'object') return null;
    const localKey = String(card.localKey || '').trim();
    const statusMeta = findApiRefundStatusUpdateForCard(sortedMessages, {
      targetMessageId: localKey,
      cardIndex: options?.cardIndex,
      activeSession: options?.activeSession,
    });
    if (statusMeta?.footerText) {
      return {
        ...card,
        footerText: statusMeta.footerText,
      };
    }
    return card;
  }

  function renderApiRefundStatusUpdateCardHtml(message = {}, options = {}) {
    const statusMeta = getApiRefundStatusUpdateMeta(message);
    if (!statusMeta) return '';
    const card = findApiMatchedRefundCard(options?.sortedMessages, {
      targetMessageId: statusMeta.targetMessageId,
      messageIndex: options?.messageIndex,
      activeSession: options?.activeSession,
    });
    const displayText = statusMeta.displayText || '消费者已同意您发起的退款申请，请及时处理';
    if (!card) {
      if (statusMeta.kind === 'refund-success') {
        return `<div class="api-system-refund-card success">
          <div class="api-system-refund-card-success-head">
            <span class="api-system-refund-card-success-icon" aria-hidden="true"></span>
            <span>退款成功</span>
          </div>
        </div>`;
      }
      return `<div class="api-system-refund-card pending">
        <div class="api-system-refund-card-header">${esc(displayText)}</div>
      </div>`;
    }
    const imageHtml = card.imageUrl
      ? `<img class="api-system-refund-card-media" src="${esc(card.imageUrl)}" alt="${esc(card.goodsTitle || '商品主图')}">`
      : `<div class="api-system-refund-card-media-placeholder">商品</div>`;
    if (statusMeta.kind === 'refund-success') {
      return `<div class="api-system-refund-card success">
        <div class="api-system-refund-card-success-head">
          <span class="api-system-refund-card-success-icon" aria-hidden="true"></span>
          <span>退款成功</span>
        </div>
        <div class="api-system-refund-card-goods">
          ${imageHtml}
          <div class="api-system-refund-card-main">
            <div class="api-system-refund-card-goods-title">${esc(card.goodsTitle || '订单商品')}</div>
            <div class="api-system-refund-card-success-meta">
              ${card.specText ? `<div class="api-system-refund-card-spec">${esc(card.specText)}</div>` : ''}
              <div class="api-system-refund-card-success-actual">实收：${esc(card.amountText || '--')}</div>
            </div>
          </div>
        </div>
        <div class="api-system-refund-card-success-footer">
          <div class="api-system-refund-card-success-amount">
            <span class="api-system-refund-card-success-amount-label">退款金额</span>
            <span class="api-system-refund-card-success-amount-value">${esc(card.amountText || '--')}</span>
          </div>
          <span class="api-system-refund-card-success-button">查看订单售后详情</span>
        </div>
      </div>`;
    }
    return renderApiRefundCardHtml(card, {
      headerText: displayText,
      actionButtonLabel: '去处理',
    });
  }

  function getApiRefundCardTypeText(type = 'refund') {
    if (type === 'refund') return '退款';
    if (type === 'returnRefund') return '退货退款';
    if (type === 'resend') return '补寄';
    if (type === '1' || type === 1) return '退款';
    if (type === '2' || type === 2) return '退货退款';
    if (type === '3' || type === 3) return '补寄';
    return String(type || '').trim() || '退款';
  }

  function getApiRefundCardButtonTexts(buttons = []) {
    const list = Array.isArray(buttons) ? buttons : [];
    return list
      .map(item => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        return String(
          item.text
          || item.title
          || item.label
          || item.button_text
          || item.buttonText
          || item.name
          || ''
        ).trim();
      })
      .filter(Boolean);
  }

  function findApiRefundCardNode(source) {
    const queue = [{ value: source, depth: 0 }];
    const visited = new WeakSet();
    while (queue.length) {
      const currentEntry = queue.shift();
      const current = currentEntry?.value;
      const depth = Number(currentEntry?.depth || 0);
      if (!current || typeof current !== 'object') continue;
      if (visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) {
        if (depth < 4) {
          current.forEach(item => {
            if (item && typeof item === 'object') queue.push({ value: item, depth: depth + 1 });
          });
        }
        continue;
      }
      const sources = [
        current,
        current.goods,
        current.goodsInfo,
        current.goods_info,
        current.item,
        current.product,
      ].filter(Boolean);
      const text = [
        pickApiRefundText(sources, ['title', 'card_title', 'cardTitle', 'header', 'header_text', 'headerText', 'name']),
        pickApiRefundText(sources, ['content', 'text', 'desc', 'description', 'message']),
        ...getApiRefundCardButtonTexts(
          current.buttons || current.button_list || current.buttonList || current.actions || current.action_list
        ),
      ].filter(Boolean).join(' ');
      const hasRefundText = /(快捷退款|申请退款|同意退款|暂不退款|退货退款|申请补寄)/.test(text);
      const hasCardPayload = !!(
        pickApiRefundText(sources, ['goods_name', 'goodsName', 'item_title', 'itemTitle', 'order_sn', 'orderSn'])
        || pickApiRefundNumber(sources, ['refund_amount', 'refundAmount', 'amount', 'price'])
      );
      if (hasRefundText && hasCardPayload) {
        return current;
      }
      if (depth >= 4) continue;
      Object.keys(current).forEach(key => {
        const value = current[key];
        if (value && typeof value === 'object') {
          queue.push({ value, depth: depth + 1 });
        }
      });
    }
    return null;
  }

  function normalizeApiRefundCardData(card = {}, fallback = {}) {
    const sources = [
      card,
      card?.goods,
      card?.goodsInfo,
      card?.goods_info,
      card?.item,
      card?.product,
      card?.order,
      card?.orderInfo,
      card?.order_info,
      card?.reposeInfo,
      card?.repose_info,
      fallback,
    ].filter(Boolean);
    const orderSn = pickApiRefundText(sources, ['orderSn', 'order_sn', 'orderId', 'order_id']) || String(fallback?.orderSn || '').trim();
    const goodsTitle = pickApiRefundText(sources, ['goodsTitle', 'goods_title', 'goodsName', 'goods_name', 'itemTitle', 'item_title', 'title'])
      || String(fallback?.goodsTitle || '').trim()
      || '订单商品';
    const imageUrl = pickApiRefundText(sources, ['imageUrl', 'image_url', 'thumb_url', 'goods_thumb_url', 'pic_url'])
      || String(fallback?.imageUrl || '').trim();
    const specText = pickApiRefundText(sources, ['specText', 'spec_text', 'spec', 'skuSpec', 'sku_spec', 'detailText', 'detail_text'])
      || String(fallback?.specText || '').trim();
    const reasonText = pickApiRefundText(sources, ['reasonText', 'reason_text', 'reason', 'questionTypeText', 'question_type_text'])
      || String(fallback?.reasonText || '').trim();
    const contactText = pickApiRefundText(sources, ['contactText', 'contact_text', 'mobile', 'phone', 'phoneNum', 'phone_num', 'telephone'])
      || String(fallback?.contactText || '').trim();
    const noteText = pickApiRefundText(sources, ['noteText', 'note_text', 'applyNote', 'apply_note', 'description', 'desc'])
      || String(fallback?.noteText || '').trim()
      || '商家代消费者填写售后单';
    const cardState = card?.mstate || card?.mState || card?.state || card?.status || fallback?.mstate || fallback?.mState || fallback?.state || {};
    const footerText = resolveApiRefundCardFooterText(
      cardState,
      pickApiRefundText(sources, ['footerText', 'footer_text', 'statusText', 'status_text', 'statusDesc', 'status_desc'])
      || pickApiRefundText([card?.mstate, card?.mState, card?.state, fallback?.mstate, fallback?.mState, fallback?.state], ['text', 'desc', 'label', 'expire_text'])
      || String(fallback?.footerText || '').trim()
    );
    const actionTypeRaw = pickApiRefundText(sources, ['actionText', 'action_text', 'applyTypeText', 'apply_type_text', 'afterSalesTypeDesc', 'after_sales_type_desc', 'type'])
      || fallback?.actionText
      || fallback?.type
      || 'refund';
    const amountText = normalizeApiRefundCardAmountText(
      pickApiRefundText(sources, ['amountText', 'amount_text', 'refundAmountText', 'refund_amount_text'])
      || pickApiRefundText(sources, ['refund_amount', 'refundAmount', 'amount', 'price'])
      || fallback?.amountText
      || ''
    );
    const localKey = String(
      fallback?.localKey
      || card?.localKey
      || [orderSn, actionTypeRaw, reasonText, amountText].filter(Boolean).join('::')
    ).trim();
    return {
      localKey,
      orderSn,
      title: String(fallback?.title || card?.title || getApiRefundCardTitle(actionTypeRaw)),
      actionText: getApiRefundCardTypeText(actionTypeRaw),
      goodsTitle,
      imageUrl,
      specText,
      reasonText,
      amountText,
      noteText,
      contactText,
      footerText,
    };
  }

  function extractApiRefundCard(message = {}, session = {}) {
    const directCard = message?.refundCard
      || message?.extra?.refundCard
      || message?.raw?.extra?.refundCard
      || message?.raw?.ext?.refundCard;
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    const goodsInfo = info?.goods_info && typeof info.goods_info === 'object' ? info.goods_info : {};
    const rawRefundCard = !directCard && Number(raw?.type ?? message?.type ?? -1) === 19 && String(info.card_id || '').trim() === 'ask_refund_apply'
      ? {
          localKey: String(raw?.msg_id || raw?.message_id || '').trim(),
          orderSn: String(goodsInfo?.order_sequence_no || '').trim(),
          title: String(info?.title || message?.content || '商家想帮您申请快捷退款').replace(/^\[|\]$/g, '').trim(),
          actionText: (() => {
            const row = (Array.isArray(info?.item_list) ? info.item_list : []).find(item => String(item?.left || '').includes('申请类型'));
            const value = Array.isArray(row?.right) ? row.right.map(entry => String(entry?.text || '').trim()).filter(Boolean).join(' ') : '';
            return value || '退款';
          })(),
          goodsTitle: String(goodsInfo?.goods_name || '').trim(),
          imageUrl: String(goodsInfo?.goods_thumb_url || '').trim(),
          specText: [String(goodsInfo?.extra || '').trim(), goodsInfo?.count ? `x${goodsInfo.count}` : ''].filter(Boolean).join(' '),
          reasonText: (() => {
            const row = (Array.isArray(info?.item_list) ? info.item_list : []).find(item => String(item?.left || '').includes('申请原因'));
            const value = Array.isArray(row?.right) ? row.right.map(entry => String(entry?.text || '').trim()).filter(Boolean).join(' ') : '';
            return value || '其他原因';
          })(),
          amountText: (() => {
            const row = (Array.isArray(info?.item_list) ? info.item_list : []).find(item => String(item?.left || '').includes('退款金额'));
            const value = Array.isArray(row?.right) ? row.right.map(entry => String(entry?.text || '').trim()).filter(Boolean).join(' ') : '';
            if (value) return value.includes('¥') ? value : `¥${value}`;
            const amountFen = Number(goodsInfo?.total_amount || 0) || 0;
            return amountFen > 0 ? `¥${(amountFen / 100).toFixed(2)}` : '';
          })(),
          noteText: (() => {
            const row = (Array.isArray(info?.item_list) ? info.item_list : []).find(item => String(item?.left || '').includes('申请说明'));
            const value = Array.isArray(row?.right) ? row.right.map(entry => String(entry?.text || '').trim()).filter(Boolean).join(' ') : '';
            return value || '商家代消费者填写售后单';
          })(),
          contactText: (() => {
            const row = (Array.isArray(info?.item_list) ? info.item_list : []).find(item => String(item?.left || '').includes('联系方式'));
            return Array.isArray(row?.right) ? row.right.map(entry => String(entry?.text || '').trim()).filter(Boolean).join(' ') : '';
          })(),
          footerText: resolveApiRefundCardFooterText(
            info?.mstate || info?.state,
            info?.mstate?.text || info?.state?.text || info?.mstate?.expire_text || info?.state?.expire_text
          ),
        }
      : null;
    const sourceCard = (directCard && typeof directCard === 'object') ? directCard : rawRefundCard;
    if (sourceCard && typeof sourceCard === 'object') {
      return normalizeApiRefundCardData(sourceCard, sourceCard);
    }
    const cardNode = findApiRefundCardNode(message?.raw || message);
    if (!cardNode) return null;
    return normalizeApiRefundCardData(cardNode, {
      orderSn: pickApiRefundText([message?.raw, session?.raw, session], ['order_sn', 'orderSn', 'order_id', 'orderId']),
      goodsTitle: pickApiRefundText([message?.raw, session?.goodsInfo, session?.raw?.goods_info, session?.raw, session], ['goods_name', 'goodsName', 'title', 'item_title']),
      imageUrl: pickApiRefundText([message?.raw, session?.goodsInfo, session?.raw?.goods_info], ['image_url', 'imageUrl', 'thumb_url', 'goods_thumb_url']),
      specText: pickApiRefundText([message?.raw, session?.goodsInfo, session?.raw?.goods_info], ['spec_text', 'specText', 'spec', 'sku_spec', 'skuSpec']),
    });
  }

  function buildApiRefundCardFromSubmit({
    orderContext = {},
    refundType = 'refund',
    reason = '',
    amountText = '',
    result = {},
    activeSession = {},
  } = {}) {
    const contactText = pickApiRefundText([
      result?.requestBody?.reposeInfo,
      result?.requestBody?.repose_info,
      result?.reposeInfo,
      result?.repose_info,
      result?.info?.reposeInfo,
      result?.info?.repose_info,
      result?.info,
      activeSession?.raw,
      activeSession,
    ], ['mobile', 'phone', 'phoneNum', 'phone_num', 'telephone']);
    const normalizedAmountText = refundType === 'resend' ? '' : normalizeApiRefundCardAmountText(amountText);
    return normalizeApiRefundCardData({
      localKey: [orderContext?.orderId || '', refundType, reason || '', normalizedAmountText || ''].join('::'),
      title: getApiRefundCardTitle(refundType),
      type: refundType,
      orderSn: orderContext?.orderId || '',
      goodsTitle: orderContext?.title || '订单商品',
      imageUrl: orderContext?.imageUrl || '',
      specText: orderContext?.detailText || '',
      reasonText: reason || '',
      amountText: normalizedAmountText,
      noteText: '商家代消费者填写售后单',
      contactText,
      footerText: '等待消费者确认',
    });
  }

  // 退款 modal（含订单选择子 modal、退款 / 退货退款 / 补寄三种类型）已迁出至
  // src/renderer/chat-api/modules/refund-modal.js
  // 通过 window.__chatApiModuleAccess（getApiActiveSession / loadApiSessions / openApiSession 等）
  // 与 window.__chatApiModuleHelpers（esc/setApiHint/recordApiSyncState/退款字段拾取与金额工具/商品链接解析等）共享上下文
  // 同时此前的小额打款 modal、邀请下单 modal / 邀请关注按钮也已分别迁出至
  // src/renderer/chat-api/modules/small-payment-modal.js 和 src/renderer/chat-api/modules/invite-order-modal.js

  function getApiMessageReadState(message = {}) {
    const normalized = String(message?.readState || '').toLowerCase();
    if (normalized === 'read') return 'read';
    if (normalized === 'unread') return 'unread';
    return '';
  }

  function extractApiGoodsLinkInfo(message = {}) {
    const rawText = [
      message?.content,
      message?.raw?.content,
      message?.raw?.msg_content,
    ].filter(Boolean).join('\n');
    const structuredSources = [
      message?.extra,
      message?.raw?.extra,
      message?.raw?.info,
      message?.raw?.biz_context,
      message?.raw,
      message,
    ].filter(Boolean);
    const match = rawText.match(/https?:\/\/(?:[\w-]+\.)?yangkeduo\.com\/(?:goods2?|goods)\.html\?[^ \n]+/i)
      || rawText.match(/https?:\/\/(?:[\w-]+\.)?yangkeduo\.com\/poros\/h5[^ \n]*goods_id=\d+[^ \n]*/i);
    let url = match?.[0]
      ? match[0].replace(/&amp;/gi, '&')
      : pickApiGoodsText(structuredSources, ['url', 'share_url', 'shareUrl', 'goods_url', 'goodsUrl', 'jump_url', 'jumpUrl', 'link_url', 'linkUrl']);
    if (url && !/^https?:\/\//i.test(url) && /(?:^|[?&])goods_id=\d+/i.test(url)) {
      url = `https://mobile.yangkeduo.com/${String(url).replace(/^\/+/, '')}`;
    }
    if (url && /^\/(?:goods2?|goods)\.html\?/i.test(url)) {
      url = `https://mobile.yangkeduo.com${url}`;
    }
    const isHttpGoodsUrl = url && /^https?:\/\/(?:[\w-]+\.)?yangkeduo\.com\/(?:goods2?|goods)\.html\?/i.test(url);
    const isH5GoodsUrl = url && /^https?:\/\/(?:[\w-]+\.)?yangkeduo\.com\/poros\/h5/i.test(url) && /[?&]goods_id=\d+/i.test(url);
    if (url && !isHttpGoodsUrl && !isH5GoodsUrl) {
      url = '';
    }
    const goodsIdMatch = (url
      ? (url.match(/[?&]goods_id=(\d+)/i) || url.match(/[?&]goodsId=(\d+)/i))
      : null)
      || rawText.match(/[?&]goods_id=(\d+)/i)
      || rawText.match(/[?&]goodsId=(\d+)/i)
      || rawText.match(/商品ID[:：]?\s*(\d{6,})/i);
    const goodsId = goodsIdMatch?.[1]
      || pickApiGoodsText(structuredSources, ['goods_id', 'goodsId', 'goodsID', 'target_goods_id', 'targetGoodsId', 'id']);
    if (goodsId) {
      url = `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`;
    }
    if (!url && !goodsId) return null;
    return {
      url,
      goodsId,
      cacheKey: goodsId || url,
    };
  }

  function pickApiGoodsText(sources = [], keys = []) {
    const extractText = (value, preferredKeys = [], seen = new Set()) => {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (!value || typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const matched = extractText(item, preferredKeys, seen);
          if (matched) return matched;
        }
        return '';
      }
      for (const key of preferredKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const matched = extractText(value[key], preferredKeys, seen);
        if (matched) return matched;
      }
      for (const item of Object.values(value)) {
        const matched = extractText(item, preferredKeys, seen);
        if (matched) return matched;
      }
      return '';
    };
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const matched = extractText(source[key], ['title', 'name', 'text', 'content', 'url', 'src', 'imageUrl', 'image_url']);
        if (matched) return matched;
      }
    }
    return '';
  }

  function pickApiGoodsNumber(sources = [], keys = []) {
    const extractNumber = (value, seen = new Set()) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      if (!value || typeof value !== 'object' || seen.has(value)) return 0;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const matched = extractNumber(item, seen);
          if (matched > 0) return matched;
        }
        return 0;
      }
      for (const item of Object.values(value)) {
        const matched = extractNumber(item, seen);
        if (matched > 0) return matched;
      }
      return 0;
    };
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const matched = extractNumber(source[key]);
        if (matched > 0) return matched;
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

  function normalizeApiGoodsSpecItems(items = []) {
    return (Array.isArray(items) ? items : [])
      .map(item => ({
        specLabel: String(item?.specLabel || '').trim(),
        styleLabel: String(item?.styleLabel || '').trim(),
        priceText: String(item?.priceText || '').trim(),
        stockText: String(item?.stockText || '').trim(),
        salesText: String(item?.salesText || '').trim(),
      }))
      .filter(item => item.specLabel || item.styleLabel || item.priceText || item.stockText || item.salesText);
  }

  function buildApiGoodsSpecFallbackItems(card = {}) {
    const specText = String(card?.specText || '').trim();
    if (!specText || specText === '查看商品规格') return [];
    return [{
      specLabel: specText,
      styleLabel: '',
      priceText: String(card?.priceText || '').trim(),
      stockText: '',
      salesText: '',
    }];
  }

  function normalizeApiGoodsCard(card = {}, fallback = {}) {
    const goodsId = String(card.goodsId || fallback.goodsId || '');
    return {
      cacheKey: String(card.cacheKey || fallback.cacheKey || ''),
      goodsId,
      url: String(card.url || fallback.url || ''),
      title: String(card.title || fallback.title || '拼多多商品'),
      imageUrl: String(card.imageUrl || fallback.imageUrl || ''),
      priceText: String(card.priceText || fallback.priceText || ''),
      groupText: String(card.groupText || fallback.groupText || '2人团'),
      specText: String(card.specText || fallback.specText || '查看商品规格'),
      specItems: normalizeApiGoodsSpecItems(card.specItems || fallback.specItems || []),
      stockText: String(card.stockText || fallback.stockText || ''),
      salesText: String(card.salesText || fallback.salesText || ''),
      pendingGroupText: String(card.pendingGroupText || fallback.pendingGroupText || ''),
    };
  }

  function isMeaningfulApiGoodsCard(card = {}) {
    const title = String(card?.title || '').trim();
    return !!(
      String(card?.imageUrl || '').trim()
      || String(card?.priceText || '').trim()
      || (title && title !== '拼多多商品')
    );
  }

  function describeApiGoodsCardResult(card = {}) {
    const title = String(card?.title || '').trim() || '空标题';
    const imageState = card?.imageUrl ? '有图' : '无图';
    const priceState = card?.priceText ? `价格:${card.priceText}` : '无价';
    return `${title}，${imageState}，${priceState}`;
  }

  function buildApiGoodsCardFallback(linkInfo, message = {}, session = {}) {
    // 优先读"商品来源通知消息"里显式挂载的 goods_info 对象，
    // 这里字段是 goods_id / goods_name / goods_thumb_url / mall_link_url / min_group_price 等。
    // 不走 pickApiGoods* 的深度遍历，避免把 raw.info.title（系统提示文案）或 goods_id 误当 title/price。
    const explicitGoodsInfo = [
      message?.raw?.info?.goods_info,
      message?.raw?.info?.data?.goods_info,
      message?.extra?.goods_info,
      message?.raw?.extra?.goods_info,
      message?.raw?.biz_context?.goods_info,
      message?.raw?.goods_info,
      session?.goodsInfo,
      session?.raw?.goods_info,
      session?.raw?.goods,
    ].find(item => item && typeof item === 'object') || {};

    const explicitGoodsId = explicitGoodsInfo.goods_id
      ?? explicitGoodsInfo.goodsId
      ?? explicitGoodsInfo.goodsID
      ?? explicitGoodsInfo.id;
    const explicitTitle = explicitGoodsInfo.goods_name
      || explicitGoodsInfo.goodsName
      || explicitGoodsInfo.goods_title
      || explicitGoodsInfo.goodsTitle;
    const explicitImage = explicitGoodsInfo.goods_thumb_url
      || explicitGoodsInfo.goodsThumbUrl
      || explicitGoodsInfo.hd_thumb_url
      || explicitGoodsInfo.hdThumbUrl
      || explicitGoodsInfo.thumb_url
      || explicitGoodsInfo.thumbUrl
      || explicitGoodsInfo.image_url
      || explicitGoodsInfo.imageUrl
      || explicitGoodsInfo.pic_url
      || explicitGoodsInfo.picUrl;
    const explicitUrl = explicitGoodsInfo.mall_link_url
      || explicitGoodsInfo.mallLinkUrl
      || explicitGoodsInfo.goods_url
      || explicitGoodsInfo.goodsUrl
      || explicitGoodsInfo.url;
    const explicitPriceRaw = explicitGoodsInfo.min_group_price
      ?? explicitGoodsInfo.minGroupPrice
      ?? explicitGoodsInfo.group_price
      ?? explicitGoodsInfo.groupPrice
      ?? explicitGoodsInfo.promotion_price
      ?? explicitGoodsInfo.promotionPrice
      ?? explicitGoodsInfo.coupon_promo_price
      ?? explicitGoodsInfo.couponPromoPrice
      ?? explicitGoodsInfo.min_normal_price
      ?? explicitGoodsInfo.minNormalPrice
      ?? explicitGoodsInfo.min_price
      ?? explicitGoodsInfo.minPrice
      ?? explicitGoodsInfo.price;

    // 没命中显式字段时，回退到旧的深度遍历（兼容其它消息类型）
    const sources = [
      message?.extra,
      message?.raw?.extra,
      message?.raw?.info,
      message?.raw?.biz_context,
      message?.raw,
      session?.goodsInfo,
      session?.raw?.goods_info,
      session?.raw?.goods,
    ].filter(Boolean);
    const fallbackPriceText = pickApiGoodsText(sources, ['priceText', 'price_text'])
      || formatApiGoodsPrice(pickApiGoodsNumber(sources, ['promotionPrice', 'promotion_price', 'couponPromoPrice', 'coupon_promo_price', 'group_price', 'min_group_price', 'min_normal_price', 'price', 'min_price']));
    const priceText = formatApiGoodsPrice(explicitPriceRaw) || fallbackPriceText;
    const groupRawText = pickApiGoodsText(sources, ['groupText', 'group_text', 'groupLabel', 'group_label', 'group_order_type_desc', 'group_desc']);
    const groupCount = pickApiGoodsNumber(sources, ['customer_num', 'customerNumber', 'group_member_count', 'group_count']);

    return normalizeApiGoodsCard({
      cacheKey: String(linkInfo?.cacheKey || ''),
      goodsId: linkInfo?.goodsId
        || (explicitGoodsId != null && explicitGoodsId !== '' ? String(explicitGoodsId) : '')
        || pickApiGoodsText(sources, ['goods_id', 'goodsId', 'goodsID']),
      url: linkInfo?.url || explicitUrl || '',
      title: (explicitTitle && String(explicitTitle).trim())
        || pickApiGoodsText(sources, ['goods_name', 'goodsName', 'goodsTitle'])
        || '拼多多商品',
      imageUrl: explicitImage
        || pickApiGoodsText(sources, ['goods_thumb_url', 'goodsThumbUrl', 'hd_thumb_url', 'hdThumbUrl', 'thumb_url', 'thumbUrl', 'image_url', 'imageUrl', 'pic_url']),
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
    const specItems = card.specItems?.length ? card.specItems : buildApiGoodsSpecFallbackItems(card);
    return `<div class="api-message-bubble api-goods-card-bubble api-goods-card-clickable" data-goods-id="${esc(card.goodsId || '')}" data-goods-url="${esc(card.url || '')}" data-goods-title="${esc(card.title || '')}">
      <div class="api-goods-card-top">
        <span class="api-goods-card-id">${esc(goodsIdLabel)}</span>
        ${card.goodsId ? `<button class="api-goods-card-copy" type="button" data-goods-id="${esc(card.goodsId)}">复制</button>` : ''}
      </div>
      <div class="api-goods-card-divider"></div>
      <div class="api-goods-card-body">
        <div class="api-goods-card-content">
          <div class="api-goods-card-media">
            ${imageHtml}
          </div>
          <div class="api-goods-card-main">
            <div class="api-goods-card-summary">
              <div class="api-goods-card-title">${esc(card.title || '拼多多商品')}</div>
              ${priceHtml}
            </div>
            <button
              class="api-goods-card-spec"
              type="button"
              data-goods-cache-key="${esc(card.cacheKey || '')}"
              data-goods-id="${esc(card.goodsId || '')}"
              data-goods-url="${esc(card.url || '')}"
              data-goods-title="${esc(card.title || '')}"
              data-goods-image-url="${esc(card.imageUrl || '')}"
              data-goods-price-text="${esc(card.priceText || '')}"
              data-goods-group-text="${esc(card.groupText || '')}"
              data-goods-spec-text="${esc(card.specText || '查看商品规格')}"
              data-goods-stock-text="${esc(card.stockText || '')}"
              data-goods-sales-text="${esc(card.salesText || '')}"
              data-goods-pending-group-text="${esc(card.pendingGroupText || '')}"
              data-goods-spec-items="${esc(JSON.stringify(specItems || []))}"
            >${esc(card.specText || '查看商品规格')}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function findApiGoodsSourceReferenceCard(sortedMessages = [], messageIndex = -1, session = {}, goodsLinkInfo = null) {
    if (!Array.isArray(sortedMessages) || !sortedMessages.length || messageIndex < 0) return null;
    const state = getState();
    const expectedGoodsId = String(goodsLinkInfo?.goodsId || '').trim();
    let nearestMeaningfulCard = null;
    for (let distance = 1; distance <= 12; distance++) {
      const candidateIndexes = [messageIndex - distance, messageIndex + distance];
      for (const candidateIndex of candidateIndexes) {
        if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= sortedMessages.length) continue;
        const candidateMessage = sortedMessages[candidateIndex];
        const candidateLinkInfo = extractApiGoodsLinkInfo(candidateMessage);
        if (!candidateLinkInfo) continue;
        const candidateFallbackCard = buildApiGoodsCardFallback(candidateLinkInfo, candidateMessage, session);
        const candidateCachedCard = candidateLinkInfo.cacheKey
          ? state.apiGoodsCardCache?.get(candidateLinkInfo.cacheKey)
          : null;
        const candidateCard = normalizeApiGoodsCard(
          candidateLinkInfo?.cacheKey ? { ...(candidateCachedCard || {}), cacheKey: candidateLinkInfo.cacheKey } : (candidateCachedCard || {}),
          candidateLinkInfo?.cacheKey ? { ...(candidateFallbackCard || {}), cacheKey: candidateLinkInfo.cacheKey } : (candidateFallbackCard || {})
        );
        if (!isMeaningfulApiGoodsCard(candidateCard)) continue;
        const candidateGoodsId = String(candidateLinkInfo.goodsId || candidateCard.goodsId || '').trim();
        if (expectedGoodsId && candidateGoodsId && candidateGoodsId === expectedGoodsId) {
          return candidateCard;
        }
        if (!nearestMeaningfulCard) {
          nearestMeaningfulCard = candidateCard;
        }
      }
    }
    return nearestMeaningfulCard;
  }

  function resolveApiGoodsSourceCard(message = {}, session = {}, goodsLinkInfo = null, cachedCard = null, options = {}) {
    const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    const infoData = info?.data && typeof info.data === 'object' ? info.data : {};
    const goodsList = [
      infoData?.goods_info_list,
      infoData?.goodsInfoList,
      infoData?.goods_list,
      infoData?.goodsList,
      info?.goods_info_list,
      info?.goodsInfoList,
      info?.goods_list,
      info?.goodsList,
      infoData?.goods,
      info?.goods,
    ].find(Array.isArray) || [];
    const goodsItem = goodsList.find(item => item && typeof item === 'object') || {};
    const sourceNoticeText = getApiSystemNoticeText(message).replace(/^\[|\]$/g, '').trim();
    const textExclusions = [
      sourceNoticeText,
      /当前用户来自/,
      /商品详情页/,
    ];
    const sources = [
      goodsItem,
      session?.goodsInfo,
      session?.raw?.goods_info,
      session?.raw?.goods,
      infoData,
      info,
      message?.extra,
      raw?.extra,
      raw?.biz_context,
      raw?.bizContext,
      raw,
      message,
    ].filter(Boolean);
    const fallbackCard = normalizeApiGoodsCard({
      cacheKey: String(goodsLinkInfo?.cacheKey || ''),
      goodsId: goodsLinkInfo?.goodsId || pickApiGoodsText(sources, ['goods_id', 'goodsId', 'goodsID', 'target_goods_id', 'targetGoodsId', 'id']),
      url: goodsLinkInfo?.url || '',
      title: pickApiGoodsTextWithExclusions(sources, [
        'goods_name',
        'goodsName',
        'goods_title',
        'goodsTitle',
        'item_title',
        'itemTitle',
        'share_title',
        'shareTitle',
        'name',
        'title',
      ], textExclusions) || '',
      imageUrl: pickApiGoodsText(sources, [
        'imageUrl',
        'image_url',
        'thumb_url',
        'hd_thumb_url',
        'goods_thumb_url',
        'thumbUrl',
        'hdThumbUrl',
        'goodsThumbUrl',
        'pic_url',
        'sku_thumb_url',
        'skuThumbUrl',
        'cover_url',
        'coverUrl',
        'hd_url',
        'hdUrl',
        'top_gallery',
        'gallery',
        'images',
        'imageList',
      ]),
      priceText: pickApiGoodsText(sources, [
        'priceText',
        'price_text',
        'price',
        'promotion_price',
        'promotionPrice',
        'goods_price',
        'goodsPrice',
        'amount',
        'amountText',
        'sku_price',
        'skuPrice',
        'group_price',
        'unit_price',
        'pay_price',
        'final_price',
      ]) || formatApiGoodsPrice(pickApiGoodsNumber(sources, [
        'promotion_price',
        'promotionPrice',
        'goods_price',
        'goodsPrice',
        'price',
        'amount',
        'sku_price',
        'skuPrice',
        'group_price',
        'unit_price',
        'pay_price',
        'final_price',
      ])),
      specText: pickApiGoodsTextWithExclusions(sources, [
        'specText',
        'spec_text',
        'spec',
        'sku_spec',
        'skuSpec',
        'spec_desc',
        'specDesc',
        'sub_name',
        'subName',
        'sku_name',
        'skuName',
      ], textExclusions),
    }, {});
    const nearbyReferenceCard = findApiGoodsSourceReferenceCard(
      options.sortedMessages,
      Number.isInteger(options.messageIndex) ? options.messageIndex : -1,
      session,
      goodsLinkInfo
    );
    const genericFallbackCard = buildApiGoodsCardFallback(goodsLinkInfo || {}, message, session);
    const normalized = normalizeApiGoodsCard(
      goodsLinkInfo?.cacheKey ? { ...(cachedCard || {}), cacheKey: goodsLinkInfo.cacheKey } : (cachedCard || {}),
      fallbackCard
    );
    const resolved = normalizeApiGoodsCard(
      normalized,
      nearbyReferenceCard || genericFallbackCard || {}
    );
    const placeholderTitle = String(resolved.title || '').trim() === '拼多多商品';
    const referenceTitle = String(nearbyReferenceCard?.title || genericFallbackCard?.title || '').trim();
    if (placeholderTitle && referenceTitle && referenceTitle !== '拼多多商品') {
      resolved.title = referenceTitle;
    }
    const placeholderSpec = !String(resolved.specText || '').trim() || String(resolved.specText || '').trim() === '查看商品规格';
    const referenceSpec = String(nearbyReferenceCard?.specText || genericFallbackCard?.specText || '').trim();
    if (placeholderSpec && referenceSpec && referenceSpec !== '查看商品规格') {
      resolved.specText = referenceSpec;
    }
    return isMeaningfulApiGoodsCard(resolved) ? resolved : null;
  }

  function renderApiGoodsSourceNoticeCardHtml(message = {}, card = {}) {
    const sourceText = getApiSystemNoticeText(message).replace(/^\[|\]$/g, '').trim() || '当前用户来自 商品详情页';
    const imageHtml = card.imageUrl
      ? `<img class="api-source-goods-card-image" src="${esc(card.imageUrl)}" alt="${esc(card.title || '商品主图')}">`
      : '<div class="api-source-goods-card-image placeholder">商品</div>';
    const specText = String(card.specText || '').trim();
    return `<div class="api-source-goods-card">
      <div class="api-source-goods-card-header">${esc(sourceText)}</div>
      <div class="api-source-goods-card-body">
        ${imageHtml}
        <div class="api-source-goods-card-main">
          <div class="api-source-goods-card-title">${esc(card.title || '拼多多商品')}</div>
          ${specText && specText !== '查看商品规格' ? `<div class="api-source-goods-card-spec">${esc(specText)}</div>` : ''}
        </div>
        ${card.priceText ? `<div class="api-source-goods-card-price">${esc(card.priceText)}</div>` : ''}
      </div>
    </div>`;
  }

  // 商品规格 modal（消息商品卡片查看商品规格按钮）已迁出至
  // src/renderer/chat-api/modules/goods-spec-modal.js
  // 通过 window.openApiGoodsSpecModal / closeApiGoodsSpecModal 与本模块及 index.html 串联

  function buildApiRefundCardRows(card = {}) {
    return [
      { label: '申请类型', value: card.actionText || '退款' },
      { label: '申请原因', value: card.reasonText || '其他原因' },
      card.amountText ? { label: '退款金额', value: card.amountText, emphasis: true } : null,
      { label: '申请说明', value: card.noteText || '商家代消费者填写售后单' },
      card.contactText ? { label: '联系方式', value: card.contactText } : null,
    ].filter(Boolean);
  }

  function renderApiRefundCardHtml(card = {}, options = {}) {
    const imageHtml = card.imageUrl
      ? `<img class="api-refund-card-media" src="${esc(card.imageUrl)}" alt="${esc(card.goodsTitle || '商品主图')}">`
      : '<div class="api-refund-card-media-placeholder">商品</div>';
    const rows = buildApiRefundCardRows(card);
    const headerText = String(options.headerText || card.title || '商家想帮您申请快捷退款').trim();
    const actionButtonLabel = String(options.actionButtonLabel || '').trim();
    const footerHtml = actionButtonLabel
      ? `<span class="api-refund-card-action">${esc(actionButtonLabel)}</span>`
      : esc(card.footerText || '等待消费者确认');
    const footerClass = actionButtonLabel
      ? 'api-refund-card-section api-refund-card-footer is-action'
      : 'api-refund-card-section api-refund-card-footer';
    return `<div class="api-message-bubble api-refund-card-bubble">
      <div class="api-refund-card-header">${esc(headerText)}</div>
      <div class="api-refund-card-section">
        <div class="api-refund-card-goods">
          ${imageHtml}
          <div class="api-refund-card-main">
            <div class="api-refund-card-goods-title">${esc(card.goodsTitle || '订单商品')}</div>
            <div class="api-refund-card-goods-meta">
              ${card.specText ? `<span class="api-refund-card-goods-spec">${esc(card.specText)}</span>` : '<span class="api-refund-card-goods-spec"></span>'}
              ${card.amountText ? `<span class="api-refund-card-goods-price">${esc(card.amountText)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="api-refund-card-section api-refund-card-rows">
        ${rows.map(row => `<div class="api-refund-card-row"><span class="api-refund-card-label">${esc(row.label)}</span><span class="api-refund-card-value${row.emphasis ? ' is-emphasis' : ''}">${esc(row.value)}</span></div>`).join('')}
      </div>
      <div class="${footerClass}">${footerHtml}</div>
    </div>`;
  }

  function extractApiInviteOrderCard(message = {}) {
    const directCard = message?.inviteOrderCard && typeof message.inviteOrderCard === 'object'
      ? message.inviteOrderCard
      : null;
    if (directCard) return normalizeApiInviteOrderCard(directCard, directCard);
    const extraCard = message?.extra?.inviteOrderCard && typeof message.extra.inviteOrderCard === 'object'
      ? message.extra.inviteOrderCard
      : null;
    if (extraCard) return normalizeApiInviteOrderCard(extraCard, extraCard);
    const raw = message?.raw && typeof message.raw === 'object'
      ? message.raw
      : (message && typeof message === 'object' ? message : {});
    const sourceText = getApiSystemNoticeText({ ...message, raw });
    if (isApiRefundPendingNoticeText(sourceText) || isApiRefundSuccessNoticeText(sourceText)) return null;
    if (!isApiInviteOrderTemplateMessage({ ...message, raw })) return null;
    const info = raw?.info && typeof raw.info === 'object' ? raw.info : {};
    const infoData = info?.data && typeof info.data === 'object' ? info.data : {};
    const goodsList = [
      infoData?.goods_info_list,
      infoData?.goodsInfoList,
      infoData?.goods_list,
      infoData?.goodsList,
      info?.goods_info_list,
      info?.goodsInfoList,
      info?.goods_list,
      info?.goodsList,
      infoData?.goods,
      info?.goods,
    ].find(Array.isArray) || [];
    const goodsItem = goodsList.find(item => item && typeof item === 'object') || {};
    const sources = [
      infoData,
      info,
      raw?.extra,
      raw?.biz_context,
      raw?.bizContext,
      raw,
      goodsItem,
    ].filter(Boolean);
    const messageText = [
      message?.content,
      raw?.content,
      raw?.msg_content,
      raw?.text,
      raw?.message,
      info?.mall_content,
      infoData?.mall_content,
      info?.title,
      infoData?.title,
      infoData?.content,
      infoData?.text,
      infoData?.msg_content,
    ].map(item => String(item || '').trim()).find(Boolean) || '';
    const priceText = pickApiGoodsText([goodsItem, ...sources], [
      'priceText',
      'price_text',
      'price',
      'promotion_price',
      'promotionPrice',
      'goods_price',
      'goodsPrice',
      'amount',
      'amountText',
      'sku_price',
      'skuPrice',
      'group_price',
      'unit_price',
      'pay_price',
      'final_price',
    ]) || formatApiGoodsPrice(pickApiGoodsNumber([goodsItem, ...sources], [
      'promotion_price',
      'promotionPrice',
      'goods_price',
      'goodsPrice',
      'price',
      'amount',
      'sku_price',
      'skuPrice',
      'group_price',
      'unit_price',
      'pay_price',
      'final_price',
    ]));
    const totalText = pickApiGoodsText(sources, [
      'totalText',
      'total_text',
      'payAmountText',
      'pay_amount_text',
      'mallTotalAmountText',
      'mall_total_amount_text',
      'totalAmountText',
      'total_amount_text',
      'amountText',
      'orderAmountText',
      'order_amount_text',
      'orderPriceText',
      'order_price_text',
      'priceText',
      'price_text',
    ]) || formatApiGoodsPrice(pickApiGoodsNumber(sources, [
      'pay_amount',
      'payAmount',
      'mall_total_amount',
      'mallTotalAmount',
      'discount_amount',
      'discountAmount',
      'total_amount',
      'totalAmount',
      'order_amount',
      'orderAmount',
      'total_price',
      'totalPrice',
      'amount',
      'price',
    ]));
    const count = goodsList.reduce((sum, item) => {
      const quantity = pickApiGoodsNumber([item], [
        'goodsNumber',
        'goods_number',
        'quantity',
        'num',
        'count',
        'buy_num',
        'buyNum',
        'goodsCount',
        'goods_count',
      ]);
      return sum + (quantity || 1);
    }, 0) || pickApiGoodsNumber(sources, [
      'sku_count',
      'skuCount',
      'goodsNumber',
      'goods_number',
      'quantity',
      'num',
      'count',
      'buy_num',
      'buyNum',
      'goodsCount',
      'goods_count',
    ]) || 1;
    return normalizeApiInviteOrderCard({
      messageText,
      title: pickApiGoodsText([goodsItem, ...sources], [
        'goods_name',
        'goodsName',
        'goods_title',
        'goodsTitle',
        'item_title',
        'itemTitle',
        'title',
        'name',
      ]) || '已选商品',
      specText: pickApiGoodsText([goodsItem, ...sources], [
        'specText',
        'spec_text',
        'spec',
        'sku_spec',
        'skuSpec',
        'spec_desc',
        'specDesc',
        'sub_name',
        'subName',
        'sku_name',
        'skuName',
      ]),
      imageUrl: pickApiGoodsText([goodsItem, ...sources], [
        'imageUrl',
        'image_url',
        'sku_thumb_url',
        'skuThumbUrl',
        'thumb_url',
        'hd_thumb_url',
        'goods_thumb_url',
        'thumbUrl',
        'hdThumbUrl',
        'goodsThumbUrl',
        'pic_url',
        'picUrl',
        'goods_img_url',
        'goodsImgUrl',
        'hd_url',
        'hdUrl',
      ]),
      priceText,
      totalText: totalText || priceText,
      count,
    }, {
      messageText,
      priceText,
      totalText: totalText || priceText,
      count,
    });
  }

  function normalizeApiInviteOrderCard(card = {}, fallback = {}) {
    return {
      messageText: String(card?.messageText || fallback?.messageText || '').trim(),
      title: String(card?.title || fallback?.title || '已选商品').trim() || '已选商品',
      specText: String(card?.specText || fallback?.specText || '').trim(),
      imageUrl: String(card?.imageUrl || fallback?.imageUrl || '').trim(),
      priceText: String(card?.priceText || fallback?.priceText || '').trim(),
      totalText: String(card?.totalText || fallback?.totalText || card?.priceText || fallback?.priceText || '').trim(),
      count: Math.max(1, Number(card?.count || fallback?.count || 1) || 1),
    };
  }

  function normalizeApiInviteOrderComparableText(text = '') {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isSameApiInviteOrderCard(left = {}, right = {}) {
    const normalizedLeft = normalizeApiInviteOrderCard(left, left);
    const normalizedRight = normalizeApiInviteOrderCard(right, right);
    return (
      normalizeApiInviteOrderComparableText(normalizedLeft.messageText) === normalizeApiInviteOrderComparableText(normalizedRight.messageText)
      && normalizeApiInviteOrderComparableText(normalizedLeft.title) === normalizeApiInviteOrderComparableText(normalizedRight.title)
      && normalizeApiInviteOrderComparableText(normalizedLeft.specText) === normalizeApiInviteOrderComparableText(normalizedRight.specText)
      && normalizeApiInviteOrderComparableText(normalizedLeft.priceText) === normalizeApiInviteOrderComparableText(normalizedRight.priceText)
      && normalizeApiInviteOrderComparableText(normalizedLeft.totalText) === normalizeApiInviteOrderComparableText(normalizedRight.totalText)
      && Number(normalizedLeft.count || 1) === Number(normalizedRight.count || 1)
    );
  }

  // buildApiInviteOrderPreviewCard 已随 invite-order modal 一起迁出至
  // src/renderer/chat-api/modules/invite-order-modal.js（仅在 modal 内部使用）

  function renderApiInviteOrderCardHtml(card = {}) {
    const count = Math.max(1, Number(card?.count || 1) || 1);
    const countText = `x${count}`;
    const imageHtml = card.imageUrl
      ? `<img class="api-invite-order-message-image" src="${esc(card.imageUrl)}" alt="${esc(card.title || '商品主图')}">`
      : '<div class="api-invite-order-message-image is-placeholder">商品</div>';
    return `<div class="api-invite-order-message-bubble">
      ${card.messageText ? `<div class="api-invite-order-message-text">${esc(card.messageText)}</div>` : ''}
      <div class="api-invite-order-message-divider"></div>
      <div class="api-invite-order-message-card">
        ${imageHtml}
        <div class="api-invite-order-message-main">
          <div class="api-invite-order-message-title">${esc(card.title || '商品')}</div>
          ${card.specText ? `<div class="api-invite-order-message-spec">${esc(card.specText)}</div>` : ''}
        </div>
        <div class="api-invite-order-message-side">
          ${card.priceText ? `<div class="api-invite-order-message-price">${esc(card.priceText)}</div>` : ''}
          <div class="api-invite-order-message-count">${esc(countText)}</div>
        </div>
      </div>
      <div class="api-invite-order-message-divider"></div>
      <div class="api-invite-order-message-footer">
        <span class="api-invite-order-message-total">合计：<strong>${esc(card.totalText || card.priceText || '¥0.00')}</strong></span>
      </div>
    </div>`;
  }

  function getApiDisplayMessages(state = {}, activeSession = null) {
    const sessionKey = getApiSessionKey(activeSession || {});
    const remoteMessages = Array.isArray(state.apiMessages) ? state.apiMessages.slice() : [];
    const syntheticMessages = [
      ...(Array.isArray(state.apiSyntheticRefundMessages) ? state.apiSyntheticRefundMessages : []),
      ...(Array.isArray(state.apiSyntheticSystemMessages) ? state.apiSyntheticSystemMessages : []),
      ...(Array.isArray(state.apiSyntheticServiceMessages) ? state.apiSyntheticServiceMessages : []),
    ].filter(item => getApiSessionKey(item?.shopId || activeSession?.shopId || '', item?.sessionId || '') === sessionKey);
    const mergedMessages = remoteMessages.slice();
    syntheticMessages.forEach(item => {
      const syntheticKey = String(item?.syntheticKey || item?.refundCard?.localKey || '');
      let duplicated = syntheticKey && remoteMessages.some(remote => {
        const refundKey = String(extractApiRefundCard(remote, activeSession)?.localKey || '');
        const remoteSyntheticKey = String(remote?.syntheticKey || '');
        return refundKey === syntheticKey || remoteSyntheticKey === syntheticKey;
      });
      if (!duplicated) {
        const syntheticInviteOrderCard = extractApiInviteOrderCard(item);
        if (syntheticInviteOrderCard) {
          duplicated = remoteMessages.some(remote => {
            if (remote?.isFromBuyer) return false;
            const remoteInviteOrderCard = extractApiInviteOrderCard(remote);
            if (!remoteInviteOrderCard || !isSameApiInviteOrderCard(remoteInviteOrderCard, syntheticInviteOrderCard)) return false;
            const remoteTimestamp = getApiTimeMs(remote?.timestamp);
            const syntheticTimestamp = getApiTimeMs(item?.timestamp);
            if (remoteTimestamp && syntheticTimestamp && Math.abs(remoteTimestamp - syntheticTimestamp) > 2 * 60 * 1000) {
              return false;
            }
            return true;
          });
        }
      }
      if (!duplicated) {
        mergedMessages.push(item);
      }
    });
    return mergedMessages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  }

  async function ensureApiGoodsCardLoaded(linkInfo, fallbackCard) {
    // 安全模式：chat-api 渲染期不再自动触发 apiGetGoodsCard。
    // 真实商品卡片只在用户显式点击"查看商品规格"时才通过 goods-spec-modal.js 内部的 loadApiGoodsSpecModalData 拉取，
    // 避免 goods-page:request 隐式把后台 BrowserView 载入 chat-merchant 导致掉线。
    const state = getState();
    const cache = state.apiGoodsCardCache;
    if (!linkInfo?.cacheKey || !cache) return;
    if (fallbackCard && isMeaningfulApiGoodsCard(fallbackCard)) {
      cache.set(linkInfo.cacheKey, normalizeApiGoodsCard(fallbackCard, fallbackCard));
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
        ? (item.previewImage
          ? `<img class="api-inline-emoji-image" src="${esc(item.previewImage)}" alt="${esc(name)}" title="${esc(match)}">`
          : `<span class="api-inline-emoji" title="${esc(match)}">${esc(item.preview)}</span>`)
        : esc(match);
      lastIndex = offset + match.length;
      return match;
    });
    html += esc(source.slice(lastIndex));
    return html;
  }

  function formatApiVideoDuration(value) {
    const totalSeconds = Math.max(0, Math.round(Number(value || 0) || 0));
    if (!totalSeconds) return '00:00';
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function renderApiVideoMessageHtml(message = {}) {
    const videoUrl = getApiVideoMessageUrl(message);
    const coverUrl = getApiVideoMessageCoverUrl(message);
    const durationText = formatApiVideoDuration(getApiVideoMessageDuration(message));
    return `<div class="api-message-bubble">
      <a class="api-message-video" href="${esc(videoUrl || '#')}" target="_blank" rel="noopener noreferrer">
        ${coverUrl
          ? `<img class="api-message-video-cover" src="${esc(coverUrl)}" alt="视频封面">`
          : `<div class="api-message-video-fallback">▶</div>`}
        <div class="api-message-video-mask"><span class="api-message-video-play"></span></div>
        <div class="api-message-video-footer">
          <span class="api-message-video-label">视频</span>
          <span class="api-message-video-duration">${esc(durationText)}</span>
        </div>
      </a>
    </div>`;
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

  function getApiSellerDisplayName(message = null, activeSession = null) {
    const state = getState();
    const sessionShopName = String(
      activeSession?.shopName
      || (state.shops || []).find(item => item.id === state.apiActiveSessionShopId)?.name
      || ''
    ).trim();
    return String(
      message?.senderName
      || state.apiTokenStatus?.serviceName
      || sessionShopName
      || state.apiTokenStatus?.mallName
      || '主账号'
    ).trim();
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
      applyApiConversationMeta(activeSession);
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
          subtitle: '请先点击“店铺管理”授权店铺登录或点击左侧会话'
        });
        return;
      }

      const displayMessages = getApiDisplayMessages(state, activeSession);
      if (!displayMessages.length) {
        container.innerHTML = renderApiEmptyStateHtml({
          title: '当前会话暂无消息',
          subtitle: '可继续等待买家消息，或手动发送一条新消息',
          detail: '如果刚切换会话，也可能是接口消息仍在加载中。'
        });
        return;
      }

      const sortedMessages = displayMessages.slice().sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      let previousTimestamp = 0;
      container.innerHTML = sortedMessages.map((message, index) => {
        const isBuyer = !!message.isFromBuyer;
        const goodsLinkInfo = extractApiGoodsLinkInfo(message);
        const fallbackGoodsCard = goodsLinkInfo ? buildApiGoodsCardFallback(goodsLinkInfo, message, activeSession) : null;
        const cachedGoodsCard = goodsLinkInfo ? state.apiGoodsCardCache?.get(goodsLinkInfo.cacheKey) : null;
        const goodsCard = goodsLinkInfo ? normalizeApiGoodsCard(
          goodsLinkInfo?.cacheKey ? { ...(cachedGoodsCard || {}), cacheKey: goodsLinkInfo.cacheKey } : (cachedGoodsCard || {}),
          goodsLinkInfo?.cacheKey ? { ...(fallbackGoodsCard || {}), cacheKey: goodsLinkInfo.cacheKey } : (fallbackGoodsCard || {})
        ) : null;
        const refundStatusUpdate = !isBuyer ? getApiRefundStatusUpdateMeta(message) : null;
        const isSystem = isApiSystemNoticeMessage(message);
        const isGoodsSourceNotice = isSystem && isApiGoodsSourceNoticeMessage(message);
        const goodsSourceCard = isGoodsSourceNotice
          ? resolveApiGoodsSourceCard(message, activeSession, goodsLinkInfo, cachedGoodsCard, { sortedMessages, messageIndex: index })
          : null;
        const refundSystemNoticeKind = isSystem ? getApiRefundSystemNoticeKind(message) : '';
        const buyerAvatar = activeSession?.customerAvatar || '';
        const buyerAvatarHtml = buyerAvatar
          ? `<img src="${esc(buyerAvatar)}" alt="">`
          : esc((state.apiActiveSessionName || '客户').slice(0, 2));
        const senderName = isBuyer ? '' : getApiSellerDisplayName(message, activeSession);
        const isRobotManaged = !isBuyer && isApiRobotManagedMessage(message);
        const sellerText = senderName.slice(0, 4) || '主账号';
        const divider = shouldShowApiMessageDivider(message.timestamp, previousTimestamp)
          ? `<div class="api-message-divider">${esc(formatApiDateTime(message.timestamp))}</div>`
          : '';
        if (refundStatusUpdate) {
          previousTimestamp = message.timestamp;
          return `${divider}<div class="api-message-item platform-card">${renderApiRefundStatusUpdateCardHtml(message, { sortedMessages, messageIndex: index, activeSession })}</div>`;
        }
        if (goodsLinkInfo && fallbackGoodsCard) {
          void ensureApiGoodsCardLoaded(goodsLinkInfo, fallbackGoodsCard);
        }
        if (isGoodsSourceNotice) {
          debugApiGoodsSourceMessage(message, activeSession, {
            goodsLinkInfo,
            goodsCard: goodsSourceCard,
          });
        }
        if (isGoodsSourceNotice && goodsSourceCard) {
          previousTimestamp = message.timestamp;
          return `${divider}<div class="api-message-item platform-card source-goods-card">
            ${renderApiGoodsSourceNoticeCardHtml(message, goodsSourceCard)}
          </div>`;
        }
        if (isSystem && goodsLinkInfo) {
          previousTimestamp = message.timestamp;
          return `${divider}<div class="api-message-item buyer goods-link-card">
            <div class="api-message-avatar">${buyerAvatarHtml}</div>
            <div class="api-message-body">
              <div class="api-message-row">
                ${renderApiGoodsCardHtml(goodsCard)}
              </div>
            </div>
          </div>`;
        }
        if (isSystem) {
          const systemVariantClass = [
            isApiUnmatchedReplyNoticeMessage(message) ? 'unmatched-reply' : '',
            refundSystemNoticeKind ? 'refund-notice' : '',
          ].filter(Boolean).join(' ');
          previousTimestamp = message.timestamp;
          return `${divider}<div class="api-message-item system${systemVariantClass ? ` ${systemVariantClass}` : ''}">
            <div class="api-message-system-bubble${systemVariantClass ? ` ${systemVariantClass}` : ''}">${renderApiSystemMessageHtml(message, { message, messageIndex: index, sortedMessages, activeSession })}</div>
          </div>`;
        }
        const avatarHtml = isBuyer
          ? (buyerAvatar ? `<img src="${esc(buyerAvatar)}" alt="">` : esc((state.apiActiveSessionName || '客户').slice(0, 2)))
          : (serviceAvatar ? `<img src="${esc(serviceAvatar)}" alt="">` : esc(sellerText));
        const readState = isBuyer ? '' : getApiMessageReadState(message);
        const statusText = readState === 'read' ? '已读' : readState === 'unread' ? '未读' : '';
        const metaHtml = isBuyer ? '' : `<div class="api-message-meta">
          ${isRobotManaged ? '<span class="api-message-robot-badge">机器人</span>' : ''}
          <span class="api-message-sender">${esc(senderName)}</span>
        </div>`;
        const imageUrl = getApiImageMessageUrl(message);
        const refundCard = !isBuyer ? extractApiRefundCard(message, activeSession) : null;
        const inviteOrderCard = !isBuyer ? extractApiInviteOrderCard(message) : null;
        const resolvedRefundCard = refundCard ? applyApiRefundStatusToCard(refundCard, sortedMessages, {
          cardIndex: index,
          activeSession,
        }) : null;
        const imageMessage = isApiImageMessage(message);
        const videoMessage = isApiVideoMessage(message);
        const bubbleHtml = resolvedRefundCard
          ? renderApiRefundCardHtml(resolvedRefundCard)
          : inviteOrderCard
          ? renderApiInviteOrderCardHtml(inviteOrderCard)
          : goodsLinkInfo
          ? renderApiGoodsCardHtml(goodsCard)
          : videoMessage
          ? renderApiVideoMessageHtml(message)
          : imageMessage
            ? `<div class="api-message-bubble"><div class="api-message-content">${imageUrl ? `<img class="api-message-image" src="${esc(imageUrl)}" alt="图片消息" data-preview-url="${esc(imageUrl)}">` : '[图片消息]'}</div></div>`
            : `<div class="api-message-bubble"><div class="api-message-content">${renderApiPddEmojiHtml(message.content || '')}</div></div>`;
        const isPlainTextSellerMessage = !isBuyer
          && !goodsLinkInfo
          && !resolvedRefundCard
          && !inviteOrderCard
          && !imageMessage
          && !videoMessage
          && String(message.content || '').trim();
        const copyButtonHtml = isBuyer && !goodsLinkInfo && !resolvedRefundCard && !inviteOrderCard && !imageMessage && !videoMessage && String(message.content || '').trim()
          ? `<button class="api-message-copy" type="button" data-message-index="${index}">复制</button>`
          : '';
        const footerHtml = isPlainTextSellerMessage
          ? `<div class="api-message-row-meta">${statusText ? `<span class="api-message-status ${readState}">${statusText}</span>` : ''}</div>`
          : '';
        previousTimestamp = message.timestamp;
        if (resolvedRefundCard) {
          return `${divider}<div class="api-message-item platform-card">${bubbleHtml}</div>`;
        }
        if (inviteOrderCard) {
          return `${divider}<div class="api-message-item platform-card invite-order-card">${bubbleHtml}</div>`;
        }
        if (goodsLinkInfo) {
          return `${divider}<div class="api-message-item buyer goods-link-card">
            <div class="api-message-avatar">${buyerAvatarHtml}</div>
            <div class="api-message-body">
              <div class="api-message-row">
                ${bubbleHtml}
              </div>
            </div>
          </div>`;
        }
        return `${divider}<div class="api-message-item ${isBuyer ? 'buyer' : 'service'}${isRobotManaged ? ' robot-managed' : ''}">
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
      container.querySelectorAll('.api-message-image[data-preview-url]').forEach(image => {
        image.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          const url = image.dataset.previewUrl || image.getAttribute('src') || '';
          if (typeof window.showApiImagePreview === 'function') {
            window.showApiImagePreview(url);
            return;
          }
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        });
      });
      container.querySelectorAll('.api-message-system-action-button').forEach(button => {
        button.addEventListener('click', async event => {
          event.stopPropagation();
          const messageIndex = Number(button.dataset.messageIndex);
          await handleApiSystemAction(button.dataset.systemAction || '', messageIndex, sortedMessages);
        });
      });
      container.querySelectorAll('.api-goods-card-copy').forEach(button => {
        button.addEventListener('click', async event => {
          event.stopPropagation();
          const goodsId = String(button.dataset.goodsId || '');
          if (!goodsId) return;
          try {
            await navigator.clipboard.writeText(goodsId);
            showApiSideOrderToast('已复制到剪切板！');
          } catch {
            showApiSideOrderToast('复制失败，请稍后重试');
          }
        });
      });
      container.querySelectorAll('.api-goods-card-clickable').forEach(cardEl => {
        cardEl.addEventListener('click', async event => {
          const target = event.target;
          if (target instanceof Element && target.closest('.api-goods-card-copy, .api-goods-card-spec')) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const state = getState();
          const shopId = String(state.apiActiveSessionShopId || '');
          const goodsId = String(cardEl.dataset.goodsId || '');
          const url = String(cardEl.dataset.goodsUrl || '');
          const title = String(cardEl.dataset.goodsTitle || '').trim() || '商品详情';
          if (!shopId) {
            showApiSideOrderToast('当前会话缺少店铺信息，无法打开商品详情');
            return;
          }
          if (!goodsId && !url) {
            showApiSideOrderToast('当前商品缺少商品ID，无法打开详情');
            return;
          }
          if (!window.pddApi?.openProductDetailWindow) {
            showApiSideOrderToast('商品详情窗口能力未就绪');
            return;
          }
          try {
            const result = await window.pddApi.openProductDetailWindow({
              shopId,
              goodsId,
              url,
              title,
            });
            if (result?.error) {
              showApiSideOrderToast(result.error || '打开商品详情失败');
            }
          } catch (error) {
            showApiSideOrderToast(error?.message || '打开商品详情失败');
          }
        });
      });
      container.querySelectorAll('.api-goods-card-spec').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          let inlineSpecItems = [];
          try {
            inlineSpecItems = normalizeApiGoodsSpecItems(JSON.parse(button.dataset.goodsSpecItems || '[]'));
          } catch {}
          const state = getState();
          const cacheKey = String(button.dataset.goodsCacheKey || '');
          const cachedCard = cacheKey ? state.apiGoodsCardCache?.get(cacheKey) : null;
          window.openApiGoodsSpecModal?.(normalizeApiGoodsCard(cachedCard || {}, {
            cacheKey,
            goodsId: button.dataset.goodsId || '',
            url: button.dataset.goodsUrl || '',
            title: button.dataset.goodsTitle || '',
            imageUrl: button.dataset.goodsImageUrl || '',
            priceText: button.dataset.goodsPriceText || '',
            groupText: button.dataset.goodsGroupText || '',
            specText: button.dataset.goodsSpecText || '查看商品规格',
            specItems: inlineSpecItems,
            stockText: button.dataset.goodsStockText || '',
            salesText: button.dataset.goodsSalesText || '',
            pendingGroupText: button.dataset.goodsPendingGroupText || '',
          }));
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
    const msgTypeSource = message?.msgType ?? message?.raw?.msg_type ?? message?.raw?.message_type ?? message?.raw?.content_type ?? message?.raw?.type ?? message?.type ?? '';
    const msgType = String(msgTypeSource || '').toLowerCase();
    if (['2', 'image', 'img', 'pic', 'picture'].includes(msgType)) return true;
    const extraType = String(message?.extra?.type || message?.raw?.extra?.type || message?.raw?.ext?.type || '').toLowerCase();
    if (['image', 'img', 'pic', 'picture'].includes(extraType)) return true;
    if (['emoji', 'sticker', 'emoticon', 'expression', 'face'].includes(extraType)) {
      return !!getApiImageMessageUrl(message);
    }
    const rawContent = `${message?.content || ''} ${message?.raw?.content || ''} ${message?.raw?.msg_content || ''}`.toLowerCase();
    if (/\[(图片|image|表情|贴纸|emoji|sticker)\]/.test(rawContent)) return true;
    if (/(picture_url|image_url|img_url|emoji_url|sticker_url)/.test(rawContent)) return true;
    if (/https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?/.test(rawContent)) return true;
    return !!getApiImageMessageUrl(message);
  }

  function getApiImageMessageUrl(message = {}) {
    const isLikelyImageUrl = value => {
      const text = String(value || '').trim();
      if (!text) return false;
      if (text.startsWith('data:image/')) return true;
      return /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(text);
    };
    const candidates = [
      message?.extra?.url,
      message?.extra?.picture_url,
      message?.extra?.image_url,
      message?.extra?.img_url,
      message?.extra?.emoji_url,
      message?.extra?.sticker_url,
      message?.extra?.expression_url,
      message?.extra?.emoticon_url,
      message?.extra?.face_url,
      message?.extra?.preview_url,
      message?.extra?.previewUrl,
      message?.extra?.image?.url,
      message?.extra?.emoji?.url,
      message?.extra?.sticker?.url,
      message?.raw?.extra?.url,
      message?.raw?.extra?.picture_url,
      message?.raw?.extra?.image_url,
      message?.raw?.extra?.img_url,
      message?.raw?.extra?.emoji_url,
      message?.raw?.extra?.sticker_url,
      message?.raw?.extra?.expression_url,
      message?.raw?.extra?.emoticon_url,
      message?.raw?.extra?.face_url,
      message?.raw?.ext?.url,
      message?.raw?.ext?.picture_url,
      message?.raw?.ext?.image_url,
      message?.raw?.ext?.img_url,
      message?.raw?.ext?.emoji_url,
      message?.raw?.ext?.sticker_url,
      message?.raw?.ext?.expression_url,
      message?.raw?.ext?.emoticon_url,
      message?.raw?.ext?.face_url,
      message?.raw?.info?.url,
      message?.raw?.info?.picture_url,
      message?.raw?.info?.image_url,
      message?.raw?.info?.img_url,
      message?.raw?.info?.emoji_url,
      message?.raw?.info?.sticker_url,
      message?.raw?.info?.expression_url,
      message?.raw?.info?.emoticon_url,
      message?.raw?.info?.face_url,
      message?.raw?.info?.preview?.url,
    ].filter(Boolean);
    const firstCandidate = candidates.find(isLikelyImageUrl) || candidates[0];
    if (firstCandidate && isLikelyImageUrl(firstCandidate)) return String(firstCandidate);
    const rawText = `${message?.content || ''} ${message?.raw?.content || ''} ${message?.raw?.msg_content || ''}`;
    const urlMatch = rawText.match(/https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?/i);
    if (urlMatch) return urlMatch[0];
    const jsonMatch = rawText.match(/\{[^{}]*"(picture_url|image_url|img_url|emoji_url|sticker_url)"\s*:\s*"([^"]+)"[^{}]*\}/);
    return jsonMatch?.[2] || '';
  }

  function isApiVideoMessage(message = {}) {
    const msgTypeSource = message?.msgType ?? message?.raw?.msg_type ?? message?.raw?.message_type ?? message?.raw?.content_type ?? message?.raw?.type ?? message?.type ?? '';
    const msgType = String(msgTypeSource || '').toLowerCase();
    if (['14', 'video', 'short_video', 'small_video'].includes(msgType)) return true;
    const rawContent = `${message?.content || ''} ${message?.raw?.content || ''} ${message?.raw?.msg_content || ''}`.toLowerCase();
    if (/(video_cover_url|f20_url|f30_url|transcode_f30_url|library_file)/.test(rawContent)) return true;
    if (/https?:\/\/\S+\.(mp4|mov|m4v|webm|avi|mkv)(\?\S*)?/i.test(rawContent)) return true;
    return !!getApiVideoMessageUrl(message);
  }

  function getApiVideoMessageUrl(message = {}) {
    const candidates = [
      message?.extra?.video?.url,
      message?.extra?.url,
      message?.extra?.video_url,
      message?.extra?.f30_url,
      message?.extra?.f20_url,
      message?.raw?.extra?.video?.url,
      message?.raw?.extra?.url,
      message?.raw?.extra?.video_url,
      message?.raw?.extra?.f30_url,
      message?.raw?.extra?.f20_url,
      message?.raw?.ext?.url,
      message?.raw?.ext?.video_url,
      message?.raw?.ext?.f30_url,
      message?.raw?.ext?.f20_url,
      message?.raw?.info?.download_url,
      message?.raw?.info?.downloadUrl,
      message?.raw?.info?.url,
    ].filter(Boolean);
    if (candidates.length) return String(candidates[0] || '');
    const rawText = `${message?.content || ''} ${message?.raw?.content || ''} ${message?.raw?.msg_content || ''}`;
    const urlMatch = rawText.match(/https?:\/\/\S+\.(mp4|mov|m4v|webm|avi|mkv)(\?\S*)?/i);
    return urlMatch?.[0] || '';
  }

  function getApiVideoMessageCoverUrl(message = {}) {
    return String(
      message?.extra?.video?.coverUrl
      || message?.extra?.coverUrl
      || message?.extra?.video_cover_url
      || message?.raw?.extra?.video?.coverUrl
      || message?.raw?.extra?.coverUrl
      || message?.raw?.extra?.video_cover_url
      || message?.raw?.ext?.video_cover_url
      || message?.raw?.info?.preview?.url
      || ''
    );
  }

  function getApiVideoMessageDuration(message = {}) {
    return Number(
      message?.extra?.video?.duration
      || message?.extra?.duration
      || message?.raw?.extra?.video?.duration
      || message?.raw?.extra?.duration
      || message?.raw?.ext?.duration
      || 0
    ) || 0;
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

  function buildApiSessionListRenderSignature(state, sessions, extra = {}) {
    const activeKey = getApiSessionKey(state.apiActiveSessionShopId, state.apiActiveSessionId);
    const sessionSignature = sessions.map(session => [
      getApiSessionKey(session),
      getApiTimeMs(session.lastMessageTime),
      Number(session.unreadCount || 0),
      session.lastMessageActor || '',
      session.lastMessage || '',
      session.customerName || '',
      session.shopName || '',
      getApiSessionGroupNumber(session),
      formatApiPendingReplyText(session),
    ].join('::')).join('||');
    return [
      state.apiSessionTab || 'latest',
      state.apiSelectedShopId || '',
      state.apiSessionKeyword || '',
      activeKey,
      extra.latestCount || 0,
      extra.starredCount || 0,
      extra.unreadTotal || 0,
      state.apiSessionLoadError || '',
      sessionSignature,
    ].join('###');
  }

  function buildApiSessionItemRenderSignature(session = {}, state = {}) {
    const active = getApiSessionKey(session) === getApiSessionKey(state.apiActiveSessionShopId, state.apiActiveSessionId);
    const unread = Number(session.unreadCount || 0);
    const pendingReplyText = formatApiPendingReplyText(session);
    return [
      getApiSessionKey(session),
      active ? 1 : 0,
      unread,
      session.customerName || '',
      session.customerId || '',
      session.customerAvatar || '',
      session.shopName || '',
      session.lastMessage || '',
      getApiTimeMs(session.lastMessageTime),
      getApiSessionGroupNumber(session),
      pendingReplyText,
    ].join('###');
  }

  function buildApiSessionItemHtml(session = {}, state = {}) {
    const active = getApiSessionKey(session) === getApiSessionKey(state.apiActiveSessionShopId, state.apiActiveSessionId);
    const unread = Number(session.unreadCount || 0);
    const pendingReply = hasApiPendingReply(session);
    const pendingReplyText = pendingReply ? formatApiPendingReplyText(session) : '';
    const groupNumber = getApiSessionGroupNumber(session);
    const orderTagHtml = groupNumber >= 1
      ? `<span class="api-session-order-tag">订单 ${esc(String(groupNumber))}</span>`
      : '';
    const avatarHtml = session.customerAvatar ? `<img src="${esc(session.customerAvatar)}" alt="">` : '';
    return `<div class="api-session-item ${active ? 'active' : ''} ${pendingReply ? 'reply-pending' : ''} ${unread > 0 ? 'has-unread' : ''}" data-session-key="${esc(getApiSessionKey(session))}" data-session-id="${esc(session.sessionId)}" data-shop-id="${esc(session.shopId)}" data-customer-name="${esc(session.customerName || '')}">
      <div class="api-session-avatar">${avatarHtml}</div>
      <div class="api-session-main">
        <div class="api-session-item-title">
          <div class="api-session-item-info-row">
            <div class="api-session-item-name">
              <span class="api-session-item-name-text">${esc(session.customerName || session.customerId || '未知客户')}</span>
              ${orderTagHtml}
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
  }

  function createApiSessionItemNode(session = {}, state = {}) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildApiSessionItemHtml(session, state).trim();
    const node = wrapper.firstElementChild;
    if (!node) return null;
    node.dataset.renderSignature = buildApiSessionItemRenderSignature(session, state);
    node.onclick = async () => {
      await openApiSession(node.dataset.sessionId, node.dataset.customerName, node.dataset.shopId);
    };
    return node;
  }

  function patchApiSessionListDom(container, sessions, state) {
    const existingItems = Array.from(container.querySelectorAll('.api-session-item'));
    container.querySelectorAll('.api-empty').forEach(node => node.remove());
    const existingMap = new Map(existingItems.map(item => [item.dataset.sessionKey || '', item]));
    const desiredKeys = new Set();

    sessions.forEach((session, index) => {
      const sessionKey = getApiSessionKey(session);
      desiredKeys.add(sessionKey);
      let node = existingMap.get(sessionKey) || null;
      const nextSignature = buildApiSessionItemRenderSignature(session, state);

      if (!node || node.dataset.renderSignature !== nextSignature) {
        const nextNode = createApiSessionItemNode(session, state);
        if (!nextNode) return;
        if (node) {
          node.replaceWith(nextNode);
        }
        node = nextNode;
      } else {
        node.dataset.customerName = String(session.customerName || '');
        node.onclick = async () => {
          await openApiSession(node.dataset.sessionId, node.dataset.customerName, node.dataset.shopId);
        };
      }

      const anchor = container.children[index] || null;
      if (anchor !== node) {
        container.insertBefore(node, anchor);
      }
    });

    existingItems.forEach(item => {
      const sessionKey = item.dataset.sessionKey || '';
      if (desiredKeys.has(sessionKey)) return;
      item.remove();
    });
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
    const selectableShops = getApiSelectableShops();
    const title = state.apiSelectedShopId === state.API_ALL_SHOPS
      ? '全部店铺会话'
      : (selectedShop?.name || '未命名店铺');
    const meta = state.apiSelectedShopId === state.API_ALL_SHOPS
      ? `当前可用 ${selectableShops.length} 家店铺，左侧展示全部店铺的新消息会话`
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

  async function refreshApiSessionListAfterRealtimeUpdate() {
    const state = getState();
    if (state.apiSessionKeyword || state.apiSessionTab === 'starred') {
      await syncApiSelectionWithFilter();
    } else {
      renderApiSessions();
    }
    callRuntime('renderApiSideCards');
  }

  function getApiSessionUpdateBatchDelay(state = getState()) {
    const currentCount = Number(state?.apiSessions?.length || 0) || 0;
    return currentCount > 0 ? API_SESSION_UPDATE_BATCH_DELAY_MS : API_SESSION_INITIAL_BATCH_DELAY_MS;
  }

  async function flushPendingApiSessionUpdates() {
    if (apiPendingSessionUpdateTimer) {
      clearTimeout(apiPendingSessionUpdateTimer);
      apiPendingSessionUpdateTimer = null;
    }
    if (!apiPendingSessionUpdates.size && !apiPendingSessionUpserts.size) return;
    const pendingPayloads = Array.from(apiPendingSessionUpdates.values());
    const pendingUpserts = Array.from(apiPendingSessionUpserts.values());
    const shouldRefreshTraffic = apiPendingSessionUpdateNeedsTrafficRefresh;
    const pendingHint = apiPendingSessionUpdateHint;
    apiPendingSessionUpdates.clear();
    apiPendingSessionUpserts.clear();
    apiPendingSessionUpdateNeedsTrafficRefresh = false;
    apiPendingSessionUpdateHint = '';
    pendingPayloads.forEach(payload => {
      if (!Array.isArray(payload?.sessions)) return;
      mergeApiSessionsForShop(payload.shopId, payload.sessions);
    });
    pendingUpserts.forEach(session => {
      upsertApiSession(session);
    });
    await refreshApiSessionListAfterRealtimeUpdate();
    if (shouldRefreshTraffic && getState().currentView === 'chat-api') {
      await loadApiTraffic(getApiStatusShopId(true));
    }
    if (pendingHint) {
      setApiHint(pendingHint);
    }
  }

  function schedulePendingApiSessionUpdates() {
    if (apiPendingSessionUpdateTimer) return;
    apiPendingSessionUpdateTimer = setTimeout(() => {
      flushPendingApiSessionUpdates().catch(error => {
        emitRendererDebug('chat-api', 'flushPendingApiSessionUpdates error', {
          message: error?.message || String(error || ''),
        });
      });
    }, getApiSessionUpdateBatchDelay());
  }

  function shouldBatchApiSessionUpdate(payload, state = getState()) {
    return !!payload?.shopId
      && payload.shopId !== state.API_ALL_SHOPS
      && state.apiSelectedShopId === state.API_ALL_SHOPS;
  }

  function queuePendingApiSessionUpdate(payload) {
    if (!payload?.shopId || !Array.isArray(payload?.sessions)) return false;
    apiPendingSessionUpdates.set(payload.shopId, {
      shopId: payload.shopId,
      sessions: payload.sessions,
    });
    if (getState().currentView === 'chat-api') {
      apiPendingSessionUpdateNeedsTrafficRefresh = true;
    }
    schedulePendingApiSessionUpdates();
    return true;
  }

  function queuePendingApiSessionUpsert(session = {}, hint = '') {
    const normalizedShopId = String(session?.shopId || '').trim();
    const normalizedSessionId = String(session?.sessionId || '').trim();
    if (!normalizedShopId || !normalizedSessionId) return false;
    const sessionKey = getApiSessionKey(normalizedShopId, normalizedSessionId);
    apiPendingSessionUpserts.set(sessionKey, {
      ...session,
      shopId: normalizedShopId,
      sessionId: normalizedSessionId,
    });
    if (hint) {
      apiPendingSessionUpdateHint = hint;
    }
    if (getState().currentView === 'chat-api') {
      apiPendingSessionUpdateNeedsTrafficRefresh = true;
    }
    schedulePendingApiSessionUpdates();
    return true;
  }

  function hasRenderableApiIncomingMessage(message = {}) {
    const text = String(message?.content ?? message?.text ?? '').trim();
    return !!(text || message?.refundCard || message?.refundStatusUpdate);
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
      const scopedSessions = getApiScopedSessions();
      const unreadTotal = scopedSessions.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);
      const renderSignature = buildApiSessionListRenderSignature(state, sessions, {
        latestCount: latestSessions.length,
        starredCount: starredSessions.length,
        unreadTotal,
      });
      document.getElementById('apiLatestSessionCount').textContent = String(latestSessions.length);
      document.getElementById('apiStarredSessionCount').textContent = String(starredSessions.length);
      document.getElementById('apiSessionSummary').textContent = state.apiSessionTab === 'starred'
        ? `已收藏 ${starredSessions.length} 条会话`
        : `${sessions.length}/${scopedSessions.length} 条会话`;
      document.getElementById('apiTodoHint').textContent = unreadTotal > 0
        ? `当前有 ${unreadTotal} 条未读待处理消息`
        : (state.apiSessionTab === 'starred' ? '当前没有收藏会话' : '当前没有待处理接口会话');
      document.getElementById('apiSidebarLatest').classList.toggle('active', state.apiSessionTab === 'latest');
      document.getElementById('apiSidebarStarred').classList.toggle('active', state.apiSessionTab === 'starred');
      renderApiShopHeader();
      if (!sessions.length) {
        const emptyText = state.apiSessionTab === 'starred'
          ? '暂无收藏会话，可在右侧按钮中添加收藏。'
          : (state.apiSessionLoadError || '暂无接口会话数据，请先操作后台页面或刷新接口会话。');
        if (apiSessionListRenderSignature === renderSignature) {
          return;
        }
        container.innerHTML = `<div class="api-empty">${esc(emptyText)}</div>`;
        apiSessionListRenderSignature = renderSignature;
        apiPendingReplySignature = '';
        emitRendererDebug('chat-api', 'renderApiSessions empty-dom', { htmlLength: container.innerHTML.length });
        return;
      }

      if (apiSessionListRenderSignature === renderSignature) {
        return;
      }
      patchApiSessionListDom(container, sessions, state);
      apiSessionListRenderSignature = renderSignature;
      emitRendererDebug('chat-api', 'renderApiSessions dom-ready', {
        itemCount: container.querySelectorAll('.api-session-item').length,
        htmlLength: container.innerHTML.length
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
      requestedText: text,
      text: result?.text || text,
    };
    recordApiSyncState('发送成功', `会话：${state.apiActiveSessionName || state.apiActiveSessionId}`);
    clearApiPendingReplyState(successPayload);
    appendApiLocalServiceMessage(successPayload);
    const input = document.getElementById('apiMessageInput');
    if (input) input.value = '';
    if (result?.sendMode === 'pending-confirm') {
      setApiHint('当前会话命中平台待确认回复，已按平台待确认消息发送');
      return;
    }
    setApiHint('消息已通过人工发送接口下发，正在同步最新消息');
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

  function handleApiRisk(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
    }
  }

  function handleApiRiskMenuAction(action) {
    const state = getState();
    if (!state.apiActiveSessionId) {
      setApiHint('请先选择一个接口会话');
      return;
    }
    if (action === 'report') {
      setApiHint('举报功能开发中');
      return;
    }
    if (action === 'blacklist') {
      setApiHint('拉黑功能开发中');
      return;
    }
    if (action === 'manage') {
      setApiHint('黑名单管理功能开发中');
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
    if (shouldBatchApiSessionUpdate(payload, state)) {
      queuePendingApiSessionUpdate(payload);
      return;
    }
    if (Array.isArray(payload?.sessions)) {
      mergeApiSessionsForShop(payload.shopId, payload.sessions);
      await refreshApiSessionListAfterRealtimeUpdate();
    }
    if (getState().currentView === 'chat-api') {
      await loadApiTraffic(getApiStatusShopId(true));
    }
  }

  async function handleApiNewMessage(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    recordApiSyncState('轮询新消息', `会话：${payload?.customer || payload?.sessionId || '未知会话'}`);
    const nextState = getState();
    const isCurrentSession = String(payload?.sessionId || '') === String(nextState.apiActiveSessionId)
      && String(payload?.shopId || '') === String(nextState.apiActiveSessionShopId || '');
    const fallbackIncomingMessage = payload?.text
      ? [{
        messageId: payload?.messageId || '',
        text: payload.text,
        content: payload.text,
        timestamp: payload?.timestamp || Date.now(),
        isFromBuyer: true,
        senderName: payload?.customer || payload?.session?.customerName || '',
        raw: payload?.raw && typeof payload.raw === 'object' ? payload.raw : {},
      }]
      : [];
    const incomingMessages = Array.isArray(payload?.messages) && payload.messages.length
      ? payload.messages
      : fallbackIncomingMessage;
    if (!isCurrentSession && payload?.shopId && payload?.sessionId) {
      const nextSession = {
        ...(payload?.session && typeof payload.session === 'object' ? payload.session : {}),
        shopId: payload.shopId,
        sessionId: payload.sessionId,
        customerName: payload?.customer || payload?.session?.customerName || '',
        customerId: payload?.customerId || payload?.session?.customerId || payload?.session?.userUid || '',
        lastMessage: payload?.text || payload?.session?.lastMessage || '',
        lastMessageTime: payload?.timestamp || payload?.session?.lastMessageTime || Date.now(),
        unreadCount: Math.max(Number(payload?.session?.unreadCount || 0) || 0, 1),
      };
      if (state.apiSelectedShopId === state.API_ALL_SHOPS) {
        queuePendingApiSessionUpsert(nextSession, `收到接口新消息：${payload?.customer || '未知客户'}`);
        return;
      }
      upsertApiSession(nextSession);
      await refreshApiSessionListAfterRealtimeUpdate();
      await loadApiTraffic(getApiStatusShopId(true));
      setApiHint(`收到接口新消息：${payload?.customer || '未知客户'}`);
      return;
    }
    if (isCurrentSession && incomingMessages.length) {
      await loadApiTraffic(getApiStatusShopId(true));
      upsertApiSession({
        ...(payload?.session && typeof payload.session === 'object' ? payload.session : {}),
        shopId: payload.shopId || nextState.apiActiveSessionShopId,
        sessionId: payload.sessionId || nextState.apiActiveSessionId,
        customerName: payload?.customer || payload?.session?.customerName || nextState.apiActiveSessionName || '',
        customerId: payload?.customerId || payload?.session?.customerId || payload?.session?.userUid || '',
        lastMessage: payload?.text || payload?.session?.lastMessage || '',
        lastMessageTime: payload?.timestamp || payload?.session?.lastMessageTime || Date.now(),
        unreadCount: 0,
        lastMessageActor: 'buyer',
        lastMessageIsFromBuyer: true,
      });
      await refreshApiSessionListAfterRealtimeUpdate();
      let appendedCount = 0;
      incomingMessages.forEach(message => {
        if (!hasRenderableApiIncomingMessage(message)) return;
        const appended = callRuntime('appendApiIncomingMessage', {
          ...message,
          shopId: payload.shopId || message?.shopId || nextState.apiActiveSessionShopId,
          sessionId: payload.sessionId || message?.sessionId || nextState.apiActiveSessionId,
        });
        if (appended) appendedCount += 1;
      });
      if (appendedCount === 0) {
        await openApiSession(
          payload.sessionId || nextState.apiActiveSessionId,
          payload?.customer || payload?.session?.customerName || nextState.apiActiveSessionName || '',
          payload.shopId || nextState.apiActiveSessionShopId,
          { silentStatus: true, preserveMessages: true, forceRefresh: true }
        );
      }
    }
    setApiHint(`收到接口新消息：${payload?.customer || '未知客户'}`);
  }

  function handleApiBootstrapInspect(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customerName || payload?.sessionId || '未知会话';
    const previewText = String(payload?.previewText || '').trim() || '空';
    const pickedText = String(payload?.pickedPendingText || '').trim() || '无';
    const actor = String(payload?.lastMessageActor || 'unknown');
    const unread = Number(payload?.unreadCount || 0) || 0;
    const detail = `会话：${sessionText}；预览：${previewText}；识别：${pickedText}；actor：${actor}；未读：${unread}；emit：${payload?.willEmitPending ? '是' : '否'}`;
    recordApiSyncState('Bootstrap检查', detail);
  }

  async function handleApiMessageSent(payload) {
    await refreshApiAfterMessageSent(payload);
  }

  function handleApiReadMarkUpdated(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    applyApiReadMarkUpdate(payload);
  }

  function handleApiAutoReplySent(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || payload?.conversationId || payload?.sessionId || '未知会话';
    const ruleText = payload?.ruleName ? `，规则：${payload.ruleName}` : '';
    const sendModeText = payload?.sendMode === 'pending-confirm'
      ? '，按平台待确认消息发送'
      : (payload?.sendMode === 'manual-interface' ? '，通过人工发送接口下发' : '');
    recordApiSyncState('自动回复成功', `会话：${sessionText}${ruleText}${sendModeText}`);
    if (payload?.sendMode === 'pending-confirm') {
      setApiHint(`自动回复已按平台待确认消息发送：${sessionText}`);
      return;
    }
    setApiHint(`自动回复已通过人工发送接口下发：${sessionText}`);
  }

  function handleApiAutoReplyError(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || payload?.sessionId || '未知会话';
    const errorText = payload?.error || '未知错误';
    const errorCode = Number(payload?.errorCode || 0) || 0;
    const isPlatformPaused = /机器人已暂停接待，请人工跟进/.test(errorText)
      || (payload?.phase === 'fallback-send' && (errorCode === 40013 || /code=40013/.test(errorText)));
    recordApiSyncState('自动回复失败', `会话：${sessionText}，${errorText}`);
    if (isPlatformPaused) {
      appendApiLocalServiceMessage({
        shopId: payload?.shopId || '',
        sessionId: payload?.sessionId || '',
        text: '机器人已暂停接待，请人工跟进',
        isSystem: true,
        syntheticKey: `platform-paused::${payload?.shopId || ''}::${payload?.sessionId || ''}`,
        timestamp: Date.now(),
      });
    }
    setApiHint(`自动回复失败：${errorText}`);
  }

  function handleApiUnmatchedMessage(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || '未知会话';
    recordApiSyncState('自动回复未命中', `会话：${sessionText}，将发送兜底回复`);
    setApiHint(`未命中规则，准备发送兜底：${sessionText}`);
  }

  function handleApiFallbackScheduled(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || payload?.sessionId || '未知会话';
    const seconds = Math.max(0, Math.ceil(Number(payload?.delayMs || 0) / 1000));
    recordApiSyncState('兜底排队', `会话：${sessionText}，${seconds} 秒后发送`);
    setApiHint(`兜底已排队：${sessionText}`);
  }

  function handleApiFallbackTriggered(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || payload?.sessionId || '未知会话';
    recordApiSyncState('兜底触发', `会话：${sessionText}，准备执行发送`);
    setApiHint(`兜底开始执行：${sessionText}`);
  }

  function handleApiFallbackSendStart(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || payload?.sessionId || '未知会话';
    recordApiSyncState('兜底发送', `会话：${sessionText}，已进入人工发送链路`);
    setApiHint(`兜底进入人工发送链路：${sessionText}`);
  }

  function handleApiFallbackCancelled(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || '未知会话';
    recordApiSyncState('兜底取消', `会话：${sessionText}，原因：${payload?.reason || '未知原因'}`);
    setApiHint(`兜底已取消：${sessionText}`);
  }

  function handleApiFallbackSkipped(payload) {
    const state = getState();
    if (payload?.shopId && state.apiSelectedShopId !== state.API_ALL_SHOPS && payload.shopId !== state.apiSelectedShopId) return;
    const sessionText = payload?.customer || '未知会话';
    const seconds = Math.max(0, Math.ceil(Number(payload?.remainingMs || 0) / 1000));
    recordApiSyncState('兜底跳过', `会话：${sessionText}，冷却剩余 ${seconds} 秒`);
    setApiHint(`兜底冷却中：${sessionText}`);
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
      await handleApiSessionSearchSubmit();
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
    document.getElementById('btnApiRiskReport')?.addEventListener('click', () => handleApiRiskMenuAction('report'));
    document.getElementById('btnApiRiskBlacklist')?.addEventListener('click', () => handleApiRiskMenuAction('blacklist'));
    document.getElementById('btnApiRiskManage')?.addEventListener('click', () => handleApiRiskMenuAction('manage'));
    document.getElementById('btnApiStar')?.addEventListener('click', handleApiStar);
    // 退款 modal、邀请下单 / 邀请关注、小额打款 modal 的事件绑定已分别迁出至
    // src/renderer/chat-api/modules/refund-modal.js
    // src/renderer/chat-api/modules/invite-order-modal.js
    // src/renderer/chat-api/modules/small-payment-modal.js
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
    window.pddApi.onApiBootstrapInspect?.(handleApiBootstrapInspect);
    window.pddApi.onApiMessageSent(handleApiMessageSent);
    window.pddApi.onApiReadMarkUpdated?.(handleApiReadMarkUpdated);
    window.pddApi.onAutoReplySent(handleApiAutoReplySent);
    window.pddApi.onAutoReplyError?.(handleApiAutoReplyError);
    window.pddApi.onUnmatchedMessage(handleApiUnmatchedMessage);
    window.pddApi.onFallbackScheduled?.(handleApiFallbackScheduled);
    window.pddApi.onFallbackTriggered?.(handleApiFallbackTriggered);
    window.pddApi.onFallbackSendStart?.(handleApiFallbackSendStart);
    window.pddApi.onFallbackSkipped?.(handleApiFallbackSkipped);
    window.pddApi.onFallbackCancelled(handleApiFallbackCancelled);
    window.pddApi.onApiAuthExpired(handleApiAuthExpired);
    renderApiSideOrders();
  }

  window.setApiHint = setApiHint;
  window.toggleApiEmojiPanel = toggleApiEmojiPanel;
  window.syncApiEmojiPanelPosition = syncApiEmojiPanelPosition;
  window.insertApiMessageText = insertApiMessageText;
  window.__chatApiModuleFns = {
    renderApiPddEmojiHtml,
    extractApiGoodsLinkInfo,
    pickApiGoodsText,
    pickApiGoodsNumber,
    formatApiGoodsPrice,
    normalizeApiGoodsSpecItems,
    buildApiGoodsSpecFallbackItems,
    normalizeApiGoodsCard,
    isMeaningfulApiGoodsCard,
    describeApiGoodsCardResult,
    buildApiGoodsCardFallback,
    getApiSystemNoticeText,
    isApiUnmatchedReplyNoticeMessage,
    getApiRefundSystemNoticeKind,
    getApiRefundSystemNoticeDisplayText,
    isApiSystemNoticeMessage,
    isApiGoodsSourceNoticeMessage,
    debugApiGoodsSourceMessage,
    resolveApiGoodsSourceCard,
    renderApiGoodsSourceNoticeCardHtml,
    renderApiEmojiPanel,
    renderApiShopHeader,
    renderApiSessions,
    renderApiMessages,
    renderApiPhrasePanel,
    renderApiSideOrders,
    renderApiGoodsCardHtml,
    renderApiRefundCardHtml,
    getApiRefundStatusUpdateMeta,
    extractApiInviteOrderCard,
    isApiInviteOrderTemplateMessage,
    renderApiInviteOrderCardHtml,
    renderApiVideoMessageHtml,
    renderApiSystemMessageHtml,
    renderApiRefundSystemNoticeCardHtml,
    renderApiRefundStatusUpdateCardHtml,
    ensureApiGoodsCardLoaded,
    getApiSellerDisplayName,
  };
  window.renderApiPddEmojiHtml = renderApiPddEmojiHtml;
  window.renderApiEmojiPanel = renderApiEmojiPanel;
  window.renderApiShopHeader = renderApiShopHeader;
  window.renderApiSessions = renderApiSessions;
  window.renderApiMessages = renderApiMessages;
  window.renderApiPhrasePanel = renderApiPhrasePanel;
  window.renderApiSideOrders = renderApiSideOrders;
  window.invalidateApiSideOrders = invalidateApiSideOrders;
  window.syncApiSelectionWithFilter = syncApiSelectionWithFilter;
  // window.openApiInviteOrderModal / closeApiInviteOrderModal / closeApiInviteOrderSpecModal
  // 改由 src/renderer/chat-api/modules/invite-order-modal.js 自行挂载到 window
  // window.openApiGoodsSpecModal / closeApiGoodsSpecModal
  // 改由 src/renderer/chat-api/modules/goods-spec-modal.js 自行挂载到 window

  // 共享给 chat-api 子模块（small-payment-modal / invite-order-modal / refund-modal 等）的工具桥接
  // 子模块统一通过 window.__chatApiModuleHelpers 取这些闭包内的函数
  window.__chatApiModuleHelpers = {
    esc,
    setApiHint,
    recordApiSyncState,
    getApiSessionKey,
    getApiSideOrderItem,
    showApiSideOrderToast,
    closeApiSideOrderPriceEditor,
    formatApiSideOrderMoneyNumber,
    getApiSideOrderPriceBaseAmount,
    ensureApiSideOrderSessionScope,
    getApiSideOrderSession,
    getApiSideOrderEntry,
    loadApiSideOrders,
    getApiSideOrderStore: () => apiSideOrderStore,
    // 退款相关字段拾取与金额工具：modal 与卡片渲染层共用
    pickApiRefundText,
    pickApiRefundNumber,
    pickApiDisplayAfterSalesStatus,
    resolveApiRefundShippingInfo,
    resolveApiRefundOrderStatusText,
    formatApiRefundAmount,
    formatApiRefundPaidText,
    normalizeApiRefundAmountByKeys,
    normalizeApiRefundAmountText,
    normalizeApiRefundAmountInputValue,
    formatApiRefundAmountInputValue,
    clampApiRefundAmountInputValue,
    // 商品链接 / 卡片回退：refund modal 用来从消息里挖订单候选
    extractApiGoodsLinkInfo,
    buildApiGoodsCardFallback,
    // 商品卡片规范化：goods-spec-modal 拉取真实卡片后用来归一
    normalizeApiGoodsCard,
    normalizeApiGoodsSpecItems,
    buildApiGoodsSpecFallbackItems,
    resetApiSideOrderRemarkEditorFlags() {
      apiSideOrderRemarkState = {
        ...apiSideOrderRemarkState,
        visible: false,
        loading: false,
        saving: false,
        error: '',
      };
    },
  };

  // 与 index.html inline script 完全等价的工具/谓词函数，统一在此暴露
  // 让 inline script 删除同名副本后，依旧能通过全局调用走到模块版本
  window.applyApiChatFollowStatus = applyApiChatFollowStatus;
  window.buildApiRefundCardRows = buildApiRefundCardRows;
  window.buildApiSystemActionHtml = buildApiSystemActionHtml;
  window.extractApiStructuredNoticeEntryText = extractApiStructuredNoticeEntryText;
  window.getApiImageMessageUrl = getApiImageMessageUrl;
  window.getApiMessageReadState = getApiMessageReadState;
  window.getApiRefundStatusUpdateMeta = getApiRefundStatusUpdateMeta;
  window.getApiSessionGenderValue = getApiSessionGenderValue;
  window.getApiSessionGroupNumber = getApiSessionGroupNumber;
  window.getApiVideoMessageCoverUrl = getApiVideoMessageCoverUrl;
  window.getApiVideoMessageDuration = getApiVideoMessageDuration;
  window.getApiVideoMessageUrl = getApiVideoMessageUrl;
  window.isApiImageMessage = isApiImageMessage;
  window.isApiRefundDefaultSellerNoteText = isApiRefundDefaultSellerNoteText;
  window.isApiRefundPendingNoticeText = isApiRefundPendingNoticeText;
  window.isApiRefundSuccessNoticeText = isApiRefundSuccessNoticeText;
  window.isApiVideoMessage = isApiVideoMessage;
  window.isSameApiInviteOrderCard = isSameApiInviteOrderCard;
  window.normalizeApiInviteOrderCard = normalizeApiInviteOrderCard;
  window.normalizeApiInviteOrderComparableText = normalizeApiInviteOrderComparableText;
  window.normalizeApiSystemActionText = normalizeApiSystemActionText;
  window.normalizeApiSystemComparableText = normalizeApiSystemComparableText;
  window.resolveApiRefundCardFooterText = resolveApiRefundCardFooterText;
  window.resolveApiRefundStatusFooterText = resolveApiRefundStatusFooterText;
  window.shouldShowApiMessageDivider = shouldShowApiMessageDivider;

  // 历史上 inline script 通过 __chatApiModuleFns?.xxx 转发的纯 stub 函数，统一直接暴露
  // 让 inline script 删除门面后，调用方走全局即可拿到模块版本
  window.extractApiGoodsLinkInfo = extractApiGoodsLinkInfo;
  window.pickApiGoodsText = pickApiGoodsText;
  window.pickApiGoodsNumber = pickApiGoodsNumber;
  window.formatApiGoodsPrice = formatApiGoodsPrice;
  window.normalizeApiGoodsSpecItems = normalizeApiGoodsSpecItems;
  window.buildApiGoodsSpecFallbackItems = buildApiGoodsSpecFallbackItems;
  window.isMeaningfulApiGoodsCard = isMeaningfulApiGoodsCard;
  window.describeApiGoodsCardResult = describeApiGoodsCardResult;
  window.buildApiGoodsCardFallback = buildApiGoodsCardFallback;
  window.renderApiGoodsCardHtml = renderApiGoodsCardHtml;
  window.debugApiGoodsSourceMessage = debugApiGoodsSourceMessage;
  window.resolveApiGoodsSourceCard = resolveApiGoodsSourceCard;
  window.renderApiGoodsSourceNoticeCardHtml = renderApiGoodsSourceNoticeCardHtml;
  window.extractApiInviteOrderCard = extractApiInviteOrderCard;
  window.renderApiInviteOrderCardHtml = renderApiInviteOrderCardHtml;
  window.ensureApiGoodsCardLoaded = ensureApiGoodsCardLoaded;
  window.isApiUnmatchedReplyNoticeMessage = isApiUnmatchedReplyNoticeMessage;
  window.renderApiVideoMessageHtml = renderApiVideoMessageHtml;
  window.getApiSellerDisplayName = getApiSellerDisplayName;

  // 历史 inline rich stub（fallback 与模块实现完全等价），统一暴露后删除 inline 副本
  window.isApiGoodsSourceNoticeMessage = isApiGoodsSourceNoticeMessage;
  window.getApiRefundSystemNoticeKind = getApiRefundSystemNoticeKind;
  window.getApiRefundSystemNoticeDisplayText = getApiRefundSystemNoticeDisplayText;
  window.isApiInviteOrderTemplateMessage = isApiInviteOrderTemplateMessage;
  window.renderApiSystemMessageHtml = renderApiSystemMessageHtml;

  // 历史 inline rich stub（fallback 是死代码、滞留旧实现），module 版本已是实际生效版本
  // 一并暴露后删除 inline 副本，运行时行为不变，仅清理死代码
  window.normalizeApiGoodsCard = normalizeApiGoodsCard;
  window.renderApiRefundCardHtml = renderApiRefundCardHtml;
  window.getApiSystemNoticeText = getApiSystemNoticeText;
  window.renderApiRefundSystemNoticeCardHtml = renderApiRefundSystemNoticeCardHtml;
  window.isApiSystemNoticeMessage = isApiSystemNoticeMessage;

  // C2 step4：以下为 inline 与 module 双轨真实现差异函数，统一切换到 module 版本
  // 各 inline 调用方传参与 module 签名兼容，行为差异为微调（更规整/更宽松 fallback）
  window.formatApiVideoDuration = formatApiVideoDuration;
  window.getApiSystemPromptContext = getApiSystemPromptContext;
  window.findApiRefundStatusUpdateForCard = findApiRefundStatusUpdateForCard;
  window.normalizeApiRefundCardAmountText = normalizeApiRefundCardAmountText;

  // C2 step5：原 trampoline 函数（module 通过 callRuntime 调回 inline 真实现）
  // 已就地改为真实现，inline 真实现可一并删除，所有调用方走全局即可
  window.esc = esc;
  window.addLog = addLog;
  window.emitRendererDebug = emitRendererDebug;
  window.getApiSessionKey = getApiSessionKey;

  // C2 step6：纯函数时间格式化，原 trampoline 升格为真实现
  window.formatApiDateTime = formatApiDateTime;
  window.getApiTimeMs = getApiTimeMs;
  window.formatApiListTime = formatApiListTime;

  // C2 step7：会话超时回复 / 关注状态判定（纯函数子树，仅依赖 getApiTimeMs）
  window.getApiSessionLastMessageActor = getApiSessionLastMessageActor;
  window.isApiSessionLastMessageFromBuyer = isApiSessionLastMessageFromBuyer;
  window.getApiPendingReplyElapsedMs = getApiPendingReplyElapsedMs;
  window.getApiPendingReplyDisplayState = getApiPendingReplyDisplayState;
  window.getApiPendingReplyMinutes = getApiPendingReplyMinutes;
  window.hasApiPendingReply = hasApiPendingReply;
  window.formatApiPendingReplyText = formatApiPendingReplyText;
  window.getApiConversationFollowStatus = getApiConversationFollowStatus;

  // C2 step8：批量纯函数（时间格式化、视频/退款/缓存归一化等）
  window.formatApiTime = formatApiTime;
  window.formatApiDate = formatApiDate;
  window.formatApiAmount = formatApiAmount;
  window.getApiSessionVisibleStartMs = getApiSessionVisibleStartMs;
  window.isApiSessionWithinRecentDays = isApiSessionWithinRecentDays;
  window.getApiSessionDedupKey = getApiSessionDedupKey;
  window.normalizeApiVideoItem = normalizeApiVideoItem;
  window.buildApiSyntheticRefundMessageKey = buildApiSyntheticRefundMessageKey;
  window.formatApiCacheRelativeTime = formatApiCacheRelativeTime;

  // C2 step9：客户名提取链（纯函数子树）
  window.isUnknownApiCustomerName = isUnknownApiCustomerName;
  window.pickApiDisplayText = pickApiDisplayText;
  window.pickApiSessionCustomerName = pickApiSessionCustomerName;

  // C2 step10：店铺可用性判定 + 会话关键字匹配（纯函数）
  window.getShopAvailabilityStatus = getShopAvailabilityStatus;
  window.isApiSelectableShop = isApiSelectableShop;
  window.matchApiSessionKeyword = matchApiSessionKeyword;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('chat-api-module', bindChatApiModule);
  } else {
    bindChatApiModule();
  }
})();
