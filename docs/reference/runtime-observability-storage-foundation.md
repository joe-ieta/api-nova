---
doc-version: 2.1.0
doc-status: active
doc-updated: 2026-09-14
implementation-status: in-progress
---
# 可观测性存储基础与当前持久链路

> 当前实现基线：950e150。本文描述当前结构、事务边界及活动实现，不再保留逐批开发流水。
> 当前任务结论以[完成情况复核](../guides/runtime-observability-completion-review.md)为准；验证证据见[执行台账](../guides/runtime-observability-development-execution-status.md)。
> 重整前全文已保存在[历史归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-storage-foundation.md)。历史的未实现、未启用与失败记录不覆盖当前结论。

## 1. 当前入口与唯一写入链路

`AppModule` 已导入 `CallObservabilityModule`。模块注册查询、事件、订阅、投递、总览、依赖、服务器状态和管线接口，以及存储、采集、Outbox 和 Delivery 服务。模块接入不等于所有后台任务自动开启，也不等于目标环境已部署验收。

下表路径相对于 `packages/api-nova-api/src/`。

| 当前源码 | 职责与边界 |
| --- | --- |
| `modules/call-observability/call-observability.store.ts` | receipt、当前调用、修订历史、检查点、贡献引用、桶失效及持久事件的事务入口；唯一持久桶重算实现 |
| `modules/call-observability/call-observability.collector.ts` | 读取当前 calls-v2 JSONL、处理文件边界与重放，经 Store 摄取或隔离 |
| `modules/call-observability/call-observability.worker.ts` | 目录采集、恢复及符合条件的扫描完成后调用 Store 重算；持久化管线状态 |
| `modules/call-observability/call-observability-callers.projector.ts` | 在摄取事务内维护可信调用者、凭证、来源与观察关联 |
| `modules/call-observability/call-observability-source-lifecycle.service.ts` | 源退出与封存证据，支持关闭源残片和失联恢复 |
| `modules/call-observability/call-observability-outbox.service.ts` | 唯一已提交事件到持久投递任务的消费者；不执行网络请求 |
| `modules/call-observability/call-observability-delivery.worker.ts` | 唯一 Webhook 投递任务消费者；授权复核、出站发送、尝试结果、重试及终止状态 |
| `modules/call-observability/call-observability-statistics.service.ts` | 保留明细汇总、分组，以及满足兼容条件的持久桶时间序列读取 |
| `modules/call-observability/call-observability.module.ts` | 上述活动服务及控制器的注册与导出 |

采集、Outbox、Webhook 后台入口分别要求 `API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED`、`API_NOVA_OBSERVABILITY_OUTBOX_ENABLED`、`API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED` 严格等于字符串 `true`。Outbox/Delivery 提供显式 `runOnce`；生命周期退出停止后续调度并等待活动工作结束。

不另列本地旧 bucket projector、recompute queue/service/worker 为活动实现，不注册第二套桶重算或事件/投递消费者。当前桶协议是 Store 的 `metrics.recompute`，不是已删除本地实现的独立租约列协议。

## 2. 持久结构

| 用途 | 当前表 |
| --- | --- |
| 调用当前态与修订可见区间 | `runtime_invocations`、`runtime_invocation_revisions` |
| 私有正文对象元数据 | `runtime_payload_objects` |
| 主体、凭证、来源与观察 | `runtime_callers`、`runtime_caller_credentials`、`runtime_access_sources`、`runtime_caller_observations` |
| 摄取断点、幂等回执与隔离 | `runtime_ingest_checkpoints`、`runtime_ingest_receipts`、`runtime_ingest_quarantine` |
| 可更正聚合 | `runtime_metric_buckets`、`runtime_caller_buckets`、`runtime_metric_contributions` |
| 订阅及生效版本 | `runtime_event_subscriptions`、`runtime_subscription_revisions` |
| 投递任务及逐次尝试 | `runtime_event_deliveries`、`runtime_event_delivery_attempts` |
| 管线状态、策略结构与命令幂等 | `runtime_pipeline_state`、`runtime_observability_policies`、`runtime_observability_idempotency` |
| 统一持久事件 | 复用 `runtime_observability_events` |

实体由 `database/entities/runtime-call-observability.entity.ts`、`database/entities/runtime-observability-event.entity.ts` 定义并通过数据库实体注册表接入。聚合、事件、订阅及投递已有运行路径，不能再以“只有实体”概括；策略实体存在仍不表示策略 API 已交付。

## 3. 事务、序号与恢复

源端 `sourceSequence` 与管理数据库提交 `sequence` 分离。内部提交序号使用 20 位补零十进制字符串，对外为不补零的十进制字符串；计数器随业务事务提交或回滚，不能将预分配序号视为已提交事件。

一次摄取在同一事务中处理回执、调用投影、修订历史、投影 hook、检查点及相关事件。网络投递不在摄取事务中执行。PostgreSQL 通过计数器行锁协调提交分配；SQLite/SQL.js 通过 DataSource 共享串行通道协调此存储路径，仍要求单管理写实例，不能外推为所有模块的任意多写实例支持。

- 回执以源实例和事件身份去重；相同身份不同内容进入冲突隔离，不覆盖既有证据。
- 源版本与数据库投影版本分离；开始、进度、完成更新同一调用，迟到真实终态可纠正恢复生成的 unknown。
- 身份冲突及已观察终态的不可变约束仍由 Store 执行，桶规划不得绕过这些约束。
- 推断终态不虚构 `completedAt` 或 `durationMs`；恢复需期望版本和失联/源退出证据。
- 断点、文件身份及边界指纹随成功事务推进；源封存和隔离支持关闭源残片的可重试处理。
- `readSnapshot` 提供一致读取视图，不分配事件序号；修订查询遵循 `validFromSequence <= snapshotSeq < validUntilSequence`、资产授权及保留期。

