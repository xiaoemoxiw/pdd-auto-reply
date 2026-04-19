<script setup>
// 退款订单选择 Modal（迁移自 chat-api/modules/refund-modal.js + index.html#modalApiRefundOrderSelect）
//
// 接入方式：
// - refund-modal.js#openApiRefundOrderSelector 拉取候选订单后，通过 vueBridge.openModal('modalApiRefundOrderSelect', { candidates }) 打开；
// - 选择某订单 → 调 window.refundModule.selectApiRefundOrder(order)，由 module 关闭本 modal 并打开 ModalApiRefund；
// - 当候选只有 1 条时，refund-modal.js 会跳过本 modal 直接弹 ModalApiRefund，本组件不会出现。

import { computed } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const candidates = computed(() => Array.isArray(props.payload?.candidates) ? props.payload.candidates : []);

function formatPaid(amountText) {
  const fn = window.refundModule?.formatApiRefundPaidText;
  return typeof fn === 'function' ? fn(amountText) : (amountText || '-');
}

function selectOrder(order) {
  const fn = window.refundModule?.selectApiRefundOrder;
  if (typeof fn === 'function') {
    fn(order);
    return;
  }
  emit('close');
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="帮消费者申请售后"
    width="640px"
    :show-footer="false"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-api-refund-select-tip">仅展示该买家近三年内的支付成功订单</div>
    <div v-if="!candidates.length" class="modal-api-refund-select-empty">当前会话暂无可选订单</div>
    <div v-else class="modal-api-refund-select-list" :class="{ 'is-scrollable': candidates.length > 2 }">
      <div v-for="order in candidates" :key="order.key" class="modal-api-refund-select-item">
        <div class="modal-api-refund-select-media">
          <img v-if="order.imageUrl" :src="order.imageUrl" :alt="order.title || '订单商品'" />
          <span v-else>商品</span>
        </div>
        <div class="modal-api-refund-select-main">
          <div class="modal-api-refund-select-id">订单号：{{ order.orderId || '-' }}</div>
          <div class="modal-api-refund-select-title">{{ order.title || '订单商品' }}</div>
          <div class="modal-api-refund-select-detail">{{ order.detailText || '所拍规格待确认' }}</div>
          <div class="modal-api-refund-select-price">{{ formatPaid(order.amountText) }}</div>
          <div v-if="order.afterSalesStatus" class="modal-api-refund-select-status">
            售后：{{ order.afterSalesStatus }}
          </div>
        </div>
        <div class="modal-api-refund-select-action">
          <el-button type="primary" size="small" @click="selectOrder(order)">选择订单</el-button>
        </div>
      </div>
    </div>
  </AppModal>
</template>

<style>
.modal-api-refund-select-tip {
  font-size: 12px;
  color: #909399;
  margin-bottom: 12px;
}

.modal-api-refund-select-empty {
  text-align: center;
  padding: 32px;
  color: #909399;
  background: #f5f7fa;
  border-radius: 6px;
}

.modal-api-refund-select-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.modal-api-refund-select-list.is-scrollable {
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}

.modal-api-refund-select-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fff;
  align-items: center;
}

.modal-api-refund-select-media {
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

.modal-api-refund-select-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-refund-select-media span {
  font-size: 12px;
  color: #909399;
}

.modal-api-refund-select-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-api-refund-select-id {
  font-size: 12px;
  color: #909399;
}

.modal-api-refund-select-title {
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

.modal-api-refund-select-detail {
  font-size: 12px;
  color: #606266;
}

.modal-api-refund-select-price {
  font-size: 13px;
  color: #f56c6c;
  font-weight: 500;
}

.modal-api-refund-select-status {
  font-size: 12px;
  color: #e6a23c;
}

.modal-api-refund-select-action {
  flex-shrink: 0;
}
</style>
