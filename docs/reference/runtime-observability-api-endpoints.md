---
doc-version: 2.1.0
doc-status: active
doc-updated: 2026-09-14
approval-status: approved
implementation-status: in-progress
---
# 可观测性对外 API Endpoint 文档

> 当前消费者契约，版本 **2.1.0**，更新于 **2026-09-14**。以远端优先整合基线 950e150 及其后保留的查询/cache/origin/MCP 实现为准。
> **OBS-API-01~26：限定契约 VERIFIED；OBS-API-27/28：PLANNED；Socket.IO 新协议未实现；Webhook 闭环保留但默认关闭；AVAILABLE=0。**
> 本次是静态文档核对，不是新一轮测试、部署或发布验收。VERIFIED 依据既有执行证据，不扩大为完整需求、平台矩阵或真实存活验证。
> 当前汇总：[完成情况复核](../guides/runtime-observability-completion-review.md)、[执行状态](../guides/runtime-observability-development-execution-status.md)、[任务计划](../guides/runtime-observability-development-task-plan.md)。
> 旧版正文及逐次追加记录已原样归档：[2026-09-14 历史版本](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)。历史进度不覆盖本文当前契约。

## 1. 文档维护与版本演进

Endpoint 编号和 operationId 不因重构改变。新增或修改接口应同步控制器、DTO/Swagger、权限、契约测试和执行台账；程序生成的 OpenAPI 是字段对照依据，本文解释其范围与限制。

状态规则：PLANNED 为规划；IMPLEMENTED 为代码存在；VERIFIED 为所列限定契约已有验证证据；AVAILABLE 必须另有发布版本、部署范围及部署验证；DEPRECATED 表示弃用。模块已接入不等于已部署，默认关闭不等于未实现。不得将旧记录中的 12/28、未接入根模块或 Webhook 未实现当作当前状态。

本文版本 2.1.0 与 HTTP/event 的 schemaVersion=1.0 是不同版本。需求和完整设计见[需求](../guides/runtime-observability-requirements.md)、[设计](./runtime-observability-design.md)；设计中尚未落地的字段不是消费者可依赖的承诺。

## 2. 基础约定

| 项目 | 当前契约 |
| --- | --- |
| Base URL | `https://{deployment-host}/api/v1/monitoring/observability` |
| 认证 | `Authorization: Bearer <management-access-token>`；既有管理登录/刷新流程签发 |
| 权限 | `monitoring:read` AND 各接口额外权限；对应资产范围也取交集 |
| 凭证边界 | 业务 API Key、业务 JWT、刷新 Token 不自动具备管理 API 权限；无新增 Token 签发 Endpoint |
| 编码 | JSON；正文接口在 JSON 中表达 json/text/base64/multipart 内容 |
| 时间 | UTC ISO 8601；接受时间窗的接口使用 `[from,to)` |
| ID/序号 | ID 不透明；sequence、snapshotSeq、dataWatermark 为十进制字符串，不使用 JS Number 存储 |
| 大数 | 部分计数/累计字节超出安全整数时返回十进制字符串 |
| 未知值 | null、unknown、isPartial 必须按字段解释，不能自动转换为零或健康 |
| 缓存与错误 | 可观测性路由使用 `Cache-Control: no-store`；安全错误不回显驱动异常、秘密或隐藏资源 |

路径已含 `/api/v1`，不可重复拼接。Socket.IO 的 `/monitoring` 是既有 namespace，不代表本文新推送协议已实现。

### 2.1 公共响应

通常返回 `{ "status": "success", "data": ..., "meta": { "schemaVersion": "1.0", ... } }`。meta 的水位、lagMs、historyCompleteSince、isPartial 等仅按接口实际返回，不承诺每个接口都有实时覆盖证据。列表常用 items/nextCursor/hasMore；统计、服务器列表和依赖列表不因此自动支持 cursor。成功 DELETE 为 **204、无响应体**。

错误信封为 `{ "status": "error", "error": { "code": "INVALID_QUERY", "message": "Invalid query or request header", "requestId": "...", "details": { "field": "..." } } }`；details 可省略。客户端按 code 和受控字段处理，不依赖任意自由文本错误消息。

### 2.2 公共过滤与分页

只有对应接口白名单中的参数可用。未知、重复数组、嵌套 query、无效枚举/排序通常返回 400 INVALID_QUERY；超出查询规模返回 413 QUERY_TOO_LARGE，不截断后假称完整。

