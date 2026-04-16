const { Notification, nativeImage, app } = require('electron');
const { execFile } = require('child_process');
const path = require('path');

const recentNotificationAt = new Map();
const activeNotifications = new Set();

function getAppIcon() {
  try {
    return nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'logo.png'));
  } catch {
    return undefined;
  }
}

function shouldSkipDuplicate(uniqueKey = '', cooldownMs = 12000) {
  const key = String(uniqueKey || '').trim();
  if (!key) return false;
  const now = Date.now();
  const previous = Number(recentNotificationAt.get(key) || 0);
  if (previous > 0 && now - previous < cooldownMs) {
    return true;
  }
  recentNotificationAt.set(key, now);
  if (recentNotificationAt.size > 400) {
    const expiredBefore = now - Math.max(30000, cooldownMs);
    for (const [storedKey, ts] of recentNotificationAt.entries()) {
      if (ts < expiredBefore) {
        recentNotificationAt.delete(storedKey);
      }
    }
  }
  return false;
}

function focusMainWindow(getMainWindow) {
  const mainWindow = getMainWindow?.();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function escapeAppleScriptString(value = '') {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function showMacOsScriptNotification(params = {}) {
  if (process.platform !== 'darwin') return;
  const title = escapeAppleScriptString(params?.title || '多多尾巴');
  const body = escapeAppleScriptString(params?.body || '');
  const subtitle = escapeAppleScriptString(params?.subtitle || '');
  const parts = [`display notification "${body}" with title "${title}"`];
  if (subtitle) {
    parts.push(`subtitle "${subtitle}"`);
  }
  execFile('osascript', ['-e', parts.join(' ')], () => {});
}

function showDesktopNotification(params = {}, options = {}) {
  const title = String(params?.title || '').trim();
  const subtitle = String(params?.subtitle || '').trim();
  const body = String(params?.body || '').trim();
  const payload = params?.payload && typeof params.payload === 'object' ? params.payload : {};
  const silent = params?.silent !== false;
  const fallbackToMacOsScript = params?.fallbackToMacOsScript === true;
  const uniqueKey = String(params?.uniqueKey || '').trim();
  const cooldownMs = Math.max(1000, Number(params?.cooldownMs || 12000));
  const getMainWindow = options?.getMainWindow;
  if (!title && !body) return { error: '缺少通知内容' };
  if (uniqueKey && shouldSkipDuplicate(uniqueKey, cooldownMs)) {
    return { ok: true, skipped: true };
  }
  if (typeof Notification !== 'function' || Notification.isSupported?.() === false) {
    return { error: '当前系统不支持桌面通知' };
  }
  try {
    const notification = new Notification({
      title: title || '多多尾巴',
      subtitle,
      body,
      silent,
      icon: getAppIcon(),
    });
    activeNotifications.add(notification);
    notification.on('click', () => {
      focusMainWindow(getMainWindow);
      const mainWindow = getMainWindow?.();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-notification-click', payload);
      }
    });
    notification.on('close', () => {
      activeNotifications.delete(notification);
    });
    notification.show();
    if (fallbackToMacOsScript && process.platform === 'darwin' && !app.isPackaged) {
      showMacOsScriptNotification(params);
    }
    return { ok: true };
  } catch (error) {
    if (fallbackToMacOsScript && process.platform === 'darwin') {
      showMacOsScriptNotification(params);
      return { ok: true, fallback: 'osascript' };
    }
    return { error: error?.message || '发送桌面通知失败' };
  }
}

function registerSystemNotificationIpc({
  ipcMain,
  getMainWindow,
}) {
  ipcMain.handle('show-desktop-notification', async (event, params = {}) => {
    return showDesktopNotification(params, { getMainWindow });
  });
}

module.exports = {
  registerSystemNotificationIpc,
  showDesktopNotification,
};
