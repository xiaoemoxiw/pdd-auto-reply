const assert = require('assert');
const { app } = require('electron');
const { PddApiClient } = require('../src/main/pdd-api');

async function testTaggedRemarkUsesSingleWrite() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  const calls = [];
  client._post = async (url, body) => {
    calls.push({ url, body });
    return { success: true };
  };
  client.getOrderRemark = async () => ({
    note: '备注内容',
    tag: 'RED',
    tagName: '红色',
  });

  const result = await client.saveOrderRemark({
    orderSn: 'ORDER-1',
    note: '备注内容',
    tag: 'RED',
    source: 1,
  });

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(calls.map(item => item.url), ['/pizza/order/noteTag/update']);
  assert.strictEqual(calls[0].body.remarkTag, 'RED');
  assert.strictEqual(calls[0].body.remarkTagName, '红色');
  assert.strictEqual(calls[0].body.remark, '备注内容');
}

async function testIntervalRetryDoesNotFallThrough() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  const calls = [];
  let attempt = 0;
  client._sleep = async () => {};
  client._post = async (url, body) => {
    calls.push({ url, body });
    attempt += 1;
    if (attempt === 1) {
      throw new Error('两次备注间隔时长需大于1秒');
    }
    return { success: true };
  };
  client.getOrderRemark = async () => ({
    note: '无颜色备注',
    tag: '',
    tagName: '',
  });

  const result = await client.saveOrderRemark({
    orderSn: 'ORDER-2',
    note: '无颜色备注',
    tag: '',
    source: 1,
  });

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(calls.map(item => item.url), [
    '/pizza/order/noteTag/update',
    '/pizza/order/noteTag/update',
  ]);
}

async function testIntervalErrorCanRecoverFromLatestRemark() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  client._sleep = async () => {};
  client._post = async () => {
    throw new Error('两次备注间隔时长需大于1秒');
  };
  client.getOrderRemark = async () => ({
    note: '补抓后的备注',
    tag: 'BLUE',
    tagName: '蓝色',
  });

  const result = await client.saveOrderRemark({
    orderSn: 'ORDER-3',
    note: '补抓后的备注',
    tag: 'BLUE',
    source: 1,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.note, '补抓后的备注');
  assert.strictEqual(result.tag, 'BLUE');
}

async function testSavedRemarkCanSurviveListReload() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  client._post = async () => ({ success: true });
  client.getOrderRemark = async () => ({
    orderSn: 'ORDER-4',
    note: '刷新后仍可见',
    tag: 'YELLOW',
    tagName: '黄色',
    source: 1,
  });

  await client.saveOrderRemark({
    orderSn: 'ORDER-4',
    note: '刷新后仍可见',
    tag: 'YELLOW',
    source: 1,
  });

  const card = client._normalizeSideOrderCard({
    orderSn: 'ORDER-4',
    goodsName: '商品A',
  }, {}, 'personal', 0);

  assert.strictEqual(card.note, '刷新后仍可见');
  assert.strictEqual(card.noteTag, 'YELLOW');
  assert.strictEqual(card.noteTagName, '黄色');
}

async function testRemarkApiPrefersPageRequest() {
  const pageRequests = [];
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
    requestInPddPage(request) {
      pageRequests.push(request);
      return Promise.resolve({ success: true });
    },
  });
  client._post = async () => {
    throw new Error('should not fallback to _post when page request is available');
  };

  await client._requestOrderRemarkApi('/pizza/order/note/update', {
    orderSn: 'ORDER-5',
    note: '页面上下文保存',
    source: 1,
  });

  assert.strictEqual(pageRequests.length, 1);
  assert.strictEqual(pageRequests[0].url, '/pizza/order/note/update');
  assert.strictEqual(pageRequests[0].headers['content-type'], 'application/json');
}

async function testRemarkApiNormalizesPageBusinessError() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
    requestInPddPage() {
      return Promise.resolve({
        success: false,
        error_msg: '订单备注不能为空！',
        error_code: 50001,
      });
    },
  });
  let capturedError = null;
  try {
    await client._requestOrderRemarkApi('/pizza/order/note/update', {
      orderSn: 'ORDER-6',
      note: '',
      source: 1,
    });
  } catch (error) {
    capturedError = error;
  }
  assert.ok(capturedError);
  assert.strictEqual(capturedError.message, '订单备注不能为空！');
}

async function testSaveOrderRemarkFallsBackWhenFirstWriteNoEffect() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  const calls = [];
  let readCount = 0;
  client._sleep = async () => {};
  client._post = async (url, body) => {
    calls.push({ url, body });
    return { success: true };
  };
  client.getOrderRemark = async () => {
    readCount += 1;
    if (readCount === 1) {
      return {
        orderSn: 'ORDER-7',
        note: '旧备注',
        tag: '',
        tagName: '',
        source: 1,
      };
    }
    return {
      orderSn: 'ORDER-7',
      note: '新备注',
      tag: '',
      tagName: '',
      source: 1,
    };
  };

  const result = await client.saveOrderRemark({
    orderSn: 'ORDER-7',
    note: '新备注',
    tag: '',
    source: 1,
  });

  assert.strictEqual(result.note, '新备注');
  assert.deepStrictEqual(calls.map(item => item.url), [
    '/pizza/order/noteTag/update',
    '/pizza/order/note/update',
  ]);
}

async function testInvalidZeroTagIsNormalizedToEmpty() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  const calls = [];
  client._post = async (url, body) => {
    calls.push({ url, body });
    return { success: true };
  };
  client.getOrderRemark = async () => ({
    orderSn: 'ORDER-8',
    note: '新增备注',
    tag: '',
    tagName: '',
    source: 1,
  });

  const result = await client.saveOrderRemark({
    orderSn: 'ORDER-8',
    note: '新增备注',
    tag: 0,
    source: 1,
  });

  assert.strictEqual(result.tag, '');
  assert.deepStrictEqual(calls.map(item => item.body.remarkTag ?? null), ['']);
}

