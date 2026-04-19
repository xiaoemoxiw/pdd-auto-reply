<script setup>
// AppModal：所有迁移到 Vue 的弹窗的统一底座
//
// 约定：
// - 通过 v-model:visible 控制显隐，与 vueBridge.openModal / closeModal 联动；
// - title / width / showFooter 等基础属性透传到 ElDialog；
// - body 与 footer 都用 slot，业务 modal 只关注内容；
// - 所有 dialog 默认走中文 locale，已经在 main.js 注册。

import { computed } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: [String, Number], default: '480px' },
  showClose: { type: Boolean, default: true },
  closeOnClickModal: { type: Boolean, default: false },
  closeOnPressEscape: { type: Boolean, default: true },
  appendToBody: { type: Boolean, default: true },
  showFooter: { type: Boolean, default: true },
  destroyOnClose: { type: Boolean, default: false },
  hideHeader: { type: Boolean, default: false },
  dialogClass: { type: [String, Array, Object], default: '' },
});

const emit = defineEmits(['update:visible', 'close', 'opened', 'closed']);

const dialogVisible = computed({
  get: () => props.visible,
  set: (val) => {
    emit('update:visible', val);
    if (!val) emit('close');
  },
});
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="title"
    :width="width"
    :show-close="showClose"
    :close-on-click-modal="closeOnClickModal"
    :close-on-press-escape="closeOnPressEscape"
    :append-to-body="appendToBody"
    :destroy-on-close="destroyOnClose"
    :class="['app-modal', { 'app-modal--no-header': hideHeader }, dialogClass]"
    @opened="emit('opened')"
    @closed="emit('closed')"
  >
    <template v-if="hideHeader" #header><span /></template>
    <template v-else-if="$slots.header" #header>
      <slot name="header" />
    </template>
    <slot />
    <template v-if="showFooter" #footer>
      <slot name="footer">
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="$emit('confirm')">确定</el-button>
      </slot>
    </template>
  </el-dialog>
</template>

<style>
.app-modal .el-dialog__header {
  padding: 16px 20px;
  border-bottom: 1px solid #ebeef5;
  margin-right: 0;
}

.app-modal .el-dialog__body {
  padding: 20px;
}

.app-modal .el-dialog__footer {
  padding: 12px 20px;
  border-top: 1px solid #ebeef5;
}

.app-modal--no-header .el-dialog__header {
  display: none;
}

</style>
