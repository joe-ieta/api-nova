---
doc-version: 1.7.2
doc-status: active
doc-updated: 2026-09-09
approval-status: approved
implementation-status: in-progress
---
# 可观测性对外 API Endpoint 文档

> Document status: Maintained consumer contract; approved endpoint contract; implementation in progress
> Scope decision (2026-09-08, approved): 全新开发版本直接统一旧接口和数据库结构；不提供旧格式导入或旧查询路径兼容。新增 Endpoint 仍为 PLANNED，不能据文档确认推断已经上线。
> 可用性声明：本文新增的 28 个 HTTP Endpoint 和 2 类推送契约目前均为 PLANNED，尚未实现或部署。路径与示例用于确认和后续联调准备，不能作为已上线能力清单。
> 已确认基线：[需求](../guides/runtime-observability-requirements.md)、[设计](./runtime-observability-design.md)。
> 开发关联：[任务计划](../guides/runtime-observability-development-task-plan.md)、[执行状态](../guides/runtime-observability-development-execution-status.md)。

## 1. 文档维护与版本演进

本文是外部集成方使用的接口契约。新增或修改接口时，同一任务包必须同步更新本文、DTO/Swagger、权限映射、契约测试及执行台账。编码后由程序生成 OpenAPI 文档，不另维护一份手写且可能漂移的 OpenAPI YAML。

Endpoint 编号与 operationId 固定，不随文件重构改变。状态为 PLANNED、IMPLEMENTED、VERIFIED、AVAILABLE、DEPRECATED；代码存在只能推进到 IMPLEMENTED，契约测试通过才能推进到 VERIFIED，具体发布/部署验证后才能标为 AVAILABLE。运行版本与部署范围应随 AVAILABLE 一起登记。

本次文档版本为 1.6.2，拟对外数据 schemaVersion 为 1.0。计划已确认，OBS-TP-01 已冻结基础契约。破坏性变化必须单独记录影响与升级方式，不能在同一路径下静默改变计数或权限。

## 2. 基础约定

| 项目 | 契约 |
| --- | --- |
| Base URL | https://{deployment-host}/api/v1/monitoring/observability |
| 认证 | Authorization: Bearer <management-or-service-jwt>；现有管理认证体系中的受控服务身份 |
| 权限 | 所有查询先校验 monitoring:read 与资源范围；额外权限见各 Endpoint |
| 凭证边界 | Gateway/MCP 业务调用 API Key 或 JWT 不自动具有管理 API 权限；本功能不提供 Token 签发 Endpoint |
| 格式 | application/json；正文读取同样返回 JSON，二进制正文使用 Base64 |
| 时间 | UTC ISO 8601 字符串，区间统一为 [from,to) |
| ID | 不透明字符串；客户端不解析 ID 内部结构 |
| 序号 | sequence、snapshotSeq、dataWatermark 始终为十进制字符串 |
| 大数 | 计数和累计字节为 number 或超出安全整数范围后的十进制字符串，客户端统一归一化处理 |
| 耗时 | 毫秒数；无法测量时 null，不能解释为 0 |
| 空值 | 未知、未采集、已过期和实际空内容使用不同状态 |
| 示例 | 示例主机、ID、时间和统计值都是契约示意，不是运行数据 |

完整 URL 使用 /api/v1 前缀。实现时须对照程序全局 prefix 与 Swagger 验证，禁止生成 /api/api/v1 或漏掉 /api。Socket.IO 的 /monitoring 是 namespace，不是这里的 HTTP Base URL，也不是 MCP 的 SSE 入口。

### 2.1 公共响应

成功查询或变更返回：
```json
{
  "status": "success",
  "data": { "items": [], "nextCursor": null },
  "meta": {
    "schemaVersion": "1.0",
    "snapshotSeq": "1842",
    "dataWatermark": "1839",
    "lagMs": 1500,
    "isPartial": false,
    "historyCompleteSince": "2026-09-08T00:00:00Z",
    "gapRanges": []
  }
}
```

单对象接口的 data 是对象；集合接口是 items/nextCursor/hasMore，total 仅在明确支持且请求 includeTotal=true 时返回。示例为简化结构，不要求所有接口都有时间水位；适用字段不得以假零填充。

isPartial 表示已知覆盖缺口或字段不完整；正常异步延迟单独由 lagMs 表示。snapshotSeq 是本次读取可见的入库上限，dataWatermark 是对应投影实际处理位置。正文可能依保留策略过期，游标不延长正文保留期。

错误返回：
```json
{
  "status": "error",
  "error": {
    "code": "INVALID_QUERY",
    "message": "from must be earlier than to",
    "requestId": "req-example",
    "details": { "field": "from" }
  }
}
```

错误不返回密钥、内部文件路径或隐藏资源信息。成功的 DELETE 返回 204 且无响应体，是公共 envelope 的明确例外。

### 2.2 公共过滤与分页

| 参数 | 类型/默认 | 规则 |
| --- | --- | --- |
| from、to | UTC 时间；未提供时最近 1 小时 | 成对提供，from < to；在统计中必须落在可支持保留区间 |
| timeBasis | startedAt，或 completedAt | 调用列表和统计默认 startedAt，响应回显 |
| origin | external | 可选 external/test/probe/internal；telemetry 不进入业务调用事实 |
| serverType | gateway 或 mcp | 无值时查授权范围内两类 |
| runtimeAssetId | 字符串 | 统一服务器身份；不使用 MCP serverId 替代 Gateway 身份 |
| callerId、sourceId | 字符串 | 可信主体与观察来源分别过滤 |
| endpointDefinitionId、toolName | 字符串 | Tool 名不是稳定 API 主键 |
| sourceServiceInstanceId | 字符串 | 上游实例 |
| spanKind | gateway_request/mcp_protocol/mcp_tool/upstream_api | 限定调用边界 |
| outcome | success/error/rejected/timeout/cancelled/incomplete/unknown | started/running 的 outcome 可为空 |
| errorCategory | 字符串枚举 | 可用枚举由 capabilities 返回 |
| traceId、requestId | 字符串 | 查询内部关联；客户端自报 ID 用独立字段，不冒充内部 ID |
| cursor | 不透明字符串 | 绑定过滤、授权范围、快照及排序位置，不跨查询复用 |
| limit | 整数，默认 50，最大 200 | 超限返回 400，不静默截断 |
| includeTotal | false | 只有明确支持的集合可使用 |
| scope | business/http_ingress/tool/protocol/upstream | statistics 的三个接口必填 |
| interval | 1m/5m/1h/1d | time-series 必填，最多 1440 个桶；UTC 对齐 |
| groupBy | 逗号分隔的维度名 | groups 必填，最多两个维度 |
| top | 默认 20，最大 100 | groups 使用 |
| fill | none 或 zero，默认 none | zero 仅对有观察覆盖的空桶填零，缺口保留 unknown |

