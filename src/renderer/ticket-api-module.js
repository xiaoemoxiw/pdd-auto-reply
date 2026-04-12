(function () {
  let initialized = false;
  let ticketApiEntries = [];
  let ticketApiList = [];
  let ticketApiKeyword = '';
  let ticketApiTypeFilter = '';
  let ticketApiStatusFilter = '';
  let ticketApiQuickFilter = 'pending';
  let ticketApiFinishedShopKey = '';
  let ticketApiFinishedShopBuckets = new Map();
  let ticketApiFinishedShopOptions = [];
  let ticketApiFinishedShopMenuHideTimer = null;
  let ticketApiClosedShopKey = '';
  let ticketApiClosedShopBuckets = new Map();
  let ticketApiClosedShopOptions = [];
  let ticketApiClosedShopMenuHideTimer = null;
  let ticketApiDatePreset = 'all';
  let ticketApiActiveId = '';
  let ticketApiActiveDetail = null;
  let ticketApiDetailLoading = false;
  let ticketApiDetailError = '';
  let ticketApiPageMode = 'list';
  let ticketApiActiveLogisticsTab = 'outbound';
  let ticketApiListLoaded = false;
  let ticketApiListLoading = false;
  let ticketApiRefreshListDebounceTimer = null;
  let ticketApiRefreshListInFlight = false;
  let ticketCopyToastTimer = null;

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
    if (code === 0) return '待处理';
    if (code === 1) return '处理中';
    if (code === 2) return '已关闭';
    if (code === 3) return '已完结';
    if (code === 4) return '即将逾期';
    return String(code);
  }

  function normalizeTodoListItem(item = {}, index = 0) {
    const statusText = mapTicketStatusCode(item.status);
    return {
      shopId: String(pickFirstValue(item, ['shopId', 'shop_id', 'mallId', 'mall_id']) || ''),
      shopName: String(pickFirstValue(item, ['shopName', 'shop_name', 'mallName', 'mall_name']) || ''),
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
      shopId: String(pickFirstValue(item, ['shopId', 'shop_id', 'mallId', 'mall_id']) || ''),
      shopName: String(pickFirstValue(item, ['shopName', 'shop_name', 'mallName', 'mall_name']) || ''),
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

  function normalizeTicketApiRemoteList(list = []) {
    return dedupeTicketList(list.map((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && ('instanceId' in item || 'problemTitle' in item || 'externalDisplayName' in item)) {
        return normalizeTodoListItem(item, index);
      }
      return normalizeTicketRecord(item, index);
    }));
  }

  function resolveTicketDetailRequestId(record = {}) {
    const isUsable = (value) => {
      const text = String(value || '').trim();
      if (!text) return false;
      if (/^(instance|ticket)-\d+$/i.test(text)) return false;
      return true;
    };
    const pick = (...values) => values.find(isUsable) || '';

    const direct = pick(record.detailRequestId, record.instanceId);
    if (direct) return String(direct).trim();

    const raw = record.raw && typeof record.raw === 'object' ? record.raw : {};
    const fromRaw = pick(
      pickFirstValue(raw, ['instanceId', 'instance_id']),
      pickFirstValue(raw, ['todoId', 'todo_id']),
      pickFirstValue(raw, ['workOrderId', 'work_order_id']),
      pickFirstValue(raw, ['id'])
    );
    if (fromRaw) return String(fromRaw).trim();

    const fallback = pick(record.ticketNo);
    return fallback ? String(fallback).trim() : '';
  }

  function isTicketFinishedStatus(status = '') {
    const text = String(status).toLowerCase();
    return text.includes('已完结') || text.includes('完结') || text.includes('完成') || text.includes('已处理') || text.includes('违规已处理');
  }

  function isTicketClosedStatus(status = '') {
    const text = String(status).toLowerCase();
    return text.includes('已关闭') || (text.includes('关闭') && !text.includes('未关闭'));
  }

  function isTicketClosed(status = '') {
    return isTicketFinishedStatus(status) || isTicketClosedStatus(status);
  }

  function getTicketShopKey(item = {}) {
    const shopId = String(item.shopId || '').trim();
    if (shopId) return shopId;
    const shopName = String(item.shopName || '').trim();
    if (shopName) return shopName;
    return String(getTicketActiveShopName() || '').trim() || '-';
  }

  function rebuildTicketFinishedShopBuckets() {
    const bucket = new Map();
    for (const item of Array.isArray(ticketApiList) ? ticketApiList : []) {
      if (getTicketQuickType(item) !== 'finished') continue;
      const key = getTicketShopKey(item);
      const shopName = String(item.shopName || '').trim() || getTicketActiveShopName();
      if (!bucket.has(key)) {
        bucket.set(key, { key, shopName, items: [] });
      } else if (!bucket.get(key).shopName && shopName) {
        bucket.get(key).shopName = shopName;
      }
      bucket.get(key).items.push(item);
    }
    const options = Array.from(bucket.values())
      .map(entry => ({
        key: entry.key,
        shopName: entry.shopName || entry.key,
        count: entry.items.length,
        items: entry.items
      }))
      .sort((a, b) => (b.count - a.count) || String(a.shopName).localeCompare(String(b.shopName), 'zh-CN'));
    const total = options.reduce((sum, item) => sum + item.count, 0);
    ticketApiFinishedShopBuckets = bucket;
    ticketApiFinishedShopOptions = [{ key: '__all__', shopName: '全部店铺', count: total, items: options.flatMap(item => item.items) }].concat(options);
    const current = String(ticketApiFinishedShopKey || '').trim();
    if (current && current !== '__all__' && !bucket.has(current)) {
      ticketApiFinishedShopKey = '';
    } else {
      ticketApiFinishedShopKey = current;
    }
  }

  function rebuildTicketClosedShopBuckets() {
    const bucket = new Map();
    for (const item of Array.isArray(ticketApiList) ? ticketApiList : []) {
      if (getTicketQuickType(item) !== 'closed') continue;
      const key = getTicketShopKey(item);
      const shopName = String(item.shopName || '').trim() || getTicketActiveShopName();
      if (!bucket.has(key)) {
        bucket.set(key, { key, shopName, items: [] });
      } else if (!bucket.get(key).shopName && shopName) {
        bucket.get(key).shopName = shopName;
      }
      bucket.get(key).items.push(item);
    }
    const options = Array.from(bucket.values())
      .map(entry => ({
        key: entry.key,
        shopName: entry.shopName || entry.key,
        count: entry.items.length,
        items: entry.items
      }))
      .sort((a, b) => (b.count - a.count) || String(a.shopName).localeCompare(String(b.shopName), 'zh-CN'));
    const total = options.reduce((sum, item) => sum + item.count, 0);
    ticketApiClosedShopBuckets = bucket;
    ticketApiClosedShopOptions = [{ key: '__all__', shopName: '全部店铺', count: total, items: options.flatMap(item => item.items) }].concat(options);
    const current = String(ticketApiClosedShopKey || '').trim();
    if (current && current !== '__all__' && !bucket.has(current)) {
      ticketApiClosedShopKey = '';
    } else {
      ticketApiClosedShopKey = current;
    }
  }

  function ensureTicketFinishedShopSelector() {
    const tabs = getEl('ticketApiStatusTabs');
    if (!tabs) return null;
    const finishedButton = tabs.querySelector('[data-ticket-quick="finished"]');
    if (!finishedButton) return null;
    let menu = getEl('ticketApiFinishedShopMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ticketApiFinishedShopMenu';
      menu.className = 'ticket-api-finished-shop-menu';
      menu.style.display = 'none';
      menu.style.position = 'fixed';
      menu.style.zIndex = '9999';
      document.body.appendChild(menu);
    }
    const alreadyBound = menu.dataset.ticketFinishedBound === '1';

    const positionMenu = () => {
      if (!menu) return;
      if (menu.parentNode !== document.body) {
        document.body.appendChild(menu);
      }
      const rect = finishedButton.getBoundingClientRect();
      const gap = 6;
      const padding = 8;
      const width = menu.offsetWidth || 260;
      const height = menu.offsetHeight || 240;
      let left = rect.left;
      let top = rect.bottom + gap;
      left = Math.max(padding, Math.min(left, window.innerWidth - width - padding));
      if (top + height > window.innerHeight - padding) {
        top = rect.top - height - gap;
        top = Math.max(padding, top);
      }
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    };

    const scheduleHide = () => {
      if (ticketApiFinishedShopMenuHideTimer) clearTimeout(ticketApiFinishedShopMenuHideTimer);
      ticketApiFinishedShopMenuHideTimer = setTimeout(() => {
        if (menu) menu.style.display = 'none';
      }, 120);
    };
    const cancelHide = () => {
      if (ticketApiFinishedShopMenuHideTimer) clearTimeout(ticketApiFinishedShopMenuHideTimer);
      ticketApiFinishedShopMenuHideTimer = null;
    };
    const show = () => {
      cancelHide();
      renderTicketFinishedShopSelector();
      if (!menu) return;
      const total = Number(ticketApiFinishedShopOptions?.[0]?.count || 0);
      if (!total) {
        menu.style.display = 'none';
        return;
      }
      menu.style.display = 'block';
      menu.style.visibility = 'hidden';
      positionMenu();
      menu.style.visibility = 'visible';
    };

    if (!alreadyBound) {
      menu.dataset.ticketFinishedBound = '1';
      menu?.addEventListener('mouseenter', show);
      menu?.addEventListener('mouseleave', scheduleHide);
      finishedButton.addEventListener('mouseenter', show);
      finishedButton.addEventListener('mouseleave', scheduleHide);
      const onViewportChange = () => {
        if (!menu) return;
        if (menu.style.display === 'none') return;
        positionMenu();
      };
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('scroll', onViewportChange, true);
      document.addEventListener('click', (event) => {
        if (!menu) return;
        if (menu.style.display === 'none') return;
        if (menu.contains(event.target) || finishedButton.contains(event.target)) return;
        menu.style.display = 'none';
      });
    }

    return { menu, finishedButton, tabs, scheduleHide, show };
  }

  function renderTicketFinishedShopSelector() {
    const ctx = ensureTicketFinishedShopSelector();
    if (!ctx) return;
    const menu = ctx.menu;
    menu.innerHTML = ticketApiFinishedShopOptions
      .filter(item => item.key === '__all__' || item.count > 0)
      .map(item => `
        <button type="button" class="ticket-api-finished-shop-option" data-ticket-finished-shop="${esc(item.key)}">
          <span class="ticket-api-finished-shop-name">${esc(item.shopName)}</span>
          <span class="ticket-api-finished-shop-count">(${esc(String(item.count || 0))})</span>
        </button>
      `)
      .join('');
    menu.querySelectorAll('[data-ticket-finished-shop]').forEach(button => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextKey = String(button.dataset.ticketFinishedShop || '').trim() || '';
        ticketApiFinishedShopKey = nextKey;
        ticketApiQuickFilter = 'finished';
        menu.style.display = 'none';
        renderTicketQuickSummary();
        await renderTicketApiState();
      });
    });
  }

  function ensureTicketClosedShopSelector() {
    const tabs = getEl('ticketApiStatusTabs');
    if (!tabs) return null;
    const closedButton = tabs.querySelector('[data-ticket-quick="closed"]');
    if (!closedButton) return null;
    let menu = getEl('ticketApiClosedShopMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ticketApiClosedShopMenu';
      menu.className = 'ticket-api-finished-shop-menu';
      menu.style.display = 'none';
      menu.style.position = 'fixed';
      menu.style.zIndex = '9999';
      document.body.appendChild(menu);
    }
    const alreadyBound = menu.dataset.ticketClosedBound === '1';

    const positionMenu = () => {
      if (!menu) return;
      if (menu.parentNode !== document.body) {
        document.body.appendChild(menu);
      }
      const rect = closedButton.getBoundingClientRect();
      const gap = 6;
      const padding = 8;
      const width = menu.offsetWidth || 260;
      const height = menu.offsetHeight || 240;
      let left = rect.left;
      let top = rect.bottom + gap;
      left = Math.max(padding, Math.min(left, window.innerWidth - width - padding));
      if (top + height > window.innerHeight - padding) {
        top = rect.top - height - gap;
        top = Math.max(padding, top);
      }
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    };

    const scheduleHide = () => {
      if (ticketApiClosedShopMenuHideTimer) clearTimeout(ticketApiClosedShopMenuHideTimer);
      ticketApiClosedShopMenuHideTimer = setTimeout(() => {
        if (menu) menu.style.display = 'none';
      }, 120);
    };
    const cancelHide = () => {
      if (ticketApiClosedShopMenuHideTimer) clearTimeout(ticketApiClosedShopMenuHideTimer);
      ticketApiClosedShopMenuHideTimer = null;
    };
    const show = () => {
      cancelHide();
      renderTicketClosedShopSelector();
      if (!menu) return;
      const total = Number(ticketApiClosedShopOptions?.[0]?.count || 0);
      if (!total) {
        menu.style.display = 'none';
        return;
      }
      menu.style.display = 'block';
      menu.style.visibility = 'hidden';
      positionMenu();
      menu.style.visibility = 'visible';
    };

    if (!alreadyBound) {
      menu.dataset.ticketClosedBound = '1';
      menu?.addEventListener('mouseenter', show);
      menu?.addEventListener('mouseleave', scheduleHide);
      closedButton.addEventListener('mouseenter', show);
      closedButton.addEventListener('mouseleave', scheduleHide);
      const onViewportChange = () => {
        if (!menu) return;
        if (menu.style.display === 'none') return;
        positionMenu();
      };
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('scroll', onViewportChange, true);
      document.addEventListener('click', (event) => {
        if (!menu) return;
        if (menu.style.display === 'none') return;
        if (menu.contains(event.target) || closedButton.contains(event.target)) return;
        menu.style.display = 'none';
      });
    }

    return { menu, closedButton, tabs, scheduleHide, show };
  }

  function renderTicketClosedShopSelector() {
    const ctx = ensureTicketClosedShopSelector();
    if (!ctx) return;
    const menu = ctx.menu;
    menu.innerHTML = ticketApiClosedShopOptions
      .filter(item => item.key === '__all__' || item.count > 0)
      .map(item => `
        <button type="button" class="ticket-api-finished-shop-option" data-ticket-closed-shop="${esc(item.key)}">
          <span class="ticket-api-finished-shop-name">${esc(item.shopName)}</span>
          <span class="ticket-api-finished-shop-count">(${esc(String(item.count || 0))})</span>
        </button>
      `)
      .join('');
    menu.querySelectorAll('[data-ticket-closed-shop]').forEach(button => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextKey = String(button.dataset.ticketClosedShop || '').trim() || '';
        ticketApiClosedShopKey = nextKey;
        ticketApiQuickFilter = 'closed';
        menu.style.display = 'none';
        renderTicketQuickSummary();
        await renderTicketApiState();
      });
    });
  }

  function getTicketQuickType(item = {}) {
    const code = Number(item.statusCode || 0);
    const text = `${item.status || ''} ${item.progressText || ''}`.toLowerCase();
    if (text.includes('违规已处理')) return 'violationHandled';
    if (text.includes('扣款')) return 'deduct';
    if (isTicketClosedStatus(text)) return 'closed';
    if (isTicketFinishedStatus(text)) return 'finished';
    if (text.includes('处理中') || text.includes('跟进') || text.includes('流转')) return 'processing';
    if (text.includes('待处理')) return 'pending';
    if (code === 0) return 'pending';
    if (code === 1) return 'processing';
    if (code === 2) return 'processing';
    if (code === 3) return 'finished';
    if (code === 4) return 'finished';
    return 'pending';
  }

  function getTicketQuickCounts() {
    return ticketApiList.reduce((acc, item) => {
      const type = getTicketQuickType(item);
      acc.pending += type === 'pending' ? 1 : 0;
      acc.processing += type === 'processing' ? 1 : 0;
      acc.violationHandled += type === 'violationHandled' ? 1 : 0;
      acc.closed += type === 'closed' ? 1 : 0;
      acc.deduct += type === 'deduct' ? 1 : 0;
      acc.finished += type === 'finished' ? 1 : 0;
      return acc;
    }, { pending: 0, processing: 0, violationHandled: 0, deduct: 0, closed: 0, finished: 0 });
  }

  function renderTicketQuickSummary() {
    const counts = getTicketQuickCounts();
    const setText = (id, value) => {
      const el = getEl(id);
      if (!el) return;
      el.textContent = String(value);
    };
    setText('ticketApiQuickPendingCount', counts.pending || 0);
    setText('ticketApiQuickProcessingCount', counts.processing || 0);
    setText('ticketApiQuickViolationHandledCount', counts.violationHandled || 0);
    setText('ticketApiQuickDeductCount', counts.deduct || 0);
    setText('ticketApiQuickClosedCount', counts.closed || 0);
    setText('ticketApiQuickFinishedCount', counts.finished || 0);
    document.querySelectorAll('[data-ticket-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.ticketQuick === ticketApiQuickFilter);
    });
    renderTicketFinishedShopSelector();
    renderTicketClosedShopSelector();
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
    const baseList = (() => {
      if (ticketApiQuickFilter === 'finished') {
        const selectedKey = String(ticketApiFinishedShopKey || '').trim();
        if (!selectedKey) return [];
        if (selectedKey === '__all__') return ticketApiList;
        const group = ticketApiFinishedShopBuckets.get(selectedKey);
        return group ? group.items : ticketApiList;
      }
      if (ticketApiQuickFilter === 'closed') {
        const selectedKey = String(ticketApiClosedShopKey || '').trim();
        if (!selectedKey) return [];
        if (selectedKey === '__all__') return ticketApiList;
        const group = ticketApiClosedShopBuckets.get(selectedKey);
        return group ? group.items : ticketApiList;
      }
      return ticketApiList;
    })();
    return (Array.isArray(baseList) ? baseList : []).filter(item => {
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
    const setText = (id, value) => {
      const el = getEl(id);
      if (!el) return;
      el.textContent = String(value);
    };
    setText('ticketApiMetricTotal', total);
    setText('ticketApiMetricViolationHandled', violationHandled);
    setText('ticketApiMetricViolationRate', safeRate(violationHandled, total).toFixed(2));
    setText('ticketApiMetricClosedRate', safeRate(closed, total).toFixed(2));
    setText('ticketApiMetricEffectiveClosedRate', safeRate(effectiveClosed, total).toFixed(2));
  }

  function renderTicketApiList() {
    const container = getEl('ticketApiList');
    if (!container) return;
    const countEl = getEl('ticketApiResultCount');
    const footerEl = getEl('ticketApiFooterTotal');
    const statusEl = getEl('ticketApiListStatus');

    if (ticketApiListLoading) {
      if (countEl) countEl.textContent = '...';
      if (footerEl) footerEl.textContent = '加载中...';
      if (statusEl) statusEl.textContent = '正在加载工单列表，请稍候。';
      container.innerHTML = '<tr><td colspan="11"><div class="ticket-api-list-loading"><span class="ticket-api-loading-spinner"></span>正在加载中...</div></td></tr>';
      return;
    }

    const visibleList = getTicketVisibleList();
    if (countEl) countEl.textContent = String(visibleList.length);
    if (footerEl) footerEl.textContent = `共 ${visibleList.length} 条`;

    const filterLabels = [];
    if (ticketApiQuickFilter === 'pending') filterLabels.push('待处理');
    if (ticketApiQuickFilter === 'processing') filterLabels.push('处理中');
    if (ticketApiQuickFilter === 'violationHandled') filterLabels.push('违规已处理');
    if (ticketApiQuickFilter === 'deduct') filterLabels.push('待扣款处理');
    if (ticketApiQuickFilter === 'closed') filterLabels.push('已关闭');
    if (ticketApiQuickFilter === 'finished') filterLabels.push('已完结');
    if (ticketApiStatusFilter) filterLabels.push(`工单状态：${ticketApiStatusFilter}`);
    if (ticketApiTypeFilter) filterLabels.push(`问题类型：${ticketApiTypeFilter}`);
    if (ticketApiDatePreset !== 'all') filterLabels.push(`创建时间：${getPresetDateRangeText()}`);
    if (ticketApiKeyword) filterLabels.push(`订单编号：${ticketApiKeyword}`);
    if (statusEl) {
      statusEl.textContent = filterLabels.length ? filterLabels.join(' · ') : '当前仅展示工单管理相关抓包与接口提取结果';
    }

    if (!visibleList.length) {
      if (ticketApiQuickFilter === 'finished' && !String(ticketApiFinishedShopKey || '').trim()) {
        container.innerHTML = '<tr><td colspan="11"><div class="ticket-api-list-empty">请在“已完结”下拉中选择店铺查看对应已完结数据。</div></td></tr>';
        return;
      }
      if (ticketApiQuickFilter === 'closed' && !String(ticketApiClosedShopKey || '').trim()) {
        container.innerHTML = '<tr><td colspan="11"><div class="ticket-api-list-empty">请在“已关闭”下拉中选择店铺查看对应已关闭数据。</div></td></tr>';
        return;
      }
      container.innerHTML = '<tr><td colspan="11"><div class="ticket-api-list-empty">当前没有工单记录，可直接刷新列表重试。</div></td></tr>';
      return;
    }

    container.innerHTML = visibleList.map((item, index) => {
      const active = String(item.ticketNo) === String(ticketApiActiveId);
      const shopName = item.shopName || getTicketActiveShopName();
      const orderText = item.orderSn || '-';
      const orderCopy = item.orderSn || '';
      const ticketNo = item.ticketNo || '-';
      const ticketCopy = item.ticketNo || '';
      const goodsName = item.goodsName || '-';
      const createdAt = formatApiDateTime(item.createTime) || '-';
      const deadline = formatApiDateTime(item.deadline || item.updateTime) || '-';
      const statusText = item.status || '-';
      const questionTitle = item.questionTitle || item.ticketType || '-';
      const progressText = item.progressText || '-';
      return `
        <tr class="ticket-api-row ${active ? 'active' : ''}" data-ticket-id="${esc(item.ticketNo)}">
          <td>${index + 1}</td>
          <td title="${esc(shopName)}">${esc(shopName)}</td>
          <td class="ticket-api-cell-mono" title="${esc(orderText)}">
            <button type="button" class="ticket-api-copy-link" data-ticket-copy="${esc(orderCopy)}" data-ticket-copy-success="已复制粘贴板成功">${esc(orderText)}</button>
          </td>
          <td class="ticket-api-cell-mono" title="${esc(ticketNo)}">
            <button type="button" class="ticket-api-copy-link" data-ticket-copy="${esc(ticketCopy)}" data-ticket-copy-success="已复制粘贴板成功">${esc(ticketNo)}</button>
          </td>
          <td title="${esc(goodsName)}">${esc(goodsName)}</td>
          <td title="${esc(createdAt)}">${esc(createdAt)}</td>
          <td><span class="ticket-api-progress ${getTicketStatusClass(statusText)}">${esc(statusText)}</span></td>
          <td title="${esc(questionTitle)}">${esc(questionTitle)}</td>
          <td title="${esc(progressText)}">${esc(progressText)}</td>
          <td title="${esc(deadline)}">${esc(deadline)}</td>
          <td><button class="ticket-api-action-link" data-ticket-detail="${esc(item.ticketNo)}">立即处理</button></td>
        </tr>
      `;
    }).join('');

    bindTicketDetailActions(container);
    container.querySelectorAll('[data-ticket-id]').forEach(row => {
      row.addEventListener('click', async event => {
        if (event.target.closest('button')) return;
        await openTicketApiDetail(row.dataset.ticketId, { skipTraffic: true });
      });
    });

    container.querySelectorAll('[data-ticket-detail]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        await openTicketApiTodoDetailWindow(button.dataset.ticketDetail);
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

  function getTicketActiveShopName() {
    const fallback = (typeof activeShopId !== 'undefined' && activeShopId) ? String(activeShopId) : '-';
    try {
      const state = window.__chatApiModuleAccess?.getState?.();
      const list = Array.isArray(state?.shops)
        ? state.shops
        : (typeof shops !== 'undefined' && Array.isArray(shops) ? shops : []);
      const id = (typeof activeShopId !== 'undefined' && activeShopId) ? String(activeShopId) : '';
      const shop = list.find(item => String(item?.id) === id) || null;
      return String(shop?.name || shop?.mallName || fallback || '-');
    } catch {
      return fallback || '-';
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
    const normalizeClipboardText = (value) => String(value || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u200B/g, '')
      .trim();
    const content = normalizeClipboardText(text);
    if (!content) return;
    try {
      let copied = false;
      if (typeof window.pddApi?.writeClipboardText === 'function') {
        try {
          const result = await window.pddApi.writeClipboardText(content);
          copied = result !== false;
        } catch {
        }
      }
      if (!copied && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(content);
          copied = true;
        } catch {
        }
      }
      if (!copied) {
        let textarea = null;
        try {
          textarea = document.createElement('textarea');
          textarea.value = content;
          textarea.setAttribute('readonly', 'readonly');
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          textarea.style.top = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          if (document.execCommand) {
            document.execCommand('copy');
            copied = true;
          }
        } catch {
          copied = false;
        } finally {
          if (textarea && textarea.parentNode) textarea.parentNode.removeChild(textarea);
        }
      }
      if (typeof window.pddApi?.readClipboardText === 'function') {
        try {
          for (let i = 0; i < 6; i += 1) {
            const current = await window.pddApi.readClipboardText();
            if (normalizeClipboardText(current) === content) {
              copied = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 30 * (2 ** i)));
          }
        } catch {
        }
      }
      const toastMessage = copied ? successText : '复制失败，请稍后重试';
      try {
        if (typeof window.showToast === 'function') {
          const toastEl = document.getElementById('toastMsg');
          if (toastEl) {
            toastEl.style.visibility = '';
            toastEl.style.opacity = '';
          }
          window.showToast(toastMessage, 3000);
          if (ticketCopyToastTimer) clearTimeout(ticketCopyToastTimer);
          ticketCopyToastTimer = setTimeout(() => {
            const currentToastEl = document.getElementById('toastMsg');
            if (!currentToastEl) return;
            const text = String(currentToastEl.textContent || '').trim();
            if (!text) return;
            if (text.includes('已复制') || text.includes('复制失败')) {
              currentToastEl.classList.remove('show');
              currentToastEl.style.display = 'none';
            }
            ticketCopyToastTimer = null;
          }, 3200);
        }
      } catch {}
    } catch {
      try {
        if (typeof window.showToast === 'function') {
          window.showToast('复制失败，请稍后重试', 3000);
        }
      } catch {}
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
    const scopeShopId = (typeof API_ALL_SHOPS !== 'undefined' ? API_ALL_SHOPS : activeShopId);
    if (!scopeShopId) {
      banner.textContent = '当前没有可用店铺，请先导入或登录店铺后再查看工单管理接口页。';
      return;
    }
    if (ticketApiListLoading) {
      banner.textContent = '正在加载工单列表，请稍候。';
      return;
    }
    if (!ticketApiListLoaded) {
      banner.textContent = '未获取工单列表，点击“刷新列表”获取数据。';
      return;
    }
    if (!ticketApiList.length) {
      banner.textContent = '暂无工单数据，可点击“刷新列表”重试。';
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

  async function loadTicketApiTraffic(shopId = (typeof API_ALL_SHOPS !== 'undefined' ? API_ALL_SHOPS : activeShopId)) {
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
    rebuildTicketFinishedShopBuckets();
    rebuildTicketClosedShopBuckets();
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
    ticketApiActiveId = '';
    ticketApiActiveDetail = null;
    ticketApiDetailLoading = false;
    ticketApiDetailError = '';
    setTicketApiPageMode('list', { scroll: false });
    renderTicketApiDetail();
  }

  async function loadTicketApiList(options = {}) {
    if (options.fetch !== true) {
      ticketApiList = parseTicketRecordsFromTraffic(ticketApiEntries);
      ticketApiListLoaded = true;
      ticketApiListLoading = false;
      await renderTicketApiState();
      return;
    }
    const cachedList = Array.isArray(ticketApiList) ? ticketApiList.slice() : [];
    let remoteLoaded = false;
    let remoteError = '';
    ticketApiListLoading = true;
    updateTicketApiBannerText();
    renderTicketApiList();
    const listShopId = (typeof API_ALL_SHOPS !== 'undefined' ? API_ALL_SHOPS : activeShopId);
    try {
      if (listShopId && typeof window.pddApi.ticketGetList === 'function') {
        const result = await window.pddApi.ticketGetList({
          shopId: listShopId,
          pageNo: 1,
          pageSize: 100
        });
        if (result && !result.error) {
          ticketApiList = normalizeTicketApiRemoteList(Array.isArray(result.list) ? result.list : []);
          remoteLoaded = true;
        } else {
          remoteError = result?.error || '加载工单管理列表失败';
        }
      } else {
        remoteError = 'ticketGetList 未暴露，已回退抓包解析';
      }
    } catch (error) {
      remoteError = error?.message || '加载工单管理列表失败';
    }
    if (!remoteLoaded) {
      const fallbackList = parseTicketRecordsFromTraffic(ticketApiEntries);
      ticketApiList = fallbackList.length ? fallbackList : cachedList;
      if (remoteError && options.silentError !== true) {
        addLog(`${remoteError}，已回退到抓包解析结果`, 'error');
      }
    }
    ticketApiListLoaded = true;
    ticketApiListLoading = false;
    await renderTicketApiState();
  }

  async function openTicketApiDetail(ticketNo, options = {}) {
    if (!ticketNo) return;
    ticketApiActiveId = String(ticketNo);
    ticketApiActiveDetail = ticketApiList.find(item => String(item.ticketNo) === String(ticketNo)) || null;
    ticketApiActiveLogisticsTab = 'outbound';
    setTicketApiPageMode('detail');
    const baseRecord = ticketApiList.find(item => String(item.ticketNo) === String(ticketNo)) || ticketApiActiveDetail;
    const recordShopId = baseRecord?.shopId || activeShopId || '';
    const detailRequestId = resolveTicketDetailRequestId(baseRecord || {});
    ticketApiDetailLoading = Boolean(baseRecord && recordShopId && detailRequestId && typeof window.pddApi.ticketGetDetail === 'function');
    ticketApiDetailError = '';
    renderTicketApiList();
    renderTicketApiDetail();
    if (!options.skipTraffic) {
      await loadTicketApiTraffic(recordShopId);
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
    if (!recordShopId || typeof window.pddApi.ticketGetDetail !== 'function') {
      ticketApiDetailLoading = false;
      renderTicketApiDetail();
      return;
    }
    const activeIdAtRequest = ticketApiActiveId;
    try {
      const result = await window.pddApi.ticketGetDetail({
        shopId: recordShopId,
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

  async function openTicketApiTodoDetailWindow(ticketNo) {
    const id = String(ticketNo || '').trim();
    if (!id) return;
    const record = ticketApiList.find(item => String(item.ticketNo) === id) || null;
    if (!record) {
      addLog(`未找到工单记录：${id}`, 'error');
      return;
    }
    const shopId = String(record.shopId || activeShopId || '').trim();
    const orderSn = String(record.orderSn || '').trim();
    if (!orderSn) {
      addLog('该工单缺少订单号，无法打开“立即处理”页面', 'error');
      return;
    }
    if (!window.pddApi || typeof window.pddApi.openTicketTodoDetailWindow !== 'function') {
      addLog('openTicketTodoDetailWindow 未暴露，无法打开内置窗口', 'error');
      return;
    }
    try {
      const instanceId = String(record.instanceId || '').trim();
      if (!instanceId) {
        addLog('该工单缺少 instanceId，无法打开“立即处理”页面', 'error');
        return;
      }
      const result = await window.pddApi.openTicketTodoDetailWindow({
        shopId,
        instanceId,
        orderSn,
        ticketNo: record.ticketNo
      });
      if (result?.error) {
        addLog(`打开“立即处理”窗口失败：${result.error}`, 'error');
      }
    } catch (error) {
      addLog(`打开“立即处理”窗口失败：${error?.message || '未知错误'}`, 'error');
    }
  }

  function resetTicketApiState() {
    ticketApiEntries = [];
    ticketApiList = [];
    ticketApiKeyword = '';
    ticketApiTypeFilter = '';
    ticketApiStatusFilter = '';
    ticketApiQuickFilter = 'pending';
    ticketApiFinishedShopKey = '';
    ticketApiFinishedShopBuckets = new Map();
    ticketApiFinishedShopOptions = [];
    ticketApiClosedShopKey = '';
    ticketApiClosedShopBuckets = new Map();
    ticketApiClosedShopOptions = [];
    ticketApiDatePreset = 'all';
    ticketApiActiveId = '';
    ticketApiActiveDetail = null;
    ticketApiDetailLoading = false;
    ticketApiDetailError = '';
    ticketApiPageMode = 'list';
    ticketApiActiveLogisticsTab = 'outbound';
    ticketApiListLoaded = false;
    ticketApiListLoading = false;
    const keyword = getEl('ticketApiKeyword');
    if (keyword) keyword.value = '';
    ['ticketApiTypeFilter', 'ticketApiStatusFilter'].forEach(id => {
      const element = getEl(id);
      if (element) element.value = '';
    });
    const preset = getEl('ticketApiDatePreset');
    if (preset) preset.value = 'all';
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

  async function loadTicketApiView(options = {}) {
    await refreshShopContext();
    if (options.fetchList === false) {
      await renderTicketApiState();
      return;
    }
    const scopeShopId = (typeof API_ALL_SHOPS !== 'undefined' ? API_ALL_SHOPS : activeShopId);
    if (!scopeShopId) {
      resetTicketApiState();
      return;
    }
    ticketApiListLoading = true;
    updateTicketApiBannerText();
    renderTicketApiList();
    try {
      await loadTicketApiTraffic(scopeShopId);
    } catch (error) {
      ticketApiEntries = [];
      renderTicketApiTraffic();
      addLog(`加载工单管理抓包记录失败：${error?.message || '未知错误'}`, 'error');
    }
    await loadTicketApiList({ fetch: true });
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
      if (ticketApiRefreshListInFlight) return;
      if (ticketApiRefreshListDebounceTimer) {
        clearTimeout(ticketApiRefreshListDebounceTimer);
      }
      const button = getEl('btnTicketApiRefreshList');
      if (button) button.disabled = true;
      ticketApiListLoading = true;
      updateTicketApiBannerText();
      renderTicketApiList();
      ticketApiRefreshListDebounceTimer = setTimeout(async () => {
        ticketApiRefreshListDebounceTimer = null;
        ticketApiRefreshListInFlight = true;
        try {
          try {
            await loadTicketApiTraffic();
          } catch (error) {
            ticketApiEntries = [];
            renderTicketApiTraffic();
            addLog(`加载工单管理抓包记录失败：${error?.message || '未知错误'}`, 'error');
          }
          await loadTicketApiList({ fetch: true });
          addLog('已刷新工单管理列表', 'info');
        } finally {
          ticketApiRefreshListInFlight = false;
          if (button) button.disabled = false;
        }
      }, 320);
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
      const keyword = getEl('ticketApiKeyword');
      ticketApiKeyword = keyword ? (keyword.value || '') : '';
      await renderTicketApiState();
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
      const preset = getEl('ticketApiDatePreset');
      if (preset) preset.value = 'all';
      renderTicketQuickSummary();
      updateDateRangeText();
      await renderTicketApiState();
    });
    document.querySelectorAll('[data-ticket-quick]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextFilter = button.dataset.ticketQuick || '';
        if (nextFilter === ticketApiQuickFilter) return;
        if (nextFilter === 'finished') {
          ticketApiQuickFilter = 'finished';
          ticketApiFinishedShopKey = '';
          renderTicketQuickSummary();
          await renderTicketApiState();
          ensureTicketFinishedShopSelector()?.show?.();
          return;
        }
        if (nextFilter === 'closed') {
          ticketApiQuickFilter = 'closed';
          ticketApiClosedShopKey = '';
          renderTicketQuickSummary();
          await renderTicketApiState();
          ensureTicketClosedShopSelector()?.show?.();
          return;
        }
        ticketApiQuickFilter = nextFilter;
        renderTicketQuickSummary();
        await renderTicketApiState();
      });
    });
    getEl('ticketApiTypeFilter')?.addEventListener('change', async event => {
      ticketApiTypeFilter = event.target.value || '';
      await renderTicketApiState();
    });
    getEl('ticketApiStatusFilter')?.addEventListener('change', async event => {
      ticketApiStatusFilter = event.target.value || '';
      await renderTicketApiState();
    });
    getEl('ticketApiDatePreset')?.addEventListener('change', async event => {
      ticketApiDatePreset = event.target.value || 'all';
      updateDateRangeText();
      await renderTicketApiState();
    });
    getEl('ticketApiKeyword')?.addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const keyword = getEl('ticketApiKeyword');
      ticketApiKeyword = keyword ? (keyword.value || '') : '';
      await renderTicketApiState();
    });
  }

  window.loadTicketApiView = loadTicketApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('ticket-api-module', bindTicketApiModule);
  } else {
    bindTicketApiModule();
  }
})();
