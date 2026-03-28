const path = require('path');
const fs = require('fs');
const { app, session, BrowserWindow } = require('electron');
const { PddApiClient } = require('../src/main/pdd-api');

const TOKEN_PATH = path.join(__dirname, 'tokens', 'sample-token.json');
const API_TRAFFIC_LOG_PATH = path.join(__dirname, 'api-traffic-log.jsonl');
const SHOP_ID = 'shop_smoke_test';
const PARTITION = `persist:pdd-${SHOP_ID}`;

app.on('window-all-closed', event => {
  event.preventDefault();
});

function loadToken() {
  const raw = fs.readFileSync(TOKEN_PATH, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function decodeShopToken(rawToken) {
  if (!rawToken) return {};
  try {
    const decoded = JSON.parse(Buffer.from(rawToken, 'base64').toString());
    return {
      mallId: String(decoded.m || ''),
      userId: decoded.u || '',
      token: decoded.t || '',
    };
  } catch {
    return {};
  }
}

function loadApiTraffic() {
  if (!fs.existsSync(API_TRAFFIC_LOG_PATH)) return [];
  return fs.readFileSync(API_TRAFFIC_LOG_PATH, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line).entry;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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

async function getSessionCookieNames() {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ domain: '.pinduoduo.com' });
  return cookies.map(item => item.name).sort();
}

function sanitizeError(error) {
  return {
    message: error?.message || '未知错误',
    errorCode: error?.errorCode || null,
    statusCode: error?.statusCode || null,
    authExpired: !!error?.authExpired,
  };
}

async function runPageContextFetch(tokenData, mallId) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (tokenData.userAgent) {
    win.webContents.setUserAgent(tokenData.userAgent);
  }

  try {
    await win.loadURL('https://mms.pinduoduo.com/chat-merchant/index.html');
    await new Promise(resolve => setTimeout(resolve, 3000));
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const body = {
          mallId: ${JSON.stringify(Number(mallId || 0))},
          page: 1,
          pageSize: 5
        };
        const response = await fetch('/plateau/chat/list', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        const text = await response.text();
        let data = text;
        try { data = JSON.parse(text); } catch {}
        return {
          url: location.href,
          status: response.status,
          data
        };
      })()
    `);
    return result;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main() {
  const tokenData = loadToken();
  const decoded = decodeShopToken(tokenData.windowsAppShopToken);
  const apiTraffic = loadApiTraffic();

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
    onLog(message) {
      console.log('[PDD API TEST]', message);
    },
    getShopInfo() {
      return {
        id: SHOP_ID,
        mallId: decoded.mallId || '',
        userAgent: tokenData.userAgent || '',
      };
    },
    getApiTraffic() {
      return apiTraffic;
    },
  });

  const result = {
    tokenLoaded: true,
    hasMallId: !!decoded.mallId,
    hasUserAgent: !!tokenData.userAgent,
    tokenUserAgent: tokenData.userAgent || '',
    hasCookies: Array.isArray(tokenData.mallCookies) && tokenData.mallCookies.length > 0,
    apiTrafficCount: apiTraffic.length,
    cookieNamesBeforeInit: await getSessionCookieNames(),
    steps: [],
  };

  try {
    result.initSession = await client.initSession(true);
    result.steps.push({ step: 'initSession', ok: !!result.initSession?.initialized });

    result.userInfo = await client.getUserInfo();
    result.steps.push({ step: 'getUserInfo', ok: true });

    result.pageContextChatList = await runPageContextFetch(tokenData, decoded.mallId);
    result.steps.push({
      step: 'pageContextChatList',
      ok: result.pageContextChatList?.status === 200,
      errorCode: result.pageContextChatList?.data?.error_code || result.pageContextChatList?.data?.errorCode || null
    });

    const sessions = await client.getSessionList(1, 5);
    result.sessions = sessions;
    result.steps.push({ step: 'getSessionList', ok: true, count: sessions.length });

    if (Array.isArray(sessions) && sessions[0]?.sessionId) {
      const firstSessionId = sessions[0].sessionId;
      const messages = await client.getSessionMessages(firstSessionId, 1, 10);
      result.firstSession = {
        hasSessionId: true,
        messageCount: messages.length,
      };
      result.steps.push({ step: 'getSessionMessages', ok: true, messageCount: messages.length });
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    result.error = sanitizeError(error);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    client.destroy();
    await app.quit();
  }
}

app.whenReady()
  .then(main)
  .catch(error => {
    console.log(JSON.stringify({ error: sanitizeError(error) }, null, 2));
    process.exit(1);
  });
