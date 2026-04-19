<script setup>
// QA 规则编辑 Modal（迁移自 qa-module.js + index.html#modalQA）
//
// payload: {
//   mode: 'add' | 'edit' | 'prefill',
//   ruleId: string|null,
//   title: string,
//   shops: [{ id, name, category }],
//   form: { matchType, keywords, reply, priority, enabled, products, shopAll, selectedShopIds }
// }
//
// 业务回流：window.qaModule.saveQAFromForm(form) / window.qaModule.collectReplySegments(text)
// 关闭由 saveQAFromForm 内部调用 vueBridge.closeModal 完成。

import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import AppModal from '../components/AppModal.vue';

const SHOP_CATEGORIES = [
  '水果生鲜', '美容个护', '家居生活', '服饰箱包', '母婴玩具',
  '食品保健', '虚拟商品', '运动户外', '数码电器', '家纺家具家装', '汽配摩托',
];

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const title = ref('添加QA场景');
const shops = ref([]);
const form = ref({
  matchType: 'contains',
  keywords: '',
  reply: '',
  priority: 50,
  enabled: 'true',
  products: '',
});
const shopAll = ref(true);
const selectedShopIds = ref(new Set());
const shopCategory = ref('');
const saving = ref(false);
const replyTextarea = useTemplateRef('replyTextarea');

const replySegments = computed(() => {
  const fn = window.qaModule?.collectReplySegments;
  if (typeof fn !== 'function') return [];
  return fn(form.value.reply);
});

const showReplyPreview = computed(() => String(form.value.reply || '').trim().length > 0);
const replyPreviewSummary = computed(() => {
  const count = replySegments.value.length;
  if (count > 1) {
    return `预览拆分结果：当前会识别为 ${count} 段回复，命中后随机发送其中一条。`;
  }
  return '预览拆分结果：当前仅识别为 1 段回复；如需随机回复，请点击"插入分栏"后再填写下一段内容。';
});

const allShopChecked = computed(() => {
  if (shops.value.length === 0) return false;
  return shops.value.every(shop => selectedShopIds.value.has(shop.id));
});

watch(() => props.visible, (val) => {
  if (val) hydrateFromPayload();
});

function hydrateFromPayload() {
  const payload = props.payload || {};
  const f = payload.form || {};
  title.value = payload.title || '添加QA场景';
  shops.value = Array.isArray(payload.shops) ? payload.shops : [];
  form.value = {
    matchType: f.matchType || 'contains',
    keywords: f.keywords || '',
    reply: f.reply || '',
    priority: typeof f.priority === 'number' ? f.priority : 50,
    enabled: f.enabled === false ? 'false' : (f.enabled || 'true'),
    products: f.products || '',
  };
  shopCategory.value = '';
  shopAll.value = !!f.shopAll;
  if (shopAll.value) {
    selectedShopIds.value = new Set(shops.value.map(shop => shop.id));
  } else {
    selectedShopIds.value = new Set(Array.isArray(f.selectedShopIds) ? f.selectedShopIds : []);
  }
  saving.value = false;
}

function toggleShopAll(checked) {
  shopAll.value = !!checked;
  shopCategory.value = '';
  if (shopAll.value) {
    selectedShopIds.value = new Set(shops.value.map(shop => shop.id));
  } else {
    selectedShopIds.value = new Set();
  }
}

function toggleShop(shopId, checked) {
  const next = new Set(selectedShopIds.value);
  if (checked) next.add(shopId);
  else next.delete(shopId);
  selectedShopIds.value = next;
  shopAll.value = next.size > 0 && next.size === shops.value.length;
}

function applyCategoryFilter() {
  const category = String(shopCategory.value || '').trim();
  if (!category) return;
  shopAll.value = false;
  const next = new Set();
  let matched = 0;
  shops.value.forEach(shop => {
    if (String(shop?.category || '').trim() === category) {
      next.add(shop.id);
      matched += 1;
    }
  });
  selectedShopIds.value = next;
  if (matched === 0 && typeof window.qaToast === 'function') {
    window.qaToast('该类目下暂无店铺');
  }
}

async function insertAtCursor(insertText, selectionDelta) {
  const textarea = replyTextarea.value;
  if (!textarea) return;
  const start = textarea.selectionStart ?? form.value.reply.length;
  const end = textarea.selectionEnd ?? start;
  const original = form.value.reply;
  const next = original.slice(0, start) + insertText + original.slice(end);
  form.value.reply = next;
  await nextTick();
  textarea.focus();
  const cursor = selectionDelta || { selectionStart: start + insertText.length, selectionEnd: start + insertText.length };
  textarea.setSelectionRange(cursor.selectionStart, cursor.selectionEnd);
}

