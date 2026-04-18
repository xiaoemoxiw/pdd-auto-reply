const fs = require('fs');
const path = require('path');
const {
  getApiTrafficIndexPath,
  getApiTrafficLogPath,
  getLegacyApiTrafficIndexPaths,
  getLegacyApiTrafficLogPaths,
} = require('./api-traffic-path');
const { sanitizeTrafficEntry, tryParseJson } = require('./api-traffic-sanitizer');

const MAX_PERSISTED_LINES = 5000;
const MAX_INDEX_INTERFACES_PER_SHOP = 1000;
const INDEX_FLUSH_DELAY_MS = 1200;

let apiTrafficIndexCache = null;
let indexFlushTimer = null;
let flushHooksRegistered = false;

function pickFullUrl(entry) {
  return String(entry?.fullUrl || entry?.url || '');
}

function getUrlParts(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      pathname: parsed.pathname || '',
      endpointPath: `${parsed.pathname || ''}${parsed.search || ''}` || url,
    };
  } catch {
    return {
      host: '',
      pathname: '',
      endpointPath: String(url || ''),
    };
  }
}

function extractCommand(entry) {
  const requestBody = tryParseJson(entry?.requestBody);
  const responseBody = entry?.responseBody && typeof entry.responseBody === 'object'
    ? entry.responseBody
    : tryParseJson(entry?.responseBody);
  return String(
    requestBody?.data?.cmd
      || requestBody?.cmd
      || responseBody?.result?.response
      || responseBody?.response
      || entry?.type
      || ''
  ).trim();
}

function buildTrafficSignature(entry = {}) {
  return [
    String(entry.transport || '').toLowerCase(),
    String(entry.direction || '').toLowerCase(),
    String(entry.method || '').toUpperCase(),
    String(entry.endpointPath || entry.url || ''),
    String(entry.command || ''),
    String(entry.resourceType || '').toLowerCase(),
    String(entry.pageType || '').toLowerCase(),
  ].join(' | ');
}

function inferPageType(entry, endpointPath, pathname, fullUrl) {
  const text = [
    fullUrl,
    endpointPath,
    pathname,
    entry?.requestBody && typeof entry.requestBody === 'string' ? entry.requestBody : '',
  ].join(' ').toLowerCase();
  if (
    text.includes('/chat-merchant/')
    || text.includes('/chats/')
    || text.includes('/conversation')
    || text.includes('/sync')
    || text.includes('/notify')
    || text.includes('message')
    || text.includes('long_polling')
  ) {
    return 'chat';
  }
  if (text.includes('/mailbox/') || text.includes('/other/mail/')) return 'mail';
  if (text.includes('/invoice/')) return 'invoice';
  if (text.includes('/work_order/') || text.includes('/aftersales/')) return 'ticket';
  if (text.includes('/violation') || text.includes('/appeal')) return 'violation';
  if (text.includes('/order/')) return 'order';
  if (text.includes('/store_image') || text.includes('/general_file') || text.includes('/cos/')) return 'upload';
  return 'unknown';
}

function inferTransport(entry) {
  const method = String(entry?.method || '').toUpperCase();
  const resourceType = String(entry?.resourceType || '').toLowerCase();
  if (method.startsWith('WS') || resourceType === 'websocket') return 'websocket';
  return 'http';
}

function inferDirection(entry) {
  const type = String(entry?.type || '');
  if (type.startsWith('websocket-')) return type.replace('websocket-', '');
  return 'request-response';
}

