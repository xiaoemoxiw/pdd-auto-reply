# 接口抓包整理报告

## 产物策略

- `api-traffic-log.jsonl`：本地运行明细日志，默认不提交 Git。
- `api-traffic-index.json`：本地去重索引缓存，可由日志重建，默认不提交 Git。
- `api-traffic-sample.jsonl`：去重后的接口样本，作为仓库内展示面保留。
- `api-traffic-report.md`：给协作者快速浏览抓包覆盖面的概览报告。

## 当前概览

- 店铺数：6
- 抓包总数：7576
- 唯一接口数：812
- 分页分组：
  - unknown：629
  - chat：64
  - invoice：33
  - violation：31
  - ticket：28
  - order：21
  - mail：6

## 去重规则

- 当前接口去重签名由以下字段组成：
  - `transport`
  - `direction`
  - `method`
  - `endpointPath`
  - `command`
  - `resourceType`
  - `pageType`
- 同一签名会合并为一条索引记录，并累计 `hitCount`。

## 高频接口

- `/merchant-web-service/leonWithoutLogin`
  - 方法：POST
  - 命中：390
  - 分组：unknown
  - 摘要：POST · /merchant-web-service/leonWithoutLogin
- `/xg/pfb/a2`
  - 方法：POST
  - 命中：252
  - 分组：unknown
  - 摘要：POST · /xg/pfb/a2
- `/merchant-web-service/leon`
  - 方法：POST
  - 命中：212
  - 分组：unknown
  - 摘要：POST · /merchant-web-service/leon
- `/merchant-web-service/leonWithoutLogin`
  - 方法：POST
  - 命中：176
  - 分组：unknown
  - 摘要：POST · /merchant-web-service/leonWithoutLogin
- `/`
  - 方法：WS-RECV
  - 命中：93
  - 分组：unknown
  - 命令：websocket-received
  - 摘要：received · WS-RECV · / · cmd=websocket-received
- `/`
  - 方法：WS-SEND
  - 命中：93
  - 分组：unknown
  - 命令：websocket-sent
  - 摘要：sent · WS-SEND · / · cmd=websocket-sent
- `/merchant-web-service/leon`
  - 方法：POST
  - 命中：84
  - 分组：unknown
  - 摘要：POST · /merchant-web-service/leon
- `/chats/cs/unreplyUser/count`
  - 方法：GET
  - 命中：80
  - 分组：chat
  - 摘要：chat · GET · /chats/cs/unreplyUser/count
- `/newjersy/api/innerMessage/queryStaticsByUserId`
  - 方法：POST
  - 命中：77
  - 分组：chat
  - 摘要：chat · POST · /newjersy/api/innerMessage/queryStaticsByUserId
- `/api/pmm/defined`
  - 方法：POST
  - 命中：74
  - 分组：chat
  - 摘要：chat · POST · /api/pmm/defined

## 聊天接口

- `/chats/cs/unreplyUser/count`
  - 方法：GET
  - 命中：80
  - 摘要：chat · GET · /chats/cs/unreplyUser/count
- `/newjersy/api/innerMessage/queryStaticsByUserId`
  - 方法：POST
  - 命中：77
  - 摘要：chat · POST · /newjersy/api/innerMessage/queryStaticsByUserId
- `/api/pmm/defined`
  - 方法：POST
  - 命中：74
  - 摘要：chat · POST · /api/pmm/defined
- `/api/pmm/api`
  - 方法：POST
  - 命中：28
  - 摘要：chat · POST · /api/pmm/api
- `/chats/getCsRealTimeReplyData`
  - 方法：GET
  - 命中：12
  - 摘要：chat · GET · /chats/getCsRealTimeReplyData
- `/newjersy/api/innerMessage/queryUnreadCountForType`
  - 方法：POST
  - 命中：10
  - 摘要：chat · POST · /newjersy/api/innerMessage/queryUnreadCountForType
- `/newjersy/api/innerMessage/queryMessageForMerchant`
  - 方法：POST
  - 命中：7
  - 摘要：chat · POST · /newjersy/api/innerMessage/queryMessageForMerchant
- `/newjersy/api/innerMessage/queryStaticsByUserId`
  - 方法：GET
  - 命中：4
  - 摘要：chat · GET · /newjersy/api/innerMessage/queryStaticsByUserId

## 违规接口

- `/api/pmm/front_log`
  - 方法：POST
  - 命中：55
  - 摘要：violation · POST · /api/pmm/front_log
- `/newjersy/api/mms/overlayCard/list`
  - 方法：POST
  - 命中：26
  - 摘要：violation · POST · /newjersy/api/mms/overlayCard/list
- `/api/pmm/defined`
  - 方法：POST
  - 命中：18
  - 摘要：violation · POST · /api/pmm/defined
