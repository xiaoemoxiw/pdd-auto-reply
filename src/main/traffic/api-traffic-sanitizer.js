const REDACTED = '[REDACTED]';
const ID_PLACEHOLDER = '[ID]';
const TEXT_PLACEHOLDER = '[TEXT]';
const REQUEST_ID_PLACEHOLDER = '[REQUEST_ID]';

function isRedactedIdKey(key) {
  const normalizedKey = String(key || '').toLowerCase();
  return [
    'mall_id',
    'mallid',
    'uid',
    'user_id',
    'userid',
    'buyerid',
    'sellerid',
    'cs_id',
    'cs_uid',
    'csid',
    'session_id',
    'sessionid',
    'conversation_id',
    'conversationid',
    'msg_id',
    'pre_msg_id',
  ].includes(normalizedKey);
}

function isTextPlaceholderKey(key) {
  const normalizedKey = String(key || '').toLowerCase();
  return [
    'content',
    'text',
    'nickname',
    'username',
    'mall_name',
    'mallname',
    'cs_name',
    'nick_name',
    'customer',
    'question',
    'answer',
    'targettext',
    'messagepreview',
  ].includes(normalizedKey);
}

function tryParseJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeUrlLike(value) {
  try {
    const parsed = new URL(value);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('token')
        || normalizedKey.includes('cookie')
        || normalizedKey.includes('uid')
        || normalizedKey.includes('id')
      ) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function sanitizeString(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (!value) return value;
  if (isRedactedIdKey(normalizedKey)) return ID_PLACEHOLDER;
  if (isTextPlaceholderKey(normalizedKey)) return TEXT_PLACEHOLDER;
  if (normalizedKey.includes('token') || normalizedKey.includes('cookie')) return REDACTED;
  if (normalizedKey.includes('anti_content')) return REDACTED;
  if (normalizedKey.includes('request_id')) return REQUEST_ID_PLACEHOLDER;
  if (normalizedKey === 'pddid') return REDACTED;
  if (normalizedKey.includes('avatar') || normalizedKey.includes('logo')) return '[URL]';
  if (normalizedKey.includes('url') || normalizedKey.includes('uri')) return sanitizeUrlLike(value);
  if (/^(https?|wss?):\/\//.test(value)) return sanitizeUrlLike(value);
  if (value.length > 1200) return `${value.slice(0, 360)}...[TRUNCATED:${value.length}]`;
  return value;
}

function sanitizeValue(key, value) {
  if (typeof value === 'number') {
    if (String(key || '').toLowerCase().includes('request_id')) return REQUEST_ID_PLACEHOLDER;
    if (isRedactedIdKey(key)) return ID_PLACEHOLDER;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeValue(key, item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [childKey, childValue]) => {
      acc[childKey] = sanitizeValue(childKey, childValue);
      return acc;
    }, {});
  }
  if (typeof value === 'string') {
    return sanitizeString(key, value);
  }
  return value;
}

function sanitizeBody(body) {
  if (!body) return body;
  if (typeof body === 'string') {
    const parsed = tryParseJson(body);
    if (parsed) return sanitizeValue('body', parsed);
    return sanitizeString('body', body);
  }
  if (typeof body === 'object') {
    return sanitizeValue('body', body);
  }
  return body;
}

function sanitizeTrafficEntry(entry = {}) {
  return {
    ...sanitizeValue('entry', entry || {}),
    requestBody: sanitizeBody(entry?.requestBody || ''),
    responseBody: sanitizeBody(entry?.responseBody || ''),
    requestHeaders: sanitizeValue('headers', entry?.requestHeaders || {}),
    responseHeaders: sanitizeValue('headers', entry?.responseHeaders || {}),
    triggerContext: sanitizeValue('triggerContext', entry?.triggerContext || null),
  };
}

module.exports = {
  sanitizeBody,
  sanitizeTrafficEntry,
  sanitizeValue,
  tryParseJson,
};
