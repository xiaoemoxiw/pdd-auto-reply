'use strict';

// 商品卡片模块：负责拉取商品规格、价格、库存等信息并组装成 PddApiClient.getGoodsCard 输出格式。
// 大部分逻辑依赖 PddApiClient 的会话/请求能力（_request / _requestInPddPage / _executeInPddPage 等），
// 因此通过构造函数注入 client 引用；纯解析逻辑直接复用 goods-parsers。

const { BrowserWindow } = require('electron');
const goodsParsers = require('../parsers/goods-parsers');
const {
  DEFAULT_PAGE_CHROME_UA,
  normalizePddUserAgent,
  isChromeLikeUserAgent,
  applySessionPddPageProfile,
} = require('../../pdd-request-profile');

const PDD_BASE = 'https://mms.pinduoduo.com';
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;

class GoodsCardModule {
  constructor(client) {
    this.client = client;
  }

  async loadGoodsHtmlInWindow(url) {
    const client = this.client;
    const shop = client._getShopInfo();
    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: {
        partition: client.partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const goodsPageUserAgent = normalizePddUserAgent(shop?.userAgent || client._getTokenInfo()?.userAgent || '');
    const goodsPageProfile = applySessionPddPageProfile(win.webContents.session, {
      userAgent: isChromeLikeUserAgent(goodsPageUserAgent) ? goodsPageUserAgent : DEFAULT_PAGE_CHROME_UA,
      tokenInfo: client._getTokenInfo(),
      clientHintsProfile: 'page',
    });
    if (goodsPageProfile?.userAgent) {
      win.webContents.setUserAgent(goodsPageProfile.userAgent);
    }
    try {
      await win.loadURL(url);
      for (let i = 0; i < 6; i += 1) {
        await client._sleep(800);
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('/login')) break;
        if (currentUrl.includes('goods.html') || currentUrl.includes('goods2.html') || currentUrl.includes('goods_id=')) {
          await client._sleep(1200);
          break;
        }
      }
      return await win.webContents.executeJavaScript(`(() => ({
        url: location.href,
        title: document.title || '',
        html: document.documentElement ? document.documentElement.outerHTML : ''
      }))()`);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async requestGoodsPageApi(urlPath, body = {}, method = 'GET') {
    const client = this.client;
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const headers = {
      accept: 'application/json, text/plain, */*',
      Referer: CHAT_URL,
      Origin: PDD_BASE,
    };
    if (normalizedMethod !== 'GET') {
      headers['content-type'] = 'application/json;charset=UTF-8';
    }
    if (typeof client._requestInPddPage === 'function') {
      return client._requestInPddPage({
        method: normalizedMethod,
        url: urlPath,
        source: 'goods-page:request',
        headers,
        body: normalizedMethod === 'GET' ? null : JSON.stringify(body || {}),
      });
    }
    if (normalizedMethod === 'GET') {
      return client._request('GET', urlPath, null, headers);
    }
    return client._post(urlPath, body || {}, headers);
  }

  buildGoodsCardFromPageApis(goodsPayload, skuPayload, fallback = {}) {
    const goods = Array.isArray(goodsPayload?.result?.goods)
      ? (goodsPayload.result.goods[0] || {})
      : (goodsPayload?.goods || {});
    const skus = Array.isArray(skuPayload?.skus)
      ? skuPayload.skus
      : (Array.isArray(skuPayload?.result?.skus) ? skuPayload.result.skus : []);
    const specKeys = Array.isArray(skuPayload?.specKeys)
      ? skuPayload.specKeys
      : (Array.isArray(skuPayload?.result?.specKeys) ? skuPayload.result.specKeys : []);
    const specItems = skus.map(item => {
      const specs = Array.isArray(item?.spec) ? item.spec.map(value => String(value || '').trim()).filter(Boolean) : [];
      const priceText = goodsParsers.pickGoodsText([
        goodsParsers.normalizeGoodsPrice(item?.price),
        item?.price,
      ]);
      return {
        specLabel: specs[0] || specKeys[0] || '',
        styleLabel: specs[1] || (specs.length > 1 ? specs.slice(1).join(' / ') : (specKeys[1] || '')),
        priceText,
        stockText: item?.stock !== undefined && item?.stock !== null ? String(item.stock) : '',
        salesText: '',
      };
    }).filter(item => item.specLabel || item.styleLabel || item.priceText || item.stockText);
    const customerNumber = Number(goods?.customerNumber || goods?.customer_number || 0) || 0;
    const quantity = Number(goods?.quantity || goods?.stock || 0) || 0;
    const soldQuantity = Number(goods?.soldQuantity || goods?.sold_quantity || 0) || 0;
    const ungroupedNum = Number(goods?.ungroupedNum || goods?.ungrouped_num || 0) || 0;
    return {
      goodsId: String(goods?.goodsId || goods?.goods_id || fallback.goodsId || ''),
      title: String(goods?.goodsName || goods?.goods_name || fallback.title || '拼多多商品').trim(),
      imageUrl: String(goods?.thumbUrl || goods?.thumb_url || fallback.imageUrl || '').trim(),
      priceText: goodsParsers.normalizeGoodsPrice(goods?.price) || String(fallback.priceText || '').trim(),
      groupText: customerNumber > 0 ? `${customerNumber}人团` : String(fallback.groupText || '2人团').trim(),
      specText: String(fallback.specText || '查看商品规格').trim(),
      stockText: quantity > 0 ? String(quantity) : '',
      salesText: soldQuantity > 0 ? String(soldQuantity) : '',
      pendingGroupText: String(ungroupedNum),
      specItems,
    };
  }

  async extractGoodsSpecFromChatPage(sessionMeta = {}, goodsMeta = {}) {
    const client = this.client;
    if (typeof client._executeInPddPage !== 'function') return null;
    const target = {
      customerName: String(sessionMeta?.customerName || sessionMeta?.raw?.nick || sessionMeta?.raw?.nickname || '').trim(),
      customerId: String(sessionMeta?.customerId || sessionMeta?.raw?.customer_id || sessionMeta?.raw?.buyer_id || '').trim(),
      goodsId: goodsParsers.normalizeGoodsId(goodsMeta?.goodsId || ''),
      goodsTitle: String(goodsMeta?.title || '').trim(),
    };
    if (!target.goodsId && !target.goodsTitle) return null;
    const result = await client._executeInPddPage(`
      (async () => {
        const target = ${JSON.stringify(target)};
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const normalizeText = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = el => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 8 && rect.height > 8 && el.offsetParent !== null;
        };
        const getText = el => normalizeText(el?.innerText || el?.textContent || '');
        const lowerIncludes = (text, keyword) => !!(text && keyword && text.toLowerCase().includes(keyword.toLowerCase()));
        const maybeClickConversation = async () => {
          const keywords = [target.customerName, target.customerId].filter(Boolean);
          if (!keywords.length) return false;
          const nodes = Array.from(document.querySelectorAll('div, li, section, article, a, button'));
          const candidate = nodes.find(el => {
            if (!isVisible(el)) return false;
            const rect = el.getBoundingClientRect();
            if (rect.left > window.innerWidth * 0.42 || rect.width < 120 || rect.height < 28) return false;
            const text = getText(el);
            if (!text || text.length > 300) return false;
            return keywords.some(keyword => text.includes(keyword));
          });
          if (!candidate) return false;
          candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          candidate.click();
          candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          await sleep(600);
          return true;
        };
        const findSpecTrigger = () => {
          const nodes = Array.from(document.querySelectorAll('button, span, div, a')).filter(isVisible);
          const triggers = nodes.filter(el => getText(el) === '查看商品规格');
          if (!triggers.length) return null;
          const scored = triggers.map(el => {
            let container = el;
            for (let i = 0; i < 6 && container?.parentElement; i += 1) {
              container = container.parentElement;
              const text = getText(container);
              if (!text) continue;
              if (target.goodsId && text.includes(target.goodsId)) {
                return { el, score: 100, text };
              }
              if (target.goodsTitle && lowerIncludes(text, target.goodsTitle.slice(0, 12))) {
                return { el, score: 80, text };
              }
            }
            return { el, score: 0, text: '' };
          }).sort((a, b) => b.score - a.score);
          return scored[0]?.el || null;
        };
        const readStat = (text, label) => {
          const match = String(text || '').match(new RegExp(label + '[:：]?\\\\s*([0-9]+)', 'i'));
          return match?.[1] || '';
        };
        const parseModal = () => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .ant-modal, .MDL_root, .PNK_modal, .dialog, .modal'))
            .filter(isVisible)
            .filter(el => getText(el).includes('商品规格'));
          const modal = dialogs[0];
          if (!modal) return null;
          const modalText = getText(modal);
          const goodsIdMatch = modalText.match(/商品ID[:：]?\\s*(\\d{6,})/);
          const titleEl = modal.querySelector('a, h1, h2, h3, h4, strong, [class*="title"], [class*="name"]');
          const imageEl = modal.querySelector('img');
          const rows = [];
          const rowNodes = Array.from(modal.querySelectorAll('tbody tr, table tr')).filter(isVisible);
          rowNodes.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td, th')).map(cell => getText(cell)).filter(Boolean);
            if (cells.length >= 4 && !cells.includes('规格') && !cells.includes('款式')) {
              rows.push({
                specLabel: cells[0] || '',
                styleLabel: cells[1] || '',
                priceText: cells[2] || '',
                stockText: cells[3] || '',
                salesText: cells[4] || '',
              });
            }
          });
          if (!rows.length) {
            const blocks = Array.from(modal.querySelectorAll('div, li')).filter(isVisible);
            blocks.forEach(node => {
              const text = getText(node);
              if (!text || text.length > 200) return;
              if (!(/[¥￥]\\s*\\d/.test(text) && /(库存|销量)/.test(text))) return;
              const segments = text.split(/\\s+/).filter(Boolean);
              rows.push({
                specLabel: segments[0] || '',
                styleLabel: segments[1] || '',
                priceText: segments.find(item => /[¥￥]/.test(item)) || '',
                stockText: readStat(text, '库存'),
                salesText: readStat(text, '销量'),
              });
            });
          }
          return {
            goodsId: goodsIdMatch?.[1] || target.goodsId,
            title: getText(titleEl) || target.goodsTitle,
            imageUrl: imageEl?.src || '',
            stockText: readStat(modalText, '库存'),
            salesText: readStat(modalText, '销量'),
            groupText: readStat(modalText, '待成团'),
            specItems: rows.filter(item => item.specLabel || item.styleLabel || item.priceText || item.stockText || item.salesText),
          };
        };
        await maybeClickConversation();
        const trigger = findSpecTrigger();
        if (!trigger) {
          return { error: 'SPEC_TRIGGER_NOT_FOUND' };
        }
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.click();
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        for (let i = 0; i < 8; i += 1) {
          await sleep(350);
          const parsed = parseModal();
          if (parsed?.specItems?.length) {
            return parsed;
          }
        }
        return parseModal() || { error: 'SPEC_MODAL_NOT_FOUND' };
      })()
    `, { source: 'goods-spec:dom-extract' });
    if (!result || typeof result !== 'object' || result.error) {
      client._log('[API] 聊天页规格提取失败', { goodsId: target.goodsId, reason: result?.error || 'EMPTY_RESULT' });
      return null;
    }
    return {
      goodsId: result.goodsId || target.goodsId,
      title: result.title || target.goodsTitle,
      imageUrl: result.imageUrl || '',
      groupText: result.groupText ? `${result.groupText}件待成团` : '',
      specItems: Array.isArray(result.specItems) ? result.specItems : [],
    };
  }

  async getGoodsCard(params = {}) {
    const client = this.client;
    const inputUrl = String(params.url || '').trim();
    const explicitGoodsId = goodsParsers.normalizeGoodsId(params.goodsId || params?.fallback?.goodsId || '');
    const extractedGoodsId = goodsParsers.normalizeGoodsId(goodsParsers.extractGoodsIdFromUrl(inputUrl));
    const normalizedGoodsId = explicitGoodsId || extractedGoodsId;
    const sessionMeta = client._normalizeSessionMeta(params.session || params.sessionId || {});
    const rawUrl = normalizedGoodsId
      ? `https://mobile.yangkeduo.com/goods.html?goods_id=${normalizedGoodsId}`
      : inputUrl;
    let url = '';
    try {
      url = rawUrl ? new URL(rawUrl).toString() : '';
    } catch {
      url = normalizedGoodsId ? `https://mobile.yangkeduo.com/goods.html?goods_id=${normalizedGoodsId}` : '';
    }
    if (!url) {
      throw new Error('缺少商品链接');
    }
    const fallback = params?.fallback && typeof params.fallback === 'object'
      ? client._cloneJson(params.fallback)
      : {};
    const headers = await client._buildHeaders({
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'content-type': 'text/html;charset=UTF-8',
      Referer: url,
      Origin: 'https://mobile.yangkeduo.com',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'upgrade-insecure-requests': '1',
    });
    delete headers['X-PDD-Token'];
    delete headers['windows-app-shop-token'];
    delete headers.VerifyAuthToken;
    delete headers.etag;
    const fallbackForParse = {
      ...fallback,
      goodsId: fallback.goodsId || normalizedGoodsId || goodsParsers.extractGoodsIdFromUrl(url),
      specText: fallback.specText || '查看商品规格',
    };
    if (normalizedGoodsId) {
      try {
        const [goodsPayload, skuPayload] = await Promise.all([
          this.requestGoodsPageApi('/latitude/goods/queryGoods', {
            pageNo: 1,
            pageSize: 1,
            goodsId: Number(normalizedGoodsId),
          }, 'POST'),
          this.requestGoodsPageApi(`/latitude/goods/skuList?pageNo=1&pageSize=30&goodsId=${encodeURIComponent(normalizedGoodsId)}`, null, 'GET'),
        ]);
        const goodsError = client._normalizeBusinessError(goodsPayload);
        const skuError = client._normalizeBusinessError(skuPayload);
        if (!goodsError && !skuError) {
          const pageCard = this.buildGoodsCardFromPageApis(goodsPayload, skuPayload, fallbackForParse);
          if (pageCard.specItems?.length || goodsParsers.hasMeaningfulGoodsCardData(pageCard, fallbackForParse)) {
            return {
              goodsId: pageCard.goodsId || fallback.goodsId || normalizedGoodsId,
              url,
              title: pageCard.title || fallback.title || '拼多多商品',
              imageUrl: pageCard.imageUrl || fallback.imageUrl || '',
              priceText: pageCard.priceText || fallback.priceText || '',
              groupText: pageCard.groupText || fallback.groupText || '2人团',
              specText: pageCard.specText || fallback.specText || '查看商品规格',
              specItems: Array.isArray(pageCard.specItems) ? pageCard.specItems : [],
              stockText: pageCard.stockText || '',
              salesText: pageCard.salesText || '',
              pendingGroupText: pageCard.pendingGroupText || '',
            };
          }
        }
      } catch (error) {
        client._log('[API] 商品规格页接口失败', { goodsId: normalizedGoodsId, message: error.message });
      }
    }
    let response = null;
    let html = '';
    let fetchError = null;
    try {
      response = await client._getSession().fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
      });
      html = await response.text();
    } catch (error) {
      fetchError = error;
      client._log('[API] 商品卡片直连失败', { url, message: error.message });
    }
    let parsed = goodsParsers.extractGoodsCardFromHtml(html, fallbackForParse);
    if (fetchError || !goodsParsers.hasMeaningfulGoodsCardData(parsed, fallbackForParse) || goodsParsers.isGoodsLoginPageHtml(html)) {
      try {
        const pageResult = await this.loadGoodsHtmlInWindow(url);
        if (pageResult?.html) {
          html = String(pageResult.html || '');
          parsed = goodsParsers.extractGoodsCardFromHtml(html, fallbackForParse);
        }
      } catch (error) {
        client._log('[API] 商品卡片窗口兜底失败', { url, message: error.message });
      }
    }
    if (!parsed.specItems?.length) {
      try {
        const pageSpec = await this.extractGoodsSpecFromChatPage(sessionMeta, {
          goodsId: normalizedGoodsId || fallbackForParse.goodsId,
          title: fallback.title || parsed.title || '',
        });
        if (pageSpec?.specItems?.length) {
          parsed = {
            ...parsed,
            goodsId: parsed.goodsId || pageSpec.goodsId || normalizedGoodsId,
            title: parsed.title || pageSpec.title || fallback.title || '拼多多商品',
            imageUrl: parsed.imageUrl || pageSpec.imageUrl || fallback.imageUrl || '',
            specItems: pageSpec.specItems,
          };
        }
      } catch (error) {
        client._log('[API] 聊天页规格提取异常', { goodsId: normalizedGoodsId || fallbackForParse.goodsId, message: error.message });
      }
    }
    if (!goodsParsers.hasMeaningfulGoodsCardData(parsed, fallbackForParse) && !parsed.specItems?.length) {
      if (fetchError) {
        client._log('[API] 商品卡片回退占位', { url, message: fetchError.message });
      } else if (response && !response.ok) {
        client._log('[API] 商品卡片 HTTP 占位', { url, status: response.status });
      }
      return {
        goodsId: fallback.goodsId || normalizedGoodsId || goodsParsers.extractGoodsIdFromUrl(url),
        url,
        title: fallback.title || '拼多多商品',
        imageUrl: fallback.imageUrl || '',
        priceText: fallback.priceText || '',
        groupText: fallback.groupText || '2人团',
        specText: fallback.specText || '查看商品规格',
        specItems: Array.isArray(fallback.specItems) ? fallback.specItems : [],
        stockText: String(fallback.stockText || ''),
        salesText: String(fallback.salesText || ''),
        pendingGroupText: String(fallback.pendingGroupText || ''),
      };
    }
    if (response && !response.ok && !parsed.title && !parsed.imageUrl) {
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      goodsId: parsed.goodsId || fallback.goodsId || normalizedGoodsId || goodsParsers.extractGoodsIdFromUrl(url),
      url,
      title: parsed.title || fallback.title || '拼多多商品',
      imageUrl: parsed.imageUrl || fallback.imageUrl || '',
      priceText: parsed.priceText || fallback.priceText || '',
      groupText: parsed.groupText || fallback.groupText || '2人团',
      specText: parsed.specText || fallback.specText || '查看商品规格',
      specItems: Array.isArray(parsed.specItems) ? parsed.specItems : [],
      stockText: String(parsed.stockText || fallback.stockText || ''),
      salesText: String(parsed.salesText || fallback.salesText || ''),
      pendingGroupText: String(parsed.pendingGroupText || fallback.pendingGroupText || ''),
    };
  }
}

module.exports = { GoodsCardModule };
