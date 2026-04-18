'use strict';

const sessionParsers = require('../parsers/session-parsers');

// 聊天会话列表与会话查找业务模块。承接：
//  - 会话列表所有解析/去重/过滤/排序辅助（薄包装到 sessionParsers）
//  - 会话列表请求体构造与 latest_conversations 接口的多级回退（直调 →
//    页面抓包缓存 → 内存缓存 → init 后重试）
//  - 按订单号查找会话，必要时通过 latitude history 合成会话
//
// 状态：sessionCache（来自 latest_conversations 的最近一次有效列表，被
// 多处页面与轮询消费）。所有外部依赖（请求/会话兜底/日志）通过 client。

class ChatSessionsModule {
  constructor(client) {
    this.client = client;
    this.sessionCache = [];
  }

  // ---------- 解析/工具辅助（薄包装到 sessionParsers） ----------

  extractSessionPreviewText(item) {
    return sessionParsers.extractSessionPreviewText(item);
  }

  extractSessionPreviewTime(item) {
    return sessionParsers.extractSessionPreviewTime(item);
  }

  getSessionDedupKey(session = {}) {
    return sessionParsers.getSessionDedupKey(session);
  }

  mergeSessionEntries(existing = {}, incoming = {}) {
    return sessionParsers.mergeSessionEntries(existing, incoming);
  }

  dedupeSessionList(sessions = []) {
    return sessionParsers.dedupeSessionList(sessions);
  }

  extractSessionCreatedTime(item) {
    return sessionParsers.extractSessionCreatedTime(item);
  }

  extractSessionLastMessageActor(item = {}) {
    return sessionParsers.extractSessionLastMessageActor(item, this.client._getMallId() || '');
  }

  normalizeTimestampMs(value) {
    return sessionParsers.normalizeTimestampMs(value);
  }

  isTodayTimestamp(value) {
    return sessionParsers.isTodayTimestamp(value);
  }

  getRecentSessionStartMs() {
    return sessionParsers.getRecentSessionStartMs();
  }

  isWithinRecentTwoDaysTimestamp(value) {
    return sessionParsers.isWithinRecentTwoDaysTimestamp(value);
  }

  hasPendingReplySession(session = {}) {
    return sessionParsers.hasPendingReplySession(session);
  }

  filterDisplaySessions(sessions = []) {
    return sessionParsers.filterDisplaySessions(sessions);
  }

  sortDisplaySessions(sessions = []) {
    return sessionParsers.sortDisplaySessions(sessions);
  }

  pickPendingBuyerMessage(messages = [], buyerIds = [], sessionMeta = {}) {
    return sessionParsers.pickPendingBuyerMessage(messages, buyerIds, sessionMeta, this.client._getMallId() || '');
  }

  parseSessionIdentity(item = {}) {
    return sessionParsers.parseSessionIdentity(item, this.client._getMallId() || '');
  }

  pickDisplayText(sources = [], keys = []) {
    return sessionParsers.pickDisplayText(sources, keys);
  }

  resolveBuyerParticipant(item = {}) {
    return sessionParsers.resolveBuyerParticipant(item, this.client._getMallId() || '');
  }

  extractSessionCustomerName(item = {}) {
    return sessionParsers.extractSessionCustomerName(item, this.client._getMallId() || '');
  }

  extractSessionCustomerAvatar(item = {}) {
    return sessionParsers.extractSessionCustomerAvatar(item, this.client._getMallId() || '');
  }

  extractMessageSenderName(item = {}) {
    return sessionParsers.extractMessageSenderName(item, this.client._getMallId() || '');
  }

  parseSessionList(payload) {
    return sessionParsers.parseSessionList(payload, this.client._getMallId() || '');
  }

  describeSessionListPayload(payload) {
    return sessionParsers.describeSessionListPayload(payload);
  }

  normalizeOrderSn(value) {
    return sessionParsers.normalizeOrderSn(value);
  }

