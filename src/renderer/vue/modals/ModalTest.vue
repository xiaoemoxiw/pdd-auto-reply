<script setup>
// 测试规则 Modal（迁移自 index.html#modalTest）
//
// 接入方式：
// - 原生 qa-module 通过 vueBridge.openModal('modalTest', {}) 打开；
// - 内部直接调用 window.pddApi.testRule(message)，与原 runRuleTest 行为一致；
// - Enter 键触发测试，与原绑定保持一致。

import { ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const message = ref('');
const result = ref(null);
const testing = ref(false);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      message.value = '';
      result.value = null;
    }
  },
  { immediate: true }
);

async function runTest() {
  const trimmed = message.value.trim();
  if (!trimmed || testing.value) return;
  testing.value = true;
  try {
    if (window.pddApi && typeof window.pddApi.testRule === 'function') {
      const res = await window.pddApi.testRule(trimmed);
      result.value = res || { matched: false };
    } else {
      result.value = { matched: false };
      console.warn('[ModalTest] window.pddApi.testRule 不存在');
    }
  } catch (err) {
    console.error('[ModalTest] 测试规则失败', err);
    result.value = { matched: false, error: String(err?.message || err) };
  } finally {
    testing.value = false;
  }
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="测试规则"
    width="480px"
    :show-footer="false"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <el-form label-position="top" @submit.prevent="runTest">
      <el-form-item label="模拟客户消息">
        <el-input
          v-model="message"
          placeholder="输入一条客户消息来测试匹配..."
          autofocus
          clearable
          @keydown.enter.prevent="runTest"
        />
      </el-form-item>
    </el-form>
    <el-button type="success" style="width:100%;" :loading="testing" @click="runTest">
      开始测试
    </el-button>
    <div v-if="result" class="modal-test-result" :class="{ matched: result.matched }">
      <template v-if="result.matched">
        <div><strong>匹配成功！</strong></div>
        <div>规则：{{ result.ruleName || '-' }}</div>
        <div>回复：{{ result.reply || '-' }}</div>
      </template>
      <template v-else>
        <div>未匹配到任何规则</div>
        <div v-if="result.error" class="modal-test-result-err">{{ result.error }}</div>
      </template>
    </div>
  </AppModal>
</template>

<style>
.modal-test-result {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: 6px;
  background: #f5f7fa;
  color: #606266;
  font-size: 13px;
  line-height: 1.7;
}

.modal-test-result.matched {
  background: #f0f9eb;
  color: #67c23a;
}

.modal-test-result-err {
  margin-top: 4px;
  color: #f56c6c;
}
</style>
