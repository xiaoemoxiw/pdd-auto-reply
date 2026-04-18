const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const { EventEmitter } = require('events');
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

const PDD_BASE = 'https://mms.pinduoduo.com';
const PDD_UPLOAD_BASES = [
  'https://galerie-api.pdd.net',
  'https://galerie-api.htj.pdd.net',
  'https://mms-static-1.pddugc.com',
];
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;
const POLL_INTERVAL = 5000;
const POLL_INTERVAL_IDLE = 15000;
class PddApiClient extends EventEmitter {
  constructor(shopId, options = {}) {
    super();
    this.shopId = shopId;
    this.partition = `persist:pddv2-${shopId}`;
    this._polling = false;
    this._pollTimer = null;
    this._sessionInited = false;
    this._authExpired = false;
    this._serviceProfileCache = null;
    this._orderRemarkTagOptionsCache = null;
    this._orderRemarkCache = new Map();
    this._seenMessageIds = new Set();
    this._pollBootstrapDone = false;
    this._sessionCache = [];
    this._bootstrapTraffic = [];
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._requestInPddPage = options.requestInPddPage || null;
    this._executeInPddPage = options.executeInPddPage || null;
    this._getOrderPriceUpdateTemplate = options.getOrderPriceUpdateTemplate || (() => null);
    this._setOrderPriceUpdateTemplate = options.setOrderPriceUpdateTemplate || null;
    this._getSmallPaymentSubmitTemplate = options.getSmallPaymentSubmitTemplate || (() => null);
    this._refreshMainCookieContext = options.refreshMainCookieContext || null;
    this._goodsCardModule = new GoodsCardModule(this);
    this._refundOrdersModule = new RefundOrdersModule(this);
    this._smallPaymentModule = new SmallPaymentModule(this);
    this._orderPriceModule = new OrderPriceModule(this);
    this._inviteOrderModule = new InviteOrderModule(this);
    this._sideOrdersModule = new SideOrdersModule(this);
  }

  _log(message, extra) {
    this._onLog(message, extra);
  }

  _getSession() {
    return session.fromPartition(this.partition);
  }

