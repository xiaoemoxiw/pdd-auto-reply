<script setup>
// 店铺备注 Modal（迁移自 index.html#modalRemark）
//
// 接入方式：
// - 原生侧通过 vueBridge.openModal('modalRemark', { shopId, remark }) 打开；
//   也兼容旧的 showModal('modalRemark') —— bridge 会自动转发，但需要 payload 才能拿到当前 remark。
// - 提交时调用 window.shopsModule.saveShopRemark(shopId, remark)，
//   由原生 shops-module 完成"读取最新 store + 持久化 + renderShops"全链路，
//   Vue 不直接接触 shops 数据流。

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const remark = ref('');
const submitting = ref(false);

const shopId = computed(() => props.payload?.shopId || null);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      remark.value = String(props.payload?.remark || '');
    }
  },
  { immediate: true }
);

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleConfirm() {
  if (submitting.value) return;
  if (!shopId.value) {
    handleClose();
    return;
  }

  submitting.value = true;
  try {
    const saveFn = window.shopsModule && window.shopsModule.saveShopRemark;
    if (typeof saveFn === 'function') {
      await saveFn(shopId.value, remark.value);
    } else {
      console.warn('[ModalRemark] 未找到 window.shopsModule.saveShopRemark，备注未保存');
    }
  } catch (err) {
    console.error('[ModalRemark] 保存备注失败', err);
  } finally {
    submitting.value = false;
    handleClose();
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="添加备注"
    width="420px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
    @confirm="handleConfirm"
  >
    <el-form label-position="top" @submit.prevent="handleConfirm">
      <el-form-item label="备注内容">
        <el-input
          v-model="remark"
          placeholder="输入备注信息"
          maxlength="50"
          show-word-limit
          clearable
          autofocus
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleConfirm">确定</el-button>
    </template>
  </AppModal>
</template>
