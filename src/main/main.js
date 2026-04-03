const { app, BrowserWindow, Menu, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { nativeImage } = require('electron');
const { ReplyEngine } = require('./reply-engine');
const { NetworkMonitor } = require('./network-monitor');
const { PddApiClient } = require('./pdd-api');
const { MailApiClient } = require('./mail-api');
const { InvoiceApiClient } = require('./invoice-api');
const { createSettingsWindow } = require('./settings-window');
const { createDebugWindow, sendToDebug } = require('./debug-window');
const { ShopManager } = require('./shop-manager');
const { TokenFileStore } = require('./token-file-store');
const { SYSTEM_PHRASES, DEFAULT_SCENES, PHRASE_CATEGORIES, DEFAULT_AI_INTENTS } = require('./system-phrases');
const { AIIntentEngine } = require('./ai-intent');
const { getApiTrafficLogPath } = require('./api-traffic-path');
const { registerAiIpc, autoLoadAiIntentEngine } = require('./register-ai-ipc');
const { registerShopIpc } = require('./register-shop-ipc');
const { registerApiIpc } = require('./register-api-ipc');
const { registerReplyIpc } = require('./register-reply-ipc');
const { registerDebugIpc } = require('./register-debug-ipc');
const { registerEmbeddedViewIpc } = require('./register-embedded-view-ipc');
const Store = require('electron-store');

app.disableHardwareAcceleration();
configureChromiumLogging();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const UNMATCHED_LOG_MAX = 200;
const API_ALL_SHOPS = '__all__';

const store = new Store({
  defaults: {
    rules: [],
    autoReplyEnabled: false,
    defaultReply: {
      enabled: true,
      texts: ['亲，您好！您的问题我已收到，请稍等，马上为您处理~'],
      delay: 2000,
      cooldown: 60000,
      strategy: 'random',
      cancelOnHumanReply: true,
      scenes: DEFAULT_SCENES
    },
    windowBounds: { width: 1400, height: 900 },
    chatUrl: '',
    mailUrl: '',
    invoiceUrl: '',
    violationUrl: '',
    shops: [],
    activeShopId: '',
    shopGroups: [],
    apiStarredSessions: [],
    quickPhrases: [],
    shopCookies: {},
    shopTokens: {},
    shopTokenFiles: {},
    phraseLibrary: [],
    unmatchedLog: [],
    aiIntent: {
      enabled: false,
      threshold: 0.65,
      intents: DEFAULT_AI_INTENTS,
      modelStatus: 'none',
      modelSource: 'mirror',
      customMirror: ''
    }
  }
});

// 运行时状态：兜底延迟发送的计时器（customer -> timer）
const pendingFallbacks = new Map();
// 运行时状态：每个客户最后一次兜底发送的时间戳（用于冷却）
const fallbackCooldowns = new Map();
// 跨通道消息去重：防止 DOM 监听和网络监控同时处理同一条消息
const messageDedup = new Map(); // "customer|message" -> timestamp

const PDD_CHAT_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html';
const PDD_MAIL_URL = 'https://mms.pinduoduo.com/other/mail/mailList?type=-1&id=441077635572';
const PDD_INVOICE_URL = 'https://mms.pinduoduo.com/invoice/center?msfrom=mms_sidenav';
const PDD_VIOLATION_URL = 'https://mms.pinduoduo.com/pg/violation_list/mall_manage?msfrom=mms_sidenav';

const MOCK_SHOPS = [
  { id: 'shop_1', name: '环球优品旗舰店', account: 'huanqiu_001', mallId: '', group: 'group_1', remark: '主力店铺', status: 'online', loginMethod: 'token', userAgent: '', bindTime: '2025-10-15', category: '日用百货', balance: 15280.50 },
  { id: 'shop_2', name: '达俞生活馆', account: 'dayu_002', mallId: '', group: 'group_2', remark: '', status: 'online', loginMethod: 'token', userAgent: '', bindTime: '2025-11-02', category: '家居用品', balance: 8930.20 },
  { id: 'shop_3', name: '星辰数码专营店', account: 'xingchen_003', mallId: '', group: 'group_1', remark: '注意售后时效', status: 'offline', loginMethod: 'token', userAgent: '', bindTime: '2025-09-20', category: '数码电器', balance: 3200.00 },
  { id: 'shop_4', name: '花语美妆店', account: 'huayu_004', mallId: '', group: 'group_3', remark: '', status: 'online', loginMethod: 'token', userAgent: '', bindTime: '2025-12-01', category: '美妆护肤', balance: 22100.80 },
  { id: 'shop_5', name: '鲜果时光', account: 'xianguo_005', mallId: '', group: 'group_2', remark: '季节性商品多', status: 'online', loginMethod: 'token', userAgent: '', bindTime: '2025-08-10', category: '食品生鲜', balance: 5670.30 },
  { id: 'shop_6', name: '童趣乐园母婴店', account: 'tongqu_006', mallId: '', group: 'group_3', remark: '', status: 'expired', loginMethod: 'token', userAgent: '', bindTime: '2025-06-15', category: '母婴玩具', balance: 890.00 },
  { id: 'shop_7', name: '潮流服饰工厂店', account: 'chaoliu_007', mallId: '', group: 'group_1', remark: '换季清仓中', status: 'online', loginMethod: 'token', userAgent: '', bindTime: '2025-07-22', category: '服饰鞋包', balance: 41200.00 }
];

const MOCK_GROUPS = [
  { id: 'group_1', name: '1环球' },
  { id: 'group_2', name: '2达俞' },
  { id: 'group_3', name: '3美妆母婴' }
];

const MOCK_RULES = [
  {
    id: 'qa_1', name: '欢迎语', enabled: true, matchType: 'contains', priority: 100, shops: null,
    keywords: ['你好', '在吗', '在不在', '有人吗', 'hello', '嗨', '您好', '亲'],
    keywordGroups: [['你好', '在吗', '在不在', '有人吗', 'hello', '嗨', '您好', '亲', '请问']],
    excludeKeywords: [],
    reply: '亲，您好！欢迎光临本店，请问有什么可以帮您的呢？'
  },
  {
    id: 'qa_2', name: '发货时间', enabled: true, matchType: 'contains', priority: 80, shops: null,
    keywords: ['发货', '寄出', '时间', '多久', '几天'],
    keywordGroups: [
      ['发货', '寄出', '发', '寄'],
      ['什么时候', '多久', '几天', '时间', '啥时候', '多长时间']
    ],
    excludeKeywords: ['已发货', '已经发了'],
    reply: '亲，拍下后48小时内为您安排发货哦，一般2-3天可以收到~'
  },
  {
    id: 'qa_3', name: '退换货政策', enabled: true, matchType: 'contains', priority: 70, shops: null,
    keywords: ['退货', '换货', '退款', '不想要了', '退换'],
    keywordGroups: [
      ['退货', '退款', '退换', '退回', '换货', '不想要', '不要了']
    ],
    excludeKeywords: ['不退', '不用退', '不需要退', '不换了'],
    reply: '亲，本店支持7天无理由退换货。如需退换，请在订单页面申请，我们会尽快为您处理~'
  },
  {
    id: 'qa_4', name: '优惠活动', enabled: true, matchType: 'contains', priority: 60, shops: null,
    keywords: ['优惠', '打折', '便宜', '优惠券', '满减'],
    keywordGroups: [
      ['优惠', '打折', '便宜点', '少点', '满减', '优惠券', '券', '活动', '折扣']
    ],
    excludeKeywords: [],
    reply: '亲，目前店铺有满99减10的活动哦，收藏店铺还可以领取5元优惠券呢~'
  },
  {
    id: 'qa_5', name: '售后问题', enabled: true, matchType: 'contains', priority: 90, shops: null,
    keywords: ['投诉', '质量问题', '坏了', '破损', '有问题'],
    keywordGroups: [
      ['投诉', '质量问题', '坏了', '破损', '有问题', '瑕疵', '损坏', '不好用', '出问题']
    ],
    excludeKeywords: ['没问题', '没有问题', '质量不错'],
    reply: '亲，非常抱歉给您带来不好的体验。请您提供订单号和问题照片，我们会第一时间为您处理~'
  },
  {
    id: 'qa_6', name: '商品咨询', enabled: false, matchType: 'contains', priority: 50, shops: null,
    keywords: ['尺码', '颜色', '材质', '规格', '大小'],
    keywordGroups: [
      ['尺码', '颜色', '材质', '规格', '大小', '尺寸', '型号', '重量']
    ],
    excludeKeywords: [],
    reply: '亲，商品详情页有详细的规格说明哦，如果还有疑问请告诉我具体想了解哪款商品~'
  },
  {
    id: 'qa_7', name: '物流查询', enabled: true, matchType: 'contains', priority: 75, shops: null,
    keywords: ['快递', '物流', '到哪了', '单号'],
    keywordGroups: [
      ['快递', '物流', '运单', '包裹'],
      ['到哪', '查', '单号', '进度', '到了吗', '到了没', '在哪']
    ],
    excludeKeywords: [],
    reply: '亲，请提供一下您的订单号，我帮您查询物流信息哦~'
  }
];

const MOCK_QUICK_PHRASES = [
  { id: 'qp_1', text: '亲，您好！请问有什么可以帮您？', category: '欢迎' },
  { id: 'qp_2', text: '亲，已为您查询，请稍等~', category: '通用' },
  { id: 'qp_3', text: '亲，非常抱歉给您带来了不好的体验', category: '道歉' },
  { id: 'qp_4', text: '感谢您的理解与支持！', category: '感谢' },
  { id: 'qp_5', text: '亲，拍下后48小时内发货哦', category: '发货' },
  { id: 'qp_6', text: '亲，请提供一下您的订单号', category: '通用' },
  { id: 'qp_7', text: '好的呢，马上为您处理', category: '通用' },
  { id: 'qp_8', text: '亲，还有其他问题可以随时联系我们哦', category: '结束' }
];

const MOCK_EXAM_QUESTIONS = [
  { id: 'eq_1', type: 'single', question: '买家申请仅退款，商家最迟需要在几小时内处理？', options: ['24小时', '36小时', '48小时', '72小时'], answer: 2 },
  { id: 'eq_2', type: 'single', question: '拼多多平台客服首次响应时间要求是？', options: ['30秒内', '1分钟内', '3分钟内', '5分钟内'], answer: 2 },
  { id: 'eq_3', type: 'judge', question: '商家可以主动向买家索要好评', options: ['正确', '错误'], answer: 1 },
  { id: 'eq_4', type: 'single', question: '以下哪种行为不违反平台规则？', options: ['辱骂买家', '引导好评', '如实描述商品', '虚假发货'], answer: 2 },
  { id: 'eq_5', type: 'judge', question: '商家可以在聊天中发送第三方链接', options: ['正确', '错误'], answer: 1 },
  { id: 'eq_6', type: 'single', question: '买家申请退货退款，商家需要提供退货地址的期限是？', options: ['12小时', '24小时', '36小时', '48小时'], answer: 1 },
  { id: 'eq_7', type: 'judge', question: '消费者收到商品7天内可以无理由退货（特殊商品除外）', options: ['正确', '错误'], answer: 0 },
  { id: 'eq_8', type: 'single', question: '客服满意度达标标准是多少？', options: ['60%', '70%', '80%', '90%'], answer: 2 },
  { id: 'eq_9', type: 'single', question: '虚假发货的处罚是？', options: ['警告', '罚款5元/单', '罚款10元/单', '店铺关闭'], answer: 1 },
  { id: 'eq_10', type: 'judge', question: '商家可以在未经买家同意的情况下更换发货商品', options: ['正确', '错误'], answer: 1 }
];

const MOCK_SCAN_SHOPS = [
  { account: 'newshop_101', name: '阳光数码配件店' },
  { account: 'newshop_102', name: '清风家居用品' },
  { account: 'newshop_103', name: '优选食品旗舰店' },
  { account: 'newshop_104', name: '潮玩手办集合店' }
];

let currentView = 'chat';
let mainWindow = null;
let shopManager = null;
let replyEngine = null;
const tokenFileStore = new TokenFileStore(store);
let aiIntentEngine = null;
let networkMonitors = new Map();  // shopId -> NetworkMonitor
let apiClients = new Map();
let mailApiClients = new Map();
let invoiceApiClients = new Map();
let apiTrafficStore = new Map();
let apiSessionStore = new Map();
let rendererWatcher = null;
let rendererReloadTimer = null;

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function isDevelopmentMode() {
  return process.env.NODE_ENV === 'development';
}

function configureChromiumLogging() {
  if (isDevelopmentMode()) {
    app.commandLine.appendSwitch('enable-logging');
    app.commandLine.appendSwitch('log-level', '0');
    return;
  }

  app.commandLine.appendSwitch('log-level', '3');
}

function clearRendererReloadTimer() {
  if (!rendererReloadTimer) return;
  clearTimeout(rendererReloadTimer);
  rendererReloadTimer = null;
}

function cleanupRendererWatcher() {
  clearRendererReloadTimer();
  if (!rendererWatcher) return;
  rendererWatcher.close();
  rendererWatcher = null;
}

function setupDevelopmentRendererWatcher() {
  if (!isDevelopmentMode() || rendererWatcher) return;

  const rendererDir = path.join(__dirname, '..', 'renderer');

  try {
    rendererWatcher = fs.watch(rendererDir, (eventType, filename) => {
      if (!filename || (eventType !== 'change' && eventType !== 'rename')) return;
      if (!/\.(html|js|css)$/i.test(filename)) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;

      clearRendererReloadTimer();
      rendererReloadTimer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        console.log(`[PDD助手] 检测到渲染层文件变更，准备刷新窗口: ${filename}`);
        mainWindow.webContents.reloadIgnoringCache();
      }, 150);
    });
    console.log('[PDD助手] 开发模式已启用渲染层自动刷新');
  } catch (error) {
    console.error('[PDD助手] 启动渲染层自动刷新失败:', error.message);
  }
}

