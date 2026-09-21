---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# Header双向过滤与受控真实流执行

## 交付与范围

SEC-D1-02B交付显式内存CompiledHeaderPolicyV1的数据面执行器与受控真实HTTP/TCP验收。不是生产v1上线：Publication保存、Gateway策略编译、Registry激活及冷恢复的NOT_READY门禁全部保留；普通已部署legacy继续旧路径。父包D1仍IN_PROGRESS。

- [双向原始字段过滤](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-wire-policy.ts)：rawHeaders优先，内部fallback保留数组/大小写重复，allowlist、数量/大小/值/重复与framing检查，消费者/托管认证剥离，peer/TLS代理字段与可信凭据最后注入。
- [真实代理](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts)：Transform按原始实体字节检查长度，不解压或无界缓冲；HEAD/204/304单独处理；坏响应写头前固定502，流后失败销毁连接；trailer丢弃只记录固定事件，不存名称/值。
- [入口边界](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-http-ingress-boundary.ts)：checkContinue/checkExpectation/upgrade先于应用拒绝；大小写路径一致，错误异步predicate固定503并消费拒绝。必须由可信bootstrap在初始化后、listen前安装，当前未接生产main；可信进程代码仍必须维护监听器完整性。
- [Runtime编排](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)：compiled v1全量绕过旧缓存读写及缓存正文捕获，Header拒绝不重试；这只是未完成C期间的隔离，不算Header缓存功能完成。

## 验证

Windows本机、合成秘密与回环HTTP/TCP；未访问生产目标，未更改依赖或数据库结构。

| 验证 | 当前结果 |
| --- | --- |
| API联合回归（含新Header、入口、proxy、旧Gateway/缓存/审计/发布/激活门禁） | 26套353/353，detectOpenHandles通过；原始记录 `.tmp/header-wire-regression.log`，补充用例另列 |
| 双向纯字段专项 | 60/60，含多Set-Cookie剥离/缓存veto、Connection不能掩盖framing、Resolver固定503 |
| 独立入口真实TCP | 15/15，无提前100；兼容原监听器/once，大小写及异常predicate |
| 真实proxy HTTP/TCP | 最终21/21，detectOpenHandles；含新增4MiB双向chunked/增量摘要/背压、客户端取消、出站socket隔离 |
| Runtime缓存绕过与失败不重试 | 12/12，其中新增3项；已包含联合353 |
| API构建 | 最终通过（新增3项与agent:false后） |

联合计数包含上述专项，不得将其相加为新增场景数。中间开发构建曾因bypassCache局部变量尚未声明失败，已修正，以下最终构建才作为验收。

## 与合同矩阵对照

| 矩阵 | 本包证据与剩余 |
| --- | --- |
| H01/H02/H03/H06/H08 | 真实消费者与旧托管名剥离、Connection提名、业务allowlist、None、重复单值、入站CL+TE/重复CL原生400零命中、上游歧义固定502；完整值/限额组合另有纯函数测试 |
| H04/H05 | 继承/替换/坏候选保旧来自02A；本批回归确认生产激活仍拒绝，未证明持久路由已接入新执行器 |
| H07 | 显式当前/历史名输入与旧名剥离受测；持久迁移历史清单及重启保留属02D |
| H09/H10 | peer-only、实际HTTP proto、压缩原字节、HEAD/204/304、截断/提前响应/103竞态与trailer；Expect由独立真实TCP入口验证，生产bootstrap仍属02D |
| H11 | 原始cache veto信号已提供，但Runtime禁用全部v1缓存；策略identity/vary及真实miss/hit属02C |
| H12 | Resolver失败固定503零上游命中、None无注入，legacy/env已有专项回归；生产Resolver到compiled policy的接线仍属02D |

## 兼容决定与限制

v1在请求正文完整发送前收到最终上游响应，保守返回502并中止，避免上游提前成功掩盖未完成的正文长度验证；大上传提前返回业务错误的兼容性须列入02D迁移报告。非最终1xx/升级不作普通成功响应转出。

计数器检查Node交付的实体流。原生parser可能隐藏Content-Length之后延迟到达的额外字节，应用无法声称检测全部超长后缀。同包畸形数据可触发HPE_*，固定映射安全502；v1不复用出站连接，避免尾部污染后续请求。这不等于完整请求走私或F3网络防护验收。

02C后仍须02D接入真实Registry/路由元数据、实际应用入口安装、默认迁移/限期legacy例外、防降级及联合H01–H12验证。F3 DNS/SSRF与双平台证据保持独立，不能从本机HTTP推导TLS或Linux验收。
