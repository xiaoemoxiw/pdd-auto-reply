const DEFAULT_BASE_URL = 'https://pdd-multi-store-api.ai-tail.com/';

function getBaseUrl() {
  const env = String(process.env.LICENSE_API_BASE || '').trim();
  return env || DEFAULT_BASE_URL;
}

function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim();
  if (!b) return DEFAULT_BASE_URL;
  return b.endsWith('/') ? b : `${b}/`;
}

async function licenseFetch(path, { method = 'GET', headers = {}, body, token, timeoutMs = 15000 } = {}) {
  const url = new URL(path.replace(/^\//, ''), normalizeBaseUrl(getBaseUrl())).toString();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const finalHeaders = {
    'content-type': 'application/json',
    ...headers
  };
  if (token) finalHeaders.authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const text = await res.text();
    const json = text ? safeParseJson(text) : null;
    if (!res.ok) {
      const msg = json?.message || json?.error || `授权服务请求失败 (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.payload = json;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(t);
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapDataPayload(json) {
  if (!json || typeof json !== 'object') return json;
  if ('data' in json && json.data && typeof json.data === 'object') return json.data;
  return json;
}

function getUnbindPath() {
  const env = String(process.env.LICENSE_UNBIND_PATH || '').trim();
  return env || '/api/v1/license-codes/unbind';
}

async function verifyLicenseCode({ code, hardwareId }) {
  const payload = { code: String(code || '').trim(), hardware_id: String(hardwareId || '').trim() };
  if (!payload.code) throw new Error('缺少授权码');
  if (!payload.hardware_id) throw new Error('缺少硬件ID');

  const res = await licenseFetch('/api/v1/license-codes/verify', {
    method: 'POST',
    body: payload
  });
  return unwrapDataPayload(res);
}

async function unbindLicenseCode({ code, hardwareId, token }) {
  const payload = { code: String(code || '').trim(), hardware_id: String(hardwareId || '').trim() };
  if (!payload.code) throw new Error('缺少授权码');
  if (!payload.hardware_id) throw new Error('缺少硬件ID');
  const res = await licenseFetch(getUnbindPath(), {
    method: 'POST',
    body: payload,
    token
  });
  return unwrapDataPayload(res);
}

async function getClientAuthProfile({ token }) {
  if (!token) throw new Error('缺少 client_token');
  const res = await licenseFetch('/api/v1/client-auth/profile', { method: 'GET', token });
  return unwrapDataPayload(res);
}

module.exports = {
  verifyLicenseCode,
  unbindLicenseCode,
  getClientAuthProfile
};
