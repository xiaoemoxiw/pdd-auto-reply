const aftersaleRows = [
  { id: 'AS-240329-01', type: '退货退款', status: '待审核', shop: '旗舰店' },
  { id: 'AS-240329-02', type: '仅退款', status: '处理中', shop: '专营店' },
  { id: 'AS-240329-03', type: '换货申请', status: '待买家寄回', shop: '旗舰店' }
];

window.registerOpsCenterView({
  view: 'sub-aftersale',
  elementId: 'viewSubAftersale',
  title: '售后中心',
  description: '统一承接售后工单、退款退货和履约跟进，不再与接口对接页右侧侧栏语义混杂。',
  renderContent({ renderCards, escapeHtml }) {
    const rows = aftersaleRows.map(item => `
      <tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.shop)}</td>
      </tr>
    `).join('');
    return `
      <div class="ops-center-grid">
        ${renderCards([
          { label: '待审核售后', value: '9 单' },
          { label: '退款处理中', value: '6 单' },
          { label: '今日完结', value: '12 单' }
        ])}
      </div>
      <div class="ops-module-layout">
        <div class="ops-module-main">
          <div class="ops-center-section">
            <div class="ops-center-section-title">售后筛选</div>
            <div class="ops-module-filter-row">
              <label class="ops-module-field">
                <span class="ops-module-field-label">售后类型</span>
                <select class="form-select">
                  <option>全部类型</option>
                  <option>退货退款</option>
                  <option>仅退款</option>
                  <option>换货申请</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">所属店铺</span>
                <select class="form-select">
                  <option>全部店铺</option>
                  <option>旗舰店</option>
                  <option>专营店</option>
                </select>
              </label>
              <label class="ops-module-field">
                <span class="ops-module-field-label">搜索单号</span>
                <input class="form-input" placeholder="输入售后单号或订单号">
              </label>
            </div>
            <div class="ops-module-actions">
              <button class="btn btn-primary btn-sm" id="btnAftersaleRefresh">刷新售后</button>
              <button class="btn btn-secondary btn-sm" id="btnAftersaleSync">同步进度</button>
            </div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">售后记录</div>
            <div class="ops-module-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>售后单号</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>店铺</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="ops-module-side">
          <div class="ops-center-section">
            <div class="ops-center-section-title">当前处理提示</div>
            <div class="ops-module-note">售后中心应作为独立主页面维护退款、退货、换货和履约跟踪，不再借用 chat-api 右侧临时售后信息区域。</div>
          </div>
          <div class="ops-center-section">
            <div class="ops-center-section-title">流程占位</div>
            <div class="ops-module-timeline">
              <div class="ops-module-timeline-item">
                <div class="ops-module-timeline-title">审核阶段</div>
                <div class="ops-module-timeline-desc">后续可在本文件中补充售后详情抽屉、审核动作和材料查看。</div>
              </div>
              <div class="ops-module-timeline-item">
                <div class="ops-module-timeline-title">同步阶段</div>
                <div class="ops-module-timeline-desc">建议把状态同步和履约回写走售后中心专属 IPC，不直接混入聊天侧栏。</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },
  onMount(element) {
    element.querySelector('#btnAftersaleRefresh')?.addEventListener('click', () => {
      window.opsCenterToast?.('售后中心模板已就绪，后续可接入售后列表查询');
    });
    element.querySelector('#btnAftersaleSync')?.addEventListener('click', () => {
      window.opsCenterToast?.('售后同步入口已预留，建议后续走独立售后状态同步接口');
    });
  }
});
