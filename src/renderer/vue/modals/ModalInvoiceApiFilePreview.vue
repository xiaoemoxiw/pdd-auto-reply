<script setup>
// 发票文件预览 Modal（迁移自 index.html#modalInvoiceApiFilePreview）
//
// 接入方式：
// - 原 invoice-api-module.showInvoiceApiFilePreview / hideInvoiceApiFilePreview
//   已改为通过 vueBridge.openModal('modalInvoiceApiFilePreview', { fileUrl }) 与 closeModal 控制；
// - blob URL 的创建/释放仍由 invoice-api-module 维护，本组件只负责展示；
// - 关闭时由原生 hideInvoiceApiFilePreview 释放 URL，组件自身只清空 iframe src。

import { computed } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const fileUrl = computed(() => String(props.payload?.fileUrl || '').trim());

function handleClose() {
  emit('update:visible', false);
  emit('close');
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="预览发票"
    width="900px"
    :show-footer="false"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-invoice-preview-body">
      <iframe
        v-if="fileUrl"
        :src="fileUrl"
        class="modal-invoice-preview-frame"
        title="发票预览"
      />
      <div v-else class="modal-invoice-preview-empty">未提供发票文件</div>
    </div>
  </AppModal>
</template>

<style>
.modal-invoice-preview-body {
  width: 100%;
  height: 70vh;
  background: #f5f7fa;
  border-radius: 6px;
  overflow: hidden;
}

.modal-invoice-preview-frame {
  width: 100%;
  height: 100%;
  border: 0;
}

.modal-invoice-preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #909399;
  font-size: 13px;
}
</style>
