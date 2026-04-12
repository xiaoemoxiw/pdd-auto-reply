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

function getOrCreateHardwareId(store) {
  const existing = safeString(store?.get?.('licenseHardwareId'));
  if (existing) return existing;

  const parts = getStableFingerprintParts();
  const seed = parts.length ? parts.join('|') : `fallback:${crypto.randomUUID()}`;
  const hardwareId = hashToShortId(seed);

  try {
    store?.set?.('licenseHardwareId', hardwareId);
  } catch {}

  return hardwareId;
}

module.exports = { getOrCreateHardwareId };
