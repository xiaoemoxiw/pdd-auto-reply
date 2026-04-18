const Store = require('electron-store');

// 每个店铺最多缓存多少条会话；每个会话最多缓存多少条消息
const SESSIONS_PER_SHOP_LIMIT = 200;
const MESSAGES_PER_SESSION_LIMIT = 50;
// 每个店铺下最多保留多少个有消息缓存的会话，超出按 savedAt 倒序裁剪
const MESSAGE_SESSIONS_PER_SHOP_LIMIT = 200;
// 缓存过期时间，超过则启动时不再用作"先画一帧"
const SESSION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FLUSH_DEBOUNCE_MS = 1500;

// 任何含敏感语义的字段都不进磁盘，避免 token / cookie / 反爬上下文持久化外泄。
const SENSITIVE_KEY_RE = /^(cookie|set-cookie|anti[-_]?content|mall[-_]?token|authorization|access[-_]?token|refresh[-_]?token|x[-_]?ant[-_]?token|csrf[-_]?token|signature|sign|api[-_]?token|pdd[-_]?token)$/i;

const store = new Store({
  name: 'chat-api-cache',
  defaults: {
    sessions: {},
    messages: {},
  },
});

const sessionFlushBuffer = new Map();
const sessionFlushTimers = new Map();
const messageFlushBuffer = new Map();
const messageFlushTimers = new Map();

function stripSensitive(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map(item => stripSensitive(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    try {
      out[key] = stripSensitive(value[key], depth + 1);
    } catch {
      // 个别属性序列化失败时跳过该字段
    }
  }
  return out;
}

function normalizeSessions(sessions) {
  if (!Array.isArray(sessions)) return [];
  const result = [];
  for (const item of sessions) {
    if (!item || !item.sessionId) continue;
    try {
      result.push(stripSensitive(item));
    } catch {
      // ignore single bad entry
    }
    if (result.length >= SESSIONS_PER_SHOP_LIMIT) break;
  }
  return result;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const seen = new Map();
  for (const m of messages) {
    if (!m) continue;
    let stripped;
    try {
      stripped = stripSensitive(m);
    } catch {
      continue;
    }
    if (!stripped) continue;
    const id = String(stripped.id || stripped.messageId || stripped.msgId || '');
    const key = id || `t:${stripped.timestamp || ''}:c:${String(stripped.content || '').slice(0, 24)}`;
    seen.set(key, stripped);
  }
  const list = Array.from(seen.values());
  list.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  if (list.length > MESSAGES_PER_SESSION_LIMIT) {
    return list.slice(list.length - MESSAGES_PER_SESSION_LIMIT);
  }
  return list;
}

function readSessions(shopId) {
  if (!shopId) return null;
  try {
    const all = store.get('sessions') || {};
    const entry = all[shopId];
    if (!entry || !Array.isArray(entry.items) || !entry.items.length) return null;
    if (entry.savedAt && Date.now() - entry.savedAt > SESSION_CACHE_TTL_MS) return null;
    return { savedAt: Number(entry.savedAt || 0), sessions: entry.items };
  } catch (error) {
    console.warn(`[chat-api-cache] 读取会话缓存失败 ${shopId}: ${error.message}`);
    return null;
  }
}

function readMessages(shopId, sessionId) {
  if (!shopId || !sessionId) return null;
  try {
    const all = store.get('messages') || {};
    const shopEntry = all[shopId];
    const entry = shopEntry && shopEntry[sessionId];
    if (!entry || !Array.isArray(entry.items) || !entry.items.length) return null;
    if (entry.savedAt && Date.now() - entry.savedAt > SESSION_CACHE_TTL_MS) return null;
    return { savedAt: Number(entry.savedAt || 0), messages: entry.items };
  } catch (error) {
    console.warn(`[chat-api-cache] 读取消息缓存失败 ${shopId}/${sessionId}: ${error.message}`);
    return null;
  }
}

function flushSessions(shopId) {
  const sessions = sessionFlushBuffer.get(shopId);
  sessionFlushBuffer.delete(shopId);
  sessionFlushTimers.delete(shopId);
  if (!sessions) return;
  try {
    const all = store.get('sessions') || {};
    all[shopId] = { savedAt: Date.now(), items: sessions };
    store.set('sessions', all);
  } catch (error) {
    console.warn(`[chat-api-cache] 写入会话缓存失败 ${shopId}: ${error.message}`);
  }
}

function scheduleWriteSessions(shopId, sessions) {
  if (!shopId) return;
  const normalized = normalizeSessions(sessions);
  if (!normalized.length) return;
  sessionFlushBuffer.set(shopId, normalized);
  if (sessionFlushTimers.has(shopId)) return;
  const timer = setTimeout(() => flushSessions(shopId), FLUSH_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  sessionFlushTimers.set(shopId, timer);
}

function flushMessages(shopId, sessionId) {
  const key = `${shopId}::${sessionId}`;
  const messages = messageFlushBuffer.get(key);
  messageFlushBuffer.delete(key);
  messageFlushTimers.delete(key);
  if (!messages) return;
  try {
    const all = store.get('messages') || {};
    if (!all[shopId] || typeof all[shopId] !== 'object') all[shopId] = {};
    all[shopId][sessionId] = { savedAt: Date.now(), items: messages };
    const entries = Object.entries(all[shopId]);
    if (entries.length > MESSAGE_SESSIONS_PER_SHOP_LIMIT) {
      entries.sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0));
      all[shopId] = Object.fromEntries(entries.slice(0, MESSAGE_SESSIONS_PER_SHOP_LIMIT));
    }
    store.set('messages', all);
  } catch (error) {
    console.warn(`[chat-api-cache] 写入消息缓存失败 ${shopId}/${sessionId}: ${error.message}`);
  }
}

