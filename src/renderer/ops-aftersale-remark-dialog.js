(function () {
  const MODAL_ID = 'modalOpsAfterSaleRemark';
  const API_ORDER_REMARK_MAX_LENGTH = 300;
  const API_ORDER_REMARK_TAG_ORDER = ['RED', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE'];
  const API_ORDER_REMARK_TAG_LABELS = {
    RED: '红色',
    YELLOW: '黄色',
    GREEN: '绿色',
    BLUE: '蓝色',
    PURPLE: '紫色',
  };

  let mounted = false;
  let state = {
    context: null,
    resolver: null,
    loading: false,
    saving: false,
    error: '',
    note: '',
    tag: '',
    tags: { ...API_ORDER_REMARK_TAG_LABELS },
  };

  function getEl(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeApiOrderRemarkTags(tags = {}) {
    const source = tags && typeof tags === 'object' ? tags : {};
    const orderedKeys = [
      ...API_ORDER_REMARK_TAG_ORDER.filter(key => source[key]),
      ...Object.keys(source).filter(key => source[key] && !API_ORDER_REMARK_TAG_ORDER.includes(key)),
    ];
    if (!orderedKeys.length) return { ...API_ORDER_REMARK_TAG_LABELS };
    return orderedKeys.reduce((result, key) => {
      result[key] = String(source[key] || '').trim() || API_ORDER_REMARK_TAG_LABELS[key] || key;
      return result;
    }, {});
  }

  function normalizeApiOrderRemarkTagValue(value = '') {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized) return '';
    if (['0', 'NULL', 'UNDEFINED', 'FALSE', 'NONE'].includes(normalized)) return '';
    return normalized;
  }

  function resolveApiOrderRemarkDotColor(tag = '', tagName = '') {
    const normalized = String(tag || '').trim().toLowerCase();
    if (['red', 'yellow', 'green', 'blue', 'purple'].includes(normalized)) return normalized;
    const label = String(tagName || '').trim();
    if (!label) return '';
    if (label.includes('紫')) return 'purple';
    if (label.includes('红')) return 'red';
    if (label.includes('黄')) return 'yellow';
    if (label.includes('绿')) return 'green';
    if (label.includes('蓝')) return 'blue';
    const lower = label.toLowerCase();
    if (lower.includes('purple')) return 'purple';
    if (lower.includes('red')) return 'red';
    if (lower.includes('yellow')) return 'yellow';
    if (lower.includes('green')) return 'green';
    if (lower.includes('blue')) return 'blue';
    return '';
  }

  function isApiOrderRemarkHandlerMissing(error) {
    const message = String(error?.message || error || '');
    return /No handler registered for 'api-get-order-remark'|No handler registered for 'api-get-order-remark-tags'|No handler registered for 'api-save-order-remark'/i.test(message);
  }

  function resolveOnce(result) {
    const fn = state.resolver;
    state.resolver = null;
    if (typeof fn === 'function') {
      try {
        fn(result);
      } catch {}
    }
  }

  function closeDialog(result) {
    if (state.saving) return;
    const overlay = getEl(MODAL_ID);
    if (overlay) {
      if (typeof window.hideModal === 'function') {
        window.hideModal(MODAL_ID);
      } else {
        overlay.classList.remove('visible');
      }
    }
    state.loading = false;
    state.saving = false;
    resolveOnce(result ?? null);
  }

  async function resolveShopId() {
    const fromContext = String(state?.context?.shopId || '').trim();
    if (fromContext && fromContext !== '__all__') return fromContext;
    try {
      const active = await window.pddApi?.getActiveShop?.();
      const id = String(active?.id || '').trim();
      return id && id !== '__all__' ? id : '';
    } catch {
      return '';
    }
  }

  function buildTagButtonsHtml() {
    const tagOptions = normalizeApiOrderRemarkTags(state.tags);
    const selectedTag = normalizeApiOrderRemarkTagValue(state.tag);
    return Object.entries(tagOptions).map(([value, label]) => {
      const dotColor = resolveApiOrderRemarkDotColor(value, label);
      return `
        <button
          type="button"
          class="ops-aftersale-remark-tag${selectedTag === value ? ' active' : ''}"
          data-ops-aftersale-remark-tag="${escapeHtml(value)}"
          ${state.loading || state.saving ? 'disabled' : ''}
        >
          ${dotColor ? `<span class="ops-aftersale-remark-dot is-${escapeHtml(dotColor)}"></span>` : ''}
          <span>${escapeHtml(label)}</span>
        </button>
      `;
    }).join('');
  }

  function syncView() {
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;

    const statusEl = overlay.querySelector('#opsAftersaleRemarkStatus');
    const errorEl = overlay.querySelector('#opsAftersaleRemarkError');
    const tagsEl = overlay.querySelector('#opsAftersaleRemarkTags');
    const textarea = overlay.querySelector('#opsAftersaleRemarkTextarea');
    const countEl = overlay.querySelector('#opsAftersaleRemarkCount');
    const saveBtn = overlay.querySelector('#btnOpsAftersaleRemarkSave');

    if (statusEl) {
      if (state.loading) {
        statusEl.removeAttribute('hidden');
        statusEl.textContent = '正在读取备注...';
      } else {
        statusEl.setAttribute('hidden', '');
        statusEl.textContent = '';
      }
    }

    if (errorEl) {
      if (state.error) {
        errorEl.removeAttribute('hidden');
        errorEl.textContent = String(state.error || '');
      } else {
        errorEl.setAttribute('hidden', '');
        errorEl.textContent = '';
      }
    }

    if (tagsEl) {
      tagsEl.innerHTML = buildTagButtonsHtml();
    }

    const note = String(state.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH);
    if (textarea) {
      if (textarea.value !== note) {
        textarea.value = note;
      }
      textarea.disabled = state.loading || state.saving;
    }
    if (countEl) {
      countEl.textContent = `${note.length} / ${API_ORDER_REMARK_MAX_LENGTH}`;
    }
    if (saveBtn) {
      saveBtn.disabled = state.loading || state.saving;
      saveBtn.textContent = state.saving ? '保存中...' : '保存';
    }
  }

  async function loadRemark() {
    if (!window.pddApi?.apiGetOrderRemark || !window.pddApi?.apiGetOrderRemarkTags) {
      state.loading = false;
      state.error = '当前版本尚未提供备注读取接口';
      syncView();
      return;
    }
    const shopId = await resolveShopId();
    const orderNo = String(state?.context?.orderNo || '').trim();
    if (!shopId) {
      state.loading = false;
      state.error = '当前记录缺少店铺ID，请切换到具体店铺后重试';
      syncView();
      return;
    }
    if (!orderNo) {
      state.loading = false;
      state.error = '缺少订单号';
      syncView();
      return;
    }
    try {
      const [remarkResult, tagsResult] = await Promise.all([
        window.pddApi.apiGetOrderRemark({ shopId, orderSn: orderNo, source: 1 }),
        window.pddApi.apiGetOrderRemarkTags({ shopId }),
      ]);
      const nextNote = String(remarkResult?.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH);
      const nextTag = normalizeApiOrderRemarkTagValue(remarkResult?.tag || '');
      state.loading = false;
      state.note = nextNote;
      state.tag = nextTag;
      state.tags = normalizeApiOrderRemarkTags(tagsResult?.error ? state.tags : tagsResult);
      state.error = remarkResult?.error || tagsResult?.error || '';
      syncView();
      setTimeout(() => {
        if (state.loading || state.saving) return;
        getEl('opsAftersaleRemarkTextarea')?.focus?.();
      }, 0);
    } catch (error) {
      state.loading = false;
      if (isApiOrderRemarkHandlerMissing(error)) {
        state.error = '';
        state.tags = { ...API_ORDER_REMARK_TAG_LABELS };
        syncView();
        window.opsCenterToast?.('备注接口已更新，请重启应用后启用读取与保存');
        return;
      }
      state.error = error?.message || '读取备注失败';
      syncView();
    }
  }

  async function saveRemark() {
    if (state.loading || state.saving) return;
    const orderNo = String(state?.context?.orderNo || '').trim();
    if (!orderNo) {
      window.opsCenterToast?.('缺少订单号');
      return;
    }
    if (!window.pddApi?.apiSaveOrderRemark) {
      window.opsCenterToast?.('当前版本尚未提供备注保存接口');
      return;
    }
    const shopId = await resolveShopId();
    if (!shopId) {
      window.opsCenterToast?.('当前记录缺少店铺ID');
      return;
    }
    state.saving = true;
    state.error = '';
    syncView();
    try {
      const result = await window.pddApi.apiSaveOrderRemark({
        shopId,
        orderSn: orderNo,
        note: String(state.note || '').slice(0, API_ORDER_REMARK_MAX_LENGTH),
        tag: normalizeApiOrderRemarkTagValue(state.tag),
        source: 1,
      });
      if (result?.error) throw new Error(result.error);
      state.saving = false;
      syncView();
      closeDialog(result);
      window.opsCenterToast?.('备注保存成功');
    } catch (error) {
      if (isApiOrderRemarkHandlerMissing(error)) {
        state.saving = false;
        syncView();
        window.opsCenterToast?.('请重启应用后再保存备注');
        return;
      }
      state.saving = false;
      state.error = error?.message || '保存备注失败';
      syncView();
    }
  }

  function ensureMounted() {
    if (mounted) return;
    mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="modal ops-aftersale-remark-modal" role="dialog" aria-modal="true">
        <div class="modal-header ops-aftersale-remark-header">
          <h3 class="ops-aftersale-remark-header-title">备注</h3>
          <button class="ops-aftersale-remark-close" type="button" data-ops-close="1" aria-label="关闭">×</button>
        </div>
        <div class="modal-body ops-aftersale-remark-body">
          <div class="ops-aftersale-remark-status" id="opsAftersaleRemarkStatus" hidden></div>
          <div class="ops-aftersale-remark-error" id="opsAftersaleRemarkError" hidden></div>
          <div class="ops-aftersale-remark-tags" id="opsAftersaleRemarkTags"></div>
          <div class="ops-aftersale-remark-editor">
            <textarea
              class="ops-aftersale-remark-textarea"
              id="opsAftersaleRemarkTextarea"
              maxlength="${API_ORDER_REMARK_MAX_LENGTH}"
              placeholder="可输入备注详情，保存后商家和顾客可见"
            ></textarea>
            <div class="ops-aftersale-remark-count" id="opsAftersaleRemarkCount">0 / ${API_ORDER_REMARK_MAX_LENGTH}</div>
          </div>
        </div>
        <div class="modal-footer ops-aftersale-remark-footer">
          <button class="ops-aftersale-btn" type="button" id="btnOpsAftersaleRemarkSave">保存</button>
          <button class="ops-aftersale-remark-cancel" type="button" data-ops-close="1">取消</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDialog(null);
    });

    overlay.querySelectorAll('[data-ops-close="1"]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog(null));
    });

    overlay.querySelector('#opsAftersaleRemarkTags')?.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('[data-ops-aftersale-remark-tag]');
      if (!btn) return;
      if (state.loading || state.saving) return;
      const value = normalizeApiOrderRemarkTagValue(btn.dataset.opsAftersaleRemarkTag || '');
      state.tag = state.tag && normalizeApiOrderRemarkTagValue(state.tag) === value ? '' : value;
      syncView();
    });

    overlay.querySelector('#opsAftersaleRemarkTextarea')?.addEventListener('input', (event) => {
      if (state.loading || state.saving) return;
      const textarea = event?.target;
      if (!textarea) return;
      const value = String(textarea.value || '').slice(0, API_ORDER_REMARK_MAX_LENGTH);
      if (textarea.value !== value) textarea.value = value;
      state.note = value;
      const countEl = getEl('opsAftersaleRemarkCount');
      if (countEl) countEl.textContent = `${value.length} / ${API_ORDER_REMARK_MAX_LENGTH}`;
    });

    overlay.querySelector('#btnOpsAftersaleRemarkSave')?.addEventListener('click', () => {
      saveRemark();
    });

    document.body.appendChild(overlay);
  }

  function openDialog(context) {
    ensureMounted();
    state.context = context || null;
    state.loading = true;
    state.saving = false;
    state.error = '';
    state.note = '';
    state.tag = '';
    state.tags = { ...API_ORDER_REMARK_TAG_LABELS };
    syncView();
    if (typeof window.showModal === 'function') {
      window.showModal(MODAL_ID);
    } else {
      getEl(MODAL_ID)?.classList.add('visible');
    }
    void loadRemark();
    return new Promise((resolve) => {
      state.resolver = resolve;
    });
  }

  window.openOpsAfterSaleRemarkDialog = openDialog;
})();
