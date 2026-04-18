# PDD 掉线问题交接清单

## 背景

本轮排查的核心问题是:

- 在未主动进入聊天页的情况下，应用会隐式拉起 `chat-merchant`
- 一旦聊天运行时被后台带起，就会出现完整聊天链路:
  - `/service-market/chat/order-list`
  - `/chats/getToken`
  - `wss://m-ws.pinduoduo.com`
  - `wss://titan-ws.pinduoduo.com`
  - `/plateau/chat/*`
- 随后可能出现掉线或会话异常

当前版本已经把主要高风险链路收掉，并完成了一轮稳定性验证。

## 当前稳定结论

- `空闲不操作` 目前稳定
- 店铺管理里的 `接口校验` 目前稳定
- 店铺管理里的 `探针` 当前组合已验证稳定:
  - 待开票概览
  - 工单状态统计
  - 待开票列表
  - 违规列表
- 自动回复开启后，目前未再复现“后台隐式拉起完整聊天运行时”的掉线

## 已保留改动

### 1. 隐式聊天页恢复链已收口

- 主界面默认视图改为 `shops`，不再默认进 `chat`
- `inject-cookies` 不再强制跳到聊天页，只在当前就是嵌入页时重载当前目标页
- `app.on('activate')` 在非嵌入页下不再无条件 `switchTo(activeShopId)`
- 非嵌入页执行 `switch-shop` 时，不再先 `switchTo()` 再隐藏视图
- 启动后默认只恢复静态店铺选择，不自动恢复网页会话
- 首次创建嵌入页时，会直接加载目标业务页，不再先默认落到 `chat-merchant`
- 导入/刷新成功后，不再自动 `switchTo(shopId)` 进入聊天页

### 2. 店铺管理显式探针已建立

- 店铺管理操作列新增 `探针` 按钮
- `Token文件` 列已移除，操作列宽度已放宽，避免按钮被挤掉
- 探针只做显式触发，不并回 `接口校验`
- 当前探针包含:
  - `invoiceOverview`
  - `invoiceList`
  - `ticketStatusCount`
  - `violationList`

### 3. 纯接口请求层已统一

- 已新增共享请求基座: `src/main/pdd-business-api-client.js`
- 已迁移到该基座的业务接口:
  - `src/main/invoice-api.js`
  - `src/main/violation-api.js`
  - `src/main/ticket-api.js`
- 统一内容包括:
  - `session.fetch`
  - Cookie / 身份头
  - `Referer`
  - 登录页识别
  - 业务错误归一化

### 4. 业务请求体已修正

- `invoice_list` 请求上下文已对齐:
  - `invoice` 页面 URL 补 `activeKey=0`
  - 请求体补 `invoice_way`
  - 请求体补 `subsidy_type`
- `violation` 列表请求体已修正:
  - 若未显式传状态筛选，不再覆盖抓包样本里的 `appealStatus` 数组

### 5. 自动回复发送策略已调整

- 之前只有 `api-polling` 来源会走接口发送
- `network-monitor` 和 `embedded-dom` 来源即使拿到了 `shopId + sessionRef`，仍会走隐藏网页 DOM 发送
- 现已改为:
  - 只要拿得到 `shopId + sessionRef`
  - 自动回复统一优先走 `sendManualMessage()`
  - 只有拿不到会话标识时，才回退到隐藏网页 DOM 发送
- 这条改动是压住后台聊天运行时隐式启动的关键修复

## 当前仍保留的特殊逻辑

- `ticket-api` 仍保留 `requestInPddPage` 页面回退能力
- 但工单状态探针调用时已显式传 `allowPageRequest: false`
- 也就是说:
  - 工单真实业务能力仍可在必要时使用页面回退
  - 探针这类只读校验不会再借此拉起聊天页

## 建议保留现状

- 不要把 `探针` 能力并回 `接口校验`
- 不要恢复“启动自动恢复网页会话”
- 不要恢复“导入成功后自动进聊天页”
- 不要把 `invoice` / `violation` / `ticket` 再统一回页面请求链
- 自动回复保持“接口优先，DOM 回退兜底”的当前策略

## 建议继续观察的场景

- 自动回复开启后正常收消息
- 长时间空闲放置
- 店铺管理中点击 `接口校验`
- 店铺管理中点击 `探针`

## 若后续再次出现掉线

优先看终端是否重新出现整串聊天运行时日志:

- `/service-market/chat/order-list`
- `/chats/getToken`
- `wss://m-ws.pinduoduo.com`
- `wss://titan-ws.pinduoduo.com`
- `/plateau/chat/*`

如果再次出现，优先怀疑:

- 自动回复消息来源回退到了隐藏网页 DOM 发送
- 某条新业务链又重新触发了 `requestViaPddPage()` / `ensurePddPageViewReady()`

## 建议下一步

适合由下一位同事继续做的工作:

1. 先观察当前版本一段时间，不急着继续扩大功能面
2. 若继续优化，优先做“剩余页面请求入口盘点”:
   - `src/main/pdd-api.js`
   - `src/main/main.js`
   - `src/main/register-api-ipc.js`
3. 重点确认哪些入口属于“显式聊天能力”，哪些仍可能被后台链路误触发
4. 若要继续收口，优先目标是:
   - 让更多能力走纯接口发送/请求
   - 进一步减少对 `requestViaPddPage()` 和 `ensurePddPageViewReady()` 的依赖
5. 若无新问题，建议进入稳定观察期，而不是继续大改

## 关键文件

- `src/main/main.js`
- `src/main/pdd-business-api-client.js`
- `src/main/invoice-api.js`
- `src/main/violation-api.js`
- `src/main/ticket-api.js`
- `src/main/register-api-ipc.js`
- `src/main/register-shop-ipc.js`
- `src/main/shop-manager.js`
- `src/renderer/index.html`
- `src/renderer/shops-module.js`
