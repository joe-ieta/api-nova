---
doc-version: 1.21.0
doc-status: active
doc-updated: 2026-09-09
---
# 可观测性共享契约与接入映射

> Document status: OBS-TP-01 completed contract and source mapping
> 用户已确认全新开发版本策略；只支持当前 v2 源记录，不导入旧格式或建立历史迁移链。

## 冻结的契约

- 源记录 schemaVersion=2，对外 API schemaVersion=1.0；未知源 schema 拒绝。
- gateway_request/mcp_protocol/mcp_tool/upstream_api 分开计数。
- started/progress/finished 使用相同 invocationId，不同 eventId 和递增 recordVersion。
- 进程 sourceSequence 是源内顺序；对外 sequence 只能由管理数据库提交分配。
- API Key/JWT 主体必须经过认证；来源 IP 不等同于身份。
- HTTP body、MCP 序列化 Payload 按 byteMeasurement/measurementStage 分组，不混加。
- 缓存命中不生成上游调用；重定向的请求次数与重试轮次分别统计。
- 没有观察到正文返回 null/原因，不用空正文或 0 代替。
- 缺少父节点保持未关联；迟到终态提升版本并更新同一调用。
- 新查询路径为 /api/v1/monitoring/observability，来自全局 api + v1 控制器前缀。
- Socket.IO namespace=/monitoring，现有服务未自定义 Engine.IO path；新契约使用 /socket.io 和 auth.token。
- 现有 PermissionsGuard 为 ANY-OF；新正文/来源等权限必须使用明确 AND 检查。

## 当前源码边界与后续负责人

| 源路径 | 当前事实/后续改造 | 任务包 |
| --- | --- | --- |
| parser/src/audit/runtime-call-audit.ts | v2 阶段、正文预算/队列与失败计数；标量字符串保真和嵌套脱敏已重新验收 | 04 DONE |
| parser/src/audit/runtime-upstream-attempt.ts | 单次物理请求、实际字节与结束观察、父子上下文、编码正文省略及业务故障隔离 | 04 DONE |
| parser/src/audit/runtime-http-agent.ts、transformer/index.ts | 实例级 Agent 逐跳观察，保留原 Axios 跳转/解压及异常；17 项物理上游专项通过 | 06 IN_PROGRESS |
| parser/src/audit/runtime-observability-contract.ts | v2 校验、规范化、scope/去重参考计数；已实现 | 01 |
| gateway-runtime/services/gateway-runtime.service.ts | 入口节点、内部请求 ID、缓存与拒绝、独立上游 operation/attempt 已接入 | 05 DONE |
| gateway-runtime/services/gateway-proxy-engine.service.ts | 使用共享单次适配器，独立观察上游结束与客户端发送；21 项 HTTP 专项通过 | 05 DONE |
| gateway-runtime/services/gateway-access-log.service.ts | 已移除 fallback 规范事实；旧 DB 写入/查询保留到全链路收敛 | 05 DONE、15 |
| api-nova-server/src/transportUtils/audit.ts | 协议/Tool 父子关系与 send Promise 终态；15 项模拟和真实 Streamable/SSE 已验证，真实 STDIO 待验收 | 06 IN_PROGRESS |
| api-nova-server/src/tools/mcp-http-audit.ts、httpServer.ts | HTTP 正文/计量、认证前拒绝、协议错误、取消与不完整正文；15 项实际 HTTP 专项通过 | 06 IN_PROGRESS |
| api-nova-server/src/tools/runtime-security.ts | 逐请求主体和工具权限；拒绝不能虚构成功身份 | 06 |
| security/guards/permissions.guard.ts | 旧 ANY-OF 不用于新观测接口；专用 call-observability-access.guard.ts 已完成 AND/资源范围及真实 JWT 验证 | 03 DONE |
| database/database-options.ts | 新存储实体与两方言初始基线已完成隔离初始化/零漂移验证；未操作业务库 | 02 DONE |
| websocket/websocket.gateway.ts | 现有 namespace 和实时广播；新敏感订阅必须鉴权并接持久事件 | 13 |

路径均指 packages 下对应包的 src；实际绝对工作区为 E:/CodexDev/api-nova。

## 验证证据

