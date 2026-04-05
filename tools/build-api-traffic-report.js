const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
  getApiTrafficIndexPath,
  getApiTrafficLogPath,
  getLegacyApiTrafficIndexPaths,
  getLegacyApiTrafficLogPaths,
} = require('../src/main/api-traffic-path');
const { buildTrafficSignature, normalizeTrafficEntry } = require('../src/main/api-traffic-recorder');

const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), 'artifacts', 'api-traffic', 'api-traffic-report.md');
const DOMAIN_ORDER = ['chat', 'violation', 'invoice', 'ticket', 'mail', 'order', 'upload', 'unknown'];
const DOMAIN_LABELS = {
  chat: '聊天接口',
  violation: '违规接口',
  invoice: '发票接口',
  ticket: '工单接口',
  mail: '站内信接口',
  order: '订单接口',
  upload: '上传接口',
  unknown: '待归类接口',
};

function parseArgs(argv) {
  return argv.reduce((acc, item) => {
    if (item.startsWith('--limit=')) acc.limit = Number(item.slice('--limit='.length)) || 10;
    if (item.startsWith('--index=')) acc.index = item.slice('--index='.length);
    if (item.startsWith('--log=')) acc.log = item.slice('--log='.length);
    if (item.startsWith('--output=')) acc.output = item.slice('--output='.length);
    return acc;
  }, { limit: 10, index: '', log: '', output: '' });
}

function resolveAbsolutePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function pickExistingPath(paths) {
  return paths.find(filePath => filePath && fs.existsSync(filePath)) || '';
}

