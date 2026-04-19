<script setup>
// 小额打款订单选择 Modal（迁移自 small-payment-modal.js + index.html#modalApiSmallPaymentOrderSelect）
//
// payload: { candidates: SideOrderItem[] }
// 选择某订单 → 调 window.smallPaymentModule.selectApiSmallPaymentOrder(orderKey)
// 然后通过 vueBridge.openModal('modalApiSmallPayment', { order }) 打开主表单。

import { computed } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const candidates = computed(() => Array.isArray(props.payload?.candidates) ? props.payload.candidates : []);

function formatMoney(value) {
  const fn = window.smallPaymentModule?.formatApiSideOrderMoneyNumber;
  return typeof fn === 'function' ? fn(value) : (value || '0.00');
}

function getQuantity(order) {
  const fn = window.smallPaymentModule?.getApiSmallPaymentOrderQuantity;
  return typeof fn === 'function' ? fn(order) : '';
}

function getBaseAmount(order) {
  const fn = window.smallPaymentModule?.getApiSideOrderPriceBaseAmount;
  return typeof fn === 'function' ? fn(order) : 0;
}

function metaText(order) {
  const detail = String(order?.detailText || '所拍规格待确认').trim();
  const quantity = getQuantity(order);
  return [detail, quantity].filter(Boolean).join(' x ');
}

function selectOrder(order) {
  if (!order?.key) return;
  const mod = window.smallPaymentModule;
  const next = mod?.selectApiSmallPaymentOrder?.(order.key);
  if (!next) return;
  if (window.vueBridge?.closeModal) window.vueBridge.closeModal('modalApiSmallPaymentOrderSelect');
  if (window.vueBridge?.openModal) {
    window.vueBridge.openModal('modalApiSmallPayment', { order: next });
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="选择打款订单"
    width="600px"
    :show-footer="false"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div v-if="!candidates.length" class="modal-api-sp-select-empty">当前会话暂无可选订单</div>
    <div v-else class="modal-api-sp-select-list" :class="{ 'is-scrollable': candidates.length > 3 }">
      <div v-for="order in candidates" :key="order.key" class="modal-api-sp-select-item">
        <div class="modal-api-sp-select-media">
          <img v-if="order.imageUrl" :src="order.imageUrl" :alt="order.title || '订单商品'" />
          <span v-else>商品</span>
        </div>
        <div class="modal-api-sp-select-main">
          <div class="modal-api-sp-select-id">订单编号：{{ order.orderId || '-' }}</div>
          <div class="modal-api-sp-select-title">{{ order.title || '未命名商品' }}</div>
          <div class="modal-api-sp-select-meta">{{ metaText(order) }}</div>
          <div class="modal-api-sp-select-price">¥{{ formatMoney(getBaseAmount(order) || 0) }}</div>
        </div>
        <div class="modal-api-sp-select-action">
          <el-button type="primary" size="small" @click="selectOrder(order)">选择订单</el-button>
        </div>
      </div>
    </div>
    <div class="modal-api-sp-select-footer">
      <span>仅展示近 3 个月内的支付成功订单</span>
      <span>{{ candidates.length }} 条数据</span>
    </div>
  </AppModal>
</template>

<style>
.modal-api-sp-select-empty {
  text-align: center;
  padding: 32px;
  color: #909399;
  background: #f5f7fa;
  border-radius: 6px;
}

.modal-api-sp-select-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.modal-api-sp-select-list.is-scrollable {
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}

.modal-api-sp-select-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fff;
  align-items: center;
}

.modal-api-sp-select-media {
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

.modal-api-sp-select-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-sp-select-media span {
  font-size: 12px;
  color: #909399;
}

.modal-api-sp-select-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-api-sp-select-id {
  font-size: 12px;
  color: #909399;
}

.modal-api-sp-select-title {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  word-break: break-all;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.modal-api-sp-select-meta {
  font-size: 12px;
  color: #606266;
}

.modal-api-sp-select-price {
  font-size: 13px;
  color: #f56c6c;
  font-weight: 500;
}

.modal-api-sp-select-action {
  flex-shrink: 0;
}

.modal-api-sp-select-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 12px;
  color: #909399;
}
</style>
