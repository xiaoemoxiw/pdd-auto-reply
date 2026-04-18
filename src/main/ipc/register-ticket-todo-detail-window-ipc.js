const {
  createTicketTodoDetailWindow,
  getTicketTodoDetailWindowContextByWebContents,
  setTicketTodoDetailToolbarHeight,
  loadTicketTodoDetailUrl,
  goBack,
  goForward,
  reload,
  getViewState
} = require('../windows/ticket-todo-detail-window');
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

function getDetailWindowContext(event) {
  if (!event?.sender) return null;
  return getTicketTodoDetailWindowContextByWebContents(event.sender);
}

function buildDetailWindowReuseKey(params = {}, url = '') {
  const instanceId = String(params?.instanceId || params?.id || params?.todoId || params?.detailRequestId || '').trim();
  if (instanceId) return `instance:${instanceId}`;
  const orderSn = String(params?.orderSn || params?.orderNo || params?.order_sn || '').trim();
  if (orderSn) return `order:${orderSn}`;
  const ticketNo = String(params?.ticketNo || params?.ticket_no || '').trim();
  if (ticketNo) return `ticket:${ticketNo}`;
  const finalUrl = String(url || '').trim();
  return finalUrl ? `url:${finalUrl}` : '';
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
  ipcMain.handle('ticket-open-todo-detail-window', async (event, params = {}) => {
    try {
      const url = String(params?.url || '').trim() || buildTicketTodoDetailUrl(params);
      if (!url) return { error: '缺少订单号或详情链接' };
      const shopId = String(params?.shopId || '').trim();
      const orderSn = String(params?.orderSn || params?.orderNo || params?.order_sn || '').trim();
      const ticketNo = String(params?.ticketNo || params?.ticket_no || '').trim();

      const mainWindow = getMainWindow?.();
      const { win, reused } = await createTicketTodoDetailWindow({
        reuseKey: buildDetailWindowReuseKey(params, url)
      });
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };
      try {
        if (typeof win.setParentWindow === 'function') win.setParentWindow(null);
        if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(false);
      } catch {}

      if (orderSn) {
        win.setTitle(`工单处理 - ${orderSn}`);
      } else if (ticketNo) {
        win.setTitle(`工单处理 - ${ticketNo}`);
      } else {
        win.setTitle('工单处理');
      }

      const res = loadTicketTodoDetailUrl(win, store, shopId, url);
      if (res && res.error) return res;
      if (!reused) {
        placeWindowRelativeToMain(mainWindow, win);
      }
      win.show();
      win.focus();
      return { ok: true, reused: reused === true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('ticket-todo-detail-set-toolbar-height', async (event, params = {}) => {
    const context = getDetailWindowContext(event);
    if (!context) return { error: '无效窗口' };
    return setTicketTodoDetailToolbarHeight(context, params?.height);
  });

  ipcMain.handle('ticket-todo-detail-navigate', async (event, params = {}) => {
    const context = getDetailWindowContext(event);
    if (!context) return { error: '无效窗口' };
    const url = String(params?.url || params || '').trim();
    const res = loadTicketTodoDetailUrl(context, store, '', url);
    return res && res.error ? res : { ok: true };
  });

  ipcMain.handle('ticket-todo-detail-back', async (event) => {
    const context = getDetailWindowContext(event);
    if (!context) return { error: '无效窗口' };
    return goBack(context);
  });

  ipcMain.handle('ticket-todo-detail-forward', async (event) => {
    const context = getDetailWindowContext(event);
    if (!context) return { error: '无效窗口' };
    return goForward(context);
  });

  ipcMain.handle('ticket-todo-detail-reload', async (event) => {
    const context = getDetailWindowContext(event);
    if (!context) return { error: '无效窗口' };
    return reload(context);
  });

  ipcMain.handle('ticket-todo-detail-get-state', async (event) => {
    const context = getDetailWindowContext(event);
    if (!context) return { error: '无效窗口' };
    return { ok: true, state: getViewState(context) };
  });
}

module.exports = {
  registerTicketTodoDetailWindowIpc
};
