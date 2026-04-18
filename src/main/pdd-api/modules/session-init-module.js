'use strict';

const { BrowserWindow } = require('electron');
const { NetworkMonitor } = require('../../network-monitor');
const {
  DEFAULT_PAGE_CHROME_UA,
  normalizePddUserAgent,
  isChromeLikeUserAgent,
  applySessionPddPageProfile,
} = require('../../pdd-request-profile');

// 会话初始化业务模块。承接：在隐藏 BrowserWindow 中加载 chat-merchant
// 触发完整的 cookie/anti-content/conversation 模板抓取，构成所有后续接口
// 调用的"基础上下文"。模块通过 client 复用：会话/Token/Cookie 上下文、
// 业务错误归一化、bootstrap traffic 采集、对话模板就绪轮询。
//
// 状态：模块本身无可变状态。_sessionInited / _authExpired 仍由
// PddApiClient 持有，因为多个其它模块（getSessionList 兜底、
// getTokenStatus 上报、ChatPolling 决策）都需要直接读取这两个标志。

const PDD_BASE = 'https://mms.pinduoduo.com';
const CHAT_URL = `${PDD_BASE}/chat-merchant/index.html`;

class SessionInitModule {
  constructor(client) {
    this.client = client;
  }

  async initSession(force = false, options = {}) {
    const client = this.client;
    if (client._sessionInited && !force) return { initialized: true };

    client._authExpired = false;
    const source = String(options?.source || 'unknown').trim() || 'unknown';
    const shop = client._getShopInfo();
    client._log('[API] 会话初始化开始', { force: !!force, source });
    const cookieNamesBefore = await client._listCookieNames();
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        partition: client.partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const bootstrapUserAgent = normalizePddUserAgent(shop?.userAgent || client._getTokenInfo()?.userAgent || '');
    const bootstrapProfile = applySessionPddPageProfile(win.webContents.session, {
      userAgent: isChromeLikeUserAgent(bootstrapUserAgent) ? bootstrapUserAgent : DEFAULT_PAGE_CHROME_UA,
      tokenInfo: client._getTokenInfo(),
      clientHintsProfile: 'page'
    });
    if (bootstrapProfile?.userAgent) {
      win.webContents.setUserAgent(bootstrapProfile.userAgent);
    }

    const monitor = new NetworkMonitor(win.webContents, {
      onApiTraffic: entry => client._appendBootstrapTraffic(entry),
    });
    monitor.start();

    try {
      await win.loadURL(CHAT_URL);
      let settled = false;
      // 双判定：URL 跳到 chat-merchant 或 bootstrap 抓到模板/anti_content 任一就绪即提前结束。
      // 只看 URL 容易在快速通过 chat-merchant 后又因 SPA 路由跳走时一直等到 20s 超时。
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('/login')) break;
        if (currentUrl.includes('chat-merchant')) {
          settled = true;
          break;
        }
        const bootstrapStatus = client._getConversationBootstrapStatus();
        if (bootstrapStatus.ready) {
          settled = true;
          break;
        }
      }

      const finalUrl = win.webContents.getURL();
      client._sessionInited = settled;
      const bootstrapStatus = settled
        ? await client._waitForConversationBootstrap()
        : client._getConversationBootstrapStatus();
      client._log(`[API] 会话初始化${settled ? '成功' : '未完成'}`, { source });
      if (finalUrl.includes('/login')) {
        client._emitAuthExpired({
          errorMsg: '网页登录已失效，请重新登录或重新导入 Token',
          authState: 'expired',
          source: 'initSession',
        });
      }
      const cookieNamesAfter = await client._listCookieNames();
      const mainCookieContext = await client._getMainCookieContextSummary();
      return {
        initialized: settled,
        source,
        url: finalUrl,
        cookieNamesBefore,
        cookieNamesAfter,
        addedCookieNames: cookieNamesAfter.filter(item => !cookieNamesBefore.includes(item)),
        userAgentUsed: shop?.userAgent || client._getTokenInfo()?.userAgent || '',
        bootstrapStatus,
        mainCookieContext,
      };
    } finally {
      monitor.stop();
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

module.exports = { SessionInitModule };
