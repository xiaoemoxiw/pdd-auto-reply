'use strict';

const shopProfileParsers = require('../parsers/shop-profile-parsers');
const { normalizePddUserAgent } = require('../../pdd-request-profile');

// 店铺信息业务模块。承接四个用于店铺核身的接口（userinfo / 客服资料 /
// commonMallInfo / queryFinalCredentialNew），并把 getShopProfile 聚合
// 调度与 probeCommonMallInfoRequest 的"安全模式核身"流程都收敛到模块内。
// 模块持有 serviceProfile 缓存，通过 client 访问请求/认证/cookie 上下文。

const PDD_BASE = 'https://mms.pinduoduo.com';

class ShopProfileModule {
  constructor(client) {
    this.client = client;
    this.serviceProfileCache = null;
  }

  invalidateServiceProfileCache() {
    this.serviceProfileCache = null;
  }

  parseUserInfo(payload) {
    const client = this.client;
    return shopProfileParsers.parseUserInfo(payload, {
      mallId: client._getMallId() || '',
      userId: client._getTokenInfo()?.userId || '',
    });
  }

  parseServiceProfile(payload) {
    const client = this.client;
    return shopProfileParsers.parseServiceProfile(payload, {
      mallId: client._getMallId() || '',
      shopName: client._getShopInfo()?.name || '',
    });
  }

  parseMallInfo(payload) {
    const client = this.client;
    return shopProfileParsers.parseMallInfo(payload, { mallId: client._getMallId() || '' });
  }

  parseCredentialInfo(payload) {
    const client = this.client;
    return shopProfileParsers.parseCredentialInfo(payload, { mallId: client._getMallId() || '' });
  }

  buildShopInfoRequestHeaders(type = 'default') {
    const client = this.client;
    const antiContent = client._getLatestAntiContent();
    if (type === 'credential') {
      return {
        Referer: `${PDD_BASE}/mallcenter/info/main/index`,
        Origin: PDD_BASE,
        ...(antiContent ? { 'anti-content': antiContent } : {}),
      };
    }
    return {
      Referer: PDD_BASE,
      Origin: PDD_BASE,
      ...(antiContent ? { 'anti-content': antiContent } : {}),
    };
  }

  async getUserInfo(options = {}) {
    const client = this.client;
    try {
      const payload = await client._post('/janus/api/userinfo', {}, this.buildShopInfoRequestHeaders('mall'), options);
      return this.parseUserInfo(payload);
    } catch (error) {
      const payload = await client._post('/janus/api/new/userinfo', {}, this.buildShopInfoRequestHeaders('mall'), options);
      return this.parseUserInfo(payload);
    }
  }

  async getServiceProfile(force = false, options = {}) {
    const client = this.client;
    if (this.serviceProfileCache && !force) {
      return this.serviceProfileCache;
    }

    const cachedPayload = client._getLatestResponseBody('/chats/userinfo/realtime');
    const cachedProfile = this.parseServiceProfile(cachedPayload);
    const hasCachedProfile = !!(cachedProfile.mallName || cachedProfile.serviceName || cachedProfile.serviceAvatar);
    if (hasCachedProfile && !force) {
      this.serviceProfileCache = cachedProfile;
      return cachedProfile;
    }

    try {
      const payload = await client._request('GET', '/chats/userinfo/realtime?get_response=true', null, {}, options);
      const profile = this.parseServiceProfile(payload);
      this.serviceProfileCache = profile;
      return profile;
    } catch (error) {
      if (hasCachedProfile) {
        this.serviceProfileCache = cachedProfile;
        return cachedProfile;
      }
      throw error;
    }
  }

  async getMallInfo(options = {}) {
    const client = this.client;
    const payload = await client._request('GET', '/earth/api/mallInfo/commonMallInfo', null, this.buildShopInfoRequestHeaders('mall'), options);
    return this.parseMallInfo(payload);
  }

