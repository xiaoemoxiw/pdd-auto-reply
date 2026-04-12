(function () {
  let initialized = false;
  let deductionApiEntries = [];
  let deductionApiList = [];
  let deductionApiLastListResult = null;
  let deductionApiFilter = 'delayShip';
  let deductionApiPageNo = 1;
  const deductionApiPageSize = 30;

  function getEl(id) {
    return document.getElementById(id);
  }

  function esc(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function addInfoLog(message) {
    if (typeof addLog === 'function') {
      addLog(message, 'info');
      return;
    }
    console.log(message);
  }

  function addErrorLog(message) {
    if (typeof addLog === 'function') {
      addLog(message, 'error');
      return;
    }
    console.error(message);
  }

  function getDeductionTrafficType(entry) {
    const url = String(entry?.fullUrl || entry?.url || '').toLowerCase();
    const body = String(entry?.requestBody || '').toLowerCase();
    const text = `${url} ${body}`;
    if (text.includes('deduct') || text.includes('deduction')) return '扣款相关';
    if (text.includes('penalty') || text.includes('fine')) return '罚金相关';
    if (text.includes('punish')) return '处罚相关';
    if (text.includes('reconciliation') || text.includes('settlement')) return '对账相关';
    return '';
  }

  function isDeductionTrafficEntry(entry) {
    return !!getDeductionTrafficType(entry);
  }

  function getValueByKeys(obj, keys) {
    for (const key of keys) {
      const val = obj?.[key];
      if (val !== undefined && val !== null && String(val).trim() !== '') return val;
    }
    return '';
  }

  function getDeductionCategory(item) {
    const typeRaw = String(getValueByKeys(item, ['type', 'deductionType', 'deductType', 'penaltyType']) || '');
    const reasonRaw = String(getValueByKeys(item, ['reason', 'deductReason', 'deductionReason', 'remark', 'punishReason']) || '');
    const text = `${typeRaw} ${reasonRaw}`;
    const lower = text.toLowerCase();

    if (
      text.includes('延迟发货') ||
      text.includes('发货超时') ||
      text.includes('逾期发货') ||
      (text.includes('延迟') && text.includes('发货')) ||
      (lower.includes('delay') && lower.includes('ship'))
    ) return 'delayShip';

    if (
      text.includes('缺货') ||
      text.includes('无货') ||
      (lower.includes('out') && lower.includes('stock'))
    ) return 'outOfStock';

    if (
      text.includes('虚假发货') ||
      text.includes('轨迹') ||
      text.includes('无揽收') ||
      text.includes('无物流') ||
      (lower.includes('fake') && lower.includes('ship')) ||
      lower.includes('tracking')
    ) return 'fakeShipTrack';

    return 'other';
  }

  function getDeductionFilteredList() {
    if (!Array.isArray(deductionApiList) || !deductionApiList.length) return [];
    if (!deductionApiFilter) return deductionApiList.slice();
    return deductionApiList.filter(item => getDeductionCategory(item) === deductionApiFilter);
  }

  function renderDeductionApiFilterTabs() {
    const delayBtn = getEl('deductionApiFilterDelayShip');
    const outBtn = getEl('deductionApiFilterOutOfStock');
    const fakeBtn = getEl('deductionApiFilterFakeShipTrack');
    const countDelay = getEl('deductionApiCountDelayShip');
    const countOut = getEl('deductionApiCountOutOfStock');
    const countFake = getEl('deductionApiCountFakeShipTrack');

    const countBy = { delayShip: 0, outOfStock: 0, fakeShipTrack: 0 };
    for (const item of deductionApiList) {
      const cat = getDeductionCategory(item);
      if (countBy[cat] !== undefined) countBy[cat] += 1;
    }

    if (countDelay) countDelay.textContent = String(countBy.delayShip || 0);
    if (countOut) countOut.textContent = String(countBy.outOfStock || 0);
    if (countFake) countFake.textContent = String(countBy.fakeShipTrack || 0);

    delayBtn?.classList.toggle('active', deductionApiFilter === 'delayShip');
    outBtn?.classList.toggle('active', deductionApiFilter === 'outOfStock');
    fakeBtn?.classList.toggle('active', deductionApiFilter === 'fakeShipTrack');
  }

  function renderDeductionApiPager(total) {
    const prevBtn = getEl('btnDeductionApiPagePrev');
    const nextBtn = getEl('btnDeductionApiPageNext');
    const numbers = getEl('deductionApiPageNumbers');

    const pageCount = Math.max(1, Math.ceil((total || 0) / deductionApiPageSize));
    if (deductionApiPageNo > pageCount) deductionApiPageNo = pageCount;
    if (deductionApiPageNo < 1) deductionApiPageNo = 1;

    if (prevBtn) prevBtn.disabled = deductionApiPageNo <= 1;
    if (nextBtn) nextBtn.disabled = deductionApiPageNo >= pageCount;

    if (!numbers) return;
    const maxButtons = 5;
    let start = Math.max(1, deductionApiPageNo - Math.floor(maxButtons / 2));
    let end = Math.min(pageCount, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);

    const btns = [];
    for (let i = start; i <= end; i += 1) {
      const active = i === deductionApiPageNo ? ' active' : '';
      btns.push(`<button type="button" class="deduction-api-page-number${active}" data-page-no="${i}">${esc(i)}</button>`);
    }
    numbers.innerHTML = btns.join('');
  }

  function renderDeductionApiTraffic() {
    const container = getEl('deductionApiTrafficList');
    if (!container) return;
    const summary = getEl('deductionApiTrafficSummary');
    if (summary) summary.textContent = `${deductionApiEntries.length} 条抓包记录`;
    if (!deductionApiEntries.length) {
      container.innerHTML = '<span class="mail-api-traffic-chip">暂无抓包</span>';
      return;
    }
    container.innerHTML = deductionApiEntries.slice(0, 18).map(entry => {
      const typeTag = getDeductionTrafficType(entry);
      const summary = `${typeTag} · ${entry.method || 'GET'} ${entry.url}`;
      return `<span class="mail-api-traffic-chip" title="${esc(summary)}">${esc(summary)}</span>`;
    }).join('');
  }

  async function loadDeductionApiTraffic(shopId) {
    const scopeShopId = String(shopId || activeShopId || API_ALL_SHOPS || '__all__').trim();
    if (!window.pddApi || typeof window.pddApi.getApiTraffic !== 'function') {
      deductionApiEntries = [];
      renderDeductionApiTraffic();
      return;
    }
    const list = await window.pddApi.getApiTraffic({ shopId: scopeShopId });
    const normalized = Array.isArray(list) ? list.slice().reverse() : [];
    deductionApiEntries = normalized.filter(isDeductionTrafficEntry);
    renderDeductionApiTraffic();
  }

  function renderDeductionApiTableHead(columns) {
    const thead = document.querySelector('#viewDeductionApi .deduction-api-table thead');
    if (!thead) return;
    const ths = columns.map(col => `<th${col.thStyle ? ` style="${esc(col.thStyle)}"` : ''}>${esc(col.label)}</th>`).join('');
    thead.innerHTML = `<tr>${ths}</tr>`;
  }

  function getDeductionApiColumns(filter) {
    const keyCell = (text) => `<span class="deduction-api-key-cell">${esc(text || '-')}</span>`;
    const textCell = (text) => esc(text || '-');

    const shopCell = (item) => {
      const name = item?.shopName || '-';
      return `<td title="${esc(name)}">${esc(name)}</td>`;
    };

    const goodsNameCell = (item) => {
      const goodsName = getValueByKeys(item, ['goodsName', 'goods_name', 'productName', 'product_name', 'title', 'name']) || '-';
      return `<td title="${esc(goodsName)}" style="max-width:360px;">${esc(goodsName)}</td>`;
    };

    if (filter === 'fakeShipTrack') {
      return [
        {
          label: '店铺名称',
          thStyle: 'width:140px',
          render: shopCell
        },
        {
          label: '订单号',
          thStyle: 'width:170px',
          render: (item) => {
            const orderSn = getValueByKeys(item, ['orderSn', 'order_sn', 'orderNo', 'order_no', 'orderId', 'order_id']) || '-';
            return `<td>${keyCell(orderSn)}</td>`;
          }
        },
        {
          label: '快递编号',
          thStyle: 'width:150px',
          render: (item) => {
            const expressNo = getValueByKeys(item, ['expressNo', 'express_no', 'trackingNo', 'tracking_no', 'waybillNo', 'waybill_no', 'shippingId', 'shipping_id', 'deliveryNo', 'delivery_no']) || '-';
            return `<td>${keyCell(expressNo)}</td>`;
          }
        },
        {
          label: '商品ID',
          thStyle: 'width:110px',
          render: (item) => {
            const goodsId = getValueByKeys(item, ['goodsId', 'goods_id', 'productId', 'product_id', 'skuId', 'sku_id']) || '-';
            return `<td>${keyCell(goodsId)}</td>`;
          }
        },
        {
          label: '商品名称',
          thStyle: '',
          render: goodsNameCell
        },
        {
          label: '违规类型',
          thStyle: 'width:150px',
          render: (item) => {
            const violationType = getValueByKeys(item, ['violationType', 'violation_type', 'punishType', 'punish_type', 'deductionType', 'deductType', 'penaltyType', 'type']) || '-';
            return `<td>${textCell(violationType)}</td>`;
          }
        },
        {
          label: '发货时间',
          thStyle: 'width:160px',
          render: (item) => {
            const shipTime = getValueByKeys(item, ['shipTime', 'ship_time', 'shippingTime', 'shipping_time', 'deliveryTime', 'delivery_time', 'sendTime', 'send_time', 'shippedAt', 'shipped_at']) || '-';
            return `<td>${textCell(shipTime)}</td>`;
          }
        },
        {
          label: '扣款金额',
          thStyle: 'width:110px',
          render: (item) => {
            const amount = getValueByKeys(item, ['amountText', 'amount', 'deductAmount', 'deduct_amount', 'money', 'moneyText']) || '-';
            return `<td>${textCell(amount)}</td>`;
          }
        },
        {
          label: '扣款时间',
          thStyle: 'width:160px',
          render: (item) => {
            const deductionTime = getValueByKeys(item, ['deductionTime', 'deductTime', 'deduct_time', 'createdAtText', 'createdAt', 'created_at']) || '-';
            return `<td>${textCell(deductionTime)}</td>`;
          }
        }
      ];
    }

    const includeReason = filter === 'delayShip';
    return [
      {
        label: '序号',
        thStyle: 'width:46px',
        render: (_, ctx) => `<td>${esc(ctx.displayIndex)}</td>`
      },
      {
        label: '店铺名称',
        thStyle: 'width:140px',
        render: shopCell
      },
      {
        label: '订单号',
        thStyle: 'width:170px',
        render: (item) => {
          const orderSn = getValueByKeys(item, ['orderSn', 'order_sn', 'orderNo', 'order_no', 'orderId', 'order_id']) || '-';
          return `<td>${keyCell(orderSn)}</td>`;
        }
      },
      {
        label: '商品ID',
        thStyle: 'width:110px',
        render: (item) => {
          const goodsId = getValueByKeys(item, ['goodsId', 'goods_id', 'productId', 'product_id', 'skuId', 'sku_id']) || '-';
          return `<td>${keyCell(goodsId)}</td>`;
        }
      },
      {
        label: '商品名称',
        thStyle: '',
        render: goodsNameCell
      },
      {
        label: '承诺时间',
        thStyle: 'width:160px',
        render: (item) => {
          const promiseTime = getValueByKeys(item, ['promiseTime', 'promisedAt', 'promisedTime', 'commitTime', 'commit_time']) || '-';
          return `<td>${textCell(promiseTime)}</td>`;
        }
      },
      {
        label: '扣款金额',
        thStyle: 'width:110px',
        render: (item) => {
          const amount = getValueByKeys(item, ['amountText', 'amount', 'deductAmount', 'deduct_amount', 'money', 'moneyText']) || '-';
          return `<td>${textCell(amount)}</td>`;
        }
      },
      {
        label: '扣款时间',
        thStyle: 'width:160px',
        render: (item) => {
          const deductionTime = getValueByKeys(item, ['deductionTime', 'deductTime', 'deduct_time', 'createdAtText', 'createdAt', 'created_at']) || '-';
          return `<td>${textCell(deductionTime)}</td>`;
        }
      },
      ...(includeReason ? [
        {
          label: '扣款原因',
          thStyle: 'min-width:240px',
          render: (item) => {
            const reason = getValueByKeys(item, ['reason', 'deductReason', 'deductionReason', 'remark', 'punishReason']) || '-';
            return `<td title="${esc(reason)}" style="max-width:420px;">${esc(reason)}</td>`;
          }
        }
      ] : [])
    ];
  }

  function renderDeductionApiList() {
    const meta = getEl('deductionApiListMeta');
    const footerTotal = getEl('deductionApiFooterTotal');
    const status = getEl('deductionApiListStatus');
    const listEl = getEl('deductionApiList');
    const filtered = getDeductionFilteredList();
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / deductionApiPageSize));
    if (deductionApiPageNo > pageCount) deductionApiPageNo = pageCount;
    if (deductionApiPageNo < 1) deductionApiPageNo = 1;
    const startIndex = (deductionApiPageNo - 1) * deductionApiPageSize;
    const pageItems = filtered.slice(startIndex, startIndex + deductionApiPageSize);

    if (meta) meta.textContent = `${total} 条记录`;
    if (footerTotal) footerTotal.textContent = `共 ${total} 条`;
    if (status) {
      status.textContent = deductionApiLastListResult?.error
        ? String(deductionApiLastListResult.error)
        : `已加载 ${deductionApiList.length} 条`;
    }
    renderDeductionApiFilterTabs();
    renderDeductionApiPager(total);
    if (!listEl) return;
    const columns = getDeductionApiColumns(deductionApiFilter);
    renderDeductionApiTableHead(columns);
    if (!total) {
      listEl.innerHTML = `
        <tr>
          <td colspan="${esc(columns.length)}" style="padding:18px;color:#999;text-align:center;">
            暂无数据（可先进入相关平台页面触发扣款接口并观察右侧抓包）
          </td>
        </tr>
      `;
      return;
    }
    listEl.innerHTML = pageItems.map((item, idx) => {
      const displayIndex = startIndex + idx + 1;
      const tds = columns.map(col => col.render(item, { displayIndex })).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
  }

  async function loadDeductionApiList() {
    if (!window.pddApi || typeof window.pddApi.deductionGetList !== 'function') {
      deductionApiLastListResult = { error: '扣款列表接口未接入（缺少 pddApi.deductionGetList）' };
      deductionApiList = [];
      renderDeductionApiList();
      return;
    }
    const shopId = String(activeShopId || API_ALL_SHOPS || '__all__').trim();
    try {
      const result = await window.pddApi.deductionGetList({ shopId });
      deductionApiLastListResult = result;
      const list = result?.list || result?.data || result?.result || [];
      deductionApiList = Array.isArray(list) ? list : [];
    } catch (error) {
      deductionApiLastListResult = { error: error?.message || String(error) };
      deductionApiList = [];
    }
    deductionApiPageNo = 1;
    renderDeductionApiList();
  }

  async function loadDeductionApiView(options = {}) {
    if (!options?.keepCurrent) {
      await loadDeductionApiTraffic(activeShopId || API_ALL_SHOPS || '__all__');
    }
    await loadDeductionApiList();
  }

  function bindDeductionApiModule() {
    if (initialized) return;
    initialized = true;

    getEl('btnDeductionApiReloadTraffic')?.addEventListener('click', async () => {
      await loadDeductionApiTraffic(activeShopId || API_ALL_SHOPS || '__all__');
      addInfoLog('已刷新扣款抓包记录');
    });
    getEl('btnDeductionApiRefresh')?.addEventListener('click', async () => {
      await loadDeductionApiList();
      addInfoLog('已刷新扣款列表');
    });
    getEl('btnDeductionApiClearTraffic')?.addEventListener('click', async () => {
      if (!window.pddApi || typeof window.pddApi.clearApiTraffic !== 'function') {
        addErrorLog('清空抓包失败：缺少 clearApiTraffic 能力');
        return;
      }
      const shopId = String(activeShopId || API_ALL_SHOPS || '__all__').trim();
      await window.pddApi.clearApiTraffic({ shopId });
      await loadDeductionApiTraffic(shopId);
      addInfoLog('已清空并刷新扣款抓包记录');
    });

    getEl('deductionApiFilterTabs')?.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('button[data-deduction-filter]');
      const filter = btn?.dataset?.deductionFilter;
      if (!filter) return;
      deductionApiFilter = filter;
      deductionApiPageNo = 1;
      renderDeductionApiList();
    });

    getEl('btnDeductionApiPagePrev')?.addEventListener('click', () => {
      if (deductionApiPageNo <= 1) return;
      deductionApiPageNo = Math.max(1, deductionApiPageNo - 1);
      renderDeductionApiList();
    });
    getEl('btnDeductionApiPageNext')?.addEventListener('click', () => {
      const total = getDeductionFilteredList().length;
      const pageCount = Math.max(1, Math.ceil(total / deductionApiPageSize));
      if (deductionApiPageNo >= pageCount) return;
      deductionApiPageNo = Math.min(pageCount, deductionApiPageNo + 1);
      renderDeductionApiList();
    });
    getEl('deductionApiPageNumbers')?.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('button[data-page-no]');
      const pageNo = Number(btn?.dataset?.pageNo || 0);
      if (!pageNo || Number.isNaN(pageNo)) return;
      deductionApiPageNo = Math.max(1, pageNo);
      renderDeductionApiList();
    });
  }

  window.loadDeductionApiView = loadDeductionApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('deduction-api-module', bindDeductionApiModule);
  } else {
    bindDeductionApiModule();
  }
})();
