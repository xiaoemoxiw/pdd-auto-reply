// 第一次驳回提交链接
[03:29:28] [POST] /mercury/negotiate/mms/afterSales/getRejectNegotiateInfo -> 200
{
  "requestId": "5026.944",
  "timestamp": 1776194968351,
  "url": "/mercury/negotiate/mms/afterSales/getRejectNegotiateInfo",
  "fullUrl": "https://mms.pinduoduo.com/mercury/negotiate/mms/afterSales/getRejectNegotiateInfo",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102"
  },
  "requestBody": "{\"orderSn\":\"260410-556898731662102\",\"afterSalesId\":20013934661648,\"key\":\"ProMultiSolution\"}",
  "initiator": "script",
  "initiatorDetails": {
    "type": "script",
    "url": "https://mms-static.pinduoduo.com/aftersales-ssr/_next/static/chunks/commons.115d9f796df59a28f0ff.mms-aftersales-ssr.js",
    "lineNumber": 0,
    "columnNumber": 238717,
    "functionName": ""
  },
  "resourceType": "Fetch",
  "documentURL": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
  "status": 200,
  "mimeType": "application/json",
  "responseHeaders": {
    "content-type": "application/json;charset=UTF-8"
  },
  "responseBody": {
    "success": true,
    "errorCode": 1000000,
    "errorMsg": null,
    "result": {
      "refundableAmount": 9030,
      "negotiateSolutionList": [
        {
          "extraMods": [
            "refundAmount"
          ],
          "code": "partial_refund",
          "text": "退款$refundAmount（无需退货）",
          "desc": "协商退款金额"
        },
        {
          "extraMods": [],
          "code": "return_refund",
          "text": "退货退款",
          "desc": "退货后退全款"
        },
        {
          "extraMods": [],
          "code": "exchange",
          "text": "换货",
          "desc": "换货"
        },
        {
          "extraMods": [],
          "code": "resend",
          "text": "补寄",
          "desc": "补寄"
        }
      ],
      "afterSalesApplyAmount": 9030
    }
  },
  "isJson": true,
  "triggerContext": null,
  "recordedAt": 1776194968351,
  "endpointPath": "/mercury/negotiate/mms/afterSales/getRejectNegotiateInfo",
  "host": "mms.pinduoduo.com",
  "command": "",
  "transport": "http",
  "direction": "request-response",
  "pageType": "ticket",
  "summary": "ticket · POST · /mercury/negotiate/mms/afterSales/getRejectNegotiateInfo"
}



[03:31:24] [POST] /mercury/mms/afterSales/rejectRefundSubmitFormData -> 200
{
  "requestId": "5026.993",
  "timestamp": 1776195084537,
  "url": "/mercury/mms/afterSales/rejectRefundSubmitFormData",
  "fullUrl": "https://mms.pinduoduo.com/mercury/mms/afterSales/rejectRefundSubmitFormData",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102"
  },
  "requestBody": "{\"formName\":\"新售后驳回标准化流程_日用品_step1\",\"formDataList\":[{\"keyLabel\":\"\",\"value\":\"option1\",\"key\":\"RadioGroup1\",\"valueLabel\":\"与消费者协商售后方案\"},{\"value\":\"[{\\\"keyLabel\\\":\\\"协商方案\\\",\\\"value\\\":\\\"[{\\\\\\\"value\\\\\\\":\\\\\\\"return_refund\\\\\\\",\\\\\\\"valueLabel\\\\\\\":\\\\\\\"退货后退全款\\\\\\\"}]\\\",\\\"key\\\":\\\"CheckboxGroupNegotiatedSolution\\\"},{\\\"keyLabel\\\":\\\"退款金额\\\",\\\"key\\\":\\\"RefundAmount\\\"},{\\\"keyLabel\\\":\\\"协商话术\\\",\\\"value\\\":\\\"'亲，很抱歉给您带来了不好的购物体验～' 我们想与您协商“退货退款”，您看可以吗～\\\",\\\"key\\\":\\\"RefundWords\\\"},{\\\"keyLabel\\\":\\\"上传凭证\\\",\\\"value\\\":\\\"[]\\\",\\\"key\\\":\\\"MmsUpload\\\"}]\",\"key\":\"ProMultiSolution1\"},{\"key\":\"FormId\",\"value\":\"form1\",\"keyLabel\":\"\",\"valueLabel\":\"\"}],\"orderSn\":\"260410-556898731662102\",\"afterSalesId\":20013934661648,\"bizType\":10,\"bizId\":\"20013934661648\"}",
  "initiator": "script",
  "initiatorDetails": {
    "type": "script",
    "url": "https://mms-static.pinduoduo.com/aftersales-ssr/_next/static/chunks/commons.115d9f796df59a28f0ff.mms-aftersales-ssr.js",
    "lineNumber": 0,
    "columnNumber": 238717,
    "functionName": ""
  },
  "resourceType": "Fetch",
  "documentURL": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
  "status": 200,
  "mimeType": "application/json",
  "responseHeaders": {
    "content-type": "application/json;charset=UTF-8"
  },
  "responseBody": "",
  "isJson": false,
  "responseBodyUnavailable": true,
  "responseBodyError": "No resource with given identifier found",
  "triggerContext": null,
  "recordedAt": 1776195084537,
  "endpointPath": "/mercury/mms/afterSales/rejectRefundSubmitFormData",
  "host": "mms.pinduoduo.com",
  "command": "",
  "transport": "http",
  "direction": "request-response",
  "pageType": "ticket",
  "summary": "ticket · POST · /mercury/mms/afterSales/rejectRefundSubmitFormData"
}

