<script setup>
// 退款 / 退货退款 / 补寄申请 Modal（迁移自 chat-api/modules/refund-modal.js + index.html#modalApiRefund）
//
// 业务 API 通过 window.refundModule.* 访问，本组件不直接调 pddApi。
// - getApiRefundTypeMeta / isApiRefundTypeAllowed / shouldShowApiRefundReceiptStatus 决定字段可用性与可见性；
// - normalizeApiRefundAmountInputValue / clampApiRefundAmountInputValue 处理金额输入校验；
// - formatApiRefundPaidText 用于商品价文案；
// - reopenApiRefundOrderSelector 触发"重选订单"返回上一步；
// - submitApiRefund 统一封装提交 IPC 与会话刷新。

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const REASON_OPTIONS = [
  { value: '不喜欢', text: '不喜欢、效果不好' },
  { value: '不想要了', text: '不想要了' },
  { value: '缺货', text: '缺货' },
  { value: '发货慢', text: '发货慢' },
  { value: '质量问题', text: '质量问题' },
  { value: '卖家发错货', text: '卖家发错货' },
  { value: '空包裹', text: '空包裹' },
  { value: '其他原因', text: '其他原因' },
  { value: '收到商品少件（含少配件）', text: '收到商品少件（含少配件）' },
  { value: '商品破损或污渍', text: '商品破损或污渍' },
];

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const refundType = ref('refund');
const receiptStatus = ref('');
const reasonValue = ref('');
const amountText = ref('');
const noteText = ref('');
const submitting = ref(false);

const orderContext = computed(() => props.payload?.order || {});
const allowReselect = computed(() => !!props.payload?.allowOrderReselect);

const typeMeta = computed(() => {
  const fn = window.refundModule?.getApiRefundTypeMeta;
  return typeof fn === 'function' ? fn(refundType.value) : { actionText: '退款', reasonLabel: '退款原因', amountLabel: '退款金额', defaultNote: '', noteHint: '' };
});

function isTypeAllowed(type) {
  const fn = window.refundModule?.isApiRefundTypeAllowed;
  return typeof fn === 'function' ? fn(type, orderContext.value) : true;
}

const showReceiptStatus = computed(() => {
  const fn = window.refundModule?.shouldShowApiRefundReceiptStatus;
  return typeof fn === 'function' ? fn(refundType.value, orderContext.value) : false;
});

const showAmount = computed(() => refundType.value !== 'resend');

const formattedPaid = computed(() => {
  const fn = window.refundModule?.formatApiRefundPaidText;
  return typeof fn === 'function' ? fn(orderContext.value.amountText) : (orderContext.value.amountText || '-');
});

function normalizeAmountForInput(value) {
  const fn = window.refundModule?.normalizeApiRefundAmountInputValue;
  return typeof fn === 'function' ? fn(value) : '';
}

function clampAmount(value, options = {}) {
  const fn = window.refundModule?.clampApiRefundAmountInputValue;
  return typeof fn === 'function' ? fn(value, { context: orderContext.value, ...options }) : String(value || '');
}

function isDefaultNote(value) {
  const constants = window.refundModule?.constants || {};
  const defaults = [constants.DEFAULT_NOTE, constants.RETURN_REFUND_DEFAULT_NOTE, constants.RESEND_DEFAULT_NOTE, ''];
  return defaults.includes(String(value || '').trim());
}

function resetForm() {
  refundType.value = 'refund';
  receiptStatus.value = '';
  reasonValue.value = '';
  amountText.value = clampAmount(normalizeAmountForInput(orderContext.value.amountText));
  noteText.value = typeMeta.value.defaultNote || '';
}

watch(() => props.visible, (val) => {
  if (val) resetForm();
});

watch(() => props.payload?.order, () => {
  if (props.visible) resetForm();
});

watch(refundType, (next, prev) => {
  if (next === prev) return;
  if (!isTypeAllowed(next)) {
    refundType.value = 'refund';
    return;
  }
  if (!showReceiptStatus.value) receiptStatus.value = '';
  if (next === 'resend') {
    amountText.value = '';
  } else {
    amountText.value = clampAmount(amountText.value || normalizeAmountForInput(orderContext.value.amountText));
  }
  if (isDefaultNote(noteText.value)) {
    noteText.value = typeMeta.value.defaultNote || '';
  }
});

