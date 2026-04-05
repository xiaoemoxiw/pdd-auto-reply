const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getApiTrafficLogPath, getLegacyApiTrafficLogPaths } = require('../src/main/api-traffic-path');
const { sanitizeBody, sanitizeValue, tryParseJson } = require('../src/main/api-traffic-sanitizer');

const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), 'artifacts', 'api-traffic', 'api-traffic-sample.jsonl');

function parseArgs(argv) {
  return argv.reduce((acc, item) => {
    if (item.startsWith('--input=')) acc.input = item.slice('--input='.length);
    if (item.startsWith('--output=')) acc.output = item.slice('--output='.length);
    return acc;
  }, {});
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
  const sanitizedUrl = sanitizeValue('url', entry?.url || '');
  return {
    signature: buildSignature({ ...entry, url: sanitizedUrl }),
    summary: sanitizeValue('summary', entry?.summary || ''),
    method: entry?.method || '',
    url: sanitizedUrl,
    status: entry?.status || 0,
    resourceType: entry?.resourceType || '',
    mimeType: entry?.mimeType || '',
    transport: entry?.transport || '',
    direction: entry?.direction || '',
    pageType: entry?.pageType || '',
    endpointPath: sanitizeValue('url', entry?.endpointPath || ''),
    host: entry?.host || '',
    recordedAt: entry?.recordedAt || entry?.timestamp || 0,
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
  return [getApiTrafficLogPath(), ...getLegacyApiTrafficLogPaths()].find(filePath => fs.existsSync(filePath)) || '';
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
