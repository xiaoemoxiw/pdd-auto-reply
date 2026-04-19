<script setup>
// 设置分组 Modal（迁移自 index.html#modalGroup）
//
// 接入方式：
// - 原生 shops-module.openGroupModal 通过 vueBridge.openModal('modalGroup', { groups })
//   把当前可选分组传过来；本组件不直接读全局 store；
// - 提交时调用 window.shopsModule.saveShopGroup({ groupId, newGroupName })
//   由原生侧完成持久化、setShops、renderGroupTabs、renderShops；
// - 新建分组与选择已有分组互斥：填了"新建名称"则忽略下拉选择。

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const groupId = ref('');
const newGroupName = ref('');
const submitting = ref(false);

const groups = computed(() => Array.isArray(props.payload?.groups) ? props.payload.groups : []);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      const list = groups.value;
      groupId.value = list.length ? list[0].id : '';
      newGroupName.value = '';
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
  submitting.value = true;
  try {
    const saveFn = window.shopsModule && window.shopsModule.saveShopGroup;
    if (typeof saveFn === 'function') {
      await saveFn({ groupId: groupId.value, newGroupName: newGroupName.value });
    } else {
      console.warn('[ModalGroup] 未找到 window.shopsModule.saveShopGroup');
    }
  } catch (err) {
    console.error('[ModalGroup] 保存分组失败', err);
  } finally {
    submitting.value = false;
    handleClose();
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="设置分组"
    width="420px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
    @confirm="handleConfirm"
  >
    <el-form label-position="top" @submit.prevent="handleConfirm">
      <el-form-item label="选择分组">
        <el-select v-model="groupId" placeholder="选择已有分组" style="width: 100%;" :disabled="!groups.length">
          <el-option
            v-for="group in groups"
            :key="group.id"
            :label="group.name"
            :value="group.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="或新建分组">
        <el-input
          v-model="newGroupName"
          placeholder="输入新分组名称"
          maxlength="20"
          show-word-limit
          clearable
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleConfirm">确定</el-button>
    </template>
  </AppModal>
</template>
