# Chat-API 能力恢复阶段交接

本文是 `docs/chat-api-stability-handover.md` 的续篇。
上一轮的目标是"先止血、不掉线"；这一轮的目标是在不打破止血的前提下，把 `客户对话（接口对接）` 这条链的"列表能加载、消息能拉到、商品卡片能显示"重新跑通。

阅读顺序建议：

1. 先读 `docs/pdd-stability-handover.md`：了解整体掉线问题的处理脉络。
2. 再读 `docs/chat-api-stability-handover.md`：了解上一轮 `chat-api` 安全模式怎么落地的。
3. 最后看本文：了解本轮把 `chat-api` 从"只能空显示"恢复到"能用"的具体路径，以及还没做的事。

## 当前稳定结论

完整重启应用后，进入「客户对话（接口对接）」的体验：

- 启动到会话列表显示约 1~3 秒（取决于主 Cookie 上下文刷新耗时），不再有 ~20 秒 init 阻塞。
- 会话列表显示真实昵称 / 头像 / 最后消息 / 时间，没有 `[TEXT]` / `[ID]` / `[REDACTED]` 占位符。
- 点击会话立刻拉到消息：`POST /plateau/chat/list -> 200`。
- 商品来源通知卡片显示正确的商品标题和主图。
- 静置不操作，主进程未观察到隐式 `chat-merchant` 拉起或互踢掉线。

## 上一轮遗留的根因与本轮修复

### 根因 1：脱敏过的持久化抓包污染了运行时数据流

**症状**：

- 会话列表里出现假会话，标题、最后消息、徽标都是字面量 `[TEXT]`，头像是破图。
- 点击此假会话拉消息，`POST /plateau/chat/list -> 500`。
- 兜底 `latitude/order/userOrderQuantity` 报 `bad params`。
- 日志里 `customerId / userUid / sessionId` 全是 `[ID]`。

**根因**：

`api-traffic-sanitizer.js` 定义了脱敏占位符（`[TEXT]` / `[ID]` / `[REDACTED]` / `[URL]` / `[REQUEST_ID]`），用来把抓包数据写入 `artifacts/api-traffic` 落盘。
但旧版 `getApiTraffic(shopId)` 在 runtime 抓包不足 20 条时，会自动合并 `getPersistedApiTraffic(shopId)`（即落盘的脱敏副本）回填运行时。

下游所有依赖立刻被污染：

- `extractApiSessionsFromTraffic` 把脱敏的 `latest_conversations` 响应解析成假会话，`customerName='[TEXT]'`、`sessionId='[ID]'`。
- 这条假会话被 `setApiSessionSnapshot` 缓存进内存。
- 渲染层把它作为正常会话画出来：`[TEXT]` 文案 + 破图（avatar URL 是 `[URL]`，`<img src="[URL]">` 加载失败）。
- 用户点击假会话 → `chat/list` 用 `candidate.id='[ID]'` 请求 → 服务器 500。
- 走 latitude 兜底要 `buyerUid` → 也是 `[ID]` → `userOrderQuantity` 报 `bad params`。
- `chat/list` 兜底使用的请求模板也来自脱敏 traffic，里面 `anti_content/cookie/uid` 全是占位符 → 即使有模板也发不出去。

**本轮修复**：`src/main/main.js`

```js
function getApiTraffic(shopId) {
  // 仅返回运行时实抓的请求/响应。
  // 持久化的 artifacts/api-traffic 已脱敏（content/nickname → [TEXT]，uid/session_id → [ID]，
  // anti_content/cookie → [REDACTED]），既不能当请求模板（发出去服务器 500），
  // 也不能当渲染兜底（会话列表会出现"[TEXT]"占位符），所以这里不再回灌。
  return (apiTrafficStore.get(shopId) || []).map(normalizeTrafficEntry);
}
```

同时移除已不再需要的 `getPersistedApiTraffic` 引入。

