(function () {
  const defaultAiConfig = () => ({
    enabled: false,
    threshold: 0.65,
    intents: [],
    modelStatus: 'none'
  });

  const intentCollapsed = {};
  let initialized = false;
  let progressSubscribed = false;

  function getEl(id) {
    return document.getElementById(id);
  }

  function getAiConfig() {
    if (!window.aiConfig || typeof window.aiConfig !== 'object') {
      window.aiConfig = defaultAiConfig();
    }
    if (!Array.isArray(window.aiConfig.intents)) {
      window.aiConfig.intents = [];
    }
    return window.aiConfig;
  }

  function setAiConfig(nextConfig) {
    const merged = {
      ...defaultAiConfig(),
      ...(nextConfig && typeof nextConfig === 'object' ? nextConfig : {})
    };
    if (!Array.isArray(merged.intents)) {
      merged.intents = [];
    }
    window.aiConfig = merged;
    return window.aiConfig;
  }

  function escapeHtml(value) {
    return typeof window.esc === 'function'
      ? window.esc(value)
      : String(value ?? '');
  }

  function showToast(message) {
    if (typeof window.qaToast === 'function') {
      window.qaToast(message);
    }
  }

  function updateModelSourceUI() {
    const source = getEl('aiModelSource')?.value || 'mirror';
    const customMirrorRow = getEl('aiCustomMirrorRow');
    const localPathRow = getEl('aiLocalPathRow');
    const downloadBtn = getEl('btnDownloadModel');
    if (customMirrorRow) customMirrorRow.style.display = source === 'mirror' ? '' : 'none';
    if (localPathRow) localPathRow.style.display = source === 'local' ? '' : 'none';
    if (downloadBtn) {
      downloadBtn.textContent = source === 'local' ? '加载本地模型' : '下载模型';
    }
  }

  function updateAIStatusUI(status) {
    const tag = getEl('aiStatusTag');
    const downloadBtn = getEl('btnDownloadModel');
    const unloadBtn = getEl('btnUnloadModel');
    const enabledCb = getEl('aiEnabled');
    const progressArea = getEl('aiProgressArea');
    if (!tag || !downloadBtn || !unloadBtn || !enabledCb || !progressArea) return;

    tag.className = `ai-status-tag ${status}`;
    const labels = {
      none: '未下载',
      downloading: '下载中...',
      ready: '已就绪',
      error: '出错'
    };
    tag.textContent = labels[status] || status;
    downloadBtn.style.display = status === 'none' || status === 'error' ? '' : 'none';
    unloadBtn.style.display = status === 'ready' ? '' : 'none';
    enabledCb.disabled = status !== 'ready';
    if (status !== 'ready') enabledCb.checked = false;
    progressArea.style.display = status === 'downloading' ? '' : 'none';
  }

  function renderAIIntents() {
    const list = getEl('aiIntentList');
    if (!list) return;
    const aiConfig = getAiConfig();
    const intents = aiConfig.intents || [];
    if (intents.length === 0) {
      list.innerHTML = '<div style="color:#ccc;font-size:13px;padding:8px 0;">暂无意图，请添加</div>';
      return;
    }

    list.innerHTML = intents.map((intent, intentIndex) => {
      const descriptions = intent.descriptions || [];
      const replies = intent.replies || [];
      const collapsed = !!intentCollapsed[intent.id];

      const tagsHtml = descriptions.map((description, descIndex) => `
        <span class="ai-tag">
          <span class="ai-tag-text" title="${escapeHtml(description)}">${escapeHtml(description)}</span>
          <span class="ai-tag-remove" onclick="event.stopPropagation();window.removeIntentDesc(${intentIndex}, ${descIndex})">×</span>
        </span>
      `).join('');

      const repliesHtml = replies.map((reply, replyIndex) => `
        <div class="ai-reply-item">
          <span class="ai-reply-index">${replyIndex + 1}</span>
          <span class="ai-reply-text" contenteditable="true"
            onblur="window.updateIntentReply(${intentIndex}, ${replyIndex}, this.textContent)"
          >${escapeHtml(reply)}</span>
          <span class="ai-reply-remove" onclick="window.removeIntentReply(${intentIndex}, ${replyIndex})">×</span>
        </div>
      `).join('');

      return `
        <div class="ai-intent-card ${collapsed ? 'collapsed' : ''}" data-intent-id="${escapeHtml(intent.id)}">
          <div class="ai-intent-header" onclick="window.toggleIntentCollapse('${escapeHtml(intent.id)}')">
            <span class="intent-collapse-icon">▼</span>
            <input type="text" class="intent-name" value="${escapeHtml(intent.name)}" placeholder="意图名称"
              onclick="event.stopPropagation()"
              onchange="window.aiConfig.intents[${intentIndex}].name=this.value">
            <span class="intent-count">${descriptions.length} 条描述 · ${replies.length} 条话术</span>
            <label class="fb-switch" onclick="event.stopPropagation()">
              <input type="checkbox" ${intent.enabled ? 'checked' : ''}
                onchange="window.aiConfig.intents[${intentIndex}].enabled=this.checked">
              <span class="fb-switch-track"></span>
            </label>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();window.removeAIIntent(${intentIndex})">删除</button>
          </div>
          <div class="ai-intent-body">
            <div class="ai-intent-field">
              <div class="ai-intent-label">描述语句 <span style="color:#ccc">— 客户可能的说法，用于语义匹配</span></div>
              <div class="ai-tag-list">${tagsHtml}</div>
              <div class="ai-tag-input-wrap">
                <input type="text" placeholder="输入描述语句后按 Enter 添加"
                  onkeydown="if(event.key==='Enter'){event.preventDefault();window.addIntentDesc(${intentIndex}, this)}">
              </div>
            </div>
            <div class="ai-intent-field">
              <div class="ai-intent-label">回复话术 <span style="color:#ccc">— 命中时随机选取一条回复</span></div>
              <div class="ai-reply-list">${repliesHtml}</div>
              <div class="ai-reply-add-wrap">
                <input type="text" placeholder="输入回复话术后按 Enter 添加"
                  onkeydown="if(event.key==='Enter'){event.preventDefault();window.addIntentReply(${intentIndex}, this)}">
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async function loadAIConfig() {
    const nextConfig = await window.pddApi.aiGetConfig();
    const status = await window.pddApi.aiGetStatus();
    const aiConfig = setAiConfig(nextConfig);

    const enabled = getEl('aiEnabled');
    const threshold = getEl('aiThreshold');
    const thresholdVal = getEl('aiThresholdVal');
    const modelSource = getEl('aiModelSource');
    const customMirror = getEl('aiCustomMirror');
    const statusTag = getEl('aiStatusTag');

    if (enabled) enabled.checked = !!aiConfig.enabled;
    if (threshold) threshold.value = aiConfig.threshold || 0.65;
    if (thresholdVal) thresholdVal.textContent = aiConfig.threshold || 0.65;
    if (modelSource) modelSource.value = aiConfig.modelSource || 'mirror';
    if (customMirror) customMirror.value = aiConfig.customMirror || '';

    updateModelSourceUI();

    if (status?.hasCache && status.status === 'none') {
      updateAIStatusUI('none');
      if (statusTag) {
        statusTag.textContent = '已缓存（未加载）';
      }
    } else {
      updateAIStatusUI(status?.status || 'none');
    }

    renderAIIntents();
  }

  async function checkSystem() {
    const el = getEl('aiSysInfo');
    if (!el) return;
    el.innerHTML = '<span style="color:#888">正在检测系统配置...</span>';

    const info = await window.pddApi.aiGetSystemInfo();
    const recColors = { good: '#2e7d32', fair: '#d48806', poor: '#e02e24' };
    const recLabels = { good: '适合运行', fair: '勉强可用', poor: '不建议使用' };
    const recBg = { good: '#f0faf0', fair: '#fffbe6', poor: '#fef0f0' };
    const recBorder = { good: '#b7eb8f', fair: '#ffe58f', poor: '#ffccc7' };
    const issues = Array.isArray(info?.issues) ? info.issues : [];

    let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin-bottom:10px">';
    html += `<div><span style="color:#888">CPU：</span>${escapeHtml(info?.cpu?.model)}</div>`;
    html += `<div><span style="color:#888">核心数：</span>${escapeHtml(info?.cpu?.cores)} 核</div>`;
    html += `<div><span style="color:#888">总内存：</span>${escapeHtml(info?.memory?.total)} GB</div>`;
    html += `<div><span style="color:#888">可用内存：</span>${escapeHtml(info?.memory?.free)} GB</div>`;
    if (info?.disk) {
      html += `<div><span style="color:#888">可用磁盘：</span>${escapeHtml(info.disk.free)} GB</div>`;
    }
    html += `<div><span style="color:#888">系统：</span>${escapeHtml(info?.platform)} (${escapeHtml(info?.arch)})</div>`;
    html += '</div>';

    const recommendation = info?.recommendation || 'fair';
    html += `<div style="padding:8px 12px;background:${recBg[recommendation]};border:1px solid ${recBorder[recommendation]};border-radius:6px">`;
    html += `<strong style="color:${recColors[recommendation]}">评估结果：${recLabels[recommendation]}</strong>`;
    html += '<ul style="margin:6px 0 0 16px;font-size:12px;color:#555">';
    issues.forEach(issue => {
      html += `<li>${escapeHtml(issue)}</li>`;
    });
    html += '</ul></div>';

    el.innerHTML = html;
  }

  function toggleIntentCollapse(intentId) {
    intentCollapsed[intentId] = !intentCollapsed[intentId];
    const card = document.querySelector(`.ai-intent-card[data-intent-id="${CSS.escape(intentId)}"]`);
    if (card) {
      card.classList.toggle('collapsed');
    }
  }

  function addIntentDesc(index, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;
    const aiConfig = getAiConfig();
    if (!Array.isArray(aiConfig.intents[index]?.descriptions)) {
      aiConfig.intents[index].descriptions = [];
    }
    aiConfig.intents[index].descriptions.push(value);
    inputEl.value = '';
    renderAIIntents();
  }

  function removeIntentDesc(index, descIndex) {
    const aiConfig = getAiConfig();
    aiConfig.intents[index].descriptions.splice(descIndex, 1);
    renderAIIntents();
  }

  function addIntentReply(index, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;
    const aiConfig = getAiConfig();
    if (!Array.isArray(aiConfig.intents[index]?.replies)) {
      aiConfig.intents[index].replies = [];
    }
    aiConfig.intents[index].replies.push(value);
    inputEl.value = '';
    renderAIIntents();
  }

  function removeIntentReply(index, replyIndex) {
    const aiConfig = getAiConfig();
    aiConfig.intents[index].replies.splice(replyIndex, 1);
    renderAIIntents();
  }

  function updateIntentReply(index, replyIndex, nextText) {
    const value = nextText.trim();
    const aiConfig = getAiConfig();
    if (value) {
      aiConfig.intents[index].replies[replyIndex] = value;
      return;
    }
    aiConfig.intents[index].replies.splice(replyIndex, 1);
    renderAIIntents();
  }

  function removeAIIntent(index) {
    const aiConfig = getAiConfig();
    if (!confirm(`确定删除意图「${aiConfig.intents[index].name}」吗？`)) return;
    aiConfig.intents.splice(index, 1);
    renderAIIntents();
  }

  async function resetIntents() {
    if (!confirm('确定要恢复为系统默认意图配置吗？当前自定义的意图将被覆盖。')) return;
    const intents = await window.pddApi.aiResetIntents();
    getAiConfig().intents = Array.isArray(intents) ? intents : [];
    renderAIIntents();
    showToast('已恢复为默认意图配置');
  }

  function addIntent() {
    getAiConfig().intents.push({
      id: `intent_${Date.now().toString(36)}`,
      name: '新意图',
      enabled: true,
      descriptions: [],
      replies: []
    });
    renderAIIntents();
  }

  async function handleAiEnabledChange(event) {
    getAiConfig().enabled = event.target.checked;
    await window.pddApi.aiSetEnabled(event.target.checked);
  }

  async function selectLocalModel() {
    const result = await window.pddApi.aiSelectLocalModel();
    if (result?.canceled || !result?.path) return;
    const localPath = getEl('aiLocalPath');
    if (localPath) {
      localPath.value = result.path;
    }
  }

  async function downloadModel() {
    const source = getEl('aiModelSource')?.value || 'mirror';
    const customMirror = getEl('aiCustomMirror')?.value.trim() || '';
    const localPath = getEl('aiLocalPath')?.value.trim() || '';
    const progressFill = getEl('aiProgressFill');
    const progressText = getEl('aiProgressText');

    if (source === 'local' && !localPath) {
      showToast('请先选择本地模型文件夹');
      return;
    }

    updateAIStatusUI('downloading');
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) {
      progressText.textContent = source === 'local' ? '正在加载本地模型...' : '正在下载模型文件...';
    }

    const result = await window.pddApi.aiDownloadModel({ source, customMirror, localPath });
    if (result?.error) {
      updateAIStatusUI('error');
      if (progressText) {
        progressText.textContent = `${source === 'local' ? '加载失败: ' : '下载失败: '}${result.error}`;
      }
      return;
    }

    updateAIStatusUI('ready');
  }

  async function unloadModel() {
    await window.pddApi.aiUnloadModel();
    getAiConfig().enabled = false;
    updateAIStatusUI('none');
  }

  async function saveAIConfig() {
    const aiConfig = getAiConfig();
    aiConfig.threshold = parseFloat(getEl('aiThreshold')?.value || aiConfig.threshold || 0.65);
    aiConfig.modelSource = getEl('aiModelSource')?.value || 'mirror';
    aiConfig.customMirror = getEl('aiCustomMirror')?.value.trim() || '';
    await window.pddApi.aiSaveConfig(aiConfig);
    showToast('AI 配置已保存');
  }

  async function testAiMatch() {
    const message = getEl('aiTestInput')?.value.trim();
    if (!message) return;

    const resultEl = getEl('aiTestResult');
    if (!resultEl) return;
    resultEl.className = 'ai-test-result show miss';
    resultEl.innerHTML = '<span style="color:#888">正在推理中...</span>';

    const aiResult = await window.pddApi.aiTestMatch(message);
    const keywordResult = await window.pddApi.testRule(message);

    if (aiResult?.error) {
      resultEl.className = 'ai-test-result show miss';
      resultEl.innerHTML = `<strong style="color:#e02e24">AI 错误:</strong> ${escapeHtml(aiResult.error)}`;
      return;
    }

    let html = '<div style="margin-bottom:10px"><strong>关键词匹配:</strong> ';
    if (keywordResult?.matched) {
      html += `<span style="color:#2e7d32">命中「${escapeHtml(keywordResult.ruleName)}」得分 ${keywordResult.score}</span>`;
    } else {
      html += '<span style="color:#999">未命中</span>';
    }
    html += '</div>';

    html += '<div style="margin-bottom:8px"><strong>AI 意图识别:</strong> ';
    if (aiResult?.matched && aiResult.bestMatch) {
      html += `<span style="color:#2e7d32">命中「${escapeHtml(aiResult.bestMatch.intentName)}」 相似度 ${aiResult.bestMatch.similarity}</span>`;
      if (aiResult.bestMatch.reply) {
        html += `<div style="margin-top:4px;padding:6px 10px;background:#f0faf0;border-radius:4px;font-size:12px">回复: ${escapeHtml(aiResult.bestMatch.reply)}</div>`;
      }
    } else {
      html += `<span style="color:#999">未命中（低于阈值 ${aiResult?.threshold}）</span>`;
    }
    html += '</div>';

    if (Array.isArray(aiResult?.ranking) && aiResult.ranking.length) {
      html += '<table class="ai-ranking-table"><thead><tr><th>意图</th><th>相似度</th><th></th></tr></thead><tbody>';
      aiResult.ranking.forEach(item => {
        const pct = Math.round(item.similarity * 100);
        const cls = item.similarity >= (aiResult.threshold || 0.65)
          ? 'high'
          : item.similarity >= 0.4
            ? 'medium'
            : 'low';
        html += `<tr><td>${escapeHtml(item.intentName)}</td><td>${item.similarity}</td><td><span class="ai-sim-bar ${cls}" style="width:${pct}px"></span></td></tr>`;
      });
      html += '</tbody></table>';
    }

    resultEl.className = `ai-test-result show ${aiResult?.matched ? 'hit' : 'miss'}`;
    resultEl.innerHTML = html;
  }

  function subscribeProgress() {
    if (progressSubscribed) return;
    progressSubscribed = true;
    window.pddApi.onAiDownloadProgress(data => {
      if (data?.status === 'downloading') {
        const progressFill = getEl('aiProgressFill');
        const progressText = getEl('aiProgressText');
        if (progressFill) progressFill.style.width = `${data.progress}%`;
        if (progressText) {
          progressText.textContent = `下载中... ${data.progress}%${data.file ? ` (${data.file})` : ''}`;
        }
        return;
      }

      if (data?.status === 'ready') {
        const progressFill = getEl('aiProgressFill');
        const progressText = getEl('aiProgressText');
        if (progressFill) progressFill.style.width = '100%';
        if (progressText) progressText.textContent = '模型加载完成';
      }
    });
  }

  function bindAIEvents() {
    if (initialized) return;
    initialized = true;

    document.querySelectorAll('.ai-sub-tab').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.ai-sub-tab').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.ai-sub-content').forEach(content => content.classList.remove('active'));
        button.classList.add('active');
        const tabId = {
          model: 'aiTabModel',
          intents: 'aiTabIntents',
          test: 'aiTabTest'
        }[button.dataset.aitab];
        const target = tabId ? getEl(tabId) : null;
        if (target) {
          target.classList.add('active');
        }
      });
    });

    getEl('btnCheckSystem')?.addEventListener('click', checkSystem);
    getEl('aiModelSource')?.addEventListener('change', updateModelSourceUI);
    getEl('btnResetIntents')?.addEventListener('click', resetIntents);
    getEl('btnAddIntent')?.addEventListener('click', addIntent);
    getEl('aiThreshold')?.addEventListener('input', event => {
      const value = parseFloat(event.target.value);
      const thresholdVal = getEl('aiThresholdVal');
      if (thresholdVal) {
        thresholdVal.textContent = value.toFixed(2);
      }
      getAiConfig().threshold = value;
    });
    getEl('aiEnabled')?.addEventListener('change', handleAiEnabledChange);
    getEl('btnSelectLocalModel')?.addEventListener('click', selectLocalModel);
    getEl('btnDownloadModel')?.addEventListener('click', downloadModel);
    getEl('btnUnloadModel')?.addEventListener('click', unloadModel);
    getEl('btnSaveAI')?.addEventListener('click', saveAIConfig);
    getEl('btnAiTest')?.addEventListener('click', testAiMatch);
    getEl('aiTestInput')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        testAiMatch();
      }
    });

    subscribeProgress();
  }

  window.loadAIConfig = loadAIConfig;
  window.updateModelSourceUI = updateModelSourceUI;
  window.updateAIStatusUI = updateAIStatusUI;
  window.renderAIIntents = renderAIIntents;
  window.toggleIntentCollapse = toggleIntentCollapse;
  window.addIntentDesc = addIntentDesc;
  window.removeIntentDesc = removeIntentDesc;
  window.addIntentReply = addIntentReply;
  window.removeIntentReply = removeIntentReply;
  window.updateIntentReply = updateIntentReply;
  window.removeAIIntent = removeAIIntent;
  window.aiConfig = window.aiConfig || defaultAiConfig();

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('ai-module', bindAIEvents);
  } else {
    bindAIEvents();
  }
})();