// 第二次驳回提交链接
[POST] /mercury/mms/afterSales/rejectRefundGetFormInfo -> 200
{
  "requestId": "5026.2170",
  "timestamp": 1776197934160,
  "url": "/mercury/mms/afterSales/rejectRefundGetFormInfo",
  "fullUrl": "https://mms.pinduoduo.com/mercury/mms/afterSales/rejectRefundGetFormInfo",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102"
  },
  "requestBody": "{\"bizType\":2,\"bizId\":\"20013934661648\",\"orderSn\":\"260410-556898731662102\",\"afterSalesId\":20013934661648}",
  "initiator": "script",
  "initiatorDetails": {
    "type": "script",
    "url": "https://mms-static.pinduoduo.com/aftersales-ssr/_next/static/chunks/commons.115d9f796df59a28f0ff.mms-aftersales-ssr.js",
    "lineNumber": 0,
    "columnNumber": 238717,
    "functionName": ""
  },
  "resourceType": "Fetch",
  "documentURL": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
  "status": 200,
  "mimeType": "application/json",
  "responseHeaders": {
    "content-type": "application/json;charset=UTF-8"
  },
  "responseBody": {
    "success": true,
    "errorCode": 1000000,
    "errorMsg": null,
    "result": {
      "finished": false,
      "formName": "新售后驳回标准化流程_日用品_step2",
      "formText": {
        "taskSet": {
          "taskTitle": "",
          "taskDesc": "",
          "showExample": false,
          "label": ""
        },
        "buttonSet": [
          {
            "type": "primary",
            "name": "提交"
          }
        ]
      },
      "formSchema": [
        {
          "id": "container",
          "name": "undefined",
          "el": "formGrid",
          "colSpan": "24",
          "properties": {
            "rowSpan": 24,
            "direction": "horizontal"
          },
          "formItemProperties": "{}",
          "children": [
            {
              "id": "854098da-0d4d-4a3a-b4e4-00d64cf10391",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第一步：请选择您与消费者的协商结果：",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText1"
              },
              "children": []
            },
            {
              "id": "ae90fb77-f1b0-4fca-b21b-f6f63a41bd49",
              "name": "undefined",
              "el": "RadioGroup",
              "colSpan": "24",
              "properties": {
                "mode": "radioButton",
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "options": [
                  {
                    "label": "退款金额未达成一致",
                    "value": "option1",
                    "desc": "",
                    "defaultCheck": true
                  },
                  {
                    "label": "消费者提供的凭证不足",
                    "value": "option2",
                    "desc": "",
                    "defaultCheck": false
                  },
                  {
                    "label": "因商品在途，与消费者协商",
                    "value": "option3",
                    "defaultCheck": false
                  },
                  {
                    "label": "已与消费者协商达成一致",
                    "value": "option4",
                    "defaultCheck": false
                  },
                  {
                    "label": "消费者物流已签收但未拿到到货",
                    "value": "option5",
                    "defaultCheck": false
                  },
                  {
                    "label": "消费者退货物流在途",
                    "value": "option6",
                    "defaultCheck": false
                  },
                  {
                    "label": "消费者退回的商品有问题",
                    "value": "option7",
                    "defaultCheck": false
                  }
                ],
                "visibleRule": {
                  "rules": [],
                  "totalRule": ""
                },
                "initialValue": "option1",
                "itemWidth": "232"
              },
              "formItemProperties": {
                "field": "RadioGroup1",
                "label": "",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "befb4e83-887a-4c3d-91b5-cef83a392e0e",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请与消费者协商退款金额，提交后将自动发送协商话术给消费者。",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": true,
                  "examples": []
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option1"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText2"
              },
              "children": []
            },
            {
              "id": "3a07c66a-580d-4532-89e4-ca9d609ee8a2",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "平台建议您根据问题商品的比例进行赔付，可参考平台规则",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.4)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option1"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText3"
              },
              "children": []
            },
            {
              "id": "92ea43d0-6bf7-4acf-aa42-f5f59976240f",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option1"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords1"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    },
                    "disabled": true
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲~ 我们已经仔细了解了您的问题。如果您收到的商品有问题，我们愿意根据实际情况补偿您的损失~ 您看看能不能再协商下退款金额呢？"
                      }
                    ]
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "ce3c3431-f1c3-4fc4-8227-f16098498b41",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请按要求上传能证明发货商品没有问题的凭证，并邀请消费者举证，主动了解消费者遇到的问题。若您上传无效或虚假凭证，平台会根据现有规则直接判责。提交后将自动发送凭证和协商话术给消费者",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText4"
              },
              "children": []
            },
            {
              "id": "490cbd2d-a8b3-4f4e-97a5-6808bba4f129",
              "name": "undefined",
              "el": "RadioGroup",
              "colSpan": "24",
              "properties": {
                "mode": "radioButton",
                "exampleContent": {
                  "text": "",
                  "hasExample": true,
                  "marginBottom": 0
                },
                "options": [
                  {
                    "label": "少发漏发",
                    "value": "option1",
                    "desc": "",
                    "defaultCheck": true
                  },
                  {
                    "label": "描述不符",
                    "value": "option2",
                    "desc": "",
                    "defaultCheck": false
                  },
                  {
                    "label": "质量问题",
                    "value": "option3",
                    "defaultCheck": false
                  }
                ],
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    }
                  ],
                  "totalRule": "r0"
                },
                "initialValue": "option1",
                "itemWidth": "232"
              },
              "formItemProperties": {
                "field": "RadioGroup2",
                "label": "待消费者提供凭证",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "2a330f65-3878-4fa3-a376-08546f652da5",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    },
                    {
                      "leftVal": "RadioGroup2",
                      "operate": "==",
                      "rightVal": "option1"
                    }
                  ],
                  "totalRule": "r0&r1"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload1",
                "label": "发货凭证图",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "74a9c248-4e65-481f-a41f-8d13c8a041cc",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    },
                    {
                      "leftVal": "RadioGroup2",
                      "operate": "==",
                      "rightVal": "option1"
                    }
                  ],
                  "totalRule": "r0&&r1"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords2"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    },
                    "disabled": true
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲~您看看这是我们商品发货相关信息~ 如果您收到的商品少件，还请把收到的商品拍张照片给我们，我们会尽快处理您的申请~ \n"
                      }
                    ]
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "6129e455-af95-48da-93ec-c46738643e36",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    },
                    {
                      "leftVal": "RadioGroup2",
                      "operate": "==",
                      "rightVal": "option2"
                    }
                  ],
                  "totalRule": "r0&r1"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload2",
                "label": "商品细节图和发货商品图",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "434d7306-d4d9-456c-a11d-261b07a0e8b6",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    },
                    {
                      "leftVal": "RadioGroup2",
                      "operate": "==",
                      "rightVal": "option2"
                    }
                  ],
                  "totalRule": "r0&r1"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords3"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "disabled": true,
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    }
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲~您看看这是我们商品细节信息和发货实物相符的相关信息~  如果您收到的商品确实有问题，还请把收到描述不符的商品拍张照片给我们，我们会尽快处理您的申请~"
                      }
                    ],
                    "defaultRecommand": false,
                    "defaultRecommandWords": ""
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "58c96850-0973-40fc-8a85-97471e185758",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    },
                    {
                      "leftVal": "RadioGroup2",
                      "operate": "==",
                      "rightVal": "option3"
                    }
                  ],
                  "totalRule": "r0&r1"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload3",
                "label": "商品细节图和发货商品图",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "1f0d4dfd-0754-428d-b5d5-d247ce805855",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option2"
                    },
                    {
                      "leftVal": "RadioGroup2",
                      "operate": "==",
                      "rightVal": "option3"
                    }
                  ],
                  "totalRule": "r0&r1"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords4"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "disabled": true,
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    }
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲~您看看这是我们的发货商品相关信息~ 如果您收到的商品确实有质量问题，还请把有问题的商品拍张照片给我们，我们会尽快处理您的申请~ "
                      }
                    ],
                    "defaultRecommand": false,
                    "defaultRecommandWords": ""
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "1f16cf08-c57a-4702-b48f-23e022cd6e46",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请主动了解消费者遇到的问题，并协商解决方案。提交后将自动发送协商话术给消费者",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option3"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText5"
              },
              "children": []
            },
            {
              "id": "f413f4a1-675a-4d2a-9d89-f62434d1f05d",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option3"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords5"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    },
                    "disabled": true
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲，抱歉给您带来不好的体验！我们已联系物流公司召回商品，如果召回失败，请您在快递员派送时向快递员说明，“这个快递不要了，麻烦退回寄件方”。拒收后待我们收到快递，将尽快为您退款。"
                      }
                    ]
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "4462afdb-0340-4b30-8396-cbf5e4077a67",
              "name": "undefined",
              "el": "NoticeBar",
              "colSpan": "24",
              "properties": {
                "type": "warn",
                "content": [
                  {
                    "notice": {
                      "text": "平台监控中："
                    },
                    "key": 0
                  },
                  {
                    "notice": {
                      "text": "▪ 驳回后，消费者可以要求拼多多介入处理，如果核实是您的责任，将影响您的店铺纠纷退款率"
                    },
                    "key": 0
                  },
                  {
                    "notice": {
                      "text": "▪ 如果您提供无效或虚假凭证，平台会根据现有规则直接判定并处理"
                    },
                    "key": 1
                  }
                ],
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option4"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "NoticeBar1",
                "label": "",
                "labelWidth": 0,
                "rowSpan": 24,
                "required": false,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "dcf62786-78a4-4953-a655-11d566b80faf",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请补充必要的驳回描述及凭证信息。如平台审核通过，可完成此次驳回。请在驳回后向消费者发送温馨的致歉，及时安抚好消费者的情绪，避免纠纷退款",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option4"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText6"
              },
              "children": []
            },
            {
              "id": "39470e51-d3b7-4a34-a20a-a14023f0f7d8",
              "name": "undefined",
              "el": "Select",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "options": [
                  {
                    "label": "已与消费者协商达成一致",
                    "value": "option1",
                    "defaultCheck": true
                  }
                ],
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option4"
                    }
                  ],
                  "totalRule": "r0"
                },
                "initialValue": "option1",
                "disabled": true
              },
              "formItemProperties": {
                "field": "Select1",
                "label": "驳回原因",
                "labelWidth": 88,
                "fieldWidth": 240,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "3eee8723-3fd9-4972-9975-9d438094b2a9",
              "name": "undefined",
              "el": "TextArea",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "placeholder": "请输入",
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "autosize": {
                  "minRows": 8
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option4"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "TextArea1",
                "label": "驳回描述",
                "labelWidth": 88,
                "fieldWidth": 376,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "8584ac9d-2847-4ae2-9015-ef3b23503e89",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "请上传与消费者聊天的截图；最多可上传3张图片",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option4"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload4",
                "label": "协商凭证",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "6c146691-b24a-49da-b0c4-97d8490f7df4",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请主动了解消费者遇到的问题，并协商解决方案。提交后将自动发送协商话术给消费者",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option5"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText7"
              },
              "children": []
            },
            {
              "id": "45a9d13a-5894-413f-9ca4-5f8907981629",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option5"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload5",
                "label": "联系物流处理凭证",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "8aaa410a-ea49-4ae5-902b-d4791767f3f0",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option5"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords6"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "disabled": true,
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    }
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲，先不要着急哦，我这边帮亲联系下快递问下情况，这是我们联系物流公司处理的相关凭证，我们会尽快与物流公司解决您的问题"
                      }
                    ],
                    "defaultRecommand": false,
                    "defaultRecommandWords": ""
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "721aa8b1-3091-4e2e-8a70-6b01eebc0d1d",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请主动了解消费者遇到的问题，并协商解决方案。提交后将自动发送协商话术给消费者",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option6"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText8"
              },
              "children": []
            },
            {
              "id": "f7430d33-b5bc-4a1f-b9e5-8f59326923b2",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "exampleContent": {
                  "text": "",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option6"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload6",
                "label": "退货物流凭证",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "309bf5ed-c083-4b24-8308-93eaa2deee06",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option6"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords7"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "disabled": true,
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    }
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲，抱歉给您带来不好的体验！这是您的退货物流还未签收的相关凭证，待我们确认收到退货并验收后，会尽快处理您的售后，请放心~一定给您处理~\n"
                      }
                    ],
                    "defaultRecommand": false,
                    "defaultRecommandWords": ""
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "6e513a47-5cae-4fef-8bcd-06a41dc536ce",
              "name": "undefined",
              "el": "ProDisplayText",
              "colSpan": "24",
              "properties": {
                "exampleContent": {
                  "text": "第二步：请主动了解消费者遇到的问题，并协商解决方案。提交后将自动发送协商话术给消费者",
                  "fontSize": 12,
                  "fontWeight": 400,
                  "color": "rgba(0, 0, 0, 0.8)",
                  "lineHeight": 14,
                  "hasExample": false
                },
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option7"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProDisplayText9"
              },
              "children": []
            },
            {
              "id": "987d8641-8de1-486f-a7c5-1254605a092d",
              "name": "undefined",
              "el": "MmsUpload",
              "colSpan": "24",
              "properties": {
                "disabled": false,
                "exampleContent": {
                  "text": "请上传消费者退货不符合退货标准的凭证信息；最多可上传3张图片",
                  "hasExample": false,
                  "marginBottom": 0
                },
                "maxNum": "3",
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option7"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "MmsUpload7",
                "label": "商品凭证",
                "labelWidth": 88,
                "rowSpan": 24,
                "required": true,
                "validateOnChange": true,
                "validateOnBlur": false,
                "labelAlign": {
                  "value": "right",
                  "default": "right"
                },
                "help": ""
              },
              "children": []
            },
            {
              "id": "368caa47-841b-4b1d-80ba-638542a62a61",
              "name": "undefined",
              "el": "ProRecommendWords",
              "colSpan": "24",
              "properties": {
                "visibleRule": {
                  "rules": [
                    {
                      "leftVal": "RadioGroup1",
                      "operate": "==",
                      "rightVal": "option7"
                    }
                  ],
                  "totalRule": "r0"
                }
              },
              "formItemProperties": {
                "field": "ProRecommendWords8"
              },
              "children": [
                {
                  "id": "TextArea",
                  "name": "undefined",
                  "el": "TextArea",
                  "colSpan": "24",
                  "properties": {
                    "disabled": true,
                    "placeholder": "请输入",
                    "exampleContent": {
                      "text": "",
                      "hasExample": false
                    },
                    "autosize": {
                      "minRows": 8
                    },
                    "visibleRule": {
                      "rules": [],
                      "totalRule": ""
                    }
                  },
                  "formItemProperties": {
                    "field": "Words",
                    "label": "协商话术",
                    "labelWidth": 88,
                    "fieldWidth": 376,
                    "rowSpan": 24,
                    "required": true,
                    "validateOnChange": true,
                    "validateOnBlur": false,
                    "labelAlign": {
                      "value": "right",
                      "default": "right"
                    },
                    "help": "提交后，此话术将自动发送给消费者",
                    "recommandWords": [
                      {
                        "label": "推荐话术",
                        "value": "亲，抱歉给您带来不好的体验！这是您的退货不符合退货标准的凭证，希望与您协商解决方案，感谢您的理解和支持~"
                      }
                    ],
                    "defaultRecommand": false,
                    "defaultRecommandWords": ""
                  },
                  "children": []
                }
              ]
            }
          ]
        }
      ],
      "formDataList": [],
      "bizType": 10
    }
  },
  "isJson": true,
  "triggerContext": null,
  "recordedAt": 1776197934160,
  "endpointPath": "/mercury/mms/afterSales/rejectRefundGetFormInfo",
  "host": "mms.pinduoduo.com",
  "command": "",
  "transport": "http",
  "direction": "request-response",
  "pageType": "ticket",
  "summary": "ticket · POST · /mercury/mms/afterSales/rejectRefundGetFormInfo"
}

