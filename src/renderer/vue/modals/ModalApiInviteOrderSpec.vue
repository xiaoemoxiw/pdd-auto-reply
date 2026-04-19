<script setup>
// 邀请下单 - 规格选择子 Modal（迁移自 invite-order-modal.js + index.html#modalApiInviteOrderSpec）
//
// payload: { item: { itemId, goodsId, title, imageUrl, priceText } }
// 流程：
// 1. 打开 → loadInviteOrderSkuOptions 拉规格
// 2. 用户选 sku → 点确定 → addInviteOrderItem
// 3. 成功 → emitInviteOrderSnapshot(snapshot) 通知父 modal → 关闭自己

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const item = ref({ itemId: '', goodsId: '', title: '商品', imageUrl: '', priceText: '' });
const optionLabel = ref('规格');
const skuOptions = ref([]);
const selectedSkuId = ref('');
const loading = ref(false);
const confirming = ref(false);
const errorText = ref('');

let loadToken = 0;

const hasSelectableOption = computed(() => skuOptions.value.some(opt => !opt.disabled));

const showOptions = computed(() => !loading.value && !errorText.value && skuOptions.value.length > 0);
const showLabel = computed(() => !errorText.value && (loading.value || skuOptions.value.length > 0));
const showEmpty = computed(() => !loading.value && !errorText.value && !skuOptions.value.length);

const confirmDisabled = computed(() => loading.value || confirming.value || !hasSelectableOption.value || !selectedSkuId.value);
const confirmText = computed(() => confirming.value ? '加入中...' : '确定');

async function loadOptions(payloadItem) {
  if (!payloadItem?.itemId) return;
  const mod = window.inviteOrderModule;
  if (!mod?.loadInviteOrderSkuOptions) return;
  loading.value = true;
  errorText.value = '';
  skuOptions.value = [];
  selectedSkuId.value = '';
  optionLabel.value = '规格';
  const token = ++loadToken;
  try {
    const result = await mod.loadInviteOrderSkuOptions(payloadItem);
    if (token !== loadToken) return;
    item.value = {
      itemId: payloadItem.itemId,
      goodsId: result.goodsId || payloadItem.goodsId || payloadItem.itemId,
      title: result.title || payloadItem.title || '商品',
      imageUrl: result.imageUrl || payloadItem.imageUrl || '',
      priceText: result.priceText || payloadItem.priceText || '',
    };
    optionLabel.value = result.optionLabel || '规格';
    skuOptions.value = result.skuOptions || [];
    selectedSkuId.value = result.selectedSkuId || '';
  } catch (error) {
    if (token !== loadToken) return;
    errorText.value = error?.message || '读取邀请下单规格失败';
    mod?.setApiHint?.(errorText.value);
    mod?.showApiSideOrderToast?.(errorText.value);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => props.visible, (val) => {
  if (val) {
    const payloadItem = props.payload?.item || {};
    item.value = {
      itemId: String(payloadItem.itemId || '').trim(),
      goodsId: String(payloadItem.goodsId || payloadItem.itemId || '').trim(),
      title: String(payloadItem.title || '').trim() || '商品',
      imageUrl: String(payloadItem.imageUrl || '').trim(),
      priceText: String(payloadItem.priceText || '').trim(),
    };
    confirming.value = false;
    void loadOptions(payloadItem);
  } else {
    loadToken += 1;
    loading.value = false;
    confirming.value = false;
    errorText.value = '';
  }
});

function selectSku(skuId) {
  selectedSkuId.value = skuId;
  errorText.value = '';
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleConfirm() {
  const mod = window.inviteOrderModule;
  if (!mod?.addInviteOrderItem) return;
  if (!item.value.itemId || !selectedSkuId.value) return;
  confirming.value = true;
  errorText.value = '';
  try {
    const snapshot = await mod.addInviteOrderItem({
      itemId: item.value.itemId,
      skuId: selectedSkuId.value,
    });
    mod?.emitInviteOrderSnapshot?.(snapshot);
    mod?.setApiHint?.('已加入邀请下单清单');
    handleClose();
  } catch (error) {
    errorText.value = error?.message || '加入邀请下单清单失败';
    mod?.setApiHint?.(errorText.value);
    mod?.showApiSideOrderToast?.(errorText.value);
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="选择商品规格"
    width="480px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-api-ios-product">
      <div class="modal-api-ios-product-media">
        <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.title" />
        <span v-else>商品</span>
      </div>
      <div class="modal-api-ios-product-main">
        <div v-if="item.priceText" class="modal-api-ios-product-price">{{ item.priceText }}</div>
        <div class="modal-api-ios-product-title">{{ item.title }}</div>
        <div class="modal-api-ios-product-tip">请选择：{{ optionLabel }}</div>
      </div>
    </div>

    <div v-if="loading" class="modal-api-ios-loading">正在加载可邀请规格...</div>
    <div v-if="errorText" class="modal-api-ios-error">{{ errorText }}</div>
    <div v-if="showEmpty" class="modal-api-ios-empty">当前商品暂无可邀请规格</div>

    <div v-if="showLabel" class="modal-api-ios-label">{{ optionLabel }}</div>
    <div v-if="showOptions" class="modal-api-ios-options">
      <button
        v-for="opt in skuOptions"
        :key="opt.skuId"
        type="button"
        class="modal-api-ios-option"
        :class="{ 'is-selected': opt.skuId === selectedSkuId, 'is-disabled': opt.disabled }"
        :disabled="opt.disabled"
        :title="opt.detailLabel || opt.label"
        @click="selectSku(opt.skuId)"
      >{{ opt.label }}</button>
    </div>

    <template #footer>
      <el-button type="primary" :disabled="confirmDisabled" :loading="confirming" @click="handleConfirm">
        {{ confirmText }}
      </el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-api-ios-product {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fafbfc;
  margin-bottom: 16px;
  align-items: center;
}

.modal-api-ios-product-media {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  background: #f5f7fa;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.modal-api-ios-product-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-ios-product-media span {
  font-size: 12px;
  color: #909399;
}

.modal-api-ios-product-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-api-ios-product-price {
  font-size: 13px;
  color: #f56c6c;
  font-weight: 500;
}

.modal-api-ios-product-title {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.modal-api-ios-product-tip {
  font-size: 12px;
  color: #909399;
}

.modal-api-ios-loading {
  text-align: center;
  padding: 24px;
  color: #606266;
  font-size: 13px;
}

.modal-api-ios-error {
  padding: 12px;
  margin-bottom: 12px;
  background: #fef0f0;
  color: #f56c6c;
  font-size: 13px;
  border-radius: 4px;
}

.modal-api-ios-empty {
  text-align: center;
  padding: 24px;
  color: #909399;
  font-size: 13px;
}

.modal-api-ios-label {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  margin-bottom: 8px;
}

.modal-api-ios-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}

.modal-api-ios-option {
  padding: 8px 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #303133;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
  word-break: break-all;
}

.modal-api-ios-option:hover:not(.is-disabled) {
  border-color: #409eff;
  color: #409eff;
}

.modal-api-ios-option.is-selected {
  border-color: #409eff;
  color: #409eff;
  background: #ecf5ff;
}

.modal-api-ios-option.is-disabled {
  background: #f5f7fa;
  color: #c0c4cc;
  cursor: not-allowed;
}
</style>
