const { ipcRenderer } = require('electron');

function injectNotificationBlocker() {
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.textContent = `
    (() => {
      try {
        const BlockedNotification = function Notification() {
          throw new Error('Notifications are blocked in embedded PDD page');
        };
        BlockedNotification.permission = 'denied';
        BlockedNotification.requestPermission = () => Promise.resolve('denied');
        Object.defineProperty(window, 'Notification', {
          configurable: true,
          enumerable: false,
          writable: false,
          value: BlockedNotification,
        });
        if (navigator && navigator.permissions && typeof navigator.permissions.query === 'function') {
          const rawQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (descriptor) => {
            if (descriptor && descriptor.name === 'notifications') {
              return Promise.resolve({
                state: 'denied',
                onchange: null,
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() { return false; },
              });
            }
            return rawQuery(descriptor);
          };
        }
      } catch (error) {
        console.warn('[PDD助手] 屏蔽页面通知失败:', error);
      }
    })();
  `;
  const target = document.head || document.documentElement;
  if (!target) return;
  target.prepend(script);
  script.remove();
}

if (document.readyState === 'loading') {
  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive') injectNotificationBlocker();
  }, { once: true });
} else {
  injectNotificationBlocker();
}

/**
 * PDD 页面的 preload 脚本
 * 负责在拼多多网页内建立与主进程的通信通道
 */

// 接收主进程发来的自动回复开关
ipcRenderer.on('auto-reply-toggle', (_, enabled) => {
  window.postMessage({ type: 'PDD_AUTO_REPLY_TOGGLE', enabled }, '*');
});

// 接收主进程发来的回复指令
ipcRenderer.on('send-reply', (_, data) => {
  window.postMessage({ type: 'PDD_SEND_REPLY', ...data }, '*');
});

// 监听注入脚本发来的消息
window.addEventListener('message', (event) => {
  if (event.data?.type === 'PDD_NEW_MESSAGE') {
    ipcRenderer.send('new-customer-message', {
      message: event.data.message,
      customer: event.data.customer,
      conversationId: event.data.conversationId,
      source: event.data.source || 'embedded-dom'
    });
  }

  if (event.data?.type === 'PDD_CLICK_SEND') {
    ipcRenderer.send('click-send-button', {
      x: event.data.x,
      y: event.data.y,
      conversationId: event.data.conversationId || '',
      messagePreview: event.data.messagePreview || '',
      source: event.data.source || 'embedded-dom-auto-reply'
    });
  }

  if (event.data?.type === 'PDD_USER_ACTION') {
    ipcRenderer.send('embedded-page-user-action', {
      actionType: event.data.actionType || 'click',
      pageUrl: event.data.pageUrl || window.location.href,
      targetText: event.data.targetText || '',
      targetTag: event.data.targetTag || '',
      targetRole: event.data.targetRole || '',
      targetHref: event.data.targetHref || '',
      targetSelector: event.data.targetSelector || '',
      x: event.data.x,
      y: event.data.y,
      messagePreview: event.data.messagePreview || '',
      source: event.data.source || 'embedded-page'
    });
  }
});