| 参数 | 适用接口的规则 |
| --- | --- |
| from/to | 调用/访客/统计/overview 类默认最近 1 小时，成对提供；通用最大跨度 30 天。deliveries 列表的 from/to 是其独立创建时间过滤，不套用最近一小时默认 |
| origin | 调用/访客/统计/overview/dependencies/servers 默认 external，允许 external/test/probe/internal；**events 省略 origin 时不限制来源** |
| timeBasis | 接受该字段时默认 startedAt，另可 completedAt；overview/dependencies/servers 固定 startedAt，不接受 timeBasis 参数 |
| cursor | 端点专用签名游标，绑定主体/权限/过滤/快照/排序；events 使用 after/until，不混用 |
| limit/includeTotal | 支持 limit 的列表默认 50、最大 200；includeTotal 仅调用/访客列表支持，不是全局参数 |
| scope | statistics 三接口必填：business/http_ingress/tool/protocol/upstream |
| interval/fill | time-series 必填 interval=1m/5m/1h/1d；fill=none 默认或 zero；最多 1440 个触达桶 |
| groupBy/orderBy/top | groups 专用；1~2 维，top 默认 20、最大 100；排序枚举见 4.5 |

游标只签名、不加密，不是授权凭据。过期需重新建立查询；游标不会延长事件、正文或调用明细保留期。数据快照与当前权限同时生效，续页不得恢复已撤销权限。

## 3. Endpoint 注册表

“基础”表示除 monitoring:read 与资源范围外没有额外权限。此表为当前状态唯一入口；API01~26 的 VERIFIED 仅限本文描述的行为，全部 AVAILABLE=0。

| 编号 | 方法与相对路径 | operationId | 额外权限 | 任务包 | 状态 |
| --- | --- | --- | --- | --- | --- |
| OBS-API-01 | GET /capabilities | obsGetCapabilities | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-02 | GET /overview | obsGetOverview | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-03 | GET /invocations | obsListInvocations | 基础 | OBS-TP-09 | VERIFIED |
| OBS-API-04 | GET /invocations/:id | obsGetInvocation | 基础 | OBS-TP-09 | VERIFIED |
| OBS-API-05 | GET /invocations/:id/payloads/:side | obsGetInvocationPayload | monitoring:payload:read | OBS-TP-09 | VERIFIED |
| OBS-API-06 | GET /traces/:traceId | obsGetTrace | 基础 | OBS-TP-09 | VERIFIED |
| OBS-API-07 | GET /callers | obsListCallers | 基础 | OBS-TP-09 | VERIFIED |
| OBS-API-08 | GET /callers/:id | obsGetCaller | 基础 | OBS-TP-09 | VERIFIED |
| OBS-API-09 | PATCH /callers/:id | obsUpdateCallerLabels | monitoring:manage | OBS-TP-09 | VERIFIED |
| OBS-API-10 | GET /sources | obsListSources | 基础；IP 另需 monitoring:source:read | OBS-TP-09 | VERIFIED |
| OBS-API-11 | GET /statistics/summary | obsGetStatisticsSummary | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-12 | GET /statistics/time-series | obsGetStatisticsTimeSeries | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-13 | GET /statistics/groups | obsGetStatisticsGroups | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-14 | GET /dependencies | obsGetDependencies | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-15 | GET /servers/status | obsGetServerStatuses | 基础 | OBS-TP-10 | VERIFIED |
| OBS-API-16 | GET /events | obsListEvents | 基础 | OBS-TP-11 | VERIFIED |
| OBS-API-17 | POST /subscriptions | obsCreateSubscription | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-18 | GET /subscriptions | obsListSubscriptions | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-19 | GET /subscriptions/:id | obsGetSubscription | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-20 | PATCH /subscriptions/:id | obsUpdateSubscription | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-21 | DELETE /subscriptions/:id | obsDeleteSubscription | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-22 | POST /subscriptions/:id/test | obsTestSubscription | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-23 | GET /deliveries | obsListDeliveries | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-24 | GET /deliveries/:id | obsGetDelivery | monitoring:subscription:manage | OBS-TP-12 | VERIFIED |
| OBS-API-25 | POST /deliveries/:id/retry | obsRetryDelivery | monitoring:subscription:manage AND monitoring:delivery:retry | OBS-TP-12 | VERIFIED |
| OBS-API-26 | GET /pipeline/status | obsGetPipelineStatus | 基础 AND 显式全局资源范围 | OBS-TP-14 | VERIFIED |
| OBS-API-27 | GET /policies | obsGetPolicies | 规划：基础 | OBS-TP-14 | PLANNED |
| OBS-API-28 | PATCH /policies/:id | obsUpdatePolicy | 规划：monitoring:manage | OBS-TP-14 | PLANNED |

## 4. 查询接口对象与行为

### 4.1 OBS-API-01/02：能力与总览

**capabilities** 不接受 query。返回 endpoints（按 endpointId 排序）、features、enabledFeatures、resourceScope、schemaVersions、参数白名单及规模边界。availabilitySemantics=`implementation_and_scope_eligibility_not_runtime_health`，observationHealth=`unknown`。它不是 worker 开关、密钥就绪、实际资源访问或健康证明。

| 范围与权限 | 可发现 Endpoint 数 |
| --- | --- |
| 全局且全部细分权限 | 26 |
| 全局仅 monitoring:read | 15（包含 API26） |
| 非空 scoped、仅 monitoring:read | 14（不含 API26） |
| 空资源范围 | 1（capabilities 自身） |