  async getCredentialInfo(options = {}) {
    const client = this.client;
    const payload = await client._request('GET', '/earth/api/mallInfo/queryFinalCredentialNew', null, this.buildShopInfoRequestHeaders('credential'), options);
    return this.parseCredentialInfo(payload);
  }

  async getShopProfile(force = false) {
    const client = this.client;
    if (force) {
      this.serviceProfileCache = null;
    }
    const requestOptions = { suppressAuthExpired: true };
    const [userInfoResult, serviceProfileResult, mallInfoResult, credentialInfoResult] = await Promise.allSettled([
      this.getUserInfo(requestOptions),
      this.getServiceProfile(force, requestOptions),
      this.getMallInfo(requestOptions),
      this.getCredentialInfo(requestOptions)
    ]);
    const userInfo = userInfoResult.status === 'fulfilled' ? userInfoResult.value : {};
    const serviceProfile = serviceProfileResult.status === 'fulfilled' ? serviceProfileResult.value : {};
    const mallInfo = mallInfoResult.status === 'fulfilled' ? mallInfoResult.value : {};
    const credentialInfo = credentialInfoResult.status === 'fulfilled' ? credentialInfoResult.value : {};
    const resultEntries = [
      ['userInfo', userInfoResult],
      ['serviceProfile', serviceProfileResult],
      ['mallInfo', mallInfoResult],
      ['credentialInfo', credentialInfoResult]
    ];
    const apiResolvedSources = resultEntries
      .filter(([, item]) => item?.status === 'fulfilled')
      .map(([name]) => name);
    const apiFailedSources = resultEntries
      .filter(([, item]) => item?.status !== 'fulfilled')
      .map(([name]) => name);
    const apiAuthFailedSources = resultEntries
      .filter(([, item]) => item?.status === 'rejected' && (item.reason?.authExpired || client._isAuthError(item.reason?.errorCode)))
      .map(([name]) => name);
    if (apiResolvedSources.length > 0) {
      client._authExpired = false;
    }
    return {
      mallId: mallInfo.mallId || credentialInfo.mallId || serviceProfile.mallId || userInfo.mallId || client._getMallId() || '',
      mallName: mallInfo.mallName || credentialInfo.mallName || serviceProfile.mallName || '',
      account: userInfo.nickname || serviceProfile.serviceName || '',
      mobile: userInfo.mobile || '',
      category: mallInfo.category || '',
      logo: mallInfo.logo || serviceProfile.serviceAvatar || '',
      companyName: credentialInfo.companyName || '',
      merchantType: credentialInfo.merchantType || '',
      apiSuccessCount: apiResolvedSources.length,
      apiResolvedSources,
      apiFailedSources,
      apiAuthFailedCount: apiAuthFailedSources.length,
      apiAuthFailedSources,
    };
  }

  _summarizePreparedHeaders(headers = {}) {
    const userAgent = String(headers['user-agent'] || headers['User-Agent'] || '').trim();
    const cookieHeader = String(headers.cookie || '').trim();
    const cookieNames = cookieHeader
      ? cookieHeader
        .split(';')
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .map(item => item.split('=')[0].trim())
        .filter(Boolean)
      : [];
    return {
      hasCookie: !!cookieHeader,
      cookieNames,
      hasXToken: !!headers['X-PDD-Token'],
      hasWindowsAppToken: !!headers['windows-app-shop-token'],
      hasPddid: !!headers.pddid,
      hasEtag: !!headers.etag,
      hasVerifyAuthToken: !!(headers.VerifyAuthToken || headers.verifyauthtoken),
      hasAntiContent: !!(headers['anti-content'] || headers['Anti-Content']),
      referer: headers.Referer || headers.referer || '',
      origin: headers.Origin || headers.origin || '',
      secChUaPlatform: headers['sec-ch-ua-platform'] || '',
      userAgent,
      userAgentKind: userAgent.includes('PddWorkbench-Online')
        ? 'workbench'
        : (userAgent ? 'chrome-like' : 'missing'),
    };
  }