async function testSaveOrderRemarkUsesSuccessPayloadShape() {
  const calls = [];
  const expectedNote = 'abc123 [pdd50480578936 04/03 04:22]';
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
    requestInPddPage(request) {
      calls.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(request.body),
      });
      return Promise.resolve({ success: true, errorCode: 1000000, result: null });
    },
  });
  client.getUserInfo = async () => ({ username: 'pdd50480578936' });
  client._formatOrderRemarkMeta = () => '04/03 04:22';
  let readCount = 0;
  client.getOrderRemark = async () => {
    readCount += 1;
    if (readCount === 1) {
      return {
        orderSn: 'ORDER-9',
        note: expectedNote,
        tag: '',
        tagName: '',
        source: 1,
      };
    }
    return {
      orderSn: 'ORDER-9',
      note: expectedNote,
      tag: '',
      tagName: '',
      source: 1,
    };
  };

  const result = await client.saveOrderRemark({
    orderSn: 'ORDER-9',
    note: 'abc123',
    tag: '',
    source: 1,
    autoAppendMeta: true,
  });

  assert.strictEqual(result.note, expectedNote);
  assert.strictEqual(calls[0].headers['content-type'], 'application/json');
  assert.strictEqual(calls[0].body.orderSn, 'ORDER-9');
  assert.strictEqual(calls[0].body.source, 1);
  assert.strictEqual(calls[0].body.remarkTag, '');
  assert.strictEqual(calls[0].body.remarkTagName, '');
  assert.ok(!('tag' in calls[0].body));
  assert.ok(!('note' in calls[0].body));
  assert.ok(String(calls[0].body.remark || '').includes('abc123'));
}

async function testRefundShippingBenefitSupportsBooleanFields() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  const giftedCard = client._normalizeSideOrderCard({
    orderSn: 'ORDER-10',
    goodsName: '商品A',
    refundShippingBenefit: true,
  }, {}, 'personal', 0);
  const ungiftedCard = client._normalizeSideOrderCard({
    orderSn: 'ORDER-11',
    goodsName: '商品B',
    refund_shipping_insurance: 0,
  }, {}, 'personal', 0);

  assert.deepStrictEqual(
    giftedCard.metaRows.find(item => item.label === '退货包运费'),
    { label: '退货包运费', value: '已赠送' }
  );
  assert.deepStrictEqual(
    ungiftedCard.metaRows.find(item => item.label === '退货包运费'),
    { label: '退货包运费', value: '未赠送' }
  );
}

async function testRefundShippingBenefitSupportsInsuranceTextFields() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  const card = client._normalizeSideOrderCard({
    orderSn: 'ORDER-12',
    goodsName: '商品C',
    refundShippingInsuranceStatusDesc: '首重免费',
  }, {}, 'personal', 0);

  assert.deepStrictEqual(
    card.metaRows.find(item => item.label === '退货包运费'),
    { label: '退货包运费', value: '首重免费' }
  );
}

async function testAftersaleSideOrdersSupportStatusCodeOnlyQueryList() {
  const client = new PddApiClient('shop_1', {
    getShopInfo: () => ({ name: '店铺A' }),
  });
  client._getLatestAntiContent = () => '';
  client._requestRefundOrderPageApi = async (url) => {
    if (url === '/latitude/order/userRefundOrder') {
      return {
        result: {
          orders: [
            {
              orderSn: 'ORDER-13',
              goodsName: '商品A',
              orderAmount: 1990,
              orderStatusStr: '未发货，退款成功',
              afterSalesInfo: {
                afterSalesId: 'AS-13',
                afterSalesStatus: 5,
                afterSalesType: 1,
              },
              compensate: {
                text: '未赠送',
              },
              workbenchOrderTagNew: [
                {
                  status: '未赠送',
                  text: '退货包运费',
                  type: 2,
                },
              ],
            },
            {
              orderSn: 'ORDER-14',
              goodsName: '商品B',
              orderAmount: 2990,
            },
          ],
        },
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const cards = await client.getSideOrders({ userUid: '10001' }, 'aftersale');

  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].orderId, 'ORDER-13');
  assert.strictEqual(cards[0].headline, '未发货，退款成功');
  assert.deepStrictEqual(
    cards[0].metaRows.find(item => item.label === '售后状态'),
    { label: '售后状态', value: '未发货，退款成功' }
  );
  assert.deepStrictEqual(
    cards[0].metaRows.find(item => item.label === '退货包运费'),
    { label: '退货包运费', value: '未赠送' }
  );
}

async function run() {
  await testTaggedRemarkUsesSingleWrite();
  await testIntervalRetryDoesNotFallThrough();
  await testIntervalErrorCanRecoverFromLatestRemark();
  await testSavedRemarkCanSurviveListReload();
  await testRemarkApiPrefersPageRequest();
  await testRemarkApiNormalizesPageBusinessError();
  await testSaveOrderRemarkFallsBackWhenFirstWriteNoEffect();
  await testInvalidZeroTagIsNormalizedToEmpty();
  await testSaveOrderRemarkUsesSuccessPayloadShape();
  await testRefundShippingBenefitSupportsBooleanFields();
  await testRefundShippingBenefitSupportsInsuranceTextFields();
  await testAftersaleSideOrdersSupportStatusCodeOnlyQueryList();
}

app.whenReady().then(async () => {
  try {
    await run();
    console.log('order-remark-save test passed');
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

app.on('window-all-closed', event => {
  event.preventDefault();
});
