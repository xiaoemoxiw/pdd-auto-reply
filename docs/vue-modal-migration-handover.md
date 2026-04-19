# Vue 3 Modal 迁移交接清单

## 背景

`src/renderer/index.html` 历史上承载了 18 个 `modal-overlay` 弹窗的完整 DOM、内联样式与事件绑定，叠加各业务模块（shops / quick-phrases / qa / refund / small-payment / invite-order / invoice-api / chat-api 等）的私有 DOM 操作，使得：

- `index.html` 长期 11000+ 行，多人改同一文件极易冲突；
- 弹窗 DOM 与业务 JS 强耦合（`getElementById('xxx').textContent = ...`），无法做单元化复用；
- 表单类弹窗（QA / Exam / 录入发票 / 退款）混合"模板渲染 + 状态机 + 事件绑定"，可读性差。

本轮工作目标：
1. 引入 Vue 3 + Element Plus + Vite，落在 `src/renderer/vue` 子树，不替换其余原生 JS 模块；
2. 把所有 18 个 modal 全量迁移为 Vue SFC，由统一的 `ModalHost` 集中管理；
3. 业务侧通过 `vueBridge` + 各模块对外暴露的 `window.xxxModule.*` 与 Vue 解耦，不让 SFC 直接散调 `pddApi` / DOM helpers；
4. 渲染层共享入口（`index.html`）只负责挂载点 + 接线，不再承担弹窗实体。

迁移已**全部完成（18 / 18）**。本文档目的是让接手同学：

- 知道现在仓库里已经有什么、放在哪里；
- 改 modal 时遵守哪几个约束；
- 后续要做的 P0 验收 + 演进项怎么接。

## 现状概览

### 目录结构

```
src/renderer/vue/
├── App.vue                  # 子树根组件，仅挂 ModalHost
├── main.js                  # createApp + Element Plus(zh-cn) + 提供 vueBridge
├── bridge.js                # createVueBridge：openModal / closeModal / 劫持 showModal/hideModal
├── components/
│   └── AppModal.vue         # 所有 modal 的统一底座（包 ElDialog）
└── modals/
    ├── ModalHost.vue        # 集中注册 + 挂载所有 modal
    ├── ModalRemark.vue
    ├── ModalGroup.vue
    ├── ModalTest.vue
    ├── ModalApplyShopCategory.vue
    ├── ModalApiImagePreview.vue
    ├── ModalInvoiceApiFilePreview.vue
    ├── ModalApiGoodsSpec.vue
    ├── ModalApiRefundOrderSelect.vue
    ├── ModalApiRefund.vue
    ├── ModalApiSmallPaymentOrderSelect.vue
    ├── ModalApiSmallPayment.vue
    ├── ModalApiInviteOrder.vue
    ├── ModalApiInviteOrderSpec.vue
    ├── ModalPhrases.vue
    ├── ModalBind.vue
    ├── ModalExam.vue
    ├── ModalQA.vue
    └── ModalInvoiceApiEntry.vue
```

构建产物：`src/renderer/dist-vue/{main.js, style.css}`，由 `index.html` 通过 `<script type="module" src="./dist-vue/main.js">` 引入。Vite 配置见 `vite.config.js`，`root` 指向 `src/renderer/vue`。

构建命令：
- 一次性：`pnpm vue:build`
- watch：`pnpm vue:watch`
- electron 启动：`pnpm dev` / `pnpm start`
- Windows 打包：`pnpm build:win`（已包含 `pnpm vue:build` 前置）

### 18 个 modal 完成清单