function getPddChatUrl() {
  return store.get('chatUrl') || PDD_CHAT_URL;
}

function getPddMailUrl() {
  return store.get('mailUrl') || PDD_MAIL_URL;
}

function getPddInvoiceUrl() {
  return store.get('invoiceUrl') || PDD_INVOICE_URL;
}

function getPddViolationUrl() {
  return store.get('violationUrl') || PDD_VIOLATION_URL;
}

function isEmbeddedPddView(view) {
  return view === 'chat' || view === 'mail' || view === 'invoice' || view === 'violation';
}

function isMailRelatedView(view) {
  return view === 'mail' || view === 'mail-api';
}

function isInvoiceRelatedView(view) {
  return view === 'invoice' || view === 'invoice-api';
}

function isViolationRelatedView(view) {
  return view === 'violation' || view === 'violation-api';
}

function getEmbeddedViewUrl(view) {
  if (isMailRelatedView(view)) return getPddMailUrl();
  if (isInvoiceRelatedView(view)) return getPddInvoiceUrl();
  if (isViolationRelatedView(view)) return getPddViolationUrl();
  return getPddChatUrl();
}

function isMailPageUrl(url) {
  return String(url || '').includes('/other/mail/');
}

function isChatPageUrl(url) {
  return String(url || '').includes('chat-merchant');
}

function isInvoicePageUrl(url) {
  return String(url || '').includes('/invoice/');
}

function isViolationPageUrl(url) {
  const text = String(url || '');
  return text.includes('/pg/violation_list/') || text.includes('/violation_list/');
}

function normalizeStoredPddUrls() {
  const storedChatUrl = store.get('chatUrl');
  if (!storedChatUrl || isMailPageUrl(storedChatUrl) || isInvoicePageUrl(storedChatUrl) || isViolationPageUrl(storedChatUrl)) {
    store.set('chatUrl', PDD_CHAT_URL);
  }
  const storedMailUrl = store.get('mailUrl');
  if (!storedMailUrl || isChatPageUrl(storedMailUrl) || isInvoicePageUrl(storedMailUrl) || isViolationPageUrl(storedMailUrl)) {
    store.set('mailUrl', PDD_MAIL_URL);
  }
  const storedInvoiceUrl = store.get('invoiceUrl');
  if (!storedInvoiceUrl || isChatPageUrl(storedInvoiceUrl) || isMailPageUrl(storedInvoiceUrl) || isViolationPageUrl(storedInvoiceUrl)) {
    store.set('invoiceUrl', PDD_INVOICE_URL);
  }
  const storedViolationUrl = store.get('violationUrl');
  if (!storedViolationUrl || isChatPageUrl(storedViolationUrl) || isMailPageUrl(storedViolationUrl) || isInvoicePageUrl(storedViolationUrl)) {
    store.set('violationUrl', PDD_VIOLATION_URL);
  }
}

// ---- 注入脚本 ----

function injectAutoReplyScript(view) {
  if (!view) return;
  const injectPath = path.join(__dirname, '..', 'inject', 'auto-reply.js');
  const fs = require('fs');
  const script = fs.readFileSync(injectPath, 'utf-8');
  view.webContents.executeJavaScript(script).then(() => {
    // 注入成功后立即同步当前自动回复开关状态
    const enabled = store.get('autoReplyEnabled');
    view.webContents.send('auto-reply-toggle', enabled);
  }).catch(err => {
    console.error('注入自动回复脚本失败:', err.message);
  });
}

// ---- 自动检测客服聊天页面 ----

function detectChatPage(view, shopId) {
  if (!view || !mainWindow) return;
  const currentUrl = view.webContents.getURL();
  if (isMailPageUrl(currentUrl) && currentUrl !== store.get('mailUrl')) {
    store.set('mailUrl', currentUrl);
    console.log('[PDD助手] 自动检测到站内信页面，已保存:', currentUrl);
  }
  if (isInvoicePageUrl(currentUrl) && currentUrl !== store.get('invoiceUrl')) {
    store.set('invoiceUrl', currentUrl);
    console.log('[PDD助手] 自动检测到待开票页面，已保存:', currentUrl);
  }
  if (isViolationPageUrl(currentUrl) && currentUrl !== store.get('violationUrl')) {
    store.set('violationUrl', currentUrl);
    console.log('[PDD助手] 自动检测到违规管理页面，已保存:', currentUrl);
  }

  view.webContents.executeJavaScript(`
    (function() {
      var text = document.body ? document.body.innerText : '';
      var buttons = document.querySelectorAll('button');
      var hasSendBtn = false;
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent.trim() === '发送') { hasSendBtn = true; break; }
      }
      var hasSessionList = text.indexOf('今日接待') !== -1 || text.indexOf('全部会话') !== -1;
      return hasSendBtn && hasSessionList;
    })()
  `).then(isChat => {
    if (!isChat) return;
    const url = view.webContents.getURL();
    if (url === store.get('chatUrl')) return;
    store.set('chatUrl', url);
    console.log('[PDD助手] 自动检测到客服页面，已保存:', url);
    mainWindow.webContents.send('chat-url-detected', { url });
  }).catch(() => {});
}

// ---- 网络监控 ----

// 网络监控提取的消息去重（避免与 DOM 监听重复触发）
const networkMsgDedup = new Map(); // text -> timestamp
const apiSessionTrafficSnapshot = new Map();

function buildApiSessionTrafficSignature(sessions = []) {
  if (!Array.isArray(sessions)) return '';
  return sessions.map(item => [
    item.sessionId || '',
    item.lastMessageTime || 0,
    item.unreadCount || 0,
    item.waitTime || 0,
    item.lastMessage || '',
  ].join(':')).join('|');
}