[04:22:04] [POST] /mercury/mms/afterSales/rejectRefundSubmitFormData -> 200
{
  "requestId": "5026.2236",
  "timestamp": 1776198123861,
  "url": "/mercury/mms/afterSales/rejectRefundSubmitFormData",
  "fullUrl": "https://mms.pinduoduo.com/mercury/mms/afterSales/rejectRefundSubmitFormData",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102"
  },
  "requestBody": "{\"formName\":\"新售后驳回标准化流程_日用品_step2\",\"formDataList\":[{\"key\":\"ProDisplayText1\"},{\"keyLabel\":\"\",\"value\":\"option1\",\"key\":\"RadioGroup1\",\"valueLabel\":\"退款金额未达成一致\"},{\"key\":\"ProDisplayText2\"},{\"key\":\"ProDisplayText3\"},{\"value\":\"[{\\\"keyLabel\\\":\\\"协商话术\\\",\\\"value\\\":\\\"亲~ 我们已经仔细了解了您的问题。如果您收到的商品有问题，我们愿意根据实际情况补偿您的损失~ 您看看能不能再协商下退款金额呢？\\\",\\\"key\\\":\\\"Words\\\"}]\",\"key\":\"ProRecommendWords1\"},{\"key\":\"FormId\",\"value\":\"container\",\"keyLabel\":\"\",\"valueLabel\":\"\"}],\"orderSn\":\"260410-556898731662102\",\"afterSalesId\":20013934661648,\"bizType\":10,\"bizId\":\"20013934661648\"}",
  "initiator": "script",
  "initiatorDetails": {
    "type": "script",
    "url": "https://mms-static.pinduoduo.com/aftersales-ssr/_next/static/chunks/commons.115d9f796df59a28f0ff.mms-aftersales-ssr.js",
    "lineNumber": 0,
    "columnNumber": 238717,
    "functionName": ""
  },
  "resourceType": "Fetch",
  "documentURL": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
  "status": 200,
  "mimeType": "application/json",
  "responseHeaders": {
    "content-type": "application/json;charset=UTF-8"
  },
  "responseBody": {
    "success": true,
    "errorCode": 1000000,
    "errorMsg": null,
    "result": {
      "success": true,
      "errMsg": null,
      "rejectRefundImmediately": false
    }
  },
  "isJson": true,
  "triggerContext": null,
  "recordedAt": 1776198123861,
  "endpointPath": "/mercury/mms/afterSales/rejectRefundSubmitFormData",
  "host": "mms.pinduoduo.com",
  "command": "",
  "transport": "http",
  "direction": "request-response",
  "pageType": "ticket",
  "summary": "ticket · POST · /mercury/mms/afterSales/rejectRefundSubmitFormData"
}