2026-09-08：npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts，1 suite、23 tests 全部通过。覆盖工具/上游分层、缓存、工具错误、失败身份、正文缺失、迟到终态、非业务 origin、STDIO、重试/重定向、未知父节点、混合计量和非法 schema 拒绝。

2026-09-08：npm.cmd run type-check --workspace api-nova-parser，通过。

本包只是共享契约验证，不将未完成的采集器、数据库、API 或推送标为已实现。

## 后续基础代码证据

共享采集器新增阶段测试；此前运行 runtime-observability-contract.test.ts、runtime-call-phases.test.ts、runtime-security-audit.test.ts，3 suites / 44 tests PASS；parser build PASS。这些结果不替代 Gateway/MCP 接入或存储端到端验收。

存储基础于 2026-09-08 写入，详见[存储基础实现说明](./runtime-observability-storage-foundation.md)。本轮仅写入源码/初始化文件，没有运行新的测试、构建或数据库验证。

## TP-04 收口记录

2026-09-08：runtime-upstream-attempt.test.ts 新增 16 项单次上游请求与故障用例，四组 parser 测试合计 60 项 PASS；parser 和 API 构建均 PASS。TP-04 达到共享采集器退出条件，实际 Gateway/MCP/测试探测接入未完成。适配器通过 index.ts 导出，不自行实现业务重试或读取响应流。

Gateway 已切换为不同 spanKind 的显式父子事实：gateway-request-audit.ts 观察入口现有读写，不消费或重放请求；代理使用共享适配器；auditRecorded 互斥与旧 fallback 规范记录已移除。2026-09-09：TP-03 夹具修复后 56 项专项与 48 项存储/GC 回归共 104/104 PASS，API build PASS；权限/API 公共基础已验收，生产控制器仍未接入。

2026-09-09：Gateway 21 项新增 HTTP 专项和 104 项基础回归共 125/125 PASS，API build PASS，TP-05 按包级退出条件收口。实际 Nest 控制器/独立监听器矩阵、可信代理逐跳解析和旧 DB 日志收敛仍留在 TP-15，不能声称全链路完成。TP-06 进入接入分析，MCP 代码尚未切换。

2026-09-09 TP-06 首批：server/src/transportUtils/audit.ts 已按 send Promise 结束记录 Tool/独立协议终态；server/src/tools/httpServer.ts 传递 HTTP 协议父节点。15 项模拟专项与 140 项联合回归、Server/API 构建通过，真实 SDK 联调待执行；MCP 整包仍 IN_PROGRESS。

## TP-06 HTTP 与物理上游批次验收

2026-09-09：公共脱敏标量保真、跳转终态、压缩响应原始编码观察和 Axios 超时分类修复完成。parser 五组 86 项与 Node 六脚本 155 项全部通过，parser/Server/API 构建及真实 Streamable/SSE 烟测通过。原失败证据保存在执行台账第 18 节，修复与重新验收见第 19 节；TP-04 恢复 DONE，TP-06 整包仍 IN_PROGRESS。

来源适配现在区分 mcp_protocol/mcp_tool/upstream_api，HTTP 与上游分别观察原字节，SSE 原始帧与编码正文只记录省略元数据。入站协议与 Tool/逐跳上游父子关系已有当前版本验证，不把原来逻辑补写方式继续当作单次物理请求。实际 STDIO、内部来源、自动汇集与查询/推送接入仍待后续包，旧格式不导入。

## 真实 STDIO 首轮接入证据（历史快照）

2026-09-09：新增 server/scripts/test-mcp-stdio-observability.cjs，通过公开服务器创建/STDIO 启动函数在实际子进程管道验证生产代码。7 项通过，慢读用例因 Windows 同步 stdout 与夹具 IPC 快照互相等待而失败，尚未修正。Server build PASS，联合回归 162/163 PASS；不能用已有模拟传输通过记录替代该失败场景。

脚本通过独立 IPC 控制夹具快照与主动关闭，不是生产状态推送接口。stdin EOF、stdout 错误/断管及完整平台矩阵仍待 TP-06/16 验收；TP-06 保持 IN_PROGRESS。

## STDIO 慢读修复后的有效证据

2026-09-09：在父进程暂停读取期间直接观察持久日志，恢复读取后再要求子进程 flush/health 快照，已修正 Windows 同步 stdout 导致的夹具等待错误。真实 STDIO 8/8、联合回归 163/163 与真实 Streamable/SSE 烟测通过，原不得提前成功和最终唯一终态断言均保留。

