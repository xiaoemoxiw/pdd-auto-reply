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
  let ticketApiDetailLoading = false;
  let ticketApiDetailError = '';
  let ticketApiPageMode = 'list';
  let ticketApiActiveLogisticsTab = 'outbound';

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

  function isFilledValue(value) {
    if (value === 0 || value === false) return true;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && String(value).trim() !== '';
  }

  function normalizeTicketFieldValue(value) {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value)) {
      return value.map(normalizeTicketFieldValue).filter(Boolean).join('、');
    }
    if (typeof value === 'object') {
      return Object.values(value).map(normalizeTicketFieldValue).filter(Boolean).join(' · ');
    }
    if (typeof value === 'boolean') return value ? '是' : '否';
    return String(value).trim();
  }

  function formatTicketAmount(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const amount = Number(text);
    if (!Number.isFinite(amount)) return text;
    const normalized = text.includes('.') ? amount : amount / 100;
    return `¥${normalized.toFixed(2)}`;
  }

  function buildTicketInfoGroup(title, items = []) {
    const list = items
      .map(([label, value]) => ({ label, value: normalizeTicketFieldValue(value) }))
      .filter(item => isFilledValue(item.value));
    return list.length ? { title, items: list } : null;
  }

  function resolveTicketDetailRequestId(source = {}) {
    const directValue = pickFirstValue(source, [
      'detailRequestId',
      'detail_request_id',
      'instanceId',
      'instance_id',
      'todoId',
      'todo_id',
      'id',
      'workOrderId',
      'work_order_id',
      'workOrderSn',
      'work_order_sn',
      'ticketId',
      'ticket_id',
      'ticketSn',
      'ticket_sn',
      'taskId',
      'task_id'
    ]);
    if (directValue) return String(directValue);
    if (source?.raw && source.raw !== source) {
      const rawValue = pickFirstValue(source.raw, [
        'instanceId',
        'instance_id',
        'todoId',
        'todo_id',
        'id',
        'workOrderId',
        'work_order_id',
        'workOrderSn',
        'work_order_sn',
        'ticketId',
        'ticket_id',
        'ticketSn',
        'ticket_sn',
        'taskId',
        'task_id'
      ]);
      if (rawValue) return String(rawValue);
    }
    return '';
  }

  function normalizeTicketItemList(list = []) {
    if (!Array.isArray(list)) return [];
    return list.map(item => {
      const urls = Array.isArray(item?.urls)
        ? item.urls.map(normalizeImageUrl).filter(Boolean)
        : [];
      const value = normalizeTicketFieldValue(item?.value) || (urls.length ? `${urls.length}张图片凭证` : '');
      return {
        type: Number(item?.type || 0) || 0,
        key: normalizeTicketFieldValue(item?.key) || '补充信息',
        value,
        urls
      };
    }).filter(item => item.key || item.value || item.urls.length);
  }

  function normalizeTicketFlowList(flowList = []) {
    if (!Array.isArray(flowList)) return [];
    return flowList.map((item, index) => {
      const itemList = normalizeTicketItemList(item?.itemList);
      const images = Array.from(new Set(itemList.flatMap(entry => entry.urls || []))).filter(Boolean);
      return {
        title: normalizeTicketFieldValue(item?.title) || `节点 ${index + 1}`,
        content: normalizeTicketFieldValue(item?.content),
        operatorName: normalizeTicketFieldValue(item?.operatorName),
        createdAt: item?.createdAt || '',
        itemList,
        images
      };
    }).filter(item => item.title || item.content || item.itemList.length || item.images.length);
  }

  function collectTicketFlowFields(flowList = []) {
    return flowList.flatMap(item => item?.itemList || []);
  }

  function normalizeTicketApiRemoteDetail(detail = {}, fallbackRecord = {}, requestInstanceId = '') {
    const todoDetail = detail?.todoDetail && typeof detail.todoDetail === 'object' ? detail.todoDetail : {};
    const flowList = normalizeTicketFlowList(todoDetail.flowList);
    const flowFields = collectTicketFlowFields(flowList);
    const currentFlow = flowList[0] || null;
    const firstFlow = flowList[flowList.length - 1] || null;
    const receiverFields = flowFields.filter(item => /手机|电话|收货|地址|联系人|姓名/.test(`${item.key} ${item.value}`));
    const logisticsFields = flowFields.filter(item => /物流|运单|快递|签收|揽收|轨迹|逆向|取件/.test(`${item.key} ${item.value}`));
    const ticketNo = String(requestInstanceId || detail?.instanceId || detail?.todoId || fallbackRecord.instanceId || fallbackRecord.ticketNo || '');
    const statusCode = Number(detail?.status ?? fallbackRecord.statusCode ?? 0) || 0;
    const statusText = mapTicketStatusCode(detail?.status ?? fallbackRecord.statusCode ?? fallbackRecord.status);
    const questionTitle = String(detail?.problemTitle || fallbackRecord.questionTitle || fallbackRecord.ticketType || '工单');
    const questionDesc = [
      normalizeTicketFieldValue(todoDetail?.externalDetail),
      firstFlow?.title && firstFlow.title !== questionTitle ? firstFlow.title : '',
      normalizeTicketFieldValue(firstFlow?.content),
      normalizeTicketFieldValue(fallbackRecord.questionDesc)
    ].filter(Boolean).join('\n');
    const images = Array.from(new Set([
      normalizeImageUrl(detail?.thumbUrl),
      ...(fallbackRecord.images || []),
      ...extractImageUrls(detail, 18),
      ...flowList.flatMap(item => item.images || [])
    ])).filter(Boolean).slice(0, 18);
    return {
      ticketNo: ticketNo || String(fallbackRecord.ticketNo || ''),
      instanceId: ticketNo || String(fallbackRecord.instanceId || ''),
      detailRequestId: String(requestInstanceId || resolveTicketDetailRequestId(detail) || fallbackRecord.detailRequestId || ''),
      orderSn: String(detail?.orderSn || fallbackRecord.orderSn || ''),
      ticketType: String(fallbackRecord.ticketType || questionTitle),
      questionTitle,
      questionDesc,
      goodsName: String(detail?.goodsName || fallbackRecord.goodsName || ''),
      createTime: fallbackRecord.createTime || '',
      updateTime: currentFlow?.createdAt || fallbackRecord.updateTime || '',
      status: statusText || fallbackRecord.status || '待处理',
      statusCode,
      assignee: String(currentFlow?.operatorName || fallbackRecord.assignee || '-'),
      progressText: String(
        todoDetail?.externalDisplayTaskName
        || todoDetail?.manualTaskName
        || currentFlow?.title
        || fallbackRecord.progressText
        || statusText
        || '-'
      ),
      images,
      detailImages: images,
      goodsThumb: normalizeImageUrl(detail?.thumbUrl) || images[0] || '',
      goodsSpec: normalizeTicketFieldValue(detail?.spec),
      goodsNumber: normalizeTicketFieldValue(detail?.goodsNumber),
      goodsPriceText: formatTicketAmount(detail?.goodsPrice),
      merchantAmountText: formatTicketAmount(detail?.merchantAmount),
      orderStatus: normalizeTicketFieldValue(detail?.orderStatusStr),
      flowList,
      orderInfo: buildTicketInfoGroup('订单信息', [
        ['订单号', detail?.orderSn || fallbackRecord.orderSn],
        ['订单状态', detail?.orderStatusStr],
        ['商品规格', detail?.spec],
        ['商品数量', detail?.goodsNumber],
        ['商品单价', formatTicketAmount(detail?.goodsPrice)],
        ['实收金额', formatTicketAmount(detail?.merchantAmount)]
      ]),
      afterSalesInfo: buildTicketInfoGroup('售后信息', [
        ['售后单号', detail?.afterSalesId],
        ['售后状态', detail?.afterSalesStatusDesc || detail?.afterSalesStatus],
        ['售后类型', detail?.afterSalesTypeDesc || detail?.afterSalesType],
        ['退款金额', formatTicketAmount(detail?.refundAmount)]
      ]),
      receiverInfo: buildTicketInfoGroup('收货信息', receiverFields.map(item => [item.key, item.value])),
      logisticsInfo: buildTicketInfoGroup('物流信息', [
        ['逆向物流单号', detail?.reverseShippingId],
        ['逆向运单号', detail?.reverseTrackingNumber],
        ...logisticsFields.map(item => [item.key, item.value])
      ]),
      serviceInfo: buildTicketInfoGroup('服务信息', [
        ['服务域', todoDetail?.serviceDomain ?? detail?.serviceDomain],
        ['当前节点截止时间', formatApiDateTime(todoDetail?.curStepDeadline) || ''],
        ['处理完成', todoDetail?.finished === undefined ? '' : (todoDetail.finished ? '是' : '否')],
        ['处理角色', todoDetail?.handlerRole],
        ['展示标签', Array.isArray(todoDetail?.displayTag) ? todoDetail.displayTag.join('、') : ''],
        ['一键关闭', todoDetail?.showOneClickClose === undefined ? '' : (todoDetail.showOneClickClose ? '是' : '否')]
      ]),
      raw: detail
    };
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
      detailRequestId: String(item.instanceId || item.todoId || item.id || ''),
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
      detailRequestId: resolveTicketDetailRequestId(item),
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

  function mergeTicketDetailRecord(base = {}, extra = {}) {
    const merged = { ...base, ...extra };
    Object.keys(base).forEach(key => {
      if (!isFilledValue(merged[key]) && isFilledValue(base[key])) {
        merged[key] = base[key];
      }
    });
    Object.keys(extra).forEach(key => {
      if (Array.isArray(extra[key])) {
        merged[key] = extra[key].length ? extra[key] : (Array.isArray(base[key]) ? base[key] : []);
      }
    });
    merged.raw = extra.raw || base.raw || {};
    return merged;
  }

  function upsertTicketApiListItem(record = {}) {
    const recordId = String(record.ticketNo || record.instanceId || '');
    if (!recordId) return;
    const index = ticketApiList.findIndex(item => String(item.ticketNo || item.instanceId || '') === recordId);
    if (index === -1) return;
    ticketApiList[index] = mergeTicketDetailRecord(ticketApiList[index], record);
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

  function normalizeTicketApiRemoteList(list = []) {
    return dedupeTicketList(list.map((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && ('instanceId' in item || 'problemTitle' in item || 'externalDisplayName' in item)) {
        return normalizeTodoListItem(item, index);
      }
      return normalizeTicketRecord(item, index);
    }));
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
    getEl('ticketApiListStatus').textContent = filterLabels.length ? filterLabels.join(' · ') : '当前展示工单管理接口返回结果';

    if (!visibleList.length) {
      container.innerHTML = '<div class="ticket-api-list-empty">当前没有工单记录，可直接刷新列表重试。</div>';
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
      return `${text.slice(0, limit)}\n...（已截断）`;
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

  function renderTicketInfoGroup(group) {
    if (!group?.items?.length) return '';
    return `
      <div class="ticket-api-side-card">
        <div class="ticket-api-side-card-title">${esc(group.title)}</div>
        <div class="ticket-api-side-list">
          ${group.items.map(item => `
            <div class="ticket-api-side-list-item">
              <div class="ticket-api-side-list-label">${esc(item.label)}</div>
              <div class="ticket-api-side-list-value">${esc(item.value || '-')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function maskPhoneNumber(value = '') {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 7) return String(value || '');
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }

  function parseTicketNamePhone(text = '') {
    const source = String(text || '');
    const match = source.match(/【([^：:】]+)[：:]\s*(1\d{10})】/);
    if (match) {
      return { name: match[1], phone: match[2] };
    }
    const phoneMatch = source.match(/(1\d{10})/);
    if (!phoneMatch) return { name: '', phone: '' };
    const leftText = source.slice(0, phoneMatch.index).replace(/[【】:\s：]/g, ' ').trim();
    const name = leftText.split(/\s+/).filter(Boolean).slice(-1)[0] || '';
    return { name, phone: phoneMatch[1] };
  }

  function buildTicketReceiverSummary(detail = {}) {
    const fields = collectTicketFlowFields(detail.flowList || []);
    const receiverItems = fields.filter(item => /联系人|姓名|收货人|手机|电话|地址|代收点|联系地址|自取地址/.test(`${item.key} ${item.value}`));
    const combinedText = receiverItems.map(item => `${item.key} ${item.value || ''}`).join('\n');
    const parsed = parseTicketNamePhone(combinedText);
    const nameField = receiverItems.find(item => /联系人|姓名|收货人/.test(item.key));
    const phoneField = receiverItems.find(item => /手机|电话/.test(item.key));
    const addressField = receiverItems.find(item => /地址|代收点|联系地址|自取地址/.test(item.key));
    const addressText = normalizeTicketFieldValue(addressField?.value || combinedText.match(/(?:签收代收点|联系地址|收货地址|地址)[：:]\s*([^\n。]+)/)?.[1] || '');
    return {
      alertText: '通过拨打隐私号等方式尝试获取用户联系方式无效时，请按平台要求联系可触达的第三方后继续处理。',
      receiverName: normalizeTicketFieldValue(nameField?.value || parsed.name || ''),
      receiverPhone: normalizeTicketFieldValue(phoneField?.value || parsed.phone || ''),
      receiverPhoneMasked: maskPhoneNumber(phoneField?.value || parsed.phone || ''),
      receiverAddress: addressText || normalizeTicketFieldValue(addressField?.value || ''),
      rawText: combinedText
    };
  }

  function buildTicketAfterSalesSummary(detail = {}) {
    const group = detail.afterSalesInfo;
    if (!group?.items?.length) return { empty: true, items: [] };
    return { empty: false, items: group.items };
  }

  function buildTicketLogisticsTabs(detail = {}) {
    const fields = collectTicketFlowFields(detail.flowList || []);
    const logisticsItems = fields.filter(item => /物流|运单|快递|签收|揽收|轨迹|取件|送达|发货|退货|逆向|自取/.test(`${item.key} ${item.value}`));
    const shippingNotes = logisticsItems.length
      ? logisticsItems.map(item => `${item.key}：${item.value || '-'}`)
      : (detail.flowList || []).flatMap(item => {
        const lines = [];
        if (item.title) lines.push(item.title);
        (item.itemList || []).forEach(field => {
          if (field.key || field.value) lines.push(`${field.key || '信息'}：${field.value || '-'}`);
        });
        return lines;
      }).slice(0, 6);
    const outboundTab = {
      key: 'outbound',
      label: '发货物流',
      trackingNo: '',
      notes: shippingNotes,
      footerText: detail.updateTime ? formatApiDateTime(detail.updateTime) : ''
    };
    const reverseTrackingNo = normalizeTicketFieldValue(detail.raw?.reverseTrackingNumber || detail.reverseTrackingNumber || '');
    const reverseShippingId = normalizeTicketFieldValue(detail.raw?.reverseShippingId || detail.reverseShippingId || '');
    const reverseNotes = [];
    if (reverseShippingId) reverseNotes.push(`逆向物流单号：${reverseShippingId}`);
    if (reverseTrackingNo) reverseNotes.push(`逆向运单号：${reverseTrackingNo}`);
    const tabs = [outboundTab];
    if (reverseNotes.length) {
      tabs.push({
        key: 'reverse',
        label: '退货物流',
        trackingNo: reverseTrackingNo,
        notes: reverseNotes,
        footerText: ''
      });
    } else {
      tabs.push({
        key: 'reverse',
        label: '退货物流',
        trackingNo: '',
        notes: ['暂无退货物流信息'],
        footerText: ''
      });
    }
    return tabs;
  }

  function classifyTicketProgressField(field = {}) {
    const key = String(field.key || '');
    const value = String(field.value || '');
    const text = `${key} ${value}`;
    if (Array.isArray(field.urls) && field.urls.length) return 'proof';
    if (/凭证|截图|图片|照片/.test(text)) return 'proof';
    if (/话术|发送话术|回复内容|联系内容/.test(text)) return 'script';
    if (/地址|代收点|联系地址|收货地址|自取地址/.test(text)) return 'address';
    if (/物流|运单|快递|签收|揽收|轨迹|取件|送达|发货|退货|逆向/.test(text)) return 'logistics';
    if (/货物情况|情况确认|处理结果|凭证发送情况|处理方案|核实结果/.test(text)) return 'status';
    return 'general';
  }

  function groupTicketProgressFields(fields = []) {
    return fields.reduce((acc, field) => {
      const type = classifyTicketProgressField(field);
      if (!acc[type]) acc[type] = [];
      acc[type].push(field);
      return acc;
    }, {});
  }

  function renderTicketProgressFieldRow(field = {}) {
    const label = esc(field.key || '-');
    const value = esc(field.value || '-');
    return `<div class="ticket-api-progress-row"><span class="ticket-api-progress-row-label">${label}</span><span class="ticket-api-progress-row-value">${value}</span></div>`;
  }

  function renderTicketProgressGroup(title, fields = []) {
    if (!fields.length) return '';
    return `
      <div class="ticket-api-progress-group">
        <div class="ticket-api-progress-group-title">${esc(title)}</div>
        <div class="ticket-api-progress-group-body">
          ${fields.map(renderTicketProgressFieldRow).join('')}
        </div>
      </div>
    `;
  }

  function renderTicketProgressProofGroup(fields = []) {
    if (!fields.length) return '';
    return `
      <div class="ticket-api-progress-group">
        <div class="ticket-api-progress-group-title">联系凭证</div>
        <div class="ticket-api-progress-group-body">
          ${fields.map(field => `
            ${field.value ? renderTicketProgressFieldRow(field) : ''}
            ${field.urls?.length ? `
              <div class="ticket-api-progress-image-list">
                ${field.urls.map(url => `<img class="ticket-api-progress-image" src="${esc(url)}" alt="">`).join('')}
              </div>
            ` : ''}
          `).join('')}
        </div>
      </div>
    `;
  }

  function setTicketApiPageMode(mode, options = {}) {
    ticketApiPageMode = mode === 'detail' ? 'detail' : 'list';
    getEl('ticketApiPageRoot')?.classList.toggle('is-detail-mode', ticketApiPageMode === 'detail');
    getEl('ticketApiPageRoot')?.classList.toggle('is-list-mode', ticketApiPageMode !== 'detail');
    if (options.scroll === false) return;
    const targetId = ticketApiPageMode === 'detail' ? 'ticketApiDetailShell' : 'ticketApiListSection';
    getEl(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderTicketFlowList(flowList = []) {
    if (!flowList.length) {
      return '<div class="ticket-api-empty-note">暂无服务进度记录</div>';
    }
    return `
      <div class="ticket-api-progress-list">
        ${flowList.map((item, index) => `
          <div class="ticket-api-progress-item ${index === 0 ? 'is-current' : ''}">
            <div class="ticket-api-progress-point"></div>
            <div class="ticket-api-progress-body">
              <div class="ticket-api-progress-time">${esc(formatApiDateTime(item.createdAt) || '-')}</div>
              <div class="ticket-api-progress-title">${esc(item.title || '-')}</div>
              ${item.content ? `<div class="ticket-api-progress-content">${esc(item.content)}</div>` : ''}
              ${item.itemList.length ? (() => {
                const groups = groupTicketProgressFields(item.itemList);
                return `
                  <div class="ticket-api-progress-fields">
                    ${renderTicketProgressGroup('处理结果', groups.status || [])}
                    ${renderTicketProgressGroup('联系地址', groups.address || [])}
                    ${renderTicketProgressGroup('物流说明', groups.logistics || [])}
                    ${renderTicketProgressGroup('发送话术', groups.script || [])}
                    ${renderTicketProgressGroup('补充信息', groups.general || [])}
                    ${renderTicketProgressProofGroup(groups.proof || [])}
                  </div>
                `;
              })() : ''}
              <div class="ticket-api-progress-meta">
                <span>处理人：${esc(item.operatorName || '-')}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function copyTicketDetailText(text, successText = '已复制') {
    const content = String(text || '').trim();
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      if (typeof window.showToast === 'function') {
        window.showToast(successText);
      }
    } catch {
      if (typeof window.showToast === 'function') {
        window.showToast('复制失败，请稍后重试');
      }
    }
  }

  function bindTicketDetailActions(container) {
    if (!container) return;
    container.querySelectorAll('[data-ticket-copy]').forEach(button => {
      button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await copyTicketDetailText(button.dataset.ticketCopy, button.dataset.ticketCopySuccess || '已复制');
      });
    });
    container.querySelectorAll('[data-ticket-logistics-tab]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const tabKey = button.dataset.ticketLogisticsTab || 'outbound';
        if (tabKey === ticketApiActiveLogisticsTab) return;
        ticketApiActiveLogisticsTab = tabKey;
        renderTicketApiDetail();
      });
    });
  }

  function renderTicketDetailReceiver(summary = {}) {
    const displayName = summary.receiverName || '-';
    const displayPhone = summary.receiverPhoneMasked || summary.receiverPhone || '-';
    const rawPhone = summary.receiverPhone || '';
    const displayAddress = summary.receiverAddress || '暂无联系地址信息';
    return `
      <div class="ticket-api-side-card">
        <div class="ticket-api-side-card-title">收货信息</div>
        <div class="ticket-api-side-alert">${esc(summary.alertText || '请核对收货信息后继续处理')}</div>
        <div class="ticket-api-kv-card">
          <div class="ticket-api-kv-row">
            <span class="ticket-api-kv-label">收货人</span>
            <span class="ticket-api-kv-value">${esc(displayName)}</span>
          </div>
          <div class="ticket-api-kv-row">
            <span class="ticket-api-kv-label">手机号</span>
            <span class="ticket-api-kv-value">
              ${esc(displayPhone)}
              ${rawPhone ? `<button class="ticket-api-inline-button" data-ticket-copy="${esc(rawPhone)}" data-ticket-copy-success="手机号已复制">查看手机号</button>` : ''}
            </span>
          </div>
          <div class="ticket-api-kv-row is-block">
            <span class="ticket-api-kv-label">联系地址</span>
            <span class="ticket-api-kv-value">
              ${esc(displayAddress)}
              ${summary.receiverAddress ? `<button class="ticket-api-inline-button" data-ticket-copy="${esc(summary.receiverAddress)}" data-ticket-copy-success="地址已复制">查看姓名和地址</button>` : ''}
            </span>
          </div>
        </div>
      </div>
    `;
  }

  function renderTicketDetailAfterSales(summary = {}) {
    if (summary.empty) {
      return `
        <div class="ticket-api-side-card">
          <div class="ticket-api-side-card-title">售后信息</div>
          <div class="ticket-api-side-empty">暂无售后信息</div>
        </div>
      `;
    }
    return renderTicketInfoGroup({ title: '售后信息', items: summary.items });
  }

  function renderTicketDetailLogistics(tabs = []) {
    const normalizedTabs = tabs.length ? tabs : [{ key: 'outbound', label: '发货物流', notes: ['暂无物流信息'] }];
    const activeTab = normalizedTabs.find(tab => tab.key === ticketApiActiveLogisticsTab) || normalizedTabs[0];
    return `
      <div class="ticket-api-side-card">
        <div class="ticket-api-side-card-title">物流轨迹</div>
        <div class="ticket-api-logistics-tabs">
          ${normalizedTabs.map(tab => `
            <button
              class="ticket-api-logistics-tab ${tab.key === activeTab.key ? 'active' : ''}"
              type="button"
              data-ticket-logistics-tab="${esc(tab.key)}"
            >${esc(tab.label)}</button>
          `).join('')}
        </div>
        <div class="ticket-api-logistics-body">
          <div class="ticket-api-logistics-number">
            物流信息：${esc(activeTab.trackingNo || '暂无运单号')}
            ${activeTab.trackingNo ? `<button class="ticket-api-inline-button" data-ticket-copy="${esc(activeTab.trackingNo)}" data-ticket-copy-success="物流单号已复制">复制</button>` : ''}
          </div>
          <div class="ticket-api-logistics-note">
            ${activeTab.notes.map(item => `<div>${esc(item)}</div>`).join('')}
          </div>
          ${activeTab.footerText ? `<div class="ticket-api-logistics-footer">${esc(activeTab.footerText)}</div>` : ''}
        </div>
      </div>
    `;
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
      getEl('ticketApiDetailMeta').textContent = '点击列表中的“立即查看”打开详情页';
      return;
    }

    if (ticketApiDetailLoading) {
      head.innerHTML = `
        <div class="mail-api-detail-title">${esc(ticketApiActiveDetail.questionTitle || ticketApiActiveDetail.ticketType || '工单')}</div>
        <div class="mail-api-detail-meta">
          <span>工单号：${esc(ticketApiActiveDetail.ticketNo || '-')}</span>
          <span>订单号：${esc(ticketApiActiveDetail.orderSn || '-')}</span>
        </div>
      `;
      panel.innerHTML = '<div class="invoice-api-detail-empty">正在加载工单详情接口数据...</div>';
      getEl('ticketApiDetailMeta').textContent = `正在加载：${ticketApiActiveDetail.ticketNo}`;
      return;
    }

    const matchedPayloads = findMatchedPayloads(ticketApiActiveDetail);
    const detail = extractDetailFromPayloads(matchedPayloads, ticketApiActiveDetail);
    const flowList = Array.isArray(ticketApiActiveDetail.flowList) ? ticketApiActiveDetail.flowList : [];
    const orderText = ticketApiActiveDetail.orderSn || ticketApiActiveDetail.ticketNo || '-';
    const ticketFinished = Boolean(ticketApiActiveDetail.raw?.todoDetail?.finished) || isTicketClosed(ticketApiActiveDetail.status || '');
    const processLabel = Number(ticketApiActiveDetail.raw?.todoDetail?.serviceDomain ?? ticketApiActiveDetail.serviceDomain ?? 0) === 1 ? '平台处理' : '商家处理';
    const receiverSummary = buildTicketReceiverSummary(ticketApiActiveDetail);
    const afterSalesSummary = buildTicketAfterSalesSummary(ticketApiActiveDetail);
    const logisticsTabs = buildTicketLogisticsTabs(ticketApiActiveDetail);
    const serviceInfoGroup = ticketApiActiveDetail.serviceInfo;
    const orderInfoGroup = ticketApiActiveDetail.orderInfo;
    const goodsTitle = ticketApiActiveDetail.goodsName || ticketApiActiveDetail.questionTitle || '工单';

    head.innerHTML = `
      <div class="ticket-api-detail-topline">
        <span class="ticket-api-detail-state ${ticketFinished ? 'is-finished' : 'is-pending'}">${ticketFinished ? '[已完结]' : '[处理中]'}</span>
        <span class="ticket-api-detail-topic">${esc(ticketApiActiveDetail.questionTitle || ticketApiActiveDetail.ticketType || '工单')}</span>
        <span class="ticket-api-detail-origin">${esc(processLabel)}</span>
      </div>
      <div class="ticket-api-detail-submeta">
        <span>工单号：${esc(ticketApiActiveDetail.ticketNo || '-')}</span>
        <span>订单号：${esc(orderText)}</span>
        <span>创建时间：${esc(formatApiDateTime(ticketApiActiveDetail.createTime) || '-')}</span>
      </div>
    `;

    panel.innerHTML = `
      <div class="ticket-api-detail-scene">
        <div class="ticket-api-detail-left">
          ${ticketApiDetailError ? `<div class="ticket-api-detail-error">${esc(ticketApiDetailError)}</div>` : ''}
          <section class="ticket-api-detail-card">
            <div class="ticket-api-detail-card-title">服务进度</div>
            ${renderTicketFlowList(flowList.length ? flowList : detail.timeline.map(item => ({
              createdAt: item.time,
              title: item.title,
              content: item.desc,
              operatorName: '',
              itemList: [],
              images: []
            })))}
          </section>
        </div>
        <aside class="ticket-api-detail-right">
          <div class="ticket-api-side-card">
            <div class="ticket-api-side-card-title">订单信息</div>
            <div class="ticket-api-order-hero">
              <div class="ticket-api-order-hero-meta">
                <span>订单编号：${esc(orderText)}</span>
                ${ticketApiActiveDetail.orderSn ? `<button class="ticket-api-inline-button" data-ticket-copy="${esc(ticketApiActiveDetail.orderSn)}" data-ticket-copy-success="订单号已复制">复制</button>` : ''}
              </div>
              <div class="ticket-api-order-hero-content">
                ${ticketApiActiveDetail.goodsThumb ? `<img class="ticket-api-order-hero-image" src="${esc(ticketApiActiveDetail.goodsThumb)}" alt="">` : '<div class="ticket-api-order-hero-image is-placeholder">暂无商品图</div>'}
                <div class="ticket-api-order-hero-body">
                  <div class="ticket-api-order-hero-title">${esc(goodsTitle)}</div>
                  ${ticketApiActiveDetail.goodsSpec ? `<div class="ticket-api-order-hero-spec">${esc(ticketApiActiveDetail.goodsSpec)}</div>` : ''}
                  <div class="ticket-api-order-hero-status">
                    ${ticketApiActiveDetail.orderStatus ? `<span class="ticket-api-order-status">${esc(ticketApiActiveDetail.orderStatus)}</span>` : ''}
                    ${ticketApiActiveDetail.goodsNumber ? `<span>数量：x${esc(ticketApiActiveDetail.goodsNumber)}</span>` : ''}
                  </div>
                  <div class="ticket-api-order-hero-price">
                    <span>${esc(ticketApiActiveDetail.goodsPriceText || '-')}</span>
                    <span>${esc(ticketApiActiveDetail.merchantAmountText ? `实收：${ticketApiActiveDetail.merchantAmountText}` : '')}</span>
                  </div>
                </div>
              </div>
              ${orderInfoGroup ? `<div class="ticket-api-order-hero-extra">${orderInfoGroup.items.map(item => `<span>${esc(item.label)}：${esc(item.value)}</span>`).join('')}</div>` : ''}
            </div>
          </div>
          ${renderTicketDetailAfterSales(afterSalesSummary)}
          ${renderTicketDetailReceiver(receiverSummary)}
          ${renderTicketDetailLogistics(logisticsTabs)}
          ${serviceInfoGroup ? renderTicketInfoGroup(serviceInfoGroup) : ''}
        </aside>
      </div>
    `;

    bindTicketDetailActions(panel);
    getEl('ticketApiDetailMeta').textContent = `已打开记录：${ticketApiActiveDetail.ticketNo}`;
  }

  function renderTicketApiTraffic() {
    const container = getEl('ticketApiTrafficList');
    const summary = getEl('ticketApiTrafficSummary');
    if (!container || !summary) return;
    summary.textContent = `${ticketApiEntries.length} 条抓包记录`;
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
    if (!ticketApiList.length) {
      banner.textContent = '正在加载工单列表，请稍候。';
      return;
    }
    banner.textContent = `已加载 ${ticketApiList.length} 条工单数据，点击“立即查看”进入详情页。`;
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

  async function renderTicketApiState() {
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
      setTicketApiPageMode(ticketApiPageMode, { scroll: false });
      return;
    }
    ticketApiActiveId = '';
    ticketApiActiveDetail = null;
    setTicketApiPageMode('list', { scroll: false });
    renderTicketApiDetail();
  }

  async function loadTicketApiList(options = {}) {
    let remoteLoaded = false;
    let remoteError = '';
    if (activeShopId && typeof window.pddApi.ticketGetList === 'function') {
      const result = await window.pddApi.ticketGetList({
        shopId: activeShopId,
        pageNo: 1,
        pageSize: 100
      });
      if (result && !result.error) {
        ticketApiList = normalizeTicketApiRemoteList(Array.isArray(result.list) ? result.list : []);
        remoteLoaded = true;
      } else {
        remoteError = result?.error || '加载工单管理列表失败';
      }
    }
    if (!remoteLoaded) {
      ticketApiList = parseTicketRecordsFromTraffic(ticketApiEntries);
      if (remoteError && options.silentError !== true) {
        addLog(`${remoteError}，已回退到抓包解析结果`, 'error');
      }
    }
    await renderTicketApiState();
  }

  async function openTicketApiDetail(ticketNo, options = {}) {
    if (!ticketNo) return;
    ticketApiActiveId = String(ticketNo);
    ticketApiActiveDetail = ticketApiList.find(item => String(item.ticketNo) === String(ticketNo)) || null;
    ticketApiActiveLogisticsTab = 'outbound';
    setTicketApiPageMode('detail');
    const baseRecord = ticketApiList.find(item => String(item.ticketNo) === String(ticketNo)) || ticketApiActiveDetail;
    const detailRequestId = resolveTicketDetailRequestId(baseRecord || {});
    ticketApiDetailLoading = Boolean(baseRecord && activeShopId && detailRequestId && typeof window.pddApi.ticketGetDetail === 'function');
    ticketApiDetailError = '';
    renderTicketApiList();
    renderTicketApiDetail();
    if (!options.skipTraffic) {
      await loadTicketApiTraffic();
    }
    if (!baseRecord) {
      ticketApiDetailLoading = false;
      renderTicketApiDetail();
      return;
    }
    if (!detailRequestId) {
      ticketApiDetailLoading = false;
      ticketApiDetailError = '该记录缺少详情实例 ID，已先展示列表基础信息';
      renderTicketApiDetail();
      return;
    }
    if (!activeShopId || typeof window.pddApi.ticketGetDetail !== 'function') {
      ticketApiDetailLoading = false;
      renderTicketApiDetail();
      return;
    }
    const activeIdAtRequest = ticketApiActiveId;
    try {
      const result = await window.pddApi.ticketGetDetail({
        shopId: activeShopId,
        detailRequestId,
        instanceId: detailRequestId,
        ticketNo: baseRecord.ticketNo
      });
      if (ticketApiActiveId !== activeIdAtRequest) return;
      if (result && !result.error && result.detail) {
        const normalizedDetail = normalizeTicketApiRemoteDetail(result.detail, baseRecord, result.instanceId || baseRecord.instanceId || baseRecord.ticketNo);
        const mergedDetail = mergeTicketDetailRecord(baseRecord, normalizedDetail);
        ticketApiActiveDetail = mergedDetail;
        upsertTicketApiListItem(mergedDetail);
      } else if (result?.error) {
        ticketApiDetailError = result.error;
      } else {
        ticketApiDetailError = '工单详情接口未返回可识别的详情数据';
      }
    } catch (error) {
      if (ticketApiActiveId !== activeIdAtRequest) return;
      ticketApiDetailError = error?.message || '加载工单详情失败';
    } finally {
      if (ticketApiActiveId !== activeIdAtRequest) return;
      ticketApiDetailLoading = false;
      renderTicketApiList();
      renderTicketApiDetail();
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
    ticketApiDetailLoading = false;
    ticketApiDetailError = '';
    ticketApiPageMode = 'list';
    ticketApiActiveLogisticsTab = 'outbound';
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
    setTicketApiPageMode('list', { scroll: false });
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
    getEl('btnTicketApiOpenDebug')?.addEventListener('click', () => window.pddApi.openDebugWindow());
    getEl('btnTicketApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnTicketApiReloadTraffic')?.addEventListener('click', async () => {
      await loadTicketApiTraffic();
      updateTicketApiBannerText();
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
      updateTicketApiBannerText();
      addLog('已清空当前范围的工单管理抓包记录', 'info');
    });
    getEl('btnTicketApiBackToTicket')?.addEventListener('click', () => switchView('ticket'));
    getEl('btnTicketApiBackToList')?.addEventListener('click', () => setTicketApiPageMode('list'));
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
