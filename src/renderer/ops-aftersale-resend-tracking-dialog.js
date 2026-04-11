(function () {
  const MODAL_ID = 'modalOpsAfterSaleResendTracking';
  const FALLBACK_COMPANY_NAMES = [
    '申通快递',
    '百世快递',
    '顺丰快递',
    '圆通快递',
    '中通快递',
    '优速',
  ];
  const companyCache = new Map();
  let mounted = false;
  let state = {
    context: null,
    resolver: null,
    submitting: false,
  };

  function getEl(id) {
    return document.getElementById(id);
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
    const overlay = getEl(MODAL_ID);
    if (overlay) {
      if (typeof window.hideModal === 'function') {
        window.hideModal(MODAL_ID);
      } else {
        overlay.classList.remove('visible');
      }
    }
    state.submitting = false;
    resolveOnce(result ?? null);
  }

  function setAgreedHintVisible(visible) {
    const el = getEl('opsAftersaleResendAgreedHint');
    if (!el) return;
    if (visible) {
      el.removeAttribute('hidden');
      return;
    }
    el.setAttribute('hidden', '');
  }

  function setInvalid(id, invalid) {
    const el = getEl(id);
    if (!el) return;
    el.dataset.invalid = invalid ? '1' : '';
  }

  function readValue(id) {
    const el = getEl(id);
    if (!el) return '';
    return String(el.value || '').trim();
  }

  function escapeHtml(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildCompanyOptions(list, placeholder) {
    const head = `<option value="" selected disabled>${escapeHtml(placeholder || '请选择快递公司')}</option>`;
    const normalized = Array.isArray(list) ? list : [];
    const body = normalized.map(item => {
      if (!item) return '';
      if (typeof item === 'string') {
        const name = item.trim();
        if (!name) return '';
        return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      if (!id || !name) return '';
      return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
    }).filter(Boolean).join('');
    return head + body;
  }

  function getSelectedOptionText(selectId) {
    const el = getEl(selectId);
    if (!el || el.tagName !== 'SELECT') return '';
    const idx = Number(el.selectedIndex);
    if (!Number.isFinite(idx) || idx < 0) return '';
    const opt = el.options?.[idx];
    const value = String(opt?.value || '').trim();
    const text = String(opt?.textContent || opt?.innerText || '').trim();
    return value ? text : '';
  }

  function setCompanyOptionsHtml(html) {
    const select = getEl('opsAftersaleResendCompany');
    if (!select) return;
    select.innerHTML = html;
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

  async function loadShippingCompanies() {
    const shopId = await resolveShopId();
    if (!shopId) {
      setCompanyOptionsHtml(buildCompanyOptions(FALLBACK_COMPANY_NAMES, '请选择快递公司'));
      return;
    }
    const cached = companyCache.get(shopId);
    if (cached?.list?.length) {
      setCompanyOptionsHtml(buildCompanyOptions(cached.list, '请选择快递公司'));
      return;
    }
    if (typeof window.pddApi?.aftersaleGetShippingCompanies !== 'function') {
      setCompanyOptionsHtml(buildCompanyOptions(FALLBACK_COMPANY_NAMES, '请选择快递公司'));
      return;
    }
    try {
      setCompanyOptionsHtml(buildCompanyOptions([], '加载中...'));
      const result = await window.pddApi.aftersaleGetShippingCompanies({ shopId });
      if (!result || result.error) throw new Error(result?.error || '快递公司列表获取失败');
      const list = Array.isArray(result?.list) ? result.list : [];
      const normalized = list.map(item => {
        if (!item) return null;
        if (typeof item === 'string') {
          const name = item.trim();
          return name ? { id: name, name } : null;
        }
        const id = String(item?.id || '').trim();
        const name = String(item?.name || '').trim();
        if (!id || !name) return null;
        return { id, name };
      }).filter(Boolean);
      if (!normalized.length) {
        setCompanyOptionsHtml(buildCompanyOptions(FALLBACK_COMPANY_NAMES, '请选择快递公司'));
        return;
      }
      companyCache.set(shopId, { list: normalized, at: Date.now() });
      setCompanyOptionsHtml(buildCompanyOptions(normalized, '请选择快递公司'));
    } catch (err) {
      setCompanyOptionsHtml(buildCompanyOptions(FALLBACK_COMPANY_NAMES, '请选择快递公司'));
    }
  }

  function ensureMounted() {
    if (mounted) return;
    mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="modal ops-aftersale-resend-modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3>填写补寄单号</h3>
          <button class="modal-close" type="button" data-ops-close="1">&times;</button>
        </div>
        <div class="modal-body ops-aftersale-resend-body">
          <div class="ops-aftersale-resend-agreed-hint" id="opsAftersaleResendAgreedHint" hidden>已同意，请填写补寄单号！</div>
          <div class="ops-aftersale-resend-tip">
            <div class="ops-aftersale-resend-tip-icon" aria-hidden="true">!</div>
            <div class="ops-aftersale-resend-tip-text">
              请填写正确的补寄单号，并督促物流及时揽收；若平台核实您提供了虚假单号或补寄后不揽收，将酌情对店铺进行处罚
            </div>
          </div>

          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label"><span class="ops-aftersale-approve-return-required">*</span>快递单号</div>
            <div class="ops-aftersale-approve-return-control">
              <input class="ops-aftersale-approve-return-input" id="opsAftersaleResendTrackingNo" placeholder="请输入快递单号">
            </div>
          </div>

          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label"><span class="ops-aftersale-approve-return-required">*</span>快递公司</div>
            <div class="ops-aftersale-approve-return-control">
              <select class="ops-aftersale-approve-return-select" id="opsAftersaleResendCompany">
                ${buildCompanyOptions([], '加载中...')}
              </select>
            </div>
          </div>

          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label">补寄说明</div>
            <div class="ops-aftersale-approve-return-control">
              <textarea class="ops-aftersale-approve-return-textarea" id="opsAftersaleResendRemark" placeholder="请填写给消费者的留言"></textarea>
            </div>
          </div>
        </div>
        <div class="modal-footer ops-aftersale-resend-footer">
          <button class="ops-aftersale-btn" type="button" id="btnOpsAftersaleResendConfirm">确认</button>
          <button class="ops-aftersale-resend-cancel" type="button" data-ops-close="1">取消</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDialog(null);
    });

    overlay.querySelectorAll('[data-ops-close="1"]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog(null));
    });

    overlay.querySelector('#btnOpsAftersaleResendConfirm')?.addEventListener('click', () => {
      if (state.submitting) return;
      const trackingNo = readValue('opsAftersaleResendTrackingNo');
      const company = readValue('opsAftersaleResendCompany');
      const remark = readValue('opsAftersaleResendRemark');
      const invalidTracking = !trackingNo;
      const invalidCompany = !company;
      setInvalid('opsAftersaleResendTrackingNo', invalidTracking);
      setInvalid('opsAftersaleResendCompany', invalidCompany);
      if (invalidTracking) {
        window.opsCenterToast?.('请输入快递单号');
        return;
      }
      if (invalidCompany) {
        window.opsCenterToast?.('请选择快递公司');
        return;
      }
      state.submitting = true;
      const instanceId = String(state?.context?.instanceId || '').trim();
      const orderNo = String(state?.context?.orderNo || '').trim();
      const shopId = String(state?.context?.shopId || '').trim();
      const companyName = getSelectedOptionText('opsAftersaleResendCompany');
      closeDialog({ instanceId, orderNo, shopId, trackingNo, companyId: company, companyName, company: companyName || company, remark });
    });

    document.body.appendChild(overlay);
  }

  function resetFields() {
    const trackingEl = getEl('opsAftersaleResendTrackingNo');
    const companyEl = getEl('opsAftersaleResendCompany');
    const remarkEl = getEl('opsAftersaleResendRemark');
    if (trackingEl) trackingEl.value = '';
    if (companyEl) {
      companyEl.value = '';
      companyEl.innerHTML = buildCompanyOptions([], '加载中...');
    }
    if (remarkEl) remarkEl.value = '';
    setInvalid('opsAftersaleResendTrackingNo', false);
    setInvalid('opsAftersaleResendCompany', false);
  }

  function openDialog(context) {
    ensureMounted();
    state.context = context || null;
    state.submitting = false;
    resetFields();
    setAgreedHintVisible(Boolean(state?.context?.agreedHint));
    if (typeof window.showModal === 'function') {
      window.showModal(MODAL_ID);
    } else {
      getEl(MODAL_ID)?.classList.add('visible');
    }
    loadShippingCompanies();
    return new Promise((resolve) => {
      state.resolver = resolve;
    });
  }

  window.openOpsAfterSaleResendTrackingDialog = openDialog;
})();
