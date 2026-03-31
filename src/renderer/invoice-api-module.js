(function () {
  let initialized = false;
  let invoiceApiEntries = [];
  let invoiceApiOverview = null;
  let invoiceApiList = [];
  let invoiceApiKeyword = '';
  let invoiceApiQuickFilter = 'all';
  let invoiceApiOrderStatus = '';
  let invoiceApiModeFilter = '';
  let invoiceApiTypeFilter = '';
  let invoiceApiLetterheadTypeFilter = '';
  let invoiceApiLetterheadKeyword = '';
  let invoiceApiFiltersExpanded = false;
  let invoiceApiActiveSerialNo = '';
  let invoiceApiActiveDetail = null;
  const invoiceApiSelectedSerialNos = new Set();

  function getEl(id) {
    return document.getElementById(id);
  }

  function getInvoiceTrafficType(entry) {
    const text = `${entry?.fullUrl || entry?.url || ''} ${entry?.requestBody || ''}`.toLowerCase();
    if (text.includes('/invoice/center')) return '页面入口';
    if (text.includes('/omaisms/invoice/invoice_list')) return '待开票列表';
    if (text.includes('/omaisms/invoice/invoice_statistic')) return '统计概览';
    if (text.includes('/omaisms/invoice/invoice_quick_filter')) return '快捷筛选';
    if (text.includes('/omaisms/invoice/pop_notice')) return '弹窗公告';
    if (text.includes('/omaisms/invoice/invoice_tutorials')) return '开票教程';
    if (text.includes('/omaisms/invoice/is_third_party_entity_sub_mall')) return '主体校验';
    if (text.includes('/voice/api/mms/invoice/mall/verify2')) return '开票校验';
    if (text.includes('/orderinvoice/mall/mallcontrolinfo')) return '店铺控制';
    if (text.includes('/orderinvoice/mall/showinvoicemarktab')) return '页签配置';
    if (text.includes('/invoice/')) return '待开票接口';
    return '';
  }

  function isInvoiceTrafficEntry(entry) {
    return !!getInvoiceTrafficType(entry);
  }

  function resetInvoiceApiState() {
    invoiceApiOverview = null;
    invoiceApiList = [];
    invoiceApiEntries = [];
    invoiceApiActiveSerialNo = '';
    invoiceApiActiveDetail = null;
    invoiceApiKeyword = '';
    invoiceApiQuickFilter = 'all';
    invoiceApiOrderStatus = '';
    invoiceApiModeFilter = '';
    invoiceApiTypeFilter = '';
    invoiceApiLetterheadTypeFilter = '';
    invoiceApiLetterheadKeyword = '';
    invoiceApiFiltersExpanded = false;
    invoiceApiSelectedSerialNos.clear();
    const keywordInput = getEl('invoiceApiKeyword');
    if (keywordInput) keywordInput.value = '';
    const letterheadInput = getEl('invoiceApiLetterheadKeyword');
    if (letterheadInput) letterheadInput.value = '';
    ['invoiceApiOrderStatus', 'invoiceApiModeFilter', 'invoiceApiTypeFilter', 'invoiceApiLetterheadTypeFilter'].forEach(id => {
      const element = getEl(id);
      if (element) element.value = '';
    });
    renderInvoiceApiOverview();
    renderInvoiceApiSummary();
    renderInvoiceApiList();
    renderInvoiceApiDetail();
    renderInvoiceApiTraffic();
  }

  function getInvoiceQuickType(item = {}) {
    const text = `${item.invoiceType || ''} ${item.raw?.invoice_type_desc || ''} ${item.raw?.invoice_kind_desc || ''}`.toLowerCase();
    if (text.includes('正品')) return 'quality';
    if (text.includes('普通')) return 'normal';
    return 'all';
  }

  function getInvoiceQuickCounts() {
    const counts = invoiceApiList.reduce((acc, item) => {
      const type = getInvoiceQuickType(item);
      acc.all += 1;
      if (type === 'quality') acc.quality += 1;
      if (type === 'normal') acc.normal += 1;
      return acc;
    }, { all: 0, quality: 0, normal: 0 });
    return {
      all: counts.all || Number(invoiceApiOverview?.quickPendingTotal || invoiceApiOverview?.pendingNum || 0),
      quality: counts.quality || Number(invoiceApiOverview?.qualityPendingTotal || 0),
      normal: counts.normal || Number(invoiceApiOverview?.normalPendingTotal || 0)
    };
  }

  function renderInvoiceApiFilterOptions() {
    const renderSelect = (id, values, currentValue = '') => {
      const element = getEl(id);
      if (!element) return;
      const options = ['<option value="">全部</option>'].concat(values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`));
      element.innerHTML = options.join('');
      element.value = values.includes(currentValue) ? currentValue : '';
    };
    const getValues = key => Array.from(new Set(invoiceApiList.map(item => String(item[key] || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    renderSelect('invoiceApiOrderStatus', getValues('orderStatus'), invoiceApiOrderStatus);
    renderSelect('invoiceApiModeFilter', getValues('invoiceMode'), invoiceApiModeFilter);
    renderSelect('invoiceApiTypeFilter', getValues('invoiceType'), invoiceApiTypeFilter);
    renderSelect('invoiceApiLetterheadTypeFilter', getValues('letterheadType'), invoiceApiLetterheadTypeFilter);
  }

  function getInvoiceVisibleList() {
    const keyword = invoiceApiKeyword.trim().toLowerCase();
    const letterheadKeyword = invoiceApiLetterheadKeyword.trim().toLowerCase();
    return invoiceApiList.filter(item => {
      if (invoiceApiQuickFilter !== 'all' && getInvoiceQuickType(item) !== invoiceApiQuickFilter) return false;
      if (invoiceApiOrderStatus && item.orderStatus !== invoiceApiOrderStatus) return false;
      if (invoiceApiModeFilter && item.invoiceMode !== invoiceApiModeFilter) return false;
      if (invoiceApiTypeFilter && item.invoiceType !== invoiceApiTypeFilter) return false;
      if (invoiceApiLetterheadTypeFilter && item.letterheadType !== invoiceApiLetterheadTypeFilter) return false;
      if (keyword) {
        const text = `${item.orderSn || ''} ${item.serialNo || ''}`.toLowerCase();
        if (!text.includes(keyword)) return false;
      }
      if (letterheadKeyword) {
        const text = `${item.letterhead || ''}`.toLowerCase();
        if (!text.includes(letterheadKeyword)) return false;
      }
      return true;
    });
  }

  function renderInvoiceApiOverview() {
    getEl('invoiceApiPendingNum').textContent = invoiceApiOverview ? String(invoiceApiOverview.pendingNum || 0) : '-';
    getEl('invoiceApiInvoicedNum').textContent = invoiceApiOverview ? String(invoiceApiOverview.invoicedNum || 0) : '-';
    getEl('invoiceApiApplyingNum').textContent = invoiceApiOverview ? String(invoiceApiOverview.applyingNum || 0) : '-';
    getEl('invoiceApiAmount').textContent = invoiceApiOverview ? formatApiAmount(invoiceApiOverview.invoiceAmount || 0) : '-';
    getEl('invoiceApiQualityTotal').textContent = invoiceApiOverview ? String(invoiceApiOverview.qualityPendingTotal || 0) : '-';
    getEl('invoiceApiNormalTotal').textContent = invoiceApiOverview ? String(invoiceApiOverview.normalPendingTotal || 0) : '-';
    const quickSummary = getEl('invoiceApiQuickSummary');
    if (quickSummary) {
      quickSummary.value = invoiceApiOverview
        ? `快捷待开票 ${invoiceApiOverview.quickPendingTotal || 0}，全国票确认 ${invoiceApiOverview.nationalInvoiceConfirmTotal || 0}`
        : '待加载统计概览';
    }
    const scopeHint = getEl('invoiceApiScopeHint');
    if (scopeHint) {
      scopeHint.value = invoiceApiOverview
        ? `标记页签：${invoiceApiOverview.showInvoiceMarkTab ? '显示' : '隐藏'}，第三方主体分店：${invoiceApiOverview.isThirdPartySubMall ? '是' : '否'}`
        : '当前仅展示待开票接口返回结果';
    }
  }

  function renderInvoiceApiSummary() {
    const quickCounts = getInvoiceQuickCounts();
    getEl('invoiceApiQuickAllCount').textContent = String(quickCounts.all || 0);
    getEl('invoiceApiQuickQualityCount').textContent = String(quickCounts.quality || 0);
    getEl('invoiceApiQuickNormalCount').textContent = String(quickCounts.normal || 0);
    getEl('invoiceApiPendingTabCount').textContent = String(invoiceApiOverview?.pendingNum || quickCounts.all || 0);
    getEl('invoiceApiInvoicedTabCount').textContent = String(invoiceApiOverview?.invoicedNum || 0);
    getEl('invoiceApiFailTabCount').textContent = '0';
    getEl('invoiceApiHoldTabCount').textContent = String(invoiceApiOverview?.applyingNum || 0);
    document.querySelectorAll('[data-invoice-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.invoiceQuick === invoiceApiQuickFilter);
    });
    const advancedFilters = getEl('invoiceApiAdvancedFilters');
    const toggleButton = getEl('btnInvoiceApiToggleMore');
    if (advancedFilters) advancedFilters.classList.toggle('hidden', !invoiceApiFiltersExpanded);
    if (toggleButton) toggleButton.textContent = invoiceApiFiltersExpanded ? '收起' : '展开';
    renderInvoiceApiFilterOptions();
  }

  function syncInvoiceApiSelectAllState(visibleList = getInvoiceVisibleList()) {
    const visibleSelectedCount = visibleList.filter(item => invoiceApiSelectedSerialNos.has(String(item.serialNo))).length;
    const allSelected = !!visibleList.length && visibleSelectedCount === visibleList.length;
    const partialSelected = visibleSelectedCount > 0 && visibleSelectedCount < visibleList.length;
    ['invoiceApiSelectAllHead', 'invoiceApiSelectAll'].forEach(id => {
      const element = getEl(id);
      if (!element) return;
      element.checked = allSelected;
      element.indeterminate = partialSelected;
    });
    getEl('invoiceApiSelectionSummary').textContent = invoiceApiSelectedSerialNos.size
      ? `已选择 ${invoiceApiSelectedSerialNos.size} 条记录`
      : '未选择记录';
    getEl('invoiceApiFooterTotal').textContent = `共 ${visibleList.length} 条`;
    getEl('btnInvoiceApiBatchAction').disabled = invoiceApiSelectedSerialNos.size === 0;
  }

  async function syncInvoiceApiDetailWithVisible() {
    const visibleList = getInvoiceVisibleList();
    if (invoiceApiActiveSerialNo && visibleList.some(item => String(item.serialNo) === String(invoiceApiActiveSerialNo))) {
      renderInvoiceApiList();
      renderInvoiceApiDetail();
      return;
    }
    renderInvoiceApiList();
    if (visibleList[0]?.serialNo) {
      await openInvoiceApiDetail(visibleList[0].serialNo, { skipTraffic: true });
      return;
    }
    invoiceApiActiveSerialNo = '';
    invoiceApiActiveDetail = null;
    renderInvoiceApiDetail();
  }

  function renderInvoiceApiList() {
    const container = getEl('invoiceApiList');
    const visibleList = getInvoiceVisibleList();
    getEl('invoiceApiListMeta').textContent = `${visibleList.length} / ${invoiceApiList.length} 条记录`;
    const filterLabels = [];
    if (invoiceApiQuickFilter === 'quality') filterLabels.push('正品发票');
    if (invoiceApiQuickFilter === 'normal') filterLabels.push('普通发票');
    if (invoiceApiOrderStatus) filterLabels.push(`订单状态：${invoiceApiOrderStatus}`);
    if (invoiceApiModeFilter) filterLabels.push(`开票方式：${invoiceApiModeFilter}`);
    if (invoiceApiTypeFilter) filterLabels.push(`发票种类：${invoiceApiTypeFilter}`);
    if (invoiceApiLetterheadTypeFilter) filterLabels.push(`抬头类型：${invoiceApiLetterheadTypeFilter}`);
    if (invoiceApiKeyword) filterLabels.push(`订单号：${invoiceApiKeyword}`);
    if (invoiceApiLetterheadKeyword) filterLabels.push(`买家抬头：${invoiceApiLetterheadKeyword}`);
    getEl('invoiceApiListStatus').textContent = filterLabels.length ? filterLabels.join(' · ') : '默认拉取待开票列表';
    if (!visibleList.length) {
      container.innerHTML = '<tr><td colspan="12"><div class="mail-api-list-empty">当前没有待开票记录，或没有匹配到搜索结果。</div></td></tr>';
      syncInvoiceApiSelectAllState(visibleList);
      return;
    }
    container.innerHTML = visibleList.map(item => {
      const serialNo = String(item.serialNo || '');
      const active = serialNo === String(invoiceApiActiveSerialNo);
      const selected = invoiceApiSelectedSerialNos.has(serialNo);
      return `
        <tr class="${active ? 'active' : ''} ${selected ? 'selected' : ''}" data-invoice-serial-no="${esc(serialNo)}">
          <td><input type="checkbox" class="invoice-api-row-check" data-invoice-check="${esc(serialNo)}" ${selected ? 'checked' : ''}></td>
          <td class="invoice-api-cell-em" title="${esc(item.orderSn || serialNo || '-')}">${esc(item.orderSn || serialNo || '-')}</td>
          <td title="${esc(item.orderStatus || '-')}">${esc(item.orderStatus || '-')}</td>
          <td title="${esc(item.afterSalesStatus || '-')}">${esc(item.afterSalesStatus || '-')}</td>
          <td>${esc(formatApiDateTime(item.applyTime))}</td>
          <td class="invoice-api-cell-muted">-</td>
          <td class="invoice-api-amount">${esc(formatApiAmount(item.invoiceAmount))}</td>
          <td title="${esc(item.invoiceMode || '-')}">${esc(item.invoiceMode || '-')}</td>
          <td title="${esc(item.invoiceType || '-')}">${esc(item.invoiceType || '-')}</td>
          <td title="${esc(item.letterheadType || '-')}">${esc(item.letterheadType || '-')}</td>
          <td title="${esc(item.letterhead || '-')}">${esc(item.letterhead || '-')}</td>
          <td><button class="btn btn-secondary btn-sm invoice-api-op-btn" data-invoice-detail="${esc(serialNo)}">查看</button></td>
        </tr>
      `;
    }).join('');
    container.querySelectorAll('tr[data-invoice-serial-no]').forEach(row => {
      row.addEventListener('click', async event => {
        if (event.target.closest('button') || event.target.closest('input')) return;
        await openInvoiceApiDetail(row.dataset.invoiceSerialNo, { skipTraffic: true });
      });
    });
    container.querySelectorAll('[data-invoice-detail]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        await openInvoiceApiDetail(button.dataset.invoiceDetail, { skipTraffic: true });
      });
    });
    container.querySelectorAll('[data-invoice-check]').forEach(input => {
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('change', event => {
        const serialNo = String(event.target.dataset.invoiceCheck || '');
        if (!serialNo) return;
        if (event.target.checked) {
          invoiceApiSelectedSerialNos.add(serialNo);
        } else {
          invoiceApiSelectedSerialNos.delete(serialNo);
        }
        const row = event.target.closest('tr');
        if (row) row.classList.toggle('selected', event.target.checked);
        syncInvoiceApiSelectAllState(visibleList);
      });
    });
    syncInvoiceApiSelectAllState(visibleList);
  }

  function renderInvoiceApiDetail() {
    const head = getEl('invoiceApiDetailHead');
    const panel = getEl('invoiceApiDetailPanel');
    if (!invoiceApiActiveDetail?.serialNo) {
      head.innerHTML = `
        <div class="mail-api-detail-title">请选择一条待开票记录</div>
        <div class="mail-api-detail-meta"><span>订单号：-</span><span>申请时间：-</span></div>
      `;
      panel.innerHTML = '<div class="invoice-api-detail-empty">请选择一条待开票记录查看详情</div>';
      getEl('invoiceApiDetailMeta').textContent = '点击表格中的“查看”打开详情';
      return;
    }
    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(invoiceApiActiveDetail.orderSn || invoiceApiActiveDetail.serialNo || '待开票记录')}</div>
      <div class="mail-api-detail-meta">
        <span>流水号：${esc(invoiceApiActiveDetail.serialNo || '-')}</span>
        <span>申请时间：${esc(formatApiDateTime(invoiceApiActiveDetail.applyTime))}</span>
      </div>
    `;
    const detailItems = [
      ['店铺', invoiceApiActiveDetail.shopName || '-'],
      ['流水号', invoiceApiActiveDetail.serialNo || '-'],
      ['订单状态', invoiceApiActiveDetail.orderStatus || '-'],
      ['售后状态', invoiceApiActiveDetail.afterSalesStatus || '-'],
      ['开票金额', formatApiAmount(invoiceApiActiveDetail.invoiceAmount)],
      ['开票方式', invoiceApiActiveDetail.invoiceMode || '-'],
      ['发票种类', invoiceApiActiveDetail.invoiceType || '-'],
      ['抬头类型', invoiceApiActiveDetail.letterheadType || '-'],
      ['发票抬头', invoiceApiActiveDetail.letterhead || '-']
    ];
    panel.innerHTML = `
      <div class="invoice-api-detail-grid">
        ${detailItems.map(([label, value]) => `
          <div class="invoice-api-detail-item">
            <div class="invoice-api-detail-item-label">${esc(label)}</div>
            <div class="invoice-api-detail-item-value">${esc(value)}</div>
          </div>
        `).join('')}
      </div>
    `;
    getEl('invoiceApiDetailMeta').textContent = `已打开记录：${invoiceApiActiveDetail.serialNo || invoiceApiActiveDetail.orderSn}`;
  }

  function renderInvoiceApiTraffic() {
    const container = getEl('invoiceApiTrafficList');
    getEl('invoiceApiTrafficSummary').textContent = `${invoiceApiEntries.length} 条抓包记录`;
    if (!invoiceApiEntries.length) {
      container.innerHTML = '<span class="mail-api-traffic-chip">暂无抓包</span>';
      return;
    }
    container.innerHTML = invoiceApiEntries.slice(0, 10).map(entry => {
      const typeTag = getInvoiceTrafficType(entry);
      const summary = `${typeTag} · ${entry.method || 'GET'} ${entry.url}`;
      return `<span class="mail-api-traffic-chip" title="${esc(summary)}">${esc(summary)}</span>`;
    }).join('');
  }

  async function loadInvoiceApiTraffic(shopId = activeShopId) {
    if (!shopId) {
      invoiceApiEntries = [];
      renderInvoiceApiTraffic();
      return;
    }
    const list = await window.pddApi.getApiTraffic({ shopId });
    invoiceApiEntries = Array.isArray(list) ? list.slice().reverse().filter(isInvoiceTrafficEntry) : [];
    renderInvoiceApiTraffic();
  }

  async function loadInvoiceApiOverview(shopId = activeShopId) {
    const result = await window.pddApi.invoiceGetOverview({ shopId });
    if (!result || result.error) {
      invoiceApiOverview = null;
      renderInvoiceApiOverview();
      renderInvoiceApiSummary();
      getEl('invoiceApiHeaderMeta').textContent = result?.error || '加载待开票统计失败';
      return false;
    }
    invoiceApiOverview = result;
    renderInvoiceApiOverview();
    renderInvoiceApiSummary();
    getEl('invoiceApiHeaderMeta').textContent = `统计口径：当前接口返回 · 待开票 ${result.pendingNum || 0} 条，已开票 ${result.invoicedNum || 0} 条`;
    return true;
  }

  async function openInvoiceApiDetail(serialNo, options = {}) {
    if (!serialNo) return;
    invoiceApiActiveSerialNo = String(serialNo);
    invoiceApiActiveDetail = invoiceApiList.find(item => String(item.serialNo) === String(serialNo)) || null;
    renderInvoiceApiList();
    renderInvoiceApiDetail();
    if (!options.skipTraffic) {
      await loadInvoiceApiTraffic();
    }
  }

  async function loadInvoiceApiList(options = {}) {
    if (!activeShopId) {
      invoiceApiList = [];
      invoiceApiActiveSerialNo = '';
      invoiceApiActiveDetail = null;
      renderInvoiceApiFilterOptions();
      renderInvoiceApiSummary();
      renderInvoiceApiList();
      renderInvoiceApiDetail();
      return false;
    }
    const result = await window.pddApi.invoiceGetList({
      shopId: activeShopId,
      pageNo: 1,
      pageSize: 20,
      keyword: invoiceApiKeyword
    });
    if (!result || result.error) {
      invoiceApiList = [];
      invoiceApiActiveSerialNo = '';
      invoiceApiActiveDetail = null;
      renderInvoiceApiFilterOptions();
      renderInvoiceApiSummary();
      renderInvoiceApiList();
      renderInvoiceApiDetail();
      addLog(result?.error || '加载待开票列表失败', 'error');
      return false;
    }
    invoiceApiList = Array.isArray(result.list) ? result.list : [];
    renderInvoiceApiFilterOptions();
    renderInvoiceApiSummary();
    renderInvoiceApiList();
    const visibleList = getInvoiceVisibleList();
    const keepCurrent = options.keepCurrent && visibleList.some(item => String(item.serialNo) === String(invoiceApiActiveSerialNo));
    if (keepCurrent && invoiceApiActiveSerialNo) {
      await openInvoiceApiDetail(invoiceApiActiveSerialNo, { skipTraffic: true });
    } else if (visibleList[0]?.serialNo) {
      await openInvoiceApiDetail(visibleList[0].serialNo, { skipTraffic: true });
    } else {
      invoiceApiActiveSerialNo = '';
      invoiceApiActiveDetail = null;
      renderInvoiceApiDetail();
    }
    return true;
  }

  async function loadInvoiceApiView(options = {}) {
    await refreshShopContext();
    const shopId = activeShopId;
    if (!shopId) {
      getEl('invoiceApiHeaderMeta').textContent = '当前没有活跃店铺';
      resetInvoiceApiState();
      return;
    }
    await loadInvoiceApiOverview(shopId);
    await loadInvoiceApiList({ keepCurrent: options.keepCurrent });
    await loadInvoiceApiTraffic(shopId);
  }

  function bindInvoiceApiModule() {
    if (initialized) return;
    initialized = true;

    getEl('btnInvoiceApiOpenDebug')?.addEventListener('click', () => window.pddApi.openDebugWindow());
    getEl('btnInvoiceApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnInvoiceApiRefreshList')?.addEventListener('click', async () => {
      await loadInvoiceApiOverview();
      await loadInvoiceApiList({ keepCurrent: true });
      await loadInvoiceApiTraffic();
      addLog('已刷新待开票列表', 'info');
    });
    getEl('btnInvoiceApiReloadTraffic')?.addEventListener('click', async () => {
      await loadInvoiceApiTraffic();
      addLog('已刷新待开票抓包记录', 'info');
    });
    getEl('btnInvoiceApiClearTraffic')?.addEventListener('click', async () => {
      const shopId = activeShopId || API_ALL_SHOPS;
      await window.pddApi.clearApiTraffic({ shopId });
      await loadInvoiceApiTraffic();
      addLog('已清空当前范围的待开票抓包记录', 'info');
    });
    getEl('btnInvoiceApiBackToInvoice')?.addEventListener('click', () => switchView('invoice'));
    getEl('btnInvoiceApiApplyFilters')?.addEventListener('click', async () => {
      invoiceApiKeyword = getEl('invoiceApiKeyword').value || '';
      await loadInvoiceApiList({ keepCurrent: true });
    });
    getEl('btnInvoiceApiResetFilters')?.addEventListener('click', async () => {
      invoiceApiKeyword = '';
      invoiceApiQuickFilter = 'all';
      invoiceApiOrderStatus = '';
      invoiceApiModeFilter = '';
      invoiceApiTypeFilter = '';
      invoiceApiLetterheadTypeFilter = '';
      invoiceApiLetterheadKeyword = '';
      invoiceApiSelectedSerialNos.clear();
      getEl('invoiceApiKeyword').value = '';
      getEl('invoiceApiLetterheadKeyword').value = '';
      ['invoiceApiOrderStatus', 'invoiceApiModeFilter', 'invoiceApiTypeFilter', 'invoiceApiLetterheadTypeFilter'].forEach(id => {
        const element = getEl(id);
        if (element) element.value = '';
      });
      renderInvoiceApiSummary();
      await loadInvoiceApiList({ keepCurrent: true });
    });
    getEl('btnInvoiceApiToggleMore')?.addEventListener('click', () => {
      invoiceApiFiltersExpanded = !invoiceApiFiltersExpanded;
      renderInvoiceApiSummary();
    });
    document.querySelectorAll('[data-invoice-quick]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextFilter = button.dataset.invoiceQuick || 'all';
        if (nextFilter === invoiceApiQuickFilter) return;
        invoiceApiQuickFilter = nextFilter;
        renderInvoiceApiSummary();
        await syncInvoiceApiDetailWithVisible();
      });
    });
    getEl('invoiceApiOrderStatus')?.addEventListener('change', async event => {
      invoiceApiOrderStatus = event.target.value || '';
      await syncInvoiceApiDetailWithVisible();
    });
    getEl('invoiceApiModeFilter')?.addEventListener('change', async event => {
      invoiceApiModeFilter = event.target.value || '';
      await syncInvoiceApiDetailWithVisible();
    });
    getEl('invoiceApiTypeFilter')?.addEventListener('change', async event => {
      invoiceApiTypeFilter = event.target.value || '';
      await syncInvoiceApiDetailWithVisible();
    });
    getEl('invoiceApiLetterheadTypeFilter')?.addEventListener('change', async event => {
      invoiceApiLetterheadTypeFilter = event.target.value || '';
      await syncInvoiceApiDetailWithVisible();
    });
    getEl('invoiceApiLetterheadKeyword')?.addEventListener('input', async event => {
      invoiceApiLetterheadKeyword = event.target.value || '';
      await syncInvoiceApiDetailWithVisible();
    });
    ['invoiceApiKeyword', 'invoiceApiLetterheadKeyword'].forEach(id => {
      getEl(id)?.addEventListener('keydown', async event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (id === 'invoiceApiKeyword') {
          invoiceApiKeyword = getEl('invoiceApiKeyword').value || '';
          await loadInvoiceApiList({ keepCurrent: true });
          return;
        }
        invoiceApiLetterheadKeyword = getEl('invoiceApiLetterheadKeyword').value || '';
        await syncInvoiceApiDetailWithVisible();
      });
    });
    ['invoiceApiSelectAllHead', 'invoiceApiSelectAll'].forEach(id => {
      getEl(id)?.addEventListener('change', event => {
        const checked = !!event.target.checked;
        const visibleList = getInvoiceVisibleList();
        visibleList.forEach(item => {
          const serialNo = String(item.serialNo || '');
          if (!serialNo) return;
          if (checked) {
            invoiceApiSelectedSerialNos.add(serialNo);
          } else {
            invoiceApiSelectedSerialNos.delete(serialNo);
          }
        });
        renderInvoiceApiList();
      });
    });
  }

  window.loadInvoiceApiView = loadInvoiceApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('invoice-api-module', bindInvoiceApiModule);
  } else {
    bindInvoiceApiModule();
  }
})();
