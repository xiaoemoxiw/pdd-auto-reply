/**
 * PDD API 客户端
 * 通过 HTTP 直接调用拼多多商家后台 API，实现消息收发、会话列表、订单查询等功能。
 * 认证信息复用 ShopManager 中已导入的 Token 和 Cookie。
 *
 * 已确认的端点：
 *   POST /plateau/chat/list  body: { mallId, page, pageSize }
 *   POST /plateau/chat/messages
 *   POST /plateau/chat/send
 *
 * PDD 可能随时更新接口格式，需保持抓包工具可用以便快速适配。
 */

const { session, BrowserWindow } = require('electron');
const { EventEmitter } = require('events');

const PDD_BASE = 'https://mms.pinduoduo.com';
const PLATEAU_BASE = `${PDD_BASE}/plateau`;

const POLL_INTERVAL = 5000;
const POLL_INTERVAL_IDLE = 15000;

class PddApiClient extends EventEmitter {
  constructor(shopId, options = {}) {
    super();
    this.shopId = shopId;
    this.partition = `persist:pdd-${shopId}`;
    this._polling = false;
    this._pollTimer = null;
    this._lastSyncTimestamp = 0;
    this._seenMessageIds = new Set();
    this._sessionCache = [];
    this._authExpired = false;
    this._sessionInited = false;
    this._onLog = options.onLog || (() => {});
  }

  // ---- 认证信息 ----

  _getTokenInfo() {
    return (global.__pddTokens && global.__pddTokens[this.shopId]) || null;
  }

  // ---- 会话初始化：模拟网页认证流程 ----

  /**
   * 通过隐藏 BrowserWindow 加载聊天页面完成认证流程。
   * PASS_ID 需要经过网页 JS 兑换为正式 session，直接 API 调用无法使用。
   */
  async initSession() {
    this._onLog('[API] 通过网页认证流程初始化会话...');
    this._authExpired = false;

    const win = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    try {
      await win.loadURL(`${PDD_BASE}/chat-merchant/index.html`);

      // 等待页面完成认证跳转，最多等 20 秒
      let settled = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const currentUrl = win.webContents.getURL();
        this._onLog(`[API] 页面 URL: ${currentUrl.slice(0, 80)}`);

        // 如果 URL 不再是 login 页面，说明认证通过
        if (currentUrl.includes('chat-merchant') && !currentUrl.includes('login')) {
          settled = true;
          this._onLog('[API] 网页认证成功，聊天页面已加载');
          break;
        }
        // 如果停留在 login 页面超过 10 秒，认为需要人工登录
        if (i >= 10 && currentUrl.includes('login')) {
          this._onLog('[API] 页面停留在登录页，PASS_ID 可能已过期');
          break;
        }
      }

      if (settled) {
        // 认证成功后检查 cookie
        const ses = session.fromPartition(this.partition);
        const cookies = await ses.cookies.get({ url: PDD_BASE });
        this._onLog(`[API] 认证后 Cookie: ${cookies.map(c => c.name).join(', ')} (共${cookies.length}个)`);
      }
    } catch (err) {
      this._onLog(`[API] 网页认证出错: ${err.message}`);
    } finally {
      win.destroy();
    }