webhook/subscriptionManagement 已实现，但没有 subscription:manage 的用户看到 restricted；socketPush/policyManagement 为 not_implemented。pipelineStatus 只对全局 read 启用，authorizationRule=`explicit_global_scope`，不另要求 monitoring:manage。

非空 read 范围下 maxBuckets=1440、maxGroupLimit=100、eventRetention=1209600000ms；空范围的 maxBuckets/eventRetention 为 null。maxStatisticsQueryInvocations=5000、traceMaxNodes=200、maxVisitorQueryInvocations=5000；maxQueryCursorLifetimeMs=900000。payloadLimits 仅对正文权限交集有效：readObjectMaxBytes=134217728，仅是单存储对象读取上限；effectiveCaptureBytes=null、capturePolicyState=not_reported_by_producers。aggregateRetentionMs/effectiveHistoryCompleteSince 仍 null。

**overview** 接受 `from,to,origin,serverType,runtimeAssetId`。data 包含 window、snapshotSeq、businessSummary、upstreamSummary、serverStates、unavailableSections、restricted，以及 invocationSnapshotSeq/Scope/Authorized/ExpiresAt。`pipeline` 和 `recentEvents` 仍列为 unavailableSections，不返回伪造区块；pipeline 的独立 API26 不改变这个限制。

invocationSnapshotScope=`invocation_facts_only`。模块中的共享授权器保存进程内快照授权，最长 5 分钟、最多 1000 条，重启或淘汰后须重新 overview。只有 invocationSnapshotAuthorized=true 且未过期、主体/资产权限和 origin/serverType/runtimeAssetId 匹配时，才可用 invocationSnapshotSeq 启动 events 的 afterSequence。该许可不是全局事件快照，也不能初始化旧服务器状态；不可直接用普通 snapshotSeq 冒充签名游标。

### 4.2 OBS-API-03/04/06：调用、详情与链路

invocations 查询白名单：`from,to,timeBasis,origin,serverType,runtimeAssetId,callerId,sourceId,endpointDefinitionId,toolName,sourceServiceInstanceId,spanKind,outcome,traceId,requestId,errorCategory,limit,includeTotal,cursor`。列表按所选时间 DESC、invocationId DESC；详情仅接受 timeBasis。

返回调用元数据及正文状态，不返回正文对象。关键字段包括关联 ID、recordVersion、spanKind/origin、资产和上游标识、可信身份、开始/完成时间、lifecycle/completionSource/outcome、结果及测量质量。publicationSnapshot、未采集来源字段等可能为 null，并由 missingFields/isPartial 表明限制。IP 需独立 source:read；隐藏链路不能通过父/根 ID 或计数泄露。

traces 仅接受 origin（默认 external），返回 nodes、edges、missingParentReferences、structuralIssues、relationshipsComplete、isPartial、maxNodes。最多 200 个保留且可见节点，超限 413；关系仅在同 trace/origin 可见图内成立，不返回隐藏父/根 ID。relationshipsComplete 不等于历史采集完整。

运行中 outcome 可空；unknown 表示没有可靠终态，不能当成功。HTTP 200 且 toolIsError=true 的工具错误仍属于 error。

### 4.3 OBS-API-05：正文读取

side 仅 request/response，无 query。权限为 read AND payload:read，必须在同一资产范围内成立。data 包含 invocationId、recordVersion、side、state、reason、contentType、encoding、observedBytes、capturedBytes、storedBytes、redacted、readRedacted、redactionPolicyVersion、capturedDigest、digestScope、content、expiresAt。

state 为 captured/omitted/incomplete/unavailable；encoding 为 json/text/base64/multipart。未采集、不可用或空正文按状态表达，不伪造内容；已过期返回 410 PAYLOAD_EXPIRED，details 可含 state=expired 和 expiredAt。未知或隐藏调用为 404；无读取权限为 403。读取有安全管理审计，multipart 不提供任意文件下载路径。摘要可能描述观察原文或部分内容，不应直接当作返回脱敏 JSON 的哈希。

### 4.4 OBS-API-07/08/09/10：调用者与来源

共同查询键为 `from,to,timeBasis,origin,serverType,runtimeAssetId,sourceId`。callers 列表另接收 callerId/limit/includeTotal/cursor；caller 详情仅共同键；sources 列表另接收 callerId/limit/includeTotal/cursor/authState。不得根据旧设计添加未经实现的字段或原始 IP 过滤。

列表按 lastSeenAt DESC、callerId/sourceId DESC。最多 5000 条授权、保留且匹配的调用修订作为查询输入，超限 413。firstSeenAt/lastSeenAt、summary 来自固定调用窗口/快照；可编辑档案是当前值，profileSnapshot=current，不是历史档案快照。callers 只归并可信 authenticated 身份；sources 包括 authenticated/anonymous/authentication_failed/unknown。匿名来源不是人数，日级 HMAC 不保证跨日稳定。

