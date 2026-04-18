const crypto = require('crypto');
const {
  normalizePddUserAgent,
  getChromeClientHintHeaders,
  applyIdentityHeaders,
  applyCookieContextHeaders,
} = require('./pdd-request-profile');
const { PddBusinessApiClient } = require('./pdd-business-api-client');
const commonParsers = require('./pdd-api/parsers/common-parsers');
const goodsParsers = require('./pdd-api/parsers/goods-parsers');
const refundParsers = require('./pdd-api/parsers/refund-parsers');
const orderRemarkParsers = require('./pdd-api/parsers/order-remark-parsers');
const messageParsers = require('./pdd-api/parsers/message-parsers');
const smallPaymentParsers = require('./pdd-api/parsers/small-payment-parsers');
const { GoodsCardModule } = require('./pdd-api/modules/goods-card-module');
const { RefundOrdersModule } = require('./pdd-api/modules/refund-orders-module');
const { SmallPaymentModule } = require('./pdd-api/modules/small-payment-module');
const { OrderPriceModule } = require('./pdd-api/modules/order-price-module');
const { InviteOrderModule } = require('./pdd-api/modules/invite-order-module');
const { SideOrdersModule } = require('./pdd-api/modules/side-orders-module');
const { OrderRemarkModule } = require('./pdd-api/modules/order-remark-module');
const { MessageSendModule } = require('./pdd-api/modules/message-send-module');
const { ChatPollingModule } = require('./pdd-api/modules/chat-polling-module');
const { ShopProfileModule } = require('./pdd-api/modules/shop-profile-module');
const { ChatSessionsModule } = require('./pdd-api/modules/chat-sessions-module');
const { SessionInitModule } = require('./pdd-api/modules/session-init-module');

const PDD_BASE = 'https://mms.pinduoduo.com';
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;
const PDD_API_MAIN_COOKIE_WHITELIST = [
  'PASS_ID',
  '_nano_fp',
  'rckk',
  'api_uid',
  '_bee',
  'ru1k',
  '_f77',
  'ru2k',
  '_a42',
  'JSESSIONID',
  'msfe-pc-cookie-captcha-token',
];

class PddApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    // 通过 super 启用基类的请求/重试/认证管线，PddApiClient 自己只保留 chat 链路
    // 特有的 header 默认值与 emit 文案。基类继承自 EventEmitter，仍可正常 this.emit。
    super(shopId, {
      partition: `persist:pddv2-${shopId}`,
      baseUrl: PDD_BASE,
      onLog: options.onLog,
      getShopInfo: options.getShopInfo,
      getApiTraffic: options.getApiTraffic,
      refreshMainCookieContext: options.refreshMainCookieContext,
      errorLabel: 'API',
      loginExpiredMessage: '网页登录已失效，请重新登录或重新导入 Token',
      enableMainCookieContextRetry: true,
      enableAuthExpiredEvent: true,
      enableCrossOriginHandling: true,
      enableDeepBusinessErrorScan: true,
      getMainCookieWhitelist: () => PDD_API_MAIN_COOKIE_WHITELIST,
    });
    this._sessionInited = false;
    this._bootstrapTraffic = [];
    this._requestInPddPage = options.requestInPddPage || null;
    this._executeInPddPage = options.executeInPddPage || null;
    this._getOrderPriceUpdateTemplate = options.getOrderPriceUpdateTemplate || (() => null);
    this._setOrderPriceUpdateTemplate = options.setOrderPriceUpdateTemplate || null;
    this._getSmallPaymentSubmitTemplate = options.getSmallPaymentSubmitTemplate || (() => null);
    this._goodsCardModule = new GoodsCardModule(this);
    this._refundOrdersModule = new RefundOrdersModule(this);
    this._smallPaymentModule = new SmallPaymentModule(this);
    this._orderPriceModule = new OrderPriceModule(this);
    this._inviteOrderModule = new InviteOrderModule(this);
    this._sideOrdersModule = new SideOrdersModule(this);
    this._orderRemarkModule = new OrderRemarkModule(this);
    this._messageSendModule = new MessageSendModule(this);
    this._chatPollingModule = new ChatPollingModule(this);
    this._shopProfileModule = new ShopProfileModule(this);
    this._chatSessionsModule = new ChatSessionsModule(this);
    this._sessionInitModule = new SessionInitModule(this);
  }

  // _sessionCache 现在由 ChatSessionsModule 持有；保留访问器兼容外部模块
  // 直接读写（main.js 在页面抓包同步时会赋值）。
  get _sessionCache() {
    return this._chatSessionsModule.sessionCache;
  }

  set _sessionCache(value) {
    this._chatSessionsModule.sessionCache = Array.isArray(value) ? value : [];
  }

  _getMallId() {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    return Number(tokenInfo?.mallId || shop?.mallId || 0);
  }

  _getApiTrafficEntries() {
    const list = this._getApiTraffic();
    return [
      ...(Array.isArray(list) ? list : []),
      ...this._bootstrapTraffic,
    ];
  }

  _appendBootstrapTraffic(entry) {
    if (!entry || typeof entry !== 'object') return;
    this._bootstrapTraffic.push(entry);
    if (this._bootstrapTraffic.length > 200) {
      this._bootstrapTraffic.splice(0, this._bootstrapTraffic.length - 200);
    }
  }

  _safeParseJson(text) {
    return commonParsers.safeParseJson(text);
  }

  _cloneJson(value) {
    return commonParsers.cloneJson(value);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _getLatestAntiContent() {
    const urlParts = [
      '/plateau/chat/list',
      '/plateau/chat/latest_conversations',
      '/plateau/conv_list/status',
    ];

    for (const urlPart of urlParts) {
      const entry = this._findLatestTraffic(urlPart);
      const body = this._safeParseJson(entry?.requestBody);
      const antiContent = body?.anti_content || body?.data?.anti_content || '';
      if (antiContent) {
        return antiContent;
      }
    }

    return '';
  }

  _getLatestResponseBody(urlPart) {
    const entry = this._findLatestTraffic(urlPart);
    const body = entry?.responseBody;
    if (body && typeof body === 'object') return body;
    return null;
  }

  _findLatestTrafficEntry(matcher) {
    const list = this._getApiTrafficEntries();
    for (let i = list.length - 1; i >= 0; i--) {
      if (matcher(list[i])) {
        return list[i];
      }
    }
    return null;
  }

  _getLatestRequestBody(urlPart) {
    return this._safeParseJson(this._findLatestTraffic(urlPart)?.requestBody);
  }

  _getLatestRawRequestBody(urlPart) {
    return this._findLatestTraffic(urlPart)?.requestBody;
  }

  _collectObjectKeyPaths(value, prefix = '', depth = 0) {
    return commonParsers.collectObjectKeyPaths(value, prefix, depth);
  }

  _readObjectPath(value, path) {
    return commonParsers.readObjectPath(value, path);
  }

  _writeObjectPath(value, path, nextValue) {
    return commonParsers.writeObjectPath(value, path, nextValue);
  }

  _findObjectPathByCandidates(value, candidates = []) {
    return commonParsers.findObjectPathByCandidates(value, candidates);
  }

  _analyzeSmallPaymentSubmitTemplate(templateEntry) {
    return smallPaymentParsers.analyzeSmallPaymentSubmitTemplate(templateEntry);
  }

  _isSmallPaymentSubmitBody(body = {}, normalizedOrderSn = '') {
    return smallPaymentParsers.isSmallPaymentSubmitBody(body, normalizedOrderSn);
  }

  _normalizeSmallPaymentTemplateLabel(value) {
    return smallPaymentParsers.normalizeSmallPaymentTemplateLabel(value);
  }

  _inferSmallPaymentTemplateLabelFromBody(body = {}) {
    return smallPaymentParsers.inferSmallPaymentTemplateLabelFromBody(body);
  }

  _normalizeSmallPaymentTemplateEntry(template) {
    return smallPaymentParsers.normalizeSmallPaymentTemplateEntry(template);
  }

  _collectPersistedSmallPaymentSubmitTemplates(desiredType = '') {
    return this._smallPaymentModule.collectPersistedSubmitTemplates(desiredType);
  }

  _getLatestSmallPaymentSubmitTemplate(orderSn = '', options = {}) {
    return this._smallPaymentModule.getLatestSubmitTemplate(orderSn, options);
  }

  _getLatestConversationTrafficEntry() {
    return this._findLatestTrafficEntry((entry) => {
      if (!String(entry?.url || '').includes('/plateau/chat/latest_conversations')) return false;
      const body = this._safeParseJson(entry?.requestBody);
      return body?.data?.chat_type_id === undefined;
    }) || this._findLatestTraffic('/plateau/chat/latest_conversations');
  }

  _getLatestConversationRequestBody() {
    return this._safeParseJson(this._getLatestConversationTrafficEntry()?.requestBody);
  }

  _getConversationBootstrapStatus() {
    const latestConversationsEntry = this._getLatestConversationTrafficEntry();
    const convStatusEntry = this._findLatestTraffic('/plateau/conv_list/status');
    const chatListEntry = this._findLatestTraffic('/plateau/chat/list');
    const antiContent = this._getLatestAntiContent();
    return {
      ready: !!(latestConversationsEntry || convStatusEntry || (chatListEntry && antiContent)),
      hasLatestConversations: !!latestConversationsEntry,
      hasConvStatus: !!convStatusEntry,
      hasChatList: !!chatListEntry,
      hasAntiContent: !!antiContent,
    };
  }

  async _waitForConversationBootstrap(maxWaitMs = 2500) {
    const deadline = Date.now() + maxWaitMs;
    let status = this._getConversationBootstrapStatus();
    while (!status.ready && Date.now() < deadline) {
      await this._sleep(250);
      status = this._getConversationBootstrapStatus();
    }
    return status;
  }

  _getLatestClientValue() {
    const urlParts = [
      '/plateau/chat/send_message',
      '/plateau/chat/list',
      '/plateau/chat/latest_conversations',
    ];

    for (const urlPart of urlParts) {
      const body = this._getLatestRequestBody(urlPart);
      if (body?.client !== undefined && body?.client !== null && body?.client !== '') {
        return body.client;
      }
    }

    return 1;
  }

  _getLatestSessionTraffic(urlPart, sessionId) {
    const ids = Array.isArray(sessionId) ? sessionId.map(item => String(item || '')).filter(Boolean) : [String(sessionId || '')].filter(Boolean);
    if (!ids.length) return null;
    return this._findLatestTrafficEntry((entry) => {
      if (!String(entry?.url || '').includes(urlPart)) return false;
      const body = this._safeParseJson(entry?.requestBody);
      const targetIds = [
        body?.data?.list?.with?.id,
        body?.data?.message?.to?.uid,
        body?.data?.message?.session_id,
        body?.data?.message?.conversation_id,
        body?.data?.message?.chat_id,
        body?.data?.message?.user_info?.uid,
        body?.session_id,
        body?.conversation_id,
        body?.chat_id,
      ].map(value => String(value || '')).filter(Boolean);
      return targetIds.some(targetId => ids.includes(targetId));
    });
  }

  _getLatestSendMessagePreCheck(sessionRef) {
    const { sessionMeta, ids } = this._getSessionIdentityCandidates(sessionRef);
    const uidSet = new Set(ids.map(value => String(value || '').trim()).filter(Boolean));

    const updateEntry = this._findLatestTrafficEntry((entry) => {
      if (!String(entry?.url || '').includes('/detroit/chatDetail/updateChatBizInfo')) return false;
      const body = this._safeParseJson(entry?.requestBody);
      const customerUid = String(body?.customerUid || '').trim();
      return !!customerUid && uidSet.has(customerUid);
    });
    const updatePayload = updateEntry?.responseBody && typeof updateEntry.responseBody === 'object'
      ? updateEntry.responseBody
      : null;
    const updateInfo = updatePayload?.result?.sendMessageCheckData?.preCheckInfo;
    if (updateInfo && typeof updateInfo === 'object') {
      return this._cloneJson(updateInfo);
    }

    const wsEntry = this._findLatestTrafficEntry((entry) => {
      if (String(entry?.direction || '') !== 'received') return false;
      if (String(entry?.transport || '') !== 'websocket') return false;
      const payload = entry?.decodedFrame?.notifyPayload;
      const data = payload?.message?.data;
      if (!data || typeof data !== 'object') return false;
      if (String(payload?.response || '') !== 'mall_system_msg') return false;
      if (Number(payload?.message?.type) !== 67) return false;
      const uid = String(data?.uid || data?.user_id || '').trim();
      return !!uid && uidSet.has(uid);
    });
    const wsPayload = wsEntry?.decodedFrame?.notifyPayload;
    const wsInfo = wsPayload?.message?.data;
    if (wsInfo && typeof wsInfo === 'object') {
      return this._cloneJson(wsInfo);
    }

    return null;
  }

  _getLatestTrusteeshipStateInfo(sessionRef) {
    const { sessionMeta, ids } = this._getSessionIdentityCandidates(sessionRef);
    const uidSet = new Set(ids.map(value => String(value || '').trim()).filter(Boolean));

    const queryEntry = this._findLatestTrafficEntry((entry) => {
      if (!String(entry?.url || '').includes('/refraction/robot/mall/trusteeshipState/queryTrusteeshipState')) return false;
      const body = this._safeParseJson(entry?.requestBody);
      const uid = String(body?.uid || '').trim();
      return !!uid && uidSet.has(uid);
    });
    const queryPayload = queryEntry?.responseBody && typeof queryEntry.responseBody === 'object'
      ? queryEntry.responseBody
      : null;
    if (queryPayload?.result && typeof queryPayload.result === 'object') {
      return this._cloneJson(queryPayload.result);
    }

    const wsEntry = this._findLatestTrafficEntry((entry) => {
      if (String(entry?.direction || '') !== 'received') return false;
      if (String(entry?.transport || '') !== 'websocket') return false;
      const payload = entry?.decodedFrame?.notifyPayload;
      const body = payload?.body || payload?.message?.data;
      if (!body || typeof body !== 'object') return false;
      const bizType = String(payload?.bizType || '').trim();
      const subType = String(payload?.subType || '').trim();
      const uid = String(body?.uid || body?.user_id || '').trim();
      return bizType === 'merchant-robot' && subType === 'trusteeshipState' && !!uid && uidSet.has(uid);
    });
    const wsPayload = wsEntry?.decodedFrame?.notifyPayload;
    const wsBody = wsPayload?.body || wsPayload?.message?.data;
    if (wsBody && typeof wsBody === 'object') {
      return this._cloneJson(wsBody);
    }

    return null;
  }

  _findConversationReadMark(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const queue = [payload];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) {
        current.forEach(item => {
          if (item && typeof item === 'object') queue.push(item);
        });
        continue;
      }
      const directMark = current.read_mark || current.readMark;
      if (directMark && typeof directMark === 'object') {
        const userLastRead = directMark.user_last_read ?? directMark.userLastRead;
        const minSupportedMsgId = directMark.min_supported_msg_id ?? directMark.minSupportedMsgId;
        if (userLastRead || minSupportedMsgId) {
          return this._cloneJson(directMark);
        }
      }
      Object.keys(current).forEach(key => {
        const value = current[key];
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      });
    }
    return null;
  }

  _getLatestConversationReadMark(sessionRef, payload = null) {
    const payloadMark = this._findConversationReadMark(payload);
    if (payloadMark) return payloadMark;
    if (!sessionRef) return null;
    const { ids } = this._getSessionIdentityCandidates(sessionRef);
    const uidSet = new Set(ids.map(value => String(value || '').trim()).filter(Boolean));
    if (!uidSet.size) return null;
    const wsEntry = this._findLatestTrafficEntry((entry) => {
      if (String(entry?.direction || '') !== 'received') return false;
      if (String(entry?.transport || '') !== 'websocket') return false;
      const notifyPayload = entry?.decodedFrame?.notifyPayload;
      if (String(notifyPayload?.response || '') !== 'mall_system_msg') return false;
      if (Number(notifyPayload?.message?.type) !== 20) return false;
      const data = notifyPayload?.message?.data;
      if (!data || typeof data !== 'object') return false;
      const uid = String(data?.uid || data?.user_id || '').trim();
      return !!uid && uidSet.has(uid);
    });
    const data = wsEntry?.decodedFrame?.notifyPayload?.message?.data;
    if (!data || typeof data !== 'object') return null;
    if (!data.user_last_read && !data.userLastRead && !data.min_supported_msg_id && !data.minSupportedMsgId) {
      return null;
    }
    return this._cloneJson(data);
  }

  _extractMessageBuyerReadState(item = {}, options = {}) {
    if (this._getMessageActor(item) !== 'seller') return '';
    const userLastReadMs = this._normalizeTimestampMs(
      options?.user_last_read
      ?? options?.userLastRead
      ?? options?.readMark?.user_last_read
      ?? options?.readMark?.userLastRead
    );
    if (!userLastReadMs) return '';
    const messageTsMs = this._normalizeTimestampMs(
      item?.send_time || item?.time || item?.ts || item?.timestamp || item?.created_at
    );
    if (!messageTsMs) return '';
    return messageTsMs <= userLastReadMs ? 'read' : 'unread';
  }

  async _queryTrusteeshipState(sessionRef) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    if (!uid) return null;
    return this._post('/refraction/robot/mall/trusteeshipState/queryTrusteeshipState', { uid }, {
      'content-type': 'application/json;charset=UTF-8',
    });
  }

  async _queryReplyState(sessionRef) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    if (!uid) return null;
    return this._post('/refraction/robot/mall/trusteeshipState/queryReplyState', { uid }, {
      'content-type': 'application/json;charset=UTF-8',
    });
  }

  async _updateChatBizInfo(sessionRef) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const customerUid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    if (!customerUid) return null;
    return this._post('/detroit/chatDetail/updateChatBizInfo', { customerUid }, {
      'content-type': 'application/json;charset=UTF-8',
    });
  }

  async _notifyTyping(sessionRef) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    if (!uid) return null;
    return this._post('/plateau/conv/typing', { uid }, {
      'content-type': 'application/json;charset=UTF-8',
    });
  }

  _normalizeSessionMeta(sessionRef) {
    if (sessionRef && typeof sessionRef === 'object' && !Array.isArray(sessionRef)) {
      return this._cloneJson(sessionRef);
    }
    const target = String(sessionRef || '');
    const cachedSessions = [
      ...this._sessionCache,
      ...this._parseSessionList(this._getLatestResponseBody('/plateau/chat/latest_conversations')),
    ];
    const matched = cachedSessions.find(item => {
      const candidates = [
        item?.sessionId,
        item?.explicitSessionId,
        item?.conversationId,
        item?.chatId,
        item?.rawId,
        item?.customerId,
        item?.userUid,
        item?.raw?.session_id,
        item?.raw?.conversation_id,
        item?.raw?.chat_id,
        item?.raw?.id,
        item?.raw?.customer_id,
        item?.raw?.buyer_id,
        item?.raw?.uid,
        item?.raw?.to?.uid,
        item?.raw?.user_info?.uid,
      ].map(value => String(value || '')).filter(Boolean);
      return candidates.includes(target);
    });
    if (matched) return this._cloneJson(matched);
    return {
      sessionId: target,
      explicitSessionId: '',
      conversationId: '',
      chatId: '',
      rawId: '',
      customerId: target,
      userUid: target,
      raw: {},
    };
  }

  _getSessionIdentityCandidates(sessionRef) {
    const sessionMeta = this._normalizeSessionMeta(sessionRef);
    const ids = [
      sessionMeta.sessionId,
      sessionMeta.explicitSessionId,
      sessionMeta.conversationId,
      sessionMeta.chatId,
      sessionMeta.rawId,
      sessionMeta.customerId,
      sessionMeta.userUid,
      sessionMeta?.raw?.session_id,
      sessionMeta?.raw?.conversation_id,
      sessionMeta?.raw?.chat_id,
      sessionMeta?.raw?.id,
      sessionMeta?.raw?.customer_id,
      sessionMeta?.raw?.buyer_id,
      sessionMeta?.raw?.uid,
      sessionMeta?.raw?.to?.uid,
      sessionMeta?.raw?.user_info?.uid,
    ].map(value => String(value || '')).filter(Boolean);
    return {
      sessionMeta,
      ids: [...new Set(ids)],
    };
  }

  _buildSessionMessageCandidates(sessionMeta = {}, templateList = {}) {
    const ids = [
      sessionMeta.sessionId,
      sessionMeta.explicitSessionId,
      sessionMeta.conversationId,
      sessionMeta.chatId,
      sessionMeta.rawId,
      sessionMeta.customerId,
      sessionMeta.userUid,
      templateList?.with?.id,
      sessionMeta?.raw?.session_id,
      sessionMeta?.raw?.conversation_id,
      sessionMeta?.raw?.chat_id,
      sessionMeta?.raw?.id,
      sessionMeta?.raw?.customer_id,
      sessionMeta?.raw?.buyer_id,
      sessionMeta?.raw?.uid,
      sessionMeta?.raw?.to?.uid,
      sessionMeta?.raw?.user_info?.uid,
    ].map(value => String(value || '')).filter(Boolean);
    const roles = [
      templateList?.with?.role,
      sessionMeta?.raw?.to?.role,
      sessionMeta?.raw?.with?.role,
      'user',
      'buyer',
    ].map(value => String(value || '')).filter(Boolean);
    const uniqueRoles = [...new Set(roles)];
    const seen = new Set();
    const candidates = [];
    ids.forEach(id => {
      uniqueRoles.forEach(role => {
        const key = `${role}:${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ id, role });
      });
    });
    return candidates;
  }

  _shouldReuseSessionWindow(templateList, page) {
    if (page !== 1 || !templateList || typeof templateList !== 'object') return false;
    const startIndex = Number(templateList.start_index ?? 0);
    const startMsgId = templateList.start_msg_id;
    const hasPinnedCursor = startMsgId !== null && startMsgId !== undefined && String(startMsgId).trim() !== '';
    return startIndex <= 0 && !hasPinnedCursor;
  }

  _getLatestBuyerInfo(sessionRef) {
    const { ids } = this._getSessionIdentityCandidates(sessionRef);
    const entry = this._getLatestSessionTraffic('/plateau/chat/list', ids);
    const payload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
    const messages = this._parseMessages(payload, sessionRef);
    const buyerMessage = [...messages].reverse().find(item => item.isFromBuyer && item?.raw && typeof item.raw === 'object');
    if (buyerMessage?.raw?.user_info) {
      return this._cloneJson(buyerMessage.raw.user_info);
    }
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    return sessionMeta?.raw?.user_info ? this._cloneJson(sessionMeta.raw.user_info) : null;
  }

  _getLatestMessageTemplate(sessionRef) {
    const { ids } = this._getSessionIdentityCandidates(sessionRef);
    const sendMessageEntry = this._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const sendMessageBody = this._safeParseJson(sendMessageEntry?.requestBody);
    if (sendMessageBody?.data?.message && typeof sendMessageBody.data.message === 'object') {
      return this._cloneJson(sendMessageBody.data.message);
    }
    const identitySet = new Set(ids);
    const entry = this._getLatestSessionTraffic('/plateau/chat/list', ids);
    const payload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
    const messages = this._parseMessages(payload, sessionRef);
    const sellerMessage = [...messages].reverse().find(item => item.actor === 'seller' && item?.raw && typeof item.raw === 'object');
    if (sellerMessage?.raw) {
      return this._cloneJson(sellerMessage.raw);
    }
    return null;
  }

  _extractBuyerUid(item = {}) {
    return messageParsers.extractBuyerUid(item, this._getMallId() || '');
  }

  _randomHex(length = 32) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  }

  _buildMessageHash(sessionId, text, ts, random) {
    return crypto
      .createHash('md5')
      .update(`${sessionId}|${text}|${ts}|${random}`)
      .digest('hex');
  }

  _nextRequestId() {
    return Date.now();
  }

  // 覆盖基类默认值：chat-merchant 链路必须用 CHAT_URL 作 Referer，
  // 同时保持 accept '*/*' 与 cache-control 'max-age=0'，避免触发 PDD 的内容协商防御。
  async _buildHeaders(_urlPart, extraHeaders = {}) {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    const cookieMap = await this._getCookieMap();
    const mainCookie = this._buildMainCookieString(cookieMap);
    const hasRequiredMainCookies = !!(cookieMap.PASS_ID && cookieMap._nano_fp && cookieMap.rckk);
    const headers = {
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'max-age=0',
      'content-type': 'application/json',
      ...getChromeClientHintHeaders('api'),
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      Referer: CHAT_URL,
      Origin: PDD_BASE,
      ...extraHeaders,
    };

    if (hasRequiredMainCookies && mainCookie) {
      headers.cookie = mainCookie;
    }
    headers['user-agent'] = normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || '');
    applyIdentityHeaders(headers, tokenInfo);
    applyCookieContextHeaders(headers, cookieMap);
    if (!hasRequiredMainCookies) {
      this._log('[API] 请求关键 Cookie 缺失', {
        hasPassId: !!cookieMap.PASS_ID,
        hasNanoFp: !!cookieMap._nano_fp,
        hasRckk: !!cookieMap.rckk,
      });
    }

    return headers;
  }

  _createStepError(step, message, extra = {}) {
    const error = new Error(message);
    error.step = step;
    Object.assign(error, extra);
    return error;
  }

  _isInviteOrderTemplateMessage(item = {}) {
    return messageParsers.isInviteOrderTemplateMessage(item);
  }

  _isRobotManagedTextMessage(item = {}) {
    return messageParsers.isRobotManagedTextMessage(item);
  }

  _isSystemNoticeMessage(item = {}) {
    return messageParsers.isSystemNoticeMessage(item);
  }

  _getMessageActor(item = {}) {
    return messageParsers.getMessageActor(item, this._getMallId() || '');
  }

  _isSystemNoticeText(text = '') {
    return messageParsers.isSystemNoticeText(text);
  }

  _isRefundDefaultSellerNoteText(text = '') {
    return refundParsers.isRefundDefaultSellerNoteText(text);
  }

  _normalizeSystemNoticeComparableText(text = '') {
    return refundParsers.normalizeSystemNoticeComparableText(text);
  }

  _isRefundPendingNoticeText(text = '') {
    return refundParsers.isRefundPendingNoticeText(text);
  }

  _isRefundSuccessNoticeText(text = '') {
    return refundParsers.isRefundSuccessNoticeText(text);
  }

  async _confirmRefundApplyConversationMessage(sessionRef, options = {}) {
    return this._refundOrdersModule.confirmRefundApplyConversationMessage(sessionRef, options);
  }

  _emitAuthExpired(payload = {}) {
    this._authExpired = true;
    this.emit('authExpired', {
      shopId: this.shopId,
      errorCode: payload.errorCode || payload.statusCode || 0,
      errorMsg: payload.errorMsg || '接口认证已失效',
      authState: payload.authState || 'expired',
      source: payload.source || 'request',
    });
  }

  async initSession(force = false, options = {}) {
    return this._sessionInitModule.initSession(force, options);
  }

  async _post(urlPath, body, extraHeaders, options) {
    return this._request('POST', urlPath, body, extraHeaders, options);
  }

  async _requestOrderRemarkApi(urlPath, body = {}) {
    return this._orderRemarkModule.requestApi(urlPath, body);
  }

  async getUserInfo(options = {}) {
    return this._shopProfileModule.getUserInfo(options);
  }

  async getServiceProfile(force = false, options = {}) {
    return this._shopProfileModule.getServiceProfile(force, options);
  }

  async getMallInfo(options = {}) {
    return this._shopProfileModule.getMallInfo(options);
  }

  async getCredentialInfo(options = {}) {
    return this._shopProfileModule.getCredentialInfo(options);
  }

  async getShopProfile(force = false) {
    return this._shopProfileModule.getShopProfile(force);
  }

  _normalizeTimestampMs(value) {
    return this._chatSessionsModule.normalizeTimestampMs(value);
  }

  _pickPendingBuyerMessage(messages = [], buyerIds = [], sessionMeta = {}) {
    return this._chatSessionsModule.pickPendingBuyerMessage(messages, buyerIds, sessionMeta);
  }

  _extractMessageSenderName(item = {}) {
    return this._chatSessionsModule.extractMessageSenderName(item);
  }

  _parseSessionList(payload) {
    return this._chatSessionsModule.parseSessionList(payload);
  }

  async getSessionList(page = 1, pageSize = 20, options = {}) {
    return this._chatSessionsModule.getSessionList(page, pageSize, options);
  }

  async getHistoryMessagesByOrderSn(orderSn, options = {}) {
    return this._chatSessionsModule.getHistoryMessagesByOrderSn(orderSn, options);
  }

  async findSessionByOrderSn(orderSn, options = {}) {
    return this._chatSessionsModule.findSessionByOrderSn(orderSn, options);
  }

  _isBuyerMessage(item) {
    return messageParsers.isBuyerMessage(item, this._getMallId() || '');
  }

  _extractPendingConfirmMessageText(sessionRef, item = {}, fallbackText = '', options = {}) {
    const latestTrusteeshipInfo = options?.latestTrusteeshipInfo
      && typeof options.latestTrusteeshipInfo === 'object'
      ? options.latestTrusteeshipInfo
      : this._getLatestTrusteeshipStateInfo(sessionRef);
    return messageParsers.extractPendingConfirmMessageText(item, fallbackText, latestTrusteeshipInfo);
  }

  _extractMessageText(item, options = {}) {
    const latestTrusteeshipInfo = options?.latestTrusteeshipInfo
      && typeof options.latestTrusteeshipInfo === 'object'
      ? options.latestTrusteeshipInfo
      : (options?.sessionRef ? this._getLatestTrusteeshipStateInfo(options.sessionRef) : null);
    return messageParsers.extractMessageText(item, { latestTrusteeshipInfo });
  }

  _extractStructuredMessageEntryText(entry) {
    return messageParsers.extractStructuredMessageEntryText(entry);
  }

  _extractStructuredMessageText(item = {}) {
    return messageParsers.extractStructuredMessageText(item);
  }

  _extractMessageReadState(item = {}) {
    return messageParsers.extractMessageReadState(item);
  }

  _decodeGoodsText(value = '') {
    return goodsParsers.decodeGoodsText(value);
  }

  _pickGoodsText(candidates = []) {
    return goodsParsers.pickGoodsText(candidates);
  }

  _normalizeGoodsPrice(value) {
    return goodsParsers.normalizeGoodsPrice(value);
  }

  _normalizeRefundAmountByKeys(sources = [], keys = []) {
    return refundParsers.normalizeRefundAmountByKeys(sources, keys);
  }

  _extractGoodsIdFromUrl(rawUrl = '') {
    return goodsParsers.extractGoodsIdFromUrl(rawUrl);
  }

  _normalizeGoodsId(value = '') {
    return goodsParsers.normalizeGoodsId(value);
  }

  _extractGoodsJsonObject(source = '') {
    return goodsParsers.extractGoodsJsonObject(source);
  }

  _extractGoodsPayloadCandidates(html = '') {
    return goodsParsers.extractGoodsPayloadCandidates(html);
  }

  _extractGoodsTextCandidate(value, preferredKeys = []) {
    return goodsParsers.extractGoodsTextCandidate(value, preferredKeys);
  }

  _findGoodsFieldText(payload, keys = [], nestedKeys = []) {
    return goodsParsers.findGoodsFieldText(payload, keys, nestedKeys);
  }

  _pickGoodsNumber(source = {}, keys = []) {
    return goodsParsers.pickGoodsNumber(source, keys);
  }

  _splitGoodsSpecText(value = '') {
    return goodsParsers.splitGoodsSpecText(value);
  }

  _formatGoodsSpecSegment(segment = {}) {
    return goodsParsers.formatGoodsSpecSegment(segment);
  }

  _appendGoodsSpecSegments(segments, value) {
    return goodsParsers.appendGoodsSpecSegments(segments, value);
  }

  _extractGoodsSpecSegments(item = {}) {
    return goodsParsers.extractGoodsSpecSegments(item);
  }

  _normalizeGoodsSpecItem(item = {}) {
    return goodsParsers.normalizeGoodsSpecItem(item);
  }

  _collectGoodsSpecCandidates(payload) {
    return goodsParsers.collectGoodsSpecCandidates(payload);
  }

  _extractGoodsSpecItems(payloadCandidates = [], fallback = {}) {
    return goodsParsers.extractGoodsSpecItems(payloadCandidates, fallback);
  }

  _extractGoodsCardFromHtml(html = '', fallback = {}) {
    return goodsParsers.extractGoodsCardFromHtml(html, fallback);
  }

  _isGoodsLoginPageHtml(html = '') {
    return goodsParsers.isGoodsLoginPageHtml(html);
  }

  _hasMeaningfulGoodsCardData(card = {}, fallback = {}) {
    return goodsParsers.hasMeaningfulGoodsCardData(card, fallback);
  }

  async _loadGoodsHtmlInWindow(url) {
    return this._goodsCardModule.loadGoodsHtmlInWindow(url);
  }

  _findMessageArray(payload) {
    return messageParsers.findMessageArray(payload);
  }

  _parseMessages(payload, sessionRef = null) {
    const list = this._findMessageArray(payload);
    const readMark = this._getLatestConversationReadMark(sessionRef, payload);
    const latestTrusteeshipInfo = sessionRef ? this._getLatestTrusteeshipStateInfo(sessionRef) : null;

    return list.map(item => ({
      actor: this._getMessageActor(item),
      messageId: item.msg_id || item.message_id || item.id || '',
      sessionId: item.session_id || item.conversation_id || item.chat_id || item?.to?.uid || item?.from?.uid || '',
      content: this._extractMessageText(item, { sessionRef, latestTrusteeshipInfo }),
      msgType: item.msg_type || item.message_type || item.content_type || item.type || 1,
      isFromBuyer: this._isBuyerMessage(item),
      isSystem: this._getMessageActor(item) === 'system',
      isRobotManaged: this._isRobotManagedTextMessage(item),
      senderName: this._extractMessageSenderName(item),
      senderId: item.from_uid || item.sender_id || item.from_id || item?.from?.uid || '',
      timestamp: item.send_time || item.time || item.ts || item.timestamp || item.created_at || 0,
      readState: this._extractMessageBuyerReadState(item, { readMark }) || '',
      extra: item.extra || item.ext || null,
      raw: item,
    }));
  }

  _pickRefundText(sources = [], keys = []) {
    return refundParsers.pickRefundText(sources, keys);
  }

  _pickRefundNumber(sources = [], keys = []) {
    return refundParsers.pickRefundNumber(sources, keys);
  }

  _pickRefundBoolean(sources = [], keys = []) {
    return refundParsers.pickRefundBoolean(sources, keys);
  }

  _resolveRefundOrderShippingInfo(sources = []) {
    return refundParsers.resolveRefundOrderShippingInfo(sources);
  }

  _resolveRefundOrderStatusText(sources = []) {
    return refundParsers.resolveRefundOrderStatusText(sources);
  }

  _isRefundOrderEligible(order = {}) {
    return refundParsers.isRefundOrderEligible(order);
  }

  _filterEligibleRefundOrders(orders = []) {
    return refundParsers.filterEligibleRefundOrders(orders);
  }

  _normalizeRefundShippingBenefitStatus(value, options = {}) {
    return refundParsers.normalizeRefundShippingBenefitStatus(value, options);
  }

  _resolveRefundShippingBenefitText(sources = []) {
    return refundParsers.resolveRefundShippingBenefitText(sources);
  }

  _looksLikeRefundOrderNode(node = {}) {
    return refundParsers.looksLikeRefundOrderNode(node);
  }

  _collectRefundOrderNodes(node, bucket, visited, depth = 0) {
    return refundParsers.collectRefundOrderNodes(node, bucket, visited, depth);
  }

  _normalizeRefundOrder(item = {}, fallback = {}, index = 0) {
    return refundParsers.normalizeRefundOrder(item, fallback, index);
  }

  _dedupeRefundOrders(list = [], fallback = {}) {
    return refundParsers.dedupeRefundOrders(list, fallback);
  }

  _extractRefundOrdersFromMessages(sessionMeta = {}, messages = []) {
    return refundParsers.extractRefundOrdersFromMessages(sessionMeta, messages);
  }

  _extractRefundOrdersFromTraffic(sessionMeta = {}) {
    return this._refundOrdersModule.extractRefundOrdersFromTraffic(sessionMeta);
  }

  _extractAfterSalesStatusText(value) {
    return refundParsers.extractAfterSalesStatusText(value);
  }

  _extractAfterSalesDetail(value) {
    return refundParsers.extractAfterSalesDetail(value);
  }

  _mapAfterSalesStatusCodeToText(value) {
    return refundParsers.mapAfterSalesStatusCodeToText(value);
  }

  _pickDisplayAfterSalesStatus(sources = []) {
    return refundParsers.pickDisplayAfterSalesStatus(sources);
  }

  _mergeSideOrderStatusTexts(primary = '', secondary = '') {
    return refundParsers.mergeSideOrderStatusTexts(primary, secondary);
  }

  _extractAfterSalesDetailMapFromPayload(payload = {}) {
    return refundParsers.extractAfterSalesDetailMapFromPayload(payload);
  }

  async _fetchAfterSalesDetailMap(orderSns = []) {
    return this._refundOrdersModule.fetchAfterSalesDetailMap(orderSns);
  }

  async _attachAfterSalesStatus(orders = []) {
    return this._refundOrdersModule.attachAfterSalesStatus(orders);
  }

  _getRefundOrderUid(sessionMeta = {}) {
    return refundParsers.getRefundOrderUid(sessionMeta);
  }

  async _requestRefundOrderPageApi(url, body) {
    if (typeof this._requestInPddPage === 'function') {
      return this._requestInPddPage({
        method: 'POST',
        url,
        source: 'refund-order:page-request',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(body || {}),
      });
    }
    return this._post(url, body || {});
  }

  async _requestGoodsPageApi(urlPath, body = {}, method = 'GET') {
    return this._goodsCardModule.requestGoodsPageApi(urlPath, body, method);
  }

  _buildGoodsCardFromPageApis(goodsPayload, skuPayload, fallback = {}) {
    return this._goodsCardModule.buildGoodsCardFromPageApis(goodsPayload, skuPayload, fallback);
  }

  async _requestRefundApplyApi(urlPath, body = {}, method = 'POST') {
    return this._refundOrdersModule.requestRefundApplyApi(urlPath, body, method);
  }

  _normalizeRefundApplyType(type) {
    return refundParsers.normalizeRefundApplyType(type);
  }

  _normalizeRefundApplyShipStatus(status) {
    return refundParsers.normalizeRefundApplyShipStatus(status);
  }

  _resolveRefundApplyQuestionType(params = {}) {
    return refundParsers.resolveRefundApplyQuestionType(params);
  }

  _buildRefundApplyReposeInfo(params = {}) {
    return refundParsers.buildRefundApplyReposeInfo(params);
  }

  _resolveRefundApplyReposeInfo(infoPayload = {}, params = {}) {
    return refundParsers.resolveRefundApplyReposeInfo(infoPayload, params);
  }

  _normalizeRefundApplyFlag(value, defaultValue = false) {
    return refundParsers.normalizeRefundApplyFlag(value, defaultValue);
  }

  async getRefundApplyInfo(orderSn) {
    return this._refundOrdersModule.getRefundApplyInfo(orderSn);
  }

  async submitRefundApply(params = {}) {
    return this._refundOrdersModule.submitRefundApply(params);
  }

  async getSmallPaymentInfo(params = {}) {
    return this._smallPaymentModule.getSmallPaymentInfo(params);
  }

  _inferSmallPaymentTypeLabel(text) {
    return smallPaymentParsers.inferSmallPaymentTypeLabel(text);
  }

  _resolveSmallPaymentRefundTypeFromTemplate(templateBody, submitTemplateMeta = null) {
    return smallPaymentParsers.resolveSmallPaymentRefundTypeFromTemplate(templateBody, submitTemplateMeta);
  }

  _resolveSmallPaymentRefundTypeFromHistory(detailList = [], desiredLabel = '') {
    return smallPaymentParsers.resolveSmallPaymentRefundTypeFromHistory(detailList, desiredLabel);
  }

  _normalizeSmallPaymentRefundType(value, options = {}) {
    return smallPaymentParsers.normalizeSmallPaymentRefundType(value, options);
  }

  _buildSmallPaymentSubmitRequestBody(params = {}) {
    return smallPaymentParsers.buildSmallPaymentSubmitRequestBody(params);
  }

  async submitSmallPayment(params = {}) {
    return this._smallPaymentModule.submitSmallPayment(params);
  }

  _resolveInviteOrderUid(params = {}) {
    return this._inviteOrderModule.resolveUid(params);
  }

  _getInviteOrderSessionState(uid) {
    return this._inviteOrderModule.getSessionState(uid);
  }

  _formatInviteOrderFen(value) {
    return this._inviteOrderModule.formatFen(value);
  }

  _normalizeInviteOrderGoodsItem(item = {}) {
    return this._inviteOrderModule.normalizeGoodsItem(item);
  }

  _filterInviteOrderGoodsList(goodsList = [], keyword = '') {
    return this._inviteOrderModule.filterGoodsList(goodsList, keyword);
  }

  _buildInviteOrderSnapshot(uid, options = {}) {
    return this._inviteOrderModule.buildSnapshot(uid, options);
  }

  async _loadInviteOrderGoodsList(uid) {
    return this._inviteOrderModule.loadGoodsList(uid);
  }

  async _loadInviteOrderSkuSelector(uid, goodsId) {
    return this._inviteOrderModule.loadSkuSelector(uid, goodsId);
  }

  _buildInviteOrderSkuSpecText(specs = [], options = {}) {
    return this._inviteOrderModule.buildSkuSpecText(specs, options);
  }

  _buildInviteOrderSkuPriceText(sku = {}) {
    return this._inviteOrderModule.buildSkuPriceText(sku);
  }

  async getInviteOrderSkuOptions(params = {}) {
    return this._inviteOrderModule.getSkuOptions(params);
  }

  async _resolveInviteOrderSelection(uid, goodsId, goodsList = [], preferredSkuId = '') {
    return this._inviteOrderModule.resolveSelection(uid, goodsId, goodsList, preferredSkuId);
  }

  async getInviteOrderState(params = {}) {
    return this._inviteOrderModule.getState(params);
  }

  async addInviteOrderItem(params = {}) {
    return this._inviteOrderModule.addItem(params);
  }

  async clearInviteOrderItems(params = {}) {
    return this._inviteOrderModule.clearItems(params);
  }

  async submitInviteOrder(params = {}) {
    return this._inviteOrderModule.submitOrder(params);
  }

  async submitInviteFollow(params = {}) {
    return this._inviteOrderModule.submitFollow(params);
  }

  _parseOrderPriceYuanToFen(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.round(numeric * 100);
  }

  _getLatestOrderPriceUpdateTemplate(orderSn = '') {
    return this._orderPriceModule.getLatestUpdateTemplate(orderSn);
  }

  _rememberOrderPriceUpdateTemplate(entry = {}, options = {}) {
    return this._orderPriceModule.rememberUpdateTemplate(entry, options);
  }

  _summarizeBootstrapDebug(debug = {}) {
    return this._orderPriceModule.summarizeBootstrapDebug(debug);
  }

  async _bootstrapOrderPriceTemplate(params = {}, sessionMeta = {}) {
    return this._orderPriceModule.bootstrapTemplate(params, sessionMeta);
  }

  async updateOrderPrice(params = {}) {
    return this._orderPriceModule.updateOrderPrice(params);
  }

  async _extractRefundOrdersFromPageApis(sessionMeta = {}, options = {}) {
    return this._refundOrdersModule.extractRefundOrdersFromPageApis(sessionMeta, options);
  }

  async _extractAftersaleOrdersFromPageApis(sessionMeta = {}) {
    return this._refundOrdersModule.extractAftersaleOrdersFromPageApis(sessionMeta);
  }

  async _extractRefundOrdersFromDom(sessionMeta = {}) {
    return this._refundOrdersModule.extractRefundOrdersFromDom(sessionMeta);
  }

  async _extractGoodsSpecFromChatPage(sessionMeta = {}, goodsMeta = {}) {
    return this._goodsCardModule.extractGoodsSpecFromChatPage(sessionMeta, goodsMeta);
  }

  async getRefundOrders(sessionRef) {
    return this._refundOrdersModule.getRefundOrders(sessionRef);
  }

  _formatSideOrderDateTime(value) {
    return this._sideOrdersModule.formatDateTime(value);
  }

  _formatOrderRemarkDateTime(value = Date.now()) {
    return orderRemarkParsers.formatOrderRemarkDateTime(value);
  }

  _extractOrderRemarkText(value) {
    return orderRemarkParsers.extractOrderRemarkText(value);
  }

  _normalizeOrderRemarkTag(value) {
    return orderRemarkParsers.normalizeOrderRemarkTag(value);
  }

  _isOrderRemarkSaveIntervalError(error) {
    return orderRemarkParsers.isOrderRemarkSaveIntervalError(error);
  }

  _isOrderRemarkSaveMatched(remark = {}, note = '', tag = '') {
    return orderRemarkParsers.isOrderRemarkSaveMatched(remark, note, tag);
  }

  _maskOrderRemarkOrderSn(orderSn) {
    return orderRemarkParsers.maskOrderRemarkOrderSn(orderSn);
  }

  _summarizeOrderRemarkRequest(urlPath, body = {}, via = 'direct') {
    return orderRemarkParsers.summarizeOrderRemarkRequest(urlPath, body, via);
  }

  _summarizeOrderRemarkResponse(payload) {
    return this._orderRemarkModule.summarizeResponse(payload);
  }

  _getOrderRemarkTagName(tag) {
    return this._orderRemarkModule.getTagName(tag);
  }

  _formatOrderRemarkMeta(value = Date.now()) {
    return orderRemarkParsers.formatOrderRemarkMeta(value);
  }

  async _getOrderRemarkOperatorName() {
    return this._orderRemarkModule.getOperatorName();
  }

  _getOrderRemarkCache(orderSn) {
    return this._orderRemarkModule.getCache(orderSn);
  }

  _setOrderRemarkCache(orderSn, remark = {}) {
    return this._orderRemarkModule.setCache(orderSn, remark);
  }

  _normalizeOrderRemarkTagOptions(payload = {}) {
    return orderRemarkParsers.normalizeOrderRemarkTagOptions(payload);
  }

  async getOrderRemarkTagOptions(force = false) {
    return this._orderRemarkModule.getTagOptions(force);
  }

  async getOrderRemark(orderSn, source = 1) {
    return this._orderRemarkModule.getRemark(orderSn, source);
  }

  async saveOrderRemark(params = {}) {
    return this._orderRemarkModule.saveRemark(params);
  }

  _buildSideOrderSources(item = {}, fallback = {}) {
    return this._sideOrdersModule.buildSources(item, fallback);
  }

  _resolveSideOrderHeadline(tab = 'personal', sources = []) {
    return this._sideOrdersModule.resolveHeadline(tab, sources);
  }

  _isPendingLikeSideOrder(sources = []) {
    return this._sideOrdersModule.isPendingLikeOrder(sources);
  }

  _buildSideOrderMetaRows(tab = 'personal', sources = []) {
    return this._sideOrdersModule.buildMetaRows(tab, sources);
  }

  _formatSideOrderAmount(value, options = {}) {
    return this._sideOrdersModule.formatAmount(value, options);
  }

  _resolveSideOrderDiscountText(sources = []) {
    return this._sideOrdersModule.resolveDiscountText(sources);
  }

  _resolveSideOrderManualPriceInfo(sources = []) {
    return this._sideOrdersModule.resolveManualPriceInfo(sources);
  }

  _resolveSideOrderPendingCountdown(sources = []) {
    return this._sideOrdersModule.resolvePendingCountdown(sources);
  }

  _buildSideOrderSummaryRows(tab = 'personal', sources = [], amountText = '') {
    return this._sideOrdersModule.buildSummaryRows(tab, sources, amountText);
  }

  _shouldShowSideOrderAddressAction(tab = 'personal', sources = []) {
    return this._sideOrdersModule.shouldShowAddressAction(tab, sources);
  }

  _resolveSideOrderAddressInfo(sources = []) {
    return this._sideOrdersModule.resolveAddressInfo(sources);
  }

  _buildSideOrderActionTags(tab = 'personal', sources = []) {
    return this._sideOrdersModule.buildActionTags(tab, sources);
  }

  _normalizeSideOrderCard(item = {}, fallback = {}, tab = 'personal', index = 0) {
    return this._sideOrdersModule.normalizeCard(item, fallback, tab, index);
  }

  async _extractPendingOrdersFromPageApis(sessionMeta = {}) {
    return this._sideOrdersModule.extractPendingOrdersFromPageApis(sessionMeta);
  }

  _getOrderTrafficEntries(urlPart = '', sessionMeta = {}) {
    return this._sideOrdersModule.getOrderTrafficEntries(urlPart, sessionMeta);
  }

  _buildSideOrderCompensatePatch(result = {}) {
    return this._sideOrdersModule.buildCompensatePatch(result);
  }

  _mergeSideOrderCompensatePatch(order = {}, patch = {}) {
    return this._sideOrdersModule.mergeCompensatePatch(order, patch);
  }

  _extractOrderCompensateMapFromTraffic(sessionMeta = {}) {
    return this._sideOrdersModule.extractOrderCompensateMapFromTraffic(sessionMeta);
  }

  _attachOrderCompensateFromTraffic(orders = [], sessionMeta = {}) {
    return this._sideOrdersModule.attachOrderCompensateFromTraffic(orders, sessionMeta);
  }

  _hasAfterSalesContext(sources = []) {
    return this._sideOrdersModule.hasAfterSalesContext(sources);
  }

  _extractAfterSalesStatusMapFromTraffic(orderSns = [], sessionMeta = {}) {
    return this._sideOrdersModule.extractAfterSalesStatusMapFromTraffic(orderSns, sessionMeta);
  }

  _attachAfterSalesStatusFromTraffic(orders = [], sessionMeta = {}) {
    return this._sideOrdersModule.attachAfterSalesStatusFromTraffic(orders, sessionMeta);
  }

  _extractPersonalOrdersFromTraffic(sessionMeta = {}) {
    return this._sideOrdersModule.extractPersonalOrdersFromTraffic(sessionMeta);
  }

  _extractAftersaleOrdersFromTraffic(sessionMeta = {}) {
    return this._sideOrdersModule.extractAftersaleOrdersFromTraffic(sessionMeta);
  }

  _extractPendingOrdersFromTraffic(sessionMeta = {}) {
    return this._sideOrdersModule.extractPendingOrdersFromTraffic(sessionMeta);
  }

  async getSideOrders(sessionRef, tab = 'personal') {
    return this._sideOrdersModule.getSideOrders(sessionRef, tab);
  }

  async getSessionMessages(sessionRef, page = 1, pageSize = 30, options = {}) {
    const allowInitSession = options.allowInitSession !== false;
    // 不再前置 init：先尝试请求，失败再触发 init 兜底，避免每次点击会话都阻塞 ~20s。
    // init 触发位置见下方 chat/list 全部候选失败后的 latitude 兜底之前。

    const sessionMeta = this._normalizeSessionMeta(sessionRef);
    const sessionIds = [
      sessionMeta.sessionId,
      sessionMeta.explicitSessionId,
      sessionMeta.conversationId,
      sessionMeta.chatId,
      sessionMeta.rawId,
      sessionMeta.customerId,
      sessionMeta.userUid,
    ].filter(Boolean);
    const sessionTraffic = this._getLatestSessionTraffic('/plateau/chat/list', sessionIds);
    const latestTraffic = sessionTraffic || this._findLatestTraffic('/plateau/chat/list');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    const templateList = templateBody?.data?.list || {};
    const requestCandidates = this._buildSessionMessageCandidates(sessionMeta, templateList);
    const buildRequestBody = (candidate, useSessionWindow) => {
      const requestList = useSessionWindow
        ? {
            ...templateList,
            with: {
              ...(templateList.with || {}),
              role: candidate.role || templateList.with?.role || 'user',
              id: String(candidate.id),
            },
            start_msg_id: templateList.start_msg_id,
            start_index: templateList.start_index,
            size: pageSize || templateList.size,
          }
        : {
            with: {
              role: candidate.role || templateList.with?.role || 'user',
              id: String(candidate.id),
            },
            start_msg_id: null,
            start_index: Math.max(0, (page - 1) * pageSize),
            size: pageSize || templateList.size || 30,
          };
      // PDD chat/list 普通客服聊天必须带 chat_type_id=1，缺失会直接 500。
      // 模板里若没有则补默认值；非模板分支也用 1 作为默认。
      const fallbackChatTypeId = 1;
      return templateBody
        ? {
            ...this._cloneJson(templateBody),
            data: {
              ...(templateBody.data || {}),
              request_id: this._nextRequestId(),
              cmd: templateBody.data?.cmd || 'list',
              chat_type_id: templateBody.data?.chat_type_id ?? fallbackChatTypeId,
              anti_content: templateBody.data?.anti_content || antiContent,
              list: requestList,
            },
            client: templateBody.client !== undefined && templateBody.client !== null && templateBody.client !== ''
              ? templateBody.client
              : this._getLatestClientValue(),
            anti_content: templateBody.anti_content || antiContent,
          }
        : {
            data: {
              cmd: 'list',
              chat_type_id: fallbackChatTypeId,
              request_id: this._nextRequestId(),
              list: {
                with: {
                  role: candidate.role || 'user',
                  id: String(candidate.id),
                },
                start_msg_id: null,
                start_index: Math.max(0, (page - 1) * pageSize),
                size: pageSize,
              },
              notUpdateUnreplyTs: true,
              anti_content: antiContent,
            },
            client: this._getLatestClientValue(),
            anti_content: antiContent,
          };
    };
    const cachedEntries = this._getApiTrafficEntries()
      .filter(entry => String(entry?.url || '').includes('/plateau/chat/list'))
      .filter(entry => {
        const body = this._safeParseJson(entry?.requestBody);
        const id = String(body?.data?.list?.with?.id || '');
        return requestCandidates.some(candidate => String(candidate.id) === id);
      });
    if (!allowInitSession && !templateBody && !antiContent) {
      for (const entry of cachedEntries) {
        const cachedPayload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
        if (!cachedPayload) continue;
        const cachedMessages = this._parseMessages(cachedPayload, sessionMeta);
        if (cachedMessages.length > 0) {
          this._log('[API] 安全模式读取消息，直接回退页面抓取缓存', {
            sessionId: String(sessionMeta.sessionId || ''),
            count: cachedMessages.length,
          });
          return cachedMessages;
        }
      }
      this._log('[API] 安全模式读取消息缺少模板，跳过初始化链路', {
        sessionId: String(sessionMeta.sessionId || ''),
      });
      return [];
    }
    let fallbackMessages = [];
    let lastError = null;
    for (let index = 0; index < requestCandidates.length; index++) {
      const candidate = requestCandidates[index];
      const useSessionWindow = index === 0
        && !!sessionTraffic
        && this._shouldReuseSessionWindow(templateList, page)
        && String(templateList?.with?.id || '') === String(candidate.id);
      const requestBody = buildRequestBody(candidate, useSessionWindow);
      try {
        const payload = await this._post('/plateau/chat/list', requestBody, undefined, {
          suppressAuthExpired: !allowInitSession,
          ensureMainCookieContext: allowInitSession,
          disableMainCookieContextRetry: !allowInitSession,
        });
        const messages = this._parseMessages(payload, sessionMeta);
        this._log('[API] chat/list 候选响应', {
          candidateId: candidate.id,
          candidateRole: candidate.role,
          count: messages.length,
        });
        if (messages.length > 0) {
          return messages;
        }
        if (!fallbackMessages.length) {
          fallbackMessages = messages;
        }
      } catch (error) {
        lastError = error;
        const payload = error?.payload;
        const payloadPreview = (() => {
          if (payload && typeof payload === 'object') {
            return {
              success: payload.success,
              error_code: payload.error_code ?? payload.errorCode,
              error_msg: payload.error_msg || payload.errorMsg || payload.message,
              result_code: payload?.result?.error_code,
              result_msg: payload?.result?.error_msg,
            };
          }
          if (typeof payload === 'string') {
            return payload.slice(0, 200);
          }
          return undefined;
        })();
        this._log('[API] chat/list 候选失败', {
          candidateId: candidate.id,
          candidateRole: candidate.role,
          statusCode: error?.statusCode,
          message: error.message,
          hasTemplate: !!templateBody,
          chatTypeId: requestBody?.data?.chat_type_id,
          payloadPreview,
        });
      }
    }
    for (const entry of cachedEntries) {
      const cachedPayload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
      if (!cachedPayload) continue;
      const cachedMessages = this._parseMessages(cachedPayload, sessionMeta);
      if (cachedMessages.length > 0) {
        this._log('[API] chat/list 回退页面抓取缓存', {
          sessionId: String(sessionMeta.sessionId || ''),
          count: cachedMessages.length,
        });
        return cachedMessages;
      }
    }
    // 终极降级：chat/list 走 anti_content 链路在没有页面模板时几乎必然 500，
    // 改走商家工作台标准 REST /latitude/message/getHistoryMessage（按 orderSn 查），
    // 该接口无 anti_content，鉴权只看 cookie + token，对带订单的会话非常稳定。
    const orderSn = this._extractSessionOrderSn(sessionMeta);
    if (orderSn) {
      try {
        const historyMessages = await this._fetchHistoryMessagesByOrderSn(orderSn, page, pageSize, sessionMeta);
        if (historyMessages.length > 0) {
          this._log('[API] 降级走 latitude/getHistoryMessage 成功', {
            sessionId: String(sessionMeta.sessionId || ''),
            orderSn,
            count: historyMessages.length,
          });
          return historyMessages;
        }
        this._log('[API] latitude/getHistoryMessage 返回 0 条', {
          sessionId: String(sessionMeta.sessionId || ''),
          orderSn,
        });
      } catch (error) {
        this._log('[API] latitude/getHistoryMessage 调用失败', {
          sessionId: String(sessionMeta.sessionId || ''),
          orderSn,
          statusCode: error?.statusCode,
          message: error?.message,
        });
      }
    } else {
      // 没拿到 orderSn 时主动诊断：把 sessionMeta 关键字段打出来，并询问 PDD"该买家共有多少订单"
      // 这样能立即区分"测试买家无订单"和"买家有订单但我们没解析到"两种情况
      const buyerUid = String(sessionMeta.userUid || sessionMeta.customerId || sessionMeta.sessionId || '').trim();
      const sessionMetaSummary = {
        sessionId: String(sessionMeta.sessionId || ''),
        userUid: String(sessionMeta.userUid || ''),
        customerId: String(sessionMeta.customerId || ''),
        rawKeys: sessionMeta?.raw && typeof sessionMeta.raw === 'object' ? Object.keys(sessionMeta.raw).slice(0, 20) : [],
        rawToUid: String(sessionMeta?.raw?.to?.uid || ''),
        rawUserInfoUid: String(sessionMeta?.raw?.user_info?.uid || ''),
      };
      let buyerOrderQuantity = null;
      if (buyerUid) {
        // 先试 number 再试 string（PDD 该接口对 uid 类型较挑），附上 chat 页 Referer
        const uidAsNumber = Number(buyerUid);
        const uidCandidates = Number.isFinite(uidAsNumber) && String(uidAsNumber) === buyerUid
          ? [uidAsNumber, buyerUid]
          : [buyerUid, uidAsNumber].filter(v => v !== undefined && !Number.isNaN(v));
        const extraHeaders = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          Referer: `${PDD_BASE}/chat-merchant/index.html`,
        };
        for (const uidValue of uidCandidates) {
          try {
            const quantityPayload = await this._post('/latitude/order/userOrderQuantity', { uid: uidValue }, extraHeaders, {
              suppressAuthExpired: true,
              ensureMainCookieContext: false,
              disableMainCookieContextRetry: true,
            });
            const result = quantityPayload?.result || {};
            buyerOrderQuantity = {
              uidType: typeof uidValue,
              sum: Number(result.sum || 0),
              unfinished: Number(result.unfinished || 0),
              unshipped: Number(result.unshipped || 0),
              shippedNotReceived: Number(result.shippedNotReceived || 0),
              received: Number(result.received || 0),
              refund: Number(result.refund || 0),
            };
            break;
          } catch (error) {
            buyerOrderQuantity = { uidType: typeof uidValue, error: error?.message || String(error || '') };
            if (!/bad params/i.test(String(error?.message || ''))) break;
          }
        }
      }
      this._log('[API] 缺少 orderSn 无法降级 latitude/getHistoryMessage', {
        ...sessionMetaSummary,
        buyerOrderQuantity,
      });
    }
    if (lastError) {
      throw lastError;
    }
    return fallbackMessages;
  }

  _extractSessionOrderSn(sessionMeta) {
    if (!sessionMeta || typeof sessionMeta !== 'object') return '';
    const raw = sessionMeta.raw && typeof sessionMeta.raw === 'object' ? sessionMeta.raw : {};
    const candidates = [
      sessionMeta.orderId,
      sessionMeta.orderSn,
      raw.order_sn,
      raw.orderSn,
      raw.order_id,
      raw.orderId,
      raw?.last_order?.order_sn,
      raw?.last_order?.orderSn,
      raw?.goods_info?.order_sn,
    ];
    for (const value of candidates) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    const buyerUid = this._extractSessionBuyerUid(sessionMeta);
    if (buyerUid) {
      const viaTraffic = this._findOrderSnByBuyerUid(buyerUid);
      if (viaTraffic) return viaTraffic;
    }
    return '';
  }

  _extractSessionBuyerUid(sessionMeta) {
    if (!sessionMeta || typeof sessionMeta !== 'object') return '';
    const raw = sessionMeta.raw && typeof sessionMeta.raw === 'object' ? sessionMeta.raw : {};
    const candidates = [
      sessionMeta.userUid,
      sessionMeta.customerId,
      raw?.to?.uid,
      raw?.user_info?.uid,
      raw?.buyer?.uid,
      raw.buyer_uid,
      raw.user_uid,
      raw.uid,
    ];
    for (const value of candidates) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return '';
  }

  // 在本店铺已抓到的 afterSales/queryList 等 mercury 响应里按 buyer uid 反查订单号。
  // pdd-api 和 ticket-api 共享同一个 api-traffic store，所以这条反查链路不需要额外网络请求。
  _findOrderSnByBuyerUid(buyerUid) {
    const target = String(buyerUid || '').trim();
    if (!target) return '';
    const urlHints = [
      '/mercury/mms/afterSales/',
      '/mercury/after_sales/',
      '/mangkhut/mms/orderDetail',
    ];
    const entries = this._getApiTrafficEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const url = String(entry?.url || '');
      if (!urlHints.some(hint => url.includes(hint))) continue;
      const payload = entry?.responseBody;
      const body = typeof payload === 'object' && payload !== null
        ? payload
        : this._safeParseJson(payload);
      if (!body) continue;
      const orderSn = this._searchOrderSnByBuyerUidInPayload(body, target);
      if (orderSn) return orderSn;
    }
    return '';
  }

  _searchOrderSnByBuyerUidInPayload(payload, targetUid) {
    const orderSnKeys = ['orderSn', 'order_sn', 'orderNo', 'order_no'];
    const buyerUidKeys = ['userUid', 'user_uid', 'buyerUid', 'buyer_uid', 'customerId', 'customer_id', 'uid'];
    const queue = [payload];
    const visited = new Set();
    const MAX_NODES = 5000;
    let processed = 0;
    while (queue.length && processed < MAX_NODES) {
      const node = queue.shift();
      processed += 1;
      if (!node || typeof node !== 'object') continue;
      if (visited.has(node)) continue;
      visited.add(node);
      if (!Array.isArray(node)) {
        let matched = false;
        for (const key of buyerUidKeys) {
          const value = node[key];
          if (value === undefined || value === null) continue;
          if (String(value).trim() === targetUid) {
            matched = true;
            break;
          }
        }
        if (matched) {
          for (const key of orderSnKeys) {
            const value = node[key];
            const text = String(value || '').trim();
            if (text) return text;
          }
        }
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === 'object') queue.push(item);
        }
      } else {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') queue.push(value);
        }
      }
    }
    return '';
  }

  async _fetchHistoryMessagesByOrderSn(orderSn, page = 1, pageSize = 20, sessionRef = null) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeSize = Math.max(1, Math.min(50, Number(pageSize) || 20));
    const requestBody = {
      orderSn: String(orderSn),
      startTime: 0,
      endTime: Math.floor(Date.now() / 1000),
      pageNum: safePage - 1,
      pageSize: safeSize,
    };
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
    };
    const payload = await this._post('/latitude/message/getHistoryMessage', requestBody, headers, {
      suppressAuthExpired: true,
      ensureMainCookieContext: false,
      disableMainCookieContextRetry: true,
    });
    const list = this._parseLatitudeHistoryMessageList(payload);
    if (!list.length) return [];
    return this._parseMessages({ result: { list } }, sessionRef);
  }

  _parseLatitudeHistoryMessageList(payload) {
    const raw = payload?.result?.messageList
      || payload?.data?.messageList
      || payload?.messageList
      || [];
    if (!Array.isArray(raw)) return [];
    const items = [];
    for (const entry of raw) {
      if (!entry) continue;
      if (typeof entry === 'object') {
        items.push(entry);
        continue;
      }
      if (typeof entry !== 'string') continue;
      const parsed = this._safeParseJson(entry);
      if (parsed && typeof parsed === 'object') {
        items.push(parsed);
      }
    }
    // 接口默认按"新→旧"返回；按 ts 升序排，和 chat/list 一致
    items.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
    return items;
  }

  async uploadImage(filePath, options = {}) {
    return this._messageSendModule.uploadImage(filePath, options);
  }

  async sendMessage(sessionRef, text, options = {}) {
    return this._messageSendModule.sendMessage(sessionRef, text, options);
  }

  async sendManualMessage(sessionRef, text, options = {}) {
    return this._messageSendModule.sendManualMessage(sessionRef, text, options);
  }

  async sendImage(sessionRef, filePath) {
    return this._messageSendModule.sendImage(sessionRef, filePath);
  }

  async sendImageUrl(sessionRef, imageUrl, extra = {}) {
    return this._messageSendModule.sendImageUrl(sessionRef, imageUrl, extra);
  }

  async getVideoLibrary(params = {}) {
    return this._messageSendModule.getVideoLibrary(params);
  }

  async getVideoFileDetail(params = {}) {
    return this._messageSendModule.getVideoFileDetail(params);
  }

  async waitVideoFileReady(params = {}) {
    return this._messageSendModule.waitVideoFileReady(params);
  }

  async sendVideoUrl(sessionRef, videoUrl, extra = {}) {
    return this._messageSendModule.sendVideoUrl(sessionRef, videoUrl, extra);
  }

  async getGoodsCard(params = {}) {
    return this._goodsCardModule.getGoodsCard(params);
  }

  async markLatestConversations(size = 100) {
    return this._chatPollingModule.markLatestConversations(size);
  }

  async testConnection(options = {}) {
    const steps = [];
    const initializeSession = options?.initializeSession === true;
    let sessions = [];
    if (initializeSession) {
      const sessionInit = await this.initSession(true, {
        source: 'api-test-connection'
      });
      steps.push({ step: 'initSession', ok: !!sessionInit.initialized, detail: sessionInit });
    } else {
      steps.push({ step: 'initSession', ok: false, skipped: true, detail: { reason: 'safe-mode' } });
    }

    const userInfo = await this.getUserInfo();
    steps.push({ step: 'getUserInfo', ok: true, detail: userInfo });

    if (initializeSession) {
      sessions = await this.getSessionList(1, 5);
      steps.push({ step: 'getSessionList', ok: true, detail: { count: sessions.length } });
    } else {
      steps.push({ step: 'getSessionList', ok: false, skipped: true, detail: { reason: 'safe-mode' } });
    }

    return {
      ok: true,
      tokenStatus: await this.getTokenStatus(),
      userInfo,
      sessions,
      steps,
    };
  }

  startPolling() {
    this._chatPollingModule.start();
  }

  stopPolling() {
    this._chatPollingModule.stop();
  }

  async getTokenStatus() {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    const mainCookieContext = await this._getMainCookieContextSummary();
    const tokenMissing = shop?.loginMethod === 'token' && !tokenInfo?.raw;
    const authState = tokenMissing ? 'token_missing' : (this._authExpired ? 'expired' : 'normal');
    const authHint = tokenMissing
      ? '当前店铺缺少接口 Token，请重新导入 Token'
      : (this._authExpired ? '网页登录已失效，请刷新登录态或重新导入 Token' : '');
    return {
      hasToken: !!tokenInfo?.raw,
      shopId: this.shopId,
      mallId: tokenInfo?.mallId || this._getShopInfo()?.mallId || '',
      userId: tokenInfo?.userId || '',
      authExpired: this._authExpired,
      authState,
      authHint,
      requiresReauth: authState !== 'normal',
      sessionInited: this._sessionInited,
      mallName: shop?.name || '',
      serviceName: shop?.account || '',
      serviceAvatar: '',
      mainCookieContext,
    };
  }

  async probeCommonMallInfoRequest(options = {}) {
    return this._shopProfileModule.probeCommonMallInfoRequest(options);
  }

  destroy() {
    this.stopPolling();
    this.removeAllListeners();
    this._chatPollingModule.resetSeenMessages();
    this._sessionCache = [];
  }
}

module.exports = { PddApiClient };