各接口只接受自己适用的参数。不支持的参数、维度组合和排序返回 400/422。时间跨度限制及长期保留的维度组合以 capabilities 为准，不通过扫描全部文件绕过限制。

invocations 按 (timeBasis DESC, invocationId DESC) 排序；其他列表明确各自默认排序。游标过期返回 410，需要重建查询，不能伪装为最后一页。调用记录会随真实终态和更正提升 recordVersion，列表使用快照可见性和稳定键分页，详情显示返回记录版本。

筛选数组只在订阅等 JSON 请求中使用；HTTP 标量 query 不接收任意嵌套 JSON 条件。所有过滤均与服务端授权范围取交集。

## 3. Endpoint 注册表

下表权限在 monitoring:read 与资源授权基础上叠加；“基础”表示没有额外权限。涉及写入仍须校验相应对象管理权。所有状态为 PLANNED。

| 编号 | 方法与相对路径 | operationId | 额外权限 | 任务包 |
| --- | --- | --- | --- | --- |
| OBS-API-01 | GET /capabilities | obsGetCapabilities | 基础 | OBS-TP-10 |
| OBS-API-02 | GET /overview | obsGetOverview | 基础 | OBS-TP-10 |
| OBS-API-03 | GET /invocations | obsListInvocations | 基础 | OBS-TP-09 |
| OBS-API-04 | GET /invocations/:id | obsGetInvocation | 基础 | OBS-TP-09 |
| OBS-API-05 | GET /invocations/:id/payloads/:side | obsGetInvocationPayload | monitoring:payload:read | OBS-TP-09 |
| OBS-API-06 | GET /traces/:traceId | obsGetTrace | 基础 | OBS-TP-09 |
| OBS-API-07 | GET /callers | obsListCallers | 基础 | OBS-TP-09 |
| OBS-API-08 | GET /callers/:id | obsGetCaller | 基础 | OBS-TP-09 |
| OBS-API-09 | PATCH /callers/:id | obsUpdateCallerLabels | monitoring:manage | OBS-TP-09 |
| OBS-API-10 | GET /sources | obsListSources | 基础；IP 字段需 monitoring:source:read | OBS-TP-09 |
| OBS-API-11 | GET /statistics/summary | obsGetStatisticsSummary | 基础 | OBS-TP-10 |
| OBS-API-12 | GET /statistics/time-series | obsGetStatisticsTimeSeries | 基础 | OBS-TP-10 |
| OBS-API-13 | GET /statistics/groups | obsGetStatisticsGroups | 基础 | OBS-TP-10 |
| OBS-API-14 | GET /dependencies | obsGetDependencies | 基础 | OBS-TP-10 |
| OBS-API-15 | GET /servers/status | obsGetServerStatuses | 基础 | OBS-TP-10 |
| OBS-API-16 | GET /events | obsListEvents | 基础 | OBS-TP-11 |
| OBS-API-17 | POST /subscriptions | obsCreateSubscription | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-18 | GET /subscriptions | obsListSubscriptions | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-19 | GET /subscriptions/:id | obsGetSubscription | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-20 | PATCH /subscriptions/:id | obsUpdateSubscription | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-21 | DELETE /subscriptions/:id | obsDeleteSubscription | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-22 | POST /subscriptions/:id/test | obsTestSubscription | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-23 | GET /deliveries | obsListDeliveries | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-24 | GET /deliveries/:id | obsGetDelivery | monitoring:subscription:manage | OBS-TP-12 |
| OBS-API-25 | POST /deliveries/:id/retry | obsRetryDelivery | monitoring:subscription:manage AND monitoring:delivery:retry | OBS-TP-12 |
| OBS-API-26 | GET /pipeline/status | obsGetPipelineStatus | 基础；系统汇总另需全局资源范围 | OBS-TP-14 |
| OBS-API-27 | GET /policies | obsGetPolicies | 基础 | OBS-TP-14 |
| OBS-API-28 | PATCH /policies/:id | obsUpdatePolicy | monitoring:manage | OBS-TP-14 |

Endpoint 状态在当前注册表声明中统一维护；出现不同状态后增加逐行“实现状态/版本”列。首次可用必须以执行台账证据为依据，而非仅改文案。

## 4. 查询接口对象与行为

### 4.1 OBS-API-01/02：能力与总览

capabilities 返回 supportedScopes、supportedGroupByCombinations、errorCategories、retentionWindows、maxLimit、maxBuckets、maxQueryRange、payloadLimits、byteMeasurements、eventRetention、schemaVersions 和 enabledFeatures。

overview 接收 from/to/origin/serverType/runtimeAssetId，返回 businessSummary、upstreamSummary、serverStates、pipeline、recentEvents 及 snapshotSeq。各区块携带自己的 dataWatermark；不能把尚未汇集的上游流量归零。授权不足的区块省略并提供通用 restricted 标记，不泄露隐藏资源数量。

### 4.2 OBS-API-03/04/06：调用、详情与链路

列表只返回元数据及正文状态。详情至少包含以下字段组：

| 字段组 | 字段 |
| --- | --- |
| 关联 | invocationId、traceId、parentInvocationId、rootInvocationId、requestId、recordVersion |
| 类型 | spanKind、origin、transport、serverType |
| 资产 | runtimeAssetId、serverId（可空）、endpointDefinitionId、operationId、toolName、sourceServiceInstanceId、publicationSnapshot |
| 身份 | callerId、sourceId、authState、identitySource；IP 按权限裁剪 |
| 时序 | startedAt、completedAt、durationMs、lifecycle、completionSource |
| 结果 | outcome、httpStatus、protocolErrorCode、toolIsError、errorCategory、failureStage、脱敏 errorSummary |
| 上游尝试 | upstreamOperationId、attemptIndex、redirectHopIndex |
| 流量 | requestBytes、responseBytes、byteMeasurement、measurementStage、partial |
| 正文 | request/response 的 state、reason、expiresAt 和读取链接 |
| 质量 | schemaVersion、sourceRecordId、ingestedAt、missingFields、isPartial |

