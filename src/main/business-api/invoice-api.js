const fs = require('fs');
const path = require('path');
const { getDefaultInvoiceSubmitConfig } = require('./invoice-submit-config');
const { PddBusinessApiClient } = require('./pdd-business-api-client');
const { normalizePddUserAgent } = require('./pdd-request-profile');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_INVOICE_URL = `${PDD_BASE}/invoice/center?msfrom=mms_sidenav&activeKey=0`;

function pickValue(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeInvoiceAmount(value) {
  const raw = value ?? 0;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return 0;
  if (typeof raw === 'string' && raw.includes('.')) return amount;
  return Number.isInteger(amount) ? amount / 100 : amount;
}

function normalizeMappedText(value, map) {
  if (value === undefined || value === null || value === '') return '';
  return map[String(value)] || String(value);
}

function resolveOrderStatusText(item = {}) {
  const text = pickValue(item, ['order_status_desc', 'order_status_text', 'order_status_name', 'order_status_str'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['order_status'], ''), {
    2: '已收货',
  });
}

function resolveAfterSalesStatusText(item = {}) {
  const text = pickValue(item, ['after_sales_status_desc', 'after_sales_status_text', 'refund_status_desc'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['after_sales_status'], ''), {
    0: '正常',
  });
}

function resolveInvoiceModeText(item = {}) {
  const text = pickValue(item, ['invoice_mode_desc', 'invoice_mode_name', 'invoice_mode_text'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['invoice_mode'], ''), {
    0: '自动',
    1: '自动',
    2: '手动',
    3: '手动',
  });
}

function resolveInvoiceTypeText(item = {}) {
  const text = pickValue(item, [
    'invoice_way_desc',
    'invoice_way_name',
    'invoice_way_text',
    'invoice_type_desc',
    'invoice_type_name',
    'invoice_type_text',
  ], '');
  if (text) return String(text);
  const invoiceWay = pickValue(item, ['invoice_way'], '');
  if (invoiceWay !== '') {
    return normalizeMappedText(invoiceWay, {
      0: '电票',
      1: '纸票',
    });
  }
  return normalizeMappedText(pickValue(item, ['invoice_type'], ''), {
    0: '电票',
    1: '纸票',
  });
}

function resolveInvoiceKindText(item = {}) {
  const text = pickValue(item, ['invoice_kind_desc', 'invoice_kind_name', 'invoice_kind_text'], '');
  if (text) return String(text);
  return normalizeMappedText(pickValue(item, ['invoice_kind'], ''), {
    0: '蓝票',
    1: '红票',
  });
}

function resolveLetterheadTypeText(item = {}) {
  const text = pickValue(item, ['letterhead_type_desc', 'letterhead_type_name', 'title_type_desc'], '');
  if (text) return String(text);
  const normalized = normalizeMappedText(pickValue(item, ['letterhead_type'], ''), {
    0: '个人',
    1: '企业',
  });
  if (normalized) return normalized;
  if (pickValue(item, ['payer_register_no', 'tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo'], '')) {
    return '企业';
  }
  return pickValue(item, ['letterhead', 'invoice_title', 'title_name'], '') ? '个人' : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class InvoiceApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    const getInvoiceUrl = options.getInvoiceUrl || (() => DEFAULT_INVOICE_URL);
    super(shopId, {
      ...options,
      getRefererUrl: getInvoiceUrl,
      errorLabel: '待开票接口',
      loginExpiredMessage: '待开票页面登录已失效，请重新导入 Token 或刷新登录态'
    });
    this._getInvoiceUrl = getInvoiceUrl;
    this._getSubmitConfig = options.getSubmitConfig || (() => null);
    this._setSubmitConfig = options.setSubmitConfig || (() => {});
    this._detailCache = new Map(); // orderSn -> { at, value }
    this._detailPending = new Map(); // orderSn -> Promise
    this._detailThrottle = Promise.resolve();
    this._lastDetailRequestAt = 0;
  }

  _parseMultipartFieldNames(text) {
    const bodyText = String(text || '');
    if (!bodyText) return null;
    if (!bodyText.includes('Content-Disposition: form-data')) return null;
    const parts = [];
    const regex = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/gi;
    let match = null;
    while ((match = regex.exec(bodyText))) {
      const name = match[1];
      const filename = match[2] || '';
      parts.push({
        name,
        isFile: !!filename,
      });
    }
    if (!parts.length) return null;
    const filePart = parts.find(item => item.isFile) || null;
    const fieldNames = Array.from(new Set(parts.map(item => item.name).filter(Boolean)));
    return {
      fileFieldName: filePart?.name || '',
      fieldNames,
    };
  }

  _discoverSubmitTraffic() {
    const list = this._getApiTrafficEntries();
    const candidates = [];
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
    const ignoredLoose = [
      '/chats/',
      '/plateau/',
      '/latitude/',
      '/mercury/',
      '/pizza/order/',
      '/get_signature',
      '/store_image',
      '/api/pmm/',
      '/xg/',
      '/janus/',
      '/escort/',
    ];
    for (let i = list.length - 1; i >= 0 && candidates.length < 40; i--) {
      const entry = list[i] || {};
      const method = String(entry.method || '').toUpperCase();
      if (method !== 'POST') continue;
      const url = String(entry.endpointPath || entry.url || '');
      if (!url) continue;
      if (ignored.some(part => url.includes(part))) continue;
      if (ignoredLoose.some(part => url.includes(part))) continue;
      const headers = entry.requestHeaders || {};
      const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
      const requestBody = entry.requestBody;
      const bodyText = typeof requestBody === 'string' ? requestBody : '';

      const referer = String(headers.referer || headers.Referer || '').toLowerCase();
      const documentUrl = String(entry.documentURL || '').toLowerCase();
      const urlLower = url.toLowerCase();
      const isMultipart = contentType.includes('multipart/form-data')
        || (bodyText && bodyText.includes('Content-Disposition: form-data'));
      const parsedFields = this._parseMultipartFieldNames(bodyText);
      const fieldNames = parsedFields?.fieldNames || [];
      const hasInvoiceFieldHints = fieldNames.some(name => {
        const lower = String(name || '').toLowerCase();
        return lower.includes('invoice') || lower.includes('serial') || (lower.includes('order') && (lower.includes('sn') || lower.includes('no')));
      });
      const invoiceContext = documentUrl.includes('/invoice/') || referer.includes('/invoice/');
      const invoiceUrlHints = urlLower.includes('invoice') || urlLower.includes('/orderinvoice/') || urlLower.includes('/cambridge/api/');
      const submitHints = /submit|record|upload/i.test(urlLower);
      const score = [
        isMultipart ? 10 : 0,
        submitHints ? 6 : 0,
        invoiceUrlHints ? 6 : 0,
        invoiceContext ? 6 : 0,
        hasInvoiceFieldHints ? 8 : 0,
        typeof requestBody === 'object' && requestBody ? 2 : 0,
      ].reduce((sum, val) => sum + val, 0);

      if (!invoiceContext && !invoiceUrlHints && !hasInvoiceFieldHints) continue;
      if (score <= 0) continue;
      candidates.push({ entry, url, contentType, score });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].entry || null;
  }

  _discoverSubmitConfigFromTraffic() {
    const traffic = this._discoverSubmitTraffic();
    if (!traffic) return null;
    const urlPath = String(traffic.endpointPath || traffic.url || '').trim();
    if (!urlPath) return null;
    const method = String(traffic.method || 'POST').toUpperCase();
    const headers = traffic.requestHeaders || {};
    const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    const requestBody = traffic.requestBody;
    if (contentType.includes('multipart/form-data') || (typeof requestBody === 'string' && requestBody.includes('Content-Disposition: form-data'))) {
      const parsed = this._parseMultipartFieldNames(requestBody);
      const config = {
        mode: 'multipart',
        method,
        urlPath,
        fileFieldName: parsed?.fileFieldName || '',
        fieldNames: parsed?.fieldNames || [],
        discoveredAt: Date.now(),
      };
      return config;
    }
    if (typeof requestBody === 'object' && requestBody) {
      return {
        mode: 'json',
        method,
        urlPath,
        fieldNames: Object.keys(requestBody),
        discoveredAt: Date.now(),
      };
    }
    return null;
  }

  async submitInvoiceRecord(params = {}) {
    const serialNo = String(params.serialNo || params.serial_no || '').trim();
    const orderSn = String(params.orderSn || params.order_sn || '').trim();
    const invoiceNumberInput = String(params.invoiceNumber || params.invoice_number || params.invoiceNo || '').trim();
    const invoiceCodeInput = String(params.invoiceCode || params.invoice_code || '').trim();
    const fileName = String(params.fileName || params.filename || '').trim();
    const filePath = String(params.filePath || '').trim();
    const fileData = params.fileData ?? params.fileBuffer ?? null;
    const invoicePdfUrlInput = String(params.invoicePdfUrl || params.invoice_pdf_url || '').trim();

    if (!serialNo && !orderSn) throw new Error('缺少流水号或订单号');
    if (!fileName && !filePath && !invoicePdfUrlInput) throw new Error('缺少发票文件');

    const defaultConfig = (typeof getDefaultInvoiceSubmitConfig === 'function'
      ? getDefaultInvoiceSubmitConfig()
      : null) || null;
    let submitConfig = defaultConfig || this._getSubmitConfig?.() || null;
    if (!submitConfig) {
      submitConfig = this._discoverSubmitConfigFromTraffic();
      if (submitConfig) {
        this._setSubmitConfig?.(submitConfig);
      }
    }
    if (!submitConfig) {
      throw new Error('未识别到“录入发票上传/提交”接口抓包：请先在【待开票（嵌入网页）】页面完成一次录入发票提交，再回来重试。');
    }

    if (submitConfig.mode === 'json') {
      return await this._submitInvoiceRecordByJson(submitConfig, {
        serialNo,
        orderSn,
        invoiceNumberInput,
        invoiceCodeInput,
        fileName,
        filePath,
        fileData,
        invoicePdfUrl: invoicePdfUrlInput,
        businessType: params.businessType ?? params.business_type,
        invoiceKind: params.invoiceKind ?? params.invoice_kind ?? params.invoiceKindValue,
        payerName: params.payerName ?? params.payer_name ?? params.letterhead,
        payerRegisterNo: params.payerRegisterNo ?? params.payer_register_no ?? params.taxNo ?? params.tax_no,
        force: !!params.force,
      });
    }
    if (submitConfig.mode !== 'multipart') {
      throw new Error(`已识别到提交接口(${submitConfig.urlPath})，但当前提交模式(${submitConfig.mode || 'unknown'})暂未支持自动对接。`);
    }

    const buffer = await (async () => {
      if (fileData) {
        if (Buffer.isBuffer(fileData)) return fileData;
        if (fileData instanceof ArrayBuffer) return Buffer.from(fileData);
        if (ArrayBuffer.isView(fileData)) return Buffer.from(fileData.buffer, fileData.byteOffset, fileData.byteLength);
      }
      if (filePath) return fs.promises.readFile(filePath);
      throw new Error('发票文件读取失败');
    })();

    const ext = path.extname(fileName || filePath || '').toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
    const blob = new Blob([buffer], { type: mimeType });
    const formData = new FormData();

    const fileFieldName = String(submitConfig.fileFieldName || '').trim() || 'file';
    const fieldNames = Array.isArray(submitConfig.fieldNames) ? submitConfig.fieldNames : [];
    const normalizedFieldNames = fieldNames.length
      ? fieldNames
      : ['serial_no', 'order_sn', 'invoice_number', 'invoice_code'];

    const setFieldValue = (name) => {
      const lower = String(name || '').toLowerCase();
      if (lower.includes('invoice') && (lower.includes('number') || lower.includes('no') || lower === 'fpqh' || lower === 'fphm')) return invoiceNumberInput;
      if (lower.includes('invoice') && lower.includes('code')) return invoiceCodeInput;
      if (lower.includes('serial')) return serialNo;
      if (lower.includes('order') && (lower.includes('sn') || lower.includes('no'))) return orderSn;
      return '';
    };

    normalizedFieldNames.forEach(name => {
      if (!name) return;
      if (name === fileFieldName) return;
      const value = setFieldValue(name);
      if (value !== '') {
        formData.append(name, value);
      }
    });

    formData.append(fileFieldName, blob, fileName || path.basename(filePath) || 'invoice.pdf');

    const payload = await this._requestForm(submitConfig.method || 'POST', submitConfig.urlPath, formData);
    return payload?.result ?? payload ?? { ok: true };
  }

  async _uploadInvoiceFile(buffer, fileName, mimeType = 'application/octet-stream') {
    const byteLength = Buffer.isBuffer(buffer) ? buffer.length : 0;
    if (!byteLength) {
      throw new Error('上传发票文件失败：文件为空');
    }
    const blob = new Blob([buffer], { type: mimeType });
    const uploadUrl = 'https://file.pinduoduo.com/general_file';
    const signature = await this._getInvoiceUploadSignature();
    if (!signature || String(signature).trim().length < 16) {
      throw new Error('上传发票文件失败：签名为空');
    }
    let lastError = null;
    try {
      const cookie = await this._getCookieString();
      const tokenInfo = this._getTokenInfo();
      const shop = this._getShopInfo();
      const userAgent = normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || '');

      const fileFieldCandidates = [
        'file',
        'files',
        'files[]',
        'file[]',
        'invoice',
        'invoice_file',
        'invoiceFile',
        'upload',
        'upload_file',
        'document',
        'data',
        'file_data',
      ];
      const signatureCandidates = [
        ['upload_sign', signature],
        ['signature', signature],
        ['sign', signature],
        ['uploadSign', signature],
      ];
      for (const fileFieldName of fileFieldCandidates) {
        const formData = new FormData();
        signatureCandidates.forEach(([key, value]) => formData.append(key, value));
        formData.append('bucket_tag', 'order_invoice');
        formData.append('file_type', mimeType.includes('pdf') ? 'pdf' : '');
        formData.append(fileFieldName, blob, fileName || 'invoice.pdf');

        let response = null;
        try {
          response = await this._getSession().fetch(uploadUrl, {
            method: 'POST',
            headers: {
              accept: 'application/json, text/plain, */*',
              'accept-language': 'zh-CN,zh;q=0.9',
              Referer: 'https://mms.pinduoduo.com/',
              Origin: 'https://mms.pinduoduo.com',
              'sec-fetch-site': 'cross-site',
              ...(cookie ? { cookie } : {}),
              ...(userAgent ? { 'user-agent': userAgent } : {}),
            },
            credentials: 'include',
            body: formData,
          });
        } catch (error) {
          lastError = new Error(`[待开票接口] POST ${uploadUrl} 上传失败：${error?.message || 'network error'}`);
          continue;
        }

        const text = await response.text();
        let payload = text;
        try {
          payload = JSON.parse(text);
        } catch {}
        if (!response.ok) {
          const message = typeof payload === 'object'
            ? payload?.error_msg || payload?.errorMsg || payload?.message || `HTTP ${response.status}`
            : `HTTP ${response.status}: ${String(text).slice(0, 200)}`;
          lastError = new Error(message);
          continue;
        }
        const businessError = this._normalizeBusinessError(payload);
        if (businessError) {
          lastError = new Error(businessError.message);
          continue;
        }
        const url = typeof payload === 'object' ? String(payload.url || '').trim() : '';
        const md5 = typeof payload === 'object' ? String(payload.md5 || '').trim() : '';
        if (url) {
          return { url, md5 };
        }
        lastError = new Error('上传发票文件失败：缺少 url 返回');
      }
    } catch (error) {
      lastError = error;
    }
    throw lastError || new Error('上传发票文件失败');
  }

  async _getInvoiceUploadSignature() {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const payload = await this._request('POST', '/galerie/business/get_signature', {
          bucket_tag: 'order_invoice'
        });
        const signature = payload?.result?.signature || payload?.signature || '';
        if (!signature) {
          throw new Error('获取上传签名失败');
        }
        return signature;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || '');
        const shouldRetry = message.includes('操作太过频繁') || message.includes('太过频繁') || message.includes('频繁');
        if (!shouldRetry || attempt >= 4) {
          throw error;
        }
        const base = 1200 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 220);
        await sleep(base + jitter);
      }
    }
    throw lastError || new Error('获取上传签名失败');
  }

  async _parseInvoiceFile(orderSn, serialNo, invoicePdfUrl) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const payload = await this._request('POST', '/orderinvoice/eInvoice/parseInvoice', {
          orderSn,
          invoicePdfUrl,
          serialNo,
        });
        return payload?.result || {};
      } catch (error) {
        lastError = error;
        const message = String(error?.message || '');
        const shouldRetry = message.includes('操作太过频繁') || message.includes('太过频繁') || message.includes('频繁');
        if (!shouldRetry || attempt >= 4) {
          throw error;
        }
        const base = 1500 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 260);
        await sleep(base + jitter);
      }
    }
    throw lastError || new Error('发票解析校验失败');
  }

  async _submitInvoiceRecordByJson(config, context) {
    const urlPath = String(config?.urlPath || '').trim();
    if (!urlPath) throw new Error('缺少提交接口地址');
    const method = String(config?.method || 'POST').toUpperCase();

    const serialNo = context.serialNo;
    const orderSn = context.orderSn;
    const force = !!context.force;
    const ext = path.extname(context.fileName || context.filePath || '').toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';

    let invoicePdfUrl = String(context.invoicePdfUrl || '').trim();
    let buffer = null;
    if (!invoicePdfUrl) {
      buffer = await (async () => {
        if (context.fileData) {
          if (Buffer.isBuffer(context.fileData)) return context.fileData;
          if (context.fileData instanceof ArrayBuffer) return Buffer.from(context.fileData);
          if (ArrayBuffer.isView(context.fileData)) return Buffer.from(context.fileData.buffer, context.fileData.byteOffset, context.fileData.byteLength);
        }
        if (context.filePath) return fs.promises.readFile(context.filePath);
        throw new Error('发票文件读取失败');
      })();
      const uploaded = await this._uploadInvoiceFile(buffer, context.fileName || path.basename(context.filePath) || 'invoice.pdf', mimeType);
      invoicePdfUrl = uploaded.url;
    }

    let parsed = {};
    let forbidden = false;
    let warn = false;
    let warnMessage = '';
    try {
      parsed = await this._parseInvoiceFile(orderSn, serialNo, invoicePdfUrl);
      forbidden = parsed?.forbidden === true || parsed?.forbidden === 'true';
      warn = parsed?.warn === true || parsed?.warn === 'true';
      warnMessage = String(parsed?.message || '').trim();
    } catch (error) {
      const message = String(error?.message || '');
      const isRateLimit = message.includes('操作太过频繁') || message.includes('太过频繁') || message.includes('频繁');
      if (!isRateLimit) throw error;
      parsed = {};
      forbidden = false;
      warn = false;
      warnMessage = '';
    }

    const invoiceNumber = String(context.invoiceNumberInput || parsed?.invoiceNumber || '').trim();
    const invoiceCode = String(context.invoiceCodeInput || parsed?.invoiceCode || '').trim();
    const payerName = String(context.payerName || parsed?.payerName || '').trim();
    const payerRegisterNo = String(context.payerRegisterNo || '').trim();

    if (!invoiceNumber) throw new Error('缺少发票号码');
    if (forbidden) {
      throw new Error(warnMessage || '发票解析校验未通过');
    }
    if (warn && !force) {
      return {
        warn: true,
        message: warnMessage || '发票解析提示风险，请确认后再提交',
        invoicePdfUrl,
        invoiceNumber,
        invoiceCode,
        payerName,
        payerRegisterNo,
      };
    }

    const businessType = Number(context.businessType ?? 1);
    const invoiceKind = Number(context.invoiceKind ?? 0);
    const body = {
      invoice_code: invoiceCode,
      invoice_pdf_url: invoicePdfUrl,
      invoice_kind: Number.isFinite(invoiceKind) ? invoiceKind : 0,
      business_type: Number.isFinite(businessType) ? businessType : 1,
      payer_register_no: payerRegisterNo,
      payer_name: payerName,
      serial_no: serialNo,
      invoice_number: invoiceNumber,
      order_sn: orderSn,
      paper_shipping_id: null,
      send_certificate_url: [],
    };

    const payload = await this._request(method, urlPath, body);
    return payload?.result ?? payload ?? { ok: true };
  }

  _normalizeOverview(stats = {}, quickFilter = {}, mallControl = {}, verifyInfo = {}, extra = {}) {
    return {
      pendingNum: Number(stats.pending_num || 0),
      invoicedNum: Number(stats.invoiced_num || 0),
      applyingNum: Number(stats.applying_num || 0),
      invoiceAmount: normalizeInvoiceAmount(stats.invoice_amount || 0),
      quickPendingTotal: Number(quickFilter.total || 0),
      qualityPendingTotal: Number(quickFilter.quality_total || 0),
      normalPendingTotal: Number(quickFilter.normal_total || 0),
      nationalInvoiceConfirmTotal: Number(quickFilter.national_invoice_confirm_total || 0),
      mallControlInfo: mallControl || {},
      verifyInfo: verifyInfo || {},
      showInvoiceMarkTab: !!extra.showInvoiceMarkTab,
      isThirdPartySubMall: !!extra.isThirdPartySubMall,
    };
  }

  _normalizeListItem(item = {}) {
    const serialNo = pickValue(item, ['serial_no', 'serialNo', 'id'], '');
    const orderSn = pickValue(item, ['order_sn', 'orderSn', 'order_no', 'orderNo'], '');
    return {
      serialNo: String(serialNo || ''),
      orderSn: String(orderSn || ''),
      shopName: String(pickValue(item, ['mall_name', 'shop_name', 'store_name'], '')),
      orderStatus: resolveOrderStatusText(item),
      afterSalesStatus: resolveAfterSalesStatusText(item),
      applyTime: Number(pickValue(item, ['apply_time', 'applyTime', 'created_at', 'create_time'], 0) || 0),
      promiseInvoiceTime: Number(pickValue(item, ['promise_invoicing_time', 'promise_invoice_time'], 0) || 0),
      invoiceAmount: normalizeInvoiceAmount(pickValue(item, ['invoice_amount', 'amount', 'sum_amount'], 0) || 0),
      invoiceMode: resolveInvoiceModeText(item),
      invoiceType: resolveInvoiceTypeText(item),
      invoiceKind: resolveInvoiceKindText(item),
      letterheadType: resolveLetterheadTypeText(item),
      letterhead: String(pickValue(item, ['letterhead', 'invoice_title', 'title_name'], '')),
      goodsName: String(pickValue(item, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle'], '')),
      goodsSpec: String(pickValue(item, ['spec', 'goods_spec', 'goodsSpec', 'sku_spec_desc'], '')),
      goodsThumb: String(pickValue(item, [
        'thumb_url',
        'thumbUrl',
        'goods_thumbnail_url',
        'goods_thumb_url',
        'goods_img_url',
        'goods_image_url',
        'goods_image',
      ], '')),
      taxNo: String(pickValue(item, ['payer_register_no', 'tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo', 'duty_paragraph'], '')),
      otherInfo: String(pickValue(item, ['other_info', 'otherInfo'], '')),
      paperReceiverName: String(pickValue(item, ['paper_receiver_name', 'paperReceiverName'], '')),
      paperReceiverMobile: String(pickValue(item, ['paper_receiver_mobile', 'paperReceiverMobile'], '')),
      paperReceiverAddress: String(pickValue(item, ['paper_receiver_address', 'paperReceiverAddress'], '')),
      invoiceDisplayStatus: Number(pickValue(item, ['invoice_display_status', 'display_status', 'status'], 0) || 0),
      raw: item,
    };
  }

  _normalizeDetail(detail = {}) {
    return {
      orderSn: String(pickValue(detail, ['order_sn', 'orderSn'], '')),
      orderStatus: String(pickValue(detail, ['order_status_str', 'order_status_desc', 'order_status_text', 'order_status'], '')),
      invoiceApplyStatus: String(pickValue(detail, ['invoice_apply_status_str', 'invoice_apply_status_desc'], '')),
      goodsName: String(pickValue(detail, ['goods_name', 'goodsName', 'goods_title', 'goodsTitle'], '')),
      goodsSpec: String(pickValue(detail, ['spec', 'goods_spec', 'goodsSpec', 'sku_spec_desc'], '')),
      goodsThumb: String(pickValue(detail, [
        'thumb_url',
        'thumbUrl',
        'goods_thumbnail_url',
        'goods_thumb_url',
        'goods_img_url',
        'goods_image_url',
        'goods_image',
      ], '')),
      receiveName: String(pickValue(detail, ['receive_name', 'receiver_name', 'consignee', 'receiver'], '')),
      receiveMobile: String(pickValue(detail, ['receive_mobile', 'receiver_mobile', 'mobile'], '')),
      shippingAddress: String(pickValue(detail, ['shipping_address', 'receive_address', 'address'], '')),
      shippingName: String(pickValue(detail, ['shipping_name', 'express_company_name', 'express_name'], '')),
      trackingNumber: String(pickValue(detail, ['tracking_number', 'waybill_no', 'trackingNo'], '')),
      taxNo: String(pickValue(detail, ['tax_no', 'taxNo', 'taxpayer_no', 'taxpayerNo', 'duty_paragraph'], '')),
      raw: detail
    };
  }

  async getOverview() {
    const [statsPayload, quickFilterPayload, mallControlPayload, verifyPayload, markTabPayload, thirdPartyPayload] = await Promise.all([
      this._request('POST', '/omaisms/invoice/invoice_statistic', {}),
      this._request('POST', '/omaisms/invoice/invoice_quick_filter', {}),
      this._request('POST', '/orderinvoice/mall/mallControlInfo', {}),
      this._request('POST', '/voice/api/mms/invoice/mall/verify2', {}),
      this._request('POST', '/orderinvoice/mall/showInvoiceMarkTab', {}),
      this._request('POST', '/omaisms/invoice/is_third_party_entity_sub_mall', {}),
    ]);
    return this._normalizeOverview(
      statsPayload?.result || {},
      quickFilterPayload?.result || {},
      mallControlPayload?.result || {},
      verifyPayload?.result || {},
      {
        showInvoiceMarkTab: markTabPayload?.result,
        isThirdPartySubMall: thirdPartyPayload?.result,
      }
    );
  }

  async getList(params = {}) {
    const pageNo = Math.max(1, Number(params.pageNo || params.page_no || 1));
    const pageSize = Math.max(1, Number(params.pageSize || params.page_size || 10));
    const keyword = String(params.keyword || '').trim();
    const body = {
      invoice_mode_list: null,
      invalid_status: '',
      letterhead: '',
      invoice_display_status: Number(params.invoiceDisplayStatus ?? 0),
      order_status: '',
      page_size: pageSize,
      serial_no: keyword,
      after_sales_status: '',
      letterhead_type: '',
      page_no: pageNo,
      invoice_type: '',
      invoice_kind: '',
      invoice_way: '',
      invoice_waybill_no: '',
      file_status: '',
      subsidy_type: Number(params.subsidyType ?? 0),
      order_sn: keyword,
    };
    const payload = await this._request('POST', '/omaisms/invoice/invoice_list', body);
    const result = payload?.result || {};
    const list = Array.isArray(result.list) ? result.list.map(item => this._normalizeListItem(item)) : [];
    return {
      pageNo,
      pageSize,
      total: Number(result.total || 0),
      list,
    };
  }

  async getDetail(params = {}) {
    const orderSn = String(params.orderSn || params.order_sn || '').trim();
    if (!orderSn) {
      throw new Error('缺少订单号');
    }
    const cached = this._detailCache.get(orderSn) || null;
    if (cached && Date.now() - Number(cached.at || 0) < 2 * 60 * 1000) {
      return cached.value;
    }

    const pending = this._detailPending.get(orderSn);
    if (pending) return pending;

    const task = (async () => {
      const throttle = this._detailThrottle.then(async () => {
        const now = Date.now();
        const diff = now - this._lastDetailRequestAt;
        if (diff < 1500) {
          await sleep(1500 - diff);
        }
        this._lastDetailRequestAt = Date.now();
      });
      this._detailThrottle = throttle.catch(() => {});
      await throttle;

      const detailPayload = await this._requestOrderDetailWithRetry(orderSn);
      const detail = this._normalizeDetail(detailPayload?.result || {});

      const submitCheckPayload = await Promise.allSettled([
        this._request('POST', '/cambridge/api/duoDuoRuleSecret/checkAvailableToSubmitInvoiceRecord', {})
      ]);

      const result = {
        orderSn,
        canSubmit: submitCheckPayload[0].status === 'fulfilled'
          ? !!submitCheckPayload[0].value?.result
          : null,
        detail
      };
      this._detailCache.set(orderSn, { at: Date.now(), value: result });
      return result;
    })();

    this._detailPending.set(orderSn, task);
    try {
      return await task;
    } finally {
      this._detailPending.delete(orderSn);
    }
  }

  async _requestOrderDetailWithRetry(orderSn) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this._request('POST', '/mangkhut/mms/orderDetail', { orderSn, source: 'MMS' });
      } catch (error) {
        lastError = error;
        const message = String(error?.message || '');
        const shouldRetry = message.includes('操作太过频繁') || message.includes('太过频繁') || message.includes('频繁');
        if (!shouldRetry || attempt >= 4) {
          throw error;
        }
        const base = 2000 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 320);
        await sleep(base + jitter);
      }
    }
    throw lastError || new Error('加载订单详情失败');
  }
}

module.exports = { InvoiceApiClient };
