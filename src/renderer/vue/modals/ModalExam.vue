<script setup>
// 客服规则考试 Modal（迁移自 index.html#modalExam）
//
// 流程：
// 1. 打开 → window.shopsModule.loadExamQuestions() 拉题目
// 2. 用户单选答案，进度条按已答题数实时更新
// 3. 提交 → 未答完 confirm 二次确认 → window.shopsModule.submitExam(answers) → 显示得分卡 + 答案对错高亮
// 4. 重新考试 → 清空作答态，回到答题状态

import { computed, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import AppModal from '../components/AppModal.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  payload: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:visible', 'close']);

const questions = ref([]);
const answers = ref({});
const loading = ref(false);
const submitting = ref(false);
const submitted = ref(false);
const scoreResult = ref(null);

const total = computed(() => questions.value.length);
const answered = computed(() => Object.keys(answers.value).length);
const progressPercent = computed(() => total.value ? (answered.value / total.value) * 100 : 0);

watch(() => props.visible, async (val) => {
  if (val) {
    answers.value = {};
    submitted.value = false;
    scoreResult.value = null;
    questions.value = [];
    loading.value = true;
    try {
      const list = await window.shopsModule?.loadExamQuestions?.();
      questions.value = Array.isArray(list) ? list : [];
    } finally {
      loading.value = false;
    }
  }
});

function typeLabel(question) {
  return question?.type === 'judge' ? '判断题' : '单选题';
}

function selectOption(qid, oi) {
  if (submitted.value) return;
  answers.value = { ...answers.value, [qid]: oi };
}

function isSelected(qid, oi) {
  return answers.value[qid] === oi;
}

function optionStateClass(question, oi) {
  if (!submitted.value) {
    return isSelected(question.id, oi) ? 'is-selected' : '';
  }
  if (oi === question.answer) return 'is-correct';
  if (answers.value[question.id] === oi) return 'is-wrong';
  return '';
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function handleSubmit() {
  if (submitting.value || submitted.value) return;
  if (answered.value < total.value) {
    try {
      await ElMessageBox.confirm(
        `还有 ${total.value - answered.value} 题未作答，确定提交？`,
        '提示',
        { confirmButtonText: '确定提交', cancelButtonText: '继续作答', type: 'warning' },
      );
    } catch {
      return;
    }
  }
  submitting.value = true;
  try {
    const result = await window.shopsModule?.submitExam?.(answers.value);
    if (result && typeof result === 'object') {
      scoreResult.value = result;
      submitted.value = true;
    }
  } finally {
    submitting.value = false;
  }
}

function handleRetake() {
  answers.value = {};
  submitted.value = false;
  scoreResult.value = null;
}
</script>

<template>
  <AppModal
    :visible="visible"
    title="客服规则考试"
    width="720px"
    @update:visible="(val) => emit('update:visible', val)"
    @close="emit('close')"
  >
    <template #header>
      <div class="modal-exam-header">
        <span class="modal-exam-header-title">客服规则考试</span>
        <div class="modal-exam-progress">
          <span class="modal-exam-progress-text">{{ answered }}/{{ total }}</span>
          <div class="modal-exam-progress-bar">
            <div class="modal-exam-progress-fill" :style="{ width: `${progressPercent}%` }"></div>
          </div>
        </div>
      </div>
    </template>

    <div v-if="loading" class="modal-exam-loading">正在加载题目...</div>
    <div v-else-if="!questions.length" class="modal-exam-empty">暂无可用题目</div>

    <div v-else class="modal-exam-body">
      <div v-if="scoreResult" class="modal-exam-score">
        <div class="modal-exam-score-num">{{ scoreResult.score }}</div>
        <div class="modal-exam-score-label">考试得分</div>
        <div class="modal-exam-score-detail">共 {{ scoreResult.total }} 题，答对 {{ scoreResult.correct }} 题</div>
      </div>

      <div
        v-for="(question, index) in questions"
        :key="question.id"
        class="modal-exam-question"
      >
        <div class="modal-exam-question-title">
          <span class="modal-exam-q-num">{{ index + 1 }}</span>
          <span>{{ question.question }}</span>
          <span class="modal-exam-q-type">[{{ typeLabel(question) }}]</span>
        </div>
        <div class="modal-exam-options">
          <label
            v-for="(option, oi) in question.options"
            :key="oi"
            class="modal-exam-option"
            :class="[optionStateClass(question, oi), { 'is-locked': submitted }]"
            @click="selectOption(question.id, oi)"
          >
            <input
              type="radio"
              :name="`exam_${question.id}`"
              :value="oi"
              :checked="isSelected(question.id, oi)"
              :disabled="submitted"
              @change="selectOption(question.id, oi)"
            />
            <span>{{ option }}</span>
          </label>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button
        v-if="!submitted"
        type="primary"
        :loading="submitting"
        :disabled="loading || !questions.length"
        @click="handleSubmit"
      >提交答卷</el-button>
      <el-button v-else type="primary" @click="handleRetake">重新考试</el-button>
    </template>
  </AppModal>
</template>

<style>
.modal-exam-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.modal-exam-header-title {
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

.modal-exam-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 12px;
}

.modal-exam-progress-text {
  font-size: 12px;
  color: #606266;
  min-width: 36px;
  text-align: right;
}

.modal-exam-progress-bar {
  width: 120px;
  height: 6px;
  background: #ebeef5;
  border-radius: 3px;
  overflow: hidden;
}

.modal-exam-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #67c23a, #409eff);
  transition: width 0.2s;
}

.modal-exam-loading,
.modal-exam-empty {
  padding: 48px 16px;
  text-align: center;
  color: #909399;
  font-size: 13px;
}

.modal-exam-body {
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 4px;
}

.modal-exam-score {
  margin-bottom: 16px;
  padding: 20px;
  text-align: center;
  background: linear-gradient(135deg, #ecf5ff, #f0f9eb);
  border-radius: 6px;
}

.modal-exam-score-num {
  font-size: 36px;
  font-weight: 600;
  color: #409eff;
  line-height: 1.2;
}

.modal-exam-score-label {
  font-size: 13px;
  color: #606266;
  margin-top: 4px;
}

.modal-exam-score-detail {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.modal-exam-question {
  margin-bottom: 16px;
  padding: 12px;
  background: #fafbfc;
  border: 1px solid #ebeef5;
  border-radius: 6px;
}

.modal-exam-question-title {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: #303133;
  font-weight: 500;
  margin-bottom: 12px;
  line-height: 1.6;
}

.modal-exam-q-num {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  background: #409eff;
  color: #fff;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.modal-exam-q-type {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
  font-weight: normal;
}

.modal-exam-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-exam-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #303133;
  transition: all 0.2s;
}

.modal-exam-option:hover:not(.is-locked) {
  border-color: #409eff;
  background: #ecf5ff;
}

.modal-exam-option.is-selected {
  border-color: #409eff;
  background: #ecf5ff;
  color: #409eff;
}

.modal-exam-option.is-correct {
  border-color: #67c23a;
  background: #f0f9eb;
  color: #67c23a;
}

.modal-exam-option.is-wrong {
  border-color: #f56c6c;
  background: #fef0f0;
  color: #f56c6c;
}

.modal-exam-option.is-locked {
  cursor: default;
}

.modal-exam-option input {
  margin: 0;
}
</style>
