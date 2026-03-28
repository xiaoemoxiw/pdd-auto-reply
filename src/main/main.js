const { app, BrowserWindow, Menu, ipcMain, session, dialog } = require('electron');
const path = require('path');
const { nativeImage } = require('electron');
const { ReplyEngine } = require('./reply-engine');
const { NetworkMonitor } = require('./network-monitor');
const { createSettingsWindow } = require('./settings-window');
const { createDebugWindow, sendToDebug } = require('./debug-window');
const { ShopManager } = require('./shop-manager');
const { SYSTEM_PHRASES, DEFAULT_SCENES, PHRASE_CATEGORIES, DEFAULT_AI_INTENTS } = require('./system-phrases');
const { AIIntentEngine, MODEL_ID, MODEL_SOURCES } = require('./ai-intent');
const { ApiLogger } = require('./api-logger');
const { PddApiClient } = require('./pdd-api');
const Store = require('electron-store');

const UNMATCHED_LOG_MAX = 200;

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
    shops: [],
    activeShopId: '',
    shopGroups: [],
    quickPhrases: [],
    shopCookies: {},
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

// 保留用于兼容
const PDD_CHAT_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html';

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
let aiIntentEngine = null;
let networkMonitors = new Map();  // shopId -> NetworkMonitor
const apiLogger = new ApiLogger();
const apiClients = new Map();     // shopId -> PddApiClient



// ---- 网络监控 ----

// 网络监控提取的消息去重（避免与 DOM 监听重复触发）
const networkMsgDedup = new Map(); // text -> timestamp

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
    onApiCapture(captureEntry) {
      const record = apiLogger.add(captureEntry);
      sendToDebug('api-capture', {
        id: record.id,
        timestamp: record.timestamp,
        category: record.category,
        method: record.request.method,
        url: record.request.shortUrl,
        status: record.response.status,
        bodySize: record.response.bodySize,
        isJson: record.response.isJson,
        hasPostData: !!record.request.postData,
      });
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

// ---- 窗口创建 ----

function createMainWindow() {
  const { width, height } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1100,
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
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    shopManager = null;
  });

  // 创建 ShopManager
  shopManager = new ShopManager(mainWindow, store, {
    onLog: (msg) => console.log(msg),
    onInjectScript: () => {},
    onNetworkMonitor: startNetworkMonitor,
    onDetectChat: () => {}
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
  if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' });
});

ipcMain.handle('diagnose-page', async () => {
  return { info: 'API 模式，无 BrowserView 可诊断' };
});

ipcMain.handle('open-debug-window', () => {
  createDebugWindow(mainWindow);
});

ipcMain.handle('reload-pdd', () => {
  // API 模式下无需重载页面
  return true;
});

ipcMain.handle('get-chat-url', () => store.get('chatUrl'));

ipcMain.handle('set-chat-url', (event, url) => {
  store.set('chatUrl', url);
  return true;
});

ipcMain.handle('get-current-url', () => '');

ipcMain.handle('navigate-pdd', () => true);