并新增 `isSanitizedApiSessionEntry()` 作为第二道防线：任何会话条目里 `sessionId / customerId / userUid / customerName / customerAvatar / lastMessage / conversationId / chatId / rawId` 命中 `[TEXT]` / `[ID]` / `[REDACTED]` / `[URL]` / `[REQUEST_ID]` 五个占位符之一的，立即丢弃。

```js
function isSanitizedApiSessionEntry(item = {}) { ... }
```

`setApiSessionSnapshot` 与 `enqueueRendererApiSessionUpdate` 双双在 `.filter()` 里调用此函数，确保以后即使其它路径塞脏数据也进不到 snapshot 和渲染层。

### 根因 2：商品卡片 fallback 字段映射错误

**症状**：

- "用户来自商品详情页"通知卡片显示标题为 `当前用户来自 商品详情页`（系统提示文案，不是商品名）。
- 价格栏出现离谱数字（如 `¥9198528646.38`），主图缺失。

**根因**：`src/renderer/chat-api-module.js` 的 `buildApiGoodsCardFallback`

旧实现把 `message.raw.info` 整个对象塞进 `sources`，再交给 `pickApiGoodsText` / `pickApiGoodsNumber` 做深度遍历：

- `title` 的 keys 列表把 `'title'` 排第一 → 命中 `raw.info.title = "当前用户来自 商品详情页"` → 系统文案被当成商品名。
- `priceText` 的深度遍历在 preferredKeys 全不命中后扫 `Object.values` 取第一个 Finite 数字 → 常常命中 `goods_info.goods_id`（如 `919852864638`），再经 `formatApiGoodsPrice` 的 `/100` 规则变成 `¥9198528646.38`。
- 真实商品信息其实挂在 `raw.info.goods_info`，字段是 `goods_name` / `goods_thumb_url` / `mall_link_url` / `min_group_price` 等，sources 顶层根本没这些字段。

**本轮修复**：

- 优先在 `[raw.info.goods_info, raw.info.data.goods_info, extra.goods_info, raw.extra.goods_info, raw.biz_context.goods_info, raw.goods_info, session.goodsInfo, session.raw.goods_info, session.raw.goods]` 里找第一个对象，**精确按字段名取值**：`goods_id` / `goods_name` / `goods_thumb_url` / `mall_link_url` / `min_group_price` / `group_price` / `promotion_price` / `min_normal_price` / `min_price` / `price`。
- 旧 `pickApiGoods*` 路径仍作兜底，但：
  - `title` 的 keys 去掉 `'title'`（只留 `goods_name` / `goodsName` / `goodsTitle`），防止系统文案污染；
  - `priceText` 的 keys 去掉独立的 `'price'`（改成显式价格字段列表），避免深度遍历命中 `goods_id`；
  - `imageUrl` 的 keys 把 `goods_thumb_url` 提到最前。

实测产物（来自调试日志 `goods-source-message-debug`）：

```json
"resolvedCard": {
  "goodsId": "919852864638",
  "title": "南沙白心番石榴脆甜芭乐低糖分孕妇当季水果新鲜采摘批发【包邮】",
  "imageUrl": "https://img.pddpic.com/.../93bdb181ee9916196d628cfa65a938ea.jpeg",
  "priceText": "",
  "groupText": "2人团"
}
```

`priceText` 为空是合理的：原始 `goods_info` 只下发了 `goods_id / goods_name / goods_thumb_url / total_amount / mall_link_url`，PDD 后台在这条通知里压根没下发价格字段；`total_amount` 看字段名更像销量而不是价格，刻意没把它当价格，避免显示离谱数字。

### 根因 3：列表加载慢（每次 ~20s）和"列表一直为空"

**症状**：

- 点客户对话标签后等 20 秒才出列表，或一直空着。
- 日志里反复出现：

```
[API] 会话初始化开始
[API] 会话初始化未完成
[API] 安全模式读取会话缺少模板，跳过初始化链路
```

**根因**：

上一轮把 polling 改成 safe 模式（`allowInitSession: false`），同时 `loadShopApiSessions` 也写死 `false`。结果：

