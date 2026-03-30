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
    this._seenMessageIds = new Set();
    this._sessionCache = [];
    this._bootstrapTraffic = [];
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
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
      const targetId = body?.data?.list?.with?.id || body?.data?.message?.to?.uid || body?.session_id || '';
      return ids.includes(String(targetId));
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

  _getLatestBuyerInfo(sessionId) {
    const entry = this._getLatestSessionTraffic('/plateau/chat/list', sessionId);
    const payload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
    const messages = this._parseMessages(payload);
    const buyerMessage = [...messages].reverse().find(item => item.isFromBuyer && item?.raw && typeof item.raw === 'object');
    return buyerMessage?.raw?.user_info ? this._cloneJson(buyerMessage.raw.user_info) : null;
  }

  _getLatestMessageTemplate(sessionId) {
    const entry = this._getLatestSessionTraffic('/plateau/chat/list', sessionId);
    const payload = entry?.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : null;
    const messages = this._parseMessages(payload);
    const sellerMessage = [...messages].reverse().find(item => !item.isFromBuyer && item?.raw && typeof item.raw === 'object');
    if (sellerMessage?.raw) {
      return this._cloneJson(sellerMessage.raw);
    }

    const sessionListPayload = this._getLatestResponseBody('/plateau/chat/latest_conversations');
    const sessions = this._parseSessionList(sessionListPayload);
    const matchedSession = [...sessions].find(item => String(item.sessionId || '') === String(sessionId) && item?.raw && typeof item.raw === 'object');
    if (matchedSession?.raw) {
      return this._cloneJson(matchedSession.raw);
    }

    const latestSellerSession = [...sessions].find(item => !this._isBuyerMessage(item.raw) && item?.raw && typeof item.raw === 'object');
    return latestSellerSession?.raw ? this._cloneJson(latestSellerSession.raw) : null;
  }

  _buildSendMessageTemplate(sessionId, text, ts, hash) {
    const shop = this._getShopInfo();
    const mallId = this._getMallId();
    const template = this._getLatestMessageTemplate(sessionId) || {};
    const buyerInfo = this._getLatestBuyerInfo(sessionId);
    const from = { ...(template.from || {}) };
    const to = { ...(template.to || {}) };

    from.role = from.role || 'mall_cs';
    if (!from.uid && mallId) from.uid = String(mallId);
    if (!from.mall_id && mallId) from.mall_id = String(mallId);
    if (!from.csid && shop?.name) from.csid = shop.name;
    to.role = to.role || 'user';
    to.uid = String(sessionId);

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

  _buildSendImageTemplate(sessionId, imageUrl, ts, hash) {
    const imageContent = JSON.stringify({
      picture_url: imageUrl,
      url: imageUrl,
      type: 'image',
    });
    const message = this._buildSendMessageTemplate(sessionId, imageContent, ts, hash);
    message.type = 2;
    message.msg_type = 2;
    message.message_type = 2;
    message.content_type = 2;
    message.extra = {
      ...(message.extra || {}),
      type: 'image',
      picture_url: imageUrl,
      url: imageUrl,
    };
    message.ext = {
      ...(message.ext || {}),
      type: 'image',
      picture_url: imageUrl,
      url: imageUrl,
    };
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
    if (!payload || typeof payload !== 'object') return null;
    if (payload.success === false) {
      return {
        code: payload.error_code || payload.code,
        message: payload.error_msg || payload.message || 'API 请求失败',
      };
    }
    if (payload.error_code && payload.error_code !== 0) {
      return {
        code: payload.error_code,
        message: payload.error_msg || payload.message || 'API 请求失败',
      };
    }
    return null;
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

  _parseUserInfo(payload) {
    const info = payload?.result || payload?.data || payload || {};
    return {
      mallId: info.mall_id || info.mallId || this._getMallId() || '',
      userId: info.uid || info.user_id || info.userId || this._getTokenInfo()?.userId || '',
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
      serviceName: info.username || info.nickname || info.nick_name || info.name || '',
      serviceAvatar: mall.logo || info.avatar || info.head_img || '',
    };
  }

  async getUserInfo() {
    const payload = await this._post('/janus/api/new/userinfo', {});
    return this._parseUserInfo(payload);
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

  _filterDisplaySessions(sessions = []) {
    return sessions.filter(session => this._isTodayTimestamp(session?.lastMessageTime) || this._isTodayTimestamp(session?.createdAt));
  }

  _parseSessionIdentity(item = {}) {
    const conversationId = item.conversation_id || item.conversationId || '';
    const chatId = item.chat_id || item.chatId || '';
    const explicitSessionId = item.session_id || item.sessionId || '';
    const rawId = item.id || '';
    const customerId = item.customer_id || item.buyer_id || item.from_uid || item.uid || '';
    const userUid = item?.to?.uid || item?.user_info?.uid || item?.from?.uid || '';
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
    if (['buyer', 'customer', 'user', '1', '0'].includes(role)) return true;
    if (['seller', 'system', 'robot', 'service', 'kf', 'agent', 'bot', 'mall_cs', '2', '3', '4', '99'].includes(role)) return false;
    if (item.is_buyer || item.is_buyer === 1 || item.sender_type === 1 || item.sender_type === 0) return true;
    if (item.is_seller || item.is_robot || item.is_system) return false;
    return !role;
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

  _extractGoodsCardFromHtml(html = '', fallback = {}) {
    const source = String(html || '');
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
        /<title>([^<]+)<\/title>/i,
      ]),
      fallback.title,
    ]);
    const imageUrl = this._pickGoodsText([
      matchFirst([
        /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
        /<meta[^>]+name="og:image"[^>]+content="([^"]+)"/i,
        /"hd_thumb_url"\s*:\s*"([^"]+)"/i,
        /"thumb_url"\s*:\s*"([^"]+)"/i,
        /"goods_thumb_url"\s*:\s*"([^"]+)"/i,
        /"top_gallery"\s*:\s*\[\s*"([^"]+)"/i,
      ]),
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
      messageId: item.msg_id || item.message_id || item.id || '',
      sessionId: item.session_id || item.conversation_id || item.chat_id || item?.to?.uid || item?.from?.uid || '',
      content: this._extractMessageText(item),
      msgType: item.msg_type || item.message_type || item.content_type || 1,
      isFromBuyer: this._isBuyerMessage(item),
      senderName: item.nick || item.nickname || item.sender_name || item.from_name || item?.from?.csid || '',
      senderId: item.from_uid || item.sender_id || item.from_id || item?.from?.uid || '',
      timestamp: item.send_time || item.time || item.ts || item.timestamp || item.created_at || 0,
      readState: this._extractMessageReadState(item),
      extra: item.extra || item.ext || null,
      raw: item,
    }));
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

  _buildSendMessageBody(sessionId, text) {
    const latestTraffic = this._findLatestTraffic('/plateau/chat/send_message');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const latestListBody = this._getLatestRequestBody('/plateau/chat/list');
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
    const hash = this._buildMessageHash(sessionId, text, ts, random);
    const message = this._buildSendMessageTemplate(sessionId, text, ts, hash);

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
    const fileBuffer = await fs.readFile(filePath);
    const attempts = [];
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

  _buildSendImageBody(sessionId, imageUrl) {
    const latestTraffic = this._findLatestTraffic('/plateau/chat/send_message');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const latestListBody = this._getLatestRequestBody('/plateau/chat/list');
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
    const hash = this._buildMessageHash(sessionId, imageUrl, ts, random);
    const message = this._buildSendImageTemplate(sessionId, imageUrl, ts, hash);

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

  async sendMessage(sessionId, text) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const requestBody = this._buildSendMessageBody(sessionId, text);
    this._log('[API] 发送消息', {
      sessionId: String(sessionId),
      textLength: String(text || '').length,
      client: requestBody?.client,
      hasTopAntiContent: !!requestBody?.anti_content,
      hasBodyAntiContent: !!requestBody?.data?.anti_content,
      hasUserInfo: !!requestBody?.data?.message?.user_info,
      preMsgId: requestBody?.data?.message?.pre_msg_id || '',
    });
    const payload = await this._post('/plateau/chat/send_message', requestBody);
    this._log('[API] 消息发送成功', {
      sessionId: String(sessionId),
      payloadKeys: Object.keys(payload?.result || payload?.data || payload || {}),
    });

    const result = { sessionId, text, response: payload };
    this.emit('messageSent', result);
    return result;
  }

  async sendImage(sessionId, filePath) {
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
    const imageUrl = uploadResult?.processed_url || uploadResult?.url;
    const requestBody = this._buildSendImageBody(sessionId, imageUrl);
    this._log('[API] 发送图片', {
      sessionId: String(sessionId),
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
      sessionId,
      filePath,
      imageUrl,
      uploadBaseUrl: uploadResult?.uploadBaseUrl,
      response: payload
    };
    this.emit('messageSent', result);
    return result;
  }

  async sendImageUrl(sessionId, imageUrl, extra = {}) {
    if (!this._sessionInited) {
      await this.initSession();
    }
    const requestBody = this._buildSendImageBody(sessionId, imageUrl);
    this._log('[API] 发送图片', {
      sessionId: String(sessionId),
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
      sessionId,
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