function setApiSessionSnapshot(shopId, sessions = [], source = 'runtime') {
  if (!shopId) return [];
  const normalized = Array.isArray(sessions)
    ? sessions.filter(item => item && item.sessionId)
    : [];
  if (normalized.length === 0) {
    const existing = apiSessionStore.get(shopId) || [];
    if (existing.length > 0 && source !== 'clear') {
      return existing;
    }
  }
  apiSessionStore.set(shopId, normalized);
  sendToDebug('api-session-snapshot', { shopId, count: normalized.length, source });
  return normalized;
}

function getApiSessionSnapshot(shopId) {
  if (!shopId) return [];
  return apiSessionStore.get(shopId) || [];
}

function extractApiSessionsFromTraffic(shopId) {
  if (!shopId) return [];
  const client = getApiClient(shopId);
  const traffic = getApiTraffic(shopId);
  const urlParts = ['/plateau/chat/latest_conversations', '/plateau/conv_list/status'];
  for (const urlPart of urlParts) {
    for (let i = traffic.length - 1; i >= 0; i--) {
      const entry = traffic[i];
      if (!String(entry?.url || '').includes(urlPart) || !entry?.responseBody) continue;
      try {
        const sessions = client._parseSessionList(entry.responseBody);
        if (Array.isArray(sessions) && sessions.length > 0) {
          return setApiSessionSnapshot(shopId, sessions, `traffic-fallback:${urlPart}`);
        }
      } catch {}
    }
  }
  return [];
}

function pushApiSessionsFromTraffic(shopId, entry) {
  if (!shopId || !entry?.url) return;
  const url = String(entry.url || '');
  if (!url.includes('/plateau/chat/latest_conversations') && !url.includes('/plateau/conv_list/status')) {
    return;
  }
  const client = getApiClient(shopId);
  if (!client || !entry.responseBody) return;
  try {
    const sessions = client._parseSessionList(entry.responseBody);
    if (!Array.isArray(sessions) || sessions.length === 0) return;
    const signature = buildApiSessionTrafficSignature(sessions);
    if (apiSessionTrafficSnapshot.get(shopId) === signature) return;
    apiSessionTrafficSnapshot.set(shopId, signature);
    client._sessionCache = sessions;
    setApiSessionSnapshot(shopId, sessions, 'traffic');
    updateShopStatus(shopId, 'online');
    mainWindow?.webContents.send('api-session-updated', { shopId, sessions });
    sendToDebug('api-session-updated', { shopId, count: sessions.length, source: 'traffic' });
    console.log(`[PDD接口:${shopId}] 已从页面抓包同步会话: ${sessions.length}`);
  } catch (error) {
    console.log(`[PDD接口:${shopId}] 页面抓包解析会话失败: ${error.message}`);
  }
}

function startNetworkMonitor(view, shopId) {
  if (networkMonitors.has(shopId)) {
    networkMonitors.get(shopId).stop();
  }
  if (!view) return;

  const monitor = new NetworkMonitor(view.webContents, {
    onLog(entry) {
      sendToDebug('network-log', entry);
      if (entry.type === 'important' || entry.type === 'info') {
        console.log(`[网络监控:${shopId}] ${entry.text}`);
      }
    },
    onMessage(logEntry) {
      sendToDebug('network-message-detected', logEntry);
    },
    onApiTraffic(entry) {
      const list = apiTrafficStore.get(shopId) || [];
      list.push(entry);
      if (list.length > 200) {
        list.splice(0, list.length - 200);
      }
      apiTrafficStore.set(shopId, list);
      appendApiTrafficLog(shopId, entry);
      if (String(entry?.url || '').includes('/latitude/order/price/update')) {
        const requestBody = typeof entry?.requestBody === 'string' ? entry.requestBody : '';
        if (requestBody) {
          try {
            const parsedBody = JSON.parse(requestBody);
            if (parsedBody && typeof parsedBody === 'object' && (parsedBody.crawlerInfo || parsedBody.crawler_info)) {
              store.set(`apiOrderPriceUpdateTemplate.${shopId}`, {
                url: entry.url,
                method: entry.method || 'POST',
                requestBody: JSON.stringify(parsedBody),
                updatedAt: Date.now(),
              });
            }
          } catch {}
        }
      }
      console.log(`[接口抓取:${shopId}] [${entry.method}] ${entry.url} -> ${entry.status}`);
      sendToDebug('api-traffic', { shopId, entry });
      pushApiSessionsFromTraffic(shopId, entry);
    },
    onCustomerMessage(msg) {
      if (!store.get('autoReplyEnabled')) return;
      // 去重：5秒内相同文本不重复处理（DOM 监听可能已处理过）
      const now = Date.now();
      const lastTime = networkMsgDedup.get(msg.text);
      if (lastTime && now - lastTime < 5000) return;
      networkMsgDedup.set(msg.text, now);
      // 清理过期去重记录
      if (networkMsgDedup.size > 100) {
        for (const [k, t] of networkMsgDedup) {
          if (now - t > 30000) networkMsgDedup.delete(k);
        }
      }
      console.log(`[PDD助手] 网络监控提取到客户消息: ${msg.text.slice(0, 50)}`);
      // 复用与 DOM 监听相同的处理管线
      handleNewCustomerMessage({
        message: msg.text,
        customer: msg.customer,
        conversationId: msg.conversationId || Date.now().toString(),
        source: 'network-monitor'
      });
    }
  });

  monitor.start();
  networkMonitors.set(shopId, monitor);
}

function getApiClient(shopId) {
  if (!shopId) return null;
  if (apiClients.has(shopId)) return apiClients.get(shopId);

  const client = new PddApiClient(shopId, {
    onLog(message, extra) {
      sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
      if (extra && typeof extra === 'object' && Object.keys(extra).length) {
        console.log(`[PDD接口:${shopId}] ${message}`, extra);
      } else {
        console.log(`[PDD接口:${shopId}] ${message}`);
      }
    },
    getShopInfo() {
      const shops = store.get('shops') || [];
      return shops.find(item => item.id === shopId) || null;
    },
    getApiTraffic() {
      return getApiTraffic(shopId);
    },
    getOrderPriceUpdateTemplate() {
      return store.get(`apiOrderPriceUpdateTemplate.${shopId}`) || null;
    },
    requestInPddPage(request) {
      return requestViaPddPage(shopId, request);
    },
    async executeInPddPage(script) {
      const view = await ensurePddPageViewReady(shopId);
      return view.webContents.executeJavaScript(String(script || ''), true);
    }
  });

  client.on('authExpired', payload => {
    updateShopStatus(shopId, 'expired');
    mainWindow?.webContents.send('api-auth-expired', payload);
    sendToDebug('api-auth-expired', payload);
  });

  client.on('sessionUpdated', sessions => {
    const stableSessions = Array.isArray(sessions) && sessions.length === 0
      ? getApiSessionSnapshot(shopId)
      : setApiSessionSnapshot(shopId, sessions, 'polling');
    if (Array.isArray(stableSessions) && stableSessions.length >= 0) {
      updateShopStatus(shopId, 'online');
    }
    const payload = { shopId, sessions: stableSessions };
    mainWindow?.webContents.send('api-session-updated', payload);
    sendToDebug('api-session-updated', { shopId, count: stableSessions.length });
  });

  client.on('newMessage', payload => {
    mainWindow?.webContents.send('api-new-message', payload);
    sendToDebug('api-new-message', payload);
    handleNewCustomerMessage({
      message: payload.text,
      customer: payload.customer,
      conversationId: payload.sessionId,
      source: 'api-polling',
      shopId
    });
  });

  client.on('messageSent', payload => {
    mainWindow?.webContents.send('api-message-sent', { shopId, ...payload });
    sendToDebug('api-message-sent', { shopId, sessionId: payload.sessionId });
  });

  apiClients.set(shopId, client);
  return client;
}

function waitForViewLoad(view, targetUrl = '') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('加载拼多多聊天页超时'));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      view.webContents.removeListener('did-finish-load', onLoad);
      view.webContents.removeListener('did-fail-load', onFail);
    };
    const onLoad = () => {
      if (!targetUrl || view.webContents.getURL().includes(targetUrl)) {
        cleanup();
        resolve();
      }
    };
    const onFail = (_event, _code, desc) => {
      cleanup();
      reject(new Error(desc || '加载拼多多聊天页失败'));
    };
    view.webContents.on('did-finish-load', onLoad);
    view.webContents.on('did-fail-load', onFail);
  });
}

function waitForMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureViewDebugger(view) {
  const debuggerInstance = view.webContents.debugger;
  const attachedBefore = debuggerInstance.isAttached();
  if (!attachedBefore) {
    debuggerInstance.attach('1.3');
  }
  try {
    await debuggerInstance.sendCommand('DOM.enable');
  } catch {}
  try {
    await debuggerInstance.sendCommand('Network.enable', {
      maxResourceBufferSize: 1024 * 1024 * 5,
      maxTotalBufferSize: 1024 * 1024 * 20,
    });
  } catch {}
  return { debuggerInstance, attachedBefore };
}

async function findFileInputNodeId(view) {
  const ids = await listFileInputNodeIds(view);
  return ids[0] || null;
}

async function listFileInputNodeIds(view) {
  const { debuggerInstance, attachedBefore } = await ensureViewDebugger(view);
  try {
    const search = await debuggerInstance.sendCommand('DOM.performSearch', {
      query: 'input[type="file"]',
      includeUserAgentShadowDOM: true,
    });
    const resultCount = search?.resultCount || 0;
    if (!resultCount) return [];
    const { nodeIds = [] } = await debuggerInstance.sendCommand('DOM.getSearchResults', {
      searchId: search.searchId,
      fromIndex: 0,
      toIndex: resultCount,
    });
    return nodeIds;
  } finally {
    if (!attachedBefore && debuggerInstance.isAttached()) {
      debuggerInstance.detach();
    }
  }
}

