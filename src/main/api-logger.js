/**
 * API 抓包日志模块
 * 将 NetworkMonitor 捕获的完整请求+响应对分类保存到 JSON 文件，
 * 供 API 逆向分析和 PDD API 客户端开发使用。
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// API 分类规则：URL 关键词 → 类型标签
const CATEGORY_RULES = [
  { patterns: ['send_msg', 'send_message', 'send_chat', 'reply'], category: 'message-send' },
  { patterns: ['msg_list', 'message_list', 'recv_msg', 'new_msg', 'pull_msg', 'sync', 'long_polling'], category: 'message-receive' },
  { patterns: ['conversation', 'session', 'chat_list', 'conv_list', 'contact'], category: 'session-list' },
  { patterns: ['order', 'trade'], category: 'order' },
  { patterns: ['goods', 'product', 'item'], category: 'goods' },
  { patterns: ['customer', 'user_info', 'buyer', 'member'], category: 'customer' },
  { patterns: ['/plateau/'], category: 'plateau-core' },
];

class ApiLogger {
  constructor() {
    this._captures = [];
    this._maxMemoryCaptures = 500;
    this._logDir = path.join(app.getPath('userData'), 'api-captures');
    this._ensureDir();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this._logDir)) fs.mkdirSync(this._logDir, { recursive: true });
    } catch {}
  }

  categorize(url) {
    const lower = url.toLowerCase();
    for (const rule of CATEGORY_RULES) {
      if (rule.patterns.some(p => lower.includes(p))) return rule.category;
    }
    return 'other';
  }

  /**
   * 记录一条完整的请求+响应捕获
   * @param {object} entry - { id, timestamp, request: {url, shortUrl, method, headers, postData}, response: {status, bodySize, body, isJson} }
   */
  add(entry) {
    const category = this.categorize(entry.request.url);
    const record = { ...entry, category };
    this._captures.push(record);

    if (this._captures.length > this._maxMemoryCaptures) {
      this._captures = this._captures.slice(-Math.floor(this._maxMemoryCaptures * 0.7));
    }

    return record;
  }

  getAll() {
    return this._captures;
  }

  getByCategory(category) {
    return this._captures.filter(c => c.category === category);
  }

  getCategories() {
    const counts = {};
    for (const c of this._captures) {
      counts[c.category] = (counts[c.category] || 0) + 1;
    }
    return counts;
  }

  /**
   * 获取最近捕获的摘要列表（不含完整 body，用于 UI 展示）
   */
  getSummaryList(limit = 100) {
    return this._captures.slice(-limit).reverse().map(c => ({
      id: c.id,
      timestamp: c.timestamp,
      category: c.category,
      method: c.request.method,
      url: c.request.shortUrl,
      status: c.response.status,
      bodySize: c.response.bodySize,
      isJson: c.response.isJson,
      hasPostData: !!c.request.postData,
    }));
  }

  /**
   * 获取单条捕获的完整详情
   */
  getDetail(captureId) {
    return this._captures.find(c => c.id === captureId) || null;
  }

  /**
   * 导出所有捕获到 JSON 文件
   */
  exportToFile(filename) {
    this._ensureDir();
    const filePath = filename || path.join(this._logDir, `capture-${Date.now()}.json`);
    const data = {
      exportTime: new Date().toISOString(),
      totalCaptures: this._captures.length,
      categories: this.getCategories(),
      captures: this._captures,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * 导出指定分类的捕获
   */
  exportCategory(category, filename) {
    this._ensureDir();
    const filtered = this.getByCategory(category);
    const filePath = filename || path.join(this._logDir, `capture-${category}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      exportTime: new Date().toISOString(),
      category,
      totalCaptures: filtered.length,
      captures: filtered,
    }, null, 2), 'utf-8');
    return filePath;
  }

  clear() {
    this._captures = [];
  }

  getLogDir() {
    return this._logDir;
  }
}

module.exports = { ApiLogger };