sourceRestricted 为 true 时省略 IP 字段；read AND source:read 的资产交集满足才返回 clientIp、peerIp、ipSource、proxyTrusted。caller 详情仅给窗口内观察到的 credentialIds，不给业务 Key、JWT 或秘密。

PATCH callers 仅支持 displayName（≤200 或 null）、note（≤2000 或 null）、labels（≤32 项，每项≤64）；至少一个字段，输入≤16KiB，无 query，未知字段拒绝。未提交字段保持原值，规范化后无变化不推进版本但仍审计。编辑须 read AND manage 覆盖该调用者全部登记关联及保留可信调用，不能以 GET 时间窗缩小权限范围。

使用 data.profileEtag 或 `X-Profile-ETag` 原样提交 If-Match。成功返回 callerId/displayName/note/labels/profileEtag/changed/changedFields/auditId；普通 HTTP ETag 不是编辑令牌。审计与变更原子提交，审计失败回滚。

### 4.5 OBS-API-11/12/13/14：统计与依赖

summary 接受 `from,to,timeBasis,origin,scope,serverType,runtimeAssetId,callerId,sourceId,endpointDefinitionId,toolName,sourceServiceInstanceId,spanKind,outcome,traceId,requestId,errorCategory`，scope 必填，无 limit/cursor/includeTotal。time-series 和 groups 继承这些筛选，再接受各自专用参数。

data 包含 window、metrics、coverage、queryMode、maxQueryInvocations、livenessEvaluated=false。输入上限 5000 在授权、TTL、窗口/scope/过滤之后应用。覆盖通常仍 historyCompleteSince=null、isPartial=true、observationHealth=unknown。未结束观察归 unknownInFlight；inFlight=0 不证明不存在正在执行的请求。

metrics.selectedInvocations 为所选时间基准的调用数；totalStarted 在 completedAt 基准为 null。failures 已含 error/timeout/incomplete，不可再加 timeouts/incomplete。successRate=successes/knownCompleted，errorRate=failures/(successes+failures)，无分母为 null。唯一调用者按整个选定集合去重，不累加桶/分组去重数。

byteGroups 按 spanKind/byteMeasurement/measurementStage 区分；分侧带测量、缺失和部分计数。混合计量口径不声称统一网络总字节。latency 使用 fixed_histogram_upper_bound_v1、approximate=true；溢出区间保留下界而 upperBoundMs/estimateMs=null，不平均已有分位。缓存字段 cacheEligibleRecords/cacheObservedRecords/cacheUnknownRecords/cacheHits/cacheMisses/cacheHitRate/cacheCoveragePartial 区分已观察与未知；缺少 cacheHit 不是 miss，不能因上游请求少就推断命中。

**time-series**：interval 必填，fill 默认 none；按 UTC 对齐，边缘桶也计入 1440 上限。返回 items 的 bucketStart/bucketEnd/effectiveFrom/effectiveTo/bucketVersion/dataWatermark/synthetic/metrics/coverage。兼容且有效的持久桶返回 bucketVersionSemantics=persisted；有 pending 重算、缺桶、筛选不兼容或缺少必要缓存计量时回退按需计算，标记 not_persisted、bucketVersion=null。不得将“总是按需”或“总是持久版本”写成契约。fill=zero 会补桶，但零计数仍不证明观察覆盖或健康。

**groups**：groupBy 必填，允许 runtimeAssetId/serverType/callerId/endpointDefinitionId/toolName/sourceServiceInstanceId/outcome 的单维及两维，共 28 种，接受反向两维顺序。orderBy 为 selectedInvocations（默认）、failures、successes、uniqueCallers、upstreamRequests，降序并以维度元组打破平局。返回 groupBy/orderBy/top/totalGroups/hasMoreGroups/items，项含 rank/dimensionValues/metrics。缺失维度为 null；top 截断不改变整体统计。

**dependencies**：只接收 overview 五个查询键。返回 window、items、dataWatermark、maxQueryInvocations、queryMode、historyCompleteSince、isPartial、restricted、dependencyBasis；项包含 runtimeAssetId/serverType/endpointDefinitionId/sourceServiceInstanceId、upstreamRequests/failures/retryAttempts/unlinkedRetryRecords、affectedBusinessRequests/unlinkedFailureRecords/relationshipsComplete/lastFailureAt。

仅返回已观察上游关联，不枚举配置但未使用的依赖。受影响业务数按失败上游的最近可见外部业务祖先去重，要求同资产、trace 和时间窗证据；同一协议根下不同 MCP Tool 分别计业务调用，不按根 ID 合并成一次。affected 不等于业务最终失败，缺失链路显式标记。

### 4.6 OBS-API-15/26/27/28：状态与策略

