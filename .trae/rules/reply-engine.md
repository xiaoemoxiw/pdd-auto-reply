---
description: 当任务涉及自动回复规则、关键词匹配、兜底策略、AI 意图或未匹配消息记录时使用此规则
alwaysApply: false
---

# 自动回复与意图识别规则

## 规则引擎边界
- 自动回复核心逻辑优先复用 `src/main/reply-engine.js`，不要在渲染层重复实现一套匹配逻辑。
- 修改规则命中、优先级、场景兜底或回复文本处理时，先对齐 `ReplyEngine` 的现有输入输出结构。
- 规则冲突时，以当前真实数据结构和引擎行为为准，不以历史文档里的旧字段假设为准。

## 规则数据结构
- 规则项默认围绕 `id`、`name`、`enabled`、`keywords`、`keywordGroups`、`excludeKeywords`、`matchType`、`reply`、`shops`、`priority`、`minScore` 组织。
- 新功能优先基于 `keywordGroups` 扩展，`keywords` 更多用于兼容旧数据。
- 修改规则结构时，要同步考虑主进程 store 默认值、配置保存、测试匹配和页面编辑能力。

## 匹配机制
- 关键词匹配优先延续当前评分模型：关键词组命中计分、exact 额外加分、priority 参与权重、excludeKeywords 直接排除。
- 修改评分或排序逻辑时，要同时考虑 `match`、`testMatch`、`matchWithFallback` 三条调用路径。
- 流程测试 `simulate-message-flow` 与真实收消息链路可以共用引擎能力，但要明确它是测试视图，不默认等同于线上真实发送顺序。
- 正则匹配必须保持容错，避免因为非法表达式直接让流程中断。

## 兜底回复
- 所有规则不命中时，优先走 `defaultReply` 的场景匹配，再走通用兜底文本。
- `defaultReply` 继续兼容 `texts`、历史 `text`、`delay`、`cooldown`、`strategy`、`cancelOnHumanReply`、`scenes`。
- 修改兜底策略时，要同时考虑顺序轮换、随机选择、人工介入取消和同客户冷却时间。
- 未匹配消息记录继续视为正式能力的一部分，调整兜底流程时不要漏掉 `unmatchedLog` 链路。

## AI 意图
- 涉及 AI 意图识别时，优先复用 `ai-intent.js`、`system-phrases.js` 和 store 中 `aiIntent` 配置。
- 模型来源、阈值、状态与意图列表要和现有默认值及 UI 控制项保持一致，不平行创造另一套配置。
- 引入模型相关变更前，先确认当前仓库是否已经具备对应依赖和下载来源，不臆测新增外部能力。

## 输出约束
- 回复文本变量继续兼容 `{time}`、`{date}` 这类现有模板替换方式。
- 新增或修改话术、场景、意图时，优先保持可配置，而不是把业务文案硬编码在流程判断里。
- Reply 配置、话术库、未匹配日志和规则测试适合按业务域拆到独立 IPC 注册模块；直接操作 BrowserView 的调试发送链应与回复配置域分开维护。