## 4. 持久桶与统计读取

`call-observability-bucket-plan.ts` 提供按数据库修订比较和 UTC 桶键规划；资产、origin、scope、timeBasis 和 interval 是隔离维度。规划本身不代表提交或完成计算。

Store 在持久桶的 `metrics.recompute` 中保存待重算标记，`recomputePendingBuckets` 读取符合修订可见性、窗口与保留条件的调用，复用 `calculateObservabilityMetrics` 重建指标。成功后保存 `{ metrics, coverage }`、推进桶版本，并写入 `metrics.bucket_updated`。metric 桶和 caller 桶均可生成该事件；失败保留待处理状态并记录诊断。采集 Worker 仅在符合恢复/重算条件的扫描完成后调用此入口。

时间序列只有在查询过滤、单资产授权、完整对齐窗口及桶维度匹配，所需桶齐全、版本有效、未过期且没有 `metrics.recompute` 待处理标记时读取持久结果。缺桶不是零流量证据；不兼容时沿用保留明细计算并返回 `not_persisted`，不能把回退结果标成完整持久历史。现有明细查询预算和桶数量退出条件仍适用。

新桶由当前内核直接生成缓存七字段。旧桶缺少或含不合法缓存字段时整条持久时间序列路径降级到保留明细，不补成零、不拼接不同样本集的指标。缓存命中、未命中和未知分别计数，命中率只使用已观测样本作为分母。

覆盖仍须保守表达：已提交桶和完成重算不证明连续历史采集完整，重算/恢复也不能恢复已经删除的证据。长期覆盖、缺口、清理协调和容量验收的剩余状态由当前复核维护；不沿用已删除本地 coverage 服务的字段作为现行契约。

## 5. 统一事件、Outbox 与投递

当前事件表包含调用完成/恢复、桶更新及管线状态事件。调用事件计数必须按事件名和主体过滤，不能把事件表总数当作调用次数。

事件历史接口已提供授权过滤、持久顺序及游标读取。Outbox 消费未过期的已提交 `pending` 事件或租约已到期事件，匹配事件序号处生效的订阅修订，以订阅和事件身份形成幂等投递任务。事件状态、水位与投递生成在事务边界内推进；`suppressed` 历史事件不冒充实时待投递事件。

Delivery Worker 消费到期可尝试任务，使用持久租约、当前授权复核、签名与出站约束执行网络投递，再持久化每次尝试和最终状态。订阅管理、测试投递、投递查询及人工重试已有服务和 API，TP11/TP12 按当前限定范围 DONE。任务创建不等于发送成功，发送成功也不证明接收端业务只处理一次；恢复语义仍需接收端去重。

Outbox/Delivery 的实现和开关接入不等于目标环境密钥、网络、授权、保留策略及监控均已部署验收。旧 Socket.IO 通道亦不能替代新的持久事件授权订阅与补拉契约。

## 6. 正文与保留边界

正文由 `call-observability-payload.store.ts` 私有存储，调用、事件和投递元数据不嵌入原始正文。对象使用数据库归属、generation、调用及侧别绑定；路径和完整性校验不允许任意文件读取或公开静态目录。正文读取另有授权及管理审计，不因调用快照延长正文 TTL。

`call-observability-payload.coordinator.ts` 提供写入/GC 协调，`call-observability-garbage.service.ts` 提供有界正文回收与引用保护。数据库事务失败可能遗留孤立文件，由协调后的回收处理；正文 GC 不等于全部观测对象的自动治理。

存储基础既有默认保留值包括调用/修订 30 天、正文 7 天、事件 14 天、回执 32 天、隔离记录 30 天。Outbox 新建投递的过期时间不超过事件有效期及其投递保留窗口。过期字段与读取过滤不能视为物理清理已经执行；策略 API 27/28 仍 PLANNED，整体容量、清理和保留协调不能由单个对象的 TTL 推断完成。

## 7. 初始化与证据边界

当前开发基线维护 `database/migrations/*-InitialSqliteSchema.ts`、`*-InitialPostgresSchema.ts` 及包目录 `database/sqlite-schema.sql`、`postgres-schema.sql`。只支持当前源格式，不导入旧日志。已执行过旧 InitialSchema 的数据库不会因源文件变化自动升级；不能对业务库直接重放空库初始化或自行清空。

历史 TP02 已有 SQLite/PostgreSQL 初始化烟测、存储专项，以及 PostgreSQL 四进程调用仓储验证记录；不能表述为 PostgreSQL 从未验证。这些历史专项及其警告、容量和平台范围见[执行台账](../guides/runtime-observability-development-execution-status.md)与[归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-storage-foundation.md)。

950e150 上轮证据为 API 548/548、Parser 103/103、MCP 53/53 及三个包 build PASS。本轮只整理文档和定向读取源码，没有新运行构建、测试、迁移或部署；上述结果不是本轮新验证。950e150 全链 PostgreSQL/Linux 部署矩阵、代表性负载与容量目标尚未验证。

API01-26 为限定契约 VERIFIED，API27/28 为 PLANNED；VERIFIED 不等于生产 AVAILABLE。任务包、接口及剩余差异统一链接[当前复核](../guides/runtime-observability-completion-review.md)，避免在结构文档中继续追加历史状态流水。
