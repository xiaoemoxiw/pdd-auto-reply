<script setup>
// 邀请下单主 Modal（迁移自 invite-order-modal.js + index.html#modalApiInviteOrder）
//
// 双面板布局：
// - 左侧：店铺商品 + 关键词搜索 + 加入清单按钮（点击弹规格选择子 modal）
// - 右侧：邀请清单 + 清空按钮 + 合计金额 + 状态文案
// - 底部：取消 / 发送
//
// 业务通过 window.inviteOrderModule.* 调用。
// 子 modal（规格选择）添加成功后通过 onInviteOrderSnapshot 通知本组件刷新 snapshot。

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const keyword = ref('');
const goodsItems = ref([]);
const selectedItems = ref([]);
const selectedCount = ref(0);
const totalText = ref('¥0.00');
const statusText = ref('未添加任何商品，请从左侧列表选择商品');
const canClear = ref(false);
const loading = ref(false);
const submitting = ref(false);

let loadToken = 0;
let unsubscribeSnapshot = null;

const submitDisabled = computed(() => loading.value || submitting.value || selectedCount.value <= 0);
const submitText = computed(() => submitting.value ? '发送中...' : '发送');
const clearDisabled = computed(() => loading.value || !canClear.value);
const searchDisabled = computed(() => loading.value || submitting.value);
const searchText = computed(() => loading.value ? '查询中...' : '搜索');

function applySnapshot(snapshot) {
  if (!snapshot) return;
  goodsItems.value = snapshot.goodsItems || [];
  selectedItems.value = snapshot.selectedItems || [];
  selectedCount.value = Number(snapshot.selectedCount || 0);
  totalText.value = snapshot.totalText || '¥0.00';
  statusText.value = snapshot.statusText || '';
  canClear.value = !!snapshot.canClear;
  loading.value = false;
  submitting.value = false;
}

async function fetchSnapshot({ keyword: nextKeyword, refreshOpen = true, hint = false } = {}) {
  const mod = window.inviteOrderModule;
  if (!mod?.loadInviteOrderSnapshot) return;
  const targetKeyword = nextKeyword !== undefined ? String(nextKeyword || '').trim() : keyword.value;
  keyword.value = targetKeyword;
  loading.value = true;
  const token = ++loadToken;
  try {
    const snapshot = await mod.loadInviteOrderSnapshot({ keyword: targetKeyword, refreshOpen });
    if (token !== loadToken) return;
    applySnapshot(snapshot);
    if (hint && snapshot.source) {
      mod?.setApiHint?.(snapshot.source === 'api' ? '邀请下单已切到真实接口链路' : '邀请下单数据已刷新');
    }
  } catch (error) {
    if (token !== loadToken) return;
    goodsItems.value = [];
    selectedItems.value = [];
    selectedCount.value = 0;
    totalText.value = '¥0.00';
    statusText.value = error?.message || '读取邀请下单弹窗失败';
    canClear.value = false;
    loading.value = false;
    mod?.setApiHint?.(error?.message || '读取邀请下单弹窗失败');
    mod?.showApiSideOrderToast?.(error?.message || '读取邀请下单弹窗失败');
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

function resetState() {
  keyword.value = '';
  goodsItems.value = [];
  selectedItems.value = [];
  selectedCount.value = 0;
  totalText.value = '¥0.00';
  statusText.value = '未添加任何商品，请从左侧列表选择商品';
  canClear.value = false;
  loading.value = false;
  submitting.value = false;
}

watch(() => props.visible, (val) => {
  if (val) {
    resetState();
    void fetchSnapshot({ refreshOpen: true });
    if (!unsubscribeSnapshot) {
      unsubscribeSnapshot = window.inviteOrderModule?.onInviteOrderSnapshot?.(applySnapshot) || null;
    }
  } else {
    loadToken += 1;
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
  }
});

onBeforeUnmount(() => {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }
});

function handleSearch() {
  void fetchSnapshot({ keyword: keyword.value, refreshOpen: true });
}

function handleSearchKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  handleSearch();
}

