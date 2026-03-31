(function () {
  let initialized = false;
  let testChatHistory = [];
  let testMsgInput = null;
  let testChatMessages = null;
  let testPipelineContent = null;

  function getEl(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return typeof window.esc === 'function'
      ? window.esc(value)
      : String(value ?? '');
  }

  function appendTestBubble(type, label, text, sourceRule) {
    if (!testChatMessages) return;
    const row = document.createElement('div');
    row.className = `test-msg-row ${type}`;

    if (type === 'customer') {
      row.innerHTML = `<div class="test-msg-name">${escapeHtml(label)}</div><div class="test-msg-bubble">${escapeHtml(text)}</div>`;
    } else {
      const sourceClass = label === '关键词匹配'
        ? 'keyword'
        : label === 'AI 意图识别'
          ? 'ai'
          : label === '兜底回复'
            ? 'fallback'
            : 'none';
      row.innerHTML = `<div class="test-msg-bubble">${escapeHtml(text)}</div><div class="test-msg-source"><span class="test-source-tag ${sourceClass}">${escapeHtml(label)}</span>${sourceRule ? `<span>${escapeHtml(sourceRule)}</span>` : ''}</div>`;
    }

    testChatMessages.appendChild(row);
    testChatMessages.scrollTop = testChatMessages.scrollHeight;
  }

  function appendTestBubbleNoMatch() {
    if (!testChatMessages) return;
    const row = document.createElement('div');
    row.className = 'test-msg-row system';
    row.innerHTML = '<div class="test-msg-bubble no-match">（无匹配回复）</div><div class="test-msg-source"><span class="test-source-tag none">无匹配</span></div>';
    testChatMessages.appendChild(row);
    testChatMessages.scrollTop = testChatMessages.scrollHeight;
  }

  function renderTestPipeline(result) {
    if (!testPipelineContent) return;
    let html = '';

    (result?.steps || []).forEach((step, index) => {
      const status = step.skipped ? 'skip' : step.matched ? 'hit' : 'miss';
      const isWinner = step.matched && result.finalSource === step.name;

      html += `<div class="test-step ${isWinner ? 'winning' : ''}">`;
      html += '<div class="test-step-header">';
      html += `<span class="test-step-num ${status}">${index + 1}</span>`;
      html += `<span class="test-step-name">${escapeHtml(step.name)}</span>`;

      if (step.skipped) {
        html += '<span class="test-step-badge skip">跳过</span>';
      } else if (step.matched) {
        html += '<span class="test-step-badge hit">命中</span>';
      } else {
        html += '<span class="test-step-badge miss">未命中</span>';
      }
      html += '</div>';

      html += '<div class="test-step-detail">';
      if (step.skipped && step.detail?.reason) {
        html += `<div class="kv"><span class="k">原因:</span><span class="v">${escapeHtml(step.detail.reason)}</span></div>`;
      } else if (step.detail) {
        if (step.name === '关键词匹配') {
          if (step.matched) {
            html += `<div class="kv"><span class="k">规则:</span><span class="v">${escapeHtml(step.detail.ruleName)}</span></div>`;
            html += `<div class="kv"><span class="k">得分:</span><span class="v">${step.detail.score}</span></div>`;
            html += `<div class="test-step-reply-preview">${escapeHtml(step.detail.reply)}</div>`;
          }
        } else if (step.name === 'AI 意图识别') {
          if (step.detail.error) {
            html += `<div class="kv"><span class="k">错误:</span><span class="v" style="color:#e02e24">${escapeHtml(step.detail.error)}</span></div>`;
          } else if (step.matched) {
            html += `<div class="kv"><span class="k">意图:</span><span class="v">${escapeHtml(step.detail.intentName)}</span></div>`;
            html += `<div class="kv"><span class="k">相似度:</span><span class="v">${step.detail.similarity}</span></div>`;
            html += `<div class="test-step-reply-preview">${escapeHtml(step.detail.reply)}</div>`;
          }
          if (Array.isArray(step.detail.ranking) && step.detail.ranking.length) {
            html += '<div style="margin-top:6px;font-size:11px;color:#999">相似度排名:</div><div style="margin-top:2px">';
            step.detail.ranking.slice(0, 5).forEach(item => {
              const pct = Math.round(item.similarity * 100);
              const cls = item.similarity >= (step.detail.threshold || 0.65)
                ? 'high'
                : item.similarity >= 0.4
                  ? 'medium'
                  : 'low';
              html += `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px"><span style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(item.intentName)}">${escapeHtml(item.intentName)}</span><span class="ai-sim-bar ${cls}" style="width:${pct}px;height:6px"></span><span style="color:#999">${item.similarity}</span></div>`;
            });
            html += '</div>';
          }
        } else if (step.name === '兜底回复') {
          if (step.matched) {
            html += `<div class="kv"><span class="k">类型:</span><span class="v">${escapeHtml(step.detail.ruleName)}</span></div>`;
            html += `<div class="test-step-reply-preview">${escapeHtml(step.detail.reply)}</div>`;
          } else if (step.detail?.reason) {
            html += `<div class="kv"><span class="k">原因:</span><span class="v">${escapeHtml(step.detail.reason)}</span></div>`;
          }
        }
      }

      html += `<div style="margin-top:4px;font-size:11px;color:#ccc">耗时: ${step.duration}ms</div>`;
      html += '</div></div>';
    });

    const hasReply = !!result?.finalReply;
    html += `<div class="test-final ${hasReply ? '' : 'no-match'}">`;
    html += '<div class="test-final-title">';
    html += hasReply ? '&#10003; 最终回复' : '&#10007; 无可用回复';
    html += '</div>';
    if (hasReply) {
      html += `<div class="test-final-reply">${escapeHtml(result.finalReply)}</div>`;
    }
    html += '<div class="test-final-meta">';
    html += `<span>来源: ${escapeHtml(result?.finalSource)}</span>`;
    if (result?.finalSourceRule) {
      html += `<span>规则: ${escapeHtml(result.finalSourceRule)}</span>`;
    }
    html += `<span>总耗时: ${result?.totalDuration}ms</span>`;
    html += '</div></div>';

    testPipelineContent.innerHTML = html;
  }

  async function sendTestMessage() {
    if (!testMsgInput || !testChatMessages || !testPipelineContent) return;
    const message = testMsgInput.value.trim();
    if (!message) return;
    testMsgInput.value = '';

    const customerName = getEl('testCustomerName')?.value.trim() || '测试买家';
    const tip = testChatMessages.querySelector('.test-chat-tip');
    if (tip) {
      tip.remove();
    }

    appendTestBubble('customer', customerName, message);
    testPipelineContent.innerHTML = '<div style="padding:20px;text-align:center;color:#999;font-size:13px">处理中...</div>';

    const result = await window.pddApi.simulateMessageFlow({ message, customerName });
    if (result?.finalReply) {
      appendTestBubble('system', result.finalSource, result.finalReply, result.finalSourceRule);
    } else {
      appendTestBubbleNoMatch();
    }

    renderTestPipeline(result);
    testChatHistory.push({ customer: customerName, message, result });
  }

  function clearTestChat() {
    testChatHistory = [];
    if (testChatMessages) {
      testChatMessages.innerHTML = '<div class="test-chat-tip">输入消息模拟客户发送，查看自动回复流程的每一步处理结果</div>';
    }
    if (testPipelineContent) {
      testPipelineContent.innerHTML = '<div class="test-chat-tip">发送消息后查看匹配流程</div>';
    }
  }

  function bindTestFlowModule() {
    if (initialized) return;
    initialized = true;

    testMsgInput = getEl('testMsgInput');
    testChatMessages = getEl('testChatMessages');
    testPipelineContent = getEl('testPipelineContent');

    getEl('btnTestSend')?.addEventListener('click', sendTestMessage);
    testMsgInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        sendTestMessage();
      }
    });

    document.querySelectorAll('.test-quick-btn').forEach(button => {
      button.addEventListener('click', () => {
        if (!testMsgInput) return;
        testMsgInput.value = button.dataset.msg || '';
        sendTestMessage();
      });
    });

    getEl('btnClearTestChat')?.addEventListener('click', clearTestChat);
  }

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('test-flow-module', bindTestFlowModule);
  } else {
    bindTestFlowModule();
  }
})();
