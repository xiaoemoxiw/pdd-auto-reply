<script setup>
// 应用类目店铺 Modal（迁移自 index.html#modalApplyShopCategory）
//
// 接入方式：
// - 原生 qa-module 通过 vueBridge.openModal('modalApplyShopCategory', {}) 打开；
// - 提交时调用 window.qaModule.applyShopCategory(category)，由原生侧完成规则更新与持久化；
// - 类目选项与原 select 保持一致（12 个）。

import { ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const SHOP_CATEGORIES = [
  { value: '__all__', label: '全部店铺' },
  { value: '水果生鲜', label: '水果生鲜' },
  { value: '美容个护', label: '美容个护' },
  { value: '家居生活', label: '家居生活' },
  { value: '服饰箱包', label: '服饰箱包' },
  { value: '母婴玩具', label: '母婴玩具' },
  { value: '食品保健', label: '食品保健' },
  { value: '虚拟商品', label: '虚拟商品' },
  { value: '运动户外', label: '运动户外' },
  { value: '数码电器', label: '数码电器' },
  { value: '家纺家具家装', label: '家纺家具家装' },
  { value: '汽配摩托', label: '汽配摩托' },
];

const category = ref('__all__');
const submitting = ref(false);

watch(
  () => props.visible,
  (val) => {
    if (val) category.value = '__all__';
  },
  { immediate: true }
);

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleConfirm() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const fn = window.qaModule && window.qaModule.applyShopCategory;
    if (typeof fn === 'function') {
      await fn(category.value);
    } else {
      console.warn('[ModalApplyShopCategory] 未找到 window.qaModule.applyShopCategory');
    }
  } catch (err) {
    console.error('[ModalApplyShopCategory] 应用类目失败', err);
  } finally {
    submitting.value = false;
    handleClose();
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="应用类目店铺"
    width="420px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
    @confirm="handleConfirm"
  >
    <el-form label-position="top">
      <el-form-item label="选择类目">
        <el-select v-model="category" style="width: 100%;">
          <el-option
            v-for="opt in SHOP_CATEGORIES"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <div class="form-hint" style="margin-top:6px;">将所选 QA 规则的适用店铺批量改为该类目下的店铺</div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleConfirm">应用</el-button>
    </template>
  </AppModal>
</template>
