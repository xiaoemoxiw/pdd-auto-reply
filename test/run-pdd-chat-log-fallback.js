const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const { PddApiClient } = require('../src/main/pdd-api');
const { getApiTrafficLogPath } = require('../src/main/api-traffic-path');

app.setName('元尾巴 · 拼多多客服助手');

const TOKEN_PATH = path.join(__dirname, 'tokens', 'sample-token.json');
const SHOP_ID = 'shop_504805789';
const PARTITION = `persist:pdd-${SHOP_ID}`;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
}

function decodeToken(rawToken) {
  try {
    const decoded = JSON.parse(Buffer.from(rawToken, 'base64').toString());
    return {
      mallId: String(decoded.m || ''),
      userId: String(decoded.u || ''),
      token: decoded.t || ''
    };
  } catch {
    return { mallId: '', userId: '', token: '' };
  }
}

async function importToken(tokenData) {
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
      httpOnly: true
    });
  }
  if (tokenData.pddid) {
    await ses.cookies.set({
      url: 'https://mms.pinduoduo.com',
      name: 'pddid',
      value: tokenData.pddid,
      domain: '.pinduoduo.com',
      path: '/'
    });
  }
}

function loadPersistedTraffic(shopId) {
  const logPath = getApiTrafficLogPath();
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(item => item.shopId === shopId && item.entry)
    .map(item => item.entry);
}

async function run() {
  const tokenData = readJson(TOKEN_PATH);
  const tokenInfo = decodeToken(tokenData.windowsAppShopToken);
  await importToken(tokenData);
  global.__pddTokens = {
    [SHOP_ID]: {
      token: tokenInfo.token,
      mallId: tokenInfo.mallId,
      userId: tokenInfo.userId,
      raw: tokenData.windowsAppShopToken || '',
      userAgent: tokenData.userAgent || '',
      pddid: tokenData.pddid || ''
    }
  };

  const traffic = loadPersistedTraffic(SHOP_ID);
  if (!traffic.length) {
    throw new Error('没有找到该店铺的持久化聊天抓包');
  }

  const client = new PddApiClient(SHOP_ID, {
    getShopInfo() {
      return {
        id: SHOP_ID,
        mallId: tokenInfo.mallId,
        userAgent: tokenData.userAgent || '',
        loginMethod: 'token',
        name: '日志回放店铺'
      };
    },
    getApiTraffic() {
      return traffic;
    },
    onLog() {}
  });

  const sessions = await client.getSessionList(1, 20);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('持久化聊天抓包回放后仍未拿到会话');
  }
  console.log(`chat log fallback test passed: ${sessions.length}`);
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
