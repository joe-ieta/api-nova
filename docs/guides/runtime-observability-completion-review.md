---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-09-11
---
# 统一调用可观测性：任务完成情况复核与未完成清单

> 本次在既有 1c70067 复核基线上继续并发开发，以下状态描述当前工作区，不代表已经提交、发布或部署。
> 当前结论：采集、查询、持久贡献/重算与事件历史已形成可验证的应用内链路；完整保留治理、主动网络投递、统一实时状态和平台性能验收仍未全部完成。

## 1. 产品定位与本轮结论

ApiNova 是围绕 API 资产导入/注册、测试、治理与发布构建的 Gateway/MCP 双模能力平台。统一调用可观测性为其运行闭环提供事实：区分外部入口、MCP 协议/Tool、物理上游和 test/probe/internal 来源，不将管理监控或自身健康通信计作业务流量。

本轮不再仅停留在独立查询模块：AppModule 已接入 CallObservabilityModule，新增五个受控查询接口，调用者和持久桶投影在同一摄取/恢复事务中执行。真实模块验收贯通 JSONL、来源/桶投影、事件 HTTP、缓存统计、持久重算及 Outbox 扫描。采集、聚合、分发和后续新增的 Webhook 发送开关均默认关闭，部署环境尚未启用验证。

新增结果包括：

- TP-07 五类真实测试/探测/候选验证入口接入；健康通信显式按 telemetry 排除。
- B02 持久贡献、版本条件、脏桶、租约队列、回滚、重启及保留明细回填完成。
- B03 内部完整重算快照与可选后台运行完成；长期治理、覆盖账本和 HTTP 持久读取仍未完成。
- OBS-API-02/14/15/16/26 的当前受限契约已验证；总览至事件 afterSequence 绑定同一主体、资产与 origin。
- 缓存命中/未命中/未知三态贯穿归一化及统计；缺失 cacheHit 不再自动计作未命中。
- 持久事件 Outbox 创建投递任务并推进检查点；Webhook 签名、有限重试、租约、固定地址 HTTPS 传输与受控发送编排已有实现和隔离专项证据，尚未完成真实接收端、订阅 API 及部署交付。

## 2. 验证证据与状态口径

- Parser、Server、API 本轮构建通过；MCP 四脚本最终 53/53 PASS，真实安全/多会话烟测通过。53 项包含有界原生 SDK 对照，不代表所有背压恢复场景成功。
- Parser 审计五套件 103/103 PASS。
- API 29 脚本联合 507/507 PASS，0 fail/cancelled/skipped；日志：`tmp/observability-concurrent-final-regression.log`。
- TP-07 在上述联合之后仅新增健康通信排除测试，专项最终 22/22 PASS；其中新增四项不与联合重复计算。
- B02 16 项、B03 Service 9 项/Worker 4 项、事件 10 项、Outbox 9 项、分发集成 4 项、总览/依赖/状态 16 项、快照授权 6 项、pipeline 10 项均有专项证据；它们与联合回归存在重叠，不相加冒充新增总量。
- 隔离 SQL.js SQLite、测试临时目录与回环 HTTP 是本轮主要环境。两方言初始化结构同步、SQLite schema drift=0；没有新增真实 PostgreSQL/Linux/生产负载证明。
- DONE 表示任务包/子节点声明的开发验收范围完成；VERIFIED 表示当前明确契约已验证。AVAILABLE 仍需实际部署证据，本轮 AVAILABLE=0。

## 3. 当前任务包状态

DONE=8、IN_PROGRESS=3、READY=0、BACKLOG=5，共 8 个任务包尚未完成。下游提前完成的准备工作不取消硬依赖，不将模块注册当作整个集成任务包完成。