function resolveOutputPath(explicitOutput) {
  if (!explicitOutput) return DEFAULT_OUTPUT_PATH;
  return path.isAbsolute(explicitOutput) ? explicitOutput : path.resolve(process.cwd(), explicitOutput);
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

function collectInterfaces(indexData) {
  return Object.values(indexData?.byShop || {}).flatMap(bucket => Object.values(bucket.interfaces || {}));
}

function sumCaptured(indexData) {
  return Object.values(indexData?.byShop || {}).reduce((sum, bucket) => sum + Number(bucket.totalCaptured || 0), 0);
}

function formatDateTime(timestamp) {
  const time = Number(timestamp || 0);
  if (!time) return '未知';
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function escapeMarkdown(text) {
  return String(text || '').replace(/`/g, '\\`');
}

function uniqueBy(items, pickKey) {
  const map = new Map();
  for (const item of items) {
    const key = pickKey(item);
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return Array.from(map.values());
}

function buildOverview(indexData) {
  const interfaces = collectInterfaces(indexData);
  const pageTypes = interfaces.reduce((acc, item) => {
    const key = String(item.pageType || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    totalShops: Object.keys(indexData?.byShop || {}).length,
    totalCaptured: sumCaptured(indexData),
    uniqueInterfaceCount: interfaces.length,
    pageTypes,
    interfaces,
  };
}

function buildTopInterfaces(interfaces, limit) {
  return [...interfaces]
    .sort((left, right) => {
      const hitDiff = Number(right.hitCount || 0) - Number(left.hitCount || 0);
      if (hitDiff !== 0) return hitDiff;
      return Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0);
    })
    .slice(0, limit);
}

function buildDomainGroups(interfaces, limit) {
  const groups = {};
  for (const pageType of DOMAIN_ORDER) {
    const scoped = interfaces.filter(item => String(item.pageType || 'unknown') === pageType);
    if (!scoped.length) continue;
    groups[pageType] = uniqueBy(
      [...scoped].sort((left, right) => {
        const hitDiff = Number(right.hitCount || 0) - Number(left.hitCount || 0);
        if (hitDiff !== 0) return hitDiff;
        return Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0);
      }),
      item => `${item.method} ${item.endpointPath}`
    ).slice(0, limit);
  }
  return groups;
}

function buildTriggeredInterfaces(interfaces, limit) {
  return interfaces
    .filter(item => item.sample?.triggerContext?.targetText || item.sample?.triggerContext?.targetSelector)
    .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0))
    .slice(0, limit);
}

function buildJudgements(overview, triggeredInterfaces) {
  const results = [];
  if (overview.pageTypes.unknown) {
    const ratio = overview.uniqueInterfaceCount
      ? Math.round((Number(overview.pageTypes.unknown || 0) / overview.uniqueInterfaceCount) * 100)
      : 0;
    results.push(`- \`unknown\` 分组仍有 ${overview.pageTypes.unknown} 个接口，约占 ${ratio}% ，后续可继续补充 pageType 识别规则。`);
  }
  if (overview.pageTypes.chat) {
    results.push(`- 聊天域已识别 ${overview.pageTypes.chat} 个唯一接口，适合继续围绕会话、未读和消息详情做字段梳理。`);
  }
  if (overview.pageTypes.violation || overview.pageTypes.invoice || overview.pageTypes.ticket) {
    results.push('- 非聊天业务域已经有可复用接口样本，可直接按样本回看请求头、请求体和响应结构。');
  }
  if (triggeredInterfaces.length) {
    results.push(`- 当前保留了 ${triggeredInterfaces.length} 条最近点击触发接口，后续排查页面操作链路时可以优先沿这些触发点继续抓。`);
  }
  if (!results.length) {
    results.push('- 当前抓包量较少，建议继续在目标页面补充操作样本后再更新报告。');
  }
  return results;
}

function buildMarkdown(indexData, options = {}) {
  const limit = Math.max(1, Number(options.limit || 10));
  const overview = buildOverview(indexData);
  const topInterfaces = buildTopInterfaces(overview.interfaces, limit);
  const domainGroups = buildDomainGroups(overview.interfaces, Math.min(limit, 8));
  const triggeredInterfaces = buildTriggeredInterfaces(overview.interfaces, limit);
  const judgements = buildJudgements(overview, triggeredInterfaces);
  const lines = [];

  lines.push('# 接口抓包整理报告', '');
  lines.push('## 产物策略', '');
  lines.push('- `api-traffic-log.jsonl`：本地运行明细日志，默认不提交 Git。');
  lines.push('- `api-traffic-index.json`：本地去重索引缓存，可由日志重建，默认不提交 Git。');
  lines.push('- `api-traffic-sample.jsonl`：去重后的接口样本，作为仓库内展示面保留。');
  lines.push('- `api-traffic-report.md`：给协作者快速浏览抓包覆盖面的概览报告。', '');

  lines.push('## 当前概览', '');
  lines.push(`- 店铺数：${overview.totalShops}`);
  lines.push(`- 抓包总数：${overview.totalCaptured}`);
  lines.push(`- 唯一接口数：${overview.uniqueInterfaceCount}`);
  lines.push('- 分页分组：');
  const pageTypeEntries = Object.entries(overview.pageTypes)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0));
  if (pageTypeEntries.length) {
    for (const [pageType, count] of pageTypeEntries) {
      lines.push(`  - ${pageType}：${count}`);
    }
  } else {
    lines.push('  - 暂无数据');
  }
  lines.push('');

  lines.push('## 去重规则', '');
  lines.push('- 当前接口去重签名由以下字段组成：');
  lines.push('  - `transport`');
  lines.push('  - `direction`');
  lines.push('  - `method`');
  lines.push('  - `endpointPath`');
  lines.push('  - `command`');
  lines.push('  - `resourceType`');
  lines.push('  - `pageType`');
  lines.push('- 同一签名会合并为一条索引记录，并累计 `hitCount`。', '');

  lines.push('## 高频接口', '');
  if (topInterfaces.length) {
    for (const item of topInterfaces) {
      lines.push(`- \`${escapeMarkdown(item.endpointPath || '(empty)')}\``);
      lines.push(`  - 方法：${item.method || 'UNKNOWN'}`);
      lines.push(`  - 命中：${Number(item.hitCount || 0)}`);
      lines.push(`  - 分组：${item.pageType || 'unknown'}`);
      if (item.command) lines.push(`  - 命令：${escapeMarkdown(item.command)}`);
      if (item.lastSummary) lines.push(`  - 摘要：${escapeMarkdown(item.lastSummary)}`);
    }
  } else {
    lines.push('- 暂无数据');
  }
  lines.push('');

  for (const pageType of DOMAIN_ORDER) {
    const items = domainGroups[pageType];
    if (!items || !items.length) continue;
    lines.push(`## ${DOMAIN_LABELS[pageType]}`, '');
    for (const item of items) {
      lines.push(`- \`${escapeMarkdown(item.endpointPath || '(empty)')}\``);
      lines.push(`  - 方法：${item.method || 'UNKNOWN'}`);
      lines.push(`  - 命中：${Number(item.hitCount || 0)}`);
      if (item.lastSummary) lines.push(`  - 摘要：${escapeMarkdown(item.lastSummary)}`);
    }
    lines.push('');
  }

  lines.push('## 最近点击触发接口', '');
  if (triggeredInterfaces.length) {
    for (const item of triggeredInterfaces) {
      lines.push(`- \`${escapeMarkdown(item.endpointPath || '(empty)')}\``);
      lines.push(`  - 方法：${item.method || 'UNKNOWN'}`);
      lines.push(`  - 触发文本：${escapeMarkdown(item.sample?.triggerContext?.targetText || '无')}`);
      lines.push(`  - 触发选择器：${escapeMarkdown(item.sample?.triggerContext?.targetSelector || '无')}`);
      lines.push(`  - 触发页面：${escapeMarkdown(item.sample?.triggerContext?.pageUrl || '无')}`);
      lines.push(`  - 最近命中：${formatDateTime(item.lastSeenAt)}`);
    }
  } else {
    lines.push('- 暂无点击触发上下文');
  }
  lines.push('');

  lines.push('## 当前判断', '');
  lines.push(...judgements, '');

  lines.push('## 常用命令', '');
  lines.push('```bash');
  lines.push('pnpm run export:api-sample');
  lines.push('```', '');
  lines.push('```bash');
  lines.push('pnpm run build:api-traffic-report');
  lines.push('```', '');
  lines.push('```bash');
  lines.push('pnpm run refresh:api-traffic-artifacts');
  lines.push('```', '');
  lines.push('```bash');
  lines.push('pnpm run rebuild:api-traffic-index');
  lines.push('```');

  return `${lines.join('\n')}\n`;
}

function writeReport(outputPath, indexData, options) {
  const content = buildMarkdown(indexData, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf-8');
  return {
    outputPath,
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const explicitIndexPath = resolveAbsolutePath(args.index);
  const explicitLogPath = resolveAbsolutePath(args.log);
  const outputPath = resolveOutputPath(args.output);
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
      throw new Error('未找到可生成报告的抓包索引或日志，请先操作页面生成抓包数据');
    }
    indexData = buildIndexFromLog(logEntries);
    mode = 'log';
  }
  const result = writeReport(outputPath, indexData, {
    limit: args.limit,
    mode,
    indexPath,
    logPath,
  });
  console.log(JSON.stringify({
    ...result,
    mode,
    indexPath,
    logPath,
  }, null, 2));
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(error => {
    console.error(error.message);
    app.exit(1);
  });