- runtime 完全没有 `latest_conversations` 模板和 `anti_content` 时，`getSessionList` 在 safe 分支直接 `return []`，请求都不发。
- 启用 init 后又遇到第二个问题：`initSession` 的循环只看 URL 是否含 `chat-merchant`（20 × 1000ms = 20s 上限），即使 cookie 已就绪、`_appendBootstrapTraffic` 已抓到 `latest_conversations` / `anti_content`，仍然死等 URL 跳转。`chat-merchant` SPA 路由偶尔不会停在该 URL，于是死撞 20s 超时。
- 实测发现：cookie 主上下文一旦就绪，**fallback 简化请求体（无 traffic 模板）就足以让 `latest_conversations` 返回 200 + 真实数据**。前置 init 完全是多余的代价。

**本轮修复**：`src/main/pdd-api.js` + `src/main/main.js` + `src/main/register-api-ipc.js`

1. `initSession` 等待循环：从 `20 × 1000ms` 改为 `20 × 500ms`（上限 10s），并加入双判定：
   - URL 跳到 `chat-merchant` ⇒ 就绪；
   - `_getConversationBootstrapStatus().ready` ⇒ 就绪（已抓到 `latest_conversations` / `conv_status` / `chat_list + anti_content`）；
   - URL 跳到 `/login` ⇒ 立即终止，触发 authExpired。

2. `getSessionList` 去掉前置 `if (!_sessionInited && allowInit) await initSession()`，直接走请求路径。

3. `getSessionList` safe-mode 短路（`!allowInit && !template && !anti` → `return []`）整段去掉，改为也尝试 fallback 请求。`_post` 是普通 HTTPS 请求，不会触发 `chat-merchant` BrowserView，不影响掉线收口。

4. `getSessionList` catch 路径增加 init 重试兜底：直调失败 + 缓存为空 + 允许 init + 尚未 init → 触发一次 `initSession()` 后重试一次 `_post`。

5. `getSessionMessages` 同样去掉前置 init（polling 路径的 safe-mode 短路保留，`_pollMessagesForSession` 仍是 `allowInitSession: false`）。

6. `loadShopApiSessions` 与 `api-get-messages` IPC 把 `allowInitSession` 改成 `true`，依赖 client 内部 sticky 标志（`_sessionInited`）防止重复 init。

最终格局：

- 用户主动进入 chat-api / 主动点会话 → 直接发请求，毫秒级响应；请求失败才触发 init 一次。
- 后台 polling → 仍 safe，绝不 init。

### 根因 4：进入 chat-api 时店铺没自动校验在线状态

**症状**：

- 启动后立即进入 chat-api，日志报 `显示所有店铺时，1 个店铺未验证在线：xxx`，列表为空。
- 必须手动到「店铺管理」点"接口校验"按钮，才能进入 chat-api 拉数据。

**根因**：

启动时只把 token 文件加载到内存（"已恢复 N 个店铺 Token"），不会主动用 token 去 PDD 服务器探测一次"是否真有效"，所以 `availabilityStatus` 保留上次保存的值（往往是 `expired`）。
而 `getApiSessionsByScope` 强制要求店铺 `apiReadyOnly: true`，过滤掉非 online 的店铺。

**本轮修复**：`src/main/main.js` 的 `getApiSessionsByScope`

进入 chat-api 时如果 `targetShops.length === 0`，且 `shopManager.safeValidateShops` 可用，自动跑一次批量接口校验（等价于"接口校验"按钮，内部走 `_fetchAndApplyShopProfile` → 4 个并行轻量 API），通过的店铺立即可用。

```js
const candidateShops = shopId === API_ALL_SHOPS
  ? getApiShopList(API_ALL_SHOPS).filter(shop => !isApiReadyShop(shop) && shop?.id)
  : getApiShopList(shopId).filter(shop => !isApiReadyShop(shop) && shop?.id);
if (candidateShops.length && shopManager?.safeValidateShops) {
  await shopManager.safeValidateShops(candidateShops.map(item => item.id));
  targetShops = getApiShopList(shopId, { apiReadyOnly: true });
}
```

