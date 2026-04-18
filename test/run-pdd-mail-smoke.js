const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');
const { MailApiClient } = require('../src/main/business-api/mail-api');

const TOKEN_PATH = path.join(__dirname, 'tokens', 'sample-token.json');
const SHOP_ID = 'shop_mail_smoke';
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

async function main() {
  const tokenData = loadToken();
  const decoded = decodeShopToken(tokenData.windowsAppShopToken);
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

  const client = new MailApiClient(SHOP_ID, {
    onLog(message) {
      console.log('[PDD MAIL TEST]', message);
    },
    getShopInfo() {
      return {
        id: SHOP_ID,
        mallId: decoded.mallId || '',
        userAgent: tokenData.userAgent || '',
      };
    },
    getApiTraffic() {
      return [];
    },
    getMailUrl() {
      return 'https://mms.pinduoduo.com/other/mail/mailList?type=-1&id=441077635572';
    },
  });

  const result = {
    tokenLoaded: true,
    hasMallId: !!decoded.mallId,
    hasUserAgent: !!tokenData.userAgent,
    steps: [],
  };

  try {
    result.overview = await client.getOverview();
    result.steps.push({
      step: 'getOverview',
      ok: true,
      totalNum: result.overview.totalNum,
      unreadNum: result.overview.unreadNum,
    });

    result.list = await client.getList({ pageNum: 1, size: 10 });
    result.steps.push({
      step: 'getList',
      ok: true,
      totalCount: result.list.totalCount,
      count: result.list.list.length,
    });

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify({
      ...result,
      error: {
        message: error?.message || '未知错误',
      },
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await app.quit();
    process.exit(process.exitCode || 0);
  }
}

app.whenReady()
  .then(main)
  .catch(error => {
    console.log(JSON.stringify({
      error: {
        message: error?.message || '未知错误',
      },
    }, null, 2));
    process.exit(1);
  });
