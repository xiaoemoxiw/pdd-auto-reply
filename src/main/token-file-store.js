const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

class TokenFileStore {
  constructor(store, options = {}) {
    this.store = store;
    this.baseDir = options.baseDir || path.join(app.getPath('userData'), 'shop-tokens');
  }

  getManagedDir() {
    return this.baseDir;
  }

  ensureManagedDir() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    return this.baseDir;
  }

  bootstrapFromDirectory(sourceDir) {
    if (!sourceDir || !fs.existsSync(sourceDir)) return 0;
    const existing = this._listJsonFiles(this.ensureManagedDir());
    if (existing.length > 0) return 0;
    let imported = 0;
    for (const filePath of this._listJsonFiles(sourceDir)) {
      this.importTokenFile(filePath);
      imported++;
    }
    return imported;
  }

  importTokenFile(filePath) {
    const record = this.readTokenFile(filePath);
    const targetPath = path.join(this.ensureManagedDir(), `${record.shopId}.json`);
    fs.writeFileSync(targetPath, JSON.stringify(record.tokenData, null, 2) + '\n', 'utf-8');
    return this.readTokenFile(targetPath);
  }

  listTokenRecords() {
    return this._listJsonFiles(this.ensureManagedDir())
      .map(filePath => this.readTokenFile(filePath))
      .sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'));
  }

  findRecordByShopId(shopId) {
    return this.listTokenRecords().find(item => item.shopId === shopId) || null;
  }

  removeTokenFile(shopId) {
    const record = this.findRecordByShopId(shopId);
    if (!record) return false;
    fs.unlinkSync(record.filePath);
    return true;
  }

  readTokenFile(filePath) {
    const tokenData = this._readTokenJson(filePath);
    const stats = fs.statSync(filePath);
    const tokenInfo = this._buildTokenInfo(tokenData);
    const shopId = this._buildShopId(tokenInfo, tokenData, filePath);
    return {
      shopId,
      filePath,
      fileName: path.basename(filePath),
      updatedAt: stats.mtimeMs || 0,
      bindTime: this._formatDate(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now()),
      tokenData,
      tokenInfo
    };
  }

  _listJsonFiles(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter(fileName => fileName.toLowerCase().endsWith('.json'))
      .map(fileName => path.join(dirPath, fileName))
      .filter(filePath => fs.statSync(filePath).isFile());
  }

  _readTokenJson(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  }

  _buildTokenInfo(tokenData = {}) {
    let mallId = '';
    let userId = '';
    let token = '';
    if (tokenData.windowsAppShopToken) {
      try {
        const decoded = JSON.parse(Buffer.from(tokenData.windowsAppShopToken, 'base64').toString());
        mallId = decoded.m ? String(decoded.m) : '';
        userId = decoded.u ? String(decoded.u) : '';
        token = decoded.t || '';
      } catch {}
    }
    return {
      token,
      mallId,
      userId,
      raw: tokenData.windowsAppShopToken || '',
      userAgent: tokenData.userAgent || '',
      pddid: tokenData.pddid || ''
    };
  }

  _buildShopId(tokenInfo = {}, tokenData = {}, filePath = '') {
    if (tokenInfo.mallId) {
      return `shop_${String(tokenInfo.mallId).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    }
    const fallback = tokenInfo.raw || JSON.stringify(tokenData) || filePath || Date.now().toString();
    const hash = crypto.createHash('md5').update(fallback).digest('hex').slice(0, 12);
    return `shop_${hash}`;
  }

  _formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return new Date().toISOString().split('T')[0];
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

module.exports = { TokenFileStore };