  _summarizeWarmupResult(result = null) {
    if (!result || typeof result !== 'object') return null;
    return {
      ready: !!result.ready,
      error: result.error || '',
      url: result.url || result.currentUrl || '',
      entryUrl: result.entryUrl || '',
      attemptedEntryUrls: Array.isArray(result.attemptedEntryUrls) ? result.attemptedEntryUrls : [],
      cookieNames: Array.isArray(result.cookieNames) ? result.cookieNames : [],
      cookieScopes: Array.isArray(result.cookieScopes) ? result.cookieScopes : [],
      hasPassId: !!result.hasPassId,
      hasNanoFp: !!result.hasNanoFp,
      hasRckk: !!result.hasRckk,
    };
  }

  _buildSafeApiResultSummary(result = {}) {
    return {
      success: !!result.success,
      skipped: !!result.skipped,
      error: result.error || '',
      statusCode: Number(result.statusCode || 0),
      errorCode: Number(result.errorCode || 0),
      authExpired: !!result.authExpired,
      mallId: result.mallId || '',
      mallName: result.mallName || '',
      username: result.username || '',
      nickname: result.nickname || '',
      companyName: result.companyName || '',
      merchantType: result.merchantType || '',
      category: result.category || '',
    };
  }

  async probeCommonMallInfoRequest(options = {}) {
    const client = this.client;
    const tokenInfo = client._getTokenInfo();
    const shop = client._getShopInfo();
    const requestHeaders = this.buildShopInfoRequestHeaders('mall');
    const mainCookieContextBefore = await client._getMainCookieContextSummary();
    let warmupResult = null;
    let warmupError = '';

    if (
      options.refreshMainCookieContext !== false
      && typeof client._refreshMainCookieContext === 'function'
      && shop?.loginMethod === 'token'
    ) {
      try {
        warmupResult = await client._refreshMainCookieContext({
          shopId: client.shopId,
          reason: 'manual-commonMallInfo-probe',
          source: 'shop-auth-probe',
        });
      } catch (error) {
        warmupError = error?.message || String(error);
      }
    }

    const mainCookieContextAfter = await client._getMainCookieContextSummary();
    let preparedHeaders = null;
    let prepareError = '';

    try {
      const prepared = await client._prepareRequestHeaders(undefined, requestHeaders, {
        ensureMainCookieContext: false,
      });
      preparedHeaders = this._summarizePreparedHeaders(prepared.headers);
    } catch (error) {
      prepareError = error?.message || String(error);
      const fallbackHeaders = await client._buildHeaders(undefined, requestHeaders);
      preparedHeaders = this._summarizePreparedHeaders(fallbackHeaders);
    }

    const missingRequiredCookies = [
      !mainCookieContextAfter.hasPassId ? 'PASS_ID' : '',
      !mainCookieContextAfter.hasNanoFp ? '_nano_fp' : '',
      !mainCookieContextAfter.hasRckk ? 'rckk' : '',
    ].filter(Boolean);

    let commonMallInfo = {
      success: false,
      skipped: !mainCookieContextAfter.hasRequiredMainCookies,
      error: mainCookieContextAfter.hasRequiredMainCookies
        ? ''
        : (prepareError || '主站 Cookie 未完整建立'),
      statusCode: 0,
      errorCode: 0,
      authExpired: false,
      mallId: '',
      mallName: '',
    };

    const userInfo = {
      success: false,
      skipped: !mainCookieContextAfter.hasRequiredMainCookies,
      error: mainCookieContextAfter.hasRequiredMainCookies
        ? ''
        : (prepareError || '主站 Cookie 未完整建立'),
      statusCode: 0,
      errorCode: 0,
      authExpired: false,
      mallId: '',
      username: '',
      nickname: '',
    };
    const credentialInfo = {
      success: false,
      skipped: !mainCookieContextAfter.hasRequiredMainCookies,
      error: mainCookieContextAfter.hasRequiredMainCookies
        ? ''
        : (prepareError || '主站 Cookie 未完整建立'),
      statusCode: 0,
      errorCode: 0,
      authExpired: false,
      mallId: '',
      mallName: '',
      companyName: '',
      merchantType: '',
    };

    if (mainCookieContextAfter.hasRequiredMainCookies) {
      try {
        const payload = await client._request(
          'GET',
          '/earth/api/mallInfo/commonMallInfo',
          null,
          requestHeaders,
          { suppressAuthExpired: true }
        );
        const info = this.parseMallInfo(payload);
        commonMallInfo = {
          success: true,
          skipped: false,
          error: '',
          statusCode: 200,
          errorCode: 0,
          authExpired: false,
          mallId: info?.mallId || '',
          mallName: info?.mallName || '',
          category: info?.category || '',
          logo: info?.logo || '',
        };
      } catch (error) {
        commonMallInfo = {
          success: false,
          skipped: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode || 0),
          errorCode: Number(error?.errorCode || 0),
          authExpired: !!error?.authExpired,
          mallId: '',
          mallName: '',
        };
      }

      try {
        const info = await this.getUserInfo({ suppressAuthExpired: true });
        Object.assign(userInfo, {
          success: true,
          skipped: false,
          error: '',
          statusCode: 200,
          errorCode: 0,
          authExpired: false,
          mallId: info?.mallId || '',
          username: info?.username || '',
          nickname: info?.nickname || '',
        });
      } catch (error) {
        Object.assign(userInfo, {
          success: false,
          skipped: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode || 0),
          errorCode: Number(error?.errorCode || 0),
          authExpired: !!error?.authExpired,
        });
      }

