const { app, session } = require('electron');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TARGET_URL = 'https://mms.pinduoduo.com';

function loadReferenceModule(modulePath) {
  const absPath = path.resolve(modulePath);
  const source = fs.readFileSync(absPath, 'utf8').replace(/export default\s+/g, 'module.exports = ');
  const mod = new Module(absPath, module);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  mod._compile(source, absPath);
  return mod.exports;
}

async function run() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('missing file path');
  const getAntiContent0aq = loadReferenceModule('/Users/sivan/Source/pp/pdd-strategy/src/main/config/get_anti_content_0aq.js');
  const tokenData = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  const ses = session.fromPartition(`persist:probe-passid-req-${Date.now()}`);
  await ses.clearStorageData();
  await ses.clearCache();

  for (const cookieStr of (tokenData.mallCookies || [])) {
    const eqIdx = cookieStr.indexOf('=');
    if (eqIdx < 0) continue;
    await ses.cookies.set({
      url: TARGET_URL,
      name: cookieStr.slice(0, eqIdx),
      value: cookieStr.slice(eqIdx + 1),
      domain: '.pinduoduo.com',
      path: '/',
      secure: true,
      httpOnly: false
    });
  }
  if (tokenData.pddid) {
    await ses.cookies.set({
      url: TARGET_URL,
      name: 'pddid',
      value: tokenData.pddid,
      domain: '.pinduoduo.com',
      path: '/'
    });
  }

  const before = await ses.cookies.get({ url: TARGET_URL });
  const cookieHeader = before.map(item => `${item.name}=${item.value}`).join('; ');
  const antiContent = getAntiContent0aq();
  const response = await fetch(`${TARGET_URL}/earth/api/mallInfo/commonMallInfo`, {
    method: 'GET',
    headers: {
      accept: '*/*',
      origin: TARGET_URL,
      referer: TARGET_URL,
      'user-agent': tokenData.userAgent || '',
      pddid: tokenData.pddid || '',
      'windows-app-shop-token': tokenData.windowsAppShopToken || '',
      'x-pdd-token': tokenData.windowsAppShopToken || '',
      cookie: cookieHeader,
      ...(antiContent ? { 'anti-content': antiContent } : {})
    }
  });
  const text = await response.text();
  const after = await ses.cookies.get({ url: TARGET_URL });
  console.log(JSON.stringify({
    filePath,
    beforeCookieNames: before.map(item => item.name),
    beforeHasPassId: before.some(item => item.name === 'PASS_ID'),
    status: response.status,
    textPreview: text.slice(0, 160),
    afterCookieNames: after.map(item => item.name),
    afterHasPassId: after.some(item => item.name === 'PASS_ID'),
  }, null, 2));
}

app.whenReady().then(() => run()).finally(() => {
  setTimeout(() => app.quit(), 300);
});