生产传输代码未改，本轮未重复构建；发送前 flush 是测试基线，不是新增生产能力。stdin EOF、stdout 错误/断管和完整平台矩阵仍待验收，TP-06 仍 IN_PROGRESS。

## TP-08 单文件采集映射（2026-09-09）

packages/api-nova-api/src/modules/call-observability/call-observability.collector.ts 消费 calls-v2 专用 JSONL，经唯一 CallObservabilityStore.ingest/rejectRecord 事务写入；调用/事件、检查点和尾边界指纹同事务。旧日志与 callers 文件不导入。测试脚本 test-call-observability-collector.cjs 新增 14 项通过；连同存储/GC/权限基础 118 项及 API 构建通过。目录调度、身份归并和公开 API 未在此节点宣告完成。

TP-08 第二节点：call-observability-callers.projector.ts 通过唯一 ingest/reconcile 的 ProjectionHook 写入身份/来源关联；call-observability.worker.ts 只做受控目录发现、周期调度和恢复，不重试业务请求、不删除源文件。新增 test-call-observability-worker.cjs 15 项通过，API build 与联合 133 项通过；实际业务应用尚未启用此模块。

TP-08 持久进程节点：test-call-observability-restart.cjs 新增 3 项独立 Node/持久 SQL.js 重开验证；与现有五脚本联合 136 项全部通过。检查点、数据集边界和正文引用跨进程保留；已保存证据后强制终止采集进程不会把重放计作新调用。生产者退出/关闭残片和正式应用启用不在这 3 项证据范围内。

TP-08 已收口：parser/audit/runtime-audit-source.ts 发布真实写入进程标识；API call-observability-source-lifecycle.service.ts 观察并持久化退出证明/文件最终状态；collector/store/worker 接入来源绑定、关闭残片与立即 unknown。新增 test-call-observability-source-lifecycle.cjs 13 项全部通过，跨模块 208 项、parser 86 项及三包构建/真实烟测通过。根应用启用和公开查询/推送仍按后续任务执行。

## TP-09 调用查询映射（2026-09-09）

call-observability-invocations.controller.ts 注册 obsListInvocations / obsGetInvocation；invocations.service.ts 使用 Store.readSnapshot 和修订可见区间，invocations.dto.ts 是程序生成 Swagger 的唯一响应结构来源。查询参数映射固定标量列或两个固定 JSON 文本提取表达式，所有输入值参数化；source/IP 权限按资产交集裁剪，不透传底层 record。

test-call-observability-invocations.cjs 新增 22 项真实 Nest 管理 HTTP/Swagger 用例，API 构建和联合 230/230 通过。初次过期夹具错误获用户批准修正，保留生产 OUTSIDE_METADATA_RETENTION 策略。两接口为 VERIFIED，根模块未启用；正文读取/审计、trace、callers/sources 仍属 TP-09 后续。publicationSnapshot 尚未采集，返回 null/缺失标记；TP-10 覆盖指标未提供前不宣称查询健康完整。PostgreSQL 查询和 Linux 留待矩阵验证。

## TP-09 正文与管理审计映射（2026-09-09）

call-observability-payloads.controller/service/dto.ts 实现 OBS-API-05；共享 API 异常增加严格 PAYLOAD_EXPIRED 状态/时间详情，元数据 readLink 指向受控路由。AuditService.log 可接受事务 EntityManager，复用既有 audit_logs 写入而非新增业务事件或自造审计表；已有非事务调用方式保持有效。日志只保存安全访问元数据，不复制内容或文件引用。

新增 test-call-observability-payloads.cjs 19 项真实 HTTP/JWT、私有文件、实际 User/AuditLog 外键和 Swagger 用例，API build/联合 249 项通过。OBS-API-03/04/05 VERIFIED，TP-09 整包未完成。既有 audit.findLogs 的 timestamp 时间列与 createdAt 实体不一致，下一节点修正并补检索回归；入口守卫前拒绝统一留痕、全局 HTTP 内存和应用启用仍在 TP-15。

## TP-09 管理审计检索对齐（2026-09-09）

