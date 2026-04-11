---
description: 当任务涉及 BrowserView/BrowserWindow 内嵌拼多多后台页面（订单/开票/售后等）并需要兼容性处理时使用此规则
alwaysApply: false
---

# 内嵌页面兼容性规则（BrowserView / BrowserWindow）

## 目标
- 内嵌页面尽量表现为“正常浏览器访问”，减少拼多多后台对非 Chrome/非浏览器环境的拦截弹窗
- 兼容性策略优先走“正确的浏览器特征与会话复用”，不依赖脆弱的 DOM 自动点击

## 会话与分区（必须）
- 内嵌拼多多后台页面必须按店铺复用登录态：`partition: persist:pdd-{shopId}`
- 不要在内嵌窗口使用默认 session（否则会出现“主窗口已登录，详情窗未登录”的割裂）

## User-Agent 策略（优先级）
- 第一优先：若店铺配置了 `shop.userAgent`，使用该 UA
- 兜底策略：店铺未配置 UA 时，内嵌窗口默认使用稳定的 Win10 Chrome UA（避免被识别为 Electron/非 Chrome）
- UA 设置必须落在主进程创建 `BrowserView` 时（`webContents.setUserAgent`），不要在渲染层拼接或注入
- 不要全局覆写整个 app 的 UA；只对“内嵌拼多多后台页面”的 BrowserView/窗口生效

## 弹窗与引导（推荐做法）
- 遇到“检测到非 chrome / 已安装去使用 / 下载 Chrome”等引导弹窗：
  - 优先通过 UA 兜底解决（最稳定、最可维护）
  - 不建议默认自动点击按钮（页面结构/文案随时变，容易误点下载或外跳）

## 如必须自动处理弹窗（允许但需满足）
- 仅在单一业务窗口内生效（例如“订单开票窗口”），不得影响其他内嵌页或主窗口
- 只做最小动作：关闭弹窗或点击“继续在当前页使用”类按钮
- 必须增加防误触约束：
  - 只在目标域名（`.pinduoduo.com`）且目标路径命中业务页时触发
  - 只在识别到明确的弹窗容器后触发；避免使用过于宽泛的选择器
  - 点击前校验按钮文本/aria-label 等关键特征，并设置单次触发上限（例如每次加载最多 1 次）

## 外链与新窗口（必须）
- `will-navigate` / `setWindowOpenHandler`：非 `.pinduoduo.com` 域名一律用系统浏览器打开（`shell.openExternal`）
- 内嵌窗口禁止打开新的 Electron 窗口链（统一 deny 新窗口请求，必要时在当前 view 打开）

## 安全与性能（必须）
- 内嵌 BrowserView / BrowserWindow：保持 `contextIsolation: true`、`nodeIntegration: false`
- 避免开启不必要权限（如 media / geolocation），按现有项目策略禁用
- 若页面渲染性能问题明显，优先排查：
  - 是否错误开启/关闭硬件加速
  - 是否重复创建 view 而未复用/销毁
  - 是否未正确 resize 导致反复 layout

## 验证清单
- 同一店铺：主窗口已登录 → 打开内嵌窗口无需重新登录
- 打开订单/开票/售后等后台页：不再出现“非 Chrome”拦截弹窗（或至少可正常继续使用）
- 外部链接仍走系统浏览器，不在内嵌窗口内加载第三方站点

