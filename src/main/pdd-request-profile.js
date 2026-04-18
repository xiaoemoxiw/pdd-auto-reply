const DEFAULT_PAGE_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PAGE_CLIENT_HINT_HEADERS = Object.freeze({
  'sec-ch-ua': '"Chromium";v="122", "Google Chrome";v="122", "Not(A:Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"'
});

const API_CLIENT_HINT_HEADERS = Object.freeze({
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"'
});

const sessionProfileMap = new WeakMap();

function normalizePddUserAgent(value) {
  return String(value || '')
    .replace(/pdd_webview/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isChromeLikeUserAgent(value) {
  const ua = normalizePddUserAgent(value);
  const lower = ua.toLowerCase();
  return !!ua && lower.includes('chrome/') && !lower.includes('electron/');
}

function getTokenStoreKey(shopId) {
  const id = String(shopId || '').trim();
  if (!id) return '';
  return `shopTokens.${id}`;
}

function getStoredShop(store, shopId) {
  const id = String(shopId || '').trim();
  if (!id || !store || typeof store.get !== 'function') return null;
  const shops = store.get('shops') || [];
  if (!Array.isArray(shops)) return null;
  return shops.find(item => String(item?.id || '').trim() === id) || null;
}

function getStoredTokenInfo(store, shopId) {
  const key = getTokenStoreKey(shopId);
  if (!key || !store || typeof store.get !== 'function') return null;
  const tokenInfo = store.get(key);
  if (!tokenInfo || typeof tokenInfo !== 'object') return null;
  return tokenInfo;
}

function resolveStoredShopProfile(store, shopId, options = {}) {
  const fallbackUserAgent = normalizePddUserAgent(options.fallbackUserAgent || '');
  const chromeOnly = options.chromeOnly === true;
  const shop = getStoredShop(store, shopId);
  const tokenInfo = getStoredTokenInfo(store, shopId);
  let userAgent = normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || '');
  if (chromeOnly && !isChromeLikeUserAgent(userAgent)) {
    userAgent = '';
  }
  if (!userAgent) {
    userAgent = fallbackUserAgent;
  }
  return {
    shop,
    tokenInfo,
    userAgent
  };
}

function getChromeClientHintHeaders(profile = 'api') {
  const source = profile === 'page' ? PAGE_CLIENT_HINT_HEADERS : API_CLIENT_HINT_HEADERS;
  return { ...source };
}

function applyIdentityHeaders(headers, tokenInfo, options = {}) {
  if (!headers || typeof headers !== 'object') return headers;
  const includeXToken = options.includeXToken !== false;
  const includeWindowsAppToken = options.includeWindowsAppToken !== false;
  const includePddid = options.includePddid !== false;
  const rawToken = String(tokenInfo?.raw || '').trim();
  const pddid = String(tokenInfo?.pddid || '').trim();
  if (includeXToken && rawToken) {
    headers['X-PDD-Token'] = rawToken;
  }
  if (includeWindowsAppToken && rawToken) {
    headers['windows-app-shop-token'] = rawToken;
  }
  if (includePddid && pddid) {
    headers.pddid = pddid;
  }
  return headers;
}

function applyCookieContextHeaders(headers, cookieMap = {}) {
  if (!headers || typeof headers !== 'object' || !cookieMap || typeof cookieMap !== 'object') {
    return headers;
  }
  if (cookieMap.rckk) {
    headers.etag = cookieMap.rckk;
  }
  if (cookieMap['msfe-pc-cookie-captcha-token']) {
    headers.VerifyAuthToken = cookieMap['msfe-pc-cookie-captcha-token'];
  }
  return headers;
}

function isPddUrl(url) {
  try {
    const hostname = new URL(String(url || '')).hostname;
    return hostname === 'pinduoduo.com' || hostname.endsWith('.pinduoduo.com');
  } catch {
    return false;
  }
}

function applySessionPddPageProfile(ses, profile = {}) {
  if (!ses) return null;
  const nextProfile = {
    userAgent: normalizePddUserAgent(profile.userAgent || ''),
    clientHintsProfile: profile.clientHintsProfile === 'api' ? 'api' : 'page'
  };

  try {
    if (nextProfile.userAgent && typeof ses.setUserAgent === 'function') {
      ses.setUserAgent(nextProfile.userAgent);
    }
  } catch {}

  const existing = sessionProfileMap.get(ses);
  if (existing) {
    existing.profile = nextProfile;
    return nextProfile;
  }

  sessionProfileMap.set(ses, { profile: nextProfile });
  if (!ses.webRequest || typeof ses.webRequest.onBeforeSendHeaders !== 'function') {
    return nextProfile;
  }

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details?.requestHeaders || {};
    if (!isPddUrl(details?.url)) {
      return callback({ requestHeaders: headers });
    }

    const current = sessionProfileMap.get(ses)?.profile || nextProfile;
    if (current.userAgent) {
      headers['User-Agent'] = current.userAgent;
    }
    if (current.clientHintsProfile === 'api') {
      Object.assign(headers, getChromeClientHintHeaders('api'));
    }
    if (!headers['Accept-Language'] && !headers['accept-language']) {
      headers['Accept-Language'] = 'zh-CN,zh;q=0.9';
    }
    delete headers['X-PDD-Token'];
    delete headers['x-pdd-token'];
    delete headers['windows-app-shop-token'];
    delete headers.pddid;
    delete headers.etag;
    delete headers.VerifyAuthToken;
    delete headers.verifyauthtoken;
    callback({ requestHeaders: headers });
  });

  return nextProfile;
}

module.exports = {
  DEFAULT_PAGE_CHROME_UA,
  normalizePddUserAgent,
  isChromeLikeUserAgent,
  resolveStoredShopProfile,
  getChromeClientHintHeaders,
  applyIdentityHeaders,
  applyCookieContextHeaders,
  applySessionPddPageProfile
};
