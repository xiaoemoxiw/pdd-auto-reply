# Chat-API 稳定性专项交接

> 本文记录的是"先止血、不掉线"阶段的进展，文中"未解决问题"已在续篇中处理。
> 续篇见 `docs/chat-api-recovery-handover.md`，请优先阅读续篇了解最新状态，本文仅作为历史背景保留。

## 目标

本轮排查的目标不是恢复完整聊天页能力，而是先把 `客户对话（接口对接）` 这一条链稳定下来，避免它在后台隐式拉起真实 `chat-merchant` 聊天运行时，进而导致整店铺掉线。

当前进展可以概括为两句话:

- `chat-api` 会话列表已经可以通过页面抓包回退显示出来
- 但点击具体会话时，后台仍会被某些附加链路重新带起真实聊天运行时，问题还没有彻底收住

## 当前已确认的事实

### 1. 会话列表已能显示

- `chat-api` 当前可以显示至少 1 条会话
- 这条会话不是由 `latest_conversations` 直调返回，而是由页面抓包回退拿到
- 日志特征:
  - `latest_conversations 直调为空，回退页面抓取缓存`
  - `api-get-sessions 返回 1 条`
  - `renderApiSessions totalSessions:1`

### 2. 点击会话仍会掉线

- 自动打开会话的问题已经去掉
- 现在必须手动点击左侧会话，才会复现掉线
- 说明触发点已经缩小到“打开会话后的详情/侧栏链路”

### 3. 真实聊天运行时仍会在后台出现

以下日志已经多次出现，说明后台真实聊天页仍会被带起:

- `/service-market/chat/order-list`
- `/chats/getToken`
- `wss://m-ws.pinduoduo.com`
- `wss://titan-ws.pinduoduo.com`
- `/janus/api/heartbeat/v2`
- `/plateau/chat/marked_lastest_conversations`
- `/plateau/chat/get_banner_reminder`

这些都不是 `chat-api` 纯接口页“只读列表/消息”场景应主动打出的请求。

### 4. 明确抓到过页面回退触发源

日志中已经出现过这条关键证据:

- `refund-order:page-request 触发聊天页准备: about:blank -> https://mms.pinduoduo.com/chat-merchant/index.html`

这说明至少有一条“退款/侧栏订单相关”链路，会在打开会话后把后台 `BrowserView` 从 `about:blank` 再次带进真实聊天页。

## 本轮已完成的代码收口

### 1. 嵌入网页聊天入口已停用

目的:

- 防止用户显式进入 `chat-merchant`
- 强制引导到 `客户对话（接口对接）`

主要改动:

- `src/renderer/index.html`
- 左侧 `客户对话（嵌入网页）` 改为停用态
- 点击后统一跳转 `chat-api`
- 恢复旧 `chat` 视图时也会自动转到 `chat-api`

### 2. `chat-api` 会话列表读取已改成安全模式

目的:

- 读取会话列表时不再隐式 `initSession()`
- 先保住“不掉线”，再谈恢复能力

主要改动:

- `src/main/pdd-api.js`
  - `getSessionList(page, pageSize, options)`
  - 新增 `allowInitSession`
- `src/main/main.js`
  - `loadShopApiSessions()` 调用 `getSessionList(..., { allowInitSession: false })`
- `src/main/main.js`
  - 已去掉 `testConnection()` 自动兜底，避免 `janus 430` 污染判断

### 3. 会话列表模板/抓包解析已修正

目的:

- 让历史抓包里的对象型 `requestBody/responseBody` 能被模板复用

主要改动:

- `src/main/pdd-api.js`
  - `_safeParseJson()` 现在能直接处理对象
- `src/main/pdd-api.js`
  - 会话摘要日志补了:
    - `dataConversations`
    - `resultDataConversations`
    - `resultConversations`
    - `rootConversations`

### 4. 会话列表本地过滤已放宽

目的:

- 避免接口实际返回会话，但因为近两天过滤或时间字段异常被本地清空

主要改动:

- `src/main/pdd-api.js`
  - 如果原始解析已有会话，但近两天过滤后为空，会回退展示原始会话

### 5. 自动打开会话行为已关闭

目的:

- 列表出现后不再自己打开上次会话
- 避免“像是用户点了，实际是页面自己开的”

主要改动:

- `src/renderer/index.html`
  - 去掉 `restoreApiLastSessionSelection()` 自动打开
  - `loadApiSessions({ keepCurrent })` 不再默认自动刷新当前会话详情

### 6. 消息读取已改成安全模式

目的:

- 点击会话时，不再因为消息接口自动走 `initSession()`

主要改动:

- `src/main/pdd-api.js`
  - `getSessionMessages(sessionRef, page, pageSize, options)`
  - 新增 `allowInitSession`
- `src/main/register-api-ipc.js`
  - `api-get-messages` 显式传 `allowInitSession: false`

### 7. 打开会话后的自动副作用已分批关闭

已经去掉的动作:

- 自动 `apiMarkLatestConversations()`
- 打开会话前自动 `loadApiTokenStatus()`
- `chat/list` 失败后自动向全局抛 `authExpired`
- 安全模式消息请求里的主 Cookie 自动补刷/重试链

对应文件:

- `src/renderer/index.html`
- `src/main/pdd-api.js`

### 8. 店铺隐藏视图的默认行为已收口

主要改动:

- `src/main/shop-manager.js`

包括:

- `switchTo()` 中，空白 `BrowserView` 默认不再加载 `chat-merchant`，改为 `PDD_HOME_URL`
- `hideActiveView()` 不再只是移除视图，还会把隐藏页导航到 `about:blank`

