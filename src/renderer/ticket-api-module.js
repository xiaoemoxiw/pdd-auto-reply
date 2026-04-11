(function () {
  let initialized = false;
  let ticketApiEntries = [];
  let ticketApiList = [];
  let ticketApiKeyword = '';
  let ticketApiTypeFilter = '';
  let ticketApiStatusFilter = '';
  let ticketApiQuickFilter = 'pending';
  let ticketApiDatePreset = 'all';
  let ticketApiActiveId = '';
  let ticketApiActiveDetail = null;

  function getEl(id) {
    return document.getElementById(id);
  }

  function getTicketTrafficType(entry) {
    const text = `${entry?.fullUrl || entry?.url || ''} ${entry?.requestBody || ''}`.toLowerCase();
    if (text.includes('/aftersales/work_order/list')) return '页面入口';
    if (text.includes('work_order')) return '工单列表';
    if (text.includes('after_sales') || text.includes('aftersales')) return '售后工单';
    if (text.includes('ticket')) return '工单接口';
    if (text.includes('complaint')) return '投诉工单';
    return '';
  }

  function isTicketTrafficEntry(entry) {
    return !!getTicketTrafficType(entry);
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

  function normalizeImageUrl(url) {
    const text = String(url || '').trim();
    if (!text) return '';
    if (!text.startsWith('http://') && !text.startsWith('https://')) return '';
    return text;
  }

  function extractImageUrls(source, limit = 12) {
    const result = [];
    const seen = new Set();
    const visited = new Set();
    const matchesImageText = (text) => {
      const value = String(text || '');
      if (!value.startsWith('http')) return false;
      const lower = value.toLowerCase();
      if (lower.includes('pddpic') || lower.includes('pddimg')) return true;
      return /\.(png|jpe?g|webp|gif)(\?|$)/.test(lower);
    };
    const push = (candidate) => {
      const url = normalizeImageUrl(candidate);
      if (!url) return;
      if (!matchesImageText(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      result.push(url);
    };
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      Object.entries(node).forEach(([key, value]) => {
        if (result.length >= limit) return;
        if (typeof value === 'string') {
          const lowerKey = String(key || '').toLowerCase();
          if (lowerKey.includes('image') || lowerKey.includes('img') || lowerKey.includes('pic') || lowerKey.includes('thumb') || lowerKey.includes('url')) {
            push(value);
          } else if (matchesImageText(value)) {
            push(value);
          }
          return;
        }
        if (value && typeof value === 'object') {
          walk(value);
        }
      });
    };
    walk(source);
    return result;
  }

  function looksLikeTicketRecord(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item).join(' ').toLowerCase();
    const values = getObjectStringValues(item).join(' ').toLowerCase();
    if (keys.includes('work_order') || keys.includes('workorder') || keys.includes('ticket')) return true;
    if (keys.includes('handler') || keys.includes('assignee') || keys.includes('sla')) return true;
    if (keys.includes('order_sn') || keys.includes('ordersn')) return true;
    return values.includes('工单') || values.includes('售后') || values.includes('投诉');
  }

  function mapTicketStatusCode(status) {
    const code = Number(status);
    if (!Number.isFinite(code)) return String(status || '');
    if (code === 1) return '待处理';
    if (code === 2) return '处理中';
    if (code === 3) return '待处理';
    if (code === 4) return '违规已处理';
    return String(code);
  }

  function normalizeTodoListItem(item = {}, index = 0) {
    const statusText = mapTicketStatusCode(item.status);
    return {
      ticketNo: String(item.instanceId || `instance-${index + 1}`),
      instanceId: String(item.instanceId || ''),
      orderSn: String(item.orderSn || ''),
      ticketType: String(item.problemTitle || '工单'),
      questionTitle: String(item.problemTitle || '工单'),
      questionDesc: String(item.goodsName || ''),
      goodsName: String(item.goodsName || ''),
      createTime: item.createdAt || '',
      updateTime: item.deadline || item.createdAt || '',
      status: statusText || '待处理',
      statusCode: Number(item.status || 0) || 0,
      assignee: String(item.externalDisplayName || '-'),
      progressText: String(item.externalDisplayName || statusText || '-'),
      images: extractImageUrls(item, 6),
      punished: item.punished,
      serviceDomain: item.serviceDomain,
      hideCountdownTime: Boolean(item.hideCountdownTime),
      deadline: item.deadline || '',
      summary: [item.problemTitle, item.goodsName, item.externalDisplayName].filter(Boolean).join(' · '),
      raw: item
    };
  }

  function normalizeTicketRecord(item = {}, index = 0) {
    const ticketNo = String(pickFirstValue(item, [
      'workOrderId',
      'work_order_id',
      'workOrderSn',
      'work_order_sn',
      'ticketId',
      'ticket_id',
      'ticketSn',
      'ticket_sn',
      'taskId',
      'task_id',
      'id'
    ]) || `ticket-${index + 1}`);
    const orderSn = String(pickFirstValue(item, [
      'orderSn',
      'order_sn',
      'orderId',
      'order_id',
      'orderNo',
      'order_no',
      'orderNumber',
      'order_number',
      'bizOrderSn',
      'biz_order_sn'
    ]) || '');
    const ticketType = String(pickFirstValue(item, [
      'questionTypeDesc',
      'question_type_desc',
      'workOrderTypeDesc',
      'work_order_type_desc',
      'workOrderType',
      'work_order_type',
      'bizTypeDesc',
      'biz_type_desc',
      'bizType',
      'biz_type',
      'questionType',
      'question_type',
      'categoryName',
      'category_name'
    ]) || '工单');
    const questionTitle = String(pickFirstValue(item, [
      'questionTitle',
      'question_title',
      'title',
      'subject',
      'problemTitle',
      'problem_title',
      'issueTitle',
      'issue_title',
      'workOrderTitle',
      'work_order_title'
    ]) || ticketType);
    const questionDesc = String(pickFirstValue(item, [
      'questionDesc',
      'question_desc',
      'content',
      'desc',
      'description',
      'detail',
      'remark',
      'buyerDesc',
      'buyer_desc',
      'complaintContent',
      'complaint_content'
    ]) || '');
    const goodsName = String(pickFirstValue(item, [
      'goodsName',
      'goods_name',
      'skuName',
      'sku_name',
      'productName',
      'product_name',
      'goodsTitle',
      'goods_title'
    ]) || '');
    const createTime = pickFirstValue(item, [
      'createTime',
      'create_time',
      'createdAt',
      'created_at',
      'submitTime',
      'submit_time',
      'gmtCreate'
    ]);
    const updateTime = pickFirstValue(item, [
      'updateTime',
      'update_time',
      'lastReplyTime',
      'last_reply_time',
      'latestReplyTime',
      'latest_reply_time',
      'finishTime',
      'finish_time',
      'handleTime',
      'handle_time',
      'gmtModified'
    ]);
    const status = String(pickFirstValue(item, [
      'statusDesc',
      'status_desc',
      'statusText',
      'status_text',
      'workOrderStatusDesc',
      'work_order_status_desc',
      'workOrderStatus',
      'work_order_status',
      'handleStatusDesc',
      'handle_status_desc',
      'handleStatus',
      'handle_status',
      'processStatusDesc',
      'process_status_desc',
      'processStatus',
      'process_status',
      'replyStatusDesc',
      'reply_status_desc',
      'replyStatus',
      'reply_status'
    ]) || '待处理');
    const assignee = String(pickFirstValue(item, [
      'handlerName',
      'handler_name',
      'assigneeName',
      'assignee_name',
      'ownerName',
      'owner_name',
      'csName',
      'cs_name',
      'serviceName',
      'service_name'
    ]) || '-');
    const progressText = String(pickFirstValue(item, [
      'processDesc',
      'process_desc',
      'progressDesc',
      'progress_desc',
      'handleResult',
      'handle_result',
      'resultDesc',
      'result_desc',
      'solution',
      'solution_desc'
    ]) || '');
    const images = extractImageUrls(item, 12);
    const rawValues = getObjectStringValues(item);
    return {
      ticketNo,
      instanceId: String(pickFirstValue(item, [
        'instanceId',
        'instance_id',
        'todoId',
        'todo_id'
      ]) || ''),
      orderSn,
      ticketType,
      questionTitle,
      questionDesc,
      goodsName,
      createTime,
      updateTime,
      status,
      statusCode: Number(pickFirstValue(item, [
        'status',
        'workOrderStatus',
        'work_order_status'
      ]) || 0) || 0,
      assignee,
      progressText,
      images,
      deadline: pickFirstValue(item, [
        'deadline',
        'expireTime',
        'expire_time'
      ]),
      summary: rawValues.slice(0, 8).join(' · '),
      raw: item
    };
  }

  function collectTicketRecordCandidates(source, bucket, visited = new Set()) {
    if (!source || typeof source !== 'object') return;
    if (visited.has(source)) return;
    visited.add(source);
    if (Array.isArray(source)) {
      source.forEach(item => collectTicketRecordCandidates(item, bucket, visited));
      return;
    }
    if (looksLikeTicketRecord(source)) {
      bucket.push(source);
    }
    Object.values(source).forEach(value => {
      if (value && typeof value === 'object') {
        collectTicketRecordCandidates(value, bucket, visited);
      }
    });
  }

  function dedupeTicketList(list = []) {
    const seen = new Set();
    return list.filter(item => {
      const key = `${item.instanceId || ''}::${item.orderSn || ''}::${item.ticketNo || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function mergeTicketRecord(base = {}, extra = {}) {
    const merged = { ...base, ...extra };
    Object.keys(merged).forEach(key => {
      const baseValue = base[key];
      const extraValue = extra[key];
      if ((merged[key] === '' || merged[key] === null || merged[key] === undefined || merged[key] === '-') && baseValue) {
        merged[key] = baseValue;
      }
      if (Array.isArray(baseValue) || Array.isArray(extraValue)) {
        merged[key] = Array.from(new Set([...(Array.isArray(baseValue) ? baseValue : []), ...(Array.isArray(extraValue) ? extraValue : [])])).filter(Boolean);
      }
    });
    merged.raw = extra.raw || base.raw || {};
    return merged;
  }

  function parseTicketRecordsFromTraffic(entries = []) {
    const records = [];
    const recordMap = new Map();
    entries.forEach(entry => {
      const payload = parseJsonSafely(entry?.responseBody);
      if (!payload) return;
      const url = String(entry?.fullUrl || entry?.url || '');
      if (url.includes('/strickland/sop/mms/todoList')) {
        const dataList = Array.isArray(payload?.result?.dataList) ? payload.result.dataList : [];
        dataList.forEach((item, index) => {
          const normalized = normalizeTodoListItem(item, index);
          const key = normalized.instanceId || normalized.orderSn || normalized.ticketNo;
          if (!key) return;
          recordMap.set(key, mergeTicketRecord(recordMap.get(key) || {}, normalized));
        });
        return;
      }
      const bucket = [];
      collectTicketRecordCandidates(payload, bucket);
      bucket.forEach((item, index) => {
        const normalized = normalizeTicketRecord(item, index);
        const key = normalized.instanceId || normalized.orderSn || normalized.ticketNo;
        if (!key) {
          records.push(normalized);
          return;
        }
        recordMap.set(key, mergeTicketRecord(recordMap.get(key) || {}, normalized));
      });
    });
    return dedupeTicketList([...recordMap.values(), ...records]);
  }

  function isTicketClosed(status = '') {
    const text = String(status).toLowerCase();
    return text.includes('已处理') || text.includes('已完结') || text.includes('已关闭') || text.includes('完成') || text.includes('完结');
  }

  function getTicketQuickType(item = {}) {
    const code = Number(item.statusCode || 0);
    if (code === 3) return 'pending';
    if (code === 2) return 'processing';
    if (code === 4) return 'closed';
    const text = `${item.status || ''} ${item.progressText || ''}`.toLowerCase();
    if (text.includes('2小时') || text.includes('将逾期') || text.includes('逾期') || text.includes('超时') || text.includes('超期')) return 'timeout';
    if (text.includes('处理中') || text.includes('跟进') || text.includes('流转') || text.includes('处理中')) return 'processing';
    if (text.includes('违规已处理') || isTicketClosed(item.status)) return 'closed';
    return 'pending';
  }

  function getTicketQuickCounts() {
    return ticketApiList.reduce((acc, item) => {
      const type = getTicketQuickType(item);
      acc.pending += type === 'pending' ? 1 : 0;
      acc.timeout += type === 'timeout' ? 1 : 0;
      acc.processing += type === 'processing' ? 1 : 0;
      acc.closed += type === 'closed' ? 1 : 0;
      return acc;
    }, { pending: 0, timeout: 0, processing: 0, closed: 0 });
  }

  function renderTicketQuickSummary() {
    const counts = getTicketQuickCounts();
    getEl('ticketApiQuickPendingCount').textContent = String(counts.pending || 0);
    getEl('ticketApiQuickTimeoutCount').textContent = String(counts.timeout || 0);
    getEl('ticketApiQuickProcessingCount').textContent = String(counts.processing || 0);
    getEl('ticketApiQuickClosedCount').textContent = String(counts.closed || 0);
    document.querySelectorAll('[data-ticket-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.ticketQuick === ticketApiQuickFilter);
    });
  }

  function renderTicketFilterOptions() {
    const renderSelect = (id, values, currentValue = '') => {
      const element = getEl(id);
      if (!element) return;
      const options = ['<option value="">全部</option>'].concat(values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`));
      element.innerHTML = options.join('');
      element.value = values.includes(currentValue) ? currentValue : '';
    };
    const getValues = key => Array.from(new Set(ticketApiList.map(item => String(item[key] || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    renderSelect('ticketApiTypeFilter', getValues('ticketType'), ticketApiTypeFilter);
    renderSelect('ticketApiStatusFilter', getValues('status'), ticketApiStatusFilter);
  }

  function getPresetDays(preset) {
    const value = String(preset || 'all');
    if (value === '7') return 7;
    if (value === '30') return 30;
    if (value === '60') return 60;
    return null;
  }

  function getPresetDateRangeText() {
    const days = getPresetDays(ticketApiDatePreset);
    if (!days) return '-';
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    const format = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${format(start)} - ${format(end)}`;
  }

  function shouldIncludeByDate(item) {
    const days = getPresetDays(ticketApiDatePreset);
    if (!days) return true;
    const source = item.createTime || item.updateTime;
    if (!source) return true;
    const ts = new Date(source).getTime();
    if (Number.isNaN(ts)) return true;
    const earliest = Date.now() - days * 24 * 60 * 60 * 1000;
    return ts >= earliest;
  }

  function getTicketVisibleList() {
    const keyword = ticketApiKeyword.trim().toLowerCase();
    return ticketApiList.filter(item => {
      if (ticketApiQuickFilter && getTicketQuickType(item) !== ticketApiQuickFilter) return false;
      if (ticketApiTypeFilter && item.ticketType !== ticketApiTypeFilter) return false;
      if (ticketApiStatusFilter && item.status !== ticketApiStatusFilter) return false;
      if (!shouldIncludeByDate(item)) return false;
      if (keyword) {
        const text = `${item.orderSn || ''} ${item.ticketNo || ''} ${item.goodsName || ''} ${item.questionTitle || ''} ${item.questionDesc || ''}`.toLowerCase();
        if (!text.includes(keyword)) return false;
      }
      return true;
    });
  }

  function getTicketStatusClass(status = '') {
    const text = String(status).toLowerCase();
    if (isTicketClosed(text)) return 'is-success';
    if (text.includes('处理中') || text.includes('跟进') || text.includes('流转')) return 'is-processing';
    return 'is-pending';
  }

  function renderTicketMetrics() {
    const total = ticketApiList.length;
    const closed = ticketApiList.filter(item => isTicketClosed(item.status)).length;
    const violationHandled = ticketApiList.filter(item => String(item.status || '').includes('违规')).length;
    const effectiveClosed = Math.max(0, closed - violationHandled);
    const safeRate = (num, den) => (den ? (num * 100 / den) : 0);
    getEl('ticketApiMetricTotal').textContent = String(total);
    getEl('ticketApiMetricViolationHandled').textContent = String(violationHandled);
    getEl('ticketApiMetricViolationRate').textContent = safeRate(violationHandled, total).toFixed(2);
    getEl('ticketApiMetricClosedRate').textContent = safeRate(closed, total).toFixed(2);
    getEl('ticketApiMetricEffectiveClosedRate').textContent = safeRate(effectiveClosed, total).toFixed(2);
  }

  function renderTicketApiList() {
    const container = getEl('ticketApiList');
    const visibleList = getTicketVisibleList();
    getEl('ticketApiResultCount').textContent = String(visibleList.length);
    getEl('ticketApiFooterTotal').textContent = `共 ${visibleList.length} 条`;

    const filterLabels = [];
    if (ticketApiQuickFilter === 'pending') filterLabels.push('待处理');
    if (ticketApiQuickFilter === 'timeout') filterLabels.push('2小时内将逾期');
    if (ticketApiQuickFilter === 'processing') filterLabels.push('处理中');
    if (ticketApiQuickFilter === 'closed') filterLabels.push('违规已处理');
    if (ticketApiStatusFilter) filterLabels.push(`工单状态：${ticketApiStatusFilter}`);
    if (ticketApiTypeFilter) filterLabels.push(`问题类型：${ticketApiTypeFilter}`);
    if (ticketApiDatePreset !== 'all') filterLabels.push(`创建时间：${getPresetDateRangeText()}`);
    if (ticketApiKeyword) filterLabels.push(`订单编号：${ticketApiKeyword}`);
    getEl('ticketApiListStatus').textContent = filterLabels.length ? filterLabels.join(' · ') : '当前仅展示工单管理相关抓包与接口提取结果';

    if (!visibleList.length) {
      container.innerHTML = '<div class="ticket-api-list-empty">当前没有工单记录，请先在嵌入网页打开工单列表后再刷新接口页。</div>';
      return;
    }

    container.innerHTML = visibleList.map(item => {
      const active = String(item.ticketNo) === String(ticketApiActiveId);
      const thumb = item.images?.[0] ? `<img class="ticket-api-thumb" src="${esc(item.images[0])}" alt="">` : '<div class="ticket-api-thumb-placeholder">暂无图片</div>';
      const orderText = item.orderSn || item.ticketNo || '-';
      const questionTitle = item.questionTitle || item.ticketType || '工单';
      const questionDesc = item.questionDesc || item.goodsName || item.summary || '';
      const progressText = item.progressText || item.status || '-';
      const actionLabel = '立即查看';
      return `
        <div class="ticket-api-list-item ${active ? 'active' : ''}" data-ticket-id="${esc(item.ticketNo)}">
          <div class="ticket-api-list-main">
            <div class="ticket-api-info">
              ${thumb}
              <div class="ticket-api-info-body">
                <div class="ticket-api-order-line">
                  <span class="ticket-api-order-label">订单号：</span>
                  <span class="ticket-api-order-value" title="${esc(orderText)}">${esc(orderText)}</span>
                  <span class="ticket-api-copy-tag">复制</span>
                </div>
                <div class="ticket-api-question-title" title="${esc(questionTitle)}">${esc(questionTitle)}</div>
                <div class="ticket-api-question-desc" title="${esc(questionDesc)}">${esc(questionDesc)}</div>
              </div>
            </div>
            <div class="ticket-api-progress-col">
              <span class="ticket-api-progress ${getTicketStatusClass(item.status)}">${esc(item.status || '-')}</span>
              <div class="ticket-api-progress-text">${esc(progressText)}</div>
              <div class="ticket-api-progress-sub">${esc(item.assignee || '-')}</div>
            </div>
            <div class="ticket-api-time-col">
              <div>创建时间：${esc(formatApiDateTime(item.createTime) || '-')}</div>
              <div>更新时间：${esc(formatApiDateTime(item.updateTime) || '-')}</div>
            </div>
            <div class="ticket-api-action-col">
              <button class="ticket-api-action-link" data-ticket-detail="${esc(item.ticketNo)}">${actionLabel}</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-ticket-id]').forEach(row => {
      row.addEventListener('click', async event => {
        if (event.target.closest('button')) return;
        await openTicketApiDetail(row.dataset.ticketId, { skipTraffic: true });
      });
    });

    container.querySelectorAll('[data-ticket-detail]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        await openTicketApiDetail(button.dataset.ticketDetail, { skipTraffic: true });
      });
    });
  }

  function stringifySafely(value, limit = 20000) {
    try {
      const text = JSON.stringify(value, null, 2);
      if (text.length <= limit) return text;
      return `${text.slice(0, limit)}\n...（已截断，原始数据过大）`;
    } catch {
      return '';
    }
  }

  function collectTimelineCandidates(source, bucket, visited = new Set()) {
    if (!source || typeof source !== 'object') return;
    if (visited.has(source)) return;
    visited.add(source);
    if (Array.isArray(source)) {
      if (source.length && source.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
        bucket.push(source);
      }
      source.forEach(item => collectTimelineCandidates(item, bucket, visited));
      return;
    }
    Object.values(source).forEach(value => {
      if (value && typeof value === 'object') {
        collectTimelineCandidates(value, bucket, visited);
      }
    });
  }

  function normalizeTimelineItem(item = {}, index = 0) {
    const time = pickFirstValue(item, [
      'time',
      'createTime',
      'createdAt',
      'gmtCreate',
      'operateTime',
      'operate_time',
      'updateTime',
      'gmtModified'
    ]) || '';
    const title = String(pickFirstValue(item, [
      'title',
      'action',
      'actionName',
      'action_name',
      'operateTypeDesc',
      'operate_type_desc',
      'typeDesc',
      'type_desc',
      'statusDesc',
      'status_desc'
    ]) || `节点 ${index + 1}`);
    const desc = String(pickFirstValue(item, [
      'desc',
      'description',
      'content',
      'remark',
      'memo',
      'detail'
    ]) || '');
    return { time, title, desc };
  }

  function extractTimelineFromPayload(payload) {
    const arrays = [];
    collectTimelineCandidates(payload, arrays);
    const merged = arrays.flat().slice(0, 30).map(normalizeTimelineItem).filter(item => item.time || item.title || item.desc);
    return merged.slice(0, 16);
  }

  function extractDetailFromPayloads(payloads = [], fallbackRecord) {
    const merged = { raw: fallbackRecord?.raw || {} };
    payloads.forEach((payload, index) => {
      merged[`payload_${index + 1}`] = payload;
    });
    const images = Array.from(new Set([...(fallbackRecord?.images || []), ...payloads.flatMap(p => extractImageUrls(p, 12))])).slice(0, 18);
    const timeline = payloads.flatMap(extractTimelineFromPayload).slice(0, 16);
    return { merged, images, timeline };
  }

  function findMatchedPayloads(record) {
    if (!record?.ticketNo) return [];
    const matches = [];
    const max = Math.min(ticketApiEntries.length, 120);
    for (let i = 0; i < max; i += 1) {
      const entry = ticketApiEntries[i];
      const payload = parseJsonSafely(entry?.responseBody);
      if (!payload) continue;
      const text = stringifySafely(payload, 8000);
      if (!text) continue;
      if (text.includes(String(record.ticketNo)) || (record.orderSn && text.includes(String(record.orderSn)))) {
        matches.push(payload);
      }
      if (matches.length >= 5) break;
    }
    return matches;
  }

  function renderTicketApiDetail() {
    const head = getEl('ticketApiDetailHead');
    const panel = getEl('ticketApiDetailPanel');
    if (!ticketApiActiveDetail?.ticketNo) {
      head.innerHTML = `
        <div class="mail-api-detail-title">请选择一条工单记录</div>
        <div class="mail-api-detail-meta"><span>工单号：-</span><span>提交时间：-</span></div>
      `;
      panel.innerHTML = '<div class="invoice-api-detail-empty">请选择一条工单记录查看详情</div>';
      getEl('ticketApiDetailMeta').textContent = '点击列表中的“立即查看”打开详情';
      return;
    }

    const matchedPayloads = findMatchedPayloads(ticketApiActiveDetail);
    const detail = extractDetailFromPayloads(matchedPayloads, ticketApiActiveDetail);
    const detailImages = detail.images || [];
    const timeline = detail.timeline || [];
    const orderText = ticketApiActiveDetail.orderSn || ticketApiActiveDetail.ticketNo || '-';

    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(ticketApiActiveDetail.questionTitle || ticketApiActiveDetail.ticketType || '工单')}</div>
      <div class="mail-api-detail-meta">
        <span>订单号：${esc(orderText)}</span>
        <span>创建时间：${esc(formatApiDateTime(ticketApiActiveDetail.createTime) || '-')}</span>
      </div>
      <div class="ticket-api-detail-summary">
        <span class="ticket-api-detail-summary-chip">工单号：${esc(ticketApiActiveDetail.ticketNo)}</span>
        <span class="ticket-api-detail-summary-chip">状态：${esc(ticketApiActiveDetail.status || '-')}</span>
        <span class="ticket-api-detail-summary-chip">处理人：${esc(ticketApiActiveDetail.assignee || '-')}</span>
        <span class="ticket-api-detail-summary-chip">问题类型：${esc(ticketApiActiveDetail.ticketType || '-')}</span>
      </div>
    `;

    const baseItems = [
      ['工单号', ticketApiActiveDetail.ticketNo || '-'],
      ['订单号', ticketApiActiveDetail.orderSn || '-'],
      ['问题类型', ticketApiActiveDetail.ticketType || '-'],
      ['工单状态', ticketApiActiveDetail.status || '-'],
      ['处理人', ticketApiActiveDetail.assignee || '-'],
      ['创建时间', formatApiDateTime(ticketApiActiveDetail.createTime) || '-'],
      ['更新时间', formatApiDateTime(ticketApiActiveDetail.updateTime) || '-'],
      ['处理进度', ticketApiActiveDetail.progressText || '-'],
      ['商品信息', ticketApiActiveDetail.goodsName || '-']
    ];

    const questionText = [ticketApiActiveDetail.questionTitle, ticketApiActiveDetail.questionDesc].filter(Boolean).join('\n');

    panel.innerHTML = `
      <div class="ticket-api-detail-section">
        <div class="ticket-api-detail-section-title">基础信息</div>
        <div class="ticket-api-detail-grid">
          ${baseItems.map(([label, value]) => `
            <div class="ticket-api-detail-item">
              <div class="ticket-api-detail-item-label">${esc(label)}</div>
              <div class="ticket-api-detail-item-value">${esc(value)}</div>
            </div>
          `).join('')}
          <div class="ticket-api-detail-item is-full">
            <div class="ticket-api-detail-item-label">问题描述</div>
            <div class="ticket-api-detail-item-value">${esc(questionText || '-')}</div>
          </div>
        </div>
      </div>
      <div class="ticket-api-detail-section">
        <div class="ticket-api-detail-section-title">图片/附件</div>
        ${detailImages.length ? `
          <div class="ticket-api-gallery">
            ${detailImages.map((url, index) => `
              <div class="ticket-api-gallery-item">
                <img class="ticket-api-gallery-image" src="${esc(url)}" alt="">
                <div class="ticket-api-gallery-caption">图片 ${index + 1}</div>
              </div>
            `).join('')}
          </div>
        ` : '<div class="ticket-api-table-meta" style="padding:0 2px 2px;">暂无图片数据（需要确保详情接口抓包已进入记录）</div>'}
      </div>
      <div class="ticket-api-detail-section">
        <div class="ticket-api-detail-section-title">流转记录</div>
        ${timeline.length ? `
          <div class="ticket-api-timeline">
            ${timeline.map(item => `
              <div class="ticket-api-timeline-item">
                <div class="ticket-api-timeline-time">${esc(formatApiDateTime(item.time) || item.time || '-')}</div>
                <div class="ticket-api-timeline-title">${esc(item.title || '-')}</div>
                <div class="ticket-api-timeline-desc">${esc(item.desc || '')}</div>
              </div>
            `).join('')}
          </div>
        ` : '<div class="ticket-api-table-meta" style="padding:0 2px 2px;">暂无流转记录（需要确保详情/流转接口抓包已进入记录）</div>'}
      </div>
      <div class="ticket-api-detail-section">
        <div class="ticket-api-detail-section-title">原始数据</div>
        <div class="ticket-api-raw-block"><pre>${esc(stringifySafely(detail.merged, 20000) || '')}</pre></div>
      </div>
    `;

    getEl('ticketApiDetailMeta').textContent = `已打开记录：${ticketApiActiveDetail.ticketNo}`;
  }

  function renderTicketApiTraffic() {
    const container = getEl('ticketApiTrafficList');
    getEl('ticketApiTrafficSummary').textContent = `${ticketApiEntries.length} 条抓包记录`;
    if (!ticketApiEntries.length) {
      container.innerHTML = '<span class="mail-api-traffic-chip">暂无抓包</span>';
      return;
    }
    container.innerHTML = ticketApiEntries.slice(0, 12).map(entry => {
      const typeTag = getTicketTrafficType(entry);
      const summary = `${typeTag} · ${entry.method || 'GET'} ${entry.url}`;
      return `<span class="mail-api-traffic-chip" title="${esc(summary)}">${esc(summary)}</span>`;
    }).join('');
  }

  function updateTicketApiBannerText() {
    const banner = getEl('ticketApiBannerText');
    if (!banner) return;
    if (!activeShopId) {
      banner.textContent = '当前没有活跃店铺，请先切换店铺后再查看工单管理接口页。';
      return;
    }
    if (!ticketApiEntries.length) {
      banner.textContent = '请先在嵌入网页打开工单管理列表页，再切到接口对接页查看同步结果。';
      return;
    }
    banner.textContent = `已抓取 ${ticketApiEntries.length} 条工单管理相关记录，当前解析出 ${ticketApiList.length} 条工单数据。`;
  }

  function updateTicketUpdatedAt() {
    const el = getEl('ticketApiUpdatedAt');
    if (!el) return;
    const now = new Date();
    const text = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    el.textContent = text;
  }

  function updateDateRangeText() {
    const el = getEl('ticketApiDateRangeText');
    if (!el) return;
    el.textContent = getPresetDateRangeText();
  }

  async function loadTicketApiTraffic(shopId = activeShopId) {
    if (!shopId) {
      ticketApiEntries = [];
      renderTicketApiTraffic();
      updateTicketApiBannerText();
      updateTicketUpdatedAt();
      return;
    }
    const list = await window.pddApi.getApiTraffic({ shopId });
    ticketApiEntries = Array.isArray(list) ? list.slice().reverse().filter(isTicketTrafficEntry) : [];
    renderTicketApiTraffic();
    updateTicketApiBannerText();
    updateTicketUpdatedAt();
  }

  async function loadTicketApiList() {
    ticketApiList = parseTicketRecordsFromTraffic(ticketApiEntries);
    renderTicketFilterOptions();
    renderTicketMetrics();
    renderTicketQuickSummary();
    updateDateRangeText();
    renderTicketApiList();
    updateTicketApiBannerText();
    const visibleList = getTicketVisibleList();
    if (ticketApiActiveId && visibleList.some(item => String(item.ticketNo) === String(ticketApiActiveId))) {
      ticketApiActiveDetail = visibleList.find(item => String(item.ticketNo) === String(ticketApiActiveId)) || ticketApiActiveDetail;
      renderTicketApiList();
      renderTicketApiDetail();
      return;
    }
    if (visibleList[0]?.ticketNo) {
      await openTicketApiDetail(visibleList[0].ticketNo, { skipTraffic: true });
      return;
    }
    ticketApiActiveId = '';
    ticketApiActiveDetail = null;
    renderTicketApiDetail();
  }

  async function openTicketApiDetail(ticketNo, options = {}) {
    if (!ticketNo) return;
    ticketApiActiveId = String(ticketNo);
    ticketApiActiveDetail = ticketApiList.find(item => String(item.ticketNo) === String(ticketNo)) || null;
    renderTicketApiList();
    renderTicketApiDetail();
    if (!options.skipTraffic) {
      await loadTicketApiTraffic();
    }
  }

  function resetTicketApiState() {
    ticketApiEntries = [];
    ticketApiList = [];
    ticketApiKeyword = '';
    ticketApiTypeFilter = '';
    ticketApiStatusFilter = '';
    ticketApiQuickFilter = 'pending';
    ticketApiDatePreset = 'all';
    ticketApiActiveId = '';
    ticketApiActiveDetail = null;
    const keyword = getEl('ticketApiKeyword');
    if (keyword) keyword.value = '';
    ['ticketApiTypeFilter', 'ticketApiStatusFilter'].forEach(id => {
      const element = getEl(id);
      if (element) element.value = '';
    });
    getEl('ticketApiDatePreset').value = 'all';
    renderTicketFilterOptions();
    renderTicketMetrics();
    renderTicketQuickSummary();
    updateDateRangeText();
    renderTicketApiList();
    renderTicketApiDetail();
    renderTicketApiTraffic();
    updateTicketApiBannerText();
    updateTicketUpdatedAt();
  }

  async function loadTicketApiView() {
    await refreshShopContext();
    if (!activeShopId) {
      resetTicketApiState();
      return;
    }
    await loadTicketApiTraffic(activeShopId);
    await loadTicketApiList();
  }

  function bindTicketApiModule() {
    if (initialized) return;
    initialized = true;
    updateDateRangeText();
    getEl('btnTicketApiOpenDebug')?.addEventListener('click', async () => {
      const result = await window.pddApi.openDebugWindow();
      if (result?.error) addLog(`打开调试面板失败: ${result.error}`, 'error');
    });
    getEl('btnTicketApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnTicketApiReloadTraffic')?.addEventListener('click', async () => {
      await loadTicketApiTraffic();
      await loadTicketApiList();
      addLog('已刷新工单管理抓包记录', 'info');
    });
    getEl('btnTicketApiRefreshList')?.addEventListener('click', async () => {
      await loadTicketApiTraffic();
      await loadTicketApiList();
      addLog('已刷新工单管理列表', 'info');
    });
    getEl('btnTicketApiClearTraffic')?.addEventListener('click', async () => {
      const shopId = activeShopId || API_ALL_SHOPS;
      await window.pddApi.clearApiTraffic({ shopId });
      await loadTicketApiTraffic();
      await loadTicketApiList();
      addLog('已清空当前范围的工单管理抓包记录', 'info');
    });
    getEl('btnTicketApiBackToTicket')?.addEventListener('click', () => switchView('ticket'));
    getEl('btnTicketApiApplyFilters')?.addEventListener('click', async () => {
      ticketApiKeyword = getEl('ticketApiKeyword').value || '';
      await loadTicketApiList();
    });
    getEl('btnTicketApiResetFilters')?.addEventListener('click', async () => {
      ticketApiKeyword = '';
      ticketApiTypeFilter = '';
      ticketApiStatusFilter = '';
      ticketApiQuickFilter = 'pending';
      ticketApiDatePreset = 'all';
      const keyword = getEl('ticketApiKeyword');
      if (keyword) keyword.value = '';
      ['ticketApiTypeFilter', 'ticketApiStatusFilter'].forEach(id => {
        const element = getEl(id);
        if (element) element.value = '';
      });
      getEl('ticketApiDatePreset').value = 'all';
      renderTicketQuickSummary();
      updateDateRangeText();
      await loadTicketApiList();
    });
    document.querySelectorAll('[data-ticket-quick]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextFilter = button.dataset.ticketQuick || 'pending';
        if (nextFilter === ticketApiQuickFilter) return;
        ticketApiQuickFilter = nextFilter;
        renderTicketQuickSummary();
        await loadTicketApiList();
      });
    });
    getEl('ticketApiTypeFilter')?.addEventListener('change', async event => {
      ticketApiTypeFilter = event.target.value || '';
      await loadTicketApiList();
    });
    getEl('ticketApiStatusFilter')?.addEventListener('change', async event => {
      ticketApiStatusFilter = event.target.value || '';
      await loadTicketApiList();
    });
    getEl('ticketApiDatePreset')?.addEventListener('change', async event => {
      ticketApiDatePreset = event.target.value || 'all';
      updateDateRangeText();
      await loadTicketApiList();
    });
    getEl('ticketApiKeyword')?.addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      ticketApiKeyword = getEl('ticketApiKeyword').value || '';
      await loadTicketApiList();
    });
  }

  window.loadTicketApiView = loadTicketApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('ticket-api-module', bindTicketApiModule);
  } else {
    bindTicketApiModule();
  }
})();
