// 通用解析与对象路径工具：从 PddApiClient 抽离，保持纯函数语义，便于复用与单测。
// 任何模块都不应在这里挂业务上下文。

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function safeParseJson(text) {
  if (!text) return null;
  if (typeof text === 'object') {
    return cloneJson(text);
  }
  if (typeof text !== 'string') return null;
  const source = String(text).trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    if (!source.includes('=') || source.startsWith('<')) {
      return null;
    }
    try {
      const params = new URLSearchParams(source);
      const result = {};
      let hasEntry = false;
      for (const [key, rawValue] of params.entries()) {
        hasEntry = true;
        const value = String(rawValue || '').trim();
        let parsedValue = value;
        if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
          try {
            parsedValue = JSON.parse(value);
          } catch {}
        }
        if (Object.prototype.hasOwnProperty.call(result, key)) {
          if (Array.isArray(result[key])) {
            result[key].push(parsedValue);
          } else {
            result[key] = [result[key], parsedValue];
          }
        } else {
          result[key] = parsedValue;
        }
      }
      return hasEntry ? result : null;
    } catch {
      return null;
    }
  }
}

function collectObjectKeyPaths(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return [];
  const result = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    result.push(path);
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      result.push(...collectObjectKeyPaths(child, path, depth + 1));
    }
  }
  return result;
}

function readObjectPath(value, path) {
  if (!value || typeof value !== 'object' || !path) return undefined;
  const segments = String(path).split('.').filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function writeObjectPath(value, path, nextValue) {
  if (!value || typeof value !== 'object' || !path) return false;
  const segments = String(path).split('.').filter(Boolean);
  if (!segments.length) return false;
  let current = value;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = nextValue;
  return true;
}

function findObjectPathByCandidates(value, candidates = []) {
  const keyPaths = collectObjectKeyPaths(value);
  for (const candidate of candidates) {
    const exact = keyPaths.find(path => path === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const suffix = `.${candidate}`;
    const matched = keyPaths.find(path => path.endsWith(suffix));
    if (matched) return matched;
  }
  return '';
}

module.exports = {
  cloneJson,
  safeParseJson,
  collectObjectKeyPaths,
  readObjectPath,
  writeObjectPath,
  findObjectPathByCandidates,
};