traces 返回 nodes、edges、missingParentReferences、isPartial。返回的节点包括所有可访问的协议/工具/上游边界；无权限节点不返回原始 ID 或隐蔽数量，不通过路径透露资源存在。

内部 outcome 仍在运行时允许为空；unknown 表示缺少终态证据，不能算作成功。httpStatus=200 且 toolIsError=true 的工具仍应 outcome=error。

查询示意：
```http
GET /api/v1/monitoring/observability/invocations?from=2026-09-08T00%3A00%3A00Z&to=2026-09-09T00%3A00%3A00Z&serverType=mcp&spanKind=upstream_api&outcome=timeout&limit=50
Authorization: Bearer <management-or-service-jwt>
```

### 4.3 OBS-API-05：正文读取

side 为 request 或 response。该操作同时要求 monitoring:read、monitoring:payload:read 与对应资源范围，不能使用 ANY-OF 权限组合。

```json
{
  "status": "success",
  "data": {
    "invocationId": "inv-example",
    "side": "response",
    "state": "captured",
    "reason": null,
    "contentType": "application/json",
    "encoding": "json",
    "observedBytes": 128,
    "capturedBytes": 128,
    "storedBytes": 124,
    "redacted": true,
    "redactionPolicyVersion": "redact-1",
    "capturedDigest": "sha256-placeholder",
    "digestScope": "observed_raw",
    "content": { "result": "ok", "token": "[REDACTED]" },
    "expiresAt": "2026-09-15T10:00:00Z"
  }
}
```

encoding 可为 json、text、base64、multipart。multipart 内容包含经脱敏的字段与文件 part，不提供任意文件下载路径。incomplete 必须说明摘要/字节仅覆盖部分流。

未采集但存在记录时返回 200 和 omitted/unavailable 状态，content=null；已过期返回 410 PAYLOAD_EXPIRED，携带安全的 state/expiredAt 元数据。未知或不可见 invocation 返回 404，权限不足返回通用 403。读取行为写管理审计。

### 4.4 OBS-API-07/08/09/10：调用者与来源

callers 按 lastSeenAt DESC、callerId DESC 分页。每项包含 callerId、displayName、identitySource、firstSeenAt、lastSeenAt、serverTypes、授权范围内的 observedServerCount、labels 和区间 summary。统计不足时带 historyCompleteSince，不导入或推算旧历史。

caller 详情返回凭证 ID/subject 的受限引用，不返回 Key、JWT、secretHash 或其他可用于认证的值。PATCH 仅修改 displayName、note、labels；不得修改可信 issuer/sub、callerId 或历史证据。

PATCH 请求需 If-Match，示意：
```json
{ "displayName": "订单服务", "note": "生产集成调用者", "labels": ["production", "orders"] }
```

sources 按 lastSeenAt DESC、sourceId DESC 排序；支持 authState、serverType/runtimeAssetId 和时间过滤。返回 anonymous/authentication_failed/unknown 来源、first/lastSeen 与访问摘要。有 monitoring:source:read 才返回 clientIp、peerIp、ipSource、proxyTrusted。没有该权限也不提供可用于反向查 IP 的过滤。

同一 IP 多个可信主体保持分离；同一可信主体的多个 IP 保持关联。匿名来源不是人数，日级 HMAC 标识不保证跨日稳定。

### 4.5 OBS-API-11/12/13/14：统计与依赖

summary 返回 totalStarted、knownCompleted、successes、failures、rejections、timeouts、cancelled、incomplete、unknown、inFlight、uniqueCallers、anonymousSources、requestBytes/responseBytes、successRate、errorRate 与延迟直方图/分位。

failures 包含 error、timeout、incomplete，不能再把它与 timeouts/incomplete 相加当总失败。successRate=success/knownCompleted；errorRate=failures/(success+failures)。无分母返回 null。

字节响应包含 measuredRecords、unmeasuredRecords、partialRecords 以及 byteMeasurement/measurementStage。不同测量边界分组返回，不把工具 UTF-8 大小与 HTTP body 字节相加。

time-series 返回每桶 bucketStart、bucketEnd、bucketVersion、metrics、dataWatermark、coverage。groups 返回 dimensionValues、metrics、rank、hasMoreGroups；唯一调用者要在所查范围重新去重，不能相加各桶去重数。

groupBy 首期维度为 runtimeAssetId、serverType、callerId、endpointDefinitionId、toolName、sourceServiceInstanceId、outcome；具体组合以 capabilities 为准。排序只允许公开指标枚举，不接受 SQL 表达式。p95/p99 返回估计值或区间、algorithm 和 approximate=true，不输出伪精确值。

dependencies 返回 sourceServiceInstanceId/API 到 runtimeAssetId 的关联、upstreamRequests、failures、retryAttempts、affectedBusinessRequests、最近失败和数据覆盖范围。受影响外部访问数按根业务调用去重；同一请求的多个失败尝试不能重复放大。

### 4.6 OBS-API-15/26/27/28：状态与策略

servers/status 返回 runtimeAssetId、serverType、lifecycleStatus、healthStatus、dependencyHealth、freshnessStatus、lastHeartbeatAt、processInstanceId、activeInvocations、unknownInFlight、lastSuccessAt/lastFailureAt 和 stateVersion。

pipeline/status 返回 ingest/aggregation/dispatch 的状态、水位、lagMs、pendingCount、oldestPendingAt、failedRecords、quarantinedRecords、droppedRecords/unknownLoss、diskUsage、effectiveQuota 和 gapRanges。基础流水线计量由其他任务包先实现，本 Endpoint 在 OBS-TP-14 完成治理与权限裁剪后验收。

policies 返回 scope、revision、payloadCapture、redaction 字段规则、retention、quotas、heartbeat 和 deliveryLimits 的有效配置；不返回 secretRef 的实际秘密或敏感文件路径。

PATCH /policies/:id 使用 If-Match，接受该策略支持字段的部分更新；未知字段拒绝。减小 TTL 或容量会影响后续清理，变更记录 actor/reason/revision，并返回 effectiveAt 及 retentionImpact；不在一次 HTTP PATCH 内同步删除大量记录。