security/services/audit.service.ts 的 findLogs 将日期绑定到 createdAt 并以 createdAt/id 降序查询，action/details 使用固定文本转换与参数化搜索；不修改清理方法或审计权限。test-call-observability-payloads.cjs 追加四项真实留痕列表/日期/关键词/并列分页回归，现 23 项，API build 与联合 253/253 通过。第 27 节提出的通用检索服务问题已解决，完整旧管理 HTTP/实际 PostgreSQL/治理仍是后续边界。

## TP-09 trace 查询映射（2026-09-09）

现有 call-observability-invocations.controller/service/dto.ts 增加 OBS-API-06 / obsGetTrace 和显式图 DTO，复用 readSnapshot、修订可见区间、资产与正文元数据呈现。只接受 origin，查询保留期内当前版本；200 节点上限在权限过滤后执行，超限 413，无默认时间截断。缺失/跨范围引用与 parent_cycle 只在可见节点报告，返回图闭合且不改存储。

test-call-observability-invocations.cjs 新增 16 项 trace 用例，总 38 项；API 构建和联合 269/269 PASS。OBS-API-03~06 VERIFIED，07~10 尚待实施，根应用未启用；实际 PostgreSQL trace、Linux 与性能未验收。

## TP-09 调用者/来源查询映射与待验收项（2026-09-09）

新增 call-observability-visitors.service/controller/dto.ts，映射 obsListCallers、obsGetCaller、obsListSources；观测模块注册该服务/控制器，公共 query 仅增加 authState 枚举。使用现有 revision + caller/source 注册表，不新建表，不以全局 first/lastSeen 或观察计数替代资产/窗口内数据。

调用者需可信认证，凭证引用来自可见调用；来源按实体资产匹配并逐项裁剪 IP，原始 IP 不可过滤。固定调用快照分页、5000 候选上限与按边界/计量阶段分组的 summary 已编码。test-call-observability-visitors.cjs 新增 24 项，初次 23 PASS/1 FAIL；失败为匿名夹具 identitySource=unknown，待许可修正。API 构建及既有 269 项通过，三接口仅 IMPLEMENTED，合计 293 项联合尚未执行。

### 访客查询验收更新

匿名夹具获用户批准修正后，新脚本 24/24、14 脚本联合 293/293 通过，OBS-API-07/08/10 VERIFIED；生产查询与身份源码不变。保留前述初始失败证据。下一映射为 OBS-API-09 档案标签修改、If-Match 与 AuditService 同事务管理审计。

## TP-09 档案标签实现与待修正边界（2026-09-09）

新增 call-observability-caller-profile.ts 负责完整登记资产范围和档案令牌；caller-labels.service/controller.ts 负责 OBS-API-09、严格字段、事务内新鲜权限、If-Match 与 AuditService 留痕。visitors 的详情增加可选 profileEtag；callers.projector 只维护观察时间、不再因流量推进档案编辑 version。既有实体、迁移和业务库不变。

test-call-observability-caller-labels.cjs 的 22 项与联合 315 项、API build 均通过，但额外 Express 条件请求实验发现档案令牌误用为完整详情 ETag，可导致错误 304。08/09 暂 IMPLEMENTED，修正和真实路由边界回归待用户许可；不是已部署回归，也未把问题修复计入成功数字。版本/字段审计不存自由文本历史。

## 档案 ETag 修正与 TP-09 收口

visitors.controller 与 caller-labels.controller 均改为 X-Profile-ETag，JSON profileEtag 和服务内 If-Match 不变；不替换完整响应的 HTTP ETag。标签脚本新增 5 项 Node 原生 HTTP 条件请求，共 27 项；API 构建及联合 320 项通过。03~10 八接口 VERIFIED，TP-09 包级 DONE；实时、治理、平台和应用启用不在此完成声明中。

## TP-10 能力查询映射（2026-09-09）

call-observability-capabilities.service/controller/dto.ts 对应 OBS-API-01/obsGetCapabilities，注册于 opt-in CallObservabilityModule。复用现有管理 JWT/AND 资源权限、严格 query 解析、只读快照与安全信封；query 白名单直接关联已实现调用/访客常量，14 项专项逐一核对九条当前实际 Swagger 路由及 DTO。

