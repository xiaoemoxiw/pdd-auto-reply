const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');
const { NetworkMonitor } = require('./network-monitor');

const PDD_BASE = 'https://mms.pinduoduo.com';
const PDD_UPLOAD_BASES = [
  'https://galerie-api.pdd.net',
  'https://galerie-api.htj.pdd.net',
  'https://mms-static-1.pddugc.com',
];
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;
const POLL_INTERVAL = 5000;
const POLL_INTERVAL_IDLE = 15000;
const ORDER_REMARK_TAG_LABELS = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  BLUE: '蓝色',
  PURPLE: '紫色',
};

class PddApiClient extends EventEmitter {
  constructor(shopId, options = {}) {
    super();
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
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
    if (!text || typeof text !== 'string') return null;
    const source = String(text).trim();
    if (!source) return null;
    try {
      return JSON.parse(source);
    } catch {
      if (!source.includes('=') || source.startsWith('<')) {
        return null;
      }
      try {
        const params = new URLSearchParams(source);
        const result = {};
        let hasEntry = false;
        for (const [key, rawValue] of params.entries()) {
          hasEntry = true;
          const value = String(rawValue || '').trim();
          let parsedValue = value;
          if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
            try {
              parsedValue = JSON.parse(value);
            } catch {}
          }
          if (Object.prototype.hasOwnProperty.call(result, key)) {
            if (Array.isArray(result[key])) {
              result[key].push(parsedValue);
            } else {
              result[key] = [result[key], parsedValue];
            }
          } else {
            result[key] = parsedValue;
          }
        }
        return hasEntry ? result : null;
      } catch {
        return null;
      }
    }
  }

  _cloneJson(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
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
    if (!value || typeof value !== 'object' || depth > 3) return [];
    const result = [];
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      result.push(path);
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        result.push(...this._collectObjectKeyPaths(child, path, depth + 1));
      }
    }
    return result;
  }

  _readObjectPath(value, path) {
    if (!value || typeof value !== 'object' || !path) return undefined;
    const segments = String(path).split('.').filter(Boolean);
    let current = value;
    for (const segment of segments) {
      if (!current || typeof current !== 'object' || !(segment in current)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }

  _findObjectPathByCandidates(value, candidates = []) {
    const keyPaths = this._collectObjectKeyPaths(value);
    for (const candidate of candidates) {
      const exact = keyPaths.find(path => path === candidate);
      if (exact) return exact;
    }
    for (const candidate of candidates) {
      const suffix = `.${candidate}`;
      const matched = keyPaths.find(path => path.endsWith(suffix));
      if (matched) return matched;
    }
    return '';
  }

  _analyzeSmallPaymentSubmitTemplate(templateEntry) {
    const templateBody = this._safeParseJson(templateEntry?.requestBody);
    if (!templateBody || typeof templateBody !== 'object') {
      return {
        ready: false,
        url: templateEntry?.url || '',
        keys: [],
        recognizedCount: 0,
      };
    }
    const orderField = this._findObjectPathByCandidates(templateBody, ['orderSn', 'order_sn']);
    const amountField = this._findObjectPathByCandidates(templateBody, ['playMoneyAmount', 'play_money_amount', 'amount', 'transferAmount', 'transfer_amount']);
    const typeField = this._findObjectPathByCandidates(templateBody, ['refundType', 'refund_type', 'payType', 'pay_type', 'transferType', 'transfer_type']);
    const noteField = this._findObjectPathByCandidates(templateBody, ['remarks', 'remark', 'leaveMessage', 'leave_message', 'message']);
    const mobileField = this._findObjectPathByCandidates(templateBody, ['mobile', 'userinfo.mobile', 'currentUserInfo.mobile']);
    const recognizedFields = {
      orderField,
      amountField,
      typeField,
      noteField,
      mobileField,
    };
    const recognizedCount = Object.values(recognizedFields).filter(Boolean).length;
    return {
      ready: true,
      url: templateEntry?.url || '',
      keys: this._collectObjectKeyPaths(templateBody).slice(0, 60),
      recognizedCount,
      recognizedFields,
      snapshot: this._cloneJson({
        orderSn: orderField ? this._readObjectPath(templateBody, orderField) : undefined,
        amount: amountField ? this._readObjectPath(templateBody, amountField) : undefined,
        type: typeField ? this._readObjectPath(templateBody, typeField) : undefined,
        note: noteField ? this._readObjectPath(templateBody, noteField) : undefined,
      }),
    };
  }

  _isSmallPaymentSubmitBody(body = {}, normalizedOrderSn = '') {
    if (!body || typeof body !== 'object') return false;
    const targetOrderSn = String(body?.orderSn || body?.order_sn || '').trim();
    if (!targetOrderSn) return false;
    if (normalizedOrderSn && targetOrderSn !== normalizedOrderSn) return false;
    return [
      body?.playMoneyAmount,
      body?.play_money_amount,
      body?.refundType,
      body?.refund_type,
      body?.remarks,
      body?.remark,
      body?.leaveMessage,
      body?.leave_message,
    ].some(value => value !== undefined && value !== null && value !== '');
  }

  _getLatestSmallPaymentSubmitTemplate(orderSn = '') {
    const normalizedOrderSn = String(orderSn || '').trim();
    const latestTrafficTemplate = this._findLatestTrafficEntry((entry) => {
      if (String(entry?.method || 'GET').toUpperCase() !== 'POST') return false;
      const url = String(entry?.url || '');
      if (!url.includes('/mercury/')) return false;
      if ([
        '/mercury/micro_transfer/detail',
        '/mercury/micro_transfer/queryTips',
        '/mercury/play_money/check',
      ].some(part => url.includes(part))) {
        return false;
      }
      const body = this._safeParseJson(entry?.requestBody);
      return this._isSmallPaymentSubmitBody(body, normalizedOrderSn);
    });
    if (latestTrafficTemplate) {
      return latestTrafficTemplate;
    }
    const persistedTemplate = this._getSmallPaymentSubmitTemplate();
    if (!persistedTemplate || typeof persistedTemplate !== 'object') {
      return null;
    }
    const persistedBody = this._safeParseJson(persistedTemplate?.requestBody);
    if (!this._isSmallPaymentSubmitBody(persistedBody, normalizedOrderSn)) {
      return null;
    }
    return {
      url: persistedTemplate.url || `${PDD_BASE}/mercury/unknown_small_payment_submit`,
      method: persistedTemplate.method || 'POST',
      requestBody: JSON.stringify(persistedBody),
    };
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
    const messages = this._parseMessages(payload);
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
    const messages = this._parseMessages(payload);
    const sellerMessage = [...messages].reverse().find(item => item.actor === 'seller' && item?.raw && typeof item.raw === 'object');
    if (sellerMessage?.raw) {
      return this._cloneJson(sellerMessage.raw);
    }
    return null;
  }

  _extractBuyerUid(item = {}) {
    const directCandidates = [
      item.customer_id,
      item.buyer_id,
      item?.user_info?.uid,
      item.uid,
    ].map(value => String(value || '')).filter(Boolean);
    if (directCandidates.length) return directCandidates[0];
    const mallId = String(this._getMallId() || '');
    const fromUid = String(item?.from?.uid || item.from_uid || '');
    const toUid = String(item?.to?.uid || item.to_uid || '');
    const fromRole = String(item?.from?.role || '').toLowerCase();
    const toRole = String(item?.to?.role || '').toLowerCase();
    if (['buyer', 'customer', 'user'].includes(fromRole) && fromUid) return fromUid;
    if (['buyer', 'customer', 'user'].includes(toRole) && toUid) return toUid;
    if (mallId) {
      if (fromUid && fromUid === mallId && toUid) return toUid;
      if (toUid && toUid === mallId && fromUid) return fromUid;
      if (String(item?.from?.mall_id || '') === mallId && toUid) return toUid;
      if (String(item?.to?.mall_id || '') === mallId && fromUid) return fromUid;
    }
    return toUid || fromUid || '';
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

  async _buildHeaders(extraHeaders = {}) {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    const cookie = await this._getCookieString();
    const cookieMap = await this._getCookieMap();
    const headers = {
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'max-age=0',
      'content-type': 'application/json',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      Referer: CHAT_URL,
      Origin: PDD_BASE,
      ...extraHeaders,
    };

    if (cookie) headers.cookie = cookie;
    headers['user-agent'] = (shop?.userAgent || tokenInfo?.userAgent || '').replace('pdd_webview', '').trim();
    if (tokenInfo?.raw) {
      headers['X-PDD-Token'] = tokenInfo.raw;
      headers['windows-app-shop-token'] = tokenInfo.raw;
    }
    if (tokenInfo?.pddid) headers.pddid = tokenInfo.pddid;
    if (cookieMap.rckk) headers.etag = cookieMap.rckk;
    if (cookieMap['msfe-pc-cookie-captcha-token']) {
      headers.VerifyAuthToken = cookieMap['msfe-pc-cookie-captcha-token'];
    }

    return headers;
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
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  _isSystemNoticeMessage(item = {}) {
    const messageType = Number(
      item?.type
      ?? item?.msg_type
      ?? item?.message_type
      ?? item?.content_type
      ?? -1
    );
    if (messageType === 31 || messageType === 90) return true;
    const templateName = String(item?.template_name || item?.templateName || '').trim();
    if (templateName) return true;
    const systemInfo = item?.system;
    if (systemInfo && typeof systemInfo === 'object' && Object.keys(systemInfo).length) return true;
    return this._isSystemNoticeText(this._extractMessageText(item));
  }

  _getMessageActor(item = {}) {
    if (this._isSystemNoticeMessage(item)) return 'system';
    const role = String(
      item.role ||
      item.msg_from ||
      item.from_type ||
      item.sender_role ||
      item?.from?.role ||
      item?.sender?.role ||
      item?.to?.role ||
      ''
    ).toLowerCase();
    if (['buyer', 'customer', 'user', '1', '0'].includes(role)) return 'buyer';
    if (['system', 'robot', 'bot', 'notice', 'tips', '99'].includes(role)) return 'system';
    if (['seller', 'service', 'kf', 'agent', 'mall_cs', '2', '3', '4'].includes(role)) return 'seller';
    if (item.is_buyer || item.is_buyer === 1 || item.sender_type === 1 || item.sender_type === 0) return 'buyer';
    if (item.is_robot || item.is_system) return 'system';
    if (item.is_seller) return 'seller';

    const mallId = String(this._getMallId() || '');
    const fromUid = String(item?.from?.uid || item.from_uid || item.sender_id || item.from_id || '');
    const toUid = String(item?.to?.uid || item.to_uid || '');
    const buyerUidCandidates = [
      item?.customer_id,
      item?.buyer_id,
      item?.uid,
      item?.user_info?.uid,
    ].map(value => String(value || '')).filter(Boolean);

    if (mallId && (fromUid === mallId || String(item?.from?.mall_id || '') === mallId)) return 'seller';
    if (mallId && (toUid === mallId || String(item?.to?.mall_id || '') === mallId)) return 'buyer';
    if (fromUid && buyerUidCandidates.includes(fromUid)) return 'buyer';
    if (toUid && buyerUidCandidates.includes(toUid)) return 'seller';
    return 'unknown';
  }

  _isSystemNoticeText(text = '') {
    const source = String(text || '').trim();
    if (!source) return false;
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
      /^\[?消费者已同意您发起的退款申请，请及时处理\]?$/,
      /^退款成功通知$/,
      /^退款成功$/,
    ].some(pattern => pattern.test(source));
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

  async initSession(force = false) {
    if (this._sessionInited && !force) return { initialized: true };

    this._authExpired = false;
    const shop = this._getShopInfo();
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

    if (shop?.userAgent) {
      win.webContents.setUserAgent(shop.userAgent);
    }

    const monitor = new NetworkMonitor(win.webContents, {
      onApiTraffic: entry => this._appendBootstrapTraffic(entry),
    });
    monitor.start();

    try {
      await win.loadURL(CHAT_URL);
      let settled = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('chat-merchant') && !currentUrl.includes('/login')) {
          settled = true;
          break;
        }
      }

      const finalUrl = win.webContents.getURL();
      this._sessionInited = settled;
      const bootstrapStatus = settled
        ? await this._waitForConversationBootstrap()
        : this._getConversationBootstrapStatus();
      this._log(`[API] 会话初始化${settled ? '成功' : '未完成'}`);
      if (finalUrl.includes('/login')) {
        this._emitAuthExpired({
          errorMsg: '网页登录已失效，请重新登录或重新导入 Token',
          authState: 'expired',
          source: 'initSession',
        });
      }
      const cookieNamesAfter = await this._listCookieNames();
      return {
        initialized: settled,
        url: finalUrl,
        cookieNamesBefore,
        cookieNamesAfter,
        addedCookieNames: cookieNamesAfter.filter(item => !cookieNamesBefore.includes(item)),
        userAgentUsed: shop?.userAgent || this._getTokenInfo()?.userAgent || '',
        bootstrapStatus,
      };
    } finally {
      monitor.stop();
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async _request(method, urlPath, body, extraHeaders = {}) {
    const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
    const headers = await this._buildHeaders(extraHeaders);
    const shop = this._getShopInfo();
    if (shop?.loginMethod === 'token' && !headers['X-PDD-Token']) {
      const error = new Error('当前店铺未恢复 Token，请重新导入 Token');
      throw this._markAuthExpired(error, {
        errorMsg: error.message,
        authState: 'token_missing',
        source: 'missing-token',
      });
    }
    const options = { method, headers };

    if (body !== undefined && body !== null) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await this._getSession().fetch(url, options);
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
  }

  async _requestRaw(method, urlPath, body, extraHeaders = {}) {
    const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
    const headers = await this._buildHeaders(extraHeaders);
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
      throw this._markAuthExpired(error, {
        errorMsg: error.message,
        authState: 'token_missing',
        source: 'missing-token',
      });
    }
    const options = { method, headers };
    if (body instanceof FormData) {
      delete options.headers['content-type'];
      delete options.headers['Content-Type'];
    }
    if (body !== undefined && body !== null) {
      options.body = body;
    }
    const response = await this._getSession().fetch(url, options);
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
  }

  async _post(urlPath, body, extraHeaders) {
    return this._request('POST', urlPath, body, extraHeaders);
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
    const info = payload?.result || payload?.data || payload || {};
    return {
      mallId: info.mall_id || info.mallId || this._getMallId() || '',
      userId: info.uid || info.user_id || info.userId || this._getTokenInfo()?.userId || '',
      username: info.username || info.user_name || info.login_name || '',
      nickname: info.nick_name || info.nickname || info.name || '',
      mobile: info.mobile || '',
    };
  }

  _parseServiceProfile(payload) {
    const info = payload?.result || payload?.data || payload || {};
    const mall = (info.mall && typeof info.mall === 'object') ? info.mall : {};
    return {
      mallId: info.mall_id || info.mallId || mall.mall_id || this._getMallId() || '',
      mallName: mall.mall_name || info.mall_name || this._getShopInfo()?.name || '',
      username: info.username || info.user_name || info.login_name || '',
      serviceName: info.username || info.nickname || info.nick_name || info.name || '',
      serviceAvatar: mall.logo || info.avatar || info.head_img || '',
    };
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

  async getUserInfo() {
    try {
      const payload = await this._post('/janus/api/userinfo', {}, this._getShopInfoRequestHeaders('mall'));
      return this._parseUserInfo(payload);
    } catch (error) {
      const payload = await this._post('/janus/api/new/userinfo', {}, this._getShopInfoRequestHeaders('mall'));
      return this._parseUserInfo(payload);
    }
  }

  async getServiceProfile(force = false) {
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
      const payload = await this._request('GET', '/chats/userinfo/realtime?get_response=true');
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
    const info = payload?.result || payload?.data || payload || {};
    const staple = Array.isArray(info.staple) ? info.staple : [];
    return {
      mallId: info.mall_id || info.mallId || this._getMallId() || '',
      mallName: info.mall_name || info.mallName || '',
      category: staple[0] || info.mall_category || info.category || '',
      logo: info.logo || '',
    };
  }

  _parseCredentialInfo(payload) {
    const info = payload?.result || payload?.data || payload || {};
    const mallInfo = info.mallInfo && typeof info.mallInfo === 'object' ? info.mallInfo : {};
    const detail = info.queryDetailResult && typeof info.queryDetailResult === 'object' ? info.queryDetailResult : {};
    const enterprise = detail.enterprise && typeof detail.enterprise === 'object' ? detail.enterprise : {};
    return {
      mallId: mallInfo.id || detail.mallId || this._getMallId() || '',
      mallName: mallInfo.mallName || detail.mallName || '',
      companyName: mallInfo.companyName || enterprise.companyName || '',
      merchantType: detail.merchantType || '',
    };
  }

  async getMallInfo() {
    const payload = await this._request('GET', '/earth/api/mallInfo/commonMallInfo', null, this._getShopInfoRequestHeaders('mall'));
    return this._parseMallInfo(payload);
  }

  async getCredentialInfo() {
    const payload = await this._request('GET', '/earth/api/mallInfo/queryFinalCredentialNew', null, this._getShopInfoRequestHeaders('credential'));
    return this._parseCredentialInfo(payload);
  }

  async getShopProfile(force = false) {
    if (force) {
      this._serviceProfileCache = null;
    }
    const [userInfoResult, serviceProfileResult, mallInfoResult, credentialInfoResult] = await Promise.allSettled([
      this.getUserInfo(),
      this.getServiceProfile(force),
      this.getMallInfo(),
      this.getCredentialInfo()
    ]);
    const userInfo = userInfoResult.status === 'fulfilled' ? userInfoResult.value : {};
    const serviceProfile = serviceProfileResult.status === 'fulfilled' ? serviceProfileResult.value : {};
    const mallInfo = mallInfoResult.status === 'fulfilled' ? mallInfoResult.value : {};
    const credentialInfo = credentialInfoResult.status === 'fulfilled' ? credentialInfoResult.value : {};
    return {
      mallId: mallInfo.mallId || credentialInfo.mallId || serviceProfile.mallId || userInfo.mallId || this._getMallId() || '',
      mallName: mallInfo.mallName || credentialInfo.mallName || serviceProfile.mallName || '',
      account: userInfo.nickname || serviceProfile.serviceName || '',
      mobile: userInfo.mobile || '',
      category: mallInfo.category || '',
      logo: mallInfo.logo || serviceProfile.serviceAvatar || '',
      companyName: credentialInfo.companyName || '',
      merchantType: credentialInfo.merchantType || '',
    };
  }

  _extractSessionPreviewText(item) {
    return this._extractMessageText({
      content: item?.last_msg,
      text: item?.last_message,
      msg_content: item?.latest_msg,
      message: item?.content,
      body: item?.summary,
      msg: item?.preview,
      extra: {
        text: item?.last_msg_text || item?.msg_text,
      },
      ext: {
        text: item?.snippet,
      },
    });
  }

  _extractSessionPreviewTime(item) {
    const candidates = [
      item?.last_msg_time,
      item?.update_time,
      item?.last_time,
      item?.ts,
      item?.last_msg?.send_time,
      item?.last_msg?.time,
      item?.last_msg?.ts,
      item?.last_message?.send_time,
      item?.last_message?.time,
      item?.latest_msg?.send_time,
      item?.latest_msg?.time,
      item?.content?.send_time,
      item?.content?.time,
    ];
    return candidates.find(value => value !== undefined && value !== null && value !== '') || 0;
  }

  _extractSessionCreatedTime(item) {
    const candidates = [
      item?.create_time,
      item?.created_at,
      item?.createdAt,
      item?.createTime,
      item?.ctime,
      item?.context?.create_time,
      item?.context?.created_at,
      item?.session_create_time,
      item?.conversation_create_time,
      item?.first_msg_time,
      item?.first_message_time,
    ];
    return candidates.find(value => value !== undefined && value !== null && value !== '') || 0;
  }

  _extractSessionLastMessageActor(item = {}) {
    const context = {
      customer_id: item?.customer_id,
      buyer_id: item?.buyer_id,
      uid: item?.user_info?.uid,
      user_info: item?.user_info,
      from: item?.from,
      to: item?.to,
    };
    const candidates = [
      item?.last_msg,
      item?.last_message,
      item?.latest_msg,
      item?.content,
      item?.preview,
      item,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const actor = this._getMessageActor({ ...context, ...candidate });
      if (actor !== 'unknown') return actor;
    }
    return 'unknown';
  }

  _normalizeTimestampMs(value) {
    if (value === undefined || value === null || value === '') return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : 0;
      }
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return num < 1e12 ? num * 1000 : num;
  }

  _isTodayTimestamp(value) {
    const ms = this._normalizeTimestampMs(value);
    if (!ms) return false;
    const date = new Date(ms);
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
  }

  _hasPendingReplySession(session = {}) {
    const lastMessageActor = String(session?.lastMessageActor || '').toLowerCase();
    const lastMessageIsFromBuyer = session?.lastMessageIsFromBuyer === true || lastMessageActor === 'buyer';
    const waitValue = Number(session?.waitTime || 0);
    const hasPendingIndicators = (
      (Number.isFinite(waitValue) && waitValue > 0)
      || session?.isTimeout
      || Number(session?.unreadCount || 0) > 0
    );
    if (lastMessageIsFromBuyer) return hasPendingIndicators;
    if (lastMessageActor === 'seller') return false;
    return hasPendingIndicators;
  }

  _filterDisplaySessions(sessions = []) {
    return sessions.filter(session => (
      this._isTodayTimestamp(session?.lastMessageTime)
      || this._isTodayTimestamp(session?.createdAt)
      || this._hasPendingReplySession(session)
    ));
  }

  _pickPendingBuyerMessage(messages = [], buyerIds = [], sessionMeta = {}) {
    const sorted = Array.isArray(messages)
      ? messages.slice().sort((a, b) => this._normalizeTimestampMs(a?.timestamp) - this._normalizeTimestampMs(b?.timestamp))
      : [];
    let latestBuyerMessage = null;
    const comparableBuyerIds = Array.isArray(buyerIds)
      ? buyerIds.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    const previewText = this._normalizeComparableMessageText(this._extractSessionPreviewText(sessionMeta));
    for (const item of sorted) {
      const actor = String(item?.actor || this._getMessageActor(item?.raw || item) || '').toLowerCase();
      const senderId = String(item?.senderId || item?.raw?.from_uid || item?.raw?.sender_id || item?.raw?.from_id || item?.raw?.from?.uid || '').trim();
      const isBuyerMessage = actor === 'buyer' || (!!senderId && comparableBuyerIds.includes(senderId));
      const isSellerMessage = actor === 'seller';
      const text = String(item?.content || '').trim();
      const normalizedText = this._normalizeComparableMessageText(text);
      const matchesPreview = !!previewText && !!normalizedText && normalizedText === previewText;
      if (!text || actor === 'system') continue;
      if (isSellerMessage) {
        latestBuyerMessage = null;
        continue;
      }
      if (isBuyerMessage || (actor === 'unknown' && matchesPreview)) {
        latestBuyerMessage = item;
      }
    }
    return latestBuyerMessage;
  }

  _parseSessionIdentity(item = {}) {
    const conversationId = item.conversation_id || item.conversationId || '';
    const chatId = item.chat_id || item.chatId || '';
    const explicitSessionId = item.session_id || item.sessionId || '';
    const rawId = item.id || '';
    const buyerUid = this._extractBuyerUid(item);
    const customerId = item.customer_id || item.buyer_id || item?.user_info?.uid || buyerUid || '';
    const userUid = item?.user_info?.uid || item.customer_id || item.buyer_id || buyerUid || '';
    const sessionId = explicitSessionId || conversationId || chatId || rawId || customerId || userUid || '';
    return {
      sessionId,
      explicitSessionId,
      conversationId,
      chatId,
      rawId,
      customerId: customerId || userUid || '',
      userUid: userUid || customerId || '',
    };
  }

  _pickDisplayText(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
    }
    return '';
  }

  _resolveBuyerParticipant(item = {}) {
    const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
    const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
    const buyerUid = String(this._extractBuyerUid(item) || '');
    if (!buyerUid) return fromObj || toObj || null;
    if (String(fromObj?.uid || '') === buyerUid) return fromObj;
    if (String(toObj?.uid || '') === buyerUid) return toObj;
    return fromObj || toObj || null;
  }

  _extractSessionCustomerName(item = {}) {
    const userInfo = item?.user_info && typeof item.user_info === 'object' ? item.user_info : null;
    const buyerInfo = item?.buyer && typeof item.buyer === 'object' ? item.buyer : null;
    const customerInfo = item?.customer && typeof item.customer === 'object' ? item.customer : null;
    const participant = this._resolveBuyerParticipant(item);
    const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
    const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
    return this._pickDisplayText(
      [item, userInfo, buyerInfo, customerInfo, participant, fromObj, toObj],
      [
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
        'displayName',
        'name',
      ],
    );
  }

  _extractSessionCustomerAvatar(item = {}) {
    const userInfo = item?.user_info && typeof item.user_info === 'object' ? item.user_info : null;
    const buyerInfo = item?.buyer && typeof item.buyer === 'object' ? item.buyer : null;
    const customerInfo = item?.customer && typeof item.customer === 'object' ? item.customer : null;
    const participant = this._resolveBuyerParticipant(item);
    const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
    const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
    return this._pickDisplayText(
      [item, userInfo, buyerInfo, customerInfo, participant, fromObj, toObj],
      [
        'avatar',
        'head_img',
        'buyer_avatar',
        'avatar_url',
        'avatarUrl',
      ],
    );
  }

  _extractMessageSenderName(item = {}) {
    const fromObj = item?.from && typeof item.from === 'object' ? item.from : null;
    const toObj = item?.to && typeof item.to === 'object' ? item.to : null;
    const userInfo = item?.user_info && typeof item.user_info === 'object' ? item.user_info : null;
    const participant = this._isBuyerMessage(item) ? this._resolveBuyerParticipant(item) : fromObj;
    return this._pickDisplayText(
      [item, participant, fromObj, userInfo, toObj],
      [
        'nick',
        'nickname',
        'nick_name',
        'sender_name',
        'from_name',
        'display_name',
        'displayName',
        'name',
        'csid',
      ],
    );
  }

  _parseSessionList(payload) {
    const list = payload?.data?.list ||
      payload?.data?.conv_list ||
      payload?.data?.conversation_list ||
      payload?.data?.conversations ||
      payload?.data?.items ||
      payload?.result?.data?.list ||
      payload?.result?.data?.conv_list ||
      payload?.result?.data?.conversation_list ||
      payload?.result?.data?.conversations ||
      payload?.result?.data?.items ||
      payload?.result?.data ||
      payload?.result?.list ||
      payload?.result?.data ||
      payload?.result?.conversations ||
      payload?.result?.items ||
      payload?.conv_list ||
      payload?.conversation_list ||
      payload?.conversations ||
      payload?.data?.conversations ||
      payload?.list ||
      [];

    return list.map(item => {
      const identity = this._parseSessionIdentity(item);
      const lastMessageActor = this._extractSessionLastMessageActor(item);
      const customerName = this._extractSessionCustomerName(item);
      const customerAvatar = this._extractSessionCustomerAvatar(item);
      return {
        sessionId: identity.sessionId,
        explicitSessionId: identity.explicitSessionId,
        conversationId: identity.conversationId,
        chatId: identity.chatId,
        rawId: identity.rawId,
        customerId: identity.customerId,
        userUid: identity.userUid,
        customerName: customerName || '未知客户',
        customerAvatar,
        lastMessage: this._extractSessionPreviewText(item),
        lastMessageTime: this._extractSessionPreviewTime(item),
        lastMessageActor,
        lastMessageIsFromBuyer: lastMessageActor === 'buyer',
        createdAt: this._extractSessionCreatedTime(item),
        unreadCount: item.unread_count || item.unread || item.unread_num || item?.context?.unread || 0,
        isTimeout: item.is_timeout || item.timeout || false,
        waitTime: item.wait_time || item.waiting_time || item.last_unreply_time || 0,
        groupNumber: item.groupNumber ?? item.group_number ?? item?.user_info?.group_number ?? item?.user_info?.groupNumber ?? 0,
        group_number: item.group_number ?? item.groupNumber ?? item?.user_info?.group_number ?? item?.user_info?.groupNumber ?? 0,
        orderId: item.order_id || item.order_sn || '',
        goodsInfo: item.goods_info || item.goods || null,
        csUid: item?.from?.cs_uid || '',
        mallId: item?.from?.mall_id || '',
        mallName: item.mallName || item.mall_name || item?.mall_info?.mall_name || item?.mall_info?.mallName || '',
        isShopMember: typeof item.is_shop_member === 'boolean'
          ? item.is_shop_member
          : (typeof item.isShopMember === 'boolean' ? item.isShopMember : null),
        raw: item,
      };
    });
  }

  _describeSessionListPayload(payload) {
    const candidates = {
      dataList: Array.isArray(payload?.data?.list) ? payload.data.list.length : -1,
      dataConvList: Array.isArray(payload?.data?.conv_list) ? payload.data.conv_list.length : -1,
      dataConversationList: Array.isArray(payload?.data?.conversation_list) ? payload.data.conversation_list.length : -1,
      dataItems: Array.isArray(payload?.data?.items) ? payload.data.items.length : -1,
      resultDataList: Array.isArray(payload?.result?.data?.list) ? payload.result.data.list.length : -1,
      resultDataConvList: Array.isArray(payload?.result?.data?.conv_list) ? payload.result.data.conv_list.length : -1,
      resultList: Array.isArray(payload?.result?.list) ? payload.result.list.length : -1,
      resultItems: Array.isArray(payload?.result?.items) ? payload.result.items.length : -1,
      rootList: Array.isArray(payload?.list) ? payload.list.length : -1,
      rootConvList: Array.isArray(payload?.conv_list) ? payload.conv_list.length : -1,
    };
    return {
      payloadType: Array.isArray(payload) ? 'array' : typeof payload,
      topKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
      dataKeys: payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data).slice(0, 12) : [],
      resultKeys: payload?.result && typeof payload.result === 'object' ? Object.keys(payload.result).slice(0, 12) : [],
      candidates,
    };
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

  async getSessionList(page = 1, pageSize = 20) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    let templateBody = this._getLatestConversationRequestBody();
    let antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    if (!templateBody && !antiContent && page === 1 && this._sessionCache.length === 0) {
      const bootstrapStatus = await this._waitForConversationBootstrap(1500);
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
      const sessions = this._filterDisplaySessions(this._parseSessionList(payload));
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
        const retrySessions = this._filterDisplaySessions(this._parseSessionList(retryPayload));
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
      this._log('[API] 会话列表拉取失败', {
        message: error.message,
        statusCode: error.statusCode || 0,
        errorCode: error.errorCode || 0,
        payload: error.payload || null,
      });
      throw error;
    }
  }

  _isBuyerMessage(item) {
    return this._getMessageActor(item) === 'buyer';
  }

  _extractMessageText(item) {
    const candidates = [
      item?.content,
      item?.text,
      item?.msg_content,
      item?.message,
      item?.body,
      item?.msg_text,
      item?.msg,
      item?.extra?.text,
      item?.ext?.text,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') {
        const nestedText = [
          value.text,
          value.content,
          value.message,
          value.msg,
          value.title,
        ].find(entry => typeof entry === 'string' && entry.trim());
        if (nestedText) return nestedText;
      }
    }
    return '';
  }

  _extractMessageReadState(item = {}) {
    const candidates = [
      item?.is_read,
      item?.isRead,
      item?.read_status,
      item?.readStatus,
      item?.read_state,
      item?.readState,
      item?.extra?.is_read,
      item?.extra?.isRead,
      item?.extra?.read_status,
      item?.extra?.readStatus,
      item?.extra?.read_state,
      item?.extra?.readState,
      item?.ext?.is_read,
      item?.ext?.isRead,
      item?.ext?.read_status,
      item?.ext?.readStatus,
      item?.ext?.read_state,
      item?.ext?.readState,
    ];
    for (const value of candidates) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'boolean') return value ? 'read' : 'unread';
      if (typeof value === 'number') return value > 0 ? 'read' : 'unread';
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) continue;
        if (['1', 'true', 'read', 'has_read', 'already_read', '已读'].includes(normalized)) return 'read';
        if (['0', 'false', 'unread', 'not_read', '未读'].includes(normalized)) return 'unread';
      }
    }
    return '';
  }

  _decodeGoodsText(value = '') {
    return String(value || '')
      .replace(/\\u([\da-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([\da-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  _pickGoodsText(candidates = []) {
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return this._decodeGoodsText(value);
    }
    return '';
  }

  _normalizeGoodsPrice(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return '';
      if (text.includes('¥')) return text;
      const numeric = Number(text);
      if (!Number.isNaN(numeric)) return this._normalizeGoodsPrice(numeric);
      return text;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const amount = Number.isInteger(numeric) && numeric >= 1000 ? numeric / 100 : numeric;
    return `¥${amount.toFixed(2)}`;
  }

  _normalizeRefundAmountByKeys(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const rawValue = source[key];
        if (rawValue === undefined || rawValue === null || rawValue === '') continue;
        if (typeof rawValue === 'string') {
          const text = rawValue.trim();
          if (!text) continue;
          if (text.includes('¥')) return text;
          if (text.includes('.')) {
            const decimal = Number(text);
            if (Number.isFinite(decimal) && decimal > 0) return `¥${decimal.toFixed(2)}`;
          }
          const integer = Number(text);
          if (Number.isFinite(integer) && integer > 0) return `¥${(integer / 100).toFixed(2)}`;
          continue;
        }
        const numeric = Number(rawValue);
        if (Number.isFinite(numeric) && numeric > 0) {
          return `¥${(numeric / 100).toFixed(2)}`;
        }
      }
    }
    return '';
  }

  _extractGoodsIdFromUrl(rawUrl = '') {
    const urlText = String(rawUrl || '').trim();
    if (!urlText) return '';
    try {
      const parsed = new URL(urlText);
      return parsed.searchParams.get('goods_id') || parsed.searchParams.get('goodsId') || '';
    } catch {
      const match = urlText.match(/[?&]goods_id=(\d+)/i) || urlText.match(/[?&]goodsId=(\d+)/i);
      return match?.[1] || '';
    }
  }

  _normalizeGoodsId(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    const digitsOnly = text.replace(/[^\d]/g, '');
    return digitsOnly || '';
  }

  _extractGoodsJsonObject(source = '') {
    const text = String(source || '').trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {}
    const normalized = text.replace(/;\s*$/, '').trim();
    try {
      return JSON.parse(normalized);
    } catch {}
    const start = normalized.search(/[\[{]/);
    if (start < 0) return null;
    const opening = normalized[start];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;
    for (let index = start; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === quote) {
          inString = false;
          quote = '';
        }
        continue;
      }
      if (char === '"' || char === "'") {
        inString = true;
        quote = char;
        continue;
      }
      if (char === opening) {
        depth += 1;
        continue;
      }
      if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          const candidate = normalized.slice(start, index + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  _extractGoodsPayloadCandidates(html = '') {
    const source = String(html || '');
    const payloads = [];
    const seen = new Set();
    const pushPayload = (value) => {
      if (!value || typeof value !== 'object') return;
      let serialized = '';
      try {
        serialized = JSON.stringify(value);
      } catch {}
      if (serialized) {
        if (seen.has(serialized)) return;
        seen.add(serialized);
      }
      payloads.push(value);
    };
    const patterns = [
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
      /(?:window\.)?__NEXT_DATA__\s*=\s*([\s\S]*?);\s*<\/script>/gi,
      /(?:window\.)?__PRELOADED_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/gi,
      /(?:window\.)?__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/gi,
      /(?:window\.)?rawData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
      /(?:window\.)?pageData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
      /(?:window\.)?goodsData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
    ];
    patterns.forEach((pattern) => {
      source.replace(pattern, (_, payloadText) => {
        const parsed = this._extractGoodsJsonObject(payloadText);
        if (parsed) pushPayload(parsed);
        return _;
      });
    });
    return payloads;
  }

  _extractGoodsTextCandidate(value, preferredKeys = []) {
    if (typeof value === 'string' && value.trim()) {
      return this._decodeGoodsText(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const matched = this._extractGoodsTextCandidate(item, preferredKeys);
        if (matched) return matched;
      }
      return '';
    }
    if (!value || typeof value !== 'object') return '';
    for (const key of preferredKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const matched = this._extractGoodsTextCandidate(value[key], preferredKeys);
      if (matched) return matched;
    }
    for (const item of Object.values(value)) {
      const matched = this._extractGoodsTextCandidate(item, preferredKeys);
      if (matched) return matched;
    }
    return '';
  }

  _findGoodsFieldText(payload, keys = [], nestedKeys = []) {
    if (!payload || typeof payload !== 'object') return '';
    const queue = [payload];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        current.forEach(item => queue.push(item));
        continue;
      }
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        const matched = this._extractGoodsTextCandidate(current[key], nestedKeys);
        if (matched) return matched;
      }
      Object.values(current).forEach(item => queue.push(item));
    }
    return '';
  }

  _pickGoodsNumber(source = {}, keys = []) {
    if (!source || typeof source !== 'object') return null;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const numeric = Number(source[key]);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  }

  _splitGoodsSpecText(value = '') {
    return String(value || '')
      .split(/[|/,，；;]/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  _formatGoodsSpecSegment(segment = {}) {
    const group = String(segment.group || '').trim();
    const name = String(segment.name || '').trim();
    if (!group) return name;
    return `${group}：${name}`;
  }

  _appendGoodsSpecSegments(segments, value) {
    if (!value) return;
    const pushSegment = (group, name) => {
      const normalizedName = String(name || '').trim();
      if (!normalizedName) return;
      segments.push({
        group: String(group || '').trim(),
        name: normalizedName,
      });
    };
    if (typeof value === 'string' || typeof value === 'number') {
      this._splitGoodsSpecText(value).forEach(part => pushSegment('', part));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => this._appendGoodsSpecSegments(segments, item));
      return;
    }
    if (typeof value !== 'object') return;
    const group = this._pickGoodsText([
      value.parent_spec_name,
      value.parentSpecName,
      value.spec_key,
      value.specKey,
      value.group_name,
      value.groupName,
      value.label,
      value.key,
      value.name,
      value.title,
    ]);
    const name = this._pickGoodsText([
      value.spec_name,
      value.specName,
      value.spec_value,
      value.specValue,
      value.value,
      value.text,
      value.desc,
      value.display_name,
      value.displayName,
    ]);
    if (name) {
      pushSegment(group, name);
      return;
    }
    ['items', 'children', 'list', 'values', 'specs', 'spec_list', 'specList'].forEach((key) => {
      if (value[key]) this._appendGoodsSpecSegments(segments, value[key]);
    });
  }

  _extractGoodsSpecSegments(item = {}) {
    const segments = [];
    [
      item.specs,
      item.spec_list,
      item.specList,
      item.spec_info,
      item.specInfo,
      item.spec_values,
      item.specValues,
      item.properties,
      item.props,
      item.sku_props,
      item.skuProps,
    ].forEach(value => this._appendGoodsSpecSegments(segments, value));
    if (segments.length) return segments;
    const combined = this._pickGoodsText([
      item.spec,
      item.specText,
      item.spec_text,
      item.sku_spec,
      item.skuSpec,
      item.spec_desc,
      item.specDesc,
      item.sku_name,
      item.skuName,
      item.sub_name,
      item.subName,
      item.option_desc,
      item.optionDesc,
      item.name,
      item.title,
    ]);
    this._appendGoodsSpecSegments(segments, combined);
    return segments;
  }

  _normalizeGoodsSpecItem(item = {}) {
    if (!item || typeof item !== 'object') return null;
    const segments = this._extractGoodsSpecSegments(item);
    const formattedSegments = segments
      .map(segment => this._formatGoodsSpecSegment(segment))
      .filter(Boolean);
    const specLabel = formattedSegments[0]
      || this._pickGoodsText([
        item.spec,
        item.specText,
        item.spec_text,
        item.sku_spec,
        item.skuSpec,
        item.spec_desc,
        item.specDesc,
        item.sku_name,
        item.skuName,
        item.sub_name,
        item.subName,
        item.name,
      ]);
    const styleLabel = formattedSegments.slice(1).join(' / ')
      || this._pickGoodsText([
        item.style,
        item.style_name,
        item.styleName,
        item.mode,
        item.mode_name,
        item.modeName,
        item.option,
        item.option_name,
        item.optionName,
      ]);
    const priceText = this._pickGoodsText([
      this._normalizeGoodsPrice(this._pickGoodsNumber(item, [
        'group_price',
        'min_group_price',
        'single_price',
        'origin_price',
        'normal_price',
        'price',
        'promotion_price',
        'promotionPrice',
        'discount_price',
        'discountPrice',
        'min_price',
      ])),
      item.priceText,
      item.price_text,
      item.price,
      item.group_price_text,
      item.groupPriceText,
    ]);
    const stockNumber = this._pickGoodsNumber(item, [
      'quantity',
      'stock',
      'stock_num',
      'stockNum',
      'stock_number',
      'stockNumber',
      'left_quantity',
      'leftQuantity',
      'available_stock',
      'availableStock',
      'inventory',
      'inventory_num',
      'inventoryNum',
      'warehouse_num',
      'warehouseNum',
      'goods_number',
      'goodsNumber',
    ]);
    const salesNumber = this._pickGoodsNumber(item, [
      'sales',
      'sales_num',
      'salesNum',
      'sold',
      'sold_num',
      'soldNum',
      'sold_quantity',
      'soldQuantity',
      'sales_volume',
      'salesVolume',
      'deal_num',
      'dealNum',
      'cnt',
    ]);
    const stockText = Number.isFinite(stockNumber)
      ? String(stockNumber)
      : this._pickGoodsText([item.stockText, item.stock_text, item.stock]);
    const salesText = Number.isFinite(salesNumber)
      ? String(salesNumber)
      : this._pickGoodsText([item.salesText, item.sales_text, item.sales]);
    const imageUrl = this._pickGoodsText([
      item.imageUrl,
      item.image_url,
      item.thumb_url,
      item.hd_thumb_url,
      item.goods_thumb_url,
      item.pic_url,
    ]);
    if (!specLabel && !styleLabel && !priceText && !stockText && !salesText) {
      return null;
    }
    return {
      specLabel,
      styleLabel,
      priceText,
      stockText,
      salesText,
      imageUrl,
    };
  }

  _collectGoodsSpecCandidates(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const results = [];
    const seen = new Set();
    const preferredKeys = new Set([
      'sku',
      'skus',
      'sku_list',
      'skuList',
      'sku_map',
      'skuMap',
      'sku_info',
      'skuInfo',
      'specs',
      'spec_list',
      'specList',
      'spec_info',
      'specInfo',
      'goods_sku',
      'goodsSku',
    ]);
    const pushCandidate = (value) => {
      let list = null;
      if (Array.isArray(value)) {
        list = value;
      } else if (value && typeof value === 'object') {
        const values = Object.values(value);
        if (values.length && values.every(item => item && typeof item === 'object')) {
          list = values;
        }
      }
      if (!list || !list.length) return;
      const serialized = JSON.stringify(list.slice(0, 10));
      if (seen.has(serialized)) return;
      seen.add(serialized);
      results.push(list);
    };
    const queue = [payload];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) {
        current.forEach(item => queue.push(item));
        continue;
      }
      Object.entries(current).forEach(([key, value]) => {
        if (preferredKeys.has(key)) pushCandidate(value);
        if (value && typeof value === 'object') queue.push(value);
      });
    }
    return results;
  }

  _extractGoodsSpecItems(payloadCandidates = [], fallback = {}) {
    const rows = [];
    const seen = new Set();
    const pushRow = (row) => {
      if (!row) return;
      const dedupeKey = [
        row.specLabel,
        row.styleLabel,
        row.priceText,
        row.stockText,
        row.salesText,
      ].join('|');
      if (!dedupeKey.replace(/\|/g, '').trim() || seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      rows.push(row);
    };
    payloadCandidates.forEach((payload) => {
      this._collectGoodsSpecCandidates(payload).forEach((list) => {
        list.forEach((item) => {
          pushRow(this._normalizeGoodsSpecItem(item));
        });
      });
    });
    if (!rows.length) {
      const fallbackSpecText = String(fallback?.specText || '').trim();
      const fallbackPriceText = String(fallback?.priceText || '').trim();
      if (fallbackSpecText && fallbackSpecText !== '查看商品规格') {
        pushRow({
          specLabel: fallbackSpecText,
          styleLabel: '',
          priceText: fallbackPriceText,
          stockText: '',
          salesText: '',
          imageUrl: String(fallback?.imageUrl || '').trim(),
        });
      }
    }
    return rows.slice(0, 50);
  }

  _extractGoodsCardFromHtml(html = '', fallback = {}) {
    const source = String(html || '');
    const payloadCandidates = this._extractGoodsPayloadCandidates(source);
    const matchFirst = (patterns = []) => {
      for (const pattern of patterns) {
        const matched = source.match(pattern);
        if (matched?.[1]) return this._decodeGoodsText(matched[1]);
      }
      return '';
    };
    const goodsId = this._pickGoodsText([
      matchFirst([
        /[?&]goods_id=(\d+)/i,
        /"goods_id"\s*:\s*"?(\\d+|\d+)"/i,
        /"goodsId"\s*:\s*"?(\\d+|\d+)"/i,
      ]),
      fallback.goodsId,
    ]);
    const title = this._pickGoodsText([
      matchFirst([
        /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
        /<meta[^>]+name="og:title"[^>]+content="([^"]+)"/i,
        /"goods_name"\s*:\s*"([^"]+)"/i,
        /"goodsName"\s*:\s*"([^"]+)"/i,
        /"goods_title"\s*:\s*"([^"]+)"/i,
        /"goodsTitle"\s*:\s*"([^"]+)"/i,
        /"share_title"\s*:\s*"([^"]+)"/i,
        /<title>([^<]+)<\/title>/i,
      ]),
      ...payloadCandidates.map(payload => this._findGoodsFieldText(
        payload,
        ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'share_title', 'title', 'item_title', 'itemTitle', 'name'],
        ['title', 'name', 'text', 'content', 'value']
      )),
      fallback.title,
    ]);
    const imageUrl = this._pickGoodsText([
      matchFirst([
        /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
        /<meta[^>]+name="og:image"[^>]+content="([^"]+)"/i,
        /"hd_thumb_url"\s*:\s*"([^"]+)"/i,
        /"thumb_url"\s*:\s*"([^"]+)"/i,
        /"goods_thumb_url"\s*:\s*"([^"]+)"/i,
        /"hdThumbUrl"\s*:\s*"([^"]+)"/i,
        /"thumbUrl"\s*:\s*"([^"]+)"/i,
        /"goodsThumbUrl"\s*:\s*"([^"]+)"/i,
        /"top_gallery"\s*:\s*\[\s*"([^"]+)"/i,
      ]),
      ...payloadCandidates.map(payload => this._findGoodsFieldText(
        payload,
        ['hd_thumb_url', 'thumb_url', 'goods_thumb_url', 'hdThumbUrl', 'thumbUrl', 'goodsThumbUrl', 'imageUrl', 'image_url', 'pic_url', 'top_gallery', 'gallery', 'images', 'imageList'],
        ['url', 'src', 'imageUrl', 'image_url', 'thumb_url', 'thumbUrl']
      )),
      fallback.imageUrl,
    ]);
    const priceText = this._pickGoodsText([
      this._normalizeGoodsPrice(matchFirst([
        /"min_group_price"\s*:\s*"?(\\d+(?:\\.\\d+)?|\d+(?:\.\d+)?)"/i,
        /"group_price"\s*:\s*"?(\\d+(?:\\.\\d+)?|\d+(?:\.\d+)?)"/i,
        /"price"\s*:\s*"?(\\d+(?:\\.\\d+)?|\d+(?:\.\d+)?)"/i,
      ])),
      fallback.priceText,
    ]);
    const groupText = this._pickGoodsText([
      matchFirst([
        /"group_order_type_desc"\s*:\s*"([^"]+)"/i,
        /"group_desc"\s*:\s*"([^"]+)"/i,
        /"groupLabel"\s*:\s*"([^"]+)"/i,
        /"customer_num"\s*:\s*"?(\\d+|\d+)"/i,
      ]),
      fallback.groupText,
      '2人团',
    ]);
    const specItems = this._extractGoodsSpecItems(payloadCandidates, fallback);
    return {
      goodsId,
      title: title.replace(/\s*-\s*拼多多.*$/i, '').trim(),
      imageUrl,
      priceText,
      groupText: /^\d+$/.test(groupText) ? `${groupText}人团` : groupText,
      specText: fallback.specText || '查看商品规格',
      specItems,
    };
  }

  _isGoodsLoginPageHtml(html = '') {
    const source = String(html || '');
    if (!source) return false;
    return /手机号码/.test(source)
      && /验证码/.test(source)
      && /服务协议/.test(source)
      && /隐私政策/.test(source);
  }

  _hasMeaningfulGoodsCardData(card = {}, fallback = {}) {
    const title = String(card?.title || '').trim();
    const fallbackTitle = String(fallback?.title || '').trim();
    return !!(
      String(card?.imageUrl || '').trim()
      || String(card?.priceText || '').trim()
      || (title && title !== '拼多多商品' && (!fallbackTitle || title !== fallbackTitle))
    );
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
    if (shop?.userAgent) {
      win.webContents.setUserAgent(shop.userAgent);
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
    const directCandidates = [
      payload?.data?.msg_list,
      payload?.data?.messages,
      payload?.result?.data?.msg_list,
      payload?.result?.data?.messages,
      payload?.result?.data?.list,
      payload?.result?.msg_list,
      payload?.result?.messages,
      payload?.result?.list,
      payload?.msg_list,
      payload?.messages,
      payload?.data?.list,
    ];
    const directList = directCandidates.find(item => Array.isArray(item) && item.length);
    if (directList) return directList;
    const queue = [payload];
    const visited = new Set();
    const candidateKeys = new Set([
      'msg_list',
      'message_list',
      'messages',
      'msg_info',
      'chat_msg',
      'im_msg',
      'recv_msg',
      'new_msg',
      'data',
      'result',
      'list',
      'items',
      'records',
      'response',
      'conversations',
      'conv_list',
      'chat_list',
      'msg_data',
      'message_data',
    ]);
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) {
        if (current.length && current.some(item => item && typeof item === 'object')) {
          return current;
        }
        continue;
      }
      Object.keys(current).forEach(key => {
        if (!candidateKeys.has(key)) return;
        queue.push(current[key]);
      });
    }
    return directCandidates.find(Array.isArray) || [];
  }

  _parseMessages(payload) {
    const list = this._findMessageArray(payload);

    return list.map(item => ({
      actor: this._getMessageActor(item),
      messageId: item.msg_id || item.message_id || item.id || '',
      sessionId: item.session_id || item.conversation_id || item.chat_id || item?.to?.uid || item?.from?.uid || '',
      content: this._extractMessageText(item),
      msgType: item.msg_type || item.message_type || item.content_type || 1,
      isFromBuyer: this._isBuyerMessage(item),
      isSystem: this._getMessageActor(item) === 'system',
      senderName: this._extractMessageSenderName(item),
      senderId: item.from_uid || item.sender_id || item.from_id || item?.from?.uid || '',
      timestamp: item.send_time || item.time || item.ts || item.timestamp || item.created_at || 0,
      readState: this._extractMessageReadState(item),
      extra: item.extra || item.ext || null,
      raw: item,
    }));
  }

  _pickRefundText(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return this._decodeGoodsText(value);
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      }
    }
    return '';
  }

  _pickRefundNumber(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const numeric = Number(source[key]);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
      }
    }
    return 0;
  }

  _pickRefundBoolean(sources = [], keys = []) {
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

  _resolveRefundOrderShippingInfo(sources = []) {
    const trackingNo = this._pickRefundText(sources, [
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
    const shippingStateText = this._pickRefundText(sources, [
      'refund_shipping_state',
      'shippingState',
      'shipping_state',
    ]);
    const shippingStatusText = this._pickRefundText(sources, [
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
    const shippedFlag = this._pickRefundBoolean(sources, [
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
    const unshippedFlag = this._pickRefundBoolean(sources, [
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

  _resolveRefundOrderStatusText(sources = []) {
    return this._pickRefundText(sources, [
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

  _isRefundOrderEligible(order = {}) {
    const mergedStatusText = [
      order?.orderStatusText,
      order?.shippingStatusText,
      order?.shippingState,
    ].filter(Boolean).join(' ').replace(/\s+/g, '');
    if (!mergedStatusText) {
      return order?.shippingState === 'unshipped' || order?.shippingState === 'shipped';
    }
    if (/(待支付|待付款|未支付|未付款|付款中|待成团|未成团)/.test(mergedStatusText)) {
      return false;
    }
    if (/(已签收|已收货|交易成功|已完成|已关闭|已取消|退款成功|已退款|售后完成|退款中止)/.test(mergedStatusText)) {
      return false;
    }
    return /(待发货|未发货|待揽收|待出库|待配送|未揽件|待收货|已发货|运输中|派送中|配送中|揽收|物流)/.test(mergedStatusText)
      || order?.shippingState === 'unshipped'
      || order?.shippingState === 'shipped';
  }

  _filterEligibleRefundOrders(orders = []) {
    return (Array.isArray(orders) ? orders : []).filter(order => this._isRefundOrderEligible(order));
  }

  _normalizeRefundShippingBenefitStatus(value, { legacyGifted = false } = {}) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value === 0) return '未赠送';
      if (value === 1) return legacyGifted ? '已赠送' : '商家承担';
      if (value === 2) return '包运费';
      return String(value);
    }
    const text = String(value || '').trim();
    if (!text) return '';
    const normalized = text.toLowerCase();
    if (['0', 'false', 'no', 'n', 'unshipped', 'not_gifted', 'none', '未赠送'].includes(normalized)) {
      return '未赠送';
    }
    if (legacyGifted && ['1', 'true', 'yes', 'y', 'shipped', 'gifted', 'presented', '已赠送'].includes(normalized)) {
      return '已赠送';
    }
    if (['1', '商家承担'].includes(normalized)) {
      return '商家承担';
    }
    if (['2', '包运费'].includes(normalized)) {
      return '包运费';
    }
    if (['已赠送'].includes(normalized)) {
      return legacyGifted ? '已赠送' : text;
    }
    return text;
  }

  _resolveRefundShippingBenefitText(sources = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const compensateCandidates = [
        source.compensate,
        source.compensateInfo,
        source.pendingCompensate,
      ];
      for (const candidate of compensateCandidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const hasStatusKey = ['status', 'compensateStatus', 'compensate_status']
          .some(key => Object.prototype.hasOwnProperty.call(candidate, key));
        if (hasStatusKey && candidate.status === null) {
          return '未赠送';
        }
        if (hasStatusKey && candidate.compensateStatus === null) {
          return '未赠送';
        }
        if (hasStatusKey && candidate.compensate_status === null) {
          return '未赠送';
        }
        const statusText = this._normalizeRefundShippingBenefitStatus(
          candidate.status ?? candidate.compensateStatus ?? candidate.compensate_status,
        );
        if (statusText) return statusText;
        const directText = this._normalizeRefundShippingBenefitStatus(
          candidate.text ?? candidate.desc ?? candidate.note,
        );
        if (directText) return directText;
      }
      const tagLists = [
        source.workbenchOrderTagNew,
        source.workbench_order_tag_new,
        source.workbenchOrderTag,
        source.workbench_order_tag,
      ];
      for (const tagList of tagLists) {
        if (!Array.isArray(tagList) || !tagList.length) continue;
        for (const tag of tagList) {
          if (!tag || typeof tag !== 'object') continue;
          const labelText = String(tag.text ?? tag.label ?? tag.name ?? tag.desc ?? '').trim();
          const matched = /退货包运费|包运费/.test(labelText) || Number(tag.type) === 2;
          if (!matched) continue;
          const statusText = this._normalizeRefundShippingBenefitStatus(
            tag.status ?? tag.statusText ?? tag.status_text ?? tag.value,
          );
          if (statusText) return statusText;
        }
      }
    }
    const freightResponsibilityText = this._pickRefundText(sources, [
      'freightResponsibilityText',
      'freight_responsibility_text',
      'freightResponsibilityDesc',
      'freight_responsibility_desc',
      'freightResponsibility',
      'freight_responsibility',
    ]);
    const normalizedFreightResponsibilityText = this._normalizeRefundShippingBenefitStatus(freightResponsibilityText);
    if (normalizedFreightResponsibilityText) {
      return normalizedFreightResponsibilityText;
    }
    const rawText = this._pickRefundText(sources, [
      'refundShippingText',
      'refund_shipping_text',
      'refundShippingDesc',
      'refund_shipping_desc',
      'refundShippingStateDesc',
      'refund_shipping_state_desc',
      'refundShippingStatusDesc',
      'refund_shipping_status_desc',
      'refundShippingBenefitText',
      'refund_shipping_benefit_text',
      'refundShippingBenefitDesc',
      'refund_shipping_benefit_desc',
      'refundShippingBenefitStateDesc',
      'refund_shipping_benefit_state_desc',
      'refundShippingInsuranceText',
      'refund_shipping_insurance_text',
      'refundShippingInsuranceDesc',
      'refund_shipping_insurance_desc',
      'refundShippingInsuranceStateDesc',
      'refund_shipping_insurance_state_desc',
      'refundShippingInsuranceStatusDesc',
      'refund_shipping_insurance_status_desc',
      'refundShippingState',
      'refund_shipping_state',
      'refundShippingBenefit',
      'refund_shipping_benefit',
      'refundShippingInsurance',
      'refund_shipping_insurance',
    ]);
    const text = this._normalizeRefundShippingBenefitStatus(rawText, { legacyGifted: true });
    if (text) {
      return text;
    }
    const giftedFlag = this._pickRefundBoolean(sources, [
      'refundShippingBenefit',
      'refund_shipping_benefit',
      'refundShippingInsurance',
      'refund_shipping_insurance',
      'refundShippingGifted',
      'refund_shipping_gifted',
      'refundShippingInsured',
      'refund_shipping_insured',
      'hasRefundShippingBenefit',
      'has_refund_shipping_benefit',
      'hasRefundShippingInsurance',
      'has_refund_shipping_insurance',
    ]);
    if (giftedFlag === true) return '已赠送';
    if (giftedFlag === false) return '未赠送';
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const [key, value] of Object.entries(source)) {
        if (!key || value === undefined || value === null) continue;
        const keyText = String(key).toLowerCase();
        const freightResponsibilityMatched = /freight.*responsibility|responsibility.*freight|freight_responsibility/i.test(keyText);
        if (freightResponsibilityMatched) {
          const normalizedValue = this._normalizeRefundShippingBenefitStatus(value);
          if (normalizedValue) return normalizedValue;
        }
        const keyMatched = /(refund.*ship|ship.*refund|refund_shipping|shipping_refund)/i.test(keyText)
          && /(benefit|insurance|state|status|desc|text)/i.test(keyText);
        if (!keyMatched) continue;
        if (typeof value === 'boolean') {
          return value ? '已赠送' : '未赠送';
        }
        const normalizedValue = this._normalizeRefundShippingBenefitStatus(value, { legacyGifted: true });
        if (normalizedValue) return normalizedValue;
      }
    }
    return '';
  }

  _looksLikeRefundOrderNode(node = {}) {
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

  _collectRefundOrderNodes(node, bucket, visited, depth = 0) {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) {
      node.slice(0, 30).forEach(item => this._collectRefundOrderNodes(item, bucket, visited, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (this._looksLikeRefundOrderNode(node)) {
      bucket.push(node);
    }
    Object.values(node).forEach(value => {
      if (value && typeof value === 'object') {
        this._collectRefundOrderNodes(value, bucket, visited, depth + 1);
      }
    });
  }

  _normalizeRefundOrder(item = {}, fallback = {}, index = 0) {
    const sources = [
      item,
      item?.raw,
      item?.orderGoodsList,
      item?.order_goods_list,
      item?.goods_info,
      item?.goodsInfo,
      item?.goods,
      item?.order_info,
      item?.orderInfo,
      item?.logistics_info,
      item?.logisticsInfo,
      item?.logistics,
      item?.delivery_info,
      item?.deliveryInfo,
      item?.delivery,
      item?.express_info,
      item?.expressInfo,
      item?.express,
      item?.shipping_info,
      item?.shippingInfo,
      item?.shipping,
      item?.transport_info,
      item?.transportInfo,
      item?.transport,
      item?.raw?.logistics_info,
      item?.raw?.logisticsInfo,
      item?.raw?.logistics,
      item?.raw?.delivery_info,
      item?.raw?.deliveryInfo,
      item?.raw?.delivery,
      item?.raw?.express_info,
      item?.raw?.expressInfo,
      item?.raw?.express,
      item?.raw?.shipping_info,
      item?.raw?.shippingInfo,
      item?.raw?.shipping,
      fallback?.goodsInfo,
      fallback?.raw?.goods_info,
      fallback?.raw?.goods,
      fallback?.raw,
      fallback,
    ].filter(Boolean);
    const orderId = this._pickRefundText(sources, ['order_id', 'order_sn', 'orderSn', 'parent_order_sn', 'mall_order_sn', 'orderId'])
      || String(fallback?.orderId || '').trim();
    const title = this._pickRefundText(sources, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'item_title', 'itemTitle', 'goodsName', 'title'])
      || fallback?.title
      || `订单 ${index + 1}`;
    const imageUrl = this._pickRefundText(sources, ['imageUrl', 'image_url', 'thumb_url', 'hd_thumb_url', 'goods_thumb_url', 'thumbUrl', 'hdThumbUrl', 'goodsThumbUrl', 'pic_url', 'thumbUrl']);
    const amountText = this._normalizeRefundAmountByKeys(sources, ['order_amount', 'orderAmount', 'pay_amount', 'refund_amount', 'amount', 'order_price', 'price'])
      || this._pickRefundText(sources, ['priceText', 'price_text'])
      || this._normalizeGoodsPrice(this._pickRefundNumber(sources, ['goodsPrice', 'min_price', 'group_price']))
      || '待确认';
    const quantityValue = this._pickRefundText(sources, ['quantity', 'num', 'count', 'goods_count', 'goodsNumber', 'buy_num', 'buyNum']);
    const specText = this._pickRefundText(sources, ['specText', 'spec_text', 'spec', 'sku_spec', 'skuSpec', 'spec_desc', 'specDesc', 'sub_name', 'subName']);
    const normalizedQuantity = String(quantityValue || '').replace(/^x/i, '').trim();
    const detailText = normalizedQuantity && specText
      ? `${specText} x${normalizedQuantity}`
      : (specText || (normalizedQuantity ? `x${normalizedQuantity}` : '所拍规格待确认'));
    const shippingInfo = this._resolveRefundOrderShippingInfo(sources);
    const orderStatusText = this._resolveRefundOrderStatusText(sources);
    return {
      key: `${orderId || 'order'}::${title}::${index}`,
      orderId: orderId || '-',
      title,
      imageUrl,
      amountText,
      detailText,
      orderStatusText,
      trackingNo: shippingInfo.trackingNo,
      shippingState: shippingInfo.shippingState,
      shippingStatusText: shippingInfo.shippingStatusText,
      isShipped: shippingInfo.isShipped,
      raw: item,
    };
  }

  _dedupeRefundOrders(list = [], fallback = {}) {
    const deduped = [];
    const seen = new Set();
    list.forEach((item, index) => {
      const normalized = this._normalizeRefundOrder(item, fallback, index);
      if (!normalized.orderId || normalized.orderId === '-') return;
      const signature = [normalized.orderId, normalized.title, normalized.imageUrl, normalized.amountText].join('::');
      if (!signature.replace(/[:\-]/g, '')) return;
      if (seen.has(signature)) return;
      seen.add(signature);
      deduped.push(normalized);
    });
    if (!deduped.length) {
      const fallbackOrder = this._normalizeRefundOrder(fallback, fallback, 0);
      if (fallbackOrder.orderId && fallbackOrder.orderId !== '-') {
        deduped.push(fallbackOrder);
      }
    }
    return deduped;
  }

  _extractRefundOrdersFromMessages(sessionMeta = {}, messages = []) {
    const bucket = [];
    const visited = new WeakSet();
    (Array.isArray(messages) ? messages : []).forEach(message => {
      this._collectRefundOrderNodes(message?.extra, bucket, visited);
      this._collectRefundOrderNodes(message?.raw?.extra, bucket, visited);
      this._collectRefundOrderNodes(message?.raw, bucket, visited);
    });
    return bucket.map((item, index) => this._normalizeRefundOrder(item, sessionMeta, index));
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
    if (!value) return '';
    if (Array.isArray(value)) {
      const texts = value
        .map(item => this._extractAfterSalesStatusText(item))
        .filter(Boolean);
      return [...new Set(texts)].join(' / ');
    }
    if (typeof value !== 'object') return '';
    const text = this._pickRefundText([value], [
      'statusDesc',
      'status_desc',
      'aftersaleStatusDesc',
      'afterSalesStatusDesc',
      'aftersale_status_desc',
      'after_sales_status_desc',
      'typeDesc',
      'type_desc',
      'afterSalesTypeDesc',
      'after_sales_type_desc',
      'buttonDesc',
      'button_desc',
      'label',
      'desc',
    ]);
    return text || '';
  }

  _extractAfterSalesDetail(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      const candidates = value
        .map(item => this._extractAfterSalesDetail(item))
        .filter(Boolean)
        .sort((left, right) => {
          const timeDiff = Number(right?._afterSalesSortTime || 0) - Number(left?._afterSalesSortTime || 0);
          if (timeDiff) return timeDiff;
          return Number(right?._afterSalesScore || 0) - Number(left?._afterSalesScore || 0);
        });
      if (!candidates.length) return null;
      return candidates[0];
    }
    if (typeof value !== 'object') return null;
    const nestedLists = [
      value.list,
      value.afterSalesList,
      value.after_sales_list,
      value.records,
      value.items,
    ];
    for (const nested of nestedLists) {
      if (!Array.isArray(nested) || !nested.length) continue;
      const nestedDetail = this._extractAfterSalesDetail(nested);
      if (nestedDetail) return nestedDetail;
    }
    const detail = this._cloneJson(value);
    const statusText = this._pickDisplayAfterSalesStatus([detail]) || this._extractAfterSalesStatusText(detail);
    const afterSalesId = this._pickRefundText([detail], [
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
    const sortTime = this._pickRefundNumber([detail], [
      'updatedAt',
      'updated_at',
      'updateTime',
      'update_time',
      'modifiedAt',
      'modified_at',
      'createdAt',
      'created_at',
      'createTime',
      'create_time',
      'applyTime',
      'apply_time',
    ]);
    const score = (statusText ? 20 : 0) + (afterSalesId ? 10 : 0) + (sortTime ? 5 : 0);
    if (!score) return null;
    return {
      ...detail,
      afterSalesStatus: detail.afterSalesStatus || detail.after_sales_status_desc || detail.afterSalesStatusDesc || statusText || '',
      _afterSalesSortTime: sortTime,
      _afterSalesScore: score,
    };
  }

  _mapAfterSalesStatusCodeToText(value) {
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

  _pickDisplayAfterSalesStatus(sources = []) {
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
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const descText = this._pickRefundText([source], descKeys);
      if (descText) return descText;
      const hasAfterSalesContext = descKeys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '')
        || statusKeys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '');
      if (!hasAfterSalesContext) continue;
      const scopedText = this._pickRefundText([source], ['statusDesc', 'status_desc', 'label', 'desc']);
      if (scopedText && !/^\d+$/.test(scopedText)) return scopedText;
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const statusText = this._pickRefundText([source], statusKeys);
      if (statusText && !/^\d+$/.test(statusText)) return statusText;
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const statusCode = this._pickRefundText([source], statusKeys);
      const mappedText = this._mapAfterSalesStatusCodeToText(statusCode);
      if (mappedText) return mappedText;
    }
    return '';
  }

  _mergeSideOrderStatusTexts(primary = '', secondary = '') {
    const primaryText = typeof primary === 'string' ? primary.trim() : '';
    const secondaryText = typeof secondary === 'string' ? secondary.trim() : '';
    if (!primaryText) return secondaryText;
    if (!secondaryText) return primaryText;
    const normalize = text => String(text || '').replace(/[，,、/\s]+/g, '');
    if (normalize(primaryText) === normalize(secondaryText)) {
      return primaryText;
    }
    return [primaryText, secondaryText].join('，');
  }

  _extractAfterSalesDetailMapFromPayload(payload = {}) {
    const map = payload?.result?.orderSn2AfterSalesListMap;
    if (!map || typeof map !== 'object') return {};
    const detailMap = {};
    Object.entries(map).forEach(([orderSn, list]) => {
      const detail = this._extractAfterSalesDetail(list);
      if (detail) {
        const { _afterSalesSortTime, _afterSalesScore, ...normalizedDetail } = detail;
        detailMap[String(orderSn)] = normalizedDetail;
        return;
      }
      const text = this._extractAfterSalesStatusText(list);
      if (text) {
        detailMap[String(orderSn)] = {
          afterSalesStatus: text,
        };
      }
    });
    return detailMap;
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
    const candidates = [
      sessionMeta?.customerId,
      sessionMeta?.userUid,
      sessionMeta?.raw?.customer_id,
      sessionMeta?.raw?.buyer_id,
      sessionMeta?.raw?.uid,
      sessionMeta?.raw?.to?.uid,
      sessionMeta?.raw?.user_info?.uid,
    ].map(value => String(value || '').trim()).filter(Boolean);
    return candidates[0] || '';
  }

  async _requestRefundOrderPageApi(url, body) {
    if (typeof this._requestInPddPage === 'function') {
      return this._requestInPddPage({
        method: 'POST',
        url,
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
    const normalized = String(type || '').trim();
    if (!normalized || normalized === 'refund' || normalized === '1') {
      return 1;
    }
    if (normalized === 'returnRefund') {
      throw new Error('当前仅已接通“退款”申请接口，请继续抓取“退货退款”提交请求后再补齐');
    }
    if (normalized === 'resend') {
      throw new Error('当前仅已接通“退款”申请接口，请继续抓取“补寄”提交请求后再补齐');
    }
    throw new Error('暂不支持当前申请类型');
  }

  _normalizeRefundApplyShipStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (['2', 'received', '已收到货'].includes(normalized)) return 2;
    if (['1', 'not_received', '未收到货', ''].includes(normalized)) return 1;
    return 1;
  }

  _resolveRefundApplyQuestionType(params = {}) {
    const directCode = Number(params?.questionType ?? params?.question_type);
    if (Number.isFinite(directCode) && directCode > 0) {
      return directCode;
    }
    const reasonText = String(params?.reasonText || params?.reason || '').trim();
    const knownMap = {
      '不喜欢、效果不好': 103,
      '不喜欢': 103,
      '其他原因': 111,
    };
    if (knownMap[reasonText]) {
      return knownMap[reasonText];
    }
    throw new Error(`退款原因“${reasonText || '未选择'}”暂未完成真实接口映射，请先使用“不喜欢、效果不好”或继续抓取该原因的请求体`);
  }

  _buildRefundApplyReposeInfo(params = {}) {
    const raw = params?.reposeInfo && typeof params.reposeInfo === 'object' ? params.reposeInfo : {};
    return {
      userName: raw.userName ?? null,
      mobile: raw.mobile ?? null,
      provinceId: raw.provinceId ?? null,
      provinceName: raw.provinceName ?? null,
      cityId: raw.cityId ?? null,
      cityName: raw.cityName ?? null,
      districtId: raw.districtId ?? null,
      districtName: raw.districtName ?? null,
      address: raw.address ?? null,
      isApply: Boolean(raw.isApply),
      inGray: raw.inGray === undefined ? true : Boolean(raw.inGray),
      orderSn: raw.orderSn ?? null,
      mallId: raw.mallId ?? null,
      uid: raw.uid ?? null,
    };
  }

  _resolveRefundApplyReposeInfo(infoPayload = {}, params = {}) {
    const info = infoPayload?.result && typeof infoPayload.result === 'object'
      ? infoPayload.result
      : (infoPayload && typeof infoPayload === 'object' ? infoPayload : {});
    const infoReposeInfo = info?.reposeInfo && typeof info.reposeInfo === 'object' ? info.reposeInfo : {};
    return this._buildRefundApplyReposeInfo({
      reposeInfo: {
        userName: infoReposeInfo.userName ?? info.userName ?? null,
        mobile: infoReposeInfo.mobile ?? info.mobile ?? info.phone ?? null,
        provinceId: infoReposeInfo.provinceId ?? info.provinceId ?? null,
        provinceName: infoReposeInfo.provinceName ?? info.provinceName ?? null,
        cityId: infoReposeInfo.cityId ?? info.cityId ?? null,
        cityName: infoReposeInfo.cityName ?? info.cityName ?? null,
        districtId: infoReposeInfo.districtId ?? info.districtId ?? null,
        districtName: infoReposeInfo.districtName ?? info.districtName ?? null,
        address: infoReposeInfo.address ?? info.address ?? null,
        isApply: infoReposeInfo.isApply ?? info.isApply ?? false,
        inGray: infoReposeInfo.inGray ?? info.inGray ?? true,
        orderSn: infoReposeInfo.orderSn ?? info.orderSn ?? params?.orderSn ?? params?.order_sn ?? null,
        mallId: infoReposeInfo.mallId ?? info.mallId ?? null,
        uid: infoReposeInfo.uid ?? info.uid ?? null,
        ...(params?.reposeInfo && typeof params.reposeInfo === 'object' ? params.reposeInfo : {}),
      },
    });
  }

  _normalizeRefundApplyFlag(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
    return defaultValue;
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
    const submitTemplate = this._getLatestSmallPaymentSubmitTemplate(normalizedOrderSn);
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

  _normalizeSmallPaymentRefundType(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('缺少打款类型');
    }
    if (['other', '其他', '2'].includes(normalized)) {
      return 2;
    }
    if (['difference', '补差价'].includes(normalized)) {
      throw new Error('当前尚未确认“补差价”的真实 refundType 映射，请先继续抓取一次该类型请求');
    }
    if (['shipping', '补运费'].includes(normalized)) {
      throw new Error('当前尚未确认“补运费”的真实 refundType 映射，请先继续抓取一次该类型请求');
    }
    if (['0', '1'].includes(normalized)) {
      return Number(normalized);
    }
    throw new Error(`暂不支持的打款类型：${value}`);
  }

  async submitSmallPayment(params = {}) {
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const refundType = this._normalizeSmallPaymentRefundType(
      params?.refundType ?? params?.refund_type ?? params?.type
    );
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
    const chargeType = Number.isFinite(Number(params?.chargeType))
      ? Math.max(0, Math.round(Number(params.chargeType)))
      : Math.max(0, Number(
        templateBody?.chargeType
        ?? templateBody?.charge_type
        ?? info?.channel
        ?? 4
      ) || 0);
    const requestBody = {
      orderSn: normalizedOrderSn,
      playMoneyAmount,
      refundType,
      remarks,
      chargeType,
    };
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

  async _resolveInviteOrderSelection(uid, goodsId, goodsList = []) {
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
    const targetSku = skuList.find(item => Number(item?.isOnsale) === 1 && Number(item?.quantity || 0) > 0)
      || skuList.find(item => Number(item?.isOnsale) === 1)
      || skuList[0];
    if (!targetSku?.skuId) {
      throw new Error('该商品暂无可邀请规格');
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
    const specText = Array.isArray(targetSku?.specs)
      ? targetSku.specs
        .map(item => `${item?.specKey || ''}${item?.specValue ? `:${item.specValue}` : ''}`.trim())
        .filter(Boolean)
        .join(' ')
      : '';
    return {
      goodsId: Number(goodsId),
      skuId: Number(targetSku.skuId),
      goodsNumber: Number(promoItem?.goodsNumber || 1),
      skuPrice: Number(promoItem?.skuPrice || skuPrice || 0),
      promoPrice: Number(promoItem?.promoPrice || skuPrice || 0),
      title: String(goodsInfo?.title || result?.goodsName || '').trim(),
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
      const selection = await this._resolveInviteOrderSelection(uid, goodsId, state.goodsList);
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
    const panelText = String(debug?.panelText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return [
      cardActionText ? `cardActions=${cardActionText}` : '',
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
      `);
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
    `);
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
    `);
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
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
  }

  _extractOrderRemarkText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value.map(item => this._extractOrderRemarkText(item)).filter(Boolean).join('\n').trim();
    }
    if (typeof value !== 'object') return '';
    return this._pickRefundText([value], [
      'note',
      'content',
      'text',
      'remark',
      'desc',
      'message',
      'value',
    ]);
  }

  _normalizeOrderRemarkTag(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized) return '';
    if (['0', 'NULL', 'UNDEFINED', 'FALSE', 'NONE'].includes(normalized)) {
      return '';
    }
    return normalized;
  }

  _isOrderRemarkSaveIntervalError(error) {
    const message = String(error?.message || error || '').trim();
    if (!message) return false;
    return /两次备注间隔时长需大于1秒|备注间隔时长需大于1秒|间隔时长需大于1秒/.test(message);
  }

  _isOrderRemarkSaveMatched(remark = {}, note = '', tag = '') {
    return this._extractOrderRemarkText(remark?.note) === this._extractOrderRemarkText(note)
      && this._normalizeOrderRemarkTag(remark?.tag) === this._normalizeOrderRemarkTag(tag);
  }

  _maskOrderRemarkOrderSn(orderSn) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) return '';
    if (normalizedOrderSn.length <= 8) return normalizedOrderSn;
    return `${normalizedOrderSn.slice(0, 4)}***${normalizedOrderSn.slice(-4)}`;
  }

  _summarizeOrderRemarkRequest(urlPath, body = {}, via = 'direct') {
    const normalizedNote = this._extractOrderRemarkText(body?.note);
    return {
      urlPath: String(urlPath || ''),
      via,
      orderSn: this._maskOrderRemarkOrderSn(body?.orderSn),
      hasNote: normalizedNote.length > 0,
      noteLength: normalizedNote.length,
      tag: this._normalizeOrderRemarkTag(body?.tag),
      source: Number(body?.source) > 0 ? Number(body.source) : 1,
    };
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
    const normalizedTag = this._normalizeOrderRemarkTag(tag);
    if (!normalizedTag) return '';
    const cachedName = this._orderRemarkTagOptionsCache?.[normalizedTag];
    if (cachedName) return String(cachedName).trim();
    return ORDER_REMARK_TAG_LABELS[normalizedTag] || '';
  }

  _formatOrderRemarkMeta(value = Date.now()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
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
    const source = payload?.result && typeof payload.result === 'object'
      ? payload.result
      : (payload && typeof payload === 'object' ? payload : {});
    const entries = Object.entries(source)
      .map(([value, label]) => [String(value || '').trim().toUpperCase(), String(label || '').trim()])
      .filter(([value, label]) => value && label);
    const preferredOrder = ['RED', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE'];
    const ordered = [
      ...preferredOrder.filter(key => entries.some(([value]) => value === key)),
      ...entries.map(([value]) => value).filter(value => !preferredOrder.includes(value)),
    ];
    return ordered.reduce((result, key) => {
      const matched = entries.find(([value]) => value === key);
      if (matched) result[key] = matched[1];
      return result;
    }, {});
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

  async getSessionMessages(sessionRef, page = 1, pageSize = 30) {
    if (!this._sessionInited) {
      await this.initSession();
    }

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
      return templateBody
        ? {
            ...this._cloneJson(templateBody),
            data: {
              ...(templateBody.data || {}),
              request_id: this._nextRequestId(),
              cmd: templateBody.data?.cmd || 'list',
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
        const payload = await this._post('/plateau/chat/list', requestBody);
        const messages = this._parseMessages(payload);
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
        this._log('[API] chat/list 候选失败', {
          candidateId: candidate.id,
          candidateRole: candidate.role,
          message: error.message,
        });
      }
    }
    for (const entry of cachedEntries) {
      const cachedPayload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
      if (!cachedPayload) continue;
      const cachedMessages = this._parseMessages(cachedPayload);
      if (cachedMessages.length > 0) {
        this._log('[API] chat/list 回退页面抓取缓存', {
          sessionId: String(sessionMeta.sessionId || ''),
          count: cachedMessages.length,
        });
        return cachedMessages;
      }
    }
    if (lastError) {
      throw lastError;
    }
    return fallbackMessages;
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

  async testConnection() {
    const steps = [];
    const sessionInit = await this.initSession(true);
    steps.push({ step: 'initSession', ok: !!sessionInit.initialized, detail: sessionInit });

    const userInfo = await this.getUserInfo();
    steps.push({ step: 'getUserInfo', ok: true, detail: userInfo });

    const sessions = await this.getSessionList(1, 5);
    steps.push({ step: 'getSessionList', ok: true, detail: { count: sessions.length } });

    return {
      ok: true,
      tokenStatus: this.getTokenStatus(),
      userInfo,
      sessions,
      steps,
    };
  }

  async _pollMessagesForSession(sessionRef, options = {}) {
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const messages = await this.getSessionMessages(sessionMeta.sessionId || sessionRef, 1, 20);
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
      const sessions = await this.getSessionList(1, 20);
      this.emit('sessionUpdated', sessions);

      const targets = sessions
        .filter(item => item.sessionId)
        .sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0))
        .slice(0, 5);

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
    const tokenMissing = shop?.loginMethod === 'token' && !tokenInfo?.raw;
    let serviceProfile = null;
    if (tokenInfo?.raw) {
      try {
        serviceProfile = await this.getServiceProfile();
      } catch {}
    }
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
      mallName: serviceProfile?.mallName || this._getShopInfo()?.name || '',
      serviceName: serviceProfile?.serviceName || '',
      serviceAvatar: serviceProfile?.serviceAvatar || '',
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
