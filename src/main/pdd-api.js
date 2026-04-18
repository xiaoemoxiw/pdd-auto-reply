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
    this._inviteOrderStateByUid = new Map();
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._requestInPddPage = options.requestInPddPage || null;
    this._executeInPddPage = options.executeInPddPage || null;
    this._getOrderPriceUpdateTemplate = options.getOrderPriceUpdateTemplate || (() => null);
    this._setOrderPriceUpdateTemplate = options.setOrderPriceUpdateTemplate || null;
    this._getSmallPaymentSubmitTemplate = options.getSmallPaymentSubmitTemplate || (() => null);
    this._refreshMainCookieContext = options.refreshMainCookieContext || null;
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
    const persistedTemplate = this._getSmallPaymentSubmitTemplate();
    if (!persistedTemplate || typeof persistedTemplate !== 'object') {
      return [];
    }
    const normalizedDesired = smallPaymentParsers.normalizeSmallPaymentTemplateLabel(desiredType);
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (template) => {
      const normalizedTemplate = smallPaymentParsers.normalizeSmallPaymentTemplateEntry(template);
      if (!normalizedTemplate) return;
      const key = `${normalizedTemplate.method}:${normalizedTemplate.url}:${normalizedTemplate.requestBody}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(normalizedTemplate);
    };
    if (persistedTemplate.latest || persistedTemplate.byLabel || persistedTemplate.byRefundType) {
      if (normalizedDesired) {
        pushCandidate(persistedTemplate.byLabel?.[normalizedDesired]);
      }
      pushCandidate(persistedTemplate.latest);
      Object.values(persistedTemplate.byLabel || {}).forEach(pushCandidate);
      Object.values(persistedTemplate.byRefundType || {}).forEach(pushCandidate);
      return candidates;
    }
    pushCandidate(persistedTemplate);
    return candidates;
  }

  _getLatestSmallPaymentSubmitTemplate(orderSn = '', options = {}) {
    const normalizedOrderSn = String(orderSn || '').trim();
    const desiredType = smallPaymentParsers.normalizeSmallPaymentTemplateLabel(options?.desiredType);
    const trafficEntries = this._getApiTrafficEntries();
    let fallbackTrafficTemplate = null;
    for (let i = trafficEntries.length - 1; i >= 0; i--) {
      const entry = trafficEntries[i];
      if (String(entry?.method || 'GET').toUpperCase() !== 'POST') continue;
      const url = String(entry?.url || '');
      if (!url.includes('/mercury/')) continue;
      if ([
        '/mercury/micro_transfer/detail',
        '/mercury/micro_transfer/queryTips',
        '/mercury/play_money/check',
      ].some(part => url.includes(part))) {
        continue;
      }
      const body = commonParsers.safeParseJson(entry?.requestBody);
      if (!smallPaymentParsers.isSmallPaymentSubmitBody(body, normalizedOrderSn)) {
        continue;
      }
      if (!fallbackTrafficTemplate) {
        fallbackTrafficTemplate = entry;
      }
      if (!desiredType || smallPaymentParsers.inferSmallPaymentTemplateLabelFromBody(body) === desiredType) {
        return entry;
      }
    }
    if (fallbackTrafficTemplate) {
      return fallbackTrafficTemplate;
    }
    const persistedCandidates = this._collectPersistedSmallPaymentSubmitTemplates(desiredType);
    let fallbackPersistedTemplate = null;
    for (const template of persistedCandidates) {
      const persistedBody = commonParsers.safeParseJson(template?.requestBody);
      if (!smallPaymentParsers.isSmallPaymentSubmitBody(persistedBody, normalizedOrderSn)) {
        continue;
      }
      if (!fallbackPersistedTemplate) {
        fallbackPersistedTemplate = template;
      }
      if (!desiredType || smallPaymentParsers.inferSmallPaymentTemplateLabelFromBody(persistedBody) === desiredType) {
        return template;
      }
    }
    return fallbackPersistedTemplate;
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
    const attempts = Math.max(1, Number(options.attempts || 6));
    const delayMs = Math.max(0, Number(options.delayMs || 800));
    const pageSize = Math.max(20, Number(options.pageSize || 30));
    const sentAtMs = Number(options.sentAtMs || Date.now());
    const expectedText = this._normalizeComparableMessageText(options.expectedText || '');
    for (let index = 0; index < attempts; index++) {
      const messages = await this.getSessionMessages(sessionRef, 1, pageSize);
      const matched = messages.find(message => {
        const actor = this._getMessageActor(message?.raw || message);
        if (actor === 'buyer' || actor === 'system') return false;
        const timestampMs = this._normalizeTimestampMs(message.timestamp);
        if (timestampMs && (timestampMs < sentAtMs - 15000 || timestampMs > Date.now() + 60000)) {
          return false;
        }
        const messageText = this._normalizeComparableMessageText(message.content);
        if (expectedText && messageText && messageText === expectedText) return true;
        if (/快捷退款|申请退款|退货退款|待消费者确认/.test(messageText || '')) return true;
        return !!timestampMs && timestampMs >= sentAtMs - 15000;
      });
      if (matched) {
        return {
          confirmed: true,
          messageId: String(matched.messageId || ''),
          timestamp: matched.timestamp || 0,
          content: String(matched.content || ''),
        };
      }
      if (index < attempts - 1) {
        await this._sleep(delayMs);
      }
    }
    return { confirmed: false };
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
    const shop = this._getShopInfo();
    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const goodsPageUserAgent = normalizePddUserAgent(shop?.userAgent || this._getTokenInfo()?.userAgent || '');
    const goodsPageProfile = applySessionPddPageProfile(win.webContents.session, {
      userAgent: isChromeLikeUserAgent(goodsPageUserAgent) ? goodsPageUserAgent : DEFAULT_PAGE_CHROME_UA,
      tokenInfo: this._getTokenInfo(),
      clientHintsProfile: 'page'
    });
    if (goodsPageProfile?.userAgent) {
      win.webContents.setUserAgent(goodsPageProfile.userAgent);
    }
    try {
      await win.loadURL(url);
      for (let i = 0; i < 6; i += 1) {
        await this._sleep(800);
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('/login')) break;
        if (currentUrl.includes('goods.html') || currentUrl.includes('goods2.html') || currentUrl.includes('goods_id=')) {
          await this._sleep(1200);
          break;
        }
      }
      return await win.webContents.executeJavaScript(`(() => ({
        url: location.href,
        title: document.title || '',
        html: document.documentElement ? document.documentElement.outerHTML : ''
      }))()`);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
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
    const bucket = [];
    const visited = new WeakSet();
    this._getApiTrafficEntries()
      .filter(entry => /order|goods|trade|pay|after/i.test(String(entry?.url || '')))
      .slice(-30)
      .forEach(entry => {
        const requestBody = typeof entry?.requestBody === 'string' ? this._safeParseJson(entry.requestBody) : entry?.requestBody;
        const responseBody = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
        this._collectRefundOrderNodes(requestBody, bucket, visited);
        this._collectRefundOrderNodes(responseBody, bucket, visited);
      });
    return bucket.map((item, index) => this._normalizeRefundOrder(item, sessionMeta, index));
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
    const validOrderSns = [...new Set((Array.isArray(orderSns) ? orderSns : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!validOrderSns.length) return {};
    const antiContent = this._getLatestAntiContent();
    const payload = await this._requestRefundOrderPageApi('/mercury/chat/afterSales/queryList', antiContent
      ? { orderSns: validOrderSns, anti_content: antiContent }
      : { orderSns: validOrderSns });
    return this._extractAfterSalesDetailMapFromPayload(payload);
  }

  async _attachAfterSalesStatus(orders = []) {
    const orderSns = orders.map(item => String(item?.orderId || item?.orderSn || '').trim()).filter(Boolean);
    if (!orderSns.length) return orders;
    let detailMap = {};
    try {
      detailMap = await this._fetchAfterSalesDetailMap(orderSns);
    } catch (error) {
      this._log('[API] 售后状态查询失败', { message: error.message });
    }
    return orders.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || '').trim();
      const detail = detailMap[orderSn] && typeof detailMap[orderSn] === 'object'
        ? detailMap[orderSn]
        : {};
      return {
        ...order,
        ...detail,
        afterSalesStatus: detail.afterSalesStatus || order?.afterSalesStatus || '',
      };
    });
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
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const headers = {
      accept: 'application/json, text/plain, */*',
      Referer: CHAT_URL,
      Origin: PDD_BASE,
    };
    if (normalizedMethod !== 'GET') {
      headers['content-type'] = 'application/json;charset=UTF-8';
    }
    if (typeof this._requestInPddPage === 'function') {
      return this._requestInPddPage({
        method: normalizedMethod,
        url: urlPath,
        source: 'goods-page:request',
        headers,
        body: normalizedMethod === 'GET' ? null : JSON.stringify(body || {}),
      });
    }
    if (normalizedMethod === 'GET') {
      return this._request('GET', urlPath, null, headers);
    }
    return this._post(urlPath, body || {}, headers);
  }

  _buildGoodsCardFromPageApis(goodsPayload, skuPayload, fallback = {}) {
    const goods = Array.isArray(goodsPayload?.result?.goods)
      ? (goodsPayload.result.goods[0] || {})
      : (goodsPayload?.goods || {});
    const skus = Array.isArray(skuPayload?.skus)
      ? skuPayload.skus
      : (Array.isArray(skuPayload?.result?.skus) ? skuPayload.result.skus : []);
    const specKeys = Array.isArray(skuPayload?.specKeys)
      ? skuPayload.specKeys
      : (Array.isArray(skuPayload?.result?.specKeys) ? skuPayload.result.specKeys : []);
    const specItems = skus.map(item => {
      const specs = Array.isArray(item?.spec) ? item.spec.map(value => String(value || '').trim()).filter(Boolean) : [];
      const priceText = this._pickGoodsText([
        this._normalizeGoodsPrice(item?.price),
        item?.price,
      ]);
      return {
        specLabel: specs[0] || specKeys[0] || '',
        styleLabel: specs[1] || (specs.length > 1 ? specs.slice(1).join(' / ') : (specKeys[1] || '')),
        priceText,
        stockText: item?.stock !== undefined && item?.stock !== null ? String(item.stock) : '',
        salesText: '',
      };
    }).filter(item => item.specLabel || item.styleLabel || item.priceText || item.stockText);
    const customerNumber = Number(goods?.customerNumber || goods?.customer_number || 0) || 0;
    const quantity = Number(goods?.quantity || goods?.stock || 0) || 0;
    const soldQuantity = Number(goods?.soldQuantity || goods?.sold_quantity || 0) || 0;
    const ungroupedNum = Number(goods?.ungroupedNum || goods?.ungrouped_num || 0) || 0;
    return {
      goodsId: String(goods?.goodsId || goods?.goods_id || fallback.goodsId || ''),
      title: String(goods?.goodsName || goods?.goods_name || fallback.title || '拼多多商品').trim(),
      imageUrl: String(goods?.thumbUrl || goods?.thumb_url || fallback.imageUrl || '').trim(),
      priceText: this._normalizeGoodsPrice(goods?.price) || String(fallback.priceText || '').trim(),
      groupText: customerNumber > 0 ? `${customerNumber}人团` : String(fallback.groupText || '2人团').trim(),
      specText: String(fallback.specText || '查看商品规格').trim(),
      stockText: quantity > 0 ? String(quantity) : '',
      salesText: soldQuantity > 0 ? String(soldQuantity) : '',
      pendingGroupText: String(ungroupedNum),
      specItems,
    };
  }

  async _requestRefundApplyApi(urlPath, body = {}, method = 'POST') {
    const normalizedMethod = String(method || 'POST').toUpperCase();
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
    };
    if (normalizedMethod === 'GET') {
      delete headers['content-type'];
    }
    if (typeof this._requestInPddPage === 'function') {
      return this._requestInPddPage({
        method: normalizedMethod,
        url: urlPath,
        source: 'refund-apply:page-request',
        headers,
        body: normalizedMethod === 'GET' ? null : JSON.stringify(body || {}),
      });
    }
    if (normalizedMethod === 'GET') {
      return this._request('GET', urlPath, null, headers);
    }
    return this._post(urlPath, body || {}, headers);
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
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const payload = await this._requestRefundApplyApi('/plateau/message/ask_refund_apply/infoV2', {
      order_sn: normalizedOrderSn,
    });
    return this._cloneJson(payload);
  }

  async submitRefundApply(params = {}) {
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const afterSalesType = this._normalizeRefundApplyType(params?.type || params?.afterSalesType || params?.after_sales_type);
    const infoPayload = await this.getRefundApplyInfo(normalizedOrderSn);
    const info = infoPayload?.result && typeof infoPayload.result === 'object' ? infoPayload.result : {};
    const shopProfile = await this.getShopProfile().catch(() => ({}));
    if (afterSalesType !== 1) {
      throw new Error('当前仅已接通“退款”申请接口');
    }
    const refundAmountFen = Number.isFinite(Number(params?.refundAmountFen))
      ? Math.max(0, Math.round(Number(params.refundAmountFen)))
      : this._parseOrderPriceYuanToFen(params?.refundAmount || params?.amount);
    const maxRefundAmountFen = Number(info?.total_amount || 0);
    if (!refundAmountFen) {
      throw new Error('缺少退款金额');
    }
    if (maxRefundAmountFen > 0 && refundAmountFen > maxRefundAmountFen) {
      throw new Error('退款金额不能超过订单实付金额');
    }
    const requestReposeInfo = this._resolveRefundApplyReposeInfo(infoPayload, {
      ...params,
      reposeInfo: {
        ...(params?.reposeInfo && typeof params.reposeInfo === 'object' ? params.reposeInfo : {}),
        mobile: params?.reposeInfo?.mobile ?? info?.mobile ?? info?.phone ?? shopProfile?.mobile ?? null,
      },
    });
    const requestBody = {
      order_sn: normalizedOrderSn,
      after_sales_type: afterSalesType,
      user_ship_status: this._normalizeRefundApplyShipStatus(params?.userShipStatus || params?.user_ship_status || params?.receiptStatus),
      question_type: this._resolveRefundApplyQuestionType(params),
      refund_amount: refundAmountFen,
      reposeInfo: requestReposeInfo,
      message: String(params?.message || '').trim(),
      manualEditedNote: Boolean(params?.manualEditedNote),
      send_card_before_message: this._normalizeRefundApplyFlag(info?.send_card_before_message, true),
    };
    if (!requestBody.message && this._normalizeRefundApplyFlag(info?.need_show_message_box, false)) {
      throw new Error('缺少留言内容');
    }
    this._log('[API] 提交申请售后', {
      orderSn: normalizedOrderSn,
      afterSalesType: requestBody.after_sales_type,
      questionType: requestBody.question_type,
      refundAmountFen,
      userShipStatus: requestBody.user_ship_status,
      hasMessage: !!requestBody.message,
    });
    const sentAtMs = Date.now();
    const payload = await this._requestRefundApplyApi('/plateau/message/ask_refund_apply/send', requestBody);
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      const error = new Error(businessError.message);
      error.errorCode = businessError.code;
      error.payload = payload;
      throw error;
    }
    const sessionRef = params.session || params.sessionId || normalizedOrderSn;
    const conversationConfirm = sessionRef
      ? await this._confirmRefundApplyConversationMessage(sessionRef, {
          sentAtMs,
          expectedText: requestBody.message,
        }).catch(() => ({ confirmed: false }))
      : { confirmed: false };
    return {
      success: true,
      orderSn: normalizedOrderSn,
      afterSalesType: requestBody.after_sales_type,
      questionType: requestBody.question_type,
      refundAmountFen,
      requestBody: this._cloneJson(requestBody),
      reposeInfo: this._cloneJson(requestReposeInfo),
      response: payload,
      info: this._cloneJson(info),
      messageConfirmed: !!conversationConfirm.confirmed,
      confirmedMessageId: conversationConfirm.messageId || '',
      confirmedMessageText: conversationConfirm.content || '',
    };
  }

  async getSmallPaymentInfo(params = {}) {
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const mallId = Number(params?.mallId || params?.mall_id || this._getMallId() || 0);
    const tipsBody = { orderSn: normalizedOrderSn };
    if (Number.isFinite(mallId) && mallId > 0) {
      tipsBody.mallId = mallId;
    }
    const [detailPayload, checkPayload, tipsPayload] = await Promise.all([
      this._requestRefundOrderPageApi('/mercury/micro_transfer/detail', { orderSn: normalizedOrderSn }),
      this._requestRefundOrderPageApi('/mercury/play_money/check', { orderSn: normalizedOrderSn }),
      this._requestRefundOrderPageApi('/mercury/micro_transfer/queryTips', tipsBody),
    ]);
    const businessError = this._normalizeBusinessError(detailPayload)
      || this._normalizeBusinessError(checkPayload)
      || this._normalizeBusinessError(tipsPayload);
    if (businessError) {
      throw new Error(businessError.message || '获取小额打款信息失败');
    }
    const detailList = Array.isArray(detailPayload?.result) ? detailPayload.result : [];
    const checkResult = checkPayload?.result && typeof checkPayload.result === 'object' ? checkPayload.result : {};
    const tipsResult = tipsPayload?.result && typeof tipsPayload.result === 'object' ? tipsPayload.result : {};
    const freight = tipsResult?.freightDTO && typeof tipsResult.freightDTO === 'object' ? tipsResult.freightDTO : {};
    const successNum = Math.max(0, Number(freight?.successNum || 0) || 0);
    const processingNum = Math.max(0, Number(freight?.processingNum || 0) || 0);
    const waitHandleNum = Math.max(0, Number(freight?.waitHandleNum || 0) || 0);
    const usedTimes = Math.max(detailList.length, successNum + processingNum + waitHandleNum);
    const maxTimes = 3;
    const remainingTimes = Math.max(0, maxTimes - usedTimes);
    const limitAmountFen = Math.max(0, Number(checkResult?.limitAmount || 0) || 0);
    const transferCode = String(checkResult?.transferCode || '').trim();
    const transferDesc = String(checkResult?.transferDesc || '').trim();
    const desiredType = this._normalizeSmallPaymentTemplateLabel(
      params?.refundType ?? params?.refund_type ?? params?.type
    );
    const submitTemplate = this._getLatestSmallPaymentSubmitTemplate(normalizedOrderSn, {
      desiredType,
    });
    const submitTemplateMeta = this._analyzeSmallPaymentSubmitTemplate(submitTemplate);
    const tipList = Array.isArray(tipsResult?.tipVOList) ? tipsResult.tipVOList : [];
    const confirmTipList = Array.isArray(tipsResult?.confirmTipVOList) ? tipsResult.confirmTipVOList : [];
    const standardTipList = Array.isArray(tipsResult?.standardTipVOList) ? tipsResult.standardTipVOList : [];
    const collectedTips = [...tipList, ...confirmTipList, ...standardTipList]
      .map(item => (item && typeof item === 'object')
        ? String(item.content || item.desc || item.tip || item.text || '').trim()
        : String(item || '').trim())
      .filter(Boolean);
    return {
      success: true,
      orderSn: normalizedOrderSn,
      mallId: Number.isFinite(mallId) && mallId > 0 ? mallId : null,
      limitAmountFen,
      limitAmount: limitAmountFen > 0 ? this._formatSideOrderAmount(limitAmountFen).replace(/^¥/, '') : '',
      transferType: Number.isFinite(Number(checkResult?.transferType)) ? Number(checkResult.transferType) : null,
      playMoneyPattern: Number.isFinite(Number(checkResult?.playMoneyPattern)) ? Number(checkResult.playMoneyPattern) : null,
      channel: Number.isFinite(Number(checkResult?.channel)) ? Number(checkResult.channel) : null,
      needChargePlayMoney: Boolean(checkResult?.needChargePlayMoney),
      transferCode: transferCode || null,
      transferDesc: transferDesc || null,
      canSubmit: limitAmountFen > 0 && remainingTimes > 0 && (!transferCode || Boolean(checkResult?.needChargePlayMoney)),
      submitTemplateReady: !!submitTemplate,
      submitTemplateUrl: submitTemplate?.url || '',
      submitTemplateMeta: submitTemplateMeta.ready ? submitTemplateMeta : null,
      maxTimes,
      usedTimes,
      remainingTimes,
      history: {
        successNum,
        processingNum,
        waitHandleNum,
        successAmountFen: Math.max(0, Number(freight?.successTotalAmount || 0) || 0),
        processingAmountFen: Math.max(0, Number(freight?.processingTotalAmount || 0) || 0),
        waitHandleAmountFen: Math.max(0, Number(freight?.waitHandleTotalAmount || 0) || 0),
      },
      showNotSignedTips: Boolean(tipsResult?.showNotSignedTips),
      tips: collectedTips,
      detailList: this._cloneJson(detailList),
      raw: {
        check: this._cloneJson(checkResult),
        tips: this._cloneJson(tipsResult),
      },
    };
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
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const playMoneyAmount = Number.isFinite(Number(params?.playMoneyAmountFen))
      ? Math.max(0, Math.round(Number(params.playMoneyAmountFen)))
      : this._parseOrderPriceYuanToFen(params?.playMoneyAmount || params?.amount);
    if (!playMoneyAmount) {
      throw new Error('缺少打款金额');
    }
    const remarks = String(params?.remarks ?? params?.remark ?? params?.message ?? '').trim();
    if (!remarks) {
      throw new Error('缺少留言内容');
    }
    const info = await this.getSmallPaymentInfo({
      orderSn: normalizedOrderSn,
      mallId: params?.mallId || params?.mall_id,
    });
    if (Number(info?.limitAmountFen || 0) > 0 && playMoneyAmount > Number(info.limitAmountFen || 0)) {
      throw new Error('打款金额不能超过单次上限');
    }
    const submitTemplate = this._getLatestSmallPaymentSubmitTemplate(normalizedOrderSn);
    if (!submitTemplate) {
      throw new Error('当前店铺尚未捕获小额打款真实提交模板');
    }
    const templateBody = this._safeParseJson(submitTemplate?.requestBody);
    const submitTemplateMeta = this._analyzeSmallPaymentSubmitTemplate(submitTemplate);
    const refundType = this._normalizeSmallPaymentRefundType(
      params?.refundType ?? params?.refund_type ?? params?.type,
      {
        detailList: info?.detailList,
        templateBody,
        submitTemplateMeta,
      }
    );
    const chargeType = Number.isFinite(Number(params?.chargeType))
      ? Math.max(0, Math.round(Number(params.chargeType)))
      : Math.max(0, Number(
        submitTemplateMeta?.snapshot?.chargeType
        ?? this._readObjectPath(templateBody, submitTemplateMeta?.recognizedFields?.chargeField)
        ?? templateBody?.chargeType
        ?? templateBody?.charge_type
        ?? info?.channel
        ?? 4
      ) || 0);
    const requestBody = this._buildSmallPaymentSubmitRequestBody({
      templateBody,
      submitTemplateMeta,
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      remarks,
      chargeType,
    });
    this._log('[API] 提交小额打款', {
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      chargeType,
      hasRemarks: !!remarks,
    });
    const payload = await this._requestRefundOrderPageApi('/mercury/play_money/create', requestBody);
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      const error = new Error(businessError.message || '提交小额打款失败');
      error.errorCode = businessError.code;
      error.payload = payload;
      throw error;
    }
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    const cashierShortUrl = String(result?.link || '').trim();
    return {
      success: true,
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      chargeType,
      requestBody: this._cloneJson(requestBody),
      response: this._cloneJson(payload),
      chargeSn: String(result?.chargeSn || '').trim(),
      chargeStatus: Number.isFinite(Number(result?.status)) ? Number(result.status) : null,
      transferCode: result?.transferCode ?? null,
      cashierShortUrl,
      cashierUrl: cashierShortUrl ? `https://mms.pinduoduo.com/cashier/?orderSn=${cashierShortUrl}` : '',
    };
  }

  _resolveInviteOrderUid(params = {}) {
    const sessionMeta = this._normalizeSessionMeta(params?.session || params?.sessionId);
    const candidates = [
      params?.uid,
      sessionMeta?.userUid,
      sessionMeta?.customerId,
      sessionMeta?.sessionId,
      sessionMeta?.raw?.uid,
      sessionMeta?.raw?.to?.uid,
      sessionMeta?.raw?.user_info?.uid,
      sessionMeta?.raw?.buyer_id,
      sessionMeta?.raw?.customer_id,
    ].map(value => String(value || '').trim()).filter(Boolean);
    return candidates[0] || '';
  }

  _getInviteOrderSessionState(uid) {
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) {
      return {
        uid: '',
        goodsList: [],
        selectedItems: [],
      };
    }
    if (!this._inviteOrderStateByUid.has(normalizedUid)) {
      this._inviteOrderStateByUid.set(normalizedUid, {
        uid: normalizedUid,
        goodsList: [],
        selectedItems: [],
      });
    }
    return this._inviteOrderStateByUid.get(normalizedUid);
  }

  _formatInviteOrderFen(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '';
    const yuan = amount / 100;
    return yuan.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  _normalizeInviteOrderGoodsItem(item = {}) {
    const minPrice = Number(item?.minOnSaleGroupPriceOriginal);
    const maxPrice = Number(item?.maxOnSaleGroupPriceOriginal);
    let priceText = '';
    if (Number.isFinite(minPrice) && Number.isFinite(maxPrice) && minPrice > 0 && maxPrice > 0) {
      priceText = minPrice === maxPrice
        ? `¥${this._formatInviteOrderFen(minPrice)}`
        : `¥${this._formatInviteOrderFen(minPrice)}-${this._formatInviteOrderFen(maxPrice)}`;
    } else if (String(item?.defaultPriceStr || '').trim()) {
      priceText = `¥${String(item.defaultPriceStr).trim()}`;
    }
    const metaParts = [];
    if (Number.isFinite(Number(item?.quantity))) {
      metaParts.push(`库存 ${Number(item.quantity)}`);
    }
    if (Number.isFinite(Number(item?.soldQuantity))) {
      metaParts.push(`已售 ${Number(item.soldQuantity)}`);
    }
    if (String(item?.failInviteReason || '').trim()) {
      metaParts.push(String(item.failInviteReason).trim());
    }
    return {
      itemId: String(item?.goodsId || '').trim(),
      goodsId: Number(item?.goodsId || 0),
      title: String(item?.goodsName || '').trim(),
      imageUrl: String(item?.thumbUrl || item?.hdUrl || '').trim(),
      priceText,
      metaText: metaParts.join(' · '),
      canInvite: item?.canInvite !== false,
      raw: this._cloneJson(item),
    };
  }

  _filterInviteOrderGoodsList(goodsList = [], keyword = '') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return goodsList;
    return goodsList.filter(item => String(item?.title || '').toLowerCase().includes(normalizedKeyword));
  }

  _buildInviteOrderSnapshot(uid, options = {}) {
    const normalizedUid = String(uid || '').trim();
    const state = this._getInviteOrderSessionState(normalizedUid);
    const keyword = String(options?.keyword || '').trim();
    const goodsList = Array.isArray(options?.goodsList) ? options.goodsList : state.goodsList;
    const selectedItems = Array.isArray(state.selectedItems) ? state.selectedItems : [];
    const selectedGoodsIds = new Set(
      selectedItems.map(item => String(item?.goodsId || '').trim()).filter(Boolean)
    );
    const filteredGoodsList = this._filterInviteOrderGoodsList(goodsList, keyword).map(item => ({
      ...item,
      selected: selectedGoodsIds.has(String(item?.goodsId || '').trim()),
      buttonText: selectedGoodsIds.has(String(item?.goodsId || '').trim()) ? '已加入' : '加入清单',
    }));
    const totalFen = selectedItems.reduce((sum, item) => sum + Number(item?.promoPrice || item?.skuPrice || 0), 0);
    let statusText = selectedItems.length
      ? `已选 ${selectedItems.length} 件商品，可直接发送给买家`
      : '未添加任何商品，请从左侧列表选择商品';
    if (!filteredGoodsList.length && keyword) {
      statusText = '未找到匹配商品，请尝试更换关键词';
    } else if (!filteredGoodsList.length) {
      statusText = '暂未读取到可邀请商品';
    }
    return {
      success: true,
      source: 'api',
      goodsItems: filteredGoodsList,
      selectedItems: selectedItems.map((item, index) => ({
        itemId: `${item.goodsId || 'goods'}:${item.skuId || index}`,
        title: item.displayTitle || item.title || '已选商品',
        imageUrl: String(item?.imageUrl || '').trim(),
        priceText: `¥${this._formatInviteOrderFen(Number(item?.promoPrice || item?.skuPrice || 0)) || '0.00'}`,
        goodsNumber: Number(item?.goodsNumber || 1),
      })),
      selectedCount: selectedItems.length,
      totalText: `¥${this._formatInviteOrderFen(totalFen || 0) || '0.00'}`,
      statusText,
    };
  }

  async _loadInviteOrderGoodsList(uid) {
    const payload = await this._requestGoodsPageApi('/latitude/goods/getMallChatGoodsList', {
      pageNum: 1,
      pageSize: 15,
      uid,
    }, 'POST');
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError);
    }
    const result = payload?.result || {};
    const rawList = [
      ...(Array.isArray(result?.goodsList) ? result.goodsList : []),
      ...(Array.isArray(result?.activeGoodsList) ? result.activeGoodsList : []),
      ...(Array.isArray(result?.footprintGoodsList) ? result.footprintGoodsList : []),
    ];
    const deduped = [];
    const seen = new Set();
    for (const item of rawList) {
      const normalized = this._normalizeInviteOrderGoodsItem(item);
      if (!normalized.goodsId || !normalized.title) continue;
      const key = String(normalized.goodsId);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(normalized);
    }
    return deduped;
  }

  async _loadInviteOrderSkuSelector(uid, goodsId) {
    const payload = await this._requestGoodsPageApi('/latitude/goods/skuSelectorForMall', {
      goodsId,
      uid,
    }, 'POST');
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError);
    }
    const result = payload?.result || {};
    const skuList = Array.isArray(result?.sku) ? result.sku : [];
    return { payload, result, skuList };
  }

  _buildInviteOrderSkuSpecText(specs = [], { withKeys = false } = {}) {
    return (Array.isArray(specs) ? specs : [])
      .map(item => {
        const key = String(item?.specKey || '').trim();
        const value = String(item?.specValue || '').trim();
        if (withKeys && key && value) return `${key}:${value}`;
        return value || key;
      })
      .filter(Boolean)
      .join(' ');
  }

  _buildInviteOrderSkuPriceText(sku = {}) {
    const price = Number(
      sku?.groupPrice
      || sku?.oldGroupPrice
      || sku?.normalPrice
      || sku?.price
      || 0
    );
    return price > 0 ? `¥${this._formatInviteOrderFen(price)}` : '';
  }

  async getInviteOrderSkuOptions(params = {}) {
    const uid = this._resolveInviteOrderUid(params);
    const goodsId = Number(String(params?.itemId || params?.goodsId || '').trim());
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    if (!Number.isFinite(goodsId) || goodsId <= 0) {
      throw new Error('缺少商品标识');
    }
    const state = this._getInviteOrderSessionState(uid);
    if (!Array.isArray(state.goodsList) || !state.goodsList.length) {
      state.goodsList = await this._loadInviteOrderGoodsList(uid);
    }
    const goodsInfo = state.goodsList.find(item => Number(item?.goodsId) === goodsId) || {};
    const { result, skuList } = await this._loadInviteOrderSkuSelector(uid, goodsId);
    const availableSku = skuList.find(item => Number(item?.isOnsale) === 1 && Number(item?.quantity || 0) > 0)
      || skuList.find(item => Number(item?.isOnsale) === 1)
      || skuList[0];
    const optionLabelSet = new Set();
    const skuOptions = skuList
      .map((item, index) => {
        const skuId = Number(item?.skuId || 0);
        if (!skuId) return null;
        const label = this._buildInviteOrderSkuSpecText(item?.specs || []);
        const detailLabel = this._buildInviteOrderSkuSpecText(item?.specs || [], { withKeys: true });
        const specKeys = Array.isArray(item?.specs) ? item.specs.map(spec => String(spec?.specKey || '').trim()).filter(Boolean) : [];
        specKeys.forEach(key => optionLabelSet.add(key));
        const quantity = Number(item?.quantity || 0);
        return {
          skuId,
          label: label || `规格 ${index + 1}`,
          detailLabel: detailLabel || label || `规格 ${index + 1}`,
          priceText: this._buildInviteOrderSkuPriceText(item) || goodsInfo.priceText || '',
          quantity,
          stockText: Number.isFinite(quantity) ? `库存 ${Math.max(0, quantity)}` : '',
          disabled: Number(item?.isOnsale) !== 1 || quantity <= 0,
        };
      })
      .filter(Boolean);
    return {
      success: true,
      source: 'api',
      goodsId,
      title: String(goodsInfo?.title || result?.goodsName || '').trim() || '商品',
      imageUrl: String(goodsInfo?.imageUrl || '').trim(),
      priceText: String(goodsInfo?.priceText || '').trim() || (availableSku ? this._buildInviteOrderSkuPriceText(availableSku) : ''),
      optionLabel: optionLabelSet.size === 1 ? Array.from(optionLabelSet)[0] : '规格',
      selectedSkuId: availableSku?.skuId ? String(availableSku.skuId) : '',
      skuOptions,
    };
  }

  async _resolveInviteOrderSelection(uid, goodsId, goodsList = [], preferredSkuId = '') {
    const { result, skuList } = await this._loadInviteOrderSkuSelector(uid, goodsId);
    const normalizedPreferredSkuId = Number(String(preferredSkuId || '').trim());
    const targetSku = (Number.isFinite(normalizedPreferredSkuId) && normalizedPreferredSkuId > 0
      ? skuList.find(item => Number(item?.skuId) === normalizedPreferredSkuId)
      : null)
      || skuList.find(item => Number(item?.isOnsale) === 1 && Number(item?.quantity || 0) > 0)
      || skuList.find(item => Number(item?.isOnsale) === 1)
      || skuList[0];
    if (!targetSku?.skuId) {
      throw new Error('该商品暂无可邀请规格');
    }
    if (Number.isFinite(normalizedPreferredSkuId) && normalizedPreferredSkuId > 0 && Number(targetSku?.skuId) !== normalizedPreferredSkuId) {
      throw new Error('所选规格不存在');
    }
    if (Number(targetSku?.isOnsale) !== 1 || Number(targetSku?.quantity || 0) <= 0) {
      throw new Error('所选规格当前不可邀请');
    }
    const skuPrice = Number(
      targetSku?.groupPrice
      || targetSku?.oldGroupPrice
      || targetSku?.normalPrice
      || targetSku?.price
      || 0
    );
    const promoPayload = await this._requestGoodsPageApi('/latitude/goods/substitutePromoPrice', {
      type: 1,
      uid,
      selectList: [{
        goodsId,
        skuId: targetSku.skuId,
        goodsNumber: 1,
        skuPrice,
      }],
    }, 'POST');
    const promoBusinessError = this._normalizeBusinessError(promoPayload);
    if (promoBusinessError) {
      throw new Error(promoBusinessError);
    }
    const promoItem = Array.isArray(promoPayload?.result?.skuPromoPriceList)
      ? promoPayload.result.skuPromoPriceList[0]
      : null;
    const goodsInfo = goodsList.find(item => Number(item?.goodsId) === Number(goodsId)) || {};
    const specText = this._buildInviteOrderSkuSpecText(targetSku?.specs || [], { withKeys: true });
    return {
      goodsId: Number(goodsId),
      skuId: Number(targetSku.skuId),
      goodsNumber: Number(promoItem?.goodsNumber || 1),
      skuPrice: Number(promoItem?.skuPrice || skuPrice || 0),
      promoPrice: Number(promoItem?.promoPrice || skuPrice || 0),
      title: String(goodsInfo?.title || result?.goodsName || '').trim(),
      imageUrl: String(goodsInfo?.imageUrl || '').trim(),
      displayTitle: specText
        ? `${String(goodsInfo?.title || result?.goodsName || '商品').trim()}（${specText}）`
        : String(goodsInfo?.title || result?.goodsName || '商品').trim(),
    };
  }

  async getInviteOrderState(params = {}) {
    const uid = this._resolveInviteOrderUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const state = this._getInviteOrderSessionState(uid);
    state.goodsList = await this._loadInviteOrderGoodsList(uid);
    return this._buildInviteOrderSnapshot(uid, {
      keyword: params?.keyword,
      goodsList: state.goodsList,
    });
  }

  async addInviteOrderItem(params = {}) {
    const uid = this._resolveInviteOrderUid(params);
    const goodsId = Number(String(params?.itemId || '').trim());
    const preferredSkuId = String(params?.skuId || '').trim();
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    if (!Number.isFinite(goodsId) || goodsId <= 0) {
      throw new Error('缺少商品标识');
    }
    const state = this._getInviteOrderSessionState(uid);
    if (!Array.isArray(state.goodsList) || !state.goodsList.length) {
      state.goodsList = await this._loadInviteOrderGoodsList(uid);
    }
    const exists = state.selectedItems.find(item => Number(item?.goodsId) === goodsId);
    if (!exists) {
      const selection = await this._resolveInviteOrderSelection(uid, goodsId, state.goodsList, preferredSkuId);
      state.selectedItems.push(selection);
    }
    return this._buildInviteOrderSnapshot(uid, {
      keyword: params?.keyword,
      goodsList: state.goodsList,
    });
  }

  async clearInviteOrderItems(params = {}) {
    const uid = this._resolveInviteOrderUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const state = this._getInviteOrderSessionState(uid);
    state.selectedItems = [];
    if (!Array.isArray(state.goodsList) || !state.goodsList.length) {
      state.goodsList = await this._loadInviteOrderGoodsList(uid);
    }
    return this._buildInviteOrderSnapshot(uid, {
      keyword: params?.keyword,
      goodsList: state.goodsList,
    });
  }

  async submitInviteOrder(params = {}) {
    const uid = this._resolveInviteOrderUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const state = this._getInviteOrderSessionState(uid);
    const goodsList = Array.isArray(state.selectedItems)
      ? state.selectedItems
        .filter(item => item?.goodsId && item?.skuId)
        .map(item => ({
          skuId: Number(item.skuId),
          goodsId: Number(item.goodsId),
          goodsNumber: Number(item.goodsNumber || 1),
        }))
      : [];
    if (!goodsList.length) {
      throw new Error('请先选择至少一个商品');
    }
    const payload = await this._requestGoodsPageApi('/latitude/goods/sendSubstituteOrderCard', {
      goodsList,
      uid,
      note: '',
      couponAmount: 0,
      autoSendCoupon: true,
    }, 'POST');
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError);
    }
    state.selectedItems = [];
    return {
      success: true,
      source: 'api',
      message: '邀请下单已发送',
    };
  }

  async submitInviteFollow(params = {}) {
    const uid = this._resolveInviteOrderUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const payload = await this._requestGoodsPageApi('/latitude/message/sendFavMallCard', {
      uid,
    }, 'POST');
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message || '发送邀请关注失败');
    }
    return {
      success: true,
      source: 'api',
      uid,
      message: '邀请关注已发送',
    };
  }

  _parseOrderPriceYuanToFen(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.round(numeric * 100);
  }

  _getLatestOrderPriceUpdateTemplate(orderSn = '') {
    const normalizedOrderSn = String(orderSn || '').trim();
    const latestTrafficTemplate = this._findLatestTrafficEntry((entry) => {
      if (!String(entry?.url || '').includes('/latitude/order/price/update')) return false;
      if (!normalizedOrderSn) return true;
      const body = this._safeParseJson(entry?.requestBody);
      const targetOrderSn = String(body?.order_sn || body?.orderSn || '').trim();
      return targetOrderSn === normalizedOrderSn;
    }) || this._findLatestTraffic('/latitude/order/price/update');
    if (latestTrafficTemplate) {
      return latestTrafficTemplate;
    }
    const persistedTemplate = this._getOrderPriceUpdateTemplate();
    if (!persistedTemplate || typeof persistedTemplate !== 'object') {
      return null;
    }
    const persistedBody = this._safeParseJson(persistedTemplate?.requestBody);
    if (!persistedBody || typeof persistedBody !== 'object') {
      return null;
    }
    return {
      url: persistedTemplate.url || `${PDD_BASE}/latitude/order/price/update`,
      method: persistedTemplate.method || 'POST',
      requestBody: JSON.stringify(persistedBody),
    };
  }

  _rememberOrderPriceUpdateTemplate(entry = {}, options = {}) {
    if (!entry || typeof entry !== 'object') return null;
    const parsedBody = typeof entry.requestBody === 'string'
      ? this._safeParseJson(entry.requestBody)
      : entry.requestBody;
    if (!parsedBody || typeof parsedBody !== 'object') return null;
    const crawlerInfo = String(parsedBody?.crawlerInfo || parsedBody?.crawler_info || '').trim();
    if (!crawlerInfo) return null;
    const normalized = {
      url: entry.url || `${PDD_BASE}/latitude/order/price/update`,
      method: String(entry.method || 'POST').toUpperCase(),
      requestBody: JSON.stringify(parsedBody),
    };
    this._appendBootstrapTraffic({
      ...normalized,
      timestamp: Date.now(),
    });
    if (options.persist !== false && typeof this._setOrderPriceUpdateTemplate === 'function') {
      try {
        this._setOrderPriceUpdateTemplate({
          ...normalized,
          updatedAt: Date.now(),
        });
      } catch (error) {
        this._log('[API] 持久化改价模板失败', { message: error?.message || String(error || '') });
      }
    }
    return normalized;
  }

  _summarizeBootstrapDebug(debug = {}) {
    if (!debug || typeof debug !== 'object') return '';
    const buttonText = (Array.isArray(debug.buttons) ? debug.buttons : [])
      .map(item => String(item?.text || '').trim())
      .filter(Boolean)
      .slice(0, 5)
      .join('/');
    const cardActionText = (Array.isArray(debug.cardActions) ? debug.cardActions : [])
      .map(item => {
        const text = String(item?.text || '').trim();
        const score = Number(item?.score || 0) || 0;
        const tag = String(item?.tag || '').trim();
        const cls = String(item?.cls || '').trim().replace(/\s+/g, '.');
        const left = Number(item?.left || 0) || 0;
        const top = Number(item?.top || 0) || 0;
        const suffix = [tag, cls ? cls.slice(0, 24) : '', left && top ? `${left},${top}` : '']
          .filter(Boolean)
          .join('@');
        return text ? `${text}:${score}${suffix ? `:${suffix}` : ''}` : '';
      })
      .filter(Boolean)
      .slice(0, 5)
      .join('/');
    const inputText = (Array.isArray(debug.inputs) ? debug.inputs : [])
      .map(item => {
        const placeholder = String(item?.placeholder || '').trim();
        const value = String(item?.value || '').trim();
        return placeholder || value;
      })
      .filter(Boolean)
      .slice(0, 3)
      .join('/');
    const actionGroupText = (Array.isArray(debug.actionGroup) ? debug.actionGroup : [])
      .map(item => {
        const text = String(item?.text || '').trim();
        const tag = String(item?.tag || '').trim();
        const cls = String(item?.cls || '').trim().replace(/\s+/g, '.');
        return text ? `${text}:${tag}${cls ? `@${cls.slice(0, 18)}` : ''}` : '';
      })
      .filter(Boolean)
      .slice(0, 6)
      .join('/');
    const panelText = String(debug?.panelText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return [
      cardActionText ? `cardActions=${cardActionText}` : '',
      actionGroupText ? `actionGroup=${actionGroupText}` : '',
      buttonText ? `buttons=${buttonText}` : '',
      inputText ? `inputs=${inputText}` : '',
      panelText ? `panel=${panelText}` : '',
    ].filter(Boolean).join('; ');
  }

  async _bootstrapOrderPriceTemplate(params = {}, sessionMeta = {}) {
    if (typeof this._executeInPddPage !== 'function') {
      return { success: false, error: '当前环境不支持页面侧自动初始化改价模板' };
    }
    const target = {
      orderSn: String(params?.orderSn || params?.order_sn || '').trim(),
      customerName: String(sessionMeta?.customerName || sessionMeta?.raw?.nick || sessionMeta?.raw?.nickname || '').trim(),
      customerId: String(sessionMeta?.customerId || sessionMeta?.raw?.customer_id || sessionMeta?.raw?.buyer_id || '').trim(),
      discount: String(params?.discount ?? '').trim(),
      timeoutMs: 6000,
    };
    if (!target.orderSn) {
      return { success: false, error: '缺少订单编号' };
    }
    let result = null;
    try {
      result = await this._executeInPddPage(`
        (async () => {
          const target = ${JSON.stringify(target)};
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          const logs = [];
          const pushLog = (message) => logs.push(String(message || ''));
          const normalizeText = value => String(value || '').replace(/\\s+/g, ' ').trim();
          const isVisible = el => {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8 && el.offsetParent !== null;
          };
          const getText = el => normalizeText(el?.innerText || el?.textContent || '');
          const clickElement = async (el) => {
            if (!isVisible(el)) return false;
            try {
              el.scrollIntoView({ block: 'center', inline: 'center' });
            } catch {}
            ['mousedown', 'mouseup', 'click'].forEach(type => {
              try {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
              } catch {}
            });
            try { el.click(); } catch {}
            await sleep(280);
            return true;
          };
          const fillInputValue = (input, value) => {
            if (!input) return false;
            const nextValue = String(value || '');
            try { input.focus(); } catch {}
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, nextValue);
            else input.value = nextValue;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
            return true;
          };
          const findClickableByTexts = (root, texts = []) => {
            const candidates = Array.from((root || document).querySelectorAll('button, [role="button"], a, span, div'));
            return candidates.find(el => {
              if (!isVisible(el)) return false;
              const text = getText(el);
              if (!text || text.length > 80) return false;
              return texts.some(label => text === label || text.includes(label));
            }) || null;
          };
          const findBestActionByTexts = (root, texts = [], options = {}) => {
            const candidates = Array.from((root || document).querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                const text = getText(el);
                const classText = String(el.className || '').toLowerCase();
                let score = 0;
                if (!text || text.length > 80) return null;
                for (const label of texts) {
                  if (!label) continue;
                  if (text === label) score += 20;
                  else if (text.includes(label)) score += 10;
                }
                if (options.preferShortText && text.length <= 8) score += 5;
                if (options.rejectLongText && text.length > 16) score -= 12;
                if (options.preferRight && rect.left >= window.innerWidth * 0.55) score += 4;
                if (rect.width >= 24 && rect.width <= 260) score += 4;
                if (rect.height >= 18 && rect.height <= 72) score += 4;
                if (rect.width > 320 || rect.height > 120) score -= 12;
                if (classText.includes('active') || classText.includes('selected')) score += 2;
                if (classText.includes('disabled')) score -= 20;
                if (options.preferTop && rect.top <= window.innerHeight * 0.45) score += 3;
                if (options.preferBottom && rect.top >= window.innerHeight * 0.45) score += 3;
                return score > 0 ? { el, score } : null;
              })
              .filter(Boolean)
              .sort((a, b) => b.score - a.score);
            return candidates[0]?.el || null;
          };
          const isPriceEditorVisible = (root) => {
            const scope = root || document.body || document.documentElement;
            const text = getText(scope);
            const hitCount = [
              /手工改价/.test(text),
              /配送费用/.test(text),
              /仅可对订单进行一次改价操作/.test(text),
              /优惠折扣/.test(text),
              /保存/.test(text) && /取消/.test(text),
            ].filter(Boolean).length;
            return hitCount >= 2;
          };
          const findPendingTabTrigger = (panel) => (
            findBestActionByTexts(panel, ['待支付', '待付款', '店铺待支付', '店铺待支付订单'], {
              preferRight: true,
              preferTop: true,
              preferShortText: true,
              rejectLongText: true,
            }) || findClickableByTexts(panel, ['待支付', '待付款', '店铺待支付', '店铺待支付订单'])
          );
          const getCardActionCandidates = (orderCard) => {
            if (!orderCard) return null;
            const cardRect = orderCard.getBoundingClientRect();
            const rawCandidates = Array.from(orderCard.querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                const text = getText(el);
                const classText = String(el.className || '').toLowerCase();
                const roleText = String(el.getAttribute?.('role') || '').toLowerCase();
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const isNativeInteractive = ['button', 'a'].includes(String(el.tagName || '').toLowerCase()) || roleText === 'button';
                const looksInteractive = isNativeInteractive
                  || typeof el.onclick === 'function'
                  || Number(el.tabIndex) >= 0
                  || /button|btn|action|operate|click/.test(classText)
                  || style?.cursor === 'pointer';
                let score = 0;
                if (!looksInteractive) return null;
                if (rect.width < 18 || rect.height < 18) return null;
                if (rect.width > 120 || rect.height > 60) score -= 10;
                if (!text) score -= 2;
                if (/order-btn-item/.test(classText)) score += 12;
                if (/el-tooltip/.test(classText)) score += 4;
                if (rect.left >= cardRect.left + cardRect.width * 0.6) score += 8;
                if (rect.top >= cardRect.top + cardRect.height * 0.55) score += 8;
                if (text && text.length <= 8) score += 4;
                if (/改价|修改价格|手工改价/.test(text)) score += 20;
                if (/备注|物流|地址|复制|查看/.test(text)) score -= 10;
                if (/待支付|待付款|未支付/.test(text)) score -= 14;
                if (/订单号|下单时间|待支付说明|商家未启用服务或不满足服务规则/.test(text)) score -= 20;
                if (/配送费|优惠|折|实收|待支付金额/.test(text)) score -= 18;
                if (/^¥?\d+(?:\.\d+)?$/.test(text)) score -= 25;
                if (/^\d{2}:\d{2}:\d{2}$/.test(text)) score -= 20;
                return score > 0 ? {
                  el,
                  score,
                  text,
                  tag: String(el.tagName || '').toLowerCase(),
                  cls: classText,
                  left: Math.round(rect.left || 0),
                  top: Math.round(rect.top || 0),
                } : null;
              }).filter(Boolean);
            const groupedCandidates = [];
            for (const item of rawCandidates) {
              if (!/order-btn-item/.test(String(item?.cls || ''))) continue;
              const parent = item.el?.parentElement;
              if (!parent) continue;
              const siblings = Array.from(parent.children)
                .filter(el => el !== item.el && isVisible(el))
                .filter(el => /order-btn-item/.test(String(el.className || '').toLowerCase()))
                .map(el => {
                  const rect = el.getBoundingClientRect();
                  const text = getText(el);
                  const classText = String(el.className || '').toLowerCase();
                  let score = 10;
                  if (/改价|修改价格|手工改价/.test(text)) score += 20;
                  if (/待支付|待付款|未支付/.test(text)) score -= 14;
                  if (/备注|物流|地址|复制|查看/.test(text)) score -= 8;
                  if (!text) score -= 4;
                  return score > 0 ? {
                    el,
                    score,
                    text,
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: classText,
                    left: Math.round(rect.left || 0),
                    top: Math.round(rect.top || 0),
                  } : null;
                })
                .filter(Boolean);
              groupedCandidates.push(...siblings);
              const parentRect = parent.getBoundingClientRect();
              const rowNeighbors = Array.from((parent.parentElement || orderCard).querySelectorAll('button, [role="button"], a, span, div'))
                .filter(el => el !== item.el && el !== parent && isVisible(el))
                .map(el => {
                  const rect = el.getBoundingClientRect();
                  const text = getText(el);
                  const classText = String(el.className || '').toLowerCase();
                  const roleText = String(el.getAttribute?.('role') || '').toLowerCase();
                  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                  const looksInteractive = ['button', 'a'].includes(String(el.tagName || '').toLowerCase())
                    || roleText === 'button'
                    || typeof el.onclick === 'function'
                    || Number(el.tabIndex) >= 0
                    || /button|btn|action|operate|click|icon/.test(classText)
                    || style?.cursor === 'pointer';
                  let score = 0;
                  if (!looksInteractive) return null;
                  if (Math.abs(rect.top - parentRect.top) > 24) return null;
                  if (rect.left < cardRect.left + cardRect.width * 0.45) return null;
                  if (rect.width < 14 || rect.height < 14) return null;
                  if (rect.width > 80 || rect.height > 48) return null;
                  score += 10;
                  if (!text) score += 6;
                  if (text && text.length <= 6) score += 4;
                  if (/icon|svg|tooltip|btn/.test(classText)) score += 6;
                  if (/改价|修改价格|手工改价/.test(text)) score += 20;
                  if (/待支付|待付款|未支付/.test(text)) score -= 18;
                  if (/备注|物流|地址|复制|查看/.test(text)) score -= 10;
                  return score > 0 ? {
                    el,
                    score,
                    text,
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: classText,
                    left: Math.round(rect.left || 0),
                    top: Math.round(rect.top || 0),
                  } : null;
                })
                .filter(Boolean);
              groupedCandidates.push(...rowNeighbors);
            }
            const deduped = [];
            const seen = new Set();
            for (const item of [...groupedCandidates, ...rawCandidates]) {
              const key = String(item.left) + ':' + String(item.top) + ':' + String(item.text) + ':' + String(item.cls);
              if (seen.has(key)) continue;
              seen.add(key);
              deduped.push(item);
            }
            const candidates = deduped.sort((a, b) => b.score - a.score);
            return candidates;
          };
          const hoverOrderCard = async (orderCard) => {
            if (!isVisible(orderCard)) return false;
            const rect = orderCard.getBoundingClientRect();
            const points = [
              { x: rect.left + rect.width * 0.85, y: rect.top + rect.height * 0.78 },
              { x: rect.left + rect.width * 0.72, y: rect.top + rect.height * 0.78 },
            ];
            for (const point of points) {
              ['mouseenter', 'mouseover', 'mousemove'].forEach(type => {
                try {
                  orderCard.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: Math.round(point.x),
                    clientY: Math.round(point.y),
                  }));
                } catch {}
              });
              await sleep(120);
            }
            return true;
          };
          const probeOrderCardBody = async (orderCard) => {
            if (!isVisible(orderCard)) return false;
            const rect = orderCard.getBoundingClientRect();
            const clickableNodes = Array.from(orderCard.querySelectorAll('img, [class*="thumb"], [class*="title"], [class*="content"], [class*="main"], div, span'))
              .filter(isVisible)
              .map(el => {
                const nodeRect = el.getBoundingClientRect();
                const text = getText(el);
                let score = 0;
                if (nodeRect.width < 24 || nodeRect.height < 18) return null;
                if (nodeRect.width > rect.width * 0.92 || nodeRect.height > rect.height * 0.92) score -= 8;
                if (nodeRect.left <= rect.left + rect.width * 0.82) score += 6;
                if (nodeRect.top <= rect.top + rect.height * 0.82) score += 4;
                if (/thumb|title|content|main|goods|item/.test(String(el.className || '').toLowerCase())) score += 8;
                if (String(el.tagName || '').toLowerCase() === 'img') score += 10;
                if (text && text.length >= 2 && text.length <= 80) score += 2;
                if (/订单号|下单时间|待支付说明|备注|复制/.test(text)) score -= 10;
                return score > 0 ? { el, score } : null;
              })
              .filter(Boolean)
              .sort((a, b) => b.score - a.score)
              .slice(0, 4);
            const fallbackPoints = [
              { x: rect.left + rect.width * 0.3, y: rect.top + rect.height * 0.35 },
              { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.45 },
            ];
            for (const candidate of clickableNodes) {
              pushLog('probe-card-body');
              await clickElement(candidate.el);
              await sleep(320);
              if (isPriceEditorVisible(findRightPanel()) || findDiscountInput(findRightPanel()) || findDiscountInput(document.body)) {
                return true;
              }
            }
            for (const point of fallbackPoints) {
              ['mousedown', 'mouseup', 'click'].forEach(type => {
                try {
                  orderCard.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: Math.round(point.x),
                    clientY: Math.round(point.y),
                  }));
                } catch {}
              });
              await sleep(320);
              if (isPriceEditorVisible(findRightPanel()) || findDiscountInput(findRightPanel()) || findDiscountInput(document.body)) {
                return true;
              }
            }
            return false;
          };
          const findCardActionFallback = (orderCard) => {
            const candidates = getCardActionCandidates(orderCard);
            return candidates?.[0]?.el || null;
          };
          const findEditTrigger = (orderCard, panel) => (
            findBestActionByTexts(orderCard, ['改价', '修改价格', '手工改价'], {
              preferRight: true,
              preferBottom: true,
              preferShortText: true,
              rejectLongText: true,
            })
            || findBestActionByTexts(panel, ['改价', '修改价格', '手工改价'], {
              preferRight: true,
              preferBottom: true,
              preferShortText: true,
              rejectLongText: true,
            })
            || findClickableByTexts(orderCard, ['改价', '修改价格', '手工改价'])
            || findClickableByTexts(panel, ['改价', '修改价格', '手工改价'])
            || findCardActionFallback(orderCard)
          );
          const findRightSideClickableByTexts = (texts = []) => {
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                return {
                  el,
                  rect,
                  text: getText(el),
                };
              })
              .filter(item => item.text && item.text.length <= 80)
              .filter(item => texts.some(label => item.text === label || item.text.includes(label)))
              .filter(item => item.rect.left >= window.innerWidth * 0.58 && item.rect.width >= 24 && item.rect.height >= 20)
              .sort((a, b) => {
                const scoreA = a.rect.left + Math.min(a.rect.width, 240) - Math.abs(a.rect.top - window.innerHeight * 0.78);
                const scoreB = b.rect.left + Math.min(b.rect.width, 240) - Math.abs(b.rect.top - window.innerHeight * 0.78);
                return scoreB - scoreA;
              });
            return candidates[0]?.el || null;
          };
          const maybeClickConversation = async () => {
            const keywords = [target.orderSn, target.customerName, target.customerId].filter(Boolean);
            if (!keywords.length) return false;
            const nodes = Array.from(document.querySelectorAll('div, li, section, article, a, button'));
            const candidate = nodes.find(el => {
              if (!isVisible(el)) return false;
              const rect = el.getBoundingClientRect();
              if (rect.left > window.innerWidth * 0.42 || rect.width < 120 || rect.height < 28) return false;
              const text = getText(el);
              if (!text || text.length > 320) return false;
              return keywords.some(keyword => keyword && text.includes(keyword));
            });
            if (!candidate) return false;
            pushLog('click-conversation');
            await clickElement(candidate);
            await sleep(600);
            return true;
          };
          const findRightPanel = () => {
            const containers = Array.from(document.querySelectorAll(
              '.right-panel, .order-panel, .customer-info, [class*="right-panel"], [class*="orderInfo"], [class*="goodsInfo"], [class*="order-panel"], [class*="customer-info"], [class*="sidebar"]'
            )).filter(isVisible);
            return containers.sort((a, b) => {
              const rectA = a.getBoundingClientRect();
              const rectB = b.getBoundingClientRect();
              return (rectB.left + rectB.width) - (rectA.left + rectA.width);
            })[0] || null;
          };
          const findOrderCard = (root) => {
            const base = root || document;
            const baseRect = root?.getBoundingClientRect?.() || {
              left: 0,
              top: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            };
            const nodes = Array.from(base.querySelectorAll('div, li, section, article')).filter(isVisible);
            const candidates = nodes.map(el => {
              const text = getText(el);
              if (!text || text.length < 20 || text.length > 900) return null;
              if (!text.includes(target.orderSn)) return null;
              const rect = el.getBoundingClientRect();
              if (rect.width < 180 || rect.height < 60) return null;
              if (rect.width > Math.max(520, baseRect.width * 0.96)) return null;
              if (rect.height > Math.max(420, baseRect.height * 0.92)) return null;
              let score = 0;
              score += 20;
              if (rect.left >= window.innerWidth * 0.58) score += 8;
              if (rect.width >= 220 && rect.width <= 420) score += 8;
              if (rect.height >= 90 && rect.height <= 280) score += 8;
              if (/订单编号|下单时间|待支付|商家未启用服务或不满足服务规则/.test(text)) score += 6;
              if (/¥\d+(\.\d+)?/.test(text)) score += 4;
              if (/备注|改价|配送费|手工改价/.test(text)) score += 4;
              const area = rect.width * rect.height;
              score -= Math.round(area / 40000);
              return score > 0 ? { el, score, area, rect, text } : null;
            }).filter(Boolean);
            const narrowed = candidates.filter(candidate => !candidates.some(other => {
              if (!other || other === candidate) return false;
              if (other.area >= candidate.area) return false;
              if (!candidate.el.contains(other.el)) return false;
              if (!String(other.text || '').includes(target.orderSn)) return false;
              return other.area <= candidate.area * 0.88;
            })).sort((a, b) => {
              if (a.area !== b.area) return a.area - b.area;
              return b.score - a.score;
            });
            const ranked = (narrowed.length ? narrowed : candidates).sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return a.area - b.area;
            });
            return ranked[0]?.el || null;
          };
          const findDiscountInput = (root) => {
            const inputs = Array.from((root || document).querySelectorAll('input')).filter(el => isVisible(el) && !el.disabled && !el.readOnly);
            const scored = inputs.map(input => {
              const wrapperText = getText(input.parentElement) + ' ' + getText(input.closest('div, section, form, article'));
              const placeholderText = String(input.placeholder || '').trim();
              const valueText = String(input.value || '').trim();
              let score = 0;
              if (/查找|搜索|用户名|订单号|客户名|买家名|筛选/i.test(placeholderText + ' ' + wrapperText)) score -= 20;
              if (/折|折扣|discount/i.test(wrapperText)) score += 5;
              if (/实收|配送费用|手工改价|优惠|减价|改价/i.test(wrapperText)) score += 4;
              if (placeholderText.includes('折')) score += 4;
              if (/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(valueText)) score += 1;
              return { input, score };
            })
              .filter(item => item.score >= 4)
              .sort((a, b) => b.score - a.score);
            return scored[0]?.input || null;
          };
          const findSaveButtonNearInput = (input) => {
            let scope = input;
            for (let depth = 0; depth < 6 && scope; depth += 1) {
              const found = findClickableByTexts(scope, ['保存', '确认', '确定']);
              if (found) return found;
              scope = scope.parentElement;
            }
            return null;
          };
          const isCancelLikeButton = (el) => {
            const text = getText(el);
            if (/取消|关闭|返回|收起/.test(text)) return true;
            const classText = String(el?.className || '').toLowerCase();
            return /default|secondary|ghost/.test(classText);
          };
          const findPrimaryActionButton = (root, input) => {
            const inputRect = input?.getBoundingClientRect?.() || null;
            const candidates = Array.from((root || document).querySelectorAll('button, [role="button"], a'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                const text = getText(el);
                const classText = String(el.className || '').toLowerCase();
                let score = 0;
                if (/保存|确认|确定/.test(text)) score += 12;
                if (/primary|submit|confirm/.test(classText)) score += 8;
                if (/disabled/.test(classText) || el.disabled) score -= 20;
                if (isCancelLikeButton(el)) score -= 12;
                if (rect.left >= window.innerWidth * 0.58) score += 4;
                if (inputRect) {
                  const horizontalGap = Math.abs(rect.left - inputRect.left);
                  const verticalGap = Math.abs(rect.top - inputRect.bottom);
                  if (horizontalGap < 220) score += 5;
                  if (verticalGap < 220) score += 5;
                  if (rect.top >= inputRect.top - 40) score += 2;
                }
                return { el, rect, text, score };
              })
              .filter(item => item.score > 0)
              .sort((a, b) => b.score - a.score);
            return candidates[0]?.el || null;
          };
          const summarizeElement = (el) => {
            if (!el) return null;
            const rect = typeof el.getBoundingClientRect === 'function'
              ? el.getBoundingClientRect()
              : { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: String(el.tagName || '').toLowerCase(),
              text: getText(el).slice(0, 80),
              cls: String(el.className || '').slice(0, 120),
              left: Math.round(rect.left || 0),
              top: Math.round(rect.top || 0),
              width: Math.round(rect.width || 0),
              height: Math.round(rect.height || 0),
            };
          };
          const collectDebugSnapshot = (panel, input) => {
            const root = panel || document.body || document.documentElement;
            const panelText = getText(root).slice(0, 300);
            const visibleButtons = Array.from((root || document).querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .filter(el => {
                const text = getText(el);
                const rect = el.getBoundingClientRect();
                return text && text.length <= 40 && rect.width <= 260 && rect.height <= 80;
              })
              .map(el => summarizeElement(el))
              .filter(Boolean)
              .slice(0, 12);
            const card = findOrderCard(root);
            const cardActions = (getCardActionCandidates(card) || [])
              .slice(0, 6)
              .map(item => ({
                text: String(item?.text || '').slice(0, 40),
                score: item?.score || 0,
                tag: String(item?.tag || ''),
                cls: String(item?.cls || '').slice(0, 40),
                left: item?.left || 0,
                top: item?.top || 0,
              }));
            const anchorAction = (getCardActionCandidates(card) || []).find(item => /order-btn-item/.test(String(item?.cls || '')));
            const actionGroup = anchorAction?.el?.parentElement
              ? Array.from(anchorAction.el.parentElement.children)
                .filter(isVisible)
                .map(el => {
                  const rect = el.getBoundingClientRect();
                  return {
                    text: getText(el).slice(0, 40),
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: String(el.className || '').slice(0, 40),
                    left: Math.round(rect.left || 0),
                    top: Math.round(rect.top || 0),
                    width: Math.round(rect.width || 0),
                    height: Math.round(rect.height || 0),
                  };
                })
                .slice(0, 10)
              : [];
            const allInputs = Array.from(document.querySelectorAll('input'))
              .filter(isVisible)
              .map(el => {
                const summary = summarizeElement(el) || {};
                return {
                  ...summary,
                  value: String(el.value || '').slice(0, 40),
                  placeholder: String(el.placeholder || '').slice(0, 40),
                };
              })
              .slice(0, 8);
            return {
              panelText,
              activeElement: summarizeElement(document.activeElement),
              input: summarizeElement(input),
              buttons: visibleButtons,
              cardActions,
              actionGroup,
              inputs: allInputs,
            };
          };
          const tryProbeCardActions = async (orderCard, panel) => {
            const candidates = (getCardActionCandidates(orderCard) || []).slice(0, 4);
            for (const candidate of candidates) {
              if (!candidate?.el) continue;
              pushLog('probe-card-action:' + String(candidate.text || ''));
              await clickElement(candidate.el);
              await sleep(450);
              const latestPanel = findRightPanel() || panel;
              if (isPriceEditorVisible(latestPanel) || findDiscountInput(latestPanel) || findDiscountInput(document.body)) {
                return true;
              }
            }
            return false;
          };
          const createInterceptor = () => {
            let settled = false;
            let timer = 0;
            let resolvePromise = () => {};
            const cleanupTasks = [];
            const finalize = (payload) => {
              if (settled) return payload;
              settled = true;
              if (timer) clearTimeout(timer);
              cleanupTasks.reverse().forEach(task => {
                try { task(); } catch {}
              });
              resolvePromise(payload);
              return payload;
            };
            const promise = new Promise(resolve => {
              resolvePromise = resolve;
            });
            if (typeof window.fetch === 'function') {
              const originalFetch = window.fetch.bind(window);
              window.fetch = async function patchedFetch(input, init) {
                const requestUrl = typeof input === 'string' ? input : (input?.url || '');
                if (String(requestUrl || '').includes('/latitude/order/price/update')) {
                  const requestBody = typeof init?.body === 'string' ? init.body : '';
                  pushLog('capture-fetch');
                  finalize({
                    ok: true,
                    channel: 'fetch',
                    url: requestUrl,
                    method: String(init?.method || 'POST').toUpperCase(),
                    requestBody,
                    logs,
                  });
                  return new Response(JSON.stringify({ success: true, result: {} }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  });
                }
                return originalFetch(input, init);
              };
              cleanupTasks.push(() => { window.fetch = originalFetch; });
            }
            if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
              const proto = window.XMLHttpRequest.prototype;
              const originalOpen = proto.open;
              const originalSend = proto.send;
              proto.open = function patchedOpen(method, url) {
                this.__pddHelperUrl = url;
                this.__pddHelperMethod = method;
                return originalOpen.apply(this, arguments);
              };
              proto.send = function patchedSend(body) {
                if (String(this.__pddHelperUrl || '').includes('/latitude/order/price/update')) {
                  const requestBody = typeof body === 'string' ? body : '';
                  pushLog('capture-xhr');
                  try {
                    Object.defineProperty(this, 'readyState', { configurable: true, value: 4 });
                    Object.defineProperty(this, 'status', { configurable: true, value: 200 });
                    Object.defineProperty(this, 'statusText', { configurable: true, value: 'OK' });
                    Object.defineProperty(this, 'responseText', { configurable: true, value: '{"success":true,"result":{}}' });
                    Object.defineProperty(this, 'response', { configurable: true, value: '{"success":true,"result":{}}' });
                  } catch {}
                  setTimeout(() => {
                    try { this.onreadystatechange && this.onreadystatechange(new Event('readystatechange')); } catch {}
                    try { this.onload && this.onload(new Event('load')); } catch {}
                    try { this.dispatchEvent(new Event('readystatechange')); } catch {}
                    try { this.dispatchEvent(new Event('load')); } catch {}
                    try { this.dispatchEvent(new Event('loadend')); } catch {}
                  }, 0);
                  return finalize({
                    ok: true,
                    channel: 'xhr',
                    url: this.__pddHelperUrl,
                    method: String(this.__pddHelperMethod || 'POST').toUpperCase(),
                    requestBody,
                    logs,
                  });
                }
                return originalSend.apply(this, arguments);
              };
              cleanupTasks.push(() => {
                proto.open = originalOpen;
                proto.send = originalSend;
              });
            }
            timer = window.setTimeout(() => finalize({
              ok: false,
              error: 'capture-timeout',
              logs,
            }), Number(target.timeoutMs || 6000));
            return {
              promise,
              abort(error, extra = {}) {
                return finalize({
                  ok: false,
                  error,
                  logs,
                  ...extra,
                });
              },
            };
          };

          const interceptor = createInterceptor();
          try {
            await maybeClickConversation();
            let panel = findRightPanel();
            if (!panel) {
              await sleep(500);
              panel = findRightPanel();
            }
            if (!panel) return interceptor.abort('panel-not-found', {
              debug: collectDebugSnapshot(null, null),
            });
            const pendingTab = findPendingTabTrigger(panel);
            if (pendingTab) {
              pushLog('click-pending-tab');
              await clickElement(pendingTab);
              await sleep(700);
              panel = findRightPanel() || panel;
            }
            const orderCard = findOrderCard(panel) || findOrderCard(document.body);
            if (!orderCard) return interceptor.abort('order-card-not-found', {
              debug: collectDebugSnapshot(panel, null),
            });
            await hoverOrderCard(orderCard);
            await sleep(180);
            await probeOrderCardBody(orderCard);
            panel = findRightPanel() || panel;
            const editTrigger = findEditTrigger(orderCard, panel);
            if (editTrigger) {
              pushLog('click-edit-trigger');
              await clickElement(editTrigger);
              await sleep(700);
              panel = findRightPanel() || panel;
            }
            const editorVisible = isPriceEditorVisible(panel) || isPriceEditorVisible(document.body);
            if (!editorVisible && !findDiscountInput(panel) && !findDiscountInput(document.body)) {
              const probed = await tryProbeCardActions(orderCard, panel);
              if (probed) {
                panel = findRightPanel() || panel;
              }
            }
            if (!isPriceEditorVisible(panel) && !isPriceEditorVisible(document.body) && !findDiscountInput(panel) && !findDiscountInput(document.body)) {
              return interceptor.abort(editTrigger ? 'edit-mode-not-entered' : 'edit-trigger-not-found', {
                debug: collectDebugSnapshot(panel, null),
              });
            }
            if (!editTrigger && !findDiscountInput(panel) && !findDiscountInput(document.body)) {
              return interceptor.abort('edit-trigger-not-found', {
                debug: collectDebugSnapshot(panel, null),
              });
            }
            const discountInput = findDiscountInput(panel) || findDiscountInput(document.body);
            if (!discountInput) return interceptor.abort('discount-input-not-found', {
              debug: collectDebugSnapshot(panel, null),
            });
            fillInputValue(discountInput, target.discount || '9.9');
            await sleep(250);
            panel = findRightPanel() || panel;
            let saveButton = findSaveButtonNearInput(discountInput);
            if (!saveButton) {
              saveButton = findClickableByTexts(panel, ['保存', '确认', '确定'])
                || findPrimaryActionButton(panel, discountInput)
                || findRightSideClickableByTexts(['保存', '确认', '确定'])
                || findPrimaryActionButton(document.body, discountInput)
                || findClickableByTexts(document.body, ['保存', '确认', '确定']);
            }
            if (!saveButton) {
              await sleep(500);
              panel = findRightPanel() || panel;
              const refreshedDiscountInput = findDiscountInput(panel) || discountInput;
              saveButton = findSaveButtonNearInput(refreshedDiscountInput)
                || findClickableByTexts(panel, ['保存', '确认', '确定'])
                || findPrimaryActionButton(panel, refreshedDiscountInput)
                || findRightSideClickableByTexts(['保存', '确认', '确定'])
                || findPrimaryActionButton(document.body, refreshedDiscountInput)
                || findClickableByTexts(document.body, ['保存', '确认', '确定']);
            }
            if (!saveButton) return interceptor.abort('save-button-not-found', {
              debug: collectDebugSnapshot(panel, discountInput),
            });
            pushLog('click-save-button');
            await clickElement(saveButton);
            return await interceptor.promise;
          } catch (error) {
            return interceptor.abort(error?.message || String(error || 'bootstrap-failed'));
          }
        })()
      `, { source: 'order-price:template-bootstrap' });
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || '页面改价模板自动初始化失败'),
      };
    }
    const parsedBody = this._safeParseJson(result?.requestBody);
    const crawlerInfo = String(parsedBody?.crawlerInfo || parsedBody?.crawler_info || '').trim();
    if (!crawlerInfo) {
      const debugSummary = this._summarizeBootstrapDebug(result?.debug);
      this._log('[API] 页面侧自动初始化改价模板失败', {
        orderSn: target.orderSn,
        error: result?.error || 'missing-crawler-info',
        logs: Array.isArray(result?.logs) ? result.logs.slice(-8) : [],
        debug: result?.debug || null,
      });
      return {
        success: false,
        error: [
          result?.error || '未捕获到改价校验参数',
          debugSummary,
        ].filter(Boolean).join(' | '),
      };
    }
    const remembered = this._rememberOrderPriceUpdateTemplate({
      url: result?.url || `${PDD_BASE}/latitude/order/price/update`,
      method: result?.method || 'POST',
      requestBody: JSON.stringify(parsedBody),
    });
    this._log('[API] 页面侧自动初始化改价模板成功', {
      orderSn: target.orderSn,
      channel: result?.channel || '',
      persisted: !!remembered,
    });
    return {
      success: true,
      crawlerInfo,
      requestBody: parsedBody,
    };
  }

  async updateOrderPrice(params = {}) {
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const sessionMeta = this._normalizeSessionMeta(params.session || params.sessionId || {});
    const templateEntry = this._getLatestOrderPriceUpdateTemplate(normalizedOrderSn);
    const templateBody = this._safeParseJson(templateEntry?.requestBody) || {};
    const uid = Number(params?.uid || templateBody?.uid || this._getRefundOrderUid(sessionMeta) || 0);
    if (!Number.isFinite(uid) || uid <= 0) {
      throw new Error('缺少消费者 UID，请先在嵌入网页中打开对应会话后重试');
    }
    const discount = Number(params?.discount);
    if (!Number.isFinite(discount) || discount < 1 || discount > 10) {
      throw new Error('您仅可对订单进行一次改价操作，且优惠折扣不能低于1折');
    }
    const originalAmountFen = Number.isFinite(Number(params?.originalAmountFen))
      ? Math.max(0, Math.round(Number(params.originalAmountFen)))
      : this._parseOrderPriceYuanToFen(params?.originalAmount);
    if (!originalAmountFen) {
      throw new Error('缺少原始实收金额');
    }
    const shippingAmountFen = Number.isFinite(Number(params?.shippingAmountFen))
      ? Math.max(0, Math.round(Number(params.shippingAmountFen)))
      : this._parseOrderPriceYuanToFen(params?.shippingFee);
    const goodsReceiveFen = Math.max(0, Math.ceil(originalAmountFen * (discount / 10)));
    const goodsDiscountFen = Math.max(0, originalAmountFen - goodsReceiveFen);
    const receiveAmountFen = goodsReceiveFen + shippingAmountFen;
    const requestBody = {
      uid,
      order_sn: normalizedOrderSn,
      goodsDiscount: String(goodsDiscountFen),
      shippingDiscount: String(0),
      receiveAmount: String(receiveAmountFen),
      shippingAmount: shippingAmountFen,
      crawlerInfo: String(params?.crawlerInfo || templateBody?.crawlerInfo || templateBody?.crawler_info || '').trim(),
    };
    if (!requestBody.crawlerInfo) {
      const bootstrapResult = await this._bootstrapOrderPriceTemplate({
        ...params,
        orderSn: normalizedOrderSn,
      }, sessionMeta);
      const bootstrappedCrawlerInfo = String(
        bootstrapResult?.crawlerInfo
        || bootstrapResult?.requestBody?.crawlerInfo
        || bootstrapResult?.requestBody?.crawler_info
        || ''
      ).trim();
      if (bootstrappedCrawlerInfo) {
        requestBody.crawlerInfo = bootstrappedCrawlerInfo;
      } else {
        throw new Error(
          bootstrapResult?.error
            ? `缺少改价校验参数，且自动初始化失败：${bootstrapResult.error}`
            : '缺少改价校验参数，且自动初始化失败'
        );
      }
    }
    const payload = await this._requestRefundOrderPageApi('/latitude/order/price/update', requestBody);
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message || '改价失败');
    }
    let verifiedOrder = null;
    const normalizedTab = String(params?.tab || 'pending').trim() || 'pending';
    try {
      const latestOrders = await this._extractRefundOrdersFromPageApis(sessionMeta);
      verifiedOrder = (Array.isArray(latestOrders) ? latestOrders : []).find(item => {
        const currentOrderSn = String(item?.orderSn || item?.order_id || item?.order_sn || item?.orderId || '').trim();
        return currentOrderSn === normalizedOrderSn;
      }) || null;
    } catch (error) {
      this._log('[API] 改价后订单回读失败', {
        orderSn: normalizedOrderSn,
        message: error.message,
      });
    }
    return {
      success: true,
      orderSn: normalizedOrderSn,
      uid,
      discount,
      originalAmount: originalAmountFen / 100,
      discountAmount: goodsDiscountFen / 100,
      receiveAmount: receiveAmountFen / 100,
      shippingFee: shippingAmountFen / 100,
      verifiedOrder: this._cloneJson(verifiedOrder),
      verifiedCard: verifiedOrder ? this._normalizeSideOrderCard(verifiedOrder, {}, normalizedTab, 0) : null,
      response: payload,
    };
  }

  async _extractRefundOrdersFromPageApis(sessionMeta = {}, options = {}) {
    const eligibleOnly = options?.eligibleOnly !== false;
    const uid = this._getRefundOrderUid(sessionMeta);
    if (!uid) return null;
    const quantityPayload = await this._requestRefundOrderPageApi('/latitude/order/userOrderQuantity', { uid });
    const quantityResult = quantityPayload?.result || {};
    const totalCount = Number(quantityResult?.sum || 0) || 0;
    if (totalCount <= 0) {
      return [];
    }
    const orderPayload = await this._requestRefundOrderPageApi('/latitude/order/userAllOrder', {
      pageNo: 1,
      pageSize: Math.min(Math.max(totalCount, 10), 50),
      showHistory: true,
      uid,
    });
    const orders = Array.isArray(orderPayload?.result?.orders) ? orderPayload.result.orders : [];
    const normalizedOrders = await this._attachAfterSalesStatus(this._dedupeRefundOrders(orders, sessionMeta));
    const normalized = eligibleOnly
      ? this._filterEligibleRefundOrders(normalizedOrders)
      : normalizedOrders;
    if (normalized.length) {
      return normalized;
    }
    const unshippedCount = Number(quantityResult?.unshipped || 0) || 0;
    if (unshippedCount > 0) {
      const unshippedPayload = await this._requestRefundOrderPageApi('/latitude/order/userUnshippedOrder', {
        pageNo: 1,
        pageSize: Math.min(Math.max(unshippedCount, 10), 50),
        uid,
      });
      const unshippedOrders = Array.isArray(unshippedPayload?.result?.orders) ? unshippedPayload.result.orders : [];
      const normalizedUnshippedOrders = await this._attachAfterSalesStatus(this._dedupeRefundOrders(
          unshippedOrders.map(item => ({
            ...(item || {}),
            refund_shipping_state: 'unshipped',
          })),
          sessionMeta
        ));
      return eligibleOnly
        ? this._filterEligibleRefundOrders(normalizedUnshippedOrders)
        : normalizedUnshippedOrders;
    }
    return [];
  }

  async _extractAftersaleOrdersFromPageApis(sessionMeta = {}) {
    const uid = this._getRefundOrderUid(sessionMeta);
    if (!uid) return null;
    const orderPayload = await this._requestRefundOrderPageApi('/latitude/order/userRefundOrder', {
      pageNo: 1,
      pageSize: 50,
      uid,
    });
    const orders = Array.isArray(orderPayload?.result?.orders) ? orderPayload.result.orders : [];
    if (!orders.length) return [];
    return this._dedupeRefundOrders(orders, sessionMeta);
  }

  async _extractRefundOrdersFromDom(sessionMeta = {}) {
    if (typeof this._executeInPddPage !== 'function') return [];
    const target = {
      customerName: String(sessionMeta?.customerName || sessionMeta?.raw?.nick || sessionMeta?.raw?.nickname || '').trim(),
      orderId: String(sessionMeta?.orderId || '').trim(),
      customerId: String(sessionMeta?.customerId || sessionMeta?.raw?.customer_id || sessionMeta?.raw?.buyer_id || '').trim(),
    };
    const result = await this._executeInPddPage(`
      (async () => {
        const target = ${JSON.stringify(target)};
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const isVisible = el => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 20 && rect.height > 20 && el.offsetParent !== null;
        };
        const getText = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
        const maybeClickConversation = async () => {
          const keywords = [target.orderId, target.customerName, target.customerId].filter(Boolean);
          if (!keywords.length) return false;
          const nodes = Array.from(document.querySelectorAll('div, li, section, article, a, button'));
          const candidate = nodes.find(el => {
            if (!isVisible(el)) return false;
            const rect = el.getBoundingClientRect();
            if (rect.left > window.innerWidth * 0.45 || rect.width < 120 || rect.height < 28) return false;
            const text = getText(el);
            if (!text || text.length > 300) return false;
            return keywords.some(keyword => keyword && text.includes(keyword));
          });
          if (!candidate) return false;
          candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          candidate.click();
          candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          await sleep(500);
          return true;
        };
        await maybeClickConversation();
        const containers = Array.from(document.querySelectorAll(
          '.right-panel, .order-panel, .customer-info, [class*="right-panel"], [class*="orderInfo"], [class*="goodsInfo"], [class*="order-panel"], [class*="customer-info"]'
        )).filter(isVisible);
        const container = containers.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return (rectB.left + rectB.width) - (rectA.left + rectA.width);
        })[0] || document.body;
        const orderPattern = /订单号[:：]?\\s*([0-9-]{10,})/;
        const pricePattern = /¥\\s*\\d+(?:\\.\\d+)?/;
        const nodes = Array.from(container.querySelectorAll('div, li, section, article')).filter(isVisible);
        const items = [];
        const seen = new Set();
        nodes.forEach((node, index) => {
          const text = getText(node);
          if (!text || text.length > 800) return;
          const orderMatch = text.match(orderPattern);
          if (!orderMatch?.[1]) return;
          const orderId = orderMatch[1];
          if (seen.has(orderId)) return;
          const rect = node.getBoundingClientRect();
          if (rect.width < 160 || rect.height < 50) return;
          const titleEl = node.querySelector('[class*="title"], [class*="name"], strong, h3, h4, h5');
          const img = node.querySelector('img');
          const titleText = getText(titleEl) || (img?.getAttribute('alt') || '').trim();
          const priceMatch = text.match(pricePattern);
          const quantityMatch = text.match(/x\\s*\\d+/i);
          items.push({
            orderId,
            title: titleText || ('订单 ' + (index + 1)),
            imageUrl: img?.src || '',
            amountText: priceMatch?.[0] || '待确认',
            detailText: quantityMatch?.[0] || '消费者订单',
          });
          seen.add(orderId);
        });
        return items;
      })()
    `, { source: 'refund-orders:dom-extract' });
    return Array.isArray(result) ? result : [];
  }

  async _extractGoodsSpecFromChatPage(sessionMeta = {}, goodsMeta = {}) {
    if (typeof this._executeInPddPage !== 'function') return null;
    const target = {
      customerName: String(sessionMeta?.customerName || sessionMeta?.raw?.nick || sessionMeta?.raw?.nickname || '').trim(),
      customerId: String(sessionMeta?.customerId || sessionMeta?.raw?.customer_id || sessionMeta?.raw?.buyer_id || '').trim(),
      goodsId: this._normalizeGoodsId(goodsMeta?.goodsId || ''),
      goodsTitle: String(goodsMeta?.title || '').trim(),
    };
    if (!target.goodsId && !target.goodsTitle) return null;
    const result = await this._executeInPddPage(`
      (async () => {
        const target = ${JSON.stringify(target)};
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const normalizeText = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = el => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 8 && rect.height > 8 && el.offsetParent !== null;
        };
        const getText = el => normalizeText(el?.innerText || el?.textContent || '');
        const lowerIncludes = (text, keyword) => !!(text && keyword && text.toLowerCase().includes(keyword.toLowerCase()));
        const maybeClickConversation = async () => {
          const keywords = [target.customerName, target.customerId].filter(Boolean);
          if (!keywords.length) return false;
          const nodes = Array.from(document.querySelectorAll('div, li, section, article, a, button'));
          const candidate = nodes.find(el => {
            if (!isVisible(el)) return false;
            const rect = el.getBoundingClientRect();
            if (rect.left > window.innerWidth * 0.42 || rect.width < 120 || rect.height < 28) return false;
            const text = getText(el);
            if (!text || text.length > 300) return false;
            return keywords.some(keyword => text.includes(keyword));
          });
          if (!candidate) return false;
          candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          candidate.click();
          candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          await sleep(600);
          return true;
        };
        const findSpecTrigger = () => {
          const nodes = Array.from(document.querySelectorAll('button, span, div, a')).filter(isVisible);
          const triggers = nodes.filter(el => getText(el) === '查看商品规格');
          if (!triggers.length) return null;
          const scored = triggers.map(el => {
            let container = el;
            for (let i = 0; i < 6 && container?.parentElement; i += 1) {
              container = container.parentElement;
              const text = getText(container);
              if (!text) continue;
              if (target.goodsId && text.includes(target.goodsId)) {
                return { el, score: 100, text };
              }
              if (target.goodsTitle && lowerIncludes(text, target.goodsTitle.slice(0, 12))) {
                return { el, score: 80, text };
              }
            }
            return { el, score: 0, text: '' };
          }).sort((a, b) => b.score - a.score);
          return scored[0]?.el || null;
        };
        const readStat = (text, label) => {
          const match = String(text || '').match(new RegExp(label + '[:：]?\\\\s*([0-9]+)', 'i'));
          return match?.[1] || '';
        };
        const parseModal = () => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .ant-modal, .MDL_root, .PNK_modal, .dialog, .modal'))
            .filter(isVisible)
            .filter(el => getText(el).includes('商品规格'));
          const modal = dialogs[0];
          if (!modal) return null;
          const modalText = getText(modal);
          const goodsIdMatch = modalText.match(/商品ID[:：]?\\s*(\\d{6,})/);
          const titleEl = modal.querySelector('a, h1, h2, h3, h4, strong, [class*="title"], [class*="name"]');
          const imageEl = modal.querySelector('img');
          const rows = [];
          const rowNodes = Array.from(modal.querySelectorAll('tbody tr, table tr')).filter(isVisible);
          rowNodes.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td, th')).map(cell => getText(cell)).filter(Boolean);
            if (cells.length >= 4 && !cells.includes('规格') && !cells.includes('款式')) {
              rows.push({
                specLabel: cells[0] || '',
                styleLabel: cells[1] || '',
                priceText: cells[2] || '',
                stockText: cells[3] || '',
                salesText: cells[4] || '',
              });
            }
          });
          if (!rows.length) {
            const blocks = Array.from(modal.querySelectorAll('div, li')).filter(isVisible);
            blocks.forEach(node => {
              const text = getText(node);
              if (!text || text.length > 200) return;
              if (!(/[¥￥]\\s*\\d/.test(text) && /(库存|销量)/.test(text))) return;
              const segments = text.split(/\\s+/).filter(Boolean);
              rows.push({
                specLabel: segments[0] || '',
                styleLabel: segments[1] || '',
                priceText: segments.find(item => /[¥￥]/.test(item)) || '',
                stockText: readStat(text, '库存'),
                salesText: readStat(text, '销量'),
              });
            });
          }
          return {
            goodsId: goodsIdMatch?.[1] || target.goodsId,
            title: getText(titleEl) || target.goodsTitle,
            imageUrl: imageEl?.src || '',
            stockText: readStat(modalText, '库存'),
            salesText: readStat(modalText, '销量'),
            groupText: readStat(modalText, '待成团'),
            specItems: rows.filter(item => item.specLabel || item.styleLabel || item.priceText || item.stockText || item.salesText),
          };
        };
        await maybeClickConversation();
        const trigger = findSpecTrigger();
        if (!trigger) {
          return { error: 'SPEC_TRIGGER_NOT_FOUND' };
        }
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.click();
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        for (let i = 0; i < 8; i += 1) {
          await sleep(350);
          const parsed = parseModal();
          if (parsed?.specItems?.length) {
            return parsed;
          }
        }
        return parseModal() || { error: 'SPEC_MODAL_NOT_FOUND' };
      })()
    `, { source: 'goods-spec:dom-extract' });
    if (!result || typeof result !== 'object' || result.error) {
      this._log('[API] 聊天页规格提取失败', { goodsId: target.goodsId, reason: result?.error || 'EMPTY_RESULT' });
      return null;
    }
    return {
      goodsId: result.goodsId || target.goodsId,
      title: result.title || target.goodsTitle,
      imageUrl: result.imageUrl || '',
      groupText: result.groupText ? `${result.groupText}件待成团` : '',
      specItems: Array.isArray(result.specItems) ? result.specItems : [],
    };
  }

  async getRefundOrders(sessionRef) {
    const sessionMeta = this._normalizeSessionMeta(sessionRef);
    try {
      const pageOrders = await this._extractRefundOrdersFromPageApis(sessionMeta);
      if (Array.isArray(pageOrders)) {
        return this._filterEligibleRefundOrders(pageOrders);
      }
    } catch (error) {
      this._log('[API] 售后订单接口查询失败', { message: error.message });
    }
    try {
      const domOrders = await this._extractRefundOrdersFromDom(sessionMeta);
      const normalizedDomOrders = this._filterEligibleRefundOrders(this._dedupeRefundOrders(domOrders, sessionMeta));
      if (normalizedDomOrders.length) {
        return normalizedDomOrders;
      }
    } catch (error) {
      this._log('[API] 售后订单 DOM 提取失败', { message: error.message });
    }
    const bucket = [];
    const visited = new WeakSet();
    [
      sessionMeta?.goodsInfo,
      sessionMeta?.raw?.goods_info,
      sessionMeta?.raw?.goods,
      sessionMeta?.raw?.orders,
      sessionMeta?.raw?.order_list,
      sessionMeta?.raw?.orderList,
      sessionMeta?.raw?.order_info,
      sessionMeta?.raw?.orderInfo,
      sessionMeta?.raw,
    ].forEach(source => this._collectRefundOrderNodes(source, bucket, visited));
    let messages = [];
    try {
      messages = await this.getSessionMessages(sessionMeta, 1, 50);
    } catch (error) {
      this._log('[API] 售后订单消息回退失败', { message: error.message });
    }
    const merged = bucket
      .map((item, index) => this._normalizeRefundOrder(item, sessionMeta, index))
      .concat(this._extractRefundOrdersFromMessages(sessionMeta, messages))
      .concat(this._extractRefundOrdersFromTraffic(sessionMeta));
    return this._filterEligibleRefundOrders(this._dedupeRefundOrders(merged, sessionMeta));
  }

  _formatSideOrderDateTime(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const timestamp = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}`;
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
    return [
      item,
      item?.raw,
      item?.orderGoodsList,
      item?.order_goods_list,
      item?.goods_info,
      item?.goodsInfo,
      item?.goods,
      item?.order_info,
      item?.orderInfo,
      item?.afterSalesInfo,
      item?.after_sales_info,
      item?.compensate,
      item?.compensateInfo,
      item?.pendingCompensate,
      item?.raw?.afterSalesInfo,
      item?.raw?.after_sales_info,
      item?.raw?.compensate,
      item?.raw?.compensateInfo,
      item?.raw?.pendingCompensate,
      fallback?.goodsInfo,
      fallback?.raw?.goods_info,
      fallback?.raw?.goods,
      fallback?.raw,
      fallback,
    ].filter(Boolean);
  }

  _resolveSideOrderHeadline(tab = 'personal', sources = []) {
    const afterSalesStatus = this._pickDisplayAfterSalesStatus(sources);
    const orderStatusText = this._pickRefundText(sources, [
      'orderStatusStr',
      'order_status_str',
      'order_status_desc',
      'order_status_text',
      'statusDesc',
      'status_desc',
      'statusText',
      'status_text',
      'shippingStatusText',
      'shipping_status_text',
      'shippingStatus',
      'shipping_status',
    ]);
    const compensateText = this._pickRefundText(sources, [
      'pendingCompensateText',
      'pending_compensate_text',
      'detail',
      'text',
      'desc',
    ]);
    if (tab === 'aftersale') {
      return this._mergeSideOrderStatusTexts(orderStatusText, afterSalesStatus) || afterSalesStatus || orderStatusText || '售后处理中';
    }
    if (tab === 'pending') {
      return [orderStatusText, compensateText].filter(Boolean).join('，') || orderStatusText || '店铺待支付';
    }
    return this._mergeSideOrderStatusTexts(orderStatusText, afterSalesStatus) || orderStatusText || '订单状态待确认';
  }

  _isPendingLikeSideOrder(sources = []) {
    const mergedStatusText = [
      this._resolveSideOrderHeadline('personal', sources),
      this._pickRefundText(sources, [
        'orderStatusStr',
        'order_status_str',
        'order_status_desc',
        'order_status_text',
        'statusDesc',
        'status_desc',
        'statusText',
        'status_text',
        'shippingStatusText',
        'shipping_status_text',
        'payStatusDesc',
        'pay_status_desc',
        'payStatusText',
        'pay_status_text',
      ]),
    ].filter(Boolean).join(' ').replace(/\s+/g, '');
    return /(待支付|待付款|未支付|未付款|付款中|待成团|未成团)/.test(mergedStatusText);
  }

  _buildSideOrderMetaRows(tab = 'personal', sources = []) {
    const rows = [];
    const orderTimeText = this._formatSideOrderDateTime(this._pickRefundNumber(sources, ['orderTime', 'order_time', 'createdAt', 'created_at']));
    const afterSalesStatus = this._pickDisplayAfterSalesStatus(sources);
    const compensateText = this._pickRefundText(sources, [
      'pendingCompensateText',
      'pending_compensate_text',
      'detail',
      'text',
      'desc',
    ]);
    const refundShippingBenefitText = this._resolveRefundShippingBenefitText(sources);
    const shippingInfo = this._resolveRefundOrderShippingInfo(sources);
    const showRefundShippingAfterOrderTime = tab === 'personal' && refundShippingBenefitText;
    if (orderTimeText) {
      rows.push({ label: '下单时间', value: orderTimeText });
    }
    if (showRefundShippingAfterOrderTime) {
      rows.push({ label: '退货包运费', value: refundShippingBenefitText });
    }
    if (afterSalesStatus) {
      rows.push({ label: '售后状态', value: afterSalesStatus });
    }
    if (tab === 'pending' && compensateText) {
      rows.push({ label: '待支付说明', value: compensateText });
    } else if (!showRefundShippingAfterOrderTime && refundShippingBenefitText) {
      rows.push({ label: '退货包运费', value: refundShippingBenefitText });
    }
    if (shippingInfo.shippingStatusText) {
      rows.push({ label: '物流状态', value: shippingInfo.shippingStatusText });
    } else if (shippingInfo.trackingNo) {
      rows.push({ label: '物流单号', value: shippingInfo.trackingNo });
    }
    return rows.slice(0, 4);
  }

  _formatSideOrderAmount(value, { negative = false } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return '';
    return `${negative ? '-' : ''}¥${(numeric / 100).toFixed(2)}`;
  }

  _resolveSideOrderDiscountText(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of ['merchantDiscount', 'discountAmount', 'totalDiscount']) {
        if (source[key] === undefined || source[key] === null || source[key] === '') continue;
        const numeric = Number(source[key]);
        if (Number.isFinite(numeric) && numeric >= 0) {
          return this._formatSideOrderAmount(numeric, { negative: true });
        }
      }
    }
    return '-¥0.00';
  }

  _resolveSideOrderManualPriceInfo(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const manualDiscount = Number(
        source.manualDiscount
        ?? source.manual_discount
        ?? source.goodsDiscount
        ?? source.goods_discount
        ?? ''
      );
      const orderAmount = Number(
        source.orderAmount
        ?? source.order_amount
        ?? source.pay_amount
        ?? source.amount
        ?? ''
      );
      const shippingAmount = Number(
        source.shippingAmount
        ?? source.shipping_amount
        ?? 0
      );
      if (!Number.isFinite(manualDiscount) || manualDiscount <= 0) continue;
      if (!Number.isFinite(orderAmount) || orderAmount < 0) continue;
      const originalAmount = Math.max(0, orderAmount + manualDiscount);
      const discount = originalAmount > 0
        ? Number(((orderAmount / originalAmount) * 10).toFixed(2))
        : 0;
      return {
        applied: true,
        originalAmount,
        currentAmount: Math.max(0, orderAmount),
        discountAmount: Math.max(0, manualDiscount),
        shippingFee: Math.max(0, shippingAmount),
        discount,
      };
    }
    return {
      applied: false,
      originalAmount: 0,
      currentAmount: 0,
      discountAmount: 0,
      shippingFee: 0,
      discount: 0,
    };
  }

  _resolveSideOrderPendingCountdown(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const rawOrderTime = source.orderTime ?? source.order_time ?? source.createdAt ?? source.created_at;
      const numeric = Number(rawOrderTime);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      const orderTimeMs = numeric > 1e12 ? numeric : numeric * 1000;
      const countdownEndTime = orderTimeMs + 24 * 60 * 60 * 1000;
      const remainMs = Math.max(0, countdownEndTime - Date.now());
      const totalSeconds = Math.floor(remainMs / 1000);
      const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      return {
        countdownEndTime,
        countdownText: `${hours}:${minutes}:${seconds}`,
      };
    }
    return {
      countdownEndTime: 0,
      countdownText: '',
    };
  }

  _buildSideOrderSummaryRows(tab = 'personal', sources = [], amountText = '') {
    const rows = [];
    rows.push({
      label: '店铺优惠抵扣',
      value: this._resolveSideOrderDiscountText(sources),
      tone: 'muted',
    });
    if (amountText) {
      rows.push({
        label: tab === 'pending' ? '待支付金额' : '实收',
        value: amountText,
        tone: 'danger',
      });
    }
    return rows.slice(0, 2);
  }

  _shouldShowSideOrderAddressAction(tab = 'personal', sources = []) {
    if (tab !== 'personal') return false;
    const statusText = [
      this._resolveSideOrderHeadline(tab, sources),
      this._pickRefundText(sources, [
        'orderStatusStr',
        'order_status_str',
        'order_status_desc',
        'order_status_text',
        'statusDesc',
        'status_desc',
        'statusText',
        'status_text',
      ]),
    ].filter(Boolean).join(' ');
    return /待发货|已发货/.test(statusText);
  }

  _resolveSideOrderAddressInfo(sources = []) {
    const receiverName = this._pickRefundText(sources, [
      'receiverName',
      'receiver_name',
      'consignee',
      'consigneeName',
      'consignee_name',
      'userName',
      'user_name',
      'name',
    ]);
    const receiverPhone = this._pickRefundText(sources, [
      'receiverMobile',
      'receiver_mobile',
      'receiverPhone',
      'receiver_phone',
      'mobile',
      'phone',
      'tel',
      'telephone',
    ]);
    const areaParts = [
      this._pickRefundText(sources, ['provinceName', 'province_name']),
      this._pickRefundText(sources, ['cityName', 'city_name']),
      this._pickRefundText(sources, ['districtName', 'district_name']),
      this._pickRefundText(sources, ['townName', 'town_name']),
      this._pickRefundText(sources, ['streetName', 'street_name']),
    ].filter(Boolean);
    const areaText = areaParts.filter((part, index) => areaParts.indexOf(part) === index).join('');
    const detailText = this._pickRefundText(sources, [
      'address',
      'addressDetail',
      'address_detail',
      'detailAddress',
      'detail_address',
      'receiverAddress',
      'receiver_address',
    ]);
    const addressText = [areaText, detailText].filter(Boolean).join('');
    const fullText = [
      receiverName ? `收货人：${receiverName}` : '',
      receiverPhone ? `联系电话：${receiverPhone}` : '',
      addressText ? `收货地址：${addressText}` : '',
    ].filter(Boolean).join('\n');
    return {
      receiverName,
      receiverPhone,
      addressText,
      fullText,
    };
  }

  _buildSideOrderActionTags(tab = 'personal', sources = []) {
    const tags = [];
    if (tab === 'pending' || (tab === 'personal' && this._isPendingLikeSideOrder(sources))) {
      const manualPriceInfo = this._resolveSideOrderManualPriceInfo(sources);
      tags.push('备注');
      if (!manualPriceInfo.applied) {
        tags.push('改价');
      }
      return tags;
    }
    const shippingInfo = this._resolveRefundOrderShippingInfo(sources);
    const manualPriceInfo = this._resolveSideOrderManualPriceInfo(sources);
    if (this._shouldShowSideOrderAddressAction(tab, sources)) {
      tags.push('地址');
    }
    tags.push('备注');
    if (tab === 'personal') {
      tags.push('小额打款');
    }
    if (shippingInfo.isShipped || shippingInfo.trackingNo) {
      tags.push('物流信息');
    }
    if (this._pickRefundBoolean(sources, ['showGoodsInstructEntrance', 'show_goods_instruct_entrance'])) {
      tags.push('查看说明书');
    }
    if (this._pickRefundBoolean(sources, ['showExtraPackageTool', 'show_extra_package_tool'])) {
      tags.push('新增额外包裹');
    }
    const statusText = this._pickRefundText(sources, ['orderStatusStr', 'order_status_str']);
    if (!manualPriceInfo.applied && (tab === 'pending' || /待支付/.test(statusText))) {
      tags.push('改价');
    }
    return [...new Set(tags)].slice(0, 6);
  }

  _normalizeSideOrderCard(item = {}, fallback = {}, tab = 'personal', index = 0) {
    const sources = this._buildSideOrderSources(item, fallback);
    const manualPriceInfo = this._resolveSideOrderManualPriceInfo(sources);
    const addressInfo = this._resolveSideOrderAddressInfo(sources);
    const goodsInfo = Array.isArray(item?.orderGoodsList)
      ? (item.orderGoodsList[0] || {})
      : (item?.orderGoodsList || item?.goodsInfo || item?.goods_info || item?.raw?.orderGoodsList || {});
    const orderId = this._pickRefundText(sources, ['order_id', 'order_sn', 'orderSn', 'parent_order_sn', 'mall_order_sn', 'orderId'])
      || String(fallback?.orderId || '').trim();
    const title = this._pickRefundText(sources, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'item_title', 'itemTitle', 'title'])
      || fallback?.title
      || `订单 ${index + 1}`;
    const imageUrl = this._pickRefundText(sources, ['imageUrl', 'image_url', 'thumb_url', 'hd_thumb_url', 'goods_thumb_url', 'thumbUrl', 'hdThumbUrl', 'goodsThumbUrl', 'pic_url']);
    const amountText = this._normalizeRefundAmountByKeys(sources, ['order_amount', 'orderAmount', 'pay_amount', 'refund_amount', 'amount', 'order_price', 'price'])
      || this._pickRefundText(sources, ['priceText', 'price_text'])
      || this._normalizeGoodsPrice(this._pickRefundNumber(sources, ['goodsPrice', 'min_price', 'group_price']))
      || '';
    const quantityValue = this._pickRefundText(
      [goodsInfo, ...sources],
      ['goodsNumber', 'quantity', 'num', 'count', 'goods_count', 'buy_num', 'buyNum'],
    );
    const specText = this._pickRefundText(
      [goodsInfo, ...sources],
      ['spec', 'specText', 'spec_text', 'sku_spec', 'skuSpec', 'spec_desc', 'specDesc', 'sub_name', 'subName'],
    );
    const normalizedQuantity = String(quantityValue || '').replace(/^x/i, '').trim();
    const detailText = this._pickRefundText([item, goodsInfo, ...sources], ['detailText', 'detail_text']) || (normalizedQuantity && specText
      ? `${specText} x${normalizedQuantity}`
      : (specText || (normalizedQuantity ? `x${normalizedQuantity}` : '所拍规格待确认')));
    const pendingCountdown = tab === 'pending'
      ? this._resolveSideOrderPendingCountdown(sources)
      : { countdownEndTime: 0, countdownText: '' };
    const remarkNote = this._extractOrderRemarkText(this._pickRefundText(sources, ['note']));
    const remarkTag = this._normalizeOrderRemarkTag(this._pickRefundText(sources, ['tag']));
    const remarkTagName = this._pickRefundText(sources, ['tagName', 'tag_name']);
    const cachedRemark = this._getOrderRemarkCache(orderId);
    if (orderId && (remarkNote || remarkTag || remarkTagName)) {
      this._setOrderRemarkCache(orderId, {
        note: remarkNote,
        tag: remarkTag,
        tagName: remarkTagName,
      });
    }
    return {
      key: `${tab}::${orderId || 'order'}::${index}`,
      orderId: orderId || '-',
      title,
      imageUrl,
      detailText,
      amountText,
      headline: this._resolveSideOrderHeadline(tab, sources),
      receiverName: addressInfo.receiverName,
      receiverPhone: addressInfo.receiverPhone,
      addressText: addressInfo.addressText,
      addressFullText: addressInfo.fullText,
      countdownEndTime: pendingCountdown.countdownEndTime,
      countdownText: pendingCountdown.countdownText,
      metaRows: this._buildSideOrderMetaRows(tab, sources),
      summaryRows: this._buildSideOrderSummaryRows(tab, sources, amountText),
      note: remarkNote || cachedRemark?.note || '',
      noteTag: remarkTag || cachedRemark?.tag || '',
      noteTagName: remarkTagName || cachedRemark?.tagName || '',
      actionTags: this._buildSideOrderActionTags(tab, sources),
      manualPriceApplied: manualPriceInfo.applied,
      manualPriceOriginalAmount: manualPriceInfo.originalAmount / 100,
      manualPriceDiscount: manualPriceInfo.discount,
      manualPriceDiscountAmount: manualPriceInfo.discountAmount / 100,
      manualPriceShippingFee: manualPriceInfo.shippingFee / 100,
    };
  }

  async _extractPendingOrdersFromPageApis(sessionMeta = {}) {
    const uid = this._getRefundOrderUid(sessionMeta);
    if (!uid) return null;
    const pendingPayload = await this._requestRefundOrderPageApi('/latitude/order/userUnfinishedOrder', {
      pageNo: 1,
      pageSize: 50,
      uid,
    });
    const pendingOrders = Array.isArray(pendingPayload?.result?.orders) ? pendingPayload.result.orders : [];
    if (!pendingOrders.length) return [];
    const compensateMap = {};
    const validOrderSns = [...new Set(pendingOrders.map(item => String(item?.orderSn || item?.orderId || '').trim()).filter(Boolean))].slice(0, 20);
    await Promise.all(validOrderSns.map(async orderSn => {
      try {
        const payload = await this._requestRefundOrderPageApi('/latitude/order/orderCompensate', { orderSn });
        const compensatePatch = this._buildSideOrderCompensatePatch(payload?.result || {});
        if (Object.keys(compensatePatch).length) {
          compensateMap[orderSn] = compensatePatch;
        }
      } catch (error) {
        this._log('[API] 店铺待支付补充查询失败', { orderSn, message: error.message });
      }
    }));
    return this._dedupeRefundOrders(pendingOrders.map(item => {
      const orderSn = String(item?.orderSn || item?.orderId || '').trim();
      return {
        ...(item || {}),
        ...(compensateMap[orderSn] || {}),
      };
    }), sessionMeta);
  }

  _getOrderTrafficEntries(urlPart = '', sessionMeta = {}) {
    const uid = this._getRefundOrderUid(sessionMeta);
    return this._getApiTrafficEntries()
      .filter(entry => String(entry?.url || '').includes(urlPart))
      .filter(entry => {
        if (!uid) return true;
        const body = typeof entry?.requestBody === 'string' ? this._safeParseJson(entry.requestBody) : entry?.requestBody;
        const requestUid = String(body?.uid || body?.data?.uid || '').trim();
        return !requestUid || requestUid === uid;
      });
  }

  _buildSideOrderCompensatePatch(result = {}) {
    if (!result || typeof result !== 'object') return {};
    const text = this._pickRefundText([result], ['detail', 'text', 'desc']);
    const statusKeys = ['status', 'compensateStatus', 'compensate_status'];
    const hasStatusKey = statusKeys.some(key => Object.prototype.hasOwnProperty.call(result, key));
    const status = result.status ?? result.compensateStatus ?? result.compensate_status;
    const compensate = {};
    if (hasStatusKey) {
      compensate.status = status ?? null;
    } else if (status !== undefined && status !== null && status !== '') {
      compensate.status = status;
    }
    if (text) {
      compensate.text = text;
    }
    if (!Object.keys(compensate).length) return {};
    return {
      pendingCompensateText: text || '',
      pendingCompensate: { ...compensate },
      compensate,
    };
  }

  _mergeSideOrderCompensatePatch(order = {}, patch = {}) {
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
      return order;
    }
    const existingCompensate = order?.compensate && typeof order.compensate === 'object'
      ? order.compensate
      : null;
    const existingPendingCompensate = order?.pendingCompensate && typeof order.pendingCompensate === 'object'
      ? order.pendingCompensate
      : null;
    const mergedCompensate = (patch.compensate && typeof patch.compensate === 'object') || existingCompensate
      ? {
          ...(patch.compensate && typeof patch.compensate === 'object' ? patch.compensate : {}),
          ...(existingCompensate || {}),
        }
      : undefined;
    const mergedPendingCompensate = (patch.pendingCompensate && typeof patch.pendingCompensate === 'object') || existingPendingCompensate
      ? {
          ...(patch.pendingCompensate && typeof patch.pendingCompensate === 'object' ? patch.pendingCompensate : {}),
          ...(existingPendingCompensate || {}),
        }
      : undefined;
    return {
      ...(order || {}),
      ...(patch || {}),
      pendingCompensateText: order?.pendingCompensateText || patch.pendingCompensateText || '',
      ...(mergedPendingCompensate ? { pendingCompensate: mergedPendingCompensate } : {}),
      ...(mergedCompensate ? { compensate: mergedCompensate } : {}),
    };
  }

  _extractOrderCompensateMapFromTraffic(sessionMeta = {}) {
    const compensateEntries = this._getOrderTrafficEntries('/latitude/order/orderCompensate', sessionMeta);
    const compensateMap = {};
    for (let i = compensateEntries.length - 1; i >= 0; i -= 1) {
      const requestBody = typeof compensateEntries[i]?.requestBody === 'string'
        ? this._safeParseJson(compensateEntries[i].requestBody)
        : compensateEntries[i]?.requestBody;
      const responseBody = compensateEntries[i]?.responseBody && typeof compensateEntries[i].responseBody === 'object'
        ? compensateEntries[i].responseBody
        : this._safeParseJson(compensateEntries[i]?.responseBody);
      const orderSn = String(requestBody?.orderSn || '').trim();
      const compensatePatch = this._buildSideOrderCompensatePatch(responseBody?.result || {});
      if (orderSn && Object.keys(compensatePatch).length && !compensateMap[orderSn]) {
        compensateMap[orderSn] = compensatePatch;
      }
    }
    return compensateMap;
  }

  _attachOrderCompensateFromTraffic(orders = [], sessionMeta = {}) {
    const list = Array.isArray(orders) ? orders : [];
    if (!list.length) return list;
    const compensateMap = this._extractOrderCompensateMapFromTraffic(sessionMeta);
    if (!Object.keys(compensateMap).length) return list;
    return list.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || order?.order_sn || '').trim();
      if (!orderSn || !compensateMap[orderSn]) return order;
      return this._mergeSideOrderCompensatePatch(order, compensateMap[orderSn]);
    });
  }

  _hasAfterSalesContext(sources = []) {
    if (this._pickDisplayAfterSalesStatus(sources)) return true;
    const afterSalesId = this._pickRefundText(sources, [
      'afterSalesSn',
      'after_sales_sn',
      'refundSn',
      'refund_sn',
      'refundId',
      'refund_id',
      'aftersaleId',
      'aftersale_id',
      'id',
    ]);
    return !!afterSalesId;
  }

  _extractAfterSalesStatusMapFromTraffic(orderSns = [], sessionMeta = {}) {
    const validOrderSns = [...new Set((Array.isArray(orderSns) ? orderSns : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!validOrderSns.length) return {};
    const targetSet = new Set(validOrderSns);
    const detailMap = {};
    const entries = this._getOrderTrafficEntries('/mercury/chat/afterSales/queryList', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : this._safeParseJson(entries[i]?.responseBody);
      const currentMap = this._extractAfterSalesDetailMapFromPayload(responseBody);
      Object.entries(currentMap).forEach(([orderSn, detail]) => {
        if (!targetSet.has(String(orderSn)) || detailMap[String(orderSn)]) return;
        detailMap[String(orderSn)] = detail;
      });
      if (validOrderSns.every(orderSn => detailMap[orderSn])) break;
    }
    return detailMap;
  }

  _attachAfterSalesStatusFromTraffic(orders = [], sessionMeta = {}) {
    const orderSns = orders.map(item => String(item?.orderId || item?.orderSn || '').trim()).filter(Boolean);
    if (!orderSns.length) return orders;
    const detailMap = this._extractAfterSalesStatusMapFromTraffic(orderSns, sessionMeta);
    return orders.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || '').trim();
      const detail = detailMap[orderSn] && typeof detailMap[orderSn] === 'object'
        ? detailMap[orderSn]
        : {};
      return {
        ...order,
        ...detail,
        afterSalesStatus: order?.afterSalesStatus || detail.afterSalesStatus || '',
      };
    });
  }

  _extractPersonalOrdersFromTraffic(sessionMeta = {}) {
    const entries = this._getOrderTrafficEntries('/latitude/order/userAllOrder', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : this._safeParseJson(entries[i]?.responseBody);
      const orders = Array.isArray(responseBody?.result?.orders) ? responseBody.result.orders : [];
      if (!orders.length) continue;
      return this._attachOrderCompensateFromTraffic(
        this._attachAfterSalesStatusFromTraffic(this._dedupeRefundOrders(orders, sessionMeta), sessionMeta),
        sessionMeta,
      );
    }
    return [];
  }

  _extractAftersaleOrdersFromTraffic(sessionMeta = {}) {
    const entries = this._getOrderTrafficEntries('/latitude/order/userRefundOrder', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : this._safeParseJson(entries[i]?.responseBody);
      const orders = Array.isArray(responseBody?.result?.orders) ? responseBody.result.orders : [];
      if (!orders.length) continue;
      return this._attachOrderCompensateFromTraffic(this._dedupeRefundOrders(orders, sessionMeta), sessionMeta);
    }
    return [];
  }

  _extractPendingOrdersFromTraffic(sessionMeta = {}) {
    const entries = this._getOrderTrafficEntries('/latitude/order/userUnfinishedOrder', sessionMeta);
    let pendingOrders = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : this._safeParseJson(entries[i]?.responseBody);
      const orders = Array.isArray(responseBody?.result?.orders) ? responseBody.result.orders : [];
      if (!orders.length) continue;
      pendingOrders = orders;
      break;
    }
    if (!pendingOrders.length) return [];
    return this._attachOrderCompensateFromTraffic(this._dedupeRefundOrders(pendingOrders, sessionMeta), sessionMeta);
  }

  async getSideOrders(sessionRef, tab = 'personal') {
    const sessionMeta = this._normalizeSessionMeta(sessionRef);
    const normalizedTab = ['personal', 'aftersale', 'pending'].includes(String(tab || ''))
      ? String(tab)
      : 'personal';
    if (normalizedTab === 'pending') {
      let pendingOrders = [];
      try {
        const pagePendingOrders = await this._extractPendingOrdersFromPageApis(sessionMeta);
        if (Array.isArray(pagePendingOrders)) {
          pendingOrders = pagePendingOrders;
        }
      } catch (error) {
        this._log('[API] 侧栏待支付接口查询失败', { message: error.message });
      }
      if (!pendingOrders.length) {
        pendingOrders = this._extractPendingOrdersFromTraffic(sessionMeta);
      }
      if (!Array.isArray(pendingOrders) || !pendingOrders.length) return [];
      return this._attachOrderCompensateFromTraffic(pendingOrders, sessionMeta)
        .map((item, index) => this._normalizeSideOrderCard(item, sessionMeta, normalizedTab, index));
    }
    if (normalizedTab === 'aftersale') {
      let aftersaleOrders = [];
      try {
        const pageOrders = await this._extractAftersaleOrdersFromPageApis(sessionMeta);
        if (Array.isArray(pageOrders)) {
          aftersaleOrders = pageOrders;
        }
      } catch (error) {
        this._log('[API] 侧栏售后订单接口查询失败', { message: error.message });
      }
      if (!aftersaleOrders.length) {
        aftersaleOrders = this._extractAftersaleOrdersFromTraffic(sessionMeta);
      }
      if (!aftersaleOrders.length) {
        try {
          const fallbackOrders = await this._extractRefundOrdersFromPageApis(sessionMeta, {
            eligibleOnly: false,
          });
          if (Array.isArray(fallbackOrders)) {
            aftersaleOrders = fallbackOrders;
          }
        } catch (error) {
          this._log('[API] 侧栏售后订单回退失败', { message: error.message });
        }
      }
      aftersaleOrders = this._attachOrderCompensateFromTraffic(aftersaleOrders, sessionMeta);
      return aftersaleOrders
        .filter(item => this._hasAfterSalesContext(this._buildSideOrderSources(item, sessionMeta)))
        .map((item, index) => this._normalizeSideOrderCard(item, sessionMeta, normalizedTab, index));
    }
    let orders = [];
    try {
      const pageOrders = await this._extractRefundOrdersFromPageApis(sessionMeta, {
        eligibleOnly: false,
      });
      if (Array.isArray(pageOrders)) {
        orders = pageOrders;
      }
    } catch (error) {
      this._log('[API] 侧栏订单接口查询失败', { tab: normalizedTab, message: error.message });
    }
    if (!orders.length) {
      orders = this._extractPersonalOrdersFromTraffic(sessionMeta);
    }
    if (!orders.length) {
      try {
        orders = await this.getRefundOrders(sessionMeta);
      } catch (error) {
        this._log('[API] 侧栏订单回退失败', { tab: normalizedTab, message: error.message });
      }
    }
    orders = this._attachOrderCompensateFromTraffic(orders, sessionMeta);
    const filtered = normalizedTab === 'aftersale'
      ? orders.filter(item => this._hasAfterSalesContext(this._buildSideOrderSources(item, sessionMeta)))
      : orders;
    return filtered.map((item, index) => this._normalizeSideOrderCard(item, sessionMeta, normalizedTab, index));
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
    const inputUrl = String(params.url || '').trim();
    const explicitGoodsId = this._normalizeGoodsId(params.goodsId || params?.fallback?.goodsId || '');
    const extractedGoodsId = this._normalizeGoodsId(this._extractGoodsIdFromUrl(inputUrl));
    const normalizedGoodsId = explicitGoodsId || extractedGoodsId;
    const sessionMeta = this._normalizeSessionMeta(params.session || params.sessionId || {});
    const rawUrl = normalizedGoodsId
      ? `https://mobile.yangkeduo.com/goods.html?goods_id=${normalizedGoodsId}`
      : inputUrl;
    let url = '';
    try {
      url = rawUrl ? new URL(rawUrl).toString() : '';
    } catch {
      url = normalizedGoodsId ? `https://mobile.yangkeduo.com/goods.html?goods_id=${normalizedGoodsId}` : '';
    }
    if (!url) {
      throw new Error('缺少商品链接');
    }
    const fallback = params?.fallback && typeof params.fallback === 'object'
      ? this._cloneJson(params.fallback)
      : {};
    const headers = await this._buildHeaders({
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'content-type': 'text/html;charset=UTF-8',
      Referer: url,
      Origin: 'https://mobile.yangkeduo.com',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'upgrade-insecure-requests': '1',
    });
    delete headers['X-PDD-Token'];
    delete headers['windows-app-shop-token'];
    delete headers.VerifyAuthToken;
    delete headers.etag;
    const fallbackForParse = {
      ...fallback,
      goodsId: fallback.goodsId || normalizedGoodsId || this._extractGoodsIdFromUrl(url),
      specText: fallback.specText || '查看商品规格',
    };
    if (normalizedGoodsId) {
      try {
        const [goodsPayload, skuPayload] = await Promise.all([
          this._requestGoodsPageApi('/latitude/goods/queryGoods', {
            pageNo: 1,
            pageSize: 1,
            goodsId: Number(normalizedGoodsId),
          }, 'POST'),
          this._requestGoodsPageApi(`/latitude/goods/skuList?pageNo=1&pageSize=30&goodsId=${encodeURIComponent(normalizedGoodsId)}`, null, 'GET'),
        ]);
        const goodsError = this._normalizeBusinessError(goodsPayload);
        const skuError = this._normalizeBusinessError(skuPayload);
        if (!goodsError && !skuError) {
          const pageCard = this._buildGoodsCardFromPageApis(goodsPayload, skuPayload, fallbackForParse);
          if (pageCard.specItems?.length || this._hasMeaningfulGoodsCardData(pageCard, fallbackForParse)) {
            return {
              goodsId: pageCard.goodsId || fallback.goodsId || normalizedGoodsId,
              url,
              title: pageCard.title || fallback.title || '拼多多商品',
              imageUrl: pageCard.imageUrl || fallback.imageUrl || '',
              priceText: pageCard.priceText || fallback.priceText || '',
              groupText: pageCard.groupText || fallback.groupText || '2人团',
              specText: pageCard.specText || fallback.specText || '查看商品规格',
              specItems: Array.isArray(pageCard.specItems) ? pageCard.specItems : [],
              stockText: pageCard.stockText || '',
              salesText: pageCard.salesText || '',
              pendingGroupText: pageCard.pendingGroupText || '',
            };
          }
        }
      } catch (error) {
        this._log('[API] 商品规格页接口失败', { goodsId: normalizedGoodsId, message: error.message });
      }
    }
    let response = null;
    let html = '';
    let fetchError = null;
    try {
      response = await this._getSession().fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
      });
      html = await response.text();
    } catch (error) {
      fetchError = error;
      this._log('[API] 商品卡片直连失败', { url, message: error.message });
    }
    let parsed = this._extractGoodsCardFromHtml(html, fallbackForParse);
    if (fetchError || !this._hasMeaningfulGoodsCardData(parsed, fallbackForParse) || this._isGoodsLoginPageHtml(html)) {
      try {
        const pageResult = await this._loadGoodsHtmlInWindow(url);
        if (pageResult?.html) {
          html = String(pageResult.html || '');
          parsed = this._extractGoodsCardFromHtml(html, fallbackForParse);
        }
      } catch (error) {
        this._log('[API] 商品卡片窗口兜底失败', { url, message: error.message });
      }
    }
    if (!parsed.specItems?.length) {
      try {
        const pageSpec = await this._extractGoodsSpecFromChatPage(sessionMeta, {
          goodsId: normalizedGoodsId || fallbackForParse.goodsId,
          title: fallback.title || parsed.title || '',
        });
        if (pageSpec?.specItems?.length) {
          parsed = {
            ...parsed,
            goodsId: parsed.goodsId || pageSpec.goodsId || normalizedGoodsId,
            title: parsed.title || pageSpec.title || fallback.title || '拼多多商品',
            imageUrl: parsed.imageUrl || pageSpec.imageUrl || fallback.imageUrl || '',
            specItems: pageSpec.specItems,
          };
        }
      } catch (error) {
        this._log('[API] 聊天页规格提取异常', { goodsId: normalizedGoodsId || fallbackForParse.goodsId, message: error.message });
      }
    }
    if (!this._hasMeaningfulGoodsCardData(parsed, fallbackForParse) && !parsed.specItems?.length) {
      if (fetchError) {
        this._log('[API] 商品卡片回退占位', { url, message: fetchError.message });
      } else if (response && !response.ok) {
        this._log('[API] 商品卡片 HTTP 占位', { url, status: response.status });
      }
      return {
        goodsId: fallback.goodsId || normalizedGoodsId || this._extractGoodsIdFromUrl(url),
        url,
        title: fallback.title || '拼多多商品',
        imageUrl: fallback.imageUrl || '',
        priceText: fallback.priceText || '',
        groupText: fallback.groupText || '2人团',
        specText: fallback.specText || '查看商品规格',
        specItems: Array.isArray(fallback.specItems) ? fallback.specItems : [],
        stockText: String(fallback.stockText || ''),
        salesText: String(fallback.salesText || ''),
        pendingGroupText: String(fallback.pendingGroupText || ''),
      };
    }
    if (response && !response.ok && !parsed.title && !parsed.imageUrl) {
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      goodsId: parsed.goodsId || fallback.goodsId || normalizedGoodsId || this._extractGoodsIdFromUrl(url),
      url,
      title: parsed.title || fallback.title || '拼多多商品',
      imageUrl: parsed.imageUrl || fallback.imageUrl || '',
      priceText: parsed.priceText || fallback.priceText || '',
      groupText: parsed.groupText || fallback.groupText || '2人团',
      specText: parsed.specText || fallback.specText || '查看商品规格',
      specItems: Array.isArray(parsed.specItems) ? parsed.specItems : [],
      stockText: String(parsed.stockText || fallback.stockText || ''),
      salesText: String(parsed.salesText || fallback.salesText || ''),
      pendingGroupText: String(parsed.pendingGroupText || fallback.pendingGroupText || ''),
    };
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
