(function () {
  let initialized = false;
  let rules = [];
  let selectedQAIds = new Set();
  let editingQAId = null;
  let fbConfig = {};
  let plSystem = [];
  let plCustom = [];
  let plCategories = [];
  let plCurrentTab = 'system';
  let plFiltered = [];
  let umLog = [];

  function getEl(id) {
    return document.getElementById(id);
  }

  function qaToast(message) {
    const el = getEl('toastMsg');
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
  }

  function sanitizeRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    const { name, ...rest } = rule;
    return rest;
  }

  function sanitizeRules(input) {
    const arr = Array.isArray(input) ? input : [];
    return arr.map(sanitizeRule).filter(Boolean);
  }

  function collectReplySegments(reply) {
    if (Array.isArray(reply)) {
      return reply
        .flatMap(item => collectReplySegments(item))
        .filter(Boolean);
    }

    const text = String(reply || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];

    return text
      .split(/\n\s*---\s*\n/g)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function formatReplyForEditor(reply) {
    return collectReplySegments(reply).join('\n\n---\n\n');
  }

  function renderQAReplySplitPreview(reply) {
    const previewEl = getEl('qaReplySplitPreview');
    if (!previewEl) return;

    const rawText = String(reply || '').trim();
    if (!rawText) {
      previewEl.classList.remove('show');
      previewEl.innerHTML = '';
      return;
    }

    const segments = collectReplySegments(reply);
    const summary = segments.length > 1
      ? `预览拆分结果：当前会识别为 ${segments.length} 段回复，命中后随机发送其中一条。`
      : '预览拆分结果：当前仅识别为 1 段回复；如需随机回复，请点击“插入分栏”后再填写下一段内容。';

    previewEl.innerHTML = `
      <div class="qa-reply-preview-title">${summary}</div>
      <div class="qa-reply-preview-list">
        ${segments.map((segment, index) => `
          <div class="qa-reply-preview-item">
            <div class="qa-reply-preview-label">回复 ${index + 1}</div>
            <div class="qa-reply-preview-text">${esc(segment)}</div>
          </div>
        `).join('')}
      </div>
    `;
    previewEl.classList.add('show');
  }

  async function persistRules(nextRules) {
    rules = sanitizeRules(nextRules);
    await window.pddApi.saveRules(rules);
  }

  async function loadRules() {
    rules = sanitizeRules(await window.pddApi.getRules());
    shops = await window.pddApi.getShops();
    renderRules();
  }

  function renderRules() {
    const tbody = getEl('qaTableBody');
    const empty = getEl('qaEmpty');

    if (rules.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    const matchTypeMap = { contains: '包含关键词', exact: '完全匹配', regex: '正则匹配' };
    tbody.innerHTML = rules.map((rule, index) => {
      const kwSummary = (rule.keywords || []).slice(0, 3).join('、') + (rule.keywords?.length > 3 ? '...' : '');
      const replyText = formatReplyForEditor(rule.reply);
      const replySummary = replyText.slice(0, 20) + (replyText.length > 20 ? '...' : '');
      const shopNames = rule.shops && rule.shops.length
        ? rule.shops.map(shopId => shops.find(shop => shop.id === shopId)?.name || shopId).join('、')
        : '全部';
      return `<tr>
        <td><input type="checkbox" data-id="${rule.id}" class="qa-check" ${selectedQAIds.has(rule.id) ? 'checked' : ''}></td>
        <td>${index + 1}</td>
        <td title="${esc((rule.keywords || []).join('、'))}">${esc(kwSummary)}</td>
        <td title="${esc(replyText)}">${esc(replySummary)}</td>
        <td>${matchTypeMap[rule.matchType] || rule.matchType}</td>
        <td title="${esc(shopNames)}">${esc(shopNames)}</td>
        <td>${rule.priority || 0}</td>
        <td><span class="status-tag ${rule.enabled ? 'enabled' : 'disabled'}">${rule.enabled ? '启用' : '禁用'}</span></td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="openQAModal('${rule.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="deleteRule('${rule.id}')">删除</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.qa-check').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedQAIds.add(checkbox.dataset.id);
        else selectedQAIds.delete(checkbox.dataset.id);
      });
    });
  }

  function openQAModal(ruleId) {
    editingQAId = ruleId || null;
    const rule = ruleId ? rules.find(item => item.id === ruleId) : null;

    getEl('qaModalTitle').textContent = rule ? '编辑QA场景' : '添加QA场景';
    getEl('qaMatchType').value = rule?.matchType || 'contains';
    if (rule?.requireAllGroups && rule.keywordGroups?.length) {
      getEl('qaKeywords').value = rule.keywordGroups
        .filter(group => group?.length)
        .map(group => group.join('\n'))
        .join('\n&\n');
    } else if (rule?.keywordGroups?.length) {
      getEl('qaKeywords').value = rule.keywordGroups.flat().join('\n');
    } else {
      getEl('qaKeywords').value = (rule?.keywords || []).join('\n');
    }
    getEl('qaReply').value = formatReplyForEditor(rule?.reply);
    renderQAReplySplitPreview(getEl('qaReply').value);
    getEl('qaPriority').value = rule?.priority ?? 50;
    getEl('qaEnabled').value = rule ? String(rule.enabled) : 'true';
    getEl('qaProducts').value = (rule?.products || []).join(', ');

    const shopSelectEl = getEl('qaShopSelect');
    const shopAllEl = getEl('qaShopSelectAll');
    const shopCategoryEl = getEl('qaShopCategory');
    const selectedShops = new Set(rule?.shops || []);
    const isAll = !rule?.shops || rule.shops.length === 0;
    shopAllEl.checked = isAll;
    if (shopCategoryEl) shopCategoryEl.value = '';
    shopSelectEl.innerHTML = shops.map(shop => {
      const checked = isAll || selectedShops.has(shop.id);
      return `
        <label class="qa-shop-item">
          <input type="checkbox" class="qa-shop-check" value="${shop.id}" ${checked ? 'checked' : ''}>
          <span class="qa-shop-name">${esc(shop.name)}</span>
        </label>
      `;
    }).join('');

    const shopMap = new Map((shops || []).map(shop => [shop.id, shop]));
    const shopChecks = [...shopSelectEl.querySelectorAll('input.qa-shop-check')];
    shopAllEl.onchange = () => {
      if (shopCategoryEl) shopCategoryEl.value = '';
      shopChecks.forEach(chk => { chk.checked = shopAllEl.checked; });
    };
    shopChecks.forEach(chk => {
      chk.addEventListener('change', () => {
        const allChecked = shopChecks.length > 0 && shopChecks.every(item => item.checked);
        shopAllEl.checked = allChecked;
      });
    });

    if (shopCategoryEl) {
      shopCategoryEl.onchange = () => {
        const category = String(shopCategoryEl.value || '').trim();
        if (!category) return;
        shopAllEl.checked = false;
        let matchedCount = 0;
        shopChecks.forEach(chk => {
          const shop = shopMap.get(chk.value);
          const hit = String(shop?.category || '').trim() === category;
          chk.checked = hit;
          if (hit) matchedCount += 1;
        });
        if (matchedCount === 0) qaToast('该类目下暂无店铺');
      };
    }

    showModal('modalQA');
  }

  async function saveQA() {
    const lines = getEl('qaKeywords').value.split('\n').map(keyword => keyword.trim()).filter(Boolean);
    const keywordGroups = [];
    let current = [];
    let hasAnd = false;
    for (const line of lines) {
      if (line === '&' || line === '＆') {
        hasAnd = true;
        keywordGroups.push(current);
        current = [];
        continue;
      }
      current.push(line);
    }
    keywordGroups.push(current);

    const hasEmptyGroup = hasAnd && keywordGroups.some(group => group.length === 0);
    if (hasEmptyGroup) return alert('使用 & 组词时，& 前后都需要关键词');

    const cleanedGroups = keywordGroups.filter(group => group.length > 0);
    const keywords = cleanedGroups.flat();
    if (keywords.length === 0) return alert('请至少输入一个关键词');

    const reply = getEl('qaReply').value.trim();
    if (!reply) return alert('请输入回复内容');

    const shopAllEl = getEl('qaShopSelectAll');
    const selectedShops = shopAllEl.checked
      ? []
      : [...document.querySelectorAll('#qaShopSelect input.qa-shop-check:checked')].map(checkbox => checkbox.value);
    if (!shopAllEl.checked && selectedShops.length === 0) return alert('请至少选择一个店铺或勾选应用到全部店铺');
    const productsStr = getEl('qaProducts').value.trim();
    const products = productsStr ? productsStr.split(/[,，]/).map(product => product.trim()).filter(Boolean) : [];

    const ruleData = {
      id: editingQAId || Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      enabled: getEl('qaEnabled').value === 'true',
      keywords,
      keywordGroups: cleanedGroups.length > 0 ? cleanedGroups : null,
      requireAllGroups: hasAnd && cleanedGroups.length > 1 ? true : undefined,
      matchType: getEl('qaMatchType').value,
      reply,
      shops: selectedShops.length > 0 ? selectedShops : null,
      products: products.length > 0 ? products : null,
      priority: parseInt(getEl('qaPriority').value, 10) || 50
    };

    if (editingQAId) {
      const index = rules.findIndex(item => item.id === editingQAId);
      if (index >= 0) rules[index] = ruleData;
    } else {
      rules.push(ruleData);
    }

    await persistRules(rules);
    hideModal('modalQA');
    renderRules();
  }

  async function deleteRule(ruleId) {
    if (!confirm('确定删除此规则？')) return;
    rules = rules.filter(rule => rule.id !== ruleId);
    await persistRules(rules);
    renderRules();
  }

  async function batchDeleteQA() {
    if (selectedQAIds.size === 0) return alert('请先选择规则');
    if (!confirm(`确定删除 ${selectedQAIds.size} 条规则？`)) return;
    rules = rules.filter(rule => !selectedQAIds.has(rule.id));
    await persistRules(rules);
    selectedQAIds.clear();
    renderRules();
  }

  function getShopIdsByCategory(category) {
    const cat = String(category || '').trim();
    if (!cat || cat === '__all__') return null;
    return (shops || [])
      .filter(shop => String(shop?.category || '').trim() === cat)
      .map(shop => shop.id);
  }

  async function applyShopCategoryToSelectedQA(category) {
    if (selectedQAIds.size === 0) return alert('请先勾选要修改的规则');
    const shopIds = getShopIdsByCategory(category);
    if (Array.isArray(shopIds) && shopIds.length === 0) return alert('该类目下暂无店铺');

    rules = rules.map(rule => {
      if (!selectedQAIds.has(rule.id)) return rule;
      return { ...rule, shops: shopIds && shopIds.length > 0 ? shopIds : null };
    });
    await persistRules(rules);
    renderRules();
    qaToast('已更新适用店铺');
  }

  function openApplyShopCategoryModal() {
    if (selectedQAIds.size === 0) return alert('请先勾选要修改的规则');
    const selectEl = getEl('qaApplyShopCategoryModal');
    if (selectEl) selectEl.value = '__all__';
    showModal('modalApplyShopCategory');
  }

  async function confirmApplyShopCategoryModal() {
    const category = getEl('qaApplyShopCategoryModal')?.value;
    await applyShopCategoryToSelectedQA(category);
    hideModal('modalApplyShopCategory');
  }

  function importQA() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async event => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const imported = JSON.parse(await file.text());
        if (Array.isArray(imported)) {
          await persistRules(imported);
          renderRules();
        }
      } catch {
        alert('导入失败：文件格式不正确');
      }
    };
    input.click();
  }

  function exportQA() {
    const exported = sanitizeRules(rules);
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'pdd-qa-rules.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function resetQA() {
    if (!confirm('确定恢复默认规则？当前规则将被覆盖。')) return;
    rules = sanitizeRules(await window.pddApi.resetRules());
    selectedQAIds.clear();
    renderRules();
    qaToast('已恢复默认规则');
  }

  async function runRuleTest() {
    const message = getEl('testMessage').value.trim();
    if (!message) return;
    const result = await window.pddApi.testRule(message);
    const el = getEl('testResult');
    if (result.matched) {
      el.innerHTML = `<div class="test-result matched">
        <strong>匹配成功!</strong><br>
        规则: ${esc(result.ruleName)}<br>
        回复: ${esc(result.reply)}
      </div>`;
      return;
    }
    el.innerHTML = '<div class="test-result no-match">未匹配到任何规则</div>';
  }

  async function loadFallbackConfig() {
    fbConfig = await window.pddApi.getDefaultReply() || {};
    if (!fbConfig.texts && fbConfig.text) fbConfig.texts = [fbConfig.text];
    if (!fbConfig.texts) fbConfig.texts = [];
    if (!fbConfig.scenes) fbConfig.scenes = [];
    if (fbConfig.cooldown === undefined) fbConfig.cooldown = 60000;
    if (!fbConfig.strategy) fbConfig.strategy = 'random';
    if (fbConfig.cancelOnHumanReply === undefined) fbConfig.cancelOnHumanReply = true;
    window.fbConfig = fbConfig;

    getEl('fbEnabled').checked = fbConfig.enabled !== false;
    getEl('fbDelay').value = (fbConfig.delay || 2000) / 1000;
    getEl('fbCooldown').value = (fbConfig.cooldown || 60000) / 1000;
    getEl('fbStrategy').value = fbConfig.strategy || 'random';
    getEl('fbCancelOnHuman').checked = fbConfig.cancelOnHumanReply !== false;
    renderFBTexts();
    renderFBScenes();
  }

  function renderFBTexts() {
    const container = getEl('fbTextList');
    const texts = fbConfig.texts || [];
    if (texts.length === 0) {
      container.innerHTML = '<div style="color:#ccc;font-size:13px;padding:6px 0;">暂无话术，请添加</div>';
      return;
    }
    container.innerHTML = texts.map((text, index) => `
      <div class="fb-text-item">
        <span class="fb-text-num">${index + 1}</span>
        <textarea rows="1" onchange="window.fbConfig.texts[${index}]=this.value">${esc(text)}</textarea>
        <button class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:11px" onclick="window.fbConfig.texts.splice(${index},1);window.renderFBTexts()">×</button>
      </div>
    `).join('');
  }

  function renderFBScenes() {
    const container = getEl('fbSceneList');
    const scenes = fbConfig.scenes || [];
    if (scenes.length === 0) {
      container.innerHTML = '<div style="color:#ccc;font-size:13px;padding:6px 0;">暂无场景分类</div>';
      return;
    }
    container.innerHTML = scenes.map((scene, sceneIndex) => {
      const repliesHtml = (scene.replies || []).map((reply, replyIndex) => `
        <div class="fb-text-item">
          <textarea rows="1" onchange="window.fbConfig.scenes[${sceneIndex}].replies[${replyIndex}]=this.value">${esc(reply)}</textarea>
          ${scene.replies.length > 1 ? `<button class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:11px" onclick="window.fbConfig.scenes[${sceneIndex}].replies.splice(${replyIndex},1);window.renderFBScenes()">×</button>` : ''}
        </div>
      `).join('');

      return `
        <div class="fb-scene-card">
          <div class="fb-scene-header">
            <input type="text" value="${esc(scene.name)}" placeholder="场景名称" onchange="window.fbConfig.scenes[${sceneIndex}].name=this.value">
            <span style="font-size:12px;color:#888;">优先级</span>
            <input type="number" value="${scene.priority || 0}" onchange="window.fbConfig.scenes[${sceneIndex}].priority=parseInt(this.value, 10)||0">
            <label class="fb-switch">
              <input type="checkbox" ${scene.enabled !== false ? 'checked' : ''} onchange="window.fbConfig.scenes[${sceneIndex}].enabled=this.checked">
              <span class="fb-switch-track"></span>
            </label>
            <button class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:11px" onclick="removeFBScene(${sceneIndex})">删除</button>
          </div>
          <div class="fb-scene-field">
            <div class="fb-scene-label">触发词（逗号分隔）</div>
            <textarea rows="1" onchange="window.fbConfig.scenes[${sceneIndex}].signals=this.value.split(',').map(s=>s.trim()).filter(Boolean)">${(scene.signals || []).join(', ')}</textarea>
          </div>
          <div class="fb-scene-field">
            <div class="fb-scene-label">场景话术</div>
            ${repliesHtml}
            <button class="fb-add-btn" onclick="window.fbConfig.scenes[${sceneIndex}].replies.push('');window.renderFBScenes()">+ 添加话术</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function removeFBScene(index) {
    if (!confirm('确定删除此场景？')) return;
    fbConfig.scenes.splice(index, 1);
    renderFBScenes();
  }

  async function saveFallback() {
    const config = {
      enabled: getEl('fbEnabled').checked,
      texts: fbConfig.texts.filter(text => text.trim()),
      delay: Math.round(parseFloat(getEl('fbDelay').value || '2') * 1000),
      cooldown: Math.round(parseFloat(getEl('fbCooldown').value || '60') * 1000),
      strategy: getEl('fbStrategy').value,
      cancelOnHumanReply: getEl('fbCancelOnHuman').checked,
      scenes: fbConfig.scenes
    };
    await window.pddApi.saveDefaultReply(config);
    fbConfig = config;
    window.fbConfig = fbConfig;
    qaToast('兜底设置已保存');
  }

  async function loadPhraseLibrary() {
    plSystem = await window.pddApi.getSystemPhrases();
    plCustom = await window.pddApi.getPhraseLibrary();
    plCategories = await window.pddApi.getPhraseCategories();

    const categoryOptions = '<option value="">全部分类</option>' + plCategories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
    getEl('plCategory').innerHTML = categoryOptions;
    getEl('plNewCat').innerHTML = plCategories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
    renderPL();
  }

  function renderPL() {
    const category = getEl('plCategory').value;
    const search = getEl('plSearch').value.trim().toLowerCase();
    const source = plCurrentTab === 'system' ? plSystem : plCustom;
    const containerId = plCurrentTab === 'system' ? 'plSystemList' : 'plCustomList';
    let filtered = source;
    if (category) filtered = filtered.filter(item => item.category === category);
    if (search) filtered = filtered.filter(item => item.text.toLowerCase().includes(search));
    plFiltered = filtered;

    const container = getEl(containerId);
    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:20px">无匹配话术</div>';
      return;
    }
    container.innerHTML = filtered.map((phrase, index) => `
      <div class="pl-item">
        <span class="pl-cat-tag">${esc(phrase.category)}</span>
        <span class="pl-text">${esc(phrase.text)}</span>
        <div class="pl-actions">
          <button class="btn btn-sm" style="padding:2px 8px;font-size:11px;background:#f0f0f0" onclick="plCopy(${index})">复制</button>
          <button class="btn btn-sm" style="padding:2px 8px;font-size:11px;background:#fff1f0;color:#e02e24" onclick="plUseFallback(${index})">引用到兜底</button>
          ${plCurrentTab === 'custom' ? `<button class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:11px" onclick="plDelete(${index})">删除</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  function plCopy(index) {
    const text = plFiltered[index]?.text;
    if (text) navigator.clipboard.writeText(text).then(() => qaToast('已复制'));
  }

  async function plUseFallback(index) {
    const text = plFiltered[index]?.text;
    if (!text) return;
    await window.pddApi.addPhraseToFallback(text);
    if (!fbConfig.texts) fbConfig.texts = [];
    if (!fbConfig.texts.includes(text)) fbConfig.texts.push(text);
    window.fbConfig = fbConfig;
    qaToast('已添加到通用兜底话术');
  }

  async function plDelete(index) {
    const phrase = plFiltered[index];
    if (!phrase) return;
    const realIndex = plCustom.findIndex(item => item.id === phrase.id);
    if (realIndex >= 0) {
      plCustom.splice(realIndex, 1);
      await window.pddApi.savePhraseLibrary(plCustom);
      renderPL();
    }
  }

  async function addCustomPhrase() {
    const text = getEl('plNewText').value.trim();
    const category = getEl('plNewCat').value;
    if (!text) return;
    plCustom.push({ id: 'cp_' + Date.now().toString(36), text, category });
    await window.pddApi.savePhraseLibrary(plCustom);
    getEl('plNewText').value = '';
    renderPL();
    qaToast('自定义话术已添加');
  }

  async function loadUnmatchedLog() {
    umLog = await window.pddApi.getUnmatchedLog();
    renderUM();
  }

  function renderUM() {
    const list = getEl('umList');
    const emptyEl = getEl('umEmpty');

    if (umLog.length === 0) {
      list.innerHTML = '';
      emptyEl.style.display = '';
      getEl('umStats').innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';

    const wordCount = {};
    umLog.forEach(item => {
      item.message.replace(/[，。！？、；：""（）\s]+/g, ' ').split(' ')
        .filter(word => word.length >= 2)
        .forEach(word => {
          wordCount[word] = (wordCount[word] || 0) + 1;
        });
    });
    const topWords = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

    getEl('umStats').innerHTML = `<span class="um-chip">共 <strong>${umLog.length}</strong> 条</span>` +
      topWords.map(([word, count]) => `<span class="um-chip">${esc(word)} <strong>×${count}</strong></span>`).join('');

    function formatDate(timestamp) {
      const date = new Date(timestamp);
      return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    list.innerHTML = umLog.map((item, index) => `
      <div class="um-item">
        <span class="um-time">${formatDate(item.timestamp)}</span>
        <span class="um-customer">${esc(item.customer)}</span>
        <span class="um-msg" title="${esc(item.message)}">${esc(item.message)}</span>
        <button class="btn btn-sm" style="padding:2px 8px;font-size:11px;background:#fff1f0;color:#e02e24" onclick="umCreateRule(${index})">创建规则</button>
      </div>
    `).join('');
  }

  function umCreateRule(index) {
    const item = umLog[index];
    if (!item) return;
    prefillQARuleFromMessage(item);
  }

  function prefillQARuleFromMessage(item = {}) {
    const sourceMessage = String(item.message || '').trim();
    if (!sourceMessage) return false;
    const suggestedKeywords = item.message
      .replace(/[，。！？、；：""（）\s]+/g, ',')
      .split(',')
      .map(segment => segment.trim())
      .filter(segment => segment.length >= 2)
      .slice(0, 5);

    getEl('qaModalTitle').textContent = '添加QA场景';
    getEl('qaMatchType').value = 'contains';
    getEl('qaKeywords').value = suggestedKeywords.join('\n');
    getEl('qaReply').value = '';
    renderQAReplySplitPreview('');
    getEl('qaPriority').value = 50;
    getEl('qaEnabled').value = 'true';
    getEl('qaProducts').value = '';
    editingQAId = null;

    const shopSelectEl = getEl('qaShopSelect');
    const shopAllEl = getEl('qaShopSelectAll');
    const shopCategoryEl = getEl('qaShopCategory');
    if (shopCategoryEl) shopCategoryEl.value = '';
    shopAllEl.checked = true;
    shopSelectEl.innerHTML = shops.map(shop => `
      <label class="qa-shop-item">
        <input type="checkbox" class="qa-shop-check" value="${shop.id}" checked>
        <span class="qa-shop-name">${esc(shop.name)}</span>
      </label>
    `).join('');

    const shopChecks = [...shopSelectEl.querySelectorAll('input.qa-shop-check')];
    shopAllEl.onchange = () => {
      if (shopCategoryEl) shopCategoryEl.value = '';
      shopChecks.forEach(chk => { chk.checked = shopAllEl.checked; });
    };
    shopChecks.forEach(chk => {
      chk.addEventListener('change', () => {
        const allChecked = shopChecks.length > 0 && shopChecks.every(item => item.checked);
        shopAllEl.checked = allChecked;
      });
    });

    if (shopCategoryEl) {
      const shopMap = new Map((shops || []).map(shop => [shop.id, shop]));
      shopCategoryEl.onchange = () => {
        const category = String(shopCategoryEl.value || '').trim();
        if (!category) return;
        shopAllEl.checked = false;
        let matchedCount = 0;
        shopChecks.forEach(chk => {
          const shop = shopMap.get(chk.value);
          const hit = String(shop?.category || '').trim() === category;
          chk.checked = hit;
          if (hit) matchedCount += 1;
        });
        if (matchedCount === 0) qaToast('该类目下暂无店铺');
      };
    }

    showModal('modalQA');
    qaToast('已预填关键词，请补充回复内容');
    return true;
  }

  function findUnmatchedLogIndex(criteria = {}) {
    const customer = String(criteria.customer || '').trim();
    const message = String(criteria.message || '').trim();
    if (customer && message) {
      for (let index = umLog.length - 1; index >= 0; index -= 1) {
        const item = umLog[index];
        if (String(item.customer || '').trim() === customer && String(item.message || '').trim() === message) {
          return index;
        }
      }
    }
    if (customer) {
      for (let index = umLog.length - 1; index >= 0; index -= 1) {
        const item = umLog[index];
        if (String(item.customer || '').trim() === customer) {
          return index;
        }
      }
    }
    if (message) {
      for (let index = umLog.length - 1; index >= 0; index -= 1) {
        const item = umLog[index];
        if (String(item.message || '').trim() === message) {
          return index;
        }
      }
    }
    return -1;
  }

  async function openQAUnmatchedFromContext(criteria = {}) {
    await loadRules();
    const unmatchedButton = document.querySelector('.qa-sub-tab[data-qatab="unmatched"]');
    if (unmatchedButton) {
      switchQATab(unmatchedButton);
    }
    await loadUnmatchedLog();
    const matchedIndex = findUnmatchedLogIndex(criteria);
    if (matchedIndex >= 0) {
      umCreateRule(matchedIndex);
      return { matched: true };
    }
    const prefilled = prefillQARuleFromMessage(criteria);
    if (prefilled) {
      qaToast('未在记录中定位到该条消息，已按当前消息预填规则');
      return { matched: false, prefilled: true };
    }
    return { matched: false, prefilled: false };
  }

  async function clearUM() {
    if (!confirm('确定清空所有未匹配记录？')) return;
    await window.pddApi.clearUnmatchedLog();
    umLog = [];
    renderUM();
    qaToast('记录已清空');
  }

  function switchQATab(button) {
    document.querySelectorAll('.qa-sub-tab').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.qa-sub-content').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    const tabId = { rules: 'qaTabRules', fallback: 'qaTabFallback', phrases: 'qaTabPhrases', unmatched: 'qaTabUnmatched' }[button.dataset.qatab];
    getEl(tabId).classList.add('active');
    if (button.dataset.qatab === 'fallback') loadFallbackConfig();
    if (button.dataset.qatab === 'phrases') loadPhraseLibrary();
    if (button.dataset.qatab === 'unmatched') loadUnmatchedLog();
  }

  function bindQAModule() {
    if (initialized) return;
    initialized = true;

    getEl('qaSelectAll')?.addEventListener('change', event => {
      if (event.target.checked) rules.forEach(rule => selectedQAIds.add(rule.id));
      else selectedQAIds.clear();
      renderRules();
    });

    getEl('btnAddQA')?.addEventListener('click', () => openQAModal(null));
    getEl('btnSaveQA')?.addEventListener('click', saveQA);
    getEl('btnInsertImage')?.addEventListener('click', () => {
      const textarea = getEl('qaReply');
      const pos = textarea.selectionStart;
      const value = textarea.value;
      const insert = '[img:https://example.com/image.jpg]';
      textarea.value = value.slice(0, pos) + insert + value.slice(pos);
      renderQAReplySplitPreview(textarea.value);
      textarea.focus();
      textarea.setSelectionRange(pos + 5, pos + insert.length - 1);
    });
    getEl('btnInsertDivider')?.addEventListener('click', () => {
      const textarea = getEl('qaReply');
      const pos = textarea.selectionStart;
      const value = textarea.value;
      const insert = '\n\n---\n\n';
      textarea.value = value.slice(0, pos) + insert + value.slice(pos);
      renderQAReplySplitPreview(textarea.value);
      textarea.focus();
      textarea.setSelectionRange(pos + insert.length, pos + insert.length);
    });
    getEl('btnInsertVar')?.addEventListener('click', () => {
      const textarea = getEl('qaReply');
      const pos = textarea.selectionStart;
      const value = textarea.value;
      const insert = '{time}';
      textarea.value = value.slice(0, pos) + insert + value.slice(pos);
      renderQAReplySplitPreview(textarea.value);
      textarea.focus();
      textarea.setSelectionRange(pos, pos + insert.length);
    });
    getEl('qaReply')?.addEventListener('input', event => {
      renderQAReplySplitPreview(event.target.value);
    });
    getEl('btnBatchDeleteQA')?.addEventListener('click', batchDeleteQA);
    getEl('btnImportQA')?.addEventListener('click', importQA);
    getEl('btnExportQA')?.addEventListener('click', exportQA);
    getEl('btnResetQA')?.addEventListener('click', resetQA);
    getEl('btnApplyShopCategory')?.addEventListener('click', openApplyShopCategoryModal);
    getEl('btnConfirmApplyShopCategory')?.addEventListener('click', confirmApplyShopCategoryModal);
    getEl('btnTestQA')?.addEventListener('click', () => {
      getEl('testMessage').value = '';
      getEl('testResult').innerHTML = '';
      showModal('modalTest');
    });
    getEl('btnRunTest')?.addEventListener('click', runRuleTest);
    getEl('testMessage')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') getEl('btnRunTest').click();
    });
    document.querySelectorAll('.qa-sub-tab').forEach(button => {
      button.addEventListener('click', () => switchQATab(button));
    });
    getEl('btnAddFBText')?.addEventListener('click', () => {
      fbConfig.texts.push('');
      window.fbConfig = fbConfig;
      renderFBTexts();
      const items = document.querySelectorAll('#fbTextList textarea');
      items[items.length - 1]?.focus();
    });
    getEl('btnAddFBScene')?.addEventListener('click', () => {
      fbConfig.scenes.push({
        id: 'scene_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: '新场景',
        enabled: true,
        signals: [],
        replies: [''],
        priority: 0
      });
      window.fbConfig = fbConfig;
      renderFBScenes();
    });
    getEl('btnSaveFB')?.addEventListener('click', saveFallback);
    document.querySelectorAll('.pl-tab').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.pl-tab').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        plCurrentTab = button.dataset.pltab;
        getEl('plSystemContent').style.display = plCurrentTab === 'system' ? '' : 'none';
        getEl('plCustomContent').style.display = plCurrentTab === 'custom' ? '' : 'none';
        renderPL();
      });
    });
    getEl('plCategory')?.addEventListener('change', renderPL);
    getEl('plSearch')?.addEventListener('input', renderPL);
    getEl('btnAddPL')?.addEventListener('click', addCustomPhrase);
    getEl('btnClearUM')?.addEventListener('click', clearUM);
  }

  window.loadRules = loadRules;
  window.openQAModal = openQAModal;
  window.deleteRule = deleteRule;
  window.qaToast = qaToast;
  window.removeFBScene = removeFBScene;
  window.renderFBTexts = renderFBTexts;
  window.renderFBScenes = renderFBScenes;
  window.plCopy = plCopy;
  window.plUseFallback = plUseFallback;
  window.plDelete = plDelete;
  window.umCreateRule = umCreateRule;
  window.openQAUnmatchedFromContext = openQAUnmatchedFromContext;
  window.fbConfig = fbConfig;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('qa-module', bindQAModule);
  } else {
    bindQAModule();
  }
})();