**servers/status** 使用 overview 五个查询键，返回有界 items 与 maxServers/maxQueryInvocations/maxStateRows、stateBasis=current_database_snapshot、readAt、invocationDataWatermark、livenessEvaluated=false 等。资产 lifecycleStatus 来自 runtime_assets；reportedState 是持久旧报告，不能解释为最新存活证据。

healthStatus/dependencyHealth/freshnessStatus 当前 unknown；lastHeartbeatAt/processInstanceId/activeInvocations/stateVersion 为 null。unknownInFlight、observedBusinessRequests、lastSuccessAt/lastFailureAt 仅根据选定开始时间窗内调用计算。服务器状态的 dataWatermark=null，因为旧资产/报告更新不推进调用序号；invocationDataWatermark 仅覆盖调用派生统计。

**pipeline/status** 不接收 query，要求显式全局 read；scoped 请求拒绝，不返回部分全局统计。data.resourceScope=global，semantics=persisted_observations_not_live_health。ingest 表达持久扫描报告及 recent/stale/unknown；aggregation 读取 Store 的 metric/caller pending 重算标记；dispatch 读取远端 Outbox 状态及尚未物化的有效事件，并包含 webhook 最近执行报告。

dispatch.dataWatermarkScope=outbox_materialization_not_webhook_acknowledgement；水位不是接收端 ACK。aggregation 待处理计数包含 Store 会选择的持久标记，不是完整长期趋势保证。Webhook 的 workerConfigured、lastAttemptAt、claimed/succeeded/retrying/dead/cancelled 是最近持久报告，不是当前开关或实时健康。diskUsage/effectiveQuota/gapRanges 等未实现计量保持 null。

**policies 两接口未实现**。GET 有效策略、PATCH 保留/配额/脱敏设置、effectiveAt/retentionImpact 均属规划，不提供当前可调用示例。默认存储时长也不是用户可通过 API27/28 修改的能力。

## 5. 事件历史、订阅与投递 Endpoint

### 5.1 OBS-API-16：事件历史与补拉

白名单为 `after,afterSequence,until,origin,eventTypes,severities,spanKinds,outcomes,runtimeAssetId,serverType,callerId,endpointDefinitionId,toolName,limit`。eventTypes/severities/spanKinds/outcomes 接受逗号分隔枚举；serverType/origin 单值。省略 origin 不限制来源；原始 IP、任意 JSON 条件和调用列表 cursor 不接受。

事件类型白名单：invocation.completed、invocation.reconciled、caller.discovered、server.state_changed、server.snapshot、metrics.bucket_updated、pipeline.state_changed。可过滤某类型不等于所有生产者都提供了该类型的完整实时覆盖。

按 sequence ASC 读取 `(after,until]`，after/until 是该端点签名游标。首请求无 after 从保留事件读取，不因较高序号已过期而丢掉较低序号仍存活事件。afterSequence 与 after 互斥；只有 overview 的未过期调用快照授权可启动，须显式匹配 origin 等范围。许可缺失、过滤或权限不符返回 400 CURSOR_SCOPE_MISMATCH。

data 为 items、nextCursor、hasMore、highWatermark、highWatermarkCursor、scannedEvents。最多扫描 1000 个授权范围事件，最多返回 limit 个匹配项；过滤后 items 可空且 nextCursor 仍推进。补拉未完成时固定高水位，完成后可继续追赶新事件。until 可使用服务返回的 highWatermarkCursor，不自行拼接数值。水位表示提交/扫描位置，不是可见事件数量、覆盖完整性或 Webhook 确认。

游标最长 15 分钟且受窗口内最早事件到期和前置游标截止约束。遇到过期缺口返回 410 EVENT_CURSOR_EXPIRED，details 为 `availableFrom: string|null`、`resnapshotRequired: true`。availableFrom 是可用起点的序号提示，**不是签名恢复游标**；当前没有 earliestAvailableCursor/requiresSnapshot 字段。

HTTP items 是安全投影：schemaVersion/eventId/sequence/eventType/occurredAt/recordedAt/severity/server/subject/historical/data/links。不会任意透传 details、correlationId、正文、头或 IP；不承诺 traceId、callerId 等设计字段一定出现在 data。bucket 更新带 refreshRequired=true，应重新查询聚合，不能直接累加消息。historical=true 表示 suppressed 历史证据，不参与普通 Outbox 分发。

### 5.2 OBS-API-17~22：Webhook 订阅

所有接口叠加 subscription:manage。当前远端按完整订阅资产范围判断管理资格，不是仅 owner 可读的已移除本地内核；发送时另检查订阅所有者当前权限。

创建 POST 返回 201，必填 name、destination、secretRef；可选 filter、enabled（默认 true）、reason。请求没有独立 scope/signingKeyId 字段。示例仅展示语法，目的地和 secret 引用仍须通过部署配置允许名单：

```json
{
  "name": "订单监测",
  "destination": { "type": "webhook", "url": "https://monitor.example/events" },
  "secretRef": "webhook-orders-v1",
  "filter": { "runtimeAssetIds": ["runtime-example"], "eventTypes": ["invocation.completed"] },
  "enabled": true
}
```

