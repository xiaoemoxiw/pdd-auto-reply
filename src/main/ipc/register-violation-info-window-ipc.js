const {
  createViolationInfoWindow,
  loadViolationInfoUrl
} = require('../windows/violation-info-window');
const { screen } = require('electron');

function buildViolationInfoUrl(params = {}) {
  const appealSn = String(params?.appealSn || params?.appeal_sn || '').trim();
  const violationType = String(params?.violationType || params?.violation_type || '').trim();
  let targetUrl = String(params?.url || '').trim() || 'https://mms.pinduoduo.com/pg/violation_info';
  if (!targetUrl) return '';
  try {
    const url = new URL(targetUrl);
    if (appealSn) url.searchParams.set('appeal_sn', appealSn);
    if (violationType) url.searchParams.set('violation_type', violationType);
    targetUrl = url.toString();
  } catch {}
  return targetUrl;
}

function buildViolationInfoWindowReuseKey(params = {}, url = '') {
  const shopId = String(params?.shopId || params?.shop_id || '').trim();
  const appealSn = String(params?.appealSn || params?.appeal_sn || '').trim();
  const violationType = String(params?.violationType || params?.violation_type || '').trim();
  if (shopId && appealSn && violationType) return `shop:${shopId}:appeal:${appealSn}:type:${violationType}`;
  if (appealSn && violationType) return `appeal:${appealSn}:type:${violationType}`;
  if (shopId && appealSn) return `shop:${shopId}:appeal:${appealSn}`;
  if (appealSn) return `appeal:${appealSn}`;
  const finalUrl = String(url || '').trim();
  return shopId && finalUrl ? `shop:${shopId}:url:${finalUrl}` : (finalUrl ? `url:${finalUrl}` : '');
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

function registerViolationInfoWindowIpc({
  ipcMain,
  store,
  getMainWindow
}) {
  ipcMain.handle('violation-open-info-window', async (event, params = {}) => {
    try {
      const shopId = String(params?.shopId || '').trim();
      const url = buildViolationInfoUrl(params);
      if (!url) return { error: '缺少违规详情链接' };
      try {
        const parsed = new URL(url);
        const appealSn = String(parsed.searchParams.get('appeal_sn') || '').trim();
        const violationType = String(parsed.searchParams.get('violation_type') || '').trim();
        if (!appealSn || !violationType) return { error: '缺少 appeal_sn 或 violation_type' };
      } catch {}

      const appealSn = String(params?.appealSn || params?.appeal_sn || '').trim();
      const mainWindow = getMainWindow?.();
      const { win, reused } = await createViolationInfoWindow({
        reuseKey: buildViolationInfoWindowReuseKey(params, url),
        shopId,
        store
      });
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };
      try {
        if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(false);
      } catch {}

      win.setTitle(appealSn ? `违规详情 - ${appealSn}` : '违规详情');

      const res = loadViolationInfoUrl(win, store, shopId, url);
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
}

module.exports = {
  registerViolationInfoWindowIpc
};
