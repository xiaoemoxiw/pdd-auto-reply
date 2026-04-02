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
    this._sessionCache = [];
    this._bootstrapTraffic = [];
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._requestInPddPage = options.requestInPddPage || null;
    this._executeInPddPage = options.executeInPddPage || null;
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
    try {
      return JSON.parse(text);
    } catch {
      return null;
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
    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const shop = this._getShopInfo();
    const mallId = this._getMallId();
    const template = this._getLatestMessageTemplate(sessionMeta) || {};
    const buyerInfo = this._getLatestBuyerInfo(sessionMeta);
    const targetUid = String(sessionMeta.userUid || sessionMeta.customerId || sessionMeta.sessionId || '');
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

  _getMessageActor(item = {}) {
    if (this._isSystemNoticeText(this._extractMessageText(item))) return 'system';
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
    const waitValue = Number(session?.waitTime || 0);
    if (Number.isFinite(waitValue) && waitValue > 0) return true;
    if (session?.isTimeout) return true;
    return Number(session?.unreadCount || 0) > 0;
  }

  _filterDisplaySessions(sessions = []) {
    return sessions.filter(session => (
      this._isTodayTimestamp(session?.lastMessageTime)
      || this._isTodayTimestamp(session?.createdAt)
      || this._hasPendingReplySession(session)
    ));
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
      return {
      sessionId: identity.sessionId,
      explicitSessionId: identity.explicitSessionId,
      conversationId: identity.conversationId,
      chatId: identity.chatId,
      rawId: identity.rawId,
      customerId: identity.customerId,
      userUid: identity.userUid,
      customerName: item.nick || item.nickname || item.buyer_name || item.customer_name || item.name || item?.user_info?.nickname || '未知客户',
      customerAvatar: item.avatar || item.head_img || item.buyer_avatar || item?.user_info?.avatar || '',
      lastMessage: this._extractSessionPreviewText(item),
      lastMessageTime: this._extractSessionPreviewTime(item),
      createdAt: this._extractSessionCreatedTime(item),
      unreadCount: item.unread_count || item.unread || item.unread_num || item?.context?.unread || 0,
      isTimeout: item.is_timeout || item.timeout || false,
      waitTime: item.wait_time || item.waiting_time || item.last_unreply_time || 0,
      orderId: item.order_id || item.order_sn || '',
      goodsInfo: item.goods_info || item.goods || null,
      csUid: item?.from?.cs_uid || '',
      mallId: item?.from?.mall_id || '',
      raw: item,
    }});
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
    return {
      goodsId,
      title: title.replace(/\s*-\s*拼多多.*$/i, '').trim(),
      imageUrl,
      priceText,
      groupText: /^\d+$/.test(groupText) ? `${groupText}人团` : groupText,
      specText: fallback.specText || '查看商品规格',
    };
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
      senderName: item.nick || item.nickname || item.sender_name || item.from_name || item?.from?.csid || '',
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

  _resolveRefundShippingBenefitText(sources = []) {
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
    const text = String(rawText || '').trim();
    if (text) {
      const normalized = text.toLowerCase();
      if (['0', 'false', 'no', 'n', 'unshipped', 'not_gifted', 'none'].includes(normalized) || text === '未赠送') {
        return '未赠送';
      }
      if (['1', 'true', 'yes', 'y', 'shipped', 'gifted', 'presented'].includes(normalized) || text === '已赠送') {
        return '已赠送';
      }
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
        const keyMatched = /(refund.*ship|ship.*refund|refund_shipping|shipping_refund)/i.test(keyText)
          && /(benefit|insurance|state|status|desc|text)/i.test(keyText);
        if (!keyMatched) continue;
        if (typeof value === 'string') {
          const candidate = value.trim();
          if (!candidate) continue;
          if (/(已赠送|未赠送)/.test(candidate)) return candidate;
        } else if (typeof value === 'boolean') {
          return value ? '已赠送' : '未赠送';
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          if (value === 0) return '未赠送';
          if (value === 1) return '已赠送';
        }
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
    return {
      key: `${orderId || 'order'}::${title}::${index}`,
      orderId: orderId || '-',
      title,
      imageUrl,
      amountText,
      detailText,
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

  async _fetchAfterSalesStatusMap(orderSns = []) {
    const validOrderSns = [...new Set((Array.isArray(orderSns) ? orderSns : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!validOrderSns.length) return {};
    const antiContent = this._getLatestAntiContent();
    const payload = await this._requestRefundOrderPageApi('/mercury/chat/afterSales/queryList', antiContent
      ? { orderSns: validOrderSns, anti_content: antiContent }
      : { orderSns: validOrderSns });
    const map = payload?.result?.orderSn2AfterSalesListMap;
    if (!map || typeof map !== 'object') return {};
    const statusMap = {};
    Object.entries(map).forEach(([orderSn, list]) => {
      const text = this._extractAfterSalesStatusText(list);
      if (text) statusMap[String(orderSn)] = text;
    });
    return statusMap;
  }

  async _attachAfterSalesStatus(orders = []) {
    const orderSns = orders.map(item => String(item?.orderId || item?.orderSn || '').trim()).filter(Boolean);
    if (!orderSns.length) return orders;
    let statusMap = {};
    try {
      statusMap = await this._fetchAfterSalesStatusMap(orderSns);
    } catch (error) {
      this._log('[API] 售后状态查询失败', { message: error.message });
    }
    return orders.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || '').trim();
      return {
        ...order,
        afterSalesStatus: statusMap[orderSn] || '',
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

  async _extractRefundOrdersFromPageApis(sessionMeta = {}) {
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
    const normalized = await this._attachAfterSalesStatus(this._dedupeRefundOrders(orders, sessionMeta));
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
      return this._attachAfterSalesStatus(this._dedupeRefundOrders(
        unshippedOrders.map(item => ({
          ...(item || {}),
          refund_shipping_state: 'unshipped',
        })),
        sessionMeta
      ));
    }
    return [];
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

  async getRefundOrders(sessionRef) {
    const sessionMeta = this._normalizeSessionMeta(sessionRef);
    try {
      const pageOrders = await this._extractRefundOrdersFromPageApis(sessionMeta);
      if (Array.isArray(pageOrders)) {
        return pageOrders;
      }
    } catch (error) {
      this._log('[API] 售后订单接口查询失败', { message: error.message });
    }
    try {
      const domOrders = await this._extractRefundOrdersFromDom(sessionMeta);
      const normalizedDomOrders = this._dedupeRefundOrders(domOrders, sessionMeta);
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
    return this._dedupeRefundOrders(merged, sessionMeta);
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
    const afterSalesStatus = this._pickRefundText(sources, ['afterSalesStatus', 'after_sales_status', 'afterSalesStatusDesc', 'after_sales_status_desc']);
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
      return [orderStatusText, afterSalesStatus].filter(Boolean).join('，') || afterSalesStatus || orderStatusText || '售后处理中';
    }
    if (tab === 'pending') {
      return [orderStatusText, compensateText].filter(Boolean).join('，') || orderStatusText || '店铺待支付';
    }
    return [orderStatusText, afterSalesStatus].filter(Boolean).join('，') || orderStatusText || '订单状态待确认';
  }

  _buildSideOrderMetaRows(tab = 'personal', sources = []) {
    const rows = [];
    const orderTimeText = this._formatSideOrderDateTime(this._pickRefundNumber(sources, ['orderTime', 'order_time', 'createdAt', 'created_at']));
    const afterSalesStatus = this._pickRefundText(sources, ['afterSalesStatus', 'after_sales_status', 'afterSalesStatusDesc', 'after_sales_status_desc']);
    const compensateText = this._pickRefundText(sources, [
      'pendingCompensateText',
      'pending_compensate_text',
      'detail',
      'text',
      'desc',
    ]);
    const refundShippingBenefitText = this._resolveRefundShippingBenefitText(sources);
    const shippingInfo = this._resolveRefundOrderShippingInfo(sources);
    if (orderTimeText) {
      rows.push({ label: '下单时间', value: orderTimeText });
    }
    if (afterSalesStatus) {
      rows.push({ label: '售后状态', value: afterSalesStatus });
    }
    if (tab === 'pending' && compensateText) {
      rows.push({ label: '待支付说明', value: compensateText });
    } else if (refundShippingBenefitText) {
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
      for (const key of ['manualDiscount', 'merchantDiscount', 'discountAmount', 'totalDiscount']) {
        if (source[key] === undefined || source[key] === null || source[key] === '') continue;
        const numeric = Number(source[key]);
        if (Number.isFinite(numeric) && numeric >= 0) {
          return this._formatSideOrderAmount(numeric, { negative: true });
        }
      }
    }
    return '-¥0.00';
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

  _buildSideOrderActionTags(tab = 'personal', sources = []) {
    const tags = ['备注'];
    const shippingInfo = this._resolveRefundOrderShippingInfo(sources);
    if (shippingInfo.isShipped || shippingInfo.trackingNo) {
      tags.push('物流信息');
    }
    if (tab === 'pending') {
      tags.push('小额打款');
    }
    if (this._pickRefundBoolean(sources, ['showGoodsInstructEntrance', 'show_goods_instruct_entrance'])) {
      tags.push('查看说明书');
    }
    if (this._pickRefundBoolean(sources, ['showExtraPackageTool', 'show_extra_package_tool'])) {
      tags.push('新增额外包裹');
    }
    const statusText = this._pickRefundText(sources, ['orderStatusStr', 'order_status_str']);
    if (tab === 'pending' || /待支付/.test(statusText)) {
      tags.push('改价');
    }
    return [...new Set(tags)].slice(0, 6);
  }

  _normalizeSideOrderCard(item = {}, fallback = {}, tab = 'personal', index = 0) {
    const sources = this._buildSideOrderSources(item, fallback);
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
      countdownEndTime: pendingCountdown.countdownEndTime,
      countdownText: pendingCountdown.countdownText,
      metaRows: this._buildSideOrderMetaRows(tab, sources),
      summaryRows: this._buildSideOrderSummaryRows(tab, sources, amountText),
      note: remarkNote || cachedRemark?.note || '',
      noteTag: remarkTag || cachedRemark?.tag || '',
      noteTagName: remarkTagName || cachedRemark?.tagName || '',
      actionTags: this._buildSideOrderActionTags(tab, sources),
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
        const result = payload?.result || {};
        const text = this._pickRefundText([result], ['detail', 'text', 'desc']);
        if (text) {
          compensateMap[orderSn] = {
            pendingCompensateText: text,
          };
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

  _extractAfterSalesStatusMapFromTraffic(orderSns = [], sessionMeta = {}) {
    const validOrderSns = [...new Set((Array.isArray(orderSns) ? orderSns : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!validOrderSns.length) return {};
    const targetSet = new Set(validOrderSns);
    const statusMap = {};
    const entries = this._getOrderTrafficEntries('/mercury/chat/afterSales/queryList', sessionMeta);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const responseBody = entries[i]?.responseBody && typeof entries[i].responseBody === 'object'
        ? entries[i].responseBody
        : this._safeParseJson(entries[i]?.responseBody);
      const map = responseBody?.result?.orderSn2AfterSalesListMap;
      if (!map || typeof map !== 'object') continue;
      Object.entries(map).forEach(([orderSn, list]) => {
        if (!targetSet.has(String(orderSn)) || statusMap[String(orderSn)]) return;
        const text = this._extractAfterSalesStatusText(list);
        if (text) statusMap[String(orderSn)] = text;
      });
      if (validOrderSns.every(orderSn => statusMap[orderSn])) break;
    }
    return statusMap;
  }

  _attachAfterSalesStatusFromTraffic(orders = [], sessionMeta = {}) {
    const orderSns = orders.map(item => String(item?.orderId || item?.orderSn || '').trim()).filter(Boolean);
    if (!orderSns.length) return orders;
    const statusMap = this._extractAfterSalesStatusMapFromTraffic(orderSns, sessionMeta);
    return orders.map(order => {
      const orderSn = String(order?.orderId || order?.orderSn || '').trim();
      return {
        ...order,
        afterSalesStatus: order?.afterSalesStatus || statusMap[orderSn] || '',
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
      return this._attachAfterSalesStatusFromTraffic(this._dedupeRefundOrders(orders, sessionMeta), sessionMeta);
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
      const text = this._pickRefundText([responseBody?.result || {}], ['detail', 'text', 'desc']);
      if (orderSn && text && !compensateMap[orderSn]) {
        compensateMap[orderSn] = {
          pendingCompensateText: text,
        };
      }
    }
    return this._dedupeRefundOrders(pendingOrders.map(item => {
      const orderSn = String(item?.orderSn || item?.orderId || '').trim();
      return {
        ...(item || {}),
        ...(compensateMap[orderSn] || {}),
      };
    }), sessionMeta);
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
      return pendingOrders.map((item, index) => this._normalizeSideOrderCard(item, sessionMeta, normalizedTab, index));
    }
    let orders = [];
    try {
      const pageOrders = await this._extractRefundOrdersFromPageApis(sessionMeta);
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
    const filtered = normalizedTab === 'aftersale'
      ? orders.filter(item => String(item?.afterSalesStatus || '').trim())
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

  async sendMessage(sessionRef, text) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const { sessionMeta } = this._getSessionIdentityCandidates(sessionRef);
    const requestBody = this._buildSendMessageBody(sessionMeta, text);
    this._log('[API] 发送消息', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      textLength: String(text || '').length,
      client: requestBody?.client,
      hasTopAntiContent: !!requestBody?.anti_content,
      hasBodyAntiContent: !!requestBody?.data?.anti_content,
      hasUserInfo: !!requestBody?.data?.message?.user_info,
      preMsgId: requestBody?.data?.message?.pre_msg_id || '',
    });
    const sentAtMs = Date.now();
    const payload = await this._post('/plateau/chat/send_message', requestBody);
    const confirmResult = await this._confirmSentTextMessage(sessionMeta, text, { sentAtMs });
    if (!confirmResult.confirmed) {
      const error = new Error('发送接口未确认消息已入会话，请稍后刷新重试');
      error.payload = payload;
      throw error;
    }
    this._log('[API] 消息发送确认成功', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      payloadKeys: Object.keys(payload?.result || payload?.data || payload || {}),
      messageId: confirmResult.messageId,
    });

    const result = {
      success: true,
      sessionId: String(sessionMeta.sessionId || ''),
      customerId: String(sessionMeta.customerId || ''),
      userUid: String(sessionMeta.userUid || ''),
      messageId: confirmResult.messageId,
      text,
      response: payload
    };
    this.emit('messageSent', result);
    return result;
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

  async getGoodsCard(params = {}) {
    const url = String(params.url || '').trim();
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
    const response = await this._getSession().fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
    const html = await response.text();
    const parsed = this._extractGoodsCardFromHtml(html, {
      ...fallback,
      goodsId: fallback.goodsId || this._extractGoodsIdFromUrl(url),
      specText: fallback.specText || '查看商品规格',
    });
    if (!response.ok && !parsed.title && !parsed.imageUrl) {
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      goodsId: parsed.goodsId || fallback.goodsId || this._extractGoodsIdFromUrl(url),
      url,
      title: parsed.title || fallback.title || '拼多多商品',
      imageUrl: parsed.imageUrl || fallback.imageUrl || '',
      priceText: parsed.priceText || fallback.priceText || '',
      groupText: parsed.groupText || fallback.groupText || '2人团',
      specText: parsed.specText || fallback.specText || '查看商品规格',
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

  async _pollMessagesForSession(sessionId) {
    const messages = await this.getSessionMessages(sessionId, 1, 20);
    const newMessages = [];

    for (const item of messages) {
      const key = item.messageId || `${item.sessionId}|${item.senderId}|${item.timestamp}|${item.content}`;
      if (!item.isFromBuyer || !item.content || this._seenMessageIds.has(key)) continue;
      this._seenMessageIds.add(key);
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

      for (const sessionItem of targets) {
        const freshMessages = await this._pollMessagesForSession(sessionItem.sessionId);
        for (const message of freshMessages) {
          this.emit('newMessage', {
            shopId: this.shopId,
            sessionId: message.sessionId,
            customer: message.senderName || sessionItem.customerName || '未知客户',
            customerId: message.senderId || sessionItem.customerId || '',
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
    this._sessionCache = [];
  }
}

module.exports = { PddApiClient };