async function describeFileInputNode(view, nodeId) {
  const { debuggerInstance, attachedBefore } = await ensureViewDebugger(view);
  try {
    const { object } = await debuggerInstance.sendCommand('DOM.resolveNode', { nodeId });
    if (!object?.objectId) return null;
    const result = await debuggerInstance.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `
        function() {
          const rect = this.getBoundingClientRect();
          const style = window.getComputedStyle(this);
          const inputBox = document.querySelector('.middle-panel textarea')
            || document.querySelector('.middle-panel [contenteditable="true"]')
            || document.querySelector('textarea')
            || document.querySelector('[contenteditable="true"]');
          const inputRect = inputBox ? inputBox.getBoundingClientRect() : null;
          return {
            accept: this.accept || '',
            className: this.className || '',
            id: this.id || '',
            multiple: !!this.multiple,
            disabled: !!this.disabled,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            style: { display: style.display, visibility: style.visibility },
            nearInput: inputRect
              ? Math.abs(rect.left - inputRect.left) < 320 && Math.abs(rect.top - inputRect.top) < 180
              : false,
          };
        }
      `,
    });
    return result?.result?.value || null;
  } finally {
    if (!attachedBefore && debuggerInstance.isAttached()) {
      debuggerInstance.detach();
    }
  }
}

async function pickBestFileInputNodeId(view, nodeIds = []) {
  let bestNodeId = null;
  let bestScore = -Infinity;
  for (const nodeId of nodeIds) {
    const meta = await describeFileInputNode(view, nodeId);
    if (!meta || meta.disabled) continue;
    let score = 0;
    if (String(meta.accept).includes('image')) score += 12;
    if (/upload|image|img|pic|photo/i.test(`${meta.className} ${meta.id}`)) score += 8;
    if (meta.nearInput) score += 8;
    if (meta.style?.display !== 'none' && meta.style?.visibility !== 'hidden') score += 3;
    if ((meta.rect?.width || 0) > 0 || (meta.rect?.height || 0) > 0) score += 2;
    if (meta.multiple) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestNodeId = nodeId;
    }
  }
  return bestNodeId;
}

async function probePddUploadInput(view) {
  return view.webContents.executeJavaScript(`
    (() => {
      const markNode = (node, prefix) => {
        if (!node) return '';
        const token = (prefix || 'probe') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        node.setAttribute('data-pdd-helper-probe', token);
        return '[data-pdd-helper-probe="' + token + '"]';
      };
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const inputBox = document.querySelector('.middle-panel textarea')
        || document.querySelector('.middle-panel [contenteditable="true"]')
        || document.querySelector('textarea')
        || document.querySelector('[contenteditable="true"]');
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(node => !node.disabled);
      const imageInput = inputs.find(node => String(node.accept || '').includes('image')) || inputs[0];
      if (imageInput) {
        return {
          selector: markNode(imageInput, 'upload-input'),
          accept: imageInput.accept || '',
          hasInputBox: !!inputBox,
          inputCount: inputs.length,
          currentUrl: location.href
        };
      }
      const inputRect = inputBox ? inputBox.getBoundingClientRect() : null;
      const root = document.body;
      const candidates = Array.from(root.querySelectorAll('button,[role="button"],span,div'))
        .filter(isVisible)
        .map(node => {
          const rect = node.getBoundingClientRect();
          const text = (node.textContent || '').trim();
          const title = node.getAttribute('title') || node.getAttribute('aria-label') || '';
          const cls = node.className || '';
          let score = 0;
          if (/图片|相册|上传/.test(text)) score += 8;
          if (/图片|相册|上传/.test(title)) score += 8;
          if (/upload|image|img|pic|photo/i.test(String(cls))) score += 6;
          if (rect.top > window.innerHeight * 0.55) score += 3;
          if (rect.left < window.innerWidth * 0.75) score += 2;
          if (inputRect) {
            const dx = Math.abs((rect.left + rect.width / 2) - inputRect.left);
            const dy = Math.abs((rect.top + rect.height / 2) - (inputRect.top - 18));
            if (dx < 280 && dy < 120) score += 6;
            if (rect.left < inputRect.left && rect.top < inputRect.top + 40 && rect.bottom > inputRect.top - 80) score += 5;
          }
          if (rect.width <= 44 && rect.height <= 44) score += 2;
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            score,
            text,
            title,
            cls: String(cls).slice(0, 80),
            selector: markNode(node, 'upload-candidate'),
          };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return {
        candidates,
        hasInputBox: !!inputBox,
        inputCount: inputs.length,
        currentUrl: location.href
      };
    })()
  `, true);
}

function clickViewAt(view, x, y) {
  view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  return waitForMs(80).then(() => {
    view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  });
}

async function clickViewTarget(view, target) {
  if (!view || !target) return false;
  if (target.selector) {
    const clicked = await view.webContents.executeJavaScript(`
      (() => {
        const node = document.querySelector(${JSON.stringify(target.selector)});
        if (!node) return false;
        const clickable = node.closest('button,[role="button"],label,a,div,span') || node;
        clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        clickable.click();
        clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()
    `, true).catch(() => false);
    if (clicked) return true;
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    await clickViewAt(view, target.x, target.y);
    return true;
  }
  return false;
}

async function setViewFileInputFiles(view, target, filePath) {
  const { debuggerInstance, attachedBefore } = await ensureViewDebugger(view);
  try {
    let nodeId = null;
    if (typeof target === 'number') {
      nodeId = target;
    } else {
      const { root } = await debuggerInstance.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const result = await debuggerInstance.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: target,
      });
      nodeId = result?.nodeId || null;
    }
    if (!nodeId) {
      throw new Error('PDD_UPLOAD_INPUT_MISSING');
    }
    await debuggerInstance.sendCommand('DOM.setFileInputFiles', {
      nodeId,
      files: [filePath],
    });
    const { object } = await debuggerInstance.sendCommand('DOM.resolveNode', { nodeId });
    if (object?.objectId) {
      await debuggerInstance.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `
          function() {
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }
        `,
      });
    }
  } finally {
    if (!attachedBefore && debuggerInstance.isAttached()) {
      debuggerInstance.detach();
    }
  }
}

