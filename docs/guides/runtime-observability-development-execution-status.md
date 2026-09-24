---
doc-version: 2.27.0
doc-status: active
doc-updated: 2026-09-24
---
# 可观测性开发执行与验收状态

> Document status: Active evidence register
> 当前任务包计数、实现边界与未完成清单统一见[完成情况复核](./runtime-observability-completion-review.md)。本页登记最新有效证据，不再混排不同开发阶段的“当前状态”。

> 2026-09-15 调度重排：父包原退出条件不变；当前细分、跨计划归属和下一队列见[工作包划分](./active-work-package-breakdown.md)，逐项状态见[子任务执行台账](./active-work-package-execution-status.md)。父包 IN_PROGRESS 不表示正在同时执行；文档子项完成不计为代码完成。

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


## 16. 按验收子项重排

父包仍DONE10、IN_PROGRESS5、BACKLOG1。已实现页流、TTL/GC和恢复切片转维护；新的主交付为OBS-14-02过期元数据残留整理、OBS-10/13业务状态与快照、OBS-15旧消费者收敛。OBS-16-01本轮完成交接校准（文档2.2.0，AC/脚本入口静态核对）；这不是TP16代码或平台验收完成，不提升其父包BACKLOG。详见[子任务台账](./active-work-package-execution-status.md)。

## 17. 重排首批：OBS-14-02完成（2026-09-15）

删除成功而元数据事务回滚的残留已由collect内持久keyset分页恢复；单轮最多scanLimit，同GC fence，cursor与行修复同事务。仅TTL到期且受控文件确认缺失才更新expired/fileKey；有效对象、当前/历史调用引用不改。状态接口仅公开独立checked/reconciled/retained/hasMore，内部游标不公开，也不混入磁盘扫描容量证据。

API构建通过，五脚本联合67/67通过，包含7项恢复专项及SQL.js数据库连接重建恢复。子项OBS-14-02 DONE，OBS-TP-14父包保持IN_PROGRESS；事件/receipt清理、引用墓碑合同及配额仍按[新划分](./active-work-package-breakdown.md)独立推进。
## 18. 重拆第二批生命周期与配额基础（2026-09-16）

[生命周期、引用与墓碑合同](../reference/runtime-observability-lifecycle-contract.md)完成OBS-14-01文档出口；[容量计量、配额与降级合同](../reference/runtime-observability-capacity-quota-contract.md)完成OBS-14-04文档出口。合同约束后续实现，不代表任何物理清理或强制配额已开启。两个DOC出口不提升OBS-TP-14父包状态。

OBS-14-03E1新增持久非连续事件缺口记录，授权历史查询在命中已删除区间时返回410；SQLite/PostgreSQL初始化结构与实体同步。OBS-14-03E2A只提供默认关闭的只读保留候选预览，核对授权、TTL、租约和投递资格，不写入也不删除。事件历史/缺口/预览联合26/26通过。OBS-14-03E2B真正物理删除执行器未落地：自动审批要求明确授权永久删除行为；E3生命周期验证依赖E2B。任何dry-run候选都不能宣称空间已回收。