初始保留与限制沿用已确认设计：元数据 30 天、正文 7 天、分钟聚合 30 天、小时/日聚合 180 天、事件 14 天、投递及本功能管理审计 30 天；正文上限默认 16 MiB、最大 64 MiB。

## 5. 事件历史、订阅与投递 Endpoint

### 5.1 OBS-API-16：事件历史与补拉

after、until 是事件游标，区间为 (after,until]；不与调用列表 cursor 混用。未提供 after 时从授权且仍在保留期内的可用起点读取，生产集成建议先从 overview 获取 snapshotSeq。支持 eventTypes、severities、spanKinds、outcomes、runtimeAssetId、serverType、callerId、endpointDefinitionId、toolName 与 limit。

结果为 items、nextCursor、hasMore 和 highWatermark。nextCursor 表示已扫描进度，过滤后 items=[] 时仍可能推进。服务端签名游标封装 sequence、过滤和授权；示例 sequence 字符串不等于可自行伪造的签名 cursor。

snapshotSeq 用于创建首次事件订阅的 afterSequence 参数；后续使用服务返回的 after 游标。after 与 afterSequence 互斥，afterSequence 只允许在快照授权/过滤范围内启动，服务将其转为绑定范围的游标。这样无需把不同格式的 snapshotSeq 冒充签名游标。

事件保留过期或过滤/授权发生不兼容变化时返回 410 EVENT_CURSOR_EXPIRED 或 400 CURSOR_SCOPE_MISMATCH。响应提供可用起点和需要重取快照的提示，不自动跳过未知区间。

### 5.2 OBS-API-17~22：Webhook 订阅

POST /subscriptions 返回 201；请求示意：
```json
{
  "name": "订单平台运行监测",
  "destination": { "type": "webhook", "url": "https://monitor.example/api-nova/events" },
  "secretRef": "webhook-orders-v1",
  "filter": {
    "runtimeAssetIds": ["runtime-example"],
    "eventTypes": ["invocation.completed", "server.state_changed", "server.snapshot"],
    "serverTypes": ["gateway", "mcp"]
  },
  "enabled": true,
  "reason": "接入运行态势监测"
}
```

filter 支持 runtimeAssetIds、serverTypes、eventTypes、severities、spanKinds、outcomes、callerIds、endpointDefinitionIds、toolNames。同一数组内 OR，不同字段间 AND；不适用的字段不会命中。若订阅设置 outcomes，仅包含状态结果的调用事件能匹配，心跳不强行填 outcome；需要不同筛选时建两个订阅。

订阅资源范围不得超过创建者权限。目的地按部署允许列表和地址校验约束；secretRef 只引用已授权的签名秘密，不接受在 URL 或请求中直接内嵌业务 API Key。读取返回 signingKeyId 和 secretConfigured，不回显秘密。

订阅返回 id、version、state、filter、effectiveFromSeq、destination 的安全视图和健康摘要。首次创建只匹配之后的新事件，不自动发送全部历史。GET 列表按 createdAt DESC、id DESC 排序，限定管理者有权访问的订阅。

PATCH 使用 If-Match；修改地址/过滤/启停创建新配置 revision。暂停期间不创建新投递，并暂停现有任务重试，恢复后继续已有任务，响应给出 pausedGapRange。旧任务绑定旧配置修订；撤销旧修订后任务 cancelled，需要显式选择当前授权修订进行人工 retry。

DELETE 软删除订阅并停止新投递、取消未完成投递，保留事件和尝试审计。POST /subscriptions/:id/test 返回 202，生成明确 test=true 的事件和一次受控投递，可通过返回的 deliveryId 查询；不计业务调用，也不自动恢复暂停订阅。

### 5.3 OBS-API-23~25：投递查询与人工重投

deliveries 支持 subscriptionId、eventId、status、from/to、cursor、limit，按 createdAt DESC、id DESC 排序。投递状态为 pending、in_flight、retry_wait、succeeded、dead、cancelled；订阅暂停通过 suspendedBySubscription=true 表达，不丢弃逻辑投递状态。

详情返回 deliveryId、eventId、subscriptionId、subscriptionRevision、version、status、attemptCount、nextAttemptAt、replayGeneration、lastError 及尝试分页。attempt 字段包括 attemptNo、startedAt/completedAt、durationMs、httpStatus、result、脱敏 responseSummary、errorCategory。尝试列表不得无限展开；详情支持 attemptsCursor/attemptsLimit，返回 attemptsNextCursor。

POST retry 需要 Idempotency-Key，且需该资源管理范围和 monitoring:delivery:retry。请求为 reason 以及可选 subscriptionRevision；死信可重试，已在发送/等待重试或已成功返回 409。由配置撤销产生的 cancelled，只有显式选定当前有效修订、权限重新满足时才能重试。

返回 202，保留 eventId、deliveryId 和旧 attempts，增加 replayGeneration；新发送追加 attemptNo。事件过期返回 410，不从外部或过期正文重建伪事件。

### 5.4 变更并发与幂等

PATCH/DELETE 对象要求 If-Match 为 GET 返回的 ETag/版本；缺失返回 428 PRECONDITION_REQUIRED，版本过期返回 412 PRECONDITION_FAILED。JSON 中的 version 用于展示，不覆盖服务器版本。

创建订阅、测试推送、retry 接受 Idempotency-Key；retry 为必填。幂等键按调用主体、方法、路径及请求摘要隔离，建议保留 24 小时。同键同内容返回原操作结果，同键不同内容返回 409 IDEMPOTENCY_CONFLICT；记录不能保存秘密明文。

这些是已随任务计划确认的 Endpoint 级并发与幂等契约。

## 6. 主动消息协议

### OBS-PUSH-01：Socket.IO 实时订阅与恢复

归属 OBS-TP-13，状态 PLANNED。沿用 namespace=/monitoring；Socket.IO 不是原生 WebSocket 帧 API，不另约定 WebSocket URL。连接使用受管管理身份，握手传 auth.token，namespace=/monitoring、Engine.IO path=/socket.io；凭证仅通过受控连接传递，不放 URL。当前服务器未自定义 Engine.IO path，新权限检查在实现包中接入。

