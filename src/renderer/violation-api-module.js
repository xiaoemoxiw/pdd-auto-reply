(function () {
  let initialized = false;
  let violationApiEntries = [];
  let violationApiList = [];
  let violationApiTypeMap = {};
  let violationApiKeyword = '';
  let violationApiStatusFilter = '';
  let violationApiTypeFilter = '';
  let violationApiQuickFilter = 'all';
  let violationApiActiveId = '';
  let violationApiActiveDetail = null;
  let violationApiPageMode = 'list';
  let violationApiDetailLoading = false;
  let violationApiDetailError = '';
  const PDD_BASE = 'https://mms.pinduoduo.com';
  const VIOLATION_TYPE_URL_KEY = '/genji/gosling/mallViolationAppeal/query/queryViolationType';
  const VIOLATION_RECORD_URL_KEY = '/genji/gosling/mallViolationAppeal/query/queryAppealRecord';
  const VIOLATION_STATUS_TEXT_MAP = {
    0: '待申诉',
    1: '平台处理中',
    2: '待完善资料',
    5: '超时关闭申诉',
    7: '待申诉',
    8: '平台处理中',
    9: '待完善资料',
    10: '平台处理中',
    11: '待完善资料',
    16: '平台处理中',
    17: '平台处理中',
    18: '待完善资料',
    19: '待完善资料',
    27: '平台处理中',
    28: '待完善资料',
    30: '平台处理中'
  };
  const VIOLATION_QUICK_STATUS_GROUPS = {
    pending: new Set([0, 7]),
    appealing: new Set([2, 9, 11, 18, 19, 28]),
    processing: new Set([1, 8, 10, 16, 17, 27, 30])
  };
  const VIOLATION_NAV_TABS = {
    shop: {
      label: '店铺违规管理',
      url: `${PDD_BASE}/pg/violation_list/mall_manage?msfrom=mms_sidenav`,
      matchers: ['/pg/violation_list/mall_manage', '/pg/violation_info']
    },
    goods: {
      label: '店铺/商品违规',
      url: `${PDD_BASE}/pg/violation_list/mallgoods?msfrom=mms_sidenav`,
      matchers: ['/pg/violation_list/mallgoods']
    },
    appeal: {
      label: '违规申诉/整改',
      url: `${PDD_BASE}/pg/violation_list/rectify?msfrom=mms_sidenav`,
      matchers: ['/pg/violation_list/rectify', '/pg/batch_appeal/', '/mall/violation_complain', '/mall/complain_result']
    },
    live: {
      label: '直播违规',
      url: `${PDD_BASE}/pg/violation_list/live?msfrom=mms_sidenav`,
      matchers: ['/pg/violation_list/live']
    },
    after: {
      label: '售后服务违规',
      url: `${PDD_BASE}/aftersales/aftersale_violation/list?msfrom=mms_sidenav`,
      matchers: ['/aftersales/aftersale_violation/list']
    },
    warning: {
      label: '违规预警',
      url: `${PDD_BASE}/pg/violation_list/hk_ship?msfrom=mms_sidenav`,
      matchers: ['/pg/violation_list/hk_ship']
    }
  };

  function getEl(id) {
    return document.getElementById(id);
  }

  function getViolationTrafficType(entry) {
    const text = `${entry?.fullUrl || entry?.url || ''} ${entry?.requestBody || ''}`.toLowerCase();
    if (text.includes('/pg/violation_list/mall_manage')) return '页面入口';
    if (text.includes('violation_list')) return '违规列表';
    if (text.includes('appeal')) return '违规申诉';
    if (text.includes('warn')) return '违规预警';
    if (text.includes('punish')) return '处罚记录';
    if (text.includes('violation')) return '违规接口';
    return '';
  }

  function isViolationTrafficEntry(entry) {
    return !!getViolationTrafficType(entry);
  }

  function parseJsonSafely(text) {
    if (!text) return null;
    if (typeof text === 'object') return text;
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function pickFirstValue(source, paths) {
    for (const path of paths) {
      const segments = path.split('.');
      let current = source;
      let valid = true;
      for (const segment of segments) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
          valid = false;
          break;
        }
        current = current[segment];
      }
      if (valid && current !== undefined && current !== null && String(current).trim() !== '') {
        return current;
      }
    }
    return '';
  }

  function getObjectStringValues(source = {}) {
    return Object.values(source)
      .filter(value => ['string', 'number'].includes(typeof value))
      .map(value => String(value));
  }

  function toNumberIfPossible(value) {
    const code = Number(value);
    return Number.isFinite(code) ? code : null;
  }

  function ensureObject(value) {
    if (!value) return {};
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const parsed = parseJsonSafely(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  function formatViolationAmount(value, fallbackFen) {
    const amount = toNumberIfPossible(value);
    if (amount !== null) return `${amount}元`;
    const fen = toNumberIfPossible(fallbackFen);
    if (fen !== null) return `${(fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)}元`;
    return '';
  }

  function getViolationDownloadState(extra = {}) {
    const keys = [
      'orderMmsExcelUrl',
      'orderExcelUrl',
      'expressOrderMmsExcelUrl',
      'expressOrderExcelUrl',
      'appealTemplateUrl',
      'structureAppealFileUrl'
    ];
    return keys.some(key => String(extra?.[key] || '').trim()) ? '已提供' : '';
  }

  function buildViolationExtra(item = {}) {
    const extra = {
      ...ensureObject(item.violationNotes),
      ...ensureObject(item.violationInfo)
    };
    const punishMeasures = Array.isArray(extra.punishMeasureOptions)
      ? extra.punishMeasureOptions.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    return {
      punishMeasures,
      violationAmountText: formatViolationAmount(extra.violationAmount, item.initViolationAmountFen),
      violationOrderCount: pickFirstValue(extra, ['violationOrderCount', 'originViolationOrderCount']) || '',
      appealEndTime: item.appealEndTime || '',
      batchId: extra.batchId || item.batchId || '',
      punishStatus: extra.punishStatus || '',
      downloadState: getViolationDownloadState(extra),
      stockoutType: item.stockoutType || item.extStringOne || '',
      restrictTypes: Array.isArray(extra.restrictTypes) ? extra.restrictTypes.join('、') : (extra.restrictTypes || item.restrictTypes || ''),
      raw: extra
    };
  }

  function getViolationAppealSn(detail = {}) {
    return String(pickFirstValue(detail.raw || detail, [
      'violationAppealSn',
      'violation_appeal_sn',
      'noticeSn',
      'notice_sn',
      'violationNo'
    ]) || detail.violationNo || '').trim();
  }

  function getViolationTypeCode(detail = {}) {
    return toNumberIfPossible(pickFirstValue(detail.raw || detail, [
      'violationType',
      'violation_type',
      'punishType',
      'punish_type',
      'type'
    ]));
  }

  function buildViolationDetailUrl(detail = {}) {
    const violationAppealSn = getViolationAppealSn(detail);
    const violationTypeCode = getViolationTypeCode(detail);
    if (!violationAppealSn || violationTypeCode === null) return '';
    return `${PDD_BASE}/pg/violation_info?appeal_sn=${encodeURIComponent(violationAppealSn)}&violation_type=${encodeURIComponent(violationTypeCode)}`;
  }

  function buildViolationAppealFormUrl(detail = {}) {
    const violationAppealSn = getViolationAppealSn(detail);
    const violationTypeCode = getViolationTypeCode(detail);
    if (!violationAppealSn || violationTypeCode === null) return '';
    if (Number(violationTypeCode) === 10) {
      return `${PDD_BASE}/pg/batch_appeal/out_stock_of_goods?appeal_sn=${encodeURIComponent(violationAppealSn)}&violation_type=${encodeURIComponent(violationTypeCode)}`;
    }
    return '';
  }

  function buildViolationAppealTargetUrl(detail = {}) {
    return buildViolationAppealFormUrl(detail) || buildViolationDetailUrl(detail);
  }

  function canViolationAppeal(detail = {}) {
    const progress = String(detail.progress || '').toLowerCase();
    const statusCode = toNumberIfPossible(detail.statusCode);
    if (progress.includes('超时') || progress.includes('关闭')) return false;
    if (statusCode !== null) {
      return VIOLATION_QUICK_STATUS_GROUPS.pending.has(statusCode) || VIOLATION_QUICK_STATUS_GROUPS.appealing.has(statusCode);
    }
    return progress.includes('待申诉') || progress.includes('待完善') || progress.includes('举证') || progress.includes('整改');
  }

  function getViolationAppealActionText(detail = {}) {
    const progress = String(detail.progress || '').toLowerCase();
    if (progress.includes('待完善') || progress.includes('举证') || progress.includes('整改')) return '补充材料';
    return '申诉';
  }

  function getViolationAppealButtonText(detail = {}) {
    const actionText = getViolationAppealActionText(detail);
    return buildViolationAppealFormUrl(detail) ? `填写${actionText}` : `去${actionText}`;
  }

  function getViolationMatchedNavKey(url = '') {
    const text = String(url || '');
    return Object.entries(VIOLATION_NAV_TABS).find(([, config]) => config.matchers.some(item => text.includes(item)))?.[0] || 'shop';
  }

  function renderViolationNavTabs(activeKey = 'shop') {
    document.querySelectorAll('[data-violation-nav-tab]').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.violationNavTab === activeKey);
    });
  }

  function looksLikeViolationRecord(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item).join(' ').toLowerCase();
    const values = getObjectStringValues(item).join(' ').toLowerCase();
    const hasCoreField = [
      'violationAppealSn',
      'violation_appeal_sn',
      'violationType',
      'violation_type',
      'violationTypeStr',
      'violation_type_str',
      'appealStatus',
      'appeal_status',
      'violationId',
      'violation_id',
      'violationSn',
      'violation_sn',
      'noticeSn',
      'notice_sn',
      'createdAt',
      'noticeTime'
    ].some(key => key in item);
    if (hasCoreField) return true;
    if ((keys.includes('violation') || keys.includes('appeal') || keys.includes('punish')) && (keys.includes('time') || keys.includes('status') || keys.includes('type') || keys.includes('id') || keys.includes('sn'))) return true;
    return values.includes('违规') || values.includes('申诉') || values.includes('处罚');
  }

  function normalizeViolationAppealRecord(item = {}, index = 0, typeMap = {}) {
    const statusCode = toNumberIfPossible(pickFirstValue(item, [
      'appealStatus',
      'appeal_status',
      'status',
      'statusCode',
      'status_code'
    ]));
    const violationTypeCode = toNumberIfPossible(pickFirstValue(item, [
      'violationType',
      'violation_type',
      'punishType',
      'punish_type',
      'type'
    ]));
    const rawValues = getObjectStringValues(item);
    const extra = buildViolationExtra(item);
    return {
      violationNo: String(pickFirstValue(item, [
        'violationAppealSn',
        'violation_appeal_sn',
        'noticeSn',
        'notice_sn',
        'violationId',
        'violation_id',
        'id'
      ]) || `record-${index + 1}`),
      violationType: String(pickFirstValue(item, [
        'violationTypeStr',
        'violation_type_str',
        'violationTypeDesc',
        'violation_type_desc',
        'punishTypeDesc',
        'punish_type_desc'
      ]) || (violationTypeCode !== null ? typeMap[String(violationTypeCode)] : '') || '违规记录'),
      notifyTime: pickFirstValue(item, [
        'createdAt',
        'createTime',
        'gmtCreate',
        'noticeTime',
        'notice_time'
      ]),
      appealTime: pickFirstValue(item, [
        'lastAppealCommitTime',
        'last_appeal_commit_time',
        'appealTime',
        'appeal_time',
        'submitTime',
        'submit_time'
      ]),
      processTime: pickFirstValue(item, [
        'lastAppealDealTime',
        'last_appeal_deal_time',
        'updatedAt',
        'updateTime',
        'gmtModified',
        'processTime',
        'process_time'
      ]),
      progress: String(pickFirstValue(item, [
        'appealStatusDesc',
        'appeal_status_desc',
        'statusDesc',
        'status_desc',
        'statusText',
        'status_text'
      ]) || (statusCode !== null ? VIOLATION_STATUS_TEXT_MAP[statusCode] : '') || '待处理'),
      statusCode,
      summary: [
        pickFirstValue(item, ['extStringOne', 'ext_string_one']),
        pickFirstValue(item, ['remark']),
        extra.punishMeasures[0] || '',
        rawValues.slice(0, 4).join(' · ')
      ].filter(Boolean).join(' · '),
      extra,
      raw: item
    };
  }

  function normalizeViolationRecord(item = {}, index = 0, typeMap = {}) {
    const violationNo = String(pickFirstValue(item, [
      'violationAppealSn',
      'violation_appeal_sn',
      'violationId',
      'violation_id',
      'violationSn',
      'violation_sn',
      'serialNo',
      'serial_no',
      'noticeSn',
      'notice_sn',
      'recordId',
      'record_id',
      'id'
    ]) || `record-${index + 1}`);
    const statusCode = toNumberIfPossible(pickFirstValue(item, [
      'appealStatus',
      'appeal_status',
      'status',
      'statusCode',
      'status_code'
    ]));
    const violationTypeCode = toNumberIfPossible(pickFirstValue(item, [
      'violationType',
      'violation_type',
      'punishType',
      'punish_type',
      'type'
    ]));
    const violationType = String(pickFirstValue(item, [
      'violationTypeStr',
      'violation_type_str',
      'violationType',
      'violation_type',
      'violationTypeDesc',
      'violation_type_desc',
      'punishType',
      'punish_type',
      'punishTypeDesc',
      'punish_type_desc',
      'ruleName',
      'rule_name',
      'sceneName',
      'scene_name',
      'reason',
      'reason_desc'
    ]) || (violationTypeCode !== null ? typeMap[String(violationTypeCode)] : '') || '违规记录');
    const notifyTime = pickFirstValue(item, [
      'createdAt',
      'createTime',
      'gmtCreate',
      'noticeTime',
      'notice_time',
      'violationTime',
      'violation_time',
      'punishTime',
      'punish_time',
      'createdAt',
      'createTime',
      'gmtCreate'
    ]);
    const appealTime = pickFirstValue(item, [
      'appealTime',
      'appeal_time',
      'complaintTime',
      'complaint_time',
      'submitTime',
      'submit_time'
    ]);
    const processTime = pickFirstValue(item, [
      'platformHandleTime',
      'platform_handle_time',
      'processTime',
      'process_time',
      'dealTime',
      'deal_time',
      'updateTime',
      'gmtModified'
    ]);
    const progress = String(pickFirstValue(item, [
      'appealStatusDesc',
      'appeal_status_desc',
      'statusDesc',
      'status_desc',
      'statusText',
      'status_text',
      'processStatus',
      'process_status',
      'processStatusDesc',
      'process_status_desc',
      'currentProgress',
      'current_progress',
      'progress'
    ]) || (statusCode !== null ? VIOLATION_STATUS_TEXT_MAP[statusCode] : '') || '待处理');
    const rawValues = getObjectStringValues(item);
    const extra = buildViolationExtra(item);
    return {
      violationNo,
      violationType,
      notifyTime,
      appealTime,
      processTime,
      progress,
      statusCode,
      summary: [extra.punishMeasures[0] || '', rawValues.slice(0, 6).join(' · ')].filter(Boolean).join(' · '),
      extra,
      raw: item
    };
  }

  function collectViolationRecordCandidates(source, bucket, visited = new Set()) {
    if (!source || typeof source !== 'object') return;
    if (visited.has(source)) return;
    visited.add(source);
    if (Array.isArray(source)) {
      source.forEach(item => collectViolationRecordCandidates(item, bucket, visited));
      return;
    }
    if (looksLikeViolationRecord(source)) {
      bucket.push(source);
    }
    Object.values(source).forEach(value => {
      if (value && typeof value === 'object') {
        collectViolationRecordCandidates(value, bucket, visited);
      }
    });
  }

  function dedupeViolationList(list = []) {
    const seen = new Set();
    return list.filter(item => {
      const key = `${item.violationNo}::${item.violationType}::${item.notifyTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseViolationRecordsFromTraffic(entries = []) {
    const typeMap = {};
    const records = [];
    entries.forEach(entry => {
      const url = String(entry?.fullUrl || entry?.url || '');
      const payload = parseJsonSafely(entry?.responseBody);
      if (!payload) return;
      if (url.includes(VIOLATION_TYPE_URL_KEY) && payload?.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
        Object.entries(payload.result).forEach(([key, value]) => {
          const label = String(value || '').trim();
          if (label) typeMap[String(key)] = label;
        });
      }
    });
    entries.forEach(entry => {
      const url = String(entry?.fullUrl || entry?.url || '');
      const payload = parseJsonSafely(entry?.responseBody);
      if (!payload) return;
      if (url.includes(VIOLATION_RECORD_URL_KEY)) {
        const dataList = Array.isArray(payload?.result?.data) ? payload.result.data : [];
        dataList.forEach((item, index) => {
          records.push(normalizeViolationAppealRecord(item, index, typeMap));
        });
        return;
      }
    });
    if (records.length) {
      violationApiTypeMap = typeMap;
      return dedupeViolationList(records);
    }
    entries.forEach(entry => {
      const payload = parseJsonSafely(entry?.responseBody);
      if (!payload) return;
      const bucket = [];
      collectViolationRecordCandidates(payload, bucket);
      bucket.forEach((item, index) => {
        records.push(normalizeViolationRecord(item, index, typeMap));
      });
    });
    violationApiTypeMap = typeMap;
    return dedupeViolationList(records);
  }

  function getViolationQuickType(item = {}) {
    const statusCode = toNumberIfPossible(item.statusCode);
    if (statusCode !== null) {
      if (VIOLATION_QUICK_STATUS_GROUPS.processing.has(statusCode)) return 'processing';
      if (VIOLATION_QUICK_STATUS_GROUPS.appealing.has(statusCode)) return 'appealing';
      if (VIOLATION_QUICK_STATUS_GROUPS.pending.has(statusCode)) return 'pending';
    }
    const text = `${item.progress || ''} ${item.violationType || ''}`.toLowerCase();
    if (text.includes('平台处理') || text.includes('处理中') || text.includes('审核')) return 'processing';
    if (text.includes('申诉') || text.includes('举证') || text.includes('整改') || text.includes('完善资料')) return 'appealing';
    return 'pending';
  }

  function getViolationQuickCounts() {
    return violationApiList.reduce((acc, item) => {
      const type = getViolationQuickType(item);
      acc[type] += 1;
      return acc;
    }, { pending: 0, appealing: 0, processing: 0 });
  }

  function renderViolationQuickSummary() {
    const counts = getViolationQuickCounts();
    getEl('violationApiQuickPendingCount').textContent = String(counts.pending || 0);
    getEl('violationApiQuickAppealingCount').textContent = String(counts.appealing || 0);
    getEl('violationApiQuickProcessingCount').textContent = String(counts.processing || 0);
    document.querySelectorAll('[data-violation-quick]').forEach(button => {
      button.classList.toggle('active', button.dataset.violationQuick === violationApiQuickFilter);
    });
  }

  function renderViolationFilterOptions() {
    const renderSelect = (id, values, currentValue = '') => {
      const element = getEl(id);
      if (!element) return;
      const options = ['<option value="">全部</option>'].concat(values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`));
      element.innerHTML = options.join('');
      element.value = values.includes(currentValue) ? currentValue : '';
    };
    const getValues = key => Array.from(new Set(violationApiList.map(item => String(item[key] || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    renderSelect('violationApiStatusFilter', getValues('progress'), violationApiStatusFilter);
    renderSelect('violationApiTypeFilter', getValues('violationType'), violationApiTypeFilter);
  }

  function getViolationVisibleList() {
    const keyword = violationApiKeyword.trim().toLowerCase();
    return violationApiList.filter(item => {
      if (violationApiQuickFilter !== 'all' && getViolationQuickType(item) !== violationApiQuickFilter) return false;
      if (violationApiStatusFilter && item.progress !== violationApiStatusFilter) return false;
      if (violationApiTypeFilter && item.violationType !== violationApiTypeFilter) return false;
      if (keyword) {
        const text = `${item.violationNo || ''} ${item.violationType || ''} ${item.summary || ''}`.toLowerCase();
        if (!text.includes(keyword)) return false;
      }
      return true;
    });
  }

  function getViolationProgressClass(progress = '') {
    const text = String(progress).toLowerCase();
    if (text.includes('平台处理') || text.includes('处理中') || text.includes('审核')) return 'is-processing';
    if (text.includes('通过') || text.includes('完成') || text.includes('已解除')) return 'is-success';
    return 'is-pending';
  }

  function formatViolationDisplayValue(value, suffix = '') {
    if (value === undefined || value === null) return '-';
    const text = String(value).trim();
    if (!text) return '-';
    return suffix && !text.endsWith(suffix) ? `${text}${suffix}` : text;
  }

  function getViolationStatusTitle(detail = {}) {
    return detail.progress || detail.violationType || '违规记录';
  }

  function getViolationStatusNotice(detail = {}) {
    const progress = String(detail.progress || '').toLowerCase();
    if (progress.includes('超时')) {
      return '您好，贵店未在申诉截止时间内提交有效申诉材料，平台将依照站内信通知的相应处理措施执行。';
    }
    if (progress.includes('待完善') || progress.includes('举证') || progress.includes('整改')) {
      return '当前记录仍需补充申诉材料，请按平台要求继续完善后提交。';
    }
    if (progress.includes('平台处理') || progress.includes('处理中') || progress.includes('审核')) {
      return '平台已受理当前申诉，请持续关注处理进度与站内通知。';
    }
    if (progress.includes('待申诉')) {
      return '当前记录仍可继续申诉，请在截止时间前准备材料并及时提交。';
    }
    return '请结合违规通知与处罚信息核对当前状态。';
  }

  function getViolationAppealInstruction(detail = {}) {
    const deadline = formatApiDateTime(detail?.extra?.appealEndTime) || '';
    const notice = getViolationStatusNotice(detail);
    if (!deadline || notice.includes(deadline)) return notice;
    return `${notice} 申诉截止时间：${deadline}。`;
  }

  function getViolationRuleText(detail = {}) {
    const extraRaw = ensureObject(detail.extra?.raw);
    const ruleText = pickFirstValue(detail.raw || {}, [
      'ruleDesc',
      'rule_desc',
      'ruleName',
      'rule_name',
      'reasonDesc',
      'reason_desc',
      'reason',
      'punishReason',
      'punish_reason',
      'violationReason',
      'violation_reason'
    ]) || pickFirstValue(extraRaw, [
      'ruleDesc',
      'rule_desc',
      'ruleName',
      'rule_name',
      'reasonDesc',
      'reason_desc',
      'reason',
      'punishReason',
      'punish_reason'
    ]);
    if (ruleText) return String(ruleText);
    if (detail.summary) return String(detail.summary);
    if (detail.violationType) return `${detail.violationType}，请以平台违规通知和处罚规则为准。`;
    return '暂未获取更完整的规则说明，请回到违规页查看平台原始通知。';
  }

  function getViolationDownloadLinks(detail = {}) {
    const linkCandidates = [];
    const rawList = [ensureObject(detail.extra?.raw), ensureObject(detail.raw)];
    const keys = [
      ['orderMmsExcelUrl', '违规订单下载'],
      ['orderExcelUrl', '违规订单下载'],
      ['expressOrderMmsExcelUrl', '快递订单下载'],
      ['expressOrderExcelUrl', '快递订单下载'],
      ['appealTemplateUrl', '申诉模板'],
      ['structureAppealFileUrl', '申诉材料模板']
    ];
    rawList.forEach(raw => {
      keys.forEach(([key, label]) => {
        const url = String(raw?.[key] || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (linkCandidates.some(item => item.url === url)) return;
        linkCandidates.push({ label, url });
      });
    });
    return linkCandidates;
  }

  function getViolationPunishText(detail = {}) {
    const extra = detail.extra || {};
    const lines = [];
    if (Array.isArray(extra.punishMeasures) && extra.punishMeasures.length) {
      extra.punishMeasures.forEach((item, index) => {
        const text = String(item || '').trim();
        if (text) lines.push(`${index + 1}、${text}`);
      });
    }
    if (extra.violationAmountText) lines.push(`处罚金额：${extra.violationAmountText}`);
    if (extra.restrictTypes) lines.push(`限制类型：${extra.restrictTypes}`);
    const rawPunishText = pickFirstValue(detail.raw || {}, [
      'punishDesc',
      'punish_desc',
      'punishReason',
      'punish_reason',
      'punishContent',
      'punish_content',
      'punishmentContent',
      'punishment_content'
    ]);
    if (rawPunishText && !lines.length) lines.push(String(rawPunishText));
    if (!lines.length) return '暂未获取更完整的处罚措施说明，请以平台详情页为准。';
    return lines.join('\n');
  }

  function getViolationActionItems(detail = {}) {
    const detailUrl = buildViolationDetailUrl(detail);
    const appealUrl = buildViolationAppealTargetUrl(detail);
    const downloadLinks = getViolationDownloadLinks(detail);
    const items = [];
    if (detailUrl) {
      items.push({
        label: '平台详情',
        valueHtml: '<span class="violation-api-action-text">已对接</span>'
      });
    }
    if (canViolationAppeal(detail) && appealUrl) {
      items.push({
        label: '申诉入口',
        valueHtml: `<span class="violation-api-action-text">${esc(getViolationAppealButtonText(detail))}</span>`
      });
    }
    if (downloadLinks.length) {
      items.push({
        label: '材料下载',
        valueHtml: downloadLinks.map(item => `<a class="violation-api-link" href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.label)}</a>`).join(' ')
      });
    } else {
      items.push({
        label: '材料下载',
        valueHtml: '当前记录暂无模板或订单下载链接'
      });
    }
    items.push({
      label: '接口对接',
      valueHtml: '已接入违规列表、违规详情与平台申诉页入口'
    });
    return items;
  }

  function mergeViolationDetail(baseDetail = {}, nextRaw = {}) {
    const baseRaw = ensureObject(baseDetail.raw);
    const remoteRaw = ensureObject(nextRaw);
    const mergedRaw = {
      ...baseRaw,
      ...remoteRaw,
      violationInfo: {
        ...ensureObject(baseRaw.violationInfo),
        ...ensureObject(remoteRaw.violationInfo)
      },
      violationNotes: {
        ...ensureObject(baseRaw.violationNotes),
        ...ensureObject(remoteRaw.violationNotes)
      }
    };
    const normalized = normalizeViolationAppealRecord(mergedRaw, 0, violationApiTypeMap);
    return {
      ...baseDetail,
      ...normalized,
      violationNo: normalized.violationNo || baseDetail.violationNo,
      violationType: normalized.violationType || baseDetail.violationType,
      notifyTime: normalized.notifyTime || baseDetail.notifyTime,
      appealTime: normalized.appealTime || baseDetail.appealTime,
      processTime: normalized.processTime || baseDetail.processTime,
      progress: normalized.progress || baseDetail.progress,
      statusCode: normalized.statusCode ?? baseDetail.statusCode,
      summary: normalized.summary || baseDetail.summary || '',
      raw: mergedRaw,
      extra: buildViolationExtra(mergedRaw)
    };
  }

  function updateViolationDetailActionButtons(detail = {}) {
    const detailButton = getEl('btnViolationApiOpenPlatformDetail');
    const appealButton = getEl('btnViolationApiOpenAppeal');
    const detailUrl = buildViolationDetailUrl(detail);
    const appealUrl = buildViolationAppealTargetUrl(detail);
    const showActions = !!detail?.violationNo;
    const showAppeal = showActions && canViolationAppeal(detail);
    if (detailButton) {
      detailButton.style.display = showActions ? '' : 'none';
      detailButton.disabled = !detailUrl;
    }
    if (appealButton) {
      appealButton.style.display = showAppeal ? '' : 'none';
      appealButton.disabled = !appealUrl;
      appealButton.textContent = getViolationAppealButtonText(detail);
    }
  }

  function renderViolationCaseItems(items = []) {
    return `
      <div class="violation-api-case-items">
        ${items.map(item => `
          <div class="violation-api-case-item">
            <div class="violation-api-case-label">${esc(item.label)}</div>
            <div class="violation-api-case-value">${item.valueHtml}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderViolationDetailItems(items = [], options = {}) {
    return `
      <div class="violation-api-detail-grid">
        ${items.map(([label, value]) => `
          <div class="violation-api-detail-item${options.fullLabels?.includes(label) ? ' is-full' : ''}">
            <div class="violation-api-detail-item-label">${esc(label)}</div>
            <div class="violation-api-detail-item-value">${esc(value)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function setViolationApiPageMode(mode, options = {}) {
    violationApiPageMode = mode === 'detail' ? 'detail' : 'list';
    getEl('violationApiListShell')?.classList.toggle('is-hidden', violationApiPageMode !== 'list');
    getEl('violationApiDetailShell')?.classList.toggle('is-hidden', violationApiPageMode !== 'detail');
    const targetId = violationApiPageMode === 'detail' ? 'violationApiDetailShell' : 'violationApiListShell';
    if (options.scroll === false) return;
    getEl(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderViolationApiList() {
    const container = getEl('violationApiList');
    const visibleList = getViolationVisibleList();
    const filterLabels = [];
    if (violationApiQuickFilter === 'pending') filterLabels.push('待申诉');
    if (violationApiQuickFilter === 'appealing') filterLabels.push('待完善资料');
    if (violationApiQuickFilter === 'processing') filterLabels.push('平台处理中');
    if (violationApiStatusFilter) filterLabels.push(`处理进度：${violationApiStatusFilter}`);
    if (violationApiTypeFilter) filterLabels.push(`违规类型：${violationApiTypeFilter}`);
    if (violationApiKeyword) filterLabels.push(`违规单号：${violationApiKeyword}`);
    getEl('violationApiListMeta').textContent = `${visibleList.length} / ${violationApiList.length} 条记录`;
    getEl('violationApiListStatus').textContent = filterLabels.length ? filterLabels.join(' · ') : '当前展示违规管理接口返回结果';
    getEl('violationApiFooterTotal').textContent = `共 ${visibleList.length} 条`;
    if (!visibleList.length) {
      container.innerHTML = '<tr><td colspan="7"><div class="violation-api-table-empty">当前没有违规记录，可直接刷新列表重试。</div></td></tr>';
      return;
    }
    container.innerHTML = visibleList.map(item => {
      const active = String(item.violationNo) === String(violationApiActiveId);
      const actionText = canViolationAppeal(item) ? getViolationAppealActionText(item) : '';
      return `
        <tr class="${active ? 'active' : ''}" data-violation-id="${esc(item.violationNo)}">
          <td class="invoice-api-cell-em" title="${esc(item.violationNo || '-')}">${esc(item.violationNo || '-')}</td>
          <td title="${esc(item.violationType || '-')}">${esc(item.violationType || '-')}</td>
          <td>${esc(formatApiDateTime(item.notifyTime) || '-')}</td>
          <td>${esc(formatApiDateTime(item.appealTime) || '-')}</td>
          <td>${esc(formatApiDateTime(item.processTime) || '-')}</td>
          <td><span class="violation-api-progress ${getViolationProgressClass(item.progress)}">${esc(item.progress || '-')}</span></td>
          <td>
            <div class="violation-api-row-actions">
              <button class="violation-api-action-link" data-violation-detail="${esc(item.violationNo)}">查看详情</button>
              ${actionText ? `<button class="violation-api-action-link" data-violation-appeal="${esc(item.violationNo)}">${esc(actionText)}</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
    container.querySelectorAll('[data-violation-id]').forEach(row => {
      row.addEventListener('click', async event => {
        if (event.target.closest('button')) return;
        await openViolationApiDetail(row.dataset.violationId, { skipTraffic: true });
      });
    });
    container.querySelectorAll('[data-violation-detail]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        await openViolationApiDetail(button.dataset.violationDetail, { skipTraffic: true });
      });
    });
    container.querySelectorAll('[data-violation-appeal]').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        const detail = violationApiList.find(item => String(item.violationNo) === String(button.dataset.violationAppeal));
        await openViolationPlatformPage(detail, { mode: 'appeal' });
      });
    });
  }

  function renderViolationApiDetail() {
    const head = getEl('violationApiDetailHead');
    const panel = getEl('violationApiDetailPanel');
    const breadcrumb = getEl('violationApiDetailBreadcrumb');
    if (!violationApiActiveDetail?.violationNo) {
      if (breadcrumb) breadcrumb.textContent = '店铺违规管理';
      updateViolationDetailActionButtons();
      head.innerHTML = `
        <div class="mail-api-detail-title">请选择一条违规记录</div>
        <div class="mail-api-detail-meta"><span>违规编号：-</span><span>违规时间：-</span></div>
      `;
      panel.innerHTML = '<div class="invoice-api-detail-empty">请选择一条违规记录查看详情</div>';
      return;
    }
    if (breadcrumb) breadcrumb.textContent = `店铺违规管理 > ${getViolationStatusTitle(violationApiActiveDetail)}`;
    updateViolationDetailActionButtons(violationApiActiveDetail);
    const progressClass = getViolationProgressClass(violationApiActiveDetail.progress);
    const progressIcon = progressClass === 'is-success' ? '✓' : progressClass === 'is-processing' ? '!' : '×';
    head.innerHTML = `
      <div class="mail-api-detail-title">${esc(violationApiActiveDetail.violationType || '违规详情')}</div>
      <div class="mail-api-detail-meta">
        <span>违规编号：${esc(violationApiActiveDetail.violationNo || '-')}</span>
        <span>违规通知时间：${esc(formatApiDateTime(violationApiActiveDetail.notifyTime) || '-')}</span>
        <span>申诉截止时间：${esc(formatApiDateTime(violationApiActiveDetail.extra?.appealEndTime) || '-')}</span>
      </div>
    `;
    const extra = violationApiActiveDetail.extra || {};
    const orderCountText = extra.violationOrderCount ? formatViolationDisplayValue(extra.violationOrderCount, '单') : '-';
    const infoItems = [
      { label: '违规编号', valueHtml: esc(violationApiActiveDetail.violationNo || '-') },
      { label: '违规类型', valueHtml: esc(violationApiActiveDetail.violationType || '-') },
      { label: '违规时间', valueHtml: esc(formatApiDateTime(violationApiActiveDetail.notifyTime) || '-') },
      { label: '申诉时间', valueHtml: esc(formatApiDateTime(violationApiActiveDetail.appealTime) || '-') },
      { label: '平台处理时间', valueHtml: esc(formatApiDateTime(violationApiActiveDetail.processTime) || '-') },
      { label: '违规单量', valueHtml: esc(orderCountText) },
      { label: '处罚金额', valueHtml: esc(extra.violationAmountText || '-') },
      { label: '规则说明', valueHtml: esc(getViolationRuleText(violationApiActiveDetail)) }
    ];
    const actionItems = getViolationActionItems(violationApiActiveDetail);
    panel.innerHTML = `
      <div class="violation-api-detail-section">
        <div class="violation-api-detail-section-title">提交申诉说明</div>
        <div class="violation-api-detail-note">${esc(getViolationAppealInstruction(violationApiActiveDetail))}</div>
      </div>
      <div class="violation-api-detail-section">
        <div class="violation-api-detail-section-head">
          <div class="violation-api-detail-section-title">违规信息</div>
        </div>
        <div class="violation-api-status-card">
          <div class="violation-api-status-icon ${progressClass}">${esc(progressIcon)}</div>
          <div class="violation-api-status-main">
            <div class="violation-api-status-title">${esc(getViolationStatusTitle(violationApiActiveDetail))}</div>
            <div class="violation-api-status-desc">${esc(getViolationStatusNotice(violationApiActiveDetail))}</div>
          </div>
        </div>
        <div class="violation-api-case-card">
          <div class="violation-api-case-grid">
            <div class="violation-api-case-column">
              <div class="violation-api-case-title">违规信息</div>
              ${renderViolationCaseItems(infoItems)}
            </div>
            <div class="violation-api-case-column">
              <div class="violation-api-case-title">处罚措施</div>
              <div class="violation-api-punish-text">${esc(getViolationPunishText(violationApiActiveDetail))}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="violation-api-detail-section">
        <div class="violation-api-detail-section-title">申诉入口与资料</div>
        <div class="violation-api-case-card">
          <div class="violation-api-case-grid">
            <div class="violation-api-case-column">
              <div class="violation-api-case-title">已对接能力</div>
              ${renderViolationCaseItems(actionItems)}
            </div>
            <div class="violation-api-case-column">
              <div class="violation-api-case-title">当前说明</div>
              <div class="violation-api-punish-text">已接入违规列表、违规详情与平台申诉页入口。保存草稿、提交申诉和上传材料接口仍以平台原页为准，当前页面先承接查看、下载与跳转。</div>
            </div>
          </div>
        </div>
      </div>
      ${violationApiDetailLoading ? '<div class="violation-api-detail-hint">正在补充违规详情接口数据…</div>' : ''}
      ${violationApiDetailError ? `<div class="violation-api-detail-error">${esc(violationApiDetailError)}</div>` : ''}
    `;
  }

  function renderViolationApiTraffic() {
    const container = getEl('violationApiTrafficList');
    const summary = getEl('violationApiTrafficSummary');
    if (!container || !summary) return;
    summary.textContent = `${violationApiEntries.length} 条抓包记录`;
    if (!violationApiEntries.length) {
      container.innerHTML = '<span class="mail-api-traffic-chip">暂无抓包</span>';
      return;
    }
    container.innerHTML = violationApiEntries.slice(0, 12).map(entry => {
      const typeTag = getViolationTrafficType(entry);
      const summary = `${typeTag} · ${entry.method || 'GET'} ${entry.url}`;
      return `<span class="mail-api-traffic-chip" title="${esc(summary)}">${esc(summary)}</span>`;
    }).join('');
  }

  function updateViolationApiBannerText() {
    const banner = getEl('violationApiBannerText');
    if (!banner) return;
    if (!activeShopId) {
      banner.textContent = '当前没有活跃店铺，请先切换店铺后再查看违规管理接口页。';
      return;
    }
    if (violationApiList.length && !violationApiEntries.length) {
      banner.textContent = `已直接请求违规列表，当前加载 ${violationApiList.length} 条违规数据；详情与申诉入口已整理到详情页。`;
      return;
    }
    if (!violationApiEntries.length) {
      banner.textContent = '正在优先通过接口直接加载违规列表；详情页已接入查看、下载与申诉页入口。';
      return;
    }
    banner.textContent = `已直接加载 ${violationApiList.length} 条违规数据，申诉入口与资料下载已整理到详情页。`;
  }

  async function loadViolationApiTraffic(shopId = activeShopId) {
    if (!shopId) {
      violationApiEntries = [];
      renderViolationApiTraffic();
      updateViolationApiBannerText();
      return;
    }
    const list = await window.pddApi.getApiTraffic({ shopId });
    violationApiEntries = Array.isArray(list) ? list.slice().reverse().filter(isViolationTrafficEntry) : [];
    renderViolationApiTraffic();
    updateViolationApiBannerText();
  }

  function renderViolationApiState() {
    renderViolationFilterOptions();
    renderViolationQuickSummary();
    renderViolationApiList();
    updateViolationApiBannerText();
    const visibleList = getViolationVisibleList();
    if (violationApiActiveId && visibleList.some(item => String(item.violationNo) === String(violationApiActiveId))) {
      violationApiActiveDetail = visibleList.find(item => String(item.violationNo) === String(violationApiActiveId)) || violationApiActiveDetail;
      renderViolationApiList();
      renderViolationApiDetail();
      setViolationApiPageMode(violationApiPageMode, { scroll: false });
      return;
    }
    violationApiActiveId = '';
    violationApiActiveDetail = null;
    violationApiDetailLoading = false;
    violationApiDetailError = '';
    renderViolationApiDetail();
    setViolationApiPageMode('list', { scroll: false });
  }

  async function loadViolationApiList(options = {}) {
    let remoteLoaded = false;
    let remoteError = '';
    if (activeShopId && typeof window.pddApi.violationGetList === 'function') {
      const result = await window.pddApi.violationGetList({
        shopId: activeShopId,
        pageNo: 1,
        pageSize: 100
      });
      if (result && !result.error) {
        const nextTypeMap = result?.typeMap && typeof result.typeMap === 'object' ? result.typeMap : {};
        violationApiTypeMap = Object.keys(nextTypeMap).length ? nextTypeMap : {};
        const rawList = Array.isArray(result.list) ? result.list : [];
        violationApiList = dedupeViolationList(rawList.map((item, index) => normalizeViolationAppealRecord(item, index, violationApiTypeMap)));
        remoteLoaded = true;
      } else {
        remoteError = result?.error || '加载违规管理列表失败';
      }
    }
    if (!remoteLoaded) {
      violationApiList = parseViolationRecordsFromTraffic(violationApiEntries);
      if (remoteError && options.silentError !== true) {
        addLog(`${remoteError}，已回退到抓包解析结果`, 'error');
      }
    }
    renderViolationApiState();
  }

  async function loadViolationApiDetail(options = {}) {
    if (!violationApiActiveDetail?.violationNo || !activeShopId || typeof window.pddApi.violationGetDetail !== 'function') return;
    const violationAppealSn = getViolationAppealSn(violationApiActiveDetail);
    if (!violationAppealSn) return;
    violationApiDetailLoading = true;
    violationApiDetailError = '';
    renderViolationApiDetail();
    const result = await window.pddApi.violationGetDetail({
      shopId: activeShopId,
      violationAppealSn,
      violationType: getViolationTypeCode(violationApiActiveDetail) ?? ''
    });
    if (!violationApiActiveDetail || String(violationApiActiveId) !== String(violationApiActiveDetail.violationNo)) return;
    violationApiDetailLoading = false;
    if (result && !result.error && result.detail && typeof result.detail === 'object') {
      violationApiActiveDetail = mergeViolationDetail(violationApiActiveDetail, result.detail);
      violationApiList = violationApiList.map(item => (
        String(item.violationNo) === String(violationApiActiveDetail.violationNo)
          ? violationApiActiveDetail
          : item
      ));
      violationApiDetailError = '';
      renderViolationApiList();
      renderViolationApiDetail();
      return;
    }
    violationApiDetailError = result?.error || '当前未抓到详情接口完整返回，已使用列表字段展示。';
    renderViolationApiDetail();
    if (options.silentError !== true && result?.error) {
      addLog(`${result.error}，已继续使用列表字段展示`, 'error');
    }
  }

  async function openViolationUrl(url, successMessage = '') {
    if (!url) return false;
    const switched = await window.pddApi.switchView('violation');
    if (!switched) {
      addLog('切换违规页失败，请检查当前店铺是否可用。', 'error');
      return false;
    }
    const navigated = await window.pddApi.navigatePdd(url);
    if (!navigated) {
      addLog('打开违规页面失败，请刷新违规页后重试。', 'error');
      return false;
    }
    if (successMessage) {
      addLog(successMessage, 'info');
    }
    return true;
  }

  async function openViolationPlatformPage(detail = violationApiActiveDetail, options = {}) {
    if (!detail?.violationNo) return;
    const url = options.mode === 'appeal' ? buildViolationAppealTargetUrl(detail) : buildViolationDetailUrl(detail);
    if (!url) {
      addLog(options.mode === 'appeal' ? '当前记录缺少申诉页参数，暂时无法打开平台申诉页。' : '当前记录缺少违规详情页参数，暂时无法打开平台详情。', 'error');
      return;
    }
    await openViolationUrl(url, options.mode === 'appeal' ? '已切到平台申诉页' : '');
  }

  async function syncViolationNavTabs() {
    let currentUrl = '';
    if (typeof window.pddApi.getCurrentUrl === 'function') {
      currentUrl = await window.pddApi.getCurrentUrl();
    }
    if (!currentUrl && typeof window.pddApi.getViolationUrl === 'function') {
      currentUrl = await window.pddApi.getViolationUrl();
    }
    renderViolationNavTabs(getViolationMatchedNavKey(currentUrl));
  }

  async function openViolationNavigationTab(tabKey) {
    const config = VIOLATION_NAV_TABS[tabKey];
    if (!config?.url) return;
    renderViolationNavTabs(tabKey);
    if (typeof window.pddApi.setViolationUrl === 'function') {
      await window.pddApi.setViolationUrl(config.url);
    }
    const opened = await openViolationUrl(config.url, `已打开${config.label}`);
    if (!opened) {
      await syncViolationNavTabs();
    }
  }

  async function openViolationApiDetail(violationNo, options = {}) {
    if (!violationNo) return;
    violationApiActiveId = String(violationNo);
    violationApiActiveDetail = violationApiList.find(item => String(item.violationNo) === String(violationNo)) || null;
    violationApiDetailLoading = false;
    violationApiDetailError = '';
    renderViolationApiList();
    renderViolationApiDetail();
    setViolationApiPageMode(violationApiActiveDetail ? 'detail' : 'list', { scroll: options.scroll !== false });
    if (!options.skipTraffic) {
      await loadViolationApiTraffic();
    }
    if (violationApiActiveDetail) {
      await loadViolationApiDetail({ silentError: options.silentError === true });
    }
  }

  function resetViolationApiState() {
    violationApiEntries = [];
    violationApiList = [];
    violationApiTypeMap = {};
    violationApiKeyword = '';
    violationApiStatusFilter = '';
    violationApiTypeFilter = '';
    violationApiQuickFilter = 'all';
    violationApiActiveId = '';
    violationApiActiveDetail = null;
    violationApiPageMode = 'list';
    violationApiDetailLoading = false;
    violationApiDetailError = '';
    const keyword = getEl('violationApiKeyword');
    if (keyword) keyword.value = '';
    ['violationApiStatusFilter', 'violationApiTypeFilter'].forEach(id => {
      const element = getEl(id);
      if (element) element.value = '';
    });
    renderViolationFilterOptions();
    renderViolationQuickSummary();
    renderViolationApiList();
    renderViolationApiDetail();
    renderViolationApiTraffic();
    updateViolationApiBannerText();
    setViolationApiPageMode('list', { scroll: false });
  }

  async function loadViolationApiView() {
    await refreshShopContext();
    await syncViolationNavTabs();
    if (!activeShopId) {
      resetViolationApiState();
      return;
    }
    await loadViolationApiTraffic(activeShopId);
    await loadViolationApiList();
  }

  function bindViolationApiModule() {
    if (initialized) return;
    initialized = true;
    getEl('btnViolationApiOpenDebug')?.addEventListener('click', () => window.pddApi.openDebugWindow());
    getEl('btnViolationApiRefreshPage')?.addEventListener('click', () => window.pddApi.reloadPdd());
    getEl('btnViolationApiReloadTraffic')?.addEventListener('click', async () => {
      await loadViolationApiTraffic();
      updateViolationApiBannerText();
      addLog('已刷新违规管理抓包记录', 'info');
    });
    getEl('btnViolationApiRefreshList')?.addEventListener('click', async () => {
      await loadViolationApiTraffic();
      await loadViolationApiList();
      addLog('已刷新违规管理列表', 'info');
    });
    getEl('btnViolationApiClearTraffic')?.addEventListener('click', async () => {
      const shopId = activeShopId || API_ALL_SHOPS;
      await window.pddApi.clearApiTraffic({ shopId });
      await loadViolationApiTraffic();
      updateViolationApiBannerText();
      addLog('已清空当前范围的违规管理抓包记录', 'info');
    });
    getEl('btnViolationApiBackToViolation')?.addEventListener('click', () => switchView('violation'));
    getEl('btnViolationApiBackToList')?.addEventListener('click', () => setViolationApiPageMode('list'));
    getEl('btnViolationApiOpenPlatformDetail')?.addEventListener('click', async () => {
      await openViolationPlatformPage();
    });
    getEl('btnViolationApiOpenAppeal')?.addEventListener('click', async () => {
      await openViolationPlatformPage(violationApiActiveDetail, { mode: 'appeal' });
    });
    document.querySelectorAll('[data-violation-nav-tab]').forEach(tab => {
      tab.addEventListener('click', async () => {
        const tabKey = tab.dataset.violationNavTab || 'shop';
        await openViolationNavigationTab(tabKey);
      });
    });
    getEl('btnViolationApiApplyFilters')?.addEventListener('click', async () => {
      violationApiKeyword = getEl('violationApiKeyword').value || '';
      await loadViolationApiList();
    });
    getEl('btnViolationApiResetFilters')?.addEventListener('click', async () => {
      violationApiKeyword = '';
      violationApiStatusFilter = '';
      violationApiTypeFilter = '';
      violationApiQuickFilter = 'all';
      const keyword = getEl('violationApiKeyword');
      if (keyword) keyword.value = '';
      ['violationApiStatusFilter', 'violationApiTypeFilter'].forEach(id => {
        const element = getEl(id);
        if (element) element.value = '';
      });
      renderViolationQuickSummary();
      await loadViolationApiList();
    });
    document.querySelectorAll('[data-violation-quick]').forEach(button => {
      button.addEventListener('click', async () => {
        const nextFilter = button.dataset.violationQuick || 'all';
        if (nextFilter === violationApiQuickFilter) return;
        violationApiQuickFilter = nextFilter;
        renderViolationQuickSummary();
        await loadViolationApiList();
      });
    });
    getEl('violationApiStatusFilter')?.addEventListener('change', async event => {
      violationApiStatusFilter = event.target.value || '';
      await loadViolationApiList();
    });
    getEl('violationApiTypeFilter')?.addEventListener('change', async event => {
      violationApiTypeFilter = event.target.value || '';
      await loadViolationApiList();
    });
    getEl('violationApiKeyword')?.addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      violationApiKeyword = getEl('violationApiKeyword').value || '';
      await loadViolationApiList();
    });
  }

  window.loadViolationApiView = loadViolationApiView;

  if (typeof window.registerRendererModule === 'function') {
    window.registerRendererModule('violation-api-module', bindViolationApiModule);
  } else {
    bindViolationApiModule();
  }
})();