function handleInsertImage() {
  const insert = '[img:https://example.com/image.jpg]';
  const start = replyTextarea.value?.selectionStart ?? form.value.reply.length;
  void insertAtCursor(insert, {
    selectionStart: start + 5,
    selectionEnd: start + insert.length - 1,
  });
}

function handleInsertDivider() {
  const insert = '\n\n---\n\n';
  void insertAtCursor(insert);
}

function handleInsertVar() {
  const insert = '{time}';
  const start = replyTextarea.value?.selectionStart ?? form.value.reply.length;
  void insertAtCursor(insert, {
    selectionStart: start,
    selectionEnd: start + insert.length,
  });
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleSave() {
  if (saving.value) return;
  const mod = window.qaModule;
  if (!mod?.saveQAFromForm) return;
  saving.value = true;
  try {
    const result = await mod.saveQAFromForm({
      matchType: form.value.matchType,
      keywords: form.value.keywords,
      reply: form.value.reply,
      priority: form.value.priority,
      enabled: form.value.enabled,
      products: form.value.products,
      shopAll: shopAll.value,
      selectedShopIds: Array.from(selectedShopIds.value),
    });
    if (result && result.ok === false) {
      if (typeof window.qaToast === 'function') {
        window.qaToast(result.message || '保存失败');
      } else {
        // eslint-disable-next-line no-alert
        alert(result.message || '保存失败');
      }
    }
  } finally {
    saving.value = false;
  }
}

function handleTutorial() {
  // eslint-disable-next-line no-alert
  alert('教程页面开发中，敬请期待');
}
</script>

<template>
  <AppModal
    :visible="visible"
    :title="title"
    width="780px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <template #header>
      <div class="modal-qa-header">
        <h3 class="modal-qa-title">{{ title }}</h3>
        <a class="modal-qa-tutorial" @click="handleTutorial">查看教程</a>
      </div>
    </template>

    <div class="modal-qa-top-row">
      <div class="modal-qa-col modal-qa-col-left">
        <div class="modal-qa-field">
          <label class="modal-qa-label">指定商品（可选）</label>
          <input
            v-model="form.products"
            class="modal-qa-input"
            placeholder="输入商品ID，多个用逗号分隔，留空则不限商品"
          />
          <div class="modal-qa-hint">仅当客户咨询指定商品时触发此规则</div>
        </div>

        <div class="modal-qa-field">
          <label class="modal-qa-label">匹配类型</label>
          <select v-model="form.matchType" class="modal-qa-select">
            <option value="contains">包含关键词</option>
            <option value="exact">完全匹配</option>
            <option value="regex">正则匹配</option>
          </select>
        </div>

        <div class="modal-qa-field">
          <label class="modal-qa-label">触发关键词（每行一个，多个关键词组词 &amp; 连接）</label>
          <textarea
            v-model="form.keywords"
            class="modal-qa-textarea"
            placeholder="你好&#10;在吗&#10;有人吗"
            rows="6"
          ></textarea>
        </div>

        <div class="modal-qa-row">
          <div class="modal-qa-row-col">
            <label class="modal-qa-label">优先级</label>
            <input
              v-model.number="form.priority"
              type="number"
              class="modal-qa-input"
              min="0"
              max="999"
            />
            <div class="modal-qa-hint">数字越大优先级越高</div>
          </div>
          <div class="modal-qa-row-col">
            <label class="modal-qa-label">状态</label>
            <select v-model="form.enabled" class="modal-qa-select">
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          </div>
        </div>
      </div>

      <div class="modal-qa-col modal-qa-col-right">
        <div class="modal-qa-shop-panel">
          <div class="modal-qa-shop-toolbar">
            <label class="modal-qa-shop-all">
              <input
                type="checkbox"
                :checked="shopAll"
                @change="(e) => toggleShopAll(e.target.checked)"
              />
              应用到全部店铺
            </label>
            <select
              v-model="shopCategory"
              class="modal-qa-select modal-qa-shop-category"
              @change="applyCategoryFilter"
            >
              <option value="">选择类目</option>
              <option v-for="cat in SHOP_CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
            </select>
          </div>
          <div class="modal-qa-shop-list">
            <label
              v-for="shop in shops"
              :key="shop.id"
              class="modal-qa-shop-item"
            >
              <input
                type="checkbox"
                :checked="selectedShopIds.has(shop.id)"
                @change="(e) => toggleShop(shop.id, e.target.checked)"
              />
              <span class="modal-qa-shop-name">{{ shop.name }}</span>
            </label>
            <div v-if="shops.length === 0" class="modal-qa-shop-empty">暂无店铺</div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-qa-field">
      <label class="modal-qa-label">回复内容</label>
      <div class="modal-qa-reply-toolbar">
        <button type="button" class="modal-qa-reply-btn" title="插入图片占位符" @click="handleInsertImage">插入图片</button>
        <button type="button" class="modal-qa-reply-btn" title="插入分栏分隔符" @click="handleInsertDivider">插入分栏</button>
        <button type="button" class="modal-qa-reply-btn" title="插入变量" @click="handleInsertVar">插入变量</button>
      </div>
      <textarea
        ref="replyTextarea"
        v-model="form.reply"
        class="modal-qa-textarea modal-qa-reply"
        placeholder="输入回复话术，支持变量：{time} {date}"
      ></textarea>
      <div class="modal-qa-hint">
        支持变量: {time} 当前时间、{date} 当前日期 | 图片: [img:URL] | 每段回复之间可点击"插入分栏"，命中后随机发送其中一条
      </div>
      <div v-if="showReplyPreview" class="modal-qa-reply-preview">
        <div class="modal-qa-reply-preview-title">{{ replyPreviewSummary }}</div>
        <div class="modal-qa-reply-preview-list">
          <div
            v-for="(segment, index) in replySegments"
            :key="index"
            class="modal-qa-reply-preview-item"
          >
            <div class="modal-qa-reply-preview-label">回复 {{ index + 1 }}</div>
            <div class="modal-qa-reply-preview-text">{{ segment }}</div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-qa-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.modal-qa-title {
  margin: 0;
  font-size: 16px;
  color: #303133;
  font-weight: 500;
}

.modal-qa-tutorial {
  font-size: 12px;
  color: #409eff;
  cursor: pointer;
  text-decoration: none;
}

.modal-qa-tutorial:hover {
  text-decoration: underline;
}

.modal-qa-top-row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.modal-qa-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-qa-col-left {
  flex: 1.4;
  min-width: 0;
}

.modal-qa-col-right {
  flex: 1;
  min-width: 0;
}

.modal-qa-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.modal-qa-row {
  display: flex;
  gap: 16px;
}

.modal-qa-row-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-qa-label {
  font-size: 13px;
  color: #303133;
  font-weight: 500;
}

.modal-qa-input,
.modal-qa-select {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  font-size: 13px;
  color: #303133;
  background: #fff;
  outline: none;
  box-sizing: border-box;
}

.modal-qa-input:focus,
.modal-qa-select:focus,
.modal-qa-textarea:focus {
  border-color: #409eff;
}

.modal-qa-textarea {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  font-size: 13px;
  color: #303133;
  background: #fff;
  outline: none;
  box-sizing: border-box;
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
}

.modal-qa-textarea.modal-qa-reply {
  min-height: 120px;
}

.modal-qa-hint {
  font-size: 12px;
  color: #909399;
}

.modal-qa-shop-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #fafbfc;
  height: 100%;
  min-height: 280px;
}

