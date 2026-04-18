const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getApiTrafficLogPath, getLegacyApiTrafficLogPaths } = require('../src/main/traffic/api-traffic-path');
const { sanitizeTrafficEntry, sanitizeValue } = require('../src/main/traffic/api-traffic-sanitizer');

const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), 'artifacts', 'api-traffic', 'api-traffic-log.redacted.jsonl');

function parseArgs(argv) {
  return argv.reduce((acc, item) => {
    if (item.startsWith('--input=')) acc.input = item.slice('--input='.length);
    if (item.startsWith('--output=')) acc.output = item.slice('--output='.length);
    return acc;
  }, {});
}

function loadTrafficRecords(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
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

function snapshotTraffic(inputPath, outputPath) {
  const records = loadTrafficRecords(inputPath);
  const lines = records.map(record => JSON.stringify({
    shopId: sanitizeValue('shopId', record?.shopId || ''),
    recordedAt: record?.recordedAt || 0,
    entry: sanitizeTrafficEntry(record?.entry || {}),
  }));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf-8');
  return {
    inputPath,
    outputPath,
    recordCount: lines.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(args.input);
  const outputPath = resolveOutputPath(args.output);
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('未找到原始抓包日志，请先运行应用生成接口抓取日志，或通过 --input 指定文件');
  }
  const result = snapshotTraffic(inputPath, outputPath);
  console.log(JSON.stringify(result, null, 2));
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(error => {
    console.error(error.message);
    app.exit(1);
  });
