const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');
const { PddApiClient } = require('../src/main/pdd-api');

const TOKEN_PATH = path.join(__dirname, 'tokens', 'sample-token.json');
const SHOP_ID = 'shop_bootstrap_diag';
const PARTITION = `persist:pdd-${SHOP_ID}`;

function readToken() {
  const raw = fs.readFileSync(TOKEN_PATH, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function decodeToken(rawToken) {
  if (!rawToken) return {};
  try {
    const decoded = JSON.parse(Buffer.from(rawToken, 'base64').toString());
    return {
      mallId: String(decoded.m || ''),
      userId: String(decoded.u || ''),
      token: decoded.t || '',
    };
  } catch {
    return {};
  }
}

async function importTokenToSession(tokenData) {
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  for (const cookieStr of tokenData.mallCookies || []) {
    const eqIdx = cookieStr.indexOf('=');
    if (eqIdx < 0) continue;
    await ses.cookies.set({
      url: 'https://mms.pinduoduo.com',
      name: cookieStr.slice(0, eqIdx),
      value: cookieStr.slice(eqIdx + 1),
      domain: '.pinduoduo.com',
      path: '/',
      secure: true,
      httpOnly: true,
    });
  }
  if (tokenData.pddid) {
    await ses.cookies.set({
      url: 'https://mms.pinduoduo.com',
      name: 'pddid',
      value: tokenData.pddid,
      domain: '.pinduoduo.com',
      path: '/',
    });
  }
}

async function run() {
  const tokenData = readToken();
  const decoded = decodeToken(tokenData.windowsAppShopToken);
  await importTokenToSession(tokenData);

  global.__pddTokens = {
    [SHOP_ID]: {
      token: decoded.token || '',
      mallId: decoded.mallId || '',
      userId: decoded.userId || '',
      raw: tokenData.windowsAppShopToken || '',
      userAgent: tokenData.userAgent || '',
      pddid: tokenData.pddid || '',
    },
  };

  const client = new PddApiClient(SHOP_ID, {
    onLog(message, extra) {
      console.log('[CHAT DIAG]', message, extra ? JSON.stringify(extra) : '');
    },
    getShopInfo() {
      return {
        id: SHOP_ID,
        mallId: decoded.mallId || '',
        userAgent: tokenData.userAgent || '',
        loginMethod: 'token',
        name: '诊断店铺',
      };
    },
    getApiTraffic() {
      return [];
    },
  });

  const initResult = await client.initSession(true);
  const bootstrapUrls = client._bootstrapTraffic.map(item => item.url).slice(-20);
  const convTemplate = client._getLatestConversationRequestBody();
  const antiContent = client._getLatestAntiContent();

  let sessionResult;
  try {
    const sessions = await client.getSessionList(1, 20);
    sessionResult = {
      ok: true,
      count: sessions.length,
      firstSessionId: sessions[0]?.sessionId || '',
    };
  } catch (error) {
    sessionResult = {
      ok: false,
      message: error.message,
      errorCode: error.errorCode || 0,
      statusCode: error.statusCode || 0,
      authExpired: !!error.authExpired,
      authState: error.authState || '',
      payload: error.payload || null,
    };
  }

  console.log(JSON.stringify({
    initResult,
    bootstrapTrafficCount: client._bootstrapTraffic.length,
    bootstrapUrls,
    hasConversationTemplate: !!convTemplate,
    templateKeys: convTemplate ? Object.keys(convTemplate) : [],
    templateDataKeys: convTemplate?.data ? Object.keys(convTemplate.data) : [],
    antiContentLength: String(antiContent || '').length,
    sessionResult,
  }, null, 2));
}

app.whenReady().then(async () => {
  try {
    await run();
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

app.on('window-all-closed', event => {
  event.preventDefault();
});
