'use strict';

/**
 * 工单管理（含 strickland 客服工单 + mercury 售后单 + 物流地区）入口。
 *
 * 历史上这个文件把全部 25+ 业务方法和 10+ 个纯函数 helper 都堆在
 * 一个 1200+ 行的 class 里。现在已经按业务域拆成：
 * - parsers/ticket-helpers.js：纯函数（取值 / JSON / 列表清洗 / 模板存储）
 * - modules/ticket-list-module.js：strickland 工单列表 / 状态计数 / 详情
 * - modules/aftersale-refund-module.js：mercury 售后退款全部读写接口
 * - modules/shipping-module.js：地区 / 物流公司 / 聊天页发货详情
 *
 * 主类只保留三件事：
 *  1. 构造函数与 PddBusinessApiClient 共享配置；
 *  2. 与 _request 链路相关的 helper（Referer / 抓包模板 / 子 page-api 兜底）；
 *  3. 把外部调用按方法名委派给对应 module（保留原有方法签名，IPC 层不需要改）。
 */

const {
  normalizePddUserAgent,
  applyIdentityHeaders,
} = require('../pdd-request-profile');
const { PddBusinessApiClient } = require('../pdd-business-api-client');

const {
  isPlainObject,
  parseJsonSafely,
  pickHeaderCaseInsensitive,
} = require('./ticket-api/parsers/ticket-helpers');

const {
  TicketListModule,
  TICKET_LIST_URL,
  TICKET_STATUS_COUNT_URL,
  TICKET_DETAIL_URL,
} = require('./ticket-api/modules/ticket-list-module');

const {
  AftersaleRefundModule,
  REFUND_LIST_URL,
  REFUND_COUNT_URL,
  REFUND_GROUP_COUNT_URL,
} = require('./ticket-api/modules/aftersale-refund-module');

const {
  ShippingModule,
  REGION_GET_URL,
} = require('./ticket-api/modules/shipping-module');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_TICKET_URL = `${PDD_BASE}/aftersales/work_order/list?msfrom=mms_sidenav`;
const DEFAULT_AFTERSALE_URL = `${PDD_BASE}/aftersales/refund/list?msfrom=mms_sidenav`;

class TicketApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    const getTicketUrl = options.getTicketUrl || (() => DEFAULT_TICKET_URL);
    const getAfterSaleUrl = options.getAfterSaleUrl || (() => DEFAULT_AFTERSALE_URL);
    super(shopId, {
      ...options,
      getRefererUrl: getTicketUrl,
      errorLabel: '工单管理接口',
      loginExpiredMessage: '工单管理页面登录已失效，请重新导入 Token 或刷新登录态'
    });
    this._getTicketUrl = getTicketUrl;
    this._getAfterSaleUrl = getAfterSaleUrl;
    this._requestInPddPage = typeof options.requestInPddPage === 'function' ? options.requestInPddPage : null;

    this._ticketListModule = new TicketListModule(this);
    this._aftersaleRefundModule = new AftersaleRefundModule(this);
    this._shippingModule = new ShippingModule(this);
  }

  // ------- 共享请求/Referer/抓包模板 helpers -------

  // mercury 售后接口在服务端会根据 Referer 判断"是否来自售后页"，
  // strickland 工单 Referer（/aftersales/work_order/list）在它眼里会被当成会话失效，
  // 所以这里集中判定 mercury / antis 售后域名，让 Referer 切回售后页 URL。
  _isAfterSalePath(urlPath) {
    const path = String(urlPath || '');
    return path.startsWith('/mercury/mms/afterSales/')
      || path.startsWith('/mercury/after_sales/')
      || path.startsWith('/mercury/merchant/afterSales/')
      || path.startsWith('/mercury/negotiate/mms/afterSales/')
      || path.startsWith('/antis/api/refundAddress/');
  }

  _resolveRefererForPath(urlPath) {
    if (this._isAfterSalePath(urlPath)) {
      return this._getAfterSaleUrl() || DEFAULT_AFTERSALE_URL;
    }
    return this._getTicketUrl() || DEFAULT_TICKET_URL;
  }

  _findLatestTraffic(urlPart, predicate) {
    const list = this._getApiTrafficEntries();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (!String(item?.url || '').includes(urlPart)) continue;
      if (typeof predicate === 'function' && !predicate(item)) continue;
      return item;
    }
    return null;
  }

  _getTrafficRequestBody(urlPart, predicate) {
    const requestBody = this._findLatestTraffic(urlPart, predicate)?.requestBody;
    if (isPlainObject(requestBody)) return { ...requestBody };
    const parsed = parseJsonSafely(requestBody);
    return isPlainObject(parsed) ? parsed : null;
  }

  async _buildHeaders(urlPart, extraHeaders = {}) {
    const trafficHeaders = this._findLatestTraffic(urlPart)?.requestHeaders || {};
    const referer = pickHeaderCaseInsensitive(trafficHeaders, ['referer', 'Referer']);
    const antiContent = pickHeaderCaseInsensitive(trafficHeaders, ['anti-content', 'anti_content', 'Anti-Content']);
    const csrfToken = pickHeaderCaseInsensitive(trafficHeaders, ['x-csrf-token', 'x-csrftoken', 'x-csrf', 'X-CSRF-Token']);
    const requestedWith = pickHeaderCaseInsensitive(trafficHeaders, ['x-requested-with', 'X-Requested-With']);
    const headers = await super._buildHeaders(urlPart, {
      Referer: referer || this._resolveRefererForPath(urlPart),
      ...extraHeaders
    });
    if (antiContent) headers['anti-content'] = antiContent;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    if (requestedWith) headers['x-requested-with'] = requestedWith;
    return headers;
  }

  async _request(method, urlPath, body, extraHeaders = {}, requestOptions = {}) {
    const source = String(requestOptions?.source || 'ticket-api').trim() || 'ticket-api';
    const allowPageRequest = requestOptions.allowPageRequest !== false;
    const shouldTryPageRequest = allowPageRequest && !!this._requestInPddPage && (
      urlPath === TICKET_LIST_URL
      || urlPath === TICKET_STATUS_COUNT_URL
      || urlPath === TICKET_DETAIL_URL
      || urlPath === REFUND_LIST_URL
      || urlPath === REFUND_COUNT_URL
      || urlPath === REFUND_GROUP_COUNT_URL
      || urlPath.startsWith('/antis/api/refundAddress/')
      || urlPath.startsWith('/mercury/mms/afterSales/')
      || urlPath.startsWith('/mercury/after_sales/')
      || urlPath.startsWith(REGION_GET_URL)
      || urlPath.startsWith('/express_base/')
      || urlPath.startsWith('/express_wbfrontend/')
    );
    await this._ensureMainCookieContextIfNeeded();
    if (shouldTryPageRequest) {
      try {
        const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
        const tokenInfo = this._getTokenInfo();
        const shop = this._getShopInfo();
        const baseHeaders = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
        };
        const ua = normalizePddUserAgent(shop?.userAgent || tokenInfo?.userAgent || '');
        if (ua) baseHeaders['user-agent'] = ua;
        applyIdentityHeaders(baseHeaders, tokenInfo);
        const refererForPath = this._resolveRefererForPath(urlPath);
        const payload = await this._requestInPddPage({
          url,
          method,
          source,
          headers: { ...baseHeaders, ...extraHeaders },
          referrer: refererForPath,
          body: body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
        });
        if (typeof payload === 'string') {
          const snippet = payload.slice(0, 800).toLowerCase();
          if (snippet.includes('<html') || snippet.includes('登录') || snippet.includes('passport') || snippet.includes('扫码')) {
            throw new Error('工单管理页面登录已失效，请重新导入 Token 或刷新登录态');
          }
        }
        const businessError = this._normalizeBusinessError(payload);
        if (businessError) {
          throw new Error(businessError.message);
        }
        return payload;
      } catch (error) {
        this._log(`[工单管理接口] PAGE ${method} ${urlPath} -> ${error?.message || 'FAILED'}`, { source });
      }
    }
    const url = urlPath.startsWith('http') ? urlPath : `${PDD_BASE}${urlPath}`;
    const headers = await this._buildHeaders(urlPath, extraHeaders);
    const options = { method, headers };
    if (body !== undefined && body !== null) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await this._getSession().fetch(url, options);
    const text = await response.text();
    const payload = this._parsePayload(text);
    this._log(`[工单管理接口] ${method} ${urlPath} -> ${response.status}`, { source });
    if (this._isLoginPageResponse(response, text)) {
      throw new Error('工单管理页面登录已失效，请重新导入 Token 或刷新登录态');
    }
    if (!response.ok) {
      throw new Error(typeof payload === 'object'
        ? payload?.error_msg || payload?.errorMsg || payload?.message || `HTTP ${response.status}`
        : `HTTP ${response.status}: ${String(text).slice(0, 200)}`);
    }
    const businessError = this._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message);
    }
    return payload;
  }

  // ------- 委派给 strickland 工单模块 -------

  getList(params, options) {
    return this._ticketListModule.getList(params, options);
  }

  getStatusCount(options) {
    return this._ticketListModule.getStatusCount(options);
  }

  getDetail(params, options) {
    return this._ticketListModule.getDetail(params, options);
  }

  // ------- 委派给 mercury 售后模块 -------

  getRefundList(params, options) {
    return this._aftersaleRefundModule.getRefundList(params, options);
  }

  getRefundCount(params, options) {
    return this._aftersaleRefundModule.getRefundCount(params, options);
  }

  getRefundGroupCount(params) {
    return this._aftersaleRefundModule.getRefundGroupCount(params);
  }

  listRefundAddresses(params, options) {
    return this._aftersaleRefundModule.listRefundAddresses(params, options);
  }

  approveReturnGoods(params, options) {
    return this._aftersaleRefundModule.approveReturnGoods(params, options);
  }

  approveResend(params, options) {
    return this._aftersaleRefundModule.approveResend(params, options);
  }

  agreeRefundPreCheck(params, options) {
    return this._aftersaleRefundModule.agreeRefundPreCheck(params, options);
  }

  rejectRefundPreCheck(params, options) {
    return this._aftersaleRefundModule.rejectRefundPreCheck(params, options);
  }

  rejectRefundGetFormInfo(params, options) {
    return this._aftersaleRefundModule.rejectRefundGetFormInfo(params, options);
  }

  getRejectRefundNegotiateInfo(params, options) {
    return this._aftersaleRefundModule.getRejectRefundNegotiateInfo(params, options);
  }

  rejectRefundSubmit(params, options) {
    return this._aftersaleRefundModule.rejectRefundSubmit(params, options);
  }

  rejectRefundGetReasons(params, options) {
    return this._aftersaleRefundModule.rejectRefundGetReasons(params, options);
  }

  rejectRefundValidate(params, options) {
    return this._aftersaleRefundModule.rejectRefundValidate(params, options);
  }

  merchantAfterSalesRefuse(params, options) {
    return this._aftersaleRefundModule.merchantAfterSalesRefuse(params, options);
  }

  // ------- 委派给物流地区模块 -------

  getRegionChildren(params, options) {
    return this._shippingModule.getRegionChildren(params, options);
  }

  getShippingCompanyList(params, options) {
    return this._shippingModule.getShippingCompanyList(params, options);
  }

  getChatShippingDetail(params, options) {
    return this._shippingModule.getChatShippingDetail(params, options);
  }
}

module.exports = { TicketApiClient };
