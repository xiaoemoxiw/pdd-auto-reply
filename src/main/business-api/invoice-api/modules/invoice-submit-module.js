'use strict';

/**
 * 录入发票提交模块。
 *
 * 这条链路是整个 invoice-api 里最重的一块：
 * - 通过历史抓包识别"录入发票"提交接口（multipart vs json）；
 * - 必要时把发票文件上传到 https://file.pinduoduo.com/general_file，
 *   遍历多种 fileFieldName / signature 字段名兜底；
 * - 调 /orderinvoice/eInvoice/parseInvoice 校验并回填发票号 / 抬头；
 * - 最后按识别到的 mode（multipart 或 json）落到具体提交接口。
 *
 * 整个过程对 client 仅有三类依赖：
 * - _request / _requestForm / _getSession（基类提供）
 * - _getApiTrafficEntries / _getCookieString / _getTokenInfo / _getShopInfo
 * - _normalizeBusinessError
 * 因此独立成模块只需注入 client，不重复任何 cookie / Referer 处理。
 */

const fs = require('fs');
const path = require('path');
const { getDefaultInvoiceSubmitConfig } = require('../../invoice-submit-config');
const { normalizePddUserAgent } = require('../../../pdd-request-profile');
const { sleep } = require('../parsers/invoice-parsers');

class InvoiceSubmitModule {
  constructor(client, options = {}) {
    this.client = client;
    this._getSubmitConfig = typeof options.getSubmitConfig === 'function' ? options.getSubmitConfig : (() => null);
    this._setSubmitConfig = typeof options.setSubmitConfig === 'function' ? options.setSubmitConfig : (() => {});
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
    const list = this.client._getApiTrafficEntries();
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
    let submitConfig = defaultConfig || this._getSubmitConfig() || null;
    if (!submitConfig) {
      submitConfig = this._discoverSubmitConfigFromTraffic();
      if (submitConfig) {
        this._setSubmitConfig(submitConfig);
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

    const payload = await this.client._requestForm(submitConfig.method || 'POST', submitConfig.urlPath, formData);
    return payload?.result ?? payload ?? { ok: true };
  }

  async _uploadInvoiceFile(buffer, fileName, mimeType = 'application/octet-stream') {
    const client = this.client;
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
      const cookie = await client._getCookieString();
      const tokenInfo = client._getTokenInfo();
      const shop = client._getShopInfo();
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
          response = await client._getSession().fetch(uploadUrl, {
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
        const businessError = client._normalizeBusinessError(payload);
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
        const payload = await this.client._request('POST', '/galerie/business/get_signature', {
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
        const payload = await this.client._request('POST', '/orderinvoice/eInvoice/parseInvoice', {
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

    const payload = await this.client._request(method, urlPath, body);
    return payload?.result ?? payload ?? { ok: true };
  }
}

module.exports = { InvoiceSubmitModule };
