<script setup>
// 录入发票 Modal（迁移自 invoice-api-module.js + index.html#modalInvoiceApiEntry）
//
// payload: 由 window.invoiceApiModule.openInvoiceApiEntryDialog 通过 vueBridge 注入
//   - serialNo / orderSn / shopId / shopName / businessType / invoiceKindValue
//   - orderStatus / applyTime / invoiceAmount / letterheadType / letterhead / taxNo
//   - goodsName / goodsSpec / goodsThumb / orderSnDateText / initialStatus
//
// 业务调用：
//   - window.invoiceApiModule.loadInvoiceApiEntrySubmitDetail({shopId, orderSn})
//   - window.invoiceApiModule.submitInvoiceApiEntryFromForm({...formData, file})
//   - window.invoiceApiModule.previewInvoiceApiFile(file)
//   - window.invoiceApiModule.hideInvoiceApiFilePreview()
//   - window.invoiceApiModule.extractInvoiceNumberFromFileName(fileName)
//   - window.showApiImagePreview(url)
//   - window.pddApi.openInvoiceOrderDetailWindow(...)
//
// 复用已有的 .invoice-api-entry-* 命名空间样式（在 invoice-api-module.css 中定义）。

import { computed, ref, useTemplateRef, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const data = ref(createEmptyState());
const fileInputRef = useTemplateRef('fileInputRef');
const fileName = ref('');
const invoiceNumber = ref('');
const invoiceCode = ref('');
const autoInvoiceNumberFromFile = ref('');
const invoicePdfUrl = ref('');
const warnConfirmed = ref(false);
const canSubmit = ref(null);
const loading = ref(false);
const submitting = ref(false);
let currentFile = null;

function createEmptyState() {
  return {
    serialNo: '',
    orderSn: '',
    shopId: '',
    shopName: '',
    businessType: 1,
    invoiceKindValue: 0,
    orderStatus: '',
    applyTime: 0,
    invoiceAmount: 0,
    invoiceMode: '',
    invoiceType: '',
    invoiceKind: '',
    letterheadType: '',
    letterhead: '',
    taxNo: '',
    goodsName: '',
    goodsSpec: '',
    goodsThumb: '',
    orderSnDateText: ''
  };
}

const hasFile = computed(() => !!fileName.value);
const canPreviewFile = computed(() => hasFile.value && /\.pdf$/i.test(fileName.value));
const submitDisabled = computed(() => loading.value || submitting.value || canSubmit.value === false);
const submitText = computed(() => {
  if (submitting.value) return warnConfirmed.value ? '确认中...' : '提交中...';
  return warnConfirmed.value ? '再次确认' : '确认';
});
const invoiceAmountText = computed(() => {
  const value = Number(data.value.invoiceAmount);
  if (!Number.isFinite(value)) return '-';
  return typeof window.formatApiAmount === 'function'
    ? window.formatApiAmount(value)
    : value.toFixed(2);
});

const orderSnDateLabel = computed(() => {
  return data.value.orderSnDateText ? `订单号日期：${data.value.orderSnDateText}` : '';
});

watch(() => props.visible, (val) => {
  if (val) {
    hydrate(props.payload || {});
    void loadDetail();
  } else {
    teardownPreview();
    resetState();
  }
});

function hydrate(payload) {
  const next = createEmptyState();
  Object.keys(next).forEach(key => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      next[key] = payload[key];
    }
  });
  data.value = next;
  fileName.value = '';
  invoiceNumber.value = '';
  invoiceCode.value = '';
  autoInvoiceNumberFromFile.value = '';
  invoicePdfUrl.value = '';
  warnConfirmed.value = false;
  canSubmit.value = null;
  loading.value = false;
  submitting.value = false;
  currentFile = null;
  if (fileInputRef.value) fileInputRef.value.value = '';
  const initialStatus = payload.initialStatus || {};
  if (initialStatus.text) {
    notify(initialStatus.type || 'info', initialStatus.text);
  }
}

