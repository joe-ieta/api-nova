---
doc-version: 2.10.0
doc-status: active
doc-updated: 2026-09-15
---
# 可观测性开发执行与验收状态

> Document status: Active evidence register
> 当前任务包计数、实现边界与未完成清单统一见[完成情况复核](./runtime-observability-completion-review.md)。本页登记最新有效证据，不再混排不同开发阶段的“当前状态”。

## 1. 当前快照

早期整合提交 `950e150` 以远端 `7a7fc44` 为主链；后续当前进展见第7节起的逐轮验证，不将该历史提交视为最新实现。TP11/TP12 的远端持久事件、Outbox、订阅/投递管理和签名发送闭环予以保留；没有第二套聚合、物化或发送消费者。

API01~28的限定契约已验证；API27/28覆盖新事件与新正文留存。TP13/15调用事实UI已接入有界Socket.IO页流；TP14投递30天留存、正文TTL及默认关闭的有界正文GC已验证，完整状态快照/治理仍未闭合。任务包范围、接口验证与部署交付是不同维度；目前没有部署可用性验收，不将 `VERIFIED` 写成 `AVAILABLE`。

## 2. 状态规则

| 状态 | 含义 |
| --- | --- |
| DONE | 已满足该任务包记录的范围与退出条件，不外推未覆盖的环境或其他任务包 |
| IN_PROGRESS | 已有实现与证据，但该任务包仍有未完成退出条件 |
| BACKLOG | 尚未完成该包的实施闭环；可能已有可复用的局部准备能力 |
| VERIFIED | 该接口的限定契约已有实际验收证据，不保证所有平台或部署 |
| AVAILABLE | 已完成相应部署交付验收；当前没有此类证据 |
| active | 文档仍受维护，与运行能力是否启用无关 |

## 3. 最近有效验收记录

下表是 2026-09-14 前次整合运行的结果；后续新增运行按第7节起各轮记录，不能与历史专项相加。

| 验收范围 | 最近结果 | 证据解释 |
| --- | --- | --- |
| Parser 构建 | PASS | 整合时运行，不代表全部运行环境验收 |
| Server 构建 | PASS | 整合时运行，不代表 MCP 完整矩阵完成 |
| API 构建 | PASS | 整合时运行，不代表部署成功 |
| Parser 审计专项 | 103/103 PASS | 与其他专项可能存在范围重叠 |
| MCP 四脚本 | 53/53 PASS | 含有界背压对照；不能把已知限制对照通过解释为恢复成功 |
| API 可观测性 + Gateway + 内部依赖联合 | 548/548 PASS | 0 fail、0 cancelled、0 skipped；SQL.js、隔离回环或注入网络等限定环境 |

API 联合日志位于工作区 `tmp/observability-remote-integration-final-2026-09-14.log`，本轮核对其最终汇总为 tests/pass 548、fail/cancelled/skipped 0。`tmp` 是本地证据位置，不承诺作为发布包或永久归档交付；正式交付应固化原始日志、运行版本与环境信息。

Parser/MCP 的结果沿用前次整合验收记录，本轮没有重新执行或重新统计。先前的本地 105、507 及远端节点专项属于不同历史口径，不与本次 548 相加。

## 4. 整合差异与已关闭问题

前次首轮 API 联合为 543/548，后续只修正五项旧测试问题后达到 548/548，没有为迎合断言改写远端生产内核。

| 历史问题 | 已完成处理 | 当前归类 |
| --- | --- | --- |
| 能力断言仍将 Webhook 写成未实现 | 历史整合时对齐远端 read-only 的 restricted；Socket.IO当时未实现，后续有界页流已在第7节起验证 | 已关闭，不列待办 |
| 三项重启计数混入桶/管线事件 | 分别检查调用事件和辅助事件 | 已关闭，不撤回新增事件 |
| 事件过期夹具依赖批量插入后被回填改写的数组 ID | 按持久 sequence 定位待过期事件，保留 410 及安全断言 | 已关闭；原版远端隔离运行也曾复现 |

远端 Store、采集 Worker、Outbox、订阅/投递管理、发送 Worker、实体与初始化结构在前次整合中保留。增量集中于根模块、四类查询、授权调用快照桥接、缓存证据和运行端发送/origin 边界。

