'use strict';

// 聊天会话轮询业务模块。承接首轮预热、长期轮询、单会话拉取与"已读会话"
// 心跳，所有状态（_polling/_pollTimer/_seenMessageIds/_pollBootstrapDone）
// 都收敛在模块内部，PddApiClient 仅通过 facade 转发。
//
// 设计原则：
// 1. 不重复实现请求逻辑，统一通过 client._post / client.getSessionList /
//    client.getSessionMessages / client._findLatestTraffic 等基础能力完成。
// 2. 事件仍由 PddApiClient.emit 抛出（后台监听 newMessage/sessionUpdated
//    的代码无须改造），模块通过 client.emit 转发。
// 3. 安全模式：轮询路径上不允许隐式 initSession()，避免在后台拉起完整
//    chat-merchant 运行时导致已建立的会话被踢下线。

const POLL_INTERVAL = 5000;
const POLL_INTERVAL_IDLE = 15000;

class ChatPollingModule {
  constructor(client) {
    this.client = client;
    this._polling = false;
    this._pollTimer = null;
    this._seenMessageIds = new Set();
    this._pollBootstrapDone = false;
  }

  isPolling() {
    return this._polling;
  }

  start() {
    if (this._polling) return;
    this._polling = true;
    this._doPoll();
  }

  stop() {
    this._polling = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  resetSeenMessages() {
    this._seenMessageIds.clear();
    this._pollBootstrapDone = false;
  }

  async markLatestConversations(size = 100) {
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
    }

    const latestTraffic = client._findLatestTraffic('/plateau/chat/marked_lastest_conversations');
    const templateBody = client._safeParseJson(latestTraffic?.requestBody);
    const antiContent = templateBody?.anti_content || client._getLatestAntiContent();
    const requestBody = templateBody
      ? {
          ...client._cloneJson(templateBody),
          data: {
            ...(templateBody.data || {}),
            request_id: client._nextRequestId(),
            size,
          },
          client: templateBody.client !== undefined && templateBody.client !== null && templateBody.client !== ''
            ? templateBody.client
            : client._getLatestClientValue(),
        }
      : {
          data: {
            cmd: 'marked_lastest_conversations',
            request_id: client._nextRequestId(),
            size,
            anti_content: antiContent,
          },
          client: client._getLatestClientValue(),
          anti_content: antiContent,
        };

    return client._post('/plateau/chat/marked_lastest_conversations', requestBody);
  }

  async pollMessagesForSession(sessionRef, options = {}) {
    const client = this.client;
    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    // 安全模式：轮询过程中不允许隐式 initSession()，防止后台拉起完整 chat-merchant 运行时
    const messages = await client.getSessionMessages(sessionMeta.sessionId || sessionRef, 1, 20, { allowInitSession: false });
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
      ? client._pickPendingBuyerMessage(messages, buyerIds, sessionMeta.raw || sessionMeta)
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

  async _doPoll() {
    const client = this.client;
    if (!this._polling) return;

    try {
      // 安全模式：轮询读取会话列表时不允许隐式 initSession()，
      // 首轮若尚未建立会话，走页面抓包缓存回退，避免后台创建隐藏 BrowserWindow 加载 chat-merchant 而掉线
      const sessions = await client.getSessionList(1, 100, { allowInitSession: false });
      client.emit('sessionUpdated', sessions);

      const targets = sessions
        .filter(item => item.sessionId)
        .sort((a, b) => {
          const unreadDiff = Number(b.unreadCount || 0) - Number(a.unreadCount || 0);
          if (unreadDiff !== 0) return unreadDiff;
          return client._normalizeTimestampMs(b?.lastMessageTime) - client._normalizeTimestampMs(a?.lastMessageTime);
        })
        .slice(0, 20);

      if (!this._pollBootstrapDone) {
        const bootstrapTargets = sessions
          .filter(item => item.sessionId)
          .sort((a, b) => client._normalizeTimestampMs(b?.lastMessageTime) - client._normalizeTimestampMs(a?.lastMessageTime));
        const bootstrapPendingMessages = [];
        for (const sessionItem of bootstrapTargets) {
          const seededMessages = await this.pollMessagesForSession(sessionItem, {
            bootstrapOnly: true,
            emitBootstrapPending: true,
          });
          client._log('[API] Bootstrap检查会话', {
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
        client._log('[API] 首轮轮询预热完成', {
          seededSessions: bootstrapTargets.length,
          pendingSessions: bootstrapPendingMessages.length,
        });
        for (const item of bootstrapPendingMessages) {
          const message = item.message;
          const sessionItem = item.sessionItem;
          client.emit('newMessage', {
            shopId: client.shopId,
            sessionId: message.sessionId,
            customer: message.senderName || sessionItem.customerName || '未知客户',
            customerId: message.senderId || sessionItem.customerId || '',
            userUid: message.senderId || sessionItem.userUid || sessionItem.customerId || '',
            session: {
              ...client._cloneJson(sessionItem),
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
        const freshMessages = await this.pollMessagesForSession(sessionItem);
        for (const message of freshMessages) {
          client.emit('newMessage', {
            shopId: client.shopId,
            sessionId: message.sessionId,
            customer: message.senderName || sessionItem.customerName || '未知客户',
            customerId: message.senderId || sessionItem.customerId || '',
            userUid: message.senderId || sessionItem.userUid || sessionItem.customerId || '',
            session: {
              ...client._cloneJson(sessionItem),
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
        this.stop();
        return;
      }
      client._log(`[API] 轮询失败: ${error.message}`);
      this._schedulePoll(POLL_INTERVAL_IDLE);
    }
  }

  _schedulePoll(delay) {
    if (!this._polling) return;
    this._pollTimer = setTimeout(() => this._doPoll(), delay);
  }
}

module.exports = { ChatPollingModule, POLL_INTERVAL, POLL_INTERVAL_IDLE };