function resetState() {
  fileName.value = '';
  invoiceNumber.value = '';
  invoiceCode.value = '';
  autoInvoiceNumberFromFile.value = '';
  invoicePdfUrl.value = '';
  warnConfirmed.value = false;
  canSubmit.value = null;
  loading.value = false;
  submitting.value = false;
  currentFile = null;
  if (fileInputRef.value) fileInputRef.value.value = '';
}

function teardownPreview() {
  const mod = window.invoiceApiModule;
  if (mod?.hideInvoiceApiFilePreview) {
    mod.hideInvoiceApiFilePreview();
  }
}

function notify(type, text) {
  const mod = window.invoiceApiModule;
  if (mod?.notifyStatus) {
    mod.notifyStatus(type, text);
    return;
  }
  if (typeof window.showToast === 'function') {
    window.showToast(text);
  }
}

async function loadDetail() {
  const mod = window.invoiceApiModule;
  if (!mod?.loadInvoiceApiEntrySubmitDetail) return;
  const shopId = String(data.value.shopId || '').trim();
  const orderSn = String(data.value.orderSn || '').trim();
  if (!shopId || !orderSn) return;
  loading.value = true;
  notify('info', '正在加载录入发票校验信息...');
  try {
    const result = await mod.loadInvoiceApiEntrySubmitDetail({ shopId, orderSn });
    if (!result.ok) {
      canSubmit.value = null;
      notify('warn', result.error || '加载录入发票校验信息失败');
      return;
    }
    canSubmit.value = result.canSubmit;
    if (result.detail?.taxNo) {
      data.value = { ...data.value, taxNo: result.detail.taxNo };
    }
    if (canSubmit.value === false) {
      notify('warn', '接口校验未开放录入发票提交能力');
    }
  } finally {
    loading.value = false;
  }
}

function handleFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) {
    currentFile = null;
    fileName.value = '';
    autoInvoiceNumberFromFile.value = '';
    invoicePdfUrl.value = '';
    warnConfirmed.value = false;
    return;
  }
  if (!/\.(pdf|ofd)$/i.test(file.name)) {
    event.target.value = '';
    currentFile = null;
    fileName.value = '';
    notify('error', '仅支持上传 PDF 或 OFD 文件。');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    event.target.value = '';
    currentFile = null;
    fileName.value = '';
    notify('error', '发票文件不能超过 5M。');
    return;
  }
  currentFile = file;
  fileName.value = file.name;
  invoicePdfUrl.value = '';
  warnConfirmed.value = false;
  const mod = window.invoiceApiModule;
  const extracted = mod?.extractInvoiceNumberFromFileName ? mod.extractInvoiceNumberFromFileName(file.name) : '';
  if (extracted) {
    const current = String(invoiceNumber.value || '').trim();
    if (!current || current === autoInvoiceNumberFromFile.value) {
      invoiceNumber.value = extracted;
    }
  }
  autoInvoiceNumberFromFile.value = extracted || '';
}

function handlePreview(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!currentFile) {
    notify('error', '请先上传发票文件。');
    return;
  }
  const mod = window.invoiceApiModule;
  if (!mod?.previewInvoiceApiFile) return;
  const result = mod.previewInvoiceApiFile(currentFile);
  if (result && result.ok === false) {
    notify(result.type || 'warn', result.message || '');
  }
}

function handleThumbClick() {
  const url = String(data.value.goodsThumb || '').trim();
  if (!url) return;
  if (typeof window.showApiImagePreview === 'function') {
    window.showApiImagePreview(url);
  }
}

function handleOrderSnClick(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const orderSn = String(data.value.orderSn || '').trim();
  if (!orderSn) return;
  if (window.pddApi && typeof window.pddApi.openInvoiceOrderDetailWindow === 'function') {
    window.pddApi.openInvoiceOrderDetailWindow({
      shopId: String(data.value.shopId || '').trim(),
      orderSn,
      serialNo: String(data.value.serialNo || '').trim()
    });
  }
}