OBS-14-05A提供隔离的正文预算ledger与reservation原语，校验epoch、并发CAS、幂等预留/结算、高低水位、未知占用和回滚；配额/缺口/预览联合18/18通过。OBS-14-05B已把默认关闭的门禁接入可选正文prepare/publish，启用但账本不可用/额度不足时先于临时文件写入省略正文，专项11/11、旧六脚本81/81及API类型检查/构建通过。发布后外围元数据事务失败可能留下已计费孤儿对象。OBS-14-05C1已完成只读有界正文盘点和跨会话完整shard前缀复核，专项6/6、旧GC/容量27/27及API typecheck通过；结果始终要求writerFenceRequired=true且baselineReady=false，不改账本、schema或文件。05C2A已交付持久但未验证的完整shard前缀及owner/epoch/generation CAS，专项5/5、C1 6/6、quota 8/8和API typecheck通过；它不持跨批围栏、不确认baseline、不改ledger。05C2B跨批writer/GC围栏与原子baseline已解锁，05C2C未结算预留/孤儿占用恢复、05C3崩溃重启/多写者验收及05D全局状态/策略仍未完成。quotaEnforced仍为false，不将盘点证据或局部门禁说成完整配额已启用。所有结果均为本地SQL.js/合成夹具和代码测试，不是当前版本PostgreSQL/Linux、多进程容量或生产清理证据。任务状态以[统一子任务台账](./active-work-package-execution-status.md)为准。
本轮收口复验：C2A checkpoint 5/5、B2A真实loopback 27/27，最终API构建通过。隔离SQLite database-tool.cjs smoke通过，68张表、schemaDrift=0、persistence/apiStartup=true，使用随机测试密钥。这是当前本地空库与API启动证据；未运行PostgreSQL实库、历史业务库原地迁移或生产部署，也未关闭05C2B/C及父OBS14。
## 最新限定进展：恢复链故障验收（2026-09-21）

此前跨批围栏/原子baseline、持久发布意图及可证明结算原语已完成限定出口，见[9月17日审计](../audits/2026-09-17-interruption-recovery-evidence.md)；旧节保留当时进度。

OBS-14-05C2C3新增真实ingest/文件发布后的5条隔离故障链：延后结算后完整恢复；外部元数据事务回滚后保留已计费对象并重放修复；延后结算且缺receipt跨重启拒绝释放；真实final发布但temp清理失败保留峰值；显式temp故障注入阻断、仅测试夹具修复后安全结算。每次重启先export并关闭旧SQL.js连接，再以同文件根重建连接/服务；每次账本断言统计真实.body/.tmp路径字节，reserved+committed不得低于实物。无直接改写账本制造成功状态。

新专项5/5、相邻关联/文件证明/结算23/23、整合API构建通过。仅Windows本地SQL.js和临时目录证据，不是杀进程、PG/Linux、多写者或生产配额验收；quotaEnforced仍false。下一项05C3已就绪，05D继续等待。完整证据见[恢复故障验收](../audits/2026-09-21-payload-recovery-acceptance.md)。

OBS-TP-14父包保持IN_PROGRESS，父包数量不变；当前状态以[统一台账](./active-work-package-execution-status.md)为准。

## PostgreSQL真实多写者与中断窗口（2026-09-21）

新增Windows PostgreSQL16.10隔离多进程9项验收：四写者竞争预算不超卖、同operation仅收费一次、预留提交前/后杀进程、真实ingest写入中/最终发布后/temp删除后/元数据事务中四窗口中断，以及四个实际ingest进程共享数据库和文件根并发，PG重启后跨进程重放不重复计费。拒绝采集正文仍保留全部业务调用元数据；残留按峰值保守计费。父任务独立复跑9/9，全部新建集群已停止删除。

不连接默认目标：专用用户、随机IPv4回环端口、独立临时目录、fsync和synchronous_commit开启。Linux核查仅有docker-desktop WSL发行版，Docker Linux Engine管道不可用；C3本机出口完成但整包仍NEED_ENV，05D不解锁。PG自身异常崩溃/掉电、长期物理磁盘压力和生产根未验。命令和故障矩阵见[PG多写者证据](../audits/2026-09-21-pg-quota-multiwriter-evidence.md)。

## 22. OBS-10受管业务进程生命周期来源（2026-09-24）

OBS-10-01限定DONE：`ProcessManagerService`只为显式`managed=true`且具备`runtimeAssetId`的真实child创建不透明generation，将start/stop/unexpected exit/lost写入`runtime_pipeline_state`独立投影，并绑定runtimeAssetId、serverId、generation与pid。新generation启动可替换旧代；旧generation迟到终止、Windows stop/exit竞态及error后exit均以事务CAS/首个terminal幂等处理，不能覆盖当前代。servers/status单列`managedProcessLifecycle`，管理心跳仍只证明管理进程存储往返，不能代表业务进程实时存活。

