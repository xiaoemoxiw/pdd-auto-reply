const zlib = require('zlib');

/**
 * 网络请求监控模块
 * 通过 Chrome DevTools Protocol (CDP) 拦截 BrowserView 中的网络请求，
 * 捕获拼多多客服页面的消息轮询接口响应数据。
 */

class NetworkMonitor {
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.debugger = webContents.debugger;
    this.attached = false;
    this.onLog = options.onLog || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onCustomerMessage = options.onCustomerMessage || null;
    this.onApiTraffic = options.onApiTraffic || (() => {});
    this.getLatestAction = options.getLatestAction || (() => null);
    // 启动后的宽限期：前 N 秒内提取的消息视为历史消息，不触发回复
    this._startTime = Date.now();
    this._warmupMs = options.warmupMs || 10000;
    // 已见消息去重（避免轮询接口重复触发）
    this._seenMessages = new Set();
    this._requestMap = new Map();
    this._webSocketMap = new Map();

    // 需要捕获响应体的 URL 关键词（从 DevTools 截图中识别的关键接口）
    this.capturePatterns = [
      '/plateau/',    // PDD 客服平台核心 API（含 sync/message, chat/list 等）
      '/latitude/',   // 订单、改价、待支付等接口
      '/mercury/',    // 售后与订单辅助接口
      '/pizza/order/', // 订单备注等页面接口
      '/omaisms/invoice/',
      '/orderinvoice/',
      '/voice/api/mms/invoice/',
      '/cambridge/api/',
      '/invoice/',
      '/chats/',
      '/get_signature',
      '/store_image',
      '/general_file',
      'message',
      'chat',
      'im/',
      'msg',
      'conversation',
      'session',
      'notify',
      'pull',
      'recv',
      'long_polling',
      'sync',
      'galerie-api.pdd.net',
      'galerie-api.htj.pdd.net',
      'pddugc.com',
      'pddpic.com',
      'store_image',
      'general_file',
      'get_signature',
      '/cos/',
    ];

