;(function () {
  const api = window.mailDetailWindowApi;
  const toolbar = document.getElementById('toolbar');
  const btnBack = document.getElementById('btnBack');
  const btnForward = document.getElementById('btnForward');
  const btnReload = document.getElementById('btnReload');
  const urlInput = document.getElementById('urlInput');
  const statusText = document.getElementById('statusText');

  let lastUrl = '';

  function getDisplayPath(url) {
    const text = String(url || '').trim();
    if (!text) return '';
    try {
      const parsed = new URL(text);
      return `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
    } catch {
      return text;
    }
  }

  function applyState(state = {}) {
    const url = String(state?.url || '').trim();
    const canGoBack = state?.canGoBack === true;
    const canGoForward = state?.canGoForward === true;
    const isLoading = state?.isLoading === true;
    const errorDescription = String(state?.errorDescription || '').trim();

    btnBack.disabled = !canGoBack;
    btnForward.disabled = !canGoForward;

    if (url && url !== lastUrl) {
      lastUrl = url;
      urlInput.value = getDisplayPath(url);
      urlInput.title = url;
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

  window.addEventListener('resize', () => {
    updateToolbarHeight();
  });

  requestAnimationFrame(() => updateToolbarHeight());
})();