| 类别 | Modal ID | Vue 组件 | 业务桥接模块 |
|---|---|---|---|
| 领航试点 | modalRemark | ModalRemark.vue | `window.shopsModule.saveShopRemark` |
| 简单表单 | modalGroup | ModalGroup.vue | `window.shopsModule.saveShopGroup` |
| 简单表单 | modalTest | ModalTest.vue | `window.qaModule` 测试入口 |
| 简单表单 | modalApplyShopCategory | ModalApplyShopCategory.vue | `window.shopsModule.applyShopCategory` |
| 简单展示 | modalApiImagePreview | ModalApiImagePreview.vue | `window.showApiImagePreview` |
| 简单展示 | modalInvoiceApiFilePreview | ModalInvoiceApiFilePreview.vue | `window.invoiceApiModule.previewInvoiceApiFile` |
| 简单表单 | modalPhrases | ModalPhrases.vue | `window.quickPhrasesModule` |
| 简单表单 | modalBind | ModalBind.vue | `window.shopsModule` 扫描/绑店 |
| 表单（重） | modalExam | ModalExam.vue | `window.shopsModule` 考试入口 |
| 表单（重） | modalQA | ModalQA.vue | `window.qaModule.{buildQAModalPayload, saveQAFromForm, collectReplySegments}` |
| 表单（重） | modalInvoiceApiEntry | ModalInvoiceApiEntry.vue | `window.invoiceApiModule.{loadInvoiceApiEntrySubmitDetail, submitInvoiceApiEntryFromForm, previewInvoiceApiFile}` |
| chat-api | modalApiGoodsSpec | ModalApiGoodsSpec.vue | `window.__chatApiModuleAccess` + `window.__chatApiModuleHelpers` |
| chat-api | modalApiRefundOrderSelect | ModalApiRefundOrderSelect.vue | `window.refundModule` |
| chat-api | modalApiRefund | ModalApiRefund.vue | `window.refundModule.{getApiRefundTypeMeta, isApiRefundTypeAllowed, shouldShowApiRefundReceiptStatus, submitApiRefund, ...}` |
| chat-api | modalApiSmallPaymentOrderSelect | ModalApiSmallPaymentOrderSelect.vue | `window.smallPaymentModule` |
| chat-api | modalApiSmallPayment | ModalApiSmallPayment.vue | `window.smallPaymentModule.{submitSmallPayment, ...}` |
| chat-api | modalApiInviteOrder | ModalApiInviteOrder.vue | `window.inviteOrderModule` |
| chat-api | modalApiInviteOrderSpec | ModalApiInviteOrderSpec.vue | `window.inviteOrderModule.{submitInviteOrder, ...}` |

`index.html` 现已无任何 `id="modalXxx"` 的 `modal-overlay` 残留，对应 inline CSS（`.exam-* / .scan-* / .qa-modal-* / .invoice-api-entry-status* / .invoice-api-entry-card* / .invoice-api-entry-detail* / .invoice-api-entry-upload-* / .reply-edit-* / .qa-reply-preview*`）已全部清理。

## 关键架构

### vueBridge（`src/renderer/vue/bridge.js`）

> 原生 IIFE 模块 ↔ Vue 子树之间的桥。挂在 `window.vueBridge` 与 `inject('vueBridge')` 双端。

| 方法 | 用途 |
|---|---|
| `openModal(name, payload)` | 弹起一个被 Vue 接管的 modal，payload 透传到 SFC props |
| `closeModal(name)` | 关掉指定 modal |
| `isModalOpen(name)` | 查询状态 |
| `getModalPayload(name)` | 取当前 payload（一般用不到，SFC 通过 props.payload 拿） |
| `registerModal(name)` | ModalHost 在 onMounted 时登记，登记后 `showModal(name)` / `hideModal(name)` 自动转发 |
| `installShowModalProxy()` | 启动时劫持原生 `window.showModal` / `hideModal`，实现"零侵入"切换 |
| `on/off/emit` | 跨层事件总线，目前用得少 |

> 设计要点：**已注册的 modalId** 走 Vue；**未注册的** 仍走 `index.html` 里原始 `showModal/hideModal` 实现。当前 18 个 modal 都已注册，原始实现可以被视为没有调用方，但保留兼容劫持。

### AppModal（`src/renderer/vue/components/AppModal.vue`）

所有 modal 的统一底座，封装 ElDialog。常用 props：

| Prop | 默认 | 说明 |
|---|---|---|
| `visible` | false | 由父 `ModalHost` 绑定 `vueBridge.state.activeModals[name].visible` |
| `title` | `''` | 简单标题；如果要自定义 header，用 `#header` slot 并配合 `hide-header` |
| `width` | `'480px'` | 直接透传 ElDialog |
| `show-footer` | true | 是否渲染底部；纯展示型/自带底部的 modal 设 false |
| `hide-header` | false | 隐藏 ElDialog 默认 header（业务自渲染时使用） |
| `destroy-on-close` | false | 关闭时销毁内部 DOM，复杂表单建议开 |
| `close-on-click-modal` | false | 关闭时点遮罩，默认禁用避免误操作 |
| `dialog-class` | `''` | 自定义 wrapper class，需要覆盖 ElDialog 默认 padding 等内置样式时使用（例：`modal-invoice-api-entry-dialog`） |

### 业务桥接模块

