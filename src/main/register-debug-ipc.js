function registerDebugIpc({
  ipcMain,
  store,
  getMainWindow,
  getCurrentView,
  getShopManager,
  isEmbeddedPddView,
  createSettingsWindow,
  createDebugWindow
}) {
  const verboseLogging = process.env.NODE_ENV === 'development' || process.env.PDD_VERBOSE_LOG === '1';

  ipcMain.handle('open-settings', () => {
    createSettingsWindow(getMainWindow(), store);
  });

  ipcMain.handle('open-devtools', () => {
    if (isEmbeddedPddView(getCurrentView())) {
      const view = getShopManager()?.getActiveView();
      if (!view) {
        return { error: '当前没有可调试的嵌入页' };
      }
      view.webContents.openDevTools({ mode: 'detach' });
      return { ok: true, target: 'embedded' };
    }

    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: '主窗口不可用' };
    }
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return { ok: true, target: 'renderer' };
  });

  ipcMain.handle('diagnose-page', async () => {
    const view = getShopManager()?.getActiveView();
    if (!view) return { error: '没有活跃的 BrowserView' };
    return view.webContents.executeJavaScript(`(function(){
      var r = {};
      r.url = location.href;
      r.title = document.title;

      r.bodyChildren = [];
      var body = document.body;
      if (body) {
        for (var i = 0; i < Math.min(body.children.length, 30); i++) {
          var el = body.children[i];
          var rect = el.getBoundingClientRect();
          r.bodyChildren.push({
            tag: el.tagName, id: el.id || '',
            cls: (el.className || '').toString().slice(0, 100),
            w: Math.round(rect.width), h: Math.round(rect.height)
          });
        }
      }

      r.layoutTree = [];
      function walkLayout(parent, depth) {
        if (depth > 3) return;
        for (var c = 0; c < parent.children.length && r.layoutTree.length < 80; c++) {
          var el = parent.children[c];
          var rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 50) continue;
          r.layoutTree.push({
            depth: depth,
            tag: el.tagName, id: el.id || '',
            cls: (el.className || '').toString().slice(0, 100),
            x: Math.round(rect.left), y: Math.round(rect.top),
            w: Math.round(rect.width), h: Math.round(rect.height),
            children: el.children.length
          });
          walkLayout(el, depth + 1);
        }
      }
      if (body) walkLayout(body, 0);

      r.iframes = [];
      document.querySelectorAll('iframe').forEach(function(f){
        var rect = f.getBoundingClientRect();
        r.iframes.push({
          src: (f.src || '').slice(0, 300), id: f.id || '',
          w: Math.round(rect.width), h: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0
        });
      });

      r.shadowRoots = 0;
      document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot) r.shadowRoots++; });

      r.singleSpa = typeof window.singleSpa !== 'undefined';
      r.qiankun = typeof window.__POWERED_BY_QIANKUN__ !== 'undefined';

      r.layerCount = document.querySelectorAll('.layer').length;
      r.layerVisible = false;
      document.querySelectorAll('.layer').forEach(function(el){
        var rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) r.layerVisible = true;
      });

      return r;
    })()`);
  });

  ipcMain.handle('open-debug-window', async () => {
    try {
      const mainWindow = getMainWindow();
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const win = await createDebugWindow(parent);
      if (!win || win.isDestroyed()) {
        return { error: '调试窗口创建失败' };
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.on('renderer-debug-log', (event, payload = {}) => {
    if (!verboseLogging) return;
    const scope = payload?.scope || 'renderer';
    const message = payload?.message || '';
    const extra = payload?.extra ? ` ${JSON.stringify(payload.extra)}` : '';
    console.log(`[页面调试:${scope}] ${message}${extra}`);
  });
}

module.exports = {
  registerDebugIpc
};
