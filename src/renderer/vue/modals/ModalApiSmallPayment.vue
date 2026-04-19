<script setup>
// 小额打款主表单 Modal（迁移自 small-payment-modal.js + index.html#modalApiSmallPayment）
//
// 业务 API 通过 window.smallPaymentModule.* 访问：
//   - getApiSmallPaymentTypeMeta：三种类型的标签 / refundType / 默认留言
//   - getApiSmallPaymentMaxAmount / clampApiSmallPaymentAmountInputValue：金额限制与校验
//   - loadApiSmallPaymentInfo：拉取剩余次数 / 模板状态 / tips
//   - submitApiSmallPayment：提交 IPC + cashier 跳转
//   - reopenApiSmallPaymentOrderSelector：重选订单返回上一步

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const NOTE_MAX_LENGTH = 60;
const MAX_TIMES = 3;

const TYPE_OPTIONS = [
  { value: 'shipping', label: '补运费' },
  { value: 'difference', label: '补差价' },
  { value: 'other', label: '其他' },
];

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const order = ref(null);
const type = ref('shipping');
const amountText = ref('');
const noteText = ref('');
const info = ref(null);
const loading = ref(false);
const submitting = ref(false);

let loadToken = 0;

const typeMeta = computed(() => {
  const fn = window.smallPaymentModule?.getApiSmallPaymentTypeMeta;
  return typeof fn === 'function' ? fn(type.value) : { label: '补运费', refundType: null, notePlaceholder: '已补偿给您，请查收' };
});

function formatMoney(value) {
  const fn = window.smallPaymentModule?.formatApiSideOrderMoneyNumber;
  return typeof fn === 'function' ? fn(value) : (value || '0.00');
}

function getQuantity(o) {
  const fn = window.smallPaymentModule?.getApiSmallPaymentOrderQuantity;
  return typeof fn === 'function' ? fn(o || {}) : '';
}

function maxAmountOf(o = order.value) {
  const fn = window.smallPaymentModule?.getApiSmallPaymentMaxAmount;
  return typeof fn === 'function' ? fn(o || {}, info.value) : 0;
}

function clamp(value, options = {}) {
  const fn = window.smallPaymentModule?.clampApiSmallPaymentAmountInputValue;
  return typeof fn === 'function'
    ? fn(value, { order: order.value, info: info.value, ...options })
    : String(value || '');
}

const detailText = computed(() => {
  if (!order.value) return '';
  const detail = String(order.value.detailText || '所拍规格待确认').trim();
  const quantity = getQuantity(order.value);
  return [detail, quantity].filter(Boolean).join(' · ');
});

const orderPriceText = computed(() => formatMoney(maxAmountOf() || 0));

const amountPlaceholder = computed(() => {
  const max = maxAmountOf();
  return max > 0 ? `单次上限¥${formatMoney(max)}` : '请输入打款金额';
});

const remainingTimes = computed(() => {
  const v = Number(info.value?.remainingTimes);
  return Number.isFinite(v) ? v : MAX_TIMES;
});

const amountTipText = computed(() => `最多可打款${remainingTimes.value}次`);

function formatFen(fen) {
  const numeric = Number(fen);
  if (!Number.isFinite(numeric) || numeric < 0) return '0.00';
  return formatMoney(numeric / 100);
}

const statusChips = computed(() => {
  if (!info.value) return [];
  const i = info.value;
  const usedTimes = Number.isFinite(Number(i.usedTimes)) ? Number(i.usedTimes) : 0;
  const successNum = Number.isFinite(Number(i?.history?.successNum)) ? Number(i.history.successNum) : 0;
  const processingNum = Number.isFinite(Number(i?.history?.processingNum)) ? Number(i.history.processingNum) : 0;
  const waitHandleNum = Number.isFinite(Number(i?.history?.waitHandleNum)) ? Number(i.history.waitHandleNum) : 0;
  const chips = [
    `最大金额 ¥${formatMoney(maxAmountOf() || 0)}`,
    `剩余次数 ${remainingTimes.value}`,
    `已打款 ${usedTimes}`,
    `成功 ${successNum}`,
    `处理中 ${processingNum}`,
    `待处理 ${waitHandleNum}`,
    `模板 ${i?.submitTemplateReady ? '已捕获' : '未捕获'}`,
  ];
  if (i?.submitTemplateReady) {
    const recognizedCount = Number(i?.submitTemplateMeta?.recognizedCount || 0) || 0;
    chips.push(`识别 ${recognizedCount}`);
  }
  return chips;
});

