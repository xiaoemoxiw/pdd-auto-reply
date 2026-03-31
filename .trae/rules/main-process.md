---
description: 当任务涉及 Electron 主进程、IPC、店铺管理、PDD API、本地存储或会话同步时使用此规则
alwaysApply: false
---

# 主进程与数据边界规则

## 主进程职责
- 主进程逻辑优先放在 `src/main` 现有模块中，不要把业务逻辑散落到渲染层。
- 与店铺、会话、消息、网络抓取、自动回复相关的能力，优先复用 `main.js`、`shop-manager.js`、`pdd-api.js`、`network-monitor.js`、`api-logger.js`。
- 新增能力前，先确认现有模块是否已经承担相近职责，避免并行再造一套管理器。
- `main.js` 默认视为共享接线层；新增能力优先放到职责更明确的主进程模块中，`main.js` 只保留必要的 IPC 注册和流程编排。

## IPC 与 preload
- 渲染层与主进程通信必须通过 preload 暴露的 API 入口，不直接穿透 Electron 原生对象。
- 新增 IPC 时，优先沿用现有命名和返回结构，保证渲染层调用方式一致。
- 设计 IPC 时优先返回业务上稳定的数据对象，不把主进程内部状态直接暴露给页面。
- 为减少多人协作冲突，新增 IPC 时先确认能否挂到现有命名族和模块边界内，不在共享入口里顺手塞入无关逻辑。
- 如果主进程维护 `currentView`、活跃店铺、轮询作用域等运行态，而渲染层也需要展示同一状态，必须提供显式读取或同步入口；不要依赖渲染层默认初始值推断主进程真实状态。
- 切页、店铺切换或初始化失败时，主进程与渲染层的恢复动作要成对设计；不能只回退左侧选中态，却让主进程继续停留在已隐藏 BrowserView 或旧运行态。

## 店铺与认证
- 店铺登录与认证优先沿用当前 Token 导入和分店铺 partition 的实现，不假设扫码 BrowserView 仍是主路径。
- 涉及店铺身份、Cookie、User-Agent、mallId 时，先查 `ShopManager` 和 `PddApiClient` 的真实来源，再决定修改位置。
- 认证失败、会话过期和重新初始化流程，优先兼容现有 `authExpired`、`initSession`、隐藏窗口认证链路。

## PDD API 与同步
- 接口请求优先复用 `PddApiClient` 的 `_request`、`_get`、`_post` 以及现有轮询机制，不要平行新建另一套 API 客户端。
- 请求头、Referer、Origin、partition、`X-PDD-Token` 等细节要与当前实现保持一致，不要臆测替换。
- 解析接口返回时，以真实字段兼容现状为准，延续当前多候选字段回退方式，不要只按理想字段名实现。

## 存储规范
- 本地持久化统一走 `electron-store`，并优先复用 `main.js` 中现有默认结构。
- 渲染层不要直接操作 store；变更配置时由主进程负责读写和兜底。
- 修改 `rules`、`defaultReply`、`shops`、`shopGroups`、`quickPhrases`、`phraseLibrary`、`unmatchedLog`、`aiIntent` 等结构时，要兼容已有数据。
- 不要把新的敏感信息直接持久化到普通 store；如必须保存敏感字段，应先评估安全边界。

## 运行时状态
- 延迟发送、冷却时间、消息去重、轮询缓存等运行时状态优先保持在主进程内存结构中，不随意下放到页面层。
- 修改去重、轮询或延迟逻辑时，要同时考虑多店铺、多来源消息和重复触发问题。
- 新增接口页或非嵌入页时，要显式验证 BrowserView 显隐与 `currentView` 是否一致；尤其在窗口重载、异常回退和视图恢复场景下，避免出现左侧导航已切回、右侧仍为空白的状态失配。
