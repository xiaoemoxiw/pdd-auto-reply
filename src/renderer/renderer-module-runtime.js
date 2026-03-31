(function () {
  const modules = [];
  let initialized = false;

  window.registerRendererModule = function registerRendererModule(name, setup) {
    if (typeof setup !== 'function') return;
    modules.push({ name, setup });
  };

  window.initRendererModules = function initRendererModules(context = {}) {
    if (initialized) return;
    initialized = true;
    window.__rendererModuleContext = context;
    modules.forEach(module => {
      try {
        module.setup(context);
      } catch (error) {
        console.error(`[renderer-module:${module.name}]`, error);
      }
    });
  };
})();
