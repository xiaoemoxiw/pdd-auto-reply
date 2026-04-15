(function () {
  const MODAL_ID = 'modalOpsAfterSaleRejectRefund';
  const DEFAULT_WORDS = '亲，很抱歉给您带来了不好的购物体验～ 我们想与您协商“退货退款”，您看可以吗～';
  const SECOND_REJECT_DEFAULT_WORDS = '亲~ 我们已经仔细了解了您的问题。如果您收到的商品有问题，我们愿意根据实际情况补偿您的损失~ 您看看能不能再协商下退款金额呢？';

  let mounted = false;
  let state = {
    context: null,
    loading: false,
    submitting: false,
    error: '',
    formName: '',
    formId: 'form1',
    flowType: 'step1',
    refundableAmount: 0,
    words: DEFAULT_WORDS,
    solutionOptions: [],
    selectedSolutionCodes: ['return_refund'],
    partialRefundAmount: '',
    reasonOptions: [],
    selectedReasonCode: '',
    selectedReasonDesc: '',
    handlingSuggestions: [],
    requiredRejectDescs: [],
    requiredProofs: [],
    customRejectDesc: '',
    imageUrlsText: '',
  };

  function getEl(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function closeDialog() {
    if (state.submitting) return;
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    overlay.classList.remove('visible');
  }

  function setLoading(next) {
    state.loading = !!next;
    syncView();
  }

  function setSubmitting(next) {
    state.submitting = !!next;
    syncView();
  }

  function formatMoneyYuanFromFen(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return '';
    return (amount / 100).toFixed(2);
  }

  function formatRemainSeconds(value) {
    const seconds = Number(value || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} 分钟`;
  }

  function hasPartialRefund() {
    return state.selectedSolutionCodes.includes('partial_refund');
  }

  function parseImageUrls(text) {
    return String(text || '')
      .split(/\r?\n|,/)
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }

  function normalizeReasonOptions(result = []) {
    return (Array.isArray(result) ? result : [])
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        code: String(item.rejectReasonCode ?? '').trim(),
        desc: String(item.rejectReasonDesc || '').trim(),
        rejectChatTip: String(item.rejectChatTip || '').trim(),
        pushEvidenceTips: String(item.pushEvidenceTips || '').trim(),
        mustPushEvidence: !!item.mustPushEvidence,
        requiredProofs: Array.isArray(item.requiredProofs) ? item.requiredProofs : [],
        requiredRejectDescs: Array.isArray(item.requiredRejectDescs) ? item.requiredRejectDescs : [],
        handlingSuggestions: Array.isArray(item.handlingSuggestions) ? item.handlingSuggestions : [],
      }))
      .filter(item => item.code && item.desc);
  }

  function getCurrentReasonOption() {
    return state.reasonOptions.find(item => item.code === String(state.selectedReasonCode || '').trim()) || null;
  }

  function extractRecommendWords(schema = []) {
    const queue = Array.isArray(schema) ? [...schema] : [];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      const formItemProperties = node.formItemProperties && typeof node.formItemProperties === 'object'
        ? node.formItemProperties
        : null;
      const recommendWords = Array.isArray(formItemProperties?.recommandWords)
        ? formItemProperties.recommandWords
        : [];
      const first = recommendWords.find(item => String(item?.value || '').trim());
      if (first) return String(first.value || '').trim();
      if (Array.isArray(node.children) && node.children.length) {
        queue.push(...node.children);
      }
    }
    return '';
  }

  function buildSelectedSolutionItems() {
    const selected = state.solutionOptions.filter(item => state.selectedSolutionCodes.includes(item.code));
    return selected.map(item => ({
      value: item.code,
      valueLabel: item.desc || item.text || item.code,
    }));
  }

  function normalizeSolutionOptions(result = {}) {
    const list = Array.isArray(result?.negotiateSolutionList) ? result.negotiateSolutionList : [];
    return list
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        code: String(item.code || '').trim(),
        text: String(item.text || '').trim(),
        desc: String(item.desc || '').trim(),
        extraMods: Array.isArray(item.extraMods) ? item.extraMods.map(String) : [],
      }))
      .filter(item => item.code);
  }

  async function loadStep3ReasonRequirements(shopId, instanceId, orderSn, reasonCode) {
    if (!reasonCode) {
      state.selectedReasonCode = '';
      state.selectedReasonDesc = '';
      state.handlingSuggestions = [];
      state.requiredRejectDescs = [];
      state.requiredProofs = [];
      return;
    }
    const reasonResp = await window.pddApi.aftersaleRejectRefundGetReasons({
      shopId,
      afterSalesId: instanceId,
      orderSn,
      rejectPopupWindowType: 2,
      withRejectRequirements: true,
      rejectReasonCode: Number(reasonCode),
    });
    if (reasonResp?.error) throw new Error(reasonResp.error);
    const current = normalizeReasonOptions(reasonResp?.result || [])[0] || null;
    const fallback = state.reasonOptions.find(item => item.code === String(reasonCode)) || null;
    const next = current || fallback;
    state.selectedReasonCode = String(reasonCode);
    state.selectedReasonDesc = String(next?.desc || '');
    state.requiredRejectDescs = Array.isArray(next?.requiredRejectDescs) ? next.requiredRejectDescs : [];
    state.requiredProofs = Array.isArray(next?.requiredProofs) ? next.requiredProofs : [];
    state.handlingSuggestions = Array.isArray(next?.handlingSuggestions) ? next.handlingSuggestions : [];
  }

  function buildSolutionsHtml() {
    if (!state.solutionOptions.length) {
      return '<div class="ops-aftersale-reject-empty">暂无可用协商方案</div>';
    }
    return state.solutionOptions.map(item => {
      const checked = state.selectedSolutionCodes.includes(item.code);
      const helpText = item.desc || item.text || item.code;
      return `
        <label class="ops-aftersale-reject-solution${checked ? ' is-active' : ''}">
          <input
            type="checkbox"
            value="${escapeHtml(item.code)}"
            ${checked ? 'checked' : ''}
            ${state.loading || state.submitting ? 'disabled' : ''}
            data-ops-aftersale-reject-solution="1"
          />
          <span class="ops-aftersale-reject-solution-text">${escapeHtml(helpText)}</span>
        </label>
      `;
    }).join('');
  }

  function syncView() {
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    const statusEl = getEl('opsAftersaleRejectRefundStatus');
    const errorEl = getEl('opsAftersaleRejectRefundError');
    const solutionsEl = getEl('opsAftersaleRejectRefundSolutions');
    const solutionsGroupEl = getEl('opsAftersaleRejectRefundSolutionsGroup');
    const wordsEl = getEl('opsAftersaleRejectRefundWords');
    const amountRowEl = getEl('opsAftersaleRejectRefundAmountRow');
    const amountEl = getEl('opsAftersaleRejectRefundAmount');
    const submitBtn = getEl('btnOpsAftersaleRejectRefundSubmit');
    const amountHintEl = getEl('opsAftersaleRejectRefundAmountHint');
    const tipEl = getEl('opsAftersaleRejectRefundTip');
    const titleEl = getEl('opsAftersaleRejectRefundTitle');
    const step3ReasonGroupEl = getEl('opsAftersaleRejectRefundStep3ReasonGroup');
    const step3DescGroupEl = getEl('opsAftersaleRejectRefundStep3DescGroup');
    const step3ProofGroupEl = getEl('opsAftersaleRejectRefundStep3ProofGroup');
    const wordsGroupEl = getEl('opsAftersaleRejectRefundWordsGroup');
    const step3ReasonSelectEl = getEl('opsAftersaleRejectRefundReasonSelect');
    const step3DescHintEl = getEl('opsAftersaleRejectRefundDescHint');
    const step3ProofHintEl = getEl('opsAftersaleRejectRefundProofHint');
    const step3DescEl = getEl('opsAftersaleRejectRefundStep3Desc');
    const step3ImageUrlsEl = getEl('opsAftersaleRejectRefundImageUrls');
    const step3SuggestionEl = getEl('opsAftersaleRejectRefundSuggestion');

    if (statusEl) {
      if (state.loading) {
        statusEl.hidden = false;
        statusEl.textContent = state.flowType === 'step2'
          ? '正在加载二次驳回信息...'
          : '正在加载驳回退款表单...';
      } else {
        statusEl.hidden = true;
        statusEl.textContent = '';
      }
    }

    if (titleEl) {
      titleEl.textContent = state.flowType === 'step2' ? '第二次驳回退款' : '驳回退款';
    }

    if (tipEl) {
      tipEl.textContent = state.flowType === 'step2'
        ? '第二次驳回会进入“退款金额未达成一致”流程，仅需填写协商话术。'
        : (state.flowType === 'step3'
          ? '第三次驳回会走最终驳回流程，需要选择驳回原因并补充说明/凭证。'
          : '提交后会按当前售后标准化流程向消费者发送协商方案。');
    }

    if (errorEl) {
      if (state.error) {
        errorEl.hidden = false;
        errorEl.textContent = state.error;
      } else {
        errorEl.hidden = true;
        errorEl.textContent = '';
      }
    }

    if (solutionsGroupEl) {
      solutionsGroupEl.style.display = state.flowType === 'step1' ? '' : 'none';
    }

    if (solutionsEl) {
      solutionsEl.innerHTML = buildSolutionsHtml();
    }

    if (wordsEl) {
      const nextValue = String(state.words || '');
      if (wordsEl.value !== nextValue) wordsEl.value = nextValue;
      wordsEl.disabled = state.loading || state.submitting;
    }
    if (wordsGroupEl) {
      wordsGroupEl.style.display = state.flowType === 'step3' ? 'none' : '';
    }

    if (amountRowEl) {
      amountRowEl.style.display = state.flowType === 'step1' && hasPartialRefund() ? '' : 'none';
    }

    if (amountEl) {
      const nextAmount = String(state.partialRefundAmount || '');
      if (amountEl.value !== nextAmount) amountEl.value = nextAmount;
      amountEl.disabled = state.loading || state.submitting;
    }

    if (amountHintEl) {
      const maxText = formatMoneyYuanFromFen(state.refundableAmount);
      amountHintEl.textContent = maxText ? `最多可协商 ${maxText} 元` : '';
    }

    if (submitBtn) {
      submitBtn.disabled = state.loading || state.submitting;
      if (state.submitting) {
        submitBtn.textContent = '提交中...';
      } else {
        submitBtn.textContent = state.flowType === 'step2'
          ? '提交第二次驳回'
          : (state.flowType === 'step3' ? '提交最终驳回' : '提交协商方案');
      }
    }

    if (step3ReasonGroupEl) {
      step3ReasonGroupEl.style.display = state.flowType === 'step3' ? '' : 'none';
    }
    if (step3DescGroupEl) {
      step3DescGroupEl.style.display = state.flowType === 'step3' ? '' : 'none';
    }
    if (step3ProofGroupEl) {
      step3ProofGroupEl.style.display = state.flowType === 'step3' ? '' : 'none';
    }
    if (step3ReasonSelectEl) {
      const optionsHtml = ['<option value="">请选择驳回原因</option>'].concat(
        state.reasonOptions.map(item => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.desc)}</option>`)
      ).join('');
      step3ReasonSelectEl.innerHTML = optionsHtml;
      step3ReasonSelectEl.value = String(state.selectedReasonCode || '');
      step3ReasonSelectEl.disabled = state.loading || state.submitting;
    }
    if (step3DescHintEl) {
      const descs = (state.requiredRejectDescs || []).map(item => String(item?.type || '').trim()).filter(Boolean);
      step3DescHintEl.textContent = descs.length
        ? `需覆盖：${descs.join('；')}`
        : '请补充最终驳回说明。';
    }
    if (step3ProofHintEl) {
      const proofText = (state.requiredProofs || []).map(item => {
        const title = String(item?.proofType || '').trim();
        const requirement = String(item?.proofRequirement || '').trim();
        return [title, requirement].filter(Boolean).join('：');
      }).filter(Boolean).join('；');
      step3ProofHintEl.textContent = proofText || '可粘贴凭证图片 URL，一行一个。';
    }
    if (step3DescEl) {
      const nextValue = String(state.customRejectDesc || '');
      if (step3DescEl.value !== nextValue) step3DescEl.value = nextValue;
      step3DescEl.disabled = state.loading || state.submitting;
    }
    if (step3ImageUrlsEl) {
      const nextValue = String(state.imageUrlsText || '');
      if (step3ImageUrlsEl.value !== nextValue) step3ImageUrlsEl.value = nextValue;
      step3ImageUrlsEl.disabled = state.loading || state.submitting;
    }
    if (step3SuggestionEl) {
      const suggestions = Array.isArray(state.handlingSuggestions) ? state.handlingSuggestions.filter(Boolean) : [];
      step3SuggestionEl.style.display = state.flowType === 'step3' && suggestions.length ? '' : 'none';
      step3SuggestionEl.innerHTML = suggestions.length
        ? `<div class="ops-aftersale-reject-help">处理建议：${escapeHtml(suggestions.join('；'))}</div>`
        : '';
    }
  }

  async function loadFormData() {
    const context = state.context || {};
    const instanceId = String(context.instanceId || '').trim();
    const orderSn = String(context.orderNo || context.orderSn || '').trim();
    const shopId = String(context.shopId || '').trim();
    const version = Number(context.version || 0);
    if (!instanceId) throw new Error('缺少售后单ID');
    if (!orderSn) throw new Error('缺少订单号');
    if (!shopId || shopId === '__all__') throw new Error('请先选择具体店铺后再操作');
    if (!Number.isFinite(version) || version <= 0) throw new Error('缺少版本号，请刷新列表后重试');
    if (typeof window.pddApi?.aftersaleRejectRefundPreCheck !== 'function'
      || typeof window.pddApi?.aftersaleRejectRefundGetFormInfo !== 'function'
      || typeof window.pddApi?.aftersaleRejectRefundGetNegotiateInfo !== 'function'
      || typeof window.pddApi?.aftersaleRejectRefundGetReasons !== 'function') {
      throw new Error('接口未就绪，请退出并重启客户端后重试');
    }

    const precheckResp = await window.pddApi.aftersaleRejectRefundPreCheck({
      shopId,
      afterSalesId: instanceId,
      orderSn,
      version,
      invokeType: 0,
    });
    if (precheckResp?.error) throw new Error(precheckResp.error);

    const precheck = precheckResp?.result && typeof precheckResp.result === 'object' ? precheckResp.result : {};

    if (precheck?.rejectPopupWindowType === 1) {
      throw new Error('当前售后单暂不支持标准化驳回流程');
    }

    if (Number(precheck?.hasRejectCount || 0) >= 2) {
      const remainText = formatRemainSeconds(precheck?.rejectChatTipExpireRemainTime);
      if (remainText) {
        throw new Error(`上一轮协商仍在等待买家处理，请约 ${remainText} 后再试第三次驳回`);
      }
      const reasonsResp = await window.pddApi.aftersaleRejectRefundGetReasons({
        shopId,
        afterSalesId: instanceId,
        orderSn,
      });
      if (reasonsResp?.error) throw new Error(reasonsResp.error);
      const reasonOptions = normalizeReasonOptions(reasonsResp?.result || []);
      if (!reasonOptions.length) {
        throw new Error('未获取到第三次驳回原因列表');
      }
      const preferred = reasonOptions.find(item => item.code === '38') || reasonOptions[0];
      state.flowType = 'step3';
      state.formName = '';
      state.formId = '';
      state.refundableAmount = 0;
      state.words = '';
      state.solutionOptions = [];
      state.selectedSolutionCodes = [];
      state.partialRefundAmount = '';
      state.reasonOptions = reasonOptions;
      state.selectedReasonCode = String(preferred?.code || '');
      state.selectedReasonDesc = String(preferred?.desc || '');
      state.customRejectDesc = '';
      state.imageUrlsText = '';
      state.handlingSuggestions = Array.isArray(preferred?.handlingSuggestions) ? preferred.handlingSuggestions : [];
      state.requiredRejectDescs = Array.isArray(preferred?.requiredRejectDescs) ? preferred.requiredRejectDescs : [];
      state.requiredProofs = Array.isArray(preferred?.requiredProofs) ? preferred.requiredProofs : [];
      await loadStep3ReasonRequirements(shopId, instanceId, orderSn, state.selectedReasonCode);
      return;
    }

    if (Number(precheck?.hasRejectCount || 0) >= 1) {
      if (precheck?.isSopFinished === false && Number(precheck?.rejectChatTipExpireRemainTime || 0) > 0) {
        const remainText = formatRemainSeconds(precheck.rejectChatTipExpireRemainTime);
        throw new Error(`买家尚未处理上一次协商，请约 ${remainText} 后再试`);
      }
      const step2PrecheckResp = await window.pddApi.aftersaleRejectRefundPreCheck({
        shopId,
        afterSalesId: instanceId,
        orderSn,
        version,
        invokeType: 1,
      });
      if (step2PrecheckResp?.error) throw new Error(step2PrecheckResp.error);
      const step2Precheck = step2PrecheckResp?.result && typeof step2PrecheckResp.result === 'object'
        ? step2PrecheckResp.result
        : {};
      if (step2Precheck?.rejectPopupWindowType === 2) {
        state.flowType = 'step2';
        state.formName = '新售后驳回标准化流程_日用品_step2';
        state.formId = 'container';
        state.refundableAmount = 0;
        state.words = SECOND_REJECT_DEFAULT_WORDS;
        state.solutionOptions = [];
        state.selectedSolutionCodes = [];
        state.partialRefundAmount = '';
        return;
      }
      throw new Error('当前第二次驳回未命中已知标准化流程');
    }

    const [formInfoResp, negotiateResp] = await Promise.all([
      window.pddApi.aftersaleRejectRefundGetFormInfo({
        shopId,
        afterSalesId: instanceId,
        orderSn,
        bizType: 2,
        bizId: instanceId,
      }),
      window.pddApi.aftersaleRejectRefundGetNegotiateInfo({
        shopId,
        afterSalesId: instanceId,
        orderSn,
        key: 'ProMultiSolution',
      }),
    ]);
    if (formInfoResp?.error) throw new Error(formInfoResp.error);
    if (negotiateResp?.error) throw new Error(negotiateResp.error);

    const formInfo = formInfoResp?.result && typeof formInfoResp.result === 'object' ? formInfoResp.result : {};
    const negotiateInfo = negotiateResp?.result && typeof negotiateResp.result === 'object' ? negotiateResp.result : {};
    const schema = Array.isArray(formInfo.formSchema) ? formInfo.formSchema : [];
    const options = normalizeSolutionOptions(negotiateInfo);
    const recommendedWords = extractRecommendWords(schema);

    state.flowType = 'step1';
    state.formName = String(formInfo.formName || '').trim() || '新售后驳回标准化流程_日用品_step1';
    state.formId = String(schema?.[0]?.id || 'form1').trim() || 'form1';
    state.refundableAmount = Number(negotiateInfo.refundableAmount || negotiateInfo.afterSalesApplyAmount || 0);
    state.words = recommendedWords || DEFAULT_WORDS;
    state.solutionOptions = options;
    if (options.some(item => item.code === 'return_refund')) {
      state.selectedSolutionCodes = ['return_refund'];
    } else if (options[0]?.code) {
      state.selectedSolutionCodes = [options[0].code];
    } else {
      state.selectedSolutionCodes = [];
    }
    state.partialRefundAmount = state.refundableAmount > 0 ? formatMoneyYuanFromFen(state.refundableAmount) : '';
  }

  function buildSubmitPayload() {
    const context = state.context || {};
    const instanceId = String(context.instanceId || '').trim();
    const orderSn = String(context.orderNo || context.orderSn || '').trim();
    if (state.flowType === 'step3') {
      const reasonCode = Number(state.selectedReasonCode || 0);
      if (!Number.isFinite(reasonCode) || reasonCode <= 0) {
        throw new Error('请选择驳回原因');
      }
      const reason = String(state.selectedReasonDesc || '').trim();
      if (!reason) {
        throw new Error('缺少驳回原因文案');
      }
      const operateDesc = String(state.customRejectDesc || '').trim();
      if (!operateDesc) {
        throw new Error('请填写补充说明');
      }
      const requiredRejectDescs = (state.requiredRejectDescs || [])
        .map(item => ({ type: String(item?.type || '').trim() }))
        .filter(item => item.type);
      requiredRejectDescs.push({
        type: '自行补充其他描述',
        desc: operateDesc,
      });
      const requiredProofs = (state.requiredProofs || [])
        .map(item => ({
          proofCode: Number(item?.proofCode || 0),
          images: [],
        }))
        .filter(item => Number.isFinite(item.proofCode) && item.proofCode > 0);
      return {
        id: instanceId,
        afterSalesId: instanceId,
        orderSn,
        version: Number(context.version || 0),
        reason,
        operateDesc,
        images: parseImageUrls(state.imageUrlsText),
        shipImages: [],
        consumerReason: '',
        requiredRejectDescs,
        rejectReasonCode: reasonCode,
        mallId: null,
        requiredProofs,
      };
    }
    if (state.flowType === 'step2') {
      return {
        afterSalesId: instanceId,
        orderSn,
        formName: state.formName || '新售后驳回标准化流程_日用品_step2',
        bizType: 10,
        bizId: instanceId,
        formDataList: [
          { key: 'ProDisplayText1' },
          {
            keyLabel: '',
            value: 'option1',
            key: 'RadioGroup1',
            valueLabel: '退款金额未达成一致',
          },
          { key: 'ProDisplayText2' },
          { key: 'ProDisplayText3' },
          {
            value: JSON.stringify([
              {
                keyLabel: '协商话术',
                value: String(state.words || '').trim(),
                key: 'Words',
              },
            ]),
            key: 'ProRecommendWords1',
          },
          {
            key: 'FormId',
            value: state.formId || 'container',
            keyLabel: '',
            valueLabel: '',
          },
        ],
      };
    }
    const selectedItems = buildSelectedSolutionItems();
    if (!selectedItems.length) {
      throw new Error('请至少选择一个协商方案');
    }

    const nestedItems = [
      {
        keyLabel: '协商方案',
        value: JSON.stringify(selectedItems),
        key: 'CheckboxGroupNegotiatedSolution',
      },
    ];

    const partialRefundSelected = state.selectedSolutionCodes.includes('partial_refund');
    if (partialRefundSelected) {
      const amount = String(state.partialRefundAmount || '').trim();
      if (!amount) throw new Error('请输入协商退款金额');
      nestedItems.push({
        keyLabel: '退款金额',
        value: amount,
        key: 'RefundAmount',
      });
    } else {
      nestedItems.push({
        keyLabel: '退款金额',
        key: 'RefundAmount',
      });
    }

    nestedItems.push({
      keyLabel: '协商话术',
      value: String(state.words || '').trim(),
      key: 'RefundWords',
    });
    nestedItems.push({
      keyLabel: '上传凭证',
      value: '[]',
      key: 'MmsUpload',
    });

    return {
      afterSalesId: instanceId,
      orderSn,
      formName: state.formName,
      bizType: 10,
      bizId: instanceId,
      formDataList: [
        {
          keyLabel: '',
          value: 'option1',
          key: 'RadioGroup1',
          valueLabel: '与消费者协商售后方案',
        },
        {
          value: JSON.stringify(nestedItems),
          key: 'ProMultiSolution1',
        },
        {
          key: 'FormId',
          value: state.formId || 'form1',
          keyLabel: '',
          valueLabel: '',
        },
      ],
    };
  }

  async function submit() {
    if (state.loading || state.submitting) return;
    const context = state.context || {};
    const shopId = String(context.shopId || '').trim();
    if (!shopId || shopId === '__all__') {
      window.opsCenterToast?.('请先选择具体店铺后再操作');
      return;
    }
    if (state.flowType !== 'step3' && !String(state.words || '').trim()) {
      window.opsCenterToast?.('请填写协商话术');
      return;
    }
    if (state.flowType === 'step3') {
      if (typeof window.pddApi?.aftersaleRejectRefundValidate !== 'function'
        || typeof window.pddApi?.aftersaleMerchantRefuse !== 'function') {
        window.opsCenterToast?.('接口未就绪，请退出并重启客户端后重试');
        return;
      }
    } else if (typeof window.pddApi?.aftersaleRejectRefundSubmit !== 'function') {
      window.opsCenterToast?.('接口未就绪，请退出并重启客户端后重试');
      return;
    }
    try {
      const payload = buildSubmitPayload();
      setSubmitting(true);
      if (state.flowType === 'step3') {
        const validateResult = await window.pddApi.aftersaleRejectRefundValidate({ shopId, ...payload });
        if (!validateResult || validateResult.error) {
          throw new Error(validateResult?.error || '最终驳回校验失败');
        }
        const refuseResult = await window.pddApi.aftersaleMerchantRefuse({ shopId, ...payload });
        if (!refuseResult || refuseResult.error) {
          throw new Error(refuseResult?.error || '最终驳回提交失败');
        }
      } else {
        const result = await window.pddApi.aftersaleRejectRefundSubmit({ shopId, ...payload });
        if (!result || result.error) {
          throw new Error(result?.error || '提交协商方案失败');
        }
      }
      window.opsCenterToast?.(
        state.flowType === 'step3'
          ? '已提交第三次驳回'
          : (state.flowType === 'step2' ? '已提交第二次驳回' : '已提交驳回退款协商方案')
      );
      closeDialog();
      try {
        window.dispatchEvent(new CustomEvent('ops-aftersale-rejected-refund', {
          detail: {
            shopId,
            id: Number(context.instanceId || 0),
            orderSn: String(context.orderNo || context.orderSn || '').trim(),
            optimisticRemove: true,
          },
        }));
      } catch {}
    } catch (error) {
      state.error = error?.message || '提交协商方案失败';
      syncView();
      window.opsCenterToast?.(state.error);
    } finally {
      setSubmitting(false);
    }
  }

  function bindEvents(overlay) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDialog();
    });
    overlay.querySelectorAll('[data-ops-close="1"]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog());
    });
    overlay.addEventListener('change', (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && target.id === 'opsAftersaleRejectRefundReasonSelect') {
        const code = String(target.value || '').trim();
        state.selectedReasonCode = code;
        state.selectedReasonDesc = '';
        state.requiredRejectDescs = [];
        state.requiredProofs = [];
        state.handlingSuggestions = [];
        const context = state.context || {};
        loadStep3ReasonRequirements(
          String(context.shopId || '').trim(),
          String(context.instanceId || '').trim(),
          String(context.orderNo || context.orderSn || '').trim(),
          code
        ).then(() => {
          syncView();
        }).catch((error) => {
          state.error = error?.message || '加载驳回原因要求失败';
          syncView();
        });
        syncView();
        return;
      }
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.opsAftersaleRejectSolution === '1') {
        const code = String(target.value || '').trim();
        if (!code) return;
        const next = new Set(state.selectedSolutionCodes);
        if (target.checked) next.add(code);
        else next.delete(code);
        state.selectedSolutionCodes = Array.from(next);
        syncView();
        return;
      }
      if (target.id === 'opsAftersaleRejectRefundAmount') {
        state.partialRefundAmount = String(target.value || '');
      }
    });
    overlay.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target.id === 'opsAftersaleRejectRefundWords') {
        state.words = String(target.value || '');
      }
      if (target.id === 'opsAftersaleRejectRefundAmount') {
        state.partialRefundAmount = String(target.value || '');
      }
      if (target.id === 'opsAftersaleRejectRefundStep3Desc') {
        state.customRejectDesc = String(target.value || '');
      }
      if (target.id === 'opsAftersaleRejectRefundImageUrls') {
        state.imageUrlsText = String(target.value || '');
      }
    });
    getEl('btnOpsAftersaleRejectRefundSubmit')?.addEventListener('click', () => {
      submit().catch(() => {});
    });
  }

  function ensureMounted() {
    if (mounted) return;
    mounted = true;

    const style = document.createElement('style');
    style.textContent = `
      .ops-aftersale-reject-modal { width: 680px; max-width: calc(100vw - 40px); }
      .ops-aftersale-reject-body { display: flex; flex-direction: column; gap: 14px; }
      .ops-aftersale-reject-status { color: #666; font-size: 13px; }
      .ops-aftersale-reject-error { color: #d4380d; font-size: 13px; }
      .ops-aftersale-reject-tip { color: #666; font-size: 12px; line-height: 1.6; background: #fafafa; border-radius: 8px; padding: 10px 12px; }
      .ops-aftersale-reject-group-title { font-size: 13px; font-weight: 600; color: #333; margin-bottom: 8px; }
      .ops-aftersale-reject-solutions { display: flex; flex-wrap: wrap; gap: 8px; }
      .ops-aftersale-reject-solution { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #d9d9d9; border-radius: 8px; cursor: pointer; background: #fff; }
      .ops-aftersale-reject-solution.is-active { border-color: #1890ff; background: #e6f4ff; }
      .ops-aftersale-reject-solution input { margin: 0; }
      .ops-aftersale-reject-solution-text { font-size: 13px; color: #333; }
      .ops-aftersale-reject-empty { color: #999; font-size: 13px; }
      .ops-aftersale-reject-input { width: 100%; border: 1px solid #d9d9d9; border-radius: 8px; padding: 8px 10px; font-size: 13px; box-sizing: border-box; }
      .ops-aftersale-reject-textarea { width: 100%; min-height: 132px; resize: vertical; border: 1px solid #d9d9d9; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.6; box-sizing: border-box; }
      .ops-aftersale-reject-help { margin-top: 6px; color: #999; font-size: 12px; }
      .ops-aftersale-reject-select { width: 100%; height: 36px; border: 1px solid #d9d9d9; border-radius: 8px; padding: 0 10px; font-size: 13px; background: #fff; }
      .ops-aftersale-reject-footer { display: flex; justify-content: flex-end; gap: 10px; }
      .ops-aftersale-reject-cancel { border: 1px solid #d9d9d9; background: #fff; color: #333; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="modal ops-aftersale-reject-modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3 id="opsAftersaleRejectRefundTitle">驳回退款</h3>
          <button class="modal-close" type="button" data-ops-close="1">×</button>
        </div>
        <div class="modal-body ops-aftersale-reject-body">
          <div class="ops-aftersale-reject-status" id="opsAftersaleRejectRefundStatus" hidden></div>
          <div class="ops-aftersale-reject-error" id="opsAftersaleRejectRefundError" hidden></div>
          <div class="ops-aftersale-reject-tip" id="opsAftersaleRejectRefundTip">提交后会按当前售后标准化流程向消费者发送协商方案。</div>
          <div id="opsAftersaleRejectRefundSolutionsGroup">
            <div class="ops-aftersale-reject-group-title">协商方案</div>
            <div class="ops-aftersale-reject-solutions" id="opsAftersaleRejectRefundSolutions"></div>
          </div>
          <div id="opsAftersaleRejectRefundAmountRow" style="display:none;">
            <div class="ops-aftersale-reject-group-title">退款金额</div>
            <input class="ops-aftersale-reject-input" id="opsAftersaleRejectRefundAmount" type="number" min="0" step="0.01" placeholder="请输入协商退款金额（元）" />
            <div class="ops-aftersale-reject-help" id="opsAftersaleRejectRefundAmountHint"></div>
          </div>
          <div id="opsAftersaleRejectRefundWordsGroup">
            <div class="ops-aftersale-reject-group-title">协商话术</div>
            <textarea class="ops-aftersale-reject-textarea" id="opsAftersaleRejectRefundWords" placeholder="提交后将自动发送给消费者"></textarea>
            <div class="ops-aftersale-reject-help">提交后，此话术将自动发送给消费者。</div>
          </div>
          <div id="opsAftersaleRejectRefundStep3ReasonGroup" style="display:none;">
            <div class="ops-aftersale-reject-group-title">驳回原因</div>
            <select class="ops-aftersale-reject-select" id="opsAftersaleRejectRefundReasonSelect"></select>
            <div id="opsAftersaleRejectRefundSuggestion" style="display:none;"></div>
          </div>
          <div id="opsAftersaleRejectRefundStep3DescGroup" style="display:none;">
            <div class="ops-aftersale-reject-group-title">补充说明</div>
            <textarea class="ops-aftersale-reject-textarea" id="opsAftersaleRejectRefundStep3Desc" placeholder="请输入第三次驳回的补充说明"></textarea>
            <div class="ops-aftersale-reject-help" id="opsAftersaleRejectRefundDescHint"></div>
          </div>
          <div id="opsAftersaleRejectRefundStep3ProofGroup" style="display:none;">
            <div class="ops-aftersale-reject-group-title">凭证图片 URL</div>
            <textarea class="ops-aftersale-reject-textarea" id="opsAftersaleRejectRefundImageUrls" placeholder="可粘贴图片 URL，一行一个"></textarea>
            <div class="ops-aftersale-reject-help" id="opsAftersaleRejectRefundProofHint"></div>
          </div>
        </div>
        <div class="modal-footer ops-aftersale-reject-footer">
          <button class="ops-aftersale-reject-cancel" type="button" data-ops-close="1">取消</button>
          <button class="ops-aftersale-btn" type="button" id="btnOpsAftersaleRejectRefundSubmit">提交协商方案</button>
        </div>
      </div>
    `;
    bindEvents(overlay);
    document.body.appendChild(overlay);
  }

  async function openDialog(context = {}) {
    ensureMounted();
    state = {
      context: context && typeof context === 'object' ? { ...context } : {},
      loading: false,
      submitting: false,
      error: '',
      formName: '',
      formId: 'form1',
      flowType: 'step1',
      refundableAmount: 0,
      words: DEFAULT_WORDS,
      solutionOptions: [],
      selectedSolutionCodes: ['return_refund'],
      partialRefundAmount: '',
      reasonOptions: [],
      selectedReasonCode: '',
      selectedReasonDesc: '',
      handlingSuggestions: [],
      requiredRejectDescs: [],
      requiredProofs: [],
      customRejectDesc: '',
      imageUrlsText: '',
    };
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    overlay.classList.add('visible');
    syncView();
    try {
      setLoading(true);
      await loadFormData();
      state.error = '';
      syncView();
    } catch (error) {
      state.error = error?.message || '加载驳回退款表单失败';
      syncView();
    } finally {
      setLoading(false);
    }
  }

  window.openOpsAfterSaleRejectRefundDialog = openDialog;
  window.closeOpsAfterSaleRejectRefundDialog = closeDialog;
})();
