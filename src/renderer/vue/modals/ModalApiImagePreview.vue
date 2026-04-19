<script setup>
// 图片预览 Modal（迁移自 index.html#modalApiImagePreview）
//
// 接入方式：
// - 原全局 window.showApiImagePreview(url) 已在 index.html 改为转发到 vueBridge.openModal('modalApiImagePreview', { url })；
// - chat-api-module / invoice-api-module 等调用 window.showApiImagePreview 的地方无需改动；
// - 关闭时清空 src 释放内存。

import { computed } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const url = computed(() => String(props.payload?.url || '').trim());

function handleClose() {
  emit('update:visible', false);
  emit('close');
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="查看图片"
    width="640px"
    :show-footer="false"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-image-preview-body">
      <img v-if="url" :src="url" alt="对话图片预览" />
      <div v-else class="modal-image-preview-empty">图片地址无效</div>
    </div>
  </AppModal>
</template>

<style>
.modal-image-preview-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  background: #f5f7fa;
  border-radius: 6px;
}

.modal-image-preview-body img {
  max-width: 100%;
  max-height: 70vh;
  display: block;
}

.modal-image-preview-empty {
  color: #909399;
  font-size: 13px;
  padding: 24px;
}
</style>
