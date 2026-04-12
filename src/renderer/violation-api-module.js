(function () {
  let initialized = false;
  let violationApiEntries = [];
  let violationApiList = [];
  let violationApiStatusFilter = '';
  let violationApiQuickFilter = 'pending';
  let violationApiQuickFilterBeforeStatus = 'pending';
  let violationApiActiveId = '';
  let violationApiActiveDetail = null;
  let violationApiLastListResult = null;
  let violationApiSelectedRecord = null;
  let violationApiProgressMenuOpen = false;
  const violationApiProgressGroups = [
    { label: '待申诉', codes: [0, 7] },
    { label: '平台处理中', codes: [1, 8, 10, 16, 17, 27, 30] },
    { label: '平台跟进中', codes: [34] },
    { label: '待完善资料', codes: [2, 9, 11, 18, 19] },
    { label: '申诉成功', codes: [3] },
    { label: '申诉失败', codes: [4, 21] },
    { label: '超时关闭申诉', codes: [5] },
    { label: '已处理', codes: [6, 31] },
    { label: '申诉终止', codes: [12, 26] },
    { label: '确认违规，处理中', codes: [13, 25] },
    { label: '未缴纳保证金', codes: [20] },
    { label: '主动认罚', codes: [22] },
    { label: '申诉完结', codes: [23] },
    { label: '申诉部分成功', codes: [24] },
    { label: '申述关闭', codes: [28] },
    { label: '待商家处理', codes: [29] },
    { label: '补缴成功', codes: [32] },
    { label: '超时未缴纳', codes: [33] },
  ];

  function getViolationProgressLabelFromCode(code) {
    const num = Number(code);
    if (!Number.isFinite(num)) return '';
    const group = violationApiProgressGroups.find(item => item.codes.includes(num));
    return group?.label || '';
  }

  const violationApiProgressOptions = violationApiProgressGroups.map(group => {
    const value = group.label;
    const label = group.label;
    const codes = Array.isArray(group.codes) ? group.codes : [];
    const normalizedLabel = String(label || '')
      .replace(/[，,]/g, '')
      .replace(/\s+/g, '');
    return {
      value,
      label,
      codes,
      match(text = '', code) {
        const num = Number(code);
        if (Number.isFinite(num) && codes.includes(num)) return true;
        const normalized = String(text || '')
          .replace(/[，,]/g, '')
          .replace(/\s+/g, '');
        if (label === '申述关闭') return normalized.includes('申述关闭') || normalized.includes('申诉关闭');
        return normalized.includes(normalizedLabel);
      }
    };
  });

  function getViolationProgressCodesByLabels(labels = []) {
    const set = new Set();
    labels.forEach(label => {
      const group = violationApiProgressGroups.find(item => item.label === label);
      const codes = Array.isArray(group?.codes) ? group.codes : [];
      codes.forEach(code => {
        const num = Number(code);
        if (Number.isFinite(num)) set.add(num);
      });
    });
    return set;
  }

  const violationApiQuickPendingCodes = getViolationProgressCodesByLabels(['待申诉']);
  const violationApiQuickAppealingCodes = getViolationProgressCodesByLabels(['待完善资料']);
  const violationApiQuickProcessingCodes = getViolationProgressCodesByLabels(['平台处理中', '平台跟进中', '确认违规，处理中']);

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

  function stringifySafely(value, maxLength = 24000) {
    try {
      const text = JSON.stringify(value, null, 2);
      if (typeof text !== 'string') return '';
      if (text.length <= maxLength) return text;
      return `${text.slice(0, maxLength)}\n...（内容过长已截断）`;
    } catch {
      try {
        return String(value || '');
      } catch {
        return '';
      }
    }
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
    const appealSn = String(pickFirstValue(item, [
      'violationAppealSn',
      'violation_appeal_sn',
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
    const violationTypeCode = String(pickFirstValue(item, [
      'violationType',
      'violation_type',
      'punishType',
      'punish_type',
      'type'
    ]) || '').trim();
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
      'appealEndTime',
      'appeal_end_time',
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
    const appealStatus = pickFirstValue(item, [
      'appealStatus',
      'appeal_status'
    ]);
    const progressCode = (() => {
      const num = Number(appealStatus);
      return Number.isFinite(num) ? num : null;
    })();
    const progressTextFromCode = progressCode === null ? '' : getViolationProgressLabelFromCode(progressCode);
    const progress = String(progressTextFromCode || pickFirstValue(item, [
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
      appealSn,
      violationNo: appealSn,
      violationType,
      violationTypeCode: /^\d+$/.test(violationTypeCode) ? violationTypeCode : '',
      notifyTime,
      appealTime,
      processTime,
      progressCode,
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
      const key = `${item.shopId || ''}::${item.violationNo}::${item.violationType}::${item.notifyTime}`;
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
    const code = Number(item.progressCode);
    if (Number.isFinite(code)) {
      if (violationApiQuickProcessingCodes.has(code)) return 'processing';
      if (violationApiQuickAppealingCodes.has(code)) return 'appealing';
      if (violationApiQuickPendingCodes.has(code)) return 'pending';
      return 'other';
    }
    const text = String(item.progress || '').trim();
    if (!text) return 'other';
    if (text.includes('待完善资料')) return 'appealing';
    if (text.includes('平台处理中') || text.includes('平台跟进中') || text.includes('确认违规')) return 'processing';
    if (text.includes('待申诉')) return 'pending';
    return 'other';
  }

  function getViolationQuickCounts() {
    return violationApiList.reduce((acc, item) => {
      const type = getViolationQuickType(item);
      if (type in acc) acc[type] += 1;
      return acc;
    }, { pending: 0, appealing: 0, processing: 0 });
  }

  function getViolationProgressCounts() {
    const base = violationApiProgressOptions.reduce((acc, option) => {
      acc[option.value] = 0;
      return acc;
    }, {});
    return violationApiList.reduce((acc, item) => {
      const text = String(item.progress || '').trim();
      for (const option of violationApiProgressOptions) {
        if (option.match(text, item.progressCode)) {
          acc[option.value] += 1;
          break;
        }
      }
      return acc;
    }, base);
  }

  function getActiveShopName(shopId = activeShopId) {
    const state = window.__shopsModuleAccess?.getState?.() || {};
    const shops = Array.isArray(state.shops) ? state.shops : [];
    const normalized = String(shopId || '');
    if (!normalized) return '';
    const match = shops.find(shop => String(shop.id || shop.shopId || shop.mallId || '') === normalized);
    return String(match?.name || '');
  }

  function formatViolationDateTime(value) {
    const text = formatApiDateTime(value);
    if (text) return text;
    if (typeof value !== 'string') return '';
    const match = value.trim().match(/^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})(?::\d{2})?$/);
    if (!match) return '';
    const year = Number(match[1]);
    const fullYear = year >= 0 && year <= 99 ? 2000 + year : year;
    return `${String(fullYear).padStart(4, '0')}-${match[2]}-${match[3]} ${match[4]}`;
  }

  function renderViolationQuickSummary() {
    const counts = getViolationQuickCounts();
    getEl('violationApiQuickPendingCount').textContent = String(counts.pending || 0);
    getEl('violationApiQuickAppealingCount').textContent = String(counts.appealing || 0);
    getEl('violationApiQuickProcessingCount').textContent = String(counts.processing || 0);
    document.querySelectorAll('[data-violation-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.violationQuick === violationApiQuickFilter);
    });
    getEl('violationApiProgressDropdownBtn')?.classList.toggle('active', !!violationApiStatusFilter);
  }

  function renderViolationProgressMenu() {
    const counts = getViolationProgressCounts();
    const total = violationApiList.length;
    const labelEl = getEl('violationApiProgressDropdownLabel');
    if (labelEl) {
      const active = violationApiProgressOptions.find(option => option.value === violationApiStatusFilter);
      if (active) {
        labelEl.textContent = `${active.label} ${String(counts[active.value] ?? 0)}`;
      } else {
        labelEl.textContent = '选择所有进度';
      }
    }
    const menu = getEl('violationApiProgressMenu');
    if (!menu) return;
    const options = [{ value: '', label: '选择所有进度', count: total }].concat(
      violationApiProgressOptions.map(option => ({ value: option.value, label: option.label, count: counts[option.value] || 0 }))
    );
    menu.innerHTML = options.map(option => {
      const active = String(option.value || '') === String(violationApiStatusFilter || '');
      return `
        <button type="button" class="violation-api-progress-option ${active ? 'is-active' : ''}" data-violation-progress="${esc(option.value || '')}">
          <span class="violation-api-progress-option-label">${esc(option.label)}</span>
          <span class="violation-api-progress-option-count">${esc(String(option.count ?? 0))}</span>
        </button>
      `;
    }).join('');
    menu.querySelectorAll('[data-violation-progress]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextValue = button.dataset.violationProgress || '';
        violationApiStatusFilter = nextValue;
        if (nextValue) {
          if (violationApiQuickFilter !== 'all') violationApiQuickFilterBeforeStatus = violationApiQuickFilter;
          violationApiQuickFilter = 'all';
        } else if (violationApiQuickFilter === 'all') {
          violationApiQuickFilter = violationApiQuickFilterBeforeStatus || 'pending';
        }
        closeViolationProgressMenu();
        renderViolationQuickSummary();
        await loadViolationApiList();
      });
    });
  }

  function openViolationProgressMenu() {
    const menu = getEl('violationApiProgressMenu');
    if (!menu) return;
    violationApiProgressMenuOpen = true;
    menu.classList.remove('is-hidden');
  }

  function closeViolationProgressMenu() {
    const menu = getEl('violationApiProgressMenu');
    if (!menu) return;
    violationApiProgressMenuOpen = false;
    menu.classList.add('is-hidden');
  }

  function getViolationVisibleList() {
    return violationApiList.filter(item => {
      if (violationApiQuickFilter !== 'all' && getViolationQuickType(item) !== violationApiQuickFilter) return false;
      if (violationApiStatusFilter) {
        const text = String(item.progress || '').trim();
        const option = violationApiProgressOptions.find(item => item.value === violationApiStatusFilter);
        if (option && !option.match(text, item.progressCode)) return false;
      }
      return true;
    });
  }

  function getViolationProgressClass(progress = '') {
    const text = String(progress).toLowerCase();
    if (text.includes('平台处理') || text.includes('处理中') || text.includes('审核')) return 'is-processing';
    if (text.includes('成功') || text.includes('通过') || text.includes('完成') || text.includes('已解除')) return 'is-success';
    return 'is-pending';
  }

  function renderViolationApiList() {
    const container = getEl('violationApiList');
    const visibleList = getViolationVisibleList();
    const filterLabels = [];
    if (violationApiQuickFilter === 'pending') filterLabels.push('待申诉');
    if (violationApiQuickFilter === 'appealing') filterLabels.push('待完善资料');
    if (violationApiQuickFilter === 'processing') filterLabels.push('平台处理中');
    if (violationApiStatusFilter) {
      const active = violationApiProgressOptions.find(option => option.value === violationApiStatusFilter);
      if (active) filterLabels.push(`进度类型：${active.label}`);
    }
    getEl('violationApiListMeta').textContent = `${visibleList.length} / ${violationApiList.length} 条记录`;
    getEl('violationApiListStatus').textContent = filterLabels.length ? filterLabels.join(' · ') : '当前展示违规管理接口返回结果';
    getEl('violationApiFooterTotal').textContent = `共 ${visibleList.length} 条`;
    if (!visibleList.length) {
      container.innerHTML = '<tr><td colspan="11"><div class="violation-api-table-empty">当前没有违规记录</div></td></tr>';
      return;
    }
    container.innerHTML = visibleList.map((item, idx) => {
      const active = String(item.violationNo) === String(violationApiActiveId);
      return `
        <tr class="${active ? 'active' : ''}" data-violation-id="${esc(item.violationNo)}">
          <td>${esc(idx + 1)}</td>
          <td title="${esc(item.shopName || '-')}">${esc(item.shopName || '-')}</td>
          <td class="violation-api-violation-no" title="${esc(item.violationNo || '-')}">
            <button
              type="button"
              class="violation-api-action-link violation-api-open-window"
              data-shop-id="${esc(item.shopId || '')}"
              data-appeal-sn="${esc(item.appealSn || item.violationNo || '')}"
              data-violation-type="${esc(item.violationTypeCode || '')}"
            >${esc(item.violationNo || '-')}</button>
          </td>
          <td title="${esc(item.violationType || '-')}">${esc(item.violationType || '-')}</td>
          <td>${esc(item.fineText || '-')}</td>
          <td>${esc(item.orderCountText || '-')}</td>
          <td><span class="violation-api-progress ${getViolationProgressClass(item.progress)}">${esc(item.progress || '-')}</span></td>
          <td>${esc(formatViolationDateTime(item.notifyTime) || '-')}</td>
          <td>${esc(formatViolationDateTime(item.appealTime) || '-')}</td>
          <td>${esc(formatViolationDateTime(item.processTime) || '-')}</td>
          <td title="${esc(item.reasonText || '-')}">${esc(item.reasonText || '-')}</td>
        </tr>
      `;
    }).join('');
    container.querySelectorAll('[data-violation-id]').forEach(row => {
      row.addEventListener('click', async event => {
        await openViolationApiDetail(row.dataset.violationId, { skipTraffic: true });
      });
    });
    container.querySelectorAll('.violation-api-open-window').forEach(btn => {
      btn.addEventListener('click', async event => {
        event.stopPropagation();
        const shopId = String(btn.dataset.shopId || activeShopId || '').trim();
        const appealSn = String(btn.dataset.appealSn || '').trim();
        const violationType = String(btn.dataset.violationType || '').trim();
        if (!appealSn || !/^\d+$/.test(appealSn) || !violationType || !/^\d+$/.test(violationType)) {
          addLog(`打开违规详情失败：缺少有效参数 appeal_sn/violation_type（appeal_sn=${appealSn || '-'}，violation_type=${violationType || '-'}）`, 'error');
          return;
        }
        const res = await window.pddApi.openViolationInfoWindow({ shopId, appealSn, violationType });
        if (res?.error) addLog(`打开违规详情失败：${res.error}`, 'error');
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
      const meta = getEl('violationApiDetailMeta');
      if (meta) meta.textContent = '点击表格中的“查看详情”打开详情';
      return;
    }
    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(violationApiActiveDetail.violationType || '违规记录')}</div>
      <div class="mail-api-detail-meta">
        <span>违规编号：${esc(violationApiActiveDetail.violationNo || '-')}</span>
        <span>违规时间：${esc(formatViolationDateTime(violationApiActiveDetail.notifyTime) || '-')}</span>
      </div>
    `;
    const detailItems = [
      ['违规编号', violationApiActiveDetail.violationNo || '-'],
      ['违规类型', violationApiActiveDetail.violationType || '-'],
      ['违规通知时间', formatViolationDateTime(violationApiActiveDetail.notifyTime) || '-'],
      ['申诉时间', formatViolationDateTime(violationApiActiveDetail.appealTime) || '-'],
      ['平台处理时间', formatViolationDateTime(violationApiActiveDetail.processTime) || '-'],
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
    const meta = getEl('violationApiDetailMeta');
    if (meta) meta.textContent = `已打开记录：${violationApiActiveDetail.violationNo}`;
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
    banner.textContent = `已加载违规管理列表 ${violationApiList.length} 条。`;
  }

  async function loadViolationApiTraffic(shopId = API_ALL_SHOPS) {
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

  function resolveViolationTypeLabel(raw = {}, typeMap = {}) {
    const explicit = String(pickFirstValue(raw, [
      'violationTypeStr',
      'violation_type_str',
      'violationTypeDesc',
      'violation_type_desc',
      'punishTypeDesc',
      'punish_type_desc',
      'ruleName',
      'rule_name',
      'sceneName',
      'scene_name'
    ]) || '').trim();
    if (explicit) return explicit;
    const code = String(pickFirstValue(raw, [
      'violationType',
      'violation_type',
      'punishType',
      'punish_type',
      'type'
    ]) || '').trim();
    if (code && typeMap && typeMap[code]) return String(typeMap[code] || '').trim();
    return '';
  }

  async function loadViolationApiList() {
    const shopId = API_ALL_SHOPS;
    const pageSize = 100;
    const maxPages = 5;
    try {
      let combinedList = [];
      let typeMap = {};
      let total = 0;
      const failuresMap = new Map();

      for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
        const result = await window.pddApi.violationGetList({ shopId, pageNo, pageSize });
        if (result?.error) {
          throw new Error(result.error);
        }
        if (result?.typeMap && typeof result.typeMap === 'object') {
          typeMap = result.typeMap;
        }
        if (Array.isArray(result?.failures)) {
          result.failures.forEach(item => {
            const key = String(item?.shopId || '');
            if (!key) return;
            failuresMap.set(key, item);
          });
        }
        const list = Array.isArray(result?.list) ? result.list : [];
        combinedList = combinedList.concat(list);
        if (!total) total = Number(result?.total || 0) || 0;
        if (total && combinedList.length >= total) break;
        if (!list.length) break;
      }

      violationApiLastListResult = {
        total: total || combinedList.length,
        loaded: combinedList.length,
        pageSize,
        typeMapSize: Object.keys(typeMap || {}).length,
        failuresCount: failuresMap.size,
      };

      violationApiList = dedupeViolationList(combinedList.map((raw, index) => {
        const normalized = normalizeViolationRecord(raw, index);
        const resolvedType = resolveViolationTypeLabel(raw, typeMap);
        if (resolvedType && (String(normalized.violationType || '').trim() === '' || String(normalized.violationType) === String(pickFirstValue(raw, ['violationType', 'violation_type', 'type']) || '') || normalized.violationType === '违规记录')) {
          normalized.violationType = resolvedType;
        }
        const fineText = (() => {
          const raw = normalized.raw || {};
          const violationAmountFen = pickFirstValue(raw, [
            'initViolationAmountFen',
            'violationAmount',
            'violation_amount'
          ]);
          if (violationAmountFen !== '' && violationAmountFen !== null && violationAmountFen !== undefined) {
            const num = Number(violationAmountFen);
            if (Number.isFinite(num)) return formatApiAmount(num / 100);
            return String(violationAmountFen);
          }
          const rawValue = pickFirstValue(raw, [
            'fine',
            'fineAmount',
            'fine_amount',
            'punishAmount',
            'punish_amount',
            'punishMoney',
            'punish_money',
            'penalty',
            'penaltyAmount',
            'penalty_amount',
            'amount',
            'money'
          ]);
          if (!rawValue && rawValue !== 0) return '';
          if (typeof rawValue === 'string' && (rawValue.includes('¥') || rawValue.includes('元'))) return rawValue;
          const num = Number(rawValue);
          if (!Number.isFinite(num)) return String(rawValue);
          return formatApiAmount(num);
        })();
        const orderCountText = (() => {
          const rawValue = pickFirstValue(normalized.raw || {}, [
            'violationInfo.violationOrderCount',
            'violation_info.violation_order_count',
            'violationOrderCount',
            'violation_order_count',
            'orderCount',
            'order_count',
            'orderNum',
            'order_num',
            'orders',
            'orderSize',
            'order_size'
          ]);
          if (rawValue === '' || rawValue === null || rawValue === undefined) return '';
          const num = Number(rawValue);
          if (!Number.isFinite(num)) return String(rawValue);
          return String(num);
        })();
        const reasonText = (() => {
          const rawValue = pickFirstValue(normalized.raw || {}, [
            'violationReason',
            'violation_reason',
            'violationReasonDesc',
            'violation_reason_desc',
            'reason',
            'reasonDesc',
            'reason_desc',
            'punishReason',
            'punish_reason',
            'punishDesc',
            'punish_desc'
          ]);
          return rawValue ? String(rawValue) : '';
        })();
        const rawShopId = String(raw?.shopId || raw?.mallId || raw?.shop_id || raw?.mall_id || '').trim();
        const rawShopName = String(raw?.shopName || raw?.mallName || raw?.shop_name || raw?.mall_name || '').trim();
        return {
          ...normalized,
          shopId: rawShopId || activeShopId,
          shopName: rawShopName || getActiveShopName(rawShopId || activeShopId) || '',
          fineText: fineText || '',
          orderCountText: orderCountText || '',
          reasonText: reasonText || '',
        };
      }));
    } catch (error) {
      addLog(`加载违规管理列表失败: ${error?.message || String(error)}`, 'error');
      violationApiLastListResult = null;
      violationApiList = [];
      violationApiSelectedRecord = null;
      renderViolationQuickSummary();
      renderViolationProgressMenu();
      renderViolationApiList();
      renderViolationApiDetail();
      updateViolationApiBannerText();
      return;
    }

    violationApiSelectedRecord = null;
    renderViolationQuickSummary();
    renderViolationProgressMenu();
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
    violationApiSelectedRecord = violationApiActiveDetail || null;
    renderViolationApiList();
    renderViolationApiDetail();

    if (!options.skipTraffic) {
      await loadViolationApiTraffic();
    }
  }

  function resetViolationApiState() {
    violationApiEntries = [];
    violationApiList = [];
    violationApiStatusFilter = '';
    violationApiQuickFilter = 'pending';
    violationApiQuickFilterBeforeStatus = 'pending';
    violationApiActiveId = '';
    violationApiActiveDetail = null;
    violationApiLastListResult = null;
    violationApiSelectedRecord = null;
    renderViolationQuickSummary();
    renderViolationProgressMenu();
    renderViolationApiList();
    renderViolationApiDetail();
    renderViolationApiTraffic();
    updateViolationApiBannerText();
  }

  async function loadViolationApiView() {
    await refreshShopContext();
    resetViolationApiState();
    await loadViolationApiTraffic();
    await loadViolationApiList();
  }

  function bindViolationApiModule() {
    if (initialized) return;
    initialized = true;
    getEl('btnViolationApiReloadTraffic')?.addEventListener('click', async () => {
      await loadViolationApiTraffic();
      await loadViolationApiList();
      addLog('已刷新违规管理抓包记录', 'info');
    });
    getEl('btnViolationApiRefreshList')?.addEventListener('click', async () => {
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
    document.querySelectorAll('[data-violation-quick]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextFilter = button.dataset.violationQuick || 'pending';
        if (nextFilter === violationApiQuickFilter) return;
        violationApiStatusFilter = '';
        closeViolationProgressMenu();
        violationApiQuickFilter = nextFilter;
        renderViolationQuickSummary();
        renderViolationProgressMenu();
        await loadViolationApiList();
      });
    });

    getEl('violationApiProgressDropdownBtn')?.addEventListener('click', event => {
      event.preventDefault();
      if (violationApiProgressMenuOpen) {
        closeViolationProgressMenu();
      } else {
        renderViolationProgressMenu();
        openViolationProgressMenu();
      }
    });
    document.addEventListener('click', event => {
      if (!violationApiProgressMenuOpen) return;
      const trigger = getEl('violationApiProgressDropdownBtn');
      const menu = getEl('violationApiProgressMenu');
      if (trigger && trigger.contains(event.target)) return;
      if (menu && menu.contains(event.target)) return;
      closeViolationProgressMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!violationApiProgressMenuOpen) return;
      closeViolationProgressMenu();
    });
  }

  window.loadViolationApiView = loadViolationApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('violation-api-module', bindViolationApiModule);
  } else {
    bindViolationApiModule();
  }
})();
