const fs = require('fs');

async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error('missing file path');
  }

  const tokenData = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  const cookieList = Array.isArray(tokenData.mallCookies) ? tokenData.mallCookies.filter(Boolean) : [];
  const cookieHeader = [
    ...cookieList,
    tokenData.pddid ? `pddid=${tokenData.pddid}` : ''
  ].filter(Boolean).join('; ');

  let decoded = {};
  try {
    decoded = JSON.parse(Buffer.from(tokenData.windowsAppShopToken || '', 'base64').toString());
  } catch {}

  const baseHeaders = {
    accept: '*/*',
    'content-type': 'application/json',
    origin: 'https://mms.pinduoduo.com',
    referer: 'https://mms.pinduoduo.com',
    'user-agent': tokenData.userAgent || '',
    'x-pdd-token': tokenData.windowsAppShopToken || '',
    'windows-app-shop-token': tokenData.windowsAppShopToken || '',
    pddid: tokenData.pddid || '',
    cookie: cookieHeader,
  };

  const tests = [
    {
      name: 'userinfo',
      url: 'https://mms.pinduoduo.com/janus/api/userinfo',
      options: {
        method: 'POST',
        headers: baseHeaders,
        body: '{}',
      },
    },
    {
      name: 'commonMallInfo',
      url: 'https://mms.pinduoduo.com/earth/api/mallInfo/commonMallInfo',
      options: {
        method: 'GET',
        headers: baseHeaders,
      },
    },
    {
      name: 'queryFinalCredentialNew',
      url: 'https://mms.pinduoduo.com/earth/api/mallInfo/queryFinalCredentialNew',
      options: {
        method: 'GET',
        headers: {
          ...baseHeaders,
          referer: 'https://mms.pinduoduo.com/mallcenter/info/main/index',
        },
      },
    },
  ];

  const summary = {
    filePath,
    mallCookieCount: cookieList.length,
    tokenMallId: decoded.m || '',
    tokenUserId: decoded.u || '',
  };
  console.log(JSON.stringify(summary, null, 2));

  for (const test of tests) {
    try {
      const response = await fetch(test.url, test.options);
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {}

      console.log(JSON.stringify({
        name: test.name,
        status: response.status,
        ok: response.ok,
        finalUrl: response.url,
        contentType: response.headers.get('content-type') || '',
        errorCode: payload && typeof payload === 'object'
          ? (payload.errorCode ?? payload.error_code ?? payload.code ?? null)
          : null,
        hasResult: !!(payload && typeof payload === 'object' && payload.result),
        mallName: payload?.result?.mall_name || payload?.result?.mallInfo?.mallName || payload?.result?.queryDetailResult?.mallName || '',
        username: payload?.result?.username || '',
        companyName: payload?.result?.mallInfo?.companyName || payload?.result?.queryDetailResult?.enterprise?.companyName || '',
        textPreview: typeof text === 'string' ? text.slice(0, 160) : '',
      }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({
        name: test.name,
        error: error.message || String(error),
      }, null, 2));
    }
  }
}

run().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