filter 键为 runtimeAssetIds/serverTypes/eventTypes/severities/spanKinds/outcomes/callerIds/endpointDefinitionIds/toolNames，数组内 OR、字段间 AND；不适用字段不命中。不显式指定 runtimeAssetIds 时由授权范围确定订阅范围，不允许请求扩大范围。

destination 为 `{type,url}`，默认 HTTPS；拒绝 URL userinfo/query/fragment。部署须配置 WEBHOOK_ALLOWED_HOSTS 与 WEBHOOK_SECRET_REFS；HTTP 需显式允许。创建/修改的允许名单通过不等于已连通目的地或已解析秘密。

列表只接收 state=enabled/paused、cursor、limit；按 createdAt DESC、id DESC，签名游标绑定查询和权限/快照，返回 items/nextCursor/hasMore/scannedSubscriptions。详情无 query。返回 id/version/state/name/destination/filter/effectiveFromSeq/signingKeyId/secretConfigured/editEtag/createdAt/updatedAt/health，命令可增加 replayed/auditId/changed/pausedGapRange。

**读取实际返回配置 destination.url（可含路径），不是仅 origin 的视图。**不返回独立 secretRef 字段或密钥明文；当前 signingKeyId 取自订阅行的 secretRef，因此是引用标识，列表历史修订视图不能据它推断历史密钥版本。secretConfigured 当前为 true，仅表示引用配置存在，不证明 WEBHOOK_SECRETS 中有可用密钥。health 当前固定 not_started，时间为 null，不承诺订阅健康汇总已经实现。

PATCH 是**部分更新**，只接受 name/destination/secretRef/filter/enabled/reason，必须至少一个非 reason 字段；不是本地旧内核七字段完整替换。If-Match 必填，使用 data.editEtag 或 `X-Subscription-ETag`。变更产生新修订及生效序号；无实际变化不增加版本。远端修订窗口是 `[effectiveFromSequence,effectiveUntilSequence)`，不能套用历史本地内核相反的端点开闭规则。

暂停期间不创建普通新投递，已有队列受暂停约束；恢复返回 pausedGapRange，不暗中补发全部暂停期事件。DELETE 需 If-Match，软删除并取消未完成投递，成功 204；不是当前本地仅内核、无 HTTP 的旧阶段。测试推送 POST /subscriptions/:id/test 接受可选 reason，返回 202 的 delivery 数据，事务内创建显式测试事件及任务，不同步发送，也不自动恢复暂停订阅。

### 5.3 OBS-API-23~25：投递查询与人工重投

列表白名单：subscriptionId/eventId/status/from/to/cursor/limit，按 createdAt DESC、id DESC；状态为 pending/in_flight/retry_wait/succeeded/dead/cancelled。返回 items/nextCursor/hasMore/scannedDeliveries。详情 query 为 attemptsCursor/attemptsLimit（默认50、最大200），attempt 按 attemptNo **DESC**，固定首次页的 maxAttemptNo；返回字段是 **nextAttemptsCursor**、hasMoreAttempts，不是 attemptsNextCursor 或本地旧版数字页键。

投递 data 包含 deliveryId/eventId/subscriptionId/subscriptionRevision/version/status/attemptCount/replayGeneration/suspendedBySubscription/nextAttemptAt/lastError/createdAt/updatedAt/expiresAt。详情再含 attempts，其项为 attemptNo/startedAt/completedAt/durationMs/httpStatus/result/errorCategory/responseSummary；摘要受限且脱敏，不返回原始响应正文、lease 或实际秘密。

retry 必填 Idempotency-Key 与 JSON reason，可选正整数 subscriptionRevision。仅 dead/cancelled 可进入重投；不符合返回 409 DELIVERY_NOT_RETRYABLE。cancelled 必须显式选定当前 enabled 订阅的有效修订。事件不可用/过期返回 410 EVENT_EXPIRED；不重建历史事件。成功 202，保留 eventId/deliveryId/旧 attempts，增加 replayGeneration 并记录审计。

### 5.4 变更并发与幂等

If-Match 缺失为 428 PRECONDITION_REQUIRED、格式错误为 400、版本不符为 412 PRECONDITION_FAILED。caller 用 profileEtag，subscription 用 editEtag；普通响应 ETag 不替代编辑令牌。

创建订阅和测试推送的 Idempotency-Key **可选**，人工 retry 必填。主体、方法、路径、请求摘要共同隔离幂等记录；同键不同内容返回 409 IDEMPOTENCY_CONFLICT，保留窗口 24 小时。重放仍检查访问资格。审计记录安全操作与版本元数据，不声称可以还原任意原始自由文本或秘密。

## 6. 主动消息协议

### OBS-PUSH-01：Socket.IO 实时订阅与恢复