.modal-qa-shop-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.modal-qa-shop-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #303133;
  margin: 0;
  white-space: nowrap;
  cursor: pointer;
}

.modal-qa-shop-category {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
}

.modal-qa-shop-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  min-height: 200px;
}

.modal-qa-shop-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 13px;
  color: #303133;
  cursor: pointer;
  border-radius: 3px;
}

.modal-qa-shop-item:hover {
  background: #f5f7fa;
}

.modal-qa-shop-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-qa-shop-empty {
  padding: 12px;
  text-align: center;
  color: #909399;
  font-size: 12px;
}

.modal-qa-reply-toolbar {
  display: flex;
  gap: 6px;
}

.modal-qa-reply-btn {
  padding: 4px 10px;
  font-size: 12px;
  background: #f5f7fa;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  color: #606266;
  cursor: pointer;
}

.modal-qa-reply-btn:hover {
  background: #ecf5ff;
  color: #409eff;
  border-color: #c6e2ff;
}

.modal-qa-reply-preview {
  margin-top: 6px;
  padding: 10px 12px;
  background: #f4f9ff;
  border: 1px dashed #91caff;
  border-radius: 4px;
}

.modal-qa-reply-preview-title {
  font-size: 12px;
  color: #1d6dc7;
  margin-bottom: 6px;
}

.modal-qa-reply-preview-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-qa-reply-preview-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 8px;
  background: #fff;
  border-radius: 4px;
}

.modal-qa-reply-preview-label {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
  min-width: 44px;
}

.modal-qa-reply-preview-text {
  font-size: 12px;
  color: #303133;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  flex: 1;
}
</style>
