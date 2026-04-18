# PDD API 接口层重构基线

本文记录 `src/main/pdd-api.js` 拆分重构的"重构前"基线，作为后续每一阶段对照验证的依据。

## 一、改动范围

涉及文件：

| 文件 | 当前行数 | 重构后预期 |
|---|---|---|
| `src/main/pdd-api.js` | ~9986 | ~1500（纯 facade） |
| `src/main/pdd-business-api-client.js` | ~250 | ~400（加固后基座） |
| `src/main/mail-api.js` | 288 | ~150（接基座） |
| `src/main/deduction-api.js` | 408 | ~250（接基座） |
| `src/main/ticket-api.js` | 1260 | 不变 |
| `src/main/invoice-api.js` | 792 | 不变 |
| `src/main/violation-api.js` | 437 | 不变 |
| `src/main/pdd-request-profile.js` | 180 | 不变 |

新增子目录：

```
src/main/pdd-api/
  modules/   (12 个业务模块文件)
  parsers/   (8 个纯解析模块文件)
```

## 二、PddApiClient 公共调用面（不变量）

下表列出 `register-api-ipc.js` / `main.js` 调用的 `PddApiClient` 公共方法。重构期间这些方法的签名、返回结构、抛错形态必须保持不变。

| 方法 | 调用处 |
|---|---|
| `initSession(force, options)` | register-api-ipc.js L209,L253 |
| `getTokenStatus()` | register-api-ipc.js L244 |
| `testConnection(options)` | register-api-ipc.js L266 |
| `findSessionByOrderSn(orderSn, options)` | register-api-ipc.js L395 |
| `getSessionList(page, pageSize)` | register-api-ipc.js L778 |
| `getSessionMessages(sessionRef, page, pageSize, options)` | register-api-ipc.js L428 |
| `getGoodsCard(params)` | register-api-ipc.js L465 |
| `getRefundOrders(sessionRef)` | register-api-ipc.js L476 |
| `submitRefundApply(params)` | register-api-ipc.js L487 |
| `getSideOrders(sessionRef, tab)` | register-api-ipc.js L498 |
| `getInviteOrderState(params)` | register-api-ipc.js L509 |
| `getInviteOrderSkuOptions(params)` | register-api-ipc.js L521 |
| `addInviteOrderItem(params)` | register-api-ipc.js L533 |
| `clearInviteOrderItems(params)` | register-api-ipc.js L544 |
| `submitInviteOrder(params)` | register-api-ipc.js L555 |
| `submitInviteFollow(params)` | register-api-ipc.js L566 |
| `getSmallPaymentInfo(params)` | register-api-ipc.js L577 |
| `submitSmallPayment(params)` | register-api-ipc.js L588 |
| `getOrderRemark(orderSn, source)` | register-api-ipc.js L599 |
| `getOrderRemarkTagOptions(force)` | register-api-ipc.js L609 |
| `saveOrderRemark(params)` | register-api-ipc.js L620 |
| `updateOrderPrice(params)` | register-api-ipc.js L631 |
| `sendManualMessage(sessionRef, text, options)` | register-api-ipc.js L643, main.js L3423 |
| `getVideoLibrary(params)` | register-api-ipc.js L716 |
| `sendVideoUrl(sessionRef, videoUrl, extra)` | register-api-ipc.js L729 |
| `markLatestConversations(size)` | register-api-ipc.js L762 |
| `startPolling()` | register-api-ipc.js L776, L805 |
| `stopPolling()` | （内部 + destroy） |
| `destroy()` | shop-manager 销毁链路 |

事件（EventEmitter）：

- `authExpired` → main.js L1534
- `sessionUpdated` → main.js L1540
- `newMessage` → main.js L1550

构造 options（main.js L1482-L1531）：

`onLog` / `getShopInfo` / `getApiTraffic` / `getOrderPriceUpdateTemplate` / `setOrderPriceUpdateTemplate` / `getSmallPaymentSubmitTemplate` / `refreshMainCookieContext` / `requestInPddPage` / `executeInPddPage`

## 三、验证矩阵

每一阶段提交前要跑的验证项：

| ID | 描述 | Phase 0/3 | Phase 1/2 | Phase 4 | Phase 5 | Phase 6 | Phase 7 | Phase 8 |
|---|---|---|---|---|---|---|---|---|
| A | 启动 → 客户对话(接口对接) → 会话列表（无 `[TEXT]/[ID]` 占位符，<5s 出列表） | ✓ | – | ✓ | – | – | ✓ | ✓ |
| B | 点击会话 → 消息 + 商品来源卡片 | ✓ | – | ✓ | – | – | ✓ | ✓ |
| C | 静置 5-10 分钟 → 不出现 chat-merchant 链路日志 | – | – | – | – | – | ✓ | ✓ |
| D | 工单/售后/发票/违规/扣款 5 个业务页各打开一次 | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| E | 手动发送一条消息 + 自动回复触发一次 | – | – | – | – | ✓ | ✓ | ✓ |
| F | 改价 / 小额退款 / 邀请下单 各跑一次（page 注入路径） | – | – | – | ✓ | – | ✓ | ✓ |
| G | 站内信打开 + 一条详情 | – | ✓ | – | – | – | ✓ | – |

## 四、强约束（来自 chat-api-stability.mdc）

任何阶段都必须保持：

- `getApiTraffic(shopId)` 不回灌 `getPersistedApiTraffic` / `apiTrafficLogPath`
- `isSanitizedApiSessionEntry()` 占位符过滤防线
- 后台 polling (`_pollMessagesForSession` / `_doPoll`) 全程 `allowInitSession: false`
- 用户主动入口 `loadShopApiSessions` / `api-get-messages` 保持 `allowInitSession: true`
- `getSessionList` / `getSessionMessages` 不前置 init
- `initSession` 等待循环：URL 跳到 `chat-merchant` ⇒ ready；`_getConversationBootstrapStatus().ready` ⇒ ready；URL 跳到 `/login` ⇒ 立即终止；上限 10s（`20 × 500ms`）
- `buildApiGoodsCardFallback` 字段优先级与 keys 黑名单严格保留
- `apiGetRefundOrders` / `apiGetSideOrders` 默认安全模式（`allowPageRequest: false` 或显式触发）

## 五、commit 节奏

每个 Phase 一个 commit，commit message 前缀统一用 `refactor(pdd-api): ...`，便于后续按 Phase 单独 revert。