async function waitForViewUploadResult(view, filePath) {
  const { debuggerInstance, attachedBefore } = await ensureViewDebugger(view);
  const trackedRequestIds = new Set();
  const uploadRequestPattern = /get_signature|store_image|general_file|upload|pddugc|galerie|cos/i;
  const buildMissingInputError = (probe) => {
    const parts = [];
    if (probe?.currentUrl) parts.push(`url=${probe.currentUrl}`);
    if (typeof probe?.hasInputBox === 'boolean') parts.push(`hasInputBox=${probe.hasInputBox ? 1 : 0}`);
    if (typeof probe?.inputCount === 'number') parts.push(`inputCount=${probe.inputCount}`);
    if (Array.isArray(probe?.candidates)) parts.push(`candidates=${probe.candidates.length}`);
    return new Error(parts.length ? `PDD_UPLOAD_INPUT_MISSING; ${parts.join('; ')}` : 'PDD_UPLOAD_INPUT_MISSING');
  };
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('PDD_UPLOAD_TIMEOUT'));
    }, 20000);

    const cleanup = () => {
      clearTimeout(timeout);
      debuggerInstance.removeListener('message', onMessage);
      if (!attachedBefore && debuggerInstance.isAttached()) {
        debuggerInstance.detach();
      }
    };

    const onMessage = async (_event, method, params) => {
      try {
        if (method === 'Network.requestWillBeSent') {
          const url = params?.request?.url || '';
          if (uploadRequestPattern.test(url)) {
            trackedRequestIds.add(params.requestId);
          }
        }
        if (method === 'Network.responseReceived') {
          const url = params?.response?.url || '';
          if (uploadRequestPattern.test(url)) {
            trackedRequestIds.add(params.requestId);
          }
        }
        if (method === 'Network.loadingFinished' && trackedRequestIds.has(params.requestId)) {
          const body = await debuggerInstance.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const raw = body?.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body?.body || '';
          let payload = null;
          try {
            payload = JSON.parse(raw || '{}');
          } catch {}
          if (payload?.url || payload?.processed_url) {
            cleanup();
            resolve({ ...payload, uploadBaseUrl: 'embedded-pdd-page' });
          }
        }
        if (method === 'Network.loadingFailed' && trackedRequestIds.has(params.requestId)) {
          cleanup();
          reject(new Error(params?.errorText || 'PDD_UPLOAD_FAILED'));
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    debuggerInstance.on('message', onMessage);

    try {
      let target = await (async () => {
        const initialNodeIds = await listFileInputNodeIds(view);
        const directNodeId = await pickBestFileInputNodeId(view, initialNodeIds);
        if (directNodeId) return directNodeId;
        let probe = await probePddUploadInput(view);
        if (probe?.selector) return probe.selector;
        if (typeof selectConversationInView === 'function' && !probe?.hasInputBox) {
          await selectConversationInView(view);
          await waitForMs(400);
          const nodeIdAfterSelect = await pickBestFileInputNodeId(view, await listFileInputNodeIds(view));
          if (nodeIdAfterSelect) return nodeIdAfterSelect;
          probe = await probePddUploadInput(view);
          if (probe?.selector) return probe.selector;
        }
        const candidates = Array.isArray(probe?.candidates) ? probe.candidates : [];
        for (const candidate of candidates) {
          const beforeNodeIds = await listFileInputNodeIds(view);
          await clickViewTarget(view, candidate);
          await waitForMs(500);
          const afterNodeIds = await listFileInputNodeIds(view);
          const newNodeIds = afterNodeIds.filter(id => !beforeNodeIds.includes(id));
          const clickedNodeId = await pickBestFileInputNodeId(view, newNodeIds.length ? newNodeIds : afterNodeIds);
          if (clickedNodeId) return clickedNodeId;
          const nextProbe = await probePddUploadInput(view);
          if (nextProbe?.selector) return nextProbe.selector;
          probe = nextProbe;
        }
        throw buildMissingInputError(probe);
      })();
      await setViewFileInputFiles(view, target, filePath);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function ensurePddPageViewReady(shopId) {
  const view = shopManager?.getOrCreateView(shopId);
  if (!view) throw new Error('未找到店铺网页实例');
  try {
    shopManager?._resizeView?.(view);
  } catch {}
  let justLoadedChatPage = false;
  const currentUrl = view.webContents.getURL();
  if (!currentUrl || currentUrl === 'about:blank' || !currentUrl.includes('/chat-merchant/')) {
    const waitTask = waitForViewLoad(view, '/chat-merchant/');
    view.webContents.loadURL(PDD_CHAT_URL);
    await waitTask;
    justLoadedChatPage = true;
  }
  if (justLoadedChatPage) {
    await waitForMs(1200);
  }
  await view.webContents.executeJavaScript(
    `window.__PDD_HELPER__?.dismissBlockingPopups?.() || 0`
  ).catch(() => {});
  await waitForMs(300);
  return view;
}

async function requestViaPddPage(shopId, request = {}) {
  const view = await ensurePddPageViewReady(shopId);
  const payload = {
    url: String(request.url || ''),
    method: String(request.method || 'GET').toUpperCase(),
    headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
    body: request.body === undefined ? null : request.body,
  };
  if (!payload.url) {
    throw new Error('缺少页面请求 URL');
  }
  const result = await view.webContents.executeJavaScript(`
    (async () => {
      const payload = ${JSON.stringify(payload)};
      try {
        const response = await fetch(payload.url, {
          method: payload.method,
          credentials: 'include',
          headers: payload.headers,
          body: payload.body === null ? undefined : payload.body,
        });
        const text = await response.text();
        let data = text;
        try { data = JSON.parse(text); } catch {}
        return {
          ok: response.ok,
          status: response.status,
          url: response.url,
          body: data,
        };
      } catch (error) {
        return {
          ok: false,
          error: error?.message || String(error || 'PAGE_REQUEST_FAILED'),
        };
      }
    })()
  `, true);
  if (!result?.ok) {
    throw new Error(result?.error || `PAGE_REQUEST_FAILED${result?.status ? `:${result.status}` : ''}`);
  }
  return result.body;
}

async function uploadImageViaPddPage(shopId, filePath) {
  const view = await ensurePddPageViewReady(shopId);
  return waitForViewUploadResult(view, filePath);
}

function destroyApiClient(shopId) {
  const client = apiClients.get(shopId);
  if (!client) return;
  client.destroy();
  apiClients.delete(shopId);
  apiSessionTrafficSnapshot.delete(shopId);
  apiSessionStore.delete(shopId);
}

function getMailApiClient(shopId) {
  if (!shopId) return null;
  if (mailApiClients.has(shopId)) return mailApiClients.get(shopId);
  const client = new MailApiClient(shopId, {
    onLog(message, extra) {
      sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
      if (extra && typeof extra === 'object' && Object.keys(extra).length) {
        console.log(`[PDD站内信:${shopId}] ${message}`, extra);
      } else {
        console.log(`[PDD站内信:${shopId}] ${message}`);
      }
    },
    getShopInfo() {
      const shops = store.get('shops') || [];
      return shops.find(item => item.id === shopId) || null;
    },
    getApiTraffic() {
      return getApiTraffic(shopId);
    },
    getMailUrl() {
      return getPddMailUrl();
    }
  });
  mailApiClients.set(shopId, client);
  return client;
}

function destroyMailApiClient(shopId) {
  if (!mailApiClients.has(shopId)) return;
  mailApiClients.delete(shopId);
}

function getInvoiceApiClient(shopId) {
  if (!shopId) return null;
  if (invoiceApiClients.has(shopId)) return invoiceApiClients.get(shopId);
  const client = new InvoiceApiClient(shopId, {
    onLog(message, extra) {
      sendToDebug('api-log', { shopId, message, extra, timestamp: Date.now() });
      console.log(`[PDD待开票:${shopId}] ${message}`);
    },
    getShopInfo() {
      const shops = store.get('shops') || [];
      return shops.find(item => item.id === shopId) || null;
    },
    getApiTraffic() {
      return getApiTraffic(shopId);
    },
    getInvoiceUrl() {
      return getPddInvoiceUrl();
    }
  });
  invoiceApiClients.set(shopId, client);
  return client;
}

function destroyInvoiceApiClient(shopId) {
  if (!invoiceApiClients.has(shopId)) return;
  invoiceApiClients.delete(shopId);
}

function getApiTraffic(shopId) {
  const runtimeList = apiTrafficStore.get(shopId) || [];
  if (runtimeList.length >= 20) return runtimeList;
  const persistedList = getPersistedApiTraffic(shopId);
  if (!persistedList.length) return runtimeList;
  const merged = [...persistedList, ...runtimeList];
  if (merged.length > 200) {
    return merged.slice(merged.length - 200);
  }
  return merged;
}

function getStoredShops() {
  return store.get('shops') || [];
}

function updateShopStatus(shopId, status) {
  if (!shopId || !status) return;
  const shops = getStoredShops();
  const target = shops.find(item => item.id === shopId);
  if (!target || target.status === status) return;
  target.status = status;
  store.set('shops', shops);
  if (status === 'expired' && shopManager?.getActiveShopId() === shopId) {
    const shouldShowView = !!mainWindow && isEmbeddedPddView(currentView);
    shopManager.syncActiveShopSelection({
      shops,
      showView: shouldShowView,
      emitEvent: !!mainWindow && !shouldShowView
    });
  }
  mainWindow?.webContents.send('shop-list-updated', { shops });
}

function hasRecoveredApiToken(shopId) {
  return !!global.__pddTokens?.[shopId]?.raw;
}

function isApiReadyShop(shop) {
  if (!shop?.id) return false;
  if (shop.loginMethod !== 'token') return true;
  return hasRecoveredApiToken(shop.id);
}

function getApiShopList(shopId, options = {}) {
  const { apiReadyOnly = false } = options;
  const shops = getStoredShops().filter(item => item?.id);
  if (shopId === API_ALL_SHOPS) {
    return apiReadyOnly ? shops.filter(isApiReadyShop) : shops;
  }
  return shops.filter(item => item.id === shopId);
}

function decorateApiSession(shopId, session) {
  const shop = getStoredShops().find(item => item.id === shopId);
  return {
    ...session,
    shopId,
    shopName: session?.shopName || shop?.name || '未知店铺',
    shopStatus: shop?.status || '',
  };
}

async function loadShopApiSessions(shopId, page = 1, pageSize = 20) {
  const client = getApiClient(shopId);
  let sessions = await client.getSessionList(page, pageSize);
  if (sessions.length > 0) {
    setApiSessionSnapshot(shopId, sessions, 'request');
    return sessions;
  }
  const trafficSessions = extractApiSessionsFromTraffic(shopId);
  if (page === 1 && trafficSessions.length > 0) {
    return trafficSessions.slice(0, pageSize);
  }
  const snapshot = getApiSessionSnapshot(shopId);
  if (page === 1 && snapshot.length > 0) {
    return snapshot.slice(0, pageSize);
  }
  const retry = await client.testConnection();
  if (Array.isArray(retry?.sessions) && retry.sessions.length > 0) {
    setApiSessionSnapshot(shopId, retry.sessions, 'test-connection');
    return retry.sessions;
  }
  const retriedTrafficSessions = extractApiSessionsFromTraffic(shopId);
  if (page === 1 && retriedTrafficSessions.length > 0) {
    return retriedTrafficSessions.slice(0, pageSize);
  }
  return sessions;
}

async function getApiSessionsByScope(shopId, page = 1, pageSize = 20) {
  const targetShops = getApiShopList(shopId, { apiReadyOnly: shopId === API_ALL_SHOPS });
  if (!targetShops.length) {
    if (shopId === API_ALL_SHOPS) {
      const skippedShops = getApiShopList(API_ALL_SHOPS).filter(shop => !isApiReadyShop(shop));
      if (skippedShops.length) {
        const summary = skippedShops
          .slice(0, 3)
          .map(shop => `${shop.name || shop.id}`)
          .join('、');
        throw new Error(`显示所有店铺时，${skippedShops.length} 个店铺未恢复 Token：${summary}`);
      }
      return [];
    }
    throw new Error('没有可用店铺');
  }
  if (shopId === API_ALL_SHOPS) {
    const skippedShops = getApiShopList(API_ALL_SHOPS).filter(shop => !isApiReadyShop(shop));
    if (skippedShops.length) {
      sendToDebug('api-session-skip-token-missing', {
        count: skippedShops.length,
        shops: skippedShops.map(shop => ({ shopId: shop.id, shopName: shop.name || '' })),
      });
    }
  }
  if (shopId !== API_ALL_SHOPS) {
    const sessions = await loadShopApiSessions(targetShops[0].id, page, pageSize);
    return sessions.map(session => decorateApiSession(targetShops[0].id, session));
  }
  const failures = [];
  const sessionGroups = await Promise.all(targetShops.map(async shop => {
    try {
      const sessions = await loadShopApiSessions(shop.id, page, pageSize);
      return sessions.map(session => decorateApiSession(shop.id, session));
    } catch (error) {
      failures.push({
        shopId: shop.id,
        shopName: shop.name || '未命名店铺',
        message: error.message || '接口会话拉取失败',
      });
      sendToDebug('api-session-load-skipped', { shopId: shop.id, message: error.message });
      return [];
    }
  }));
  const mergedSessions = sessionGroups
    .flat()
    .sort((a, b) => Number(b.lastMessageTime || 0) - Number(a.lastMessageTime || 0));
  if (!mergedSessions.length && failures.length) {
    const summary = failures
      .slice(0, 3)
      .map(item => `${item.shopName || item.shopId}：${item.message}`)
      .join('；');
    throw new Error(`接口会话加载失败，共 ${failures.length} 个店铺失败：${summary}`);
  }
  return mergedSessions;
}

function getApiTrafficByScope(shopId) {
  if (shopId !== API_ALL_SHOPS) {
    return getApiTraffic(shopId).map(entry => decorateApiSession(shopId, entry));
  }
  return getStoredShops()
    .flatMap(shop => getApiTraffic(shop.id).map(entry => decorateApiSession(shop.id, entry)))
    .sort((a, b) => Number(b.timestamp || b.recordedAt || 0) - Number(a.timestamp || a.recordedAt || 0));
}

function appendApiTrafficLog(shopId, entry) {
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    const record = JSON.stringify({
      shopId,
      recordedAt: Date.now(),
      entry,
    });
    fs.mkdirSync(path.dirname(apiTrafficLogPath), { recursive: true });
    fs.appendFileSync(apiTrafficLogPath, `${record}\n`, 'utf-8');
  } catch (error) {
    console.error('[PDD助手] 写入接口抓取日志失败:', error.message);
  }
}

function getPersistedApiTraffic(shopId, limit = 200) {
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    if (!fs.existsSync(apiTrafficLogPath)) return [];
    const lines = fs.readFileSync(apiTrafficLogPath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    const result = [];
    for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed?.shopId !== shopId || !parsed?.entry) continue;
        result.push(parsed.entry);
      } catch {}
    }
    return result.reverse();
  } catch (error) {
    console.error('[PDD助手] 读取接口抓包日志失败:', error.message);
    return [];
  }
}

