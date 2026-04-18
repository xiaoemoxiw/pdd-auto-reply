'use strict';

const orderRemarkParsers = require('../parsers/order-remark-parsers');

// 订单备注业务模块。承接订单备注的接口请求、状态缓存、读取保存、回读校验
// 等所有逻辑。模块持有标签选项缓存与单订单备注缓存。所有外部依赖（请求/
// 业务错误归一化/日志/会话信息）通过构造函数注入的 PddApiClient 访问。

class OrderRemarkModule {
  constructor(client) {
    this.client = client;
    this.tagOptionsCache = null;
    this.cache = new Map();
  }

  async requestApi(urlPath, body = {}) {
    const client = this.client;
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
    };
    let payload = null;
    const via = typeof client._requestInPddPage === 'function' ? 'page' : 'direct';
    client._log('[API] 订单备注请求开始', orderRemarkParsers.summarizeOrderRemarkRequest(urlPath, body, via));
    if (typeof client._requestInPddPage === 'function') {
      payload = await client._requestInPddPage({
        method: 'POST',
        url: urlPath,
        source: 'order-remark:page-request',
        headers,
        body: JSON.stringify(body || {}),
      });
    } else {
      payload = await client._post(urlPath, body || {}, headers);
    }
    client._log('[API] 订单备注请求返回', {
      ...orderRemarkParsers.summarizeOrderRemarkRequest(urlPath, body, via),
      response: this.summarizeResponse(payload),
    });
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      const error = new Error(businessError.message);
      error.errorCode = businessError.code;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  summarizeResponse(payload) {
    if (!payload || typeof payload !== 'object') {
      return {
        type: typeof payload,
      };
    }
    const candidates = this.client._collectBusinessPayloadCandidates(payload);
    const first = candidates[0] || payload;
    return {
      success: first?.success,
      ok: first?.ok,
      errorCode: first?.error_code ?? first?.code ?? first?.err_no ?? first?.errno ?? null,
      message: first?.error_msg || first?.message || first?.msg || '',
      resultKeys: first?.result && typeof first.result === 'object' ? Object.keys(first.result).slice(0, 10) : [],
    };
  }

  getTagName(tag) {
    return orderRemarkParsers.getOrderRemarkTagName(tag, this.tagOptionsCache);
  }

  async getOperatorName() {
    const client = this.client;
    try {
      const userInfo = await client.getUserInfo();
      const username = String(userInfo?.username || '').trim();
      if (username) return username;
    } catch {}
    try {
      const profile = await client.getServiceProfile();
      const username = String(profile?.username || '').trim();
      if (username) return username;
      const serviceName = String(profile?.serviceName || '').trim();
      if (serviceName) return serviceName;
    } catch {}
    return String(client._getShopInfo()?.name || '').trim() || '主账号';
  }