// 第三次驳回提交链接
[04:54:51] [POST] /mercury/mms/afterSales/rejectRefundReasons -> 200
{
  "requestId": "5026.3443",
  "timestamp": 1776200091112,
  "url": "/mercury/mms/afterSales/rejectRefundReasons",
  "fullUrl": "https://mms.pinduoduo.com/mercury/mms/afterSales/rejectRefundReasons",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102"
  },
  "requestBody": "{\"orderSn\":\"260410-556898731662102\",\"afterSalesId\":20013934661648,\"uid\":null,\"rejectPopupWindowType\":2,\"withHandlingSuggestion\":true,\"rejectReasonCode\":1001}",
  "initiator": "script",
  "initiatorDetails": {
    "type": "script",
    "url": "https://mms-static.pinduoduo.com/aftersales-ssr/_next/static/chunks/commons.115d9f796df59a28f0ff.mms-aftersales-ssr.js",
    "lineNumber": 0,
    "columnNumber": 238717,
    "functionName": ""
  },
  "resourceType": "Fetch",
  "documentURL": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
  "status": 200,
  "mimeType": "application/json",
  "responseHeaders": {
    "content-type": "application/json;charset=UTF-8"
  },
  "responseBody": {
    "success": true,
    "errorCode": 1000000,
    "errorMsg": null,
    "result": [
      {
        "rejectReasonCode": 1001,
        "rejectReasonDesc": "消费者描述与实际情况不符",
        "handlingSuggestions": [
          "商家应与用户进一步协商合理售后处理方案",
          "商家应核实商品与描述不符的具体问题并反馈"
        ],
        "requiredProofs": null,
        "requiredRejectDescs": null,
        "rejectChatTip": null,
        "rejectChatTipTemplateName": null,
        "rejectChatTipTitleId": null,
        "mustPushExpressEvidence": null,
        "mustPushExpressInfo": null,
        "chooseRejectReasonTips": null,
        "mustPushEvidence": null,
        "evidenceType": null,
        "pushEvidenceTips": null,
        "pushEvidenceTipContent": null,
        "selectRejectReasonCodeWhenSendChatTip": null,
        "consumerNoProofReasons": null
      }
    ]
  },
  "isJson": true,
  "triggerContext": null,
  "recordedAt": 1776200091112,
  "endpointPath": "/mercury/mms/afterSales/rejectRefundReasons",
  "host": "mms.pinduoduo.com",
  "command": "",
  "transport": "http",
  "direction": "request-response",
  "pageType": "ticket",
  "summary": "ticket · POST · /mercury/mms/afterSales/rejectRefundReasons"
}


 /mercury/merchant/afterSales/refuse -> 200
{
  "requestId": "5026.3673",
  "timestamp": 1776200357004,
  "url": "/mercury/merchant/afterSales/refuse",
  "fullUrl": "https://mms.pinduoduo.com/mercury/merchant/afterSales/refuse",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102"
  },
  "requestBody": "{\"reason\":\"反馈商品少发漏发，消费者未提供凭证\",\"operateDesc\":\"商品已签收，如需退款，请选择退货退款，商品退回后为您退款\",\"images\":[\"https://pfs.pinduoduo.com/merchant-aftersale-media/2026-04-15/6e2c14c8-eb9f-4e96-992a-c1965107469e.png\"],\"shipImages\":[],\"consumerReason\":\"\",\"requiredRejectDescs\":[{\"type\":\"商家应回应用户提出的商品与宣传不一致问题\"},{\"type\":\"自行补充其他描述\",\"desc\":\"商品已签收，如需退款，请选择退货退款，商品退回后为您退款\"}],\"rejectReasonCode\":38,\"id\":20013934661648,\"mallId\":null,\"version\":3,\"orderSn\":\"260410-556898731662102\",\"requiredProofs\":[{\"proofCode\":114,\"images\":[]},{\"proofCode\":118,\"images\":[]}]}",
  "initiator": "script",
  "initiatorDetails": {
    "type": "script",
    "url": "https://mms-static.pinduoduo.com/aftersales-ssr/_next/static/chunks/commons.115d9f796df59a28f0ff.mms-aftersales-ssr.js",
    "lineNumber": 0,
    "columnNumber": 238717,
    "functionName": ""
  },
  "resourceType": "Fetch",
  "documentURL": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
  "status": 200,
  "mimeType": "application/json",
  "responseHeaders": {
    "content-type": "application/json;charset=UTF-8"
  },
  "responseBody": {
    "success": true,
    "errorCode": 1000000,
    "errorMsg": null,
    "result": {
      "id": 20013934661648,
      "canMerchantFeedback": false,
      "attributeCode": 0,
      "hitCruseNeedPop": false,
      "merchantRejectSuccess": true,
      "merchantProofValid": true,
      "imagesReverseTrackingNumberMismatch": null
    }
  },
  "isJson": true,
  "triggerContext": {
    "timestamp": 1776200356239,
    "pageUrl": "https://mms.pinduoduo.com/aftersales-ssr/detail?id=20013934661648&orderSn=260410-556898731662102",
    "actionType": "click",
    "targetText": "提交",
    "targetTag": "button",
    "targetRole": "",
    "targetHref": "",
    "targetSelector": "div.MDL_bottom_5-177-0 > div.MDL_footer_5-177-0 > div > button.BTN_outerWrapper_5-177-0.BTN_primary_5-177-0",
    "x": 899,
    "y": 745,
    "messagePreview": "",
    "source": "embedded-page",
    "currentView": "aftersale",
    "requestDelayMs": 765
  },
  "recordedAt": 1776200357004,
  "endpointPath": "/mercury/merchant/afterSales/refuse",
  "host": "mms.pinduoduo.com",
  "command": "",
  "transport": "http",
  "direction": "request-response",
  "pageType": "ticket",
  "summary": "ticket · POST · /mercury/merchant/afterSales/refuse"
}
