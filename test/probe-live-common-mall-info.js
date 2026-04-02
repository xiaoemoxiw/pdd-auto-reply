const fs = require('fs');
const path = require('path');
const Module = require('module');
const { app, session } = require('electron');

const CONFIG_PATH = '/Users/sivan/Library/Application Support/元尾巴 · 拼多多客服助手/config.json';
const USER_DATA_PATH = '/Users/sivan/Library/Application Support/元尾巴 · 拼多多客服助手';
const PDD_BASE = 'https://mms.pinduoduo.com';
const PDD_BROWSER = '1';
const MMS_B84D1838 = '3616,150,3523,3660,3614,3599,3603,3658,3605,3621,3622,3669,3677,3588,3254,3532,3559,3642,3474,3475,3477,3479,3497,3482,1202,1203,1204,1205,3417';

function loadReferenceModule(modulePath) {
  const absPath = path.resolve(modulePath);
  const source = fs.readFileSync(absPath, 'utf8').replace(/export default\s+/g, 'module.exports = ');
  const mod = new Module(absPath, module);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  mod._compile(source, absPath);
  return mod.exports;
}

function buildCookieHeader(cookies) {
  const pairs = cookies.map(cookie => `${cookie.name}=${cookie.value}`);
  if (!cookies.find(cookie => cookie.name === 'PddBrowser')) {
    pairs.unshift(`PddBrowser=${PDD_BROWSER}`);
  }
  if (!cookies.find(cookie => cookie.name === 'mms_b84d1838')) {
    pairs.unshift(`mms_b84d1838=${MMS_B84D1838}`);
  }
  return pairs.join('; ');
}

async function run() {
  const getAntiContent0aq = loadReferenceModule('/Users/sivan/Source/pp/pdd-strategy/src/main/config/get_anti_content_0aq.js');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const shopId = process.argv[2] || config.activeShopId;
  if (!shopId) {
    throw new Error('missing shop id');
  }

  const shop = Array.isArray(config.shops) ? config.shops.find(item => item.id === shopId) : null;
  const tokenInfo = config.shopTokens?.[shopId] || null;
  if (!shop || !tokenInfo) {
    throw new Error(`shop/token not found for ${shopId}`);
  }

  const ses = session.fromPartition(`persist:pdd-${shopId}`);
  const cookies = await ses.cookies.get({ url: PDD_BASE });
  const cookieHeader = buildCookieHeader(cookies);
  const antiContent = getAntiContent0aq();

  console.log(JSON.stringify({
    shopId,
    mallId: shop.mallId || '',
    currentName: shop.name || '',
    cookieCount: cookies.length,
    cookieNames: cookies.slice(0, 20).map(item => item.name),
    hasRckk: cookies.some(item => item.name === 'rckk'),
    hasPassId: cookies.some(item => item.name === 'PASS_ID'),
    hasVerifyAuthToken: cookies.some(item => item.name === 'msfe-pc-cookie-captcha-token'),
    antiContentLength: String(antiContent || '').length
  }, null, 2));

  const response = await fetch(`${PDD_BASE}/earth/api/mallInfo/commonMallInfo`, {
    method: 'GET',
    headers: {
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'content-type': 'application/json',
      origin: PDD_BASE,
      referer: PDD_BASE,
      'user-agent': tokenInfo.userAgent || shop.userAgent || '',
      pddid: tokenInfo.pddid || '',
      'windows-app-shop-token': tokenInfo.raw || '',
      'x-pdd-token': tokenInfo.raw || '',
      cookie: cookieHeader,
      etag: cookies.find(item => item.name === 'rckk')?.value || '',
      ...(cookies.find(item => item.name === 'msfe-pc-cookie-captcha-token')?.value
        ? { VerifyAuthToken: cookies.find(item => item.name === 'msfe-pc-cookie-captcha-token').value }
        : {}),
      ...(antiContent ? { 'anti-content': antiContent } : {})
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}

  console.log(JSON.stringify({
    shopId,
    status: response.status,
    ok: response.ok,
    errorCode: payload?.errorCode ?? payload?.error_code ?? payload?.code ?? null,
    mallName: payload?.result?.mall_name || payload?.result?.mallName || '',
    mallIdFromResult: payload?.result?.mall_id || payload?.result?.mallId || '',
    textPreview: typeof text === 'string' ? text.slice(0, 200) : ''
  }, null, 2));
}

app.setPath('userData', USER_DATA_PATH);

app.whenReady().then(() => run()).finally(() => {
  setTimeout(() => app.quit(), 300);
});
