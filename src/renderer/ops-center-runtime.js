function escapeOpsCenterHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function opsCenterToast(message) {
  const el = document.getElementById('toastMsg');
  if (!el) return;
  el.textContent = String(message ?? '');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function renderOpsCenterCards(stats) {
  return (stats || []).map(item => `
    <div class="ops-center-card">
      <div class="ops-center-card-label">${escapeOpsCenterHtml(item.label)}</div>
      <div class="ops-center-card-value">${escapeOpsCenterHtml(item.value)}</div>
    </div>
  `).join('');
}

function renderOpsCenterSections(sections) {
  return (sections || []).map(section => `
    <div class="ops-center-section">
      <div class="ops-center-section-title">${escapeOpsCenterHtml(section.title)}</div>
      <div class="ops-center-list">
        ${(section.items || []).map(item => `
          <div class="ops-center-list-item">
            <div class="ops-center-list-label">${escapeOpsCenterHtml(item.label)}</div>
            <div class="ops-center-list-value">${escapeOpsCenterHtml(item.value)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function renderOpsCenterView(config) {
  const contentHtml = typeof config.renderContent === 'function'
    ? config.renderContent({
      renderCards: renderOpsCenterCards,
      renderSections: renderOpsCenterSections,
      escapeHtml: escapeOpsCenterHtml
    })
    : `
      <div class="ops-center-grid">${renderOpsCenterCards(config.stats)}</div>
      ${renderOpsCenterSections(config.sections)}
    `;
  return `
    <div class="view-page" id="${escapeOpsCenterHtml(config.elementId)}">
      <div class="page-toolbar">
        <span style="font-weight:600;font-size:14px">${escapeOpsCenterHtml(config.title)}</span>
        <span class="spacer"></span>
        <span class="ops-center-toolbar-desc">${escapeOpsCenterHtml(config.description)}</span>
      </div>
      <div class="page-content">${contentHtml}</div>
    </div>
  `;
}

window.initOpsCenterViews = function initOpsCenterViews() {
  const mount = document.getElementById('opsCenterViewMount');
  const views = typeof window.getOpsCenterViews === 'function'
    ? window.getOpsCenterViews()
    : [];
  if (!mount || views.length === 0) return;
  mount.innerHTML = views.map(renderOpsCenterView).join('');
  views.forEach(config => {
    if (typeof config.onMount !== 'function') return;
    const element = document.getElementById(config.elementId);
    if (element) config.onMount(element);
  });
};

window.hasOpsCenterView = function hasOpsCenterView(view) {
  return typeof window.getOpsCenterView === 'function' && !!window.getOpsCenterView(view);
};

window.activateOpsCenterView = function activateOpsCenterView(view) {
  if (typeof window.getOpsCenterView !== 'function') return;
  const config = window.getOpsCenterView(view);
  if (!config) return;
  const page = document.getElementById(config.elementId);
  if (!page) return;
  page.classList.add('active');
  if (typeof config.onShow === 'function') config.onShow(page);
};

window.opsCenterToast = opsCenterToast;
