const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      BrowserWindow: class {},
      session: {
        fromPartition() {
          return {};
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { PddApiClient } = require('../src/main/pdd-api');

async function testResetStaleCursor() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/list',
    requestBody: JSON.stringify({
      client: 1,
      anti_content: 'top-anti',
      data: {
        anti_content: 'body-anti',
        list: {
          with: { role: 'user', id: 'session-1' },
          start_msg_id: 'old-msg-id',
          start_index: 20,
          size: 30,
        }
      }
    })
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  client._sessionInited = true;
  let capturedBody = null;
  client._post = async (url, body) => {
    capturedBody = { url, body };
    return {
      data: {
        msg_list: [{
          msg_id: 'm1',
          session_id: 'session-1',
          content: 'latest',
          send_time: 1,
        }]
      }
    };
  };

  const messages = await client.getSessionMessages('session-1', 1, 30);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(capturedBody.url, '/plateau/chat/list');
  assert.strictEqual(capturedBody.body.data.list.with.id, 'session-1');
  assert.strictEqual(capturedBody.body.data.list.start_msg_id, null);
  assert.strictEqual(capturedBody.body.data.list.start_index, 0);
}

async function testReuseLatestWindow() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/list',
    requestBody: JSON.stringify({
      client: 1,
      anti_content: 'top-anti',
      data: {
        anti_content: 'body-anti',
        list: {
          with: { role: 'user', id: 'session-1' },
          start_msg_id: null,
          start_index: 0,
          size: 30,
        }
      }
    })
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  client._sessionInited = true;
  let capturedBody = null;
  client._post = async (url, body) => {
    capturedBody = { url, body };
    return { data: { msg_list: [] } };
  };

  await client.getSessionMessages('session-1', 1, 30);
  assert.strictEqual(capturedBody.body.data.list.start_msg_id, null);
  assert.strictEqual(capturedBody.body.data.list.start_index, 0);
}

function testParseNestedSessionPreview() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const sessions = client._parseSessionList({
    data: {
      list: [{
        session_id: 'session-2',
        nick: '客户A',
        last_msg: {
          text: '00:40 最新消息',
          send_time: 1743352800,
        },
      }]
    }
  });

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].lastMessage, '00:40 最新消息');
  assert.strictEqual(sessions[0].lastMessageTime, 1743352800);
}

function testParseSessionListMarksLastMessageActor() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const sessions = client._parseSessionList({
    data: {
      list: [{
        session_id: 'session-actor',
        buyer_id: 'buyer-actor',
        last_msg: {
          text: '买家最新消息',
          send_time: 1743352800,
          sender_role: 'buyer',
        },
      }]
    }
  });

  assert.strictEqual(sessions[0].lastMessageActor, 'buyer');
  assert.strictEqual(sessions[0].lastMessageIsFromBuyer, true);
}

function testParseSessionListKeepsConversationIdentity() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const sessions = client._parseSessionList({
    data: {
      list: [{
        conversation_id: 'conv-1',
        buyer_id: 'buyer-1',
        user_info: { uid: 'buyer-1', nickname: '客户B' },
        last_msg: { text: '新消息', send_time: 1743352800 },
      }]
    }
  });

  assert.strictEqual(sessions[0].sessionId, 'conv-1');
  assert.strictEqual(sessions[0].conversationId, 'conv-1');
  assert.strictEqual(sessions[0].customerId, 'buyer-1');
  assert.strictEqual(sessions[0].userUid, 'buyer-1');
}

function testParseSessionIdentityPrefersBuyerUid() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const identity = client._parseSessionIdentity({
    conversation_id: 'conv-2',
    from: { uid: 'mall-1' },
    to: { uid: 'buyer-2' },
    user_info: { uid: 'buyer-2' },
  });

  assert.strictEqual(identity.customerId, 'buyer-2');
  assert.strictEqual(identity.userUid, 'buyer-2');
}