| 任务包 | 名称 | 状态 | 当前进展与未完成边界 |
| --- | --- | --- | --- |
| OBS-TP-01 | 共享字段与契约 | DONE | 既定范围已完成；本轮补缓存缺失证据标记并回归 |
| OBS-TP-02 | 实体、索引与事务基础 | DONE | 既定范围已完成；本轮同步持久桶队列的两方言初始化结构 |
| OBS-TP-03 | 管理权限、游标与并发基础 | DONE | 既定范围已完成；新接口继续复用当前管理主体和资源范围 |
| OBS-TP-04 | 共享采集器与受限正文 | DONE | 既定范围已完成；新增内部入口复用真实 HTTP 适配器 |
| OBS-TP-05 | Gateway 接入 | DONE | 外部入口保持原语义；候选验证通过进程内标记隔离 |
| OBS-TP-06 | MCP 接入 | IN_PROGRESS | EOF/断管修复及发送确认推进；AC-02 真实重试与完整传输/正文矩阵仍未全部闭环 |
| OBS-TP-07 | 测试、探测、验证与内部上游 | DONE | 五类入口、origin 隔离、真实数据库查询及健康通信排除已验证；不代表全平台部署 |
| OBS-TP-08 | 汇集、调用者与恢复 | DONE | 已接入调用者后置的持久桶事务投影，不改变恢复证据规则 |
| OBS-TP-09 | 调用/正文/trace/访客查询 | DONE | 既定查询与审计范围已完成；全局前置拒绝审计仍归集成任务 |
| OBS-TP-10 | 聚合、总览、依赖与状态 | IN_PROGRESS | B02 DONE；B03 内部重算和三查询完成，长期治理/读取、真实存活和桶事件未完成 |
| OBS-TP-11 | 持久事件、Outbox 与历史 | IN_PROGRESS | 历史/游标/范围绑定、事务 Outbox 与可选调度完成；全部事件类别及完整报送验收未闭环 |
| OBS-TP-12 | Webhook 与投递管理 | BACKLOG（已有准备增量） | 签名、重试、租约和受控发送链路已有专项证据；Worker、密钥适配、订阅事务内核已实现待验证；HTTP 管理、人工重投及真实联调未完成 |
| OBS-TP-13 | Socket.IO 统一事件 | BACKLOG | REST 调用快照补拉已准备；统一推送、慢消费及撤权断开仍未完成 |
| OBS-TP-14 | 配额、保留、策略与健康 | BACKLOG | pipeline/status 已完成准备节点；整体保留、配额和策略 API 未完成 |
| OBS-TP-15 | 全链路集成与旧能力收敛 | BACKLOG | 根模块、配置和隔离贯通已完成准备；全部查询报送、入口审计、切换与部署未完成 |
| OBS-TP-16 | 总体验收与交付 | BACKLOG | 真实 PostgreSQL/Linux、代表性容量性能与完整 AC 矩阵仍待完成 |

## 4. HTTP 与推送现状

当前 28 个 HTTP Endpoint 中，OBS-API-01~16、26 共 17 个 VERIFIED，11 个 PLANNED；所有接口 AVAILABLE=0。VERIFIED 仅覆盖下面写明的当前契约，不意味着原始需求全部实现。

| 本轮接口 | 当前契约 | 明确限制 |
| --- | --- | --- |
| GET /overview | 同事务调用统计、资产状态；调用快照签发 | 仅 from/to/origin/serverType/runtimeAssetId；pipeline/recentEvents 在 unavailableSections 中；旧状态无统一事件水位 |
| GET /dependencies | 实际上游分组、失败业务归因与去重 | 只统计可见保留记录；无证据的根关联显式未关联，不展示未观察的配置绑定 |
| GET /servers/status | 授权资产生命周期与旧持久状态证据 | 健康/存活/心跳未知，activeInvocations/stateVersion=null；不从旧状态推断当前健康 |
| GET /events | 持久序号扫描、稳定游标、过期恢复、可选 origin | 首次 afterSequence 必须有匹配的总览授权；签发仅覆盖调用事实，5 分钟/1000 条/进程内 |
| GET /pipeline/status | 持久扫描、桶队列与分发检查点证据 | 仅显式全局 read；未知指标为 null，不将检查点年龄等同 lag 或投递成功 |

仍未完成：

| Endpoint | 方法与路径 | 归属 |
| --- | --- | --- |
| OBS-API-17 | POST /subscriptions | TP-12 |
| OBS-API-18 | GET /subscriptions | TP-12 |
| OBS-API-19 | GET /subscriptions/:id | TP-12 |
| OBS-API-20 | PATCH /subscriptions/:id | TP-12 |
| OBS-API-21 | DELETE /subscriptions/:id | TP-12 |
| OBS-API-22 | POST /subscriptions/:id/test | TP-12 |
| OBS-API-23 | GET /deliveries | TP-12 |
| OBS-API-24 | GET /deliveries/:id | TP-12 |
| OBS-API-25 | POST /deliveries/:id/retry | TP-12 |
| OBS-API-27 | GET /policies | TP-14 |
| OBS-API-28 | PATCH /policies/:id | TP-14 |

