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
const { AIIntentEngine, MODEL_ID, MODEL_SOURCES } = require('./ai-intent');
const { getApiTrafficLogPath } = require('./api-traffic-path');
const Store = require('electron-store');

app.disableHardwareAcceleration();

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

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function getPddChatUrl() {
  return store.get('chatUrl') || PDD_CHAT_URL;
}

function getPddMailUrl() {
  return store.get('mailUrl') || PDD_MAIL_URL;
}

function getPddInvoiceUrl() {
  return store.get('invoiceUrl') || PDD_INVOICE_URL;
}

function isEmbeddedPddView(view) {
  return view === 'chat' || view === 'mail' || view === 'invoice';
}

function isMailRelatedView(view) {
  return view === 'mail' || view === 'mail-api';
}

function isInvoiceRelatedView(view) {
  return view === 'invoice' || view === 'invoice-api';
}

function getEmbeddedViewUrl(view) {
  if (isMailRelatedView(view)) return getPddMailUrl();
  if (isInvoiceRelatedView(view)) return getPddInvoiceUrl();
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

function normalizeStoredPddUrls() {
  const storedChatUrl = store.get('chatUrl');
  if (!storedChatUrl || isMailPageUrl(storedChatUrl) || isInvoicePageUrl(storedChatUrl)) {
    store.set('chatUrl', PDD_CHAT_URL);
  }
  const storedMailUrl = store.get('mailUrl');
  if (!storedMailUrl || isChatPageUrl(storedMailUrl) || isInvoicePageUrl(storedMailUrl)) {
    store.set('mailUrl', PDD_MAIL_URL);
  }
  const storedInvoiceUrl = store.get('invoiceUrl');
  if (!storedInvoiceUrl || isChatPageUrl(storedInvoiceUrl) || isMailPageUrl(storedInvoiceUrl)) {
    store.set('invoiceUrl', PDD_INVOICE_URL);
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
    const signature = sessions.map(item => `${item.sessionId}:${item.lastMessageTime || item.waitTime || 0}`).join('|');
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
        conversationId: msg.conversationId || Date.now().toString()
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
      console.log(`[PDD接口:${shopId}] ${message}`);
    },
    getShopInfo() {
      const shops = store.get('shops') || [];
      return shops.find(item => item.id === shopId) || null;
    },
    getApiTraffic() {
      return getApiTraffic(shopId);
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
      conversationId: payload.sessionId
    });
  });

  client.on('messageSent', payload => {
    mainWindow?.webContents.send('api-message-sent', { shopId, ...payload });
    sendToDebug('api-message-sent', { shopId, sessionId: payload.sessionId });
  });

  apiClients.set(shopId, client);
  return client;
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
      console.log(`[PDD站内信:${shopId}] ${message}`);
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
  mainWindow?.webContents.send('shop-list-updated', { shops });
}