async function handleSubmit() {
  if (submitDisabled.value) return;
  if (!currentFile) {
    notify('error', '请先上传发票文件。');
    return;
  }
  const trimmedNumber = String(invoiceNumber.value || '').trim();
  if (!trimmedNumber) {
    notify('error', '请填写发票号码。');
    return;
  }
  const mod = window.invoiceApiModule;
  if (!mod?.submitInvoiceApiEntryFromForm) return;
  submitting.value = true;
  notify('info', warnConfirmed.value ? '正在确认并提交录入发票...' : '正在提交录入发票...');
  try {
    const result = await mod.submitInvoiceApiEntryFromForm({
      shopId: data.value.shopId,
      serialNo: data.value.serialNo,
      orderSn: data.value.orderSn,
      invoiceNumber: trimmedNumber,
      invoiceCode: invoiceCode.value || '',
      letterhead: data.value.letterhead,
      taxNo: data.value.taxNo,
      invoiceKindValue: data.value.invoiceKindValue,
      businessType: data.value.businessType,
      invoicePdfUrl: invoicePdfUrl.value,
      warnConfirmed: warnConfirmed.value,
      canSubmit: canSubmit.value,
      file: currentFile
    });
    if (result.ok) {
      handleClose();
      return;
    }
    if (result.warn) {
      warnConfirmed.value = true;
      if (result.invoicePdfUrl) invoicePdfUrl.value = result.invoicePdfUrl;
      if (result.invoiceNumber) invoiceNumber.value = result.invoiceNumber;
      if (result.invoiceCode !== undefined && result.invoiceCode !== null) {
        invoiceCode.value = String(result.invoiceCode);
      }
      notify('warn', result.message);
      return;
    }
    notify(result.status || 'error', result.message || '录入发票提交失败');
  } finally {
    submitting.value = false;
  }
}

function handleClose() {
  teardownPreview();
  emit('update:visible', false);
  emit('close');
}
</script>