**PLANNED，尚无本文新协议实现。**设计中的 subscribe-observability、subscription-confirmed、observability-event、历史/实时切换、慢消费者和撤权处理均不能作为当前可调用接口。既有 monitoring/runtime-event 不代表新调用事件协议已授权闭环。需求说明留在[设计](./runtime-observability-design.md)，后续 TP13 应复用远端持久事件与水位，另行验收。

### OBS-PUSH-02：Webhook 接收协议

远端闭环包含订阅/投递 API、Outbox 物化、租约发送、密钥解析、每次发送地址检查、签名、有限重试/死信及人工重投；默认关闭，未声明 AVAILABLE。COLLECTOR_ENABLED、OUTBOX_ENABLED、WEBHOOK_ENABLED 三个开关默认均为字符串 false，互不替代。

请求为 POST JSON，头包括 X-ApiNova-Event-Id、X-ApiNova-Delivery-Id、X-ApiNova-Timestamp（Unix 秒）、X-ApiNova-Signature。签名值为 `sha256=<hex>`，计算 `HMAC-SHA256(secret, timestamp + "." + 原始请求正文)`。接收方按原始字节验签并限制时间窗，以 eventId/deliveryId 做幂等；2xx（含202）只表示本次接收成功，不表示后续业务处理完成。

当前实际 Webhook JSON 字段为 schemaVersion/eventId/eventType/sequence/occurredAt/severity/status/subject/data/dimensions/delivery。subject 是 id/version；delivery 是 id/attemptNo/replayGeneration/subscriptionRevision。data/dimensions 来自持久事件。**它不是 HTTP `/events` item 的逐字段同构副本**，没有承诺 recordedAt/server/links/historical 等相同字段；生产者必须在入库前控制敏感内容，不能把 HTTP 白名单裁剪当成 Webhook 脱敏层。

发送事务提交之后执行网络操作，保持至少一次语义。默认请求超时 10 秒；3xx 不跟随；网络错误、408、429、5xx 可重试，其他非2xx 通常永久失败。退避基数 5秒/30秒/2分/10分/30分并带抖动，结合 Retry-After；每 replay generation 最多6次、活动窗口24小时，另受事件/投递保留约束。attemptNo 与历史记录不因人工重投清零。发送正文限256KiB，响应诊断最多2KiB且脱敏；不能解释为业务正文存储上限。

目的地默认 HTTPS，部署主机允许名单、每次 DNS 地址检查与固定解析地址连接共同约束出站；私网地址需显式配置。密钥由允许的引用从部署 WEBHOOK_SECRETS 解析，缺失不使用业务 API Key 或默认秘密替代。端到端运行、平台和负载证据仍需由具体部署提供。

## 7. 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | INVALID_QUERY | 未知、重复、嵌套或无效参数/请求头 |
| 400 | CURSOR_SCOPE_MISMATCH | 端点、主体、过滤、授权或快照启动范围不符 |
| 401 | UNAUTHENTICATED | 无有效管理访问凭证 |
| 403 | FORBIDDEN | 缺少权限或不允许该范围/配置 |
| 404 | NOT_FOUND | 对象不存在或不可见 |
| 409 | IDEMPOTENCY_CONFLICT / DELIVERY_NOT_RETRYABLE | 幂等冲突或当前投递不可重投 |
| 410 | PAYLOAD_EXPIRED / EVENT_EXPIRED | 正文或重投所需事件过期 |
| 410 | QUERY_CURSOR_EXPIRED / EVENT_CURSOR_EXPIRED | 游标/保留区间失效，重新取查询或快照 |
| 412 / 428 | PRECONDITION_FAILED / PRECONDITION_REQUIRED | 编辑令牌不符 / 缺失 |
| 413 | QUERY_TOO_LARGE | 有界查询或请求预算超限 |
| 429 | RATE_LIMITED | 请求受限 |
| 503 | OBSERVABILITY_UNAVAILABLE | 依赖、配置、存储或内部条件不可用 |

错误码按当前安全错误类列出，不承诺另有通用 422 分支。错误 body 中可选 details 的形状按错误类型消费。

## 8. 最小集成流程

1. 通过既有管理认证取得访问 Token，确认部署、角色资源范围和所需细分权限。
2. 读取 capabilities，仅按当前 endpoints/queryParameters 发起请求；不要把 enabled 当 worker 已启动或部署已验收。
3. 使用统计/调用/正文查询，各自遵守参数与权限；overview 仅提供限定调用快照及持久状态视图。
4. 如需事件补拉，先取获授权的 invocationSnapshotSeq，并在有效期内以匹配的 origin/serverType/runtimeAssetId 调用 afterSequence，后续使用服务返回的签名 after。
5. 如需 Webhook，先配置目的地与 secret 允许名单、密钥及独立 worker 开关，再创建订阅、测试推送并通过 deliveries 查询；接收端实现验签/去重。
6. Socket.IO、policies 和实时存活/完整治理不是当前集成前提能力，等待后续明确实现与验收。

## 9. 接口收敛与版本记录