// ---- 窗口创建 ----

function createMainWindow() {
  const { width, height } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 700,
    title: '元尾巴 · 拼多多客服助手',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('windowBounds', { width: w, height: h });
    if (isEmbeddedPddView(currentView) && shopManager) {
      shopManager.resizeActiveView();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    shopManager = null;
  });

  // 创建 ShopManager
  shopManager = new ShopManager(mainWindow, store, {
    tokenFileStore,
    onLog: (msg) => console.log(msg),
    onInjectScript: injectAutoReplyScript,
    onNetworkMonitor: startNetworkMonitor,
    onDetectChat: detectChatPage,
    getApiClient,
    onTokenUpdated: (shopId) => {
      destroyApiClient(shopId);
      destroyMailApiClient(shopId);
      destroyInvoiceApiClient(shopId);
      apiTrafficStore.set(shopId, []);
    }
  });
}

// ---- 数据迁移：旧版单店铺 → 多店铺 ----

async function migrateOldData() {
  const oldCookies = store.get('pddCookies');
  const shops = store.get('shops') || [];
  const activeShopId = store.get('activeShopId');

  // 如果有旧的全局 Cookie 且没有 activeShopId，创建迁移店铺
  if (oldCookies?.length && !activeShopId) {
    const migrateId = 'shop_migrated';
    const existing = shops.find(s => s.id === migrateId);
    if (!existing) {
      shops.unshift({
        id: migrateId,
        name: '已迁移店铺',
        account: '',
        mallId: '',
        group: '',
        remark: '从旧版本迁移',
        status: 'online',
        loginMethod: 'token',
        userAgent: '',
        bindTime: new Date().toISOString().split('T')[0],
        category: '待分类',
        balance: 0
      });
      store.set('shops', shops);
    }

    // 把旧 Cookie 恢复到迁移店铺的 partition
    const ses = session.fromPartition(`persist:pdd-${migrateId}`);
    for (const cookie of oldCookies) {
      try { await ses.cookies.set(cookie); } catch {}
    }

    store.set('activeShopId', migrateId);
    store.delete('pddCookies');
    console.log('[PDD助手] 旧版 Cookie 已迁移到 shop_migrated');
  }
}

// ---- IPC Handlers ----

ipcMain.handle('inject-cookies', async (event, cookies) => {
  const shopId = shopManager?.getActiveShopId();
  if (!shopId) return false;
  const ses = session.fromPartition(`persist:pdd-${shopId}`);
  for (const cookie of cookies) {
    try { await ses.cookies.set(cookie); } catch (err) {
      console.error('设置 Cookie 失败:', err.message);
    }
  }
  const view = shopManager?.getActiveView();
  if (view) view.webContents.loadURL(getPddChatUrl());
  return true;
});

registerShopIpc({
  ipcMain,
  store,
  getShopManager: () => shopManager,
  destroyApiClient,
  destroyMailApiClient,
  destroyInvoiceApiClient
});

registerApiIpc({
  ipcMain,
  dialog,
  store,
  API_ALL_SHOPS,
  getMainWindow: () => mainWindow,
  getShopManager: () => shopManager,
  getApiClient,
  getApiSessionsByScope,
  uploadImageViaPddPage,
  getApiShopList,
  destroyApiClient,
  getApiTrafficByScope,
  getMailApiClient,
  getInvoiceApiClient,
  setApiTrafficEntries: (shopId, entries) => {
    apiTrafficStore.set(shopId, entries);
  }
});

registerReplyIpc({
  ipcMain,
  store,
  DEFAULT_SCENES,
  SYSTEM_PHRASES,
  PHRASE_CATEGORIES,
  ReplyEngine,
  getReplyEngine: () => replyEngine,
  setReplyEngine: engine => {
    replyEngine = engine;
  },
  getAiIntentEngine: () => aiIntentEngine,
  getShopManager: () => shopManager
});

registerDebugIpc({
  ipcMain,
  store,
  getMainWindow: () => mainWindow,
  getCurrentView: () => currentView,
  getShopManager: () => shopManager,
  isEmbeddedPddView,
  createSettingsWindow,
  createDebugWindow
});

registerEmbeddedViewIpc({
  ipcMain,
  store,
  getCurrentView: () => currentView,
  setCurrentView: view => {
    currentView = view;
  },
  getShopManager: () => shopManager,
  isEmbeddedPddView,
  isMailPageUrl,
  isInvoicePageUrl,
  isViolationPageUrl,
  isChatPageUrl,
  getPddMailUrl,
  getPddInvoiceUrl,
  getPddViolationUrl,
  getPddChatUrl,
  getEmbeddedViewUrl
});

registerAiIpc({
  ipcMain,
  app,
  dialog,
  store,
  DEFAULT_AI_INTENTS,
  AIIntentEngine,
  getMainWindow: () => mainWindow,
  getAiIntentEngine: () => aiIntentEngine,
  setAiIntentEngine: engine => {
    aiIntentEngine = engine;
  }
});

// ---- 店铺考试 ----

ipcMain.handle('get-exam-questions', () => MOCK_EXAM_QUESTIONS);

ipcMain.handle('submit-exam', (event, answers) => {
  let correct = 0;
  for (const [qId, ans] of Object.entries(answers)) {
    const q = MOCK_EXAM_QUESTIONS.find(eq => eq.id === qId);
    if (q && q.answer === ans) correct++;
  }
  return { total: MOCK_EXAM_QUESTIONS.length, correct, score: Math.round(correct / MOCK_EXAM_QUESTIONS.length * 100) };
});

// ---- 批量绑定 ----

ipcMain.handle('scan-shops', () => MOCK_SCAN_SHOPS);

ipcMain.handle('bind-shops', (event, newShops) => {
  const existing = store.get('shops');
  const toAdd = newShops.map((s, i) => ({
    id: 'shop_' + Date.now() + '_' + i,
    name: s.name,
    account: s.account,
    mallId: '',
    group: '',
    remark: '',
    status: 'online',
    loginMethod: 'token',
    userAgent: '',
    bindTime: new Date().toISOString().split('T')[0],
    category: '待分类',
    balance: 0
  }));
  store.set('shops', [...existing, ...toAdd]);
  return true;
});

// ---- 网络监控 IPC ----

ipcMain.handle('toggle-network-monitor', (event, enabled) => {
  const view = shopManager?.getActiveView();
  const shopId = shopManager?.getActiveShopId();
  if (enabled && view && shopId) {
    startNetworkMonitor(view, shopId);
  } else if (!enabled && shopId && networkMonitors.has(shopId)) {
    networkMonitors.get(shopId).stop();
    networkMonitors.delete(shopId);
  }
  return true;
});

ipcMain.handle('get-network-monitor-status', () => {
  const shopId = shopManager?.getActiveShopId();
  if (!shopId) return { active: false };
  const monitor = networkMonitors.get(shopId);
  return { active: !!monitor?.attached };
});

// ---- 测试自动回复 ----

ipcMain.handle('test-auto-reply', async () => {
  const view = shopManager?.getActiveView();
  if (!view) return { error: '没有活跃的 BrowserView' };

  try {
    // 第一步：填入消息并获取发送按钮坐标
    const result = await view.webContents.executeJavaScript(`
      (function() {
        var report = { found: {} };

        // 查找输入框
        var selectors = ['[contenteditable="true"]', 'textarea'];
        var input = null;
        for (var i = 0; i < selectors.length; i++) {
          try { input = document.querySelector(selectors[i]); } catch(e) {}
          if (input) { report.found.inputSelector = selectors[i]; break; }
        }
        report.found.inputTag = input ? input.tagName : null;

        // 查找发送按钮
        var sendBtn = null;
        var candidates = document.querySelectorAll('button, a, div, span');
        for (var j = 0; j < candidates.length; j++) {
          var el = candidates[j];
          if ((el.textContent || '').trim() === '发送' && el.offsetParent !== null) {
            sendBtn = el;
            break;
          }
        }
        report.found.sendButtonTag = sendBtn ? sendBtn.tagName : null;
        report.found.sendButtonClass = sendBtn ? (sendBtn.className || '').toString().slice(0, 60) : null;

        if (!input) { report.error = '未找到输入框'; return report; }
        if (!sendBtn) { report.error = '未找到发送按钮'; return report; }

        // 填入消息
        var msg = '亲，您好！请问有什么可以帮您的呢？';
        input.focus();
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (setter && setter.set) setter.set.call(input, msg);
          else input.value = msg;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.textContent = msg;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: msg }));
        }

        // 返回发送按钮坐标
        var rect = sendBtn.getBoundingClientRect();
        report.btnX = Math.round(rect.left + rect.width / 2);
        report.btnY = Math.round(rect.top + rect.height / 2);
        report.success = true;
        return report;
      })()
    `);

    console.log('[PDD助手] 填入结果:', JSON.stringify(result));
    if (!result.success) return result;

    // 第二步：使用 Chromium 底层输入 API 点击发送按钮
    await new Promise(r => setTimeout(r, 300));
    view.webContents.sendInputEvent({
      type: 'mouseDown', x: result.btnX, y: result.btnY, button: 'left', clickCount: 1
    });
    await new Promise(r => setTimeout(r, 80));
    view.webContents.sendInputEvent({
      type: 'mouseUp', x: result.btnX, y: result.btnY, button: 'left', clickCount: 1
    });

    console.log(`[PDD助手] 已通过 sendInputEvent 点击发送按钮 (${result.btnX}, ${result.btnY})`);
    mainWindow?.webContents.send('auto-reply-sent', {
      customer: '当前客户',
      question: '(手动触发)',
      answer: '亲，您好！请问有什么可以帮您的呢？'
    });
    return result;
  } catch (err) {
    console.error('[PDD助手] 测试失败:', err.message);
    return { error: err.message };
  }
});