  matchSessionByOrderSn(session = {}, orderSn = '') {
    return sessionParsers.matchSessionByOrderSn(session, orderSn);
  }

  // ---------- 会话列表 / 缓存回退 ----------

  getCachedSessionFallback() {
    const client = this.client;
    const urlParts = [
      '/plateau/chat/latest_conversations',
      '/plateau/conv_list/status',
    ];
    for (const urlPart of urlParts) {
      const cachedPayload = client._getLatestResponseBody(urlPart);
      const cachedSessions = this.filterDisplaySessions(this.parseSessionList(cachedPayload));
      if (cachedSessions.length > 0) {
        return { sessions: cachedSessions, source: urlPart };
      }
    }
    return { sessions: [], source: '' };
  }

  buildSessionListBody(page, pageSize, templateBody, antiContent) {
    const client = this.client;
    const requestBody = templateBody
      ? {
          ...client._cloneJson(templateBody),
          data: {
            ...templateBody.data,
            request_id: client._nextRequestId(),
            cmd: templateBody.data?.cmd || 'latest_conversations',
            page: page || templateBody.data?.page,
            offset: Math.max(0, (page - 1) * pageSize),
            size: pageSize || templateBody.data?.size,
            anti_content: templateBody.data?.anti_content || antiContent,
          },
          client: templateBody.client !== undefined && templateBody.client !== null && templateBody.client !== ''
            ? templateBody.client
            : client._getLatestClientValue(),
          anti_content: templateBody.anti_content || antiContent,
        }
      : {
          data: {
            request_id: client._nextRequestId(),
            cmd: 'latest_conversations',
            version: 2,
            need_unreply_time: true,
            page,
            size: pageSize,
            end_time: Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
            anti_content: antiContent,
          },
          client: client._getLatestClientValue(),
          anti_content: antiContent,
        };
    if (requestBody?.data && 'chat_type_id' in requestBody.data) {
      delete requestBody.data.chat_type_id;
    }
    return requestBody;
  }