const statusTips = computed(() => {
  if (!info.value) return [];
  const i = info.value;
  const tips = [];
  if (i.transferDesc) tips.push(i.transferDesc);
  if (i.needChargePlayMoney) tips.push('平台提示当前打款可能涉及收费');
  if (i?.submitTemplateMeta?.recognizedFields) {
    const fields = i.submitTemplateMeta.recognizedFields;
    const labels = [
      fields.orderField ? '订单号' : '',
      fields.amountField ? '金额' : '',
      fields.typeField ? '类型' : '',
      fields.noteField ? '留言' : '',
      fields.mobileField ? '手机号' : '',
    ].filter(Boolean);
    if (labels.length) tips.push(`模板已识别字段：${labels.join('、')}`);
  }
  if (Array.isArray(i.tips) && i.tips.length) tips.push(...i.tips.slice(0, 3));
  if (!tips.length && Array.isArray(i.detailList) && i.detailList.length) {
    const first = i.detailList[0] || {};
    const amount = Number.isFinite(Number(first?.amount)) ? `¥${formatFen(first.amount)}` : '';
    const status = String(first?.statusDesc || first?.status_desc || first?.statusText || '').trim();
    if (amount || status) tips.push(`最近一笔记录 ${[amount, status].filter(Boolean).join(' · ')}`);
  }
  return tips;
});

const showStatusCard = computed(() => statusChips.value.length || statusTips.value.length);

const permissionText = computed(() => {
  const i = info.value;
  if (i?.transferDesc) return i.transferDesc;
  if (i && i.submitTemplateReady === false) {
    return '尚未捕获真实提交模板，可先在后台页面完成一次小额打款后再回到接口页继续对齐';
  }
  if (i?.submitTemplateReady) {
    const recognizedCount = Number(i?.submitTemplateMeta?.recognizedCount || 0) || 0;
    return recognizedCount > 0
      ? `已捕获真实提交模板，已识别 ${recognizedCount} 个关键字段，当前优先按真实字段提交`
      : '已捕获真实提交模板，当前将按模板字段尝试提交';
  }
  if (i?.needChargePlayMoney) return '当前打款能力涉及收费规则，请在确认前核对平台说明';
  if (Array.isArray(i?.tips) && i.tips.length) return i.tips[0];
  return '无管理员权限？点击提交打款申请给店铺管理员';
});

const submitDisabled = computed(() => {
  if (loading.value || submitting.value) return true;
  if (info.value && info.value.canSubmit === false) return true;
  return false;
});

const submitText = computed(() => {
  if (loading.value) return '加载中...';
  if (submitting.value) return '提交中...';
  if (info.value && info.value.canSubmit === false) return '暂不可打款';
  return '确认';
});

