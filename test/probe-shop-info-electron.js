const { app, session } = require('electron');
const fs = require('fs');
const { PddApiClient } = require('../src/main/pdd-api');

async function applyTokenToSession(shopId, tokenData) {
  const ses = session.fromPartition(`persist:pdd-${shopId}`);
  await ses.clearStorageData();
  await ses.clearCache();
  const mallCookies = Array.isArray(tokenData.mallCookies) ? tokenData.mallCookies : [];
  for (const cookieStr of mallCookies) {
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
  const filePath = process.argv[2];
  if (!filePath) throw new Error('missing file path');
  const tokenData = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  let decoded = {};
  try {
    decoded = JSON.parse(Buffer.from(tokenData.windowsAppShopToken || '', 'base64').toString());
  } catch {}
  const shopId = `probe_${decoded.m || 'unknown'}`;
  const shopInfo = {
    id: shopId,
    name: decoded.m ? `店铺 ${decoded.m}` : '测试店铺',
    mallId: decoded.m ? String(decoded.m) : '',
    loginMethod: 'token',
    userAgent: tokenData.userAgent || '',
  };

  global.__pddTokens = {
    [shopId]: {
      token: decoded.t || '',
      mallId: decoded.m ? String(decoded.m) : '',
      userId: decoded.u ? String(decoded.u) : '',
      raw: tokenData.windowsAppShopToken || '',
      userAgent: tokenData.userAgent || '',
      pddid: tokenData.pddid || '',
    }
  };

  await applyTokenToSession(shopId, tokenData);
  const appliedCookies = await session.fromPartition(`persist:pdd-${shopId}`).cookies.get({ url: 'https://mms.pinduoduo.com' });

  const client = new PddApiClient(shopId, {
    onLog(message) {
      console.log(JSON.stringify({ log: message }));
    },
    getShopInfo() {
      return shopInfo;
    },
    getApiTraffic() {
      return [];
    }
  });

  const result = {
    filePath,
    mallId: decoded.m || '',
    userId: decoded.u || '',
    appliedCookieCount: appliedCookies.length,
    appliedCookieNames: appliedCookies.map(cookie => cookie.name),
  };

  try {
    result.initSession = await client.initSession(true);
  } catch (error) {
    result.initSessionError = error.message || String(error);
  }

  try {
    result.userInfo = await client.getUserInfo();
  } catch (error) {
    result.userInfoError = error.message || String(error);
    result.userInfoErrorCode = error.errorCode || error.statusCode || 0;
  }

  try {
    result.mallInfo = await client.getMallInfo();
  } catch (error) {
    result.mallInfoError = error.message || String(error);
    result.mallInfoErrorCode = error.errorCode || error.statusCode || 0;
  }

  try {
    result.credentialInfo = await client.getCredentialInfo();
  } catch (error) {
    result.credentialInfoError = error.message || String(error);
    result.credentialInfoErrorCode = error.errorCode || error.statusCode || 0;
  }

  try {
    result.shopProfile = await client.getShopProfile(true);
  } catch (error) {
    result.shopProfileError = error.message || String(error);
  }

  console.log(JSON.stringify(result, null, 2));
}

app.whenReady().then(() => main()).finally(() => {
  setTimeout(() => app.quit(), 300);
});
