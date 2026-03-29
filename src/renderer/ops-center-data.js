const dataCenterMetrics = [
  { name: '实时回复率', owner: '客服团队', value: '98.6%', trend: '较昨日 +1.2%' },
  { name: '咨询转化率', owner: '运营团队', value: '13.4%', trend: '较昨日 +0.8%' },
  { name: '超时会话数', owner: '值班客服', value: '5', trend: '较昨日 -3' }
];

window.registerOpsCenterView({
  view: 'sub-data',
  elementId: 'viewSubData',
  title: '数据中心',
  description: '统一承接数据概览、指标看板和经营分析，不与客户对话主链路混写。',
  renderContent({ renderCards, renderSections, escapeHtml }) {
    const tableRows = dataCenterMetrics.map(item => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.owner)}</td>
        <td>${escapeHtml(item.value)}</td>
        <td>${escapeHtml(item.trend)}</td>
      </tr>
    `).join('');
    return `
      <div class="ops-center-grid">
        ${renderCards([
          { label: '今日咨询量', value: '1,286' },
          { label: '今日成交额', value: '¥ 86,420' },
          { label: '待分析报表', value: '3 份' }
        ])}
      </div>
      <div class="ops-module-layout">
        <div class="ops-module-main">
          <div class="ops-center-section">
            <div class="ops-center-section-title">指标筛选</div>
            <div class="ops-module-filter-row">
              <label class="ops-module-field">
                <span class="ops-module-field-label">时间范围</span>
                <select class="form-select" id="dataCenterRange">
                  <option>今天</option>
                  <option>近7天</option>
                  <option>近30天</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">店铺范围</span>
                <select class="form-select" id="dataCenterShop">
                  <option>全部店铺</option>
                  <option>当前店铺</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">关键词</span>
                <input class="form-input" id="dataCenterKeyword" placeholder="输入指标名或负责人">
              </label>
            </div>
            <div class="ops-module-actions">
              <button class="btn btn-primary btn-sm" id="btnDataCenterRefresh">刷新指标</button>
              <button class="btn btn-secondary btn-sm" id="btnDataCenterExport">导出报表</button>
            </div>
            <div class="ops-module-caption">当前为模板页结构，后续可在本文件中接入真实图表、趋势对比和导出逻辑。</div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">核心指标清单</div>
            <div class="ops-module-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>指标名称</th>
                    <th>负责人</th>
                    <th>当前值</th>
                    <th>趋势</th>
                  </tr>
                </thead>
                <tbody>${tableRows}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="ops-module-side">
          <div class="ops-center-section">
            <div class="ops-center-section-title">数据洞察</div>
            <div class="ops-module-kpi">
              <span class="ops-module-kpi-label">高优先级指标</span>
              <span class="ops-module-badge">回复时效</span>
            </div>
            <div class="ops-module-kpi">
              <span class="ops-module-kpi-label">建议下一步</span>
              <span class="ops-module-kpi-value">补充趋势图区域</span>
            </div>
            <div class="ops-module-note">适合作为数据看板、经营趋势、客服表现分析的独立承载页，避免与客户对话页面共享实现。</div>
          </div>
          ${renderSections([
            {
              title: '协作边界',
              items: [
                { label: '可扩展', value: '图表组件、导出能力、筛选条件和数据汇总逻辑。' },
                { label: '避免触碰', value: '聊天消息区、轮询状态与客户会话切换。' }
              ]
            }
          ])}
        </div>
      </div>
    `;
  },
  onMount(element) {
    element.querySelector('#btnDataCenterRefresh')?.addEventListener('click', () => {
      window.opsCenterToast?.('数据中心模板已就绪，后续可接入真实刷新逻辑');
    });
    element.querySelector('#btnDataCenterExport')?.addEventListener('click', () => {
      window.opsCenterToast?.('导出入口已预留，建议后续走独立 IPC');
    });
  }
});