客户端发送 subscribe-observability：
```json
{
  "filter": { "runtimeAssetIds": ["runtime-example"], "eventTypes": ["invocation.completed"] },
  "afterSequence": "1842",
  "subscriptionVersion": 1
}
```

afterSequence 用于首次快照衔接；重连改传服务返回的 after 游标，二者互斥。服务器确认后发送 observability-event，其载荷与 Webhook 完全一致；事件消息附本次订阅的 resumeCursor，消费者在业务处理后保存，不从未验证 payload 自行拼游标。

启动顺序为 overview 快照、从 snapshotSeq 订阅、补拉至固定高水位、切到实时。迟到聚合使用 metrics.bucket_updated 替换桶；去重使用 eventId，状态/桶更新使用 subject.version。修改过滤后重新获取绑定范围的游标。

慢客户端超过缓冲上限断开并提示恢复；客户端使用最后已处理游标补拉。授权过期/撤销停止推送，不沿用已经过期的连接权限。若游标过期则重新取快照，不把新数据直接叠加到旧总数。

### OBS-PUSH-02：Webhook 接收协议

归属 OBS-TP-12，状态 PLANNED。服务器 POST application/json 到订阅地址。默认推送只含脱敏元数据，不含正文、原始 IP、Key/JWT 或完整认证主体字段。

```json
{
  "schemaVersion": "1.0",
  "eventId": "evt-example",
  "sequence": "1843",
  "eventType": "invocation.completed",
  "occurredAt": "2026-09-08T10:00:01.000Z",
  "recordedAt": "2026-09-08T10:00:01.150Z",
  "server": { "type": "mcp", "runtimeAssetId": "runtime-example" },
  "subject": { "kind": "invocation", "id": "inv-example", "version": 2 },
  "traceId": "trace-example",
  "severity": "error",
  "data": { "spanKind": "mcp_tool", "outcome": "error", "toolName": "get_order", "durationMs": 320 },
  "links": { "invocation": "/api/v1/monitoring/observability/invocations/inv-example" }
}
```

Header 包含 X-ApiNova-Event-Id、X-ApiNova-Delivery-Id、X-ApiNova-Timestamp、X-ApiNova-Signature 和 X-ApiNova-Key-Id。timestamp 为 Unix 秒十进制文本；签名为 sha256= 加十六进制小写 HMAC-SHA256(secret, timestamp + "." + 原始 HTTP body 字节)。接收端必须对收到的原始字节验证，不能对重新格式化的 JSON 签名。

建议接收端接受正负 300 秒时钟偏差并校验事件 ID。每次尝试 timestamp/签名可变，eventId 不变；按 eventId 持久去重后返回 2xx。2xx/202 只表示接收，不意味着下游业务完成。

默认总超时 10 秒；最多 6 次尝试，重试间隔为 5 秒、30 秒、2 分钟、10 分钟、30 分钟并加入抖动，活动重试最长 24 小时。网络错误、408、429、5xx 可重试；在上限内尊重 Retry-After；其他 4xx 永久失败，3xx 不跟随。

事件类型为 invocation.completed、invocation.reconciled、caller.discovered、server.state_changed、server.snapshot、metrics.bucket_updated、pipeline.state_changed。失败用 outcome/severity 筛选，不再额外发一个用于重复计数的 invocation.failed。

默认 15 秒状态快照，45 秒无心跳表示 stale/unknown，明确进程退出才判 offline。消费者收到重复/乱序事件必须按 eventId/subject.version 处理；sequence 是管理面提交顺序，不代替跨进程因果时间。

## 7. 错误码

| HTTP | code | 客户端处理 |
| --- | --- | --- |
| 400 | INVALID_QUERY / CURSOR_SCOPE_MISMATCH | 修正参数、过滤或重建查询 |
| 401 | UNAUTHENTICATED | 使用有效管理凭证 |
| 403 | FORBIDDEN | 缺少权限或资源范围，不重试扩大范围 |
| 404 | NOT_FOUND | 资源不存在或不可见 |
| 409 | IDEMPOTENCY_CONFLICT / DELIVERY_NOT_RETRYABLE | 更换冲突幂等请求或读取投递状态 |
| 410 | PAYLOAD_EXPIRED / EVENT_CURSOR_EXPIRED / QUERY_CURSOR_EXPIRED | 识别过期或重建快照 |
| 412 | PRECONDITION_FAILED | 重新读取版本后决定变更 |
| 413 | QUERY_TOO_LARGE | 缩小范围/正文请求；不代表业务 API 正文限制 |
| 422 | UNSUPPORTED_HISTORICAL_DIMENSION / INVALID_SUBSCRIPTION_DESTINATION | 选择支持维度或合法目的地 |
| 428 | PRECONDITION_REQUIRED | 补充 If-Match |
| 429 | RATE_LIMITED | 在限定窗口内退避 |
| 503 | OBSERVABILITY_UNAVAILABLE | 保留消费游标并稍后恢复 |

## 8. 最小集成流程

1. 使用受控管理/服务身份调用 capabilities，确认版本、支持维度和资源权限。
2. 获取 overview 与 snapshotSeq，加载明细/统计，并保留 dataWatermark 与完整性状态。
3. 实时展示使用 Socket.IO；后端主动接收使用 Webhook。两种方式按同一 eventId 去重。
4. 遇到失败事件，按 links 获取 invocation，再取 trace 和被授权的 payload。
5. 用 events 补拉断线区间，用 deliveries 查询发送过程；游标过期重建快照。
6. 对 metrics.bucket_updated 按桶版本替换，不能每收到一次事件就给总数加一。

## 9. 接口收敛与版本记录

OBS-TP-15 将重复调用日志接口和现有调用方直接收敛到本文的新 Endpoint。不为 /api/v1/monitoring/management/gateway-access-logs、/management/external-callers 建立兼容别名。必要的生命周期/健康管理功能仍保留其业务职责，权限不能因收敛而放宽。

| 文档版本 | 日期 | 内容 | 实现/发布状态 |
| --- | --- | --- | --- |
| 1.0.0 | 2026-09-08 | 首次登记 28 个 HTTP Endpoint、Socket.IO/Webhook、对象与错误契约 | 全部 PLANNED；未发布 |
| 1.1.3 | 2026-09-08 | 同步 TP-02 验收、正文过期保留审计及内部 GC 边界；无新增对外路由 | 全部 PLANNED；未发布 |

## 当前开发进度与接入边界

