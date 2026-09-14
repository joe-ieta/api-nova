---
doc-version: 2.1.0
doc-status: active
doc-updated: 2026-09-14
---
# 可观测性共享契约与当前源码映射

> 当前实现基线：950e150。本文维护当前契约和活动源码映射，不作为逐批测试流水。
> 当前状态以[完成情况复核](../guides/runtime-observability-completion-review.md)为准，证据见[执行台账](../guides/runtime-observability-development-execution-status.md)。
> 重整前全文见[历史归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-contract-mapping.md)。历史初轮失败、后续修复及当时未启用状态不再重复为当前结论。

## 1. 共享契约

- 当前源记录 `schemaVersion=2`；对外 API/统一事件使用各自定义的 `schemaVersion=1.0`。只消费当前源格式，不导入旧格式。
- `gateway_request`、`mcp_protocol`、`mcp_tool`、`upstream_api` 分层计数。缓存命中不能虚构物理上游请求。
- `started/progress/finished` 共用调用身份，源事件、源内顺序与管理数据库修订分离。数据库提交序号才是持久事件读取依据。
- 已知主体来自认证证据，来源 IP 不等于调用者身份；权限按基础读取与附加权限求交并限制资产范围。
- 字节指标按 `byteMeasurement/measurementStage` 分组，不混加不同边界；未观测正文、字节和时间不能冒充空值或零。
- 恢复生成的 unknown 不伪造完成时间；迟到真实终态在同一调用上提升修订。桶规划不解除 Store 的身份冲突和终态约束。
- 缓存字段保持命中、未命中、未知三态；缺失标记不得因规范化的布尔默认值变成未命中。
- 统计完成、桶版本、事件序号和投递成功均不等于历史连续覆盖、运行健康或生产可用性。

## 2. 当前采集与持久处理映射

下表源码路径相对于 `packages/`。

| 契约职责 | 当前源码 | 可靠边界 |
| --- | --- | --- |
| 源规范化及 scope | `api-nova-parser/src/audit/runtime-observability-contract.ts` | v2 校验、身份/缓存未知证据及分层调用语义 |
| 阶段采集与受限正文 | `api-nova-parser/src/audit/runtime-call-audit.ts` | 同一调用的生命周期记录、正文预算与脱敏 |
| 物理上游请求 | `api-nova-parser/src/audit/runtime-upstream-attempt.ts`、`runtime-http-agent.ts` | 单次请求、重试/跳转及实际结束观察；不替代全部故障矩阵验收 |
| Gateway 入口及转发 | `api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts`、`gateway-proxy-engine.service.ts` | 入口、缓存/拒绝与上游分层；不重复补写同一调用 |
| MCP 协议及工具 | `api-nova-server/src/transportUtils/audit.ts`、`api-nova-server/src/tools/mcp-http-audit.ts`、`runtime-security.ts` | 协议/Tool/上游关联、传输与认证边界；不能将历史首轮 STDIO 失败继续标作当前验收结论 |
| 摄取、恢复与源生命周期 | `api-nova-api/src/modules/call-observability/call-observability.collector.ts`、`call-observability.worker.ts`、`call-observability-source-lifecycle.service.ts` | JSONL 断点、残片、退出证据及 unknown 恢复 |
| 唯一持久事务及桶重算 | `api-nova-api/src/modules/call-observability/call-observability.store.ts` | 回执/调用/贡献/事件事务，`metrics.recompute` 标记及 `recomputePendingBuckets` |
| 桶键规划 | `api-nova-api/src/modules/call-observability/call-observability-bucket-plan.ts` | 数据库修订比较、UTC 桶及维度隔离；纯规划不代表提交 |
| 调用者和来源归并 | `api-nova-api/src/modules/call-observability/call-observability-callers.projector.ts` | 可信主体、HMAC 来源、溢出降级及调用事务内关联 |
| 正文、协调及 GC | `api-nova-api/src/modules/call-observability/call-observability-payload.store.ts`、`call-observability-payload.coordinator.ts`、`call-observability-garbage.service.ts` | 私有文件、归属/租约、引用保护；不是全部对象治理 |

`api-nova-api/src/app.module.ts` 已导入 `CallObservabilityModule`。不得保留“根模块未接入”或“公开接口尚未注册”的旧判断。已删除的本地独立 bucket projector/recompute queue/service/worker 不属于活动源码，不应恢复为第二条持久链路。

## 3. HTTP 契约映射

接口共同前缀为 `/api/v1/monitoring/observability`。以下控制器、服务和 DTO 位于 `packages/api-nova-api/src/modules/call-observability/`；完整参数与返回契约见[Endpoint 参考](./runtime-observability-api-endpoints.md)。VERIFIED 仅限已验收契约，不等于所有平台、性能指标或部署完成。

