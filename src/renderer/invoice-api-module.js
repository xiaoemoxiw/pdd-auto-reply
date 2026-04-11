(function () {
  let initialized = false;
  let invoiceApiEntries = [];
  let invoiceApiOverview = null;
  let invoiceApiList = [];
  let invoiceApiPageNo = 1;
  let invoiceApiPageSize = 20;
  let invoiceApiTotal = 0;
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
  let invoiceApiEntryDialogState = createInvoiceApiEntryDialogState();
  let invoiceApiEntryPreviewUrl = '';
  let invoiceApiEntrySubmitting = false;
  let invoiceApiEmbeddedOverlayVisible = false;
  let invoiceApiEmbeddedOverlayOrderSn = '';

  function getEl(id) {
    return document.getElementById(id);
  }

  function createInvoiceApiEntryDialogState() {
    return {
      serialNo: '',
      orderSn: '',
      shopId: '',
      shopName: '',
      businessType: 1,
      orderStatus: '',
      afterSalesStatus: '',
      applyTime: 0,
      promiseInvoiceTime: 0,
      invoiceAmount: 0,
      invoiceMode: '',
      invoiceType: '',
      invoiceKind: '',
      invoiceKindValue: 0,
      letterheadType: '',
      letterhead: '',
      goodsName: '',
      goodsSpec: '',
      goodsThumb: '',
      receiveName: '',
      receiveMobile: '',
      shippingAddress: '',
      shippingName: '',
      trackingNumber: '',
      invoiceApplyStatus: '',
      taxNo: '',
      canSubmit: null,
      fileName: '',
      invoiceNumber: '',
      autoInvoiceNumberFromFile: '',
      invoiceCode: '',
      invoicePdfUrl: '',
      warnConfirmed: false,
      loading: false,
      statusType: '',
      statusText: ''
    };
  }

  function extractInvoiceNumberFromFileName(fileName) {
    const name = String(fileName || '').trim();
    if (!name) return '';
    const baseName = name.replace(/\.[^.]+$/, '').trim();
    const match = baseName.match(/(\d+)\s*$/);
    return match?.[1] || '';
  }

  function showInvoiceApiEntryStatus(type, text) {
    invoiceApiEntryDialogState.statusType = text ? type : '';
    invoiceApiEntryDialogState.statusText = text || '';
    if (invoiceApiEntryDialogState.statusText) {
      if (typeof showToast === 'function') {
        showToast(invoiceApiEntryDialogState.statusText);
      } else {
        addLog(invoiceApiEntryDialogState.statusText, invoiceApiEntryDialogState.statusType || 'info');
      }
    }
    renderInvoiceApiEntryDialog();
  }

  function hideInvoiceApiFilePreview() {
    const frame = getEl('invoiceApiFilePreviewFrame');
    if (frame) frame.removeAttribute('src');
    if (invoiceApiEntryPreviewUrl) {
      URL.revokeObjectURL(invoiceApiEntryPreviewUrl);
      invoiceApiEntryPreviewUrl = '';
    }
    const modal = document.getElementById('modalInvoiceApiFilePreview');
    if (typeof hideModal === 'function') {
      hideModal('modalInvoiceApiFilePreview');
    } else {
      modal?.classList.remove('visible');
    }
  }

  function showInvoiceApiFilePreview() {
    const file = getEl('invoiceApiEntryFile')?.files?.[0];
    if (!file) {
      showInvoiceApiEntryStatus('error', '请先上传发票文件。');
      return;
    }
    if (!/\.pdf$/i.test(file.name)) {
      showInvoiceApiEntryStatus('warn', '当前仅支持预览 PDF 发票文件。');
      return;
    }
    if (invoiceApiEntryPreviewUrl) {
      URL.revokeObjectURL(invoiceApiEntryPreviewUrl);
      invoiceApiEntryPreviewUrl = '';
    }
    invoiceApiEntryPreviewUrl = URL.createObjectURL(file);
    const frame = getEl('invoiceApiFilePreviewFrame');
    if (frame) frame.src = invoiceApiEntryPreviewUrl;
    const modal = document.getElementById('modalInvoiceApiFilePreview');
    if (typeof showModal === 'function') {
      showModal('modalInvoiceApiFilePreview');
    } else {
      modal?.classList.add('visible');
    }
  }

  function resetInvoiceApiEntryDialogState() {
    hideInvoiceApiFilePreview();
    invoiceApiEntryDialogState = createInvoiceApiEntryDialogState();
    const fileInput = getEl('invoiceApiEntryFile');
    if (fileInput) fileInput.value = '';
    const numberInput = getEl('invoiceApiEntryNumber');
    if (numberInput) numberInput.value = '';
    const codeInput = getEl('invoiceApiEntryCode');
    if (codeInput) codeInput.value = '';
  }

  function getInvoiceApiEntrySubmitHint() {
    if (!invoiceApiEntryDialogState.orderSn) return '请先选择一条待开票记录';
    if (invoiceApiEntryDialogState.loading) return '正在拉取录入发票所需信息';
    if (invoiceApiEntryDialogState.canSubmit === false) return '当前店铺接口校验未开放录入发票提交能力';
    if (!invoiceApiEntryDialogState.fileName) return '请先上传发票文件';
    if (!invoiceApiEntryDialogState.invoiceNumber.trim()) return '请填写发票号码';
    return '若提示未识别到上传接口，请先到【待开票（嵌入网页）】完成一次录入发票提交以便抓包识别';
  }

  function formatInvoiceApiPromiseTime(value) {
    const num = Number(value);
    if (!num) return '-';
    const targetMs = num < 1e12 ? num * 1000 : num;
    const diffMs = targetMs - Date.now();
    if (diffMs <= 0) return formatApiDateTime(targetMs);
    const totalHours = Math.floor(diffMs / (60 * 60 * 1000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0) return `剩余${days}天${hours}小时`;
    if (hours > 0) return `剩余${hours}小时`;
    const minutes = Math.max(1, Math.floor(diffMs / (60 * 1000)));
    return `剩余${minutes}分钟`;
  }

  function formatInvoiceApiDateTime(value) {
    const num = Number(value);
    if (!num) return '-';
    const ms = num < 1e12 ? num * 1000 : num;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '-';
    const y = String(date.getFullYear());
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  function formatInvoiceApiOrderSnDate(orderSn) {
    const sn = String(orderSn || '').trim();
    if (!sn) return '';
    const match = sn.match(/^(\d{2})(\d{2})(\d{2})(?:-|$)/);
    if (!match) return '';
    const year = 2000 + Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || year < 2000 || year > 2099) return '';
    if (!Number.isFinite(month) || month < 1 || month > 12) return '';
    if (!Number.isFinite(day) || day < 1 || day > 31) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function renderInvoiceApiEntryDialog() {
    const thumb = getEl('invoiceApiEntryThumb');
    const thumbButton = getEl('invoiceApiEntryThumbBtn');
    const thumbPlaceholder = getEl('invoiceApiEntryThumbPlaceholder');
    if (thumb) {
      const url = String(invoiceApiEntryDialogState.goodsThumb || '').trim();
      if (url) {
        thumb.hidden = false;
        thumb.src = url;
        if (thumbPlaceholder) thumbPlaceholder.hidden = true;
        if (thumbButton) thumbButton.disabled = false;
      } else {
        thumb.hidden = true;
        thumb.removeAttribute('src');
        if (thumbPlaceholder) thumbPlaceholder.hidden = false;
        if (thumbButton) thumbButton.disabled = true;
      }
    }

    const orderSnEl = getEl('invoiceApiEntryOrderSn');
    if (orderSnEl) {
      const orderSn = String(invoiceApiEntryDialogState.orderSn || '').trim();
      orderSnEl.textContent = orderSn || '-';
      orderSnEl.onclick = null;
      if (orderSn && window.pddApi && typeof window.pddApi.openInvoiceOrderDetailWindow === 'function') {
        const shopId = String(invoiceApiEntryDialogState.shopId || activeShopId || '').trim();
        const serialNo = String(invoiceApiEntryDialogState.serialNo || '').trim();
        orderSnEl.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          window.pddApi.openInvoiceOrderDetailWindow({
            shopId,
            orderSn,
            serialNo
          });
        };
      }
    }

    const orderSnDateEl = getEl('invoiceApiEntryOrderSnDate');
    if (orderSnDateEl) {
      const dateText = formatInvoiceApiOrderSnDate(invoiceApiEntryDialogState.orderSn);
      orderSnDateEl.textContent = dateText ? `订单号日期：${dateText}` : '';
      orderSnDateEl.hidden = !dateText;
    }

    const orderStatusEl = getEl('invoiceApiEntryOrderStatus');
    if (orderStatusEl) orderStatusEl.textContent = invoiceApiEntryDialogState.orderStatus || '-';

    const goodsTitleEl = getEl('invoiceApiEntryGoodsTitle');
    if (goodsTitleEl) goodsTitleEl.textContent = invoiceApiEntryDialogState.goodsName || '-';

    const goodsSpecEl = getEl('invoiceApiEntryGoodsSpec');
    if (goodsSpecEl) goodsSpecEl.textContent = invoiceApiEntryDialogState.goodsSpec || '-';

    const invoiceAmountEl = getEl('invoiceApiEntryInvoiceAmount');
    if (invoiceAmountEl) {
      const amountValue = Number(invoiceApiEntryDialogState.invoiceAmount);
      invoiceAmountEl.textContent = Number.isFinite(amountValue) ? formatApiAmount(amountValue) : '-';
    }

    const letterheadTypeEl = getEl('invoiceApiEntryLetterheadType');
    if (letterheadTypeEl) letterheadTypeEl.textContent = invoiceApiEntryDialogState.letterheadType || '-';

    const letterheadEl = getEl('invoiceApiEntryLetterhead');
    if (letterheadEl) letterheadEl.textContent = invoiceApiEntryDialogState.letterhead || '-';

    const taxNoEl = getEl('invoiceApiEntryTaxNo');
    if (taxNoEl) taxNoEl.textContent = invoiceApiEntryDialogState.taxNo || '-';

    const fileName = getEl('invoiceApiEntryFileName');
    if (fileName) {
      fileName.textContent = '上传文件';
      fileName.hidden = !!invoiceApiEntryDialogState.fileName;
    }
    const uploadBox = getEl('invoiceApiEntryUploadBox');
    if (uploadBox) {
      const hasFile = !!invoiceApiEntryDialogState.fileName;
      const canPreview = hasFile && /\.pdf$/i.test(invoiceApiEntryDialogState.fileName || '');
      uploadBox.dataset.hasFile = hasFile ? '1' : '';
      uploadBox.dataset.canPreview = canPreview ? '1' : '';
    }
    const uploadDefaultIcon = getEl('invoiceApiEntryUploadIconDefault');
    if (uploadDefaultIcon) uploadDefaultIcon.hidden = !!invoiceApiEntryDialogState.fileName;
    const uploadFileIcon = getEl('invoiceApiEntryUploadIconFile');
    if (uploadFileIcon) uploadFileIcon.hidden = !invoiceApiEntryDialogState.fileName;
    const warning = getEl('invoiceApiEntryUploadWarning');
    if (warning) warning.hidden = !invoiceApiEntryDialogState.fileName;

    const numberInput = getEl('invoiceApiEntryNumber');
    if (numberInput && numberInput.value !== invoiceApiEntryDialogState.invoiceNumber) {
      numberInput.value = invoiceApiEntryDialogState.invoiceNumber;
    }
    const codeInput = getEl('invoiceApiEntryCode');
    if (codeInput && codeInput.value !== invoiceApiEntryDialogState.invoiceCode) {
      codeInput.value = invoiceApiEntryDialogState.invoiceCode;
    }

    const submitButton = getEl('btnInvoiceApiEntrySubmit');
    if (submitButton) {
      submitButton.disabled = !!invoiceApiEntryDialogState.loading || invoiceApiEntryDialogState.canSubmit === false;
      submitButton.textContent = invoiceApiEntryDialogState.warnConfirmed ? '再次确认' : '确认';
    }
  }

  async function openInvoiceApiEntryDialog(serialNo) {
    const item = invoiceApiList.find(entry => String(entry.serialNo) === String(serialNo));
    if (!item) return;
    await openInvoiceApiDetail(serialNo, { skipTraffic: true });
    resetInvoiceApiEntryDialogState();
    const shopId = String(item.shopId || activeShopId || '').trim();
    const businessType = Number(item.raw?.business_type ?? 1);
    const invoiceKindValue = Number(item.raw?.invoice_kind ?? 0);
    invoiceApiEntryDialogState = {
      ...invoiceApiEntryDialogState,
      serialNo: String(item.serialNo || ''),
      orderSn: String(item.orderSn || ''),
      shopId,
      shopName: String(item.shopName || ''),
      businessType: Number.isFinite(businessType) ? businessType : 1,
      orderStatus: String(item.orderStatus || ''),
      afterSalesStatus: String(item.afterSalesStatus || ''),
      applyTime: Number(item.applyTime || 0),
      promiseInvoiceTime: Number(item.promiseInvoiceTime || 0),
      invoiceAmount: Number(item.invoiceAmount || 0),
      invoiceMode: String(item.invoiceMode || ''),
      invoiceType: String(item.invoiceType || ''),
      invoiceKind: String(item.invoiceKind || ''),
      invoiceKindValue: Number.isFinite(invoiceKindValue) ? invoiceKindValue : 0,
      letterheadType: String(item.letterheadType || ''),
      letterhead: String(item.letterhead || ''),
      goodsName: String(item.goodsName || ''),
      goodsSpec: String(item.goodsSpec || ''),
      goodsThumb: String(item.goodsThumb || ''),
      taxNo: String(item.taxNo || ''),
      loading: false
    };
    if (activeShopId && shopId && shopId !== activeShopId) {
      showInvoiceApiEntryStatus('warn', `当前记录所属店铺与右上角当前店铺不一致（记录店铺：${invoiceApiEntryDialogState.shopName || shopId}）。若提示未识别提交接口，请先切换到该店铺在【待开票（嵌入网页）】完成一次录入发票提交。`);
    } else {
      showInvoiceApiEntryStatus('', '');
    }
    renderInvoiceApiEntryDialog();
    if (typeof showModal === 'function') {
      showModal('modalInvoiceApiEntry');
    }
    loadInvoiceApiEntrySubmitDetail();
  }

  async function loadInvoiceApiEntrySubmitDetail() {
    const shopId = String(invoiceApiEntryDialogState.shopId || '').trim();
    const orderSn = String(invoiceApiEntryDialogState.orderSn || '').trim();
    if (!shopId || !orderSn) return;
    invoiceApiEntryDialogState.loading = true;
    showInvoiceApiEntryStatus('info', '正在加载录入发票校验信息...');
    try {
      const result = await window.pddApi.invoiceGetDetail({ shopId, orderSn });
      if (!result || result.error) {
        invoiceApiEntryDialogState.canSubmit = null;
        showInvoiceApiEntryStatus('warn', result?.error || '加载录入发票校验信息失败');
        return;
      }
      const detail = result.detail || {};
      invoiceApiEntryDialogState.canSubmit = result.canSubmit;
      invoiceApiEntryDialogState.receiveName = detail.receiveName || '';
      invoiceApiEntryDialogState.receiveMobile = detail.receiveMobile || '';
      invoiceApiEntryDialogState.shippingAddress = detail.shippingAddress || '';
      invoiceApiEntryDialogState.shippingName = detail.shippingName || '';
      invoiceApiEntryDialogState.trackingNumber = detail.trackingNumber || '';
      invoiceApiEntryDialogState.invoiceApplyStatus = detail.invoiceApplyStatus || '';
      invoiceApiEntryDialogState.taxNo = detail.taxNo || invoiceApiEntryDialogState.taxNo || '';
      if (invoiceApiEntryDialogState.canSubmit === false) {
        showInvoiceApiEntryStatus('warn', '接口校验未开放录入发票提交能力');
      } else {
        showInvoiceApiEntryStatus('', '');
      }
    } catch (error) {
      invoiceApiEntryDialogState.canSubmit = null;
      showInvoiceApiEntryStatus('error', error?.message || '加载录入发票校验信息失败');
    } finally {
      invoiceApiEntryDialogState.loading = false;
      renderInvoiceApiEntryDialog();
    }
  }

  function handleInvoiceApiEntryFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      invoiceApiEntryDialogState.fileName = '';
      invoiceApiEntryDialogState.autoInvoiceNumberFromFile = '';
      invoiceApiEntryDialogState.invoicePdfUrl = '';
      invoiceApiEntryDialogState.warnConfirmed = false;
      renderInvoiceApiEntryDialog();
      return;
    }
    const validSuffix = /\.(pdf|ofd)$/i.test(file.name);
    if (!validSuffix) {
      event.target.value = '';
      invoiceApiEntryDialogState.fileName = '';
      showInvoiceApiEntryStatus('error', '仅支持上传 PDF 或 OFD 文件。');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      event.target.value = '';
      invoiceApiEntryDialogState.fileName = '';
      showInvoiceApiEntryStatus('error', '发票文件不能超过 5M。');
      return;
    }
    invoiceApiEntryDialogState.fileName = file.name;
    invoiceApiEntryDialogState.invoicePdfUrl = '';
    invoiceApiEntryDialogState.warnConfirmed = false;
    const extracted = extractInvoiceNumberFromFileName(file.name);
    if (extracted) {
      const currentNumber = String(getEl('invoiceApiEntryNumber')?.value || invoiceApiEntryDialogState.invoiceNumber || '').trim();
      if (!currentNumber || currentNumber === invoiceApiEntryDialogState.autoInvoiceNumberFromFile) {
        invoiceApiEntryDialogState.invoiceNumber = extracted;
      }
    }
    invoiceApiEntryDialogState.autoInvoiceNumberFromFile = extracted || '';
    if (invoiceApiEntryDialogState.statusType === 'error') {
      invoiceApiEntryDialogState.statusType = '';
      invoiceApiEntryDialogState.statusText = '';
    }
    renderInvoiceApiEntryDialog();
  }

  async function submitInvoiceApiEntry() {
    invoiceApiEntryDialogState.invoiceNumber = getEl('invoiceApiEntryNumber')?.value || '';
    invoiceApiEntryDialogState.invoiceCode = getEl('invoiceApiEntryCode')?.value || '';
    const file = getEl('invoiceApiEntryFile')?.files?.[0];
    if (!invoiceApiEntryDialogState.fileName) {
      showInvoiceApiEntryStatus('error', '请先上传发票文件。');
      return;
    }
    if (!invoiceApiEntryDialogState.invoiceNumber.trim()) {
      showInvoiceApiEntryStatus('error', '请填写发票号码。');
      return;
    }
    if (!file) {
      showInvoiceApiEntryStatus('error', '请先上传发票文件。');
      return;
    }
    if (invoiceApiEntrySubmitting) return;
    if (invoiceApiEntryDialogState.loading) return;
    if (invoiceApiEntryDialogState.canSubmit === false) {
      showInvoiceApiEntryStatus('warn', '接口校验未开放录入发票提交能力');
      return;
    }
    invoiceApiEntrySubmitting = true;
    invoiceApiEntryDialogState.loading = true;
    renderInvoiceApiEntryDialog();
    showInvoiceApiEntryStatus('info', invoiceApiEntryDialogState.warnConfirmed ? '正在确认并提交录入发票...' : '正在提交录入发票...');
    try {
      const fileData = await file.arrayBuffer();
      const result = await window.pddApi.invoiceSubmitRecord({
        shopId: invoiceApiEntryDialogState.shopId,
        serialNo: invoiceApiEntryDialogState.serialNo,
        orderSn: invoiceApiEntryDialogState.orderSn,
        invoiceNumber: invoiceApiEntryDialogState.invoiceNumber,
        invoiceCode: invoiceApiEntryDialogState.invoiceCode,
        fileName: file.name,
        fileData,
        invoicePdfUrl: invoiceApiEntryDialogState.invoicePdfUrl,
        payerName: invoiceApiEntryDialogState.letterhead,
        payerRegisterNo: invoiceApiEntryDialogState.taxNo,
        invoiceKind: invoiceApiEntryDialogState.invoiceKindValue,
        businessType: invoiceApiEntryDialogState.businessType,
        force: invoiceApiEntryDialogState.warnConfirmed
      });
      if (!result || result.error) {
        showInvoiceApiEntryStatus('error', result?.error || '录入发票提交失败');
        addLog(result?.error || '录入发票提交失败', 'error');
        return;
      }
      if (result.warn) {
        invoiceApiEntryDialogState.warnConfirmed = true;
        invoiceApiEntryDialogState.invoicePdfUrl = result.invoicePdfUrl || invoiceApiEntryDialogState.invoicePdfUrl || '';
        if (result.invoiceNumber) {
          invoiceApiEntryDialogState.invoiceNumber = result.invoiceNumber;
        }
        if (result.invoiceCode !== undefined && result.invoiceCode !== null) {
          invoiceApiEntryDialogState.invoiceCode = result.invoiceCode;
        }
        showInvoiceApiEntryStatus('warn', result.message || '发票解析提示风险，请确认后再次点击确认提交');
        return;
      }
      const successKey = invoiceApiEntryDialogState.orderSn || invoiceApiEntryDialogState.serialNo;
      if (typeof hideModal === 'function') {
        hideModal('modalInvoiceApiEntry');
      } else {
        document.getElementById('modalInvoiceApiEntry')?.classList.remove('visible');
      }
      resetInvoiceApiEntryDialogState();
      if (typeof showToast === 'function') {
        showToast('录入发票成功');
      } else {
        addLog('录入发票成功', 'info');
      }
      addLog(`录入发票提交成功：${successKey}`, 'info');
      await loadInvoiceApiList({ keepCurrent: true });
    } catch (error) {
      showInvoiceApiEntryStatus('error', error?.message || '录入发票提交失败');
      addLog(error?.message || '录入发票提交失败', 'error');
    } finally {
      invoiceApiEntrySubmitting = false;
      invoiceApiEntryDialogState.loading = false;
      renderInvoiceApiEntryDialog();
    }
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
    invoiceApiPageNo = 1;
    invoiceApiTotal = 0;
    invoiceApiKeyword = '';
    invoiceApiQuickFilter = 'all';
    invoiceApiOrderStatus = '';
    invoiceApiModeFilter = '';
    invoiceApiTypeFilter = '';
    invoiceApiLetterheadTypeFilter = '';
    invoiceApiLetterheadKeyword = '';
    invoiceApiFiltersExpanded = false;
    invoiceApiSelectedSerialNos.clear();
    if (invoiceApiEmbeddedOverlayVisible) {
      invoiceApiEmbeddedOverlayVisible = false;
      invoiceApiEmbeddedOverlayOrderSn = '';
      renderInvoiceApiEmbeddedOverlayBar();
      window.pddApi.closeEmbeddedOverlay();
    }
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
    const pendingNum = getEl('invoiceApiPendingNum');
    if (pendingNum) pendingNum.textContent = invoiceApiOverview ? String(invoiceApiOverview.pendingNum || 0) : '-';
    const invoicedNum = getEl('invoiceApiInvoicedNum');
    if (invoicedNum) invoicedNum.textContent = invoiceApiOverview ? String(invoiceApiOverview.invoicedNum || 0) : '-';
    const applyingNum = getEl('invoiceApiApplyingNum');
    if (applyingNum) applyingNum.textContent = invoiceApiOverview ? String(invoiceApiOverview.applyingNum || 0) : '-';
    const amount = getEl('invoiceApiAmount');
    if (amount) amount.textContent = invoiceApiOverview ? formatApiAmount(invoiceApiOverview.invoiceAmount || 0) : '-';
    const qualityTotal = getEl('invoiceApiQualityTotal');
    if (qualityTotal) qualityTotal.textContent = invoiceApiOverview ? String(invoiceApiOverview.qualityPendingTotal || 0) : '-';
    const normalTotal = getEl('invoiceApiNormalTotal');
    if (normalTotal) normalTotal.textContent = invoiceApiOverview ? String(invoiceApiOverview.normalPendingTotal || 0) : '-';
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

  function renderInvoiceApiPager() {
    const pageNoEl = getEl('invoiceApiPageNo');
    if (pageNoEl) pageNoEl.textContent = String(invoiceApiPageNo || 1);
    const prevBtn = getEl('btnInvoiceApiPagePrev');
    if (prevBtn) prevBtn.disabled = invoiceApiPageNo <= 1;
    const nextBtn = getEl('btnInvoiceApiPageNext');
    if (nextBtn) nextBtn.disabled = invoiceApiTotal ? invoiceApiPageNo * invoiceApiPageSize >= invoiceApiTotal : invoiceApiList.length < invoiceApiPageSize;
  }

  function renderInvoiceApiSummary() {
    const quickCounts = getInvoiceQuickCounts();
    const pendingTabCount = getEl('invoiceApiPendingTabCount');
    if (pendingTabCount) pendingTabCount.textContent = String(invoiceApiOverview?.pendingNum || invoiceApiTotal || quickCounts.all || 0);
    document.querySelectorAll('[data-invoice-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.invoiceQuick === invoiceApiQuickFilter);
    });
    const advancedFilters = getEl('invoiceApiAdvancedFilters');
    const toggleButton = getEl('btnInvoiceApiToggleMore');
    if (advancedFilters) advancedFilters.classList.toggle('hidden', !invoiceApiFiltersExpanded);
    if (toggleButton) toggleButton.textContent = invoiceApiFiltersExpanded ? '收起' : '展开';
    renderInvoiceApiFilterOptions();
    renderInvoiceApiPager();
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
    const selectionSummary = getEl('invoiceApiSelectionSummary');
    if (selectionSummary) {
      selectionSummary.textContent = invoiceApiSelectedSerialNos.size
        ? `已选择 ${invoiceApiSelectedSerialNos.size} 条记录`
        : '未选择记录';
    }
    const footerTotal = getEl('invoiceApiFooterTotal');
    if (footerTotal) footerTotal.textContent = `共 ${visibleList.length} 条`;
    const batchButton = getEl('btnInvoiceApiBatchAction');
    if (batchButton) batchButton.disabled = invoiceApiSelectedSerialNos.size === 0;
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
    if (!container) return;
    if (!visibleList.length) {
      container.innerHTML = '<tr><td colspan="15"><div class="invoice-api-pdd-empty">当前没有待开票记录。</div></td></tr>';
      renderInvoiceApiPager();
      return;
    }
    container.innerHTML = visibleList.map((item, idx) => {
      const serialNo = String(item.serialNo || '');
      const applyTimeText = formatInvoiceApiDateTime(item.applyTime);
      const otherInfo = String(item.otherInfo || item.raw?.other_info || '').trim();
      const paperReceiverName = String(item.paperReceiverName || item.raw?.paper_receiver_name || '').trim();
      const paperReceiverMobile = String(item.paperReceiverMobile || item.raw?.paper_receiver_mobile || '').trim();
      const paperReceiverAddress = String(item.paperReceiverAddress || item.raw?.paper_receiver_address || '').trim();
      const mailAddressText = [paperReceiverName, paperReceiverMobile, paperReceiverAddress].filter(Boolean).join(' ') || '-';
      return `
        <tr data-invoice-serial-no="${esc(serialNo)}">
          <td class="invoice-api-sticky-left invoice-api-sticky-left-0" title="${esc(item.orderSn || serialNo || '-')}"><a class="invoice-api-pdd-order">${esc(item.orderSn || serialNo || '-')}</a></td>
          <td title="${esc(item.shopName || '-')}">${esc(item.shopName || '-')}</td>
          <td title="${esc(item.orderStatus || '-')}">${esc(item.orderStatus || '-')}</td>
          <td title="${esc(item.afterSalesStatus || '-')}">${esc(item.afterSalesStatus || '-')}</td>
          <td title="${esc(applyTimeText)}">${esc(applyTimeText)}</td>
          <td class="invoice-api-pdd-amount">${esc(formatApiAmount(item.invoiceAmount))}</td>
          <td title="${esc(item.invoiceMode || '-')}">${esc(item.invoiceMode || '-')}</td>
          <td title="${esc(item.invoiceType || '-')}">${esc(item.invoiceType || '-')}</td>
          <td title="${esc(item.invoiceKind || '-')}">${esc(item.invoiceKind || '-')}</td>
          <td title="${esc(item.letterheadType || '-')}">${esc(item.letterheadType || '-')}</td>
          <td class="invoice-api-pdd-cell-wrap" title="${esc(item.letterhead || '-')}">${esc(item.letterhead || '-')}</td>
          <td title="${esc(item.taxNo || '-')}">${esc(item.taxNo || '-')}</td>
          <td class="invoice-api-pdd-cell-wrap" title="${esc(otherInfo || '-')}">${esc(otherInfo || '-')}</td>
          <td class="invoice-api-pdd-cell-wrap" title="${esc(mailAddressText)}">${esc(mailAddressText)}</td>
          <td class="invoice-api-sticky-right">
            <div class="invoice-api-pdd-actions">
              <button class="invoice-api-pdd-action-link" data-invoice-action="issue" data-invoice-serial="${esc(serialNo)}">立即开票</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    container.querySelectorAll('[data-invoice-action]').forEach(button => {
      button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        const action = String(button.dataset.invoiceAction || '');
        const serialNo = String(button.dataset.invoiceSerial || '');
        if (!serialNo) return;
        if (action === 'issue') {
          const originalText = button.textContent || '';
          button.disabled = true;
          if (originalText) button.textContent = '加载中';
          try {
            await openInvoiceApiEntryDialog(serialNo);
          } finally {
            button.disabled = false;
            if (originalText) button.textContent = originalText;
          }
          return;
        }
        addLog('暂不开票操作接口尚未采集到真实请求路径，待补齐抓包后接入。', 'info');
      });
    });
    container.querySelectorAll('.invoice-api-pdd-order').forEach(link => {
      link.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const tr = link.closest('tr');
        const serialNo = String(tr?.dataset?.invoiceSerialNo || '');
        const item = invoiceApiList.find(entry => String(entry.serialNo) === serialNo);
        const orderSn = String(item?.orderSn || item?.raw?.order_sn || serialNo || '').trim();
        const shopId = String(item?.shopId || activeShopId || '').trim();
        await openInvoiceApiOrderInEmbedded({ orderSn, serialNo, shopId });
      });
    });
    renderInvoiceApiPager();
  }

  function ensureInvoiceApiEmbeddedOverlayBar() {
    if (document.getElementById('invoiceApiEmbeddedOverlayBar')) return;
    const bar = document.createElement('div');
    bar.id = 'invoiceApiEmbeddedOverlayBar';
    bar.style.cssText = 'position:fixed;top:48px;left:180px;right:0;height:42px;display:none;align-items:center;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid #e8e8e8;z-index:9999;';
    bar.innerHTML = `
      <button type="button" id="btnInvoiceApiEmbeddedBack" style="height:28px;padding:0 10px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;">返回待开票列表</button>
      <div id="invoiceApiEmbeddedTitle" style="font-size:13px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    `;
    document.body.appendChild(bar);
    const back = document.getElementById('btnInvoiceApiEmbeddedBack');
    back?.addEventListener('click', async () => {
      await closeInvoiceApiEmbeddedOverlay();
    });
  }

  function renderInvoiceApiEmbeddedOverlayBar() {
    ensureInvoiceApiEmbeddedOverlayBar();
    const bar = document.getElementById('invoiceApiEmbeddedOverlayBar');
    const title = document.getElementById('invoiceApiEmbeddedTitle');
    if (!bar || !title) return;
    bar.style.display = invoiceApiEmbeddedOverlayVisible ? 'flex' : 'none';
    title.textContent = invoiceApiEmbeddedOverlayVisible
      ? `订单开票页：${invoiceApiEmbeddedOverlayOrderSn || '-'}`
      : '';
  }

  async function openInvoiceApiOrderInEmbedded(params = {}) {
    const orderSn = String(params.orderSn || params.order_sn || '').trim();
    const serialNo = String(params.serialNo || params.serial_no || '').trim();
    const shopId = String(params.shopId || '').trim();
    const targetOrderSn = orderSn || serialNo;
    if (!targetOrderSn) return;
    if (!window.pddApi || typeof window.pddApi.openInvoiceOrderDetailWindow !== 'function') {
      addLog('订单开票窗口能力未就绪', 'error');
      return;
    }
    const result = await window.pddApi.openInvoiceOrderDetailWindow({
      shopId,
      orderSn: targetOrderSn,
      serialNo
    });
    if (result && result.error) {
      if (typeof showToast === 'function') {
        showToast(result.error);
      } else {
        addLog(result.error, 'error');
      }
    }
  }

  async function closeInvoiceApiEmbeddedOverlay() {
    invoiceApiEmbeddedOverlayVisible = false;
    invoiceApiEmbeddedOverlayOrderSn = '';
    renderInvoiceApiEmbeddedOverlayBar();
    await window.pddApi.closeEmbeddedOverlay();
  }

  function renderInvoiceApiDetail() {
    const head = getEl('invoiceApiDetailHead');
    const panel = getEl('invoiceApiDetailPanel');
    if (!head || !panel) return;
    if (!invoiceApiActiveDetail?.serialNo) {
      head.innerHTML = `
        <div class="mail-api-detail-title">请选择一条待开票记录</div>
        <div class="mail-api-detail-meta"><span>订单号：-</span><span>申请时间：-</span></div>
      `;
      panel.innerHTML = '<div class="invoice-api-detail-empty">请选择一条待开票记录查看详情</div>';
      const meta = getEl('invoiceApiDetailMeta');
      if (meta) meta.textContent = '点击行查看详情，点击“录入发票”弹出对话框';
      return;
    }
    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(invoiceApiActiveDetail.orderSn || invoiceApiActiveDetail.serialNo || '待开票记录')}</div>
      <div class="mail-api-detail-meta">
        <span>流水号：${esc(invoiceApiActiveDetail.serialNo || '-')}</span>
        <span>申请时间：${esc(formatInvoiceApiDateTime(invoiceApiActiveDetail.applyTime))}</span>
      </div>
    `;
    const detailItems = [
      ['店铺', invoiceApiActiveDetail.shopName || '-'],
      ['流水号', invoiceApiActiveDetail.serialNo || '-'],
      ['订单状态', invoiceApiActiveDetail.orderStatus || '-'],
      ['售后状态', invoiceApiActiveDetail.afterSalesStatus || '-'],
      ['承诺开票时间', formatInvoiceApiPromiseTime(invoiceApiActiveDetail.promiseInvoiceTime)],
      ['开票金额', formatApiAmount(invoiceApiActiveDetail.invoiceAmount)],
      ['开票方式', invoiceApiActiveDetail.invoiceMode || '-'],
      ['发票种类', invoiceApiActiveDetail.invoiceType || '-'],
      ['发票类型', invoiceApiActiveDetail.invoiceKind || '-'],
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
    const meta = getEl('invoiceApiDetailMeta');
    if (meta) meta.textContent = `已打开记录：${invoiceApiActiveDetail.serialNo || invoiceApiActiveDetail.orderSn}`;
  }

  function renderInvoiceApiTraffic() {
    const container = getEl('invoiceApiTrafficList');
    if (!container) return;
    const summary = getEl('invoiceApiTrafficSummary');
    if (summary) summary.textContent = `${invoiceApiEntries.length} 条抓包记录`;
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

  async function loadInvoiceApiTraffic(shopId = API_ALL_SHOPS) {
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
      const headerMeta = getEl('invoiceApiHeaderMeta');
      if (headerMeta) headerMeta.textContent = result?.error || '加载待开票统计失败';
      return false;
    }
    invoiceApiOverview = result;
    renderInvoiceApiOverview();
    renderInvoiceApiSummary();
    const headerMeta = getEl('invoiceApiHeaderMeta');
    if (headerMeta) headerMeta.textContent = `统计口径：当前接口返回 · 待开票 ${result.pendingNum || 0} 条，已开票 ${result.invoicedNum || 0} 条`;
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
    const shopId = API_ALL_SHOPS;
    if (!shopId) {
      invoiceApiList = [];
      invoiceApiActiveSerialNo = '';
      invoiceApiActiveDetail = null;
      invoiceApiPageNo = 1;
      invoiceApiTotal = 0;
      renderInvoiceApiFilterOptions();
      renderInvoiceApiSummary();
      renderInvoiceApiList();
      return false;
    }
    const result = await window.pddApi.invoiceGetList({
      shopId,
      pageNo: invoiceApiPageNo,
      pageSize: invoiceApiPageSize,
      keyword: invoiceApiKeyword
    });
    if (!result || result.error) {
      invoiceApiList = [];
      invoiceApiActiveSerialNo = '';
      invoiceApiActiveDetail = null;
      invoiceApiTotal = 0;
      renderInvoiceApiFilterOptions();
      renderInvoiceApiSummary();
      renderInvoiceApiList();
      addLog(result?.error || '加载待开票列表失败', 'error');
      return false;
    }
    invoiceApiList = Array.isArray(result.list) ? result.list : [];
    invoiceApiTotal = Number(result.total || 0);
    renderInvoiceApiFilterOptions();
    renderInvoiceApiSummary();
    renderInvoiceApiList();
    return true;
  }

  async function loadInvoiceApiView(options = {}) {
    await refreshShopContext();
    resetInvoiceApiState();
    await loadInvoiceApiList({ keepCurrent: options.keepCurrent });
  }

  function bindInvoiceApiModule() {
    if (initialized) return;
    initialized = true;

    getEl('btnInvoiceApiOpenDebug')?.addEventListener('click', async () => {
      const result = await window.pddApi.openDebugWindow();
      if (result?.error) addLog(`打开调试面板失败: ${result.error}`, 'error');
    });
    getEl('btnInvoiceApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnInvoiceApiRefreshList')?.addEventListener('click', async event => {
      const refreshButton = event?.currentTarget;
      const originalText = refreshButton?.textContent || '刷新';
      if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.textContent = '刷新中';
      }
      invoiceApiPageNo = 1;
      invoiceApiKeyword = '';
      invoiceApiList = [];
      invoiceApiTotal = 0;
      renderInvoiceApiSummary();
      renderInvoiceApiList();
      try {
        await loadInvoiceApiList();
        addLog('已刷新待开票列表', 'info');
      } finally {
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = originalText;
        }
      }
    });
    getEl('btnInvoiceApiPagePrev')?.addEventListener('click', async () => {
      if (invoiceApiPageNo <= 1) return;
      invoiceApiPageNo = Math.max(1, invoiceApiPageNo - 1);
      await loadInvoiceApiList();
    });
    getEl('btnInvoiceApiPageNext')?.addEventListener('click', async () => {
      if (invoiceApiTotal && invoiceApiPageNo * invoiceApiPageSize >= invoiceApiTotal) return;
      invoiceApiPageNo = Math.max(1, invoiceApiPageNo + 1);
      await loadInvoiceApiList();
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
    getEl('invoiceApiEntryFile')?.addEventListener('change', handleInvoiceApiEntryFileChange);
    getEl('invoiceApiEntryPreviewBtn')?.addEventListener('click', event => {
      event?.preventDefault();
      event?.stopPropagation();
      showInvoiceApiFilePreview();
    });
    getEl('invoiceApiEntryThumbBtn')?.addEventListener('click', () => {
      const url = String(invoiceApiEntryDialogState.goodsThumb || '').trim();
      if (!url) return;
      const previewImage = document.getElementById('apiImagePreviewContent');
      const modal = document.getElementById('modalApiImagePreview');
      if (!previewImage || !modal) return;
      previewImage.src = url;
      if (typeof showModal === 'function') {
        showModal('modalApiImagePreview');
      } else {
        modal.classList.add('visible');
      }
    });
    getEl('invoiceApiEntryNumber')?.addEventListener('input', event => {
      invoiceApiEntryDialogState.invoiceNumber = event.target.value || '';
      renderInvoiceApiEntryDialog();
    });
    getEl('invoiceApiEntryCode')?.addEventListener('input', event => {
      invoiceApiEntryDialogState.invoiceCode = event.target.value || '';
      renderInvoiceApiEntryDialog();
    });
    getEl('btnInvoiceApiEntrySubmit')?.addEventListener('click', submitInvoiceApiEntry);
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
  window.hideInvoiceApiFilePreview = hideInvoiceApiFilePreview;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('invoice-api-module', bindInvoiceApiModule);
  } else {
    bindInvoiceApiModule();
  }
})();