2026-09-08：共享 v2 采集契约及阶段写入已有代码；TP-02 存储包退出条件已满足，包括正文归属、写入/回收互斥和孤立回收。API build、48 项存储/GC 用例与 PostgreSQL 四进程测试通过，此前两方言初始化烟测通过。本文 28 个 HTTP Endpoint、Webhook 和 Socket.IO 新订阅仍为 PLANNED，没有新增可供调用的已上线接口。

源 schemaVersion=2 与对外 envelope schemaVersion=1.0 属于不同层级，不是保留两个历史格式。旧日志查询路径及其调用方将在 OBS-TP-15 直接切换，不提供自动降级或兼容别名。数据库结构只维护当前空库基线；已有开发库不会自动升级或删除，需要另行明确处理。

对外 sequence 仍为十进制字符串且允许有间隙；内部补零排序键不对客户端暴露。正文摘要中的 capturedDigest 与对象存储完整性摘要用途不同，客户端不得据此假设脱敏前后内容相同。更多实现边界见[存储基础说明](./runtime-observability-storage-foundation.md)。

验证进度更新（2026-09-08）：48 项存储/GC 用例全部通过；PostgreSQL 四进程验证了提交/回滚顺序、未提交不可见、跨进程写入租约和孤立回收，schemaDrift=0、清理退出码 0。Linux 与全链路矩阵尚未执行，pg 非致命弃用警告仍待定位。截至 2026-09-09，TP-03 权限与 API 基础已通过 API 构建及 56 项专项验收；存储模块尚未接入运行时，GC 也没有自动调度。

正文过期后的调用审计元数据仍保留；正文读取接口实现时须维持 PAYLOAD_EXPIRED 语义。目录归属、内部租约、generation、文件路径和 GC 控制入口属于服务端内部机制，不增加对外清理 Endpoint，也不暴露磁盘路径。后续 OBS-API-26/27/28 由 TP-14 提供授权后的治理/健康视图，不能直接透传内部状态行。

## 10. TP-03 公共 API 基础的实现约束

本节对应已通过包级测试但未部署的公共原语，不改变全部新 Endpoint 的 PLANNED 状态。TP-03 实现在提交 efb4536 之后完成，不包含新增 Token 签发 Endpoint。

### 10.1 管理身份和细分权限

复用现有管理登录/刷新流程签发访问 Token。新的可观测性 Guard 只接受 Authorization Bearer、HS256、aud=api-nova-management、iss=api-nova、tokenUse=management_access，并校验 exp/iat 与数据库中的当前账号状态。缺少用途声明的旧 Token、刷新 Token 和 Gateway/MCP 业务凭证不得用于新接口；新版本启用后通过既有登录/刷新流程取得管理访问 Token，不增加兼容降级。

JWT_SECRET 至少为 32 字节，缺失或不足时新 Guard 返回 OBSERVABILITY_UNAVAILABLE，不使用默认弱密钥。角色、权限和资源范围每次由服务端读取，不相信 Token 自报的权限数组或用户 preferences/metadata。

所有操作必须满足 monitoring:read 和本接口额外权限，按 AND 组合；正文叠加 monitoring:payload:read，原始 IP 叠加 monitoring:source:read，订阅与投递管理叠加 monitoring:subscription:manage，重投再叠加 monitoring:delivery:retry。monitoring:manage 不自动替代正文或 IP 的读取权限。四项新权限进入现有系统种子定义，但本轮没有执行种子或修改现有用户授权。

### 10.2 资源范围配置

受控角色管理 API 的 metadata.observabilityScope 支持两种形式：

```json
{"observabilityScope":{"mode":"assets","runtimeAssetIds":["runtime-example"]}}
```

```json
{"observabilityScope":{"mode":"all"}}
```

每个角色最多 1000 个资产 ID；assets 空数组表示没有可见资产，缺少范围配置默认不授予新可观测性资源访问。启用的系统 super_admin 角色具有全局范围；其他账号，包括受管服务账号，均需要显式角色范围。角色创建/更新继续走现有安全管理权限及审计，不能通过请求筛选或用户资料扩大范围。

同一权限的多个角色范围取并集，不同必需权限的范围再取交集；不能把 A 服务器上的正文权限与 B 服务器上的普通读取权限拼成 B 的正文访问权。禁用角色/权限不参与授权，未实现的 permission.conditions 非空条件不得被忽略并放行为无条件权限。

集合查询必须把授权范围与请求范围取交集，空集必须落实为无结果条件；详情检查不可见资源返回通用 NOT_FOUND。跨资源 trace、IP 字段、订阅对象管理范围和系统级汇总仍须由对应服务调用这些基础校验，不能仅挂 Guard 就声称所有对象已授权。

### 10.3 受控查询和签名游标

每个 Endpoint 明确传入适用参数白名单，未知/重复数组/嵌套 query 拒绝。基础解析覆盖标量、枚举、UTC 时间、50/200 分页、时间区间、最多两个分组维度和 1440 个桶限制；支持维度组合、统计必填 scope/interval 等业务校验仍由 TP-09/10 实现。

API_NOVA_OBSERVABILITY_CURSOR_SECRET 为独立的至少 32 字节服务端随机秘密；API_NOVA_OBSERVABILITY_CURSOR_KEY_ID 默认为 v1。HMAC-SHA256 游标绑定用途、Endpoint、排序、当前主体与授权范围摘要、归一化过滤、快照和位置。先验签与授权，再使用游标内容；跨主体/过滤/范围不能复用。默认有效 15 分钟，查询最大 1 小时，事件最大 14 天且不能超过实际事件保留窗口。

续页必须从已验签游标恢复原归一化过滤，再解析本次显式参数并检查过滤一致性，不能重算默认“最近一小时”。页大小和 includeTotal 不改变过滤身份。游标仅签名、不加密，不得装入密钥、正文或原始 IP；客户端将其视为不透明恢复凭据。更换游标签名秘密会使旧游标失效，重新取快照，不承诺旧密钥兼容链。

### 10.4 版本与幂等原语

ETag 绑定资源 ID 摘要和正整数版本；If-Match 只接受一个精确强 ETag，不接受通配符、弱 ETag 或列表。缺失为 428，格式错误为 400，不匹配为 412。对应资源的读取、版本检查、修改和审计必须处于同一加锁事务，单独调用 Header 检查不构成并发保护。

