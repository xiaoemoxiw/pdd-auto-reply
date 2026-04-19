<script setup>
// 商品规格 Modal（迁移自 chat-api/modules/goods-spec-modal.js + index.html#modalApiGoodsSpec）
//
// 接入方式：
// - 原 window.openApiGoodsSpecModal(card) / closeApiGoodsSpecModal() 被改造成 vueBridge.openModal/closeModal 的薄 shim；
// - 异步加载、loading/error/empty 三态、requestKey 取消机制都搬进 SFC；
// - 与主模块共享上下文仍走 window.__chatApiModuleAccess / window.__chatApiModuleHelpers，
//   保持 normalizeApiGoodsCard / normalizeApiGoodsSpecItems / buildApiGoodsSpecFallbackItems
//   等工具函数的复用，避免重复实现导致行为漂移。

import { computed, ref, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const card = ref({});
const specItems = ref([]);
const loading = ref(false);
const errorText = ref('');
const requestKey = ref('');

function chatApiAccess() {
  return window.__chatApiModuleAccess || {};
}

function chatApiHelpers() {
  return window.__chatApiModuleHelpers || {};
}

function normalizeCard(input, fallback) {
  const fn = chatApiHelpers().normalizeApiGoodsCard;
  return typeof fn === 'function' ? fn(input, fallback) : (input || fallback || {});
}

function normalizeSpecItems(items) {
  const fn = chatApiHelpers().normalizeApiGoodsSpecItems;
  if (typeof fn === 'function') return fn(items);
  return Array.isArray(items) ? items : [];
}

function buildFallbackItems(c) {
  const fn = chatApiHelpers().buildApiGoodsSpecFallbackItems;
  return typeof fn === 'function' ? fn(c) : [];
}

function showToast(text) {
  const fn = chatApiHelpers().showApiSideOrderToast;
  if (typeof fn === 'function') fn(text);
}

const metaParts = computed(() => {
  const c = card.value || {};
  return [
    c.stockText ? `库存 ${c.stockText}` : '',
    c.salesText ? `销量 ${c.salesText}` : '',
    c.pendingGroupText ? `待成团 ${c.pendingGroupText}` : '',
  ].filter(Boolean);
});

const showTable = computed(() => !loading.value && !errorText.value && specItems.value.length > 0);
const showEmpty = computed(() => !loading.value && !errorText.value && specItems.value.length === 0);

async function loadGoodsSpec(initialCard) {
  const access = chatApiAccess();
  const state = typeof access.getState === 'function' ? (access.getState() || {}) : {};
  const activeSession = typeof access.getApiActiveSession === 'function' ? access.getApiActiveSession() : null;
  const key = requestKey.value;

  if (!window.pddApi?.apiGetGoodsCard) {
    if (requestKey.value !== key) return;
    loading.value = false;
    errorText.value = '当前环境不支持加载商品规格';
    return;
  }

  try {
    const result = await window.pddApi.apiGetGoodsCard({
      shopId: state.apiActiveSessionShopId,
      url: initialCard.url,
      goodsId: initialCard.goodsId,
      session: activeSession,
      fallback: {
        goodsId: initialCard.goodsId,
        url: initialCard.url,
        title: initialCard.title,
        imageUrl: initialCard.imageUrl,
        priceText: initialCard.priceText,
        groupText: initialCard.groupText,
        specText: initialCard.specText,
        stockText: initialCard.stockText,
        salesText: initialCard.salesText,
        pendingGroupText: initialCard.pendingGroupText,
      },
    });
    if (requestKey.value !== key) return;
    if (result?.error) throw new Error(result.error);
    const normalized = normalizeCard({ ...result, cacheKey: initialCard.cacheKey }, initialCard);
    loading.value = false;
    errorText.value = '';
    card.value = normalized;
    specItems.value = normalized.specItems?.length ? normalized.specItems : buildFallbackItems(normalized);
    if (normalized.cacheKey && state.apiGoodsCardCache?.set) {
      state.apiGoodsCardCache.set(normalized.cacheKey, normalized);
    }
  } catch (err) {
    if (requestKey.value !== key) return;
    loading.value = false;
    errorText.value = err?.message || '加载商品规格失败';
    specItems.value = buildFallbackItems(initialCard);
  }
}

watch(
  () => props.visible,
  (val) => {
    if (!val) {
      requestKey.value = '';
      loading.value = false;
      return;
    }
    const inputCard = props.payload?.card || {};
    const normalized = normalizeCard(inputCard, inputCard);
    requestKey.value = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    errorText.value = '';
    card.value = normalized;
    const items = normalizeSpecItems(normalized.specItems);
    specItems.value = items.length ? items : buildFallbackItems(normalized);
    loading.value = items.length === 0;
    if (loading.value) {
      void loadGoodsSpec(normalized);
    }
  },
  { immediate: true }
);

async function handleCopyGoodsId() {
  const goodsId = String(card.value?.goodsId || '');
  if (!goodsId) return;
  try {
    await navigator.clipboard.writeText(goodsId);
    showToast('已复制到剪切板！');
  } catch {
    showToast('复制失败，请稍后重试');
  }
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}
</script>

<template>
  <AppModal
    :visible="visible"
    width="640px"
    hide-header
    :show-footer="true"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <div class="modal-api-goods-spec">
      <div class="modal-api-goods-spec-product">
        <img
          v-if="card.imageUrl"
          class="modal-api-goods-spec-product-image"
          :src="card.imageUrl"
          :alt="card.title || '商品主图'"
        />
        <div v-else class="modal-api-goods-spec-product-image placeholder">商品</div>
        <div class="modal-api-goods-spec-product-main">
          <div class="modal-api-goods-spec-product-id-row">
            <div class="modal-api-goods-spec-product-id">
              {{ card.goodsId ? `商品ID：${card.goodsId}` : '拼多多商品' }}
            </div>
            <button
              v-if="card.goodsId"
              class="modal-api-goods-spec-copy"
              type="button"
              @click="handleCopyGoodsId"
            >复制</button>
          </div>
          <div class="modal-api-goods-spec-product-title">{{ card.title || '拼多多商品' }}</div>
          <div v-if="metaParts.length" class="modal-api-goods-spec-product-meta">
            <span v-for="(item, idx) in metaParts" :key="idx">{{ item }}</span>
          </div>
        </div>
      </div>

      <div v-if="loading" class="modal-api-goods-spec-loading">正在加载商品规格...</div>
      <div v-else-if="errorText" class="modal-api-goods-spec-error">{{ errorText }}</div>
      <div v-else-if="showEmpty" class="modal-api-goods-spec-empty">暂未解析到可展示的商品规格</div>

      <div v-show="showTable" class="modal-api-goods-spec-table-wrap">
        <el-table :data="specItems" size="small" stripe border>
          <el-table-column prop="specLabel" label="规格" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.specLabel || '--' }}</template>
          </el-table-column>
          <el-table-column prop="styleLabel" label="款式" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.styleLabel || '--' }}</template>
          </el-table-column>
          <el-table-column prop="priceText" label="价格" width="100">
            <template #default="{ row }">{{ row.priceText || '--' }}</template>
          </el-table-column>
          <el-table-column prop="stockText" label="库存" width="100">
            <template #default="{ row }">{{ row.stockText || '--' }}</template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <template #footer>
      <el-button type="primary" @click="handleClose">我知道了</el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-api-goods-spec {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-api-goods-spec-product {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 6px;
}

.modal-api-goods-spec-product-image {
  width: 72px;
  height: 72px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  background: #fff;
}

.modal-api-goods-spec-product-image.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #909399;
  background: #ebeef5;
}

.modal-api-goods-spec-product-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-api-goods-spec-product-id-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-api-goods-spec-product-id {
  font-size: 12px;
  color: #606266;
}

.modal-api-goods-spec-copy {
  border: 1px solid #dcdfe6;
  background: #fff;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
  color: #606266;
  cursor: pointer;
  line-height: 1.4;
}

.modal-api-goods-spec-copy:hover {
  border-color: #409eff;
  color: #409eff;
}

.modal-api-goods-spec-product-title {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  word-break: break-all;
}

.modal-api-goods-spec-product-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #909399;
}

.modal-api-goods-spec-loading,
.modal-api-goods-spec-error,
.modal-api-goods-spec-empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  border-radius: 6px;
}

.modal-api-goods-spec-loading {
  color: #909399;
  background: #f5f7fa;
}

.modal-api-goods-spec-error {
  color: #f56c6c;
  background: #fef0f0;
}

.modal-api-goods-spec-empty {
  color: #909399;
  background: #f5f7fa;
}
</style>