<template>
  <AppModal
    :visible="visible"
    width="640px"
    :show-footer="false"
    hide-header
    :destroy-on-close="true"
    dialog-class="modal-invoice-api-entry-dialog"
    @update:visible="(val) => !val && handleClose()"
    @close="handleClose"
  >
    <div class="invoice-api-entry-modal">
      <div class="invoice-api-entry-head">
        <div class="invoice-api-entry-title">录入发票</div>
        <button class="invoice-api-entry-close" type="button" aria-label="关闭" @click="handleClose">×</button>
      </div>
      <div class="invoice-api-entry-body">
        <div class="invoice-api-entry-order">
          <div class="invoice-api-entry-order-sn-row">
            <span class="invoice-api-entry-order-sn-label">订单号：</span>
            <a class="invoice-api-entry-order-sn" href="javascript:void(0)" @click="handleOrderSnClick">
              {{ data.orderSn || '-' }}
            </a>
            <span class="invoice-api-entry-order-status">{{ data.orderStatus || '-' }}</span>
          </div>
          <div class="invoice-api-entry-order-goods">
            <button
              class="invoice-api-entry-thumb-btn"
              type="button"
              aria-label="查看商品图片"
              :disabled="!data.goodsThumb"
              @click="handleThumbClick"
            >
              <img
                v-if="data.goodsThumb"
                class="invoice-api-entry-thumb"
                :src="data.goodsThumb"
                alt=""
              />
              <div v-else class="invoice-api-entry-thumb-placeholder">暂无图片</div>
            </button>
            <div class="invoice-api-entry-goods-main">
              <div class="invoice-api-entry-goods-title">{{ data.goodsName || '-' }}</div>
              <div class="invoice-api-entry-goods-spec">
                <span>{{ data.goodsSpec || '-' }}</span>
                <span v-if="orderSnDateLabel" class="invoice-api-entry-goods-spec-date">{{ orderSnDateLabel }}</span>
              </div>
              <div class="invoice-api-entry-goods-amount">
                发票金额：<span>{{ invoiceAmountText }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="invoice-api-entry-meta">
          <div class="invoice-api-entry-meta-row">
            <span class="invoice-api-entry-meta-label">抬头类型：</span><span>{{ data.letterheadType || '-' }}</span>
          </div>
          <div class="invoice-api-entry-meta-row">
            <span class="invoice-api-entry-meta-label">发票抬头：</span><span>{{ data.letterhead || '-' }}</span>
          </div>
          <div class="invoice-api-entry-meta-row">
            <span class="invoice-api-entry-meta-label">企业税号：</span><span>{{ data.taxNo || '-' }}</span>
          </div>
        </div>

        <div class="invoice-api-entry-form">
          <div class="invoice-api-entry-field invoice-api-entry-field--file">
            <div class="invoice-api-entry-field-head">
              <label class="invoice-api-entry-required">发票文件</label>
            </div>
            <div class="invoice-api-entry-file-layout">
              <div class="invoice-api-entry-file-left">
                <label
                  class="invoice-api-entry-upload-box"
                  :data-has-file="hasFile ? '1' : ''"
                  :data-can-preview="canPreviewFile ? '1' : ''"
                >
                  <input
                    ref="fileInputRef"
                    type="file"
                    accept=".pdf,.ofd,application/pdf,application/octet-stream"
                    @change="handleFileChange"
                  />
                  <svg
                    v-if="!hasFile"
                    class="invoice-api-entry-upload-icon"
                    viewBox="0 0 24 24"
                    width="34"
                    height="34"
                    aria-hidden="true"
                  >
                    <path d="M4 6.5C4 5.12 5.12 4 6.5 4h4.8c.53 0 1.04.21 1.41.59l1.2 1.2c.19.19.44.3.71.3h2.89C18.88 6.09 20 7.21 20 8.59v8.91C20 18.88 18.88 20 17.5 20h-11C5.12 20 4 18.88 4 17.5V6.5zm2.5-.5c-.28 0-.5.22-.5.5v11c0 .28.22.5.5.5h11c.28 0 .5-.22.5-.5V8.59c0-.28-.22-.5-.5-.5h-3.1c-.8 0-1.57-.32-2.13-.88l-1.03-1.03a.5.5 0 0 0-.35-.15H6.5z" fill="currentColor"></path>
                  </svg>
                  <div v-if="hasFile" class="invoice-api-entry-upload-file-icon" aria-hidden="true">
                    <span>PDF</span>
                  </div>
                  <div v-if="!hasFile" class="invoice-api-entry-upload-text">上传文件</div>
                  <button
                    v-if="canPreviewFile"
                    type="button"
                    class="invoice-api-entry-upload-preview"
                    @click="handlePreview"
                  >预览</button>
                </label>
              </div>
              <div class="invoice-api-entry-file-right">
                <div class="invoice-api-entry-hint invoice-api-entry-hint--file">支持上传PDF和OFD文件，大小不超过5M</div>
                <div v-if="hasFile" class="invoice-api-entry-upload-warning">
                  请再次核实上传发票的抬头，若开具或提供的发票抬头与消费者申请不一致的，平台有权依据平台协议、《拼多多商家发票管理细则》及相关规定对店铺采取处理措施。如确认无误请继续提交。
                </div>
              </div>
            </div>
          </div>
          <div class="invoice-api-entry-field-row">
            <div class="invoice-api-entry-field invoice-api-entry-field--number">
              <label class="invoice-api-entry-required">发票号码</label>
              <input v-model="invoiceNumber" class="form-input" placeholder="请输入" />
            </div>
            <div class="invoice-api-entry-field invoice-api-entry-field--code">
              <label class="invoice-api-entry-label">发票代码</label>
              <input v-model="invoiceCode" class="form-input" placeholder="如果开具的发票无“发票代码”，可不填写" />
            </div>
          </div>
        </div>
      </div>
      <div class="invoice-api-entry-footer">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="submitDisabled"
          @click="handleSubmit"
        >{{ submitText }}</button>
        <button type="button" class="btn btn-secondary" @click="handleClose">取消</button>
      </div>
    </div>
  </AppModal>
</template>

<style>
/* 把 invoice-api-entry-modal 当成内容容器，关掉 ElDialog 默认 body padding 即可保留原视觉。 */
.modal-invoice-api-entry-dialog .el-dialog__body {
  padding: 0;
}
</style>