function getApiShopList(shopId) {
  const shops = getStoredShops().filter(item => item?.id);
  if (shopId === API_ALL_SHOPS) return shops;
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
  const targetShops = getApiShopList(shopId);
  if (!targetShops.length) {
    if (shopId === API_ALL_SHOPS) return [];
    throw new Error('没有可用店铺');
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
    throw new Error(failures.map(item => `${item.shopName}：${item.message}`).join('；'));
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

ipcMain.handle('get-rules', () => store.get('rules'));

ipcMain.handle('save-rules', (event, rules) => {
  store.set('rules', rules);
  if (replyEngine) replyEngine.updateRules(rules);
  return true;
});

ipcMain.handle('get-auto-reply-enabled', () => store.get('autoReplyEnabled'));

ipcMain.handle('set-auto-reply-enabled', (event, enabled) => {
  store.set('autoReplyEnabled', enabled);
  // 向所有已创建的 BrowserView 广播
  if (shopManager) {
    for (const view of shopManager.views.values()) {
      view.webContents.send('auto-reply-toggle', enabled);
    }
  }
  return true;
});

// ---- 兜底回复 ----

ipcMain.handle('get-default-reply', () => {
  const cfg = store.get('defaultReply');
  // 向后兼容：旧版 text 迁移到 texts
  if (cfg && !cfg.texts && cfg.text) {
    cfg.texts = [cfg.text];
  }
  if (cfg && !cfg.scenes) {
    cfg.scenes = DEFAULT_SCENES;
  }
  return cfg;
});

ipcMain.handle('save-default-reply', (event, config) => {
  store.set('defaultReply', config);
  return true;
});

// ---- 话术库 ----

ipcMain.handle('get-system-phrases', () => SYSTEM_PHRASES);
ipcMain.handle('get-phrase-categories', () => PHRASE_CATEGORIES);

ipcMain.handle('get-phrase-library', () => store.get('phraseLibrary') || []);

ipcMain.handle('save-phrase-library', (event, phrases) => {
  store.set('phraseLibrary', phrases);
  return true;
});

// 将话术添加到兜底配置的 texts 数组
ipcMain.handle('add-phrase-to-fallback', (event, text) => {
  const cfg = store.get('defaultReply');
  if (!cfg.texts) cfg.texts = [];
  if (!cfg.texts.includes(text)) {
    cfg.texts.push(text);
    store.set('defaultReply', cfg);
  }
  return true;
});

// 将话术添加到指定场景的 replies 数组
ipcMain.handle('add-phrase-to-scene', (event, { sceneId, text }) => {
  const cfg = store.get('defaultReply');
  const scene = cfg.scenes?.find(s => s.id === sceneId);
  if (scene) {
    if (!scene.replies.includes(text)) {
      scene.replies.push(text);
      store.set('defaultReply', cfg);
    }
  }
  return true;
});

// ---- 未匹配消息记录 ----

ipcMain.handle('get-unmatched-log', () => store.get('unmatchedLog') || []);

ipcMain.handle('clear-unmatched-log', () => {
  store.set('unmatchedLog', []);
  return true;
});

ipcMain.handle('open-settings', () => {
  createSettingsWindow(mainWindow, store);
});

ipcMain.handle('open-devtools', () => {
  if (isEmbeddedPddView(currentView)) {
    const view = shopManager?.getActiveView();
    if (!view) {
      return { error: '当前没有可调试的嵌入页' };
    }
    view.webContents.openDevTools({ mode: 'detach' });
    return { ok: true, target: 'embedded' };
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { error: '主窗口不可用' };
  }
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  return { ok: true, target: 'renderer' };
});

ipcMain.handle('diagnose-page', async () => {
  const view = shopManager?.getActiveView();
  if (!view) return { error: '没有活跃的 BrowserView' };
  return view.webContents.executeJavaScript(`(function(){
    var r = {};
    r.url = location.href;
    r.title = document.title;

    // body 直接子元素
    r.bodyChildren = [];
    var body = document.body;
    if (body) {
      for (var i = 0; i < Math.min(body.children.length, 30); i++) {
        var el = body.children[i];
        var rect = el.getBoundingClientRect();
        r.bodyChildren.push({
          tag: el.tagName, id: el.id || '',
          cls: (el.className || '').toString().slice(0, 100),
          w: Math.round(rect.width), h: Math.round(rect.height)
        });
      }
    }

    // 深层布局：找到所有宽度 > 100px 的直接子元素及其子元素
    r.layoutTree = [];
    function walkLayout(parent, depth) {
      if (depth > 3) return;
      for (var c = 0; c < parent.children.length && r.layoutTree.length < 80; c++) {
        var el = parent.children[c];
        var rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) continue;
        r.layoutTree.push({
          depth: depth,
          tag: el.tagName, id: el.id || '',
          cls: (el.className || '').toString().slice(0, 100),
          x: Math.round(rect.left), y: Math.round(rect.top),
          w: Math.round(rect.width), h: Math.round(rect.height),
          children: el.children.length
        });
        walkLayout(el, depth + 1);
      }
    }
    if (body) walkLayout(body, 0);

    // iframe
    r.iframes = [];
    document.querySelectorAll('iframe').forEach(function(f){
      var rect = f.getBoundingClientRect();
      r.iframes.push({
        src: (f.src || '').slice(0, 300), id: f.id || '',
        w: Math.round(rect.width), h: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0
      });
    });

    // Shadow DOM
    r.shadowRoots = 0;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot) r.shadowRoots++; });

    // 微前端
    r.singleSpa = typeof window.singleSpa !== 'undefined';
    r.qiankun = typeof window.__POWERED_BY_QIANKUN__ !== 'undefined';

    // guide 状态
    r.layerCount = document.querySelectorAll('.layer').length;
    r.layerVisible = false;
    document.querySelectorAll('.layer').forEach(function(el){
      var rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) r.layerVisible = true;
    });

    return r;
  })()`);
});

ipcMain.handle('open-debug-window', () => {
  createDebugWindow(mainWindow);
});

ipcMain.on('renderer-debug-log', (event, payload = {}) => {
  const scope = payload?.scope || 'renderer';
  const message = payload?.message || '';
  const extra = payload?.extra ? ` ${JSON.stringify(payload.extra)}` : '';
  console.log(`[页面调试:${scope}] ${message}${extra}`);
});

ipcMain.handle('reload-pdd', () => {
  const view = shopManager?.getActiveView();
  if (!view) return;
  view.webContents.loadURL(getEmbeddedViewUrl(currentView));
});

ipcMain.handle('get-chat-url', () => store.get('chatUrl'));

ipcMain.handle('set-chat-url', (event, url) => {
  store.set('chatUrl', url);
  return true;
});

ipcMain.handle('get-mail-url', () => store.get('mailUrl'));

ipcMain.handle('set-mail-url', (event, url) => {
  store.set('mailUrl', url);
  return true;
});

ipcMain.handle('get-invoice-url', () => store.get('invoiceUrl'));

ipcMain.handle('set-invoice-url', (event, url) => {
  store.set('invoiceUrl', url);
  return true;
});

ipcMain.handle('get-current-url', () => {
  const view = shopManager?.getActiveView();
  return view ? view.webContents.getURL() : '';
});

ipcMain.handle('navigate-pdd', (event, url) => {
  const view = shopManager?.getActiveView();
  if (view) view.webContents.loadURL(url);
});

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

// ---- 多店铺管理 IPC ----

ipcMain.handle('get-active-shop', () => {
  if (!shopManager) return null;
  const shop = shopManager.getActiveShop();
  return shop ? { shopId: shopManager.getActiveShopId(), shop } : null;
});

ipcMain.handle('switch-shop', (event, shopId) => {
  if (!shopManager) return false;
  return shopManager.switchTo(shopId);
});

ipcMain.handle('add-shop-by-token', async () => {
  if (!shopManager) return { error: '店铺管理器未初始化' };
  try {
    return await shopManager.addByToken();
  } catch (err) {
    console.error('[PDD助手] Token 添加店铺失败:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('add-shop-by-token-path', async (event, filePath) => {
  if (!shopManager) return { error: '店铺管理器未初始化' };
  try {
    return await shopManager.addByToken(filePath);
  } catch (err) {
    console.error('[PDD助手] Token 添加店铺失败:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('add-shop-by-qrcode', async () => {
  if (!shopManager) return { error: '店铺管理器未初始化' };
  try {
    return await shopManager.addByQRCode();
  } catch (err) {
    console.error('[PDD助手] 扫码添加店铺失败:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('remove-shop', (event, shopId) => {
  if (!shopManager) return false;
  destroyApiClient(shopId);
  destroyMailApiClient(shopId);
  destroyInvoiceApiClient(shopId);
  return shopManager.removeShop(shopId);
});

// 兼容旧的 import-token-file IPC（现在内部走 ShopManager）
ipcMain.handle('import-token-file', async () => {
  if (!shopManager) return { error: '店铺管理器未初始化' };
  try {
    return await shopManager.addByToken();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('import-token-from-path', async (event, filePath) => {
  if (!shopManager) return { error: '店铺管理器未初始化' };
  try {
    return await shopManager.addByToken(filePath);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-token-info', () => {
  const shopId = shopManager?.getActiveShopId();
  return (global.__pddTokens && shopId) ? global.__pddTokens[shopId] || null : null;
});

ipcMain.handle('api-get-token-status', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有活跃店铺' };
  if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
  return await getApiClient(shopId).getTokenStatus();
});

ipcMain.handle('api-init-session', async () => {
  const shopId = shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有活跃店铺' };
  try {
    return await getApiClient(shopId).initSession(true);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-test-connection', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有活跃店铺' };
  if (shopId === API_ALL_SHOPS) return { error: '请先选择具体店铺' };
  try {
    return await getApiClient(shopId).testConnection();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-get-sessions', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  try {
    const sessions = await getApiSessionsByScope(shopId, params.page || 1, params.pageSize || 20);
    console.log(`[PDD接口:${shopId}] api-get-sessions 返回 ${Array.isArray(sessions) ? sessions.length : 0} 条`);
    return sessions;
  } catch (err) {
    console.log(`[PDD接口:${shopId}] api-get-sessions 失败: ${err.message}`);
    return { error: err.message };
  }
});

ipcMain.handle('api-get-messages', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  if (!params.sessionId) return { error: '缺少 sessionId' };
  try {
    return await getApiClient(shopId).getSessionMessages(
      params.sessionId,
      params.page || 1,
      params.pageSize || 30
    );
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-send-message', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  if (!params.sessionId) return { error: '缺少 sessionId' };
  if (!params.text) return { error: '缺少发送内容' };
  try {
    return await getApiClient(shopId).sendMessage(params.sessionId, params.text);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-mark-latest-conversations', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  try {
    return await getApiClient(shopId).markLatestConversations(params.size || 100);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-start-polling', (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  if (shopId === API_ALL_SHOPS) {
    const targetShops = getApiShopList(API_ALL_SHOPS);
    targetShops.forEach(shop => getApiClient(shop.id).startPolling());
    return { ok: true, shopId, count: targetShops.length };
  }
  getApiClient(shopId).startPolling();
  return { ok: true, shopId };
});

ipcMain.handle('api-stop-polling', (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  if (shopId === API_ALL_SHOPS) {
    const targetShops = getApiShopList(API_ALL_SHOPS);
    targetShops.forEach(shop => destroyApiClient(shop.id));
    return { ok: true, shopId, count: targetShops.length };
  }
  destroyApiClient(shopId);
  return { ok: true, shopId };
});

ipcMain.handle('get-api-traffic', (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return [];
  return getApiTrafficByScope(shopId);
});

ipcMain.handle('mail-get-overview', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  try {
    return await getMailApiClient(shopId).getOverview();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mail-get-list', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  try {
    return await getMailApiClient(shopId).getList(params);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mail-get-detail', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  if (!params.messageId) return { error: '缺少 messageId' };
  try {
    return await getMailApiClient(shopId).getDetail(params.messageId);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('invoice-get-overview', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  try {
    return await getInvoiceApiClient(shopId).getOverview();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('invoice-get-list', async (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return { error: '没有可用店铺' };
  try {
    return await getInvoiceApiClient(shopId).getList(params);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('clear-api-traffic', (event, params = {}) => {
  const shopId = params.shopId || shopManager?.getActiveShopId();
  if (!shopId) return false;
  if (shopId === API_ALL_SHOPS) {
    getApiShopList(API_ALL_SHOPS).forEach(shop => apiTrafficStore.set(shop.id, []));
    return true;
  }
  apiTrafficStore.set(shopId, []);
  return true;
});

ipcMain.handle('get-api-starred-sessions', () => store.get('apiStarredSessions') || []);

ipcMain.handle('toggle-api-starred-session', (event, session = {}) => {
  const sessions = store.get('apiStarredSessions') || [];
  const sessionKey = String(session.sessionKey || `${session.shopId || ''}::${session.sessionId || ''}`);
  if (!session.shopId || !session.sessionId || !sessionKey) {
    return { error: '缺少收藏会话标识', sessions };
  }
  const currentIndex = sessions.findIndex(item => item.sessionKey === sessionKey);
  if (currentIndex >= 0) {
    sessions.splice(currentIndex, 1);
    store.set('apiStarredSessions', sessions);
    return { starred: false, sessions };
  }
  const nextSession = {
    sessionKey,
    shopId: session.shopId,
    sessionId: session.sessionId,
    shopName: session.shopName || '',
    customerName: session.customerName || '',
    customerId: session.customerId || '',
    customerAvatar: session.customerAvatar || '',
    lastMessage: session.lastMessage || '',
    lastMessageTime: session.lastMessageTime || 0,
    unreadCount: session.unreadCount || 0,
    orderId: session.orderId || '',
    updatedAt: Date.now(),
  };
  sessions.unshift(nextSession);
  store.set('apiStarredSessions', sessions);
  return { starred: true, sessions };
});

// ---- 视图切换 ----

ipcMain.handle('switch-view', (event, view) => {
  currentView = view;
  if (isEmbeddedPddView(view)) {
    const activeView = shopManager?.getActiveView();
    if (shopManager) shopManager.showActiveView();
    if (activeView) {
      const currentUrl = activeView.webContents.getURL();
      if (view === 'mail' && !isMailPageUrl(currentUrl)) {
        activeView.webContents.loadURL(getPddMailUrl());
      }
      if (view === 'invoice' && !isInvoicePageUrl(currentUrl)) {
        activeView.webContents.loadURL(getPddInvoiceUrl());
      }
      if (view === 'chat' && !isChatPageUrl(currentUrl)) {
        activeView.webContents.loadURL(getPddChatUrl());
      }
    }
  } else {
    if (shopManager) shopManager.hideActiveView();
  }
  return true;
});

// ---- 店铺管理 IPC（列表/分组） ----

ipcMain.handle('get-shops', async () => {
  if (shopManager) {
    const result = await shopManager.syncShopsFromTokenFiles({ broadcast: false });
    return Array.isArray(result?.shops) ? result.shops : result;
  }
  return store.get('shops');
});

ipcMain.handle('save-shops', (event, shops) => {
  if (shopManager) return shopManager.saveShopMetadata(shops);
  store.set('shops', shops);
  return true;
});

ipcMain.handle('get-shop-groups', () => store.get('shopGroups'));

ipcMain.handle('save-shop-groups', (event, groups) => {
  store.set('shopGroups', groups);
  return true;
});

// ---- 规则测试 ----

ipcMain.handle('test-rule', (event, message) => {
  if (!replyEngine) replyEngine = new ReplyEngine(store.get('rules'));
  return replyEngine.testMatch(message);
});

// ---- 模拟消息流水线（完整流程测试） ----

ipcMain.handle('simulate-message-flow', async (event, { message, customerName }) => {
  if (!replyEngine) replyEngine = new ReplyEngine(store.get('rules'));

  const steps = [];
  const t0 = Date.now();

  // 第一步：关键词匹配
  const kwStart = Date.now();
  const kwResult = replyEngine.testMatch(message);
  steps.push({
    name: '关键词匹配',
    duration: Date.now() - kwStart,
    matched: kwResult.matched,
    detail: kwResult.matched
      ? { ruleName: kwResult.ruleName, score: kwResult.score, reply: kwResult.reply }
      : null
  });

  // 如果关键词命中，直接返回
  if (kwResult.matched) {
    return {
      steps,
      finalReply: kwResult.reply,
      finalSource: '关键词匹配',
      finalSourceRule: kwResult.ruleName,
      totalDuration: Date.now() - t0
    };
  }

  // 第二步：AI 意图识别
  const aiCfg = store.get('aiIntent');
  const aiEnabled = aiCfg.enabled && aiIntentEngine?.isReady();
  const aiStart = Date.now();

  if (aiEnabled) {
    try {
      const threshold = aiCfg.threshold || 0.65;
      const aiResult = await aiIntentEngine.testMatch(message, threshold);
      steps.push({
        name: 'AI 意图识别',
        duration: Date.now() - aiStart,
        matched: aiResult.matched,
        detail: aiResult.matched && aiResult.bestMatch
          ? { intentName: aiResult.bestMatch.intentName, similarity: aiResult.bestMatch.similarity, reply: aiResult.bestMatch.reply, ranking: aiResult.ranking }
          : { ranking: aiResult.ranking, threshold }
      });

      if (aiResult.matched && aiResult.bestMatch?.reply) {
        return {
          steps,
          finalReply: aiResult.bestMatch.reply,
          finalSource: 'AI 意图识别',
          finalSourceRule: `AI·${aiResult.bestMatch.intentName}`,
          totalDuration: Date.now() - t0
        };
      }
    } catch (err) {
      steps.push({
        name: 'AI 意图识别',
        duration: Date.now() - aiStart,
        matched: false,
        detail: { error: err.message }
      });
    }
  } else {
    steps.push({
      name: 'AI 意图识别',
      duration: 0,
      matched: false,
      skipped: true,
      detail: { reason: !aiCfg.enabled ? '未启用' : '模型未加载' }
    });
  }

  // 第三步：兜底回复
  const fbStart = Date.now();
  const defaultReply = store.get('defaultReply');
  const fbResult = replyEngine.matchWithFallback(message, { defaultReply });
  const fbMatched = !fbResult.matched && !!fbResult.reply;
  steps.push({
    name: '兜底回复',
    duration: Date.now() - fbStart,
    matched: fbMatched,
    detail: fbMatched
      ? { ruleName: fbResult.ruleName, reply: fbResult.reply, sceneId: fbResult.sceneId }
      : { reason: defaultReply?.enabled ? '无可用兜底话术' : '兜底回复未启用' }
  });

  return {
    steps,
    finalReply: fbResult.reply || null,
    finalSource: fbMatched ? '兜底回复' : '无匹配',
    finalSourceRule: fbResult.ruleName || null,
    totalDuration: Date.now() - t0
  };
});

// ---- AI 意图识别 ----

ipcMain.handle('ai-get-system-info', () => {
  const os = require('os');
  const totalMemGB = os.totalmem() / (1024 ** 3);
  const freeMemGB = os.freemem() / (1024 ** 3);
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || '未知';
  const cpuCores = cpus.length;
  const platform = os.platform();
  const arch = os.arch();

  // 检查磁盘可用空间（模型缓存目录所在分区）
  let diskFreeGB = null;
  try {
    const { execSync } = require('child_process');
    const cacheDir = path.join(app.getPath('userData'), 'ai-models');
    if (platform === 'win32') {
      const drive = cacheDir.charAt(0).toUpperCase();
      const out = execSync(`wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace /format:value`, { encoding: 'utf-8' });
      const m = out.match(/FreeSpace=(\d+)/);
      if (m) diskFreeGB = parseInt(m[1]) / (1024 ** 3);
    } else {
      const out = execSync(`df -k "${app.getPath('userData')}"`, { encoding: 'utf-8' });
      const lines = out.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        diskFreeGB = parseInt(parts[3]) / (1024 ** 2);
      }
    }
  } catch { /* 无法获取磁盘信息 */ }

  // 评估是否适合运行 AI 模型
  let recommendation = 'good';
  const issues = [];

  if (totalMemGB < 4) {
    recommendation = 'poor';
    issues.push(`内存仅 ${totalMemGB.toFixed(1)} GB，低于最低要求 4 GB`);
  } else if (totalMemGB < 8) {
    if (recommendation !== 'poor') recommendation = 'fair';
    issues.push(`内存 ${totalMemGB.toFixed(1)} GB，可运行但可能偶尔卡顿`);
  }

  if (freeMemGB < 1) {
    recommendation = 'poor';
    issues.push(`当前可用内存仅 ${freeMemGB.toFixed(1)} GB，建议关闭部分程序后再使用`);
  }

  if (cpuCores < 2) {
    if (recommendation !== 'poor') recommendation = 'fair';
    issues.push(`CPU 仅 ${cpuCores} 核，推理速度可能较慢`);
  }

  if (diskFreeGB !== null && diskFreeGB < 0.5) {
    recommendation = 'poor';
    issues.push(`磁盘剩余空间仅 ${diskFreeGB.toFixed(1)} GB，不足以存放模型文件`);
  }

  if (issues.length === 0) {
    issues.push('您的电脑配置满足 AI 模型运行要求');
  }

  return {
    cpu: { model: cpuModel, cores: cpuCores },
    memory: { total: Math.round(totalMemGB * 10) / 10, free: Math.round(freeMemGB * 10) / 10 },
    disk: diskFreeGB !== null ? { free: Math.round(diskFreeGB * 10) / 10 } : null,
    platform, arch,
    recommendation,
    issues
  };
});

ipcMain.handle('ai-get-config', () => {
  const cfg = store.get('aiIntent');
  if (!cfg.intents) cfg.intents = DEFAULT_AI_INTENTS;
  return cfg;
});

ipcMain.handle('ai-save-config', (event, config) => {
  store.set('aiIntent', config);
  if (aiIntentEngine) {
    aiIntentEngine.updateIntents(
      config.intents.filter(i => i.enabled)
    );
  }
  return true;
});

ipcMain.handle('ai-reset-intents', () => {
  store.set('aiIntent.intents', DEFAULT_AI_INTENTS);
  if (aiIntentEngine) {
    aiIntentEngine.updateIntents(DEFAULT_AI_INTENTS.filter(i => i.enabled));
  }
  return DEFAULT_AI_INTENTS;
});

ipcMain.handle('ai-get-status', () => {
  if (!aiIntentEngine) {
    aiIntentEngine = new AIIntentEngine();
  }
  return aiIntentEngine.getStatus();
});

ipcMain.handle('ai-get-sources', () => MODEL_SOURCES);

ipcMain.handle('ai-download-model', async (event, { source, customMirror, localPath } = {}) => {
  if (!aiIntentEngine) aiIntentEngine = new AIIntentEngine();

  const src = source || store.get('aiIntent.modelSource') || 'mirror';
  const mirror = customMirror || store.get('aiIntent.customMirror') || '';

  store.set('aiIntent.modelSource', src);
  if (mirror) store.set('aiIntent.customMirror', mirror);

  try {
    await aiIntentEngine.downloadModel({
      source: src,
      customMirror: mirror,
      localPath,
      onProgress(progress) {
        mainWindow?.webContents.send('ai-download-progress', progress);
      }
    });

    store.set('aiIntent.modelStatus', 'ready');

    const intents = store.get('aiIntent.intents') || DEFAULT_AI_INTENTS;
    await aiIntentEngine.updateIntents(intents.filter(i => i.enabled));

    return { success: true };
  } catch (err) {
    store.set('aiIntent.modelStatus', 'none');
    return { error: err.message };
  }
});

ipcMain.handle('ai-select-local-model', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择本地模型文件夹',
    message: '请选择包含 ONNX 模型文件的文件夹（需包含 config.json 和 .onnx 文件）',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

ipcMain.handle('ai-load-model', async () => {
  if (!aiIntentEngine) aiIntentEngine = new AIIntentEngine();

  try {
    await aiIntentEngine.loadModel();
    store.set('aiIntent.modelStatus', 'ready');

    const intents = store.get('aiIntent.intents') || DEFAULT_AI_INTENTS;
    await aiIntentEngine.updateIntents(intents.filter(i => i.enabled));

    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ai-unload-model', () => {
  if (aiIntentEngine) aiIntentEngine.unloadModel();
  store.set('aiIntent.modelStatus', 'none');
  store.set('aiIntent.enabled', false);
  return true;
});

ipcMain.handle('ai-test-match', async (event, message) => {
  if (!aiIntentEngine?.isReady()) return { error: '模型未加载' };
  const threshold = store.get('aiIntent.threshold') || 0.65;
  return aiIntentEngine.testMatch(message, threshold);
});

ipcMain.handle('ai-set-enabled', (event, enabled) => {
  store.set('aiIntent.enabled', enabled);
  return true;
});

// ---- 快捷短语 ----

ipcMain.handle('get-quick-phrases', () => store.get('quickPhrases'));

ipcMain.handle('save-quick-phrases', (event, phrases) => {
  store.set('quickPhrases', phrases);
  return true;
});

ipcMain.handle('send-quick-phrase', (event, text) => {
  const view = shopManager?.getActiveView();
  if (view) view.webContents.send('send-reply', { message: text });
  return true;
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
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
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
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  })()`).catch(() => null);

  if (!coords) {
    console.log('[PDD助手] 未找到可点击的会话条目');
    return false;
  }

  console.log(`[PDD助手] sendInputEvent 点击会话 (${coords.x}, ${coords.y})`);
  view.webContents.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 80));
  view.webContents.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

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
 * @param {{ message: string, customer: string, conversationId: string }} data
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

  // 如果之前已下载模型且已启用，后台自动加载
  const aiCfg = store.get('aiIntent');
  if (aiCfg.modelStatus === 'ready' || aiCfg.enabled) {
    aiIntentEngine = new AIIntentEngine();
    aiIntentEngine.loadModel().then(() => {
      const intents = store.get('aiIntent.intents') || DEFAULT_AI_INTENTS;
      aiIntentEngine.updateIntents(intents.filter(i => i.enabled));
      console.log('[PDD助手] AI 意图引擎已自动加载');
    }).catch(err => {
      console.error('[PDD助手] AI 意图引擎自动加载失败:', err.message);
    });
  }

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
  if (activeId && shops.find(s => s.id === activeId)) {
    await shopManager.restoreCookies(activeId);
    shopManager.switchTo(activeId);
  } else if (shops.length > 0) {
    const realShop = shops.find(s => s.mallId || s.loginMethod);
    if (realShop) {
      await shopManager.restoreCookies(realShop.id);
      shopManager.switchTo(realShop.id);
    }
  }
});

app.on('before-quit', () => {
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
