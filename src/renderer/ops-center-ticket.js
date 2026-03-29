const ticketRows = [
  { no: 'TK-240329-01', type: '催发货', status: '处理中', assignee: '客服A' },
  { no: 'TK-240329-02', type: '退款咨询', status: '待分配', assignee: '未分配' },
  { no: 'TK-240329-03', type: '物流异常', status: '待回访', assignee: '客服B' }
];

window.registerOpsCenterView({
  view: 'sub-ticket',
  elementId: 'viewSubTicket',
  title: '工单管理',
  description: '统一承接客服工单、流转状态和处理记录，不与客户对话会话区共享页面实现。',
  renderContent({ renderCards, escapeHtml }) {
    const rows = ticketRows.map(item => `
      <tr>
        <td>${escapeHtml(item.no)}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.assignee)}</td>
      </tr>
    `).join('');
    return `
      <div class="ops-center-grid">
        ${renderCards([
          { label: '待分配工单', value: '7 单' },
          { label: '超时未处理', value: '2 单' },
          { label: '今日已关闭', value: '16 单' }
        ])}
      </div>
      <div class="ops-module-layout">
        <div class="ops-module-main">
          <div class="ops-center-section">
            <div class="ops-center-section-title">工单筛选与派发</div>
            <div class="ops-module-filter-row">
              <label class="ops-module-field">
                <span class="ops-module-field-label">工单类型</span>
                <select class="form-select">
                  <option>全部类型</option>
                  <option>催发货</option>
                  <option>退款咨询</option>
                  <option>物流异常</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">处理状态</span>
                <select class="form-select">
                  <option>全部状态</option>
                  <option>待分配</option>
                  <option>处理中</option>
                  <option>待回访</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">搜索单号</span>
                <input class="form-input" placeholder="输入工单号或客户名">
              </label>
            </div>
            <div class="ops-module-actions">
              <button class="btn btn-primary btn-sm" id="btnTicketCreate">新建工单</button>
              <button class="btn btn-secondary btn-sm" id="btnTicketDispatch">批量派发</button>
            </div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">工单队列</div>
            <div class="ops-module-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>工单号</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>处理人</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="ops-module-side">
          <div class="ops-center-section">
            <div class="ops-center-section-title">流转提醒</div>
            <div class="ops-module-kpi">
              <span class="ops-module-kpi-label">当前最久未处理</span>
              <span class="ops-module-kpi-value">46 分钟</span>
            </div>
            <div class="ops-module-kpi">
              <span class="ops-module-kpi-label">建议优先队列</span>
              <span class="ops-module-badge success">退款咨询</span>
            </div>
            <div class="ops-module-note">该页适合继续扩展派发规则、详情抽屉、处理日志和 SLA 提醒，不应与客户会话主界面混写。</div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">实现建议</div>
            <div class="ops-module-timeline">
              <div class="ops-module-timeline-item">
                <div class="ops-module-timeline-title">第一步</div>
                <div class="ops-module-timeline-desc">先补充工单详情面板和状态流转动作。</div>
              </div>
              <div class="ops-module-timeline-item">
                <div class="ops-module-timeline-title">第二步</div>
                <div class="ops-module-timeline-desc">再把批量派发、指派与筛选条件接到主进程。</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },
  onMount(element) {
    element.querySelector('#btnTicketCreate')?.addEventListener('click', () => {
      window.opsCenterToast?.('工单创建入口已预留，后续可接入弹窗表单');
    });
    element.querySelector('#btnTicketDispatch')?.addEventListener('click', () => {
      window.opsCenterToast?.('批量派发入口已预留，后续建议接入工单批处理 IPC');
    });
  }
});