复杂 modal 的"业务侧"逻辑统一保留在原生 IIFE 模块里（`src/renderer/*.js` 与 `src/renderer/chat-api/modules/*.js`），通过 `window.xxxModule = {...}` 暴露给 Vue。Vue 组件**只允许调用这些桥接 API**，不直接散调 `pddApi` / 不直接读 store / 不直接操作其它模块的 DOM。

已暴露的桥接模块：

- `window.refundModule`（`chat-api/modules/refund-modal.js`）
- `window.smallPaymentModule`（`chat-api/modules/small-payment-modal.js`）
- `window.inviteOrderModule`（`chat-api/modules/invite-order-modal.js`）
- `window.qaModule`（`qa-module.js`）
- `window.shopsModule`（`shops-module.js`）
- `window.quickPhrasesModule`（`quick-phrases-module.js`）
- `window.invoiceApiModule`（`invoice-api-module.js`）
- `window.__chatApiModuleAccess` + `window.__chatApiModuleHelpers`（`chat-api-module.js`，chat-api 系列 modal 的运行态/工具）

## 还要完成的事

### P0：跨平台冒烟验收（`p0_smoke`，必须人工跑）

迁移完成 ≠ 验收完成。需要按下面流程跑一遍主流程，确认行为没有回归。

**dev 模式：**
```bash
pnpm vue:build
pnpm dev
```

**主流程冒烟点（请逐项过一遍）：**

1. **应用启动 / Vue 子树挂载**
   - DevTools Console 应出现 `__vueRuntimeReady = true`，无 `[vue-runtime]` warn
   - `document.querySelector('[data-vue-bridge-ready]')` 不为空
2. **店铺切换 / 备注 / 分组 / 应用类目**
   - 备注：`modalRemark` 弹起 → 输入 → 保存 → 列表刷新
   - 分组：`modalGroup` 同上
   - 应用类目：`modalApplyShopCategory` 多选 + 应用
3. **绑店 / 考试 / 快捷短语**
   - `modalBind` 扫码、`modalExam` 答题、`modalPhrases` CRUD
4. **QA 规则**
   - 新增 / 编辑 / 删除规则（`modalQA`）
   - 测试规则（`modalTest`）
   - 从未匹配消息预填规则（确认 `prefillQARuleFromMessage` 入口）
5. **接口模式聊天链路（chat-api）**
   - 选会话 → `modalApiGoodsSpec`（点商品卡片）
   - 退款：`modalApiRefundOrderSelect` → `modalApiRefund`，提交并查会话回流
   - 小额支付：`modalApiSmallPaymentOrderSelect` → `modalApiSmallPayment`
   - 邀单：`modalApiInviteOrder` → `modalApiInviteOrderSpec`
6. **发票 / 图片预览**
   - 待开票列表"立即开票"→ `modalInvoiceApiEntry`，上传 PDF/OFD → 预览（`modalInvoiceApiFilePreview`）→ 提交（含 warn 二次确认路径）
   - 任意图片预览：`modalApiImagePreview`

**prod 打包：**
```bash
pnpm build:win
```
重点验证 `release/` 输出的 NSIS 包能正常启动，Vue bundle 在 asar 内被加载。

> macOS 没装 NSIS，可先 `pnpm vue:build && pnpm start` 验证 prod bundle 在 Electron 里能被正确加载。

### P1：架构层演进（按需）

| 编号 | 项目 | 说明 |
|---|---|---|
| L1 | bundle 拆分 | 当前 `dist-vue/main.js` 已 1.6MB，未来可按 modal 分组动态加载（rollup manualChunks） |
| L2 | 业务模块 ESM 化 | 把 `chat-api/modules/*.js`、`shops-module.js` 等高频模块改写成 ESM，由 vue main.js 直接 import，逐步去掉 `window.xxxModule` 中转 |
| L3 | 公共表单组件抽取 | 多个 modal 重复实现了"订单卡片选择器"、"金额校验输入"、"商品图 + 标题 + 规格"卡片，可抽 `<OrderCard>` `<AmountInput>` 复用 |
| L4 | TypeScript | bridge / AppModal / 业务桥接 API 类型化 |
| L5 | 测试 | 给 vueBridge、refundModule.submitApiRefund、qaModule.saveQAFromForm 加单测 |

P1 不阻塞 P0 验收，建议在 P0 跑通且持续跑顺一段时间后再启动。

## 接手 checklist

接手 modal 相关需求时，请：

