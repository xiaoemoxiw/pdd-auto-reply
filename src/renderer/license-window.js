(function () {
  const codeInput = document.getElementById('code');
  const btn = document.getElementById('btn');
  const statusEl = document.getElementById('status');
  const metaEl = document.getElementById('meta');

  function setStatus(text, isError) {
    statusEl.textContent = String(text || '');
    statusEl.classList.toggle('error', !!isError);
  }

  function setLoading(loading) {
    btn.disabled = !!loading;
    btn.textContent = loading ? '验证中...' : '验证';
  }

  function renderMeta(license) {
    if (!license) {
      metaEl.style.display = 'none';
      metaEl.innerHTML = '';
      return;
    }
    const items = [];
    if (license.partnerName) items.push(['合作方', license.partnerName]);
    if (license.remainingDays !== undefined && license.remainingDays !== null) items.push(['剩余天数', String(license.remainingDays)]);
    if (license.expiresAt) items.push(['到期时间', license.expiresAt]);
    if (license.verifiedAt) items.push(['最后验证', license.verifiedAt]);

    metaEl.innerHTML = items.map(([k, v]) => `<span class="tag">${escapeHtml(k)}: ${escapeHtml(v)}</span>`).join('');
    metaEl.style.display = items.length ? 'flex' : 'none';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function loadLocalLicense() {
    try {
      const data = await window.pddApi.getLicenseData();
      renderMeta(data);
    } catch {
      renderMeta(null);
    }
  }

  async function verify() {
    const code = String(codeInput.value || '').trim();
    if (!code) {
      setStatus('请输入授权码', true);
      return;
    }

    setLoading(true);
    setStatus('正在验证授权码…', false);
    try {
      const result = await window.pddApi.verifyLicense({ code });
      if (!result || !result.valid) {
        setStatus('授权无效，请检查授权码', true);
        await loadLocalLicense();
        return;
      }

      setStatus('授权验证成功，正在进入系统…', false);
      await loadLocalLicense();
      await window.pddApi.switchToMainWindow();
    } catch (err) {
      setStatus(err?.message || String(err || '授权验证失败'), true);
      await loadLocalLicense();
    } finally {
      setLoading(false);
    }
  }

  btn.addEventListener('click', verify);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verify();
  });

  if (window.pddApi?.onLicenseUpdated) {
    window.pddApi.onLicenseUpdated((data) => {
      renderMeta(data);
    });
  }

  loadLocalLicense();
})();
