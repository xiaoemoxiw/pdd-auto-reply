// 渲染层 Vue 子树入口
// 由现有 index.html 等 HTML 通过 <script type="module" src="./dist-vue/main.js"> 引入。
// 仅负责挂载 #app-vue 节点，原生 JS 模块继续走 <script src> 各自维护。

import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import * as ElIcons from '@element-plus/icons-vue';

import App from './App.vue';
import { createVueBridge } from './bridge.js';

const MOUNT_ID = 'app-vue';

function mountVueApp() {
  const target = document.getElementById(MOUNT_ID);
  if (!target) {
    console.warn('[vue-runtime] 缺少挂载点 #' + MOUNT_ID + '，跳过 Vue 子树初始化');
    return;
  }
  if (target.__vueAppMounted) return;

  const app = createApp(App);
  app.use(ElementPlus, { locale: zhCn });
  Object.entries(ElIcons).forEach(([name, comp]) => {
    app.component(`ElIcon${name}`, comp);
  });

  const bridge = createVueBridge();
  app.provide('vueBridge', bridge);
  window.vueBridge = bridge;

  app.mount(target);
  bridge.installShowModalProxy();
  target.__vueAppMounted = true;
  window.__vueRuntimeReady = true;
  document.dispatchEvent(new CustomEvent('vue-runtime:ready'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountVueApp, { once: true });
} else {
  mountVueApp();
}
