const {
  createTicketTodoDetailWindow,
  getTicketTodoDetailWindow,
  setTicketTodoDetailToolbarHeight,
  loadTicketTodoDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
} = require('./ticket-todo-detail-window');
const { screen } = require('electron');

function buildTicketTodoDetailUrl(params = {}) {
  const instanceId = String(params?.instanceId || '').trim();
  if (instanceId) {
    return `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${encodeURIComponent(instanceId)}`;
  }
  const id = String(params?.id || params?.todoId || params?.detailRequestId || '').trim();
  if (id) return `https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${encodeURIComponent(id)}`;
  const orderSn = String(params?.orderSn || params?.orderNo || params?.order_sn || '').trim();
  if (!orderSn) return '';
  return `https://mms.pinduoduo.com/aftersales/work_order/tododetail?order_sn=${encodeURIComponent(orderSn)}`;
}

function isDetailWindowSender(event) {
  const win = getTicketTodoDetailWindow();
  if (!win || win.isDestroyed()) return false;
  return win.webContents && event.sender && win.webContents.id === event.sender.id;
}

function placeWindowRelativeToMain(mainWindow, win) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!win || win.isDestroyed()) return;

  const mainBounds = mainWindow.getBounds();
  const currentBounds = win.getBounds();
  const display = screen.getDisplayMatching(mainBounds);
  const workArea = display?.workArea || display?.bounds;
  if (!workArea) return;

  if (win.isMaximized()) win.unmaximize();

  const gap = 12;
  const maxWidth = Math.max(200, workArea.width);
  const maxHeight = Math.max(200, workArea.height);
  const width = Math.min(currentBounds.width, maxWidth);
  const height = Math.min(currentBounds.height, maxHeight);

  let x = Math.round(mainBounds.x + (mainBounds.width - width) / 2);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));

  const yBelow = mainBounds.y + mainBounds.height + gap;
  const yAbove = mainBounds.y - height - gap;
  let y = yBelow;
  if (yBelow + height > workArea.y + workArea.height) {
    if (yAbove >= workArea.y) {
      y = yAbove;
    } else {
      y = Math.max(workArea.y, workArea.y + workArea.height - height);
    }
  }

  win.setBounds({ x, y, width, height }, false);
}

function registerTicketTodoDetailWindowIpc({
  ipcMain,
  store,
  getMainWindow
}) {
  let boundMainWindowFocus = false;
  ipcMain.handle('ticket-open-todo-detail-window', async (event, params = {}) => {
    try {
      const url = String(params?.url || '').trim() || buildTicketTodoDetailUrl(params);
      if (!url) return { error: '缺少订单号或详情链接' };
      const shopId = String(params?.shopId || '').trim();

      const mainWindow = getMainWindow?.();
      const win = await createTicketTodoDetailWindow();
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };
      try {
        if (typeof win.setParentWindow === 'function') win.setParentWindow(null);
        if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(false);
      } catch {}
      if (!boundMainWindowFocus && mainWindow && !mainWindow.isDestroyed()) {
        boundMainWindowFocus = true;
        mainWindow.on('focus', () => {
          try {
            if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop();
          } catch {}
        });
      }

      const res = loadTicketTodoDetailUrl(store, shopId, url);
      if (res && res.error) return res;
      placeWindowRelativeToMain(mainWindow, win);
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('ticket-todo-detail-set-toolbar-height', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    setTicketTodoDetailToolbarHeight(params?.height);
    return { ok: true };
  });

  ipcMain.handle('ticket-todo-detail-navigate', async (event, params = {}) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadTicketTodoDetailUrl(store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('ticket-todo-detail-back', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goBack();
  });

  ipcMain.handle('ticket-todo-detail-forward', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return goForward();
  });

  ipcMain.handle('ticket-todo-detail-reload', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return reload();
  });

  ipcMain.handle('ticket-todo-detail-get-state', async (event) => {
    if (!isDetailWindowSender(event)) return { error: '无效窗口' };
    return { ok: true, state: getViewState() };
  });
}

module.exports = {
  registerTicketTodoDetailWindowIpc
};