Idempotency-Key 为 1~128 个非空白可见 ASCII 字符。API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET 是独立的至少 32 字节服务端随机秘密，用于请求摘要，不复用业务 API Key。幂等身份按主体/方法/规范路径/键生成不可逆摘要；请求内容只存 HMAC 摘要，24 小时记录仅保存安全的结果引用（statusCode/resourceId/version/operationId），不保存秘密或完整响应。

同键重入必须再次校验当前对象授权；同内容复用原操作结果，异内容 409，权限范围变化拒绝复用。数据库修改、审计/Outbox 与幂等记录共用 TP-02 事务，回滚不留下成功记录。回调内禁止网络发送，实际推送由后续分发任务完成。更换请求摘要秘密不改变幂等身份，保留窗口内旧请求摘要无法匹配时返回冲突，不自动重复执行。

2026-09-09：补齐测试模块依赖后，56 项专项与原有 48 项回归共 104/104 PASS，API 构建通过。验证范围为公共原语及隔离 HTTP 夹具，不代表任何新业务 Endpoint 已达到 VERIFIED。公共错误只返回安全固定文案与服务端 requestId，不回显驱动错误或磁盘路径。成功 envelope/分页 DTO 是公共基础，204 无正文、全局响应拦截器协作、Swagger 路由和读取审计仍须在具体 Endpoint 集成时验证。

## 11. 共享采集器验证进度

TP-04 已提供单次物理上游请求适配器，明确记录 attemptIndex/redirectHopIndex、原始字节观察边界以及流是否完整结束。一次实际请求对应一个 upstream_api 调用；适配器不会自行重试或重复消费流。内部健康包含 attemptsStarted/attemptsCompleted/instrumentationFailures/finalizeFailures，文件失败另由共享写入健康记录；这些计数尚未成为已上线健康 Endpoint。

四组 parser 测试共 60 项及 parser/API 构建已通过，覆盖新增的 16 项上游尝试与故障用例。TP-03 专项与 Gateway 包级接入验收已完成，MCP/测试探测和正式应用集成仍未完成。28 个 HTTP Endpoint 与两类推送继续保持 PLANNED，不能将新导出函数等同为对外服务已可调用。

## 12. 当前对外可用性边界（2026-09-09）

TP-03 的管理身份隔离、AND 权限、显式资源范围、查询归一化、签名游标、资源版本与幂等基础已验收；现有管理登录/刷新流程用于签发符合用途约束的访问 Token。未新增 Token 签发接口，普通角色不会自动获得正文或来源 IP 权限。

生产查询控制器、读取审计、Swagger 路由及全局响应拦截器协作尚未接入。28 个 HTTP Endpoint、Socket.IO 与 Webhook 推送保持 PLANNED；公共基础通过不等于 Endpoint 已开放。Gateway 包级接入已由 TP-05 完成，本阶段不新增 Endpoint 或更改路径。

## 13. Gateway 采集语义与验证边界（2026-09-09）

Gateway 包级实现已通过 21 项真实回环 HTTP 专项及 104 项基础回归，API 构建通过。记录维度为独立 gateway_request 与 upstream_api，通过内部 requestId、traceId、parentInvocationId/rootInvocationId 关联。客户端 x-request-id 仅存入受限 clientRequestId；返回及转发的 x-request-id 为服务器新生成的 ID。

入口字节来自现有请求读事件与 ServerResponse 写入，measurementStage=gateway_http；上游字节由单次适配器观察，measurementStage=upstream_http。两侧均为 observed_body，不等于 TCP/TLS 线速流量，不跨阶段相加。未读入的请求正文保持不可用，不能拿 Content-Length 或空字符串伪装观察值。入口成功以客户端响应 finish 为界，上游成功以上游响应完整结束为界；断开和中断不记为成功。

缓存命中只新增入口，cacheHit=true；实际重试使用同一 upstreamOperationId 与递增 attemptIndex。代理不自动跟随重定向，redirectHopIndex=0。没有重放缓冲的带正文请求不自动重试。可信 API Key 身份在路由权限判断前建立，因此“认证成功但拒绝访问”仍保留可信调用者，错误凭证不会生成伪造调用者。

当前 clientIp/peerIp 为直接连接端，ipSource=peer、proxyTrusted=false；不承诺反向代理后的最终客户端地址，逐跳可信解析需集成验证。上述是采集能力，不是 API 开放证明；所有新 Endpoint 和推送保持 PLANNED，生产控制器/监听器完整集成仍由 TP-15 验收。

## 14. MCP 首批采集语义（2026-09-09，历史快照）

HTTP 协议入口作为 Tool 的父节点，STDIO/程序化请求在没有 HTTP 父节点时建立独立 mcp_protocol；Tool 使用 mcp_tool，后续上游作为其子节点。协议与 Tool 的 Payload 按 serialized_payload/logical_payload 计量，不冒充 HTTP 原始流量。

独立协议节点保存 JSON-RPC 请求/响应；Tool 保存 params 与 result/error 的逻辑内容。发送 Promise 成功才允许成功终态，发送异常记录 MCP_SEND_FAILED 和 incomplete 正文状态，不保留未完成片段。toolIsError 和 protocolErrorCode 可区分工具失败与 JSON-RPC 失败；通知无 ACK，不能记作业务成功。

上述能力已通过 15 项传输模拟与 140 项联合回归、Server/API 构建；真实 SDK 传输、HTTP 全正文/认证前失败、上游适配仍未完成。所有 28 个 HTTP Endpoint 和两类推送继续 PLANNED。

## 15. MCP 真实传输首轮验证（历史快照）

2026-09-09：真实 Streamable/SSE 安全审计烟测通过，三次实际上游调用的 HTTP 入口、Tool、上游父子链路以及身份/内部 requestId/trace/root 一致性已验证；同时覆盖认证、会话归属和 Tool 权限拒绝。该集成场景与 140 项专项/回归分别计数。

HTTP 全正文/取消、真实 STDIO 与 parser 上游适配仍在 TP-06 中推进。上述证据不改变 Endpoint/推送 PLANNED 状态，也不代表已有 API 可查询这些新日志。

## 16. MCP HTTP 当前采集语义（2026-09-09）