  _getTokenInfo() {
    return (global.__pddTokens && global.__pddTokens[this.shopId]) || null;
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

  _findLatestTraffic(urlPart) {
    const list = this._getApiTrafficEntries();
    for (let i = list.length - 1; i >= 0; i--) {
      if (String(list[i]?.url || '').includes(urlPart)) {
        return list[i];
      }
    }
    return null;
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

  async _sendPendingConfirmData(sessionRef, pendingConfirmData = {}, options = {}) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    const referenceConsumerMessageId = Number(
      pendingConfirmData?.referenceConsumerMessageId
      || pendingConfirmData?.refConsumerMessageId
      || 0
    );
    const type = Number(pendingConfirmData?.type || 2) || 2;
    const needChangeTrusteeship = options.needChangeTrusteeship === true;
    if (!uid || !referenceConsumerMessageId) return null;
    return this._post('/refraction/robot/mall/trusteeshipState/sendPendingConfirmDataNew', {
      uid,
      type,
      referenceConsumerMessageId,
      needChangeTrusteeship,
    }, {
      'content-type': 'application/json;charset=UTF-8',
    });
  }

  async _refreshManualSendAntiContent() {
    const rawBody = this._getLatestRawRequestBody('/xg/pfb/a2');
    if (!rawBody) return null;
    const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    return this._requestRaw('POST', 'https://xg.pinduoduo.com/xg/pfb/a2', body, {
      'content-type': 'application/json',
      Referer: `${PDD_BASE}/`,
    });
  }

  async _prepareManualSendContext(sessionRef) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const sessionId = String(sessionMeta?.sessionId || '');
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    this._log('[API] 发送前准备人工发送上下文', { sessionId, uid });

    let trusteeshipPayload = null;
    try {
      trusteeshipPayload = await this._queryTrusteeshipState(sessionMeta);
    } catch (error) {
      this._log('[API] queryTrusteeshipState 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    const initialTrusteeshipInfo = trusteeshipPayload?.result || null;
    const latestTrusteeshipInfo = this._getLatestTrusteeshipStateInfo(sessionMeta);
    const pendingConfirmData = initialTrusteeshipInfo?.pendingConfirmData
      || latestTrusteeshipInfo?.pendingConfirmData
      || null;
    const canRestoreTrusteeship = initialTrusteeshipInfo?.trusteeshipMode === 2
      && initialTrusteeshipInfo?.canActiveManually === true;
    let pendingConfirmExecuted = false;
    if (pendingConfirmData?.referenceConsumerMessageId && (pendingConfirmData?.hasOnlySend || canRestoreTrusteeship)) {
      try {
        await this._sendPendingConfirmData(sessionMeta, pendingConfirmData, {
          needChangeTrusteeship: canRestoreTrusteeship,
        });
        pendingConfirmExecuted = true;
        this._log('[API] sendPendingConfirmDataNew 成功', {
          sessionId,
          uid,
          type: Number(pendingConfirmData?.type || 2) || 2,
          referenceConsumerMessageId: Number(pendingConfirmData?.referenceConsumerMessageId || 0) || 0,
          needChangeTrusteeship: canRestoreTrusteeship,
        });
        await new Promise(resolve => setTimeout(resolve, 350));
        trusteeshipPayload = await this._queryTrusteeshipState(sessionMeta);
      } catch (error) {
        this._log('[API] sendPendingConfirmDataNew 失败', {
          sessionId,
          uid,
          message: error?.message || '未知异常',
        });
      }
    }
    try {
      await this._queryReplyState(sessionMeta);
    } catch (error) {
      this._log('[API] queryReplyState 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    let bizPayload = null;
    try {
      bizPayload = await this._updateChatBizInfo(sessionMeta);
    } catch (error) {
      this._log('[API] updateChatBizInfo 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    try {
      await this._notifyTyping(sessionMeta);
    } catch (error) {
      this._log('[API] conv/typing 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    try {
      await this._refreshManualSendAntiContent();
    } catch (error) {
      this._log('[API] xg/pfb/a2 刷新失败', { sessionId, uid, message: error?.message || '未知异常' });
    }

    const preCheckInfo = bizPayload?.result?.sendMessageCheckData?.preCheckInfo || null;
    const trusteeshipInfo = trusteeshipPayload?.result || null;
    return {
      checked: true,
      trusteeshipInfo: trusteeshipInfo ? this._cloneJson(trusteeshipInfo) : null,
      preCheckInfo: preCheckInfo ? this._cloneJson(preCheckInfo) : null,
      pendingConfirmData: pendingConfirmData ? this._cloneJson(pendingConfirmData) : null,
      pendingConfirmExecuted,
    };
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

  _buildSendMessageTemplate(sessionRef, text, ts, hash) {
    const { sessionMeta, ids } = this._getSessionIdentityCandidates(sessionRef);
    const shop = this._getShopInfo();
    const mallId = this._getMallId();
    const hasSendMessageTemplate = !!this._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const template = this._getLatestMessageTemplate(sessionMeta) || {};
    const buyerInfo = this._getLatestBuyerInfo(sessionMeta);
    const targetUid = String(sessionMeta.userUid || sessionMeta.customerId || sessionMeta.sessionId || '');

    if (!hasSendMessageTemplate) {
      return {
        to: {
          role: 'user',
          uid: targetUid,
        },
        from: {
          role: 'mall_cs',
        },
        ts,
        content: text,
        msg_id: null,
        type: 0,
        is_aut: 0,
        manual_reply: 1,
        status: 'read',
        is_read: 1,
        hash,
      };
    }

    const from = { ...(template.from || {}) };
    const to = { ...(template.to || {}) };

    from.role = from.role || 'mall_cs';
    if (!from.uid && mallId) from.uid = String(mallId);
    if (!from.mall_id && mallId) from.mall_id = String(mallId);
    if (!from.csid && shop?.name) from.csid = shop.name;
    to.role = to.role || 'user';
    to.uid = targetUid;

    const message = {
      ...template,
      to,
      from,
      ts: String(ts),
      content: text,
      msg_id: null,
      type: template.type ?? 0,
      is_aut: 0,
      manual_reply: 1,
      status: template.status || 'read',
      is_read: template.is_read ?? 1,
      hash,
    };

    if (message.version === undefined) message.version = 1;
    if (message.cs_type === undefined) message.cs_type = 2;
    if (!message.mall_context) message.mall_context = { client_type: 2 };
    if (!message.mallName && shop?.name) message.mallName = shop.name;
    if (!message.pre_msg_id && template.msg_id) message.pre_msg_id = template.msg_id;
    if (!message.user_info && buyerInfo) message.user_info = buyerInfo;

    return message;
  }

  _buildSendImageTemplate(sessionRef, imageUrl, ts, hash, imageMeta = {}) {
    const message = this._buildSendMessageTemplate(sessionRef, imageUrl, ts, hash);
    message.ts = ts;
    message.content = imageUrl;
    message.type = 1;
    delete message.msg_type;
    delete message.message_type;
    delete message.content_type;
    const width = Number(imageMeta?.width || 0) || 0;
    const height = Number(imageMeta?.height || 0) || 0;
    const imageSize = Number(imageMeta?.imageSize || 0) || 0;
    if (width || height || imageSize) {
      message.size = {
        ...(message.size || {}),
        ...(height ? { height } : {}),
        ...(width ? { width } : {}),
        ...(imageSize ? { image_size: imageSize } : {}),
      };
    }
    if (imageMeta?.thumbData) {
      message.info = {
        ...(message.info || {}),
        thumb_data: imageMeta.thumbData,
      };
    }
    return message;
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

  async _getCookieString() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  async _listCookieNames() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.map(item => item.name).sort();
  }

  async _getCookieMap() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.reduce((acc, item) => {
      acc[item.name] = item.value;
      return acc;
    }, {});
  }

  _getMainCookieWhitelist() {
    return [
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
  }

  _serializeCookieMap(cookieMap = {}, cookieNames = []) {
    return cookieNames
      .filter(name => name && cookieMap[name] !== undefined && cookieMap[name] !== null && cookieMap[name] !== '')
      .map(name => `${name}=${cookieMap[name]}`)
      .join('; ');
  }

  _buildMainCookieString(cookieMap = {}) {
    return this._serializeCookieMap(cookieMap, this._getMainCookieWhitelist());
  }

  async _getMainCookieContextSummary() {
    const cookieMap = await this._getCookieMap();
    const cookieNames = Object.keys(cookieMap).sort();
    const mainCookieString = this._buildMainCookieString(cookieMap);
    const hasRequiredMainCookies = !!(cookieMap.PASS_ID && cookieMap._nano_fp && cookieMap.rckk);
    return {
      hasPassId: !!cookieMap.PASS_ID,
      hasNanoFp: !!cookieMap._nano_fp,
      hasRckk: !!cookieMap.rckk,
      hasVerifyAuthToken: !!cookieMap['msfe-pc-cookie-captcha-token'],
      hasRequiredMainCookies,
      usesWhitelistCookieString: !!(mainCookieString && hasRequiredMainCookies),
      cookieNameCount: cookieNames.length,
      cookieNames,
    };
  }

  async _buildHeaders(extraHeaders = {}) {
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

  async _prepareRequestHeaders(extraHeaders = {}, options = {}) {
    let mainCookieContext = await this._getMainCookieContextSummary();
    const shop = this._getShopInfo();
    const shouldEnsureMainCookieContext = shop?.loginMethod === 'token'
      && options.ensureMainCookieContext !== false
      && (!mainCookieContext.hasPassId || !mainCookieContext.hasNanoFp || !mainCookieContext.hasRckk);
    if (shouldEnsureMainCookieContext) {
      await this._maybeRefreshMainCookieContext('missing-main-cookie-context', {
        summary: mainCookieContext,
      });
      mainCookieContext = await this._getMainCookieContextSummary();
    }
    if (!mainCookieContext.hasRequiredMainCookies) {
      const error = new Error('主站 Cookie 未完整建立');
      error.mainCookieContext = mainCookieContext;
      throw error;
    }
    const headers = await this._buildHeaders(extraHeaders);
    return { headers, mainCookieContext };
  }

  async _maybeRefreshMainCookieContext(reason = 'manual', payload = {}) {
    if (typeof this._refreshMainCookieContext !== 'function') return null;
    const shop = this._getShopInfo();
    if (shop?.loginMethod !== 'token') return null;
    this._log('[API] 刷新主 Cookie 上下文', {
      reason,
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
    return this._refreshMainCookieContext({
      shopId: this.shopId,
      reason,
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
  }

  _shouldRetryWithMainCookieContextRefresh(error, options = {}) {
    if (options.mainCookieContextRetried) return false;
    if (options.disableMainCookieContextRetry === true) return false;
    if (typeof this._refreshMainCookieContext !== 'function') return false;
    const shop = this._getShopInfo();
    if (shop?.loginMethod !== 'token') return false;
    if (error?.authExpired) return true;
    const statusCode = Number(error?.statusCode || 0);
    const errorCode = Number(error?.errorCode || 0);
    return [401, 403, 419].includes(statusCode) || this._isAuthError(errorCode);
  }

  _guessMimeType(filePath = '') {
    const ext = String(path.extname(filePath || '')).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.m4v') return 'video/x-m4v';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.avi') return 'video/x-msvideo';
    if (ext === '.mkv') return 'video/x-matroska';
    return 'application/octet-stream';
  }

  _toImageDataUrl(fileBuffer, mimeType = 'application/octet-stream') {
    return `data:${mimeType};base64,${Buffer.from(fileBuffer || []).toString('base64')}`;
  }

  async _buildImageMessageMeta(filePath, uploadResult = {}) {
    if (!filePath) {
      return {
        width: Number(uploadResult?.width || 0) || 0,
        height: Number(uploadResult?.height || 0) || 0,
        imageSize: Number(uploadResult?.imageSize || 0) || 0,
        thumbData: '',
      };
    }
    const fileBuffer = await fs.readFile(filePath);
    const mimeType = this._guessMimeType(filePath);
    return {
      width: Number(uploadResult?.width || 0) || 0,
      height: Number(uploadResult?.height || 0) || 0,
      imageSize: Math.max(1, Math.round(fileBuffer.length / 1024)),
      thumbData: this._toImageDataUrl(fileBuffer, mimeType),
    };
  }

  async _getPreUploadTicket() {
    const requestBody = {
      chat_type_id: 1,
      file_usage: 1,
    };
    let payload;
    if (typeof this._requestInPddPage === 'function') {
      payload = await this._requestInPddPage({
        method: 'POST',
        url: '/plateau/file/pre_upload',
        source: 'chat-file:pre-upload',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
        },
        body: JSON.stringify(requestBody),
      });
    } else {
      payload = await this._post('/plateau/file/pre_upload', requestBody);
    }
    const result = payload?.result || payload?.data || payload || {};
    return {
      uploadSignature: result.upload_signature || result.uploadSign || result.signature || '',
      uploadUrl: result.upload_url || result.uploadUrl || 'https://file.pinduoduo.com/v2/store_image',
      uploadHost: result.upload_host || result.uploadHost || '',
      uploadBucketTag: result.upload_bucket_tag || result.uploadBucketTag || '',
    };
  }

  async _uploadImageViaPreUpload(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    const ticket = await this._getPreUploadTicket();
    const requestBody = {
      image: this._toImageDataUrl(fileBuffer, this._guessMimeType(filePath)),
    };
    if (ticket.uploadSignature) {
      requestBody.upload_sign = ticket.uploadSignature;
      requestBody.upload_signature = ticket.uploadSignature;
    }
    const payload = typeof this._requestInPddPage === 'function'
      ? await this._requestInPddPage({
          method: 'POST',
          url: ticket.uploadUrl,
          source: 'chat-file:upload',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        })
      : await this._requestRaw('POST', ticket.uploadUrl, JSON.stringify(requestBody), {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          Referer: `${PDD_BASE}/`,
          Origin: PDD_BASE,
        });
    if (!payload?.url) {
      throw new Error(payload?.error_msg || payload?.message || '图片上传失败');
    }
    payload.uploadBaseUrl = ticket.uploadUrl;
    payload.imageSize = Math.max(1, Math.round(fileBuffer.length / 1024));
    return payload;
  }

  _isCrossOriginUrl(urlPath = '') {
    try {
      const target = new URL(urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`);
      const origin = new URL(PDD_BASE);
      return target.origin !== origin.origin;
    } catch {
      return false;
    }
  }

  _createStepError(step, message, extra = {}) {
    const error = new Error(message);
    error.step = step;
    Object.assign(error, extra);
    return error;
  }

  _normalizeBusinessError(payload) {
    const candidates = this._collectBusinessPayloadCandidates(payload);
    for (const item of candidates) {
      const error = this._extractBusinessError(item);
      if (error) return error;
    }
    return null;
  }

  _collectBusinessPayloadCandidates(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const queue = [payload];
    const visited = new Set();
    const result = [];
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      result.push(current);
      ['result', 'data', 'response'].forEach(key => {
        if (current[key] && typeof current[key] === 'object') {
          queue.push(current[key]);
        }
      });
    }
    return result;
  }

  _extractBusinessError(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const message = payload.error_msg || payload.errorMsg || payload.message || payload.msg || '';
    const successCodes = new Set([0, 200, 1000000]);
    if (payload.success === false || payload.ok === false) {
      return {
        code: payload.error_code || payload.code || payload.err_no || payload.errno || '',
        message: message || 'API 请求失败',
      };
    }
    const explicitCode = payload.error_code ?? payload.err_no ?? payload.errno ?? payload.biz_code;
    if (
      explicitCode !== undefined
      && explicitCode !== null
      && explicitCode !== ''
      && !successCodes.has(Number(explicitCode))
    ) {
      return {
        code: explicitCode,
        message: message || 'API 请求失败',
      };
    }
    const genericCode = payload.code;
    if (
      genericCode !== undefined
      && genericCode !== null
      && genericCode !== ''
      && Number.isFinite(Number(genericCode))
      && !successCodes.has(Number(genericCode))
      && message
    ) {
      return {
        code: genericCode,
        message,
      };
    }
    return null;
  }

  _normalizeComparableMessageText(text) {
    return messageParsers.normalizeComparableMessageText(text);
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

  async _confirmSentTextMessage(sessionRef, text, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || 8));
    const delayMs = Math.max(0, Number(options.delayMs || 700));
    const pageSize = Math.max(20, Number(options.pageSize || 50));
    const expectedText = this._normalizeComparableMessageText(text);
    const sentAtMs = Number(options.sentAtMs || Date.now());
    for (let index = 0; index < attempts; index++) {
      const messages = await this.getSessionMessages(sessionRef, 1, pageSize);
      const matched = messages.find(message => {
        const actor = this._getMessageActor(message?.raw || message);
        if (actor === 'buyer') return false;
        const messageText = this._normalizeComparableMessageText(message.content);
        if (!messageText || messageText !== expectedText) return false;
        const timestampMs = this._normalizeTimestampMs(message.timestamp);
        return !timestampMs || (timestampMs >= sentAtMs - 15000 && timestampMs <= Date.now() + 60000);
      });
      if (matched) {
        return {
          confirmed: true,
          messageId: String(matched.messageId || ''),
          timestamp: matched.timestamp || 0,
        };
      }
      if (index < attempts - 1) {
        await this._sleep(delayMs);
      }
    }
    return { confirmed: false };
  }

  async _confirmPendingConfirmMessage(sessionRef, pendingConfirmData = {}, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || 6));
    const delayMs = Math.max(0, Number(options.delayMs || 650));
    const pageSize = Math.max(20, Number(options.pageSize || 20));
    const sentAtMs = Number(options.sentAtMs || Date.now());
    const expectedText = this._normalizeComparableMessageText(pendingConfirmData?.showText || '');
    const expectedConsumerMessageId = Number(
      pendingConfirmData?.referenceConsumerMessageId
      || pendingConfirmData?.refConsumerMessageId
      || 0
    );
    for (let index = 0; index < attempts; index++) {
      const messages = await this.getSessionMessages(sessionRef, 1, pageSize);
      const matched = messages.find(message => {
        const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
        const timestampMs = this._normalizeTimestampMs(message.timestamp);
        if (timestampMs && (timestampMs < sentAtMs - 15000 || timestampMs > Date.now() + 60000)) {
          return false;
        }
        const templateName = String(raw?.template_name || raw?.templateName || '').trim();
        const showAuto = raw?.show_auto === true || raw?.showAuto === true;
        const consumerMessageId = Number(
          raw?.biz_context?.consumer_msg_id
          || raw?.bizContext?.consumer_msg_id
          || raw?.bizContext?.consumerMsgId
          || raw?.push_biz_context?.consumer_msg_id
          || raw?.pushBizContext?.consumer_msg_id
          || 0
        );
        if (expectedConsumerMessageId > 0 && consumerMessageId === expectedConsumerMessageId) {
          return true;
        }
        if (templateName !== 'mall_robot_text_msg' && !showAuto) return false;
        const messageText = this._normalizeComparableMessageText(message.content);
        if (expectedText && messageText && messageText === expectedText) return true;
        return !!timestampMs && timestampMs >= sentAtMs - 15000;
      });
      if (matched) {
        return {
          confirmed: true,
          messageId: String(matched.messageId || ''),
          timestamp: matched.timestamp || 0,
          content: String(matched.content || pendingConfirmData?.showText || '').trim(),
        };
      }
      if (index < attempts - 1) {
        await this._sleep(delayMs);
      }
    }
    return { confirmed: false };
  }

  async _confirmRefundApplyConversationMessage(sessionRef, options = {}) {
    return this._refundOrdersModule.confirmRefundApplyConversationMessage(sessionRef, options);
  }

  _isAuthError(code) {
    return [40001, 43001, 43002].includes(Number(code));
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

  _markAuthExpired(error, payload = {}) {
    error.authExpired = true;
    error.authState = payload.authState || 'expired';
    this._emitAuthExpired(payload);
    return error;
  }

  _isLoginPageResponse(response, text) {
    const finalUrl = String(response?.url || '');
    if (finalUrl.includes('/login')) return true;
    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return false;
    const snippet = typeof text === 'string' ? text.slice(0, 800).toLowerCase() : '';
    return snippet.includes('登录') || snippet.includes('login') || snippet.includes('passport') || snippet.includes('扫码');
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

  async _request(method, urlPath, body, extraHeaders = {}, options = {}) {
    const attempt = async (attemptOptions = {}) => {
      const suppressAuthExpired = attemptOptions.suppressAuthExpired === undefined
        ? !!options.suppressAuthExpired
        : !!attemptOptions.suppressAuthExpired;
      const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
      const { headers } = await this._prepareRequestHeaders(extraHeaders, attemptOptions);
      const shop = this._getShopInfo();
      if (shop?.loginMethod === 'token' && !headers['X-PDD-Token']) {
        const error = new Error('当前店铺未恢复 Token，请重新导入 Token');
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'token_missing';
          throw error;
        }
        throw this._markAuthExpired(error, {
          errorMsg: error.message,
          authState: 'token_missing',
          source: 'missing-token',
        });
      }
      const requestOptions = { method, headers };

      if (body !== undefined && body !== null) {
        requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const response = await this._getSession().fetch(url, requestOptions);
      const text = await response.text();
      this._log(`[API] ${method} ${url} -> ${response.status}`);

      let payload = text;
      try {
        payload = JSON.parse(text);
      } catch {}

      if (this._isLoginPageResponse(response, text)) {
        const error = new Error('网页登录已失效，请重新登录或重新导入 Token');
        error.statusCode = response.status;
        error.payload = payload;
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'expired';
          throw error;
        }
        throw this._markAuthExpired(error, {
          statusCode: response.status,
          errorMsg: error.message,
          authState: 'expired',
          source: 'login-page',
        });
      }

      if (!response.ok) {
        const message = typeof payload === 'object'
          ? payload?.error_msg || payload?.message || `HTTP ${response.status}`
          : `HTTP ${response.status}: ${String(text).slice(0, 200)}`;
        const error = new Error(message);
        error.statusCode = response.status;
        error.payload = payload;
        if ([401, 403, 419].includes(Number(response.status))) {
          if (suppressAuthExpired) {
            error.authExpired = true;
            error.authState = 'expired';
            throw error;
          }
          throw this._markAuthExpired(error, {
            statusCode: response.status,
            errorMsg: message,
            authState: 'expired',
            source: 'http-status',
          });
        }
        throw error;
      }

      const businessError = this._normalizeBusinessError(payload);
      if (businessError) {
        const error = new Error(businessError.message);
        error.errorCode = businessError.code;
        error.payload = payload;
        if (this._isAuthError(businessError.code)) {
          if (suppressAuthExpired) {
            error.authExpired = true;
            error.authState = 'expired';
            throw error;
          }
          throw this._markAuthExpired(error, {
            errorCode: businessError.code,
            errorMsg: businessError.message,
            authState: 'expired',
            source: 'business-code',
          });
        }
        throw error;
      }

      this._authExpired = false;
      return payload;
    };

    try {
      const shop = this._getShopInfo();
      const deferAuthExpired = typeof this._refreshMainCookieContext === 'function' && shop?.loginMethod === 'token';
      return await attempt({
        ensureMainCookieContext: options.ensureMainCookieContext !== false,
        mainCookieContextRetried: false,
        suppressAuthExpired: deferAuthExpired ? true : options.suppressAuthExpired,
      });
    } catch (error) {
      if (!this._shouldRetryWithMainCookieContextRefresh(error, options)) {
        throw error;
      }
      await this._maybeRefreshMainCookieContext('request-auth-retry', {
        urlPath,
        method,
        statusCode: Number(error?.statusCode || 0),
        errorCode: Number(error?.errorCode || 0),
      });
      return attempt({
        ensureMainCookieContext: options.ensureMainCookieContext !== false,
        mainCookieContextRetried: true,
        suppressAuthExpired: options.suppressAuthExpired,
      });
    }
  }

  async _requestRaw(method, urlPath, body, extraHeaders = {}, options = {}) {
    const attempt = async (attemptOptions = {}) => {
      const suppressAuthExpired = attemptOptions.suppressAuthExpired === undefined
        ? !!options.suppressAuthExpired
        : !!attemptOptions.suppressAuthExpired;
      const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
      const { headers } = await this._prepareRequestHeaders(extraHeaders, attemptOptions);
      const isCrossOrigin = this._isCrossOriginUrl(url);
      if (isCrossOrigin) {
        delete headers.cookie;
        delete headers.pddid;
        delete headers.etag;
        delete headers['sec-fetch-site'];
        headers['sec-fetch-site'] = 'cross-site';
      }
      const shop = this._getShopInfo();
      if (shop?.loginMethod === 'token' && !headers['X-PDD-Token']) {
        const error = new Error('当前店铺未恢复 Token，请重新导入 Token');
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'token_missing';
          throw error;
        }
        throw this._markAuthExpired(error, {
          errorMsg: error.message,
          authState: 'token_missing',
          source: 'missing-token',
        });
      }
      const requestOptions = { method, headers };
      if (body instanceof FormData) {
        delete requestOptions.headers['content-type'];
        delete requestOptions.headers['Content-Type'];
      }
      if (body !== undefined && body !== null) {
        requestOptions.body = body;
      }
      const response = await this._getSession().fetch(url, requestOptions);
      const text = await response.text();
      this._log(`[API] ${method} ${url} -> ${response.status}`);

      let payload = text;
      try {
        payload = JSON.parse(text);
      } catch {}

      if (this._isLoginPageResponse(response, text)) {
        const error = new Error('网页登录已失效，请重新登录或重新导入 Token');
        error.statusCode = response.status;
        error.payload = payload;
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'expired';
          throw error;
        }
        throw this._markAuthExpired(error, {
          statusCode: response.status,
          errorMsg: error.message,
          authState: 'expired',
          source: 'login-page',
        });
      }

      if (!response.ok) {
        const message = typeof payload === 'object'
          ? payload?.error_msg || payload?.message || `HTTP ${response.status}`
          : `HTTP ${response.status}: ${String(text).slice(0, 200)}`;
        const error = new Error(message);
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }

      const businessError = this._normalizeBusinessError(payload);
      if (businessError) {
        const error = new Error(businessError.message);
        error.errorCode = businessError.code;
        error.payload = payload;
        throw error;
      }

      return payload;
    };

    try {
      const shop = this._getShopInfo();
      const deferAuthExpired = typeof this._refreshMainCookieContext === 'function' && shop?.loginMethod === 'token';
      return await attempt({
        ensureMainCookieContext: true,
        mainCookieContextRetried: false,
        suppressAuthExpired: deferAuthExpired ? true : options.suppressAuthExpired,
      });
    } catch (error) {
      if (!this._shouldRetryWithMainCookieContextRefresh(error, options)) {
        throw error;
      }
      await this._maybeRefreshMainCookieContext('request-raw-auth-retry', {
        urlPath,
        method,
        statusCode: Number(error?.statusCode || 0),
        errorCode: Number(error?.errorCode || 0),
      });
      return attempt({
        ensureMainCookieContext: true,
        mainCookieContextRetried: true,
        suppressAuthExpired: options.suppressAuthExpired,
      });
    }
  }

  async _post(urlPath, body, extraHeaders, options) {
    return this._request('POST', urlPath, body, extraHeaders, options);
  }

  async _requestOrderRemarkApi(urlPath, body = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
    };
    let payload = null;
    const via = typeof this._requestInPddPage === 'function' ? 'page' : 'direct';
    this._log('[API] 订单备注请求开始', this._summarizeOrderRemarkRequest(urlPath, body, via));
    if (typeof this._requestInPddPage === 'function') {
      payload = await this._requestInPddPage({
        method: 'POST',
        url: urlPath,
        source: 'order-remark:page-request',
        headers,
        body: JSON.stringify(body || {}),
      });
    } else {
      payload = await this._post(urlPath, body || {}, headers);
    }
    this._log('[API] 订单备注请求返回', {
      ...this._summarizeOrderRemarkRequest(urlPath, body, via),
      response: this._summarizeOrderRemarkResponse(payload),
    });
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      const error = new Error(businessError.message);
      error.errorCode = businessError.code;
      error.payload = payload;
      throw error;
    }
    return payload;
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

  async _requestVideoMaterialApi(urlPath, body = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      Referer: `${PDD_BASE}/material/service`,
      Origin: PDD_BASE,
    };
    if (typeof this._requestInPddPage === 'function') {
      return this._requestInPddPage({
        method: 'POST',
        url: urlPath,
        source: 'video-material:page-request',
        headers,
        body: JSON.stringify(body || {}),
      });
    }
    return this._post(urlPath, body || {}, headers);
  }

  _normalizeVideoFile(item = {}) {
    const extra = item?.extra_info && typeof item.extra_info === 'object' ? item.extra_info : {};
    return {
      id: Number(item.id || item.file_id || 0) || 0,
      name: String(item.name || item.file_name || '').trim(),
      extension: String(item.extension || '').trim(),
      url: String(item.url || '').trim(),
      fileType: String(item.file_type || item.fileType || '').trim(),
      size: Number(item.size || extra.size || 0) || 0,
      checkStatus: Number(item.check_status || item.checkStatus || 0) || 0,
      checkComment: String(item.check_comment || item.checkComment || '').trim(),
      createTime: Number(item.create_time || item.createTime || 0) || 0,
      updateTime: Number(item.update_time || item.updateTime || 0) || 0,
      coverUrl: String(extra.video_cover_url || extra.cover_url || extra.coverUrl || '').trim(),
      duration: Number(extra.duration || 0) || 0,
      width: Number(extra.width || 0) || 0,
      height: Number(extra.height || 0) || 0,
      f20Url: String(extra.f20_url || extra.f20Url || '').trim(),
      f30Url: String(extra.f30_url || extra.f30Url || extra.transcode_f30_url || '').trim(),
      raw: this._cloneJson(item),
    };
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
    if (!payload || typeof payload !== 'object') {
      return {
        type: typeof payload,
      };
    }
    const candidates = this._collectBusinessPayloadCandidates(payload);
    const first = candidates[0] || payload;
    return {
      success: first?.success,
      ok: first?.ok,
      errorCode: first?.error_code ?? first?.code ?? first?.err_no ?? first?.errno ?? null,
      message: first?.error_msg || first?.message || first?.msg || '',
      resultKeys: first?.result && typeof first.result === 'object' ? Object.keys(first.result).slice(0, 10) : [],
    };
  }

  _getOrderRemarkTagName(tag) {
    return orderRemarkParsers.getOrderRemarkTagName(tag, this._orderRemarkTagOptionsCache);
  }

  _formatOrderRemarkMeta(value = Date.now()) {
    return orderRemarkParsers.formatOrderRemarkMeta(value);
  }

  async _getOrderRemarkOperatorName() {
    try {
      const userInfo = await this.getUserInfo();
      const username = String(userInfo?.username || '').trim();
      if (username) return username;
    } catch {}
    try {
      const profile = await this.getServiceProfile();
      const username = String(profile?.username || '').trim();
      if (username) return username;
      const serviceName = String(profile?.serviceName || '').trim();
      if (serviceName) return serviceName;
    } catch {}
    return String(this._getShopInfo()?.name || '').trim() || '主账号';
  }

  _getOrderRemarkCache(orderSn) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) return null;
    const cached = this._orderRemarkCache.get(normalizedOrderSn);
    if (!cached || typeof cached !== 'object') return null;
    return this._cloneJson(cached);
  }

  _setOrderRemarkCache(orderSn, remark = {}) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) return null;
    const nextRemark = {
      orderSn: normalizedOrderSn,
      note: this._extractOrderRemarkText(remark?.note),
      tag: this._normalizeOrderRemarkTag(remark?.tag),
      tagName: String(remark?.tagName || '').trim(),
      source: Number(remark?.source) > 0 ? Number(remark.source) : 1,
    };
    this._orderRemarkCache.set(normalizedOrderSn, nextRemark);
    return this._cloneJson(nextRemark);
  }

  _normalizeOrderRemarkTagOptions(payload = {}) {
    return orderRemarkParsers.normalizeOrderRemarkTagOptions(payload);
  }

  async getOrderRemarkTagOptions(force = false) {
    if (this._orderRemarkTagOptionsCache && !force) {
      return this._cloneJson(this._orderRemarkTagOptionsCache);
    }
    let payload;
    try {
      payload = await this._requestOrderRemarkApi('/pizza/order/remarkTag/query', {});
    } catch (error) {
      if (this._orderRemarkTagOptionsCache) {
        return this._cloneJson(this._orderRemarkTagOptionsCache);
      }
      throw error;
    }
    const result = this._normalizeOrderRemarkTagOptions(payload);
    this._orderRemarkTagOptionsCache = result;
    return this._cloneJson(result);
  }

  async getOrderRemark(orderSn, source = 1) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const requestBody = {
      orderSn: normalizedOrderSn,
      source: Number(source) > 0 ? Number(source) : 1,
    };
    const [noteResult, noteTagResult] = await Promise.allSettled([
      this._requestOrderRemarkApi('/pizza/order/note/query', requestBody),
      this._requestOrderRemarkApi('/pizza/order/noteTag/query', requestBody),
    ]);
    if (noteResult.status === 'rejected' && noteTagResult.status === 'rejected') {
      throw noteTagResult.reason || noteResult.reason || new Error('读取订单备注失败');
    }
    const notePayload = noteResult.status === 'fulfilled' ? noteResult.value : null;
    const noteTagPayload = noteTagResult.status === 'fulfilled' ? noteTagResult.value : null;
    const noteTagData = noteTagPayload?.result && typeof noteTagPayload.result === 'object'
      ? noteTagPayload.result
      : {};
    const noteData = notePayload?.result;
    const note = this._extractOrderRemarkText(noteTagData?.note) || this._extractOrderRemarkText(noteData);
    const tag = this._normalizeOrderRemarkTag(this._pickRefundText([noteTagData], ['tag', 'tagCode', 'color', 'colorCode']));
    const tagName = this._pickRefundText([noteTagData], ['tagName', 'tag_name', 'colorName', 'color_name']);
    return this._setOrderRemarkCache(normalizedOrderSn, {
      orderSn: normalizedOrderSn,
      note,
      tag,
      tagName,
      source: requestBody.source,
    });
  }

  async saveOrderRemark(params = {}) {
    const normalizedOrderSn = String(params?.orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const source = Number(params?.source) > 0 ? Number(params.source) : 1;
    const baseNote = String(params?.note || '').trim().slice(0, 300);
    const tag = this._normalizeOrderRemarkTag(params?.tag);
    const baseTagName = String(params?.tagName || '').trim();
    const tagName = baseTagName || this._getOrderRemarkTagName(tag);
    let finalNote = baseNote;
    if (params?.autoAppendMeta) {
      const operatorName = await this._getOrderRemarkOperatorName();
      const metaText = this._formatOrderRemarkMeta();
      const suffix = [operatorName, metaText].filter(Boolean).join(' ').trim();
      finalNote = suffix
        ? `${baseNote || ''} [${suffix}]`.trim()
        : baseNote;
    }
    const candidates = tag
      ? [
        {
          url: '/pizza/order/noteTag/update',
          body: {
            orderSn: normalizedOrderSn,
            source,
            remark: finalNote,
            remarkTag: tag,
            remarkTagName: tagName || '',
          },
        },
        {
          url: '/pizza/order/note/update',
          body: {
            orderSn: normalizedOrderSn,
            source,
            remark: finalNote,
          },
        },
      ]
      : [
        {
          url: '/pizza/order/noteTag/update',
          body: {
            orderSn: normalizedOrderSn,
            source,
            remark: finalNote,
            remarkTag: '',
            remarkTagName: '',
          },
        },
        {
          url: '/pizza/order/note/update',
          body: {
            orderSn: normalizedOrderSn,
            source,
            remark: finalNote,
          },
        },
      ];
    let lastError = null;
    let responsePayload = null;
    let latestRemark = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      let canRetryAfterIntervalError = true;
      while (true) {
        try {
          responsePayload = await this._requestOrderRemarkApi(candidate.url, candidate.body);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (canRetryAfterIntervalError && this._isOrderRemarkSaveIntervalError(error)) {
            canRetryAfterIntervalError = false;
            await this._sleep(1100);
            continue;
          }
          break;
        }
      }
      if (lastError) {
        continue;
      }
      latestRemark = null;
      try {
        latestRemark = await this.getOrderRemark(normalizedOrderSn, source);
      } catch (error) {
        lastError = error;
      }
      if (!lastError && this._isOrderRemarkSaveMatched(latestRemark, finalNote, tag)) {
        break;
      }
      if (!lastError) {
        this._log('[API] 订单备注写入后回读未生效', {
          candidateUrl: candidate.url,
          orderSn: this._maskOrderRemarkOrderSn(normalizedOrderSn),
          expected: {
            noteLength: this._extractOrderRemarkText(finalNote).length,
            tag,
          },
          actual: {
            noteLength: this._extractOrderRemarkText(latestRemark?.note).length,
            tag: this._normalizeOrderRemarkTag(latestRemark?.tag),
          },
        });
        lastError = new Error('备注保存未生效，请重试');
      }
      if (index < candidates.length - 1) {
        await this._sleep(1100);
      }
    }
    if (lastError && this._isOrderRemarkSaveIntervalError(lastError)) {
      try {
        latestRemark = await this.getOrderRemark(normalizedOrderSn, source);
        if (this._isOrderRemarkSaveMatched(latestRemark, finalNote, tag)) {
          lastError = null;
        }
      } catch {}
    }
    if (lastError) {
      throw lastError;
    }
    if (!latestRemark) {
      try {
        latestRemark = await this.getOrderRemark(normalizedOrderSn, source);
      } catch {}
    }
    const cachedRemark = this._setOrderRemarkCache(normalizedOrderSn, {
      orderSn: normalizedOrderSn,
      note: latestRemark?.note || finalNote,
      tag: latestRemark?.tag || tag,
      tagName: latestRemark?.tagName || '',
      source,
    });
    return {
      success: true,
      ...cachedRemark,
      response: responsePayload,
    };
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

  _buildSendMessageBody(sessionRef, text) {
    const { sessionMeta, ids } = this._getSessionIdentityCandidates(sessionRef);
    const latestTraffic = this._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const latestListTraffic = this._getLatestSessionTraffic('/plateau/chat/list', ids);
    const latestListBody = this._safeParseJson(latestListTraffic?.requestBody) || this._getLatestRequestBody('/plateau/chat/list');
    const latestConversationsBody = this._getLatestRequestBody('/plateau/chat/latest_conversations');
    const bodyAntiContent = templateBody?.data?.anti_content
      || latestListBody?.data?.anti_content
      || latestConversationsBody?.data?.anti_content
      || this._getLatestAntiContent();
    const topAntiContent = templateBody?.anti_content
      || latestListBody?.anti_content
      || latestConversationsBody?.anti_content
      || bodyAntiContent;
    const requestId = this._nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const random = this._randomHex(32);
    const hash = this._buildMessageHash(sessionMeta.sessionId || sessionMeta.userUid || sessionMeta.customerId || '', text, ts, random);
    const message = this._buildSendMessageTemplate(sessionMeta, text, ts, hash);

    if (templateBody) {
      const body = this._cloneJson(templateBody);
      body.data = body.data || {};
      body.data.request_id = requestId;
      body.data.cmd = body.data.cmd || 'send_message';
      body.data.random = random;
      body.data.anti_content = bodyAntiContent || body.data.anti_content || '';
      body.data.message = {
        ...(body.data.message || {}),
        ...message,
        to: {
          ...((body.data.message && body.data.message.to) || {}),
          ...(message.to || {}),
        },
        from: {
          ...((body.data.message && body.data.message.from) || {}),
          ...(message.from || {}),
        },
      };
      body.client = body.client || this._getLatestClientValue();
      body.anti_content = topAntiContent || body.anti_content || '';
      return body;
    }

    return {
      data: {
        cmd: 'send_message',
        anti_content: bodyAntiContent,
        request_id: requestId,
        message,
        random,
      },
      client: this._getLatestClientValue(),
      anti_content: topAntiContent,
    };
  }

  _getUploadBases() {
    return PDD_UPLOAD_BASES;
  }

  async _getUploadSignature(baseUrl, bucketTag = 'chat-merchant') {
    const payload = await this._requestRaw('POST', `${baseUrl}/get_signature`, JSON.stringify({
      bucket_tag: bucketTag,
    }), {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
    });
    const signature = payload?.signature || payload?.result?.signature || '';
    if (!signature) {
      throw new Error('获取图片上传签名失败');
    }
    return signature;
  }

  async uploadImage(filePath, options = {}) {
    if (!filePath) {
      throw new Error('缺少图片路径');
    }
    const attempts = [];
    try {
      return await this._uploadImageViaPreUpload(filePath);
    } catch (error) {
      attempts.push({ baseUrl: '/plateau/file/pre_upload', error: error.message });
    }
    const fileBuffer = await fs.readFile(filePath);
    for (const baseUrl of this._getUploadBases()) {
      try {
        const signature = await this._getUploadSignature(baseUrl, options.bucketTag || 'chat-merchant');
        const form = new FormData();
        form.append('upload_sign', signature);
        form.append('image', new Blob([fileBuffer], { type: this._guessMimeType(filePath) }), path.basename(filePath).toLowerCase());
        form.append('forbid_override', 'false');
        const payload = await this._requestRaw('POST', `${baseUrl}/v3/store_image`, form, {
          accept: '*/*',
        });
        if (!payload?.url) {
          throw new Error(payload?.error_msg || payload?.message || '图片上传失败');
        }
        payload.uploadBaseUrl = baseUrl;
        return payload;
      } catch (error) {
        attempts.push({ baseUrl, error: error.message });
      }
    }
    throw this._createStepError('upload', attempts[0]?.error || '图片上传失败', { attempts });
  }

  _buildSendImageBody(sessionRef, imageUrl, imageMeta = {}) {
    const { sessionMeta, ids } = this._getSessionIdentityCandidates(sessionRef);
    const latestTraffic = this._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const latestListTraffic = this._getLatestSessionTraffic('/plateau/chat/list', ids);
    const latestListBody = this._safeParseJson(latestListTraffic?.requestBody) || this._getLatestRequestBody('/plateau/chat/list');
    const latestConversationsBody = this._getLatestRequestBody('/plateau/chat/latest_conversations');
    const bodyAntiContent = templateBody?.data?.anti_content
      || latestListBody?.data?.anti_content
      || latestConversationsBody?.data?.anti_content
      || this._getLatestAntiContent();
    const topAntiContent = templateBody?.anti_content
      || latestListBody?.anti_content
      || latestConversationsBody?.anti_content
      || bodyAntiContent;
    const requestId = this._nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const random = this._randomHex(32);
    const hash = this._buildMessageHash(sessionMeta.sessionId || sessionMeta.userUid || sessionMeta.customerId || '', imageUrl, ts, random);
    const message = this._buildSendImageTemplate(sessionMeta, imageUrl, ts, hash, imageMeta);

    if (templateBody) {
      const body = this._cloneJson(templateBody);
      body.data = body.data || {};
      body.data.request_id = requestId;
      body.data.cmd = body.data.cmd || 'send_message';
      body.data.random = random;
      body.data.anti_content = bodyAntiContent || body.data.anti_content || '';
      body.data.message = {
        ...(body.data.message || {}),
        ...message,
        to: {
          ...((body.data.message && body.data.message.to) || {}),
          ...(message.to || {}),
        },
        from: {
          ...((body.data.message && body.data.message.from) || {}),
          ...(message.from || {}),
        },
      };
      body.client = body.client || this._getLatestClientValue();
      body.anti_content = topAntiContent || body.anti_content || '';
      return body;
    }

    return {
      data: {
        cmd: 'send_message',
        anti_content: bodyAntiContent,
        request_id: requestId,
        message,
        random,
      },
      client: this._getLatestClientValue(),
      anti_content: topAntiContent,
    };
  }

  async _ensureSendMessageContext(sessionRef) {
    const { ids, sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const hasSessionMessageTraffic = !!this._getLatestSessionTraffic('/plateau/chat/list', ids);
    const hasSessionSendTraffic = !!this._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    if (hasSessionMessageTraffic || hasSessionSendTraffic) return;
    this._log('[API] 发送前预热会话上下文', {
      sessionId: String(sessionMeta?.sessionId || ''),
      customerId: String(sessionMeta?.customerId || ''),
      userUid: String(sessionMeta?.userUid || ''),
    });
    try {
      await this.getSessionMessages(sessionMeta, 1, 30);
    } catch (error) {
      this._log('[API] 发送前预热失败', {
        sessionId: String(sessionMeta?.sessionId || ''),
        message: error?.message || '未知异常',
      });
    }
  }

  async sendMessage(sessionRef, text, options = {}) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const manualSource = String(options?.manualSource || 'manual').trim() || 'manual';
    const sendStartedAtMs = Date.now();
    const preparedContext = await this._prepareManualSendContext(sessionMeta);
    const preCheckInfo = preparedContext?.checked
      ? (preparedContext.preCheckInfo || null)
      : this._getLatestSendMessagePreCheck(sessionMeta);
    if (preCheckInfo?.needPreCheck && preCheckInfo?.canFinish === false) {
      const preCheckName = String(preCheckInfo?.name || '').trim();
      const traceId = String(preCheckInfo?.traceId || '').trim();
      const pendingConfirmData = preparedContext?.pendingConfirmData || preparedContext?.trusteeshipInfo?.pendingConfirmData || null;
      if (preCheckName === 'noViciousTalk' && preparedContext?.pendingConfirmExecuted && pendingConfirmData?.referenceConsumerMessageId) {
        const confirmResult = await this._confirmPendingConfirmMessage(sessionMeta, pendingConfirmData, {
          sentAtMs: sendStartedAtMs,
        });
        if (confirmResult.confirmed) {
          const pendingText = String(confirmResult.content || pendingConfirmData?.showText || '').trim();
          const requestedText = String(text || '').trim();
          const pendingResult = {
            success: true,
            confirmed: true,
            sendMode: 'pending-confirm',
            manualSource,
            sessionId: String(sessionMeta.sessionId || ''),
            customerId: String(sessionMeta.customerId || ''),
            userUid: String(sessionMeta.userUid || ''),
            messageId: confirmResult.messageId,
            text: pendingText,
            requestedText,
            response: {
              success: true,
              preCheckInfo: this._cloneJson(preCheckInfo),
            },
            warning: pendingText && pendingText !== String(text || '').trim()
              ? '当前会话存在平台待确认回复，已按平台待确认消息发送'
              : '',
          };
          const shouldRetryRequestedText = requestedText
            && pendingText
            && requestedText !== pendingText
            && options?.skipRetryAfterPendingConfirm !== true;
          if (shouldRetryRequestedText) {
            try {
              const retryResult = await this.sendMessage(sessionMeta, requestedText, {
                ...options,
                skipRetryAfterPendingConfirm: true,
              });
              return {
                ...retryResult,
                preludeSendMode: 'pending-confirm',
                preludeMessageId: pendingResult.messageId,
                preludeText: pendingText,
                warning: [
                  pendingResult.warning,
                  retryResult?.warning || '',
                ].filter(Boolean).join('；'),
              };
            } catch (retryError) {
              const detail = retryError?.message || '未知错误';
              const wrappedError = new Error(`平台待确认消息已发送，但补发输入内容失败: ${detail}`);
              wrappedError.errorCode = retryError?.errorCode || 40013;
              wrappedError.partialResult = pendingResult;
              wrappedError.payload = retryError?.payload;
              throw wrappedError;
            }
          }
          this.emit('messageSent', pendingResult);
          return pendingResult;
        }
      }
      if (preCheckName === 'noViciousTalk') {
        this._log('[API] noViciousTalk 前置校验未放行，继续尝试真实 send_message', {
          sessionId: String(sessionMeta.sessionId || ''),
          uid: String(sessionMeta.userUid || sessionMeta.customerId || ''),
          traceId,
          pendingConfirmExecuted: preparedContext?.pendingConfirmExecuted === true,
          hasPendingConfirmData: !!pendingConfirmData?.referenceConsumerMessageId,
        });
      } else {
      const message = preCheckName === 'noViciousTalk'
        ? '机器人已暂停接待，请人工跟进'
        : '当前会话发送前置校验未通过，请人工跟进';
      const error = new Error(
        [message, traceId ? `traceId=${traceId}` : ''].filter(Boolean).join(' | ')
      );
      error.errorCode = 40013;
      error.payload = { success: true, preCheckInfo: this._cloneJson(preCheckInfo) };
      throw error;
      }
    }
    await this._ensureSendMessageContext(sessionMeta);
    const requestBody = this._buildSendMessageBody(sessionMeta, text);
    this._log('[API] 发送消息', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      textLength: String(text || '').length,
      manualSource,
      client: requestBody?.client,
      hasTopAntiContent: !!requestBody?.anti_content,
      hasBodyAntiContent: !!requestBody?.data?.anti_content,
      hasUserInfo: !!requestBody?.data?.message?.user_info,
      preMsgId: requestBody?.data?.message?.pre_msg_id || '',
    });
    const sentAtMs = Date.now();
    let payload;
    try {
      payload = await this._post('/plateau/chat/send_message', requestBody);
    } catch (error) {
      const payloadSummary = error?.payload && typeof error.payload === 'object'
        ? {
            success: error.payload.success,
            code: error.payload.code,
            error_code: error.payload.error_code,
            error_msg: error.payload.error_msg,
            message: error.payload.message,
          }
        : null;
      const detailParts = [
        error?.message || '消息发送失败',
        error?.statusCode ? `status=${error.statusCode}` : '',
        error?.errorCode ? `code=${error.errorCode}` : '',
        payloadSummary ? `payload=${JSON.stringify(payloadSummary)}` : '',
        requestBody?.data?.message?.to?.uid ? `targetUid=${requestBody.data.message.to.uid}` : '',
        requestBody?.data?.message?.pre_msg_id ? `preMsgId=${requestBody.data.message.pre_msg_id}` : '',
      ].filter(Boolean);
      const wrappedError = new Error(detailParts.join(' | '));
      wrappedError.statusCode = error?.statusCode;
      wrappedError.errorCode = error?.errorCode;
      wrappedError.payload = error?.payload;
      throw wrappedError;
    }
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      const responseSummary = payload && typeof payload === 'object'
        ? {
            success: payload.success,
            code: payload.code,
            error_code: payload.error_code,
            error_msg: payload.error_msg,
            message: payload.message,
          }
        : {};
      const detailParts = [
        businessError.message || '消息发送失败',
        businessError.code ? `code=${businessError.code}` : '',
        Object.values(responseSummary).some(value => value !== undefined && value !== null && value !== '')
          ? `response=${JSON.stringify(responseSummary)}`
          : '',
      ].filter(Boolean);
      const error = new Error(detailParts.join(' | '));
      error.errorCode = businessError.code;
      error.payload = payload;
      if (this._isAuthError(businessError.code)) {
        throw this._markAuthExpired(error, {
          errorCode: businessError.code,
          errorMsg: businessError.message,
          authState: 'expired',
          source: 'business-code',
        });
      }
      throw error;
    }
    const confirmResult = await this._confirmSentTextMessage(sessionMeta, text, { sentAtMs });
    const confirmed = !!confirmResult.confirmed;
    if (!confirmed) {
      this._log('[API] 消息发送未确认，按接口成功返回', {
        sessionId: String(sessionMeta.sessionId || ''),
        targetUid: String(requestBody?.data?.message?.to?.uid || ''),
        payloadKeys: Object.keys(payload?.result || payload?.data || payload || {}),
      });
    } else {
      this._log('[API] 消息发送确认成功', {
        sessionId: String(sessionMeta.sessionId || ''),
        targetUid: String(requestBody?.data?.message?.to?.uid || ''),
        payloadKeys: Object.keys(payload?.result || payload?.data || payload || {}),
        messageId: confirmResult.messageId,
      });
    }

    const result = {
      success: true,
      confirmed,
      sendMode: 'manual-interface',
      manualSource,
      sessionId: String(sessionMeta.sessionId || ''),
      customerId: String(sessionMeta.customerId || ''),
      userUid: String(sessionMeta.userUid || ''),
      messageId: confirmResult.messageId,
      text,
      response: payload,
      warning: confirmed ? '' : '发送接口已返回成功，但短时间内未在会话列表确认到新消息',
    };
    this.emit('messageSent', result);
    return result;
  }

  async sendManualMessage(sessionRef, text, options = {}) {
    return this.sendMessage(sessionRef, text, {
      ...options,
      manualSource: options?.manualSource || 'manual',
    });
  }

  async sendImage(sessionRef, filePath) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    let uploadResult;
    try {
      uploadResult = await this.uploadImage(filePath);
    } catch (error) {
      if (!error.step) {
        throw this._createStepError('upload', error.message);
      }
      throw error;
    }
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const imageUrl = uploadResult?.processed_url || uploadResult?.url;
    const imageMeta = await this._buildImageMessageMeta(filePath, uploadResult);
    const requestBody = this._buildSendImageBody(sessionMeta, imageUrl, imageMeta);
    this._log('[API] 发送图片', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      filePath: path.basename(filePath || ''),
      imageUrl,
      client: requestBody?.client,
      uploadBaseUrl: uploadResult?.uploadBaseUrl,
    });
    let payload;
    try {
      payload = await this._post('/plateau/chat/send_message', requestBody);
    } catch (error) {
      throw this._createStepError('send', error.message, {
        imageUrl,
        uploadBaseUrl: uploadResult?.uploadBaseUrl,
      });
    }
    const result = {
      sessionId: String(sessionMeta.sessionId || ''),
      customerId: String(sessionMeta.customerId || ''),
      userUid: String(sessionMeta.userUid || ''),
      filePath,
      imageUrl,
      uploadBaseUrl: uploadResult?.uploadBaseUrl,
      response: payload
    };
    this.emit('messageSent', result);
    return result;
  }

  async sendImageUrl(sessionRef, imageUrl, extra = {}) {
    if (!this._sessionInited) {
      await this.initSession();
    }
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const imageMeta = await this._buildImageMessageMeta(extra?.filePath || '', extra);
    const requestBody = this._buildSendImageBody(sessionMeta, imageUrl, imageMeta);
    this._log('[API] 发送图片', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      filePath: extra?.filePath ? path.basename(extra.filePath) : '',
      imageUrl,
      client: requestBody?.client,
      uploadBaseUrl: extra?.uploadBaseUrl || '',
    });
    let payload;
    try {
      payload = await this._post('/plateau/chat/send_message', requestBody);
    } catch (error) {
      throw this._createStepError('send', error.message, {
        imageUrl,
        uploadBaseUrl: extra?.uploadBaseUrl || '',
      });
    }
    const result = {
      sessionId: String(sessionMeta.sessionId || ''),
      customerId: String(sessionMeta.customerId || ''),
      userUid: String(sessionMeta.userUid || ''),
      filePath: extra?.filePath || '',
      imageUrl,
      uploadBaseUrl: extra?.uploadBaseUrl || '',
      response: payload
    };
    this.emit('messageSent', result);
    return result;
  }

  async getVideoLibrary(params = {}) {
    if (!this._sessionInited) {
      await this.initSession();
    }
    const includePending = params.includePending === true;
    const requestBody = {
      file_type_desc: 'video',
      file_name: String(params.fileName || '').trim(),
      order_by: 'create_time desc',
      page: Math.max(1, Number(params.page || 1) || 1),
      page_size: Math.max(1, Math.min(100, Number(params.pageSize || 100) || 100)),
    };
    if (!includePending) {
      requestBody.check_status_list = [2];
    }
    const payload = await this._post('/latitude/user/file/list', requestBody, {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      Referer: CHAT_URL,
      Origin: PDD_BASE,
    });
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    const list = Array.isArray(result.file_with_check_dtolist) ? result.file_with_check_dtolist : [];
    return {
      total: Number(result.total || list.length || 0) || 0,
      list: list.map(item => this._normalizeVideoFile(item)),
    };
  }

  async getVideoFileDetail(params = {}) {
    if (!this._sessionInited) {
      await this.initSession();
    }
    const fileId = Number(params.fileId || params.file_id || 0) || 0;
    const fileUrl = String(params.fileUrl || params.file_url || '').trim();
    if (!fileId && !fileUrl) {
      throw new Error('缺少视频文件标识');
    }
    const requestBody = {};
    if (fileId) requestBody.file_id = fileId;
    if (fileUrl) requestBody.file_url = fileUrl;
    const payload = await this._requestVideoMaterialApi('/garner/mms/file/queryFileDetail', requestBody);
    const detail = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    return this._normalizeVideoFile(detail);
  }

  async waitVideoFileReady(params = {}) {
    const timeoutMs = Math.max(1000, Number(params.timeoutMs || 120000) || 120000);
    const pollMs = Math.max(500, Number(params.pollMs || 2000) || 2000);
    const deadline = Date.now() + timeoutMs;
    let lastDetail = null;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        lastDetail = await this.getVideoFileDetail(params);
        lastError = null;
        if (Number(lastDetail?.checkStatus || 0) === 2 && String(lastDetail?.url || '').trim()) {
          return lastDetail;
        }
        if ([3, 4, 5].includes(Number(lastDetail?.checkStatus || 0))) {
          throw new Error(lastDetail?.checkComment || '视频审核未通过');
        }
      } catch (error) {
        lastError = error;
      }
      await this._sleep(pollMs);
    }
    throw new Error(lastDetail?.checkComment || lastError?.message || '视频转码超时，请稍后重试');
  }

  async sendVideoUrl(sessionRef, videoUrl, extra = {}) {
    if (!this._sessionInited) {
      await this.initSession();
    }
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const url = String(videoUrl || '').trim();
    const uid = String(sessionMeta.userUid || sessionMeta.customerId || sessionMeta.sessionId || '').trim();
    if (!url) {
      throw new Error('缺少视频地址');
    }
    if (!uid) {
      throw new Error('缺少会话 uid');
    }
    const requestBody = {
      uid,
      url,
    };
    this._log('[API] 发送视频', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: uid,
      videoUrl: url,
    });
    const payload = await this._post('/plateau/message/library_file/send', requestBody, {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      Referer: CHAT_URL,
      Origin: PDD_BASE,
    });
    const result = {
      success: true,
      sessionId: String(sessionMeta.sessionId || ''),
      customerId: String(sessionMeta.customerId || ''),
      userUid: uid,
      videoUrl: url,
      videoCoverUrl: String(extra.coverUrl || extra.video_cover_url || '').trim(),
      videoDuration: Number(extra.duration || 0) || 0,
      response: payload,
    };
    this.emit('messageSent', result);
    return result;
  }

  async getGoodsCard(params = {}) {
    return this._goodsCardModule.getGoodsCard(params);
  }

  async markLatestConversations(size = 100) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const latestTraffic = this._findLatestTraffic('/plateau/chat/marked_lastest_conversations');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    const requestBody = templateBody
      ? {
          ...this._cloneJson(templateBody),
          data: {
            ...(templateBody.data || {}),
            request_id: this._nextRequestId(),
            size,
          },
          client: templateBody.client !== undefined && templateBody.client !== null && templateBody.client !== ''
            ? templateBody.client
            : this._getLatestClientValue(),
        }
      : {
          data: {
            cmd: 'marked_lastest_conversations',
            request_id: this._nextRequestId(),
            size,
            anti_content: antiContent,
          },
          client: this._getLatestClientValue(),
          anti_content: antiContent,
        };

    return this._post('/plateau/chat/marked_lastest_conversations', requestBody);
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

  async _pollMessagesForSession(sessionRef, options = {}) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    // 安全模式：轮询过程中不允许隐式 initSession()，防止后台拉起完整 chat-merchant 运行时
    const messages = await this.getSessionMessages(sessionMeta.sessionId || sessionRef, 1, 20, { allowInitSession: false });
    const newMessages = [];
    const bootstrapOnly = options.bootstrapOnly === true;
    const emitBootstrapPending = options.emitBootstrapPending === true;
    const buyerIds = [
      sessionMeta?.customerId,
      sessionMeta?.userUid,
      sessionMeta?.raw?.customer_id,
      sessionMeta?.raw?.buyer_id,
      sessionMeta?.raw?.uid,
      sessionMeta?.raw?.user_info?.uid,
    ].map(value => String(value || '')).filter(Boolean);

    const pendingBootstrapMessage = bootstrapOnly && emitBootstrapPending
      ? this._pickPendingBuyerMessage(messages, buyerIds, sessionMeta.raw || sessionMeta)
      : null;
    const pendingBootstrapKey = pendingBootstrapMessage
      ? String(pendingBootstrapMessage.messageId || `${pendingBootstrapMessage.sessionId}|${pendingBootstrapMessage.senderId}|${pendingBootstrapMessage.timestamp}|${pendingBootstrapMessage.content}`)
      : '';

    for (const item of messages) {
      const key = item.messageId || `${item.sessionId}|${item.senderId}|${item.timestamp}|${item.content}`;
      const senderId = String(item.senderId || item?.raw?.from_uid || item?.raw?.sender_id || item?.raw?.from_id || item?.raw?.from?.uid || '');
      const isBuyerMessage = item.isFromBuyer || (!!senderId && buyerIds.includes(senderId));
      if (!isBuyerMessage || !item.content || this._seenMessageIds.has(key)) continue;
      this._seenMessageIds.add(key);
      if (bootstrapOnly) {
        if (!emitBootstrapPending || key !== pendingBootstrapKey) continue;
      }
      newMessages.push(item);
    }

    if (this._seenMessageIds.size > 500) {
      const trimmed = [...this._seenMessageIds].slice(-200);
      this._seenMessageIds = new Set(trimmed);
    }

    return newMessages;
  }

  startPolling() {
    if (this._polling) return;
    this._polling = true;
    this._doPoll();
  }

  stopPolling() {
    this._polling = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _doPoll() {
    if (!this._polling) return;

    try {
      // 安全模式：轮询读取会话列表时不允许隐式 initSession()，
      // 首轮若尚未建立会话，走页面抓包缓存回退，避免后台创建隐藏 BrowserWindow 加载 chat-merchant 而掉线
      const sessions = await this.getSessionList(1, 100, { allowInitSession: false });
      this.emit('sessionUpdated', sessions);

      const targets = sessions
        .filter(item => item.sessionId)
        .sort((a, b) => {
          const unreadDiff = Number(b.unreadCount || 0) - Number(a.unreadCount || 0);
          if (unreadDiff !== 0) return unreadDiff;
          return this._normalizeTimestampMs(b?.lastMessageTime) - this._normalizeTimestampMs(a?.lastMessageTime);
        })
        .slice(0, 20);

      if (!this._pollBootstrapDone) {
        const bootstrapTargets = sessions
          .filter(item => item.sessionId)
          .sort((a, b) => this._normalizeTimestampMs(b?.lastMessageTime) - this._normalizeTimestampMs(a?.lastMessageTime));
        const bootstrapPendingMessages = [];
        for (const sessionItem of bootstrapTargets) {
          const seededMessages = await this._pollMessagesForSession(sessionItem, {
            bootstrapOnly: true,
            emitBootstrapPending: true,
          });
          this._log('[API] Bootstrap检查会话', {
            sessionId: String(sessionItem?.sessionId || ''),
            customerName: String(sessionItem?.customerName || '未知客户'),
            previewText: String(sessionItem?.lastMessage || '').trim(),
            unreadCount: Number(sessionItem?.unreadCount || 0) || 0,
            waitTime: Number(sessionItem?.waitTime || 0) || 0,
            lastMessageActor: String(sessionItem?.lastMessageActor || 'unknown'),
            pickedPendingText: seededMessages.length
              ? String(seededMessages[seededMessages.length - 1]?.content || '').trim()
              : '',
            willEmitPending: seededMessages.length > 0,
          });
          if (seededMessages.length) {
            bootstrapPendingMessages.push({
              sessionItem,
              message: seededMessages[seededMessages.length - 1],
            });
          }
        }
        this._pollBootstrapDone = true;
        this._log('[API] 首轮轮询预热完成', {
          seededSessions: bootstrapTargets.length,
          pendingSessions: bootstrapPendingMessages.length,
        });
        for (const item of bootstrapPendingMessages) {
          const message = item.message;
          const sessionItem = item.sessionItem;
          this.emit('newMessage', {
            shopId: this.shopId,
            sessionId: message.sessionId,
            customer: message.senderName || sessionItem.customerName || '未知客户',
            customerId: message.senderId || sessionItem.customerId || '',
            userUid: message.senderId || sessionItem.userUid || sessionItem.customerId || '',
            session: {
              ...this._cloneJson(sessionItem),
              sessionId: message.sessionId || sessionItem.sessionId || '',
              customerId: message.senderId || sessionItem.customerId || '',
              userUid: message.senderId || sessionItem.userUid || sessionItem.customerId || '',
              customerName: message.senderName || sessionItem.customerName || '未知客户',
            },
            text: message.content,
            timestamp: message.timestamp,
            messageId: message.messageId,
          });
        }
        this._schedulePoll(POLL_INTERVAL);
        return;
      }

      for (const sessionItem of targets) {
        const freshMessages = await this._pollMessagesForSession(sessionItem);
        for (const message of freshMessages) {
          this.emit('newMessage', {
            shopId: this.shopId,
            sessionId: message.sessionId,
            customer: message.senderName || sessionItem.customerName || '未知客户',
            customerId: message.senderId || sessionItem.customerId || '',
            userUid: message.senderId || sessionItem.userUid || sessionItem.customerId || '',
            session: {
              ...this._cloneJson(sessionItem),
              sessionId: message.sessionId || sessionItem.sessionId || '',
              customerId: message.senderId || sessionItem.customerId || '',
              userUid: message.senderId || sessionItem.userUid || sessionItem.customerId || '',
              customerName: message.senderName || sessionItem.customerName || '未知客户',
            },
            text: message.content,
            timestamp: message.timestamp,
            messageId: message.messageId,
          });
        }
      }

      this._schedulePoll(POLL_INTERVAL);
    } catch (error) {
      if (error.authExpired) {
        this.stopPolling();
        return;
      }
      this._log(`[API] 轮询失败: ${error.message}`);
      this._schedulePoll(POLL_INTERVAL_IDLE);
    }
  }

  _schedulePoll(delay) {
    if (!this._polling) return;
    this._pollTimer = setTimeout(() => this._doPoll(), delay);
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
      const prepared = await this._prepareRequestHeaders(requestHeaders, {
        ensureMainCookieContext: false,
      });
      preparedHeaders = this._summarizePreparedHeaders(prepared.headers);
    } catch (error) {
      prepareError = error?.message || String(error);
      const fallbackHeaders = await this._buildHeaders(requestHeaders);
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
    this._seenMessageIds.clear();
    this._pollBootstrapDone = false;
    this._sessionCache = [];
  }
}

module.exports = { PddApiClient };