function testParseSessionIdentityUsesBuyerFromUidForPendingSession() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    },
    getShopInfo() {
      return { mallId: 90001 };
    }
  });

  const identity = client._parseSessionIdentity({
    conversation_id: 'conv-pending',
    from_uid: 'buyer-pending',
    from: { uid: 'buyer-pending' },
    to: { uid: '90001' },
  });

  assert.strictEqual(identity.customerId, 'buyer-pending');
  assert.strictEqual(identity.userUid, 'buyer-pending');
}

function testParseMessagesMarksSystemNotice() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const messages = client._parseMessages({
    data: {
      msg_list: [{
        msg_id: 'sys-1',
        content: '您接待过此消费者，为避免插播、抢答，机器人已暂停接待',
        send_time: 1743446492,
        from: { role: 'system' },
      }]
    }
  });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].actor, 'system');
  assert.strictEqual(messages[0].isSystem, true);
  assert.strictEqual(messages[0].isFromBuyer, false);
}

function testParseMessagesMarksSystemNoticeByContent() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    },
    getShopInfo() {
      return { mallId: 90001 };
    }
  });

  const messages = client._parseMessages({
    data: {
      msg_list: [{
        msg_id: 'sys-plain',
        content: '您接待过此消费者，为避免插播、抢答，机器人已暂停接待，>>点此【立即恢复接待】<<',
        send_time: 1743446493,
        from: { uid: 'buyer-3' },
        to: { uid: '90001' },
      }]
    }
  });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].actor, 'system');
  assert.strictEqual(messages[0].isSystem, true);
  assert.strictEqual(messages[0].isFromBuyer, false);
}

function testSystemNoticeOverridesBuyerRole() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const messages = client._parseMessages({
    data: {
      msg_list: [{
        msg_id: 'sys-role-user',
        content: '您接待过此消费者，为避免插播、抢答，机器人已暂停接待，>>点此【立即恢复接待】<<',
        send_time: 1743446494,
        to: { role: 'user', uid: 'buyer-5' },
        from: { uid: 'mall-1' },
      }]
    }
  });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].actor, 'system');
  assert.strictEqual(messages[0].isSystem, true);
  assert.strictEqual(messages[0].isFromBuyer, false);
}

function testParseMessagesMarksRefundSystemNotices() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    },
    getShopInfo() {
      return { mallId: 90001 };
    }
  });

  const messages = client._parseMessages({
    data: {
      msg_list: [
        {
          msg_id: 'refund-system-1',
          content: '[消费者已同意您发起的退款申请，请及时处理]',
          send_time: 1743446495,
          from: { uid: 'buyer-8' },
          to: { uid: '90001' },
        },
        {
          msg_id: 'refund-system-2',
          content: '退款成功',
          send_time: 1743446496,
          from: { uid: 'buyer-8' },
          to: { uid: '90001' },
        }
      ]
    }
  });

  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].actor, 'system');
  assert.strictEqual(messages[0].isSystem, true);
  assert.strictEqual(messages[0].isFromBuyer, false);
  assert.strictEqual(messages[1].actor, 'system');
  assert.strictEqual(messages[1].isSystem, true);
  assert.strictEqual(messages[1].isFromBuyer, false);
}

function testFilterDisplaySessions() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).getTime() / 1000;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 0, 0).getTime() / 1000;

  const sessions = client._filterDisplaySessions([
    { sessionId: 'today-chat', lastMessageTime: today, createdAt: yesterday },
    { sessionId: 'today-created', lastMessageTime: yesterday, createdAt: today },
    { sessionId: 'old-session', lastMessageTime: yesterday, createdAt: yesterday },
  ]);

  assert.deepStrictEqual(sessions.map(item => item.sessionId), ['today-chat', 'today-created']);
}