## 5. 尚未完成的验收与外部依赖

| 领域 | 真实欠缺或限制 | 归属 |
| --- | --- | --- |
| MCP | 完整传输/正文/平台矩阵；Windows Node v24.15.0 下 16 MiB Streamable 原生 cork/uncork 3 秒未完成对照仍存在 | TP06/16 |
| 实时流 | 有界授权页流已有专项；完整状态快照、旧 UI 迁移、长期/跨平台矩阵未闭合 | TP13 |
| 状态/治理 | 真实存活、长期覆盖/保留/配额、完整策略、安全 GC 与恢复；新事件/正文策略、默认关闭正文GC和授权覆盖切片已验证 | TP10/14 |
| 投递留存剩余 | 新记录30天与14天事件重投资格已分离；历史记录策略、管理审计30天及完整安全 GC 尚待完成 | TP14；不重开 TP12 既定闭环 |
| 集成 | 完整服务身份、拒绝审计、旧消费者迁移和全链路部署切换；公共/api路径已在本轮收敛 | TP15 |
| 环境 | 当前整合版本的 PostgreSQL/Linux、多进程、持续负载/容量与性能矩阵 | TP16 |
| 对外发送/部署 | 真实受控 TLS 接收端与部署交付，自动发送默认关闭 | 外部环境与部署授权 |

历史 TP02 曾有 PostgreSQL 存储专项证据，不能写成“从未验证 PostgreSQL”；该证据也不能替代当前整合版本的 PostgreSQL 全链路、多进程和部署矩阵。详见[存储基础](../reference/runtime-observability-storage-foundation.md)。

外部操作要求见[外部验收交接](./runtime-observability-external-validation-handoff.md)。本轮未连接业务数据库、修改环境秘密、进行生产迁移、安全清理、真实外部投递或部署。

## 6. 文档与证据入口

- [当前完成情况与剩余工作](./runtime-observability-completion-review.md)
- [任务定义、依赖与退出条件](./runtime-observability-development-task-plan.md)
- [API 当前契约](../reference/runtime-observability-api-endpoints.md)
- [契约与源码映射](../reference/runtime-observability-contract-mapping.md)
- [运行集成配置](./runtime-observability-integration.md)
- [历史执行全文](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-development-execution-status.md)，仅供追溯，各节计数按当时基线解释
- [本次归档索引](../archive/summaries/runtime-observability-2026-09-14/README.md)，包含已被替代的合并前待办报告

更新规则：新增验证应注明版本、环境、范围和结果；旧失败闭环后应从当前待办移出，原始证据留在归档，不删除历史事实。

## 7. 2026-09-14 活跃任务并发整合验证

本轮在现有工作区之上完成 TP13 和 TP14 的可独立验证切片；状态更新为 DONE10、IN_PROGRESS4、BACKLOG2，TP11/12原完成边界不重开。

- TP13：新增 CallObservabilityRealtimeService，经 CallObservabilityModule/WebSocketModule 接入既有 MonitoringGateway。复用持久 EventsService、管理 JWT/实时角色、签名游标；每页读前后复验权限。固定页50、连续补拉扫描10000、ACK5秒、空闲轮询1秒、活跃订阅与在途读取合计最多100。新连接隔离旧快照/订阅/广播。
- TP14：Outbox 与订阅测试的新建投递记录均为30天；事件仍按14天及原到期语义控制发送/人工重投。DNS之后发送前复验事件有效性，重试截止不得越过事件到期。历史投递不自动回填，不启用清理。
- 能力接口新增 socketEventStream，按monitoring:read资产范围开放；完整 socketPush 仍为 not_implemented，policyManagement不变。HTTP仍26/28，AVAILABLE=0。
- 独立审查发现并修复退订后在途读者占位提前释放、错误响应泄漏旧scope动态恢复元数据；两项均有回归。完整状态快照、旧消费者迁移、policy API、整体配额/GC仍未闭合。

