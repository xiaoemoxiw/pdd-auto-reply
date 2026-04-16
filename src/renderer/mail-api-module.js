(function () {
  const MAIL_API_PAGE_SIZE = 20;

  let initialized = false;
  let mailApiOverview = null;
  let mailApiAllList = [];
  let mailApiList = [];
  let mailApiFailures = [];
  let mailApiStatusFilter = 'all';
  let mailApiPageNum = 1;
  let mailApiTotalCount = 0;
  let mailApiSelectedIds = new Set();
  let mailApiKnownMessageIds = new Set();
  let mailApiHasNotificationBaseline = false;

  function getEl(id) {
    return document.getElementById(id);
  }

  function getActiveShopName() {
    const currentShop = Array.isArray(shops)
      ? shops.find(item => String(item?.id || '') === String(activeShopId || ''))
      : null;
    if (currentShop?.name) return currentShop.name;
    return getEl('shopSwitcherName')?.textContent?.trim() || '当前店铺';
  }

  function getMailApiScopeShopId() {
    if (typeof API_ALL_SHOPS !== 'undefined' && API_ALL_SHOPS) return API_ALL_SHOPS;
    return activeShopId;
  }

  function getMailApiScopeLabel() {
    const shopId = getMailApiScopeShopId();
    if (shopId && typeof API_ALL_SHOPS !== 'undefined' && shopId === API_ALL_SHOPS) {
      return '全部已登录店铺';
    }
    return getActiveShopName();
  }

  function isMailApiAllScope() {
    const shopId = getMailApiScopeShopId();
    return !!(shopId && typeof API_ALL_SHOPS !== 'undefined' && shopId === API_ALL_SHOPS);
  }

  function getMailApiPageSlice() {
    const start = Math.max(0, (mailApiPageNum - 1) * MAIL_API_PAGE_SIZE);
    return mailApiAllList.slice(start, start + MAIL_API_PAGE_SIZE);
  }

  function getMailApiReadStatusParam() {
    if (mailApiStatusFilter === 'unread') return 0;
    if (mailApiStatusFilter === 'read') return 1;
    return undefined;
  }

  function getMailApiTotalPages() {
    return Math.max(1, Math.ceil(Number(mailApiTotalCount || 0) / MAIL_API_PAGE_SIZE));
  }

  function clearMailApiSelection() {
    mailApiSelectedIds = new Set();
  }

  function rememberMailApiMessageIds(items = []) {
    (Array.isArray(items) ? items : []).forEach(item => {
      const messageId = String(item?.messageId || '').trim();
      if (messageId) mailApiKnownMessageIds.add(messageId);
    });
    if (mailApiKnownMessageIds.size > 800) {
      const trimmed = Array.from(mailApiKnownMessageIds).slice(-500);
      mailApiKnownMessageIds = new Set(trimmed);
    }
  }

  async function notifyNewMailItems(items = []) {
    const nextItems = (Array.isArray(items) ? items : [])
      .filter(item => Number(item?.readStatus) === 0)
      .filter(item => !mailApiKnownMessageIds.has(String(item?.messageId || '').trim()));
    rememberMailApiMessageIds(items);
    if (!mailApiHasNotificationBaseline) {
      mailApiHasNotificationBaseline = true;
      return;
    }
    if (!nextItems.length || !window.pddApi?.showDesktopNotification) return;
    const title = nextItems.length === 1
      ? '新站内信提醒'
      : `发现 ${nextItems.length} 条新的站内信`;
    const subtitle = nextItems.length === 1
      ? `${String(nextItems[0]?.shopName || getMailApiScopeLabel() || '店铺').trim() || '店铺'} · 站内信`
      : '';
    const body = nextItems.slice(0, 2).map(item => {
      const shopName = String(item?.shopName || '').trim();
      const subject = String(item?.title || '未命名站内信').trim();
      return shopName ? `店铺：${shopName}\n新会话信息：${subject}` : `新会话信息：${subject}`;
    }).join('\n');
    const uniqueKey = `mail-list:${nextItems.map(item => String(item?.messageId || '').trim()).filter(Boolean).join('|')}`;
    try {
      await window.pddApi.showDesktopNotification({
        title,
        subtitle,
        body: body || '请及时查看',
        silent: false,
        uniqueKey,
        cooldownMs: 15000,
        payload: {
          type: 'mail-list',
        },
      });
    } catch {}
  }

  function getMailApiSelectedUnreadCount() {
    return mailApiList.filter(item => (
      mailApiSelectedIds.has(String(item.messageId || ''))
      && Number(item.readStatus) === 0
    )).length;
  }

  function updateMailApiSelectionControls() {
    const selectAll = getEl('mailApiSelectAll');
    const markReadButton = getEl('btnMailApiMarkRead');
    const currentIds = mailApiList.map(item => String(item.messageId || '')).filter(Boolean);
    const checkedCount = currentIds.filter(id => mailApiSelectedIds.has(id)).length;
    if (selectAll) {
      selectAll.checked = currentIds.length > 0 && checkedCount === currentIds.length;
      selectAll.indeterminate = checkedCount > 0 && checkedCount < currentIds.length;
    }
    if (markReadButton) {
      markReadButton.disabled = getMailApiSelectedUnreadCount() === 0;
    }
  }

  function renderMailApiOverview() {
    const totalNum = Number(mailApiOverview?.totalNum || 0);
    const unreadNum = Number(mailApiOverview?.unreadNum || 0);
    const readNum = Math.max(0, totalNum - unreadNum);
    getEl('mailApiAllCount').textContent = String(totalNum);
    getEl('mailApiUnreadCount').textContent = String(unreadNum);
    getEl('mailApiReadCount').textContent = String(readNum);

    const filterMap = {
      all: 'btnMailApiFilterAll',
      unread: 'btnMailApiFilterUnread',
      read: 'btnMailApiFilterRead',
    };
    Object.entries(filterMap).forEach(([key, id]) => {
      getEl(id)?.classList.toggle('active', key === mailApiStatusFilter);
    });
  }

  function renderMailApiPager() {
    const totalPages = getMailApiTotalPages();
    getEl('mailApiPageIndicator').textContent = `${mailApiPageNum} / ${totalPages}`;
    getEl('btnMailApiPrevPage').disabled = mailApiPageNum <= 1;
    getEl('btnMailApiNextPage').disabled = mailApiPageNum >= totalPages;
  }

  function renderMailApiList() {
    const container = getEl('mailApiList');
    const scopeLabel = getMailApiScopeLabel();
    const serialBase = (mailApiPageNum - 1) * MAIL_API_PAGE_SIZE;
    const filterLabelMap = {
      all: '全部',
      unread: '未读',
      read: '已读',
    };
    const failuresCount = Array.isArray(mailApiFailures) ? mailApiFailures.length : 0;
    const headerParts = [
      `范围：${scopeLabel}`,
      `当前筛选：${filterLabelMap[mailApiStatusFilter] || '全部'}`
    ];
    if (failuresCount > 0) headerParts.push(`失败店铺 ${failuresCount} 个`);
    getEl('mailApiHeaderMeta').textContent = headerParts.join(' · ');
    getEl('mailApiListMeta').textContent = `本页 ${mailApiList.length} 条，共 ${mailApiTotalCount} 条`;
    renderMailApiPager();

    if (!mailApiList.length) {
      container.innerHTML = `
        <tr>
          <td colspan="5">
            <div class="mail-api-list-empty">当前没有站内信数据</div>
          </td>
        </tr>
      `;
      updateMailApiSelectionControls();
      return;
    }

    container.innerHTML = mailApiList.map((item, idx) => {
      const messageId = String(item.messageId || '');
      const unread = Number(item.readStatus) === 0;
      const checked = mailApiSelectedIds.has(messageId);
      const shopName = String(item.shopName || scopeLabel || '店铺');
      return `
        <tr class="mail-api-row-${unread ? 'unread' : 'read'}" data-message-id="${esc(messageId)}">
          <td class="mail-api-cell-checkbox">
            <input type="checkbox" class="mail-api-row-checkbox" data-message-id="${esc(messageId)}" ${checked ? 'checked' : ''}>
          </td>
          <td class="mail-api-cell-index">${esc(String(serialBase + idx + 1))}</td>
          <td class="mail-api-cell-shop" title="${esc(shopName)}">${esc(shopName)}</td>
          <td class="mail-api-cell-subject" title="${esc(item.title || '未命名站内信')}">
            <div class="mail-api-subject mail-api-open-detail" data-message-id="${esc(messageId)}" role="button" tabindex="0" title="打开站内信详情">
              <span class="mail-api-subject-dot"></span>
              <span class="mail-api-subject-text">${esc(item.title || '未命名站内信')}</span>
            </div>
          </td>
          <td class="mail-api-cell-time">${esc(formatApiListTime(item.sendTime))}</td>
        </tr>
      `;
    }).join('');

    container.querySelectorAll('.mail-api-row-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', event => {
        const messageId = String(checkbox.dataset.messageId || '');
        if (!messageId) return;
        if (event.target.checked) {
          mailApiSelectedIds.add(messageId);
        } else {
          mailApiSelectedIds.delete(messageId);
        }
        updateMailApiSelectionControls();
      });
    });

    container.querySelectorAll('.mail-api-open-detail').forEach(trigger => {
      const openDetail = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const messageId = String(trigger.dataset.messageId || '');
        if (!messageId) return;
        const target = mailApiList.find(item => String(item.messageId || '') === messageId);
        if (!target) {
          addLog(`未找到站内信记录：${messageId}`, 'error');
          return;
        }
        await openMailApiDetailWindow(target);
      };
      trigger.addEventListener('click', openDetail);
      trigger.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        await openDetail(event);
      });
    });

    updateMailApiSelectionControls();
  }

  function resetMailApiState() {
    mailApiOverview = null;
    mailApiAllList = [];
    mailApiList = [];
    mailApiFailures = [];
    mailApiTotalCount = 0;
    mailApiPageNum = 1;
    mailApiStatusFilter = 'all';
    clearMailApiSelection();
    mailApiKnownMessageIds = new Set();
    mailApiHasNotificationBaseline = false;
    renderMailApiOverview();
    renderMailApiList();
  }

  async function loadMailApiOverview(shopId = getMailApiScopeShopId()) {
    const result = await window.pddApi.mailGetOverview({ shopId });
    if (!result || result.error) {
      mailApiOverview = null;
      renderMailApiOverview();
      getEl('mailApiHeaderMeta').textContent = result?.error || '加载站内信统计失败';
      return false;
    }
    mailApiOverview = result;
    mailApiFailures = Array.isArray(result.failures) ? result.failures : [];
    renderMailApiOverview();
    return true;
  }

  async function loadMailApiList() {
    const scopeShopId = getMailApiScopeShopId();
    if (!scopeShopId) {
      mailApiAllList = [];
      mailApiList = [];
      mailApiFailures = [];
      mailApiTotalCount = 0;
      clearMailApiSelection();
      renderMailApiList();
      return false;
    }

    const params = {
      shopId: scopeShopId,
      contentType: -1,
      pageNum: isMailApiAllScope() ? 1 : mailApiPageNum,
      size: MAIL_API_PAGE_SIZE,
    };
    const readStatus = getMailApiReadStatusParam();
    if (readStatus !== undefined) params.readStatus = readStatus;

    const result = await window.pddApi.mailGetList(params);
    if (!result || result.error) {
      mailApiAllList = [];
      mailApiList = [];
      mailApiFailures = [];
      mailApiTotalCount = 0;
      clearMailApiSelection();
      renderMailApiList();
      addLog(result?.error || '加载站内信列表失败', 'error');
      return false;
    }

    mailApiAllList = Array.isArray(result.list) ? result.list : [];
    mailApiFailures = Array.isArray(result.failures) ? result.failures : [];
    await notifyNewMailItems(mailApiAllList);
    if (isMailApiAllScope()) {
      mailApiTotalCount = Number(result.totalCount || mailApiAllList.length || 0);
      const totalPages = getMailApiTotalPages();
      if (mailApiPageNum > totalPages) {
        mailApiPageNum = totalPages;
      }
      mailApiList = getMailApiPageSlice();
    } else {
      mailApiTotalCount = Number(result.totalCount || mailApiAllList.length || 0);
      mailApiList = mailApiAllList.slice();
    }
    clearMailApiSelection();
    renderMailApiList();
    return true;
  }

  async function setMailApiStatusFilter(nextFilter) {
    if (!nextFilter || nextFilter === mailApiStatusFilter) return;
    mailApiStatusFilter = nextFilter;
    mailApiPageNum = 1;
    clearMailApiSelection();
    renderMailApiOverview();
    await loadMailApiList();
  }

  async function changeMailApiPage(step) {
    const nextPage = mailApiPageNum + step;
    const totalPages = getMailApiTotalPages();
    if (nextPage < 1 || nextPage > totalPages || nextPage === mailApiPageNum) return;
    mailApiPageNum = nextPage;
    clearMailApiSelection();
    if (isMailApiAllScope()) {
      mailApiList = getMailApiPageSlice();
      renderMailApiList();
      return;
    }
    await loadMailApiList();
  }

  async function openMailApiDetailWindow(item) {
    const messageId = String(item?.messageId || '').trim();
    if (!messageId) {
      addLog('该站内信缺少 messageId，无法打开详情', 'error');
      return;
    }
    const detailShopId = String(item?.shopId || activeShopId || '').trim();
    if (!detailShopId) {
      addLog('当前缺少店铺信息，无法打开详情', 'error');
      return;
    }
    if (!window.pddApi || typeof window.pddApi.openMailDetailWindow !== 'function') {
      addLog('openMailDetailWindow 未暴露，无法打开内置窗口', 'error');
      return;
    }
    try {
      const result = await window.pddApi.openMailDetailWindow({
        shopId: detailShopId,
        messageId,
        type: Number(item?.contentType ?? -1)
      });
      if (result?.error) {
        addLog(`打开站内信详情失败：${result.error}`, 'error');
      }
    } catch (error) {
      addLog(`打开站内信详情失败：${error?.message || '未知错误'}`, 'error');
    }
  }

  async function markMailApiSelectedAsRead() {
    const targets = mailApiList.filter(item => (
      mailApiSelectedIds.has(String(item.messageId || ''))
      && Number(item.readStatus) === 0
    ));
    if (!targets.length) {
      addLog('请选择未读站内信', 'info');
      return;
    }

    let successCount = 0;
    let failCount = 0;
    for (const item of targets) {
      const detailShopId = String(item?.shopId || activeShopId || '').trim();
      if (!detailShopId) {
        failCount += 1;
        continue;
      }
      const result = await window.pddApi.mailGetDetail({
        shopId: detailShopId,
        messageId: item.messageId,
      });
      if (!result || result.error) {
        failCount += 1;
      } else {
        successCount += 1;
      }
    }

    await loadMailApiOverview();
    await loadMailApiList();

    if (successCount > 0 && failCount > 0) {
      addLog(`已标记 ${successCount} 条站内信为已读，${failCount} 条失败`, 'info');
      return;
    }
    if (successCount > 0) {
      addLog(`已标记 ${successCount} 条站内信为已读`, 'info');
      return;
    }
    addLog('标记已读失败，请稍后重试', 'error');
  }

  async function loadMailApiView() {
    await refreshShopContext();
    if (!getMailApiScopeShopId()) {
      resetMailApiState();
      getEl('mailApiHeaderMeta').textContent = '当前没有可用店铺';
      return;
    }
    const overviewLoaded = await loadMailApiOverview();
    if (!overviewLoaded) {
      mailApiAllList = [];
      mailApiList = [];
      mailApiTotalCount = 0;
      clearMailApiSelection();
      renderMailApiList();
      return;
    }
    await loadMailApiList();
  }

  function bindMailApiModule() {
    if (initialized) return;
    initialized = true;

    getEl('btnMailApiFilterAll')?.addEventListener('click', async () => {
      await setMailApiStatusFilter('all');
    });
    getEl('btnMailApiFilterUnread')?.addEventListener('click', async () => {
      await setMailApiStatusFilter('unread');
    });
    getEl('btnMailApiFilterRead')?.addEventListener('click', async () => {
      await setMailApiStatusFilter('read');
    });
    getEl('btnMailApiRefreshList')?.addEventListener('click', async () => {
      await loadMailApiOverview();
      await loadMailApiList();
      addLog('已刷新站内信列表', 'info');
    });
    getEl('btnMailApiMarkRead')?.addEventListener('click', async () => {
      await markMailApiSelectedAsRead();
    });
    getEl('btnMailApiPrevPage')?.addEventListener('click', async () => {
      await changeMailApiPage(-1);
    });
    getEl('btnMailApiNextPage')?.addEventListener('click', async () => {
      await changeMailApiPage(1);
    });
    getEl('mailApiSelectAll')?.addEventListener('change', event => {
      const checked = !!event.target.checked;
      mailApiList.forEach(item => {
        const messageId = String(item.messageId || '');
        if (!messageId) return;
        if (checked) {
          mailApiSelectedIds.add(messageId);
        } else {
          mailApiSelectedIds.delete(messageId);
        }
      });
      renderMailApiList();
    });

    renderMailApiOverview();
    renderMailApiList();
  }

  window.loadMailApiView = loadMailApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('mail-api-module', bindMailApiModule);
  } else {
    bindMailApiModule();
  }
})();