    // 排除的 URL（心跳、埋点等无关请求）
    this.excludePatterns = [
      '/ping',
      'front_err',
      '_stm',
      'beacon',
      'log.',
      '.png',
      '.jpg',
      '.gif',
      '.css',
      '.js',
      'favicon',
    ];
  }

  start() {
    if (this.attached) return;

    try {
      this.debugger.attach('1.3');
      this.attached = true;
      this._log('info', 'CDP 调试器已连接');
    } catch (err) {
      this._log('error', `CDP 连接失败: ${err.message}`);
      return;
    }

    this.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 50 * 1024 * 1024,
      maxResourceBufferSize: 20 * 1024 * 1024,
    });

    this.debugger.on('detach', (_, reason) => {
      this.attached = false;
      this._log('info', `CDP 已断开: ${reason}`);
    });

    this.debugger.on('message', (_, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        this._handleRequest(params);
      }
      if (method === 'Network.responseReceived') {
        this._handleResponseHeaders(params);
      }
      if (method === 'Network.loadingFinished') {
        this._handleLoadingFinished(params);
      }
      if (method === 'Network.loadingFailed') {
        this._handleLoadingFailed(params);
      }
      if (method === 'Network.webSocketCreated') {
        this._handleWebSocketCreated(params);
      }
      if (method === 'Network.webSocketFrameSent') {
        this._handleWebSocketFrame('sent', params);
      }
      if (method === 'Network.webSocketFrameReceived') {
        this._handleWebSocketFrame('received', params);
      }
    });

    this._log('info', '网络监控已启动，正在捕获请求...');
  }

  stop() {
    if (!this.attached) return;
    try {
      this.debugger.detach();
    } catch {}
    this.attached = false;
    this._log('info', '网络监控已停止');
  }

  _shouldCapture(url) {
    return this._shouldCaptureRequest(url);
  }

  _isMerchantHost(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname.endsWith('.pinduoduo.com') || hostname.endsWith('.pdd.net') || hostname.endsWith('.pddugc.com');
    } catch {
      return false;
    }
  }

  _isHttpLikeUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  _hasExcludedPattern(text) {
    return this.excludePatterns.some(pattern => text.includes(pattern));
  }

  _shouldCaptureRequest(url, resourceType = '', mimeType = '') {
    const rawUrl = String(url || '');
    if (!rawUrl) return false;
    if (!this._isHttpLikeUrl(rawUrl)) return false;
    if (this._hasExcludedPattern(rawUrl)) return false;
    if (this.capturePatterns.some(pattern => rawUrl.includes(pattern))) return true;

    const type = String(resourceType || '').toLowerCase();
    const mime = String(mimeType || '').toLowerCase();
    const isDataRequest = ['xhr', 'fetch', 'preflight'].includes(type);
    const isOtherRequest = ['other', 'ping'].includes(type);
    const isHtmlDocument = type === 'document' && (!mime || mime.includes('text/html'));
    const isTextPayload = mime.includes('json') || mime.includes('text/plain') || mime.includes('javascript') || mime.includes('xml');
    if (isDataRequest || isHtmlDocument || isTextPayload) return true;
    if (this._isMerchantHost(rawUrl) && isOtherRequest) return true;
    return false;
  }

  _summarizeInitiator(initiator) {
    if (!initiator || typeof initiator !== 'object') return {};
    const topFrame = initiator?.stack?.callFrames?.[0] || null;
    return {
      type: initiator.type || '',
      url: initiator.url || topFrame?.url || '',
      lineNumber: Number.isFinite(topFrame?.lineNumber) ? topFrame.lineNumber : null,
      columnNumber: Number.isFinite(topFrame?.columnNumber) ? topFrame.columnNumber : null,
      functionName: topFrame?.functionName || '',
    };
  }

  _summarizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const picked = {};
    const allowList = [
      'content-type', 'Content-Type',
      'accept', 'Accept',
      'accept-language', 'Accept-Language',
      'user-agent', 'User-Agent',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'x-pdd-token', 'X-PDD-Token',
      'windows-app-shop-token',
      'pddid',
      'etag',
      'verifyauthtoken', 'VerifyAuthToken',
      'referer', 'Referer',
      'origin', 'Origin'
    ];
    for (const [key, value] of Object.entries(headers)) {
      if (allowList.includes(key)) {
        picked[key] = value;
      }
    }
    return picked;
  }

  _sanitizePostData(postData) {
    if (!postData) return '';
    return String(postData).slice(0, 4000);
  }

  _sanitizeFrameData(payloadData) {
    if (!payloadData) return '';
    return String(payloadData).slice(0, 4000);
  }

  _extractPrintableSegments(text, limit = 20) {
    const source = String(text || '');
    if (!source) return [];
    const matches = source.match(/[A-Za-z0-9_./:#-]{4,}/g) || [];
    const result = [];
    for (const item of matches) {
      if (result.includes(item)) continue;
      result.push(item);
      if (result.length >= limit) break;
    }
    return result;
  }

  _tryGunzipBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;
    for (let index = 0; index < buffer.length - 1; index++) {
      if (buffer[index] !== 0x1f || buffer[index + 1] !== 0x8b) continue;
      for (let end = buffer.length; end > index + 18; end--) {
        try {
          return zlib.gunzipSync(buffer.slice(index, end));
        } catch {}
      }
    }
    return null;
  }

  _extractAsciiFromBuffer(buffer, limit = 40) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
    const text = buffer.toString('latin1');
    return this._extractPrintableSegments(text, limit);
  }

  _extractJsonObjectFromText(text) {
    const source = String(text || '');
    const start = source.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
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

  _buildDecodedFrameSummary(payloadData, opcode) {
    if (!payloadData) return null;
    const payloadText = String(payloadData);
    const summary = {
      encoding: 'text',
      opcode: Number(opcode || 0) || 0,
      rawPreview: payloadText.slice(0, 240),
    };
    let buffer = null;
    if (/^[A-Za-z0-9+/=]+$/.test(payloadText) && payloadText.length % 4 === 0) {
      try {
        buffer = Buffer.from(payloadText, 'base64');
        summary.encoding = 'base64';
        summary.base64Length = buffer.length;
      } catch {}
    }
    if (!buffer) {
      buffer = Buffer.from(payloadText, 'utf8');
    }
    const bufferTokens = this._extractAsciiFromBuffer(buffer, 30);
    if (bufferTokens.length) {
      summary.bufferTokens = bufferTokens;
    }
    const gunzipped = this._tryGunzipBuffer(buffer);
    if (gunzipped) {
      const decodedText = gunzipped.toString('latin1').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ');
      const compactText = decodedText.replace(/\s+/g, ' ').trim();
      summary.gzipDecodedLength = gunzipped.length;
      summary.textPreview = compactText.slice(0, 1200);
      summary.tokens = this._extractPrintableSegments(compactText, 30);
      const notifyPayload = this._extractJsonObjectFromText(compactText);
      if (notifyPayload) {
        summary.notifyPayload = notifyPayload;
      }
      const joined = [...(summary.tokens || []), ...(summary.bufferTokens || [])].join(' ');
      summary.hasNotifyDataLite = joined.includes('titan.notifyDataLite');
      summary.hasAck = joined.includes('.ack');
      return summary;
    }
    const plainText = payloadText.replace(/\s+/g, ' ').trim();
    const tokens = this._extractPrintableSegments(plainText, 20);
    if (tokens.length) {
      summary.textPreview = plainText.slice(0, 600);
      summary.tokens = tokens;
      const joined = [...tokens, ...(summary.bufferTokens || [])].join(' ');
      summary.hasNotifyDataLite = joined.includes('titan.notifyDataLite');
      summary.hasAck = joined.includes('.ack');
      return summary;
    }
    const joined = (summary.bufferTokens || []).join(' ');
    summary.hasNotifyDataLite = joined.includes('titan.notifyDataLite');
    summary.hasAck = joined.includes('.ack');
    return summary;
  }

  _isWebSocketCaptureUrl(url) {
    return /pinduoduo\.com|m-ws\.pinduoduo\.com/.test(String(url || ''));
  }

  _handleRequest(params) {
    const { requestId, request, initiator, type, documentURL } = params;
    const { url, method, headers, postData } = request || {};
    if (!url || !this._shouldCaptureRequest(url, type)) return;

    let shortUrl;
    try {
      const parsed = new URL(url);
      shortUrl = parsed.pathname + parsed.search;
    } catch {
      shortUrl = url;
    }

    this._requestMap.set(requestId, {
      requestId,
      timestamp: Date.now(),
      url: shortUrl,
      fullUrl: url,
      method: method || 'GET',
      requestHeaders: this._summarizeHeaders(headers),
      requestBody: this._sanitizePostData(postData),
      initiator: initiator?.type || '',
      initiatorDetails: this._summarizeInitiator(initiator),
      resourceType: type || '',
      documentURL: documentURL || '',
    });
  }

  _handleWebSocketCreated(params) {
    const { requestId, url } = params || {};
    if (!requestId || !this._isWebSocketCaptureUrl(url)) return;
    this._webSocketMap.set(requestId, { url, createdAt: Date.now() });
    this.onApiTraffic({
      type: 'websocket-created',
      requestId,
      timestamp: Date.now(),
      url,
      fullUrl: url,
      method: 'WS',
      requestHeaders: {},
      requestBody: '',
      initiator: 'websocket',
      resourceType: 'WebSocket',
      status: 101,
      mimeType: 'websocket',
      responseHeaders: {},
      responseBody: '',
      isJson: false,
    });
  }

  _handleWebSocketFrame(direction, params) {
    const { requestId, response, timestamp } = params || {};
    const socketInfo = this._webSocketMap.get(requestId);
    if (!socketInfo) return;

    const payloadData = this._sanitizeFrameData(response?.payloadData);
    if (!payloadData) return;

    let parsed = null;
    try {
      parsed = JSON.parse(payloadData);
    } catch {}
    const decodedFrame = parsed ? null : this._buildDecodedFrameSummary(payloadData, response?.opcode);

    this.onApiTraffic({
      type: `websocket-${direction}`,
      requestId,
      timestamp: timestamp ? Math.round(timestamp * 1000) : Date.now(),
      url: socketInfo.url,
      fullUrl: socketInfo.url,
      method: direction === 'sent' ? 'WS-SEND' : 'WS-RECV',
      requestHeaders: {},
      requestBody: direction === 'sent' ? payloadData : '',
      requestDecodedFrame: direction === 'sent' ? decodedFrame : null,
      initiator: 'websocket',
      resourceType: 'WebSocket',
      status: 101,
      mimeType: 'websocket',
      responseHeaders: {},
      responseBody: direction === 'received' ? (parsed || payloadData) : '',
      decodedFrame: direction === 'received' ? decodedFrame : null,
      isJson: !!parsed,
      opcode: response?.opcode,
    });
  }

  _handleResponseHeaders(params) {
    const { requestId, response, type } = params;
    const { url, status, mimeType } = response;
    const requestEntry = this._requestMap.get(requestId) || null;

    if (!this._shouldCaptureRequest(url, requestEntry?.resourceType || type, mimeType)) return;

    const nextEntry = {
      ...(requestEntry || {
        requestId,
        timestamp: Date.now(),
        url,
        fullUrl: url,
        method: 'GET',
        requestHeaders: {},
        requestBody: '',
        initiator: '',
        initiatorDetails: {},
        resourceType: type || '',
        documentURL: '',
      }),
      status,
      mimeType,
      responseHeaders: this._summarizeHeaders(response.headers),
    };
    this._requestMap.set(requestId, nextEntry);
  }

  async _handleLoadingFinished(params) {
    const { requestId } = params || {};
    if (!requestId) return;
    const requestEntry = this._requestMap.get(requestId);
    if (!requestEntry) return;
    await this._finalizeRequest(requestId, requestEntry);
  }

  _handleLoadingFailed(params) {
    const { requestId, errorText, canceled } = params || {};
    if (!requestId) return;
    const requestEntry = this._requestMap.get(requestId);
    if (!requestEntry) return;
    this._requestMap.delete(requestId);
    const apiTraffic = {
      ...requestEntry,
      status: requestEntry.status || 0,
      mimeType: requestEntry.mimeType || '',
      responseHeaders: requestEntry.responseHeaders || {},
      responseBody: '',
      isJson: false,
      loadingFailed: true,
      errorText: errorText || '',
      canceled: !!canceled,
      triggerContext: this.getLatestAction(requestEntry.timestamp) || null,
    };
    this._log('network', `[FAILED] ${requestEntry.url} (${errorText || 'unknown'})`, apiTraffic);
    this.onApiTraffic(apiTraffic);
  }

  async _finalizeRequest(requestId, requestEntry) {
    const shortUrl = requestEntry.url;

    try {
      const result = await this.debugger.sendCommand('Network.getResponseBody', { requestId });
      const body = result.base64Encoded
        ? Buffer.from(result.body, 'base64').toString('utf-8')
        : result.body;

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }

      const logEntry = {
        timestamp: Date.now(),
        url: shortUrl,
        fullUrl: requestEntry.fullUrl || shortUrl,
        status: requestEntry.status,
        mimeType: requestEntry.mimeType,
        bodySize: body.length,
        body: parsed || body.slice(0, 2000),
        isJson: !!parsed,
      };
      const apiTraffic = {
        ...requestEntry,
        status: requestEntry.status,
        mimeType: requestEntry.mimeType,
        responseHeaders: requestEntry.responseHeaders || {},
        responseBody: parsed || body.slice(0, 4000),
        isJson: !!parsed,
        triggerContext: this.getLatestAction(requestEntry.timestamp) || null,
      };

      this._log('network', `[${requestEntry.status}] ${shortUrl} (${body.length}B)`, apiTraffic);
      this.onApiTraffic(apiTraffic);

      if (parsed) {
        this._analyzeForMessages(parsed, logEntry);
      }
    } catch (error) {
      const message = String(error?.message || error || '').slice(0, 260);
      const apiTraffic = {
        ...requestEntry,
        status: requestEntry.status || 0,
        mimeType: requestEntry.mimeType || '',
        responseHeaders: requestEntry.responseHeaders || {},
        responseBody: '',
        isJson: false,
        responseBodyUnavailable: true,
        responseBodyError: message,
        triggerContext: this.getLatestAction(requestEntry.timestamp) || null,
      };
      this._log('network', `[${apiTraffic.status}] ${shortUrl} (body unavailable)`, apiTraffic);
      this.onApiTraffic(apiTraffic);
    } finally {
      this._requestMap.delete(requestId);
    }
  }

  /**
   * 分析 JSON 响应，尝试识别消息相关数据
   * 同时尝试从中提取具体的客户消息文本
   */
  _analyzeForMessages(data, logEntry) {
    const json = JSON.stringify(data);

    const messageIndicators = [
      'msg_list', 'message_list', 'messages', 'msg_info',
      'chat_msg', 'im_msg', 'recv_msg', 'new_msg',
      'content', 'text', 'send_time', 'from_uid',
      'buyer', 'customer', 'sender', 'receiver',
    ];

    const foundIndicators = messageIndicators.filter(ind => json.includes(ind));

    if (foundIndicators.length >= 2) {
      this._log('important', `发现疑似消息数据! URL: ${logEntry.url} 指标: ${foundIndicators.join(',')}`);

      // 输出顶层键名以及嵌套数据结构（仅前几次）
      if (!this._structureLogged) this._structureLogged = 0;
      if (this._structureLogged < 5) {
        this._structureLogged++;
        const topKeys = Object.keys(data);
        this._log('info', `[结构探测] ${logEntry.url} 顶层键: ${topKeys.join(', ')}`);
        for (const k of topKeys) {
          const v = data[k];
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
            this._log('info', `[结构探测]   ${k}: 数组(${v.length}) 元素键: ${Object.keys(v[0]).slice(0,15).join(', ')}`);
            // 输出第一个元素的概要
            const sample = {};
            for (const [sk, sv] of Object.entries(v[0]).slice(0, 10)) {
              sample[sk] = typeof sv === 'string' ? sv.slice(0, 50) : (typeof sv === 'object' ? `[${Array.isArray(sv)?'Array':'Object'}]` : sv);
            }
            this._log('info', `[结构探测]   ${k}[0] 概要: ${JSON.stringify(sample)}`);
          } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            const subKeys = Object.keys(v);
            this._log('info', `[结构探测]   ${k}: 对象 键: ${subKeys.slice(0,15).join(', ')}`);
            // 深入一层
            for (const sk of subKeys.slice(0, 5)) {
              const sv = v[sk];
              if (Array.isArray(sv) && sv.length > 0 && typeof sv[0] === 'object') {
                this._log('info', `[结构探测]     ${k}.${sk}: 数组(${sv.length}) 元素键: ${Object.keys(sv[0]).slice(0,15).join(', ')}`);
                const sample2 = {};
                for (const [sk2, sv2] of Object.entries(sv[0]).slice(0, 12)) {
                  sample2[sk2] = typeof sv2 === 'string' ? sv2.slice(0, 60) : (typeof sv2 === 'object' ? `[${Array.isArray(sv2)?'Array':'Object'}]` : sv2);
                }
                this._log('info', `[结构探测]     ${k}.${sk}[0]: ${JSON.stringify(sample2)}`);
              }
            }
          }
        }
      }

      this.onMessage(logEntry);

      // 尝试从响应中提取客户消息
      const inWarmup = Date.now() - this._startTime < this._warmupMs;
      const extracted = this._extractCustomerMessages(data);
      this._log('info', `[提取结果] ${logEntry.url} 提取到 ${extracted.length} 条消息 (warmup=${inWarmup})`);
      for (const msg of extracted) {
        this._log('info', `[消息详情] 文本="${msg.text.slice(0,40)}" 客户=${msg.customer} ts=${msg.timestamp}`);
        const dedupKey = `${msg.text}|${msg.timestamp}`;
        if (this._seenMessages.has(dedupKey)) continue;
        this._seenMessages.add(dedupKey);
        // 防止集合无限增长
        if (this._seenMessages.size > 500) {
          const arr = [...this._seenMessages];
          this._seenMessages = new Set(arr.slice(-200));
        }
        if (inWarmup) {
          this._log('info', `[网络提取] 宽限期内忽略历史消息: ${msg.text.slice(0, 50)}`);
          continue;
        }
        this._log('important', `[网络提取] 客户消息: ${msg.text.slice(0, 50)}`);
        this.onCustomerMessage?.(msg);
      }
    }
  }

  /**
   * 递归遍历 JSON 数据，提取客户发送的文本消息
   * 识别策略：查找 msg_list/messages 数组，筛选 role=buyer 或 from 字段
   */
  _extractCustomerMessages(data) {
    const results = [];
    const seen = new Set();

    const tryExtractFromArray = (arr) => {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        // 跳过客服/系统/机器人消息
        const role = item.role || item.msg_from || item.from_type || item.sender_role || item.type;
        const roleStr = String(role || '').toLowerCase();
        if (['seller', 'system', 'robot', 'service', 'kf', 'agent', 'bot',
             '2', '3', '4', '99'].includes(roleStr)) continue;
        // 额外检查：如果有 is_seller/is_robot 等标记
        if (item.is_seller || item.is_robot || item.is_system || item.is_service ||
            item.from_system === true || item.auto_reply === true) continue;
        // 识别为买家消息的条件
        const isBuyer = roleStr === 'buyer' || roleStr === 'customer' || roleStr === 'user' ||
                        roleStr === '1' || roleStr === '0' ||
                        item.is_buyer === true || item.is_buyer === 1 ||
                        item.sender_type === 1 || item.sender_type === 0;
        // 提取文本
        const text = item.content || item.text || item.msg_content || item.message ||
                     item.body || item.msg_text || item.msg || '';
        const textStr = typeof text === 'string' ? text.trim() : (text?.text?.trim() || '');
        if (!textStr || textStr.length < 1 || textStr.length > 500) continue;
        // 跳过图片、订单卡片等非文本消息
        const msgType = item.msg_type || item.message_type || item.content_type;
        if (msgType && typeof msgType === 'number' && msgType !== 1 && msgType !== 0) continue;
        if (/^(https?:\/\/|data:image)/.test(textStr)) continue;
        if (seen.has(textStr)) continue;
        seen.add(textStr);
        // 过滤典型的客服/机器人话术（以"亲"开头的问候语大概率是卖家消息）
        const sellerPhrasePatterns = [
          /^亲[，,].*帮.*[？?~]$/,
          /^亲[，,]您好/,
          /^您好[！!~].*欢迎/,
          /^欢迎光临/
        ];
        if (!isBuyer && sellerPhrasePatterns.some(p => p.test(textStr))) continue;
        if (isBuyer || !role) {
          // PDD 的 from 字段可能是对象 {uid, name, nick, ...}
          const fromObj = (item.from && typeof item.from === 'object') ? item.from : {};
          const userInfo = (item.user_info && typeof item.user_info === 'object') ? item.user_info : {};
          results.push({
            text: textStr,
            customer: item.nick || item.nickname || item.buyer_name ||
                      fromObj.nick || fromObj.name || fromObj.nickname ||
                      userInfo.nick || userInfo.name || userInfo.nickname ||
                      item.from_name || item.sender_name || '未知客户',
            timestamp: item.send_time || item.time || item.ts || item.timestamp || item.created_at || Date.now(),
            conversationId: item.conversation_id || item.session_id || item.chat_id ||
                            item.msg_id || fromObj.uid || ''
          });
        }
      }
    };

    const walk = (obj, depth = 0, path = '') => {
      if (depth > 8 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
        tryExtractFromArray(obj);
        if (results.length === 0 && obj.length <= 5) {
          // 输出数组中第一个元素的键名，帮助理解数据结构
          this._log('info', `[数据探测] ${path} 数组(${obj.length}项) 键名: ${Object.keys(obj[0]).join(', ')}`);
        }
      }
      for (const key of Object.keys(obj)) {
        if (['msg_list', 'message_list', 'messages', 'msg_info', 'chat_msg',
             'im_msg', 'recv_msg', 'new_msg', 'data', 'result', 'list',
             'items', 'records', 'response', 'conversations', 'conv_list',
             'chat_list', 'msg_data', 'message_data'].includes(key)) {
          walk(obj[key], depth + 1, `${path}.${key}`);
        }
      }
    };

    walk(data);
    return results;
  }

  _log(type, text, data) {
    this.onLog({ type, text, data, timestamp: Date.now() });
  }
}

module.exports = { NetworkMonitor };
