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
      const result = this.importTokenFile(filePath);
      imported += result.records?.length || 0;
    }
    return imported;
  }

  importTokenFile(filePath) {
    const tokenData = this._readTokenJson(filePath);
    const importPlan = this._buildImportPlan(filePath, tokenData);
    const records = importPlan.records.map(record => {
      const targetPath = path.join(this.ensureManagedDir(), `${record.shopId}.json`);
      fs.writeFileSync(targetPath, JSON.stringify(record.tokenData, null, 2) + '\n', 'utf-8');
      return this.readTokenFile(targetPath);
    });
    return {
      filePath,
      fileName: path.basename(filePath),
      tokenData,
      tokenInfo: this._buildTokenInfo(tokenData),
      records,
      hasShopMetadata: importPlan.hasShopMetadata,
      eligibleShopCount: importPlan.eligibleShopCount,
      skippedShopCount: importPlan.skippedShopCount,
      skippedNoPassCookieCount: importPlan.skippedNoPassCookieCount
    };
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
    const passEntries = this._extractPassIdEntries(tokenData);
    if (passEntries.length === 1) {
      mallId = passEntries[0].mallId || mallId;
      userId = passEntries[0].userId || userId;
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

  _extractPassIdEntries(tokenData = {}) {
    if (!Array.isArray(tokenData.mallCookies)) return [];
    const entries = [];
    const seen = new Set();
    for (const cookieStr of tokenData.mallCookies) {
      if (typeof cookieStr !== 'string' || !cookieStr.startsWith('PASS_ID=')) continue;
      const eqIdx = cookieStr.indexOf('=');
      const passId = eqIdx >= 0 ? cookieStr.slice(eqIdx + 1).trim() : '';
      const matched = passId.match(/_(\d+)_(\d+)$/);
      if (!matched) continue;
      const mallId = matched[1];
      const userId = matched[2];
      const key = `${mallId}:${userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ cookieStr, passId, mallId, userId });
    }
    return entries;
  }

  _extractShopEntries(tokenData = {}) {
    if (!Array.isArray(tokenData.shops)) return [];
    return tokenData.shops
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        mallId: item.mallId ? String(item.mallId).trim() : '',
        mallName: String(item.mallName || '').trim(),
        loginStatus: String(item.loginStatus || '').trim(),
        isActive: item.isActive === true,
        passId: this._normalizePassCookieString(item.passId || '')
      }));
  }

  _normalizePassCookieString(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.startsWith('PASS_ID=')) return text;
    return `PASS_ID=${text}`;
  }

  _pickPassCookieForShop(shopEntry, activeEntries = [], allEntries = []) {
    const targetMallId = String(shopEntry?.mallId || '').trim();
    const targetPassCookie = this._normalizePassCookieString(shopEntry?.passId || '');
    const activeByMallId = new Map(activeEntries.map(entry => [entry.mallId, entry]));
    const allByMallId = new Map(allEntries.map(entry => [entry.mallId, entry]));

    if (targetPassCookie && activeEntries.some(entry => entry.cookieStr === targetPassCookie)) {
      return targetPassCookie;
    }
    if (targetPassCookie && allEntries.some(entry => entry.cookieStr === targetPassCookie)) {
      return targetPassCookie;
    }
    if (targetMallId && activeByMallId.has(targetMallId)) {
      return activeByMallId.get(targetMallId).cookieStr;
    }
    if (targetMallId && allByMallId.has(targetMallId)) {
      return allByMallId.get(targetMallId).cookieStr;
    }
    return '';
  }

  _buildImportPlan(filePath, tokenData = {}) {
    const records = this._buildImportRecords(filePath, tokenData);
    const shopEntries = this._extractShopEntries(tokenData);
    const hasShopMetadata = shopEntries.length > 0;
    const eligibleShopCount = hasShopMetadata
      ? shopEntries.filter(item => item.loginStatus === '已登录').length
      : records.length;
    return {
      records,
      hasShopMetadata,
      eligibleShopCount,
      skippedShopCount: hasShopMetadata ? Math.max(0, shopEntries.length - eligibleShopCount) : 0,
      skippedNoPassCookieCount: hasShopMetadata ? Math.max(0, eligibleShopCount - records.length) : 0
    };
  }

  _buildImportRecords(filePath, tokenData = {}) {
    const stats = fs.statSync(filePath);
    const passEntries = this._extractPassIdEntries(tokenData);
    const activePassEntries = this._extractPassIdEntries({
      mallCookies: Array.isArray(tokenData.activeMallCookies) ? tokenData.activeMallCookies : []
    });
    const shopEntries = this._extractShopEntries(tokenData);
    const bindTime = this._formatDate(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now());
    if (shopEntries.length > 0) {
      return shopEntries
        .filter(entry => entry.loginStatus === '已登录')
        .map(entry => {
          const passCookie = this._pickPassCookieForShop(entry, activePassEntries, passEntries);
          if (!passCookie) return null;
          const nextTokenData = {
            ...tokenData,
            mallCookies: [passCookie],
            activeMallCookies: [passCookie],
            shops: [{
              mallId: entry.mallId,
              mallName: entry.mallName,
              loginStatus: entry.loginStatus,
              isActive: entry.isActive,
              passId: passCookie
            }]
          };
          const tokenInfo = this._buildTokenInfo(nextTokenData);
          const shopId = this._buildShopId(tokenInfo, nextTokenData, `${filePath}#${entry.mallId || passCookie}`);
          return {
            shopId,
            filePath,
            fileName: path.basename(filePath),
            updatedAt: stats.mtimeMs || 0,
            bindTime,
            tokenData: nextTokenData,
            tokenInfo
          };
        })
        .filter(Boolean);
    }
    if (passEntries.length > 1) {
      return passEntries.map(entry => {
        const nextTokenData = {
          ...tokenData,
          mallCookies: [entry.cookieStr]
        };
        const tokenInfo = this._buildTokenInfo(nextTokenData);
        const shopId = this._buildShopId(tokenInfo, nextTokenData, `${filePath}#${entry.mallId}`);
        return {
          shopId,
          filePath,
          fileName: path.basename(filePath),
          updatedAt: stats.mtimeMs || 0,
          bindTime,
          tokenData: nextTokenData,
          tokenInfo
        };
      });
    }
    const tokenInfo = this._buildTokenInfo(tokenData);
    const shopId = this._buildShopId(tokenInfo, tokenData, filePath);
    return [{
      shopId,
      filePath,
      fileName: path.basename(filePath),
      updatedAt: stats.mtimeMs || 0,
      bindTime,
      tokenData,
      tokenInfo
    }];
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
