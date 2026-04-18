'use strict';

// 改价（updateOrderPrice）业务模块。包含：模板查询/记忆、用于自动捕获 crawlerInfo
// 的页面侧脚本（约 800 行内嵌 JS，必须按字节保留）、以及 updateOrderPrice 主流程。
// 内嵌 JS 通过 PddApiClient 提供的 _executeInPddPage 在隐藏 BrowserWindow 中执行。

const PDD_BASE = 'https://mms.pinduoduo.com';

class OrderPriceModule {
  constructor(client) {
    this.client = client;
  }

  getLatestUpdateTemplate(orderSn = '') {
    const client = this.client;
    const normalizedOrderSn = String(orderSn || '').trim();
    const latestTrafficTemplate = client._findLatestTrafficEntry((entry) => {
      if (!String(entry?.url || '').includes('/latitude/order/price/update')) return false;
      if (!normalizedOrderSn) return true;
      const body = client._safeParseJson(entry?.requestBody);
      const targetOrderSn = String(body?.order_sn || body?.orderSn || '').trim();
      return targetOrderSn === normalizedOrderSn;
    }) || client._findLatestTraffic('/latitude/order/price/update');
    if (latestTrafficTemplate) {
      return latestTrafficTemplate;
    }
    const persistedTemplate = client._getOrderPriceUpdateTemplate();
    if (!persistedTemplate || typeof persistedTemplate !== 'object') {
      return null;
    }
    const persistedBody = client._safeParseJson(persistedTemplate?.requestBody);
    if (!persistedBody || typeof persistedBody !== 'object') {
      return null;
    }
    return {
      url: persistedTemplate.url || `${PDD_BASE}/latitude/order/price/update`,
      method: persistedTemplate.method || 'POST',
      requestBody: JSON.stringify(persistedBody),
    };
  }

  rememberUpdateTemplate(entry = {}, options = {}) {
    const client = this.client;
    if (!entry || typeof entry !== 'object') return null;
    const parsedBody = typeof entry.requestBody === 'string'
      ? client._safeParseJson(entry.requestBody)
      : entry.requestBody;
    if (!parsedBody || typeof parsedBody !== 'object') return null;
    const crawlerInfo = String(parsedBody?.crawlerInfo || parsedBody?.crawler_info || '').trim();
    if (!crawlerInfo) return null;
    const normalized = {
      url: entry.url || `${PDD_BASE}/latitude/order/price/update`,
      method: String(entry.method || 'POST').toUpperCase(),
      requestBody: JSON.stringify(parsedBody),
    };
    client._appendBootstrapTraffic({
      ...normalized,
      timestamp: Date.now(),
    });
    if (options.persist !== false && typeof client._setOrderPriceUpdateTemplate === 'function') {
      try {
        client._setOrderPriceUpdateTemplate({
          ...normalized,
          updatedAt: Date.now(),
        });
      } catch (error) {
        client._log('[API] 持久化改价模板失败', { message: error?.message || String(error || '') });
      }
    }
    return normalized;
  }

