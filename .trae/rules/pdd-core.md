---
description: 当前仓库的通用开发规范，适用于所有拼多多客服助手相关任务
alwaysApply: true
---

# 拼多多客服助手核心规则

## 回答与工作方式
- 默认使用中文回答。
- 先理解现有实现，再修改代码；优先遵循仓库已有模式，不额外发明新抽象。
- 规则冲突时，优先级为：用户最新要求 > 仓库真实实现 > 本规则。
- 修改前先查看相邻文件和同目录实现，保持命名、依赖和组织方式一致。

## 技术栈
- 这是一个 Electron 桌面项目，主要使用 JavaScript。
- 主进程位于 `src/main`，负责窗口、IPC、店铺管理、PDD API、自动回复与本地存储。
- 预加载脚本位于 `src/preload`，负责通过 `contextBridge` 暴露安全 API。
- 渲染层位于 `src/renderer`，当前以原生 HTML/CSS/JS 为基础，并通过 CDN 引入 Vue 3 构建页面交互。
- 本地持久化统一使用 `electron-store`。

## 当前架构现实
- 当前主流程是 API 模式与自建聊天界面，不再把 BrowserView 注入脚本当作默认实现前提。
- 与拼多多交互时，优先复用 `ShopManager`、`PddApiClient`、`NetworkMonitor`、`ReplyEngine` 等现有模块。
- 历史注入脚本与 BrowserView 相关描述只能视为旧背景，新增功能时应以当前 `src/main`、`src/preload`、`src/renderer` 的真实结构为准。
- 接口抓取存储统一采用“双层模型”：仓库内统一把脱敏后的抓包明细写入 `artifacts/api-traffic/api-traffic-log.jsonl`，去重索引写入 `artifacts/api-traffic/api-traffic-index.json`；需要留档或提交时，继续在同目录生成脱敏快照、样本或分析产物。

## 编码规范
- 保持实现直接、清晰，优先复用已有函数、数据结构和模块边界。
- 非必要不要新增中转变量、兼容函数、备份函数或一次性抽象。
- 不要用硬编码绕过真实逻辑问题，优先修正真实数据流或复用现有配置来源。
- 只有在确实提升可读性时才添加注释；如果需要注释，使用中文。
- 文件名优先保持现有 kebab-case 风格，变量和函数使用 camelCase，类名使用 PascalCase。
- 新增页面或业务域的抓包能力时，统一复用 `api-traffic-recorder` 与 `network-monitor`，不要各模块私自落独立日志文件或自定义抓包格式。
- 需要提交到 GitHub 的抓包资料，统一通过仓库内 `tools` 生成或维护 `artifacts/api-traffic` 下的脱敏产物，不要把未脱敏原始日志写入仓库。

## 协作与结构演进
- 多人协作时优先按文件边界划分工作，不只按功能名称口头分工。
- `src/renderer/index.html`、`src/main/main.js`、`src/preload/preload.js` 视为共享接线层，只做薄接线，不在其中堆入整块新业务实现。
- 新增业务页、管理页或面板时，优先落到独立文件、独立脚本或独立视图容器，再回到共享入口做最小挂载。
- 为了协作进行结构调整时，坚持最小必要改动；如果该调整在单人开发下也不成立，就不要强行推进。
- 修改共享入口时，不顺手重构无关逻辑；只有与当前需求直接相关、且能提升清晰度与维护性的调整才执行。

## Electron 安全边界
- 渲染进程不要直接使用 Node.js API，能力统一通过 preload 暴露。
- 保持 `contextIsolation: true`，不要为了图省事开启不安全配置。
- 不要在渲染层直接读写 store、文件或敏感认证信息。

## 内嵌页面兼容性
- 任务涉及 BrowserView/BrowserWindow 内嵌拼多多后台页面时，遵循 `embedded-page-compat.md` 的会话分区与 UA 兜底策略，优先用稳定 UA 避免“非 Chrome”拦截弹窗。

## 验证要求
- 修改后至少做与变更范围匹配的最小验证，优先使用项目现有运行方式。
- 涉及桌面 UI、IPC、店铺状态、自动回复或网络链路时，要确认关键流程没有被改坏。

## 安全要求
- 不要输出、记录或提交 Token、Cookie、用户隐私和其他敏感数据。
- 处理拼多多接口、抓包信息或日志时，只保留排查所需的最小信息，不暴露真实凭据。
