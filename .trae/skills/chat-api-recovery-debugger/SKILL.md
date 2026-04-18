---
name: "chat-api-recovery-debugger"
description: "排查 chat-api（接口对接客户对话）链路稳定性：会话列表空/慢、点击会话掉线、[TEXT]/[ID] 占位符、商品卡片错乱、anti_content 老化、后台 chat-merchant 被拉起。"
---

# chat-api 链路稳定性排查

当任务出现以下任一信号时，使用这个技能：

- 「客户对话（接口对接）」列表为空、加载耗时 ~20s、或反复显示「会话初始化未完成」
- 列表/消息中出现 `[TEXT]` / `[ID]` / `[REDACTED]` / `[URL]` / `[REQUEST_ID]` 占位符
- 点击会话 `POST /plateau/chat/list -> 500`、`userOrderQuantity bad params`
- 商品来源通知卡片显示「当前用户来自 商品详情页」或离谱价格（如 `¥9198528646.38`）
- `anti_content` 老化导致消息拉不到
- 静置或操作后日志再次出现 `chat-merchant` 后台运行时（`/service-market/chat/order-list`、`/chats/getToken`、`wss://m-ws.pinduoduo.com`、`wss://titan-ws.pinduoduo.com`、`/janus/api/heartbeat/v2`）
- `refund-order:page-request 触发聊天页准备` 出现

## 默认要求

- 先遵循 `chat-api-stability.md`、`main-process.md`、`embedded-page-compat.md` 的硬约束，再执行排查
- 优先复用 `PddApiClient`、`ShopManager`、`api-traffic-recorder`、`isSanitizedApiSessionEntry` 等现有模块，不另起一套
- 排查前先阅读 `docs/chat-api-recovery-handover.md`（"不要轻易回退的设计决策"一节为最高优先级）；`chat-api-stability-handover.md` 与 `pdd-stability-handover.md` 作为历史背景
- 不在输出/日志/截图/文档中泄露真实 Token、Cookie、`anti_content`、`mallId` 与买家 UID

## 信号 → 根因映射

开始前先按观察到的现象做一次粗分类：

| 现象 | 最可能根因 | 关键检查点 |
| --- | --- | --- |
| `[TEXT]` / `[ID]` 占位符出现 | 持久化脱敏 traffic 回流 | `getApiTraffic` 是否被改回回灌 `getPersistedApiTraffic`；新代码路径是否绕过了 `isSanitizedApiSessionEntry` |
| 列表 ~20s 才出来 / 一直空 | 前置 init 死等、polling 被改回 init | `getSessionList` / `getSessionMessages` 是否恢复了前置 init；`_pollMessagesForSession` / `_doPoll` 是否被放开 `allowInitSession: true`；`initSession` 双判定（URL + `_getConversationBootstrapStatus().ready`）是否被破坏 |
| `chat/list 500` + `bad params` | 上游会话被脏数据污染 | snapshot 里是否塞进了占位符会话；候选 `sessionId/buyerUid` 是否是 `[ID]` |
| 商品卡片标题错乱 / 离谱价 | `buildApiGoodsCardFallback` 字段映射错乱 | `pickApiGoodsText` 的 `title` keys 是否又加回 `'title'`；`pickApiGoodsNumber` 的 `priceText` keys 是否又加回独立 `'price'`；是否真的优先读了 `goods_info` 子对象具名字段 |
| 进入 chat-api 列表持续为空且日志报"未在线" | 启动时未自动校验店铺 | `getApiSessionsByScope` 在 `targetShops.length === 0` 时是否触发 `safeValidateShops`；该自动校验是否被错误扩散到所有 IPC |
| `chat-merchant` 后台被拉起 | 业务接口走了页面回退 | `apiGetSideOrders` / `apiGetRefundOrders` / `ticket-api` 调用是否漏带 `allowPageRequest: false`；`hideActiveView()` 是否仍在导航到 `about:blank`；自动回复是否退回了 DOM 发送 |

## 排查流程

1. 在终端 / 渲染层 console 收集近一次复现的关键日志关键字（占位符、`templateSource`、`init` 相关、`chat-merchant` 链路）
2. 对照"信号 → 根因映射"先锁定 1~2 个最可疑根因
3. 在 `src/main/main.js`、`src/main/pdd-api.js`、`src/main/register-api-ipc.js`、`src/renderer/chat-api-module.js` 中按映射的"关键检查点"做最小阅读
4. 必要时打开 `artifacts/api-traffic/api-traffic-index.json` 与 `api-traffic-log.jsonl`，确认抓包样本是否被运行时误用
5. 改动严格遵守 `chat-api-stability` 的"不要轻易回退清单"
6. 改完后按下方"验证步骤"完整跑一遍

## 验证步骤（必须全跑）

完整退出整个 Electron 应用后 `npm run dev`，然后：

1. **启动 → 列表**：直接进入「客户对话（接口对接）」（不必先到店铺管理点"接口校验"）
   - 若店铺非 online，日志应出现 `api-session-auto-validate { successCount: 1, ... }`，几秒内升 online
   - 应看到 `[API] 拉取会话列表 { templateSource: 'fallback' }` + `latest_conversations -> 200` + `api-get-sessions 返回 N 条`
   - 渲染层 `renderApiSessions dom-ready`，列表显示真实昵称/头像/最后消息，**没有** `[TEXT]` / `[ID]` 等占位符
2. **点击会话 → 消息**：点列表里任意会话
   - `POST .../plateau/chat/list -> 200`、`[API] chat/list 候选响应 { count: N }`
   - 中间面板显示消息；商品来源通知卡片显示真实标题与主图
3. **静置 → 不掉线**：进入 chat-api 后不操作 5~10 分钟
   - 日志**不再出现** `/service-market/chat/order-list` / `/chats/getToken` / `wss://m-ws.pinduoduo.com` / `wss://titan-ws.pinduoduo.com` / `/janus/api/heartbeat/v2`
   - 不再出现 `refund-order:page-request 触发聊天页准备`

## 输出要求

完成排查后需要说明：

- 现象命中的是哪一类信号、根因落在哪个模块
- 复用了哪些现有模块/防线（`isSanitizedApiSessionEntry`、`PddApiClient` 已有方法、`safeValidateShops` 等）
- 改动是否触碰"不要轻易回退清单"，如果触碰必须给出明确替代方案
- 三段验证的实际结果，以及是否还存在 `B / C / D / E` 中的后续可选项需要跟进

## 避免

- 为了"启动就有兜底数据"把 `getPersistedApiTraffic` 回灌打开
- 为了"加快初始化"把 polling 改成 `allowInitSession: true`
- 为了"补全商品价格"把不确定字段（如 `total_amount`）当成价格显示
- 把 `safeValidateShops` 自动校验扩散到所有 IPC
- 把"打开会话后自动加载侧栏订单/退款"恢复为默认行为
- 在 `chat-api` 场景里调用 `apiGetSideOrders` / `apiGetRefundOrders` 时漏掉 `allowPageRequest: false`
