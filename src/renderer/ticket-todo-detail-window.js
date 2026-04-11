;(function () {
  const api = window.ticketTodoDetailWindowApi;
  const toolbar = document.getElementById('toolbar');
  const btnBack = document.getElementById('btnBack');
  const btnForward = document.getElementById('btnForward');
  const btnReload = document.getElementById('btnReload');
  const urlInput = document.getElementById('urlInput');
  const statusText = document.getElementById('statusText');

  let lastUrl = '';
  let isEditingUrl = false;

  function normalizeUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    return `https://${raw.replace(/^\/+/, '')}`;
  }

  function applyState(state = {}) {
    const url = String(state?.url || '').trim();
    const canGoBack = state?.canGoBack === true;
    const canGoForward = state?.canGoForward === true;
    const isLoading = state?.isLoading === true;
    const errorDescription = String(state?.errorDescription || '').trim();

    btnBack.disabled = !canGoBack;
    btnForward.disabled = !canGoForward;

    if (!isEditingUrl && url && url !== lastUrl) {
      lastUrl = url;
      urlInput.value = url;
    }

    if (errorDescription) {
      statusText.textContent = errorDescription;
      statusText.style.color = '#b91c1c';
      return;
    }

    if (isLoading) {
      statusText.textContent = '加载中...';
      statusText.style.color = '#2563eb';
    } else {
      statusText.textContent = '就绪';
      statusText.style.color = '#6b7280';
    }
  }

  function updateToolbarHeight() {
    if (!api || !toolbar) return;
    const rect = toolbar.getBoundingClientRect();
    const height = Math.max(32, Math.round(rect.height || 0));
    api.setToolbarHeight(height);
  }

  if (api) {
    api.onState((state) => {
      applyState(state);
    });

    api.getState().then((res) => {
      if (res && res.ok && res.state) applyState(res.state);
    }).catch(() => {});
  } else {
    statusText.textContent = 'API 未就绪';
    statusText.style.color = '#b91c1c';
  }

  btnBack.addEventListener('click', () => {
    api && api.goBack();
  });
  btnForward.addEventListener('click', () => {
    api && api.goForward();
  });
  btnReload.addEventListener('click', () => {
    api && api.reload();
  });

  urlInput.addEventListener('focus', () => {
    isEditingUrl = true;
  });
  urlInput.addEventListener('blur', () => {
    isEditingUrl = false;
    if (lastUrl) urlInput.value = lastUrl;
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = normalizeUrl(urlInput.value);
    if (!url) return;
    isEditingUrl = false;
    lastUrl = url;
    api && api.navigate(url);
  });

  window.addEventListener('resize', () => {
    updateToolbarHeight();
  });

  requestAnimationFrame(() => updateToolbarHeight());
})();
