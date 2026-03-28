# 元尾巴 · 拼多多客服助手

基于 Electron 的拼多多客服自动回复桌面应用，由**元尾巴**出品。通过嵌入拼多多官方商家后台网页，配合 JS 注入实现消息监听和自动回复。

## 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                    Electron 主窗口                         │
│  ┌────────────────────────────────────────────────────┐  │
│  │  工具栏 (index.html)                                │  │
│  │  [自动回复开关] [设置] [日志] [刷新] [DevTools]       │  │
│  ├────────────────────────────────────────────────────┤  │
│  │                                                    │  │
│  │  BrowserView — 拼多多官方客服页面                     │  │
│  │  https://mms.pinduoduo.com/service/index           │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────┐              │  │
│  │  │ 注入脚本 (auto-reply.js)          │              │  │
│  │  │ · MutationObserver 监听新消息     │              │  │
│  │  │ · 模拟输入框填写 + 点击发送        │              │  │
│  │  └──────────────────────────────────┘              │  │
│  │                                                    │  │
│  ├────────────────────────────────────────────────────┤  │
│  │  状态栏: 连接状态 | 已回复条数                        │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 核心模块

```
src/
├── main/                   # Electron 主进程
│   ├── main.js             # 应用入口：窗口管理、BrowserView、IPC 通信
│   ├── reply-engine.js     # 自动回复规则引擎（关键词匹配/正则/精确匹配）
│   └── settings-window.js  # 设置窗口管理
├── preload/                # 预加载脚本（安全通信桥）
│   ├── preload.js          # 工具栏 UI ↔ 主进程 通信
│   └── pdd-preload.js      # 拼多多网页 ↔ 主进程 通信
├── inject/                 # 注入到拼多多网页的脚本
│   └── auto-reply.js       # DOM 监听 + 消息发送 + 调试接口
└── renderer/               # 前端页面
    ├── index.html          # 主窗口工具栏 + 状态栏 + 日志面板
    └── settings.html       # 自动回复规则配置界面
```

### 数据流

```
买家发送消息
    ↓
拼多多网页 DOM 更新
    ↓
auto-reply.js (MutationObserver 检测到新消息)
    ↓ window.postMessage
pdd-preload.js (转发到主进程)
    ↓ ipcRenderer.send
main.js → reply-engine.js (关键词匹配)
    ↓ 匹配成功
pdd-preload.js (接收回复指令)
    ↓ window.postMessage
auto-reply.js (模拟输入 + 点击发送)
    ↓
买家收到自动回复
```

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm

### 安装

```bash
cd pdd-auto-reply
pnpm install
```

### 运行

```bash
pnpm start
```

开发模式（打开 DevTools）：

```bash
pnpm dev
```

### 首次使用

1. 启动后会自动加载拼多多商家后台页面
2. 在嵌入的页面中**手动登录**拼多多商家账号
3. 登录后进入客服聊天页面
4. 点击工具栏 **DevTools** 按钮，检查聊天区域的 DOM 结构
5. 如果 DOM 选择器不匹配，在 DevTools 控制台中使用调试接口调整：
   ```js
   // 查看当前选择器
   __PDD_HELPER__.getSelectors()
   // 修改选择器（根据实际 DOM 结构调整）
   __PDD_HELPER__.setSelector('chatContainer', '.your-actual-selector')
   __PDD_HELPER__.setSelector('customerMessage', '.your-actual-selector')
   ```
6. 在工具栏点击 **设置** 配置自动回复规则
7. 打开 **自动回复** 开关

## 自动回复规则

规则支持三种匹配模式：

| 模式 | 说明 | 示例 |
|------|------|------|
| 包含关键词 | 消息中包含任一关键词即触发 | 关键词 `发货` 匹配 "什么时候发货？" |
| 完全匹配 | 消息与关键词完全一致才触发 | 关键词 `你好` 仅匹配 "你好" |
| 正则匹配 | 使用正则表达式匹配 | `发货\|物流\|快递` 匹配包含任一词的消息 |

回复内容支持变量：
- `{time}` — 当前时间（如 14:30:00）
- `{date}` — 当前日期（如 2026/2/24）

规则支持设置**优先级**（数字越大优先级越高），多规则匹配时取优先级最高的。

## 对接 Token（后续）

当 C# 项目的 token 抓取功能就绪后，可通过以下方式注入登录凭证：

```js
// 在主进程或通过 IPC 调用
await window.pddApi.injectCookies([
  {
    url: 'https://mms.pinduoduo.com',
    name: 'cookie_name',
    value: 'cookie_value',
    domain: '.pinduoduo.com',
    path: '/'
  }
  // ... 其他 cookie
]);
```

注入后会自动跳转到客服页面。

## 后续开发计划

- [ ] 对接 C# 项目的 token 自动注入
- [ ] 根据实际拼多多 DOM 结构调整选择器
- [ ] 支持图片消息自动回复
- [ ] 支持多店铺切换
- [ ] 支持按店铺配置不同的回复规则
- [ ] 接入 AI 大模型实现智能回复
- [ ] 自动回复统计和数据分析