function buildSummary(entry, endpointPath, command, pageType, direction) {
  const method = String(entry?.method || 'GET').toUpperCase();
  const parts = [
    pageType !== 'unknown' ? pageType : '',
    direction !== 'request-response' ? direction : '',
    method,
    endpointPath,
    command ? `cmd=${command}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function normalizeTrafficEntry(entry = {}) {
  const recordedAt = Number(entry.recordedAt || entry.timestamp || Date.now());
  const fullUrl = pickFullUrl(entry);
  const { host, pathname, endpointPath } = getUrlParts(fullUrl || entry?.url || '');
  const command = extractCommand(entry);
  const transport = inferTransport(entry);
  const direction = inferDirection(entry);
  const pageType = inferPageType(entry, endpointPath, pathname, fullUrl);
  return {
    ...entry,
    recordedAt,
    fullUrl,
    endpointPath,
    host,
    command,
    transport,
    direction,
    pageType,
    summary: buildSummary(entry, endpointPath || String(entry?.url || ''), command, pageType, direction),
  };
}

function trimString(value, limit = 600) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[TRUNCATED:${text.length}]`;
}

function compactJsonValue(value, limit = 1200) {
  if (!value) return value;
  if (typeof value === 'string') return trimString(value, limit);
  try {
    const text = JSON.stringify(value);
    if (text.length <= limit) return value;
    return trimString(text, limit);
  } catch {
    return trimString(String(value), limit);
  }
}

function buildTrafficIndexSample(entry = {}) {
  return {
    requestHeaders: entry.requestHeaders || {},
    requestBody: compactJsonValue(entry.requestBody, 1200),
    responseHeaders: entry.responseHeaders || {},
    responseBody: compactJsonValue(entry.responseBody, 2000),
    triggerContext: entry.triggerContext || null,
    status: Number(entry.status || 0),
    mimeType: entry.mimeType || '',
    isJson: !!entry.isJson,
    fullUrl: entry.fullUrl || entry.url || '',
    documentURL: entry.documentURL || '',
    initiator: entry.initiator || '',
    initiatorDetails: entry.initiatorDetails || {},
    summary: entry.summary || '',
  };
}

function createEmptyTrafficIndex() {
  return {
    version: 1,
    updatedAt: 0,
    byShop: {},
  };
}

function ensureShopIndex(indexData, shopId) {
  if (!indexData.byShop[shopId]) {
    indexData.byShop[shopId] = {
      shopId,
      updatedAt: 0,
      totalCaptured: 0,
      uniqueInterfaceCount: 0,
      interfaces: {},
    };
  }
  return indexData.byShop[shopId];
}

function pruneShopIndex(shopBucket) {
  const entries = Object.entries(shopBucket.interfaces || {});
  if (entries.length <= MAX_INDEX_INTERFACES_PER_SHOP) {
    shopBucket.uniqueInterfaceCount = entries.length;
    return;
  }
  entries.sort(([, left], [, right]) => Number(right?.lastSeenAt || 0) - Number(left?.lastSeenAt || 0));
  const keptEntries = entries.slice(0, MAX_INDEX_INTERFACES_PER_SHOP);
  shopBucket.interfaces = Object.fromEntries(keptEntries);
  shopBucket.uniqueInterfaceCount = keptEntries.length;
}

function readApiTrafficIndexFile() {
  try {
    const apiTrafficIndexPath = getApiTrafficIndexPath();
    if (!fs.existsSync(apiTrafficIndexPath)) return createEmptyTrafficIndex();
    const content = fs.readFileSync(apiTrafficIndexPath, 'utf-8').trim();
    if (!content) return createEmptyTrafficIndex();
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return createEmptyTrafficIndex();
    if (!parsed.byShop || typeof parsed.byShop !== 'object') parsed.byShop = {};
    parsed.version = 1;
    parsed.updatedAt = Number(parsed.updatedAt || 0);
    return parsed;
  } catch (error) {
    console.error('[PDD助手] 读取接口索引失败:', error.message);
    return createEmptyTrafficIndex();
  }
}

function getApiTrafficIndexCache() {
  if (!apiTrafficIndexCache) {
    apiTrafficIndexCache = readApiTrafficIndexFile();
  }
  return apiTrafficIndexCache;
}

function flushApiTrafficIndex() {
  if (!apiTrafficIndexCache) return;
  try {
    const apiTrafficIndexPath = getApiTrafficIndexPath();
    fs.mkdirSync(path.dirname(apiTrafficIndexPath), { recursive: true });
    fs.writeFileSync(apiTrafficIndexPath, `${JSON.stringify(apiTrafficIndexCache, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.error('[PDD助手] 写入接口索引失败:', error.message);
  } finally {
    if (indexFlushTimer) {
      clearTimeout(indexFlushTimer);
      indexFlushTimer = null;
    }
  }
}

function registerIndexFlushHooks() {
  if (flushHooksRegistered) return;
  flushHooksRegistered = true;
  process.once('exit', flushApiTrafficIndex);
  process.once('beforeExit', flushApiTrafficIndex);
}

function scheduleApiTrafficIndexFlush() {
  registerIndexFlushHooks();
  if (indexFlushTimer) return;
  indexFlushTimer = setTimeout(() => {
    flushApiTrafficIndex();
  }, INDEX_FLUSH_DELAY_MS);
  indexFlushTimer.unref?.();
}

function updateApiTrafficIndex(shopId, entry) {
  if (!shopId || !entry) return null;
  const indexData = getApiTrafficIndexCache();
  const shopBucket = ensureShopIndex(indexData, shopId);
  const signature = buildTrafficSignature(entry);
  const current = shopBucket.interfaces[signature] || null;
  const nextSample = buildTrafficIndexSample(entry);
  const nextRecord = {
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
    sample: nextSample,
  };
  shopBucket.interfaces[signature] = nextRecord;
  shopBucket.totalCaptured = Number(shopBucket.totalCaptured || 0) + 1;
  shopBucket.updatedAt = nextRecord.lastSeenAt;
  pruneShopIndex(shopBucket);
  indexData.updatedAt = nextRecord.lastSeenAt;
  scheduleApiTrafficIndexFlush();
  return nextRecord;
}

function migrateFirstExistingFile(targetPath, candidatePaths = []) {
  try {
    if (fs.existsSync(targetPath)) return;
    const sourcePath = candidatePaths.find(filePath => filePath && fs.existsSync(filePath));
    if (!sourcePath) return;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  } catch (error) {
    console.error('[PDD助手] 迁移接口抓取文件失败:', error.message);
  }
}

function ensureApiTrafficLogReady() {
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    const apiTrafficIndexPath = getApiTrafficIndexPath();
    fs.mkdirSync(path.dirname(apiTrafficLogPath), { recursive: true });
    migrateFirstExistingFile(apiTrafficLogPath, getLegacyApiTrafficLogPaths());
    migrateFirstExistingFile(apiTrafficIndexPath, getLegacyApiTrafficIndexPaths());
    if (!fs.existsSync(apiTrafficLogPath)) {
      fs.writeFileSync(apiTrafficLogPath, '', 'utf-8');
    }
    if (!fs.existsSync(apiTrafficIndexPath)) {
      fs.writeFileSync(apiTrafficIndexPath, `${JSON.stringify(createEmptyTrafficIndex(), null, 2)}\n`, 'utf-8');
    }
    apiTrafficIndexCache = readApiTrafficIndexFile();
    compactApiTrafficLog();
  } catch (error) {
    console.error('[PDD助手] 初始化接口抓取日志失败:', error.message);
  }
}

function compactApiTrafficLog(maxLines = MAX_PERSISTED_LINES) {
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    if (!fs.existsSync(apiTrafficLogPath)) return;
    const lines = fs.readFileSync(apiTrafficLogPath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    if (lines.length <= maxLines) return;
    const trimmed = lines.slice(lines.length - maxLines);
    fs.writeFileSync(apiTrafficLogPath, `${trimmed.join('\n')}\n`, 'utf-8');
  } catch (error) {
    console.error('[PDD助手] 压缩接口抓取日志失败:', error.message);
  }
}

function appendApiTrafficLog(shopId, entry) {
  const normalizedEntry = normalizeTrafficEntry(entry);
  const persistedEntry = sanitizeTrafficEntry(normalizedEntry);
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    const record = JSON.stringify({
      shopId,
      recordedAt: persistedEntry.recordedAt,
      entry: persistedEntry,
    });
    fs.mkdirSync(path.dirname(apiTrafficLogPath), { recursive: true });
    fs.appendFileSync(apiTrafficLogPath, `${record}\n`, 'utf-8');
  } catch (error) {
    console.error('[PDD助手] 写入接口抓取日志失败:', error.message);
  }
  updateApiTrafficIndex(shopId, persistedEntry);
  return normalizedEntry;
}

function getPersistedApiTraffic(shopId, limit = 200) {
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    if (!fs.existsSync(apiTrafficLogPath)) return [];
    const lines = fs.readFileSync(apiTrafficLogPath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    const result = [];
    for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed?.shopId !== shopId || !parsed?.entry) continue;
        result.push(normalizeTrafficEntry(parsed.entry));
      } catch {
        const legacyEntry = tryParseJson(lines[i]);
        if (!legacyEntry) continue;
        if (legacyEntry?.shopId && legacyEntry.shopId !== shopId) continue;
        const normalizedEntry = normalizeTrafficEntry(legacyEntry?.entry || legacyEntry);
        if (!normalizedEntry.fullUrl && !normalizedEntry.url && !normalizedEntry.responseBody) continue;
        result.push(normalizedEntry);
      }
    }
    return result.reverse();
  } catch (error) {
    console.error('[PDD助手] 读取接口抓包日志失败:', error.message);
    return [];
  }
}

function getPersistedApiTrafficIndex(shopId = '') {
  const indexData = getApiTrafficIndexCache();
  if (!shopId) return indexData;
  return indexData.byShop?.[shopId] || {
    shopId,
    updatedAt: 0,
    totalCaptured: 0,
    uniqueInterfaceCount: 0,
    interfaces: {},
  };
}

function rebuildApiTrafficIndexFromLog(logPath = getApiTrafficLogPath(), indexPath = getApiTrafficIndexPath()) {
  const nextIndex = createEmptyTrafficIndex();
  if (!fs.existsSync(logPath)) {
    apiTrafficIndexCache = nextIndex;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, 'utf-8');
    return nextIndex;
  }
  const lines = fs.readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const shopId = parsed?.shopId || '';
      const entry = parsed?.entry ? normalizeTrafficEntry(parsed.entry) : null;
      if (!shopId || !entry) continue;
      const shopBucket = ensureShopIndex(nextIndex, shopId);
      const signature = buildTrafficSignature(entry);
      const current = shopBucket.interfaces[signature] || null;
      shopBucket.interfaces[signature] = {
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
        sample: buildTrafficIndexSample(entry),
      };
      shopBucket.totalCaptured = Number(shopBucket.totalCaptured || 0) + 1;
      shopBucket.updatedAt = Number(entry.recordedAt || 0);
      pruneShopIndex(shopBucket);
      nextIndex.updatedAt = Math.max(nextIndex.updatedAt || 0, Number(entry.recordedAt || 0));
    } catch {}
  }
  apiTrafficIndexCache = nextIndex;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, 'utf-8');
  return nextIndex;
}

module.exports = {
  appendApiTrafficLog,
  buildTrafficSignature,
  compactApiTrafficLog,
  ensureApiTrafficLogReady,
  extractCommand,
  getPersistedApiTraffic,
  getPersistedApiTrafficIndex,
  normalizeTrafficEntry,
  rebuildApiTrafficIndexFromLog,
};
