(function () {
  let initialized = false;

  function getRuntime() {
    return window.__quickPhrasesModuleAccess || {};
  }

  function getState() {
    const runtime = getRuntime();
    if (typeof runtime.getState === 'function') {
      return runtime.getState() || {};
    }
    return {};
  }

  function callRuntime(name, ...args) {
    const runtime = getRuntime();
    const fn = runtime[name];
    if (typeof fn === 'function') {
      return fn(...args);
    }
    return undefined;
  }

  function esc(value) {
    return callRuntime('esc', value) || '';
  }

  function addLog(message, type) {
    return callRuntime('addLog', message, type);
  }

  function showModal(id) {
    return callRuntime('showModal', id);
  }

  function hideModal(id) {
    return callRuntime('hideModal', id);
  }

  function setQuickPhrases(value) {
    return callRuntime('setQuickPhrases', value);
  }

  async function loadQuickPhrases() {
    const phrases = await window.pddApi.getQuickPhrases();
    setQuickPhrases(Array.isArray(phrases) ? phrases : []);
    renderPhrasePanel();
  }

  function renderPhrasePanel() {
    const body = document.getElementById('phrasePanelBody');
    if (!body) return;
    const grouped = {};
    (getState().quickPhrases || []).forEach(item => {
      const category = item.category || '通用';
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(item);
    });

    let html = '';
    for (const [category, items] of Object.entries(grouped)) {
      html += `<div class="phrase-category">${esc(category)}</div>`;
      items.forEach(item => {
        html += `<div class="phrase-item" data-text="${esc(item.text)}">${esc(item.text)}</div>`;
      });
    }
    body.innerHTML = html || '<div style="padding:20px;text-align:center;color:#bbb">暂无快捷短语</div>';

    body.querySelectorAll('.phrase-item').forEach(item => {
      item.addEventListener('click', async () => {
        await window.pddApi.sendQuickPhrase(item.dataset.text);
        addLog(`发送快捷短语: ${item.dataset.text}`, 'reply');
      });
    });
  }

  function openPhraseManager() {
    const editor = document.getElementById('phrasesEditor');
    if (!editor) return;
    editor.value = (getState().quickPhrases || []).map(item => `${item.category || '通用'}|${item.text}`).join('\n');
    showModal('modalPhrases');
  }

  async function saveQuickPhrases() {
    const editor = document.getElementById('phrasesEditor');
    if (!editor) return;
    const lines = editor.value.split('\n').filter(line => line.trim());
    const nextPhrases = lines.map((line, index) => {
      const parts = line.split('|');
      return {
        id: `qp_${Date.now()}_${index}`,
        category: parts.length > 1 ? parts[0].trim() : '通用',
        text: (parts.length > 1 ? parts.slice(1).join('|') : parts[0]).trim()
      };
    }).filter(item => item.text);

    setQuickPhrases(nextPhrases);
    await window.pddApi.saveQuickPhrases(nextPhrases);
    renderPhrasePanel();
    if (typeof window.renderApiPhrasePanel === 'function') {
      window.renderApiPhrasePanel();
    }
    hideModal('modalPhrases');
    addLog('快捷短语已更新', 'info');
  }

  function togglePhrasePanel() {
    const panel = document.getElementById('phrasePanel');
    if (!panel) return;
    panel.classList.toggle('visible');
    if (panel.classList.contains('visible')) {
      loadQuickPhrases();
    }
  }

  function bindQuickPhrasesModule() {
    if (initialized) return;
    initialized = true;

    document.getElementById('btnTogglePhrases')?.addEventListener('click', togglePhrasePanel);
    document.getElementById('btnQuickReply')?.addEventListener('click', togglePhrasePanel);
    document.getElementById('btnManagePhrases')?.addEventListener('click', openPhraseManager);
    document.getElementById('btnApiManagePhrases')?.addEventListener('click', openPhraseManager);
    document.getElementById('btnSavePhrases')?.addEventListener('click', saveQuickPhrases);
  }

  window.loadQuickPhrases = loadQuickPhrases;
  window.renderPhrasePanel = renderPhrasePanel;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('quick-phrases-module', bindQuickPhrasesModule);
  } else {
    bindQuickPhrasesModule();
  }
})();