function testFilterDisplaySessionsIgnoresSellerPendingState() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 0, 0).getTime() / 1000;

  const sessions = client._filterDisplaySessions([
    {
      sessionId: 'buyer-pending',
      lastMessageTime: yesterday,
      createdAt: yesterday,
      lastMessageActor: 'buyer',
      waitTime: 60,
    },
    {
      sessionId: 'seller-replied',
      lastMessageTime: yesterday,
      createdAt: yesterday,
      lastMessageActor: 'seller',
      waitTime: 60,
      unreadCount: 1,
      isTimeout: true,
    },
  ]);

  assert.deepStrictEqual(sessions.map(item => item.sessionId), ['buyer-pending']);
}

async function testGetSessionListFiltersOldSessions() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0).getTime() / 1000;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 0, 0).getTime() / 1000;

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  client._sessionInited = true;
  client._post = async () => ({
    data: {
      list: [
        { session_id: 'today-chat', nick: '客户1', last_msg: { text: '今天聊过', send_time: today } },
        { session_id: 'today-created', nick: '客户2', last_msg_time: yesterday, create_time: today, content: '今天创建' },
        { session_id: 'old-session', nick: '客户3', last_msg_time: yesterday, create_time: yesterday, content: '旧会话' },
      ]
    }
  });

  const sessions = await client.getSessionList(1, 20);
  assert.deepStrictEqual(sessions.map(item => item.sessionId), ['today-chat', 'today-created']);
}

async function testGetSessionMessagesRetriesConversationIdentity() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/list',
    requestBody: JSON.stringify({
      client: 1,
      anti_content: 'top-anti',
      data: {
        anti_content: 'body-anti',
        list: {
          with: { role: 'user', id: 'buyer-1' },
          start_msg_id: null,
          start_index: 0,
          size: 30,
        }
      }
    })
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  client._sessionInited = true;
  const attempts = [];
  client._post = async (_url, body) => {
    attempts.push(`${body.data.list.with.role}:${body.data.list.with.id}`);
    if (body.data.list.with.id === 'conv-1') {
      return {
        data: {
          msg_list: [{
            msg_id: 'm1',
            conversation_id: 'conv-1',
            content: '客户今天新发的消息',
            send_time: 1,
          }]
        }
      };
    }
    return { data: { msg_list: [] } };
  };

  const messages = await client.getSessionMessages({
    sessionId: 'buyer-1',
    conversationId: 'conv-1',
    customerId: 'buyer-1',
    raw: {
      conversation_id: 'conv-1',
      user_info: { uid: 'buyer-1' },
    }
  }, 1, 30);

  assert.strictEqual(messages.length, 1);
  assert.ok(attempts.includes('user:conv-1'));
}

function testBuildSendImageBody() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/send_message',
    requestBody: JSON.stringify({
      data: {
        cmd: 'send_message',
        anti_content: 'body-anti',
        message: {
          to: { role: 'user', uid: 'session-1' },
          from: { role: 'mall_cs', uid: 'mall-1' },
          type: 0,
        },
      },
      client: 1,
      anti_content: 'top-anti',
    })
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  const body = client._buildSendImageBody('session-1', 'https://img.example.com/chat/test.png');
  assert.strictEqual(body.data.message.type, 2);
  assert.strictEqual(body.data.message.msg_type, 2);
  assert.strictEqual(body.data.message.message_type, 2);
  assert.strictEqual(body.data.message.content_type, 2);
  assert.deepStrictEqual(JSON.parse(body.data.message.content), {
    picture_url: 'https://img.example.com/chat/test.png',
    url: 'https://img.example.com/chat/test.png',
    type: 'image',
  });
  assert.strictEqual(body.data.message.extra.picture_url, 'https://img.example.com/chat/test.png');
}

function testGuessImageMimeType() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  assert.strictEqual(client._guessMimeType('/tmp/a.jpg'), 'image/jpeg');
  assert.strictEqual(client._guessMimeType('/tmp/a.png'), 'image/png');
  assert.strictEqual(client._guessMimeType('/tmp/a.webp'), 'image/webp');
  assert.deepStrictEqual(client._getUploadBases(), [
    'https://galerie-api.pdd.net',
    'https://galerie-api.htj.pdd.net',
    'https://mms-static-1.pddugc.com',
  ]);
}

