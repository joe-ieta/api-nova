---
doc-version: 2.7.0
doc-status: active
doc-updated: 2026-09-14
---
# 统一调用可观测性：远端主链路与本地增量接入

## Document status

Active, version 2.7.0, updated 2026-09-14. The current integration baseline is the lead agent's supplied remote `950e150` context, not a Git verification performed here. The [completion review](runtime-observability-completion-review.md) is the current summary; [execution status](runtime-observability-development-execution-status.md) is the evidence index.

Current reported status: 28/28 verified within their limited contracts; API-27/API-28 implement new-event retention only; bounded Socket.IO event pages implemented, full state/snapshot protocol incomplete; TP11/TP12 done; AVAILABLE=0. Signed delivery, destination safety checks and manual replay already exist and are not reopened development tasks. OUTBOX and WEBHOOK automatic loops default off.

This round implements bounded Socket.IO event pages and separates new delivery retention (30 days) from event validity (14 days). Current test evidence is recorded in the execution status; prior Parser 103, MCP 53 and API 548 counts remain historical. No deployment or production cleanup is implied. The [archived remaining-work record](../archive/summaries/runtime-observability-2026-09-14/remaining-work-2026-09-14.md) is historical, not the active backlog.

## 整合基线

以远端 950e150 整合上下文 的持久聚合、事件历史、Outbox、订阅/投递 API 和签名发送为唯一主链路。本地独有的根应用接入、overview/dependencies/servers/status/pipeline/status、缓存三态、内部调用 origin 隔离及 MCP 发送边界修复作为增量整合。

本地先前的重复 bucket projector/queue、dispatcher、subscription command、delivery lease、webhook sender/worker 已由远端实现替代，原始代码保存在 2b4c6c6 提交中。不能继续引用这些旧类或恢复双消费者。

## 模块与后台任务

AppModule 只导入一次 CallObservabilityModule。模块保留远端全部管理控制器和 Provider，在其上添加四类本地查询及进程内调用快照授权。不存在本地旧版 withWebhook 动态装配入口。

- API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED：字符串 true 才启用采集；默认 false。采集/重算遵循远端 Store 的持久投影协议。
- API_NOVA_OBSERVABILITY_OUTBOX_ENABLED：字符串 true 才启用远端 Outbox；默认 false。入队不表示接收端收到。
- API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED：字符串 true 才启用远端 DeliveryWorker；默认 false。密钥和目的地配置必须按远端实际契约完成。
- 本地旧 AGGREGATION_ENABLED 和 DISPATCH_ENABLED 不再对应消费者，不应作为部署开关使用。schema 中残留的 API_NOVA_OBSERVABILITY_AGGREGATION_ENABLED 声明不代表旧聚合消费者仍存在；出站链路使用 OUTBOX/WEBHOOK 开关。

管理 JWT、游标 HMAC、来源标识 HMAC、幂等 HMAC 和 Webhook 签名秘密应独立配置，不能复用业务 API Key。本文不包含真实秘密。数据库初始化结构保持远端版本；本次不执行迁移、不修改环境文件、不初始化业务库、不启用发送。

## 保留的本地查询能力

overview、dependencies、servers/status 按当前管理授权和资源范围读取。没有真实心跳证据时健康/存活保持 unknown，不用旧状态时间冒充实时健康。

pipeline/status 仍只允许显式全局 monitoring:read，读取远端 metrics.recompute 标记、Outbox 与 Webhook 持久状态，不读取已移除的本地队列字段。检查点或状态年龄不自动等于端到端延迟。

调用快照桥接只覆盖 invocation facts。快照授权绑定主体、权限、资产范围及 origin/serverType/runtimeAssetId，进程内 5 分钟、最多 1000 项；重启或淘汰后重取总览。桥接以可选增量方式加入远端事件服务，不修改远端已有类型、游标完成/过期和固定水位语义。

