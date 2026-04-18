'use strict';

// 邀请下单业务模块。维护买家粒度的邀请下单会话状态（商品列表 + 已选 SKU），
// 提供给渲染层 UI 拉取/修改/提交所需的接口。所有页面侧 API 均通过 PddApiClient
// 暴露的 _requestGoodsPageApi 复用 GoodsCardModule 的会话执行能力。

class InviteOrderModule {
  constructor(client) {
    this.client = client;
    this._stateByUid = new Map();
  }

  resolveUid(params = {}) {
    const sessionMeta = this.client._normalizeSessionMeta(params?.session || params?.sessionId);
    const candidates = [
      params?.uid,
      sessionMeta?.userUid,
      sessionMeta?.customerId,
      sessionMeta?.sessionId,
      sessionMeta?.raw?.uid,
      sessionMeta?.raw?.to?.uid,
      sessionMeta?.raw?.user_info?.uid,
      sessionMeta?.raw?.buyer_id,
      sessionMeta?.raw?.customer_id,
    ].map(value => String(value || '').trim()).filter(Boolean);
    return candidates[0] || '';
  }

  getSessionState(uid) {
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) {
      return {
        uid: '',
        goodsList: [],
        selectedItems: [],
      };
    }
    if (!this._stateByUid.has(normalizedUid)) {
      this._stateByUid.set(normalizedUid, {
        uid: normalizedUid,
        goodsList: [],
        selectedItems: [],
      });
    }
    return this._stateByUid.get(normalizedUid);
  }

  formatFen(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '';
    const yuan = amount / 100;
    return yuan.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  normalizeGoodsItem(item = {}) {
    const minPrice = Number(item?.minOnSaleGroupPriceOriginal);
    const maxPrice = Number(item?.maxOnSaleGroupPriceOriginal);
    let priceText = '';
    if (Number.isFinite(minPrice) && Number.isFinite(maxPrice) && minPrice > 0 && maxPrice > 0) {
      priceText = minPrice === maxPrice
        ? `¥${this.formatFen(minPrice)}`
        : `¥${this.formatFen(minPrice)}-${this.formatFen(maxPrice)}`;
    } else if (String(item?.defaultPriceStr || '').trim()) {
      priceText = `¥${String(item.defaultPriceStr).trim()}`;
    }
    const metaParts = [];
    if (Number.isFinite(Number(item?.quantity))) {
      metaParts.push(`库存 ${Number(item.quantity)}`);
    }
    if (Number.isFinite(Number(item?.soldQuantity))) {
      metaParts.push(`已售 ${Number(item.soldQuantity)}`);
    }
    if (String(item?.failInviteReason || '').trim()) {
      metaParts.push(String(item.failInviteReason).trim());
    }
    return {
      itemId: String(item?.goodsId || '').trim(),
      goodsId: Number(item?.goodsId || 0),
      title: String(item?.goodsName || '').trim(),
      imageUrl: String(item?.thumbUrl || item?.hdUrl || '').trim(),
      priceText,
      metaText: metaParts.join(' · '),
      canInvite: item?.canInvite !== false,
      raw: this.client._cloneJson(item),
    };
  }

  filterGoodsList(goodsList = [], keyword = '') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return goodsList;
    return goodsList.filter(item => String(item?.title || '').toLowerCase().includes(normalizedKeyword));
  }

  buildSnapshot(uid, options = {}) {
    const normalizedUid = String(uid || '').trim();
    const state = this.getSessionState(normalizedUid);
    const keyword = String(options?.keyword || '').trim();
    const goodsList = Array.isArray(options?.goodsList) ? options.goodsList : state.goodsList;
    const selectedItems = Array.isArray(state.selectedItems) ? state.selectedItems : [];
    const selectedGoodsIds = new Set(
      selectedItems.map(item => String(item?.goodsId || '').trim()).filter(Boolean)
    );
    const filteredGoodsList = this.filterGoodsList(goodsList, keyword).map(item => ({
      ...item,
      selected: selectedGoodsIds.has(String(item?.goodsId || '').trim()),
      buttonText: selectedGoodsIds.has(String(item?.goodsId || '').trim()) ? '已加入' : '加入清单',
    }));
    const totalFen = selectedItems.reduce((sum, item) => sum + Number(item?.promoPrice || item?.skuPrice || 0), 0);
    let statusText = selectedItems.length
      ? `已选 ${selectedItems.length} 件商品，可直接发送给买家`
      : '未添加任何商品，请从左侧列表选择商品';
    if (!filteredGoodsList.length && keyword) {
      statusText = '未找到匹配商品，请尝试更换关键词';
    } else if (!filteredGoodsList.length) {
      statusText = '暂未读取到可邀请商品';
    }
    return {
      success: true,
      source: 'api',
      goodsItems: filteredGoodsList,
      selectedItems: selectedItems.map((item, index) => ({
        itemId: `${item.goodsId || 'goods'}:${item.skuId || index}`,
        title: item.displayTitle || item.title || '已选商品',
        imageUrl: String(item?.imageUrl || '').trim(),
        priceText: `¥${this.formatFen(Number(item?.promoPrice || item?.skuPrice || 0)) || '0.00'}`,
        goodsNumber: Number(item?.goodsNumber || 1),
      })),
      selectedCount: selectedItems.length,
      totalText: `¥${this.formatFen(totalFen || 0) || '0.00'}`,
      statusText,
    };
  }

  async loadGoodsList(uid) {
    const client = this.client;
    const payload = await client._requestGoodsPageApi('/latitude/goods/getMallChatGoodsList', {
      pageNum: 1,
      pageSize: 15,
      uid,
    }, 'POST');
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError);
    }
    const result = payload?.result || {};
    const rawList = [
      ...(Array.isArray(result?.goodsList) ? result.goodsList : []),
      ...(Array.isArray(result?.activeGoodsList) ? result.activeGoodsList : []),
      ...(Array.isArray(result?.footprintGoodsList) ? result.footprintGoodsList : []),
    ];
    const deduped = [];
    const seen = new Set();
    for (const item of rawList) {
      const normalized = this.normalizeGoodsItem(item);
      if (!normalized.goodsId || !normalized.title) continue;
      const key = String(normalized.goodsId);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(normalized);
    }
    return deduped;
  }

  async loadSkuSelector(uid, goodsId) {
    const client = this.client;
    const payload = await client._requestGoodsPageApi('/latitude/goods/skuSelectorForMall', {
      goodsId,
      uid,
    }, 'POST');
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError);
    }
    const result = payload?.result || {};
    const skuList = Array.isArray(result?.sku) ? result.sku : [];
    return { payload, result, skuList };
  }

  buildSkuSpecText(specs = [], { withKeys = false } = {}) {
    return (Array.isArray(specs) ? specs : [])
      .map(item => {
        const key = String(item?.specKey || '').trim();
        const value = String(item?.specValue || '').trim();
        if (withKeys && key && value) return `${key}:${value}`;
        return value || key;
      })
      .filter(Boolean)
      .join(' ');
  }

  buildSkuPriceText(sku = {}) {
    const price = Number(
      sku?.groupPrice
      || sku?.oldGroupPrice
      || sku?.normalPrice
      || sku?.price
      || 0
    );
    return price > 0 ? `¥${this.formatFen(price)}` : '';
  }

  async getSkuOptions(params = {}) {
    const uid = this.resolveUid(params);
    const goodsId = Number(String(params?.itemId || params?.goodsId || '').trim());
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    if (!Number.isFinite(goodsId) || goodsId <= 0) {
      throw new Error('缺少商品标识');
    }
    const state = this.getSessionState(uid);
    if (!Array.isArray(state.goodsList) || !state.goodsList.length) {
      state.goodsList = await this.loadGoodsList(uid);
    }
    const goodsInfo = state.goodsList.find(item => Number(item?.goodsId) === goodsId) || {};
    const { result, skuList } = await this.loadSkuSelector(uid, goodsId);
    const availableSku = skuList.find(item => Number(item?.isOnsale) === 1 && Number(item?.quantity || 0) > 0)
      || skuList.find(item => Number(item?.isOnsale) === 1)
      || skuList[0];
    const optionLabelSet = new Set();
    const skuOptions = skuList
      .map((item, index) => {
        const skuId = Number(item?.skuId || 0);
        if (!skuId) return null;
        const label = this.buildSkuSpecText(item?.specs || []);
        const detailLabel = this.buildSkuSpecText(item?.specs || [], { withKeys: true });
        const specKeys = Array.isArray(item?.specs) ? item.specs.map(spec => String(spec?.specKey || '').trim()).filter(Boolean) : [];
        specKeys.forEach(key => optionLabelSet.add(key));
        const quantity = Number(item?.quantity || 0);
        return {
          skuId,
          label: label || `规格 ${index + 1}`,
          detailLabel: detailLabel || label || `规格 ${index + 1}`,
          priceText: this.buildSkuPriceText(item) || goodsInfo.priceText || '',
          quantity,
          stockText: Number.isFinite(quantity) ? `库存 ${Math.max(0, quantity)}` : '',
          disabled: Number(item?.isOnsale) !== 1 || quantity <= 0,
        };
      })
      .filter(Boolean);
    return {
      success: true,
      source: 'api',
      goodsId,
      title: String(goodsInfo?.title || result?.goodsName || '').trim() || '商品',
      imageUrl: String(goodsInfo?.imageUrl || '').trim(),
      priceText: String(goodsInfo?.priceText || '').trim() || (availableSku ? this.buildSkuPriceText(availableSku) : ''),
      optionLabel: optionLabelSet.size === 1 ? Array.from(optionLabelSet)[0] : '规格',
      selectedSkuId: availableSku?.skuId ? String(availableSku.skuId) : '',
      skuOptions,
    };
  }

  async resolveSelection(uid, goodsId, goodsList = [], preferredSkuId = '') {
    const client = this.client;
    const { result, skuList } = await this.loadSkuSelector(uid, goodsId);
    const normalizedPreferredSkuId = Number(String(preferredSkuId || '').trim());
    const targetSku = (Number.isFinite(normalizedPreferredSkuId) && normalizedPreferredSkuId > 0
      ? skuList.find(item => Number(item?.skuId) === normalizedPreferredSkuId)
      : null)
      || skuList.find(item => Number(item?.isOnsale) === 1 && Number(item?.quantity || 0) > 0)
      || skuList.find(item => Number(item?.isOnsale) === 1)
      || skuList[0];
    if (!targetSku?.skuId) {
      throw new Error('该商品暂无可邀请规格');
    }
    if (Number.isFinite(normalizedPreferredSkuId) && normalizedPreferredSkuId > 0 && Number(targetSku?.skuId) !== normalizedPreferredSkuId) {
      throw new Error('所选规格不存在');
    }
    if (Number(targetSku?.isOnsale) !== 1 || Number(targetSku?.quantity || 0) <= 0) {
      throw new Error('所选规格当前不可邀请');
    }
    const skuPrice = Number(
      targetSku?.groupPrice
      || targetSku?.oldGroupPrice
      || targetSku?.normalPrice
      || targetSku?.price
      || 0
    );
    const promoPayload = await client._requestGoodsPageApi('/latitude/goods/substitutePromoPrice', {
      type: 1,
      uid,
      selectList: [{
        goodsId,
        skuId: targetSku.skuId,
        goodsNumber: 1,
        skuPrice,
      }],
    }, 'POST');
    const promoBusinessError = client._normalizeBusinessError(promoPayload);
    if (promoBusinessError) {
      throw new Error(promoBusinessError);
    }
    const promoItem = Array.isArray(promoPayload?.result?.skuPromoPriceList)
      ? promoPayload.result.skuPromoPriceList[0]
      : null;
    const goodsInfo = goodsList.find(item => Number(item?.goodsId) === Number(goodsId)) || {};
    const specText = this.buildSkuSpecText(targetSku?.specs || [], { withKeys: true });
    return {
      goodsId: Number(goodsId),
      skuId: Number(targetSku.skuId),
      goodsNumber: Number(promoItem?.goodsNumber || 1),
      skuPrice: Number(promoItem?.skuPrice || skuPrice || 0),
      promoPrice: Number(promoItem?.promoPrice || skuPrice || 0),
      title: String(goodsInfo?.title || result?.goodsName || '').trim(),
      imageUrl: String(goodsInfo?.imageUrl || '').trim(),
      displayTitle: specText
        ? `${String(goodsInfo?.title || result?.goodsName || '商品').trim()}（${specText}）`
        : String(goodsInfo?.title || result?.goodsName || '商品').trim(),
    };
  }

  async getState(params = {}) {
    const uid = this.resolveUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const state = this.getSessionState(uid);
    state.goodsList = await this.loadGoodsList(uid);
    return this.buildSnapshot(uid, {
      keyword: params?.keyword,
      goodsList: state.goodsList,
    });
  }

  async addItem(params = {}) {
    const uid = this.resolveUid(params);
    const goodsId = Number(String(params?.itemId || '').trim());
    const preferredSkuId = String(params?.skuId || '').trim();
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    if (!Number.isFinite(goodsId) || goodsId <= 0) {
      throw new Error('缺少商品标识');
    }
    const state = this.getSessionState(uid);
    if (!Array.isArray(state.goodsList) || !state.goodsList.length) {
      state.goodsList = await this.loadGoodsList(uid);
    }
    const exists = state.selectedItems.find(item => Number(item?.goodsId) === goodsId);
    if (!exists) {
      const selection = await this.resolveSelection(uid, goodsId, state.goodsList, preferredSkuId);
      state.selectedItems.push(selection);
    }
    return this.buildSnapshot(uid, {
      keyword: params?.keyword,
      goodsList: state.goodsList,
    });
  }

  async clearItems(params = {}) {
    const uid = this.resolveUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const state = this.getSessionState(uid);
    state.selectedItems = [];
    if (!Array.isArray(state.goodsList) || !state.goodsList.length) {
      state.goodsList = await this.loadGoodsList(uid);
    }
    return this.buildSnapshot(uid, {
      keyword: params?.keyword,
      goodsList: state.goodsList,
    });
  }

  async submitOrder(params = {}) {
    const client = this.client;
    const uid = this.resolveUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const state = this.getSessionState(uid);
    const goodsList = Array.isArray(state.selectedItems)
      ? state.selectedItems
        .filter(item => item?.goodsId && item?.skuId)
        .map(item => ({
          skuId: Number(item.skuId),
          goodsId: Number(item.goodsId),
          goodsNumber: Number(item.goodsNumber || 1),
        }))
      : [];
    if (!goodsList.length) {
      throw new Error('请先选择至少一个商品');
    }
    const payload = await client._requestGoodsPageApi('/latitude/goods/sendSubstituteOrderCard', {
      goodsList,
      uid,
      note: '',
      couponAmount: 0,
      autoSendCoupon: true,
    }, 'POST');
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError);
    }
    state.selectedItems = [];
    return {
      success: true,
      source: 'api',
      message: '邀请下单已发送',
    };
  }

  async submitFollow(params = {}) {
    const client = this.client;
    const uid = this.resolveUid(params);
    if (!uid) {
      throw new Error('缺少买家 UID');
    }
    const payload = await client._requestGoodsPageApi('/latitude/message/sendFavMallCard', {
      uid,
    }, 'POST');
    const businessError = client._normalizeBusinessError(payload);
    if (businessError) {
      throw new Error(businessError.message || '发送邀请关注失败');
    }
    return {
      success: true,
      source: 'api',
      uid,
      message: '邀请关注已发送',
    };
  }
}

module.exports = { InviteOrderModule };
