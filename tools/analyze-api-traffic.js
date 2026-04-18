const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
  getApiTrafficIndexPath,
  getApiTrafficLogPath,
  getLegacyApiTrafficIndexPaths,
  getLegacyApiTrafficLogPaths,
} = require('../src/main/traffic/api-traffic-path');
const { buildTrafficSignature, normalizeTrafficEntry } = require('../src/main/traffic/api-traffic-recorder');

function parseArgs(argv) {
  return argv.reduce((acc, item) => {
    if (item.startsWith('--shopId=')) acc.shopId = item.slice('--shopId='.length);
    if (item.startsWith('--pageType=')) acc.pageType = item.slice('--pageType='.length);
    if (item.startsWith('--limit=')) acc.limit = Number(item.slice('--limit='.length)) || 10;
    if (item.startsWith('--index=')) acc.index = item.slice('--index='.length);
    if (item.startsWith('--log=')) acc.log = item.slice('--log='.length);
    return acc;
  }, { shopId: '', pageType: '', limit: 10, index: '', log: '' });
}

function resolveAbsolutePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function pickExistingPath(paths) {
  return paths.find(filePath => filePath && fs.existsSync(filePath)) || '';
}

function loadIndex(indexPath) {
  if (!indexPath || !fs.existsSync(indexPath)) return null;
  const content = fs.readFileSync(indexPath, 'utf-8').trim();
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function loadLogEntries(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        const parsed = JSON.parse(line);
        return {
          shopId: parsed?.shopId || '',
          entry: normalizeTrafficEntry(parsed?.entry || parsed),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildIndexFromLog(logEntries) {
  const byShop = {};
  for (const item of logEntries) {
    const shopId = String(item.shopId || '').trim();
    if (!shopId) continue;
    const entry = item.entry;
    if (!byShop[shopId]) {
      byShop[shopId] = {
        shopId,
        updatedAt: 0,
        totalCaptured: 0,
        uniqueInterfaceCount: 0,
        interfaces: {},
      };
    }
    const bucket = byShop[shopId];
    const signature = buildTrafficSignature(entry);
    const current = bucket.interfaces[signature] || null;
    bucket.interfaces[signature] = {
      signature,
      method: String(entry.method || '').toUpperCase(),
      endpointPath: entry.endpointPath || entry.url || '',
      pageType: entry.pageType || 'unknown',
      transport: entry.transport || 'http',
      direction: entry.direction || 'request-response',
      command: entry.command || '',
      resourceType: entry.resourceType || '',
      host: entry.host || '',
      firstSeenAt: current?.firstSeenAt || Number(entry.recordedAt || Date.now()),
      lastSeenAt: Number(entry.recordedAt || Date.now()),
      hitCount: Number(current?.hitCount || 0) + 1,
      lastStatus: Number(entry.status || 0),
      lastMimeType: entry.mimeType || '',
      lastSummary: entry.summary || '',
      sample: {
        triggerContext: entry.triggerContext || null,
        summary: entry.summary || '',
        fullUrl: entry.fullUrl || entry.url || '',
      },
    };
    bucket.totalCaptured += 1;
    bucket.updatedAt = Math.max(bucket.updatedAt || 0, Number(entry.recordedAt || 0));
  }
  for (const bucket of Object.values(byShop)) {
    bucket.uniqueInterfaceCount = Object.keys(bucket.interfaces).length;
  }
  return {
    version: 1,
    updatedAt: Math.max(0, ...Object.values(byShop).map(item => Number(item.updatedAt || 0))),
    byShop,
  };
}

function summarizeShop(bucket, options = {}) {
  const limit = Math.max(1, Number(options.limit || 10));
  const pageTypeFilter = String(options.pageType || '').trim().toLowerCase();
  let interfaces = Object.values(bucket?.interfaces || {});
  if (pageTypeFilter) {
    interfaces = interfaces.filter(item => String(item.pageType || '').toLowerCase() === pageTypeFilter);
  }
  interfaces.sort((left, right) => Number(right.hitCount || 0) - Number(left.hitCount || 0));
  const byPageType = interfaces.reduce((acc, item) => {
    const key = item.pageType || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const triggered = interfaces
    .filter(item => item.sample?.triggerContext?.targetText || item.sample?.triggerContext?.targetSelector)
    .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0))
    .slice(0, limit)
    .map(item => ({
      signature: item.signature,
      endpointPath: item.endpointPath,
      method: item.method,
      hitCount: item.hitCount,
      pageType: item.pageType,
      lastSeenAt: item.lastSeenAt,
      trigger: {
        actionType: item.sample?.triggerContext?.actionType || '',
        targetText: item.sample?.triggerContext?.targetText || '',
        targetSelector: item.sample?.triggerContext?.targetSelector || '',
        pageUrl: item.sample?.triggerContext?.pageUrl || '',
        requestDelayMs: item.sample?.triggerContext?.requestDelayMs || 0,
      },
    }));
  const topInterfaces = interfaces.slice(0, limit).map(item => ({
    signature: item.signature,
    endpointPath: item.endpointPath,
    method: item.method,
    hitCount: item.hitCount,
    pageType: item.pageType,
    command: item.command,
    lastSeenAt: item.lastSeenAt,
    lastStatus: item.lastStatus,
    summary: item.lastSummary || item.sample?.summary || '',
    triggerText: item.sample?.triggerContext?.targetText || '',
  }));
  return {
    shopId: bucket.shopId,
    updatedAt: bucket.updatedAt,
    totalCaptured: bucket.totalCaptured,
    uniqueInterfaceCount: interfaces.length,
    pageTypes: byPageType,
    topInterfaces,
    recentlyTriggeredInterfaces: triggered,
  };
}

function buildSummary(indexData, options = {}) {
  const shopId = String(options.shopId || '').trim();
  const buckets = shopId
    ? [indexData.byShop?.[shopId]].filter(Boolean)
    : Object.values(indexData.byShop || {});
  const shops = buckets
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .map(bucket => summarizeShop(bucket, options));
  return {
    analyzedAt: Date.now(),
    totalShops: shops.length,
    source: {
      indexPath: options.indexPath || '',
      logPath: options.logPath || '',
      mode: options.mode || 'index',
    },
    shops,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const explicitIndexPath = resolveAbsolutePath(args.index);
  const explicitLogPath = resolveAbsolutePath(args.log);
  const indexPath = pickExistingPath([
    explicitIndexPath,
    getApiTrafficIndexPath(),
    ...getLegacyApiTrafficIndexPaths(),
  ]);
  const logPath = pickExistingPath([
    explicitLogPath,
    getApiTrafficLogPath(),
    ...getLegacyApiTrafficLogPaths(),
  ]);
  let indexData = loadIndex(indexPath);
  let mode = 'index';
  if (!indexData) {
    const logEntries = loadLogEntries(logPath);
    if (!logEntries.length) {
      throw new Error('未找到可分析的抓包索引或日志，请先操作页面生成抓包数据');
    }
    indexData = buildIndexFromLog(logEntries);
    mode = 'log';
  }
  const summary = buildSummary(indexData, {
    shopId: args.shopId,
    pageType: args.pageType,
    limit: args.limit,
    indexPath,
    logPath,
    mode,
  });
  console.log(JSON.stringify(summary, null, 2));
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(error => {
    console.error(error.message);
    app.exit(1);
  });
