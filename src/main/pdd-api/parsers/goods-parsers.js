// 商品卡片相关的纯函数集合：HTML/JSON 解析、规格归一化、文案提取等。
// 所有函数都不依赖运行时上下文，直接接收 payload 输入返回结构化数据，
// 业务侧（goods-card 模块/PddApiClient facade）通过 thin wrapper 调用。

function decodeGoodsText(value = '') {
  return String(value || '')
    .replace(/\\u([\da-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([\da-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function pickGoodsText(candidates = []) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return decodeGoodsText(value);
  }
  return '';
}

function normalizeGoodsPrice(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (text.includes('¥')) return text;
    const numeric = Number(text);
    if (!Number.isNaN(numeric)) return normalizeGoodsPrice(numeric);
    return text;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const amount = Number.isInteger(numeric) && numeric >= 1000 ? numeric / 100 : numeric;
  return `¥${amount.toFixed(2)}`;
}

function extractGoodsIdFromUrl(rawUrl = '') {
  const urlText = String(rawUrl || '').trim();
  if (!urlText) return '';
  try {
    const parsed = new URL(urlText);
    return parsed.searchParams.get('goods_id') || parsed.searchParams.get('goodsId') || '';
  } catch {
    const match = urlText.match(/[?&]goods_id=(\d+)/i) || urlText.match(/[?&]goodsId=(\d+)/i);
    return match?.[1] || '';
  }
}

function normalizeGoodsId(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const digitsOnly = text.replace(/[^\d]/g, '');
  return digitsOnly || '';
}

function extractGoodsJsonObject(source = '') {
  const text = String(source || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const normalized = text.replace(/;\s*$/, '').trim();
  try {
    return JSON.parse(normalized);
  } catch {}
  const start = normalized.search(/[\[{]/);
  if (start < 0) return null;
  const opening = normalized[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let index = start; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === opening) {
      depth += 1;
      continue;
    }
    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        const candidate = normalized.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractGoodsPayloadCandidates(html = '') {
  const source = String(html || '');
  const payloads = [];
  const seen = new Set();
  const pushPayload = (value) => {
    if (!value || typeof value !== 'object') return;
    let serialized = '';
    try {
      serialized = JSON.stringify(value);
    } catch {}
    if (serialized) {
      if (seen.has(serialized)) return;
      seen.add(serialized);
    }
    payloads.push(value);
  };
  const patterns = [
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /(?:window\.)?__NEXT_DATA__\s*=\s*([\s\S]*?);\s*<\/script>/gi,
    /(?:window\.)?__PRELOADED_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/gi,
    /(?:window\.)?__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/gi,
    /(?:window\.)?rawData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
    /(?:window\.)?pageData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
    /(?:window\.)?goodsData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
  ];
  patterns.forEach((pattern) => {
    source.replace(pattern, (_, payloadText) => {
      const parsed = extractGoodsJsonObject(payloadText);
      if (parsed) pushPayload(parsed);
      return _;
    });
  });
  return payloads;
}

function extractGoodsTextCandidate(value, preferredKeys = []) {
  if (typeof value === 'string' && value.trim()) {
    return decodeGoodsText(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const matched = extractGoodsTextCandidate(item, preferredKeys);
      if (matched) return matched;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const matched = extractGoodsTextCandidate(value[key], preferredKeys);
    if (matched) return matched;
  }
  for (const item of Object.values(value)) {
    const matched = extractGoodsTextCandidate(item, preferredKeys);
    if (matched) return matched;
  }
  return '';
}

function findGoodsFieldText(payload, keys = [], nestedKeys = []) {
  if (!payload || typeof payload !== 'object') return '';
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach(item => queue.push(item));
      continue;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      const matched = extractGoodsTextCandidate(current[key], nestedKeys);
      if (matched) return matched;
    }
    Object.values(current).forEach(item => queue.push(item));
  }
  return '';
}

function pickGoodsNumber(source = {}, keys = []) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const numeric = Number(source[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function splitGoodsSpecText(value = '') {
  return String(value || '')
    .split(/[|/,，；;]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function formatGoodsSpecSegment(segment = {}) {
  const group = String(segment.group || '').trim();
  const name = String(segment.name || '').trim();
  if (!group) return name;
  return `${group}：${name}`;
}

function appendGoodsSpecSegments(segments, value) {
  if (!value) return;
  const pushSegment = (group, name) => {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return;
    segments.push({
      group: String(group || '').trim(),
      name: normalizedName,
    });
  };
  if (typeof value === 'string' || typeof value === 'number') {
    splitGoodsSpecText(value).forEach(part => pushSegment('', part));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => appendGoodsSpecSegments(segments, item));
    return;
  }
  if (typeof value !== 'object') return;
  const group = pickGoodsText([
    value.parent_spec_name,
    value.parentSpecName,
    value.spec_key,
    value.specKey,
    value.group_name,
    value.groupName,
    value.label,
    value.key,
    value.name,
    value.title,
  ]);
  const name = pickGoodsText([
    value.spec_name,
    value.specName,
    value.spec_value,
    value.specValue,
    value.value,
    value.text,
    value.desc,
    value.display_name,
    value.displayName,
  ]);
  if (name) {
    pushSegment(group, name);
    return;
  }
  ['items', 'children', 'list', 'values', 'specs', 'spec_list', 'specList'].forEach((key) => {
    if (value[key]) appendGoodsSpecSegments(segments, value[key]);
  });
}

function extractGoodsSpecSegments(item = {}) {
  const segments = [];
  [
    item.specs,
    item.spec_list,
    item.specList,
    item.spec_info,
    item.specInfo,
    item.spec_values,
    item.specValues,
    item.properties,
    item.props,
    item.sku_props,
    item.skuProps,
  ].forEach(value => appendGoodsSpecSegments(segments, value));
  if (segments.length) return segments;
  const combined = pickGoodsText([
    item.spec,
    item.specText,
    item.spec_text,
    item.sku_spec,
    item.skuSpec,
    item.spec_desc,
    item.specDesc,
    item.sku_name,
    item.skuName,
    item.sub_name,
    item.subName,
    item.option_desc,
    item.optionDesc,
    item.name,
    item.title,
  ]);
  appendGoodsSpecSegments(segments, combined);
  return segments;
}

function normalizeGoodsSpecItem(item = {}) {
  if (!item || typeof item !== 'object') return null;
  const segments = extractGoodsSpecSegments(item);
  const formattedSegments = segments
    .map(segment => formatGoodsSpecSegment(segment))
    .filter(Boolean);
  const specLabel = formattedSegments[0]
    || pickGoodsText([
      item.spec,
      item.specText,
      item.spec_text,
      item.sku_spec,
      item.skuSpec,
      item.spec_desc,
      item.specDesc,
      item.sku_name,
      item.skuName,
      item.sub_name,
      item.subName,
      item.name,
    ]);
  const styleLabel = formattedSegments.slice(1).join(' / ')
    || pickGoodsText([
      item.style,
      item.style_name,
      item.styleName,
      item.mode,
      item.mode_name,
      item.modeName,
      item.option,
      item.option_name,
      item.optionName,
    ]);
  const priceText = pickGoodsText([
    normalizeGoodsPrice(pickGoodsNumber(item, [
      'group_price',
      'min_group_price',
      'single_price',
      'origin_price',
      'normal_price',
      'price',
      'promotion_price',
      'promotionPrice',
      'discount_price',
      'discountPrice',
      'min_price',
    ])),
    item.priceText,
    item.price_text,
    item.price,
    item.group_price_text,
    item.groupPriceText,
  ]);
  const stockNumber = pickGoodsNumber(item, [
    'quantity',
    'stock',
    'stock_num',
    'stockNum',
    'stock_number',
    'stockNumber',
    'left_quantity',
    'leftQuantity',
    'available_stock',
    'availableStock',
    'inventory',
    'inventory_num',
    'inventoryNum',
    'warehouse_num',
    'warehouseNum',
    'goods_number',
    'goodsNumber',
  ]);
  const salesNumber = pickGoodsNumber(item, [
    'sales',
    'sales_num',
    'salesNum',
    'sold',
    'sold_num',
    'soldNum',
    'sold_quantity',
    'soldQuantity',
    'sales_volume',
    'salesVolume',
    'deal_num',
    'dealNum',
    'cnt',
  ]);
  const stockText = Number.isFinite(stockNumber)
    ? String(stockNumber)
    : pickGoodsText([item.stockText, item.stock_text, item.stock]);
  const salesText = Number.isFinite(salesNumber)
    ? String(salesNumber)
    : pickGoodsText([item.salesText, item.sales_text, item.sales]);
  const imageUrl = pickGoodsText([
    item.imageUrl,
    item.image_url,
    item.thumb_url,
    item.hd_thumb_url,
    item.goods_thumb_url,
    item.pic_url,
  ]);
  if (!specLabel && !styleLabel && !priceText && !stockText && !salesText) {
    return null;
  }
  return {
    specLabel,
    styleLabel,
    priceText,
    stockText,
    salesText,
    imageUrl,
  };
}

function collectGoodsSpecCandidates(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const results = [];
  const seen = new Set();
  const preferredKeys = new Set([
    'sku',
    'skus',
    'sku_list',
    'skuList',
    'sku_map',
    'skuMap',
    'sku_info',
    'skuInfo',
    'specs',
    'spec_list',
    'specList',
    'spec_info',
    'specInfo',
    'goods_sku',
    'goodsSku',
  ]);
  const pushCandidate = (value) => {
    let list = null;
    if (Array.isArray(value)) {
      list = value;
    } else if (value && typeof value === 'object') {
      const values = Object.values(value);
      if (values.length && values.every(item => item && typeof item === 'object')) {
        list = values;
      }
    }
    if (!list || !list.length) return;
    const serialized = JSON.stringify(list.slice(0, 10));
    if (seen.has(serialized)) return;
    seen.add(serialized);
    results.push(list);
  };
  const queue = [payload];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach(item => queue.push(item));
      continue;
    }
    Object.entries(current).forEach(([key, value]) => {
      if (preferredKeys.has(key)) pushCandidate(value);
      if (value && typeof value === 'object') queue.push(value);
    });
  }
  return results;
}

function extractGoodsSpecItems(payloadCandidates = [], fallback = {}) {
  const rows = [];
  const seen = new Set();
  const pushRow = (row) => {
    if (!row) return;
    const dedupeKey = [
      row.specLabel,
      row.styleLabel,
      row.priceText,
      row.stockText,
      row.salesText,
    ].join('|');
    if (!dedupeKey.replace(/\|/g, '').trim() || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    rows.push(row);
  };
  payloadCandidates.forEach((payload) => {
    collectGoodsSpecCandidates(payload).forEach((list) => {
      list.forEach((item) => {
        pushRow(normalizeGoodsSpecItem(item));
      });
    });
  });
  if (!rows.length) {
    const fallbackSpecText = String(fallback?.specText || '').trim();
    const fallbackPriceText = String(fallback?.priceText || '').trim();
    if (fallbackSpecText && fallbackSpecText !== '查看商品规格') {
      pushRow({
        specLabel: fallbackSpecText,
        styleLabel: '',
        priceText: fallbackPriceText,
        stockText: '',
        salesText: '',
        imageUrl: String(fallback?.imageUrl || '').trim(),
      });
    }
  }
  return rows.slice(0, 50);
}

function extractGoodsCardFromHtml(html = '', fallback = {}) {
  const source = String(html || '');
  const payloadCandidates = extractGoodsPayloadCandidates(source);
  const matchFirst = (patterns = []) => {
    for (const pattern of patterns) {
      const matched = source.match(pattern);
      if (matched?.[1]) return decodeGoodsText(matched[1]);
    }
    return '';
  };
  const goodsId = pickGoodsText([
    matchFirst([
      /[?&]goods_id=(\d+)/i,
      /"goods_id"\s*:\s*"?(\\d+|\d+)"/i,
      /"goodsId"\s*:\s*"?(\\d+|\d+)"/i,
    ]),
    fallback.goodsId,
  ]);
  const title = pickGoodsText([
    matchFirst([
      /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
      /<meta[^>]+name="og:title"[^>]+content="([^"]+)"/i,
      /"goods_name"\s*:\s*"([^"]+)"/i,
      /"goodsName"\s*:\s*"([^"]+)"/i,
      /"goods_title"\s*:\s*"([^"]+)"/i,
      /"goodsTitle"\s*:\s*"([^"]+)"/i,
      /"share_title"\s*:\s*"([^"]+)"/i,
      /<title>([^<]+)<\/title>/i,
    ]),
    ...payloadCandidates.map(payload => findGoodsFieldText(
      payload,
      ['goods_name', 'goodsName', 'goods_title', 'goodsTitle', 'share_title', 'title', 'item_title', 'itemTitle', 'name'],
      ['title', 'name', 'text', 'content', 'value']
    )),
    fallback.title,
  ]);
  const imageUrl = pickGoodsText([
    matchFirst([
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<meta[^>]+name="og:image"[^>]+content="([^"]+)"/i,
      /"hd_thumb_url"\s*:\s*"([^"]+)"/i,
      /"thumb_url"\s*:\s*"([^"]+)"/i,
      /"goods_thumb_url"\s*:\s*"([^"]+)"/i,
      /"hdThumbUrl"\s*:\s*"([^"]+)"/i,
      /"thumbUrl"\s*:\s*"([^"]+)"/i,
      /"goodsThumbUrl"\s*:\s*"([^"]+)"/i,
      /"top_gallery"\s*:\s*\[\s*"([^"]+)"/i,
    ]),
    ...payloadCandidates.map(payload => findGoodsFieldText(
      payload,
      ['hd_thumb_url', 'thumb_url', 'goods_thumb_url', 'hdThumbUrl', 'thumbUrl', 'goodsThumbUrl', 'imageUrl', 'image_url', 'pic_url', 'top_gallery', 'gallery', 'images', 'imageList'],
      ['url', 'src', 'imageUrl', 'image_url', 'thumb_url', 'thumbUrl']
    )),
    fallback.imageUrl,
  ]);
  const priceText = pickGoodsText([
    normalizeGoodsPrice(matchFirst([
      /"min_group_price"\s*:\s*"?(\\d+(?:\\.\\d+)?|\d+(?:\.\d+)?)"/i,
      /"group_price"\s*:\s*"?(\\d+(?:\\.\\d+)?|\d+(?:\.\d+)?)"/i,
      /"price"\s*:\s*"?(\\d+(?:\\.\\d+)?|\d+(?:\.\d+)?)"/i,
    ])),
    fallback.priceText,
  ]);
  const groupText = pickGoodsText([
    matchFirst([
      /"group_order_type_desc"\s*:\s*"([^"]+)"/i,
      /"group_desc"\s*:\s*"([^"]+)"/i,
      /"groupLabel"\s*:\s*"([^"]+)"/i,
      /"customer_num"\s*:\s*"?(\\d+|\d+)"/i,
    ]),
    fallback.groupText,
    '2人团',
  ]);
  const specItems = extractGoodsSpecItems(payloadCandidates, fallback);
  return {
    goodsId,
    title: title.replace(/\s*-\s*拼多多.*$/i, '').trim(),
    imageUrl,
    priceText,
    groupText: /^\d+$/.test(groupText) ? `${groupText}人团` : groupText,
    specText: fallback.specText || '查看商品规格',
    specItems,
  };
}

