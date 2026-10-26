---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 可观测性、投递与留存运维

当前实现包含调用事实、正文、统计、事件历史、Socket.IO事件/状态订阅、Outbox/Webhook、配额和有界清理。生产启用仍需目标配置与验收；不按旧专题阶段计数重开工程。数据约束见[合同](../reference/observability-contract.md)，接口字段和接收协议见[API](../api/observability.md)。

## 查询与排障顺序

1. 先区分API进程健康、MCP监听健康和真实上游业务可调用；管理心跳不能替代业务存活。
2. 确认调用属于external/test/probe/internal的哪一类，并选择正确的时间窗、运行资产和权限范围。
3. 按requestId/trace/invocation查询调用及物理attempt，核对是否已采集、投影和形成终态。
4. 需要推送时分别检查事件、Outbox物化、delivery状态、attempt和接收端证据；accepted/pending不等于已送达。
5. 检查水位、lag、historyCompleteSince、isPartial、scanCoverage；没有证据的指标保持unknown/null。

进程日志、UI运行事件日志、资产访问日志和统一调用事实不是同一日志库。UI日志页当前页搜索/来源筛选不承诺全量检索。

## 关键开关和秘密

| 配置 | 默认/用途 |
| --- | --- |
| API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED | 默认false；采集源事实 |
| API_NOVA_OBSERVABILITY_OUTBOX_ENABLED | 默认false；已提交事件物化投递job |
| API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED | 默认false；租约领取和网络投递 |
| API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS | 订阅准入允许的目标主机 |
| API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS | 准入允许的签名密钥引用 |
| API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS | 部署本地引用→秘密字符串映射；不传入普通API正文 |

GC/生命周期清理、正文配额和各状态报告按当前配置schema中的独立项装配；不能用一个开关推定其余能力已启用。全部可配置字段以[API配置schema源码](../../packages/api-nova-api/src/config/validation.schema.ts)及`.env.example`为准，避免照搬历史脚本中的旧AGGREGATION/DISPATCH消费者开关。

管理JWT、游标、来源标识、幂等HMAC和Webhook签名秘密各按实际合同提供；不以默认秘密或业务API Key代替。目标账户需具备明确数据库/目录ACL，日志和脱敏证据不能包含秘密。

## 订阅和接收端

创建订阅时确定资产/事件范围、目标允许名单、签名引用和当前权限。订阅测试先创建事件及pending job，不同步证明网络成功；自动普通事件还需Outbox。暂停订阅、worker关闭、密钥缺失或目标校验失败应保留可解释状态。

接收端对原始UTF-8字节验签：HMAC-SHA256(secret, timestamp + "." + body)，头为X-ApiNova-Signature、X-ApiNova-Timestamp、X-ApiNova-Event-Id、X-ApiNova-Delivery-Id。没有自动发送key-ID头，密钥选择和轮换需双方协同。

2xx含202只表示本次接收成功；业务处理另行确认。重试/死信/人工重投按既有attempt和replayGeneration执行，不清空历史；接收端按eventId/deliveryId幂等。真实外部SMTP/Webhook、TLS/代理、DNS/私网出站和生产身份未由本机回环结果覆盖。

## 留存、容量与恢复

先核对当前有效策略及历史对象的expiresAt，再检查GC租约、引用、墓碑、容量覆盖和失败报告。到期拒读、物理删除、配额结算和状态展示分开；未知文件不按年龄盲删。数据/正文目录备份和数据库一致性需一起验证，不能只备份SQL而丢失仍被引用的对象。

使用已有SQLite/PG备份恢复、TLS及外部验证用例准备目标签收，不为文档收口新建压力矩阵。2026-10-26本机健康、浏览器和MCP结果为[限定历史证据](../archive/audits/2026-10-26-existing-scope-closure.md)，不代替SEC/OBS/OPS生产签收。

## 目标环境签收清单

- 同一候选的OS/CPU/DB、运行账户、目录/数据库ACL及有效开关明确。
- 采集终态、数据/投递完整性和授权实际通过；保留、恢复、回退有目标证据。
- 实际收件端验签/幂等与可控故障恢复有记录；仅使用获准接收端。
- 尚未证明的容量、全局状态、长时/多进程组合如实保留，不把局部成功外推。

完整原检查项见[外部验证交接（历史合同）](../archive/plans/2026-10-26/runtime-observability-external-validation-handoff.md)；它的旧AC状态以[当前open-items](../reference/open-items.md)为准。
