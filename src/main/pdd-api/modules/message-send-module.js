'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const messageParsers = require('../parsers/message-parsers');

const PDD_BASE = 'https://mms.pinduoduo.com';
const PDD_UPLOAD_BASES = [
  'https://galerie-api.pdd.net',
  'https://galerie-api.htj.pdd.net',
  'https://mms-static-1.pddugc.com',
];
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;

// 消息发送相关业务模块，覆盖人工发送上下文准备、发送前置校验、文本/图片/
// 视频/链接发送、媒体上传、视频素材库查询等。模块本身无 EventEmitter 能力，
// 通过 this.client 复用 PddApiClient 已有的请求、会话、签名等基础设施。

class MessageSendModule {
  constructor(client) {
    this.client = client;
  }

  async _sendPendingConfirmData(sessionRef, pendingConfirmData = {}, options = {}) {
    const client = this.client;
    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    const referenceConsumerMessageId = Number(
      pendingConfirmData?.referenceConsumerMessageId
      || pendingConfirmData?.refConsumerMessageId
      || 0
    );
    const type = Number(pendingConfirmData?.type || 2) || 2;
    const needChangeTrusteeship = options.needChangeTrusteeship === true;
    if (!uid || !referenceConsumerMessageId) return null;
    return client._post('/refraction/robot/mall/trusteeshipState/sendPendingConfirmDataNew', {
      uid,
      type,
      referenceConsumerMessageId,
      needChangeTrusteeship,
    }, {
      'content-type': 'application/json;charset=UTF-8',
    });
  }

  async _refreshManualSendAntiContent() {
    const client = this.client;
    const rawBody = client._getLatestRawRequestBody('/xg/pfb/a2');
    if (!rawBody) return null;
    const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    return client._requestRaw('POST', 'https://xg.pinduoduo.com/xg/pfb/a2', body, {
      'content-type': 'application/json',
      Referer: `${PDD_BASE}/`,
    });
  }