function testNormalizeBusinessErrorNested() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const error = client._normalizeBusinessError({
    result: {
      data: {
        error_code: 7001,
        error_msg: '发送失败'
      }
    }
  });

  assert.deepStrictEqual(error, {
    code: 7001,
    message: '发送失败'
  });
}

async function testRequestRawSanitizesCrossOriginHeaders() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    },
    getShopInfo() {
      return { loginMethod: 'cookie' };
    }
  });

  client._buildHeaders = async () => ({
    cookie: 'a=1',
    pddid: 'pddid',
    etag: 'etag',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  });

  let capturedHeaders = null;
  client._getSession = () => ({
    fetch: async (url, options) => {
      capturedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        text: async () => '{"signature":"sig"}',
      };
    }
  });

  await client._requestRaw('POST', 'https://mms-static-1.pddugc.com/get_signature', '{}');
  assert.strictEqual(capturedHeaders.cookie, undefined);
  assert.strictEqual(capturedHeaders.pddid, undefined);
  assert.strictEqual(capturedHeaders.etag, undefined);
  assert.strictEqual(capturedHeaders['sec-fetch-site'], 'cross-site');
}

async function testSendImageUrl() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/send_message',
    requestBody: JSON.stringify({
      data: {
        cmd: 'send_message',
        anti_content: 'body-anti',
        message: {
          to: { role: 'user', uid: 'session-1' },
          from: { role: 'mall_cs', uid: 'mall-1' },
          type: 0,
        },
      },
      client: 1,
      anti_content: 'top-anti',
    })
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  client._sessionInited = true;
  client._post = async (url, body) => ({ ok: true, url, body });
  const result = await client.sendImageUrl('session-1', 'https://img.example.com/chat/test.png', {
    filePath: '/tmp/a.png',
    uploadBaseUrl: 'embedded-pdd-page',
  });

  assert.strictEqual(result.imageUrl, 'https://img.example.com/chat/test.png');
  assert.strictEqual(result.uploadBaseUrl, 'embedded-pdd-page');
  assert.strictEqual(result.response.url, '/plateau/chat/send_message');
  assert.strictEqual(JSON.parse(result.response.body.data.message.content).picture_url, 'https://img.example.com/chat/test.png');
}

async function testSendMessageRequiresConfirmation() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  client._sessionInited = true;
  client._sleep = async () => {};
  client._buildSendMessageBody = () => ({
    data: {
      message: {
        to: { uid: 'session-1' }
      },
      anti_content: 'body-anti'
    },
    client: 1,
    anti_content: 'top-anti'
  });
  client._post = async () => ({ result: { code: 0 } });
  client.getSessionMessages = async () => ([{
    messageId: 'm-1',
    content: 'hello',
    isFromBuyer: false,
    timestamp: Date.now(),
  }]);

  const result = await client.sendMessage('session-1', 'hello');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.messageId, 'm-1');
}

async function testSendMessageConfirmationAllowsUnknownActor() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    },
    getShopInfo() {
      return { mallId: 'mall-1' };
    }
  });

  client._sessionInited = true;
  client._sleep = async () => {};
  client._buildSendMessageBody = () => ({
    data: {
      message: {
        to: { uid: 'buyer-1' }
      },
      anti_content: 'body-anti'
    },
    client: 1,
    anti_content: 'top-anti'
  });
  client._post = async () => ({ result: { code: 0 } });
  client.getSessionMessages = async () => ([{
    messageId: 'm-2',
    content: 'hello',
    timestamp: Date.now(),
    raw: {},
  }]);

  const result = await client.sendMessage('session-1', 'hello');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.messageId, 'm-2');
}