完整 Webhook 与新版 Socket.IO 推送仍未交付。Webhook 已有可调用传输和编排内核，但隔离请求测试不代表真实接收端已收到；事件查询、Outbox 入队和后台扫描也不等于网络投递成功。

## 5. 持久聚合与计量边界

| 节点 | 状态 | 当前能力与剩余 |
| --- | --- | --- |
| TP10-B01 | DONE | 纯桶键与修正规划 |
| TP10-B02 | DONE（本节点开发/SQLite 专项） | 贡献与脏桶原子更新、CAS/回滚、租约、重启恢复、保留明细分批回填；真实 PG 并发仍待验证 |
| TP10-B03 | IN_PROGRESS | 内部重算、完成快照读取和后台启停已实现；物理清理、配额、覆盖账本及长期 HTTP 读取仍缺 |
| TP10-B04 | PLANNED | metrics.bucket_updated 事件及统一状态报送未完成 |

现有 summary/time-series/groups 仍使用 retained_invocation_snapshot、5000 条上限、bucketVersion=null。内部完成快照表示当前持久贡献计算完整，不表示采集历史完整；historyCompleteSince=null、isPartial=true 保持不变。默认 90 天桶过期不等于长期存储治理已完成。

缓存字段为 cacheEligibleRecords/cacheObservedRecords/cacheUnknownRecords/cacheHits/cacheMisses/cacheHitRate/cacheCoveragePartial。仅 gateway_request 参与，命中率 hits/(hits+misses)，无观测分母为 null；历史已持久化且失去缺失标记的 false 无法凭空恢复。真实存活依据仍未接入，未知在途不升级为 confirmed in-flight。

## 6. 剩余工作与正确归属

| 待办 | 状态 | 归属与完成条件 |
| --- | --- | --- |
| REM-01 持久事务投影 | 本节点完成 | B02；实际 PostgreSQL 并发另列环境验收 |
| REM-02 长期统计 | 部分完成 | B03/B04；覆盖/保留治理、长期 HTTP 读取、桶修订事件 |
| REM-03 事件历史与分发 | 核心完成，整包未关 | TP-11；继续统一事件类别和完整报送验收，不再错归 TP-07 |
| REM-04 Webhook 完整投递 | 部分完成 | TP-12；签名/目的地检查/传输/租约已有内核；继续订阅与投递 HTTP、Worker/密钥装配验证、人工重投和真实验收 |
| REM-05 实时订阅 | 未完成 | TP-13；同一持久事件源、撤权、慢消费、断线补拉与去重 |
| REM-06 统一状态 | 部分完成 | TP-10；三查询已有，真实心跳/存活、统一版本和状态事件仍缺 |
| REM-07 剩余统计 | 部分完成 | 缓存三态完成；真实存活统计与历史缺失证据仍需治理 |
| REM-08 保留、配额与策略 | 部分完成 | TP-14；pipeline 已完成，跨对象清理/配额与 policies API 未完成 |
| REM-09 身份与全链路审计 | 未完成 | 显式主体映射、服务身份及尚未实现管理/实时操作的权限审计 |
| REM-10 全入口矩阵 | 部分完成 | TP-07 收口；TP-06 完整传输/故障/正文矩阵仍需验收 |
| REM-11 平台、性能与容量 | 未完成 | 真实 PostgreSQL/Linux、代表性持续负载、大正文及恢复报告 |
| REM-12 集成与部署 | 部分完成 | 根应用与隔离贯通已完成；实际部署、完整旧能力收敛及全局前置拒绝审计未完成 |
| REM-13 大屏 UI | 延后 | 延后不取消后端状态/事件契约责任 |

## 7. 未取得证据的非功能目标

完成至可查 p95 <= 3 秒、首次 Webhook 尝试 p95 <= 5 秒、常用查询 p95 <= 2 秒、额外业务开销 p95 <= 10 ms，均不能由本轮小规模测试耗时推定通过。4 核/8 GiB/SSD、100 请求/秒及大正文/长流的代表性负载仍须独立测量。

## 8. 继续执行与文档入口

下一依赖重点为 B03 长期治理/覆盖与 TP-11 事件类别收口，再推进 TP-12 网络投递和 TP-13 实时通道。TP-06 真实传输矩阵、安全审计及平台验证仍并行推进。不得为完成计数删除未知状态、扩大角色权限或提前替换统计读取后端。

