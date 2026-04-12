(function () {
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function normalizeLicense(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      code: raw.code ? String(raw.code) : '',
      valid: !!raw.valid,
      remainingDays: raw.remainingDays ?? raw.remaining_days,
      expiresAt: raw.expiresAt || raw.expires_at || ''
    };
  }

  function buildText(license) {
    if (!license || !license.code) return '未激活';
    if (!license.valid) return '授权无效';
    const days = Number(license.remainingDays ?? 0);
    const expires = formatDate(license.expiresAt);
    if (expires) return `有效期至 ${expires}（剩余 ${Number.isFinite(days) ? days : 0} 天）`;
    return `剩余 ${Number.isFinite(days) ? days : 0} 天`;
  }

  async function loadLicense() {
    try {
      return normalizeLicense(await window.pddApi.getLicenseData());
    } catch {
      return null;
    }
  }

  function render(license) {
    const el = document.getElementById('licenseStatus');
    const btn = document.getElementById('btnLicenseUnbind');
    if (!el) return;

    const text = buildText(license);
    el.textContent = `授权：${text}`;
    if (btn) btn.style.display = license?.code ? '' : 'none';
  }

  async function onUnbindClick() {
    const btn = document.getElementById('btnLicenseUnbind');
    if (!btn || btn.disabled) return;
    const ok = window.confirm('将清除本机授权信息并返回授权验证窗口，是否继续？');
    if (!ok) return;
    btn.disabled = true;
    try {
      await window.pddApi.clearLicense();
    } catch (err) {
      window.alert(err?.message || String(err || '解除失败'));
      btn.disabled = false;
    }
  }

  async function init() {
    if (!window.pddApi?.getLicenseData) return;
    const btn = document.getElementById('btnLicenseUnbind');
    if (btn) btn.addEventListener('click', onUnbindClick);

    render(await loadLicense());
    if (window.pddApi?.onLicenseUpdated) {
      window.pddApi.onLicenseUpdated((data) => render(normalizeLicense(data)));
    }
  }

  init();
})();