  async getSessionList(page = 1, pageSize = 20, options = {}) {
    const client = this.client;
    const allowInitSession = options.allowInitSession !== false;
    // 不再前置 initSession：cookie 已经在主上下文里就绪后，fallback 模板的 latest_conversations
    // 通常就能 200 拿到真实数据。把 init 留作"请求失败/空"的兜底，避免每次都阻塞 ~20s。
    let templateBody = client._getLatestConversationRequestBody();
    let antiContent = templateBody?.anti_content || client._getLatestAntiContent();
    if (!templateBody && !antiContent && page === 1 && this.sessionCache.length === 0 && allowInitSession) {
      // 已经有 init 在跑，或本来就有 bootstrap 数据，等一小段把模板凑齐就好
      const bootstrapStatus = await client._waitForConversationBootstrap(800);
      templateBody = client._getLatestConversationRequestBody();
      antiContent = templateBody?.anti_content || client._getLatestAntiContent();
      client._log('[API] 首次会话拉取预热结果', bootstrapStatus);
    }
    const requestBody = this.buildSessionListBody(page, pageSize, templateBody, antiContent);
    client._log('[API] 拉取会话列表', {
      page,
      pageSize,
      client: requestBody?.client,
      hasTopAntiContent: !!requestBody?.anti_content,
      hasBodyAntiContent: !!requestBody?.data?.anti_content,
      chatTypeId: requestBody?.data?.chat_type_id,
      templateSource: templateBody ? 'traffic' : 'fallback',
    });
    try {
      const payload = await client._post('/plateau/chat/latest_conversations', requestBody);
      const parsedSessions = this.parseSessionList(payload);
      let sessions = this.filterDisplaySessions(parsedSessions);
      if (!sessions.length && parsedSessions.length > 0) {
        sessions = this.sortDisplaySessions(parsedSessions);
        client._log('[API] 会话列表近两天过滤后为空，回退展示原始会话', {
          parsedCount: parsedSessions.length,
          returnedCount: sessions.length,
        });
      }
      client._log('[API] 会话列表响应解析', {
        count: sessions.length,
        summary: this.describeSessionListPayload(payload),
      });
      if (sessions.length > 0) {
        this.sessionCache = sessions;
        return sessions;
      }
      if (page === 1 && this.sessionCache.length === 0) {
        const retryBootstrapStatus = await client._waitForConversationBootstrap(1500);
        const retryTemplateBody = client._getLatestConversationRequestBody();
        const retryAntiContent = retryTemplateBody?.anti_content || client._getLatestAntiContent();
        const retryRequestBody = this.buildSessionListBody(page, pageSize, retryTemplateBody, retryAntiContent);
        client._log('[API] latest_conversations 首次为空，准备重试', {
          bootstrapStatus: retryBootstrapStatus,
          client: retryRequestBody?.client,
          hasTopAntiContent: !!retryRequestBody?.anti_content,
          hasBodyAntiContent: !!retryRequestBody?.data?.anti_content,
          templateSource: retryTemplateBody ? 'traffic' : 'fallback',
        });
        await client._sleep(800);
        const retryPayload = await client._post('/plateau/chat/latest_conversations', retryRequestBody);
        const retryParsedSessions = this.parseSessionList(retryPayload);
        let retrySessions = this.filterDisplaySessions(retryParsedSessions);
        if (!retrySessions.length && retryParsedSessions.length > 0) {
          retrySessions = this.sortDisplaySessions(retryParsedSessions);
          client._log('[API] 会话列表重试近两天过滤后为空，回退展示原始会话', {
            parsedCount: retryParsedSessions.length,
            returnedCount: retrySessions.length,
          });
        }
        client._log('[API] 会话列表重试响应解析', {
          count: retrySessions.length,
          summary: this.describeSessionListPayload(retryPayload),
        });
        if (retrySessions.length > 0) {
          this.sessionCache = retrySessions;
          return retrySessions;
        }
      }
      const { sessions: cachedSessions, source } = this.getCachedSessionFallback();
      if (cachedSessions.length > 0) {
        this.sessionCache = cachedSessions;
        client._log('[API] latest_conversations 直调为空，回退页面抓取缓存', { source });
        return cachedSessions;
      }
      if (page === 1 && this.sessionCache.length > 0) {
        client._log('[API] latest_conversations 直调为空，回退内存会话缓存');
        return this.sessionCache;
      }
      this.sessionCache = sessions;
      client._log('[API] 会话列表拉取成功', {
        count: sessions.length,
        payloadKeys: Object.keys(payload?.result || payload?.data || {}),
      });
      return sessions;
    } catch (error) {
      const { sessions: cachedSessions, source } = this.getCachedSessionFallback();
      if (cachedSessions.length > 0) {
        this.sessionCache = cachedSessions;
        client._log('[API] latest_conversations 直调失败，回退页面抓取缓存', { message: error.message, source });
        return cachedSessions;
      }
      // 直调失败 + 缓存为空 + 允许 init + 尚未 init → 触发一次 init 后再试
      if (allowInitSession && !client._sessionInited) {
        client._log('[API] latest_conversations 直调失败，触发 initSession 后重试', { message: error.message });
        try {
          await client.initSession();
        } catch (initError) {
          client._log('[API] initSession 失败', { message: initError?.message || String(initError || '') });
        }
        const retryTemplateBody = client._getLatestConversationRequestBody();
        const retryAntiContent = retryTemplateBody?.anti_content || client._getLatestAntiContent();
        const retryRequestBody = this.buildSessionListBody(page, pageSize, retryTemplateBody, retryAntiContent);
        try {
          const retryPayload = await client._post('/plateau/chat/latest_conversations', retryRequestBody);
          const retryParsed = this.parseSessionList(retryPayload);
          let retrySessions = this.filterDisplaySessions(retryParsed);
          if (!retrySessions.length && retryParsed.length > 0) {
            retrySessions = this.sortDisplaySessions(retryParsed);
          }
          if (retrySessions.length > 0) {
            this.sessionCache = retrySessions;
            return retrySessions;
          }
        } catch (retryError) {
          client._log('[API] init 后重试仍失败', {
            message: retryError?.message || String(retryError || ''),
          });
        }
      }
      client._log('[API] 会话列表拉取失败', {
        message: error.message,
        statusCode: error.statusCode || 0,
        errorCode: error.errorCode || 0,
        payload: error.payload || null,
      });
      throw error;
    }
  }