| 验证 | 命令/范围 | 本轮结果 | 日志 |
| --- | --- | --- | --- |
| API统一构建 | npm run build --workspace api-nova-api | PASS | tmp/active-tasks-api-build.log |
| 可观测性联合 | node --test；realtime、capabilities、events、outbox、deliveries、webhook-worker 六脚本 | 75/75 PASS，0 fail/cancelled/skipped | tmp/active-tasks-observability-tests.log |
| 实时子集 | 包含于上述75项 | 11/11；真实Socket.IO回环、SQL.js、JWT/撤权、恢复/ACK和隔离 | 同上，不单独累加 |
| 投递子集 | 包含于上述75项 | 33/33；30天创建、过期历史查询/重投拒绝、发送前过期及重试截止 | 同上，不单独累加 |

环境为 Windows 当前工作区、内存SQL.js、合成权限/凭据、回环或注入网络；没有操作业务数据库、生产配置或外部接收端。Gateway并行D2的161项另见安全台账。原始tmp日志仅为本地证据，正式发布需固化版本与环境。
## 8. 按规划继续：策略、状态覆盖与公共路径

本轮三个OBS切片：API27/28复用现有Policy实体，支持全局新事件eventDays、强If-Match、fresh权限交集与同事务审计；状态新增授权目录/业务事实/历史报告coverage；公开链接和应用路由共用API_GLOBAL_PREFIX，实际/api前缀通过真实模块HTTP及Swagger对照。TP15因路径收敛切片转为IN_PROGRESS；当前DONE10、IN_PROGRESS5、BACKLOG1，不新增整包DONE。

策略仅影响之后创建的invocation/projection/subscription.test事件；不改历史TTL或30天投递期限、不启动GC。坏策略拒绝使用。默认14天，允许1–365；capabilities同步持久策略并仅向全局read/manage交集开放PATCH。HTTP为28/28限定契约VERIFIED，AVAILABLE=0。Coverage不把无业务证据当空闲，不把旧状态时间当心跳。

| 验证 | 本轮结果 | 日志 |
| --- | --- | --- |
| API整合构建 | PASS | tmp/planned-next-api-build-final.log |
| OBS首轮十二脚本联合 | 188/191，3个旧接口数量/前缀断言失败，原证据保留 | tmp/planned-next-observability-tests.log |
| OBS修正后同一联合 | 191/191，0 fail/cancelled/skipped | tmp/planned-next-observability-final.log |
| 策略子集 | 6/6，SQL.js/真实HTTP、并发ETag、审计回滚、新事件生效及历史不变；包含于191 | 同上 |
| 状态覆盖子集 | 20/20，SQL.js/HTTP/Swagger、授权、窗口/TTL/MVCC、目录缺口；包含于191 | 同上 |

联合命令为 node --test packages/api-nova-api/scripts/test-call-observability-{policies,overview,capabilities,events,invocations,integration,realtime,deliveries,outbox,webhook-worker,statistics,series-groups}.cjs（花括号表示脚本集合，PowerShell执行时逐个列出）。生产代码未为旧计数调整行为；权限、数据范围和Swagger断言均保留。

当前仍欠完整策略/配额/安全GC、真实心跳、旧UI迁移、MCP矩阵和当前版本PostgreSQL/Linux/多进程/性能及部署证据。无新表/初始化变化，无业务库迁移或生产清理；本地SQL.js和回环不能替代外部验收。

## 9. 正文保留与调用事实UI并发推进

TP14新增payloadDays及实际正文TTL消费、保留旧到期的提交时复核；默认关闭有界正文GC已接入模块，pipeline/status显示最后持久报告及失败恢复证据。TP13/15调用事实UI已接入授权快照/隔离页流、ACK和身份清理，剩余全局状态快照与其余消费者仍未闭合。清理范围仅正文对象，不扩大为完整生命周期治理。

后端构建PASS，15脚本244/244；UI协议及真实Pinia接线10/10、类型检查PASS。独立审查未发现阻断问题。日志、环境边界与完整依赖见[本轮审查](../audits/2026-09-14-retention-consumer-wave.md)。当前OBS仍DONE10、IN_PROGRESS5、BACKLOG1；无新增整包DONE，AVAILABLE=0。

## 10. 管理心跳与Gateway消费者继续并发推进

TP10管理进程周期心跳已接模块、servers/status、overview.serverStates和pipeline/status；仅全局授权读取单owner证据，不改变业务健康。TP15 Gateway日志UI已改统一invocations、签名下一页、最近一小时及支持的元数据过滤；旧后端暂保留。任务包仍DONE10、IN_PROGRESS5、BACKLOG1。