缓存三态计数只使用 gateway_request 的显式证据。新持久桶直接支持缓存字段；旧桶缺少完整缓存字段时沿用远端明细降级，不补造零值，也不把保留明细当完整长期历史。

## 订阅与投递的唯一数据契约

订阅状态为远端 enabled/paused/deleted，destination 使用远端对象格式，修订采用 [effectiveFromSequence,effectiveUntilSequence)。公开 PATCH、列表游标、人工重投与 attempts 均沿用远端控制器和服务。不得把本地旧 active/config.enabled/字符串 destination 或右闭区间写回共享表。

完整接收端和秘密配置说明见[外部验收交接](runtime-observability-external-validation-handoff.md)；订阅管理说明见[订阅接入](runtime-observability-subscription-integration.md)。secretRef 的本机映射及实际秘密只能通过获批的本机环境或部署机制配置，不在聊天中提供秘密，不因文档更新而启用发送。

## 验收边界

远端闭环结论予以保留，合并需要另立回归证据证明没有破坏远端行为。本地历史 105/105 与远端历史专项不能直接作为合并后结果，也不相加冒充新增总量。

真实 PostgreSQL/Linux、多进程、容量性能、全链路审计和实际部署需独立验收。远端已完成的订阅/投递管理不重新列为从零开发待办；API-27/API-28的新事件留存已验证，完整策略治理仍未完成；Socket.IO 已有有界事件页切片，但完整状态快照仍未闭合，不由本文扩大待办范围。真实存活缺少证据时保持 unknown；没有部署验收证据前 AVAILABLE=0。

## 2026-09-14 正文策略与清理调度增量

新正文payloadDays默认7、范围1–365；旧到期时间保持，不因策略变更或并发修订而复活。事件eventDays与正文payloadDays可独立PATCH，沿用强If-Match及原子审计。

正文清理worker默认关闭。以下配置使用前缀 `API_NOVA_OBSERVABILITY_RETENTION_`：ENABLED仅字符串true/false（默认false）；INTERVAL_MS默认60000、范围1000–86400000；SCAN_LIMIT默认128、范围1–1000；DELETE_LIMIT默认32、范围1–SCAN_LIMIT；GRACE_MS默认86400000、范围60000–604800000。无效配置不清理。显式开启后等待首个间隔，单次扫描/删除有界、实例单飞、复用跨实例GC fencing；停止等待在途任务。

清理仅作用于正文对象，不删除事件、投递、调用元数据或原始采集日志。启动状态库故障不阻断业务；必须成功持久running证据才调用GC，失败在后续间隔重试。pipeline/status.retention白名单报告包含时效和上次完成结果，不能当作实时心跳。此轮未启用实际环境清理。

UI调用事实通过独立Socket.IO连接使用新授权快照与签名分页；收到并应用页后ACK，断线从最后处理游标恢复，身份更换清空缓存。页面保留最多200条最近事件，统计从授权快照刷新，不用事件重复累加。旧连接继续承担管理和生命周期；全局状态快照与全部旧消费者迁移仍未闭合。

## 管理进程周期心跳

`API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED` 默认false，仅字符串true显式启用；`API_NOVA_OBSERVABILITY_HEARTBEAT_INTERVAL_MS` 默认15000，允许1000–60000毫秒，失效阈值/owner租约为间隔的3倍。独立定时循环通过现有Store事务写入management-heartbeat及同事务pipeline.state_changed，不要求业务流量。无效配置不调度，运行故障保留上次证据并在后续周期重试；默认关闭不写状态/事件。

固定状态行只覆盖一名租约持有者，不能表示所有管理节点健康。活跃owner阻止其他进程覆盖；租约超时可接管，旧owner停机不覆盖新owner。正常停机报告stopped。状态查询以lastHeartbeatAt计算recent/stale，过期不是offline。配置关闭后旧持久报告仍可能存在，必须结合时效解释。

仅全局授权可见servers/status、overview.serverStates与pipeline/status的managementHeartbeat；资产范围请求不暴露管理进程信息。证据范围为management_process_store_roundtrip，businessServerLivenessEvaluated=false。它不证明业务Gateway/MCP存活、真实在途数或采集成功，业务心跳字段仍未知。没有改动实际环境配置。

