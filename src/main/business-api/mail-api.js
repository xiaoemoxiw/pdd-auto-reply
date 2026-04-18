const { PddBusinessApiClient, DEFAULT_PDD_BASE } = require('./pdd-business-api-client');

const PDD_BASE = DEFAULT_PDD_BASE;
const DEFAULT_MAIL_URL = `${PDD_BASE}/other/mail/mailList?type=-1&id=441077635572`;

const MAIL_CATEGORIES = [
  { contentType: -1, label: '全部' },
  { contentType: 5, label: '重要通知' },
  { contentType: 1, label: '平台动态' },
  { contentType: 3, label: '违规通知' },
  { contentType: 2, label: '规则更新' },
  { contentType: 4, label: '营销推广' },
  { contentType: 0, label: '店铺动态' },
  { contentType: 6, label: '商家成长' },
  { contentType: 10, label: '规则弹窗' },
];

class MailApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    const getMailUrl = typeof options.getMailUrl === 'function' ? options.getMailUrl : (() => DEFAULT_MAIL_URL);
    super(shopId, {
      ...options,
      errorLabel: '站内信接口',
      loginExpiredMessage: '站内信页面登录已失效，请重新导入 Token 或刷新登录态',
      getRefererUrl: () => getMailUrl() || DEFAULT_MAIL_URL,
    });
  }

  _stripHtml(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  _normalizeCategoryUnread(unreadList, totalNum, unreadNum) {
    const unreadMap = new Map((Array.isArray(unreadList) ? unreadList : []).map(item => [Number(item.contentType), Number(item.unreadCount || 0)]));
    return MAIL_CATEGORIES.map(item => ({
      contentType: item.contentType,
      label: item.label,
      unreadCount: item.contentType === -1 ? Number(unreadNum || 0) : Number(unreadMap.get(item.contentType) || 0),
      totalCount: item.contentType === -1 ? Number(totalNum || 0) : null,
    }));
  }

  _normalizeListItem(item) {
    const contentType = Number(item?.contentType ?? -1);
    const category = MAIL_CATEGORIES.find(entry => entry.contentType === contentType);
    return {
      messageId: String(item?.messageId || ''),
      title: String(item?.title || '未命名站内信'),
      summary: this._stripHtml(item?.content || ''),
      contentType,
      contentTypeName: category?.label || `类型 ${contentType}`,
      sendTime: Number(item?.sendTime || 0),
      readStatus: item?.readStatus ?? null,
      readTime: Number(item?.readTime || 0),
      attachmentCount: Array.isArray(item?.attachmentList) ? item.attachmentList.length : 0,
    };
  }

  _normalizeDetail(item) {
    const contentType = Number(item?.contentType ?? -1);
    const category = MAIL_CATEGORIES.find(entry => entry.contentType === contentType);
    return {
      messageId: String(item?.messageId || ''),
      title: String(item?.title || '未命名站内信'),
      contentHtml: String(item?.content || ''),
      contentText: this._stripHtml(item?.content || ''),
      contentType,
      contentTypeName: category?.label || `类型 ${contentType}`,
      sendTime: Number(item?.sendTime || 0),
      readStatus: item?.readStatus ?? null,
      readTime: Number(item?.readTime || 0),
      attachmentList: Array.isArray(item?.attachmentList) ? item.attachmentList : [],
    };
  }

  async getOverview() {
    const [statsPayload, unreadPayload, msgBoxPayload, msgBoxTotalPayload] = await Promise.all([
      this._request('POST', '/newjersy/api/innerMessage/queryStaticsByUserId', {}),
      this._request('POST', '/newjersy/api/innerMessage/queryUnreadCountForType', {}),
      this._request('POST', '/newjersy/api/msgBox/v1/latestMsgBoxAndInnerMsg', { type: 'normal' }),
      this._request('GET', '/newjersy/api/msgBox/v1/total?type=normal'),
    ]);
    const stats = statsPayload?.result || {};
    const unread = unreadPayload?.result || {};
    const msgBox = msgBoxPayload?.result || {};
    const msgBoxTotal = msgBoxTotalPayload?.result || {};
    return {
      userId: Number(stats.userId || 0),
      totalNum: Number(stats.totalNum || 0),
      unreadNum: Number(stats.unreadNum || 0),
      categories: this._normalizeCategoryUnread(unread.list, stats.totalNum, stats.unreadNum),
      msgBoxCount: Number(msgBox.msgBoxCount || 0),
      innerMsgCount: Number(msgBox.innerMsgCount || 0),
      normalTotal: Number(msgBoxTotal.total || 0),
      customSubMsgTypeList: Array.isArray(msgBoxTotal.customConfig?.customSubMsgTypeList)
        ? msgBoxTotal.customConfig.customSubMsgTypeList
        : [],
    };
  }

  async getList(params = {}) {
    const pageNum = Math.max(1, Number(params.pageNum || 1));
    const size = Math.max(1, Number(params.size || 40));
    const contentType = Number(params.contentType ?? -1);
    const hasReadStatus = params.readStatus === 0 || params.readStatus === 1 || params.readStatus === '0' || params.readStatus === '1';
    const readStatus = hasReadStatus ? Number(params.readStatus) : undefined;
    const bodies = contentType === -1
      ? [{ pageNum, size }, { pageNum, size, contentType: -1 }]
      : [{ pageNum, size, contentType }];
    const requestBodies = bodies.map(body => (readStatus === undefined ? body : { ...body, readStatus }));
    let payload = null;
    let lastError = null;
    for (const body of requestBodies) {
      try {
        const nextPayload = await this._request('POST', '/newjersy/api/innerMessage/queryMsgListForMerchant', body);
        const nextResult = nextPayload?.result || {};
        const nextList = Array.isArray(nextResult.msgList) ? nextResult.msgList : [];
        const nextTotalCount = Number(nextResult.totalCount || 0);
        payload = nextPayload;
        if (contentType !== -1 || nextList.length > 0 || nextTotalCount > 0) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payload && lastError) throw lastError;
    const result = payload?.result || {};
    const list = Array.isArray(result.msgList) ? result.msgList.map(item => this._normalizeListItem(item)) : [];
    return {
      contentType,
      pageNum: Number(result.pageNum || pageNum),
      size: Number(result.size || size),
      totalCount: Number(result.totalCount || 0),
      list,
    };
  }

  async getDetail(messageId) {
    if (!messageId) throw new Error('缺少 messageId');
    const payload = await this._request('POST', '/newjersy/api/innerMessage/queryMessageForMerchant', {
      messageId: String(messageId),
    });
    const item = payload?.result?.innerMessageVO || payload?.result || {};
    return this._normalizeDetail(item);
  }
}

module.exports = { MailApiClient, MAIL_CATEGORIES };
