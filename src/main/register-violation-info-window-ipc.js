const {
  createViolationInfoWindow,
  loadViolationInfoUrl
} = require('./violation-info-window');

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

function registerViolationInfoWindowIpc({
  ipcMain,
  store
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

      const win = await createViolationInfoWindow();
      if (!win || win.isDestroyed()) return { error: '详情窗口创建失败' };
      try {
        if (typeof win.setParentWindow === 'function') win.setParentWindow(null);
      } catch {}

      const res = loadViolationInfoUrl(store, shopId, url);
      if (res && res.error) return res;
      win.show();
      win.focus();
      return { ok: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });
}

module.exports = {
  registerViolationInfoWindowIpc
};