  getCache(orderSn) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) return null;
    const cached = this.cache.get(normalizedOrderSn);
    if (!cached || typeof cached !== 'object') return null;
    return this.client._cloneJson(cached);
  }

  setCache(orderSn, remark = {}) {
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) return null;
    const nextRemark = {
      orderSn: normalizedOrderSn,
      note: orderRemarkParsers.extractOrderRemarkText(remark?.note),
      tag: orderRemarkParsers.normalizeOrderRemarkTag(remark?.tag),
      tagName: String(remark?.tagName || '').trim(),
      source: Number(remark?.source) > 0 ? Number(remark.source) : 1,
    };
    this.cache.set(normalizedOrderSn, nextRemark);
    return this.client._cloneJson(nextRemark);
  }

  async getTagOptions(force = false) {
    const client = this.client;
    if (this.tagOptionsCache && !force) {
      return client._cloneJson(this.tagOptionsCache);
    }
    let payload;
    try {
      payload = await this.requestApi('/pizza/order/remarkTag/query', {});
    } catch (error) {
      if (this.tagOptionsCache) {
        return client._cloneJson(this.tagOptionsCache);
      }
      throw error;
    }
    const result = orderRemarkParsers.normalizeOrderRemarkTagOptions(payload);
    this.tagOptionsCache = result;
    return client._cloneJson(result);
  }

  async getRemark(orderSn, source = 1) {
    const client = this.client;
    const normalizedOrderSn = String(orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const requestBody = {
      orderSn: normalizedOrderSn,
      source: Number(source) > 0 ? Number(source) : 1,
    };
    const [noteResult, noteTagResult] = await Promise.allSettled([
      this.requestApi('/pizza/order/note/query', requestBody),
      this.requestApi('/pizza/order/noteTag/query', requestBody),
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
    const note = orderRemarkParsers.extractOrderRemarkText(noteTagData?.note) || orderRemarkParsers.extractOrderRemarkText(noteData);
    const tag = orderRemarkParsers.normalizeOrderRemarkTag(client._pickRefundText([noteTagData], ['tag', 'tagCode', 'color', 'colorCode']));
    const tagName = client._pickRefundText([noteTagData], ['tagName', 'tag_name', 'colorName', 'color_name']);
    return this.setCache(normalizedOrderSn, {
      orderSn: normalizedOrderSn,
      note,
      tag,
      tagName,
      source: requestBody.source,
    });
  }

  async saveRemark(params = {}) {
    const client = this.client;
    const normalizedOrderSn = String(params?.orderSn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const source = Number(params?.source) > 0 ? Number(params.source) : 1;
    const baseNote = String(params?.note || '').trim().slice(0, 300);
    const tag = orderRemarkParsers.normalizeOrderRemarkTag(params?.tag);
    const baseTagName = String(params?.tagName || '').trim();
    const tagName = baseTagName || this.getTagName(tag);
    let finalNote = baseNote;
    if (params?.autoAppendMeta) {
      const operatorName = await this.getOperatorName();
      const metaText = orderRemarkParsers.formatOrderRemarkMeta();
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
          responsePayload = await this.requestApi(candidate.url, candidate.body);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (canRetryAfterIntervalError && orderRemarkParsers.isOrderRemarkSaveIntervalError(error)) {
            canRetryAfterIntervalError = false;
            await client._sleep(1100);
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
        latestRemark = await this.getRemark(normalizedOrderSn, source);
      } catch (error) {
        lastError = error;
      }
      if (!lastError && orderRemarkParsers.isOrderRemarkSaveMatched(latestRemark, finalNote, tag)) {
        break;
      }
      if (!lastError) {
        client._log('[API] 订单备注写入后回读未生效', {
          candidateUrl: candidate.url,
          orderSn: orderRemarkParsers.maskOrderRemarkOrderSn(normalizedOrderSn),
          expected: {
            noteLength: orderRemarkParsers.extractOrderRemarkText(finalNote).length,
            tag,
          },
          actual: {
            noteLength: orderRemarkParsers.extractOrderRemarkText(latestRemark?.note).length,
            tag: orderRemarkParsers.normalizeOrderRemarkTag(latestRemark?.tag),
          },
        });
        lastError = new Error('备注保存未生效，请重试');
      }
      if (index < candidates.length - 1) {
        await client._sleep(1100);
      }
    }
    if (lastError && orderRemarkParsers.isOrderRemarkSaveIntervalError(lastError)) {
      try {
        latestRemark = await this.getRemark(normalizedOrderSn, source);
        if (orderRemarkParsers.isOrderRemarkSaveMatched(latestRemark, finalNote, tag)) {
          lastError = null;
        }
      } catch {}
    }
    if (lastError) {
      throw lastError;
    }
    if (!latestRemark) {
      try {
        latestRemark = await this.getRemark(normalizedOrderSn, source);
      } catch {}
    }
    const cachedRemark = this.setCache(normalizedOrderSn, {
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
}

module.exports = { OrderRemarkModule };
