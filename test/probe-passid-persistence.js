const { app, session } = require('electron');
const fs = require('fs');

const USER_DATA_PATH = '/Users/sivan/Library/Application Support/多多尾巴';
const TARGET_URL = 'https://mms.pinduoduo.com';

app.setPath('userData', USER_DATA_PATH);

async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error('missing file path');
  }
  const tokenData = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  const passCookie = (Array.isArray(tokenData.mallCookies) ? tokenData.mallCookies : []).find(item => typeof item === 'string' && item.startsWith('PASS_ID='));
  if (!passCookie) {
    throw new Error('missing PASS_ID');
  }

  const partitionBase = `persist:probe-passid-${Date.now()}`;
  const [name, ...valueParts] = passCookie.split('=');
  const value = valueParts.join('=');

  const currentSession = session.fromPartition(`${partitionBase}-current`);
  await currentSession.clearStorageData();
  await currentSession.clearCache();
  await currentSession.cookies.set({
    url: TARGET_URL,
    name,
    value,
    domain: '.pinduoduo.com',
    path: '/',
    secure: true,
    httpOnly: true
  });
  const currentCookies = await currentSession.cookies.get({ url: TARGET_URL });

  const referenceSession = session.fromPartition(`${partitionBase}-reference`);
  await referenceSession.clearStorageData();
  await referenceSession.clearCache();
  await referenceSession.cookies.set({
    url: TARGET_URL,
    name,
    value,
    domain: '.pinduoduo.com',
    path: '/',
    secure: true,
    httpOnly: false
  });
  const referenceCookies = await referenceSession.cookies.get({ url: TARGET_URL });

  console.log(JSON.stringify({
    filePath,
    passIdLength: value.length,
    currentModeFound: currentCookies.some(item => item.name === 'PASS_ID'),
    currentModeCookie: currentCookies.find(item => item.name === 'PASS_ID') || null,
    referenceModeFound: referenceCookies.some(item => item.name === 'PASS_ID'),
    referenceModeCookie: referenceCookies.find(item => item.name === 'PASS_ID') || null
  }, null, 2));
}

app.whenReady().then(() => run()).finally(() => {
  setTimeout(() => app.quit(), 300);
});
