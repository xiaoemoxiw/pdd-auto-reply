(function () {
  const MODAL_ID = 'modalOpsAfterSaleApproveRefundPrecheck';
  const DEFAULT_TITLE = '您当前店铺的货款余额不足';
  const DEFAULT_MESSAGE = '您当前店铺的货款余额不足（账户资金受限），为保证店铺正常运营，请您至少充值100元后再进行售后处理操作';
  const DEFAULT_RECHARGE_URL = 'https://mms.pinduoduo.com/';
  let mounted = false;
  let lastOptions = {};

  function getEl(id) {
    return document.getElementById(id);
  }

  function closeDialog() {
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    overlay.classList.remove('visible');
  }

  function renderText(message) {
    const container = getEl('opsAftersaleRefundPrecheckMessage');
    if (!container) return;
    const text = String(message || '').trim() || DEFAULT_MESSAGE;
    container.textContent = text;
  }

  function ensureMounted() {
    if (mounted) return;
    mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="modal wide ops-aftersale-refund-precheck-modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3 id="opsAftersaleRefundPrecheckTitle">${DEFAULT_TITLE}</h3>
          <button class="modal-close" type="button" data-ops-close="1">&times;</button>
        </div>
        <div class="modal-body ops-aftersale-refund-precheck-body">
          <div class="ops-aftersale-refund-precheck-text" id="opsAftersaleRefundPrecheckMessage">${DEFAULT_MESSAGE}</div>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDialog();
    });

    overlay.querySelectorAll('[data-ops-close="1"]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog());
    });

    document.body.appendChild(overlay);
  }

  function openDialog(options = {}) {
    ensureMounted();
    lastOptions = options && typeof options === 'object' ? options : {};
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;

    const titleEl = getEl('opsAftersaleRefundPrecheckTitle');
    const title = String(lastOptions?.title || '').trim() || DEFAULT_TITLE;
    if (titleEl) titleEl.textContent = title;
    renderText(lastOptions?.message);

    overlay.classList.add('visible');
  }

  window.openOpsAfterSaleApproveRefundPrecheckDialog = openDialog;
})();
