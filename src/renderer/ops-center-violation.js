const violationRecords = [
  { type: '话术风险', level: '高', status: '待复核', owner: '客服主管' },
  { type: '违规承诺', level: '中', status: '整改中', owner: '运营专员' },
  { type: '引流风险', level: '高', status: '已申诉', owner: '店铺负责人' }
];

window.registerOpsCenterView({
  view: 'sub-violation',
  elementId: 'viewSubViolation',
  title: '违规管理',
  description: '统一承接违规记录、处置状态和申诉资料，不与自动回复和客服消息处理混改。',
  renderContent({ renderCards, escapeHtml }) {
    const rows = violationRecords.map(item => `
      <tr>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.level)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.owner)}</td>
      </tr>
    `).join('');
    return `
      <div class="ops-center-grid">
        ${renderCards([
          { label: '高风险记录', value: '2 条' },
          { label: '待复核事项', value: '4 项' },
          { label: '近7天申诉通过率', value: '81%' }
        ])}
      </div>
      <div class="ops-module-layout">
        <div class="ops-module-main">
          <div class="ops-center-section">
            <div class="ops-center-section-title">处置筛选</div>
            <div class="ops-module-filter-row">
              <label class="ops-module-field">
                <span class="ops-module-field-label">违规类型</span>
                <select class="form-select">
                  <option>全部类型</option>
                  <option>话术风险</option>
                  <option>引流风险</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">处置状态</span>
                <select class="form-select">
                  <option>全部状态</option>
                  <option>待复核</option>
                  <option>整改中</option>
                  <option>已申诉</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">责任人</span>
                <input class="form-input" placeholder="输入负责人或工号">
              </label>
            </div>
            <div class="ops-module-actions">
              <button class="btn btn-primary btn-sm" id="btnViolationRefresh">刷新记录</button>
              <button class="btn btn-secondary btn-sm" id="btnViolationCreateAppeal">发起申诉</button>
            </div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">违规记录列表</div>
            <div class="ops-module-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>违规类型</th>
                    <th>风险等级</th>
                    <th>当前状态</th>
                    <th>责任人</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="ops-module-side">
          <div class="ops-center-section">
            <div class="ops-center-section-title">最近处理进度</div>
            <div class="ops-module-timeline">
              <div class="ops-module-timeline-item">
                <div class="ops-module-timeline-time">今天 10:20</div>
                <div class="ops-module-timeline-title">提交违规话术复核</div>
                <div class="ops-module-timeline-desc">建议后续将复核动作与申诉资料上传走独立 IPC。</div>
              </div>
              <div class="ops-module-timeline-item">
                <div class="ops-module-timeline-time">昨天 16:40</div>
                <div class="ops-module-timeline-title">生成整改清单</div>
                <div class="ops-module-timeline-desc">当前模板已为后续筛选、详情和时间线展示留出结构空间。</div>
              </div>
            </div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">协作边界</div>
            <div class="ops-module-note">违规模块适合独立维护记录、申诉、复核和整改流，不应直接耦合聊天消息区或快捷短语逻辑。</div>
          </div>
        </div>
      </div>
    `;
  },
  onMount(element) {
    element.querySelector('#btnViolationRefresh')?.addEventListener('click', () => {
      window.opsCenterToast?.('违规管理模板已就绪，后续可接入处罚记录查询');
    });
    element.querySelector('#btnViolationCreateAppeal')?.addEventListener('click', () => {
      window.opsCenterToast?.('申诉入口已预留，建议后续补充独立表单和附件上传');
    });
  }
});