function testGetLatestBuyerInfoFallsBackToSessionRaw() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  const userInfo = client._getLatestBuyerInfo({
    sessionId: 'session-raw',
    raw: {
      user_info: {
        uid: 'buyer-raw',
        nickname: '客户Raw'
      }
    }
  });

  assert.deepStrictEqual(userInfo, {
    uid: 'buyer-raw',
    nickname: '客户Raw'
  });
}

function testGetLatestMessageTemplateUsesSendMessageBody() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/send_message',
    requestBody: JSON.stringify({
      data: {
        message: {
          to: { role: 'user', uid: 'buyer-template' },
          from: { role: 'mall_cs', uid: 'mall-1' },
          pre_msg_id: 'msg-template'
        }
      }
    })
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  const template = client._getLatestMessageTemplate({
    sessionId: 'buyer-template',
    userUid: 'buyer-template',
    raw: {}
  });

  assert.strictEqual(template.to.uid, 'buyer-template');
  assert.strictEqual(template.pre_msg_id, 'msg-template');
}

function testGetLatestMessageTemplateIgnoresSystemMessage() {
  const traffic = [{
    url: 'https://mms.pinduoduo.com/plateau/chat/list',
    requestBody: JSON.stringify({
      data: {
        list: {
          with: { role: 'user', id: 'buyer-template' }
        }
      }
    }),
    responseBody: {
      data: {
        msg_list: [{
          msg_id: 'sys-2',
          content: '系统提示',
          from: { role: 'system' },
        }]
      }
    }
  }];

  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return traffic;
    }
  });

  const template = client._getLatestMessageTemplate({
    sessionId: 'buyer-template',
    userUid: 'buyer-template',
    raw: {}
  });

  assert.strictEqual(template, null);
}

async function testSendMessageAllowsUnconfirmedResult() {
  const client = new PddApiClient('shop-1', {
    getApiTraffic() {
      return [];
    }
  });

  client._sessionInited = true;
  client._sleep = async () => {};
  client._buildSendMessageBody = () => ({
    data: {
      message: {
        to: { uid: 'session-1' }
      },
      anti_content: 'body-anti'
    },
    client: 1,
    anti_content: 'top-anti'
  });
  client._post = async () => ({ result: { code: 0 } });
  client.getSessionMessages = async () => ([]);

  const result = await client.sendMessage('session-1', 'hello');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.confirmed, false);
  assert.match(result.warning, /接口已返回成功/);
}

async function main() {
  try {
    await testResetStaleCursor();
    await testReuseLatestWindow();
    testParseNestedSessionPreview();
    testParseSessionListMarksLastMessageActor();
    testParseSessionListKeepsConversationIdentity();
    testParseSessionIdentityPrefersBuyerUid();
    testParseSessionIdentityUsesBuyerFromUidForPendingSession();
    testParseMessagesMarksSystemNotice();
    testParseMessagesMarksSystemNoticeByContent();
    testSystemNoticeOverridesBuyerRole();
    testParseMessagesMarksRefundSystemNotices();
    testFilterDisplaySessions();
    testFilterDisplaySessionsIgnoresSellerPendingState();
    await testGetSessionListFiltersOldSessions();
    await testGetSessionMessagesRetriesConversationIdentity();
    testBuildSendImageBody();
    testGuessImageMimeType();
    testNormalizeBusinessErrorNested();
    await testRequestRawSanitizesCrossOriginHeaders();
    await testSendImageUrl();
    await testSendMessageRequiresConfirmation();
    await testSendMessageConfirmationAllowsUnknownActor();
    testGetLatestBuyerInfoFallsBackToSessionRaw();
    testGetLatestMessageTemplateUsesSendMessageBody();
    testGetLatestMessageTemplateIgnoresSystemMessage();
    await testSendMessageAllowsUnconfirmedResult();
    console.log('pdd-api-session-window-test passed');
  } finally {
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
