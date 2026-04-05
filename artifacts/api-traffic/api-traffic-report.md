# 接口抓包整理报告

## 产物说明

- `api-traffic-log.jsonl`：项目内默认抓包明细日志，已脱敏
- `api-traffic-index.json`：按接口签名聚合后的去重索引
- `api-traffic-log.redacted.jsonl`：脱敏快照，适合留档
- `api-traffic-sample.jsonl`：去重后的接口样本，适合快速浏览

## 当前概览

- 店铺数：1
- 抓包总数：1150
- 唯一接口数：219
- 分页分组：
  - unknown：186
  - chat：17
  - order：3
  - invoice：9
  - violation：3
  - mail：1

## 去重规则

- 当前接口去重签名由以下字段组成：
  - `transport`
  - `direction`
  - `method`
  - `endpointPath`
  - `command`
  - `resourceType`
  - `pageType`
- 同一签名会合并为一条索引记录，并累计 `hitCount`

## 高频接口

- `/merchant-web-service/leonWithoutLogin`
  - 方法：POST
  - 命中：102
  - 分组：unknown
- `/chats/cs/unreplyUser/count`
  - 方法：GET
  - 命中：68
  - 分组：chat
- `/merchant-web-service/leon`
  - 方法：POST
  - 命中：49
  - 分组：unknown
- `/newjersy/api/innerMessage/queryStaticsByUserId`
  - 方法：POST
  - 命中：38
  - 分组：chat
- `/api/pmm/defined`
  - 方法：POST
  - 命中：30
  - 分组：unknown

## 聊天接口

- `/chats/cs/unreplyUser/count`
  - 用途倾向：未回复用户计数
- `/newjersy/api/innerMessage/queryStaticsByUserId`
  - 用途倾向：会话统计
- `/newjersy/api/innerMessage/queryUnreadCountForType`
  - 用途倾向：未读计数
- `/newjersy/api/innerMessage/queryMessageForMerchant`
  - 用途倾向：消息列表
- `/newjersy/api/innerMessage/queryMsgListForMerchant`
  - 用途倾向：消息明细

## 违规接口

- `/genji/reaper/violation/question/query/examQuestion`
  - 用途倾向：违规考试/题目详情
- `/pg/violation_list/mall_manage?msfrom=mms_sidenav`
  - 用途倾向：违规列表页入口
- `/pg/violation_info?appeal_sn=...&violation_type=...`
  - 用途倾向：违规详情页入口

## 发票接口

- `/omaisms/invoice/is_third_party_entity_sub_mall`
- `/voice/api/mms/invoice/mall/verify2`
- `/omaisms/invoice/invoice_list`
- `/invoice/center?msfrom=mms_sidenav&activeKey=0`
- `/omaisms/invoice/pop_notice`

## 已识别的点击触发接口

- 触发页面：
  - `https://mms.pinduoduo.com/pg/violation_list/mall_manage?msfrom=mms_sidenav`
- 触发元素：
  - `tbody > tr.TB_tr_5-166-0.TB_whiteTr_5-166-0 > td.TB_td_5-166-0.TB_cellTextAlignLeft_5-166-0 > a`
- 关联接口：
  - `/api/pmm/defined`
  - `/api/pmm/front_log`
  - `/newjersy/api/mms/overlayCard/list`
  - `/newjersy/api/msgBox/v1/total?type=normal`
  - `/janus/api/subSystem/getAuthToken`

## 当前判断

- 现有抓包已覆盖聊天、违规、发票、订单、站内信几个主要业务域
- `unknown` 组接口仍然最多，后续需要继续补 `pageType` 识别规则
- 违规页“查看详情”已经能稳定带出一组点击触发型接口，适合继续沿这条链路做接口梳理
- 聊天域已经抓到统计、未读、消息列表、消息明细等核心接口，适合继续拆请求体与响应体结构

## 常用命令

```bash
pnpm run analyze:api-traffic -- --limit=20
```

```bash
pnpm run analyze:api-traffic -- --pageType=chat --limit=20
```

```bash
pnpm run analyze:api-traffic -- --pageType=violation --limit=20
```

```bash
pnpm run rebuild:api-traffic-index
```

```bash
pnpm run export:api-sample
```
