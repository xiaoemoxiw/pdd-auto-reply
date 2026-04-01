(function () {
  let initialized = false;
  let apiPendingReplyTicker = null;
  let apiPendingReplySignature = '';
  let apiActivePendingReplySignature = '';

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
            setApiHint('已复制客户消息');
          } catch {
            setApiHint('复制失败，请稍后重试');
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
  window.syncApiSelectionWithFilter = syncApiSelectionWithFilter;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('chat-api-module', bindChatApiModule);
  } else {
    bindChatApiModule();
  }
})();