1. 先读 `.cursor/rules/vue-modal.mdc`（与本文同步约定）；
2. 看你要改的 modal 对应的 SFC + 对应业务模块，确认数据流向；
3. 不要在 `index.html` 里恢复任何 `modal-overlay` DOM；
4. 不要在 SFC 里直接调 `window.pddApi.*` / 直接读取其它模块 DOM；新接口请加到对应业务模块并通过 `window.xxxModule.*` 暴露；
5. 改完跑 `pnpm vue:build`，确认无 lint 与构建错误；改 modal 行为后跑一次"接手 checklist 第 4 步"对应那个 modal 的人工冒烟。

## 标准迁移流程（如果以后还要新增 modal 走 Vue）

1. **业务侧准备**：在对应业务模块新增 / 调整一个 `xxxModule.openXxxModal(args)` 入口，里面构造 payload 并调用 `window.vueBridge.openModal('modalXxx', payload)`；
2. **业务侧 API**：把 modal 关心的"加载初始数据 / 提交 / 校验 / 关联刷新"写成纯函数，挂到 `window.xxxModule`，返回 `{ ok, ...} ` 形状；
3. **新建 SFC**：放在 `src/renderer/vue/modals/ModalXxx.vue`，使用 `<AppModal>`，通过 `props.payload` 接收数据，通过 `window.xxxModule.*` 触发业务；
4. **样式约束**：所有 CSS 必须 namespaced（如 `modal-xxx-*`），优先在 SFC `<style>` 内写；如果复用既有 namespaced CSS（例如 `invoice-api-entry-*`），可保持原 CSS 文件不动，但要确保 SFC class 与原始一致；
5. **注册到 ModalHost**：在 `ModalHost.vue` import + 加入 `ownedModals` 数组 + template 里挂载；
6. **清理 index.html**：删除旧 DOM，留一行 `<!-- 模态框：xxx → 已迁移到 Vue (...) -->` 占位符；
7. **清理旧 CSS**：扫一遍 `*.css` 与 `index.html` `<style>`，删掉只服务于该旧 DOM 的样式；
8. **构建 + lint**：`pnpm vue:build`、`ReadLints` 没新增告警；人工冒烟一次该 modal。

## 常见坑与建议

- **ElDialog body 默认 padding 20px**：纯沿用既有 namespaced CSS（自带 head/body/footer）的 modal，会出现"双层 padding"。解决：传 `dialog-class="modal-xxx-dialog"`，并在 SFC `<style>` 里写 `.modal-xxx-dialog .el-dialog__body { padding: 0; }`。参考 `ModalInvoiceApiEntry.vue`。
- **payload 不是响应式更新**：`vueBridge.openModal` 每次重新赋值 `state.activeModals[name]`，SFC 应在 `watch(() => props.visible)` 中 hydrate 状态，不要假设 payload 在弹窗存活期间会再变。
- **复杂表单状态隔离**：表单类 modal 建议关闭时 `destroy-on-close` + 在 `watch(visible)` 里 reset，避免下一次打开携带上次输入。
- **CSS 命名空间**：禁止新增无前缀的全局 class（如 `.title`、`.btn-action`），全部用 `modal-xxx-*` 或 `app-modal-*`。
- **chat-api 上下文获取**：业务 SFC 不要直接访问 `window.__chatApiModuleAccess`；遇到需求请先在 `chat-api/modules/xxx.js` 里把读取逻辑封成 helper，再挂 `window.xxxModule`，SFC 调 module 即可。
- **`window.pddApi` 调用**：原则上 SFC 不直接调；如确属一次性、纯读、不带任何业务后处理（如调试用），可在 SFC 内 `if (window.pddApi && typeof window.pddApi.xxx === 'function')` 中防御式调用。
- **`addLog` / `showToast` 反馈**：业务桥接模块层面统一调；SFC 里如果需要弱通知，优先用 ElMessage；如果要保持与原生模块一致的灰色 toast / addLog 流，调对应业务模块上暴露的 `notifyStatus` 类辅助函数（参考 `invoiceApiModule.notifyStatus`）。

## 相关参考

- `.cursor/rules/vue-modal.mdc` — Vue 子树 / Modal 编码约束（cursor）
- `.trae/rules/vue-modal.md` — 同上（trae）
- `.cursor/skills/vue-modal-migration/SKILL.md` — 新增 modal 或迁移历史 modal 的标准操作
- `.trae/skills/vue-modal-migration/SKILL.md` — 同上
- `.cursor/rules/collaboration-guardrails.mdc` — 共享接线层协作规范
- `.cursor/rules/renderer-ui.mdc` — 渲染层通用规范