API构建PASS；OBS十六脚本254/254（包含心跳9及pipeline15，不重复相加），UI联合16/16、类型检查与生产构建PASS。测试命令、日志、独立审查和剩余依赖见[本轮记录](../audits/2026-09-14-heartbeat-header-consumer-wave.md)。无真实环境启用或部署；AVAILABLE=0。

## 11. Gateway路由观测与保留策略UI

新增默认关闭GatewayRoutingObservationWorker，复用真实生效注册表、Store事务和资产授权；仅证明本实例路由注册情况，不提升业务健康。Dashboard保留策略管理已接GET/PATCH、全局capabilities、强If-Match及原因；冲突重读不重放、账号/卸载清理和异步代次保护已验证。

四包构建PASS；OBS十六脚本+路由专项265/265，Gateway17套176/176，UI26/26。完整命令/日志及安全并发映射结果见[本轮记录](../audits/2026-09-14-routing-policy-mapping-wave.md)。OBS计数仍DONE10、IN_PROGRESS5、BACKLOG1；业务存活、完整治理与整体交付不因局部通过而完成。

## 12. 容量样本与只读诊断UI

正文容量复用现有GC lstat扫描；pipeline.retention.scanUsage区分扫描覆盖、样本长度与未知当前总量，独立时间判定新鲜度，未完成尝试不复用旧样本。Dashboard只读诊断已消费管理心跳、授权路由、留存报告和容量样本，分来源失败/超时与身份切换保持隔离。

OBS联合273/273，UI33/33；Parser/API/Server/UI四包构建通过。验证详情、审查及剩余任务见[本轮记录](../audits/2026-09-14-single-hop-capacity-diagnostics-wave.md)。OBS仍DONE10、IN_PROGRESS5、BACKLOG1，配额强制/完整生命周期及业务存活未闭合，无实际清理启用或部署。
## 13. 正文扫描与诊断读取故障恢复

scanGarbage失败后清除目录句柄，下次重开失败分片，避免永久复用失效Dir或跳过已读取但测量失败的对象；关闭句柄再次失败不覆盖原错误，失败批次不返回成功容量证据。先复现新增2例失败，修复后容量9/9与retention10/10通过；最终最新构建下payloads/capacity/retention/pipeline联合58/58。

诊断UI对畸形capabilities显示来源错误且可重读恢复，允许合法not_implemented/null；pipeline读取只依赖capabilities，与servers/status并行，慢服务器来源不再耗尽管线启动时间。登出迟到响应保持隔离，UI联合36/36、类型检查通过。API整包构建通过，证据见[本轮记录](../audits/2026-09-15-ownership-recovery-wave.md)。OBS统计仍DONE10、IN_PROGRESS5、BACKLOG1；没有启用真实GC或完成配额治理。
## 14. 扫描停机与策略读取取消

新增停机门闩，onModuleDestroy等待当前扫描（含尚未返回的opendir）再关闭Dir，销毁中/后拒绝新扫描，重复销毁共用等待。新增用例先复现销毁提前完成问题，修复后容量10/10与retention10/10；最终正文/容量/保留/pipeline联合59/59通过。

策略UI的Promise.all一路GET失败时，现在finally取消同轮剩余GET，避免清除超时后遗留挂起请求；412自动重读同样覆盖，不自动重放PATCH。策略专项11/11，UI联合37/37与类型检查通过，API构建通过。见[本轮记录](../audits/2026-09-15-publication-shutdown-wave.md)。OBS整包统计不变，未开启真实GC或完成配额治理。
## 15. GC候选失败立即重试与总览对齐

GC collect在扫描成功后可能因unlink/候选事务失败而留下已消费Dir游标。现异常时在释放GC租约前清除游标，保留原异常；下一次有界扫描重新处理磁盘上仍存在的失败候选。新增删除失败测试先复现，修复后容量11/11+retention10/10；最新构建下正文/容量/留存/pipeline联合60/60。API构建通过。

unlink成功但数据库回滚后的过期元数据残留尚未实现独立整理；读取仍由expiresAt返回expired，不能将该残留称为正文复活。完成审查与任务计划已清理Socket.IO、策略/GC仍被笼统列待实现的陈旧描述，保留整包退出条件和所有统计。见[本轮记录](../audits/2026-09-15-activation-gc-wave.md)。
