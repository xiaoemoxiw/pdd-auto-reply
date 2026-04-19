'use strict';

const path = require('path');
const { defineConfig } = require('vite');
const vue = require('@vitejs/plugin-vue');

// 渲染层 Vue 子工程的构建配置
//
// 设计要点：
// 1. 当前 renderer 仍以 8 个 HTML + 30+ 个 IIFE 风格 JS 模块为主体，Vite 不接管它们；
//    Vite 只负责把 src/renderer/vue 下的 SFC 与 Element Plus 编译成单一 ES module bundle。
// 2. 产物输出到 src/renderer/dist-vue/，由现有 HTML 通过 <script type="module"> 引入。
// 3. base 设为 './'，保证 file:// 加载也能正确解析相对路径。
// 4. electron-builder 的 files 已是 src/**/*，dist-vue 自动包含，无需调整打包配置。

module.exports = defineConfig({
  root: path.resolve(__dirname, 'src/renderer/vue'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.resolve(__dirname, 'src/renderer/dist-vue'),
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, 'src/renderer/vue/main.js'),
      name: 'PddVueRuntime',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'style.css';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
