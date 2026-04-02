const fs = require('fs');
const path = require('path');
const Module = require('module');

const PDD_BASE = 'https://mms.pinduoduo.com';
const PDD_BROWSER = '1';
const MMS_B84D1838 = '3616,150,3523,3660,3614,3599,3603,3658,3605,3621,3622,3669,3677,3588,3254,3532,3559,3642,3474,3475,3477,3479,3497,3482,1202,1203,1204,1205,3417';

function buildCookieHeader(tokenData) {
  const cookies = [
    `PddBrowser=${PDD_BROWSER}`,
    `mms_b84d1838=${MMS_B84D1838}`,
    ...(Array.isArray(tokenData.mallCookies) ? tokenData.mallCookies : [])
  ];
  return cookies.filter(Boolean).join('; ');
}

async function requestJson(name, url, options) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    return {
      name,
      status: response.status,
      ok: response.ok,
      finalUrl: response.url,
      contentType: response.headers.get('content-type') || '',
      errorCode: payload && typeof payload === 'object'
        ? (payload.errorCode ?? payload.error_code ?? payload.code ?? null)
        : null,
      mallName: payload?.result?.mall_name || payload?.result?.mallInfo?.mallName || payload?.result?.queryDetailResult?.mallName || '',
      username: payload?.result?.username || '',
      companyName: payload?.result?.mallInfo?.companyName || payload?.result?.queryDetailResult?.enterprise?.companyName || '',
      textPreview: typeof text === 'string' ? text.slice(0, 160) : ''
    };
  } catch (error) {
    return {
      name,
      error: error.message || String(error)
    };
  }
}

async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error('missing file path');
  }

  const loadReferenceModule = (modulePath) => {
    const absPath = path.resolve(modulePath);
    const source = fs.readFileSync(absPath, 'utf8').replace(/export default\s+/g, 'module.exports = ');
    const mod = new Module(absPath, module);
    mod.filename = absPath;
    mod.paths = Module._nodeModulePaths(path.dirname(absPath));
    mod._compile(source, absPath);
    return mod.exports;
  };

  const getAntiContent0aq = loadReferenceModule('/Users/sivan/Source/pp/pdd-strategy/src/main/config/get_anti_content_0aq.js');
  const getAntiContent0as = loadReferenceModule('/Users/sivan/Source/pp/pdd-strategy/src/main/config/get_anti_content_0as.js');

  const tokenData = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  const userAgent = String(tokenData.userAgent || '').replace('pdd_webview', '').trim();
  const cookieHeader = buildCookieHeader(tokenData);
  const antiContentMall = getAntiContent0aq();
  const antiContentCredential = getAntiContent0as(userAgent || undefined, undefined);

  const baseHeaders = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'max-age=0',
    'content-type': 'application/json',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'user-agent': userAgent,
    pddid: tokenData.pddid || '',
    'windows-app-shop-token': tokenData.windowsAppShopToken || '',
    cookie: cookieHeader
  };

  console.log(JSON.stringify({
    filePath,
    cookieCount: Array.isArray(tokenData.mallCookies) ? tokenData.mallCookies.length : 0,
    hasToken: !!tokenData.windowsAppShopToken,
    hasPddid: !!tokenData.pddid,
    antiContentMallLength: String(antiContentMall || '').length,
    antiContentCredentialLength: String(antiContentCredential || '').length
  }, null, 2));

  const tests = [
    requestJson('userinfo', `${PDD_BASE}/janus/api/userinfo`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        Referer: PDD_BASE,
        Origin: PDD_BASE,
        'anti-content': antiContentMall
      },
      body: JSON.stringify({})
    }),
    requestJson('commonMallInfo', `${PDD_BASE}/earth/api/mallInfo/commonMallInfo`, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Referer: PDD_BASE,
        Origin: PDD_BASE,
        'anti-content': antiContentMall
      }
    }),
    requestJson('queryFinalCredentialNew', `${PDD_BASE}/earth/api/mallInfo/queryFinalCredentialNew`, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Referer: `${PDD_BASE}/mallcenter/info/main/index`,
        Origin: PDD_BASE,
        'anti-content': antiContentCredential
      }
    })
  ];

  const results = await Promise.all(tests);
  for (const result of results) {
    console.log(JSON.stringify(result, null, 2));
  }
}

run().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