HTTP 入口按 observed_body/mcp_http 观察已有请求读事件和响应写入；认证前未读正文不被主动排空，也不伪造为空正文。取消或流中断保留完整性状态，不保存未完成的正文片段。SSE 原始帧仅记录观察字节并以 sse_framing_not_captured 省略内容，Tool 逻辑 Payload 独立采集；调用方应显示省略原因而不是将其视为零流量。

HTTP 200 携带 JSON-RPC error 时仍记录协议失败。公共脱敏已修复标量字符串被重写的问题，保留严格 jsonrpc="2.0" 判断，不接受被误改的版本作为兼容形式；JSON 编码对象/数组中的秘密仍递归脱敏。

HTTP 15 项专项在本轮 155 项联合回归中全部通过，真实 Streamable/SSE SDK 烟测通过。该证据是采集端包级验证，不代表新的日志查询 API 已开放。

## 17. 物理上游计量与剩余边界（2026-09-09）

有运行调用上下文的 parser 出站按每次原生 HTTP 请求建立 upstream_api。多个跳转共用 upstreamOperationId，redirectHopIndex 逐跳递增；当前 Axios 不自动重试，attemptIndex=1。跳转不计为重试，不能用整个逻辑调用的最终响应代替各跳证据。upstream_http、mcp_http 与 Tool 的 logical_payload 必须分层展示，不跨阶段相加为网络总量。

响应观察早于跳转丢弃与 Axios 解压处理。正文未观察完整时记录 incomplete，不以 Content-Length 推算实际读入字节。编码正文保留实际观察字节及原始编码头，但不保存未经安全脱敏的压缩原文，省略原因为 encoded_body；业务客户端仍正常解压。此次 gzip 路径已经专项验证，不能据此宣称所有编码算法均完成集成矩阵。

Axios 默认的超时 ECONNABORTED 仅在确认来源为 Axios 错误时按 timeout 记录，ETIMEDOUT 同样记录超时；显式取消与普通原生中止不被一律当作超时。原业务异常码保持不变，日志不保存原始异常消息来推断分类。

当前 parser 86/86、Node 联合回归 155/155、真实 Streamable/SSE 和三包构建全部通过，前版四项失败已解决。真实 STDIO、完整传输矩阵和性能验证仍未完成；操作级 Agent 当前不复用跨操作连接。TP-04 已重新验收，TP-06 仍在进行。

新调用查询、聚合、调用者、事件与推送服务尚未接入运行。全部 28 个 HTTP Endpoint 及两类推送仍为 PLANNED；本次文档版本同步经过验证的采集语义，没有新增公开路径或宣告接口可用。

## 18. 真实 STDIO 验证补充与平台限制（2026-09-09）

实际子进程已验证 stdout 纯协议（含 debug 启动）、STDIO 协议/Tool/物理上游的父子关系、逻辑正文脱敏、错误与并发，以及主动关闭时待完成调用取消并在进程退出前完成日志 flush。STDIO 未经网络认证时只记录实际匿名上下文，不凭本地进程连接虚构可信用户或来源 IP；工具逻辑字节不冒充 HTTP 流量。

新增 8 项全部通过，联合回归 163/163 和真实 Streamable/SSE 烟测通过。慢读测试已修正 Windows 同步管道下的控制通道等待：父进程暂停消费、确认实际响应写入开始后检查两层调用无终态，恢复读取后验证完整响应与唯一成功终态。该验证不等于远端业务已处理响应。

当前 Windows Node 仍对 stdout 管道同步写入，慢消费者可能阻塞事件循环，进程不一定能及时生成心跳或处理控制消息；观察端新鲜度判断需要独立于生产进程。夹具为了建立观察基线而提前 flush started 记录，不代表生产发送路径新增了同步落盘保障。

主动 server.close 与恢复读取的证据不等于 stdin EOF、stdout 断管或任意退出路径均已验证。上述边界和 Linux/性能仍待完成；全部 28 个 HTTP Endpoint 与两类推送继续 PLANNED，本批不增加公开接口。

## 17. TP-08 采集节点实现进度（2026-09-09）

新增内部单文件 collector，不新增 HTTP 路由，本文全部 Endpoint/推送状态仍为 PLANNED。数据集的 historyCompleteSince/eventLiveSince 已持久化；早于 eventLiveSince 的初始 v2 终态事件标记 suppressed，保留审计历史但不进入实时分发；不能把它们当成当前流量。

后续 health/overview 应明确区分最近成功时间、水位、最近文件积压、部分行、隔离数与已知源序号缺口。当前内部 backlogScope=last_visited_file，不代表全目录积压；采集内存错误独立保存，数据库不可用时持久心跳不会伪装成新鲜。源文件路径与错误正文不对外公开。

本节点 API build 和 118 项联合回归通过（新增采集 14 项）。目录自动汇集、调用者算法、恢复调度及公开查询仍在后续节点完成。

### 17.1 调用者/来源与 worker 的已实现内部语义

已提供可信 caller/credential/source/observation 同事务投影和显式启用的目录 worker，API build 与 133 项联合验证通过，全部公开 Endpoint/推送仍为 PLANNED。来源采用带 keyId 的 HMAC；匿名/认证失败来源不等于人数，不包含可认证的原始 Key。来源超限时 sourceOverflow=true、来源桶 ipSource=overflow 且 IP 为 null，后续 sources/health 需表达降级数量，不把它们当作精确去重人数。

内部 worker 状态区分 running、waiting_for_source、degraded，扫描范围为 partial_directory_scan/completed_directory_scan，附部分行、已知文件积压、隔离和错误数量。完整扫描没有已知缺口时才做独立失联推断；unknown 不虚构 completedAt/durationMs，迟到终态增加投影版本而非新增一次调用。公开接口的字段裁剪/授权和运行态报告尚需后续任务接入。

### 17.2 持久重启验证边界

不同采集进程重开持久 SQL.js 后，数据集起点、调用版本、检查点、正文引用和幂等事件已通过 3 项专项；联合 136/136 PASS。unknown 的真实完成更正不增加调用总数，重复源事件不推进事实水位。强杀测试发生在 SQL.js 文件明确保存完成之后，不覆盖机器断电或生产者未刷出内存。

目录 EOF 仍只代表当前没有更多字节，不是源进程结束证明；关闭源残片的缺口状态必须经后续可信退出证据确认。以上是内部链路验证，公开 28 个 Endpoint 及两类推送仍为 PLANNED。
