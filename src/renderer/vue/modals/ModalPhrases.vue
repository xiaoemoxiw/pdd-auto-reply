<script setup>
// 管理快捷短语 Modal（迁移自 index.html#modalPhrases）
//
// payload: { initialText }
// 业务通过 window.quickPhrasesModule.saveQuickPhrasesFromText(text) 完成持久化与面板刷新。

import { ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const text = ref('');
const saving = ref(false);

watch(() => props.visible, (val) => {
  if (val) {
    text.value = String(props.payload?.initialText || '');
    saving.value = false;
  }
});

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleSave() {
  const mod = window.quickPhrasesModule;
  if (!mod?.saveQuickPhrasesFromText) {
    handleClose();
    return;
  }
  saving.value = true;
  try {
    await mod.saveQuickPhrasesFromText(text.value);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="管理快捷短语"
    width="640px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <el-form label-position="top">
      <el-form-item label="短语列表（每行一条，格式：分类|内容）">
        <el-input
          v-model="text"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 16 }"
          placeholder="欢迎|亲，您好！请问有什么可以帮您？&#10;通用|好的呢，马上为您处理"
        />
        <div class="modal-phrases-hint">格式示例: 欢迎|亲，您好！ 不填分类默认为"通用"</div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-phrases-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}
</style>