function handleAmountInput(value) {
  amountText.value = clampAmount(value);
}

function handleAmountBlur() {
  amountText.value = clampAmount(amountText.value, { formatted: true });
}

function handleReselect() {
  const fn = window.refundModule?.reopenApiRefundOrderSelector;
  if (typeof fn === 'function') {
    fn();
    return;
  }
  emit('close');
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleSubmit() {
  const submit = window.refundModule?.submitApiRefund;
  if (typeof submit !== 'function') return;
  const selectedOption = REASON_OPTIONS.find(item => item.value === reasonValue.value);
  const reasonText = selectedOption?.text || reasonValue.value || '';
  submitting.value = true;
  try {
    const finalAmount = refundType.value === 'resend'
      ? ''
      : clampAmount(amountText.value, { formatted: true });
    if (refundType.value !== 'resend') amountText.value = finalAmount;
    const result = await submit({
      type: refundType.value,
      orderContext: orderContext.value,
      receiptStatus: receiptStatus.value,
      reasonText,
      reasonValue: reasonValue.value,
      questionType: 0,
      amountText: finalAmount,
      noteText: noteText.value,
    });
    if (result?.success) handleClose();
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="帮消费者申请售后"
    width="560px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-api-refund-card">
      <div class="modal-api-refund-media">
        <img v-if="orderContext.imageUrl" :src="orderContext.imageUrl" alt="商品主图" />
        <span v-else>商品</span>
      </div>
      <div class="modal-api-refund-info">
        <div class="modal-api-refund-order-id">订单编号：{{ orderContext.orderId || '-' }}</div>
        <div class="modal-api-refund-title">{{ orderContext.title || '当前会话暂无订单商品信息' }}</div>
        <div class="modal-api-refund-price">{{ formattedPaid }}</div>
      </div>
    </div>

    <el-form label-position="top" class="modal-api-refund-form" @submit.prevent>
      <el-form-item required label="申请类型">
        <el-radio-group v-model="refundType">
          <el-radio value="refund">退款</el-radio>
          <el-radio value="returnRefund" :disabled="!isTypeAllowed('returnRefund')">退货退款</el-radio>
          <el-radio value="resend" :disabled="!isTypeAllowed('resend')">补寄</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item v-if="showReceiptStatus" required label="收货状态">
        <el-radio-group v-model="receiptStatus">
          <el-radio value="not_received">未收到货</el-radio>
          <el-radio value="received">已收到货</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item required :label="typeMeta.reasonLabel">
        <el-select v-model="reasonValue" :placeholder="`请选择${typeMeta.reasonLabel}`" style="width: 100%;">
          <el-option
            v-for="opt in REASON_OPTIONS"
            :key="opt.value"
            :label="opt.text"
            :value="opt.value"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="showAmount" required label="退款金额">
        <el-input
          :model-value="amountText"
          type="number"
          inputmode="decimal"
          min="0"
          step="0.01"
          placeholder="请输入退款金额"
          @update:model-value="handleAmountInput"
          @blur="handleAmountBlur"
        />
      </el-form-item>

      <el-form-item>
        <template #label>
          <div class="modal-api-refund-note-header">
            <span>添加留言</span>
            <span class="modal-api-refund-note-count">{{ noteText.length }} / 200</span>
          </div>
        </template>
        <el-input
          v-model="noteText"
          type="textarea"
          :rows="4"
          maxlength="200"
        />
        <div class="modal-api-refund-note-hint">{{ typeMeta.noteHint }}</div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button v-if="allowReselect" @click="handleReselect">重选订单</el-button>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">提交</el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-api-refund-card {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fafbfc;
  margin-bottom: 16px;
  align-items: center;
}

.modal-api-refund-media {
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

.modal-api-refund-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-refund-media span {
  font-size: 12px;
  color: #909399;
}

.modal-api-refund-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-api-refund-order-id {
  font-size: 12px;
  color: #909399;
}

.modal-api-refund-title {
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

.modal-api-refund-price {
  font-size: 13px;
  color: #f56c6c;
  font-weight: 500;
}

.modal-api-refund-form .el-form-item {
  margin-bottom: 16px;
}

.modal-api-refund-note-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.modal-api-refund-note-count {
  font-size: 12px;
  color: #909399;
  font-weight: normal;
}

.modal-api-refund-note-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
}
</style>