| Endpoint | 当前 controller/service 文件族 | 状态与限定 |
| --- | --- | --- |
| API01 能力 | `call-observability-capabilities.*` | VERIFIED；能力及权限范围说明不推断实际运行健康 |
| API02 总览 | `call-observability-overview.*`、`call-observability-overview-snapshot-authorizer.service.ts` | VERIFIED；总览快照与授权边界 |
| API03/04/06 调用列表、明细、trace | `call-observability-invocations.*` | VERIFIED；修订可见性、授权、保留期及有界 trace |
| API05 正文 | `call-observability-payloads.*` | VERIFIED；独立授权、私有正文读取及管理审计 |
| API07/08/10 调用者与来源 | `call-observability-visitors.*` | VERIFIED；资产/窗口过滤、主体与来源区分 |
| API09 调用者标签 | `call-observability-caller-labels.*`、`call-observability-caller-profile.ts` | VERIFIED；档案版本、If-Match 与审计；档案令牌不冒充完整 HTTP 响应 ETag |
| API11/12/13 汇总、时间序列、分组 | `call-observability-statistics.*`、`call-observability-metrics.ts` | VERIFIED；持久桶兼容读取或明细降级，保持预算、覆盖及缓存三态 |
| API14 依赖 | `call-observability-dependencies.*` | VERIFIED；限定观测关系，不推断未观测依赖 |
| API15 服务器状态 | `call-observability-server-status.*` | VERIFIED；状态按实际证据表达，未知不冒充健康 |
| API16 事件历史 | `call-observability-events.controller.ts`、`call-observability-events.service.ts` | VERIFIED；持久顺序、授权、签名游标及过期边界 |
| API17-22 订阅管理及测试 | `call-observability-subscriptions.*`，测试投递衔接 `call-observability-deliveries.service.ts` | VERIFIED；订阅生效修订、管理授权、审计及受控测试投递 |
| API23-25 投递列表、详情、重试 | `call-observability-deliveries.*` | VERIFIED；任务/尝试记录、幂等人工重试和有效期约束 |
| API26 管线状态 | `call-observability-pipeline.*` | VERIFIED；已知采集/投递证据与未知边界，不替代全部策略治理 |
| API27/28 策略读取、修改 | 尚无已验收公开实现 | PLANNED；策略实体不能替代 API 交付 |

API01-26 合计 26 个限定契约 VERIFIED，API27/28 两个 PLANNED；TP11/TP12 按当前任务范围 DONE。其他任务包状态不在本表推算，统一参见[当前复核](../guides/runtime-observability-completion-review.md)。

## 4. 统计与缓存的持久化兼容

`calculateObservabilityMetrics` 是明细计算和 Store 重算共用的内核。缓存七字段为 `cacheEligibleRecords`、`cacheObservedRecords`、`cacheUnknownRecords`、`cacheHits`、`cacheMisses`、`cacheHitRate`、`cacheCoveragePartial`；命中率分母仅包含已观测命中/未命中样本，无已观测样本时返回 null。

Store 将重算结果存为 `{ metrics, coverage }`，更新桶版本及水位，并生成桶修订事件。统计服务保留远端完整持久读取条件：单资产授权、支持的过滤、对齐窗口、维度匹配、桶齐全、有效版本/保留期以及没有待重算标记。满足条件才返回 `bucketVersionSemantics='persisted'`，否则按现有明细路径返回 `not_persisted`。

旧持久桶缺缓存字段或字段不合法时，不以零补齐，也不从当前明细拼入缓存值而保留旧桶其他指标；整体降级到保留明细。新桶通过当前内核直接包含缓存字段。明细降级只代表仍可读取的样本，不能恢复过期历史。

`coverage`、`livenessEvaluated`、合成桶和零计数保持原有保守边界。当前没有证据可从桶起止时间、重算成功或默认保留值推导连续历史覆盖。不得把已删除本地 coverage 增量的字段列为当前接口。

## 5. 事件及主动投递映射

| 契约职责 | 唯一活动实现 | 当前边界 |
| --- | --- | --- |
| 调用/桶/管线持久事件 | Store 的调用事件与 `projectionEvent`，采集 Worker 状态写入 | 事件表有多类合法事件，调用数必须按事件类型和主体筛选 |
| 历史与游标 | `call-observability-events.service.ts` | 授权、固定读取边界、持久顺序及过期恢复；不是“仅有表结构” |
| Outbox 生成任务 | `call-observability-outbox.service.ts` | 已提交事件租约、按事件序号生效的订阅修订、幂等投递任务及水位 |
| Webhook 网络消费者 | `call-observability-delivery.worker.ts` | 当前授权复核、签名/出站约束、尝试落库、租约恢复、退避、失败终止 |
| 订阅与人工重试 | `call-observability-subscriptions.service.ts`、`call-observability-deliveries.service.ts` | 版本/幂等与管理审计，不能把“已入队”写成“已送达” |

Outbox 与 Webhook 的后台开关分别是 `API_NOVA_OBSERVABILITY_OUTBOX_ENABLED`、`API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED`，仅字符串 `true` 开启。二者各有显式 `runOnce` 和停止等待，不引入本地第二套 dispatcher 或投递 Worker。

Webhook 可靠性不是端到端恰好一次，接收端仍需按事件/投递身份去重。初始历史抑制状态、订阅撤销、事件过期及人工重试各有不同语义，不能合并为无条件重放。

旧 Monitoring/WebSocket 能力不能替代统一事件源上的授权订阅、快照衔接与补拉验收；也不能将 Webhook DONE 外推为新实时通道全部完成。

## 6. 验证口径与尚未完成项

950e150 上轮验证记录为 API 548/548、Parser 103/103、MCP 53/53，API/Parser/Server 三个包 build PASS。重启专项已按合法调用、桶和管线事件分类断言，不能把旧的全事件总数失败当作重复摄取缺陷。本轮没有运行新测试、构建或部署。

历史 TP02 已完成过 SQLite/PostgreSQL 初始化、存储专项和 PostgreSQL 多进程仓储验证；不得声称 PostgreSQL 从未验证。但这些证据不覆盖 950e150 的全链 PostgreSQL/Linux 部署矩阵，该矩阵仍未验证。历史详细数字、失败修复及环境边界留在[执行台账](../guides/runtime-observability-development-execution-status.md)和[归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-contract-mapping.md)。

仍需按当前复核推进策略 API27/28、跨对象保留与容量治理、长期历史覆盖/缺口及过期证据边界、统一实时通道剩余验收、真实平台/负载矩阵和目标环境部署。源码接入、限定契约 VERIFIED 与任务包 DONE 都不能替代生产 AVAILABLE。