ipcMain.handle('inject-cookies', async (event, cookies) => {
  const shopId = shopManager?.getActiveShopId();
  if (!shopId) return false;
  const ses = session.fromPartition(`persist:pdd-${shopId}`);
  for (const cookie of cookies) {
    try { await ses.cookies.set(cookie); } catch (err) {
      console.error('设置 Cookie 失败:', err.message);
    }
  }
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

// ---- 视图切换 ----

ipcMain.handle('switch-view', (event, view) => {
  currentView = view;
  return true;
});

// ---- 店铺管理 IPC（列表/分组） ----

ipcMain.handle('get-shops', () => store.get('shops'));

ipcMain.handle('save-shops', (event, shops) => {
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

ipcMain.handle('send-quick-phrase', async (event, text) => {
  // 通过 Vue UI 的 IPC 通知前端显示，实际发送由前端调用 api-send-message
  mainWindow?.webContents.send('quick-phrase-insert', { text });
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

// ---- API 抓包 IPC ----

ipcMain.handle('api-capture-list', () => apiLogger.getSummaryList(200));

ipcMain.handle('api-capture-detail', (event, captureId) => apiLogger.getDetail(captureId));

ipcMain.handle('api-capture-categories', () => apiLogger.getCategories());

ipcMain.handle('api-capture-export', async (event, category) => {
  try {
    const filePath = category ? apiLogger.exportCategory(category) : apiLogger.exportToFile();
    return { success: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-capture-clear', () => {
  apiLogger.clear();
  return true;
});

ipcMain.handle('api-capture-log-dir', () => apiLogger.getLogDir());

// ---- PDD API 客户端 IPC ----

function getOrCreateApiClient(shopId) {
  if (!shopId) shopId = shopManager?.getActiveShopId();
  if (!shopId) return null;
  if (apiClients.has(shopId)) return apiClients.get(shopId);

  const client = new PddApiClient(shopId, {
    onLog: (msg) => {
      console.log(`[API:${shopId}] ${msg}`);
      sendToDebug('system-log', { type: 'info', text: msg });
    }
  });

  client.on('newMessage', (msg) => {
    mainWindow?.webContents.send('api-new-message', msg);
    sendToDebug('system-log', { type: 'important', text: `[API新消息] ${msg.senderName}: ${msg.content.slice(0, 50)}` });
    if (store.get('autoReplyEnabled')) {
      handleNewCustomerMessage({
        message: msg.content,
        customer: msg.senderName,
        conversationId: msg.sessionId,
      });
    }
  });

  client.on('sessionUpdated', (sessions) => {
    mainWindow?.webContents.send('api-session-updated', sessions);
  });

  client.on('authExpired', (info) => {
    mainWindow?.webContents.send('api-auth-expired', { shopId, ...info });
    console.log(`[PDD助手] 店铺 ${shopId} Token 已过期: ${info?.errorMsg || '会话已过期'}`);
  });

  client.on('messageSent', (data) => {
    mainWindow?.webContents.send('api-message-sent', data);
  });

  apiClients.set(shopId, client);
  return client;
}

ipcMain.handle('api-get-sessions', async (event, { shopId, page, pageSize } = {}) => {
  const client = getOrCreateApiClient(shopId);
  if (!client) return { error: '无活跃店铺' };
  try {
    return { data: await client.getSessionList(page, pageSize) };
  } catch (err) {
    return { error: err.message, authExpired: !!err.authExpired };
  }
});

ipcMain.handle('api-get-messages', async (event, { sessionId, page, pageSize }) => {
  const client = getOrCreateApiClient();
  if (!client) return { error: '无活跃店铺' };
  try {
    return { data: await client.getSessionMessages(sessionId, page, pageSize) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-send-message', async (event, { sessionId, text }) => {
  const client = getOrCreateApiClient();
  if (!client) return { error: '无活跃店铺' };
  try {
    const result = await client.sendMessage(sessionId, text);
    return { data: result };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-get-order-info', async (event, { orderId }) => {
  const client = getOrCreateApiClient();
  if (!client) return { error: '无活跃店铺' };
  try {
    return { data: await client.getOrderInfo(orderId) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-get-customer-info', async (event, { customerId }) => {
  const client = getOrCreateApiClient();
  if (!client) return { error: '无活跃店铺' };
  try {
    return { data: await client.getCustomerInfo(customerId) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('api-start-polling', (event, { shopId } = {}) => {
  const client = getOrCreateApiClient(shopId);
  if (!client) return { error: '无活跃店铺' };
  client.startMessagePolling();
  return { success: true };
});

ipcMain.handle('api-stop-polling', (event, { shopId } = {}) => {
  const sid = shopId || shopManager?.getActiveShopId();
  const client = sid ? apiClients.get(sid) : null;
  if (client) client.stopMessagePolling();
  return { success: true };
});

ipcMain.handle('api-get-token-status', () => {
  const client = getOrCreateApiClient();
  if (!client) return { hasToken: false, mallId: '', userId: '' };
  return client.getTokenStatus();
});

ipcMain.handle('api-discover-endpoints', async () => {
  const client = getOrCreateApiClient();
  if (!client) return { error: '无活跃店铺' };
  try {
    const captured = await client.discoverApiEndpoints();
    return { data: captured };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- 网络监控 IPC ----

ipcMain.handle('toggle-network-monitor', () => {
  // API 模式下网络监控由 API 客户端处理
  return true;
});

ipcMain.handle('get-network-monitor-status', () => {
  return { active: false, mode: 'api' };
});

// ---- 测试自动回复 ----

ipcMain.handle('test-auto-reply', async () => {
  // API 模式下通过 API 客户端发送测试消息
  const client = getOrCreateApiClient();
  if (!client) return { error: '无活跃 API 客户端' };
  return { info: 'API 模式，请使用消息流水线测试功能' };
});


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
    const replyData = {
      customer: data.customer,
      question: data.message,
      answer: result.reply,
      matched: result.matched,
      ruleName: result.ruleName,
      score: result.score,
      conversationId: data.conversationId,
    };

    // 优先通过 API 客户端直接发送
    const client = getOrCreateApiClient();
    if (client && data.conversationId) {
      try {
        await client.sendMessage(data.conversationId, result.reply);
        console.log(`[PDD助手] API 发送成功: "${result.reply.slice(0, 30)}" -> ${data.conversationId}`);
      } catch (err) {
        console.error(`[PDD助手] API 发送失败: ${err.message}`);
      }
    } else {
      console.log('[PDD助手] 无 API 客户端或 conversationId，无法发送');
    }

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
      fallbackCooldowns.set(data.customer, Date.now());
      await doSend();
    }, delay);

    pendingFallbacks.set(data.customer, timer);
  }
}

// 消息来源现在是 API 客户端的 newMessage 事件（在 getOrCreateApiClient 中绑定）
// 保留此 IPC 通道以兼容
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
  const shops = store.get('shops');
  if (!shops || shops.length === 0) {
    store.set('shops', MOCK_SHOPS);
  }
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

  const fs = require('fs');
  const devTokenPath = path.join(__dirname, '..', '..', 'test', 'tokens', 'sample-token.json');
  const hasDevToken = fs.existsSync(devTokenPath);

  console.log(`[PDD助手] NODE_ENV=${process.env.NODE_ENV}, devToken存在=${hasDevToken}`);

  if (hasDevToken) {
    console.log('[PDD助手] 检测到 test token，通过 ShopManager 导入');
    await shopManager.addByToken(devTokenPath);
  }

  // 启动后状态检查
  setTimeout(() => {
    const enabled = store.get('autoReplyEnabled');
    console.log(`[PDD助手] 自动回复状态: ${enabled ? '已开启' : '未开启'}`);
    console.log('[PDD助手] 架构模式: API 驱动 + Vue.js UI');
  }, 3000);

  /*
  // 旧版 BrowserView 诊断代码已完全移除
  if (false) { void(`(function(){
      var report = {};
      report.injected = false;
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
    }).catch(err => {});
  }, 15000);
  */

  if (!hasDevToken) {
    // 恢复上次活跃的店铺
    const activeId = store.get('activeShopId');
    const shops = store.get('shops') || [];
    if (activeId && shops.find(s => s.id === activeId)) {
      await shopManager.restoreCookies(activeId);
      shopManager.switchTo(activeId);
    } else if (shops.length > 0) {
      // 没有明确的 activeShopId，选第一个实际可用的店铺
      const realShop = shops.find(s => s.mallId || s.loginMethod);
      if (realShop) {
        await shopManager.restoreCookies(realShop.id);
        shopManager.switchTo(realShop.id);
      }
    }
  }
});

app.on('before-quit', () => {
  if (shopManager) shopManager.saveAllCookies();
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