      try {
        const info = await this.getCredentialInfo({ suppressAuthExpired: true });
        Object.assign(credentialInfo, {
          success: true,
          skipped: false,
          error: '',
          statusCode: 200,
          errorCode: 0,
          authExpired: false,
          mallId: info?.mallId || '',
          mallName: info?.mallName || '',
          companyName: info?.companyName || '',
          merchantType: info?.merchantType || '',
        });
      } catch (error) {
        Object.assign(credentialInfo, {
          success: false,
          skipped: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode || 0),
          errorCode: Number(error?.errorCode || 0),
          authExpired: !!error?.authExpired,
        });
      }
    }

    const safeApiResults = {
      mallInfo: this._buildSafeApiResultSummary({
        ...commonMallInfo,
        category: commonMallInfo?.category || '',
      }),
      userInfo: this._buildSafeApiResultSummary(userInfo),
      credentialInfo: this._buildSafeApiResultSummary(credentialInfo),
    };
    const safeApiSuccessCount = Object.values(safeApiResults).filter(item => item?.success).length;

    return {
      success: safeApiSuccessCount > 0,
      shopId: client.shopId,
      request: {
        method: 'GET',
        url: `${PDD_BASE}/earth/api/mallInfo/commonMallInfo`,
        referer: requestHeaders.Referer || '',
        origin: requestHeaders.Origin || '',
        hasAntiContentTemplate: !!requestHeaders['anti-content'],
      },
      input: {
        loginMethod: shop?.loginMethod || '',
        mallId: tokenInfo?.mallId || shop?.mallId || '',
        userId: tokenInfo?.userId || '',
        hasToken: !!tokenInfo?.raw,
        hasWindowsAppShopToken: !!tokenInfo?.raw,
        hasPddid: !!tokenInfo?.pddid,
        hasUserAgent: !!normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || ''),
      },
      mainCookieContextBefore,
      warmupResult: this._summarizeWarmupResult(warmupResult?.result || warmupResult),
      warmupError,
      mainCookieContextAfter,
      missingRequiredCookies,
      preparedHeaders,
      prepareError,
      commonMallInfo,
      safeApiResults,
      safeApiSuccessCount,
    };
  }
}

module.exports = { ShopProfileModule };
