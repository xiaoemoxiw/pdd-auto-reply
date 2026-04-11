(function () {
  const MODAL_ID = 'modalOpsAfterSaleApproveReturnGoods';
  const DEFAULT_MESSAGE = '请确保商品不影响二次销售（质量问题除外）\n寄回商品，不要邮寄到付，并快递单保留';
  const MUNICIPALITIES = ['北京市', '上海市', '天津市', '重庆市'];
  let mounted = false;
  let state = {
    mode: 'common',
    context: null,
    commonAddresses: [],
  };
  const regionCache = new Map();
  const refundAddressCache = new Map();
  let lastAutoFillKey = '';
  let submitting = false;

  function getEl(id) {
    return document.getElementById(id);
  }

  function ensureMounted() {
    if (mounted) return;
    mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="modal ops-aftersale-approve-return-modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3>同意退货</h3>
          <button class="modal-close" type="button" data-ops-close="1">&times;</button>
        </div>
        <div class="modal-body ops-aftersale-approve-return-body">
          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label"><span class="ops-aftersale-approve-return-required">*</span>退货地址</div>
            <div class="ops-aftersale-approve-return-tabs" role="tablist" aria-label="退货地址">
              <label class="ops-aftersale-approve-return-tab" data-mode="common">
                <input type="radio" name="opsAftersaleReturnAddrMode" value="common" checked>
                <span class="ops-aftersale-approve-return-tab-text">常用地址</span>
              </label>
              <label class="ops-aftersale-approve-return-tab" data-mode="temp">
                <input type="radio" name="opsAftersaleReturnAddrMode" value="temp">
                <span class="ops-aftersale-approve-return-tab-text">临时地址</span>
              </label>
            </div>
          </div>

          <div class="ops-aftersale-approve-return-section" data-mode="common">
            <div class="ops-aftersale-approve-return-row">
              <div class="ops-aftersale-approve-return-label"></div>
              <div class="ops-aftersale-approve-return-control">
                <div class="ops-aftersale-approve-return-common-line">
                  <select class="ops-aftersale-approve-return-select" id="opsAftersaleReturnCommonSelect" data-field="commonSelect">
                    <option value="" selected disabled>请选择常用地址</option>
                  </select>
                </div>
                <div class="ops-aftersale-approve-return-hint">地址规范：XX省 XX市 XX区(县)乡镇 XX街道/路/村 XX门牌号</div>
                <div class="ops-aftersale-approve-return-error" id="opsAftersaleReturnCommonError" hidden>请选择</div>
              </div>
            </div>
          </div>

          <div class="ops-aftersale-approve-return-section" data-mode="temp" hidden>
            <div class="ops-aftersale-approve-return-row">
              <div class="ops-aftersale-approve-return-label"></div>
              <div class="ops-aftersale-approve-return-control">
                <div class="ops-aftersale-approve-return-addr-selects">
                  <select class="ops-aftersale-approve-return-select" id="opsAftersaleReturnProvince">
                    <option value="" selected disabled>请选择省</option>
                  </select>
                  <select class="ops-aftersale-approve-return-select" id="opsAftersaleReturnCity" disabled>
                    <option value="" selected disabled>请选择市</option>
                  </select>
                  <select class="ops-aftersale-approve-return-select" id="opsAftersaleReturnDistrict" disabled>
                    <option value="" selected disabled>请选择区/县</option>
                  </select>
                </div>
                <div class="ops-aftersale-approve-return-error" id="opsAftersaleReturnRegionError" hidden>请选择</div>
                <textarea class="ops-aftersale-approve-return-textarea" id="opsAftersaleReturnDetailAddress" placeholder="请您按照规范格式填写精确的详细地址" data-field="detailAddress"></textarea>
                <div class="ops-aftersale-approve-return-hint">地址规范：XX省 XX市 XX区(县)乡镇 XX街道/路/村 XX门牌号</div>
              </div>
            </div>
          </div>

          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label"><span class="ops-aftersale-approve-return-required">*</span>收件人</div>
            <div class="ops-aftersale-approve-return-control">
              <input class="ops-aftersale-approve-return-input" id="opsAftersaleReturnReceiver" placeholder="请输入收件人姓名">
            </div>
          </div>

          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label"><span class="ops-aftersale-approve-return-required">*</span>联系电话</div>
            <div class="ops-aftersale-approve-return-control">
              <input class="ops-aftersale-approve-return-input" id="opsAftersaleReturnPhone" placeholder="请填写联系电话">
            </div>
          </div>

          <div class="ops-aftersale-approve-return-row">
            <div class="ops-aftersale-approve-return-label"><span class="ops-aftersale-approve-return-required">*</span>留言</div>
            <div class="ops-aftersale-approve-return-control">
              <textarea class="ops-aftersale-approve-return-textarea" id="opsAftersaleReturnMessage"></textarea>
              <div class="ops-aftersale-approve-return-hint">请勿将退货地址填写在留言中，否则店铺将违规</div>
            </div>
          </div>
        </div>
        <div class="modal-footer ops-aftersale-approve-return-footer">
          <button class="ops-aftersale-btn" type="button" id="btnOpsAftersaleReturnConfirm">确认</button>
          <button class="ops-aftersale-approve-return-cancel" type="button" data-ops-close="1">取消</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeDialog();
    });

    overlay.querySelectorAll('[data-ops-close="1"]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog());
    });

    overlay.querySelectorAll('input[name="opsAftersaleReturnAddrMode"]').forEach(input => {
      input.addEventListener('change', () => {
        const mode = String(input.value || '').trim();
        if (!mode) return;
        setMode(mode);
      });
    });

    overlay.querySelector('#opsAftersaleReturnCommonSelect')?.addEventListener('change', () => {
      const selectedId = readValue('opsAftersaleReturnCommonSelect');
      const list = Array.isArray(state?.commonAddresses) ? state.commonAddresses : [];
      const selected = list.find(item => String(item?.id || '').trim() === selectedId);
      if (!selected) return;
      const receiverEl = getEl('opsAftersaleReturnReceiver');
      const phoneEl = getEl('opsAftersaleReturnPhone');
      if (receiverEl) receiverEl.value = String(selected?.refundName || '').trim();
      if (phoneEl) phoneEl.value = String(selected?.refundPhone || '').trim();
      setInvalid('opsAftersaleReturnCommonSelect', false, 'opsAftersaleReturnCommonError');
    });

    overlay.querySelector('#btnOpsAftersaleReturnConfirm')?.addEventListener('click', () => {
      handleConfirm();
    });

    overlay.querySelector('#opsAftersaleReturnProvince')?.addEventListener('change', () => {
      loadCities();
    });
    overlay.querySelector('#opsAftersaleReturnCity')?.addEventListener('change', () => {
      loadDistricts();
    });

    overlay.querySelector('#opsAftersaleReturnDetailAddress')?.addEventListener('paste', () => {
      setTimeout(() => {
        tryAutofillContactFromDetailAddress();
      }, 0);
    });
    overlay.querySelector('#opsAftersaleReturnDetailAddress')?.addEventListener('input', () => {
      tryAutofillContactFromDetailAddress();
    });

    document.body.appendChild(overlay);
  }

  function setMode(mode) {
    state.mode = mode === 'temp' ? 'temp' : 'common';
    syncModeVisibility();
    if (state.mode === 'common') {
      ensureCommonAddresses();
    }
    if (state.mode === 'temp') {
      ensureProvinces();
      setTimeout(() => {
        const el = getEl('opsAftersaleReturnDetailAddress');
        el?.focus?.();
      }, 0);
      tryReadClipboardAndAutofill();
    }
  }

  function normalizeDigits(text) {
    return String(text || '').replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248));
  }

  function normalizeRegionText(text) {
    return normalizeDigits(text)
      .replace(/\u00A0/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/["'“”‘’]/g, '')
      .replace(/[（）()\[\]【】]/g, ' ')
      .replace(/[,:：，;；。]/g, ' ')
      .replace(/\s+/g, '')
      .trim();
  }

  function stripRegionSuffix(name) {
    return String(name || '')
      .replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市|地区|自治州|盟|县|区)$/g, '')
      .trim();
  }

  function isProvinceLike(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (/(自治区|特别行政区|省)$/.test(n)) return true;
    return MUNICIPALITIES.includes(n);
  }

  function isCityLike(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (MUNICIPALITIES.includes(n)) return true;
    return /(市|自治州|地区|盟)$/.test(n);
  }

  function isDistrictLike(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    return /(区|县|旗|市)$/.test(n);
  }

  function filterByLevel(list, predicate) {
    if (!Array.isArray(list) || !list.length) return [];
    const filtered = list.filter(item => predicate(String(item?.name || '').trim()));
    return filtered.length ? filtered : list;
  }

  function getRegionMatchLen(name, textNorm) {
    const full = normalizeRegionText(name);
    const short = normalizeRegionText(stripRegionSuffix(name));
    let best = 0;
    if (full && textNorm.includes(full)) best = Math.max(best, full.length);
    if (short && textNorm.includes(short)) best = Math.max(best, short.length);
    return best;
  }

  function findBestRegionMatch(list, textNorm, opts) {
    if (!Array.isArray(list) || !list.length || !textNorm) return null;
    const excludeNorms = new Set((opts?.excludeNorms || []).map(s => String(s || '').trim()).filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const item of list) {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      if (!id || !name) continue;
      const full = normalizeRegionText(name);
      const short = normalizeRegionText(stripRegionSuffix(name));
      const variants = [];
      if (full) variants.push({ v: full, bonus: 1 });
      if (short && short !== full) variants.push({ v: short, bonus: 0 });
      for (const { v, bonus } of variants) {
        if (!v) continue;
        const role = String(opts?.role || '').trim();
        if ((role === 'district' || role === 'city') && v.length < 2) continue;
        if (excludeNorms.has(v)) continue;
        if (!textNorm.includes(v)) continue;
        let score = v.length * 10 + bonus;
        if (role === 'district') {
          if (/(开发区|高新区|新区|工业园区|产业园区|经开区)/.test(name)) score -= 50;
          if (textNorm.includes(v + '区') || textNorm.includes(v + '县') || textNorm.includes(v + '旗')) score += 30;
        } else if (role === 'city') {
          if (/(自治州|地区|盟)$/.test(name)) score += 5;
        }
        if (score > bestScore) {
          bestScore = score;
          best = { id, name, matchLen: v.length };
        }
      }
    }
    return best;
  }

  function getSelectedOptionName(select) {
    const opt = select?.selectedOptions?.[0];
    return opt ? String(opt.textContent || '').trim() : '';
  }

  function cleanupReceiverName(name) {
    let s = String(name || '').trim();
    s = s.replace(/[：:]+$/g, '').trim();
    s = s.replace(/^(收件人|收货人|联系人|姓名)\s*[:：]?\s*/g, '').trim();
    s = s.replace(/[，,;；。]+$/g, '').trim();
    if (/(手机|电话|号码|所在地区|详细地址|地址)/.test(s)) return '';
    return s;
  }

  function extractDetailAddressFromText(text) {
    const raw = normalizeDigits(text).replace(/\u00A0/g, ' ');
    const lines = raw.split(/\r?\n/).map(s => String(s || '').trim()).filter(Boolean);
    const addressLike = /(路|街|道|巷|号|栋|单元|室|楼|村|镇|乡|小区|园|大厦|广场|门口|屯|组|开发区)/;
    for (const line of lines) {
      const m = line.match(/(?:详细地址)\s*[:：]?\s*(.+)$/);
      const v = String(m?.[1] || '').trim();
      if (v) return v;
    }
    for (const line of lines) {
      if (line.includes('所在地区') || line.includes('退货地址')) continue;
      if (!line.includes('地址')) continue;
      if (line.includes('商家地址')) continue;
      const m = line.match(/(?:地址)\s*[:：]?\s*(.+)$/);
      const v = String(m?.[1] || '').trim();
      if (!v) continue;
      const hasPhoneLike = /(?:\+?86[-\s]?)?(1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})/.test(v);
      if (hasPhoneLike && !addressLike.test(v)) continue;
      if (v) return v;
    }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!addressLike.test(line)) continue;
      if (/(收件人|收货人|联系人|姓名|手机|电话|号码|所在地区)/.test(line)) continue;
      return line;
    }
    return '';
  }

  function cleanupDetailByRegion(detail, region) {
    let s = String(detail || '').trim();
    if (!s) return '';
    const names = [
      String(region?.provinceName || '').trim(),
      String(region?.cityName || '').trim(),
      String(region?.districtName || '').trim()
    ].filter(Boolean);
    const variants = [];
    for (const n of names) {
      variants.push(n);
      const short = stripRegionSuffix(n);
      if (short && short !== n && short.length >= 2) variants.push(short);
    }
    for (const n of variants) {
      if (!n) continue;
      if (s.startsWith(n)) {
        s = s.slice(n.length).trim();
        const nextCh = s.slice(0, 1);
        if (nextCh && (nextCh === '市' || nextCh === '区' || nextCh === '县' || nextCh === '旗') && !String(n).endsWith(nextCh)) {
          s = s.slice(1).trim();
        }
      }
    }
    const cityName = String(region?.cityName || '').trim();
    const districtName = String(region?.districtName || '').trim();
    const cityShort = stripRegionSuffix(cityName);
    const districtShort = stripRegionSuffix(districtName);
    for (let i = 0; i < 3; i += 1) {
      const before = s;
      if (cityName && districtName && s.startsWith(cityName + districtName)) s = s.slice((cityName + districtName).length).trim();
      if (cityShort && districtShort && s.startsWith(cityShort + districtShort)) s = s.slice((cityShort + districtShort).length).trim();
      if (cityName && s.startsWith(cityName)) s = s.slice(cityName.length).trim();
      if (cityShort && s.startsWith(cityShort)) s = s.slice(cityShort.length).trim();
      if (districtName && s.startsWith(districtName)) s = s.slice(districtName.length).trim();
      if (districtShort && s.startsWith(districtShort)) s = s.slice(districtShort.length).trim();
      s = s.replace(/^[\s,，:：]+/g, '').trim();
      if (s === before) break;
    }
    s = s.replace(/^[\s,，:：]+/g, '').trim();
    return s;
  }

  function cleanupDetailByContact(detail, receiver, phone) {
    let s = String(detail || '').trim();
    if (!s) return '';
    s = s.replace(/^(商家地址|地址|收货地址|收件地址)\s*[:：]?\s*/g, '').trim();

    const phoneDigits = String(phone || '').replace(/[^\d]/g, '');
    if (phoneDigits) {
      const idx = s.indexOf(phoneDigits);
      if (idx >= 0 && idx < 80) {
        s = s.slice(idx + phoneDigits.length).trim();
      } else {
        const m = s.match(/(?:\+?86[-\s]?)?(1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})/);
        if (m && typeof m.index === 'number' && m.index < 80) {
          s = s.slice(m.index + String(m[0]).length).trim();
        }
      }
    }

    const receiverClean = cleanupReceiverName(receiver);
    if (receiverClean && s.startsWith(receiverClean)) {
      s = s.slice(receiverClean.length).trim();
    }

    s = s.replace(/^[\s,，:：;；。-]+/g, '').trim();
    return s;
  }

  function cleanupDetailAddress(detail, ctx) {
    const receiver = ctx?.receiver || '';
    const phone = ctx?.phone || '';
    const region = ctx?.region || null;
    let s = cleanupDetailByContact(detail, receiver, phone);
    s = cleanupDetailByRegion(s, region);
    return s;
  }

  async function matchRegionChainFromText(shopId, textNorm) {
    const provincesRaw = await fetchRegionList(shopId, 0);
    if (!provincesRaw.length) return null;
    const provinces = filterByLevel(provincesRaw, isProvinceLike);

    const scoredProvinces = provinces
      .map(p => ({ p, score: getRegionMatchLen(p?.name, textNorm) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const candidates = scoredProvinces.length ? scoredProvinces.map(x => x.p) : provinces.slice(0, 8);
    let best = null;
    let bestScore = -1;

    for (const p of candidates) {
      const provinceId = String(p?.id || '').trim();
      const provinceName = String(p?.name || '').trim();
      if (!provinceId) continue;
      const provinceMatch = getRegionMatchLen(provinceName, textNorm);
      if (!provinceMatch && scoredProvinces.length) continue;

      const citiesRaw = await fetchRegionList(shopId, provinceId);
      const shouldAllowSameNameCity = MUNICIPALITIES.includes(provinceName);
      const hasExplicitCityLevel = Array.isArray(citiesRaw) && citiesRaw.some(item => isCityLike(String(item?.name || '').trim()));

      let city = null;
      let district = null;

      if (shouldAllowSameNameCity && !hasExplicitCityLevel) {
        city = { id: provinceId, name: provinceName, matchLen: provinceMatch || 0 };
        const districts = filterByLevel(citiesRaw, isDistrictLike);
        district = findBestRegionMatch(districts, textNorm, {
          excludeNorms: [
            normalizeRegionText(provinceName),
            normalizeRegionText(stripRegionSuffix(provinceName))
          ],
          role: 'district'
        });
      } else {
        const cities = filterByLevel(citiesRaw, isCityLike);
        city = findBestRegionMatch(cities, textNorm, {
          excludeNorms: shouldAllowSameNameCity ? [] : [normalizeRegionText(provinceName), normalizeRegionText(stripRegionSuffix(provinceName))],
          role: 'city'
        });
        if (city?.id) {
          const districtsRaw = await fetchRegionList(shopId, city.id);
          const districts = filterByLevel(districtsRaw, isDistrictLike);
          district = findBestRegionMatch(districts, textNorm, {
            excludeNorms: [
              normalizeRegionText(provinceName),
              normalizeRegionText(stripRegionSuffix(provinceName)),
              normalizeRegionText(city.name),
              normalizeRegionText(stripRegionSuffix(city.name))
            ],
            role: 'district'
          });
        }
      }

      const hasCity = !!city?.id;
      const hasDistrict = !!district?.id;
      const score =
        (hasCity ? 1000000 : 0) +
        (hasDistrict ? 100000 : 0) +
        provinceMatch * 10000 +
        Number(city?.matchLen || 0) * 100 +
        Number(district?.matchLen || 0);
      if (score > bestScore) {
        bestScore = score;
        best = {
          province: { id: provinceId, name: provinceName },
          city: city?.id ? { id: String(city.id), name: String(city.name || '') } : null,
          district: district?.id ? { id: String(district.id), name: String(district.name || '') } : null
        };
      }
    }

    return best;
  }

  function parsePastedContact(text) {
    const raw = normalizeDigits(text).replace(/\u00A0/g, ' ');
    const t = raw.replace(/[\r\n]+/g, ' ').trim();
    if (!t) return { receiver: '', phone: '' };

    const phoneMatch = t.match(/(?:\+?86[-\s]?)?(1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})/) || t.match(/(0\d{2,3}[-\s]?\d{7,8})/);
    const phoneRaw = phoneMatch?.[1] ? String(phoneMatch[1]) : '';
    const phone = phoneRaw ? phoneRaw.replace(/[^\d]/g, '') : '';

    let receiver = '';
    const labelNameMatch = t.match(/(?:收件人|收货人|联系人|姓名)\s*[:：]?\s*([^\s,，;；:：]{1,20})/);
    if (labelNameMatch?.[1]) receiver = String(labelNameMatch[1]).trim();
    if (!receiver) {
      const adjacentMatch = t.match(/([^\s,，;；:：]{2,20})\s*(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/);
      if (adjacentMatch?.[1]) receiver = String(adjacentMatch[1]).trim();
    }

    if (!receiver && phoneMatch && typeof phoneMatch.index === 'number') {
      const prefix = t.slice(0, phoneMatch.index).trim();
      const tokens = prefix.split(/[\s,，;；|丨/\\]+/).map(s => String(s || '').trim()).filter(Boolean);
      if (tokens.length) {
        const last = cleanupReceiverName(tokens[tokens.length - 1]);
        if (last.length >= 1 && last.length <= 20) receiver = last;
      }
    }

    receiver = cleanupReceiverName(receiver);
    if (receiver.length > 20) receiver = receiver.slice(0, 20).trim();

    return { receiver, phone };
  }

  async function tryAutofillRegionFromText(text) {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'temp') return null;
    const provinceEl = getEl('opsAftersaleReturnProvince');
    const cityEl = getEl('opsAftersaleReturnCity');
    const districtEl = getEl('opsAftersaleReturnDistrict');
    if (!provinceEl || !cityEl || !districtEl) return null;

    const textNorm = normalizeRegionText(text);
    if (!textNorm) return null;

    try {
      await ensureProvinces();
      const shopId = await resolveRegionShopId();
      if (!shopId) return null;

      const chain = await matchRegionChainFromText(shopId, textNorm);
      if (!chain?.province?.id) return null;

      const shouldForceFix =
        !!readValue('opsAftersaleReturnProvince') &&
        (normalizeRegionText(getSelectedOptionName(cityEl)) === normalizeRegionText(getSelectedOptionName(provinceEl)) ||
          normalizeRegionText(getSelectedOptionName(districtEl)) === normalizeRegionText(getSelectedOptionName(provinceEl)) ||
          normalizeRegionText(getSelectedOptionName(districtEl)) === normalizeRegionText(getSelectedOptionName(cityEl)));

      const provinceIdNow = readValue('opsAftersaleReturnProvince');
      if (!provinceIdNow || shouldForceFix) {
        if (provinceEl.querySelector(`option[value="${chain.province.id}"]`)) {
          provinceEl.value = chain.province.id;
        }
        await loadCities();
      }

      const cityIdNow = readValue('opsAftersaleReturnCity');
      if ((!cityIdNow || shouldForceFix) && chain.city?.id) {
        if (cityEl.querySelector(`option[value="${chain.city.id}"]`)) {
          cityEl.value = chain.city.id;
        }
        await loadDistricts();
      }

      const districtIdNow = readValue('opsAftersaleReturnDistrict');
      if ((!districtIdNow || shouldForceFix) && chain.district?.id) {
        if (districtEl.querySelector(`option[value="${chain.district.id}"]`)) {
          districtEl.value = chain.district.id;
        }
      }

      return {
        provinceName: chain.province.name || getSelectedOptionName(provinceEl),
        cityName: chain.city?.name || getSelectedOptionName(cityEl),
        districtName: chain.district?.name || getSelectedOptionName(districtEl)
      };
    } catch {
      return null;
    }
  }

  function tryAutofillContactFromDetailAddress() {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'temp') return;
    const detail = readValue('opsAftersaleReturnDetailAddress');
    if (!detail) return;

    const { receiver, phone } = parsePastedContact(detail);
    if (!receiver && !phone) return;
    const key = `${receiver}|${phone}|${detail.length}`;
    if (key && key === lastAutoFillKey) return;
    lastAutoFillKey = key;

    const receiverEl = getEl('opsAftersaleReturnReceiver');
    const phoneEl = getEl('opsAftersaleReturnPhone');
    const receiverNow = String(receiverEl?.value || '').trim();
    const phoneNow = String(phoneEl?.value || '').trim();
    const receiverCanFill = receiver && !receiverNow;
    const phoneCanFill = phone && !phoneNow;
    if (receiverEl && receiverCanFill) {
      receiverEl.value = receiver;
      receiverEl.dataset.invalid = '';
    }
    if (phoneEl && phoneCanFill) {
      phoneEl.value = phone;
      phoneEl.dataset.invalid = '';
    }
    Promise.resolve(tryAutofillRegionFromText(detail)).then(region => {
      const detailEl = getEl('opsAftersaleReturnDetailAddress');
      if (!detailEl) return;
      const v = String(detailEl.value || '').trim();
      if (!v) return;
      const cleaned = cleanupDetailAddress(v, { receiver, phone, region });
      if (cleaned && cleaned !== v) detailEl.value = cleaned;
    }).catch(() => {});
  }

  async function tryReadClipboardAndAutofill() {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'temp') return;
    try {
      const text = await window.pddApi?.readClipboardText?.();
      const clip = String(text || '').trim();
      if (!clip) return;

      const { receiver, phone } = parsePastedContact(clip);
      const receiverEl = getEl('opsAftersaleReturnReceiver');
      const phoneEl = getEl('opsAftersaleReturnPhone');
      const receiverNow = String(receiverEl?.value || '').trim();
      const phoneNow = String(phoneEl?.value || '').trim();
      if (receiverEl && receiver && !receiverNow) receiverEl.value = receiver;
      if (phoneEl && phone && !phoneNow) phoneEl.value = phone;

      const detailEl = getEl('opsAftersaleReturnDetailAddress');
      const detailNow = String(detailEl?.value || '').trim();
      if (detailEl && !detailNow) {
        const extracted = extractDetailAddressFromText(clip);
        if (extracted) detailEl.value = extracted;
      }
      const region = await tryAutofillRegionFromText(clip);
      if (detailEl && !detailNow) {
        const v = String(detailEl.value || '').trim();
        const cleaned = cleanupDetailAddress(v, { receiver, phone, region });
        if (cleaned) detailEl.value = cleaned;
      }
    } catch {}
  }

  function syncTabActive() {
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    overlay.querySelectorAll('.ops-aftersale-approve-return-tab').forEach(label => {
      const mode = String(label.getAttribute('data-mode') || '').trim();
      label.classList.toggle('is-active', mode === state.mode);
    });
  }

  function setInvalid(fieldId, invalid, errorId) {
    const el = getEl(fieldId);
    if (el) el.dataset.invalid = invalid ? '1' : '';
    const err = errorId ? getEl(errorId) : null;
    if (err) err.hidden = !invalid;
  }

  function syncModeVisibility() {
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    overlay.querySelectorAll('.ops-aftersale-approve-return-section').forEach(section => {
      const mode = String(section.getAttribute('data-mode') || '').trim();
      section.hidden = mode !== state.mode;
    });
    syncTabActive();
    setInvalid('opsAftersaleReturnCommonSelect', false, 'opsAftersaleReturnCommonError');
    setInvalid('opsAftersaleReturnProvince', false);
    setInvalid('opsAftersaleReturnCity', false);
    setInvalid('opsAftersaleReturnDistrict', false, 'opsAftersaleReturnRegionError');
    setInvalid('opsAftersaleReturnDetailAddress', false);
  }

  function openDialog(context) {
    ensureMounted();
    state = { mode: 'common', context: context || null, commonAddresses: [] };
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    overlay.querySelectorAll('input[name="opsAftersaleReturnAddrMode"]').forEach(input => {
      input.checked = String(input.value) === state.mode;
    });
    syncModeVisibility();
    clearInputs();
    const messageEl = getEl('opsAftersaleReturnMessage');
    if (messageEl) messageEl.value = DEFAULT_MESSAGE;
    ensureCommonAddresses();
    if (typeof window.showModal === 'function') {
      window.showModal(MODAL_ID);
    } else {
      overlay.classList.add('visible');
    }
  }

  function closeDialog() {
    const overlay = getEl(MODAL_ID);
    if (!overlay) return;
    if (typeof window.hideModal === 'function') {
      window.hideModal(MODAL_ID);
    } else {
      overlay.classList.remove('visible');
    }
  }

  function clearInputs() {
    const ids = [
      'opsAftersaleReturnCommonSelect',
      'opsAftersaleReturnProvince',
      'opsAftersaleReturnCity',
      'opsAftersaleReturnDistrict',
      'opsAftersaleReturnDetailAddress',
      'opsAftersaleReturnReceiver',
      'opsAftersaleReturnPhone',
      'opsAftersaleReturnMessage'
    ];
    ids.forEach(id => {
      const el = getEl(id);
      if (!el) return;
      if (el.tagName === 'SELECT') {
        el.value = '';
      } else {
        el.value = '';
      }
    });
  }

  function readValue(id) {
    const el = getEl(id);
    if (!el) return '';
    return String(el.value || '').trim();
  }

  function readSelectText(id) {
    const el = getEl(id);
    if (!el || el.tagName !== 'SELECT') return '';
    const idx = Number(el.selectedIndex);
    if (!Number.isFinite(idx) || idx < 0) return '';
    const opt = el.options?.[idx];
    const text = String(opt?.textContent || opt?.innerText || '').trim();
    const value = String(opt?.value || '').trim();
    if (!value) return '';
    return text;
  }

  function setSubmitting(next) {
    submitting = !!next;
    const btn = getEl('btnOpsAftersaleReturnConfirm');
    if (btn) btn.disabled = submitting;
  }

  async function handleConfirm() {
    if (submitting) return;
    const mode = state.mode;
    const commonSelectEl = getEl('opsAftersaleReturnCommonSelect');
    const detailAddressEl = getEl('opsAftersaleReturnDetailAddress');
    if (mode === 'common') {
      const hasSelectableOptions = commonSelectEl?.options?.length > 1;
      const selected = readValue('opsAftersaleReturnCommonSelect');
      const invalid = hasSelectableOptions && !selected;
      setInvalid('opsAftersaleReturnCommonSelect', invalid, 'opsAftersaleReturnCommonError');
      if (invalid) {
        window.opsCenterToast?.('请选择常用地址');
        return;
      }
    }
    if (mode === 'temp') {
      const provinceEl = getEl('opsAftersaleReturnProvince');
      const cityEl = getEl('opsAftersaleReturnCity');
      const districtEl = getEl('opsAftersaleReturnDistrict');
      const shouldRequire = (provinceEl?.options?.length || 0) > 1;
      const provinceId = readValue('opsAftersaleReturnProvince');
      const cityId = readValue('opsAftersaleReturnCity');
      const districtId = readValue('opsAftersaleReturnDistrict');
      const invalidProvince = shouldRequire && !provinceId;
      const invalidCity = shouldRequire && !!provinceId && !cityId;
      const invalidDistrict = shouldRequire && !!cityId && !districtId;
      const invalidRegion = invalidProvince || invalidCity || invalidDistrict;
      setInvalid('opsAftersaleReturnProvince', invalidProvince);
      setInvalid('opsAftersaleReturnCity', invalidCity);
      setInvalid('opsAftersaleReturnDistrict', invalidDistrict);
      const regionErrorEl = getEl('opsAftersaleReturnRegionError');
      if (regionErrorEl) regionErrorEl.hidden = !invalidRegion;
      const detailAddress = readValue('opsAftersaleReturnDetailAddress');
      const invalidDetail = !detailAddress;
      if (detailAddressEl) detailAddressEl.dataset.invalid = invalidDetail ? '1' : '';
      if (invalidRegion) {
        window.opsCenterToast?.('请选择省/市/区');
        return;
      }
      if (invalidDetail) {
        window.opsCenterToast?.('请填写详细地址');
        return;
      }
    }
    const receiver = readValue('opsAftersaleReturnReceiver');
    const phone = readValue('opsAftersaleReturnPhone');
    if (!receiver) {
      window.opsCenterToast?.('请填写收件人');
      return;
    }
    if (!phone) {
      window.opsCenterToast?.('请填写联系电话');
      return;
    }

    const instanceId = String(state?.context?.instanceId || '').trim();
    const orderSn = String(state?.context?.orderNo || '').trim();
    const shopId = String(state?.context?.shopId || '').trim();
    const version = Number(state?.context?.version || 0);
    if (!instanceId) {
      window.opsCenterToast?.('缺少售后单ID');
      return;
    }
    if (!orderSn) {
      window.opsCenterToast?.('缺少订单号');
      return;
    }
    if (!Number.isFinite(version) || version <= 0) {
      window.opsCenterToast?.('缺少版本号，请刷新列表后重试');
      return;
    }
    if (!shopId || shopId === '__all__') {
      window.opsCenterToast?.('请先选择具体店铺后再操作');
      return;
    }
    if (typeof window.pddApi?.aftersaleApproveReturnGoods !== 'function') {
      window.opsCenterToast?.('接口未就绪，请退出并重启客户端后重试');
      return;
    }

    let provinceId = 0;
    let cityId = 0;
    let districtId = 0;
    let provinceName = '';
    let cityName = '';
    let districtName = '';
    let refundAddress = '';
    if (mode === 'common') {
      const selectedId = readValue('opsAftersaleReturnCommonSelect');
      const list = Array.isArray(state?.commonAddresses) ? state.commonAddresses : [];
      const selected = list.find(item => String(item?.id || '').trim() === selectedId);
      provinceId = Number(selected?.provinceId || 0);
      cityId = Number(selected?.cityId || 0);
      districtId = Number(selected?.districtId || 0);
      provinceName = String(selected?.provinceName || '').trim();
      cityName = String(selected?.cityName || '').trim();
      districtName = String(selected?.districtName || '').trim();
      refundAddress = String(selected?.refundAddress || '').trim();
      if (!provinceId || !cityId || !districtId || !provinceName || !cityName || !districtName || !refundAddress) {
        window.opsCenterToast?.('常用地址信息不完整，请切换临时地址填写');
        return;
      }
    } else {
      provinceId = Number(readValue('opsAftersaleReturnProvince') || 0);
      cityId = Number(readValue('opsAftersaleReturnCity') || 0);
      districtId = Number(readValue('opsAftersaleReturnDistrict') || 0);
      provinceName = readSelectText('opsAftersaleReturnProvince');
      cityName = readSelectText('opsAftersaleReturnCity');
      districtName = readSelectText('opsAftersaleReturnDistrict');
      refundAddress = readValue('opsAftersaleReturnDetailAddress');
    }
    const receiverAddress = `${provinceName}${cityName}${districtName}${refundAddress}`;
    const operateDesc = readValue('opsAftersaleReturnMessage');

    const payload = {
      shopId,
      id: Number(instanceId),
      orderSn,
      version,
      receiver,
      receiverPhone: phone,
      provinceId,
      provinceName,
      cityId,
      cityName,
      districtId,
      districtName,
      receiverAddress,
      refundAddress,
      operateDesc,
      addressType: 1,
      confirmWeakRemind: null,
    };

    setSubmitting(true);
    try {
      const result = await window.pddApi.aftersaleApproveReturnGoods(payload);
      if (!result || result.error) {
        window.opsCenterToast?.(result?.error || '同意退货失败');
        return;
      }
      window.opsCenterToast?.('已同意退货');
      closeDialog();
      try {
        window.dispatchEvent(new CustomEvent('ops-aftersale-approved-return', { detail: { shopId, id: Number(instanceId), orderSn, optimisticRemove: true } }));
      } catch {}
    } catch (error) {
      window.opsCenterToast?.(error?.message || '同意退货失败');
    } finally {
      setSubmitting(false);
    }
  }

  function buildOptionsHtml(placeholder, list) {
    const head = `<option value="" selected disabled>${placeholder}</option>`;
    const body = (list || []).map(item => {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      if (!id || !name) return '';
      return `<option value="${id}">${name}</option>`;
    }).filter(Boolean).join('');
    return head + body;
  }

  async function resolveRegionShopId() {
    const fromContext = String(state?.context?.shopId || '').trim();
    if (fromContext && fromContext !== '__all__') return fromContext;
    try {
      const active = await window.pddApi?.getActiveShop?.();
      const sid = String(active?.id || '').trim();
      return sid && sid !== '__all__' ? sid : '';
    } catch {
      return '';
    }
  }

  async function fetchRegionList(shopId, parentId) {
    const sid = String(shopId || '').trim();
    const pid = String(parentId ?? '').trim() || '0';
    const cacheKey = `${sid}|${pid}`;
    if (regionCache.has(cacheKey)) return regionCache.get(cacheKey) || [];
    if (!sid) throw new Error('缺少店铺信息');
    if (typeof window.pddApi?.aftersaleGetRegions !== 'function') throw new Error('地区接口未就绪');
    let result;
    try {
      result = await window.pddApi.aftersaleGetRegions({ shopId: sid, parentId: pid });
    } catch (error) {
      const message = String(error?.message || error || '').trim();
      if (message.includes('No handler registered') && message.includes('aftersale-get-regions')) {
        throw new Error('地区接口未加载，请退出并重启客户端后重试');
      }
      throw new Error(message || '地区接口请求失败');
    }
    if (!result || result.error) throw new Error(result?.error || '地区接口请求失败');
    const list = Array.isArray(result?.list) ? result.list : [];
    regionCache.set(cacheKey, list);
    return list;
  }

  function setSelectState(select, placeholder, options, disabled) {
    if (!select) return;
    select.disabled = !!disabled;
    select.innerHTML = buildOptionsHtml(placeholder, options);
  }

  function buildRefundAddressLabel(item) {
    const provinceName = String(item?.provinceName || '').trim();
    const cityName = String(item?.cityName || '').trim();
    const districtName = String(item?.districtName || '').trim();
    const refundAddress = String(item?.refundAddress || '').trim();
    const base = `${provinceName}${cityName}${districtName}${refundAddress}`.trim();
    if (!base) return refundAddress || '未命名地址';
    return base;
  }

  async function fetchRefundAddressList(shopId) {
    const sid = String(shopId || '').trim();
    if (!sid) throw new Error('缺少店铺信息');
    if (refundAddressCache.has(sid)) return refundAddressCache.get(sid) || [];
    if (typeof window.pddApi?.aftersaleListRefundAddresses !== 'function') throw new Error('常用地址接口未就绪');
    let result;
    try {
      result = await window.pddApi.aftersaleListRefundAddresses({ shopId: sid });
    } catch (error) {
      const message = String(error?.message || error || '').trim();
      if (message.includes('No handler registered') && message.includes('aftersale-list-refund-addresses')) {
        throw new Error('常用地址接口未加载，请退出并重启客户端后重试');
      }
      throw new Error(message || '常用地址接口请求失败');
    }
    if (!result || result.error) throw new Error(result?.error || '常用地址接口请求失败');
    const list = Array.isArray(result?.list) ? result.list : [];
    refundAddressCache.set(sid, list);
    return list;
  }

  async function ensureCommonAddresses() {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'common') return;
    const selectEl = getEl('opsAftersaleReturnCommonSelect');
    if (!selectEl) return;
    if ((selectEl.options?.length || 0) > 1) return;
    setSelectState(selectEl, '加载中...', [], true);
    try {
      const shopId = await resolveRegionShopId();
      if (!shopId) {
        setSelectState(selectEl, '请先选择具体店铺', [], true);
        return;
      }
      const list = await fetchRefundAddressList(shopId);
      state.commonAddresses = Array.isArray(list) ? list : [];
      const options = state.commonAddresses.map(item => ({
        id: String(item?.id || '').trim(),
        name: buildRefundAddressLabel(item),
      })).filter(item => item.id && item.name);
      if (!options.length) {
        setSelectState(selectEl, '暂无常用地址，请选择临时地址', [], true);
        return;
      }
      setSelectState(selectEl, '请选择常用地址', options, false);
      const defaultItem = state.commonAddresses.find(item => String(item?.isDefault || '').trim().toUpperCase() === 'Y');
      if (defaultItem) {
        selectEl.value = String(defaultItem?.id || '').trim();
      }
      try {
        selectEl.dispatchEvent(new Event('change'));
      } catch {}
    } catch (error) {
      setSelectState(selectEl, '常用地址加载失败，请选择临时地址', [], true);
      window.opsCenterToast?.(String(error?.message || '常用地址加载失败'));
    }
  }

  async function ensureProvinces() {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'temp') return;
    const provinceEl = getEl('opsAftersaleReturnProvince');
    const cityEl = getEl('opsAftersaleReturnCity');
    const districtEl = getEl('opsAftersaleReturnDistrict');
    if (!provinceEl || !cityEl || !districtEl) return;
    if ((provinceEl.options?.length || 0) > 1) return;
    setSelectState(provinceEl, '加载中...', [], true);
    setSelectState(cityEl, '请选择市', [], true);
    setSelectState(districtEl, '请选择区/县', [], true);
    try {
      const shopId = await resolveRegionShopId();
      const list = await fetchRegionList(shopId, 0);
      setSelectState(provinceEl, '请选择省', list, false);
      setSelectState(cityEl, '请选择市', [], true);
      setSelectState(districtEl, '请选择区/县', [], true);
    } catch (error) {
      setSelectState(provinceEl, '请选择省', [], false);
      window.opsCenterToast?.(error?.message || '省份加载失败');
    }
  }

  async function loadCities() {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'temp') return;
    const provinceId = readValue('opsAftersaleReturnProvince');
    const provinceEl = getEl('opsAftersaleReturnProvince');
    const provinceName = getSelectedOptionName(provinceEl);
    const cityEl = getEl('opsAftersaleReturnCity');
    const districtEl = getEl('opsAftersaleReturnDistrict');
    if (!cityEl || !districtEl) return;
    setInvalid('opsAftersaleReturnProvince', false);
    setInvalid('opsAftersaleReturnCity', false);
    setInvalid('opsAftersaleReturnDistrict', false, 'opsAftersaleReturnRegionError');
    if (!provinceId) {
      setSelectState(cityEl, '请选择市', [], true);
      setSelectState(districtEl, '请选择区/县', [], true);
      return;
    }
    setSelectState(cityEl, '加载中...', [], true);
    setSelectState(districtEl, '请选择区/县', [], true);
    try {
      const shopId = await resolveRegionShopId();
      const list = await fetchRegionList(shopId, provinceId);
      const cities = filterByLevel(list, isCityLike);
      if (MUNICIPALITIES.includes(provinceName)) {
        const hasCityLevel = Array.isArray(list) && list.some(item => isCityLike(String(item?.name || '').trim()));
        if (!hasCityLevel && Array.isArray(list) && list.length) {
          setSelectState(cityEl, '请选择市', [{ id: provinceId, name: provinceName }], false);
          cityEl.value = String(provinceId);
          const districts = filterByLevel(list, isDistrictLike);
          setSelectState(districtEl, '请选择区/县', districts, false);
          return;
        }
        const provinceNorm = normalizeRegionText(provinceName);
        const provinceShortNorm = normalizeRegionText(stripRegionSuffix(provinceName));
        const preferred = cities.find(item => {
          const name = String(item?.name || '').trim();
          const full = normalizeRegionText(name);
          const short = normalizeRegionText(stripRegionSuffix(name));
          return (provinceNorm && full === provinceNorm) || (provinceShortNorm && short === provinceShortNorm);
        });
        const picked = preferred || cities[0];
        if (picked?.id && picked?.name) {
          setSelectState(cityEl, '请选择市', [picked], false);
          cityEl.value = String(picked.id);
          await loadDistricts();
          return;
        }
      }
      setSelectState(cityEl, '请选择市', cities, false);
    } catch (error) {
      setSelectState(cityEl, '请选择市', [], false);
      window.opsCenterToast?.(error?.message || '城市加载失败');
    }
  }

  async function loadDistricts() {
    const overlay = getEl(MODAL_ID);
    if (!overlay || state.mode !== 'temp') return;
    const cityId = readValue('opsAftersaleReturnCity');
    const districtEl = getEl('opsAftersaleReturnDistrict');
    if (!districtEl) return;
    setInvalid('opsAftersaleReturnCity', false);
    setInvalid('opsAftersaleReturnDistrict', false, 'opsAftersaleReturnRegionError');
    if (!cityId) {
      setSelectState(districtEl, '请选择区/县', [], true);
      return;
    }
    setSelectState(districtEl, '加载中...', [], true);
    try {
      const shopId = await resolveRegionShopId();
      const list = await fetchRegionList(shopId, cityId);
      const districts = filterByLevel(list, isDistrictLike);
      setSelectState(districtEl, '请选择区/县', districts, false);
    } catch (error) {
      setSelectState(districtEl, '请选择区/县', [], false);
      window.opsCenterToast?.(error?.message || '区县加载失败');
    }
  }

  window.openOpsAfterSaleApproveReturnGoodsDialog = openDialog;
  window.closeOpsAfterSaleApproveReturnGoodsDialog = closeDialog;
})();
