const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pddApi', {
  // 规则管理
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (rules) => ipcRenderer.invoke('save-rules', rules),
  resetRules: () => ipcRenderer.invoke('reset-rules'),
  testRule: (message) => ipcRenderer.invoke('test-rule', message),

  // 自动回复开关
  getAutoReplyEnabled: () => ipcRenderer.invoke('get-auto-reply-enabled'),
  setAutoReplyEnabled: (enabled) => ipcRenderer.invoke('set-auto-reply-enabled', enabled),

  // 兜底回复
  getDefaultReply: () => ipcRenderer.invoke('get-default-reply'),
  saveDefaultReply: (config) => ipcRenderer.invoke('save-default-reply', config),

  // 话术库
  getSystemPhrases: () => ipcRenderer.invoke('get-system-phrases'),
  getPhraseCategories: () => ipcRenderer.invoke('get-phrase-categories'),
  getPhraseLibrary: () => ipcRenderer.invoke('get-phrase-library'),
  savePhraseLibrary: (phrases) => ipcRenderer.invoke('save-phrase-library', phrases),
  addPhraseToFallback: (text) => ipcRenderer.invoke('add-phrase-to-fallback', text),
  addPhraseToScene: (data) => ipcRenderer.invoke('add-phrase-to-scene', data),

  // 未匹配消息记录
  getUnmatchedLog: () => ipcRenderer.invoke('get-unmatched-log'),
  clearUnmatchedLog: () => ipcRenderer.invoke('clear-unmatched-log'),

  // 店铺管理（列表/分组）
  getShops: () => ipcRenderer.invoke('get-shops'),
  saveShops: (shops) => ipcRenderer.invoke('save-shops', shops),
  getShopGroups: () => ipcRenderer.invoke('get-shop-groups'),
  saveShopGroups: (groups) => ipcRenderer.invoke('save-shop-groups', groups),

  // 多店铺管理
  getActiveShop: () => ipcRenderer.invoke('get-active-shop'),
  switchShop: (shopId) => ipcRenderer.invoke('switch-shop', shopId),
  addShopByToken: () => ipcRenderer.invoke('add-shop-by-token'),
  addShopByTokenPath: (path) => ipcRenderer.invoke('add-shop-by-token-path', path),
  addShopByQRCode: () => ipcRenderer.invoke('add-shop-by-qrcode'),
  removeShop: (shopId) => ipcRenderer.invoke('remove-shop', shopId),
  refreshShopProfile: (shopId) => ipcRenderer.invoke('refresh-shop-profile', shopId),
  refreshMainCookieContext: (params) => ipcRenderer.invoke('refresh-main-cookie-context', params),

  // 视图切换
  switchView: (view) => ipcRenderer.invoke('switch-view', view),
  getCurrentView: () => ipcRenderer.invoke('get-current-view'),

  // 窗口操作
  openSettings: () => ipcRenderer.invoke('open-settings'),
  openDevTools: () => ipcRenderer.invoke('open-devtools'),
  reloadPdd: () => ipcRenderer.invoke('reload-pdd'),
  navigatePdd: (url) => ipcRenderer.invoke('navigate-pdd', url),

  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('write-clipboard-text', text),

  // 客服页面 URL 管理
  getChatUrl: () => ipcRenderer.invoke('get-chat-url'),
  setChatUrl: (url) => ipcRenderer.invoke('set-chat-url', url),
  getMailUrl: () => ipcRenderer.invoke('get-mail-url'),
  setMailUrl: (url) => ipcRenderer.invoke('set-mail-url', url),
  getInvoiceUrl: () => ipcRenderer.invoke('get-invoice-url'),
  setInvoiceUrl: (url) => ipcRenderer.invoke('set-invoice-url', url),
  openInvoiceOrderOverlay: (params) => ipcRenderer.invoke('open-invoice-order-overlay', params),
  closeEmbeddedOverlay: () => ipcRenderer.invoke('close-embedded-overlay'),
  getViolationUrl: () => ipcRenderer.invoke('get-violation-url'),
  setViolationUrl: (url) => ipcRenderer.invoke('set-violation-url', url),
  getTicketUrl: () => ipcRenderer.invoke('get-ticket-url'),
  setTicketUrl: (url) => ipcRenderer.invoke('set-ticket-url', url),
  getAfterSaleUrl: () => ipcRenderer.invoke('get-aftersale-url'),
  setAfterSaleUrl: (url) => ipcRenderer.invoke('set-aftersale-url', url),
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),

  // Cookie 注入
  injectCookies: (cookies) => ipcRenderer.invoke('inject-cookies', cookies),

  // Token 导入（兼容旧接口，内部走 ShopManager）
  importTokenFile: () => ipcRenderer.invoke('import-token-file'),
  importTokenFromPath: (path) => ipcRenderer.invoke('import-token-from-path', path),
  getTokenInfo: () => ipcRenderer.invoke('get-token-info'),
  apiGetTokenStatus: (params) => ipcRenderer.invoke('api-get-token-status', params),
  apiInitSession: () => ipcRenderer.invoke('api-init-session'),
  apiTestConnection: (params) => ipcRenderer.invoke('api-test-connection', params),
  apiGetSessions: (params) => ipcRenderer.invoke('api-get-sessions', params),
  apiFindSessionByOrderSn: (params) => ipcRenderer.invoke('api-find-session-by-order-sn', params),
  apiGetMessages: (params) => ipcRenderer.invoke('api-get-messages', params),
  apiGetGoodsCard: (params) => ipcRenderer.invoke('api-get-goods-card', params),
  apiGetRefundOrders: (params) => ipcRenderer.invoke('api-get-refund-orders', params),
  apiSubmitRefundApply: (params) => ipcRenderer.invoke('api-submit-refund-apply', params),
  apiGetSideOrders: (params) => ipcRenderer.invoke('api-get-side-orders', params),
  apiGetInviteOrderState: (params) => ipcRenderer.invoke('api-get-invite-order-state', params),
  apiGetInviteOrderSkuOptions: (params) => ipcRenderer.invoke('api-get-invite-order-sku-options', params),
  apiAddInviteOrderItem: (params) => ipcRenderer.invoke('api-add-invite-order-item', params),
  apiClearInviteOrderItems: (params) => ipcRenderer.invoke('api-clear-invite-order-items', params),
  apiSubmitInviteOrder: (params) => ipcRenderer.invoke('api-submit-invite-order', params),
  apiSubmitInviteFollow: (params) => ipcRenderer.invoke('api-submit-invite-follow', params),
  apiGetSmallPaymentInfo: (params) => ipcRenderer.invoke('api-get-small-payment-info', params),
  apiSubmitSmallPayment: (params) => ipcRenderer.invoke('api-submit-small-payment', params),
  apiGetOrderRemark: (params) => ipcRenderer.invoke('api-get-order-remark', params),
  apiGetOrderRemarkTags: (params) => ipcRenderer.invoke('api-get-order-remark-tags', params),
  apiSaveOrderRemark: (params) => ipcRenderer.invoke('api-save-order-remark', params),
  apiUpdateOrderPrice: (params) => ipcRenderer.invoke('api-update-order-price', params),
  apiSendMessage: (params) => ipcRenderer.invoke('api-send-message', params),
  apiSelectImage: () => ipcRenderer.invoke('api-select-image'),
  apiSendImage: (params) => ipcRenderer.invoke('api-send-image', params),
  apiSelectVideo: () => ipcRenderer.invoke('api-select-video'),
  apiUploadVideo: (params) => ipcRenderer.invoke('api-upload-video', params),
  apiGetVideoLibrary: (params) => ipcRenderer.invoke('api-get-video-library', params),
  apiSendVideo: (params) => ipcRenderer.invoke('api-send-video', params),
  apiMarkLatestConversations: (params) => ipcRenderer.invoke('api-mark-latest-conversations', params),
  apiStartPolling: (params) => ipcRenderer.invoke('api-start-polling', params),
  apiStopPolling: (params) => ipcRenderer.invoke('api-stop-polling', params),
  getApiTraffic: (params) => ipcRenderer.invoke('get-api-traffic', params),
  clearApiTraffic: (params) => ipcRenderer.invoke('clear-api-traffic', params),
  mailGetOverview: (params) => ipcRenderer.invoke('mail-get-overview', params),
  mailGetList: (params) => ipcRenderer.invoke('mail-get-list', params),
  mailGetDetail: (params) => ipcRenderer.invoke('mail-get-detail', params),
  invoiceGetOverview: (params) => ipcRenderer.invoke('invoice-get-overview', params),
  invoiceGetList: (params) => ipcRenderer.invoke('invoice-get-list', params),
  invoiceGetDetail: (params) => ipcRenderer.invoke('invoice-get-detail', params),
  invoiceSubmitRecord: (params) => ipcRenderer.invoke('invoice-submit-record', params),
  aftersaleGetOverview: (params) => ipcRenderer.invoke('aftersale-get-overview', params),
  aftersaleGetList: (params) => ipcRenderer.invoke('aftersale-get-list', params),
  aftersaleGetRegions: (params) => ipcRenderer.invoke('aftersale-get-regions', params),
  aftersaleGetShippingCompanies: (params) => ipcRenderer.invoke('aftersale-get-shipping-companies', params),
  aftersaleGetShippingDetail: (params) => ipcRenderer.invoke('aftersale-get-shipping-detail', params),
  aftersaleListRefundAddresses: (params) => ipcRenderer.invoke('aftersale-list-refund-addresses', params),
  aftersaleApproveReturnGoods: (params) => ipcRenderer.invoke('aftersale-approve-return-goods', params),
  aftersaleApproveResend: (params) => ipcRenderer.invoke('aftersale-approve-resend', params),
  aftersaleAgreeRefundPreCheck: (params) => ipcRenderer.invoke('aftersale-agree-refund-precheck', params),
  ticketGetList: (params) => ipcRenderer.invoke('ticket-get-list', params),
  ticketGetDetail: (params) => ipcRenderer.invoke('ticket-get-detail', params),
  violationGetList: (params) => ipcRenderer.invoke('violation-get-list', params),
  violationGetDetail: (params) => ipcRenderer.invoke('violation-get-detail', params),
  deductionGetList: (params) => ipcRenderer.invoke('deduction-get-list', params),
  getApiStarredSessions: () => ipcRenderer.invoke('get-api-starred-sessions'),
  getLastApiSessionSelection: () => ipcRenderer.invoke('get-last-api-session-selection'),
  setLastApiSessionSelection: (selection) => ipcRenderer.invoke('set-last-api-session-selection', selection),
  clearLastApiSessionSelection: () => ipcRenderer.invoke('clear-last-api-session-selection'),
  toggleApiStarredSession: (session) => ipcRenderer.invoke('toggle-api-starred-session', session),

  // 快捷短语
  getQuickPhrases: () => ipcRenderer.invoke('get-quick-phrases'),
  saveQuickPhrases: (phrases) => ipcRenderer.invoke('save-quick-phrases', phrases),
  sendQuickPhrase: (text) => ipcRenderer.invoke('send-quick-phrase', text),

  // 考试
  getExamQuestions: () => ipcRenderer.invoke('get-exam-questions'),
  submitExam: (answers) => ipcRenderer.invoke('submit-exam', answers),

  // 批量绑定
  scanShops: () => ipcRenderer.invoke('scan-shops'),
  bindShops: (shops) => ipcRenderer.invoke('bind-shops', shops),

  // 调试窗口
  openDebugWindow: () => ipcRenderer.invoke('open-debug-window'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  openAfterSaleDetailWindow: (params) => ipcRenderer.invoke('aftersale-open-detail-window', params),
  openInvoiceOrderDetailWindow: (params) => ipcRenderer.invoke('invoice-open-order-detail-window', params),
  openTicketTodoDetailWindow: (params) => ipcRenderer.invoke('ticket-open-todo-detail-window', params),
  openViolationInfoWindow: (params) => ipcRenderer.invoke('violation-open-info-window', params),
  debugLog: (payload) => ipcRenderer.send('renderer-debug-log', payload),
  toggleNetworkMonitor: (enabled) => ipcRenderer.invoke('toggle-network-monitor', enabled),
  getNetworkMonitorStatus: () => ipcRenderer.invoke('get-network-monitor-status'),

  // 授权验证
  verifyLicense: (params) => ipcRenderer.invoke('license:verify', params),
  getLicenseData: () => ipcRenderer.invoke('license:get-data'),
  checkLicense: () => ipcRenderer.invoke('license:check'),
  clearLicense: () => ipcRenderer.invoke('license:clear'),
  switchToMainWindow: () => ipcRenderer.invoke('license:switch-to-main'),
  refreshLicense: () => ipcRenderer.invoke('license:refresh'),
  onLicenseUpdated: (cb) => ipcRenderer.on('license-updated', (_e, d) => cb(d)),

  // 测试自动回复
  testAutoReply: () => ipcRenderer.invoke('test-auto-reply'),

  // 模拟消息流水线（完整流程测试）
  simulateMessageFlow: (data) => ipcRenderer.invoke('simulate-message-flow', data),

  // AI 意图识别
  aiGetSystemInfo: () => ipcRenderer.invoke('ai-get-system-info'),
  aiGetConfig: () => ipcRenderer.invoke('ai-get-config'),
  aiSaveConfig: (config) => ipcRenderer.invoke('ai-save-config', config),
  aiResetIntents: () => ipcRenderer.invoke('ai-reset-intents'),
  aiGetStatus: () => ipcRenderer.invoke('ai-get-status'),
  aiGetSources: () => ipcRenderer.invoke('ai-get-sources'),
  aiDownloadModel: (opts) => ipcRenderer.invoke('ai-download-model', opts),
  aiSelectLocalModel: () => ipcRenderer.invoke('ai-select-local-model'),
  aiLoadModel: () => ipcRenderer.invoke('ai-load-model'),
  aiUnloadModel: () => ipcRenderer.invoke('ai-unload-model'),
  aiTestMatch: (message) => ipcRenderer.invoke('ai-test-match', message),
  aiSetEnabled: (enabled) => ipcRenderer.invoke('ai-set-enabled', enabled),
  onAiDownloadProgress: (cb) => ipcRenderer.on('ai-download-progress', (_, d) => cb(d)),

  // 事件监听
  onPddPageLoading: (cb) => ipcRenderer.on('pdd-page-loading', (_, d) => cb(d)),
  onPddPageLoaded: (cb) => ipcRenderer.on('pdd-page-loaded', (_, d) => cb(d)),
  onPddPageFailed: (cb) => ipcRenderer.on('pdd-page-failed', (_, d) => cb(d)),
  onPddNavigated: (cb) => ipcRenderer.on('pdd-navigated', (_, d) => cb(d)),
  onAutoReplySent: (cb) => ipcRenderer.on('auto-reply-sent', (_, d) => cb(d)),
  onAutoReplyError: (cb) => ipcRenderer.on('auto-reply-error', (_, d) => cb(d)),
  onUnmatchedMessage: (cb) => ipcRenderer.on('unmatched-message', (_, d) => cb(d)),
  onFallbackScheduled: (cb) => ipcRenderer.on('fallback-scheduled', (_, d) => cb(d)),
  onFallbackTriggered: (cb) => ipcRenderer.on('fallback-triggered', (_, d) => cb(d)),
  onFallbackSendStart: (cb) => ipcRenderer.on('fallback-send-start', (_, d) => cb(d)),
  onFallbackSkipped: (cb) => ipcRenderer.on('fallback-skipped', (_, d) => cb(d)),
  onFallbackCancelled: (cb) => ipcRenderer.on('fallback-cancelled', (_, d) => cb(d)),
  onChatUrlDetected: (cb) => ipcRenderer.on('chat-url-detected', (_, d) => cb(d)),

  // 店铺相关事件
  onShopSwitched: (cb) => ipcRenderer.on('shop-switched', (_, d) => cb(d)),
  onShopAdded: (cb) => ipcRenderer.on('shop-added', (_, d) => cb(d)),
  onShopLoginSuccess: (cb) => ipcRenderer.on('shop-login-success', (_, d) => cb(d)),
  onShopListUpdated: (cb) => ipcRenderer.on('shop-list-updated', (_, d) => cb(d)),
  onApiAuthExpired: (cb) => ipcRenderer.on('api-auth-expired', (_, d) => cb(d)),
  onApiSessionUpdated: (cb) => ipcRenderer.on('api-session-updated', (_, d) => cb(d)),
  onApiNewMessage: (cb) => ipcRenderer.on('api-new-message', (_, d) => cb(d)),
  onApiBootstrapInspect: (cb) => ipcRenderer.on('api-bootstrap-inspect', (_, d) => cb(d)),
  onApiMessageSent: (cb) => ipcRenderer.on('api-message-sent', (_, d) => cb(d)),
  onApiReadMarkUpdated: (cb) => ipcRenderer.on('api-read-mark-updated', (_, d) => cb(d))
});
