const { getOrCreateHardwareId } = require('../license/license-hardware-id');
const { verifyLicenseCode, unbindLicenseCode, getClientAuthProfile } = require('../license/license-service');
const { getLicenseData, setLicenseData, clearLicenseData, isLicenseValid } = require('../license/license-store');

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function normalizeLicenseFromBackend({ code, hardwareId, verifyResult, profile }) {
  return {
    code,
    clientToken: String(verifyResult?.client_token || ''),
    hardwareId,
    partnerName: String(verifyResult?.partner_name || ''),
    partnerId: String(profile?.partner_id || verifyResult?.partner_id || ''),
    licenseCodeId: String(profile?.license_code_id || verifyResult?.license_code_id || ''),
    expiresAt: String(verifyResult?.expires_at || ''),
    remainingDays: Number(verifyResult?.remaining_days ?? 0),
    valid: !!verifyResult?.valid,
    verifiedAt: formatTimestamp()
  };
}

function registerLicenseIpc({
  ipcMain,
  store,
  createLicenseWindow,
  getLicenseWindow,
  destroyLicenseWindow,
  ensureMainApp,
  getMainWindow,
  destroyMainWindow
}) {
  let licenseRefreshTimer = null;

  function broadcastLicenseUpdated() {
    const data = getLicenseData(store);

    const win1 = getMainWindow?.();
    if (win1 && !win1.isDestroyed()) win1.webContents.send('license-updated', data);

    const win2 = getLicenseWindow?.();
    if (win2 && !win2.isDestroyed()) win2.webContents.send('license-updated', data);
  }

  async function refreshLicenseFromBackend() {
    const license = getLicenseData(store);
    if (!license?.code) return null;

    const hardwareId = String(license.hardwareId || getOrCreateHardwareId(store));
    try {
      const verifyResult = await verifyLicenseCode({ code: license.code, hardwareId });
      let profile = null;
      if (verifyResult?.valid && verifyResult?.client_token) {
        try {
          profile = await getClientAuthProfile({ token: verifyResult.client_token });
        } catch {}
      }

      const next = normalizeLicenseFromBackend({ code: license.code, hardwareId, verifyResult, profile });
      setLicenseData(store, next);
      broadcastLicenseUpdated();

      if (!isLicenseValid(store)) {
        stopLicenseRefreshTimer();
        createLicenseWindow?.();
        const mainWin = getMainWindow?.();
        if (mainWin && !mainWin.isDestroyed()) {
          destroyMainWindow?.();
        }
      }

      return verifyResult;
    } catch {
      broadcastLicenseUpdated();
      return null;
    }
  }

  function startLicenseRefreshTimer() {
    stopLicenseRefreshTimer();
    const ONE_HOUR = 60 * 60 * 1000;
    licenseRefreshTimer = setInterval(() => {
      refreshLicenseFromBackend();
    }, ONE_HOUR);
  }

  function stopLicenseRefreshTimer() {
    if (!licenseRefreshTimer) return;
    clearInterval(licenseRefreshTimer);
    licenseRefreshTimer = null;
  }

  ipcMain.handle('license:verify', async (_event, params) => {
    const code = String(params?.code || '').trim();
    if (!code) throw new Error('请输入授权码');

    const hardwareId = getOrCreateHardwareId(store);
    const verifyResult = await verifyLicenseCode({ code, hardwareId });

    let profile = null;
    if (verifyResult?.valid && verifyResult?.client_token) {
      try {
        profile = await getClientAuthProfile({ token: verifyResult.client_token });
      } catch {}
    }

    const next = normalizeLicenseFromBackend({ code, hardwareId, verifyResult, profile });
    setLicenseData(store, next);
    broadcastLicenseUpdated();
    return verifyResult;
  });

  ipcMain.handle('license:get-data', async () => {
    return getLicenseData(store);
  });

  ipcMain.handle('license:check', async () => {
    return isLicenseValid(store);
  });

  ipcMain.handle('license:clear', async () => {
    const license = getLicenseData(store);
    const requireRemoteUnbind = String(process.env.LICENSE_UNBIND_REQUIRED || '') === '1';

    let remoteUnbindOk = false;
    if (license?.code) {
      const hardwareId = String(license.hardwareId || getOrCreateHardwareId(store));
      const token = String(license.clientToken || license.client_token || '');
      try {
        await unbindLicenseCode({ code: license.code, hardwareId, token: token || undefined });
        remoteUnbindOk = true;
      } catch (err) {
        const status = Number(err?.status || 0);
        if (requireRemoteUnbind && status !== 404 && status !== 405) {
          throw err;
        }
      }
    }

    clearLicenseData(store);
    stopLicenseRefreshTimer();
    broadcastLicenseUpdated();

    createLicenseWindow?.();
    destroyMainWindow?.();
    return { ok: true, remoteUnbindOk };
  });

  ipcMain.handle('license:switch-to-main', async () => {
    if (!isLicenseValid(store)) throw new Error('授权无效或已过期');

    await ensureMainApp?.();
    destroyLicenseWindow?.();
    startLicenseRefreshTimer();
    return { ok: true };
  });

  ipcMain.handle('license:refresh', async () => {
    return refreshLicenseFromBackend();
  });

  ipcMain.handle('license:start-timer', async () => {
    if (isLicenseValid(store)) startLicenseRefreshTimer();
    return { ok: true };
  });

  ipcMain.handle('license:stop-timer', async () => {
    stopLicenseRefreshTimer();
    return { ok: true };
  });

  return {
    startTimer: startLicenseRefreshTimer,
    stopTimer: stopLicenseRefreshTimer,
    refreshNow: refreshLicenseFromBackend
  };
}

module.exports = { registerLicenseIpc };
