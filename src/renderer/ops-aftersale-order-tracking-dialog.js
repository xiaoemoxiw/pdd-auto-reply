(function () {
  const MODAL_ID = 'modalOpsAfterSaleOrderTracking';
  const state = {
    mounted: false,
    resolver: null,
    context: null,
    requestSeq: 0,
  };

  function getTrackingLabel(context) {
    const custom = String(context?.trackingLabel || '').trim();
    if (custom) return custom;
    const queryType = Number(context?.queryType);
    if (Number.isFinite(queryType) && queryType === 2) return '退货单号';
    return '运单号';
  }

  function getEl(id) {
    return document.getElementById(id);
  }

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
    const stamp = Number.isFinite(maybeNumber) ? maybeNumber : Number.NaN;
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
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  }

  function closeDialog(result) {
    if (typeof window.hideModal === 'function') {
      window.hideModal(MODAL_ID);
    } else {
      getEl(MODAL_ID)?.classList.remove('visible');
    }
    const resolver = state.resolver;
    state.resolver = null;
    state.context = null;
    resolver?.(result ?? null);
  }

  function renderProgressList(progress = []) {
    if (!Array.isArray(progress) || !progress.length) {
      return `<div class="ops-aftersale-tracking-empty">暂无物流轨迹</div>`;
    }
    const items = progress
      .map((item, idx) => {
        const isCurrent = idx === 0;
        const time = formatTime(item?.time || item?.timeText || '');
        const desc = String(item?.desc || item?.text || item?.message || '').trim();
        return `
          <div class="ops-aftersale-tracking-item${isCurrent ? ' is-current' : ''}">
            <div class="ops-aftersale-tracking-point" aria-hidden="true"></div>
            <div class="ops-aftersale-tracking-desc">${escape(desc || '-')}</div>
            <div class="ops-aftersale-tracking-time">${escape(time || '')}</div>
          </div>
        `;
      })
      .join('');
    return `<div class="ops-aftersale-tracking-list">${items}</div>`;
  }

  function renderLoading() {
    return `
      <div class="ops-aftersale-tracking-loading">
        <span class="ops-aftersale-spinner" aria-hidden="true"></span>
        <span>加载中...</span>
      </div>
    `;
  }

  function renderError(message) {
    const text = String(message || '').trim();
    return `<div class="ops-aftersale-tracking-empty">${escape(text || '物流信息获取失败')}</div>`;
  }

  function normalizeProgress(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const normalized = list
      .map(item => {
        const time = item?.time
          ?? item?.acceptTime
          ?? item?.accept_time
          ?? item?.updateTime
          ?? item?.update_time
          ?? item?.createdTime
          ?? item?.created_time
          ?? item?.operateTime
          ?? item?.operate_time
          ?? item?.timestamp
          ?? item?.trackTime
          ?? item?.track_time
          ?? item?.traceTime
          ?? item?.trace_time
          ?? item?.date
          ?? item?.datetime
          ?? item?.timeStr
          ?? item?.time_str;
        const desc = item?.context
          ?? item?.desc
          ?? item?.description
          ?? item?.trackingDesc
          ?? item?.tracking_desc
          ?? item?.statusDesc
          ?? item?.status_desc
          ?? item?.info
          ?? item?.message
          ?? item?.remark
          ?? item?.note
          ?? item?.content
          ?? item?.text;
        const timeMs = parseTimestampToMs(time);
        return {
          time,
          timeMs,
          desc: String(desc ?? '').trim(),
        };
      })
      .filter(item => item.desc || Number.isFinite(item.timeMs));

    const hasSortableTime = normalized.some(item => Number.isFinite(item.timeMs));
    if (hasSortableTime) {
      normalized.sort((a, b) => {
        const aMs = Number.isFinite(a.timeMs) ? a.timeMs : -Infinity;
        const bMs = Number.isFinite(b.timeMs) ? b.timeMs : -Infinity;
        return bMs - aMs;
      });
    }
    return normalized;
  }

  function pickFirstArray(source, keys) {
    for (const key of keys) {
      const value = source?.[key];
      if (Array.isArray(value) && value.length) return value;
    }
    return null;
  }

  function parseConsolidatedTipToProgress(value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    const lines = text
      .split(/\r?\n/)
      .map(item => String(item ?? '').trim())
      .filter(Boolean);
    if (!lines.length) return [];

    const timeRe = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/;
    const progress = [];
    let buffer = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (timeRe.test(line)) {
        const desc = buffer.reverse().join('\n').trim();
        progress.push({ time: line, desc });
        buffer = [];
        continue;
      }
      buffer.push(line);
    }
    if (buffer.length) {
      const desc = buffer.reverse().join('\n').trim();
      progress.push({ time: '', desc });
    }
    return normalizeProgress(progress);
  }

  function extractProgress(context) {
    const raw = context?.raw && typeof context.raw === 'object' ? context.raw : null;
    if (!raw) return [];

    const consolidated = parseConsolidatedTipToProgress(raw.shippingTrackConsoTip ?? raw.shipping_track_conso_tip);
    if (consolidated.length) return consolidated;

    const keys = [
      'orderTrackingList',
      'order_tracking_list',
      'orderTrackingInfos',
      'order_tracking_infos',
      'trackingInfoList',
      'tracking_info_list',
      'trackingList',
      'tracking_list',
      'traceList',
      'trace_list',
      'traces',
      'routes',
      'routeList',
      'route_list',
      'shippingTraceList',
      'shipping_trace_list',
      'shippingTrackList',
      'shipping_track_list',
      'progressList',
      'progress_list',
    ];

    const candidates = [
      raw,
      raw.shippingInfo,
      raw.shipping_info,
      raw.orderShippingInfo,
      raw.order_shipping_info,
      raw.logisticsInfo,
      raw.logistics_info,
      raw.trackingInfo,
      raw.tracking_info,
      raw.orderTrackingInfo,
      raw.order_tracking_info,
      raw.expressInfo,
      raw.express_info,
    ].filter(item => item && typeof item === 'object');

    for (const item of candidates) {
      const picked = pickFirstArray(item, keys);
      if (picked) return normalizeProgress(picked);
      const nested = item?.result;
      if (nested && typeof nested === 'object') {
        const pickedNested = pickFirstArray(nested, keys);
        if (pickedNested) return normalizeProgress(pickedNested);
      }
    }
    return [];
  }

  function ensureMounted() {
    if (state.mounted) return;
    state.mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="modal ops-aftersale-tracking-modal" role="dialog" aria-modal="true">
        <div class="modal-header ops-aftersale-tracking-header">
          <div class="ops-aftersale-tracking-header-main">
            <div class="ops-aftersale-tracking-header-left">
              <span class="ops-aftersale-tracking-carrier" id="opsAftersaleTrackingCarrier"></span>
              <button type="button" class="ops-aftersale-tracking-number-btn" id="btnOpsAftersaleTrackingCopy" data-copy="" title="点击复制"></button>
            </div>
          </div>
          <button class="modal-close" type="button" data-ops-close="1">&times;</button>
        </div>
        <div class="modal-body ops-aftersale-tracking-body">
          <div class="ops-aftersale-tracking-scroll" id="opsAftersaleTrackingScroll"></div>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDialog(null);
    });

    overlay.querySelectorAll('[data-ops-close="1"]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog(null));
    });

    overlay.querySelector('#btnOpsAftersaleTrackingCopy')?.addEventListener('click', async (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      const value = String(event?.currentTarget?.dataset?.copy || '').trim();
      if (!value) return;
      try {
        await copyText(value);
        window.opsCenterToast?.(`已复制${getTrackingLabel(state.context)}`);
      } catch {
        window.opsCenterToast?.('复制失败');
      }
    });

    document.body.appendChild(overlay);
  }

  function renderContext(context) {
    const carrier = String(context?.carrier || context?.carrierName || context?.shippingName || context?.shipping_name || '').trim();
    const trackingNo = String(context?.trackingNumber || context?.orderTrackingNumber || context?.trackingNo || context?.tracking_number || '').trim();

    const carrierEl = getEl('opsAftersaleTrackingCarrier');
    if (carrierEl) carrierEl.textContent = carrier || '-';

    const copyBtn = getEl('btnOpsAftersaleTrackingCopy');
    if (copyBtn) {
      copyBtn.dataset.copy = trackingNo;
      copyBtn.textContent = trackingNo || '-';
      copyBtn.disabled = !trackingNo;
    }

    const scrollEl = getEl('opsAftersaleTrackingScroll');
    if (scrollEl) {
      if (context?.loading) {
        scrollEl.innerHTML = renderLoading();
        return;
      }
      if (context?.error) {
        scrollEl.innerHTML = renderError(context.error);
        return;
      }
      const progress = Array.isArray(context?.progress)
        ? context.progress
        : Array.isArray(context?.traces)
          ? normalizeProgress(context.traces)
          : extractProgress(context);
      scrollEl.innerHTML = renderProgressList(progress);
    }
  }

  function normalizeApiResponseToContext(response) {
    if (!response || typeof response !== 'object') return { error: '物流信息获取失败' };
    if (response.error) return { error: String(response.error || '').trim() || '物流信息获取失败' };
    const payload = response.payload && typeof response.payload === 'object' ? response.payload : response;
    if (payload.error) return { error: String(payload.error || '').trim() || '物流信息获取失败' };
    if (payload.success === false) {
      return { error: String(payload.error_msg || payload.errorMsg || payload.message || '物流信息获取失败').trim() || '物流信息获取失败' };
    }
    const result = response.result && typeof response.result === 'object'
      ? response.result
      : (payload.result && typeof payload.result === 'object' ? payload.result : null);
    if (!result) return { error: '物流信息获取失败' };
    const shippingName = String(result.shipping_name || result.shippingName || '').trim();
    const trackingNumber = String(result.tracking_number || result.trackingNumber || '').trim();
    const traces = Array.isArray(result.traces) ? result.traces : [];
    return {
      carrier: shippingName,
      trackingNumber,
      traces,
    };
  }

  async function loadShippingDetail(context) {
    const shopId = String(context?.shopId || '').trim();
    const orderNo = String(context?.orderNo || context?.orderSn || context?.order_sn || '').trim();
    if (!shopId || !orderNo) return;
    if (!window.pddApi?.aftersaleGetShippingDetail) return;
    const queryTypeRaw = Number(context?.queryType);
    const queryType = Number.isFinite(queryTypeRaw) ? queryTypeRaw : 1;
    const seq = ++state.requestSeq;
    state.context = { ...(state.context || {}), loading: true, error: '' };
    renderContext(state.context);
    try {
      const response = await window.pddApi.aftersaleGetShippingDetail({
        shopId,
        orderSn: orderNo,
        queryType,
        client: 'web',
      });
      if (seq !== state.requestSeq) return;
      const normalized = normalizeApiResponseToContext(response);
      state.context = {
        ...(state.context || {}),
        ...normalized,
        loading: false,
        error: normalized?.error ? normalized.error : '',
      };
      renderContext(state.context);
    } catch (err) {
      if (seq !== state.requestSeq) return;
      state.context = { ...(state.context || {}), loading: false, error: err?.message || String(err || '物流信息获取失败') };
      renderContext(state.context);
    }
  }

  function openDialog(context) {
    ensureMounted();
    state.context = context || null;
    renderContext(state.context);
    if (typeof window.showModal === 'function') {
      window.showModal(MODAL_ID);
    } else {
      getEl(MODAL_ID)?.classList.add('visible');
    }
    loadShippingDetail(state.context);
    return new Promise((resolve) => {
      state.resolver = resolve;
    });
  }

  window.openOpsAfterSaleOrderTrackingDialog = openDialog;
})();
