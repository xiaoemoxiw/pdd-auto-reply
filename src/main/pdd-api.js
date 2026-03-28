const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PDD_BASE = 'https://mms.pinduoduo.com';
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
    this._seenMessageIds = new Set();
    this._sessionCache = [];
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
    return Array.isArray(list) ? list : [];
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

      this._sessionInited = settled;
      this._log(`[API] 会话初始化${settled ? '成功' : '未完成'}`);
      const cookieNamesAfter = await this._listCookieNames();
      return {
        initialized: settled,
        url: win.webContents.getURL(),
        cookieNamesBefore,
        cookieNamesAfter,
        addedCookieNames: cookieNamesAfter.filter(item => !cookieNamesBefore.includes(item)),
        userAgentUsed: shop?.userAgent || this._getTokenInfo()?.userAgent || '',
      };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async _request(method, urlPath, body, extraHeaders = {}) {
    const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
    const headers = await this._buildHeaders(extraHeaders);
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
      if (this._isAuthError(businessError.code)) {
        this._authExpired = true;
        error.authExpired = true;
        this.emit('authExpired', {
          shopId: this.shopId,
          errorCode: businessError.code,
          errorMsg: businessError.message,
        });
      }
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

  async getUserInfo() {
    const payload = await this._post('/janus/api/new/userinfo', {});
    return this._parseUserInfo(payload);
  }

  _parseSessionList(payload) {
    const list = payload?.data?.list ||
      payload?.result?.list ||
      payload?.result?.conversations ||
      payload?.conv_list ||
      payload?.conversations ||
      payload?.data?.conversations ||
      payload?.list ||
      [];

    return list.map(item => ({
      sessionId: item.session_id || item.conversation_id || item.chat_id || item.id || item?.to?.uid || item?.user_info?.uid || '',
      customerId: item.customer_id || item.buyer_id || item.from_uid || item.uid || item?.to?.uid || item?.user_info?.uid || '',
      customerName: item.nick || item.nickname || item.buyer_name || item.customer_name || item.name || item?.user_info?.nickname || '未知客户',
      customerAvatar: item.avatar || item.head_img || item.buyer_avatar || item?.user_info?.avatar || '',
      lastMessage: item.last_msg || item.last_message || item.latest_msg || item.content || '',
      lastMessageTime: item.last_msg_time || item.update_time || item.last_time || item.ts || 0,
      unreadCount: item.unread_count || item.unread || item.unread_num || item?.context?.unread || 0,
      isTimeout: item.is_timeout || item.timeout || false,
      waitTime: item.wait_time || item.waiting_time || item.last_unreply_time || 0,
      orderId: item.order_id || item.order_sn || '',
      goodsInfo: item.goods_info || item.goods || null,
      csUid: item?.from?.cs_uid || '',
      mallId: item?.from?.mall_id || '',
      raw: item,
    }));
  }

  async getSessionList(page = 1, pageSize = 20) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const latestTraffic = this._findLatestTraffic('/plateau/chat/latest_conversations');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    const requestBody = templateBody
      ? {
          ...templateBody,
          data: {
            ...templateBody.data,
            page: page || templateBody.data?.page,
            size: pageSize || templateBody.data?.size,
          },
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
          client: 'WEB',
          anti_content: antiContent,
        };
    try {
      const payload = await this._post('/plateau/chat/latest_conversations', requestBody);
      const sessions = this._parseSessionList(payload);
      this._sessionCache = sessions;
      return sessions;
    } catch (error) {
      const cachedPayload = this._getLatestResponseBody('/plateau/chat/latest_conversations');
      const cachedSessions = this._parseSessionList(cachedPayload);
      if (cachedSessions.length > 0) {
        this._sessionCache = cachedSessions;
        this._log('[API] latest_conversations 直调失败，回退页面抓取缓存', { message: error.message });
        return cachedSessions;
      }
      throw error;
    }
  }

  _isBuyerMessage(item) {
    const role = String(item.role || item.msg_from || item.from_type || item.sender_role || '').toLowerCase();
    if (['buyer', 'customer', 'user', '1', '0'].includes(role)) return true;
    if (['seller', 'system', 'robot', 'service', 'kf', 'agent', 'bot', '2', '3', '4', '99'].includes(role)) return false;
    if (item.is_buyer || item.is_buyer === 1 || item.sender_type === 1 || item.sender_type === 0) return true;
    if (item.is_seller || item.is_robot || item.is_system) return false;
    return !role;
  }

  _parseMessages(payload) {
    const list = payload?.data?.msg_list ||
      payload?.data?.messages ||
      payload?.msg_list ||
      payload?.messages ||
      payload?.result?.messages ||
      payload?.data?.list ||
      [];

    return list.map(item => ({
      messageId: item.msg_id || item.message_id || item.id || '',
      sessionId: item.session_id || item.conversation_id || item.chat_id || item?.to?.uid || item?.from?.uid || '',
      content: item.content || item.text || item.msg_content || item.message || '',
      msgType: item.msg_type || item.message_type || item.content_type || 1,
      isFromBuyer: this._isBuyerMessage(item),
      senderName: item.nick || item.nickname || item.sender_name || item.from_name || item?.from?.csid || '',
      senderId: item.from_uid || item.sender_id || item.from_id || item?.from?.uid || '',
      timestamp: item.send_time || item.time || item.ts || item.timestamp || item.created_at || 0,
      extra: item.extra || item.ext || null,
      raw: item,
    }));
  }

  async getSessionMessages(sessionId, page = 1, pageSize = 30) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const latestTraffic = this._findLatestTraffic('/plateau/chat/list');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    const requestBody = templateBody
      ? {
          ...templateBody,
          data: {
            ...templateBody.data,
            list: {
              ...(templateBody.data?.list || {}),
              with: {
                ...(templateBody.data?.list?.with || {}),
                role: templateBody.data?.list?.with?.role || 'user',
                id: String(sessionId),
              },
              start_index: Math.max(0, (page - 1) * pageSize),
              size: pageSize || templateBody.data?.list?.size,
            },
          },
        }
      : {
          data: {
            cmd: 'list',
            request_id: this._nextRequestId(),
            list: {
              with: {
                role: 'user',
                id: String(sessionId),
              },
              start_msg_id: null,
              start_index: Math.max(0, (page - 1) * pageSize),
              size: pageSize,
            },
            notUpdateUnreplyTs: true,
            anti_content: antiContent,
          },
          client: 'WEB',
          anti_content: antiContent,
        };
    try {
      const payload = await this._post('/plateau/chat/list', requestBody);
      return this._parseMessages(payload);
    } catch (error) {
      const cachedPayload = this._getLatestResponseBody('/plateau/chat/list');
      const cachedRequest = this._safeParseJson(this._findLatestTraffic('/plateau/chat/list')?.requestBody);
      if (cachedPayload && String(cachedRequest?.data?.list?.with?.id || '') === String(sessionId)) {
        const cachedMessages = this._parseMessages(cachedPayload);
        if (cachedMessages.length > 0) {
          this._log('[API] chat/list 直调失败，回退页面抓取缓存', { message: error.message });
          return cachedMessages;
        }
      }
      throw error;
    }
  }

  _buildSendMessageBody(sessionId, text) {
    const latestTraffic = this._findLatestTraffic('/plateau/chat/send_message');
    const templateBody = this._safeParseJson(latestTraffic?.requestBody);
    const antiContent = templateBody?.anti_content || this._getLatestAntiContent();
    const requestId = this._nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const random = this._randomHex(32);
    const hash = this._buildMessageHash(sessionId, text, ts, random);

    if (templateBody) {
      const body = this._cloneJson(templateBody);
      body.data = body.data || {};
      body.data.request_id = requestId;
      body.data.cmd = body.data.cmd || 'send_message';
      body.data.random = random;
      body.data.anti_content = body.data.anti_content || antiContent;
      body.data.message = {
        ...(body.data.message || {}),
        to: {
          ...((body.data.message && body.data.message.to) || {}),
          role: body.data.message?.to?.role || 'user',
          uid: String(sessionId),
        },
        from: {
          ...((body.data.message && body.data.message.from) || {}),
          role: body.data.message?.from?.role || 'mall_cs',
        },
        ts,
        content: text,
        msg_id: null,
        type: body.data.message?.type ?? 0,
        is_aut: 0,
        manual_reply: 1,
        status: body.data.message?.status || 'read',
        is_read: body.data.message?.is_read ?? 1,
        hash,
      };
      body.client = body.client || 'WEB';
      body.anti_content = body.anti_content || antiContent;
      return body;
    }

    return {
      data: {
        cmd: 'send_message',
        anti_content: antiContent,
        request_id: requestId,
        message: {
          to: { role: 'user', uid: String(sessionId) },
          from: { role: 'mall_cs' },
          ts,
          content: text,
          msg_id: null,
          type: 0,
          is_aut: 0,
          manual_reply: 1,
          status: 'read',
          is_read: 1,
          hash,
        },
        random,
      },
      client: 'WEB',
      anti_content: antiContent,
    };
  }

  async sendMessage(sessionId, text) {
    if (!this._sessionInited) {
      await this.initSession();
    }

    const payload = await this._post('/plateau/chat/send_message', this._buildSendMessageBody(sessionId, text));

    const result = { sessionId, text, response: payload };
    this.emit('messageSent', result);
    return result;
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
        }
      : {
          data: {
            cmd: 'marked_lastest_conversations',
            request_id: this._nextRequestId(),
            size,
            anti_content: antiContent,
          },
          client: 'WEB',
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

  getTokenStatus() {
    const tokenInfo = this._getTokenInfo();
    return {
      hasToken: !!tokenInfo?.raw,
      shopId: this.shopId,
      mallId: tokenInfo?.mallId || this._getShopInfo()?.mallId || '',
      userId: tokenInfo?.userId || '',
      authExpired: this._authExpired,
      sessionInited: this._sessionInited,
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