| 版本 | 日期 | 范围 |
| --- | --- | --- |
| 2.1.0 | 2026-09-14 | 静态对齐远端优先整合后的26项限定契约，明确快照、事件/投递响应、权限及运行限制；压缩历史追加记录 |
| 2.0.0 及历史追加 | 截至2026-09-14 | [原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)，不作为当前状态来源 |

旧接口/旧消费者收敛、身份审计联动、Linux/PostgreSQL 实际查询与负载、部署 AVAILABLE 仍须在[当前复核](../guides/runtime-observability-completion-review.md)和[执行状态](../guides/runtime-observability-development-execution-status.md)分别登记。本文不重放历史测试数量，也不把主代理之外的文档整理记作新运行证据。

## 当前开发进度与接入边界

API01~26 的限定契约 VERIFIED；API27/28 与新 Socket.IO 协议 PLANNED；AVAILABLE=0。当前模块注册13个 controller、26个 HTTP operation，独立 worker 默认关闭。overview 的 pipeline/recentEvents 区块、心跳和实时 stateVersion、有效策略/配额/磁盘计量、全局覆盖证明仍未完成。HTTP 与 Webhook 信封差异、订阅静态 health/密钥引用视图限制保留为真实边界。

## 10. TP-03 公共 API 基础的实现约束

### 10.1 管理身份和细分权限

管理 Guard 接受 Bearer HS256，校验 aud=api-nova-management、iss=api-nova、tokenUse=management_access、exp/iat 及当前账号状态。JWT_SECRET 至少32字节，缺失不使用弱默认值。禁用用户/角色/权限和不支持的条件不能降级为允许。细分权限按 AND 与资产交集判断，manage 不替代 payload/source/subscription 权限。

### 10.2 资源范围配置

受控角色 metadata.observabilityScope 为 `{ "mode": "all" }` 或 `{ "mode": "assets", "runtimeAssetIds": [...] }`；缺少范围不默认全局，空数组表示无资产。系统 super_admin 是显式系统例外。同一权限跨角色取并集，不同所需权限再取交集；客户端筛选不能扩大范围。订阅/投递管理需完整覆盖对象范围；API26 必须全局范围。

### 10.3 受控查询和签名游标

API_NOVA_OBSERVABILITY_CURSOR_SECRET 是独立至少32字节秘密，KEY_ID 默认 v1。游标 HMAC 绑定端点、排序、主体/权限、过滤和快照，先验签再使用内容；不含秘密，客户端不解析或自行构造。实际有效期可短于公开上限。overview 的5分钟进程内启动授权与事件15分钟签名游标不是同一种令牌。

### 10.4 版本与幂等原语

编辑令牌必须在授权后的同一变更事务中检查。幂等请求摘要使用独立服务端秘密，安全结果引用与操作共同提交，不保存秘密明文。原语存在不等于 API27/28 已实现，亦不替代对象授权或部署验证。

<!-- Historical heading anchors retained for incoming links; current contracts are sections 1-10. -->

## 11. 共享采集器验证进度

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 12. 当前对外可用性边界（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 13. Gateway 采集语义与验证边界（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 14. MCP 首批采集语义（2026-09-09，历史快照）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 15. MCP 真实传输首轮验证（历史快照）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 16. MCP HTTP 当前采集语义（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 17. 物理上游计量与剩余边界（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 18. 真实 STDIO 验证补充与平台限制（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 17. TP-08 采集节点实现进度（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 17.1 调用者/来源与 worker 的已实现内部语义

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 17.2 持久重启验证边界

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 17.3 源退出、残片与查询前置任务完成

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 12. OBS-API-03/04 实现与联调边界（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 13. OBS-API-05 正文读取实现（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 14. 管理审计检索实现补充（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 19. OBS-API-06 trace 实现与集成契约（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 20. OBS-API-07/08/10 调用者与来源查询契约（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 20.1 查询节点验收补充

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 21. OBS-API-09 档案编辑实现与已知阻断项（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 21.1 档案编辑令牌使用示例

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 22. OBS-API-01 能力查询实现契约（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 23. 统计计算实现进度与接入约束（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 24. OBS-API-11 统计汇总接口（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 25. 时间序列与分组接口实现契约及初轮记录（2026-09-09）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 25.1 共享查询与统计语义

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 25.2 OBS-API-12：GET /statistics/time-series

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 25.3 OBS-API-13：GET /statistics/groups

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

### 25.4 能力发现与前端消费

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 26. 时间序列与分组验收补充（2026-09-11）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 27. 持久聚合规划内核的对外边界（2026-09-11）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 28. 计划接口完成情况复核（2026-09-11）

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。

## 2026-09-14：远端优先整合后的附加查询

历史锚点，仅供旧链接定位。原阶段记录见[原文归档](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md)；当前契约以本文第 3~6 节和[当前复核](../guides/runtime-observability-completion-review.md)为准，不沿用历史状态或测试计数。