    // 验证认证是否成功
    try {
      const userInfo = await this._post(`${PDD_BASE}/janus/api/new/userinfo`, {});
      this._onLog(`[API] 认证验证通过: ${JSON.stringify(userInfo).slice(0, 200)}`);
    } catch (err) {
      this._onLog(`[API] 认证验证失败: ${err.message}`);
      if (err.authExpired) {
        this._onLog('[API] Token 确实已过期，需要重新导入');
      }
    }
  }

  // ---- HTTP 请求 ----

  async _request(method, urlPath, body = null) {
    const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
    const ses = session.fromPartition(this.partition);
    const tokenInfo = this._getTokenInfo();

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${PDD_BASE}/chat-merchant/index.html`,
      'Origin': PDD_BASE,
    };
    if (tokenInfo?.userAgent) {
      headers['User-Agent'] = tokenInfo.userAgent;
    }
    if (tokenInfo?.raw) {
      headers['X-PDD-Token'] = tokenInfo.raw;
    }

    const fetchOpts = { method, headers };
    if (body) {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await ses.fetch(url, fetchOpts);
    const text = await response.text();
    this._onLog(`[API] ${response.status} ${url} (${text.length}b)`);

    if (!response.ok) {
      let msg = text.slice(0, 200);
      try { const d = JSON.parse(text); msg = d.error_msg || d.message || msg; } catch {}
      const err = new Error(`HTTP ${response.status}: ${msg}`);
      err.statusCode = response.status;
      try { err.data = JSON.parse(text); } catch {}
      throw err;
    }

    let data;
    try { data = JSON.parse(text); } catch { return text; }

    // 检测 API 层面的认证失败
    if (data.success === false) {
      const code = data.error_code;
      if (code === 43001 || code === 43002 || code === 40001) {
        this._authExpired = true;
        this.emit('authExpired', { shopId: this.shopId, errorCode: code, errorMsg: data.error_msg });
        const err = new Error(data.error_msg || '会话已过期');
        err.authExpired = true;
        err.errorCode = code;
        throw err;
      }
      const err = new Error(data.error_msg || 'API 请求失败');
      err.errorCode = code;
      throw err;
    }

    return data;
  }

  async _get(urlPath) {
    return this._request('GET', urlPath);
  }

  async _post(urlPath, body) {
    return this._request('POST', urlPath, body);
  }

  // ---- 会话列表 ----

  async getSessionList(page = 1, pageSize = 20) {
    // 首次调用时自动初始化会话
    if (!this._sessionInited) {
      await this.initSession();
      this._sessionInited = true;
    }

    const tokenInfo = this._getTokenInfo();
    const mallId = Number(tokenInfo?.mallId) || 0;

    const data = await this._post(`${PLATEAU_BASE}/chat/list`, {
      mallId,
      page,
      pageSize,
    });
    const sessions = this._parseSessionList(data);
    this._sessionCache = sessions;
    return sessions;
  }

  _parseSessionList(data) {
    const rawList = data?.data?.list || data?.result?.list ||
                    data?.conv_list || data?.conversations ||
                    data?.data?.conversations || data?.list || [];

    return rawList.map(item => ({
      sessionId: item.session_id || item.conversation_id || item.chat_id || item.id || '',
      customerId: item.customer_id || item.buyer_id || item.from_uid || item.uid || '',
      customerName: item.nick || item.nickname || item.buyer_name || item.customer_name || item.name || '未知客户',
      customerAvatar: item.avatar || item.head_img || item.buyer_avatar || '',
      lastMessage: item.last_msg || item.last_message || item.latest_msg || '',
      lastMessageTime: item.last_msg_time || item.update_time || item.last_time || 0,
      unreadCount: item.unread_count || item.unread || item.unread_num || 0,
      isTimeout: item.is_timeout || item.timeout || false,
      waitTime: item.wait_time || item.waiting_time || 0,
      orderId: item.order_id || item.order_sn || '',
      goodsInfo: item.goods_info || item.goods || null,
    }));
  }

  // ---- 消息历史 ----

  async getSessionMessages(sessionId, page = 1, pageSize = 30) {
    const tokenInfo = this._getTokenInfo();
    const mallId = Number(tokenInfo?.mallId) || 0;

    const data = await this._post(`${PLATEAU_BASE}/chat/messages`, {
      sessionId,
      mallId,
      page,
      pageSize,
    });
    return this._parseMessages(data);
  }

  _parseMessages(data) {
    const rawList = data?.data?.msg_list || data?.data?.messages ||
                    data?.msg_list || data?.messages ||
                    data?.result?.messages || data?.data?.list || [];

    return rawList.map(item => ({
      messageId: item.msg_id || item.message_id || item.id || '',
      sessionId: item.session_id || item.conversation_id || '',
      content: item.content || item.text || item.msg_content || item.message || '',
      msgType: item.msg_type || item.message_type || item.content_type || 1,
      isFromBuyer: this._isBuyerMessage(item),
      senderName: item.nick || item.nickname || item.sender_name || item.from_name || '',
      senderId: item.from_uid || item.sender_id || item.from_id || '',
      timestamp: item.send_time || item.time || item.ts || item.timestamp || item.created_at || 0,
      extra: item.extra || item.ext || null,
    }));
  }

  _isBuyerMessage(item) {
    const role = String(item.role || item.msg_from || item.from_type || item.sender_role || '').toLowerCase();
    if (['buyer', 'customer', 'user', '1', '0'].includes(role)) return true;
    if (['seller', 'system', 'robot', 'service', 'kf', 'agent', 'bot', '2', '3', '4', '99'].includes(role)) return false;
    if (item.is_buyer || item.is_buyer === 1 || item.sender_type === 1 || item.sender_type === 0) return true;
    if (item.is_seller || item.is_robot || item.is_system) return false;
    return !role;
  }

  // ---- 发送消息 ----

  async sendMessage(sessionId, text) {
    const tokenInfo = this._getTokenInfo();
    const mallId = Number(tokenInfo?.mallId) || 0;

    const data = await this._post(`${PLATEAU_BASE}/chat/send`, {
      sessionId,
      mallId,
      content: text,
      msgType: 1,
    });
    this._onLog(`[API] 消息已发送: sessionId=${sessionId}`);
    this.emit('messageSent', { sessionId, text, response: data });
    return data;
  }

  // ---- 消息轮询 ----

  startMessagePolling() {
    if (this._polling) return;
    if (this._authExpired) {
      this._onLog('[API] Token 已过期，跳过轮询');
      return;
    }
    this._polling = true;
    this._lastSyncTimestamp = Date.now();
    this._onLog('[API] 消息轮询已启动');
    this._doPoll();
  }

  stopMessagePolling() {
    this._polling = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._onLog('[API] 消息轮询已停止');
  }

  async _doPoll() {
    if (!this._polling) return;

    try {
      const sessions = await this.getSessionList(1, 20);
      if (sessions.length > 0) {
        this._sessionCache = sessions;
        this.emit('sessionUpdated', sessions);
      }
      this._lastSyncTimestamp = Date.now();
      this._schedulePoll(POLL_INTERVAL);
    } catch (err) {
      if (err.authExpired) {
        this.stopMessagePolling();
        return;
      }
      this._onLog(`[API] 轮询出错: ${err.message}`);
      this._schedulePoll(POLL_INTERVAL_IDLE);
    }
  }

  _schedulePoll(interval) {
    if (!this._polling) return;
    this._pollTimer = setTimeout(() => this._doPoll(), interval);
  }

  // ---- 订单信息 ----

  async getOrderInfo(orderId) {
    const tokenInfo = this._getTokenInfo();
    const mallId = Number(tokenInfo?.mallId) || 0;

    const data = await this._post(`${PLATEAU_BASE}/order/detail`, {
      orderSn: orderId,
      mallId,
    });
    return this._parseOrderInfo(data);
  }

  _parseOrderInfo(data) {
    const order = data?.data || data?.result || data || {};
    return {
      orderId: order.order_sn || order.order_id || '',
      status: order.order_status || order.status || '',
      statusText: order.order_status_desc || order.status_text || '',
      totalAmount: order.total_amount || order.pay_amount || 0,
      goodsList: (order.goods_list || order.items || []).map(g => ({
        goodsId: g.goods_id || g.id || '',
        goodsName: g.goods_name || g.name || '',
        skuName: g.sku_name || g.spec || '',
        quantity: g.quantity || g.num || 1,
        price: g.price || g.goods_price || 0,
        thumbUrl: g.thumb_url || g.image || '',
      })),
      logistics: {
        company: order.logistics_company || order.express_company || '',
        trackingNo: order.tracking_number || order.tracking_no || order.express_no || '',
        status: order.logistics_status || '',
      },
      createTime: order.created_time || order.create_time || 0,
      payTime: order.pay_time || 0,
      shipTime: order.ship_time || order.send_time || 0,
      buyerNote: order.buyer_memo || order.remark || '',
    };
  }

  // ---- 客户信息 ----

  async getCustomerInfo(customerId) {
    const tokenInfo = this._getTokenInfo();
    const mallId = Number(tokenInfo?.mallId) || 0;

    const data = await this._post(`${PLATEAU_BASE}/customer/info`, {
      customerId,
      mallId,
    });
    return this._parseCustomerInfo(data);
  }

  _parseCustomerInfo(data) {
    const info = data?.data || data?.result || data || {};
    return {
      customerId: info.customer_id || info.buyer_id || info.uid || '',
      name: info.nick || info.nickname || info.buyer_name || info.name || '',
      avatar: info.avatar || info.head_img || info.buyer_avatar || '',
      level: info.level || info.buyer_level || '',
      totalOrders: info.total_orders || info.order_count || 0,
      totalAmount: info.total_amount || info.spend_amount || 0,
      tags: info.tags || info.labels || [],
      registerTime: info.register_time || info.join_time || '',
      lastOrderTime: info.last_order_time || '',
    };
  }

  // ---- 状态查询 ----

  isPolling() {
    return this._polling;
  }

  isAuthExpired() {
    return this._authExpired;
  }

  getCachedSessions() {
    return this._sessionCache;
  }

  getTokenStatus() {
    const tokenInfo = this._getTokenInfo();
    return {
      hasToken: !!tokenInfo,
      mallId: tokenInfo?.mallId || '',
      userId: tokenInfo?.userId || '',
      authExpired: this._authExpired,
    };
  }

  // ---- API 端点发现：通过加载聊天页面捕获真实请求 ----

  async discoverApiEndpoints(timeout = 15000) {
    this._onLog('[API] 开始端点发现：加载 PDD 聊天页面...');
    const captured = [];

    const win = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    const ses = session.fromPartition(this.partition);
    const filter = { urls: ['https://mms.pinduoduo.com/*'] };

    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
      const url = details.url;
      if (!/\.(js|css|png|jpg|gif|svg|woff|ico|map)(\?|$)/.test(url) && !url.includes('/static/') && !url.includes('/assets/')) {
        let bodyStr = '';
        if (details.uploadData) {
          for (const chunk of details.uploadData) {
            if (chunk.bytes) bodyStr += Buffer.from(chunk.bytes).toString();
          }
        }
        captured.push({ method: details.method, url, body: bodyStr, timestamp: Date.now() });
        this._onLog(`[API发现] ${details.method} ${url}${bodyStr ? ' body=' + bodyStr.slice(0, 200) : ''}`);
      }
      callback({});
    });

    try {
      await win.loadURL('https://mms.pinduoduo.com/chat-merchant/index.html');
      await new Promise(resolve => setTimeout(resolve, timeout));
    } catch (err) {
      this._onLog(`[API发现] 页面加载出错: ${err.message}`);
    }

    ses.webRequest.onBeforeRequest(filter, null);
    win.destroy();

    this._onLog(`[API发现] 共捕获 ${captured.length} 个 API 请求`);
    return captured;
  }

  destroy() {
    this.stopMessagePolling();
    this.removeAllListeners();
    this._seenMessageIds.clear();
    this._sessionCache = [];
  }
}

module.exports = { PddApiClient };
