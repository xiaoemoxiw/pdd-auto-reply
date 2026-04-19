---
name: "vue-modal-migration"
description: "新增 Vue 弹窗或把历史 modal 迁移到 Vue 子树。任务涉及 src/renderer/vue/modals 下新增/修改 SFC、注册 vueBridge、清理 index.html 旧 modal-overlay 时调用。"
---

# Vue Modal 迁移与新增技能

仓库已经把 18 个 modal 全部迁到 `src/renderer/vue/modals`。再次"新增 modal"或"迁移以前漏掉的 inline 弹窗"时，按这个技能里的标准流程操作，避免又把业务回流到共享入口。

## 触发场景

- 需要新加一个弹窗（不是简单 confirm）；
- 需要把某段还在原生 JS / inline DOM 里的弹窗移到 Vue；
- 需要修改既有 modal 的业务桥接 API（`window.xxxModule.*`）。

## 默认原则

- 优先遵循 `vue-modal.mdc`、`renderer-ui.mdc`、`collaboration-guardrails.mdc`、`pdd-core.mdc`。
- Vue 子树只承载 UI；业务规则/IPC/持久化继续留在原生 IIFE 模块。
- 改完一定 `pnpm vue:build` + `ReadLints` + 主路径手工冒烟一次。

## 关键文件速查

| 用途 | 路径 |
|---|---|
| Vue 子树入口 | `src/renderer/vue/main.js` |
| 桥接实现 | `src/renderer/vue/bridge.js` |
| Modal 底座 | `src/renderer/vue/components/AppModal.vue` |
| 集中注册 | `src/renderer/vue/modals/ModalHost.vue` |
| 现有 SFC 范例（简单） | `src/renderer/vue/modals/ModalRemark.vue` |
| 现有 SFC 范例（重表单） | `src/renderer/vue/modals/ModalQA.vue`、`ModalInvoiceApiEntry.vue` |
| 现有 SFC 范例（chat-api 双 modal） | `src/renderer/vue/modals/ModalApiRefundOrderSelect.vue` + `ModalApiRefund.vue` |

## 标准 8 步流程

1. **业务侧 API 设计（先于 SFC）**
   - 在对应业务模块（`src/renderer/xxx-module.js` 或 `src/renderer/chat-api/modules/xxx-modal.js`）里把这个 modal 关心的"加载初始数据 / 提交 / 关联刷新"写成纯函数。
   - 暴露到 `window.xxxModule = Object.assign(window.xxxModule || {}, { openXxxModal, loadXxxDetail, submitXxxFromForm, ... })`。
   - 业务函数返回值统一用 `{ ok: true/false, status, message, ...}` 形状，方便 SFC 处理 ok / warn / error 三态。

2. **构造 payload 并 openModal**
   - 在业务模块内部加 `function openXxxModal(args) { const payload = buildXxxPayload(args); window.vueBridge.openModal('modalXxx', payload); }`。
   - payload 包含 SFC 需要展示/提交的所有初始字段，和"是否允许操作 / 状态提示"等弱契约信息。

3. **新建 SFC**
   - 文件名 `src/renderer/vue/modals/ModalXxx.vue`，PascalCase。
   - 用 `<AppModal>` 包，`v-model:visible` 走 `props.visible` + `emit('update:visible')`；表单字段用本地 `ref`。
   - 在 `watch(() => props.visible)` 里 hydrate 表单初值；关闭时 reset。
   - 业务请求统一调 `window.xxxModule.*`，根据返回的 `{ok, status, ...}` 决定 toast / 关闭 / 二次确认。

4. **样式约定**
   - SFC `<style>` 里写 namespaced CSS：`modal-xxx-*`。
   - 如果要复用历史 namespaced CSS（如 `invoice-api-entry-*`），保持原 CSS 文件不动，SFC 里 class 与原始一致；同时考虑用 `dialog-class` 关掉 ElDialog body 默认 padding（参考 `ModalInvoiceApiEntry.vue`）。
   - 不要写无前缀全局 class。

5. **注册到 ModalHost**
   - `src/renderer/vue/modals/ModalHost.vue`：
     - import 新 SFC；
     - `ownedModals` 数组追加 `'modalXxx'`；
     - template 里挂载 `<ModalXxx :visible="isOpen('modalXxx')" :payload="payloadOf('modalXxx')" @update:visible="(v) => !v && close('modalXxx')" @close="close('modalXxx')" />`。

6. **清理 index.html**
   - 删除旧 `<div class="modal-overlay" id="modalXxx">...</div>` 整段；
   - 留一行 `<!-- 模态框：xxx → 已迁移到 Vue (src/renderer/vue/modals/ModalXxx.vue) -->` 占位；
   - 删除 `index.html` 中 `<style>` 里只服务该 modal 的 inline CSS 段，配合写一行迁移注释。

7. **清理冗余 CSS / 旧绑定**
   - `grep` 旧 modal 用到的 class 名（例如 `qa-reply-preview`、`invoice-api-entry-status`）确认无任何 HTML/JS 还在引用，再删；
   - 业务模块里 `getEl('xxxXxxId')?.addEventListener(...)` 旧绑定如果只为旧 DOM 服务，请一并删除；
   - 不要保留 `function renderXxxDialog()` 等 DOM 中介状态/渲染函数。

8. **构建与验证**
   - 跑 `pnpm vue:build`，确认 0 报错；
   - 跑 `ReadLints` 确认无新增告警（pre-existing 的 line-clamp 类告警可忽略）；
   - 在 `pnpm dev` 下手工冒烟该 modal：打开 → 输入 → 提交 → 错误态 → 关闭 → 重新打开（验 reset）；
   - 对涉及 chat-api 的 modal，顺便看一眼 `state.apiActiveSessionId` 切换、消息回流是否正常。

## 常见坑速查

- **payload 不响应式**：`vueBridge.openModal` 重新赋值 `state.activeModals[name]` 整体，SFC 不要在打开期间订阅 payload 子字段变化，hydrate 一次即可。
- **ElDialog 内重复 padding**：传 `dialog-class` + 自定义 CSS 解决。
- **chat-api 模态依赖运行态**：通过 `window.__chatApiModuleAccess`（`getApiActiveSession()` 等）+ `window.__chatApiModuleHelpers`（`pickApiRefundText` 等）拿，**不要**在 SFC 直接读这两者；先在 `chat-api/modules/xxx-modal.js` 内封装 helper，再挂业务 module。
- **`addLog` / `showToast`**：业务桥接函数在原生模块层调；SFC 弱反馈用 ElMessage 或调业务模块的 `notifyStatus`。
- **大 payload**：避免把整段会话原始数据塞进 payload；只塞"展示 + 提交需要的字段"。

## 接到任务后第一步

1. 读 `docs/vue-modal-migration-handover.md` 中"还要完成的事"+ 对应的 SFC 范例；
2. 找到要改的业务模块和现有 `window.xxxModule.*` 暴露面；
3. 按"标准 8 步流程"动手；
4. 改完同步更新 `docs/vue-modal-migration-handover.md`（如果新增 modal，把它加到清单表）。
