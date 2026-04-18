const { session } = require('electron');
const {
  normalizePddUserAgent,
  getChromeClientHintHeaders,
  applyIdentityHeaders,
  applyCookieContextHeaders
} = require('./pdd-request-profile');

const DEFAULT_PDD_BASE = 'https://mms.pinduoduo.com';

class PddBusinessApiClient {
  constructor(shopId, options = {}) {
    this.shopId = shopId;
    this.partition = options.partition || `persist:pddv2-${shopId}`;
    this._baseUrl = options.baseUrl || DEFAULT_PDD_BASE;
    this._onLog = options.onLog || (() => {});
    this._getShopInfo = options.getShopInfo || (() => null);
    this._getApiTraffic = options.getApiTraffic || (() => []);
    this._getRefererUrl = options.getRefererUrl || (() => this._baseUrl);
    this._errorLabel = String(options.errorLabel || '业务接口').trim() || '业务接口';
    this._loginExpiredMessage = String(options.loginExpiredMessage || `${this._errorLabel}登录已失效，请重新导入 Token 或刷新登录态`).trim();
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

  _getApiTrafficEntries() {
    const list = this._getApiTraffic();
    return Array.isArray(list) ? list : [];
  }

  _findLatestTraffic(urlPart, predicate) {
    const list = this._getApiTrafficEntries();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i] || {};
      const url = String(entry?.url || '');
      const fullUrl = String(entry?.fullUrl || '');
      if (!url.includes(urlPart) && !fullUrl.includes(urlPart)) continue;
      if (typeof predicate === 'function' && !predicate(entry)) continue;
      return entry;
    }
    return null;
  }

  async _getCookieString() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  async _getCookieMap() {
    const cookies = await this._getSession().cookies.get({ domain: '.pinduoduo.com' });
    return cookies.reduce((acc, item) => {
      acc[item.name] = item.value;
      return acc;
    }, {});
  }

  async _buildHeaders(urlPart, extraHeaders = {}) {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
    const cookie = await this._getCookieString();
    const cookieMap = await this._getCookieMap();
    const trafficHeaders = this._findLatestTraffic(urlPart)?.requestHeaders || {};
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      ...getChromeClientHintHeaders('api'),
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      Referer: trafficHeaders.Referer || this._getRefererUrl() || this._baseUrl,
      Origin: this._baseUrl,
      ...extraHeaders,
    };
    if (cookie) headers.cookie = cookie;
    headers['user-agent'] = normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || '');
    applyIdentityHeaders(headers, tokenInfo);
    applyCookieContextHeaders(headers, cookieMap);
    return headers;
  }

  _parsePayload(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  _normalizeBusinessError(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const success = payload.success;
    const errorCode = Number(payload.error_code ?? payload.errorCode ?? payload.code ?? 0);
    if (success === false || (errorCode && errorCode !== 1000000)) {
      return {
        code: errorCode,
        message: payload.error_msg || payload.errorMsg || payload.message || `${this._errorLabel}失败`,
      };
    }
    return null;
  }

  _isLoginPageResponse(response, text) {
    const finalUrl = String(response?.url || '');
    if (finalUrl.includes('/login')) return true;
    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return false;
    const snippet = typeof text === 'string' ? text.slice(0, 800).toLowerCase() : '';
    return snippet.includes('登录') || snippet.includes('login') || snippet.includes('passport') || snippet.includes('扫码');
  }

  _resolveRequestUrl(urlPath) {
    return urlPath.startsWith('http') ? urlPath : `${this._baseUrl}${urlPath}`;
  }

  _applyCrossOriginHeaders(url, headers) {
    const isCrossOrigin = (() => {
      try {
        return new URL(url).origin !== this._baseUrl;
      } catch {
        return false;
      }
    })();
    if (isCrossOrigin) {
      headers['sec-fetch-site'] = 'cross-site';
    }
  }

  _createHttpError(payload, response, text) {
    if (typeof payload === 'object') {
      return new Error(payload?.error_msg || payload?.errorMsg || payload?.message || `HTTP ${response.status}`);
    }
    return new Error(`HTTP ${response.status}: ${String(text).slice(0, 200)}`);
  }

  async _request(method, urlPath, body, extraHeaders = {}) {
    const url = this._resolveRequestUrl(urlPath);
    const headers = await this._buildHeaders(urlPath, extraHeaders);
    this._applyCrossOriginHeaders(url, headers);
    const options = { method, headers };
    if (body !== undefined && body !== null) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    let response = null;
    try {
      response = await this._getSession().fetch(url, options);
    } catch (error) {
      throw new Error(`[${this._errorLabel}] ${method} ${url} 请求失败：${error?.message || 'network error'}`);
    }
    const text = await response.text();
    const payload = this._parsePayload(text);
    this._log(`[${this._errorLabel}] ${method} ${urlPath} -> ${response.status}`);
    if (this._isLoginPageResponse(response, text)) {
      throw new Error(this._loginExpiredMessage);
    }
    if (!response.ok) {
      throw this._createHttpError(payload, response, text);
    }
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message);
    }
    return payload;
  }

  async _requestForm(method, urlPath, formData, extraHeaders = {}) {
    const url = this._resolveRequestUrl(urlPath);
    const headers = await this._buildHeaders(urlPath, extraHeaders);
    this._applyCrossOriginHeaders(url, headers);
    delete headers['content-type'];
    delete headers['Content-Type'];
    let response = null;
    try {
      response = await this._getSession().fetch(url, { method, headers, body: formData });
    } catch (error) {
      throw new Error(`[${this._errorLabel}] ${method} ${url} 上传失败：${error?.message || 'network error'}`);
    }
    const text = await response.text();
    const payload = this._parsePayload(text);
    this._log(`[${this._errorLabel}] ${method} ${urlPath} -> ${response.status}`);
    if (this._isLoginPageResponse(response, text)) {
      throw new Error(this._loginExpiredMessage);
    }
    if (!response.ok) {
      throw this._createHttpError(payload, response, text);
    }
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message);
    }
    return payload;
  }
}

module.exports = {
  DEFAULT_PDD_BASE,
  PddBusinessApiClient
};
