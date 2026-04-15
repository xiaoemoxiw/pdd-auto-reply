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
  statusCounts: {}
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
  const afterSalesType = Number(pickFirst(item, ['afterSalesType', 'after_sales_type'], Number.NaN));
  const rawAfterSalesTypeName = String(pickFirst(item, ['afterSalesTypeName', 'after_sales_type_name'], '') || '').trim();
  const afterSalesTypeName = rawAfterSalesTypeName || ({
    1: '仅退款',
    2: '退货退款',
    3: '换货',
    4: '补寄',
  }[Number.isFinite(afterSalesType) ? afterSalesType : 0] || '');
  const afterSalesReasonDesc = String(pickFirst(item, ['afterSalesReasonDesc', 'after_sales_reason_desc'], '') || '').trim();
  const shippingStatusDesc = String(pickFirst(item, ['sellerAfterSalesShippingStatusDesc', 'seller_after_sales_shipping_status_desc'], '') || '').trim();
  const orderTrackingNumber = String(pickFirst(item, ['orderTrackingNumber', 'order_tracking_number', 'orderTrackingNo', 'order_tracking_no'], '') || '').trim();
  const shippingTrackingNo = String(pickFirst(item, [
    'orderTrackingNumber',
    'order_tracking_number',
    'orderTrackingNo',
    'order_tracking_no',
    'trackingNumber',
    'tracking_number',
    'expressNo',
    'express_no',
    'shipTrackingNumber',
    'ship_tracking_number',
  ], '') || '').trim();
  const returnTrackingNo = String(pickFirst(item, ['reverseTrackingNumber', 'reverse_tracking_number', 'returnTrackingNumber', 'return_tracking_number', 'returnShippingNo', 'return_shipping_no'], '') || '').trim();
  const returnAddressId = String(pickFirst(item, ['returnAddressId', 'return_address_id'], '') || '').trim();
  const version = Number(pickFirst(item, ['version'], Number.NaN));
  const rawActions = pickFirst(item, ['actions', 'actionList', 'action_list'], null);
  const actions = Array.isArray(rawActions)
    ? rawActions.map(Number).filter(Number.isFinite)
    : [];
  const thumbUrl = String(pickFirst(item, ['thumbUrl', 'thumb_url', 'goodsThumbUrl', 'goods_thumb_url'], '') || '').trim();
  const mallRemark = String(pickFirst(item, ['mallRemark', 'mall_remark'], '') || '').trim();
  const mallRemarkTagRaw = pickFirst(item, ['mallRemarkTag', 'mall_remark_tag'], null);
  const mallRemarkTag = Number.isFinite(Number(mallRemarkTagRaw)) ? Number(mallRemarkTagRaw) : null;

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
    afterSalesType: Number.isFinite(afterSalesType) ? afterSalesType : null,
    refundAmount,
    paidAmount,
    afterSalesTypeName,
    afterSalesReasonDesc,
    shippingStatusDesc,
    shippingTrackingNo,
    orderTrackingNumber,
    returnTrackingNo,
    returnAddressId,
    version: Number.isFinite(version) ? version : null,
    actions,
    thumbUrl,
    mallRemark,
    mallRemarkTag,
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
      </div>
    `;
  },
  onMount(element) {
    const actionLocks = new Set();

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

    function wait(ms) {
      const value = Number(ms);
      const duration = Number.isFinite(value) && value > 0 ? value : 0;
      return new Promise(resolve => setTimeout(resolve, duration));
    }

    function clampCount(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n)) return 0;
      return n < 0 ? 0 : n;
    }

    function decCount(obj, key, delta = 1) {
      if (!obj || typeof obj !== 'object') return;
      const d = Number(delta || 0);
      if (!Number.isFinite(d) || d <= 0) return;
      obj[key] = clampCount(Number(obj[key] || 0) - d);
    }

    function optimisticRemoveRowByInstanceId(instanceId) {
      const target = String(instanceId || '').trim();
      if (!target) return false;
      const idx = aftersaleState.rows.findIndex(row => String(row?.instanceId || '').trim() === target);
      if (idx < 0) return false;
      const row = aftersaleState.rows[idx];
      aftersaleState.rows = aftersaleState.rows.filter(r => String(r?.instanceId || '').trim() !== target);

      const derived = aftersaleState.statusCounts && typeof aftersaleState.statusCounts === 'object'
        ? aftersaleState.statusCounts
        : null;
      const overview = aftersaleState.overviewCounts && typeof aftersaleState.overviewCounts === 'object'
        ? aftersaleState.overviewCounts
        : null;

      if (isSellerPendingRow(row)) {
        decCount(derived, 'waitSellerHandle', 1);
        decCount(overview, 'waitSellerHandle', 1);
      }
      if ([8, 9].includes(Number(row?.serviceStatus))) {
        decCount(derived, 'platformHandling', 1);
        decCount(overview, 'platformHandling', 1);
      }
      if (isBuyerPendingRow(row)) {
        decCount(derived, 'waitBuyerHandle', 1);
        decCount(overview, 'waitBuyerHandle', 1);
      }
      if (isReturnPendingRow(row)) {
        decCount(derived, 'returnedWaitHandle', 1);
        decCount(overview, 'returnedWaitHandle', 1);
      }
      if (isDueSoonRow(row)) {
        decCount(derived, 'expireIn24HoursWaitHandle', 1);
        decCount(overview, 'expireIn24HoursWaitHandle', 1);
      }

      aftersaleState.total = getFilteredRows().length;
      aftersaleState.updatedAt = Date.now();
      renderAll();
      return true;
    }

    function isDueSoonRow(row) {
      const ms = Number(row?.deadlineAtMs);
      if (!Number.isFinite(ms) || ms <= 0) return false;
      const remain = ms - Date.now();
      return remain > 0 && remain <= 24 * 60 * 60 * 1000;
    }

    function normalizeText(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function isSellerPendingRow(row) {
      const status = Number(row?.serviceStatus);
      if ([0, 1, 2, 3, 11, 32].includes(status)) return true;
      const afterSalesType = Number(row?.afterSalesType);
      if ([3, 4].includes(afterSalesType)) return true;
      const text = normalizeText([row?.title, row?.status].filter(Boolean).join(' '));
      if (!text) return false;
      return ['待商家', '待卖家', '待商户', '待商户处理', '待商家处理'].some(key => text.includes(key));
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
      const afterSalesType = Number(row?.afterSalesType);
      const closeTime = Number(row?.raw?.closeTime ?? row?.raw?.close_time ?? 0);
      if (Number.isFinite(closeTime) && closeTime > 0) return true;

      if ([3, 4].includes(afterSalesType)) {
        const text = normalizeText([row?.title, row?.status].filter(Boolean).join(' '));
        const looksPendingSeller = ['待商家', '待卖家', '待商户', '待商户处理', '待商家处理'].some(key => text.includes(key));
        if (looksPendingSeller) return false;
        const deadlineAtMs = Number(row?.deadlineAtMs);
        if (Number.isFinite(deadlineAtMs) && deadlineAtMs > Date.now()) return false;
        return status === 15 || status === 16 || status === 12;
      }

      // 退款/退货退款：这里做防御性判断
      return status === 14 || status === 15 || status === 16 || status === 12;
    }

    function buildDerivedCounts(rows) {
      const base = (Array.isArray(rows) ? rows : []).filter(row => !isClosedOrFinishedRow(row));
      const counts = {
        waitSellerHandle: base.filter(isSellerPendingRow).length,
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
        // parts.push(`列表 ${listCount} 条`);
        // if (overviewTotal) parts.push(`合计 ${overviewTotal} 条`);
      }
      if (aftersaleState.error) parts.push(`失败：${escape(aftersaleState.error)}`);
      metaEl.innerHTML = parts.join(' ｜ ');
    }

    function buildRowActionsHtml(row) {
      const instanceId = row.instanceId ? escape(row.instanceId) : '';
      const orderNo = row.orderNo ? escape(row.orderNo) : '';
      const shopId = row.shopId ? escape(String(row.shopId)) : '';
      const version = row.version !== null && row.version !== undefined ? escape(String(row.version)) : '';
      const canRejectRefund = Number(row?.serviceStatus) === 1 && row.afterSalesType === 1;
      const afterSalesType = Number(row?.afterSalesType);
      const canApproveReturnGoods = afterSalesType === 2 && (
        Number(row?.serviceStatus) === 1
        || (Array.isArray(row?.actions) && row.actions.includes(1002))
      );
      const isResend = afterSalesType === 4;
      const isExchange = afterSalesType === 3;
      const canApproveResend = isResend && Number(row?.serviceStatus) === 14;
      const canFillResendTracking = isResend && Number(row?.serviceStatus) === 32;
      const canApproveRefund = !isResend && !isExchange;
      const actions = [];
      if (instanceId && canApproveReturnGoods) actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="approve-return-goods" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}" data-version="${version}">同意退货</a>`);
      if (instanceId && canApproveRefund) actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="approve-refund" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}" data-version="${version}">同意退款</a>`);
      if (instanceId && canApproveResend) actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="approve-resend" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}" data-version="${version}">同意补寄</a>`);
      if (instanceId && canFillResendTracking) actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="resend-fill-tracking" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}">已补寄，填写补寄单号</a>`);
      if (instanceId && isExchange) actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="approve-exchange" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}">同意换货</a>`);
      if (instanceId && canRejectRefund) actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="reject-refund" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}">驳回退款</a>`);
      actions.push(`<a class="ops-aftersale-link" href="#" data-aftersale-action="detail" data-shop="${shopId}" data-order="${orderNo}" data-instance="${instanceId}">查看详情</a>`);
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
        shopId,
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
        thumbUrl,
        mallRemark,
        mallRemarkTag
      } = row;
      const isDue = Number.isFinite(deadlineAtMs) && (deadlineAtMs - Date.now() < 24 * 60 * 60 * 1000);
      const isOverdue = Number.isFinite(deadlineAtMs) && (deadlineAtMs < Date.now());

      const getMallRemarkTagMeta = (value) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return { label: '', color: '' };
        if (v === 1) return { label: '红色', color: 'red' };
        if (v === 2) return { label: '黄色', color: 'yellow' };
        if (v === 3) return { label: '绿色', color: 'green' };
        if (v === 4) return { label: '蓝色', color: 'blue' };
        if (v === 5) return { label: '紫色', color: 'purple' };
        return { label: '', color: '' };
      };

      const formatRemain = (ms) => {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${days}天${hours}时${minutes}分${seconds}秒`;
      };

      const countdownText = Number.isFinite(deadlineAtMs)
        ? (deadlineAtMs <= Date.now() ? '已逾期' : `${formatRemain(deadlineAtMs - Date.now())}未处理，系统将自动退款`)
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

      const mallRemarkText = String(mallRemark || '').trim();
      const mallRemarkTagMeta = getMallRemarkTagMeta(mallRemarkTag);
      const mallRemarkHtml = mallRemarkText
        ? `
          <div class="ops-aftersale-mall-remark" title="${escape(mallRemarkText)}">
            ${mallRemarkTagMeta.color ? `<span class="ops-aftersale-mall-remark-dot is-${escape(mallRemarkTagMeta.color)}"></span>` : ''}
            ${mallRemarkTagMeta.label ? `<span class="ops-aftersale-mall-remark-tag">${escape(mallRemarkTagMeta.label)}：</span>` : ''}
            <span class="ops-aftersale-mall-remark-text">${escape(mallRemarkText)}</span>
          </div>
        `
        : '';

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
                ${countdownText ? `<span class="ops-aftersale-row-head-countdown${isOverdue ? ' is-overdue' : isDue ? ' is-due-soon' : ''}">（${escape(countdownText)}）</span>` : ''}
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
              <a class="ops-aftersale-link" href="#" data-aftersale-action="ship" data-instance="${escape(String(row?.instanceId || ''))}" data-shop="${escape(shopId || '')}" data-order="${escape(orderNo || '')}" data-value="${escape(shippingTrackingNo || '')}">查看运单</a>
            </div>
          </td>
          <td>${escape(afterSalesTypeName || '-')}</td>
          <td>
            <div class="ops-aftersale-status">
              <strong>${escape(status || '-')}</strong>
              ${isOverdue ? '<div class="ops-aftersale-due" style="color:#e02e24">已逾期</div>' : (isDue && returnTrackingNo ? '<div class="ops-aftersale-due">即将逾期</div>' : '')}
              ${returnTrackingNo ? `<a class="ops-aftersale-link" href="#" data-aftersale-action="return-sn" data-instance="${escape(String(row?.instanceId || ''))}" data-shop="${escape(shopId || '')}" data-order="${escape(orderNo || '')}" data-value="${escape(returnTrackingNo)}">查看退货单号</a>` : ''}
            </div>
          </td>
          <td>
            ${mallRemarkHtml}
            <a class="ops-aftersale-link" href="#" data-aftersale-action="remark" data-order="${escape(orderNo || '')}" data-shop="${escape(shopId || '')}">添加备注</a>
          </td>
          <td>${escape(afterSalesReasonDesc || '-')}</td>
          <td>${buildRowActionsHtml(row)}</td>
        </tr>
      `;
    }

    function getFilteredRows() {
      const filterValue = String(aftersaleState.statusFilter || '').trim();
      const base = aftersaleState.rows.filter(row => !isClosedOrFinishedRow(row));
      if (filterValue === 'waitSellerHandle') return base.filter(isSellerPendingRow);
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
      renderMeta();
      renderTable();
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
      const silent = !!options.silent;
      if (!silent) {
        aftersaleState.loading = true;
        aftersaleState.error = '';
        renderAll();
      }
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
        }
        if (result?.error) {
          if (!silent || !aftersaleState.rows.length) {
            aftersaleState.error = result.error;
            aftersaleState.rows = [];
            aftersaleState.total = 0;
            aftersaleState.updatedAt = Date.now();
            aftersaleState.loading = false;
            renderAll();
          }
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
          if (!silent || !aftersaleState.rows.length) {
            aftersaleState.error = `接口请求失败（${failures.length} 个店铺）：${summary}${failures.length > 3 ? '…' : ''}`;
            aftersaleState.rows = [];
            aftersaleState.total = 0;
            aftersaleState.updatedAt = Date.now();
            aftersaleState.loading = false;
            renderAll();
          }
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
        if (!silent || !aftersaleState.rows.length) {
          aftersaleState.loading = false;
          aftersaleState.error = err?.message || String(err || '售后列表获取失败');
          aftersaleState.rows = [];
          aftersaleState.total = 0;
          aftersaleState.updatedAt = Date.now();
          renderAll();
        }
      }
    }

    window.__opsAftersaleRefreshHandler = async () => {
      await Promise.all([fetchOverview(), fetchTicketList()]);
    };
    if (!window.__opsAftersaleRefreshBound) {
      window.__opsAftersaleRefreshBound = true;
      const handleAftersaleChanged = async (event) => {
        try {
          const targetInstanceId = String(event?.detail?.id || '').trim();
          const shouldOptimisticRemove = !!event?.detail?.optimisticRemove;
          if (shouldOptimisticRemove && targetInstanceId) {
            optimisticRemoveRowByInstanceId(targetInstanceId);
            return;
          }
          await wait(300);
          for (let round = 0; round < 4; round += 1) {
            await Promise.all([fetchOverview(), fetchTicketList({ silent: round > 0 })]);
            if (!targetInstanceId) break;
            const stillVisible = aftersaleState.rows.some(row => String(row?.instanceId || '').trim() === targetInstanceId);
            if (!stillVisible) break;
            await wait(800);
          }
        } catch {}
      };
      window.addEventListener('ops-aftersale-approved-return', handleAftersaleChanged);
      window.addEventListener('ops-aftersale-rejected-refund', handleAftersaleChanged);
    }

    const refreshBtn = element.querySelector('#btnAftersaleRefresh');
    refreshBtn?.addEventListener('click', async () => {
      await window.__opsAftersaleRefreshHandler?.();
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
        const instanceId = String(legacyActionLink.dataset.instance || '').trim();
        if (action === 'approve-refund') {
          if (!instanceId) {
            window.opsCenterToast?.('当前记录缺少售后单ID');
            return;
          }
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          const shopId = String(legacyActionLink.dataset.shop || '').trim();
          if (!orderNo) {
            window.opsCenterToast?.('当前记录缺少订单号');
            return;
          }
          if (!shopId) {
            window.opsCenterToast?.('当前记录缺少店铺信息');
            return;
          }
          if (!window.pddApi?.aftersaleAgreeRefundPreCheck) {
            window.opsCenterToast?.('当前版本未暴露 aftersaleAgreeRefundPreCheck 接口');
            return;
          }
          const lockKey = `approve-refund-precheck:${shopId}:${instanceId}`;
          if (actionLocks.has(lockKey)) return;
          actionLocks.add(lockKey);
          try {
            const resp = await window.pddApi.aftersaleAgreeRefundPreCheck({
              shopId,
              afterSalesId: instanceId,
              orderSn: orderNo,
            });
            if (resp?.error) {
              window.opsCenterToast?.(String(resp.error || '同意退款预检查失败'));
              return;
            }
            const precheck = resp?.result && typeof resp.result === 'object' ? resp.result : (resp?.payload?.result && typeof resp.payload.result === 'object' ? resp.payload.result : null);
            if (precheck?.tipSellerAccountAbnormal === true) {
              if (typeof window.openOpsAfterSaleApproveRefundPrecheckDialog === 'function') {
                window.openOpsAfterSaleApproveRefundPrecheckDialog({
                  title: '您当前店铺的货款余额不足',
                  message: '您当前店铺的货款余额不足（账户资金受限），为保证店铺正常运营，请您至少充值100元后再进行售后处理操作',
                });
              } else {
                window.opsCenterToast?.('您当前店铺的货款余额不足（账户资金受限），请至少充值100元后再进行售后处理操作');
              }
              return;
            }
            window.opsCenterToast?.('预检查通过，同意退款提交入口已预留');
          } catch (err) {
            window.opsCenterToast?.(err?.message || String(err || '同意退款预检查失败'));
          } finally {
            actionLocks.delete(lockKey);
          }
          return;
        }
          if (action === 'approve-resend') {
            if (!instanceId) {
              window.opsCenterToast?.('当前记录缺少售后单ID');
              return;
            }
            const orderNo = String(legacyActionLink.dataset.order || '').trim();
            const shopId = String(legacyActionLink.dataset.shop || '').trim();
            const version = String(legacyActionLink.dataset.version || '').trim();
            if (!version) {
              window.opsCenterToast?.('当前记录缺少版本号');
              return;
            }
            if (!window.pddApi?.aftersaleApproveResend) {
              window.opsCenterToast?.('当前版本未暴露 aftersaleApproveResend 接口');
              return;
            }
            if (typeof window.openOpsAfterSaleResendTrackingDialog === 'function') {
              window.openOpsAfterSaleResendTrackingDialog({ instanceId, orderNo, shopId, agreedHint: true })
                ?.catch?.(() => {});
            } else {
              window.opsCenterToast?.('补寄单号弹窗未加载');
            }
            const lockKey = `approve-resend:${shopId}:${instanceId}`;
            if (actionLocks.has(lockKey)) return;
            actionLocks.add(lockKey);
            try {
              const result = await window.pddApi.aftersaleApproveResend({
                shopId,
                id: instanceId,
                orderSn: orderNo,
                version: Number(version),
                frontAction: 1017,
              });
              if (result?.error) {
                window.opsCenterToast?.(String(result.error || '同意补寄失败'));
                return;
              }
              window.opsCenterToast?.('已提交同意补寄');
            } catch (err) {
              window.opsCenterToast?.(err?.message || String(err || '同意补寄失败'));
            } finally {
              actionLocks.delete(lockKey);
            }
            return;
          }
          if (action === 'resend-fill-tracking') {
            if (!instanceId) {
              window.opsCenterToast?.('当前记录缺少售后单ID');
              return;
            }
            const orderNo = String(legacyActionLink.dataset.order || '').trim();
            const shopId = String(legacyActionLink.dataset.shop || '').trim();
            if (typeof window.openOpsAfterSaleResendTrackingDialog === 'function') {
              const result = await window.openOpsAfterSaleResendTrackingDialog({ instanceId, orderNo, shopId });
              const trackingNo = String(result?.trackingNo || '').trim();
              const companyName = String(result?.companyName || result?.company || '').trim();
              if (!trackingNo || !companyName) return;
              window.opsCenterToast?.(`补寄单号已填写：${trackingNo}（提交入口已预留）`);
            } else {
              window.opsCenterToast?.('补寄单号弹窗未加载');
            }
            return;
          }
          if (action === 'approve-exchange') {
            if (!instanceId) {
              window.opsCenterToast?.('当前记录缺少售后单ID');
              return;
            }
            window.opsCenterToast?.('同意换货入口已预留');
            return;
          }
        if (action === 'approve-return-goods') {
          if (!instanceId) {
            window.opsCenterToast?.('当前记录缺少售后单ID');
            return;
          }
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          const shopId = String(legacyActionLink.dataset.shop || '').trim();
          const version = String(legacyActionLink.dataset.version || '').trim();
          if (typeof window.openOpsAfterSaleApproveReturnGoodsDialog === 'function') {
            window.openOpsAfterSaleApproveReturnGoodsDialog({ instanceId, orderNo, shopId, version });
          } else {
            window.opsCenterToast?.('同意退货弹窗未加载');
          }
          return;
        }
        if (action === 'reject-refund') {
          if (!instanceId) {
            window.opsCenterToast?.('当前记录缺少售后单ID');
            return;
          }
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          const shopId = String(legacyActionLink.dataset.shop || '').trim();
          const version = String(legacyActionLink.dataset.version || '').trim();
          if (!orderNo) {
            window.opsCenterToast?.('当前记录缺少订单号');
            return;
          }
          if (!shopId) {
            window.opsCenterToast?.('当前记录缺少店铺信息');
            return;
          }
          if (!version) {
            window.opsCenterToast?.('当前记录缺少版本号');
            return;
          }
          if (typeof window.openOpsAfterSaleRejectRefundDialog === 'function') {
            window.openOpsAfterSaleRejectRefundDialog({
              instanceId,
              orderNo,
              shopId,
              version: Number(version),
            })?.catch?.(() => {});
          } else {
            window.opsCenterToast?.('驳回退款弹窗未加载');
          }
          return;
        }
        if (action === 'detail') {
          if (!instanceId) {
            window.opsCenterToast?.('当前记录缺少售后单ID');
            return;
          }
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          const shopId = String(legacyActionLink.dataset.shop || '').trim();
          try {
            if (window.pddApi && typeof window.pddApi.openAfterSaleDetailWindow === 'function') {
              Promise.resolve(window.pddApi.openAfterSaleDetailWindow({ instanceId, orderNo, shopId })).then((res) => {
                if (res && res.error) window.opsCenterToast?.(String(res.error || '').trim() || '打开失败');
              }).catch(() => {
                window.opsCenterToast?.('打开失败');
              });
            } else {
              window.opsCenterToast?.('详情窗口能力未就绪');
            }
          } catch (error) {
            window.opsCenterToast?.('打开失败');
          }
          return;
        }
        if (action === 'contact') {
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          if (!orderNo) {
            window.opsCenterToast?.('当前记录缺少订单号');
            return;
          }
          window.__pendingOpenApiChatOrderSn = orderNo;
          const targetNav = document.querySelector('.nav-item[data-view="chat-api"]');
          if (targetNav) {
            targetNav.click();
          } else {
            window.opsCenterToast?.('未找到客户对话（接口对接）页面入口');
          }
          return;
        }
        if (action === 'ship') {
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          if (!orderNo) {
            window.opsCenterToast?.('当前记录缺少订单号');
            return;
          }
          const candidateInstanceId = String(legacyActionLink.dataset.instance || '').trim();
          const row = candidateInstanceId
            ? aftersaleState.rows.find(item => String(item?.instanceId || '').trim() === candidateInstanceId)
            : null;
          const shopId = String(legacyActionLink.dataset.shop || row?.shopId || '').trim();
          if (!shopId) {
            window.opsCenterToast?.('当前记录缺少店铺信息');
            return;
          }
          const raw = row?.raw && typeof row.raw === 'object' ? row.raw : null;
          const carrier = raw
            ? String(pickFirst(raw, [
              'shippingName',
              'shipping_name',
              'shippingCompanyName',
              'shipping_company_name',
              'orderShippingName',
              'order_shipping_name',
              'expressName',
              'express_name',
              'expressCompany',
              'express_company',
              'companyName',
              'company_name',
              'logisticsCompanyName',
              'logistics_company_name',
            ], '') || '').trim()
            : '';
          const trackingNumber = raw
            ? String(pickFirst(raw, [
              'orderTrackingNumber',
              'order_tracking_number',
              'orderTrackingNo',
              'order_tracking_no',
              'trackingNumber',
              'tracking_number',
              'expressNo',
              'express_no',
              'shipTrackingNumber',
              'ship_tracking_number',
            ], value) || '').trim()
            : value;
          if (typeof window.openOpsAfterSaleOrderTrackingDialog === 'function') {
            window.openOpsAfterSaleOrderTrackingDialog({
              shopId,
              orderNo,
              trackingNumber,
              orderTrackingNumber: trackingNumber,
              carrier,
              raw,
            });
            return;
          }
          try {
            if (!value) {
              window.opsCenterToast?.('当前版本未加载物流弹窗');
              return;
            }
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
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          if (!orderNo) {
            window.opsCenterToast?.('当前记录缺少订单号');
            return;
          }
          const candidateInstanceId = String(legacyActionLink.dataset.instance || '').trim();
          const row = candidateInstanceId
            ? aftersaleState.rows.find(item => String(item?.instanceId || '').trim() === candidateInstanceId)
            : null;
          const shopId = String(legacyActionLink.dataset.shop || row?.shopId || '').trim();
          if (!shopId) {
            window.opsCenterToast?.('当前记录缺少店铺信息');
            return;
          }
          const raw = row?.raw && typeof row.raw === 'object' ? row.raw : null;
          const carrier = raw
            ? String(pickFirst(raw, [
              'reverseShippingName',
              'reverse_shipping_name',
              'reverseExpressName',
              'reverse_express_name',
              'returnShippingName',
              'return_shipping_name',
              'returnExpressName',
              'return_express_name',
              'shippingName',
              'shipping_name',
            ], '') || '').trim()
            : '';
          if (typeof window.openOpsAfterSaleOrderTrackingDialog === 'function') {
            window.openOpsAfterSaleOrderTrackingDialog({
              shopId,
              orderNo,
              queryType: 2,
              trackingLabel: '退货单号',
              trackingNumber: value,
              carrier,
              raw,
            });
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
          const orderNo = String(legacyActionLink.dataset.order || '').trim();
          const shopId = String(legacyActionLink.dataset.shop || '').trim();
          if (!orderNo) {
            window.opsCenterToast?.('当前记录缺少订单号');
            return;
          }
          if (typeof window.openOpsAfterSaleRemarkDialog === 'function') {
            window.openOpsAfterSaleRemarkDialog({ orderNo, shopId })
              ?.then?.(async (result) => {
                if (!result || result?.error) return;
                await wait(300);
                await window.__opsAftersaleRefreshHandler?.();
              })
              ?.catch?.(() => {});
          } else {
            window.opsCenterToast?.('备注弹窗未加载');
          }
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