## Gateway日志消费者收敛

监控Dashboard的Gateway访问日志改用 `/api/monitoring/observability/invocations`。首屏查询最近一小时，固定external/gateway/gateway_request/startedAt，支持runtimeAssetId、outcome、requestId过滤；每页20条，以签名cursor继续同一快照，提供下一页和最新一小时。历史页不被后台轮询替换。

UI展示调用ID、资产、requestId、结果、HTTP状态及耗时元数据；不取正文。旧method/path/statusCode过滤未映射为伪服务端过滤，当前入口改用新接口实际支持字段。失败/撤权/游标失效清结果，不回退旧查询；切换主体/token立即取消在途读取并清分页。旧后端接口尚未删除，其余消费者收敛仍属TP15。

## Gateway本实例路由观测与策略UI

`API_NOVA_OBSERVABILITY_GATEWAY_ROUTING_OBSERVER_ENABLED`默认false；显式字符串true开启。`API_NOVA_OBSERVABILITY_GATEWAY_ROUTING_OBSERVER_INTERVAL_MS`默认15000、允许1000–60000毫秒，租约/失效阈值为3倍间隔。producer读取实际GatewayRouteSnapshotService生效快照，不包括candidate/rollback暂存；在Store写锁内同步采样并核对数据库Gateway资产类型。最多200资产、10000路由，超限整次失败，不用截断数据填零。事件/各资产报告/owner租约同事务，旧owner停止不能覆盖接管者。

servers/status与overview.serverStates的Gateway条目新增gatewayRoutingObservation，按资产授权读取。evidenceScope=local_process_routing_registry，coverage=single_lease_holder_process，isPartial=true；registered/no_registered_routes仅表达该实例路由表，不能判断其他进程或HTTP监听器健康。报告包含observerState、freshnessStatus、activeRouteCount、processInstanceId、observedAt、stoppedAt、observationAgeMs、stateVersion、dataWatermark；无URL/凭据。停机保留最后观察时间和计数，只将observerState改stopped。无证据/坏报告为unknown，过期stale不是offline。

Dashboard现有监控页新增保留策略卡片。GET读取当前eventDays/payloadDays，capabilities仅全局policyManagement enabled可编辑；1–365天、原因必填、强If-Match。412重读最新值并提示冲突，不自动重放；网络失败可能已经提交，只能重新读取确认。身份变化/卸载取消旧请求并清状态，旧响应不覆盖新操作。此UI仅修改新记录TTL，不触发GC或实际环境开关。

## GC扫描样本容量与只读诊断

pipeline/status.retention.scanUsage来自既有GC扫描的同一次lstat，不额外遍历全盘、不另开定时器。observedBytes是本批清理前合法正文/临时对象的逻辑文件长度总和，observedFiles为测量对象数；不会跨批累加为当前总量。currentTotalBytes和filesystemAvailableBytes始终null，quotaEnforced=false。

scanCoverage仅衡量单次扫描：从分片边界起、遍历256分片、无缺失/未测量条目且未截断才为complete；其他可用样本为partial，无本次成功报告/旧结构/坏值为unknown。完整扫描也不是原子当前磁盘总量。scanStartedAt/scanCompletedAt独立于worker状态时间，worker停止不会把旧样本变新；失败或busy不把旧lastReport容量冒充本次结果。所有长度加总有safeInteger检查，异常不发布新测量。

Dashboard新增只读诊断卡，分别显示管理心跳、授权Gateway路由观测、留存worker和扫描样本。服务器读取时间、管线读取时间、报告时间和扫描时间分开。仅全局pipelineStatus能力开启才请求管线；部分来源失败不会遮蔽仍有权限的路由数据。未知不补零，stale不解释offline，手工刷新不启动GC。整轮10秒超时，切账号及卸载取消读取并清状态。