只在"未在线"时触发，已经在线的店铺下次直接走，不会重复触发；校验失败仍按原逻辑抛错，不掩盖 token 真过期的情况。

## 改动文件清单

| 文件 | 变更摘要 |
| --- | --- |
| `src/main/main.js` | 1. `getApiTraffic` 不再回灌持久化脱敏 traffic；移除 `getPersistedApiTraffic` 引入<br>2. 新增 `isSanitizedApiSessionEntry`，`setApiSessionSnapshot` / `enqueueRendererApiSessionUpdate` 增加占位符过滤<br>3. `loadShopApiSessions` 改为 `allowInitSession: true`<br>4. `getApiSessionsByScope` 增加未在线店铺自动 `safeValidateShops` |
| `src/main/pdd-api.js` | 1. `initSession` 循环 `20 × 1000ms` → `20 × 500ms` + 双判定提前 break<br>2. `getSessionList` 去掉前置 init / safe-mode 短路；catch 路径加 init 重试兜底<br>3. `getSessionMessages` 去掉前置 init（polling 短路保留） |
| `src/main/register-api-ipc.js` | `api-get-messages` 改为 `allowInitSession: true` |
| `src/renderer/chat-api-module.js` | `buildApiGoodsCardFallback` 改为优先读 `goods_info` 子对象的具名字段，弱化 `pickApiGoods*` 深度遍历的副作用 |

## 验证步骤

### 启动 → 列表

1. 完全退出整个 Electron 应用。
2. `npm run dev` 重新启动。
3. 直接进入「客户对话（接口对接）」（不必先到店铺管理点"接口校验"）。
4. 期望：
   - 若店铺非 online，日志出现 `api-session-auto-validate { successCount: 1, ... }`，几秒内升 online；
   - `[API] 拉取会话列表 { templateSource: 'fallback' }` 后立即 `POST .../latest_conversations -> 200`；
   - `api-get-sessions 返回 N 条`；
   - 渲染层 `renderApiSessions dom-ready`，列表显示真实昵称 / 头像 / 最后消息。

### 点击会话 → 消息

1. 点列表里任意会话。
2. 期望：
   - `POST .../plateau/chat/list -> 200`；
   - `[API] chat/list 候选响应 { count: N }`；
   - 中间面板显示消息；
   - 商品来源通知卡片显示真实商品标题和主图。

### 静置 → 不掉线

1. 进入 chat-api 后不操作，静置 5~10 分钟。
2. 期望：
   - 日志不再出现 `/service-market/chat/order-list` / `/chats/getToken` / `wss://m-ws.pinduoduo.com` / `wss://titan-ws.pinduoduo.com` / `/janus/api/heartbeat/v2`；
   - 不再出现 `refund-order:page-request 触发聊天页准备`。

### 异常排查

如果出现 `[TEXT]` / `[ID]` 占位符，代表脱敏数据回流：

- 检查是不是新加的代码路径直接读了 `getPersistedApiTraffic` 或 `apiTrafficLogPath`；
- 用 `isSanitizedApiSessionEntry` 在塞进 snapshot 之前过滤一次。

如果列表加载又变 ~20s：

- 检查 `_pollMessagesForSession` / `_doPoll` / `loadShopApiSessions` 是否被改回了 `allowInitSession: false`；
- 看 `[API] 会话初始化开始` 后多久才到 `[API] 会话初始化成功/未完成`；如果超过 5s，检查 `_getConversationBootstrapStatus()` 的 `ready` 判断是否被破坏。

## 仍未做的事 / 后续可选项

按建议优先级排序，不必都做。

### B. anti_content 失效兜底验证

仍未通过实测验证。理论上当 `chat/list` 因 anti_content 老化报 500 时，`getSessionMessages` 会落到：

- `chat/list` 缓存兜底 → 失败
- `_extractSessionOrderSn` + `_fetchHistoryMessagesByOrderSn`（即 `/latitude/message/getHistoryMessage`）→ 不需要 anti_content
- 找不到 orderSn 时再退到 `_findOrderSnByBuyerUid` 扫历史 afterSales traffic

