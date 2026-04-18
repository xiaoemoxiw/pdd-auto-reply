const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { NetworkMonitor } = require('./network-monitor');
const {
  DEFAULT_PAGE_CHROME_UA,
  normalizePddUserAgent,
  isChromeLikeUserAgent,
  getChromeClientHintHeaders,
  applyIdentityHeaders,
  applyCookieContextHeaders,
  applySessionPddPageProfile
} = require('./pdd-request-profile');
const { PddBusinessApiClient } = require('./pdd-business-api-client');
const commonParsers = require('./pdd-api/parsers/common-parsers');
const goodsParsers = require('./pdd-api/parsers/goods-parsers');
const refundParsers = require('./pdd-api/parsers/refund-parsers');
const shopProfileParsers = require('./pdd-api/parsers/shop-profile-parsers');
const orderRemarkParsers = require('./pdd-api/parsers/order-remark-parsers');
const messageParsers = require('./pdd-api/parsers/message-parsers');
const sessionParsers = require('./pdd-api/parsers/session-parsers');
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

const PDD_BASE = 'https://mms.pinduoduo.com';
const PDD_UPLOAD_BASES = [
  'https://galerie-api.pdd.net',
  'https://galerie-api.htj.pdd.net',
  'https://mms-static-1.pddugc.com',
];
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
    this._serviceProfileCache = null;
    this._sessionCache = [];
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
    if (this._sessionInited && !force) return { initialized: true };

    this._authExpired = false;
    const source = String(options?.source || 'unknown').trim() || 'unknown';
    const shop = this._getShopInfo();
    this._log('[API] 会话初始化开始', { force: !!force, source });
    const cookieNamesBefore = await this._listCookieNames();
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const bootstrapUserAgent = normalizePddUserAgent(shop?.userAgent || this._getTokenInfo()?.userAgent || '');
    const bootstrapProfile = applySessionPddPageProfile(win.webContents.session, {
      userAgent: isChromeLikeUserAgent(bootstrapUserAgent) ? bootstrapUserAgent : DEFAULT_PAGE_CHROME_UA,
      tokenInfo: this._getTokenInfo(),
      clientHintsProfile: 'page'
    });
    if (bootstrapProfile?.userAgent) {
      win.webContents.setUserAgent(bootstrapProfile.userAgent);
    }

    const monitor = new NetworkMonitor(win.webContents, {
      onApiTraffic: entry => this._appendBootstrapTraffic(entry),
    });
    monitor.start();

    try {
      await win.loadURL(CHAT_URL);
      let settled = false;
      // 双判定：URL 跳到 chat-merchant 或 bootstrap 抓到模板/anti_content 任一就绪即提前结束。
      // 只看 URL 容易在快速通过 chat-merchant 后又因 SPA 路由跳走时一直等到 20s 超时。
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('/login')) break;
        if (currentUrl.includes('chat-merchant')) {
          settled = true;
          break;
        }
        const bootstrapStatus = this._getConversationBootstrapStatus();
        if (bootstrapStatus.ready) {
          settled = true;
          break;
        }
      }

      const finalUrl = win.webContents.getURL();
      this._sessionInited = settled;
      const bootstrapStatus = settled
        ? await this._waitForConversationBootstrap()
        : this._getConversationBootstrapStatus();
      this._log(`[API] 会话初始化${settled ? '成功' : '未完成'}`, { source });
      if (finalUrl.includes('/login')) {
        this._emitAuthExpired({
          errorMsg: '网页登录已失效，请重新登录或重新导入 Token',
          authState: 'expired',
          source: 'initSession',
        });
      }
      const cookieNamesAfter = await this._listCookieNames();
      const mainCookieContext = await this._getMainCookieContextSummary();
      return {
        initialized: settled,
        source,
        url: finalUrl,
        cookieNamesBefore,
        cookieNamesAfter,
        addedCookieNames: cookieNamesAfter.filter(item => !cookieNamesBefore.includes(item)),
        userAgentUsed: shop?.userAgent || this._getTokenInfo()?.userAgent || '',
        bootstrapStatus,
        mainCookieContext,
      };
    } finally {
      monitor.stop();
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async _post(urlPath, body, extraHeaders, options) {
    return this._request('POST', urlPath, body, extraHeaders, options);
  }

  async _requestOrderRemarkApi(urlPath, body = {}) {
    return this._orderRemarkModule.requestApi(urlPath, body);
  }

  _parseUserInfo(payload) {
    return shopProfileParsers.parseUserInfo(payload, {
      mallId: this._getMallId() || '',
      userId: this._getTokenInfo()?.userId || '',
    });
  }

  _parseServiceProfile(payload) {
    return shopProfileParsers.parseServiceProfile(payload, {
      mallId: this._getMallId() || '',
      shopName: this._getShopInfo()?.name || '',
    });
  }

  _getShopInfoRequestHeaders(type = 'default') {
    const antiContent = this._getLatestAntiContent();
    if (type === 'credential') {
      return {
        Referer: `${PDD_BASE}/mallcenter/info/main/index`,
        Origin: PDD_BASE,
        ...(antiContent ? { 'anti-content': antiContent } : {}),
      };
    }
    return {
      Referer: PDD_BASE,
      Origin: PDD_BASE,
      ...(antiContent ? { 'anti-content': antiContent } : {}),
    };
  }

  async getUserInfo(options = {}) {
    try {
      const payload = await this._post('/janus/api/userinfo', {}, this._getShopInfoRequestHeaders('mall'), options);
      return this._parseUserInfo(payload);
    } catch (error) {
      const payload = await this._post('/janus/api/new/userinfo', {}, this._getShopInfoRequestHeaders('mall'), options);
      return this._parseUserInfo(payload);
    }
  }

  async getServiceProfile(force = false, options = {}) {
    if (this._serviceProfileCache && !force) {
      return this._serviceProfileCache;
    }

    const cachedPayload = this._getLatestResponseBody('/chats/userinfo/realtime');
    const cachedProfile = this._parseServiceProfile(cachedPayload);
    const hasCachedProfile = !!(cachedProfile.mallName || cachedProfile.serviceName || cachedProfile.serviceAvatar);
    if (hasCachedProfile && !force) {
      this._serviceProfileCache = cachedProfile;
      return cachedProfile;
    }

    try {
      const payload = await this._request('GET', '/chats/userinfo/realtime?get_response=true', null, {}, options);
      const profile = this._parseServiceProfile(payload);
      this._serviceProfileCache = profile;
      return profile;
    } catch (error) {
      if (hasCachedProfile) {
        this._serviceProfileCache = cachedProfile;
        return cachedProfile;
      }
      throw error;
    }
  }

  _parseMallInfo(payload) {
    return shopProfileParsers.parseMallInfo(payload, { mallId: this._getMallId() || '' });
  }

  _parseCredentialInfo(payload) {
    return shopProfileParsers.parseCredentialInfo(payload, { mallId: this._getMallId() || '' });
  }

  async getMallInfo(options = {}) {
    const payload = await this._request('GET', '/earth/api/mallInfo/commonMallInfo', null, this._getShopInfoRequestHeaders('mall'), options);
    return this._parseMallInfo(payload);
  }

  async getCredentialInfo(options = {}) {
    const payload = await this._request('GET', '/earth/api/mallInfo/queryFinalCredentialNew', null, this._getShopInfoRequestHeaders('credential'), options);
    return this._parseCredentialInfo(payload);
  }

  async getShopProfile(force = false) {
    if (force) {
      this._serviceProfileCache = null;
    }
    const requestOptions = { suppressAuthExpired: true };
    const [userInfoResult, serviceProfileResult, mallInfoResult, credentialInfoResult] = await Promise.allSettled([
      this.getUserInfo(requestOptions),
      this.getServiceProfile(force, requestOptions),
      this.getMallInfo(requestOptions),
      this.getCredentialInfo(requestOptions)
    ]);
    const userInfo = userInfoResult.status === 'fulfilled' ? userInfoResult.value : {};
    const serviceProfile = serviceProfileResult.status === 'fulfilled' ? serviceProfileResult.value : {};
    const mallInfo = mallInfoResult.status === 'fulfilled' ? mallInfoResult.value : {};
    const credentialInfo = credentialInfoResult.status === 'fulfilled' ? credentialInfoResult.value : {};
    const resultEntries = [
      ['userInfo', userInfoResult],
      ['serviceProfile', serviceProfileResult],
      ['mallInfo', mallInfoResult],
      ['credentialInfo', credentialInfoResult]
    ];
    const apiResolvedSources = resultEntries
      .filter(([, item]) => item?.status === 'fulfilled')
      .map(([name]) => name);
    const apiFailedSources = resultEntries
      .filter(([, item]) => item?.status !== 'fulfilled')
      .map(([name]) => name);
    const apiAuthFailedSources = resultEntries
      .filter(([, item]) => item?.status === 'rejected' && (item.reason?.authExpired || this._isAuthError(item.reason?.errorCode)))
      .map(([name]) => name);
    if (apiResolvedSources.length > 0) {
      this._authExpired = false;
    }
    return {
      mallId: mallInfo.mallId || credentialInfo.mallId || serviceProfile.mallId || userInfo.mallId || this._getMallId() || '',
      mallName: mallInfo.mallName || credentialInfo.mallName || serviceProfile.mallName || '',
      account: userInfo.nickname || serviceProfile.serviceName || '',
      mobile: userInfo.mobile || '',
      category: mallInfo.category || '',
      logo: mallInfo.logo || serviceProfile.serviceAvatar || '',
      companyName: credentialInfo.companyName || '',
      merchantType: credentialInfo.merchantType || '',
      apiSuccessCount: apiResolvedSources.length,
      apiResolvedSources,
      apiFailedSources,
      apiAuthFailedCount: apiAuthFailedSources.length,
      apiAuthFailedSources,
    };
  }

  _extractSessionPreviewText(item) {
    return sessionParsers.extractSessionPreviewText(item);
  }

  _extractSessionPreviewTime(item) {
    return sessionParsers.extractSessionPreviewTime(item);
  }

  _getSessionDedupKey(session = {}) {
    return sessionParsers.getSessionDedupKey(session);
  }

  _mergeSessionEntries(existing = {}, incoming = {}) {
    return sessionParsers.mergeSessionEntries(existing, incoming);
  }

  _dedupeSessionList(sessions = []) {
    return sessionParsers.dedupeSessionList(sessions);
  }

  _extractSessionCreatedTime(item) {
    return sessionParsers.extractSessionCreatedTime(item);
  }

  _extractSessionLastMessageActor(item = {}) {
    return sessionParsers.extractSessionLastMessageActor(item, this._getMallId() || '');
  }

  _normalizeTimestampMs(value) {
    return sessionParsers.normalizeTimestampMs(value);
  }

  _isTodayTimestamp(value) {
    return sessionParsers.isTodayTimestamp(value);
  }

  _getRecentSessionStartMs() {
    return sessionParsers.getRecentSessionStartMs();
  }

  _isWithinRecentTwoDaysTimestamp(value) {
    return sessionParsers.isWithinRecentTwoDaysTimestamp(value);
  }

  _hasPendingReplySession(session = {}) {
    return sessionParsers.hasPendingReplySession(session);
  }

  _filterDisplaySessions(sessions = []) {
    return sessionParsers.filterDisplaySessions(sessions);
  }

  _sortDisplaySessions(sessions = []) {
    return sessionParsers.sortDisplaySessions(sessions);
  }

  _pickPendingBuyerMessage(messages = [], buyerIds = [], sessionMeta = {}) {
    return sessionParsers.pickPendingBuyerMessage(messages, buyerIds, sessionMeta, this._getMallId() || '');
  }

  _parseSessionIdentity(item = {}) {
    return sessionParsers.parseSessionIdentity(item, this._getMallId() || '');
  }

  _pickDisplayText(sources = [], keys = []) {
    return sessionParsers.pickDisplayText(sources, keys);
  }

  _resolveBuyerParticipant(item = {}) {
    return sessionParsers.resolveBuyerParticipant(item, this._getMallId() || '');
  }

  _extractSessionCustomerName(item = {}) {
    return sessionParsers.extractSessionCustomerName(item, this._getMallId() || '');
  }

  _extractSessionCustomerAvatar(item = {}) {
    return sessionParsers.extractSessionCustomerAvatar(item, this._getMallId() || '');
  }

  _extractMessageSenderName(item = {}) {
    return sessionParsers.extractMessageSenderName(item, this._getMallId() || '');
  }

  _parseSessionList(payload) {
    return sessionParsers.parseSessionList(payload, this._getMallId() || '');
  }

  _describeSessionListPayload(payload) {
    return sessionParsers.describeSessionListPayload(payload);
  }

  _getCachedSessionFallback() {
    const urlParts = [
      '/plateau/chat/latest_conversations',
      '/plateau/conv_list/status',
    ];
    for (const urlPart of urlParts) {
      const cachedPayload = this._getLatestResponseBody(urlPart);
      const cachedSessions = this._filterDisplaySessions(this._parseSessionList(cachedPayload));
      if (cachedSessions.length > 0) {
        return { sessions: cachedSessions, source: urlPart };
      }
    }
    return { sessions: [], source: '' };
  }

  _buildSessionListBody(page, pageSize, templateBody, antiContent) {
    const requestBody = templateBody
      ? {
          ...this._cloneJson(templateBody),
          data: {
            ...templateBody.data,
            request_id: this._nextRequestId(),
            cmd: templateBody.data?.cmd || 'latest_conversations',
            page: page || templateBody.data?.page,
            offset: Math.max(0, (page - 1) * pageSize),
            size: pageSize || templateBody.data?.size,
            anti_content: templateBody.data?.anti_content || antiContent,
          },
          client: templateBody.client !== undefined && templateBody.client !== null && templateBody.client !== ''
            ? templateBody.client
            : this._getLatestClientValue(),
          anti_content: templateBody.anti_content || antiContent,
        }
      : {
          data: {
            request_id: this._nextRequestId(),
            cmd: 'latest_conversations',
            version: 2,
            need_unreply_time: true,
            page,
            size: pageSize,
            end_time: Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
            anti_content: antiContent,
          },
          client: this._getLatestClientValue(),
          anti_content: antiContent,
        };
    if (requestBody?.data && 'chat_type_id' in requestBody.data) {
      delete requestBody.data.chat_type_id;
    }
    return requestBody;
  }

  async getSessionList(page = 1, pageSize = 20, options = {}) {
    const allowInitSession = options.allowInitSession !== false;
    // 不再前置 initSession：cookie 已经在主上下文里就绪后，fallback 模板的 latest_conversations
    // 通常就能 200 拿到真实数据。把 init 留作"请求失败/空"的兜底，避免每次都阻塞 ~20s。
    let templateBody = this._getLatestConversationRequestBody();
    let antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    if (!templateBody && !antiContent && page === 1 && this._sessionCache.length === 0 && allowInitSession) {
      // 已经有 init 在跑，或本来就有 bootstrap 数据，等一小段把模板凑齐就好
      const bootstrapStatus = await this._waitForConversationBootstrap(800);
      templateBody = this._getLatestConversationRequestBody();
      antiContent = templateBody?.anti_content || this._getLatestAntiContent();
      this._log('[API] 首次会话拉取预热结果', bootstrapStatus);
    }
    const requestBody = this._buildSessionListBody(page, pageSize, templateBody, antiContent);
    this._log('[API] 拉取会话列表', {
      page,
      pageSize,
      client: requestBody?.client,
      hasTopAntiContent: !!requestBody?.anti_content,
      hasBodyAntiContent: !!requestBody?.data?.anti_content,
      chatTypeId: requestBody?.data?.chat_type_id,
      templateSource: templateBody ? 'traffic' : 'fallback',
    });
    try {
      const payload = await this._post('/plateau/chat/latest_conversations', requestBody);
      const parsedSessions = this._parseSessionList(payload);
      let sessions = this._filterDisplaySessions(parsedSessions);
      if (!sessions.length && parsedSessions.length > 0) {
        sessions = this._sortDisplaySessions(parsedSessions);
        this._log('[API] 会话列表近两天过滤后为空，回退展示原始会话', {
          parsedCount: parsedSessions.length,
          returnedCount: sessions.length,
        });
      }
      this._log('[API] 会话列表响应解析', {
        count: sessions.length,
        summary: this._describeSessionListPayload(payload),
      });
      if (sessions.length > 0) {
        this._sessionCache = sessions;
        return sessions;
      }
      if (page === 1 && this._sessionCache.length === 0) {
        const retryBootstrapStatus = await this._waitForConversationBootstrap(1500);
        const retryTemplateBody = this._getLatestConversationRequestBody();
        const retryAntiContent = retryTemplateBody?.anti_content || this._getLatestAntiContent();
        const retryRequestBody = this._buildSessionListBody(page, pageSize, retryTemplateBody, retryAntiContent);
        this._log('[API] latest_conversations 首次为空，准备重试', {
          bootstrapStatus: retryBootstrapStatus,
          client: retryRequestBody?.client,
          hasTopAntiContent: !!retryRequestBody?.anti_content,
          hasBodyAntiContent: !!retryRequestBody?.data?.anti_content,
          templateSource: retryTemplateBody ? 'traffic' : 'fallback',
        });
        await this._sleep(800);
        const retryPayload = await this._post('/plateau/chat/latest_conversations', retryRequestBody);
        const retryParsedSessions = this._parseSessionList(retryPayload);
        let retrySessions = this._filterDisplaySessions(retryParsedSessions);
        if (!retrySessions.length && retryParsedSessions.length > 0) {
          retrySessions = this._sortDisplaySessions(retryParsedSessions);
          this._log('[API] 会话列表重试近两天过滤后为空，回退展示原始会话', {
            parsedCount: retryParsedSessions.length,
            returnedCount: retrySessions.length,
          });
        }
        this._log('[API] 会话列表重试响应解析', {
          count: retrySessions.length,
          summary: this._describeSessionListPayload(retryPayload),
        });
        if (retrySessions.length > 0) {
          this._sessionCache = retrySessions;
          return retrySessions;
        }
      }
      const { sessions: cachedSessions, source } = this._getCachedSessionFallback();
      if (cachedSessions.length > 0) {
        this._sessionCache = cachedSessions;
        this._log('[API] latest_conversations 直调为空，回退页面抓取缓存', { source });
        return cachedSessions;
      }
      if (page === 1 && this._sessionCache.length > 0) {
        this._log('[API] latest_conversations 直调为空，回退内存会话缓存');
        return this._sessionCache;
      }
      this._sessionCache = sessions;
      this._log('[API] 会话列表拉取成功', {
        count: sessions.length,
        payloadKeys: Object.keys(payload?.result || payload?.data || {}),
      });
      return sessions;
    } catch (error) {
      const { sessions: cachedSessions, source } = this._getCachedSessionFallback();
      if (cachedSessions.length > 0) {
        this._sessionCache = cachedSessions;
        this._log('[API] latest_conversations 直调失败，回退页面抓取缓存', { message: error.message, source });
        return cachedSessions;
      }
      // 直调失败 + 缓存为空 + 允许 init + 尚未 init → 触发一次 init 后再试
      if (allowInitSession && !this._sessionInited) {
        this._log('[API] latest_conversations 直调失败，触发 initSession 后重试', { message: error.message });
        try {
          await this.initSession();
        } catch (initError) {
          this._log('[API] initSession 失败', { message: initError?.message || String(initError || '') });
        }
        const retryTemplateBody = this._getLatestConversationRequestBody();
        const retryAntiContent = retryTemplateBody?.anti_content || this._getLatestAntiContent();
        const retryRequestBody = this._buildSessionListBody(page, pageSize, retryTemplateBody, retryAntiContent);
        try {
          const retryPayload = await this._post('/plateau/chat/latest_conversations', retryRequestBody);
          const retryParsed = this._parseSessionList(retryPayload);
          let retrySessions = this._filterDisplaySessions(retryParsed);
          if (!retrySessions.length && retryParsed.length > 0) {
            retrySessions = this._sortDisplaySessions(retryParsed);
          }
          if (retrySessions.length > 0) {
            this._sessionCache = retrySessions;
            return retrySessions;
          }
        } catch (retryError) {
          this._log('[API] init 后重试仍失败', {
            message: retryError?.message || String(retryError || ''),
          });
        }
      }
      this._log('[API] 会话列表拉取失败', {
        message: error.message,
        statusCode: error.statusCode || 0,
        errorCode: error.errorCode || 0,
        payload: error.payload || null,
      });
      throw error;
    }
  }

  _normalizeOrderSn(value) {
    return sessionParsers.normalizeOrderSn(value);
  }

  _matchSessionByOrderSn(session = {}, orderSn = '') {
    return sessionParsers.matchSessionByOrderSn(session, orderSn);
  }

  _findCachedSessionByOrderSn(orderSn = '', sessions = []) {
    const list = Array.isArray(sessions) ? sessions : [];
    const matched = list.find(item => this._matchSessionByOrderSn(item, orderSn));
    return matched ? this._cloneJson(matched) : null;
  }

  _findCachedSessionByUid(uid = '') {
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) return null;
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
      ].map(value => String(value || '').trim()).filter(Boolean);
      return candidates.includes(normalizedUid);
    });
    return matched ? this._cloneJson(matched) : null;
  }

  _parseOrderHistoryMessageItem(item) {
    if (!item) return null;
    if (typeof item === 'string') {
      const parsed = this._safeParseJson(item);
      return parsed && typeof parsed === 'object' ? parsed : null;
    }
    return item && typeof item === 'object' ? item : null;
  }

  async getHistoryMessagesByOrderSn(orderSn, options = {}) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单号');
    }
    const payload = await this._post('/latitude/message/getHistoryMessage', {
      orderSn: normalizedOrderSn,
      startTime: Math.max(0, Number(options?.startTime || 0) || 0),
      endTime: Math.max(0, Number(options?.endTime || Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000)),
      pageNum: Math.max(0, Number(options?.pageNum || 0) || 0),
      pageSize: Math.max(1, Math.min(Number(options?.pageSize || 20) || 20, 100)),
    });
    const normalizedList = (Array.isArray(payload?.result?.messageList) ? payload.result.messageList : [])
      .map(item => this._parseOrderHistoryMessageItem(item))
      .filter(Boolean);
    const messages = this._parseMessages({
      result: {
        messages: normalizedList,
      },
    });
    return {
      payload,
      messages,
      userInfo: payload?.result?.userInfo && typeof payload.result.userInfo === 'object'
        ? payload.result.userInfo
        : {},
      mallInfo: payload?.result?.mallInfo && typeof payload.result.mallInfo === 'object'
        ? payload.result.mallInfo
        : {},
    };
  }

  _buildSyntheticSessionFromOrderHistory(orderSn = '', history = {}) {
    const normalizedOrderSn = String(orderSn || '').trim();
    const payload = history?.payload && typeof history.payload === 'object' ? history.payload : {};
    const userInfo = history?.userInfo && typeof history.userInfo === 'object' ? history.userInfo : {};
    const mallInfo = history?.mallInfo && typeof history.mallInfo === 'object' ? history.mallInfo : {};
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const buyerMessage = messages.find(item => item?.isFromBuyer && String(item?.senderId || '').trim());
    const latestMessage = messages.length ? messages[messages.length - 1] : null;
    const uid = String(
      userInfo?.uid
      || buyerMessage?.senderId
      || buyerMessage?.raw?.from?.uid
      || ''
    ).trim();
    if (!uid) return null;
    const cachedSession = this._findCachedSessionByUid(uid);
    if (cachedSession) {
      return {
        ...cachedSession,
        orderId: cachedSession.orderId || normalizedOrderSn,
        customerName: cachedSession.customerName || String(userInfo?.nickName || userInfo?.nickname || '').trim(),
        customerAvatar: cachedSession.customerAvatar || String(userInfo?.avatar || '').trim(),
      };
    }
    const customerName = String(userInfo?.nickName || userInfo?.nickname || buyerMessage?.senderName || '').trim();
    const customerAvatar = String(userInfo?.avatar || '').trim();
    return {
      sessionId: uid,
      explicitSessionId: '',
      conversationId: '',
      chatId: '',
      rawId: '',
      customerId: uid,
      userUid: uid,
      customerName,
      customerAvatar,
      lastMessage: String(latestMessage?.content || '').trim(),
      lastMessageTime: Number(latestMessage?.timestamp || 0) || 0,
      lastMessageActor: String(latestMessage?.actor || 'unknown'),
      lastMessageIsFromBuyer: latestMessage?.isFromBuyer === true,
      createdAt: Number(messages[0]?.timestamp || latestMessage?.timestamp || 0) || 0,
      unreadCount: 0,
      isTimeout: false,
      waitTime: 0,
      groupNumber: 0,
      group_number: 0,
      orderId: normalizedOrderSn,
      goodsInfo: null,
      csUid: '',
      mallId: String(mallInfo?.mallId || ''),
      mallName: String(mallInfo?.mallName || ''),
      isShopMember: null,
      raw: {
        ...(payload?.result || {}),
        user_info: {
          uid,
          nickname: customerName,
          avatar: customerAvatar,
        },
        uid,
        customer_id: uid,
        buyer_id: uid,
        order_id: normalizedOrderSn,
        order_sn: normalizedOrderSn,
      },
    };
  }

  async findSessionByOrderSn(orderSn, options = {}) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单号');
    }
    if (!this._sessionInited) {
      await this.initSession();
    }

    let matchedSession = this._findCachedSessionByOrderSn(normalizedOrderSn, this._sessionCache);
    if (matchedSession) {
      return matchedSession;
    }

    const pageLimit = Math.max(1, Math.min(Number(options?.pageLimit || 4) || 4, 10));
    const pageSize = Math.max(20, Math.min(Number(options?.pageSize || 50) || 50, 100));
    for (let page = 1; page <= pageLimit; page += 1) {
      const sessions = await this.getSessionList(page, pageSize);
      matchedSession = this._findCachedSessionByOrderSn(normalizedOrderSn, sessions);
      if (matchedSession) {
        return matchedSession;
      }
      if (!Array.isArray(sessions) || sessions.length < pageSize) {
        break;
      }
    }
    try {
      const history = await this.getHistoryMessagesByOrderSn(normalizedOrderSn, {
        pageSize: Math.max(10, Math.min(Number(options?.historyPageSize || 20) || 20, 100)),
      });
      const syntheticSession = this._buildSyntheticSessionFromOrderHistory(normalizedOrderSn, history);
      if (!syntheticSession?.sessionId) {
        throw new Error('未找到对应订单会话');
      }
      return syntheticSession;
    } catch (error) {
      this._log('[API] 按订单号查找会话失败', {
        orderSn: normalizedOrderSn,
        message: error.message,
      });
      throw new Error('未找到对应订单会话');
    }
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

  _summarizePreparedHeaders(headers = {}) {
    const userAgent = String(headers['user-agent'] || headers['User-Agent'] || '').trim();
    const cookieHeader = String(headers.cookie || '').trim();
    const cookieNames = cookieHeader
      ? cookieHeader
        .split(';')
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .map(item => item.split('=')[0].trim())
        .filter(Boolean)
      : [];
    return {
      hasCookie: !!cookieHeader,
      cookieNames,
      hasXToken: !!headers['X-PDD-Token'],
      hasWindowsAppToken: !!headers['windows-app-shop-token'],
      hasPddid: !!headers.pddid,
      hasEtag: !!headers.etag,
      hasVerifyAuthToken: !!(headers.VerifyAuthToken || headers.verifyauthtoken),
      hasAntiContent: !!(headers['anti-content'] || headers['Anti-Content']),
      referer: headers.Referer || headers.referer || '',
      origin: headers.Origin || headers.origin || '',
      secChUaPlatform: headers['sec-ch-ua-platform'] || '',
      userAgent,
      userAgentKind: userAgent.includes('PddWorkbench-Online')
        ? 'workbench'
        : (userAgent ? 'chrome-like' : 'missing'),
    };
  }

  _summarizeWarmupResult(result = null) {
    if (!result || typeof result !== 'object') return null;
    return {
      ready: !!result.ready,
      error: result.error || '',
      url: result.url || result.currentUrl || '',
      entryUrl: result.entryUrl || '',
      attemptedEntryUrls: Array.isArray(result.attemptedEntryUrls) ? result.attemptedEntryUrls : [],
      cookieNames: Array.isArray(result.cookieNames) ? result.cookieNames : [],
      cookieScopes: Array.isArray(result.cookieScopes) ? result.cookieScopes : [],
      hasPassId: !!result.hasPassId,
      hasNanoFp: !!result.hasNanoFp,
      hasRckk: !!result.hasRckk,
    };
  }

  _buildSafeApiResultSummary(result = {}) {
    return {
      success: !!result.success,
      skipped: !!result.skipped,
      error: result.error || '',
      statusCode: Number(result.statusCode || 0),
      errorCode: Number(result.errorCode || 0),
      authExpired: !!result.authExpired,
      mallId: result.mallId || '',
      mallName: result.mallName || '',
      username: result.username || '',
      nickname: result.nickname || '',
      companyName: result.companyName || '',
      merchantType: result.merchantType || '',
      category: result.category || '',
    };
  }

  async probeCommonMallInfoRequest(options = {}) {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    const requestHeaders = this._getShopInfoRequestHeaders('mall');
    const mainCookieContextBefore = await this._getMainCookieContextSummary();
    let warmupResult = null;
    let warmupError = '';

    if (
      options.refreshMainCookieContext !== false
      && typeof this._refreshMainCookieContext === 'function'
      && shop?.loginMethod === 'token'
    ) {
      try {
        warmupResult = await this._refreshMainCookieContext({
          shopId: this.shopId,
          reason: 'manual-commonMallInfo-probe',
          source: 'shop-auth-probe',
        });
      } catch (error) {
        warmupError = error?.message || String(error);
      }
    }

    const mainCookieContextAfter = await this._getMainCookieContextSummary();
    let preparedHeaders = null;
    let prepareError = '';

    try {
      const prepared = await this._prepareRequestHeaders(undefined, requestHeaders, {
        ensureMainCookieContext: false,
      });
      preparedHeaders = this._summarizePreparedHeaders(prepared.headers);
    } catch (error) {
      prepareError = error?.message || String(error);
      const fallbackHeaders = await this._buildHeaders(undefined, requestHeaders);
      preparedHeaders = this._summarizePreparedHeaders(fallbackHeaders);
    }

    const missingRequiredCookies = [
      !mainCookieContextAfter.hasPassId ? 'PASS_ID' : '',
      !mainCookieContextAfter.hasNanoFp ? '_nano_fp' : '',
      !mainCookieContextAfter.hasRckk ? 'rckk' : '',
    ].filter(Boolean);

    let commonMallInfo = {
      success: false,
      skipped: !mainCookieContextAfter.hasRequiredMainCookies,
      error: mainCookieContextAfter.hasRequiredMainCookies
        ? ''
        : (prepareError || '主站 Cookie 未完整建立'),
      statusCode: 0,
      errorCode: 0,
      authExpired: false,
      mallId: '',
      mallName: '',
    };

    const userInfo = {
      success: false,
      skipped: !mainCookieContextAfter.hasRequiredMainCookies,
      error: mainCookieContextAfter.hasRequiredMainCookies
        ? ''
        : (prepareError || '主站 Cookie 未完整建立'),
      statusCode: 0,
      errorCode: 0,
      authExpired: false,
      mallId: '',
      username: '',
      nickname: '',
    };
    const credentialInfo = {
      success: false,
      skipped: !mainCookieContextAfter.hasRequiredMainCookies,
      error: mainCookieContextAfter.hasRequiredMainCookies
        ? ''
        : (prepareError || '主站 Cookie 未完整建立'),
      statusCode: 0,
      errorCode: 0,
      authExpired: false,
      mallId: '',
      mallName: '',
      companyName: '',
      merchantType: '',
    };

    if (mainCookieContextAfter.hasRequiredMainCookies) {
      try {
        const payload = await this._request(
          'GET',
          '/earth/api/mallInfo/commonMallInfo',
          null,
          requestHeaders,
          { suppressAuthExpired: true }
        );
        const info = this._parseMallInfo(payload);
        commonMallInfo = {
          success: true,
          skipped: false,
          error: '',
          statusCode: 200,
          errorCode: 0,
          authExpired: false,
          mallId: info?.mallId || '',
          mallName: info?.mallName || '',
          category: info?.category || '',
          logo: info?.logo || '',
        };
      } catch (error) {
        commonMallInfo = {
          success: false,
          skipped: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode || 0),
          errorCode: Number(error?.errorCode || 0),
          authExpired: !!error?.authExpired,
          mallId: '',
          mallName: '',
        };
      }

      try {
        const info = await this.getUserInfo({ suppressAuthExpired: true });
        Object.assign(userInfo, {
          success: true,
          skipped: false,
          error: '',
          statusCode: 200,
          errorCode: 0,
          authExpired: false,
          mallId: info?.mallId || '',
          username: info?.username || '',
          nickname: info?.nickname || '',
        });
      } catch (error) {
        Object.assign(userInfo, {
          success: false,
          skipped: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode || 0),
          errorCode: Number(error?.errorCode || 0),
          authExpired: !!error?.authExpired,
        });
      }

      try {
        const info = await this.getCredentialInfo({ suppressAuthExpired: true });
        Object.assign(credentialInfo, {
          success: true,
          skipped: false,
          error: '',
          statusCode: 200,
          errorCode: 0,
          authExpired: false,
          mallId: info?.mallId || '',
          mallName: info?.mallName || '',
          companyName: info?.companyName || '',
          merchantType: info?.merchantType || '',
        });
      } catch (error) {
        Object.assign(credentialInfo, {
          success: false,
          skipped: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode || 0),
          errorCode: Number(error?.errorCode || 0),
          authExpired: !!error?.authExpired,
        });
      }
    }

    const safeApiResults = {
      mallInfo: this._buildSafeApiResultSummary({
        ...commonMallInfo,
        category: commonMallInfo?.category || '',
      }),
      userInfo: this._buildSafeApiResultSummary(userInfo),
      credentialInfo: this._buildSafeApiResultSummary(credentialInfo),
    };
    const safeApiSuccessCount = Object.values(safeApiResults).filter(item => item?.success).length;

    return {
      success: safeApiSuccessCount > 0,
      shopId: this.shopId,
      request: {
        method: 'GET',
        url: `${PDD_BASE}/earth/api/mallInfo/commonMallInfo`,
        referer: requestHeaders.Referer || '',
        origin: requestHeaders.Origin || '',
        hasAntiContentTemplate: !!requestHeaders['anti-content'],
      },
      input: {
        loginMethod: shop?.loginMethod || '',
        mallId: tokenInfo?.mallId || shop?.mallId || '',
        userId: tokenInfo?.userId || '',
        hasToken: !!tokenInfo?.raw,
        hasWindowsAppShopToken: !!tokenInfo?.raw,
        hasPddid: !!tokenInfo?.pddid,
        hasUserAgent: !!normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || ''),
      },
      mainCookieContextBefore,
      warmupResult: this._summarizeWarmupResult(warmupResult?.result || warmupResult),
      warmupError,
      mainCookieContextAfter,
      missingRequiredCookies,
      preparedHeaders,
      prepareError,
      commonMallInfo,
      safeApiResults,
      safeApiSuccessCount,
    };
  }

  destroy() {
    this.stopPolling();
    this.removeAllListeners();
    this._chatPollingModule.resetSeenMessages();
    this._sessionCache = [];
  }
}

module.exports = { PddApiClient };