// 注入脚本请求点击发送按钮（通过 Chromium 底层输入 API）
ipcMain.on('click-send-button', async (event, { x, y }) => {
  const view = shopManager?.getActiveView();
  if (!view) return;
  view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 80));
  view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
});

/**
 * 确保 BrowserView 中有活跃的客服会话，没有则自动选择
 * 使用 sendInputEvent 模拟真实鼠标点击，比 DOM element.click() 可靠
 */
async function selectConversationInView(view) {
  if (!view) return false;

  const hasConv = await view.webContents.executeJavaScript(`(function(){
    var input = document.querySelector('.middle-panel [contenteditable="true"]')
             || document.querySelector('.middle-panel textarea')
             || document.querySelector('[contenteditable="true"]');
    if (input && input.offsetParent !== null) return true;
    var areas = ['.middle-panel .content','.middle-panel .chat-content','.middle-panel .msg-list'];
    for (var i = 0; i < areas.length; i++) {
      var el = document.querySelector(areas[i]);
      if (el && el.children.length > 0) return true;
    }
    var mid = document.querySelector('.middle-panel');
    if (mid && mid.querySelector('[contenteditable]')) return true;
    return false;
  })()`).catch(() => false);

  if (hasConv) return true;

  console.log('[PDD助手] 无活跃会话，主进程尝试自动选择...');

  const coords = await view.webContents.executeJavaScript(`(function(){
    var markNode = function(node) {
      if (!node) return '';
      var token = 'pdd-conversation-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      node.setAttribute('data-pdd-helper-conversation', token);
      return '[data-pdd-helper-conversation="' + token + '"]';
    };
    // 通过"今日接待"文本定位会话列表区域
    var panels = document.querySelectorAll('div, aside, section, nav');
    var sp = null;
    for (var i = 0; i < panels.length; i++) {
      var el = panels[i];
      var rect = el.getBoundingClientRect();
      if (rect.left > 50 || rect.width < 100 || rect.width > 500 || rect.height < 200) continue;
      if (el.textContent && el.textContent.indexOf('今日接待') !== -1) { sp = el; break; }
    }
    if (!sp) return null;

    // 策略1: 通过超时/等待提示定位待回复会话
    var hints = ['已超时','已等待','秒后超时','分后超时','分钟后超时'];
    var allEls = sp.querySelectorAll('*');
    for (var j = 0; j < allEls.length; j++) {
      var t = (allEls[j].textContent || '').trim();
      if (t.length > 200) continue;
      for (var h = 0; h < hints.length; h++) {
        if (t.indexOf(hints[h]) !== -1) {
          var item = allEls[j];
          for (var d = 0; d < 10 && item && item !== sp; d++) {
            var r = item.getBoundingClientRect();
            if (r.height >= 40 && r.height <= 150 && r.width >= 150)
              return {
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                selector: markNode(item)
              };
            item = item.parentElement;
          }
        }
      }
    }

    // 策略2: 取面板中第一个像会话条目的元素
    var items = sp.querySelectorAll('div, li, a');
    for (var k = 0; k < items.length; k++) {
      var el = items[k];
      var r = el.getBoundingClientRect();
      if (r.height < 40 || r.height > 150 || r.width < 150 || r.top < 150) continue;
      if (!el.offsetParent) continue;
      var text = (el.textContent || '').trim();
      if (text.length < 3 || text.length > 300) continue;
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        selector: markNode(el)
      };
    }
    return null;
  })()`).catch(() => null);

  if (!coords) {
    console.log('[PDD助手] 未找到可点击的会话条目');
    return false;
  }

  console.log(`[PDD助手] sendInputEvent 点击会话 (${coords.x}, ${coords.y})`);
  await clickViewTarget(view, coords);

  // 等待会话加载
  await new Promise(r => setTimeout(r, 2000));

  // 关闭可能弹出的弹窗
  await view.webContents.executeJavaScript(
    `window.__PDD_HELPER__?.dismissBlockingPopups?.() || 0`
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 500));

  return true;
}

/**
 * 统一消息处理管线：DOM 监听和网络监控共用
 * @param {{ message: string, customer: string, conversationId: string, source?: string, shopId?: string }} data
 */
async function handleNewCustomerMessage(data) {
  if (!store.get('autoReplyEnabled')) {
    console.log(`[PDD助手] 收到消息但自动回复未开启，跳过: ${data.message?.slice(0, 30)}`);
    return;
  }

  // 跨通道去重：10秒内相同客户的相同消息只处理一次
  const dedupKey = `${data.customer}|${data.message}`;
  const now = Date.now();
  const lastProcessed = messageDedup.get(dedupKey);
  if (lastProcessed && now - lastProcessed < 10000) {
    console.log(`[PDD助手] 跨通道去重，跳过: "${data.message?.slice(0, 30)}" (${now - lastProcessed}ms前已处理)`);
    return;
  }
  messageDedup.set(dedupKey, now);
  if (messageDedup.size > 200) {
    for (const [k, t] of messageDedup) {
      if (now - t > 60000) messageDedup.delete(k);
    }
  }

  console.log(`[PDD助手] 处理客户消息: "${data.message}" 来自: ${data.customer}`);
  if (!replyEngine) {
    replyEngine = new ReplyEngine(store.get('rules'));
  }

  const defaultReply = store.get('defaultReply');
  let result = replyEngine.matchWithFallback(data.message, { defaultReply });
  console.log(`[PDD助手] 规则匹配结果: matched=${result.matched}, rule=${result.ruleName || '无'}, reply="${(result.reply || '').slice(0, 30)}"`);

  // AI 意图识别中间层：关键词未命中时，尝试 AI 语义匹配
  if (!result.matched && store.get('aiIntent.enabled') && aiIntentEngine?.isReady()) {
    try {
      const threshold = store.get('aiIntent.threshold') || 0.65;
      const aiResult = await aiIntentEngine.match(data.message, threshold);
      if (aiResult.matched) {
        result = {
          reply: aiResult.reply,
          matched: true,
          ruleName: `AI·${aiResult.intentName}`,
          score: aiResult.similarity
        };
        console.log(`[PDD助手] AI 意图命中: ${aiResult.intentName} (${aiResult.similarity})`);
      }
    } catch (err) {
      console.error('[PDD助手] AI 意图识别出错:', err.message);
    }
  }

  if (!result.reply) {
    appendUnmatchedLog(data);
    return;
  }

  const doSend = async () => {
    const view = shopManager?.getActiveView();
    if (!view) return;
    if (data.source === 'api-polling' && data.shopId && shopManager?.getActiveShopId() !== data.shopId) {
      console.log(`[PDD助手] 接口轮询消息来自店铺 ${data.shopId}，当前嵌入页店铺为 ${shopManager?.getActiveShopId() || '无'}，跳过嵌入页发送`);
      return;
    }

    // 确保有活跃会话（没有则自动选择）
    await selectConversationInView(view);

    view.webContents.send('send-reply', {
      conversationId: data.conversationId,
      message: result.reply
    });
    const replyData = {
      customer: data.customer,
      question: data.message,
      answer: result.reply,
      matched: result.matched,
      ruleName: result.ruleName,
      score: result.score
    };
    mainWindow?.webContents.send('auto-reply-sent', replyData);
    sendToDebug('auto-reply-sent', replyData);
  };

  if (result.matched) {
    cancelPendingFallback(data.customer);
    await doSend();
  } else {
    // ---- 兜底回复流程 ----

    // 冷却检查：同一客户在冷却期内不重复兜底
    const cooldown = defaultReply?.cooldown || 60000;
    const lastTime = fallbackCooldowns.get(data.customer);
    if (lastTime && Date.now() - lastTime < cooldown) {
      appendUnmatchedLog(data);
      return;
    }

    // 取消该客户之前的待发兜底（如果有）
    cancelPendingFallback(data.customer);

    // 通知 UI 显示需要人工关注
    mainWindow?.webContents.send('unmatched-message', {
      customer: data.customer,
      message: data.message,
      fallbackReply: result.reply
    });
    sendToDebug('unmatched-message', { customer: data.customer, message: data.message });

    // 记录未匹配消息
    appendUnmatchedLog(data);

    // 延迟发送兜底（给人工抢答留时间）
    const delay = defaultReply?.delay || 2000;
    const timer = setTimeout(async () => {
      pendingFallbacks.delete(data.customer);

      // 人工抢答取消：检查输入框是否有人正在输入
      if (defaultReply?.cancelOnHumanReply !== false) {
        const view = shopManager?.getActiveView();
        if (view) {
          try {
            const humanTyping = await view.webContents.executeJavaScript(
              `window.__PDD_HELPER__?.checkInputBoxHasContent?.() || false`
            );
            if (humanTyping) {
              console.log(`[PDD助手] 检测到人工正在输入，取消兜底回复: ${data.customer}`);
              mainWindow?.webContents.send('fallback-cancelled', {
                customer: data.customer,
                reason: '人工正在输入'
              });
              return;
            }
          } catch { /* 检查失败则继续发送 */ }
        }
      }

      fallbackCooldowns.set(data.customer, Date.now());
      await doSend();
    }, delay);

    pendingFallbacks.set(data.customer, timer);
  }
}