建议测试方法：

- 进入 chat-api 后静置 ≥10 分钟；
- 然后点击会话；
- 看是否出现 `chat/list 候选失败 { statusCode: 500 }` 后接 `降级走 latitude/getHistoryMessage 成功`；
- 若仍 500 且 latitude 也失败，可以引入"慢频率 `latest_conversations` 保活"轮询，定期刷新 anti_content。

### C. `latest_conversations` 慢频率保活（可选）

如果 B 验证发现 anti_content 老化是高频问题，可以在 `_doPoll` 之外增加一个低频任务（5~10 分钟一次）跑 `getSessionList(..., { allowInitSession: false })`，借助每次成功响应里 PDD 自带的 `anti_content` 自动续期。

代价：每个店铺多一个定时器；一次请求体积小，不会触发 `chat-merchant` BrowserView，安全。

### D. 商品卡片价格补全（可选 UX 优化）

当前商品来源通知卡片 `priceText` 经常为空，因为 PDD 后台在该消息里没下发价格字段。可以：

- 监听 `chat/list` 返回里其它消息（如订单卡片）的 `info.goods_info` / `data.goods_info`，提取同一 `goods_id` 的价格写回缓存；
- 或在用户点击"查看商品规格"时拿到的 `goods-spec` 数据里反查 `min_group_price`，回填到列表卡片。

不是必须，因为聊天对话本身不强依赖价格。

### E. 剩余请求路径 `allowPageRequest` 收口

`docs/pdd-stability-handover.md` 里提到的 `ticket-api` 仍保留 `requestInPddPage` 兜底。本轮没动。如果未来出现新一轮"打开会话后掉线"，先看：

- `apiGetRefundOrders` / `apiGetSideOrders` 是否在 chat-api 场景被某条新链路重新调起；
- `requestViaPddPage()` / `ensurePddPageViewReady()` 的调用方是否完整带 `allowPageRequest: false`。

## 不要轻易回退的设计决策

- `getApiTraffic` 不再回灌持久化脱敏 traffic：这是修复链路稳定性的根本，**绝对不要为了"启动就有兜底数据"再加回去**。
- `isSanitizedApiSessionEntry` 过滤防线：保留，未来无论从哪条路径塞 sessions 都先过这层。
- `polling` 全程 `allowInitSession: false`：保留，否则会重新引发后台 chat-merchant 互踢。
- `loadShopApiSessions` / `api-get-messages` 改为 `allowInitSession: true`：依赖 client 内部 sticky 标志，不要再写死 false（写死会让 fallback 路径在没模板时直接 return []）。
- `getApiSessionsByScope` 自动 `safeValidateShops`：仅在未在线时触发，不要顺手扩到所有路径，避免每个 IPC 都拖一次校验。

## 关键文件

- `src/main/pdd-api.js`
- `src/main/main.js`
- `src/main/register-api-ipc.js`
- `src/main/api-traffic-recorder.js`
- `src/main/api-traffic-sanitizer.js`
- `src/main/shop-manager.js`
- `src/renderer/chat-api-module.js`
- `src/renderer/index.html`
- `docs/pdd-stability-handover.md`
- `docs/chat-api-stability-handover.md`

## 交接建议

1. 先按"验证步骤"里的三段（启动→列表 / 点击会话 / 静置）完整过一遍，确认本机和环境一致。
2. 如果观察期 1~2 天内没有出现新掉线、没有出现 `[TEXT]` 占位符，再按需考虑 B / C / D / E 中任一项。
3. **不要**把"持久化脱敏 traffic 回灌"恢复回来，**不要**把 polling 改成 `allowInitSession: true`。这两条任意一条都会让本轮修复的稳定性立刻退化。
4. 如果发现新功能需要在 chat-api 场景里发 PDD 接口请求，优先复用 `PddApi` 里已有的方法，并显式带 `allowInitSession: false` / `allowPageRequest: false`，让兜底由 client 自己决定。