注意:

- 这两条都是主进程改动
- 当前开发环境只会自动刷新渲染层，不会自动重启主进程
- 所以测试这些改动时必须彻底重启整个应用

### 9. 自动侧栏订单/退款加载已暂停

这是目前最关键的一刀。

已确认:

- `refund-order:page-request` 来自退款/侧栏订单信息链
- 侧栏渲染会自动调用:
  - `apiGetSideOrders()`
  - 某些退款流程会调用 `apiGetRefundOrders()`

当前改动:

- `src/renderer/chat-api-module.js`
- `renderApiSideOrders()` 不再因为侧栏为空而自动 `loadApiSideOrders(tab)`
- 现在侧栏只显示提示:
  - `侧栏订单与退款信息已暂停自动加载，请先稳定查看消息。`

## 当前最重要的未解决问题

### 问题 1: 后台真实聊天运行时仍可能被带起

虽然已经做了多轮收口，但日志仍多次显示:

- `service-market/chat/order-list`
- `chats/getToken`
- `m-ws`
- `titan-ws`
- `heartbeat`

这说明:

- 仍有某条隐藏链路会让后台 `BrowserView` 实际进入聊天运行时
- 当前最可疑的来源仍是“打开会话后自动侧栏订单/退款相关能力”

### 问题 2: 会话列表依赖页面抓包回退

现在的列表虽然能出，但核心不是纯接口直调成功，而是:

- `latest_conversations` 直调结果为空
- 最终回退到页面抓取缓存

也就是说:

- 当前只能算“列表可显示”
- 还不能算“纯接口能力已经恢复稳定”

### 问题 3: 消息详情链还没有确认彻底稳定

目前还没有拿到“手动点会话后稳定显示消息且不掉线”的确定结论。

## 建议下一位同事优先继续的方向

### 第一优先: 先确认主进程收口是否真正生效

必须按下面步骤测试:

1. 完全退出整个 Electron 应用
2. 重新启动应用
3. 先不要点任何会话
4. 观察是否仍提前出现:
  - `/service-market/chat/order-list`
  - `/chats/getToken`
  - `wss://m-ws.pinduoduo.com`
  - `wss://titan-ws.pinduoduo.com`
  - `/janus/api/heartbeat/v2`

如果这些日志在进入 `chat-api` 之前就出现，说明仍有主进程/隐藏视图链路没收住。

### 第二优先: 继续追 `refund-order:page-request`

这条日志是目前最明确的页面回退证据。

建议重点排查:

- `src/renderer/chat-api-module.js`
  - 侧栏订单
  - 退款单选择器
  - 是否仍有其它路径会触发 `apiGetRefundOrders`
- `src/main/pdd-api.js`
  - `getRefundOrders()`
  - `getSessionSideOrders()`
  - 这些函数内部是否仍默认允许页面回退

建议方向:

- 把 `apiGetRefundOrders` / `apiGetSideOrders` 也改成默认安全模式
- 或者在 `chat-api` 场景下，显式传 `allowPageRequest: false`

### 第三优先: 如果后台视图仍会保活，直接考虑更强策略

如果重启后后台聊天运行时仍然会自动出现，可以考虑:

- 切到非嵌入页时，不只是 `removeBrowserView`
- 而是直接销毁该 `BrowserView`
- 需要时再重新创建

这会比“停到 `about:blank`”更激进，但能更彻底地切掉后台运行时。

### 第四优先: 会话列表纯接口化仍未完成

当前只是把列表“显示出来”。

下一位同事如果继续恢复纯接口能力，建议重点对比:

- 当前 `latest_conversations` 请求体
- 历史抓包里有会话时的请求体
- 重点字段:
  - `client`
  - `anti_content`
  - `page`
  - `size`
  - `end_time`

## 建议不要立刻恢复的能力

在问题完全收住前，不建议恢复这些行为:

- 自动恢复上次会话
- 自动刷新当前会话详情
- 打开会话后自动标已读
- 打开会话后自动加载侧栏订单/退款
- 打开消息时自动 `initSession()`
- `chat-api` 失败后自动走 `testConnection()`

## 已知现象与判读标准

### 可以接受的现象

- `chat-api` 列表通过页面抓包回退显示 1 条会话
- 打开 `chat-api` 后只看到列表，不自动打开会话
- 侧栏提示“已暂停自动加载”

### 需要继续警惕的现象

只要出现下面任意一种，都说明后台真实聊天页仍被带起:

- `/service-market/chat/order-list`
- `/chats/getToken`
- `wss://m-ws.pinduoduo.com`
- `wss://titan-ws.pinduoduo.com`
- `/janus/api/heartbeat/v2`
- `refund-order:page-request 触发聊天页准备`

## 相关文件

- `src/main/pdd-api.js`
- `src/main/main.js`
- `src/main/register-api-ipc.js`
- `src/main/shop-manager.js`
- `src/renderer/index.html`
- `src/renderer/chat-api-module.js`
- `docs/pdd-stability-handover.md`

## 交接建议

建议下一位同事先不要继续扩功能，先按下面顺序接手:

1. 彻底重启应用复测主进程改动是否生效
2. 确认后台真实聊天运行时是否仍会在未点击会话前出现
3. 继续追 `refund-order:page-request` 和 `apiGetSideOrders/apiGetRefundOrders`
4. 只有在“点会话不掉线”稳定后，再恢复侧栏订单/退款能力