function isGoodsLoginPageHtml(html = '') {
  const source = String(html || '');
  if (!source) return false;
  return /手机号码/.test(source)
    && /验证码/.test(source)
    && /服务协议/.test(source)
    && /隐私政策/.test(source);
}

function hasMeaningfulGoodsCardData(card = {}, fallback = {}) {
  const title = String(card?.title || '').trim();
  const fallbackTitle = String(fallback?.title || '').trim();
  return !!(
    String(card?.imageUrl || '').trim()
    || String(card?.priceText || '').trim()
    || (title && title !== '拼多多商品' && (!fallbackTitle || title !== fallbackTitle))
  );
}

module.exports = {
  decodeGoodsText,
  pickGoodsText,
  normalizeGoodsPrice,
  extractGoodsIdFromUrl,
  normalizeGoodsId,
  extractGoodsJsonObject,
  extractGoodsPayloadCandidates,
  extractGoodsTextCandidate,
  findGoodsFieldText,
  pickGoodsNumber,
  splitGoodsSpecText,
  formatGoodsSpecSegment,
  appendGoodsSpecSegments,
  extractGoodsSpecSegments,
  normalizeGoodsSpecItem,
  collectGoodsSpecCandidates,
  extractGoodsSpecItems,
  extractGoodsCardFromHtml,
  isGoodsLoginPageHtml,
  hasMeaningfulGoodsCardData,
};