SQL.js CAS/坏行/重开专项4/4、真实Windows child start→taskkill stop与exit 7、注入error→lost事件hook 3/3、状态投影1/1、ProcessManager相邻认证/进程回归5 suites/32 tests、API type-check与build均通过。没有新增schema/migration，复用`RuntimePipelineStateEntity`；没有生产部署或外部环境验收。OBS-10父包已按限定范围DONE；后续OBS-10-02A读模型证据见第23节。OBS-13-01后续已拆为A/B/C，B再拆为B1 reader与B2 WebSocket；A与B1已限定完成，B2现READY，详见第23节。
## 23. OBS-10-02A限定读模型完成与OBS-13依赖校准（2026-09-24）

OBS-10-02A限定DONE：复用`RuntimeInvocationEntity`当前行、managed lifecycle投影及`CallObservabilityStore`快照水位，完成5100条保留历史有界聚合、revision水位、资产隔离、legacy坏行与SQL.js重开，专项4 suites/15 tests通过。retained unfinished=0只表示保留事实中没有未完成项，不能解释为无业务流量；coverage保持unknown，live active保持null；状态只投影最新generation，不是全历史。本切片未修改Realtime/WebSocket，统一API build由并行工作包独立执行，不在此预记结果。

预研确认managed lifecycle最新行、legacy runtime state和asset目录没有共同调用事件水位，不能直接宣称跨状态snapshot或断线无丢失。OBS-10-02B1现限定DONE：managed start/terminal与最新generation投影在同一Store事务写入`server.state_changed`并分配sequence，4 suites/21 tests及API build通过；只证明同一DataSource内并发与耐久delta，不接Realtime，也不证明跨实例全局水位或实时liveness。OBS-10-02B2现限定DONE：仅对有runtimeAssetId的gateway_request/mcp_tool，在in-flight成员变化时与调用修订同一Store事务写入sequence-bound状态delta；5 suites/28 tests及API build通过。storage旧断言因新增合法delta首轮2项失败，精确更新后storage单跑32/32；events 16、invocations 38、restart 3首轮均通过，共89项分别验证，不称一次性脚本全绿。只改Store、Event reader、新spec与旧storage脚本，不接Realtime/grant/ACK/gap恢复。legacy状态、asset目录、全局多实例水位及实时liveness继续为unknown。OBS-10父包按限定范围DONE；OBS-13-01现拆为A/B/C。A限定DONE：独立server_state_v1 opaque grant绑定H、TTL、principal/fingerprint、授权asset/filter、current auth、isPartial/excluded，5 suites/31 tests及API build通过；兼容43项首轮42过，补旧EventGap夹具后overview 20/20，其余23项此前通过，不称一次性全绿。A不接Realtime或消费者，现有invocation_facts_only合同保持不变。原B再拆为B1/B2。B1限定DONE：新状态专用reader/spec与A authorizer小接口共3文件，复用A grant、签名cursor与同一事件表，每页读前后复核当前DB角色/资产范围，只接受managed_server_process_lifecycle和retained_business_in_flight，gap/expiry强制resnapshot；生命周期delta仅提供受限字段和refreshRequired。6 suites/39 tests、旧events/overview/bridge/Realtime脚本39/39及API build通过。组合首轮38/39源于SQL.js TypeORM bulk fixture ID回写交换；固定UUID复现后以updateEntity(false)和ID不可变断言修正夹具，最终39/39，生产reader未放宽。B1未注册module/controller/WS；B2现READY，后续用新事件名接WebSocket、整页ACK与重连，旧invocation_facts_only协议保持不变。C等待A/B1/B2后验收撤权、范围缩窄、TTL/重启、ACK前后重连与乱序版本。legacy状态、asset目录、全局多实例水位及live liveness继续unknown。