  summarizeBootstrapDebug(debug = {}) {
    if (!debug || typeof debug !== 'object') return '';
    const buttonText = (Array.isArray(debug.buttons) ? debug.buttons : [])
      .map(item => String(item?.text || '').trim())
      .filter(Boolean)
      .slice(0, 5)
      .join('/');
    const cardActionText = (Array.isArray(debug.cardActions) ? debug.cardActions : [])
      .map(item => {
        const text = String(item?.text || '').trim();
        const score = Number(item?.score || 0) || 0;
        const tag = String(item?.tag || '').trim();
        const cls = String(item?.cls || '').trim().replace(/\s+/g, '.');
        const left = Number(item?.left || 0) || 0;
        const top = Number(item?.top || 0) || 0;
        const suffix = [tag, cls ? cls.slice(0, 24) : '', left && top ? `${left},${top}` : '']
          .filter(Boolean)
          .join('@');
        return text ? `${text}:${score}${suffix ? `:${suffix}` : ''}` : '';
      })
      .filter(Boolean)
      .slice(0, 5)
      .join('/');
    const inputText = (Array.isArray(debug.inputs) ? debug.inputs : [])
      .map(item => {
        const placeholder = String(item?.placeholder || '').trim();
        const value = String(item?.value || '').trim();
        return placeholder || value;
      })
      .filter(Boolean)
      .slice(0, 3)
      .join('/');
    const actionGroupText = (Array.isArray(debug.actionGroup) ? debug.actionGroup : [])
      .map(item => {
        const text = String(item?.text || '').trim();
        const tag = String(item?.tag || '').trim();
        const cls = String(item?.cls || '').trim().replace(/\s+/g, '.');
        return text ? `${text}:${tag}${cls ? `@${cls.slice(0, 18)}` : ''}` : '';
      })
      .filter(Boolean)
      .slice(0, 6)
      .join('/');
    const panelText = String(debug?.panelText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return [
      cardActionText ? `cardActions=${cardActionText}` : '',
      actionGroupText ? `actionGroup=${actionGroupText}` : '',
      buttonText ? `buttons=${buttonText}` : '',
      inputText ? `inputs=${inputText}` : '',
      panelText ? `panel=${panelText}` : '',
    ].filter(Boolean).join('; ');
  }

  async bootstrapTemplate(params = {}, sessionMeta = {}) {
    const client = this.client;
    if (typeof client._executeInPddPage !== 'function') {
      return { success: false, error: '当前环境不支持页面侧自动初始化改价模板' };
    }
    const target = {
      orderSn: String(params?.orderSn || params?.order_sn || '').trim(),
      customerName: String(sessionMeta?.customerName || sessionMeta?.raw?.nick || sessionMeta?.raw?.nickname || '').trim(),
      customerId: String(sessionMeta?.customerId || sessionMeta?.raw?.customer_id || sessionMeta?.raw?.buyer_id || '').trim(),
      discount: String(params?.discount ?? '').trim(),
      timeoutMs: 6000,
    };
    if (!target.orderSn) {
      return { success: false, error: '缺少订单编号' };
    }
    let result = null;
    try {
      result = await client._executeInPddPage(`
        (async () => {
          const target = ${JSON.stringify(target)};
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          const logs = [];
          const pushLog = (message) => logs.push(String(message || ''));
          const normalizeText = value => String(value || '').replace(/\\s+/g, ' ').trim();
          const isVisible = el => {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8 && el.offsetParent !== null;
          };
          const getText = el => normalizeText(el?.innerText || el?.textContent || '');
          const clickElement = async (el) => {
            if (!isVisible(el)) return false;
            try {
              el.scrollIntoView({ block: 'center', inline: 'center' });
            } catch {}
            ['mousedown', 'mouseup', 'click'].forEach(type => {
              try {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
              } catch {}
            });
            try { el.click(); } catch {}
            await sleep(280);
            return true;
          };
          const fillInputValue = (input, value) => {
            if (!input) return false;
            const nextValue = String(value || '');
            try { input.focus(); } catch {}
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, nextValue);
            else input.value = nextValue;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
            return true;
          };
          const findClickableByTexts = (root, texts = []) => {
            const candidates = Array.from((root || document).querySelectorAll('button, [role="button"], a, span, div'));
            return candidates.find(el => {
              if (!isVisible(el)) return false;
              const text = getText(el);
              if (!text || text.length > 80) return false;
              return texts.some(label => text === label || text.includes(label));
            }) || null;
          };
          const findBestActionByTexts = (root, texts = [], options = {}) => {
            const candidates = Array.from((root || document).querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                const text = getText(el);
                const classText = String(el.className || '').toLowerCase();
                let score = 0;
                if (!text || text.length > 80) return null;
                for (const label of texts) {
                  if (!label) continue;
                  if (text === label) score += 20;
                  else if (text.includes(label)) score += 10;
                }
                if (options.preferShortText && text.length <= 8) score += 5;
                if (options.rejectLongText && text.length > 16) score -= 12;
                if (options.preferRight && rect.left >= window.innerWidth * 0.55) score += 4;
                if (rect.width >= 24 && rect.width <= 260) score += 4;
                if (rect.height >= 18 && rect.height <= 72) score += 4;
                if (rect.width > 320 || rect.height > 120) score -= 12;
                if (classText.includes('active') || classText.includes('selected')) score += 2;
                if (classText.includes('disabled')) score -= 20;
                if (options.preferTop && rect.top <= window.innerHeight * 0.45) score += 3;
                if (options.preferBottom && rect.top >= window.innerHeight * 0.45) score += 3;
                return score > 0 ? { el, score } : null;
              })
              .filter(Boolean)
              .sort((a, b) => b.score - a.score);
            return candidates[0]?.el || null;
          };
          const isPriceEditorVisible = (root) => {
            const scope = root || document.body || document.documentElement;
            const text = getText(scope);
            const hitCount = [
              /手工改价/.test(text),
              /配送费用/.test(text),
              /仅可对订单进行一次改价操作/.test(text),
              /优惠折扣/.test(text),
              /保存/.test(text) && /取消/.test(text),
            ].filter(Boolean).length;
            return hitCount >= 2;
          };
          const findPendingTabTrigger = (panel) => (
            findBestActionByTexts(panel, ['待支付', '待付款', '店铺待支付', '店铺待支付订单'], {
              preferRight: true,
              preferTop: true,
              preferShortText: true,
              rejectLongText: true,
            }) || findClickableByTexts(panel, ['待支付', '待付款', '店铺待支付', '店铺待支付订单'])
          );
          const getCardActionCandidates = (orderCard) => {
            if (!orderCard) return null;
            const cardRect = orderCard.getBoundingClientRect();
            const rawCandidates = Array.from(orderCard.querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                const text = getText(el);
                const classText = String(el.className || '').toLowerCase();
                const roleText = String(el.getAttribute?.('role') || '').toLowerCase();
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const isNativeInteractive = ['button', 'a'].includes(String(el.tagName || '').toLowerCase()) || roleText === 'button';
                const looksInteractive = isNativeInteractive
                  || typeof el.onclick === 'function'
                  || Number(el.tabIndex) >= 0
                  || /button|btn|action|operate|click/.test(classText)
                  || style?.cursor === 'pointer';
                let score = 0;
                if (!looksInteractive) return null;
                if (rect.width < 18 || rect.height < 18) return null;
                if (rect.width > 120 || rect.height > 60) score -= 10;
                if (!text) score -= 2;
                if (/order-btn-item/.test(classText)) score += 12;
                if (/el-tooltip/.test(classText)) score += 4;
                if (rect.left >= cardRect.left + cardRect.width * 0.6) score += 8;
                if (rect.top >= cardRect.top + cardRect.height * 0.55) score += 8;
                if (text && text.length <= 8) score += 4;
                if (/改价|修改价格|手工改价/.test(text)) score += 20;
                if (/备注|物流|地址|复制|查看/.test(text)) score -= 10;
                if (/待支付|待付款|未支付/.test(text)) score -= 14;
                if (/订单号|下单时间|待支付说明|商家未启用服务或不满足服务规则/.test(text)) score -= 20;
                if (/配送费|优惠|折|实收|待支付金额/.test(text)) score -= 18;
                if (/^¥?\d+(?:\.\d+)?$/.test(text)) score -= 25;
                if (/^\d{2}:\d{2}:\d{2}$/.test(text)) score -= 20;
                return score > 0 ? {
                  el,
                  score,
                  text,
                  tag: String(el.tagName || '').toLowerCase(),
                  cls: classText,
                  left: Math.round(rect.left || 0),
                  top: Math.round(rect.top || 0),
                } : null;
              }).filter(Boolean);
            const groupedCandidates = [];
            for (const item of rawCandidates) {
              if (!/order-btn-item/.test(String(item?.cls || ''))) continue;
              const parent = item.el?.parentElement;
              if (!parent) continue;
              const siblings = Array.from(parent.children)
                .filter(el => el !== item.el && isVisible(el))
                .filter(el => /order-btn-item/.test(String(el.className || '').toLowerCase()))
                .map(el => {
                  const rect = el.getBoundingClientRect();
                  const text = getText(el);
                  const classText = String(el.className || '').toLowerCase();
                  let score = 10;
                  if (/改价|修改价格|手工改价/.test(text)) score += 20;
                  if (/待支付|待付款|未支付/.test(text)) score -= 14;
                  if (/备注|物流|地址|复制|查看/.test(text)) score -= 8;
                  if (!text) score -= 4;
                  return score > 0 ? {
                    el,
                    score,
                    text,
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: classText,
                    left: Math.round(rect.left || 0),
                    top: Math.round(rect.top || 0),
                  } : null;
                })
                .filter(Boolean);
              groupedCandidates.push(...siblings);
              const parentRect = parent.getBoundingClientRect();
              const rowNeighbors = Array.from((parent.parentElement || orderCard).querySelectorAll('button, [role="button"], a, span, div'))
                .filter(el => el !== item.el && el !== parent && isVisible(el))
                .map(el => {
                  const rect = el.getBoundingClientRect();
                  const text = getText(el);
                  const classText = String(el.className || '').toLowerCase();
                  const roleText = String(el.getAttribute?.('role') || '').toLowerCase();
                  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                  const looksInteractive = ['button', 'a'].includes(String(el.tagName || '').toLowerCase())
                    || roleText === 'button'
                    || typeof el.onclick === 'function'
                    || Number(el.tabIndex) >= 0
                    || /button|btn|action|operate|click|icon/.test(classText)
                    || style?.cursor === 'pointer';
                  let score = 0;
                  if (!looksInteractive) return null;
                  if (Math.abs(rect.top - parentRect.top) > 24) return null;
                  if (rect.left < cardRect.left + cardRect.width * 0.45) return null;
                  if (rect.width < 14 || rect.height < 14) return null;
                  if (rect.width > 80 || rect.height > 48) return null;
                  score += 10;
                  if (!text) score += 6;
                  if (text && text.length <= 6) score += 4;
                  if (/icon|svg|tooltip|btn/.test(classText)) score += 6;
                  if (/改价|修改价格|手工改价/.test(text)) score += 20;
                  if (/待支付|待付款|未支付/.test(text)) score -= 18;
                  if (/备注|物流|地址|复制|查看/.test(text)) score -= 10;
                  return score > 0 ? {
                    el,
                    score,
                    text,
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: classText,
                    left: Math.round(rect.left || 0),
                    top: Math.round(rect.top || 0),
                  } : null;
                })
                .filter(Boolean);
              groupedCandidates.push(...rowNeighbors);
            }
            const deduped = [];
            const seen = new Set();
            for (const item of [...groupedCandidates, ...rawCandidates]) {
              const key = String(item.left) + ':' + String(item.top) + ':' + String(item.text) + ':' + String(item.cls);
              if (seen.has(key)) continue;
              seen.add(key);
              deduped.push(item);
            }
            const candidates = deduped.sort((a, b) => b.score - a.score);
            return candidates;
          };
          const hoverOrderCard = async (orderCard) => {
            if (!isVisible(orderCard)) return false;
            const rect = orderCard.getBoundingClientRect();
            const points = [
              { x: rect.left + rect.width * 0.85, y: rect.top + rect.height * 0.78 },
              { x: rect.left + rect.width * 0.72, y: rect.top + rect.height * 0.78 },
            ];
            for (const point of points) {
              ['mouseenter', 'mouseover', 'mousemove'].forEach(type => {
                try {
                  orderCard.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: Math.round(point.x),
                    clientY: Math.round(point.y),
                  }));
                } catch {}
              });
              await sleep(120);
            }
            return true;
          };
          const probeOrderCardBody = async (orderCard) => {
            if (!isVisible(orderCard)) return false;
            const rect = orderCard.getBoundingClientRect();
            const clickableNodes = Array.from(orderCard.querySelectorAll('img, [class*="thumb"], [class*="title"], [class*="content"], [class*="main"], div, span'))
              .filter(isVisible)
              .map(el => {
                const nodeRect = el.getBoundingClientRect();
                const text = getText(el);
                let score = 0;
                if (nodeRect.width < 24 || nodeRect.height < 18) return null;
                if (nodeRect.width > rect.width * 0.92 || nodeRect.height > rect.height * 0.92) score -= 8;
                if (nodeRect.left <= rect.left + rect.width * 0.82) score += 6;
                if (nodeRect.top <= rect.top + rect.height * 0.82) score += 4;
                if (/thumb|title|content|main|goods|item/.test(String(el.className || '').toLowerCase())) score += 8;
                if (String(el.tagName || '').toLowerCase() === 'img') score += 10;
                if (text && text.length >= 2 && text.length <= 80) score += 2;
                if (/订单号|下单时间|待支付说明|备注|复制/.test(text)) score -= 10;
                return score > 0 ? { el, score } : null;
              })
              .filter(Boolean)
              .sort((a, b) => b.score - a.score)
              .slice(0, 4);
            const fallbackPoints = [
              { x: rect.left + rect.width * 0.3, y: rect.top + rect.height * 0.35 },
              { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.45 },
            ];
            for (const candidate of clickableNodes) {
              pushLog('probe-card-body');
              await clickElement(candidate.el);
              await sleep(320);
              if (isPriceEditorVisible(findRightPanel()) || findDiscountInput(findRightPanel()) || findDiscountInput(document.body)) {
                return true;
              }
            }
            for (const point of fallbackPoints) {
              ['mousedown', 'mouseup', 'click'].forEach(type => {
                try {
                  orderCard.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: Math.round(point.x),
                    clientY: Math.round(point.y),
                  }));
                } catch {}
              });
              await sleep(320);
              if (isPriceEditorVisible(findRightPanel()) || findDiscountInput(findRightPanel()) || findDiscountInput(document.body)) {
                return true;
              }
            }
            return false;
          };
          const findCardActionFallback = (orderCard) => {
            const candidates = getCardActionCandidates(orderCard);
            return candidates?.[0]?.el || null;
          };
          const findEditTrigger = (orderCard, panel) => (
            findBestActionByTexts(orderCard, ['改价', '修改价格', '手工改价'], {
              preferRight: true,
              preferBottom: true,
              preferShortText: true,
              rejectLongText: true,
            })
            || findBestActionByTexts(panel, ['改价', '修改价格', '手工改价'], {
              preferRight: true,
              preferBottom: true,
              preferShortText: true,
              rejectLongText: true,
            })
            || findClickableByTexts(orderCard, ['改价', '修改价格', '手工改价'])
            || findClickableByTexts(panel, ['改价', '修改价格', '手工改价'])
            || findCardActionFallback(orderCard)
          );
          const findRightSideClickableByTexts = (texts = []) => {
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                return {
                  el,
                  rect,
                  text: getText(el),
                };
              })
              .filter(item => item.text && item.text.length <= 80)
              .filter(item => texts.some(label => item.text === label || item.text.includes(label)))
              .filter(item => item.rect.left >= window.innerWidth * 0.58 && item.rect.width >= 24 && item.rect.height >= 20)
              .sort((a, b) => {
                const scoreA = a.rect.left + Math.min(a.rect.width, 240) - Math.abs(a.rect.top - window.innerHeight * 0.78);
                const scoreB = b.rect.left + Math.min(b.rect.width, 240) - Math.abs(b.rect.top - window.innerHeight * 0.78);
                return scoreB - scoreA;
              });
            return candidates[0]?.el || null;
          };
          const maybeClickConversation = async () => {
            const keywords = [target.orderSn, target.customerName, target.customerId].filter(Boolean);
            if (!keywords.length) return false;
            const nodes = Array.from(document.querySelectorAll('div, li, section, article, a, button'));
            const candidate = nodes.find(el => {
              if (!isVisible(el)) return false;
              const rect = el.getBoundingClientRect();
              if (rect.left > window.innerWidth * 0.42 || rect.width < 120 || rect.height < 28) return false;
              const text = getText(el);
              if (!text || text.length > 320) return false;
              return keywords.some(keyword => keyword && text.includes(keyword));
            });
            if (!candidate) return false;
            pushLog('click-conversation');
            await clickElement(candidate);
            await sleep(600);
            return true;
          };
          const findRightPanel = () => {
            const containers = Array.from(document.querySelectorAll(
              '.right-panel, .order-panel, .customer-info, [class*="right-panel"], [class*="orderInfo"], [class*="goodsInfo"], [class*="order-panel"], [class*="customer-info"], [class*="sidebar"]'
            )).filter(isVisible);
            return containers.sort((a, b) => {
              const rectA = a.getBoundingClientRect();
              const rectB = b.getBoundingClientRect();
              return (rectB.left + rectB.width) - (rectA.left + rectA.width);
            })[0] || null;
          };
          const findOrderCard = (root) => {
            const base = root || document;
            const baseRect = root?.getBoundingClientRect?.() || {
              left: 0,
              top: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            };
            const nodes = Array.from(base.querySelectorAll('div, li, section, article')).filter(isVisible);
            const candidates = nodes.map(el => {
              const text = getText(el);
              if (!text || text.length < 20 || text.length > 900) return null;
              if (!text.includes(target.orderSn)) return null;
              const rect = el.getBoundingClientRect();
              if (rect.width < 180 || rect.height < 60) return null;
              if (rect.width > Math.max(520, baseRect.width * 0.96)) return null;
              if (rect.height > Math.max(420, baseRect.height * 0.92)) return null;
              let score = 0;
              score += 20;
              if (rect.left >= window.innerWidth * 0.58) score += 8;
              if (rect.width >= 220 && rect.width <= 420) score += 8;
              if (rect.height >= 90 && rect.height <= 280) score += 8;
              if (/订单编号|下单时间|待支付|商家未启用服务或不满足服务规则/.test(text)) score += 6;
              if (/¥\d+(\.\d+)?/.test(text)) score += 4;
              if (/备注|改价|配送费|手工改价/.test(text)) score += 4;
              const area = rect.width * rect.height;
              score -= Math.round(area / 40000);
              return score > 0 ? { el, score, area, rect, text } : null;
            }).filter(Boolean);
            const narrowed = candidates.filter(candidate => !candidates.some(other => {
              if (!other || other === candidate) return false;
              if (other.area >= candidate.area) return false;
              if (!candidate.el.contains(other.el)) return false;
              if (!String(other.text || '').includes(target.orderSn)) return false;
              return other.area <= candidate.area * 0.88;
            })).sort((a, b) => {
              if (a.area !== b.area) return a.area - b.area;
              return b.score - a.score;
            });
            const ranked = (narrowed.length ? narrowed : candidates).sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return a.area - b.area;
            });
            return ranked[0]?.el || null;
          };
          const findDiscountInput = (root) => {
            const inputs = Array.from((root || document).querySelectorAll('input')).filter(el => isVisible(el) && !el.disabled && !el.readOnly);
            const scored = inputs.map(input => {
              const wrapperText = getText(input.parentElement) + ' ' + getText(input.closest('div, section, form, article'));
              const placeholderText = String(input.placeholder || '').trim();
              const valueText = String(input.value || '').trim();
              let score = 0;
              if (/查找|搜索|用户名|订单号|客户名|买家名|筛选/i.test(placeholderText + ' ' + wrapperText)) score -= 20;
              if (/折|折扣|discount/i.test(wrapperText)) score += 5;
              if (/实收|配送费用|手工改价|优惠|减价|改价/i.test(wrapperText)) score += 4;
              if (placeholderText.includes('折')) score += 4;
              if (/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(valueText)) score += 1;
              return { input, score };
            })
              .filter(item => item.score >= 4)
              .sort((a, b) => b.score - a.score);
            return scored[0]?.input || null;
          };
          const findSaveButtonNearInput = (input) => {
            let scope = input;
            for (let depth = 0; depth < 6 && scope; depth += 1) {
              const found = findClickableByTexts(scope, ['保存', '确认', '确定']);
              if (found) return found;
              scope = scope.parentElement;
            }
            return null;
          };
          const isCancelLikeButton = (el) => {
            const text = getText(el);
            if (/取消|关闭|返回|收起/.test(text)) return true;
            const classText = String(el?.className || '').toLowerCase();
            return /default|secondary|ghost/.test(classText);
          };
          const findPrimaryActionButton = (root, input) => {
            const inputRect = input?.getBoundingClientRect?.() || null;
            const candidates = Array.from((root || document).querySelectorAll('button, [role="button"], a'))
              .filter(isVisible)
              .map(el => {
                const rect = el.getBoundingClientRect();
                const text = getText(el);
                const classText = String(el.className || '').toLowerCase();
                let score = 0;
                if (/保存|确认|确定/.test(text)) score += 12;
                if (/primary|submit|confirm/.test(classText)) score += 8;
                if (/disabled/.test(classText) || el.disabled) score -= 20;
                if (isCancelLikeButton(el)) score -= 12;
                if (rect.left >= window.innerWidth * 0.58) score += 4;
                if (inputRect) {
                  const horizontalGap = Math.abs(rect.left - inputRect.left);
                  const verticalGap = Math.abs(rect.top - inputRect.bottom);
                  if (horizontalGap < 220) score += 5;
                  if (verticalGap < 220) score += 5;
                  if (rect.top >= inputRect.top - 40) score += 2;
                }
                return { el, rect, text, score };
              })
              .filter(item => item.score > 0)
              .sort((a, b) => b.score - a.score);
            return candidates[0]?.el || null;
          };
          const summarizeElement = (el) => {
            if (!el) return null;
            const rect = typeof el.getBoundingClientRect === 'function'
              ? el.getBoundingClientRect()
              : { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: String(el.tagName || '').toLowerCase(),
              text: getText(el).slice(0, 80),
              cls: String(el.className || '').slice(0, 120),
              left: Math.round(rect.left || 0),
              top: Math.round(rect.top || 0),
              width: Math.round(rect.width || 0),
              height: Math.round(rect.height || 0),
            };
          };
          const collectDebugSnapshot = (panel, input) => {
            const root = panel || document.body || document.documentElement;
            const panelText = getText(root).slice(0, 300);
            const visibleButtons = Array.from((root || document).querySelectorAll('button, [role="button"], a, span, div'))
              .filter(isVisible)
              .filter(el => {
                const text = getText(el);
                const rect = el.getBoundingClientRect();
                return text && text.length <= 40 && rect.width <= 260 && rect.height <= 80;
              })
              .map(el => summarizeElement(el))
              .filter(Boolean)
              .slice(0, 12);
            const card = findOrderCard(root);
            const cardActions = (getCardActionCandidates(card) || [])
              .slice(0, 6)
              .map(item => ({
                text: String(item?.text || '').slice(0, 40),
                score: item?.score || 0,
                tag: String(item?.tag || ''),
                cls: String(item?.cls || '').slice(0, 40),
                left: item?.left || 0,
                top: item?.top || 0,
              }));
            const anchorAction = (getCardActionCandidates(card) || []).find(item => /order-btn-item/.test(String(item?.cls || '')));
            const actionGroup = anchorAction?.el?.parentElement
              ? Array.from(anchorAction.el.parentElement.children)
                .filter(isVisible)
                .map(el => {
                  const rect = el.getBoundingClientRect();
                  return {
                    text: getText(el).slice(0, 40),
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: String(el.className || '').slice(0, 40),
                    left: Math.round(rect.left || 0),
                    top: Math.round(rect.top || 0),
                    width: Math.round(rect.width || 0),
                    height: Math.round(rect.height || 0),
                  };
                })
                .slice(0, 10)
              : [];
            const allInputs = Array.from(document.querySelectorAll('input'))
              .filter(isVisible)
              .map(el => {
                const summary = summarizeElement(el) || {};
                return {
                  ...summary,
                  value: String(el.value || '').slice(0, 40),
                  placeholder: String(el.placeholder || '').slice(0, 40),
                };
              })
              .slice(0, 8);
            return {
              panelText,
              activeElement: summarizeElement(document.activeElement),
              input: summarizeElement(input),
              buttons: visibleButtons,
              cardActions,
              actionGroup,
              inputs: allInputs,
            };
          };
          const tryProbeCardActions = async (orderCard, panel) => {
            const candidates = (getCardActionCandidates(orderCard) || []).slice(0, 4);
            for (const candidate of candidates) {
              if (!candidate?.el) continue;
              pushLog('probe-card-action:' + String(candidate.text || ''));
              await clickElement(candidate.el);
              await sleep(450);
              const latestPanel = findRightPanel() || panel;
              if (isPriceEditorVisible(latestPanel) || findDiscountInput(latestPanel) || findDiscountInput(document.body)) {
                return true;
              }
            }
            return false;
          };
          const createInterceptor = () => {
            let settled = false;
            let timer = 0;
            let resolvePromise = () => {};
            const cleanupTasks = [];
            const finalize = (payload) => {
              if (settled) return payload;
              settled = true;
              if (timer) clearTimeout(timer);
              cleanupTasks.reverse().forEach(task => {
                try { task(); } catch {}
              });
              resolvePromise(payload);
              return payload;
            };
            const promise = new Promise(resolve => {
              resolvePromise = resolve;
            });
            if (typeof window.fetch === 'function') {
              const originalFetch = window.fetch.bind(window);
              window.fetch = async function patchedFetch(input, init) {
                const requestUrl = typeof input === 'string' ? input : (input?.url || '');
                if (String(requestUrl || '').includes('/latitude/order/price/update')) {
                  const requestBody = typeof init?.body === 'string' ? init.body : '';
                  pushLog('capture-fetch');
                  finalize({
                    ok: true,
                    channel: 'fetch',
                    url: requestUrl,
                    method: String(init?.method || 'POST').toUpperCase(),
                    requestBody,
                    logs,
                  });
                  return new Response(JSON.stringify({ success: true, result: {} }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  });
                }
                return originalFetch(input, init);
              };
              cleanupTasks.push(() => { window.fetch = originalFetch; });
            }
            if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
              const proto = window.XMLHttpRequest.prototype;
              const originalOpen = proto.open;
              const originalSend = proto.send;
              proto.open = function patchedOpen(method, url) {
                this.__pddHelperUrl = url;
                this.__pddHelperMethod = method;
                return originalOpen.apply(this, arguments);
              };
              proto.send = function patchedSend(body) {
                if (String(this.__pddHelperUrl || '').includes('/latitude/order/price/update')) {
                  const requestBody = typeof body === 'string' ? body : '';
                  pushLog('capture-xhr');
                  try {
                    Object.defineProperty(this, 'readyState', { configurable: true, value: 4 });
                    Object.defineProperty(this, 'status', { configurable: true, value: 200 });
                    Object.defineProperty(this, 'statusText', { configurable: true, value: 'OK' });
                    Object.defineProperty(this, 'responseText', { configurable: true, value: '{"success":true,"result":{}}' });
                    Object.defineProperty(this, 'response', { configurable: true, value: '{"success":true,"result":{}}' });
                  } catch {}
                  setTimeout(() => {
                    try { this.onreadystatechange && this.onreadystatechange(new Event('readystatechange')); } catch {}
                    try { this.onload && this.onload(new Event('load')); } catch {}
                    try { this.dispatchEvent(new Event('readystatechange')); } catch {}
                    try { this.dispatchEvent(new Event('load')); } catch {}
                    try { this.dispatchEvent(new Event('loadend')); } catch {}
                  }, 0);
                  return finalize({
                    ok: true,
                    channel: 'xhr',
                    url: this.__pddHelperUrl,
                    method: String(this.__pddHelperMethod || 'POST').toUpperCase(),
                    requestBody,
                    logs,
                  });
                }
                return originalSend.apply(this, arguments);
              };
              cleanupTasks.push(() => {
                proto.open = originalOpen;
                proto.send = originalSend;
              });
            }
            timer = window.setTimeout(() => finalize({
              ok: false,
              error: 'capture-timeout',
              logs,
            }), Number(target.timeoutMs || 6000));
            return {
              promise,
              abort(error, extra = {}) {
                return finalize({
                  ok: false,
                  error,
                  logs,
                  ...extra,
                });
              },
            };
          };

          const interceptor = createInterceptor();
          try {
            await maybeClickConversation();
            let panel = findRightPanel();
            if (!panel) {
              await sleep(500);
              panel = findRightPanel();
            }
            if (!panel) return interceptor.abort('panel-not-found', {
              debug: collectDebugSnapshot(null, null),
            });
            const pendingTab = findPendingTabTrigger(panel);
            if (pendingTab) {
              pushLog('click-pending-tab');
              await clickElement(pendingTab);
              await sleep(700);
              panel = findRightPanel() || panel;
            }
            const orderCard = findOrderCard(panel) || findOrderCard(document.body);
            if (!orderCard) return interceptor.abort('order-card-not-found', {
              debug: collectDebugSnapshot(panel, null),
            });
            await hoverOrderCard(orderCard);
            await sleep(180);
            await probeOrderCardBody(orderCard);
            panel = findRightPanel() || panel;
            const editTrigger = findEditTrigger(orderCard, panel);
            if (editTrigger) {
              pushLog('click-edit-trigger');
              await clickElement(editTrigger);
              await sleep(700);
              panel = findRightPanel() || panel;
            }
            const editorVisible = isPriceEditorVisible(panel) || isPriceEditorVisible(document.body);
            if (!editorVisible && !findDiscountInput(panel) && !findDiscountInput(document.body)) {
              const probed = await tryProbeCardActions(orderCard, panel);
              if (probed) {
                panel = findRightPanel() || panel;
              }
            }
            if (!isPriceEditorVisible(panel) && !isPriceEditorVisible(document.body) && !findDiscountInput(panel) && !findDiscountInput(document.body)) {
              return interceptor.abort(editTrigger ? 'edit-mode-not-entered' : 'edit-trigger-not-found', {
                debug: collectDebugSnapshot(panel, null),
              });
            }
            if (!editTrigger && !findDiscountInput(panel) && !findDiscountInput(document.body)) {
              return interceptor.abort('edit-trigger-not-found', {
                debug: collectDebugSnapshot(panel, null),
              });
            }
            const discountInput = findDiscountInput(panel) || findDiscountInput(document.body);
            if (!discountInput) return interceptor.abort('discount-input-not-found', {
              debug: collectDebugSnapshot(panel, null),
            });
            fillInputValue(discountInput, target.discount || '9.9');
            await sleep(250);
            panel = findRightPanel() || panel;
            let saveButton = findSaveButtonNearInput(discountInput);
            if (!saveButton) {
              saveButton = findClickableByTexts(panel, ['保存', '确认', '确定'])
                || findPrimaryActionButton(panel, discountInput)
                || findRightSideClickableByTexts(['保存', '确认', '确定'])
                || findPrimaryActionButton(document.body, discountInput)
                || findClickableByTexts(document.body, ['保存', '确认', '确定']);
            }
            if (!saveButton) {
              await sleep(500);
              panel = findRightPanel() || panel;
              const refreshedDiscountInput = findDiscountInput(panel) || discountInput;
              saveButton = findSaveButtonNearInput(refreshedDiscountInput)
                || findClickableByTexts(panel, ['保存', '确认', '确定'])
                || findPrimaryActionButton(panel, refreshedDiscountInput)
                || findRightSideClickableByTexts(['保存', '确认', '确定'])
                || findPrimaryActionButton(document.body, refreshedDiscountInput)
                || findClickableByTexts(document.body, ['保存', '确认', '确定']);
            }
            if (!saveButton) return interceptor.abort('save-button-not-found', {
              debug: collectDebugSnapshot(panel, discountInput),
            });
            pushLog('click-save-button');
            await clickElement(saveButton);
            return await interceptor.promise;
          } catch (error) {
            return interceptor.abort(error?.message || String(error || 'bootstrap-failed'));
          }
        })()
      `, { source: 'order-price:template-bootstrap' });
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error || '页面改价模板自动初始化失败'),
      };
    }
    const parsedBody = client._safeParseJson(result?.requestBody);
    const crawlerInfo = String(parsedBody?.crawlerInfo || parsedBody?.crawler_info || '').trim();
    if (!crawlerInfo) {
      const debugSummary = this.summarizeBootstrapDebug(result?.debug);
      client._log('[API] 页面侧自动初始化改价模板失败', {
        orderSn: target.orderSn,
        error: result?.error || 'missing-crawler-info',
        logs: Array.isArray(result?.logs) ? result.logs.slice(-8) : [],
        debug: result?.debug || null,
      });
      return {
        success: false,
        error: [
          result?.error || '未捕获到改价校验参数',
          debugSummary,
        ].filter(Boolean).join(' | '),
      };
    }
    const remembered = this.rememberUpdateTemplate({
      url: result?.url || `${PDD_BASE}/latitude/order/price/update`,
      method: result?.method || 'POST',
      requestBody: JSON.stringify(parsedBody),
    });
    client._log('[API] 页面侧自动初始化改价模板成功', {
      orderSn: target.orderSn,
      channel: result?.channel || '',
      persisted: !!remembered,
    });
    return {
      success: true,
      crawlerInfo,
      requestBody: parsedBody,
    };
  }

  async updateOrderPrice(params = {}) {
    const client = this.client;
    const normalizedOrderSn = String(params?.orderSn || params?.order_sn || '').trim();
    if (!normalizedOrderSn) {
      throw new Error('缺少订单编号');
    }
    const sessionMeta = client._normalizeSessionMeta(params.session || params.sessionId || {});
    const templateEntry = this.getLatestUpdateTemplate(normalizedOrderSn);
    const templateBody = client._safeParseJson(templateEntry?.requestBody) || {};
    const uid = Number(params?.uid || templateBody?.uid || client._getRefundOrderUid(sessionMeta) || 0);
    if (!Number.isFinite(uid) || uid <= 0) {
      throw new Error('缺少消费者 UID，请先在嵌入网页中打开对应会话后重试');
    }
    const discount = Number(params?.discount);
    if (!Number.isFinite(discount) || discount < 1 || discount > 10) {
      throw new Error('您仅可对订单进行一次改价操作，且优惠折扣不能低于1折');
    }
    const originalAmountFen = Number.isFinite(Number(params?.originalAmountFen))
      ? Math.max(0, Math.round(Number(params.originalAmountFen)))
      : client._parseOrderPriceYuanToFen(params?.originalAmount);
    if (!originalAmountFen) {
      throw new Error('缺少原始实收金额');
    }
    const shippingAmountFen = Number.isFinite(Number(params?.shippingAmountFen))
      ? Math.max(0, Math.round(Number(params.shippingAmountFen)))
      : client._parseOrderPriceYuanToFen(params?.shippingFee);
    const goodsReceiveFen = Math.max(0, Math.ceil(originalAmountFen * (discount / 10)));
    const goodsDiscountFen = Math.max(0, originalAmountFen - goodsReceiveFen);
    const receiveAmountFen = goodsReceiveFen + shippingAmountFen;
    const requestBody = {
      uid,
      order_sn: normalizedOrderSn,
      goodsDiscount: String(goodsDiscountFen),
      shippingDiscount: String(0),
      receiveAmount: String(receiveAmountFen),
      shippingAmount: shippingAmountFen,
      crawlerInfo: String(params?.crawlerInfo || templateBody?.crawlerInfo || templateBody?.crawler_info || '').trim(),
    };
    if (!requestBody.crawlerInfo) {
      const bootstrapResult = await this.bootstrapTemplate({
        ...params,
        orderSn: normalizedOrderSn,
      }, sessionMeta);
      const bootstrappedCrawlerInfo = String(
        bootstrapResult?.crawlerInfo
        || bootstrapResult?.requestBody?.crawlerInfo
        || bootstrapResult?.requestBody?.crawler_info
        || ''
      ).trim();
      if (bootstrappedCrawlerInfo) {
        requestBody.crawlerInfo = bootstrappedCrawlerInfo;
      } else {
        throw new Error(
          bootstrapResult?.error
            ? `缺少改价校验参数，且自动初始化失败：${bootstrapResult.error}`
            : '缺少改价校验参数，且自动初始化失败'
        );
      }
    }
    const payload = await client._requestRefundOrderPageApi('/latitude/order/price/update', requestBody);
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message || '改价失败');
    }
    let verifiedOrder = null;
    const normalizedTab = String(params?.tab || 'pending').trim() || 'pending';
    try {
      const latestOrders = await client._extractRefundOrdersFromPageApis(sessionMeta);
      verifiedOrder = (Array.isArray(latestOrders) ? latestOrders : []).find(item => {
        const currentOrderSn = String(item?.orderSn || item?.order_id || item?.order_sn || item?.orderId || '').trim();
        return currentOrderSn === normalizedOrderSn;
      }) || null;
    } catch (error) {
      client._log('[API] 改价后订单回读失败', {
        orderSn: normalizedOrderSn,
        message: error.message,
      });
    }
    return {
      success: true,
      orderSn: normalizedOrderSn,
      uid,
      discount,
      originalAmount: originalAmountFen / 100,
      discountAmount: goodsDiscountFen / 100,
      receiveAmount: receiveAmountFen / 100,
      shippingFee: shippingAmountFen / 100,
      verifiedOrder: client._cloneJson(verifiedOrder),
      verifiedCard: verifiedOrder ? client._normalizeSideOrderCard(verifiedOrder, {}, normalizedTab, 0) : null,
      response: payload,
    };
  }
}

module.exports = { OrderPriceModule };
