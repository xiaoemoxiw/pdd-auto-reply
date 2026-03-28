const { ipcRenderer } = require('electron');

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
      conversationId: event.data.conversationId
    });
  }

  if (event.data?.type === 'PDD_CLICK_SEND') {
    ipcRenderer.send('click-send-button', {
      x: event.data.x,
      y: event.data.y
    });
  }
});
