const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pddApi', {
  // 规则管理
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (rules) => ipcRenderer.invoke('save-rules', rules),
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

  // 视图切换
  switchView: (view) => ipcRenderer.invoke('switch-view', view),

  // 窗口操作
  openSettings: () => ipcRenderer.invoke('open-settings'),
  openDevTools: () => ipcRenderer.invoke('open-devtools'),
  reloadPdd: () => ipcRenderer.invoke('reload-pdd'),
  navigatePdd: (url) => ipcRenderer.invoke('navigate-pdd', url),

  // 客服页面 URL 管理
  getChatUrl: () => ipcRenderer.invoke('get-chat-url'),
  setChatUrl: (url) => ipcRenderer.invoke('set-chat-url', url),
  getMailUrl: () => ipcRenderer.invoke('get-mail-url'),
  setMailUrl: (url) => ipcRenderer.invoke('set-mail-url', url),
  getInvoiceUrl: () => ipcRenderer.invoke('get-invoice-url'),
  setInvoiceUrl: (url) => ipcRenderer.invoke('set-invoice-url', url),
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
  apiGetMessages: (params) => ipcRenderer.invoke('api-get-messages', params),
  apiSendMessage: (params) => ipcRenderer.invoke('api-send-message', params),
  apiSelectImage: () => ipcRenderer.invoke('api-select-image'),
  apiSendImage: (params) => ipcRenderer.invoke('api-send-image', params),
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
  getApiStarredSessions: () => ipcRenderer.invoke('get-api-starred-sessions'),
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
  onPddPageLoaded: (cb) => ipcRenderer.on('pdd-page-loaded', (_, d) => cb(d)),
  onPddNavigated: (cb) => ipcRenderer.on('pdd-navigated', (_, d) => cb(d)),
  onAutoReplySent: (cb) => ipcRenderer.on('auto-reply-sent', (_, d) => cb(d)),
  onUnmatchedMessage: (cb) => ipcRenderer.on('unmatched-message', (_, d) => cb(d)),
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
  onApiMessageSent: (cb) => ipcRenderer.on('api-message-sent', (_, d) => cb(d))
});