async function fetchInfo(targetOrder) {
  if (!targetOrder) return;
  const mod = window.smallPaymentModule;
  const apiState = window.__chatApiModuleAccess?.getState?.() || {};
  const shopId = apiState.apiActiveSessionShopId;
  const orderSn = targetOrder.orderId || targetOrder.orderSn;
  if (!mod?.loadApiSmallPaymentInfo || !shopId || !orderSn) return;
  loading.value = true;
  info.value = null;
  const token = ++loadToken;
  try {
    const result = await mod.loadApiSmallPaymentInfo({ shopId, orderSn });
    if (token !== loadToken) return;
    info.value = result || null;
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

function resetForm(nextOrder) {
  order.value = nextOrder || null;
  type.value = 'shipping';
  amountText.value = '';
  noteText.value = '';
  info.value = null;
  submitting.value = false;
}

watch(() => props.visible, (val) => {
  if (val) {
    resetForm(props.payload?.order || null);
    if (order.value) void fetchInfo(order.value);
  } else {
    loadToken += 1;
    loading.value = false;
    submitting.value = false;
  }
});

watch(() => props.payload?.order, (next) => {
  if (!props.visible) return;
  if (!next) return;
  if (order.value && next.key === order.value.key) return;
  resetForm(next);
  void fetchInfo(next);
});

function handleAmountInput(value) {
  amountText.value = clamp(value);
}

function handleAmountBlur() {
  amountText.value = clamp(amountText.value, { formatted: true });
}

function handleChangeOrder() {
  const fn = window.smallPaymentModule?.reopenApiSmallPaymentOrderSelector;
  if (typeof fn === 'function') fn();
  else handleClose();
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleSubmit() {
  const mod = window.smallPaymentModule;
  if (!mod?.submitApiSmallPayment) return;
  if (loading.value) {
    mod?.setApiHint?.('正在加载小额打款信息，请稍后再试');
    return;
  }
  submitting.value = true;
  try {
    const result = await mod.submitApiSmallPayment({
      order: order.value,
      info: info.value,
      type: type.value,
      amountText: amountText.value,
      noteText: noteText.value,
    });
    if (result?.success) {
      if (result.amountText) amountText.value = result.amountText;
      if (result.navigated) {
        handleClose();
      } else {
        await fetchInfo(order.value);
      }
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="小额打款"
    width="640px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-api-sp-intro">
      <strong>功能说明：</strong>
      如您与消费者之间存在补运费、补差价等小额补偿需求，请使用小额打款功能，打款成功后消费者将收到您的补偿金。
    </div>

    <div v-if="order" class="modal-api-sp-section">
      <div class="modal-api-sp-row">
        <div class="modal-api-sp-label">已选订单</div>
        <div class="modal-api-sp-order-card">
          <div class="modal-api-sp-order-media">
            <img v-if="order.imageUrl" :src="order.imageUrl" alt="商品主图" />
            <span v-else>商品</span>
          </div>
          <div class="modal-api-sp-order-main">
            <div class="modal-api-sp-order-id">订单编号：{{ order.orderId || '-' }}</div>
            <div class="modal-api-sp-order-title">{{ order.title || '当前订单信息待加载' }}</div>
            <div class="modal-api-sp-order-meta">
              <div class="modal-api-sp-order-detail">{{ detailText || '所拍规格待确认' }}</div>
              <div class="modal-api-sp-order-price">¥ <strong>{{ orderPriceText }}</strong></div>
            </div>
          </div>
          <div class="modal-api-sp-order-action">
            <el-button size="small" @click="handleChangeOrder">重选订单</el-button>
          </div>
        </div>
      </div>

      <div class="modal-api-sp-row">
        <div class="modal-api-sp-label">打款类型</div>
        <el-radio-group v-model="type">
          <el-radio v-for="opt in TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio>
        </el-radio-group>
      </div>

      <div class="modal-api-sp-row">
        <div class="modal-api-sp-label">打款金额</div>
        <div class="modal-api-sp-amount-row">
          <el-input
            :model-value="amountText"
            inputmode="decimal"
            :placeholder="amountPlaceholder"
            @update:model-value="handleAmountInput"
            @blur="handleAmountBlur"
          >
            <template #prepend>¥</template>
          </el-input>
          <div class="modal-api-sp-amount-tip">{{ amountTipText }}</div>
        </div>
      </div>

      <div class="modal-api-sp-row">
        <div class="modal-api-sp-label">给消费者留言</div>
        <div class="modal-api-sp-note-wrap">
          <el-input
            v-model="noteText"
            type="textarea"
            :rows="3"
            :maxlength="NOTE_MAX_LENGTH"
            :placeholder="typeMeta.notePlaceholder"
          />
          <div class="modal-api-sp-note-count">{{ noteText.length }}/{{ NOTE_MAX_LENGTH }}</div>
        </div>
      </div>
    </div>

    <div v-if="showStatusCard" class="modal-api-sp-status-card">
      <div class="modal-api-sp-status-row">
        <span v-for="(chip, idx) in statusChips" :key="idx" class="modal-api-sp-status-chip">{{ chip }}</span>
      </div>
      <div v-if="statusTips.length" class="modal-api-sp-status-tips">
        <span v-for="(tip, idx) in statusTips" :key="idx">{{ tip }}</span>
      </div>
    </div>

    <div class="modal-api-sp-permission">{{ permissionText }}</div>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :disabled="submitDisabled" :loading="submitting" @click="handleSubmit">
        {{ submitText }}
      </el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-api-sp-intro {
  background: #f5f7fa;
  padding: 12px;
  border-radius: 6px;
  font-size: 12px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 16px;
}

.modal-api-sp-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-api-sp-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.modal-api-sp-label {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
}

.modal-api-sp-order-card {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fafbfc;
  align-items: center;
}

.modal-api-sp-order-media {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  background: #f5f7fa;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.modal-api-sp-order-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-sp-order-media span {
  font-size: 12px;
  color: #909399;
}

.modal-api-sp-order-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-api-sp-order-id {
  font-size: 12px;
  color: #909399;
}

.modal-api-sp-order-title {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.modal-api-sp-order-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.modal-api-sp-order-detail {
  font-size: 12px;
  color: #606266;
}

.modal-api-sp-order-price {
  font-size: 13px;
  color: #f56c6c;
}

.modal-api-sp-order-price strong {
  font-size: 15px;
  font-weight: 600;
}

.modal-api-sp-order-action {
  flex-shrink: 0;
}

.modal-api-sp-amount-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.modal-api-sp-amount-row .el-input {
  flex: 1;
}

.modal-api-sp-amount-tip {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}

.modal-api-sp-note-wrap {
  position: relative;
}

.modal-api-sp-note-count {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 12px;
  color: #909399;
  pointer-events: none;
}

.modal-api-sp-status-card {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fafbfc;
}

.modal-api-sp-status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.modal-api-sp-status-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 12px;
  color: #606266;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 12px;
}

.modal-api-sp-status-tips {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #909399;
}

.modal-api-sp-permission {
  margin-top: 12px;
  padding: 8px 12px;
  background: #fdf6ec;
  color: #b88230;
  font-size: 12px;
  border-radius: 4px;
  line-height: 1.5;
}
</style>
