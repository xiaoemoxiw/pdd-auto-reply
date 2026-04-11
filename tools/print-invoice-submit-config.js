const fs = require('fs');
const path = require('path');

function readJsonLines(filePath, limit = 8000) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean).slice(-limit);
  const result = [];
  for (const line of lines) {
    try {
      result.push(JSON.parse(line));
    } catch {}
  }
  return result;
}

function scoreEntry(entry = {}) {
  const method = String(entry.method || '').toUpperCase();
  if (method !== 'POST') return 0;
  const url = String(entry.endpointPath || entry.url || '');
  if (!url) return 0;
  const ignored = [
    '/omaisms/invoice/invoice_list',
    '/omaisms/invoice/invoice_statistic',
    '/omaisms/invoice/invoice_quick_filter',
    '/omaisms/invoice/pop_notice',
    '/omaisms/invoice/invoice_tutorials',
    '/omaisms/invoice/is_third_party_entity_sub_mall',
    '/orderinvoice/mall/mallControlInfo',
    '/orderinvoice/mall/showInvoiceMarkTab',
    '/mangkhut/mms/orderDetail',
    '/cambridge/api/duoDuoRuleSecret/checkAvailableToSubmitInvoiceRecord',
  ];
  if (ignored.some(part => url.includes(part))) return 0;
  const headers = entry.requestHeaders || {};
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const referer = String(headers.referer || headers.Referer || '').toLowerCase();
  const documentUrl = String(entry.documentURL || '').toLowerCase();
  const bodyText = typeof entry.requestBody === 'string' ? entry.requestBody : '';

  const invoiceContext = documentUrl.includes('/invoice/') || referer.includes('/invoice/');
  const isMultipart = contentType.includes('multipart/form-data') || bodyText.includes('Content-Disposition: form-data');
  const submitHints = /submit|record|upload/i.test(url);
  const invoiceHints = /invoice|orderinvoice|cambridge\/api/i.test(url);

  return [
    invoiceContext ? 10 : 0,
    isMultipart ? 10 : 0,
    submitHints ? 6 : 0,
    invoiceHints ? 6 : 0,
  ].reduce((sum, val) => sum + val, 0);
}

function parseMultipartFieldNames(text) {
  const bodyText = String(text || '');
  if (!bodyText || !bodyText.includes('Content-Disposition: form-data')) return null;
  const parts = [];
  const regex = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/gi;
  let match = null;
  while ((match = regex.exec(bodyText))) {
    parts.push({ name: match[1], isFile: !!(match[2] || '') });
  }
  if (!parts.length) return null;
  const filePart = parts.find(item => item.isFile) || null;
  const fieldNames = Array.from(new Set(parts.map(item => item.name).filter(Boolean)));
  return { fileFieldName: filePart?.name || '', fieldNames };
}

function main() {
  const logPath = path.join(__dirname, '..', 'artifacts', 'api-traffic', 'api-traffic-log.jsonl');
  const rows = readJsonLines(logPath, 12000);
  const entries = rows
    .map(row => row?.entry)
    .filter(Boolean);

  const candidates = entries
    .map(entry => ({ entry, score: scoreEntry(entry) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (!candidates.length) {
    process.stdout.write('NO_CANDIDATE\n');
    return;
  }

  const best = candidates[0].entry;
  const urlPath = String(best.endpointPath || best.url || '').trim();
  const method = String(best.method || 'POST').toUpperCase();
  const headers = best.requestHeaders || {};
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const requestBody = best.requestBody;

  const parsed = parseMultipartFieldNames(requestBody);
  const config = contentType.includes('multipart/form-data') || parsed
    ? {
      mode: 'multipart',
      method,
      urlPath,
      fileFieldName: parsed?.fileFieldName || '',
      fieldNames: parsed?.fieldNames || [],
    }
    : {
      mode: 'json',
      method,
      urlPath,
      fieldNames: (requestBody && typeof requestBody === 'object') ? Object.keys(requestBody) : [],
    };

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

main();
