(function () {
  let initialized = false;
  let violationApiEntries = [];
  let violationApiList = [];
  let violationApiKeyword = '';
  let violationApiStatusFilter = '';
  let violationApiTypeFilter = '';
  let violationApiQuickFilter = 'all';
  let violationApiActiveId = '';
  let violationApiActiveDetail = null;

  function getEl(id) {
    return document.getElementById(id);
  }

  function getViolationTrafficType(entry) {
    const text = `${entry?.fullUrl || entry?.url || ''} ${entry?.requestBody || ''}`.toLowerCase();
    if (text.includes('/pg/violation_list/mall_manage')) return '页面入口';
    if (text.includes('violation_list')) return '违规列表';
    if (text.includes('appeal')) return '违规申诉';
    if (text.includes('warn')) return '违规预警';
    if (text.includes('punish')) return '处罚记录';
    if (text.includes('violation')) return '违规接口';
    return '';
  }

  function isViolationTrafficEntry(entry) {
    return !!getViolationTrafficType(entry);
  }

  function parseJsonSafely(text) {
    if (!text) return null;
    if (typeof text === 'object') return text;
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function pickFirstValue(source, paths) {
    for (const path of paths) {
      const segments = path.split('.');
      let current = source;
      let valid = true;
      for (const segment of segments) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
          valid = false;
          break;
        }
        current = current[segment];
      }
      if (valid && current !== undefined && current !== null && String(current).trim() !== '') {
        return current;
      }
    }
    return '';
  }

  function getObjectStringValues(source = {}) {
    return Object.values(source)
      .filter(value => ['string', 'number'].includes(typeof value))
      .map(value => String(value));
  }

  function looksLikeViolationRecord(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item).join(' ').toLowerCase();
    const values = getObjectStringValues(item).join(' ').toLowerCase();
    if (keys.includes('violation') || keys.includes('appeal') || keys.includes('punish')) return true;
    return values.includes('违规') || values.includes('申诉') || values.includes('处罚');
  }

  function normalizeViolationRecord(item = {}, index = 0) {
    const violationNo = String(pickFirstValue(item, [
      'violationId',
      'violation_id',
      'violationSn',
      'violation_sn',
      'serialNo',
      'serial_no',
      'noticeSn',
      'notice_sn',
      'recordId',
      'record_id',
      'id'
    ]) || `record-${index + 1}`);
    const violationType = String(pickFirstValue(item, [
      'violationType',
      'violation_type',
      'violationTypeDesc',
      'violation_type_desc',
      'punishType',
      'punish_type',
      'punishTypeDesc',
      'punish_type_desc',
      'ruleName',
      'rule_name',
      'sceneName',
      'scene_name',
      'reason',
      'reason_desc'
    ]) || '违规记录');
    const notifyTime = pickFirstValue(item, [
      'noticeTime',
      'notice_time',
      'violationTime',
      'violation_time',
      'punishTime',
      'punish_time',
      'createdAt',
      'createTime',
      'gmtCreate'
    ]);
    const appealTime = pickFirstValue(item, [
      'appealTime',
      'appeal_time',
      'complaintTime',
      'complaint_time',
      'submitTime',
      'submit_time'
    ]);
    const processTime = pickFirstValue(item, [
      'platformHandleTime',
      'platform_handle_time',
      'processTime',
      'process_time',
      'dealTime',
      'deal_time',
      'updateTime',
      'gmtModified'
    ]);
    const progress = String(pickFirstValue(item, [
      'statusDesc',
      'status_desc',
      'statusText',
      'status_text',
      'processStatus',
      'process_status',
      'processStatusDesc',
      'process_status_desc',
      'currentProgress',
      'current_progress',
      'progress'
    ]) || '待处理');
    const rawValues = getObjectStringValues(item);
    return {
      violationNo,
      violationType,
      notifyTime,
      appealTime,
      processTime,
      progress,
      summary: rawValues.slice(0, 6).join(' · '),
      raw: item
    };
  }

  function collectViolationRecordCandidates(source, bucket, visited = new Set()) {
    if (!source || typeof source !== 'object') return;
    if (visited.has(source)) return;
    visited.add(source);
    if (Array.isArray(source)) {
      source.forEach(item => collectViolationRecordCandidates(item, bucket, visited));
      return;
    }
    if (looksLikeViolationRecord(source)) {
      bucket.push(source);
    }
    Object.values(source).forEach(value => {
      if (value && typeof value === 'object') {
        collectViolationRecordCandidates(value, bucket, visited);
      }
    });
  }

  function dedupeViolationList(list = []) {
    const seen = new Set();
    return list.filter(item => {
      const key = `${item.violationNo}::${item.violationType}::${item.notifyTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseViolationRecordsFromTraffic(entries = []) {
    const records = [];
    entries.forEach(entry => {
      const payload = parseJsonSafely(entry?.responseBody);
      if (!payload) return;
      const bucket = [];
      collectViolationRecordCandidates(payload, bucket);
      bucket.forEach((item, index) => {
        records.push(normalizeViolationRecord(item, index));
      });
    });
    return dedupeViolationList(records);
  }

  function getViolationQuickType(item = {}) {
    const text = `${item.progress || ''} ${item.violationType || ''}`.toLowerCase();
    if (text.includes('平台处理') || text.includes('处理中') || text.includes('审核')) return 'processing';
    if (text.includes('申诉') || text.includes('举证') || text.includes('整改') || text.includes('完善资料')) return 'appealing';
    return 'pending';
  }

  function getViolationQuickCounts() {
    return violationApiList.reduce((acc, item) => {
      const type = getViolationQuickType(item);
      acc[type] += 1;
      return acc;
    }, { pending: 0, appealing: 0, processing: 0 });
  }

  function renderViolationQuickSummary() {
    const counts = getViolationQuickCounts();
    getEl('violationApiQuickPendingCount').textContent = String(counts.pending || 0);
    getEl('violationApiQuickAppealingCount').textContent = String(counts.appealing || 0);
    getEl('violationApiQuickProcessingCount').textContent = String(counts.processing || 0);
    document.querySelectorAll('[data-violation-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.violationQuick === violationApiQuickFilter);
    });
  }

  function renderViolationFilterOptions() {
    const renderSelect = (id, values, currentValue = '') => {
      const element = getEl(id);
      if (!element) return;
      const options = ['<option value="">全部</option>'].concat(values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`));
      element.innerHTML = options.join('');
      element.value = values.includes(currentValue) ? currentValue : '';
    };
    const getValues = key => Array.from(new Set(violationApiList.map(item => String(item[key] || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    renderSelect('violationApiStatusFilter', getValues('progress'), violationApiStatusFilter);
    renderSelect('violationApiTypeFilter', getValues('violationType'), violationApiTypeFilter);
  }

  function getViolationVisibleList() {
    const keyword = violationApiKeyword.trim().toLowerCase();
    return violationApiList.filter(item => {
      if (violationApiQuickFilter !== 'all' && getViolationQuickType(item) !== violationApiQuickFilter) return false;
      if (violationApiStatusFilter && item.progress !== violationApiStatusFilter) return false;
      if (violationApiTypeFilter && item.violationType !== violationApiTypeFilter) return false;
      if (keyword) {
        const text = `${item.violationNo || ''} ${item.violationType || ''} ${item.summary || ''}`.toLowerCase();
        if (!text.includes(keyword)) return false;
      }
      return true;
    });
  }

  function getViolationProgressClass(progress = '') {
    const text = String(progress).toLowerCase();
    if (text.includes('平台处理') || text.includes('处理中') || text.includes('审核')) return 'is-processing';
    if (text.includes('通过') || text.includes('完成') || text.includes('已解除')) return 'is-success';
    return 'is-pending';
  }

  function renderViolationApiList() {
    const container = getEl('violationApiList');
    const visibleList = getViolationVisibleList();
    const filterLabels = [];
    if (violationApiQuickFilter === 'pending') filterLabels.push('待申诉');
    if (violationApiQuickFilter === 'appealing') filterLabels.push('待完善资料');
    if (violationApiQuickFilter === 'processing') filterLabels.push('平台处理中');
    if (violationApiStatusFilter) filterLabels.push(`处理进度：${violationApiStatusFilter}`);
    if (violationApiTypeFilter) filterLabels.push(`违规类型：${violationApiTypeFilter}`);
    if (violationApiKeyword) filterLabels.push(`违规单号：${violationApiKeyword}`);
    getEl('violationApiListMeta').textContent = `${visibleList.length} / ${violationApiList.length} 条记录`;
    getEl('violationApiListStatus').textContent = filterLabels.length ? filterLabels.join(' · ') : '当前仅展示违规管理相关抓包与接口提取结果';
    getEl('violationApiFooterTotal').textContent = `共 ${visibleList.length} 条`;
    if (!visibleList.length) {
      container.innerHTML = '<tr><td colspan="7"><div class="violation-api-table-empty">当前没有违规记录，请先在嵌入网页打开违规管理列表后再刷新接口页。</div></td></tr>';
      return;
    }
    container.innerHTML = visibleList.map(item => {
      const active = String(item.violationNo) === String(violationApiActiveId);
      return `
        <tr class="${active ? 'active' : ''}" data-violation-id="${esc(item.violationNo)}">
          <td class="invoice-api-cell-em" title="${esc(item.violationNo || '-')}">${esc(item.violationNo || '-')}</td>
          <td title="${esc(item.violationType || '-')}">${esc(item.violationType || '-')}</td>
          <td>${esc(formatApiDateTime(item.notifyTime) || '-')}</td>
          <td>${esc(formatApiDateTime(item.appealTime) || '-')}</td>
          <td>${esc(formatApiDateTime(item.processTime) || '-')}</td>
          <td><span class="violation-api-progress ${getViolationProgressClass(item.progress)}">${esc(item.progress || '-')}</span></td>
          <td><button class="btn btn-secondary btn-sm" data-violation-detail="${esc(item.violationNo)}">查看详情</button></td>
        </tr>
      `;
    }).join('');
    container.querySelectorAll('[data-violation-id]').forEach(row => {
      row.addEventListener('click', async event => {
        if (event.target.closest('button')) return;
        await openViolationApiDetail(row.dataset.violationId, { skipTraffic: true });
      });
    });
    container.querySelectorAll('[data-violation-detail]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        await openViolationApiDetail(button.dataset.violationDetail, { skipTraffic: true });
      });
    });
  }

  function renderViolationApiDetail() {
    const head = getEl('violationApiDetailHead');
    const panel = getEl('violationApiDetailPanel');
    if (!violationApiActiveDetail?.violationNo) {
      head.innerHTML = `
        <div class="mail-api-detail-title">请选择一条违规记录</div>
        <div class="mail-api-detail-meta"><span>违规编号：-</span><span>违规时间：-</span></div>
      `;
      panel.innerHTML = '<div class="invoice-api-detail-empty">请选择一条违规记录查看详情</div>';
      getEl('violationApiDetailMeta').textContent = '点击表格中的“查看详情”打开详情';
      return;
    }
    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(violationApiActiveDetail.violationType || '违规记录')}</div>
      <div class="mail-api-detail-meta">
        <span>违规编号：${esc(violationApiActiveDetail.violationNo || '-')}</span>
        <span>违规时间：${esc(formatApiDateTime(violationApiActiveDetail.notifyTime) || '-')}</span>
      </div>
    `;
    const detailItems = [
      ['违规编号', violationApiActiveDetail.violationNo || '-'],
      ['违规类型', violationApiActiveDetail.violationType || '-'],
      ['违规通知时间', formatApiDateTime(violationApiActiveDetail.notifyTime) || '-'],
      ['申诉时间', formatApiDateTime(violationApiActiveDetail.appealTime) || '-'],
      ['平台处理时间', formatApiDateTime(violationApiActiveDetail.processTime) || '-'],
      ['当前进度', violationApiActiveDetail.progress || '-'],
      ['记录摘要', violationApiActiveDetail.summary || '-'],
      ['原始字段', Object.keys(violationApiActiveDetail.raw || {}).slice(0, 8).join('、') || '-']
    ];
    panel.innerHTML = `
      <div class="violation-api-detail-grid">
        ${detailItems.map(([label, value]) => `
          <div class="violation-api-detail-item">
            <div class="violation-api-detail-item-label">${esc(label)}</div>
            <div class="violation-api-detail-item-value">${esc(value)}</div>
          </div>
        `).join('')}
      </div>
    `;
    getEl('violationApiDetailMeta').textContent = `已打开记录：${violationApiActiveDetail.violationNo}`;
  }

  function renderViolationApiTraffic() {
    const container = getEl('violationApiTrafficList');
    getEl('violationApiTrafficSummary').textContent = `${violationApiEntries.length} 条抓包记录`;
    if (!violationApiEntries.length) {
      container.innerHTML = '<span class="mail-api-traffic-chip">暂无抓包</span>';
      return;
    }
    container.innerHTML = violationApiEntries.slice(0, 12).map(entry => {
      const typeTag = getViolationTrafficType(entry);
      const summary = `${typeTag} · ${entry.method || 'GET'} ${entry.url}`;
      return `<span class="mail-api-traffic-chip" title="${esc(summary)}">${esc(summary)}</span>`;
    }).join('');
  }

  function updateViolationApiBannerText() {
    const banner = getEl('violationApiBannerText');
    if (!banner) return;
    if (!activeShopId) {
      banner.textContent = '当前没有活跃店铺，请先切换店铺后再查看违规管理接口页。';
      return;
    }
    if (!violationApiEntries.length) {
      banner.textContent = '请先在嵌入网页打开违规管理列表页，再切到接口对接页查看同步结果。';
      return;
    }
    banner.textContent = `已抓取 ${violationApiEntries.length} 条违规管理相关记录，当前解析出 ${violationApiList.length} 条违规数据。`;
  }

  async function loadViolationApiTraffic(shopId = activeShopId) {
    if (!shopId) {
      violationApiEntries = [];
      renderViolationApiTraffic();
      updateViolationApiBannerText();
      return;
    }
    const list = await window.pddApi.getApiTraffic({ shopId });
    violationApiEntries = Array.isArray(list) ? list.slice().reverse().filter(isViolationTrafficEntry) : [];
    renderViolationApiTraffic();
    updateViolationApiBannerText();
  }

  async function loadViolationApiList() {
    violationApiList = parseViolationRecordsFromTraffic(violationApiEntries);
    renderViolationFilterOptions();
    renderViolationQuickSummary();
    renderViolationApiList();
    updateViolationApiBannerText();
    const visibleList = getViolationVisibleList();
    if (violationApiActiveId && visibleList.some(item => String(item.violationNo) === String(violationApiActiveId))) {
      violationApiActiveDetail = visibleList.find(item => String(item.violationNo) === String(violationApiActiveId)) || violationApiActiveDetail;
      renderViolationApiList();
      renderViolationApiDetail();
      return;
    }
    if (visibleList[0]?.violationNo) {
      await openViolationApiDetail(visibleList[0].violationNo, { skipTraffic: true });
      return;
    }
    violationApiActiveId = '';
    violationApiActiveDetail = null;
    renderViolationApiDetail();
  }

  async function openViolationApiDetail(violationNo, options = {}) {
    if (!violationNo) return;
    violationApiActiveId = String(violationNo);
    violationApiActiveDetail = violationApiList.find(item => String(item.violationNo) === String(violationNo)) || null;
    renderViolationApiList();
    renderViolationApiDetail();
    if (!options.skipTraffic) {
      await loadViolationApiTraffic();
    }
  }

  function resetViolationApiState() {
    violationApiEntries = [];
    violationApiList = [];
    violationApiKeyword = '';
    violationApiStatusFilter = '';
    violationApiTypeFilter = '';
    violationApiQuickFilter = 'all';
    violationApiActiveId = '';
    violationApiActiveDetail = null;
    const keyword = getEl('violationApiKeyword');
    if (keyword) keyword.value = '';
    ['violationApiStatusFilter', 'violationApiTypeFilter'].forEach(id => {
      const element = getEl(id);
      if (element) element.value = '';
    });
    renderViolationFilterOptions();
    renderViolationQuickSummary();
    renderViolationApiList();
    renderViolationApiDetail();
    renderViolationApiTraffic();
    updateViolationApiBannerText();
  }

  async function loadViolationApiView() {
    await refreshShopContext();
    if (!activeShopId) {
      resetViolationApiState();
      return;
    }
    await loadViolationApiTraffic(activeShopId);
    await loadViolationApiList();
  }

  function bindViolationApiModule() {
    if (initialized) return;
    initialized = true;
    getEl('btnViolationApiOpenDebug')?.addEventListener('click', async () => {
      const result = await window.pddApi.openDebugWindow();
      if (result?.error) addLog(`打开调试面板失败: ${result.error}`, 'error');
    });
    getEl('btnViolationApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnViolationApiReloadTraffic')?.addEventListener('click', async () => {
      await loadViolationApiTraffic();
      await loadViolationApiList();
      addLog('已刷新违规管理抓包记录', 'info');
    });
    getEl('btnViolationApiRefreshList')?.addEventListener('click', async () => {
      await loadViolationApiTraffic();
      await loadViolationApiList();
      addLog('已刷新违规管理列表', 'info');
    });
    getEl('btnViolationApiClearTraffic')?.addEventListener('click', async () => {
      const shopId = activeShopId || API_ALL_SHOPS;
      await window.pddApi.clearApiTraffic({ shopId });
      await loadViolationApiTraffic();
      await loadViolationApiList();
      addLog('已清空当前范围的违规管理抓包记录', 'info');
    });
    getEl('btnViolationApiBackToViolation')?.addEventListener('click', () => switchView('violation'));
    getEl('btnViolationApiApplyFilters')?.addEventListener('click', async () => {
      violationApiKeyword = getEl('violationApiKeyword').value || '';
      await loadViolationApiList();
    });
    getEl('btnViolationApiResetFilters')?.addEventListener('click', async () => {
      violationApiKeyword = '';
      violationApiStatusFilter = '';
      violationApiTypeFilter = '';
      violationApiQuickFilter = 'all';
      const keyword = getEl('violationApiKeyword');
      if (keyword) keyword.value = '';
      ['violationApiStatusFilter', 'violationApiTypeFilter'].forEach(id => {
        const element = getEl(id);
        if (element) element.value = '';
      });
      renderViolationQuickSummary();
      await loadViolationApiList();
    });
    document.querySelectorAll('[data-violation-quick]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextFilter = button.dataset.violationQuick || 'all';
        if (nextFilter === violationApiQuickFilter) return;
        violationApiQuickFilter = nextFilter;
        renderViolationQuickSummary();
        await loadViolationApiList();
      });
    });
    getEl('violationApiStatusFilter')?.addEventListener('change', async event => {
      violationApiStatusFilter = event.target.value || '';
      await loadViolationApiList();
    });
    getEl('violationApiTypeFilter')?.addEventListener('change', async event => {
      violationApiTypeFilter = event.target.value || '';
      await loadViolationApiList();
    });
    getEl('violationApiKeyword')?.addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      violationApiKeyword = getEl('violationApiKeyword').value || '';
      await loadViolationApiList();
    });
  }

  window.loadViolationApiView = loadViolationApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('violation-api-module', bindViolationApiModule);
  } else {
    bindViolationApiModule();
  }
})();
