'use strict';

// 店铺/账号信息相关的纯解析函数。
// PddApiClient 通过传入 ctx (mallId/userId/shopName) 提供实例侧的兜底数据，
// 这里不直接访问任何实例状态。

function parseUserInfo(payload, ctx = {}) {
  const info = payload?.result || payload?.data || payload || {};
  return {
    mallId: info.mall_id || info.mallId || ctx.mallId || '',
    userId: info.uid || info.user_id || info.userId || ctx.userId || '',
    username: info.username || info.user_name || info.login_name || '',
    nickname: info.nick_name || info.nickname || info.name || '',
    mobile: info.mobile || '',
  };
}

function parseServiceProfile(payload, ctx = {}) {
  const info = payload?.result || payload?.data || payload || {};
  const mall = (info.mall && typeof info.mall === 'object') ? info.mall : {};
  return {
    mallId: info.mall_id || info.mallId || mall.mall_id || ctx.mallId || '',
    mallName: mall.mall_name || info.mall_name || ctx.shopName || '',
    username: info.username || info.user_name || info.login_name || '',
    serviceName: info.username || info.nickname || info.nick_name || info.name || '',
    serviceAvatar: mall.logo || info.avatar || info.head_img || '',
  };
}

function parseMallInfo(payload, ctx = {}) {
  const info = payload?.result || payload?.data || payload || {};
  const staple = Array.isArray(info.staple) ? info.staple : [];
  return {
    mallId: info.mall_id || info.mallId || ctx.mallId || '',
    mallName: info.mall_name || info.mallName || '',
    category: staple[0] || info.mall_category || info.category || '',
    logo: info.logo || '',
  };
}

function parseCredentialInfo(payload, ctx = {}) {
  const info = payload?.result || payload?.data || payload || {};
  const mallInfo = info.mallInfo && typeof info.mallInfo === 'object' ? info.mallInfo : {};
  const detail = info.queryDetailResult && typeof info.queryDetailResult === 'object' ? info.queryDetailResult : {};
  const enterprise = detail.enterprise && typeof detail.enterprise === 'object' ? detail.enterprise : {};
  return {
    mallId: mallInfo.id || detail.mallId || ctx.mallId || '',
    mallName: mallInfo.mallName || detail.mallName || '',
    companyName: mallInfo.companyName || enterprise.companyName || '',
    merchantType: detail.merchantType || '',
  };
}

module.exports = {
  parseUserInfo,
  parseServiceProfile,
  parseMallInfo,
  parseCredentialInfo,
};
