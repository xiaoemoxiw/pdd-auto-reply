const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getApiTrafficLogPath, getLegacyApiTrafficLogPath } = require('../src/main/api-traffic-path');

const DEFAULT_OUTPUT_PATH = path.join(__dirname, 'api-traffic-sample.jsonl');
const REDACTED = '[REDACTED]';
const ID_PLACEHOLDER = '[ID]';
const TEXT_PLACEHOLDER = '[TEXT]';
const REQUEST_ID_PLACEHOLDER = '[REQUEST_ID]';

function isRedactedIdKey(key) {
  const normalizedKey = String(key || '').toLowerCase();
  return [
    'mall_id',
    'mallid',
    'uid',
    'user_id',
    'userid',
    'buyerid',
    'sellerid',
    'cs_id',
    'cs_uid',
    'csid',
    'session_id',
    'sessionid',
    'conversation_id',
    'conversationid',
    'msg_id',
    'pre_msg_id',
  ].includes(normalizedKey);
}

function isTextPlaceholderKey(key) {
  const normalizedKey = String(key || '').toLowerCase();
  return [
    'content',
    'text',
    'nickname',
    'username',
    'mall_name',
    'mallname',
    'cs_name',
    'nick_name',
  ].includes(normalizedKey);
}

function sanitizeUrlLike(value) {
  try {
    const parsed = new URL(value);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('token')
        || normalizedKey.includes('cookie')
        || normalizedKey.includes('uid')
        || normalizedKey.includes('id')
      ) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function parseArgs(argv) {
  return argv.reduce((acc, item) => {
    if (item.startsWith('--input=')) acc.input = item.slice('--input='.length);
    if (item.startsWith('--output=')) acc.output = item.slice('--output='.length);
    return acc;
  }, {});
}

function tryParseJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeString(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (!value) return value;
  if (isRedactedIdKey(normalizedKey)) return ID_PLACEHOLDER;
  if (isTextPlaceholderKey(normalizedKey)) return TEXT_PLACEHOLDER;
  if (normalizedKey.includes('token') || normalizedKey.includes('cookie')) return REDACTED;
  if (normalizedKey.includes('anti_content')) return REDACTED;
  if (normalizedKey.includes('request_id')) return REQUEST_ID_PLACEHOLDER;
  if (normalizedKey === 'pddid') return REDACTED;
  if (normalizedKey.includes('avatar') || normalizedKey.includes('logo')) return '[URL]';
  if (normalizedKey.includes('url') || normalizedKey.includes('uri')) return sanitizeUrlLike(value);
  if (/^(https?|wss?):\/\//.test(value)) return sanitizeUrlLike(value);
  if (value.length > 300) return `${value.slice(0, 120)}...[TRUNCATED:${value.length}]`;
  return value;
}

function sanitizeValue(key, value) {
  if (typeof value === 'number') {
    if (String(key || '').toLowerCase().includes('request_id')) return REQUEST_ID_PLACEHOLDER;
    if (isRedactedIdKey(key)) return ID_PLACEHOLDER;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map(item => sanitizeValue(key, item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [childKey, childValue]) => {
      acc[childKey] = sanitizeValue(childKey, childValue);
      return acc;
    }, {});
  }
  if (typeof value === 'string') {
    return sanitizeString(key, value);
  }
  return value;
}

function sanitizeBody(body) {
  if (!body) return body;
  if (typeof body === 'string') {
    const parsed = tryParseJson(body);
    if (parsed) return sanitizeValue('body', parsed);
    return sanitizeString('body', body);
  }
  if (typeof body === 'object') {
    return sanitizeValue('body', body);
  }
  return body;
}

function normalizeRecord(record) {
  return record?.entry || record;
}

function getEntryCommand(entry) {
  const requestBody = tryParseJson(entry?.requestBody);
  const responseBody = entry?.responseBody && typeof entry.responseBody === 'object'
    ? entry.responseBody
    : tryParseJson(entry?.responseBody);
  return requestBody?.data?.cmd
    || requestBody?.cmd
    || responseBody?.result?.response
    || responseBody?.response
    || entry?.type
    || '';
}

function buildSignature(entry) {
  return [
    String(entry?.method || '').toUpperCase(),
    entry?.url || '',
    entry?.resourceType || '',
    getEntryCommand(entry),
  ].join(' | ');
}

function buildSample(entry) {
  const sanitizedUrl = sanitizeString('url', entry?.url || '');
  return {
    signature: buildSignature({ ...entry, url: sanitizedUrl }),
    method: entry?.method || '',
    url: sanitizedUrl,
    status: entry?.status || 0,
    resourceType: entry?.resourceType || '',
    mimeType: entry?.mimeType || '',
    command: getEntryCommand(entry),
    requestHeaders: sanitizeValue('headers', entry?.requestHeaders || {}),
    requestBody: sanitizeBody(entry?.requestBody || ''),
    responseHeaders: sanitizeValue('headers', entry?.responseHeaders || {}),
    responseBody: sanitizeBody(entry?.responseBody || ''),
    isJson: !!entry?.isJson,
  };
}

function loadTrafficEntries(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return normalizeRecord(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function resolveInputPath(explicitInput) {
  if (explicitInput) {
    return path.isAbsolute(explicitInput) ? explicitInput : path.resolve(process.cwd(), explicitInput);
  }
  return [
    getApiTrafficLogPath(),
    getLegacyApiTrafficLogPath(),
  ].find(filePath => fs.existsSync(filePath)) || '';
}

function resolveOutputPath(explicitOutput) {
  if (!explicitOutput) return DEFAULT_OUTPUT_PATH;
  return path.isAbsolute(explicitOutput) ? explicitOutput : path.resolve(process.cwd(), explicitOutput);
}

function exportSamples(inputPath, outputPath) {
  const entries = loadTrafficEntries(inputPath);
  const deduped = new Map();
  for (const entry of entries) {
    deduped.set(buildSignature(entry), buildSample(entry));
  }
  const lines = Array.from(deduped.values()).map(item => JSON.stringify(item));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf-8');
  return {
    inputPath,
    outputPath,
    rawCount: entries.length,
    sampleCount: lines.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(args.input);
  const outputPath = resolveOutputPath(args.output);
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('未找到原始抓包日志，请先运行应用生成接口抓取日志，或通过 --input 指定文件');
  }
  const result = exportSamples(inputPath, outputPath);
  console.log(JSON.stringify(result, null, 2));
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(error => {
    console.error(error.message);
    app.exit(1);
  });