  // ---------- 按订单号 / UID 查找会话 ----------

  findCachedSessionByOrderSn(orderSn = '', sessions = []) {
    const list = Array.isArray(sessions) ? sessions : [];
    const matched = list.find(item => this.matchSessionByOrderSn(item, orderSn));
    return matched ? this.client._cloneJson(matched) : null;
  }

  findCachedSessionByUid(uid = '') {
    const client = this.client;
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) return null;
    const cachedSessions = [
      ...this.sessionCache,
      ...this.parseSessionList(client._getLatestResponseBody('/plateau/chat/latest_conversations')),
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
    return matched ? client._cloneJson(matched) : null;
  }

  parseOrderHistoryMessageItem(item) {
    if (!item) return null;
    if (typeof item === 'string') {
      const parsed = this.client._safeParseJson(item);
      return parsed && typeof parsed === 'object' ? parsed : null;
    }
    return item && typeof item === 'object' ? item : null;
  }

  async getHistoryMessagesByOrderSn(orderSn, options = {}) {
    const client = this.client;
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单号');
    }
    const payload = await client._post('/latitude/message/getHistoryMessage', {
      orderSn: normalizedOrderSn,
      startTime: Math.max(0, Number(options?.startTime || 0) || 0),
      endTime: Math.max(0, Number(options?.endTime || Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000)),
      pageNum: Math.max(0, Number(options?.pageNum || 0) || 0),
      pageSize: Math.max(1, Math.min(Number(options?.pageSize || 20) || 20, 100)),
    });
    const normalizedList = (Array.isArray(payload?.result?.messageList) ? payload.result.messageList : [])
      .map(item => this.parseOrderHistoryMessageItem(item))
      .filter(Boolean);
    const messages = client._parseMessages({
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

  buildSyntheticSessionFromOrderHistory(orderSn = '', history = {}) {
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
    const cachedSession = this.findCachedSessionByUid(uid);
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
    const client = this.client;
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单号');
    }
    if (!client._sessionInited) {
      await client.initSession();
    }

    let matchedSession = this.findCachedSessionByOrderSn(normalizedOrderSn, this.sessionCache);
    if (matchedSession) {
      return matchedSession;
    }

    const pageLimit = Math.max(1, Math.min(Number(options?.pageLimit || 4) || 4, 10));
    const pageSize = Math.max(20, Math.min(Number(options?.pageSize || 50) || 50, 100));
    for (let page = 1; page <= pageLimit; page += 1) {
      const sessions = await this.getSessionList(page, pageSize);
      matchedSession = this.findCachedSessionByOrderSn(normalizedOrderSn, sessions);
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
      const syntheticSession = this.buildSyntheticSessionFromOrderHistory(normalizedOrderSn, history);
      if (!syntheticSession?.sessionId) {
        throw new Error('未找到对应订单会话');
      }
      return syntheticSession;
    } catch (error) {
      client._log('[API] 按订单号查找会话失败', {
        orderSn: normalizedOrderSn,
        message: error.message,
      });
      throw new Error('未找到对应订单会话');
    }
  }
}

module.exports = { ChatSessionsModule };