function scheduleWriteMessages(shopId, sessionId, messages) {
  if (!shopId || !sessionId) return;
  const normalized = normalizeMessages(messages);
  if (!normalized.length) return;
  const key = `${shopId}::${sessionId}`;
  messageFlushBuffer.set(key, normalized);
  if (messageFlushTimers.has(key)) return;
  const timer = setTimeout(() => flushMessages(shopId, sessionId), FLUSH_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  messageFlushTimers.set(key, timer);
}

// 实时推送来一条新消息时，把它合并到现有缓存末尾。
// 用 readMessages 读出旧缓存做基底，避免覆盖前面 50 条历史。
function appendIncomingMessage(shopId, sessionId, message) {
  if (!shopId || !sessionId || !message) return;
  const cached = readMessages(shopId, sessionId);
  const next = (cached?.messages || []).slice();
  next.push(message);
  scheduleWriteMessages(shopId, sessionId, next);
}

function clearShop(shopId) {
  if (!shopId) return;
  try {
    const sessions = store.get('sessions') || {};
    if (sessions[shopId]) {
      delete sessions[shopId];
      store.set('sessions', sessions);
    }
    const messages = store.get('messages') || {};
    if (messages[shopId]) {
      delete messages[shopId];
      store.set('messages', messages);
    }
  } catch (error) {
    console.warn(`[chat-api-cache] 清理 ${shopId} 缓存失败: ${error.message}`);
  }
  sessionFlushBuffer.delete(shopId);
  const sessionTimer = sessionFlushTimers.get(shopId);
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionFlushTimers.delete(shopId);
  for (const key of Array.from(messageFlushBuffer.keys())) {
    if (key.startsWith(`${shopId}::`)) {
      messageFlushBuffer.delete(key);
      const t = messageFlushTimers.get(key);
      if (t) clearTimeout(t);
      messageFlushTimers.delete(key);
    }
  }
}

module.exports = {
  readSessions,
  readMessages,
  scheduleWriteSessions,
  scheduleWriteMessages,
  appendIncomingMessage,
  clearShop,
  SESSION_CACHE_TTL_MS,
};