function handleGoodsItemClick(item) {
  if (loading.value || submitting.value) return;
  if (item.selected) return;
  const itemId = String(item?.itemId || '').trim();
  if (!itemId) return;
  window.inviteOrderModule?.openApiInviteOrderSpecModal?.({
    itemId,
    goodsId: item.goodsId || itemId,
    title: item.title || '',
    imageUrl: item.imageUrl || '',
    priceText: item.priceText || '',
  });
}

async function handleClear() {
  const mod = window.inviteOrderModule;
  if (!mod?.clearInviteOrderItems || !canClear.value) return;
  loading.value = true;
  try {
    const snapshot = await mod.clearInviteOrderItems();
    applySnapshot(snapshot);
    mod?.setApiHint?.('已清空邀请下单清单');
  } catch (error) {
    loading.value = false;
    mod?.setApiHint?.(error?.message || '清空邀请下单清单失败');
    mod?.showApiSideOrderToast?.(error?.message || '清空邀请下单清单失败');
  }
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleSubmit() {
  const mod = window.inviteOrderModule;
  if (!mod?.submitInviteOrder) return;
  submitting.value = true;
  try {
    const result = await mod.submitInviteOrder({
      selectedItems: selectedItems.value,
      selectedCount: selectedCount.value,
      totalText: totalText.value,
    });
    if (result?.success) handleClose();
  } finally {
    submitting.value = false;
  }
}

function quantityOf(item) {
  return Math.max(1, Number(item?.goodsNumber || item?.quantity || 1) || 1);
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="邀请消费者下单"
    width="900px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-api-io-toolbar">
      <div class="modal-api-io-toolbar-main">
        <div class="modal-api-io-toolbar-title">选择商品</div>
        <div class="modal-api-io-toolbar-note">将优先对齐嵌入页真实邀请下单能力</div>
      </div>
      <div class="modal-api-io-search">
        <el-input
          v-model="keyword"
          placeholder="请输入商品关键词"
          style="width: 220px;"
          @keydown="handleSearchKeydown"
        />
        <el-button :disabled="searchDisabled" @click="handleSearch">{{ searchText }}</el-button>
      </div>
    </div>

    <div class="modal-api-io-content">
      <div class="modal-api-io-panel">
        <div class="modal-api-io-panel-header">
          <span>店铺商品</span>
        </div>
        <div class="modal-api-io-list">
          <div v-if="loading && !goodsItems.length" class="modal-api-io-empty">正在读取邀请下单商品列表...</div>
          <div v-else-if="!goodsItems.length" class="modal-api-io-empty">{{ statusText || '暂未读取到店铺商品' }}</div>
          <div v-else>
            <div v-for="(item, index) in goodsItems" :key="item.itemId || `available:${index}`" class="modal-api-io-card">
              <div class="modal-api-io-media">
                <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.title || '商品主图'" />
                <span v-else>商品</span>
              </div>
              <div class="modal-api-io-info">
                <div class="modal-api-io-title">{{ item.title || '未命名商品' }}</div>
                <div class="modal-api-io-price">{{ item.priceText || '-' }}</div>
                <div v-if="item.metaText" class="modal-api-io-meta">{{ item.metaText }}</div>
              </div>
              <button
                type="button"
                class="modal-api-io-action"
                :class="{ 'is-selected': item.selected }"
                :disabled="item.selected"
                @click="handleGoodsItemClick(item)"
              >{{ item.selected ? '已加入' : (item.buttonText || '加入清单') }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-api-io-panel">
        <div class="modal-api-io-panel-header">
          <span>邀请下单的商品清单</span>
          <el-button text size="small" :disabled="clearDisabled" @click="handleClear">清空</el-button>
        </div>
        <div class="modal-api-io-list modal-api-io-selected-list">
          <div v-if="!selectedItems.length" class="modal-api-io-empty">未添加任何商品，请从左侧列表选择商品</div>
          <div v-else>
            <div v-for="(item, index) in selectedItems" :key="`selected-${index}`" class="modal-api-io-selected-item">
              <div class="modal-api-io-selected-media">
                <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.title || '已选商品'" />
                <span v-else>商品</span>
              </div>
              <div class="modal-api-io-selected-info">
                <div class="modal-api-io-selected-title">{{ item.title || item.text || '已选商品' }}</div>
                <div class="modal-api-io-selected-price">{{ item.priceText || '-' }}</div>
              </div>
              <div class="modal-api-io-selected-side">
                <span class="modal-api-io-selected-index">{{ index + 1 }}</span>
                <span class="modal-api-io-selected-qty">x{{ quantityOf(item) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-api-io-summary">
          <div class="modal-api-io-summary-meta">
            <span>已选 {{ selectedCount }} 件商品</span>
            <span class="modal-api-io-summary-sub">加入清单后可直接发送给买家</span>
          </div>
          <span class="modal-api-io-summary-total">合计：<strong>{{ totalText }}</strong></span>
        </div>
        <div class="modal-api-io-status">{{ statusText }}</div>
      </div>
    </div>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :disabled="submitDisabled" :loading="submitting" @click="handleSubmit">
        {{ submitText }}
      </el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-api-io-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}

.modal-api-io-toolbar-title {
  font-size: 14px;
  color: #303133;
  font-weight: 500;
}

.modal-api-io-toolbar-note {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.modal-api-io-search {
  display: flex;
  gap: 8px;
}

.modal-api-io-content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  height: 480px;
}

.modal-api-io-panel {
  display: flex;
  flex-direction: column;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}

.modal-api-io-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f5f7fa;
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  border-bottom: 1px solid #ebeef5;
}

.modal-api-io-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.modal-api-io-empty {
  padding: 32px 12px;
  text-align: center;
  color: #909399;
  font-size: 13px;
}

.modal-api-io-card {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #f0f2f5;
  align-items: center;
}

.modal-api-io-card:last-child {
  border-bottom: none;
}

.modal-api-io-media {
  width: 56px;
  height: 56px;
  border-radius: 4px;
  background: #f5f7fa;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.modal-api-io-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-io-media span {
  font-size: 11px;
  color: #909399;
}

.modal-api-io-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-api-io-title {
  font-size: 12px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.4;
}

.modal-api-io-price {
  font-size: 12px;
  color: #f56c6c;
  font-weight: 500;
}

.modal-api-io-meta {
  font-size: 11px;
  color: #909399;
}

.modal-api-io-action {
  flex-shrink: 0;
  padding: 4px 12px;
  background: #409eff;
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.modal-api-io-action:hover:not(:disabled) {
  background: #66b1ff;
}

.modal-api-io-action.is-selected,
.modal-api-io-action:disabled {
  background: #c0c4cc;
  cursor: not-allowed;
}

.modal-api-io-selected-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #f0f2f5;
  align-items: center;
}

.modal-api-io-selected-item:last-child {
  border-bottom: none;
}

.modal-api-io-selected-media {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  background: #f5f7fa;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.modal-api-io-selected-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-api-io-selected-media span {
  font-size: 11px;
  color: #909399;
}

.modal-api-io-selected-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-api-io-selected-title {
  font-size: 12px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.4;
}

.modal-api-io-selected-price {
  font-size: 12px;
  color: #f56c6c;
  font-weight: 500;
}

.modal-api-io-selected-side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.modal-api-io-selected-index {
  font-size: 11px;
  color: #909399;
}

.modal-api-io-selected-qty {
  font-size: 12px;
  color: #303133;
}

.modal-api-io-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #fafbfc;
  border-top: 1px solid #ebeef5;
  font-size: 12px;
  color: #303133;
}

.modal-api-io-summary-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-api-io-summary-sub {
  font-size: 11px;
  color: #909399;
}

.modal-api-io-summary-total strong {
  color: #f56c6c;
  font-size: 14px;
  font-weight: 600;
}

.modal-api-io-status {
  padding: 6px 12px;
  background: #f5f7fa;
  font-size: 12px;
  color: #606266;
  border-top: 1px solid #ebeef5;
  text-align: center;
}
</style>
