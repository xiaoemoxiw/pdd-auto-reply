const sessionChromeUaMap = new WeakMap();

const DEFAULT_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function normalizeChromeLikeUserAgent(userAgent) {
  const ua = String(userAgent || '').trim();
  const lower = ua.toLowerCase();
  const isChromeLike = ua && lower.includes('chrome/') && !lower.includes('electron/');
  return isChromeLike ? ua : DEFAULT_CHROME_UA;
}

function getShopUserAgent(store, shopId) {
  const id = String(shopId || '').trim();
  if (!id) return DEFAULT_CHROME_UA;
  const shops = store?.get('shops') || [];
  const shop = Array.isArray(shops) ? shops.find(s => String(s?.id || '').trim() === id) : null;
  return normalizeChromeLikeUserAgent(shop?.userAgent);
}

function applySessionChromeUserAgent(ses, userAgent) {
  if (!ses) return;
  const ua = normalizeChromeLikeUserAgent(userAgent);
  try {
    if (typeof ses.setUserAgent === 'function') {
      ses.setUserAgent(ua);
    }
  } catch {}

  const existing = sessionChromeUaMap.get(ses);
  if (existing) {
    existing.ua = ua;
    return;
  }
  sessionChromeUaMap.set(ses, { ua });
  if (!ses.webRequest || typeof ses.webRequest.onBeforeSendHeaders !== 'function') return;

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details?.requestHeaders || {};
    const targetUrl = String(details?.url || '');
    try {
      const hostname = new URL(targetUrl).hostname;
      if (!hostname.endsWith('.pinduoduo.com')) return callback({ requestHeaders: headers });
    } catch {
      return callback({ requestHeaders: headers });
    }
    const current = sessionChromeUaMap.get(ses);
    const nextUa = current?.ua || ua;
    headers['User-Agent'] = nextUa;
    headers['sec-ch-ua'] = '"Chromium";v="122", "Google Chrome";v="122", "Not(A:Brand";v="99"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: headers });
  });
}

module.exports = {
  DEFAULT_CHROME_UA,
  normalizeChromeLikeUserAgent,
  getShopUserAgent,
  applySessionChromeUserAgent,
};

