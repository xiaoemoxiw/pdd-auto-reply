window.opsCenterViews = [];

window.registerOpsCenterView = function registerOpsCenterView(config) {
  if (!config || !config.view || !config.elementId) return;
  const index = window.opsCenterViews.findIndex(item => item.view === config.view);
  if (index >= 0) {
    window.opsCenterViews.splice(index, 1, config);
    return;
  }
  window.opsCenterViews.push(config);
};

window.getOpsCenterViews = function getOpsCenterViews() {
  return Array.isArray(window.opsCenterViews) ? window.opsCenterViews : [];
};

window.getOpsCenterView = function getOpsCenterView(view) {
  return window.getOpsCenterViews().find(item => item.view === view) || null;
};
