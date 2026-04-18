const { session } = require('electron');
const {
  normalizePddUserAgent,
  getChromeClientHintHeaders,
  applyIdentityHeaders,
  applyCookieContextHeaders
} = require('./pdd-request-profile');

const DEFAULT_PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_AUTH_ERROR_CODES = [40001, 43001, 43002];

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
    this._refreshMainCookieContext = typeof options.refreshMainCookieContext === 'function'
      ? options.refreshMainCookieContext
      : null;
    this._mainCookieEnsureInflight = null;

    // Phase 1 扩展能力：所有 flag 默认 false，扩展类按需开启即可启用对应增强逻辑。
    this._enableMainCookieContextRetry = options.enableMainCookieContextRetry === true;
    this._enableAuthExpiredEvent = options.enableAuthExpiredEvent === true;
    this._enableCrossOriginHandling = options.enableCrossOriginHandling === true;
    this._enableDeepBusinessErrorScan = options.enableDeepBusinessErrorScan === true;
    this._getMainCookieWhitelist = typeof options.getMainCookieWhitelist === 'function'
      ? options.getMainCookieWhitelist
      : null;
    this._authErrorCodes = Array.isArray(options.authErrorCodes) && options.authErrorCodes.length
      ? options.authErrorCodes.map(item => Number(item)).filter(item => Number.isFinite(item))
      : DEFAULT_AUTH_ERROR_CODES.slice();
    this._authExpired = false;
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

  _serializeCookieMap(cookieMap = {}, cookieNames = []) {
    return cookieNames
      .filter(name => name && cookieMap[name] !== undefined && cookieMap[name] !== null && cookieMap[name] !== '')
      .map(name => `${name}=${cookieMap[name]}`)
      .join('; ');
  }

  _buildMainCookieString(cookieMap = {}) {
    if (typeof this._getMainCookieWhitelist !== 'function') return '';
    const whitelist = this._getMainCookieWhitelist() || [];
    return this._serializeCookieMap(cookieMap, whitelist);
  }

  async _getMainCookieContextSummary() {
    const cookieMap = await this._getCookieMap();
    const cookieNames = Object.keys(cookieMap).sort();
    const mainCookieString = this._buildMainCookieString(cookieMap);
    const hasRequiredMainCookies = !!(cookieMap.PASS_ID && cookieMap._nano_fp && cookieMap.rckk);
    return {
      hasPassId: !!cookieMap.PASS_ID,
      hasNanoFp: !!cookieMap._nano_fp,
      hasRckk: !!cookieMap.rckk,
      hasVerifyAuthToken: !!cookieMap['msfe-pc-cookie-captcha-token'],
      hasRequiredMainCookies,
      usesWhitelistCookieString: !!(mainCookieString && hasRequiredMainCookies),
      cookieNameCount: cookieNames.length,
      cookieNames,
    };
  }

  // 业务接口（mercury/strickland/genji/...）服务端会校验主站 cookie：PASS_ID + _nano_fp + rckk。
  // 启动时仓库会清掉 persist:pddv2-${shopId} 的历史 session，partition 里只剩 api_uid，
  // 这时若立刻发售后/工单等业务请求，PDD 会回 success:false + errorMsg:'会话已过期…'。
  // 因此发请求前必须确保主 cookie 已注水，逻辑与 PddApiClient._prepareRequestHeaders 对齐。
  async _ensureMainCookieContextIfNeeded() {
    if (typeof this._refreshMainCookieContext !== 'function') return;
    const shop = this._getShopInfo();
    if (shop?.loginMethod !== 'token') return;
    const cookieMap = await this._getCookieMap();
    if (cookieMap.PASS_ID && cookieMap._nano_fp && cookieMap.rckk) return;
    if (!this._mainCookieEnsureInflight) {
      this._log(`[${this._errorLabel}] 关键 cookie 缺失，触发主 Cookie 上下文刷新`, {
        hasPassId: !!cookieMap.PASS_ID,
        hasNanoFp: !!cookieMap._nano_fp,
        hasRckk: !!cookieMap.rckk,
        cookieNameCount: Object.keys(cookieMap).length
      });
      this._mainCookieEnsureInflight = Promise.resolve()
        .then(() => this._refreshMainCookieContext({
          shopId: this.shopId,
          reason: 'business-api-missing-main-cookie',
          summary: {
            hasPassId: !!cookieMap.PASS_ID,
            hasNanoFp: !!cookieMap._nano_fp,
            hasRckk: !!cookieMap.rckk
          }
        }))
        .catch(error => {
          this._log(`[${this._errorLabel}] 主 Cookie 上下文刷新失败`, {
            message: error?.message || String(error || '')
          });
          return null;
        })
        .finally(() => {
          this._mainCookieEnsureInflight = null;
        });
    }
    await this._mainCookieEnsureInflight;
  }

  async _maybeRefreshMainCookieContext(reason = 'manual', payload = {}) {
    if (typeof this._refreshMainCookieContext !== 'function') return null;
    const shop = this._getShopInfo();
    if (shop?.loginMethod !== 'token') return null;
    this._log(`[${this._errorLabel}] 刷新主 Cookie 上下文`, {
      reason,
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
    return this._refreshMainCookieContext({
      shopId: this.shopId,
      reason,
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
  }

  _isAuthError(code) {
    const normalized = Number(code);
    if (!Number.isFinite(normalized)) return false;
    return this._authErrorCodes.includes(normalized);
  }

  _emitAuthExpired(payload = {}) {
    if (!this._enableAuthExpiredEvent) return;
    this._authExpired = true;
    if (typeof this.emit !== 'function') return;
    this.emit('authExpired', {
      shopId: this.shopId,
      errorCode: payload.errorCode || payload.statusCode || 0,
      errorMsg: payload.errorMsg || `${this._errorLabel}认证已失效`,
      authState: payload.authState || 'expired',
      source: payload.source || 'request',
    });
  }

  _markAuthExpired(error, payload = {}) {
    if (!error || typeof error !== 'object') return error;
    error.authExpired = true;
    error.authState = payload.authState || 'expired';
    if (this._enableAuthExpiredEvent) {
      this._emitAuthExpired(payload);
    }
    return error;
  }

  _shouldRetryWithMainCookieContextRefresh(error, options = {}) {
    if (!this._enableMainCookieContextRetry) return false;
    if (options.mainCookieContextRetried) return false;
    if (options.disableMainCookieContextRetry === true) return false;
    if (typeof this._refreshMainCookieContext !== 'function') return false;
    const shop = this._getShopInfo();
    if (shop?.loginMethod !== 'token') return false;
    if (error?.authExpired) return true;
    const statusCode = Number(error?.statusCode || 0);
    const errorCode = Number(error?.errorCode || 0);
    return [401, 403, 419].includes(statusCode) || this._isAuthError(errorCode);
  }

  // 在启用主 Cookie 上下文重试的客户端上，发请求前先做一次完整摘要校验：
  // 缺关键 cookie 时主动调用 refreshMainCookieContext 并复测；仍然不全则直接抛错避免空请求。
  async _prepareRequestHeaders(urlPart, extraHeaders = {}, options = {}) {
    let mainCookieContext = await this._getMainCookieContextSummary();
    const shop = this._getShopInfo();
    const shouldEnsureMainCookieContext = shop?.loginMethod === 'token'
      && options.ensureMainCookieContext !== false
      && (!mainCookieContext.hasPassId || !mainCookieContext.hasNanoFp || !mainCookieContext.hasRckk);
    if (shouldEnsureMainCookieContext) {
      await this._maybeRefreshMainCookieContext('missing-main-cookie-context', {
        summary: mainCookieContext,
      });
      mainCookieContext = await this._getMainCookieContextSummary();
    }
    if (!mainCookieContext.hasRequiredMainCookies) {
      const error = new Error(`${this._errorLabel}主站 Cookie 未完整建立`);
      error.mainCookieContext = mainCookieContext;
      throw error;
    }
    const headers = await this._buildHeaders(urlPart, extraHeaders);
    return { headers, mainCookieContext };
  }

  async _buildHeaders(urlPart, extraHeaders = {}) {
    const tokenInfo = this._getTokenInfo();
    const shop = this._getShopInfo();
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
      Referer: trafficHeaders.Referer || this._getRefererUrl(urlPart) || this._baseUrl,
      Origin: this._baseUrl,
      ...extraHeaders,
    };
    // 启用白名单时只挂主站关键 cookie，避免无关 partition cookie 干扰；
    // 没启用时维持原行为，cookie 头使用全量字符串。
    if (typeof this._getMainCookieWhitelist === 'function') {
      const mainCookie = this._buildMainCookieString(cookieMap);
      const hasRequiredMainCookies = !!(cookieMap.PASS_ID && cookieMap._nano_fp && cookieMap.rckk);
      if (hasRequiredMainCookies && mainCookie) {
        headers.cookie = mainCookie;
      }
      if (!hasRequiredMainCookies) {
        this._log(`[${this._errorLabel}] 请求关键 Cookie 缺失`, {
          hasPassId: !!cookieMap.PASS_ID,
          hasNanoFp: !!cookieMap._nano_fp,
          hasRckk: !!cookieMap.rckk,
        });
      }
    } else {
      const cookie = await this._getCookieString();
      if (cookie) headers.cookie = cookie;
    }
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
    if (this._enableDeepBusinessErrorScan) {
      const candidates = this._collectBusinessPayloadCandidates(payload);
      for (const item of candidates) {
        const error = this._extractBusinessError(item);
        if (error) return error;
      }
      return null;
    }
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

  _collectBusinessPayloadCandidates(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const queue = [payload];
    const visited = new Set();
    const result = [];
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      result.push(current);
      ['result', 'data', 'response'].forEach(key => {
        if (current[key] && typeof current[key] === 'object') {
          queue.push(current[key]);
        }
      });
    }
    return result;
  }

  _extractBusinessError(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const message = payload.error_msg || payload.errorMsg || payload.message || payload.msg || '';
    const successCodes = new Set([0, 200, 1000000]);
    if (payload.success === false || payload.ok === false) {
      return {
        code: payload.error_code || payload.code || payload.err_no || payload.errno || '',
        message: message || `${this._errorLabel}请求失败`,
      };
    }
    const explicitCode = payload.error_code ?? payload.err_no ?? payload.errno ?? payload.biz_code;
    if (
      explicitCode !== undefined
      && explicitCode !== null
      && explicitCode !== ''
      && !successCodes.has(Number(explicitCode))
    ) {
      return {
        code: explicitCode,
        message: message || `${this._errorLabel}请求失败`,
      };
    }
    const genericCode = payload.code;
    if (
      genericCode !== undefined
      && genericCode !== null
      && genericCode !== ''
      && Number.isFinite(Number(genericCode))
      && !successCodes.has(Number(genericCode))
      && message
    ) {
      return {
        code: genericCode,
        message,
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

  _isCrossOriginUrl(urlPath = '') {
    try {
      const target = new URL(urlPath.startsWith('http') ? urlPath : `${this._baseUrl}${urlPath}`);
      const origin = new URL(this._baseUrl);
      return target.origin !== origin.origin;
    } catch {
      return false;
    }
  }

  _applyCrossOriginHeaders(url, headers) {
    if (!this._isCrossOriginUrl(url)) return;
    if (this._enableCrossOriginHandling) {
      // 跨域请求带主站 cookie/pddid/etag 会被 PDD 反作弊命中并丢回登录页，
      // 必须把这些字段一并去掉，确保浏览器层"无身份"地走过去。
      delete headers.cookie;
      delete headers.pddid;
      delete headers.etag;
      delete headers['sec-fetch-site'];
    }
    headers['sec-fetch-site'] = 'cross-site';
  }

  _createHttpError(payload, response, text) {
    if (typeof payload === 'object') {
      return new Error(payload?.error_msg || payload?.errorMsg || payload?.message || `HTTP ${response.status}`);
    }
    return new Error(`HTTP ${response.status}: ${String(text).slice(0, 200)}`);
  }

  // 内部统一收口：实际发请求 + 响应解析 + 登录态/业务错误判断 + auth 状态标记。
  // _request / _requestForm / _requestRaw 全部委托到这里。
  async _executeRequest({ method, url, urlPath, fetchOptions, suppressAuthExpired = false, logTag = this._errorLabel }) {
    let response = null;
    try {
      response = await this._getSession().fetch(url, fetchOptions);
    } catch (error) {
      throw new Error(`[${logTag}] ${method} ${url} 请求失败：${error?.message || 'network error'}`);
    }
    const text = await response.text();
    const payload = this._parsePayload(text);
    this._log(`[${logTag}] ${method} ${urlPath} -> ${response.status}`);

    if (this._isLoginPageResponse(response, text)) {
      const error = new Error(this._loginExpiredMessage);
      error.statusCode = response.status;
      error.payload = payload;
      if (this._enableAuthExpiredEvent) {
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'expired';
          throw error;
        }
        throw this._markAuthExpired(error, {
          statusCode: response.status,
          errorMsg: error.message,
          authState: 'expired',
          source: 'login-page',
        });
      }
      throw error;
    }

    if (!response.ok) {
      const error = this._createHttpError(payload, response, text);
      error.statusCode = response.status;
      error.payload = payload;
      if (this._enableAuthExpiredEvent && [401, 403, 419].includes(Number(response.status))) {
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'expired';
          throw error;
        }
        throw this._markAuthExpired(error, {
          statusCode: response.status,
          errorMsg: error.message,
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
      if (this._enableAuthExpiredEvent && this._isAuthError(businessError.code)) {
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'expired';
          throw error;
        }
        throw this._markAuthExpired(error, {
          errorCode: businessError.code,
          errorMsg: businessError.message,
          authState: 'expired',
          source: 'business-code',
        });
      }
      throw error;
    }

    if (this._enableAuthExpiredEvent) {
      this._authExpired = false;
    }
    return payload;
  }

  // 默认 attempt：构建 headers + 应用跨域 + 走 _executeRequest。
  // 由 _request / _requestForm / _requestRaw 各自传入 bodyBuilder 适配不同 payload 形态。
  async _runRequestAttempt({ method, urlPath, extraHeaders, attemptOptions, bodyBuilder, contextLabel }) {
    const url = this._resolveRequestUrl(urlPath);
    await this._ensureMainCookieContextIfNeeded();
    const suppressAuthExpired = !!attemptOptions.suppressAuthExpired;
    const headers = this._enableMainCookieContextRetry
      ? (await this._prepareRequestHeaders(urlPath, extraHeaders, attemptOptions)).headers
      : await this._buildHeaders(urlPath, extraHeaders);
    this._applyCrossOriginHeaders(url, headers);
    if (this._enableAuthExpiredEvent) {
      const shop = this._getShopInfo();
      if (shop?.loginMethod === 'token' && !headers['X-PDD-Token']) {
        const error = new Error(`当前店铺未恢复 Token，请重新导入 Token`);
        if (suppressAuthExpired) {
          error.authExpired = true;
          error.authState = 'token_missing';
          throw error;
        }
        throw this._markAuthExpired(error, {
          errorMsg: error.message,
          authState: 'token_missing',
          source: 'missing-token',
        });
      }
    }
    const fetchOptions = bodyBuilder({ method, headers });
    return this._executeRequest({
      method,
      url,
      urlPath,
      fetchOptions,
      suppressAuthExpired,
      logTag: contextLabel || this._errorLabel,
    });
  }

  async _runRequestWithRetry({ method, urlPath, extraHeaders, options, bodyBuilder, retryReason, contextLabel }) {
    const opts = options || {};
    const baseAttempt = (attemptOptions) => this._runRequestAttempt({
      method,
      urlPath,
      extraHeaders,
      attemptOptions,
      bodyBuilder,
      contextLabel,
    });
    if (!this._enableMainCookieContextRetry) {
      return baseAttempt({ suppressAuthExpired: !!opts.suppressAuthExpired });
    }
    const shop = this._getShopInfo();
    const deferAuthExpired = typeof this._refreshMainCookieContext === 'function' && shop?.loginMethod === 'token';
    try {
      return await baseAttempt({
        ensureMainCookieContext: opts.ensureMainCookieContext !== false,
        mainCookieContextRetried: false,
        suppressAuthExpired: deferAuthExpired ? true : !!opts.suppressAuthExpired,
      });
    } catch (error) {
      if (!this._shouldRetryWithMainCookieContextRefresh(error, opts)) {
        throw error;
      }
      await this._maybeRefreshMainCookieContext(retryReason || 'request-auth-retry', {
        urlPath,
        method,
        statusCode: Number(error?.statusCode || 0),
        errorCode: Number(error?.errorCode || 0),
      });
      return baseAttempt({
        ensureMainCookieContext: opts.ensureMainCookieContext !== false,
        mainCookieContextRetried: true,
        suppressAuthExpired: !!opts.suppressAuthExpired,
      });
    }
  }

  async _request(method, urlPath, body, extraHeaders = {}, options = {}) {
    return this._runRequestWithRetry({
      method,
      urlPath,
      extraHeaders,
      options,
      retryReason: 'request-auth-retry',
      bodyBuilder: ({ method: m, headers }) => {
        const fetchOptions = { method: m, headers };
        if (body !== undefined && body !== null) {
          fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        return fetchOptions;
      },
    });
  }

  async _requestForm(method, urlPath, formData, extraHeaders = {}, options = {}) {
    return this._runRequestWithRetry({
      method,
      urlPath,
      extraHeaders,
      options,
      retryReason: 'request-form-auth-retry',
      bodyBuilder: ({ method: m, headers }) => {
        delete headers['content-type'];
        delete headers['Content-Type'];
        return { method: m, headers, body: formData };
      },
    });
  }

  // 原始请求：body 不做 JSON.stringify（适用于已序列化字符串、Buffer、FormData）；
  // 跨域处理、auth 重试都按 flag 接入。pdd-api 后续 Phase 7 接基座后由它消费。
  async _requestRaw(method, urlPath, body, extraHeaders = {}, options = {}) {
    return this._runRequestWithRetry({
      method,
      urlPath,
      extraHeaders,
      options,
      retryReason: 'request-raw-auth-retry',
      bodyBuilder: ({ method: m, headers }) => {
        const fetchOptions = { method: m, headers };
        if (body instanceof FormData) {
          delete fetchOptions.headers['content-type'];
          delete fetchOptions.headers['Content-Type'];
        }
        if (body !== undefined && body !== null) {
          fetchOptions.body = body;
        }
        return fetchOptions;
      },
    });
  }
}

module.exports = {
  DEFAULT_PDD_BASE,
  DEFAULT_AUTH_ERROR_CODES,
  PddBusinessApiClient
};
