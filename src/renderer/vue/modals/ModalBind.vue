<script setup>
// 批量绑定店铺 Modal（迁移自 index.html#modalBind + shops-module 中的 startShopScan / confirmBindShops）
//
// 两步流程：
// 1. step1：点击"开始扫描"按钮，调用 window.shopsModule.scanAvailableShops()
// 2. step2：扫描结果列表（默认全选），可调整选择，点击"确认绑定"调用 window.shopsModule.confirmBindShops(selected)

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const step = ref(1);
const scanning = ref(false);
const binding = ref(false);
const scannedShops = ref([]);
const selectedKeys = ref([]);

const selectAll = computed({
  get: () => scannedShops.value.length > 0 && selectedKeys.value.length === scannedShops.value.length,
  set: (val) => {
    selectedKeys.value = val ? scannedShops.value.map((_, idx) => idx) : [];
  },
});

const confirmDisabled = computed(() => binding.value || selectedKeys.value.length === 0);
const scanText = computed(() => scanning.value ? '正在扫描，请稍候...' : '点击下方按钮开始扫描可绑定的店铺');
const scanIcon = computed(() => scanning.value ? '📡' : '🔍');

watch(() => props.visible, (val) => {
  if (val) {
    step.value = 1;
    scanning.value = false;
    binding.value = false;
    scannedShops.value = [];
    selectedKeys.value = [];
  }
});

async function handleStartScan() {
  const mod = window.shopsModule;
  if (!mod?.scanAvailableShops) return;
  scanning.value = true;
  try {
    const list = await mod.scanAvailableShops();
    scannedShops.value = Array.isArray(list) ? list : [];
    selectedKeys.value = scannedShops.value.map((_, idx) => idx);
    step.value = 2;
  } finally {
    scanning.value = false;
  }
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleConfirmBind() {
  const mod = window.shopsModule;
  if (!mod?.confirmBindShops) return;
  binding.value = true;
  try {
    const selected = selectedKeys.value
      .map(idx => scannedShops.value[idx])
      .filter(Boolean);
    await mod.confirmBindShops(selected);
  } finally {
    binding.value = false;
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="批量绑定店铺"
    width="640px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div v-if="step === 1" class="modal-bind-step">
      <div class="modal-bind-scan-status" :class="{ 'is-scanning': scanning }">
        <div class="modal-bind-scan-icon">{{ scanIcon }}</div>
        <div class="modal-bind-scan-text">{{ scanText }}</div>
      </div>
      <div class="modal-bind-scan-action">
        <el-button type="primary" :loading="scanning" @click="handleStartScan">开始扫描</el-button>
      </div>
    </div>

    <div v-else class="modal-bind-step">
      <div class="modal-bind-result-header">
        <span class="modal-bind-result-title">扫描到以下店铺</span>
        <el-checkbox v-model="selectAll">全选</el-checkbox>
      </div>
      <div v-if="!scannedShops.length" class="modal-bind-empty">
        未扫描到可绑定的店铺
      </div>
      <el-checkbox-group v-else v-model="selectedKeys" class="modal-bind-result-list">
        <el-checkbox
          v-for="(shop, idx) in scannedShops"
          :key="idx"
          :value="idx"
          class="modal-bind-result-item"
        >
          <div class="modal-bind-result-info">
            <div class="modal-bind-result-name">{{ shop.name }}</div>
            <div class="modal-bind-result-account">{{ shop.account }}</div>
          </div>
        </el-checkbox>
      </el-checkbox-group>
    </div>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button
        v-if="step === 2"
        type="primary"
        :loading="binding"
        :disabled="confirmDisabled"
        @click="handleConfirmBind"
      >确认绑定</el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-bind-step {
  min-height: 200px;
}

.modal-bind-scan-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: #fafbfc;
  border: 1px dashed #ebeef5;
  border-radius: 6px;
  gap: 12px;
}

.modal-bind-scan-status.is-scanning .modal-bind-scan-icon {
  animation: modal-bind-pulse 1s infinite;
}

@keyframes modal-bind-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.7; }
}

.modal-bind-scan-icon {
  font-size: 36px;
}

.modal-bind-scan-text {
  font-size: 13px;
  color: #606266;
}

.modal-bind-scan-action {
  text-align: center;
  margin-top: 16px;
}

.modal-bind-result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.modal-bind-result-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.modal-bind-result-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}

.modal-bind-result-list .el-checkbox {
  height: auto;
  margin-right: 0;
  padding: 8px 12px;
  border-radius: 4px;
  white-space: normal;
  align-items: flex-start;
}

.modal-bind-result-list .el-checkbox:hover {
  background: #f5f7fa;
}

.modal-bind-result-list .el-checkbox__label {
  flex: 1;
  font-weight: normal;
}

.modal-bind-result-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-bind-result-name {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
}

.modal-bind-result-account {
  font-size: 12px;
  color: #909399;
}

.modal-bind-empty {
  padding: 32px 16px;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
</style>
