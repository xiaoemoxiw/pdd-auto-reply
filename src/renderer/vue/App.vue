<script setup>
// Vue 子树根组件：当前只承载后续迁移过来的 Modal 集合。
// 渲染层主体仍由原生 JS 模块和现有 HTML 控制，App.vue 只负责 modal 子树的渲染。

import ModalHost from './modals/ModalHost.vue';
</script>

<template>
  <div class="app-vue-root">
    <ModalHost />
  </div>
</template>

<style>
.app-vue-root {
  position: relative;
  z-index: auto;
}
</style>
