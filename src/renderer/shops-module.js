(function () {
  let initialized = false;

  function getRuntime() {
    return window.__shopsModuleAccess || {};
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

  function refreshShopContext(options = {}) {
    return callRuntime('refreshShopContext', options);
  }

  function switchView(view) {
    return callRuntime('switchView', view);
  }

  function showModal(id) {
    return callRuntime('showModal', id);
  }

  function hideModal(id) {
    return callRuntime('hideModal', id);
  }

  function handleAddShopByToken() {
    return callRuntime('handleAddShopByToken');
  }

  function handleAddShopByQR() {
    return callRuntime('handleAddShopByQR');
  }

  function setSelectedShopIds(nextSet) {
    return callRuntime('setSelectedShopIds', nextSet);
  }

  function setActiveGroup(value) {
    return callRuntime('setActiveGroup', value);
  }

  function setShopSearchText(value) {
    return callRuntime('setShopSearchText', value);
  }

  function setRemarkShopId(value) {
    return callRuntime('setRemarkShopId', value);
  }

  function setScannedShops(value) {
    return callRuntime('setScannedShops', value);
  }

  function setShopGroups(value) {
    return callRuntime('setShopGroups', value);
  }

  function setShops(value) {
    return callRuntime('setShops', value);
  }

  function setExamQuestions(value) {
    return callRuntime('setExamQuestions', value);
  }

  function setExamAnswers(value) {
    return callRuntime('setExamAnswers', value);
  }

  async function loadShops() {
    await refreshShopContext({ loadGroups: true });
    renderGroupTabs();
    renderShops();
    updateBalanceTotal();
  }

  function updateBalanceTotal() {
    const shops = getState().shops || [];
    const total = shops.reduce((sum, shop) => sum + (shop.balance || 0), 0);
    const amountEl = document.querySelector('#balanceTotal .amount');
    if (amountEl) amountEl.textContent = `¥${total.toFixed(2)}`;
  }

  function getFilteredShops() {
    const state = getState();
    const shops = state.shops || [];
    const activeGroup = state.activeGroup || 'all';
    const searchText = String(state.shopSearchText || '').toLowerCase();
    return shops.filter(shop => {
      if (activeGroup !== 'all' && shop.group !== activeGroup) return false;
      if (searchText) {
        return String(shop.name || '').toLowerCase().includes(searchText)
          || String(shop.account || '').toLowerCase().includes(searchText)
          || String(shop.tokenFileName || '').toLowerCase().includes(searchText);
      }
      return true;
    });
  }

  function renderGroupTabs() {
    const state = getState();
    const container = document.getElementById('shopGroupTabs');
    if (!container) return;
    const shops = state.shops || [];
    const shopGroups = state.shopGroups || [];
    const activeGroup = state.activeGroup || 'all';
    let html = `<button class="group-tab ${activeGroup === 'all' ? 'active' : ''}" data-group="all">全部分组</button>`;
    shopGroups.forEach(group => {
      const count = shops.filter(shop => shop.group === group.id).length;
      html += `<button class="group-tab ${activeGroup === group.id ? 'active' : ''}" data-group="${group.id}">${esc(group.name)} (${count})</button>`;
    });
    container.innerHTML = html;
    container.querySelectorAll('.group-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        setActiveGroup(tab.dataset.group);
        renderGroupTabs();
        renderShops();
      });
    });
  }

  function renderShops() {
    const state = getState();
    const shops = state.shops || [];
    const shopGroups = state.shopGroups || [];
    const selectedShopIds = state.selectedShopIds || new Set();
    const activeShopId = state.activeShopId || null;
    const filtered = getFilteredShops();
    const tbody = document.getElementById('shopTableBody');
    const empty = document.getElementById('shopEmpty');
    if (!tbody || !empty) return;

    if (!filtered.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = filtered.map((shop, index) => {
      const groupName = shopGroups.find(group => group.id === shop.group)?.name || '未分组';
      const statusMap = { online: '登录成功', offline: '已离线', expired: '已过期' };
      const isActive = shop.id === activeShopId;
      return `<tr>
        <td><input type="checkbox" data-id="${shop.id}" class="shop-check" ${selectedShopIds.has(shop.id) ? 'checked' : ''}></td>
        <td>${index + 1}</td>
        <td>
          <a href="#" class="shop-name-link" data-shop-id="${shop.id}" style="color:${isActive ? '#e02e24' : '#1890ff'};cursor:pointer;text-decoration:none;font-weight:${isActive ? '600' : 'normal'}" title="点击切换到此店铺">${esc(shop.name)}</a>
          ${isActive ? '<span style="font-size:11px;color:#e02e24;margin-left:4px">(当前)</span>' : ''}
        </td>
        <td title="${esc(shop.tokenFileName || '')}">${esc(shop.tokenFileName) || '<span style="color:#ccc">-</span>'}</td>
        <td>${esc(groupName)}</td>
        <td title="${esc(shop.remark)}">${esc(shop.remark) || '<span style="color:#ccc">-</span>'}</td>
        <td>${shop.bindTime}</td>
        <td>${esc(shop.category)}</td>
        <td><span class="status-tag ${shop.status}">${statusMap[shop.status] || shop.status}</span></td>
        <td style="text-align:right;font-weight:500">${(shop.balance || 0).toFixed(2)}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="openRemarkModal('${shop.id}')">备注</button></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.shop-check').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        const next = new Set(getState().selectedShopIds || []);
        if (checkbox.checked) next.add(checkbox.dataset.id);
        else next.delete(checkbox.dataset.id);
        setSelectedShopIds(next);
      });
    });

    tbody.querySelectorAll('.shop-name-link').forEach(link => {
      link.addEventListener('click', async event => {
        event.preventDefault();
        const shopId = link.dataset.shopId;
        if (shopId === getState().activeShopId) {
          await switchView('chat');
          return;
        }
        await window.pddApi.switchShop(shopId);
        await switchView('chat');
      });
    });
  }

  function openRemarkModal(shopId) {
    setRemarkShopId(shopId);
    const shops = getState().shops || [];
    const shop = shops.find(item => item.id === shopId);
    const input = document.getElementById('remarkInput');
    if (input) input.value = shop?.remark || '';
    showModal('modalRemark');
  }

  function openGroupModal() {
    const state = getState();
    const selectedShopIds = state.selectedShopIds || new Set();
    if (selectedShopIds.size === 0) {
      alert('请先选择店铺');
      return;
    }
    const select = document.getElementById('groupSelect');
    if (select) {
      select.innerHTML = (state.shopGroups || []).map(group => `<option value="${group.id}">${esc(group.name)}</option>`).join('');
    }
    const newGroupName = document.getElementById('newGroupName');
    if (newGroupName) newGroupName.value = '';
    showModal('modalGroup');
  }

  async function saveShopGroup() {
    const state = getState();
    let groupId = document.getElementById('groupSelect')?.value || '';
    const newName = document.getElementById('newGroupName')?.value.trim() || '';
    let shopGroups = Array.isArray(state.shopGroups) ? state.shopGroups.slice() : [];
    let shops = Array.isArray(state.shops) ? state.shops.slice() : [];
    const selectedShopIds = state.selectedShopIds || new Set();

    if (newName) {
      groupId = `group_${Date.now()}`;
      shopGroups.push({ id: groupId, name: newName });
      await window.pddApi.saveShopGroups(shopGroups);
      setShopGroups(shopGroups);
    }

    shops = shops.map(shop => (selectedShopIds.has(shop.id) ? { ...shop, group: groupId } : shop));
    await window.pddApi.saveShops(shops);
    setShops(shops);
    setSelectedShopIds(new Set());
    hideModal('modalGroup');
    renderGroupTabs();
    renderShops();
  }

  async function saveRemark() {
    const state = getState();
    const remark = document.getElementById('remarkInput')?.value.trim() || '';
    const shops = Array.isArray(state.shops) ? state.shops.slice() : [];
    const remarkShopId = state.remarkShopId;
    const nextShops = shops.map(shop => (shop.id === remarkShopId ? { ...shop, remark } : shop));
    const changed = nextShops.some((shop, index) => shop !== shops[index]);
    if (changed) {
      await window.pddApi.saveShops(nextShops);
      setShops(nextShops);
      renderShops();
    }
    hideModal('modalRemark');
  }

  async function syncShops() {
    await loadShops();
    addLog('已按 Token 文件同步店铺列表', 'info');
  }

  async function refreshShops() {
    await loadShops();
    addLog('店铺列表已刷新', 'info');
  }

  async function unbindShops() {
    const selectedShopIds = getState().selectedShopIds || new Set();
    if (selectedShopIds.size === 0) {
      alert('请先选择店铺');
      return;
    }
    if (!confirm(`确定解绑 ${selectedShopIds.size} 个店铺？`)) return;
    const shopIds = Array.from(selectedShopIds);
    for (const shopId of shopIds) {
      await window.pddApi.removeShop(shopId);
    }
    setSelectedShopIds(new Set());
    await loadShops();
    addLog(`已删除 ${shopIds.length} 个 Token 店铺`, 'info');
  }

  function openBindModal() {
    const bindStep1 = document.getElementById('bindStep1');
    const bindStep2 = document.getElementById('bindStep2');
    const btnConfirmBind = document.getElementById('btnConfirmBind');
    const scanStatus = document.getElementById('scanStatus');
    if (bindStep1) bindStep1.style.display = '';
    if (bindStep2) bindStep2.style.display = 'none';
    if (btnConfirmBind) btnConfirmBind.style.display = 'none';
    if (scanStatus) {
      scanStatus.innerHTML = '<div class="scan-icon">🔍</div><div class="scan-text">点击下方按钮开始扫描可绑定的店铺</div>';
    }
    setScannedShops([]);
    showModal('modalBind');
  }

  async function startShopScan() {
    const status = document.getElementById('scanStatus');
    const button = document.getElementById('btnStartScan');
    if (status) {
      status.innerHTML = '<div class="scan-icon" style="animation:pulse 1s infinite">📡</div><div class="scan-text">正在扫描，请稍候...</div>';
    }
    if (button) button.disabled = true;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const scannedShops = await window.pddApi.scanShops();
    setScannedShops(scannedShops);
    if (button) button.disabled = false;
    const bindStep1 = document.getElementById('bindStep1');
    const bindStep2 = document.getElementById('bindStep2');
    const btnConfirmBind = document.getElementById('btnConfirmBind');
    if (bindStep1) bindStep1.style.display = 'none';
    if (bindStep2) bindStep2.style.display = '';
    if (btnConfirmBind) btnConfirmBind.style.display = '';

    const list = document.getElementById('scanResultList');
    if (!list) return;
    list.innerHTML = (scannedShops || []).map((shop, index) => `
      <div class="scan-result-item">
        <input type="checkbox" class="bind-check" data-idx="${index}" checked>
        <div>
          <div class="shop-name">${esc(shop.name)}</div>
          <div class="shop-account">${esc(shop.account)}</div>
        </div>
      </div>
    `).join('');
  }

  function toggleSelectAllBind(event) {
    document.querySelectorAll('.bind-check').forEach(checkbox => {
      checkbox.checked = event.target.checked;
    });
  }

  async function confirmBindShops() {
    const state = getState();
    const scannedShops = state.scannedShops || [];
    const selected = [...document.querySelectorAll('.bind-check:checked')].map(checkbox => scannedShops[checkbox.dataset.idx]);
    if (selected.length === 0) {
      alert('请至少选择一个店铺');
      return;
    }
    await window.pddApi.bindShops(selected);
    hideModal('modalBind');
    addLog(`成功绑定 ${selected.length} 个店铺`, 'reply');
    if (getState().currentView === 'shops') {
      await loadShops();
    }
  }

  function updateExamProgress() {
    const state = getState();
    const answered = Object.keys(state.examAnswers || {}).length;
    const total = (state.examQuestions || []).length;
    document.getElementById('examProgressText').textContent = `${answered}/${total}`;
    document.getElementById('examProgressFill').style.width = total ? `${answered / total * 100}%` : '0%';
  }

  function renderExam() {
    const state = getState();
    const body = document.getElementById('examBody');
    if (!body) return;
    body.innerHTML = (state.examQuestions || []).map((question, index) => {
      const typeLabel = question.type === 'judge' ? '判断题' : '单选题';
      return `<div class="exam-question" data-qid="${question.id}">
        <div class="exam-question-title">
          <span class="q-num">${index + 1}</span>
          ${esc(question.question)}
          <span class="q-type">[${typeLabel}]</span>
        </div>
        <div class="exam-options">
          ${question.options.map((option, optionIndex) => `
            <label class="exam-option" data-qid="${question.id}" data-oi="${optionIndex}">
              <input type="radio" name="exam_${question.id}" value="${optionIndex}">
              ${esc(option)}
            </label>
          `).join('')}
        </div>
      </div>`;
    }).join('');

    updateExamProgress();

    body.querySelectorAll('.exam-option').forEach(option => {
      option.addEventListener('click', () => {
        const qid = option.dataset.qid;
        const oi = parseInt(option.dataset.oi, 10);
        const nextAnswers = {
          ...(getState().examAnswers || {}),
          [qid]: oi,
        };
        setExamAnswers(nextAnswers);
        body.querySelectorAll(`.exam-option[data-qid="${qid}"]`).forEach(item => item.classList.remove('selected'));
        option.classList.add('selected');
        updateExamProgress();
      });
    });
  }

  async function startShopExam() {
    const questions = await window.pddApi.getExamQuestions();
    setExamQuestions(Array.isArray(questions) ? questions : []);
    setExamAnswers({});
    renderExam();
    document.getElementById('btnSubmitExam').style.display = '';
    document.getElementById('btnRetakeExam').style.display = 'none';
    showModal('modalExam');
  }

  async function submitShopExam() {
    const state = getState();
    const examAnswers = state.examAnswers || {};
    const examQuestions = state.examQuestions || [];
    if (Object.keys(examAnswers).length < examQuestions.length) {
      if (!confirm(`还有 ${examQuestions.length - Object.keys(examAnswers).length} 题未作答，确定提交？`)) return;
    }

    const result = await window.pddApi.submitExam(examAnswers);

    examQuestions.forEach(question => {
      const options = document.querySelectorAll(`.exam-option[data-qid="${question.id}"]`);
      options.forEach(option => {
        option.style.pointerEvents = 'none';
        const oi = parseInt(option.dataset.oi, 10);
        if (oi === question.answer) option.classList.add('correct');
        else if (examAnswers[question.id] === oi) option.classList.add('wrong');
      });
    });

    const scoreHtml = document.createElement('div');
    scoreHtml.className = 'exam-score';
    scoreHtml.innerHTML = `
      <div class="score-num">${result.score}</div>
      <div class="score-label">考试得分</div>
      <div class="score-detail">共 ${result.total} 题，答对 ${result.correct} 题</div>
    `;
    document.getElementById('examBody').prepend(scoreHtml);

    document.getElementById('btnSubmitExam').style.display = 'none';
    document.getElementById('btnRetakeExam').style.display = '';
    addLog(`考试完成: ${result.score}分 (${result.correct}/${result.total})`, 'info');
  }

  function retakeShopExam() {
    setExamAnswers({});
    renderExam();
    document.getElementById('btnSubmitExam').style.display = '';
    document.getElementById('btnRetakeExam').style.display = 'none';
  }

  function bindShopsModule() {
    if (initialized) return;
    initialized = true;

    document.getElementById('btnAddShopTokenPage')?.addEventListener('click', () => handleAddShopByToken());
    document.getElementById('btnAddShopQRPage')?.addEventListener('click', () => handleAddShopByQR());
    document.getElementById('shopSearch')?.addEventListener('input', event => {
      setShopSearchText(event.target.value || '');
      renderShops();
    });
    document.getElementById('shopSelectAll')?.addEventListener('change', event => {
      const next = event.target.checked
        ? new Set(getFilteredShops().map(shop => shop.id))
        : new Set();
      setSelectedShopIds(next);
      renderShops();
    });
    document.getElementById('btnSetGroup')?.addEventListener('click', openGroupModal);
    document.getElementById('btnConfirmGroup')?.addEventListener('click', saveShopGroup);
    document.getElementById('btnConfirmRemark')?.addEventListener('click', saveRemark);
    document.getElementById('btnSyncShops')?.addEventListener('click', syncShops);
    document.getElementById('btnRefreshShops')?.addEventListener('click', refreshShops);
    document.getElementById('btnUnbindShops')?.addEventListener('click', unbindShops);
    document.getElementById('btnBindShops')?.addEventListener('click', openBindModal);
    document.getElementById('btnStartScan')?.addEventListener('click', startShopScan);
    document.getElementById('bindSelectAll')?.addEventListener('change', toggleSelectAllBind);
    document.getElementById('btnConfirmBind')?.addEventListener('click', confirmBindShops);
    document.getElementById('btnExamShop')?.addEventListener('click', startShopExam);
    document.getElementById('btnSubmitExam')?.addEventListener('click', submitShopExam);
    document.getElementById('btnRetakeExam')?.addEventListener('click', retakeShopExam);
  }

  window.loadShops = loadShops;
  window.renderGroupTabs = renderGroupTabs;
  window.renderShops = renderShops;
  window.updateBalanceTotal = updateBalanceTotal;
  window.openRemarkModal = openRemarkModal;
  window.renderExam = renderExam;
  window.updateExamProgress = updateExamProgress;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('shops-module', bindShopsModule);
  } else {
    bindShopsModule();
  }
})();