- `/janus/api/pageResources/sidebar/navigation/query`
  - 方法：POST
  - 命中：17
  - 摘要：violation · POST · /janus/api/pageResources/sidebar/navigation/query
- `/cambridge/api/duoduoChicken/queryFagList`
  - 方法：POST
  - 命中：14
  - 摘要：violation · POST · /cambridge/api/duoduoChicken/queryFagList
- `/newjersy/api/mms/popup`
  - 方法：POST
  - 命中：7
  - 摘要：violation · POST · /newjersy/api/mms/popup
- `/pg/violation_list/mall_manage`
  - 方法：GET
  - 命中：4
  - 摘要：violation · GET · /pg/violation_list/mall_manage
- `/pg/violation_list`
  - 方法：GET
  - 命中：3
  - 摘要：violation · GET · /pg/violation_list

## 发票接口

- `/omaisms/invoice/is_third_party_entity_sub_mall`
  - 方法：POST
  - 命中：17
  - 摘要：invoice · POST · /omaisms/invoice/is_third_party_entity_sub_mall
- `/newjersy/api/mms/overlayCard/list`
  - 方法：POST
  - 命中：12
  - 摘要：invoice · POST · /newjersy/api/mms/overlayCard/list
- `/api/pmm/defined`
  - 方法：POST
  - 命中：10
  - 摘要：invoice · POST · /api/pmm/defined
- `/omaisms/invoice/invoice_list`
  - 方法：POST
  - 命中：8
  - 摘要：invoice · POST · /omaisms/invoice/invoice_list
- `/api/pmm/front_log`
  - 方法：POST
  - 命中：7
  - 摘要：invoice · POST · /api/pmm/front_log
- `/omaisms/invoice/invoice_quick_filter`
  - 方法：POST
  - 命中：6
  - 摘要：invoice · POST · /omaisms/invoice/invoice_quick_filter
- `/voice/api/mms/invoice/mall/verify2`
  - 方法：POST
  - 命中：3
  - 摘要：invoice · POST · /voice/api/mms/invoice/mall/verify2
- `/api/pmm/api`
  - 方法：POST
  - 命中：2
  - 摘要：invoice · POST · /api/pmm/api

## 工单接口

- `/api/pmm/defined`
  - 方法：POST
  - 命中：43
  - 摘要：ticket · POST · /api/pmm/defined
- `/api/pmm/front_log`
  - 方法：POST
  - 命中：34
  - 摘要：ticket · POST · /api/pmm/front_log
- `/janus/api/pageResources/sidebar/navigation/query`
  - 方法：POST
  - 命中：8
  - 摘要：ticket · POST · /janus/api/pageResources/sidebar/navigation/query
- `/aftersales/work_order/tododetail?id=500011418151847`
  - 方法：GET
  - 命中：5
  - 摘要：ticket · GET · /aftersales/work_order/tododetail?id=500011418151847
- `/api/cmt/cmtc_h5`
  - 方法：POST
  - 命中：3
  - 摘要：ticket · POST · /api/cmt/cmtc_h5
- `/newjersy/api/mms/overlayCard/list`
  - 方法：POST
  - 命中：3
  - 摘要：ticket · POST · /newjersy/api/mms/overlayCard/list
- `/cambridge/api/duoduoChicken/queryFagList`
  - 方法：POST
  - 命中：3
  - 摘要：ticket · POST · /cambridge/api/duoduoChicken/queryFagList
- `/newjersy/api/mms/popup`
  - 方法：POST
  - 命中：3
  - 摘要：ticket · POST · /newjersy/api/mms/popup

## 站内信接口

- `/api/pmm/defined`
  - 方法：POST
  - 命中：7
  - 摘要：mail · POST · /api/pmm/defined
- `/api/pmm/front_log`
  - 方法：POST
  - 命中：2
  - 摘要：mail · POST · /api/pmm/front_log
- `/cambridge/api/duoduoChicken/queryFagList`
  - 方法：POST
  - 命中：1
  - 摘要：mail · POST · /cambridge/api/duoduoChicken/queryFagList
- `/janus/api/pageResources/sidebar/navigation/query`
  - 方法：POST
  - 命中：1
  - 摘要：mail · POST · /janus/api/pageResources/sidebar/navigation/query
- `/other/mail/mailList?type=0&id=410303311659`
  - 方法：GET
  - 命中：1
  - 摘要：mail · GET · /other/mail/mailList?type=0&id=410303311659
- `/other/mail/mailList?type=0&id=%5BREDACTED%5D`
  - 方法：GET
  - 命中：1
  - 摘要：mail · GET · /other/mail/mailList?type=0&id=%5BREDACTED%5D

## 订单接口

- `/cambridge/api/retain/order/showEntry`
  - 方法：POST
  - 命中：20
  - 摘要：order · POST · /cambridge/api/retain/order/showEntry