// 从注入脚本接收到新消息（DOM 监听通道）
ipcMain.on('new-customer-message', (event, data) => {
  handleNewCustomerMessage(data);
});

function cancelPendingFallback(customer) {
  const existing = pendingFallbacks.get(customer);
  if (existing) {
    clearTimeout(existing);
    pendingFallbacks.delete(customer);
  }
}

function appendUnmatchedLog(data) {
  const log = store.get('unmatchedLog') || [];
  log.unshift({
    message: data.message,
    customer: data.customer,
    timestamp: Date.now(),
    shopId: shopManager?.getActiveShopId() || ''
  });
  // 保留最近 N 条
  if (log.length > UNMATCHED_LOG_MAX) log.length = UNMATCHED_LOG_MAX;
  store.set('unmatchedLog', log);
}

// ---- App Lifecycle ----

function initMockData() {
  if (!store.get('shopGroups') || store.get('shopGroups').length === 0) {
    store.set('shopGroups', MOCK_GROUPS);
  }
  if (store.get('rules').length === 0) {
    store.set('rules', MOCK_RULES);
  }
  if (!store.get('quickPhrases') || store.get('quickPhrases').length === 0) {
    store.set('quickPhrases', MOCK_QUICK_PHRASES);
  }
}

const APP_NAME = '元尾巴 · 拼多多客服助手';
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

function setupAppMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `关于 ${APP_NAME}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${APP_NAME}` }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于顶层' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    const apiTrafficLogPath = getApiTrafficLogPath();
    fs.mkdirSync(path.dirname(apiTrafficLogPath), { recursive: true });
    fs.writeFileSync(apiTrafficLogPath, '', 'utf-8');
  } catch (error) {
    console.error('[PDD助手] 初始化接口抓取日志失败:', error.message);
  }
  app.setName(APP_NAME);

  if (process.platform === 'darwin') {
    app.dock.setIcon(APP_ICON_PATH);
  }

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: require('../../package.json').version,
    version: '',
    iconPath: APP_ICON_PATH
  });

  setupAppMenu();
  initMockData();
  replyEngine = new ReplyEngine(store.get('rules'));
  setupDevelopmentRendererWatcher();

  autoLoadAiIntentEngine({
    store,
    DEFAULT_AI_INTENTS,
    AIIntentEngine,
    getAiIntentEngine: () => aiIntentEngine,
    setAiIntentEngine: engine => {
      aiIntentEngine = engine;
    }
  });

  await migrateOldData();
  createMainWindow();

  await shopManager.syncShopsFromTokenFiles({ broadcast: false, forceApplyTokens: true });

  normalizeStoredPddUrls();

  // 启动后状态检查 + 页面结构诊断
  setTimeout(() => {
    const enabled = store.get('autoReplyEnabled');
    console.log(`[PDD助手] 自动回复状态: ${enabled ? '已开启' : '未开启'}`);

    const view = shopManager?.getActiveView();
    if (!view) return;

    // 深度页面结构诊断
    view.webContents.executeJavaScript(`(function(){
      var report = {};

      // 基本注入状态
      report.injected = !!window.__PDD_AUTO_REPLY_INJECTED__;
      report.guideSuppressed = !!window.__PDD_GUIDE_SUPPRESSED__;
      if (window.__PDD_HELPER__) report.helperStatus = window.__PDD_HELPER__.getStatus();

      // 顶层布局容器
      var body = document.body;
      report.bodyChildren = [];
      if (body) {
        for (var i = 0; i < Math.min(body.children.length, 20); i++) {
          var el = body.children[i];
          var rect = el.getBoundingClientRect();
          report.bodyChildren.push({
            tag: el.tagName,
            id: el.id || '',
            cls: (el.className || '').toString().slice(0, 80),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            visible: rect.width > 0 && rect.height > 0
          });
        }
      }

      // iframe 扫描
      report.iframes = [];
      document.querySelectorAll('iframe').forEach(function(f){
        var r = f.getBoundingClientRect();
        var info = {
          src: (f.src || '').slice(0, 200),
          id: f.id || '',
          cls: (f.className || '').toString().slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0
        };
        try { info.accessible = !!f.contentDocument; } catch(e) { info.accessible = false; }
        report.iframes.push(info);
      });

      // Shadow DOM 扫描（前两层）
      report.shadowRoots = [];
      document.querySelectorAll('*').forEach(function(el){
        if (el.shadowRoot) {
          report.shadowRoots.push({
            tag: el.tagName,
            id: el.id || '',
            cls: (el.className || '').toString().slice(0, 60),
            childCount: el.shadowRoot.childElementCount
          });
        }
      });

      // 关键布局区域检测
      var panels = [
        '.left-panel', '.middle-panel', '.right-panel',
        '.session-list', '.chat-list', '.msg-list',
        '.chatWindowHeader', '.order-panel', '.customer-info',
        '[class*="sidebar"]', '[class*="session"]', '[class*="conversation"]',
        '[class*="chatWindow"]', '[class*="orderInfo"]', '[class*="goodsInfo"]',
        '#app', '#root', '[id*="single-spa"]', '[id*="qiankun"]'
      ];
      report.panels = {};
      panels.forEach(function(sel){
        try {
          var el = document.querySelector(sel);
          if (el) {
            var r = el.getBoundingClientRect();
            report.panels[sel] = {
              tag: el.tagName,
              cls: (el.className || '').toString().slice(0, 80),
              x: Math.round(r.left), y: Math.round(r.top),
              w: Math.round(r.width), h: Math.round(r.height)
            };
          }
        } catch(e){}
      });

      // 微前端框架检测
      report.microFrontend = {
        singleSpa: typeof window.singleSpa !== 'undefined' || typeof window.__SINGLE_SPA__ !== 'undefined',
        qiankun: typeof window.__POWERED_BY_QIANKUN__ !== 'undefined' || typeof window.__INJECTED_PUBLIC_PATH_BY_QIANKUN__ !== 'undefined',
        moduleContainer: !!document.querySelector('[id*="single-spa"], [id*="qiankun"], [class*="micro-app"]')
      };

      // guide/layer 状态
      report.guideStatus = {
        layerElements: document.querySelectorAll('.layer').length,
        layerVisible: false,
        guideLocalStorage: {}
      };
      document.querySelectorAll('.layer').forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) report.guideStatus.layerVisible = true;
      });
      for (var j = 0; j < localStorage.length; j++) {
        var k = localStorage.key(j);
        if (/guide|newbie|onboard/i.test(k)) {
          report.guideStatus.guideLocalStorage[k] = localStorage.getItem(k);
        }
      }

      return report;
    })()`).then(r => {
      console.log('\\n====== PDD 页面结构诊断报告 ======');
      console.log('[基本状态] injected=' + r.injected + ' guideSuppressed=' + r.guideSuppressed);
      if (r.helperStatus) console.log('[助手状态]', JSON.stringify(r.helperStatus));

      console.log('\\n[body 子元素] (' + r.bodyChildren.length + '个)');
      r.bodyChildren.forEach(function(c, i){
        console.log('  [' + i + '] <' + c.tag + '> id="' + c.id + '" class="' + c.cls + '" ' + c.w + 'x' + c.h + (c.visible ? '' : ' [隐藏]'));
      });

      console.log('\\n[iframe] (' + r.iframes.length + '个)');
      r.iframes.forEach(function(f, i){
        console.log('  [' + i + '] src=' + f.src + ' ' + f.w + 'x' + f.h + ' accessible=' + f.accessible + (f.visible ? '' : ' [隐藏]'));
      });

      console.log('\\n[Shadow DOM] (' + r.shadowRoots.length + '个)');
      r.shadowRoots.forEach(function(s){
        console.log('  <' + s.tag + '> id="' + s.id + '" class="' + s.cls + '" children=' + s.childCount);
      });

      console.log('\\n[布局面板]');
      for (var sel in r.panels) {
        var p = r.panels[sel];
        console.log('  ' + sel + ' → <' + p.tag + '> class="' + p.cls + '" @(' + p.x + ',' + p.y + ') ' + p.w + 'x' + p.h);
      }

      console.log('\\n[微前端框架]', JSON.stringify(r.microFrontend));
      console.log('[引导状态] layer=' + r.guideStatus.layerElements + '个 visible=' + r.guideStatus.layerVisible);
      if (Object.keys(r.guideStatus.guideLocalStorage).length > 0) {
        console.log('[引导localStorage]', JSON.stringify(r.guideStatus.guideLocalStorage));
      }
      console.log('====== 诊断结束 ======\\n');
    }).catch(err => {
      console.error('[PDD助手] 页面诊断失败:', err.message);
    });
  }, 15000);

  const activeId = store.get('activeShopId');
  const shops = store.get('shops') || [];
  const startupShopId = shopManager.getPreferredActiveShopId(shops, activeId);
  if (startupShopId) {
    await shopManager.restoreCookies(startupShopId);
    shopManager.switchTo(startupShopId);
  } else {
    shopManager.syncActiveShopSelection({ shops, preferredShopId: activeId });
  }
  shopManager.startShopInfoHydrationLoop(5000);
});

app.on('before-quit', () => {
  cleanupRendererWatcher();
  shopManager?.stopShopInfoHydrationLoop();
  if (shopManager) shopManager.saveAllCookies();
  for (const shopId of apiClients.keys()) {
    destroyApiClient(shopId);
  }
  for (const shopId of mailApiClients.keys()) {
    destroyMailApiClient(shopId);
  }
  for (const shopId of invoiceApiClients.keys()) {
    destroyInvoiceApiClient(shopId);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
    const activeId = store.get('activeShopId');
    if (activeId && shopManager) shopManager.switchTo(activeId);
  }
});