接口按实现与当前范围资格分 enabled/restricted/not_implemented，不公布资产 ID/隐藏数量；payload/source/manage 均与基础 read 求交集。未交付聚合/事件/推送明确关闭，有效采集配置、历史完整起点和健康不从默认保留或父进程环境推断。正文的 128 MiB 是单存储对象读取限制，不是总 HTTP 内存预算。

首次构建 TS2739 的同步回调问题获批补 async 后，API 构建、14/14 专项与 334/334 联合通过。01、03~10 九接口 VERIFIED，TP-10 IN_PROGRESS，后续统计/状态及 TP-11 事件/Outbox 按计划推进；根应用未启用，不扩大平台或部署声明。

## TP-10 统计内核映射（2026-09-09）

call-observability-metrics.ts 提供 calculateObservabilityMetrics、MAX_METRIC_OBSERVATIONS 与固定耗时桶边界，复用 parser 的 invocationMatchesScope 和 API 严格 query 解析；只处理调用方已授权/保留/快照可见的观察，不承担仓储或公开路由权限。尚无新 Controller/模块注册，statistics 能力保持未实现。

test-call-observability-metrics.cjs 共 24 项。初次三项把 reconciled 数据库投影误当源记录校验，获批仅修正夹具后 24/24 与 358/358 联合通过，内核加入后的 API 构建通过。生产源完成时间校验、Store 推断终态及计算源码未随夹具修正改动。下一映射为 OBS-API-11 数据库汇总服务、DTO/Controller 与能力清单。

## TP-10 统计汇总路由映射（2026-09-09）

call-observability-statistics.service/controller/dto.ts 对应 OBS-API-11/obsGetStatisticsSummary，注册于 opt-in 模块。资产/TTL/修订快照、时间和 scope 过滤先于 5000 项预算；JSON 字段名固定，值参数绑定。source 同资产左关联只选 ID/ipSource，不返回标识、IP 或正文。

capabilities 同步 STATISTICS_SCOPES/STATISTICS_SUMMARY_QUERY_KEYS 和 maxStatisticsQueryInvocations；statistics 仅代表 summary，statisticsTimeSeries/Groups 仍关闭。34 项专项、378 项联合和 API 构建通过；初次来源测试忽略 serverType，获批仅改断言/注释，生产身份未变。

十条 HTTP VERIFIED、十八条 PLANNED。后续为时间序列/分组、持久桶与事件/状态；保留明细汇总不等于长期历史、进程存活或部署。

## 时间序列及分组契约映射补充（2026-09-09）

| 契约 | 当前代码映射 | 验收边界 |
| --- | --- | --- |
| OBS-API-12 / obsGetStatisticsTimeSeries | statistics controller.timeSeries -> service.timeSeries -> 共享只读快照 -> makeTimeSeries -> 指标内核 | UTC 对齐、边缘裁剪、4 种间隔、1440 桶、fill=none/zero；按需桶版本 null，不是持久桶事件 |
| OBS-API-13 / obsGetStatisticsGroups | statistics controller.groups -> service.groups -> 共享只读快照 -> makeGroups -> 指标内核 | 7 个白名单维度、最多两维、28 组合；闭集降序排行、top<=100、完整总计 |
| 能力声明 | statisticsTimeSeries/statisticsGroups、两个真实查询白名单、maxBuckets/maxGroupLimit/supportedGroupByCombinations | 空 read 范围不扩大为全局；实现声明不代表部署或联合验收完成 |
| 覆盖与健康 | summary/series/groups 共用 coverage 和 livenessEvaluated=false | 不读取心跳，不把未知覆盖、合成空桶或零计数报告为健康 |

API 构建及新增 26 项、汇总 20 项通过；能力回归 4 项测试断言更新错误待修正，故 12/13 验收状态仍为 PLANNED。本节优先限定当前按需实现，不覆盖后续持久化 bucketVersion、修订事件和长期趋势的原设计要求。

## 时间序列及分组验收更新（2026-09-11）

OBS-API-12/13 已 VERIFIED：专项 60/60、联合 404/404 PASS。此前 2026-09-09 的待验收记录为历史初轮状态。当前 12 个 HTTP Endpoint VERIFIED、16 个 PLANNED；两类推送与业务启用状态不变。桶版本仍为 null，按需查询不映射为已实现的持久聚合或桶事件。