- `/fopen/order/prepare`
  - 方法：POST
  - 命中：7
  - 摘要：order · POST · /fopen/order/prepare
- `/fopen/order/detail`
  - 方法：POST
  - 命中：6
  - 摘要：order · POST · /fopen/order/detail
- `/mars/app/order/statisticWithType`
  - 方法：POST
  - 命中：5
  - 摘要：order · POST · /mars/app/order/statisticWithType
- `/latitude/order/region/get`
  - 方法：GET
  - 命中：4
  - 摘要：order · GET · /latitude/order/region/get
- `/latitude/order/getMallUnpaidOrderCount`
  - 方法：GET
  - 命中：4
  - 摘要：order · GET · /latitude/order/getMallUnpaidOrderCount
- `/fopen/order/receiver`
  - 方法：POST
  - 命中：2
  - 摘要：order · POST · /fopen/order/receiver
- `/pizza/order/remark/query`
  - 方法：POST
  - 命中：2
  - 摘要：order · POST · /pizza/order/remark/query

## 待归类接口

- `/merchant-web-service/leonWithoutLogin`
  - 方法：POST
  - 命中：390
  - 摘要：POST · /merchant-web-service/leonWithoutLogin
- `/xg/pfb/a2`
  - 方法：POST
  - 命中：252
  - 摘要：POST · /xg/pfb/a2
- `/merchant-web-service/leon`
  - 方法：POST
  - 命中：212
  - 摘要：POST · /merchant-web-service/leon
- `/`
  - 方法：WS-RECV
  - 命中：93
  - 摘要：received · WS-RECV · / · cmd=websocket-received
- `/`
  - 方法：WS-SEND
  - 命中：93
  - 摘要：sent · WS-SEND · / · cmd=websocket-sent
- `/api/pmm/defined`
  - 方法：POST
  - 命中：60
  - 摘要：POST · /api/pmm/defined
- `/earth/api/cathet/hints/query`
  - 方法：POST
  - 命中：54
  - 摘要：POST · /earth/api/cathet/hints/query
- `/janus/api/checkLogin`
  - 方法：POST
  - 命中：48
  - 摘要：POST · /janus/api/checkLogin

## 最近点击触发接口

- `/api/pmm/defined`
  - 方法：POST
  - 触发文本：[TEXT]
  - 触发选择器：div.TAB_tabTopOuter_5-163-0 > div.TAB_tabContentInnerContainer_5-163-0 > div.TAB_capsule_5-163-0.TAB_tabItem_5-163-0 > div.TAB_capsuleLabel_5-163-0.TAB_top_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=%5BREDACTED%5D
  - 最近命中：2026/4/6 06:58:03
- `/xg/pfb/a2`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div.outerWrapper-2-2-1.outerWrapper-d12-2-2-14 > div > div > a.BTN_outerWrapper_1a7bz2d.BTN_textPrimary_1a7bz2d
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=%5BREDACTED%5D
  - 最近命中：2026/4/6 06:58:00
- `/janus/api/checkLogin`
  - 方法：POST
  - 触发文本：[TEXT]
  - 触发选择器：div.TAB_tabTopOuter_5-163-0 > div.TAB_tabContentInnerContainer_5-163-0 > div.TAB_capsule_5-163-0.TAB_tabItem_5-163-0 > div.TAB_capsuleLabel_5-163-0.TAB_top_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=%5BREDACTED%5D
  - 最近命中：2026/4/6 06:57:31
- `/fopen/order/prepare`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:20
- `/merchant-web-service/leonWithoutLogin`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:20
- `/merchant-web-service/leon`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:20
- `/mangkhut/mms/orderDetail`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:20
- `/tornado/expGrayCheck/allScenes`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:20
- `/xg/pfb/b`
  - 方法：GET
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:20
- `/api/cmt/cmtc_h5`
  - 方法：OPTIONS
  - 触发文本：[TEXT]
  - 触发选择器：div#mf-mms-aftersales-container > div > div.todoList_container__38-2E > div.Spn_nested_5-163-0
  - 触发页面：https://mms.pinduoduo.com/aftersales/work_order/list
  - 最近命中：2026/4/6 06:43:17

## 当前判断

- `unknown` 分组仍有 629 个接口，约占 77% ，后续可继续补充 pageType 识别规则。
- 聊天域已识别 64 个唯一接口，适合继续围绕会话、未读和消息详情做字段梳理。
- 非聊天业务域已经有可复用接口样本，可直接按样本回看请求头、请求体和响应结构。
- 当前保留了 10 条最近点击触发接口，后续排查页面操作链路时可以优先沿这些触发点继续抓。

## 常用命令

```bash
pnpm run export:api-sample
```

```bash
pnpm run build:api-traffic-report
```

```bash
pnpm run refresh:api-traffic-artifacts
```

```bash
pnpm run rebuild:api-traffic-index
```
