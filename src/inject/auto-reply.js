(function() {
  'use strict';
  if (window.__PDD_AUTO_REPLY_INJECTED__) return;
  window.__PDD_AUTO_REPLY_INJECTED__ = true;

  // ---- 选择器集中管理 ----
  const SELECTORS = {
    middlePanel: '.middle-panel',
    messageArea: [
      '.middle-panel .content',
      '.middle-panel .chat-content',
      '.middle-panel .msg-list',
      '.middle-panel .message-list'
    ],
    inputBox: [
      '.middle-panel [contenteditable="true"]',
      '.middle-panel textarea',
      '[contenteditable="true"]',
      'textarea'
    ],
    sendButtonScope: '.middle-panel',
    sendButtonText: '发送',
    buyerClassHints: ['buyer', 'customer', 'left', 'other', 'receive', 'recv'],
    sellerClassHints: ['seller', 'service', 'right', 'self', 'send', 'mine', 'own'],
    leftPanel: [
      '.left-panel',
      '[class*="left-panel"]',
      '[class*="leftPanel"]'
    ],
    unreadIndicators: [
      '[class*="unread"]', '[class*="Unread"]',
      '[class*="badge"]', '[class*="Badge"]',
      '[class*="new-msg"]', '[class*="newMsg"]',
      '[class*="red-dot"]', '[class*="redDot"]'
    ]
  };

  let autoReplyEnabled = false;
  const processedTexts = new Set();
  let observer = null;
  let retryTimer = null;
  let sessionObserver = null;
  let sessionCheckTimer = null;
  let lastSessionSelectTime = 0;
  let lastUserActionSignature = '';
  let lastUserActionTime = 0;

  // ---- DOM 查找 ----

  function queryFirst(selectors, parent) {
    const root = parent || document;
    if (typeof selectors === 'string') return root.querySelector(selectors);
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findMessageArea() {
    return queryFirst(SELECTORS.messageArea);
  }

  function findInputBox() {
    for (const sel of SELECTORS.inputBox) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function findSendButton() {
    const scope = document.querySelector(SELECTORS.sendButtonScope) || document;
    for (const el of scope.querySelectorAll('button, [role="button"]')) {
      if (el.textContent.trim() === SELECTORS.sendButtonText && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  function buildNodeSelector(node) {
    if (!node || node.nodeType !== 1) return '';
    const parts = [];
    let current = node;
    for (let depth = 0; depth < 4 && current && current.nodeType === 1; depth++) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const classNames = String(current.className || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      if (classNames.length) {
        part += `.${classNames.join('.')}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function buildActionPayload(node, extra = {}) {
    if (!node || node.nodeType !== 1) return null;
    const text = (node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const ariaLabel = node.getAttribute?.('aria-label') || '';
    const title = node.getAttribute?.('title') || '';
    const href = node.getAttribute?.('href') || '';
    const payload = {
      actionType: extra.actionType || 'click',
      timestamp: Date.now(),
      pageUrl: location.href,
      targetText: text || ariaLabel || title || '',
      targetTag: node.tagName?.toLowerCase() || '',
      targetRole: node.getAttribute?.('role') || '',
      targetHref: href || '',
      targetSelector: buildNodeSelector(node),
      x: Number.isFinite(extra.x) ? extra.x : undefined,
      y: Number.isFinite(extra.y) ? extra.y : undefined,
      messagePreview: extra.messagePreview || '',
      source: extra.source || 'embedded-page',
    };
    return payload;
  }

  function reportUserAction(node, extra = {}) {
    const payload = buildActionPayload(node, extra);
    if (!payload) return;
    const signature = [
      payload.actionType,
      payload.targetText,
      payload.targetTag,
      payload.targetSelector,
      payload.pageUrl,
    ].join('|');
    const now = Date.now();
    if (signature === lastUserActionSignature && now - lastUserActionTime < 800) return;
    lastUserActionSignature = signature;
    lastUserActionTime = now;
    window.postMessage({
      type: 'PDD_USER_ACTION',
      ...payload,
    }, '*');
  }

  // ---- 会话列表操作 ----

  function findLeftPanel() {
    for (const sel of SELECTORS.leftPanel) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 50) return el;
    }
    // 兜底：通过"今日接待"文本定位会话列表所在的面板
    var panels = document.querySelectorAll('div, aside, section, nav');
    for (var i = 0; i < panels.length; i++) {
      var el = panels[i];
      var rect = el.getBoundingClientRect();
      if (rect.left > 50 || rect.width < 100 || rect.width > 500 || rect.height < 300) continue;
      if (el.textContent && el.textContent.indexOf('今日接待') !== -1) return el;
    }
    return null;
  }

  function hasActiveConversation() {
    if (findInputBox()) return true;
    // 输入框可能被弹窗遮挡导致 offsetParent 为 null，兜底检查中间面板是否有实际内容
    const mid = document.querySelector(SELECTORS.middlePanel);
    if (!mid) return false;
    const area = findMessageArea();
    if (area && area.children.length > 0) return true;
    // 检查中间面板是否有 contenteditable（即使被遮挡）
    const ce = mid.querySelector('[contenteditable]');
    if (ce) return true;
    return false;
  }

  function findUnreadSessionItem(panel) {
    for (const sel of SELECTORS.unreadIndicators) {
      const indicators = panel.querySelectorAll(sel);
      for (const ind of indicators) {
        if (ind.offsetParent === null) continue;
        const indRect = ind.getBoundingClientRect();
        if (indRect.width === 0 && indRect.height === 0) continue;
        // 向上查找会话条目容器（高度 40~150px，宽度 > 150px 的元素）
        let item = ind.parentElement;
        for (let i = 0; i < 8 && item && item !== panel; i++) {
          const r = item.getBoundingClientRect();
          if (r.height >= 40 && r.height <= 150 && r.width >= 150) return item;
          item = item.parentElement;
        }
      }
    }
    return null;
  }

  function findFirstSessionItem(panel) {
    // 策略1：通过超时/等待提示文本定位待回复会话（最可靠）
    var urgencyHints = ['已超时', '已等待', '秒后超时', '分后超时', '分钟后超时'];
    var allEls = panel.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var text = (allEls[i].textContent || '').trim();
      if (text.length > 200) continue;
      var hasHint = false;
      for (var h = 0; h < urgencyHints.length; h++) {
        if (text.indexOf(urgencyHints[h]) !== -1) { hasHint = true; break; }
      }
      if (!hasHint) continue;
      var item = allEls[i];
      for (var d = 0; d < 10 && item && item !== panel; d++) {
        var r = item.getBoundingClientRect();
        if (r.height >= 40 && r.height <= 150 && r.width >= 150) return item;
        item = item.parentElement;
      }
    }
    // 策略2：通过位置和视觉特征定位
    const items = panel.querySelectorAll('div, li, a');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.height < 40 || rect.height > 150 || rect.width < 150) continue;
      if (rect.top < 120) continue;
      if (item.offsetParent === null) continue;
      const text = (item.textContent || '').trim();
      if (text.length < 2 || text.length > 300) continue;
      if (item.querySelector('img, [class*="avatar"], [class*="Avatar"]') || text.length > 5) {
        return item;
      }
    }
    return null;
  }

  function doSelectSession() {
    const panel = findLeftPanel();
    if (!panel) {
      console.log('[PDD助手] 未找到左侧会话面板');
      return false;
    }
    const item = findUnreadSessionItem(panel) || findFirstSessionItem(panel);
    if (!item) {
      console.log('[PDD助手] 未找到可选择的会话条目');
      return false;
    }
    console.log('[PDD助手] 自动选择会话');
    item.click();
    lastSessionSelectTime = Date.now();
    setTimeout(startObserving, 1500);
    return true;
  }

  // ---- 消息角色判断 ----

  function classifyMessage(node) {
    let el = node;
    for (let depth = 0; depth < 8 && el; depth++) {
      const cls = (el.className || '').toString().toLowerCase();
      if (SELECTORS.sellerClassHints.some(h => cls.includes(h))) return 'seller';
      if (SELECTORS.buyerClassHints.some(h => cls.includes(h))) return 'buyer';
      el = el.parentElement;
    }
    return 'unknown';
  }

  function extractText(node) {
    const text = (node.textContent || '').trim();
    if (!text || text.length < 1 || text.length > 500) return null;
    if (/^(发送|转接|关闭|标记|备注|订单号?|商品|评价|物流)$/.test(text)) return null;
    if (/^https?:\/\//.test(text)) return null;
    return text;
  }

  // ---- 消息检测 ----

  function dedup(text) {
    const key = text.slice(0, 100);
    if (processedTexts.has(key)) return false;
    processedTexts.add(key);
    if (processedTexts.size > 300) {
      const arr = [...processedTexts];
      processedTexts.clear();
      arr.slice(-150).forEach(k => processedTexts.add(k));
    }
    return true;
  }

  function onMutations(mutations) {
    if (!autoReplyEnabled) return;

    // 自动选择会话后短暂跳过，避免历史消息批量加载时误触发回复
    if (lastSessionSelectTime && Date.now() - lastSessionSelectTime < 2000) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;

        const role = classifyMessage(node);
        if (role === 'seller') continue;

        const text = extractText(node);
        if (!text || !dedup(text)) continue;

        console.log(`[PDD助手] DOM 检测到消息: "${text.slice(0, 50)}" role=${role}`);

        window.postMessage({
          type: 'PDD_NEW_MESSAGE',
          message: text,
          customer: '客户',
          conversationId: Date.now().toString(),
          source: 'embedded-dom'
        }, '*');
      }
    }
  }

  // ---- 消息发送 ----

  function fillInput(input, message) {
    input.focus();

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, message);
      else input.value = message;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.textContent = message;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: message }));
    }
  }

  function sendReply(message, meta, retryCount) {
    if (typeof meta === 'number') {
      retryCount = meta;
      meta = {};
    }
    meta = meta || {};
    retryCount = retryCount || 0;
    const input = findInputBox();
    if (!input) {
      if (retryCount >= 3) {
        console.warn('[PDD助手] 多次重试后仍未找到输入框，放弃发送');
        return false;
      }
      console.log('[PDD助手] 未找到输入框，尝试选择会话... (重试 ' + (retryCount + 1) + '/3)');
      doSelectSession();
      setTimeout(function() { sendReply(message, meta, retryCount + 1); }, 1500);
      return true;
    }

    fillInput(input, message);

    // 等待 React/框架响应输入后再定位发送按钮
    setTimeout(() => {
      const btn = findSendButton();
      if (!btn) {
        console.warn('[PDD助手] 未找到发送按钮');
        return;
      }
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        console.warn('[PDD助手] 发送按钮尺寸为 0');
        return;
      }
      window.postMessage({
        type: 'PDD_CLICK_SEND',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        messagePreview: String(message || '').slice(0, 80),
        conversationId: meta.conversationId || '',
        source: meta.source || 'embedded-dom-auto-reply'
      }, '*');
      reportUserAction(btn, {
        actionType: 'auto-send-click',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        messagePreview: String(message || '').slice(0, 80),
        source: meta.source || 'embedded-dom-auto-reply',
      });
      console.log(`[PDD助手] 已填入回复并请求点击发送`);
    }, 200);

    return true;
  }

  // ---- 与 preload 通信 ----

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'PDD_AUTO_REPLY_TOGGLE') {
      autoReplyEnabled = event.data.enabled;
      console.log(`[PDD助手] 自动回复: ${autoReplyEnabled ? '开启' : '关闭'}`);
    }
    if (event.data?.type === 'PDD_SEND_REPLY' && event.data.message) {
      sendReply(event.data.message, event.data);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button, a, [role="button"], input, label, [data-testid], [data-track], [class*="button"], [class*="tab"], [class*="menu"]');
    if (!target) return;
    reportUserAction(target, {
      actionType: 'click',
      x: Number.isFinite(event.clientX) ? Math.round(event.clientX) : undefined,
      y: Number.isFinite(event.clientY) ? Math.round(event.clientY) : undefined,
    });
  }, true);

  // ---- 启动 MutationObserver ----

  function startObserving() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    const area = findMessageArea();
    if (!area) {
      retryTimer = setTimeout(startObserving, 3000);
      return;
    }

    if (observer) observer.disconnect();
    observer = new MutationObserver(onMutations);
    observer.observe(area, { childList: true, subtree: true });
    console.log('[PDD助手] 消息监听已启动');
  }

  // ---- 会话列表监控：自动选择未读会话 ----

  function startSessionObserving() {
    const panel = findLeftPanel();
    if (!panel) {
      setTimeout(startSessionObserving, 5000);
      return;
    }

    if (sessionObserver) sessionObserver.disconnect();
    sessionObserver = new MutationObserver(function() {
      if (!autoReplyEnabled) return;
      if (lastSessionSelectTime && Date.now() - lastSessionSelectTime < 15000) return;
      if (hasActiveConversation()) return;
      doSelectSession();
    });
    sessionObserver.observe(panel, { childList: true, subtree: true, attributes: true });
    console.log('[PDD助手] 会话列表监听已启动');

    // 定时兜底检查（MutationObserver 可能遗漏某些变化）
    if (sessionCheckTimer) clearInterval(sessionCheckTimer);
    sessionCheckTimer = setInterval(function() {
      if (!autoReplyEnabled) return;
      if (lastSessionSelectTime && Date.now() - lastSessionSelectTime < 15000) return;
      if (hasActiveConversation()) return;
      doSelectSession();
    }, 3000);
  }

  startObserving();
  startSessionObserving();

  // ---- 调试接口 ----

  window.__PDD_HELPER__ = {
    isEnabled: () => autoReplyEnabled,
    getContainer: findMessageArea,
    findSendButton,
    findInputBox,
    sendReply,
    findLeftPanel,
    hasActiveConversation,
    doSelectSession,
    checkInputBoxHasContent() {
      const input = findInputBox();
      if (!input) return false;
      return (input.value || input.textContent || '').trim().length > 0;
    },
    getStatus() {
      return {
        injected: true,
        enabled: autoReplyEnabled,
        container: !!findMessageArea(),
        inputBox: !!findInputBox(),
        sendButton: !!findSendButton(),
        observing: !!observer,
        leftPanel: !!findLeftPanel(),
        sessionObserving: !!sessionObserver,
        activeConversation: hasActiveConversation(),
        processedCount: processedTexts.size
      };
    }
  };

  console.log('[PDD助手] 注入脚本已加载 ✓');
})();
