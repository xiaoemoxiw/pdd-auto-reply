const aftersaleState = {
  loading: false,
  error: '',
  rows: [],
  total: 0,
  updatedAt: 0,
  statusFilter: 'waitSellerHandle',
  overviewCounts: null,
  overviewTotal: 0,
  overviewUpdatedAt: 0,
  statusCounts: {},
  lastApiAt: 0,
  lastApiParams: null,
  lastApiResult: null,
  lastApiThrownError: ''
};

function escape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return '';
  const maybeNumber = Number(raw);
  const stamp = Number.isFinite(maybeNumber) ? maybeNumber : NaN;
  if (Number.isFinite(stamp) && stamp > 0) {
    const ms = stamp < 10_000_000_000 ? stamp * 1000 : stamp;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  return raw;
}

function parseTimestampToMs(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return Number.NaN;
  const maybeNumber = Number(raw);
  if (Number.isFinite(maybeNumber) && maybeNumber > 0) {
    return maybeNumber < 10_000_000_000 ? maybeNumber * 1000 : maybeNumber;
  }
  const date = new Date(raw);
  const time = date.getTime();
  return Number.isNaN(time) ? Number.NaN : time;
}

function pickFirst(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeMoneyToYuan(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return Number.NaN;
  if (Number.isInteger(raw) && Math.abs(raw) >= 1000) return raw / 100;
  return raw;
}

function formatMoneyYuan(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return '-';
  return `¥${raw.toFixed(2)}`;
}

function normalizeTicketToRow(item = {}) {
  const orderNo = String(pickFirst(item, ['orderSn', 'order_sn'], '') || '').trim();
  const instanceId = String(pickFirst(item, ['id', 'instanceId', 'instance_id', 'todoId', 'todo_id', 'workOrderId', 'work_order_id', 'ticketId', 'ticket_id'], '') || '').trim();
  const title = String(pickFirst(item, ['afterSalesTitle', 'after_sales_title', 'problemTitle', 'problem_title', 'externalDisplayName', 'external_display_name', 'title'], '') || '').trim();
  const goodsName = String(pickFirst(item, ['goodsName', 'goods_name', 'goodsTitle', 'goods_title'], '') || '').trim();
  const status = String(pickFirst(item, ['afterSalesStatusDesc', 'after_sales_status_desc', 'statusStr', 'status_str', 'status'], '') || '').trim();
  const shopName = String(pickFirst(item, ['shopName', 'shop_name', 'mallName', 'mall_name'], '') || '').trim();
  const shopId = String(pickFirst(item, ['shopId', 'shop_id'], '') || '').trim();
  const serviceStatus = Number(pickFirst(item, ['afterSalesStatus', 'after_sales_status', 'serviceStatus', 'service_status'], Number.NaN));
  const customer = String(pickFirst(item, ['customerName', 'customer_name', 'externalName', 'external_name', 'buyerName', 'buyer_name'], '') || '').trim();
  const updatedAt = formatTime(pickFirst(item, ['updatedAt', 'updated_at', 'updateTime', 'update_time', 'modifyTime', 'modify_time'], ''));
  const createdAt = formatTime(pickFirst(item, ['createdAt', 'created_at', 'applyTime', 'apply_time', 'createTime', 'create_time'], ''));
  const expireRemainTime = Number(pickFirst(item, ['expireRemainTime', 'expire_remain_time'], Number.NaN));
  const deadlineAtMs = Number.isFinite(expireRemainTime) && expireRemainTime > 0
    ? Date.now() + expireRemainTime * 1000
    : parseTimestampToMs(pickFirst(item, ['deadLine', 'dead_line', 'deadline', 'deadlineAt', 'deadline_at', 'expireTime', 'expire_time'], ''));
  
  // 补充退款金额等特有字段
  const refundAmount = Number(pickFirst(item, ['refundAmount', 'refund_amount'], 0)) / 100;
  const paidAmount = normalizeMoneyToYuan(pickFirst(item, [
    'actMoney',
    'act_money',
    'actPayAmount',
    'act_pay_amount',
    'actualPayAmount',
    'actual_pay_amount',
    'payAmount',
    'pay_amount',
    'paidAmount',
    'paid_amount',
    'merchantAmount',
    'merchant_amount',
    'orderAmount',
    'order_amount',
  ], Number.NaN));
  const afterSalesTypeName = String(pickFirst(item, ['afterSalesTypeName', 'after_sales_type_name'], '') || '').trim();
  const afterSalesReasonDesc = String(pickFirst(item, ['afterSalesReasonDesc', 'after_sales_reason_desc'], '') || '').trim();
  const shippingStatusDesc = String(pickFirst(item, ['sellerAfterSalesShippingStatusDesc', 'seller_after_sales_shipping_status_desc'], '') || '').trim();
  const shippingTrackingNo = String(pickFirst(item, ['trackingNumber', 'tracking_number', 'expressNo', 'express_no', 'shipTrackingNumber', 'ship_tracking_number'], '') || '').trim();
  const returnTrackingNo = String(pickFirst(item, ['reverseTrackingNumber', 'reverse_tracking_number', 'returnTrackingNumber', 'return_tracking_number', 'returnShippingNo', 'return_shipping_no'], '') || '').trim();
  const thumbUrl = String(pickFirst(item, ['thumbUrl', 'thumb_url', 'goodsThumbUrl', 'goods_thumb_url'], '') || '').trim();

  return {
    raw: item,
    instanceId,
    orderNo,
    title,
    goodsName,
    status: status || title,
    shopName,
    shopId,
    serviceStatus: Number.isFinite(serviceStatus) ? serviceStatus : null,
    customer,
    createdAt,
    updatedAt,
    deadlineAtMs,
    goodsSku: String(pickFirst(item, ['spec', 'sku', 'goodsSpec', 'goods_spec'], '') || '').trim(),
    
    // 退款售后单扩展字段
    refundAmount,
    paidAmount,
    afterSalesTypeName,
    afterSalesReasonDesc,
    shippingStatusDesc,
    shippingTrackingNo,
    returnTrackingNo,
    thumbUrl,
  };
}

window.registerOpsCenterView({
  view: 'sub-aftersale',
  elementId: 'viewSubAftersale',
  title: '售后中心',
  description: '统一承接售后工单、退款退货和履约跟进，不再与接口对接页右侧侧栏语义混杂。',
  renderContent({ renderCards, escapeHtml }) {
    return `
      <div class="ops-aftersale-shell">
        <div class="ops-aftersale-topbar">
          <div class="ops-aftersale-tabs" role="tablist" id="opsAftersaleTabs"></div>
          <div class="ops-aftersale-controls">
            <select class="ops-aftersale-select" id="selectAftersaleStatus">
              <option value="">全部状态</option>
            </select>
            <button type="button" class="ops-aftersale-btn" id="btnAftersaleRefresh">刷新</button>
          </div>
        </div>
        <div class="ops-aftersale-meta" id="opsAftersaleMeta" style="padding:10px 0;color:#666;font-size:12px"></div>
        <div class="ops-aftersale-table-wrap">
          <table class="ops-aftersale-table">
            <thead>
              <tr>
                <th>订单信息</th>
                <th>金额</th>
                <th>发货状态</th>
                <th>售后类型</th>
                <th>售后状态</th>
                <th>备注</th>
                <th>售后原因</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="opsAftersaleTableBody"></tbody>
          </table>
        </div>
        <details class="ops-aftersale-debug" id="opsAftersaleDebug" open>
          <summary class="ops-aftersale-debug-summary">
            <span>接口返回字段（调试）</span>
            <span class="ops-aftersale-debug-summary-right">
              <button type="button" class="ops-aftersale-debug-copy" id="btnAftersaleCopyDebug" disabled>复制 JSON</button>
              <span class="ops-aftersale-debug-summary-meta" id="opsAftersaleDebugSummaryMeta"></span>
            </span>
          </summary>
          <div class="ops-aftersale-debug-content">
            <div class="ops-aftersale-debug-hints" id="opsAftersaleDebugHints"></div>
            <div class="ops-aftersale-debug-grid">
              <div class="ops-aftersale-debug-block">
                <div class="ops-aftersale-debug-title">顶层字段</div>
                <pre class="ops-aftersale-debug-pre" id="opsAftersaleDebugTopKeys"></pre>
              </div>
              <div class="ops-aftersale-debug-block">
                <div class="ops-aftersale-debug-title">list[0] 字段</div>
                <pre class="ops-aftersale-debug-pre" id="opsAftersaleDebugItemKeys"></pre>
              </div>
            </div>
            <div class="ops-aftersale-debug-title" style="margin-top:10px">原始返回（JSON）</div>
            <pre class="ops-aftersale-debug-json" id="opsAftersaleDebugJson"></pre>
          </div>
        </details>
      </div>
    `;
  },
  onMount(element) {
    async function copyText(text) {
      const value = String(text ?? '');
      if (!value) return false;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    }

    function safeJsonStringify(value, space = 2) {
      if (value === undefined) return '';
      const seen = new WeakSet();
      try {
        return JSON.stringify(
          value,
          (key, val) => {
            if (typeof val === 'bigint') return String(val);
            if (typeof val === 'object' && val !== null) {
              if (seen.has(val)) return '[Circular]';
              seen.add(val);
            }
            return val;
          },
          space
        );
      } catch (err) {
        return String(err?.message || err || '');
      }
    }

    function buildDebugSnapshot(result) {
      if (!result || typeof result !== 'object') return result;
      if (Array.isArray(result)) return result.slice(0, 3);
      const snapshot = { ...result };
      if (Array.isArray(result.list)) snapshot.list = result.list.slice(0, 3);
      return snapshot;
    }

    let lastDebugJsonText = '';

    function isDueSoonRow(row) {
      const ms = Number(row?.deadlineAtMs);
      if (!Number.isFinite(ms) || ms <= 0) return false;
      const remain = ms - Date.now();
      return remain > 0 && remain <= 24 * 60 * 60 * 1000;
    }

    function normalizeText(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function isBuyerPendingRow(row) {
      const text = normalizeText(row?.status || '');
      if (!text) return false;
      if (text.includes('待买家') || text.includes('待消费者')) return true;
      return text.includes('买家') && text.includes('待');
    }

    function isReturnPendingRow(row) {
      const text = normalizeText([row?.title, row?.status].filter(Boolean).join(' '));
      if (!text) return false;
      return ['退货', '寄回', '退回', '返件', '退件'].some(key => text.includes(key));
    }

    function isClosedOrFinishedRow(row) {
      const status = Number(row?.serviceStatus);
      // afterSalesStatus 枚举参考: 
      // 14: 退款成功, 12: 退款失败, 15: 售后关闭, 16: 退款撤销等
      // 由于工单的 status 和售后单不一致，这里做防御性判断
      return status === 14 || status === 15 || status === 16 || status === 12;
    }

    function buildDerivedCounts(rows) {
      const base = (Array.isArray(rows) ? rows : []).filter(row => !isClosedOrFinishedRow(row));
      const counts = {
        waitSellerHandle: base.filter(row => Number(row?.serviceStatus) === 0 || Number(row?.serviceStatus) === 1 || Number(row?.serviceStatus) === 11).length,
        platformHandling: base.filter(row => Number(row?.serviceStatus) === 8 || Number(row?.serviceStatus) === 9).length,
        waitBuyerHandle: base.filter(isBuyerPendingRow).length,
        returnedWaitHandle: base.filter(isReturnPendingRow).length,
        expireIn24HoursWaitHandle: base.filter(isDueSoonRow).length,
      };
      return counts;
    }

    function renderTabs() {
      const tabsEl = element.querySelector('#opsAftersaleTabs');
      if (!tabsEl) return;
      const quickTabs = [
        { key: 'merchant', label: '待商家处理', value: 'waitSellerHandle' },
        { key: 'platform', label: '平台处理中', value: 'platformHandling' },
        { key: 'buyer', label: '待买家处理', value: 'waitBuyerHandle' },
        { key: 'return', label: '退货待处理', value: 'returnedWaitHandle' },
        { key: 'due', label: '即将逾期', value: 'expireIn24HoursWaitHandle' },
      ];
      const derived = aftersaleState.statusCounts && typeof aftersaleState.statusCounts === 'object'
        ? aftersaleState.statusCounts
        : {};
      const overviewCounts = aftersaleState.overviewCounts && typeof aftersaleState.overviewCounts === 'object'
        ? aftersaleState.overviewCounts
        : {};
      const counts = {
        waitSellerHandle: Number(overviewCounts.waitSellerHandle ?? derived.waitSellerHandle ?? 0),
        platformHandling: Number(overviewCounts.platformHandling ?? derived.platformHandling ?? 0),
        waitBuyerHandle: Number(overviewCounts.waitBuyerHandle ?? derived.waitBuyerHandle ?? 0),
        returnedWaitHandle: Number(overviewCounts.returnedWaitHandle ?? derived.returnedWaitHandle ?? 0),
        expireIn24HoursWaitHandle: Number(overviewCounts.expireIn24HoursWaitHandle ?? derived.expireIn24HoursWaitHandle ?? 0),
      };
      const active = String(aftersaleState.statusFilter || '');
      tabsEl.innerHTML = quickTabs.map(tab => `
        <button
          type="button"
          class="ops-aftersale-tab${tab.value === active ? ' is-active' : ''}"
          data-aftersale-quick="${escape(tab.value)}"
        >
          <span>${escape(tab.label)}</span>
          <span class="ops-aftersale-tab-count">${escape(counts[tab.value] || 0)}</span>
        </button>
      `).join('');
    }

    function renderMeta() {
      const metaEl = element.querySelector('#opsAftersaleMeta');
      if (!metaEl) return;
      const parts = [];
      if (aftersaleState.loading) parts.push('正在通过接口获取售后列表…');
      if (!aftersaleState.loading && aftersaleState.overviewUpdatedAt) {
        parts.push(`合计更新：${formatTime(aftersaleState.overviewUpdatedAt)}`);
      }
      if (!aftersaleState.loading && aftersaleState.updatedAt) {
        parts.push(`已更新：${formatTime(aftersaleState.updatedAt)}`);
      }
      if (!aftersaleState.loading) {
        const listCount = Number(aftersaleState.rows.length || 0);
        const overviewCounts = aftersaleState.overviewCounts && typeof aftersaleState.overviewCounts === 'object'
          ? aftersaleState.overviewCounts
          : {};
        const overviewTotal = Object.keys(overviewCounts)
          .filter(key => key !== '2' && key !== '3')
          .reduce((sum, key) => sum + Number(overviewCounts[key] || 0), 0);
        parts.push(`列表 ${listCount} 条`);
        if (overviewTotal) parts.push(`合计 ${overviewTotal} 条`);
      }
      if (aftersaleState.error) parts.push(`失败：${escape(aftersaleState.error)}`);
      metaEl.innerHTML = parts.join(' ｜ ');
    }

    function renderDebugPanel() {
      const summaryMetaEl = element.querySelector('#opsAftersaleDebugSummaryMeta');
      const hintsEl = element.querySelector('#opsAftersaleDebugHints');
      const topKeysEl = element.querySelector('#opsAftersaleDebugTopKeys');
      const itemKeysEl = element.querySelector('#opsAftersaleDebugItemKeys');
      const jsonEl = element.querySelector('#opsAftersaleDebugJson');
      const copyBtn = element.querySelector('#btnAftersaleCopyDebug');

      if (!summaryMetaEl || !hintsEl || !topKeysEl || !itemKeysEl || !jsonEl || !copyBtn) return;

      if (!aftersaleState.lastApiAt) {
        summaryMetaEl.textContent = '（点击“接口获取”后显示）';
        hintsEl.textContent = '';
        topKeysEl.textContent = '';
        itemKeysEl.textContent = '';
        jsonEl.textContent = '';
        lastDebugJsonText = '';
        copyBtn.disabled = true;
        return;
      }

      summaryMetaEl.textContent = `（${formatTime(aftersaleState.lastApiAt)}）`;

      const hints = [];
      if (aftersaleState.lastApiParams) {
        hints.push(`请求参数：${safeJsonStringify(aftersaleState.lastApiParams, 0)}`);
      }
      if (aftersaleState.lastApiThrownError) {
        hints.push(`调用异常：${aftersaleState.lastApiThrownError}`);
      }

      const result = aftersaleState.lastApiResult;
      const failures = Array.isArray(result?.failures) ? result.failures : [];
      if (failures.length) {
        const samples = failures.slice(0, 5).map(item => {
          const name = String(item?.shopName || '').trim();
          const id = String(item?.shopId || '').trim();
          const prefix = name || (id ? `shopId=${id}` : '未知店铺');
          const message = String(item?.message || '').trim();
          return message ? `${prefix}：${message}` : prefix;
        }).filter(Boolean);
        hints.push(`失败店铺 ${failures.length} 个：${samples.join('；')}${failures.length > samples.length ? '…' : ''}`);
      }
      const topKeys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : [];
      topKeys.sort((a, b) => a.localeCompare(b, 'zh-CN'));
      topKeysEl.textContent = topKeys.length ? topKeys.join('\n') : '（无）';

      const list = Array.isArray(result?.list) ? result.list : [];
      if (list.length && list[0] && typeof list[0] === 'object' && !Array.isArray(list[0])) {
        const keys = Object.keys(list[0]);
        keys.sort((a, b) => a.localeCompare(b, 'zh-CN'));
        itemKeysEl.textContent = keys.join('\n');
      } else {
        itemKeysEl.textContent = '（无）';
      }

      if (Array.isArray(result?.list)) {
        const total = result?.total ? Number(result.total) : 0;
        hints.push(`list 共 ${list.length} 条${Number.isFinite(total) && total ? `（total=${total}）` : ''}；JSON 区域仅展示前 ${Math.min(3, list.length)} 条样例。`);
      }

      const snapshot = buildDebugSnapshot(result);
      lastDebugJsonText = safeJsonStringify(snapshot, 2);
      jsonEl.textContent = lastDebugJsonText;
      hintsEl.textContent = hints.join('\n');
      copyBtn.disabled = !lastDebugJsonText;
    }

    function renderStatusSelect() {
      const select = element.querySelector('#selectAftersaleStatus');
      if (!select) return;
      const currentValue = String(aftersaleState.statusFilter || '');
      const options = [
        { value: 'waitSellerHandle', label: '待商家处理' },
        { value: 'platformHandling', label: '平台处理中' },
        { value: 'waitBuyerHandle', label: '待买家处理' },
        { value: 'returnedWaitHandle', label: '退货待处理' },
        { value: 'expireIn24HoursWaitHandle', label: '即将逾期' },
      ];
      select.innerHTML = options.map(opt => `<option value="${escape(opt.value)}"${opt.value === currentValue ? ' selected' : ''}>${escape(opt.label)}</option>`).join('');
    }

    function buildRowActionsHtml(row) {
      const instanceId = row.instanceId ? escape(row.instanceId) : '';
      const actions = [];
      if (instanceId) actions.push(`<a class="ops-aftersale-link" href="#" data-action="copy-instance" data-value="${instanceId}">复制工单ID</a>`);
      actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="detail" data-order="${escape(row.orderNo || '')}" data-instance="${instanceId}">查看详情</a>`);
      return `<div class="ops-aftersale-actions">${actions.join('')}</div>`;
    }

    function buildRowHtml(row) {
      const {
        orderNo,
        title,
        goodsName,
        goodsSku,
        status,
        shopName,
        customer,
        createdAt,
        updatedAt,
        deadlineAtMs,
        refundAmount,
        paidAmount,
        afterSalesTypeName,
        afterSalesReasonDesc,
        shippingStatusDesc,
        shippingTrackingNo,
        returnTrackingNo,
        thumbUrl
      } = row;
      const isDue = Number.isFinite(deadlineAtMs) && (deadlineAtMs - Date.now() < 24 * 60 * 60 * 1000);
      const isOverdue = Number.isFinite(deadlineAtMs) && (deadlineAtMs < Date.now());

      const formatRemain = (ms) => {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${days}天${hours}时${minutes}分${seconds}秒`;
      };

      const countdownText = Number.isFinite(deadlineAtMs)
        ? (deadlineAtMs <= Date.now() ? '已逾期' : `${formatRemain(deadlineAtMs - Date.now())}未处理`)
        : '';

      const getOrderInfo = () => {
        const thumb = thumbUrl
          ? `<img src="${escape(thumbUrl)}" referrerpolicy="no-referrer" style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #eee;background:#f6f6f6" />`
          : `<div style="width:44px;height:44px;border-radius:6px;border:1px solid #eee;background:#f6f6f6"></div>`;
        let h = `<div style="display:flex;gap:10px;align-items:flex-start">`;
        h += `<div>${thumb}</div>`;
        h += `<div style="min-width:0">`;
        if (goodsName) {
          h += `<div style="font-size:12px" class="ops-aftersale-ellipsis" title="${escape(goodsName)}">${escape(goodsName)}</div>`;
        }
        if (goodsSku) h += `<div style="color:#999;font-size:12px">${escape(goodsSku)}</div>`;
        if (shopName) h += `<div style="color:#666;font-size:12px;margin-top:6px">${escape(shopName)}</div>`;
        if (customer) h += `<div style="color:#666;font-size:12px">${escape(customer)}</div>`;
        if (goodsName) {
          h += '';
        }
        h += `</div>`;
        h += `</div>`;
        return h;
      };

      const moneyHtml = `
        <div class="ops-aftersale-money">
          <div class="ops-aftersale-money-line">
            <span class="ops-aftersale-money-label">实收：</span>
            <span class="ops-aftersale-money-value">${escape(formatMoneyYuan(paidAmount))}</span>
          </div>
          <div class="ops-aftersale-money-line">
            <span class="ops-aftersale-money-label muted">退款：</span>
            <span class="ops-aftersale-money-value">${escape(formatMoneyYuan(refundAmount))}</span>
          </div>
        </div>
      `;

      return `
        <tr class="ops-aftersale-row-head">
          <td colspan="8">
            <div class="ops-aftersale-row-head-content">
              <div class="ops-aftersale-row-head-left">
                <span>订单号：</span>
                <span class="ops-aftersale-order-no">${escape(orderNo || '-')}</span>
                ${orderNo ? `<a class="ops-aftersale-link" href="#" data-action="copy-order" data-value="${escape(orderNo)}">复制</a>` : ''}
              </div>
              <div class="ops-aftersale-row-head-right">
                <span class="ops-aftersale-row-head-time">申请时间：${escape(createdAt || '-')}</span>
                ${countdownText ? `<span class="ops-aftersale-row-head-countdown${isOverdue ? ' is-overdue' : ''}">（${escape(countdownText)}）</span>` : ''}
                <a class="ops-aftersale-link" href="#" data-aftersale-action="contact" data-order="${escape(orderNo || '')}">联系消费者</a>
              </div>
            </div>
          </td>
        </tr>
        <tr class="ops-aftersale-row-detail">
          <td class="ops-aftersale-cell-order">${getOrderInfo()}</td>
          <td>${moneyHtml}</td>
          <td>
            <div class="ops-aftersale-status">
              <strong>${escape(shippingStatusDesc || '-')}</strong>
              <a class="ops-aftersale-link" href="#" data-aftersale-action="ship" data-value="${escape(shippingTrackingNo || '')}">查看运单</a>
            </div>
          </td>
          <td>${escape(afterSalesTypeName || '-')}</td>
          <td>
            <div class="ops-aftersale-status">
              <strong>${escape(status || '-')}</strong>
              ${isOverdue ? '<div class="ops-aftersale-due" style="color:#e02e24">已逾期</div>' : isDue ? '<div class="ops-aftersale-due">即将逾期</div>' : ''}
              <a class="ops-aftersale-link" href="#" data-aftersale-action="return-sn" data-value="${escape(returnTrackingNo || '')}">查看退货单号</a>
            </div>
          </td>
          <td>
            <a class="ops-aftersale-link" href="#" data-aftersale-action="remark" data-order="${escape(orderNo || '')}">添加备注</a>
          </td>
          <td>${escape(afterSalesReasonDesc || '-')}</td>
          <td>${buildRowActionsHtml(row)}</td>
        </tr>
      `;
    }

    function getFilteredRows() {
      const filterValue = String(aftersaleState.statusFilter || '').trim();
      const base = aftersaleState.rows.filter(row => !isClosedOrFinishedRow(row));
      if (filterValue === 'waitSellerHandle') return base.filter(row => [0, 1, 11].includes(Number(row?.serviceStatus)));
      if (filterValue === 'platformHandling') return base.filter(row => [8, 9].includes(Number(row?.serviceStatus)));
      if (filterValue === 'waitBuyerHandle') return base.filter(isBuyerPendingRow);
      if (filterValue === 'returnedWaitHandle') return base.filter(isReturnPendingRow);
      if (filterValue === 'expireIn24HoursWaitHandle') return base.filter(isDueSoonRow);
      return base;
    }

    function renderTable() {
      const tbody = element.querySelector('#opsAftersaleTableBody');
      if (!tbody) return;
      const rows = getFilteredRows();
      if (aftersaleState.loading) {
        tbody.innerHTML = `
          <tr class="ops-aftersale-table-placeholder is-loading">
            <td colspan="8">
              <span class="ops-aftersale-spinner" aria-hidden="true"></span>
              <span>加载中...</span>
            </td>
          </tr>
        `;
        return;
      }
      if (aftersaleState.error) {
        tbody.innerHTML = `
          <tr class="ops-aftersale-table-placeholder is-error">
            <td colspan="8">${escape(aftersaleState.error)}</td>
          </tr>
        `;
        return;
      }
      if (!rows.length) {
        tbody.innerHTML = `
          <tr class="ops-aftersale-table-placeholder is-empty">
            <td colspan="8">暂无数据</td>
          </tr>
        `;
        return;
      }
      tbody.innerHTML = rows.map(buildRowHtml).join('');
    }

    function renderAll() {
      renderTabs();
      renderStatusSelect();
      renderMeta();
      renderTable();
      renderDebugPanel();
    }

    async function fetchOverview() {
      if (!window.pddApi?.aftersaleGetOverview) return;
      try {
        const overview = await window.pddApi.aftersaleGetOverview({ shopId: '__all__' });
        if (overview?.error) return;
        aftersaleState.overviewCounts = overview?.counts && typeof overview.counts === 'object' ? overview.counts : {};
        aftersaleState.overviewTotal = Number(overview?.total || 0);
        aftersaleState.overviewUpdatedAt = Date.now();
        renderAll();
      } catch {}
    }

    async function fetchTicketList(options = {}) {
      if (!window.pddApi?.aftersaleGetList) {
        aftersaleState.loading = false;
        aftersaleState.error = '当前版本未暴露 aftersaleGetList 接口';
        renderAll();
        return;
      }
      aftersaleState.loading = true;
      aftersaleState.error = '';
      renderAll();
      const quickSearchType = Number.isFinite(Number(options.quickSearchType)) ? Number(options.quickSearchType) : null;
      const createStartTime = Number.isFinite(Number(options.createStartTime)) ? Number(options.createStartTime) : null;
      const createEndTime = Number.isFinite(Number(options.createEndTime)) ? Number(options.createEndTime) : null;
      const shouldSendSearchType = quickSearchType !== null;
      const params = {
        shopId: '__all__',
        pageNumber: 1,
        pageSize: 100,
        debug: true,
        orderByCreatedAtDesc: true,
        ...(shouldSendSearchType ? { quickSearchType } : {}),
        ...(createStartTime !== null ? { createStartTime } : {}),
        ...(createEndTime !== null ? { createEndTime } : {}),
      };
      try {
        aftersaleState.lastApiParams = null;
        aftersaleState.lastApiThrownError = '';

        let result = null;
        try {
          result = await window.pddApi.aftersaleGetList(params);
        } catch (err) {
          const message = String(err?.message || err || '');
          const canRetry = Boolean(params.quickSearchType) && message.includes('参数校验失败');
          if (!canRetry) throw err;
          const params2 = { ...params };
          delete params2.quickSearchType;
          result = await window.pddApi.aftersaleGetList(params2);
          aftersaleState.lastApiThrownError = message;
          aftersaleState.lastApiParams = params2;
        }
        aftersaleState.lastApiAt = Date.now();
        aftersaleState.lastApiParams = aftersaleState.lastApiParams || params;
        aftersaleState.lastApiResult = result;
        aftersaleState.lastApiThrownError = aftersaleState.lastApiThrownError || '';
        if (result?.error) {
          aftersaleState.error = result.error;
          aftersaleState.rows = [];
          aftersaleState.total = 0;
          aftersaleState.updatedAt = Date.now();
          aftersaleState.loading = false;
          renderAll();
          return;
        }
        const list = Array.isArray(result?.list) ? result.list : [];
        const failures = Array.isArray(result?.failures) ? result.failures : [];
        if (!list.length && failures.length) {
          const summary = failures
            .slice(0, 3)
            .map(item => {
              const name = String(item?.shopName || '').trim() || '未知店铺';
              const message = String(item?.message || '').trim();
              return message ? `${name}：${message}` : name;
            })
            .filter(Boolean)
            .join('；');
          aftersaleState.error = `接口请求失败（${failures.length} 个店铺）：${summary}${failures.length > 3 ? '…' : ''}`;
          aftersaleState.rows = [];
          aftersaleState.total = 0;
          aftersaleState.updatedAt = Date.now();
          aftersaleState.loading = false;
          renderAll();
          return;
        }
        const normalized = list.map(normalizeTicketToRow);
        const visible = normalized.filter(row => !isClosedOrFinishedRow(row));
        aftersaleState.rows = visible;
        aftersaleState.statusCounts = buildDerivedCounts(normalized);
        aftersaleState.total = getFilteredRows().length;
        aftersaleState.updatedAt = Date.now();
        aftersaleState.loading = false;
        renderAll();
      } catch (err) {
        aftersaleState.loading = false;
        aftersaleState.error = err?.message || String(err || '售后列表获取失败');
        aftersaleState.rows = [];
        aftersaleState.total = 0;
        aftersaleState.updatedAt = Date.now();
        aftersaleState.lastApiAt = Date.now();
        aftersaleState.lastApiParams = params;
        aftersaleState.lastApiResult = null;
        aftersaleState.lastApiThrownError = err?.message || String(err || '售后列表获取失败');
        renderAll();
      }
    }

    const refreshBtn = element.querySelector('#btnAftersaleRefresh');
    refreshBtn?.addEventListener('click', async () => {
      fetchOverview();
      fetchTicketList();
    });

    element.querySelector('#btnAftersaleCopyDebug')?.addEventListener('click', async (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      try {
        await copyText(lastDebugJsonText);
        window.opsCenterToast?.('已复制');
      } catch (err) {
        window.opsCenterToast?.('复制失败');
      }
    });

    element.querySelector('#selectAftersaleStatus')?.addEventListener('change', (event) => {
      const value = String(event?.target?.value || '').trim();
      aftersaleState.statusFilter = value;
      renderAll();
    });

    element.addEventListener('click', async (event) => {
      const quickBtn = event.target?.closest?.('button[data-aftersale-quick]');
      if (quickBtn) {
        const value = String(quickBtn.dataset.aftersaleQuick || '').trim();
        aftersaleState.statusFilter = value;
        renderAll();
        return;
      }

      const copyBtn = event.target?.closest?.('button[data-copy]');
      if (copyBtn) {
        event.preventDefault?.();
        try {
          await copyText(copyBtn.dataset.copy || '');
          window.opsCenterToast?.('已复制');
        } catch (err) {
          window.opsCenterToast?.('复制失败');
        }
        return;
      }

      const actionLink = event.target?.closest?.('a[data-action]');
      if (actionLink) {
        event.preventDefault?.();
        const action = String(actionLink.dataset.action || '').trim();
        const value = String(actionLink.dataset.value || '').trim();
        if (action === 'copy-order' || action === 'copy-instance') {
          try {
            await copyText(value);
            window.opsCenterToast?.('已复制');
          } catch {
            window.opsCenterToast?.('复制失败');
          }
          return;
        }
      }

      const legacyActionLink = event.target?.closest?.('a[data-aftersale-action]');
      if (legacyActionLink) {
        event.preventDefault?.();
        const action = String(legacyActionLink.dataset.aftersaleAction || '').trim();
        const value = String(legacyActionLink.dataset.value || '').trim();
        if (action === 'detail') {
          window.opsCenterToast?.('详情入口已预留（后续可接入详情抽屉/弹窗）');
          return;
        }
        if (action === 'contact') {
          window.opsCenterToast?.('联系消费者入口已预留');
          return;
        }
        if (action === 'ship') {
          if (!value) {
            window.opsCenterToast?.('当前记录未返回运单号');
            return;
          }
          try {
            await copyText(value);
            window.opsCenterToast?.('已复制运单号');
          } catch {
            window.opsCenterToast?.('复制失败');
          }
          return;
        }
        if (action === 'return-sn') {
          if (!value) {
            window.opsCenterToast?.('当前记录未返回退货单号');
            return;
          }
          try {
            await copyText(value);
            window.opsCenterToast?.('已复制退货单号');
          } catch {
            window.opsCenterToast?.('复制失败');
          }
          return;
        }
        if (action === 'remark') {
          window.opsCenterToast?.('备注入口已预留');
          return;
        }
        window.opsCenterToast?.('操作入口已预留');
      }
    });

    window.pddApi?.onShopSwitched?.(() => {
      aftersaleState.rows = [];
      aftersaleState.total = 0;
      aftersaleState.error = '';
      aftersaleState.loading = true;
      aftersaleState.updatedAt = 0;
      aftersaleState.statusFilter = 'waitSellerHandle';
      aftersaleState.overviewCounts = null;
      aftersaleState.overviewTotal = 0;
      aftersaleState.overviewUpdatedAt = 0;
      aftersaleState.statusCounts = {};
      aftersaleState.lastApiAt = 0;
      aftersaleState.lastApiParams = null;
      aftersaleState.lastApiResult = null;
      aftersaleState.lastApiThrownError = '';
      renderAll();
      fetchOverview();
      fetchTicketList();
    });

    aftersaleState.loading = true;
    aftersaleState.error = '';
    renderAll();
    fetchOverview();
    fetchTicketList();
  }
});
