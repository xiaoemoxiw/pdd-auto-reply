const path = require('path');
const fs = require('fs');
const { app, session, BrowserWindow } = require('electron');

const TOKEN_PATH = path.join(__dirname, 'tokens', 'sample-token.json');
const SHOP_ID = 'shop_invoice_capture';
const PARTITION = `persist:pdd-${SHOP_ID}`;
const INVOICE_URL = 'https://mms.pinduoduo.com/invoice/center?msfrom=mms_sidenav';

app.on('window-all-closed', event => {
  event.preventDefault();
});

function loadToken() {
  const raw = fs.readFileSync(TOKEN_PATH, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
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

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function summarizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function shouldKeep(url) {
  const value = String(url || '');
  return value.includes('/invoice/')
    || value.includes('invoice')
    || value.includes('bill')
    || value.includes('vat')
    || value.includes('receipt');
}

async function main() {
  const tokenData = loadToken();
  await importTokenToSession(tokenData);

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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

  const webSession = session.fromPartition(PARTITION);
  const requestMap = new Map();
  const records = [];

  try {
    webSession.webRequest.onBeforeRequest((details, callback) => {
      requestMap.set(details.id, {
        url: details.url || '',
        method: details.method || '',
        resourceType: details.resourceType || '',
        postData: Array.isArray(details.uploadData)
          ? details.uploadData.map(item => {
            if (item.bytes) return Buffer.from(item.bytes).toString('utf-8');
            if (item.file) return `[file]${item.file}`;
            return '';
          }).join(' ')
          : '',
      });
      callback({});
    });

    webSession.webRequest.onCompleted((details) => {
      const request = requestMap.get(details.id) || {};
      const url = details.url || request.url || '';
      if (!shouldKeep(url)) return;
      records.push({
        url: normalizeUrl(url),
        status: Number(details.statusCode || 0),
        method: details.method || request.method || '',
        resourceType: details.resourceType || request.resourceType || '',
        postData: summarizeText(request.postData),
      });
    });

    await win.loadURL(INVOICE_URL);
    await new Promise(resolve => setTimeout(resolve, 8000));

    const domInfo = await win.webContents.executeJavaScript(`
      (function () {
        const text = document.body ? document.body.innerText : '';
        return {
          url: location.href,
          title: document.title,
          hasPendingTab: text.includes('待开票'),
          hasInvoiceAmount: text.includes('发票金额'),
          bodyTextSnippet: text.replace(/\\s+/g, ' ').slice(0, 400)
        };
      })()
    `);

    const uniqueRecords = [];
    const seen = new Set();
    for (const item of records) {
      const key = `${item.method} ${item.url} ${item.status} ${item.postData}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueRecords.push(item);
    }

    console.log(JSON.stringify({
      page: domInfo,
      count: uniqueRecords.length,
      requests: uniqueRecords,
    }, null, 2));
  } finally {
    webSession.webRequest.onBeforeRequest(null);
    webSession.webRequest.onCompleted(null);
    if (!win.isDestroyed()) win.destroy();
    await app.quit();
    process.exit(0);
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