  async _prepareManualSendContext(sessionRef) {
    const client = this.client;
    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    const sessionId = String(sessionMeta?.sessionId || '');
    const uid = String(sessionMeta?.userUid || sessionMeta?.customerId || '').trim();
    client._log('[API] 发送前准备人工发送上下文', { sessionId, uid });

    let trusteeshipPayload = null;
    try {
      trusteeshipPayload = await client._queryTrusteeshipState(sessionMeta);
    } catch (error) {
      client._log('[API] queryTrusteeshipState 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    const initialTrusteeshipInfo = trusteeshipPayload?.result || null;
    const latestTrusteeshipInfo = client._getLatestTrusteeshipStateInfo(sessionMeta);
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
        client._log('[API] sendPendingConfirmDataNew 成功', {
          sessionId,
          uid,
          type: Number(pendingConfirmData?.type || 2) || 2,
          referenceConsumerMessageId: Number(pendingConfirmData?.referenceConsumerMessageId || 0) || 0,
          needChangeTrusteeship: canRestoreTrusteeship,
        });
        await new Promise(resolve => setTimeout(resolve, 350));
        trusteeshipPayload = await client._queryTrusteeshipState(sessionMeta);
      } catch (error) {
        client._log('[API] sendPendingConfirmDataNew 失败', {
          sessionId,
          uid,
          message: error?.message || '未知异常',
        });
      }
    }
    try {
      await client._queryReplyState(sessionMeta);
    } catch (error) {
      client._log('[API] queryReplyState 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    let bizPayload = null;
    try {
      bizPayload = await client._updateChatBizInfo(sessionMeta);
    } catch (error) {
      client._log('[API] updateChatBizInfo 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    try {
      await client._notifyTyping(sessionMeta);
    } catch (error) {
      client._log('[API] conv/typing 失败', { sessionId, uid, message: error?.message || '未知异常' });
    }
    try {
      await this._refreshManualSendAntiContent();
    } catch (error) {
      client._log('[API] xg/pfb/a2 刷新失败', { sessionId, uid, message: error?.message || '未知异常' });
    }

    const preCheckInfo = bizPayload?.result?.sendMessageCheckData?.preCheckInfo || null;
    const trusteeshipInfo = trusteeshipPayload?.result || null;
    return {
      checked: true,
      trusteeshipInfo: trusteeshipInfo ? client._cloneJson(trusteeshipInfo) : null,
      preCheckInfo: preCheckInfo ? client._cloneJson(preCheckInfo) : null,
      pendingConfirmData: pendingConfirmData ? client._cloneJson(pendingConfirmData) : null,
      pendingConfirmExecuted,
    };
  }

  _buildSendMessageTemplate(sessionRef, text, ts, hash) {
    const client = this.client;
    const { sessionMeta, ids } = client._getSessionIdentityCandidates(sessionRef);
    const shop = client._getShopInfo();
    const mallId = client._getMallId();
    const hasSendMessageTemplate = !!client._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const template = client._getLatestMessageTemplate(sessionMeta) || {};
    const buyerInfo = client._getLatestBuyerInfo(sessionMeta);
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
    const client = this.client;
    const requestBody = {
      chat_type_id: 1,
      file_usage: 1,
    };
    let payload;
    if (typeof client._requestInPddPage === 'function') {
      payload = await client._requestInPddPage({
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
      payload = await client._post('/plateau/file/pre_upload', requestBody);
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
    const client = this.client;
    const fileBuffer = await fs.readFile(filePath);
    const ticket = await this._getPreUploadTicket();
    const requestBody = {
      image: this._toImageDataUrl(fileBuffer, this._guessMimeType(filePath)),
    };
    if (ticket.uploadSignature) {
      requestBody.upload_sign = ticket.uploadSignature;
      requestBody.upload_signature = ticket.uploadSignature;
    }
    const payload = typeof client._requestInPddPage === 'function'
      ? await client._requestInPddPage({
          method: 'POST',
          url: ticket.uploadUrl,
          source: 'chat-file:upload',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        })
      : await client._requestRaw('POST', ticket.uploadUrl, JSON.stringify(requestBody), {
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

  _normalizeComparableMessageText(text) {
    return messageParsers.normalizeComparableMessageText(text);
  }

  async _confirmSentTextMessage(sessionRef, text, options = {}) {
    const client = this.client;
    const attempts = Math.max(1, Number(options.attempts || 8));
    const delayMs = Math.max(0, Number(options.delayMs || 700));
    const pageSize = Math.max(20, Number(options.pageSize || 50));
    const expectedText = this._normalizeComparableMessageText(text);
    const sentAtMs = Number(options.sentAtMs || Date.now());
    for (let index = 0; index < attempts; index++) {
      const messages = await client.getSessionMessages(sessionRef, 1, pageSize);
      const matched = messages.find(message => {
        const actor = client._getMessageActor(message?.raw || message);
        if (actor === 'buyer') return false;
        const messageText = this._normalizeComparableMessageText(message.content);
        if (!messageText || messageText !== expectedText) return false;
        const timestampMs = client._normalizeTimestampMs(message.timestamp);
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
        await client._sleep(delayMs);
      }
    }
    return { confirmed: false };
  }

  async _confirmPendingConfirmMessage(sessionRef, pendingConfirmData = {}, options = {}) {
    const client = this.client;
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
      const messages = await client.getSessionMessages(sessionRef, 1, pageSize);
      const matched = messages.find(message => {
        const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
        const timestampMs = client._normalizeTimestampMs(message.timestamp);
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
        await client._sleep(delayMs);
      }
    }
    return { confirmed: false };
  }

  async _requestVideoMaterialApi(urlPath, body = {}) {
    const client = this.client;
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      Referer: `${PDD_BASE}/material/service`,
      Origin: PDD_BASE,
    };
    if (typeof client._requestInPddPage === 'function') {
      return client._requestInPddPage({
        method: 'POST',
        url: urlPath,
        source: 'video-material:page-request',
        headers,
        body: JSON.stringify(body || {}),
      });
    }
    return client._post(urlPath, body || {}, headers);
  }

  _normalizeVideoFile(item = {}) {
    const client = this.client;
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
      raw: client._cloneJson(item),
    };
  }

  _buildSendMessageBody(sessionRef, text) {
    const client = this.client;
    const { sessionMeta, ids } = client._getSessionIdentityCandidates(sessionRef);
    const latestTraffic = client._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const templateBody = client._safeParseJson(latestTraffic?.requestBody);
    const latestListTraffic = client._getLatestSessionTraffic('/plateau/chat/list', ids);
    const latestListBody = client._safeParseJson(latestListTraffic?.requestBody) || client._getLatestRequestBody('/plateau/chat/list');
    const latestConversationsBody = client._getLatestRequestBody('/plateau/chat/latest_conversations');
    const bodyAntiContent = templateBody?.data?.anti_content
      || latestListBody?.data?.anti_content
      || latestConversationsBody?.data?.anti_content
      || client._getLatestAntiContent();
    const topAntiContent = templateBody?.anti_content
      || latestListBody?.anti_content
      || latestConversationsBody?.anti_content
      || bodyAntiContent;
    const requestId = client._nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const random = client._randomHex(32);
    const hash = client._buildMessageHash(sessionMeta.sessionId || sessionMeta.userUid || sessionMeta.customerId || '', text, ts, random);
    const message = this._buildSendMessageTemplate(sessionMeta, text, ts, hash);

    if (templateBody) {
      const body = client._cloneJson(templateBody);
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
      body.client = body.client || client._getLatestClientValue();
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
      client: client._getLatestClientValue(),
      anti_content: topAntiContent,
    };
  }

  _getUploadBases() {
    return PDD_UPLOAD_BASES;
  }

  async _getUploadSignature(baseUrl, bucketTag = 'chat-merchant') {
    const client = this.client;
    const payload = await client._requestRaw('POST', `${baseUrl}/get_signature`, JSON.stringify({
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
    const client = this.client;
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
        const payload = await client._requestRaw('POST', `${baseUrl}/v3/store_image`, form, {
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
    throw client._createStepError('upload', attempts[0]?.error || '图片上传失败', { attempts });
  }

  _buildSendImageBody(sessionRef, imageUrl, imageMeta = {}) {
    const client = this.client;
    const { sessionMeta, ids } = client._getSessionIdentityCandidates(sessionRef);
    const latestTraffic = client._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    const templateBody = client._safeParseJson(latestTraffic?.requestBody);
    const latestListTraffic = client._getLatestSessionTraffic('/plateau/chat/list', ids);
    const latestListBody = client._safeParseJson(latestListTraffic?.requestBody) || client._getLatestRequestBody('/plateau/chat/list');
    const latestConversationsBody = client._getLatestRequestBody('/plateau/chat/latest_conversations');
    const bodyAntiContent = templateBody?.data?.anti_content
      || latestListBody?.data?.anti_content
      || latestConversationsBody?.data?.anti_content
      || client._getLatestAntiContent();
    const topAntiContent = templateBody?.anti_content
      || latestListBody?.anti_content
      || latestConversationsBody?.anti_content
      || bodyAntiContent;
    const requestId = client._nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const random = client._randomHex(32);
    const hash = client._buildMessageHash(sessionMeta.sessionId || sessionMeta.userUid || sessionMeta.customerId || '', imageUrl, ts, random);
    const message = this._buildSendImageTemplate(sessionMeta, imageUrl, ts, hash, imageMeta);

    if (templateBody) {
      const body = client._cloneJson(templateBody);
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
      body.client = body.client || client._getLatestClientValue();
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
      client: client._getLatestClientValue(),
      anti_content: topAntiContent,
    };
  }

  async _ensureSendMessageContext(sessionRef) {
    const client = this.client;
    const { ids, sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    const hasSessionMessageTraffic = !!client._getLatestSessionTraffic('/plateau/chat/list', ids);
    const hasSessionSendTraffic = !!client._getLatestSessionTraffic('/plateau/chat/send_message', ids);
    if (hasSessionMessageTraffic || hasSessionSendTraffic) return;
    client._log('[API] 发送前预热会话上下文', {
      sessionId: String(sessionMeta?.sessionId || ''),
      customerId: String(sessionMeta?.customerId || ''),
      userUid: String(sessionMeta?.userUid || ''),
    });
    try {
      await client.getSessionMessages(sessionMeta, 1, 30);
    } catch (error) {
      client._log('[API] 发送前预热失败', {
        sessionId: String(sessionMeta?.sessionId || ''),
        message: error?.message || '未知异常',
      });
    }
  }

  async sendMessage(sessionRef, text, options = {}) {
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
    }

    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    const manualSource = String(options?.manualSource || 'manual').trim() || 'manual';
    const sendStartedAtMs = Date.now();
    const preparedContext = await this._prepareManualSendContext(sessionMeta);
    const preCheckInfo = preparedContext?.checked
      ? (preparedContext.preCheckInfo || null)
      : client._getLatestSendMessagePreCheck(sessionMeta);
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
              preCheckInfo: client._cloneJson(preCheckInfo),
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
          client.emit('messageSent', pendingResult);
          return pendingResult;
        }
      }
      if (preCheckName === 'noViciousTalk') {
        client._log('[API] noViciousTalk 前置校验未放行，继续尝试真实 send_message', {
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
      error.payload = { success: true, preCheckInfo: client._cloneJson(preCheckInfo) };
      throw error;
      }
    }
    await this._ensureSendMessageContext(sessionMeta);
    const requestBody = this._buildSendMessageBody(sessionMeta, text);
    client._log('[API] 发送消息', {
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
      payload = await client._post('/plateau/chat/send_message', requestBody);
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
    const businessError = client._normalizeBusinessError(payload);
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
      if (client._isAuthError(businessError.code)) {
        throw client._markAuthExpired(error, {
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
      client._log('[API] 消息发送未确认，按接口成功返回', {
        sessionId: String(sessionMeta.sessionId || ''),
        targetUid: String(requestBody?.data?.message?.to?.uid || ''),
        payloadKeys: Object.keys(payload?.result || payload?.data || payload || {}),
      });
    } else {
      client._log('[API] 消息发送确认成功', {
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
    client.emit('messageSent', result);
    return result;
  }

  async sendManualMessage(sessionRef, text, options = {}) {
    return this.sendMessage(sessionRef, text, {
      ...options,
      manualSource: options?.manualSource || 'manual',
    });
  }

  async sendImage(sessionRef, filePath) {
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
    }

    let uploadResult;
    try {
      uploadResult = await this.uploadImage(filePath);
    } catch (error) {
      if (!error.step) {
        throw client._createStepError('upload', error.message);
      }
      throw error;
    }
    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    const imageUrl = uploadResult?.processed_url || uploadResult?.url;
    const imageMeta = await this._buildImageMessageMeta(filePath, uploadResult);
    const requestBody = this._buildSendImageBody(sessionMeta, imageUrl, imageMeta);
    client._log('[API] 发送图片', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      filePath: path.basename(filePath || ''),
      imageUrl,
      client: requestBody?.client,
      uploadBaseUrl: uploadResult?.uploadBaseUrl,
    });
    let payload;
    try {
      payload = await client._post('/plateau/chat/send_message', requestBody);
    } catch (error) {
      throw client._createStepError('send', error.message, {
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
    client.emit('messageSent', result);
    return result;
  }

  async sendImageUrl(sessionRef, imageUrl, extra = {}) {
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
    }
    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
    const imageMeta = await this._buildImageMessageMeta(extra?.filePath || '', extra);
    const requestBody = this._buildSendImageBody(sessionMeta, imageUrl, imageMeta);
    client._log('[API] 发送图片', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: String(requestBody?.data?.message?.to?.uid || ''),
      filePath: extra?.filePath ? path.basename(extra.filePath) : '',
      imageUrl,
      client: requestBody?.client,
      uploadBaseUrl: extra?.uploadBaseUrl || '',
    });
    let payload;
    try {
      payload = await client._post('/plateau/chat/send_message', requestBody);
    } catch (error) {
      throw client._createStepError('send', error.message, {
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
    client.emit('messageSent', result);
    return result;
  }

  async getVideoLibrary(params = {}) {
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
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
    const payload = await client._post('/latitude/user/file/list', requestBody, {
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
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
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
    const client = this.client;
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
      await client._sleep(pollMs);
    }
    throw new Error(lastDetail?.checkComment || lastError?.message || '视频转码超时，请稍后重试');
  }

  async sendVideoUrl(sessionRef, videoUrl, extra = {}) {
    const client = this.client;
    if (!client._sessionInited) {
      await client.initSession();
    }
    const { sessionMeta } = client._getSessionIdentityCandidates(sessionRef);
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
    client._log('[API] 发送视频', {
      sessionId: String(sessionMeta.sessionId || ''),
      targetUid: uid,
      videoUrl: url,
    });
    const payload = await client._post('/plateau/message/library_file/send', requestBody, {
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
    client.emit('messageSent', result);
    return result;
  }
}

module.exports = { MessageSendModule };
