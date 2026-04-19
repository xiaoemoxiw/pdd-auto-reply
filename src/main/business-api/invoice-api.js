'use strict';

/**
 * 待开票（发票管理）入口。
 *
 * 已经按 modules + parsers 模式拆分：
 * - parsers/invoice-parsers.js：字段拾取 / 金额归一化 / 状态文案 / 列表/详情/概览归一化
 * - modules/invoice-list-module.js：getOverview / getList / getDetail（含详情缓存与 1.5s 节流）
 * - modules/invoice-submit-module.js：submitInvoiceRecord 全链路（抓包识别 / 上传 / 解析 / JSON 提交）
 *
 * 主类只剩两件事：
 *  1. 构造 InvoiceApiClient 时把 PddBusinessApiClient 公共 errorLabel /
 *     loginExpiredMessage 配好，沿用基类的 _request、_requestForm；
 *  2. 把外部既有的 4 个 API（getOverview / getList / getDetail /
 *     submitInvoiceRecord）按方法名透传到对应 module，IPC 层无需变更。
 */

const { PddBusinessApiClient } = require('../pdd-business-api-client');
const { InvoiceListModule } = require('./invoice-api/modules/invoice-list-module');
const { InvoiceSubmitModule } = require('./invoice-api/modules/invoice-submit-module');

const PDD_BASE = 'https://mms.pinduoduo.com';
const DEFAULT_INVOICE_URL = `${PDD_BASE}/invoice/center?msfrom=mms_sidenav&activeKey=0`;

class InvoiceApiClient extends PddBusinessApiClient {
  constructor(shopId, options = {}) {
    const getInvoiceUrl = options.getInvoiceUrl || (() => DEFAULT_INVOICE_URL);
    super(shopId, {
      ...options,
      getRefererUrl: getInvoiceUrl,
      errorLabel: '待开票接口',
      loginExpiredMessage: '待开票页面登录已失效，请重新导入 Token 或刷新登录态'
    });
    this._getInvoiceUrl = getInvoiceUrl;

    this._listModule = new InvoiceListModule(this);
    this._submitModule = new InvoiceSubmitModule(this, {
      getSubmitConfig: options.getSubmitConfig || (() => null),
      setSubmitConfig: options.setSubmitConfig || (() => {}),
    });
  }

  getOverview() {
    return this._listModule.getOverview();
  }

  getList(params) {
    return this._listModule.getList(params);
  }

  getDetail(params) {
    return this._listModule.getDetail(params);
  }

  submitInvoiceRecord(params) {
    return this._submitModule.submitInvoiceRecord(params);
  }
}

module.exports = { InvoiceApiClient };
