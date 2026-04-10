(function () {
  let initialized = false;
  let mailApiEntries = [];
  let mailApiOverview = null;
  let mailApiList = [];
  let mailApiActiveType = -1;
  let mailApiActiveMessageId = '';
  let mailApiActiveDetail = null;
  let mailApiKeyword = '';
  let mailApiUnreadOnly = false;

  function getEl(id) {
    return document.getElementById(id);
  }

  function getMailTrafficType(entry) {
    const text = `${entry?.fullUrl || entry?.url || ''} ${entry?.requestBody || ''}`.toLowerCase();
    if (text.includes('/mailbox/overview')) return '统计概览';
    if (text.includes('/mailbox/list')) return '站内信列表';
    if (text.includes('/mailbox/detail')) return '站内信详情';
    if (text.includes('/other/mail/')) return '页面入口';
    return '';
  }

  function isMailTrafficEntry(entry) {
    return !!getMailTrafficType(entry);
  }

  function resetMailApiState() {
    mailApiOverview = null;
    mailApiList = [];
    mailApiEntries = [];
    mailApiActiveMessageId = '';
    mailApiActiveDetail = null;
    mailApiUnreadOnly = false;
    const unreadOnlyToggle = getEl('mailApiUnreadOnly');
    if (unreadOnlyToggle) unreadOnlyToggle.checked = false;
    renderMailApiOverview();
    renderMailApiCategories();
    renderMailApiList();
    renderMailApiDetail();
    renderMailApiTraffic();
  }

  function sanitizeMailHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html || ''}</div>`, 'text/html');
    doc.querySelectorAll('script,style,iframe,object,embed').forEach(element => element.remove());
    doc.querySelectorAll('a').forEach(element => {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    });
    doc.querySelectorAll('img').forEach(element => {
      element.setAttribute('loading', 'lazy');
    });
    return doc.body.innerHTML;
  }

  function getMailVisibleList() {
    const keyword = mailApiKeyword.trim().toLowerCase();
    return mailApiList.filter(item => {
      if (mailApiUnreadOnly && item.readStatus !== 0) return false;
      if (!keyword) return true;
      const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
      return text.includes(keyword);
    });
  }

  function renderMailApiOverview() {
    getEl('mailApiTotalNum').textContent = mailApiOverview ? String(mailApiOverview.totalNum || 0) : '-';
    getEl('mailApiUnreadNum').textContent = mailApiOverview ? String(mailApiOverview.unreadNum || 0) : '-';
    getEl('mailApiMsgBoxCount').textContent = mailApiOverview ? String(mailApiOverview.msgBoxCount || 0) : '-';
    getEl('mailApiNormalTotal').textContent = mailApiOverview ? String(mailApiOverview.normalTotal || 0) : '-';
  }

  function renderMailApiCategories() {
    const container = getEl('mailApiCategoryList');
    const categories = mailApiOverview?.categories || [];
    if (!categories.length) {
      container.innerHTML = '<div class="mail-api-list-empty">暂无分类数据</div>';
      return;
    }
    if (!categories.some(item => Number(item.contentType) === Number(mailApiActiveType))) {
      mailApiActiveType = Number(categories[0].contentType);
    }
    container.innerHTML = categories.map(item => `
      <div class="mail-api-category-item ${Number(item.contentType) === Number(mailApiActiveType) ? 'active' : ''}" data-mail-type="${item.contentType}">
        <div class="mail-api-category-name">
          <span class="mail-api-category-dot"></span>
          <span>${esc(item.label)}</span>
        </div>
        <div class="mail-api-category-badge">${esc(String(item.unreadCount || 0))}</div>
      </div>
    `).join('');
    container.querySelectorAll('[data-mail-type]').forEach(item => {
      item.addEventListener('click', async () => {
        const nextType = Number(item.dataset.mailType);
        if (nextType === mailApiActiveType) return;
        mailApiActiveType = nextType;
        mailApiActiveMessageId = '';
        mailApiActiveDetail = null;
        renderMailApiCategories();
        renderMailApiDetail();
        await loadMailApiList();
      });
    });
  }

  function renderMailApiList() {
    const container = getEl('mailApiList');
    const visibleList = getMailVisibleList();
    const activeCategory = (mailApiOverview?.categories || []).find(item => Number(item.contentType) === Number(mailApiActiveType));
    getEl('mailApiListTitle').textContent = activeCategory ? activeCategory.label : '站内信列表';
    getEl('mailApiListMeta').textContent = `${visibleList.length} / ${mailApiList.length} 条消息`;
    getEl('mailApiListStatus').textContent = activeCategory
      ? `当前分类：${activeCategory.label}${mailApiUnreadOnly ? ' · 仅未读' : ''}`
      : '当前分类：-';
    if (!visibleList.length) {
      container.innerHTML = '<div class="mail-api-list-empty">当前分类暂无消息，或没有匹配到搜索结果。</div>';
      return;
    }
    container.innerHTML = visibleList.map(item => `
      <div class="mail-api-list-item ${String(item.messageId) === String(mailApiActiveMessageId) ? 'active' : ''}" data-message-id="${esc(item.messageId)}">
        <div class="mail-api-list-marker ${item.readStatus === 0 ? 'unread' : ''}"></div>
        <div>
          <div class="mail-api-list-item-header">
            <div class="mail-api-list-item-title">${esc(item.title || '未命名站内信')}</div>
            <div class="mail-api-list-item-time">${esc(formatApiListTime(item.sendTime))}</div>
          </div>
          <div class="mail-api-list-item-summary">${esc(item.summary || '暂无摘要')}</div>
          <div class="mail-api-list-item-footer">
            <span class="mail-api-tag">${esc(item.contentTypeName || '未知分类')}</span>
            ${Number(item.attachmentCount || 0) > 0 ? `<span class="mail-api-tag">附件 ${esc(String(item.attachmentCount))}</span>` : ''}
            ${item.readStatus === 0 ? '<span class="mail-api-tag unread">未读</span>' : ''}
          </div>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-message-id]').forEach(item => {
      item.addEventListener('click', async () => {
        await openMailApiDetail(item.dataset.messageId);
      });
    });
  }

  function renderMailApiDetail() {
    const head = getEl('mailApiDetailHead');
    const panel = getEl('mailApiDetailPanel');
    if (!mailApiActiveDetail?.messageId) {
      head.innerHTML = `
        <div class="mail-api-detail-title">请选择一条站内信</div>
        <div class="mail-api-detail-meta"><span>分类：-</span><span>时间：-</span></div>
      `;
      panel.innerHTML = '<div class="mail-api-detail-empty">请选择一条站内信查看详情</div>';
      getEl('mailApiDetailMeta').textContent = '点击左侧列表打开详情';
      return;
    }
    const attachments = Array.isArray(mailApiActiveDetail.attachmentList) ? mailApiActiveDetail.attachmentList : [];
    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(mailApiActiveDetail.title || '未命名站内信')}</div>
      <div class="mail-api-detail-meta">
        <span>分类：${esc(mailApiActiveDetail.contentTypeName || '-')}</span>
        <span>时间：${esc(formatApiTime(mailApiActiveDetail.sendTime))}</span>
        <span>消息ID：${esc(mailApiActiveDetail.messageId || '-')}</span>
        <span>附件：${esc(String(attachments.length))}</span>
      </div>
    `;
    panel.innerHTML = `
      <div class="mail-api-detail-content">${sanitizeMailHtml(mailApiActiveDetail.contentHtml || `<p>${esc(mailApiActiveDetail.contentText || '暂无正文')}</p>`)}</div>
      ${attachments.length ? `<div class="mail-api-detail-actions">${attachments.map((item, index) => `<span class="mail-api-tag">附件 ${index + 1}</span>`).join('')}</div>` : ''}
    `;
    getEl('mailApiDetailMeta').textContent = `已打开详情：${mailApiActiveDetail.messageId}`;
  }

  function renderMailApiTraffic() {
    const container = getEl('mailApiTrafficList');
    getEl('mailApiTrafficSummary').textContent = `${mailApiEntries.length} 条抓包记录`;
    if (!mailApiEntries.length) {
      container.innerHTML = '<span class="mail-api-traffic-chip">暂无抓包</span>';
      return;
    }
    container.innerHTML = mailApiEntries.slice(0, 8).map(entry => {
      const typeTag = getMailTrafficType(entry);
      const summary = `${typeTag} · ${entry.method || 'GET'} ${entry.url}`;
      return `<span class="mail-api-traffic-chip" title="${esc(summary)}">${esc(summary)}</span>`;
    }).join('');
  }

  async function loadMailApiTraffic(shopId = activeShopId) {
    if (!shopId) {
      mailApiEntries = [];
      renderMailApiTraffic();
      return;
    }
    const list = await window.pddApi.getApiTraffic({ shopId });
    mailApiEntries = Array.isArray(list) ? list.slice().reverse().filter(isMailTrafficEntry) : [];
    renderMailApiTraffic();
  }

  async function loadMailApiOverview(shopId = activeShopId) {
    const result = await window.pddApi.mailGetOverview({ shopId });
    if (!result || result.error) {
      mailApiOverview = null;
      renderMailApiOverview();
      renderMailApiCategories();
      getEl('mailApiHeaderMeta').textContent = result?.error || '加载站内信统计失败';
      return false;
    }
    mailApiOverview = result;
    renderMailApiOverview();
    renderMailApiCategories();
    getEl('mailApiHeaderMeta').textContent = `共 ${result.totalNum || 0} 条，未读 ${result.unreadNum || 0} 条`;
    return true;
  }

  async function openMailApiDetail(messageId, options = {}) {
    if (!messageId || !activeShopId) return;
    mailApiActiveMessageId = String(messageId);
    renderMailApiList();
    const result = await window.pddApi.mailGetDetail({ shopId: activeShopId, messageId });
    if (!result || result.error) {
      mailApiActiveDetail = null;
      renderMailApiDetail();
      addLog(result?.error || '加载站内信详情失败', 'error');
      return;
    }
    mailApiActiveDetail = result;
    renderMailApiDetail();
    if (!options.skipTraffic) {
      await loadMailApiTraffic();
    }
  }

  async function loadMailApiList(options = {}) {
    if (!activeShopId) {
      mailApiList = [];
      mailApiActiveMessageId = '';
      mailApiActiveDetail = null;
      renderMailApiList();
      renderMailApiDetail();
      return false;
    }
    const result = await window.pddApi.mailGetList({
      shopId: activeShopId,
      contentType: mailApiActiveType,
      pageNum: 1,
      size: 40
    });
    if (!result || result.error) {
      mailApiList = [];
      mailApiActiveMessageId = '';
      mailApiActiveDetail = null;
      renderMailApiList();
      renderMailApiDetail();
      addLog(result?.error || '加载站内信列表失败', 'error');
      return false;
    }
    mailApiList = Array.isArray(result.list) ? result.list : [];
    renderMailApiList();
    const visibleList = getMailVisibleList();
    const keepCurrent = options.keepCurrent && visibleList.some(item => String(item.messageId) === String(mailApiActiveMessageId));
    if (keepCurrent && mailApiActiveMessageId) {
      await openMailApiDetail(mailApiActiveMessageId, { skipTraffic: true });
    } else if (visibleList[0]?.messageId) {
      await openMailApiDetail(visibleList[0].messageId, { skipTraffic: true });
    } else {
      mailApiActiveMessageId = '';
      mailApiActiveDetail = null;
      renderMailApiDetail();
    }
    return true;
  }

  async function syncMailSelectionAfterFilter() {
    renderMailApiList();
    const visibleList = getMailVisibleList();
    if (mailApiActiveMessageId && visibleList.some(item => String(item.messageId) === String(mailApiActiveMessageId))) {
      return;
    }
    if (visibleList[0]?.messageId) {
      await openMailApiDetail(visibleList[0].messageId, { skipTraffic: true });
      return;
    }
    mailApiActiveMessageId = '';
    mailApiActiveDetail = null;
    renderMailApiDetail();
  }

  async function loadMailApiView(options = {}) {
    await refreshShopContext();
    const shopId = activeShopId;
    if (!shopId) {
      getEl('mailApiHeaderMeta').textContent = '当前没有活跃店铺';
      resetMailApiState();
      return;
    }
    await loadMailApiOverview(shopId);
    await loadMailApiList({ keepCurrent: options.keepCurrent });
    await loadMailApiTraffic(shopId);
  }

  function bindMailApiModule() {
    if (initialized) return;
    initialized = true;

    getEl('btnMailApiOpenDebug')?.addEventListener('click', async () => {
      const result = await window.pddApi.openDebugWindow();
      if (result?.error) addLog(`打开调试面板失败: ${result.error}`, 'error');
    });
    getEl('btnMailApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnMailApiRefreshList')?.addEventListener('click', async () => {
      await loadMailApiOverview();
      await loadMailApiList({ keepCurrent: true });
      await loadMailApiTraffic();
      addLog('已刷新站内信列表', 'info');
    });
    getEl('btnMailApiRefreshDetail')?.addEventListener('click', async () => {
      if (!mailApiActiveMessageId) {
        addLog('请先选择一条站内信', 'info');
        return;
      }
      await openMailApiDetail(mailApiActiveMessageId);
      addLog('已刷新当前站内信详情', 'info');
    });
    getEl('btnMailApiReloadTraffic')?.addEventListener('click', async () => {
      await loadMailApiTraffic();
      addLog('已刷新站内信抓包记录', 'info');
    });
    getEl('btnMailApiClearTraffic')?.addEventListener('click', async () => {
      const shopId = activeShopId || API_ALL_SHOPS;
      await window.pddApi.clearApiTraffic({ shopId });
      await loadMailApiTraffic();
      addLog('已清空当前范围的抓包记录', 'info');
    });
    getEl('btnMailApiBackToMail')?.addEventListener('click', () => switchView('mail'));
    getEl('mailApiKeyword')?.addEventListener('input', async event => {
      mailApiKeyword = event.target.value || '';
      await syncMailSelectionAfterFilter();
    });
    getEl('mailApiUnreadOnly')?.addEventListener('change', async event => {
      mailApiUnreadOnly = !!event.target.checked;
      await syncMailSelectionAfterFilter();
    });
    getEl('btnMailApiPrev')?.addEventListener('click', async () => {
      const visibleList = getMailVisibleList();
      const index = visibleList.findIndex(item => String(item.messageId) === String(mailApiActiveMessageId));
      if (index <= 0) {
        addLog('已经是第一条站内信', 'info');
        return;
      }
      await openMailApiDetail(visibleList[index - 1].messageId);
    });
    getEl('btnMailApiNext')?.addEventListener('click', async () => {
      const visibleList = getMailVisibleList();
      const index = visibleList.findIndex(item => String(item.messageId) === String(mailApiActiveMessageId));
      if (index < 0 || index >= visibleList.length - 1) {
        addLog('已经是最后一条站内信', 'info');
        return;
      }
      await openMailApiDetail(visibleList[index + 1].messageId);
    });
  }

  window.loadMailApiView = loadMailApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('mail-api-module', bindMailApiModule);
  } else {
    bindMailApiModule();
  }
})();
