const os = require('os');
const crypto = require('crypto');

function safeString(value) {
  return String(value || '').trim();
}

function getStableFingerprintParts() {
  const parts = [];

  try {
    parts.push(`host:${safeString(os.hostname())}`);
  } catch {}

  try {
    const info = os.userInfo?.();
    if (info?.username) parts.push(`user:${safeString(info.username)}`);
  } catch {}

  try {
    const nets = os.networkInterfaces?.() || {};
    const macs = [];
    for (const name of Object.keys(nets).sort()) {
      for (const addr of nets[name] || []) {
        if (!addr) continue;
        if (addr.internal) continue;
        const mac = safeString(addr.mac).toLowerCase();
        if (!mac || mac === '00:00:00:00:00:00') continue;
        macs.push(mac);
      }
    }
    macs.sort();
    if (macs.length) parts.push(`mac:${macs.join(',')}`);
  } catch {}

  return parts;
}

function hashToShortId(input) {
  const h = crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
  return h.slice(0, 32);
}

function formatHardwareId(compact) {
  const v = safeString(compact).replace(/[^a-z0-9]/gi, '').toUpperCase();
  const head = v.slice(0, 20).padEnd(20, '0');
  return head.match(/.{1,4}/g).join('-');
}

function isFormattedHardwareId(value) {
  return /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){4}$/.test(safeString(value));
}

function getOrCreateHardwareId(store) {
  const existing = safeString(store?.get?.('licenseHardwareId'));
  if (existing) {
    if (isFormattedHardwareId(existing)) return existing;
    const migrated = formatHardwareId(existing);
    try {
      store?.set?.('licenseHardwareId', migrated);
    } catch {}
    return migrated;
  }

  const parts = getStableFingerprintParts();
  const seed = parts.length ? parts.join('|') : `fallback:${crypto.randomUUID()}`;
  const hardwareId = formatHardwareId(hashToShortId(seed));

  try {
    store?.set?.('licenseHardwareId', hardwareId);
  } catch {}

  return hardwareId;
}

module.exports = { getOrCreateHardwareId };