- [执行状态](./runtime-observability-development-execution-status.md)
- [主计划](./runtime-observability-development-task-plan.md)
- [Endpoint 契约](../reference/runtime-observability-api-endpoints.md)
- [应用接入与配置](./runtime-observability-integration.md)

## 9. 保留的 MCP 已知限制

Windows / Node v24.15.0、16 MiB Streamable 响应的原生 cork→uncork 恢复组合，在原生 SDK 与当前审计版本均可复现 3 秒未完成。该对照保留在 test-mcp-http-delivery.cjs；不能把对照断言通过等同恢复成功。等待期间没有伪成功，断开后为 error/incomplete。完整背压恢复、AC-02 与传输/正文矩阵仍归 TP-06，未据 53 项通过提前收口。

## 10. 后续增量复核与并发推进（2026-09-11）

本节记录后续开发轮次，不把第 2 节的历史联合回归扩大为最新工作区的验证。

- 已验证增量：修正最多六次总尝试后，API build 与 21 项专项通过；发送编排接入后，API build 与七个脚本 67/67 通过，包括租约 18、传输 20、编排 6、重试 8、Outbox 9、分发 4、装配 2。这些是重叠回归，不与 507 项相加。
- 已实现待验证：默认关闭的 Webhook Worker、withWebhook 动态装配、授权密钥后端适配及桥接、订阅完整替换输入和事务内核。67 项证据早于这些增量。
- 其他已实现准备：统一事务事件 writer 已供调用事件使用；B03 补充本次贡献选择证据，仍不声明连续历史覆盖。桶和状态事件生产者尚未接入。
- 本次并行工作：订阅安全查询与投递/尝试安全查询，使用互不重叠的服务文件；当前仅内部服务，不新增 HTTP VERIFIED 数量。

任务包计数仍为 DONE=8、IN_PROGRESS=3、READY=0、BACKLOG=5；17/28 HTTP VERIFIED、AVAILABLE=0。TP12 的 BACKLOG 表示整包硬依赖及验收尚未满足，不应再解读为没有代码。

下一执行重点分为三条：TP12 内核验证及管理 API；B03/B04 长期覆盖/治理和统一事件；TP06 完整矩阵与 TP16 平台验收。TP13 可以准备只消费持久事件的有界通道，但统一事件和状态水位未完成前不宣称快照到实时无缺口。TP14 不得在投递保留引用规则未确定时直接启用破坏性清理。

外部验收条件见 runtime-observability-external-validation-handoff.md。当前本地开发不需要真实秘密；真正联调前需隔离 HTTPS 接收端、授权 secretRef 后端及可清理的 PostgreSQL/Linux 环境。
本次查询增量实际落点：CallObservabilitySubscriptionsQueryService.detail 已实现 owner/范围授权和目的地 origin 安全视图；CallObservabilityDeliveriesQueryService.detail 已实现当前权限、投递 TTL、事件资产核对及白名单尝试查询，内部 afterAttemptNo/take 有界读取。两服务已注册模块，尚未构建或测试。列表查询、稳定公有游标、HTTP controller 均未实现，故本次仍不新增 VERIFIED 接口。尝试原始 responseSummary、lease token 和秘密字段不向查询调用者返回。
## 2026-09-14：类型修复与累计专项复验通过

经用户授权，订阅事务服务四处 JSON 写入使用 unknown 到对应 QueryDeepPartialEntity 字段的显式类型桥接，未改变运行时值或数据库结构。此前四处 TS2352 已在本次构建中消除。

API build PASS；九个脚本联合 105/105 PASS，0 fail/cancelled/skipped：租约 18、分发 4、Outbox 9、应用装配 2、订阅事务及详情 10、重试 8、Worker/密钥适配 28、发送编排 6、HTTPS 传输 20。该总数包含此前 67 与新增 38 的复验，不再重复累加为额外通过数量。部分专项使用源码 transpileOnly，本轮独立 API 构建同时通过。

这些证据覆盖 SQL.js/Store、隔离请求及限定模块装配。订阅专项审计为同事务 stub；未验证真实 PostgreSQL/Linux、真实审计全链路或外部 TLS 接收端。withWebhook 的真实部署依赖仍未配置，外部发送未启用。公开列表/管理 HTTP、人工重投及整体 TP12 仍未交付，HTTP VERIFIED 数量保持 17/28，AVAILABLE=0。

本节覆盖此前关于累计增量构建失败和上述专项尚未验证的状态，不删除历史失败记录。