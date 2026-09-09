---
doc-version: 1.16.0
doc-status: active
doc-updated: 2026-09-09
approval-status: approved
implementation-status: in-progress
---
# 可观测性开发执行与任务包完成状态

> Document status: Active execution ledger
> 当前阶段：OBS-TP-01/02/03/04/05 完成；TP-06、TP-08 进行中。17e9733、ac56c0b 已推送；持久 SQL.js/独立采集进程重启新增 3 项及联合回归 136 项通过，见第 24 节。
> 关联：[任务计划](./runtime-observability-development-task-plan.md)、[对外 API](../reference/runtime-observability-api-endpoints.md)、[需求](./runtime-observability-requirements.md)、[设计](../reference/runtime-observability-design.md)。

## 1. 当前快照

| 项目 | 状态 |
| --- | --- |
| 需求、设计、建议默认值和开发计划 | 已由用户明确同意 |
| OBS-GATE-01 | PASSED；用户要求按计划持续推进 |
| 全新版本决策 | 统一当前格式、接口和数据库初始结构，不增加历史兼容层 |
| 实现任务总数 | 16 |
| DONE | 5 |
| IN_PROGRESS / REVIEW / BLOCKED | 2 / 0 / 0 |
| READY / BACKLOG | 1 / 8 |
| 代码验收完成率 | 5/16；TP-04 重新验收，不代表 MCP 整包或全链路完成 |
| 新 HTTP Endpoint | 28 个，全部 PLANNED |
| 新推送契约 | 2 类，全部 PLANNED |
| 本轮数据库实际操作 | 隔离 SQL.js 内存库、独有临时目录及本机随机端口；未连接或清理业务数据库 |
| 本轮新增验证 | 持久进程重启 3 项 + worker/调用者 15 项 + 采集 14 项 + 存储/GC 48 项 + 权限基础 56 项 = 136/136 PASS；前节点 API build PASS，本节点仅加测试/文档未重复构建 |

文档已确认与基础包完成都不代表功能已上线。TP-02 的存储、GC 与 PostgreSQL 多进程针对性验证已完成；Linux 矩阵、全系统 SQL.js 并发集成和新接口端到端验收仍未完成。

## 2. 状态规则

| 状态 | 含义 |
| --- | --- |
| BACKLOG | 尚未满足硬依赖 |
| READY | 门禁和硬依赖通过，可以实施 |
| IN_PROGRESS | 代码或本包退出条件仍在推进 |
| BLOCKED | 存在明确外部障碍，记录原因、影响与解除条件 |
| REVIEW | 实现及适用验证完成，等待验收收口 |
| DONE | 全部退出条件通过，具备可定位证据 |
| DEFERRED | 有明确范围决策支持延期 |

硬依赖未完成时可以做接入准备，不将下游标为 READY 或 DONE。代码存在、测试未运行或测试失败都不满足 DONE。

## 3. 文档与门禁

| 编号 | 交付/决策 | 状态 | 证据 |
| --- | --- | --- | --- |
| OBS-DOC-01 | 需求/设计及建议默认值 | DONE | 用户明确同意 |
| OBS-DOC-02 | API 文档、任务包计划、依赖图、状态台账 | DONE | 文档产物与用户后续确认 |
| OBS-GATE-01 | 开发计划及持续推进 | PASSED | 用户“同意，请按照开发任务计划持续推进” |
| SCOPE-20260908 | 全新开发版本直接统一旧接口与数据库 | APPROVED | 用户最新范围指示；不授权清空数据 |

## 4. 实现任务包状态

本表是唯一人工完成状态台账，退出标准见任务计划。

| 任务包 | 名称 | 硬依赖 | 状态 | 当前进展与未满足项 |
| --- | --- | --- | --- | --- |
| OBS-TP-01 | 共享契约与接入映射 | GATE-01 | DONE | v2 契约、23 项契约测试及 parser 类型检查通过 |
| OBS-TP-02 | 存储/事务/序号基础 | 01 | DONE | 两方言初始结构、48 项存储/GC 用例及 PostgreSQL 四进程提交/回滚/回收竞争通过；按本包退出条件收口，跨包/平台验收仍归 15、16 |
| OBS-TP-03 | 权限与 API 基础 | 01、02 | DONE | 补齐夹具依赖后 56 项专项及 48 项存储/GC 回归全部通过，API build PASS；覆盖真实 JWT、AND/资源范围、游标、ETag、并发幂等与回滚；具体 Endpoint 接入另行验收 |
| OBS-TP-04 | 共享上下文/正文/上游采集 | 01 | DONE | 公共标量保真与编码正文修复已重新验收；parser 86 项及跨模块 155 项回归通过，三包构建通过；原失败记录保留在第 18 节 |
| OBS-TP-05 | Gateway 接入 | 04 | DONE | 入口前置、独立流结束、内部请求 ID、上游适配器/尝试编号、可信身份及取消接入完成；21 项真实回环 HTTP 专项与 104 项回归、API 构建通过；正式应用/监听器矩阵归 15/16 |
| OBS-TP-06 | MCP 接入 | 04 | IN_PROGRESS | HTTP/物理上游基线已验收；真实 STDIO 8 项含慢读背压均通过；stdin EOF、stdout 错误/断管及剩余传输矩阵尚未验收 |
| OBS-TP-07 | 测试/探测/内部调用接入 | 04 | READY | 04 重新验收，恢复就绪；test/probe/internal 实际接入尚未实施 |
| OBS-TP-08 | 增量汇集/身份/恢复 | 02、04 | IN_PROGRESS | 单文件采集、调用者/来源归并、目录调度、unknown 更正及持久库/独立采集进程重启共 32 项专项通过；关闭源残片/生产者退出证据仍待对接，应用集成另归 15 |
| OBS-TP-09 | 明细/正文/调用者查询 API | 03、08 | BACKLOG | 03 已完成，等待 08 |
| OBS-TP-10 | 聚合/状态/能力 API | 03、08 | BACKLOG | 03 已完成，等待 08 |
| OBS-TP-11 | 持久事件/Outbox/历史 API | 03、08 | BACKLOG | 03 已完成，等待 08；事件存储字段不等于分发已实现 |
| OBS-TP-12 | Webhook/订阅/投递 API | 11 | BACKLOG | 11 尚未完成 |
| OBS-TP-13 | Socket.IO/快照与恢复 | 10、11 | BACKLOG | 10、11 尚未完成 |
| OBS-TP-14 | 配额/保留/策略/健康 | 09、10、11、12 | BACKLOG | 前置查询/投递能力尚未完成 |
| OBS-TP-15 | 全链路集成与旧能力收敛 | 05、06、07、09、10、12、13、14 | BACKLOG | 同步切换旧接口；覆盖全系统 SQL.js 事务交互并定位 pg 弃用警告，不再做兼容适配 |
| OBS-TP-16 | 总体验收/性能/文档收口 | 15 | BACKLOG | 15 尚未完成；Linux、跨平台/方言完整矩阵及负载验证仍未执行 |

## 5. 接口交付跟踪

| 接口范围 | 数量 | 主任务包 | 状态 |
| --- | --- | --- | --- |
| OBS-API-03~10：调用/正文/trace/调用者/来源 | 8 | 09 | PLANNED |
| OBS-API-01/02/11~15：能力/总览/聚合/依赖/状态 | 7 | 10 | PLANNED |
| OBS-API-16：事件补拉 | 1 | 11 | PLANNED |
| OBS-API-17~25：订阅/投递/重试 | 9 | 12 | PLANNED |
| OBS-API-26~28：健康/策略 | 3 | 14 | PLANNED |
| OBS-PUSH-01：Socket.IO | 1 | 13 | PLANNED |
| OBS-PUSH-02：Webhook | 1 | 12 | PLANNED |

新存储模块目前未接入应用入口；collector/worker 已支持显式启用的目录后台调度，但业务应用未启用，尚无新的 HTTP controller。不能将内部采集与事件持久化视为公开接口或已运行的推送。

## 6. 验收证据矩阵

以下逐项记录实际覆盖范围。PARTIAL 表示对应组件已有通过证据，并不表示整条端到端链路或 Windows/Linux、SQLite/PostgreSQL 完整矩阵通过。

| 场景 | 内容 | 责任任务包 | 结果 |
| --- | --- | --- | --- |
| AC-01 | Gateway 正常调用与父子证据 | 05、15 | PARTIAL；Gateway 包级 PASS，剩余集成/MCP 待验收 |
| AC-02 | MCP 重试与工具/上游分别计数 | 06、15 | NOT_RUN |
| AC-03 | 缓存/未匹配/拒绝/认证前边界 | 05、06 | PARTIAL；Gateway 包级 PASS，剩余集成/MCP 待验收 |
| AC-04 | 连接错误/超时/取消/流中断 | 04、05、06 | PARTIAL；Gateway 包级 PASS，剩余集成/MCP 待验收 |
| AC-05 | HTTP 200 下工具/协议错误 | 06 | PARTIAL；真实 HTTP JSON-RPC error、真实 STDIO Tool isError/协议错误已通过；其余传输组合待验收 |
| AC-06 | 主体/凭证/IP 归并 | 08、09 | PARTIAL；稳定 callerId、凭证轮换、同 IP 不同主体与重复阶段归并通过；公开查询/真实认证全链路待验收 |
| AC-07 | 伪造代理 Header/Key 与高基数 | 04、08 | PARTIAL；忽略未认证主体/凭证、不信任伪造转发来源、HMAC 与有界 overflow 通过；共享可信代理规则端到端仍待验收 |
| AC-08 | 正文/脱敏/类型/上限/字节 | 04、05、06、09 | PARTIAL；Gateway 包级 PASS，剩余集成/MCP 待验收 |
| AC-09 | 半行/重复导入/重启 | 02、08 | PARTIAL；Windows/持久 SQL.js 独立采集进程重启、半行、重复、改名/轮转通过；完整业务管理应用及 Linux/PostgreSQL 交叉链路待验收 |
| AC-10 | 未终态/强杀/迟到更正 | 08、10 | PARTIAL；独立失联 unknown/半行抑制/迟到更正、已刷出证据后的采集进程强杀重启通过；生产者强杀/关闭残片与断电场景未验收 |
| AC-11 | 多服务器/多桶/去重与比率 | 10 | NOT_RUN |
| AC-12 | Webhook 超时/ACK 丢失/重复 | 12 | NOT_RUN |
| AC-13 | 重启/暂停/死信/人工重试 | 11、12 | NOT_RUN |
| AC-14 | 实时补拉/游标/过滤变化 | 11、13 | NOT_RUN |
| AC-15 | 数据库/磁盘/采集故障 | 04、08、14 | PARTIAL；存储异常重试、投影失败回滚、坏行与截断诊断通过；自动恢复及完整故障矩阵待验收 |
| AC-16 | 正文/事件/去重与清理 | 09、11、14 | NOT_RUN |
| AC-17 | 权限及自身审计 | 03、09、11、12、13 | NOT_RUN |
| AC-18 | 测试/探测/报送不污染统计 | 07、12、15 | NOT_RUN |
| AC-19 | 无流量心跳与新鲜度 | 10、13 | NOT_RUN |
| AC-20 | 两方言/两平台/STDIO | 02、06、15、16 | PARTIAL；两方言基础与 PostgreSQL 独立进程、Windows 真实 STDIO 已有证据；Linux/完整交叉矩阵未运行 |

## 7. 已有运行证据

| 时间 | 实际命令 | 结果 | 范围 |
| --- | --- | --- | --- |
| 2026-09-08（此前执行） | npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts | 1 suite / 23 tests PASS | TP-01 |
| 2026-09-08（此前执行） | npm.cmd run type-check --workspace api-nova-parser | PASS | TP-01 |
| 2026-09-08（此前执行） | npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts runtime-call-phases.test.ts runtime-security-audit.test.ts | 3 suites / 44 tests PASS | TP-01/04 部分基础证据 |
| 2026-09-08（此前执行） | npm.cmd run build --workspace api-nova-parser | PASS | parser 构建，不覆盖 API 存储模块 |
| 2026-09-08（修复后） | npm.cmd run build --workspace api-nova-api | PASS | 修复 TypeORM JSON 插入值类型错误 |
| 2026-09-08 | node --test packages/api-nova-api/scripts/test-call-observability.cjs | 32/32 PASS；0 fail；0 skipped | Windows / SQL.js 内存库 |
| 2026-09-08 | node packages/api-nova-api/scripts/database-tool.cjs smoke sqlite | PASS；63 表；schemaDrift=0；清理退出码 0 | 隔离空库、通用持久化/回滚、测试 API 启动 |
| 2026-09-08 | node packages/api-nova-api/scripts/database-tool.cjs smoke postgres | PASS；63 表；schemaDrift=0；清理退出码 0 | 隔离空库、通用持久化/回滚、测试 API 启动；有非致命弃用警告 |
| 2026-09-08（本轮） | npm.cmd run build --workspace api-nova-api | PASS | 含正文协调、GC 服务及模块导出 |
| 2026-09-08（本轮） | node --test packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 48/48 PASS；0 fail；0 skipped；退出码 0 | Windows / SQL.js；租约失效、正文引用保护、过期/孤立/临时文件、有界扫描、目录归属 |
| 2026-09-08（本轮） | node packages/api-nova-api/scripts/test-call-observability-postgres.cjs | OBSERVABILITY_POSTGRES_MULTIPROCESS_OK；4 processes；schemaDrift=0；退出码 0 | 20 个并发批次调用、21 个调用总计；提交/回滚顺序、未提交不可见、跨进程写入与 GC 互斥；仅独有隔离库 |

44 个 parser 测试包含之前的 23 个契约测试；48 个存储/GC 测试包含原有 32 个存储用例，不重复累计。PostgreSQL 四进程脚本单独记为一次场景验收，不冒充 20 个独立测试。Linux/负载验证仍未执行。

## 8. TP-02 阶段实施记录（历史快照）

| 范围 | 实际变更 | 状态 |
| --- | --- | --- |
| 采集契约 | parser v2 规范化与分层计数 | TP-01 DONE |
| 共享采集器 | started/progress/finished、内存预算、写入失败计数 | TP-04 IN_PROGRESS |
| 存储 | 新实体、正文受控路径、提交序号、调用版本/receipt/checkpoint/事件短事务、冲突隔离与更正入口；新增数据库归属、写入/GC 租约与 generation 隔离 | TP-02 DONE |
| 初始结构 | 直接维护两方言 InitialSchema 和 SQL，不新增历史升级链 | Windows 两方言隔离烟测通过；未处理业务库 |
| 文档 | 清理旧格式/旧查询适配要求；同步需求、设计、API、计划、台账及索引 | 已维护 |
| 存储测试 | 原有 32 项用例及新增 test-call-observability-gc.cjs 的 16 项；内存库及受控临时目录 | 48/48 PASS（Windows / SQL.js） |
| PostgreSQL 调用仓储 | test-call-observability-postgres.cjs；4 进程、20 个并发批次调用、共 21 个调用；顺序、回滚、不可见性、跨进程租约和孤立回收 | PASS；schemaDrift=0；清理退出码 0 |
| API 构建（修复前） | npm.cmd run build --workspace api-nova-api | 历史失败：call-observability.store.ts:98，TS2322；本轮已修复并构建通过 |

## 9. 剩余事项

- TP-03 已按包级退出条件验收；实际查询控制器、资源过滤、读取审计及响应拦截器协作仍由后续接入包验证。Linux 完整矩阵保留在 TP-16，全系统 SQL.js 并发交互和 pg 弃用警告保留在 TP-15。
- TP-14 接入回收调度、策略、健康与配额闭环；当前 GC 服务没有自动定时器，没有开启业务数据清理。
- TP-04 公共脱敏缺陷已修复并重新验收，TP-05 回归通过；TP-06 继续开发，TP-07/08 已恢复 READY。
- 后续 worker 接入调用者归并、断点恢复与状态维护；现阶段只有存储基础，不生成虚假调用者/聚合结果。
- 权限基础已完成；查询和推送 Endpoint 仍由后续任务落地，大屏 UI 仍为后续范围。
- 不自动处理现有开发库。如需重建，必须明确指定允许处理的数据库。

详细实现：[契约映射](../reference/runtime-observability-contract-mapping.md)、[存储基础说明](../reference/runtime-observability-storage-foundation.md)。

## 已解决的构建问题

用户已明确允许修复 TS2322。计数器初始化改为先通过 repository.create 构造带类型的实体，再交给 insert.values；保留原来的冲突忽略和事务语义，不增加宽泛类型断言。API build 已通过。

32 项存储用例全部通过，覆盖事务回滚、去重/冲突、断点、unknown 更正、正文隔离/故障/过期/完整性、本地并发与快照版本。SQLite/PostgreSQL 空库烟测均通过，两个脚本的清理退出码均为 0；现有业务库未触碰。

PostgreSQL 运行期间出现 client.query 并发调用的弃用警告，不影响本次通过结果；来源尚未定位，作为后续集成排查项保留。不能将该警告描述为已修复，也不能将通用数据库烟测等同于 PostgreSQL 多进程调用仓储验收。

## 10. TP-02 收口依据与后续边界

2026-09-08：依原计划的存储包退出标准，实体/索引与两方言初始化已有证据，去重/唯一性、事务回滚、并发提交序号、路径约束与孤立对象回收均已通过针对性验证，因此 TP-02=DONE、TP-03=READY。此处没有删去平台要求：AC-20、Linux 和完整跨包矩阵仍为 NOT_RUN，由 TP-15/16 完成；若集成发现基础契约缺陷，重开 TP-02。

正文目录以数据库 UUID 绑定；有内容但没有归属清单的目录拒绝自动接管。写入租约覆盖准备与最终提交，GC 独占租约配合 storage generation 防止失效操作重用正文路径。回收有宽限期、引用保护、数量上限和进度报告，但尚未接入定时治理、HTTP 或推送。

本轮 PostgreSQL 父进程仍输出 client.query 并发调用弃用警告；测试输出的 nonFatalWarnings=0 只统计子进程，不能用它声称整次运行没有警告。脚本退出码为 0，独有数据库、测试子进程及临时正文目录均完成清理，现有业务库未触碰。

## 11. TP-03 初始实施与提交记录（历史快照）

用户要求全部提交后，已创建本地提交 efb4536（feat: add observability storage and capture foundations），包含提交当时全部 36 个变更文件，也包含三份发布脚本。未推送远端。下面的 TP-03 工作发生在该提交之后，不把它描述为已包含在 efb4536。

已写入：四个细分权限进入 SYSTEM_PERMISSIONS；管理登录签发用途/audience/issuer；角色元数据资源范围校验与创建审计；可观测性专用 AND guard、DTO/安全错误、参数白名单、签名游标和事务幂等/资源 ETag。复用现有 SecurityModule 和 TP-02 事务，不新增表，也不自动赋予普通角色正文/IP 权限。

未执行：本轮构建、测试、数据库种子初始化、运行时部署。专项测试代码本轮也尚未新增。下一步须覆盖缺 Token/业务 Token/过期 Token、禁用账号/角色/权限、跨角色权限与资源范围交集、跨资源隐藏、游标篡改/过期/跨主体与过滤、If-Match 以及并发幂等和回滚。

TP-03 保持 IN_PROGRESS，完成数仍为 2/16。28 个新 HTTP Endpoint 与两类推送仍为 PLANNED；call-observability 模块未接入根应用，既有登录/角色服务的源码调整亦未构建部署。

## 12. 2026-09-08 验证与独立任务推进（历史快照）

用户明确授权后续同类专项测试、API 构建与按需阶段提交直接执行，并按依赖自动推进。该授权不包含部署、远端推送或清理业务数据库。

| 实际执行 | 结果 | 证据范围 |
| --- | --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS | TP-03 新源码构建 |
| node --test packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 总体 FAIL；原有 48 项 PASS；新脚本启动失败 | 不声称 104 项全部执行 |
| 新脚本诊断运行，临时开启 Nest 错误日志与 abortOnError=false | FAIL；定位 FixtureModule 缺少 JwtService 依赖 | 56 项均因 before 钩子失败而失败，业务断言未执行；不是 56 个独立业务缺陷 |
| npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts runtime-call-phases.test.ts runtime-security-audit.test.ts runtime-upstream-attempt.test.ts | 4 suites / 60 tests PASS | 原 44 项加新增 16 项，不重复累计 |
| npm.cmd run build --workspace api-nova-parser；随后 npm.cmd run build --workspace api-nova-api | 两个构建 PASS；退出码 0 | 新上游适配器导出及 API 消费包类型构建 |

TP-04 新文件为 parser/src/audit/runtime-upstream-attempt.ts 与 runtime-upstream-attempt.test.ts，index.ts 导出 runRuntimeUpstreamAttempt/getRuntimeUpstreamAuditHealth。每次回调只对应一次真实请求，重试/重定向由调用方控制，明确观察请求/响应结束，不主动消费或重放响应流。文件写入不阻塞业务返回，原异常对象原样抛出；错误分类只存安全代码。

新增用例覆盖并发父子上下文、实际尝试索引、正文/URL/凭证头脱敏、空正文与未观察区别、连接/DNS/TLS/超时/取消/流中断、容量保护、文件失败及 stdout 安全。按 TP-04 原退出条件完成包级验收，真实 Gateway/MCP/探测与端到端 AC 仍由后续包验证。

TP-03 测试夹具错误已明确报告，未擅自修复，也没有将该包标为 DONE。本轮保持其源码和失败测试为未验收工作；独立的 TP-04 可以单独提交。Gateway 的接入分析已启动，实际代码切换和测试尚未完成。

## 13. 2026-09-09 TP-03 验收与下一轮

用户已批准修复测试夹具。FixtureModule 显式注册 JwtService、UserService、ConfigService，并设置 abortOnError=false。该修改仅修复夹具启动，不放宽生产权限或 Token 校验。

| 实际执行 | 结果 | 证据范围 |
| --- | --- | --- |
| node --test packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 104/104 PASS；0 fail；0 skipped；退出码 0 | 新增 56 项业务断言已执行，原有存储/GC 48 项回归通过 |
| npm.cmd run build --workspace api-nova-api | PASS；退出码 0 | 当前 TP-03 源码构建 |

专项覆盖元数据/正文/IP/订阅/重投权限的允许与拒绝、跨角色范围交集、真实 JWT 与即时撤权、游标篡改/跨主体/过滤/过期、资源 ETag、12 路并发同键幂等及事务回滚。满足 TP-03 退出条件，登记 DONE；第 11/12 节的历史失败保留供复盘，不代表当前状态。

上一轮 TP-04 已提交为 4879979（feat: complete shared upstream attempt observability）。本轮按授权提交 TP-03 实现、测试与文档后继续 TP-05 Gateway。TP-06/07/08 仍为 READY，TP-09/10/11 仍等待 TP-08，不提前释放。

未部署、未推送、未运行种子初始化、未处理业务库。28 个新 HTTP Endpoint 与两类推送仍为 PLANNED；测试 HTTP 路由仅存在于隔离夹具，不能作为生产接口可用证据。

## 14. 2026-09-09 Gateway 包级验收与持续推进

TP-03 已提交为 64f65e3（feat: complete observability authorization and API foundations）。随后完成 Gateway 接入，本节为最新执行证据；前面各阶段快照保留，不重复累计测试。

| 实际执行 | 结果 | 证据范围 |
| --- | --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS；退出码 0 | Gateway 接入与已有基础源码构建 |
| node --test packages/api-nova-api/scripts/test-gateway-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 125/125 PASS；0 fail；0 skipped；退出码 0 | 新 Gateway 21 项 + TP-03 56 项 + 存储/GC 48 项 |

GatewayRequestAudit 在认证/策略执行前开始，非消费式观察 IncomingMessage 的现有读事件和 ServerResponse 的 write/end。入口在客户端 finish/close/aborted 上只终结一次；代理通过 TP-04 适配器独立观察每次物理请求与上游响应结束，不用 auditRecorded 抑制入口。旧访问日志服务不再产生规范调用事实，其旧 DB 写入/查询暂由 TP-15 收敛。

内部 requestId 每请求生成一次；客户端自报 ID 单独保留且限长，不得冒充 trace。重试共用 upstreamOperationId，attemptIndex 递增；当前代理不自动跟随重定向，redirectHopIndex=0。没有请求重放缓冲时，带 Content-Length 正文或 Transfer-Encoding 的请求不重试，避免消费后的空正文重复转发。缓存只产生入口事实，不产生上游事实。

已通过允许/拒绝 API Key、已认证但越权、查询凭证脱敏与移除、限流、未匹配、缓存、HTTP 失败、204 空内容、UTF-8/二进制/超限正文、真实重试、超时、上游中断、客户端取消、8 路并发及磁盘故障测试。磁盘故障用例的五条固定 stderr 警告属于预期注入，业务 200 与单次上游调用仍保持，结束后 activeCalls/captureMemoryBytes=0。

该证据覆盖 AC-01/03/04/08 的 Gateway 包级部分，不等于正式 Nest 控制器、独立监听器、所有代理部署模式和 MCP 的完整矩阵。来源 IP 目前采取保守策略：只使用直接连接端，ipSource=peer、proxyTrusted=false；可信代理逐跳解析仍需在 TP-15 统一接入验证，不能拿 X-Forwarded-For 或 req.ip 猜测真实客户端。

TP-05=DONE，TP-06 开始接入分析，TP-07/08=READY。生产查询控制器、收集 worker、读取审计和推送仍未接入；28 个 HTTP Endpoint 与两类推送继续 PLANNED。未部署、未推送、未处理业务库。

## 15. TP-06 第一批：传输终态与协议父子关系

2026-09-09：上一轮 Gateway 已提交为 d533652，开始本批工作时没有未提交改动。本批改动集中于 transportUtils/audit.ts、tools/httpServer.ts 和新增 test-mcp-transport-observability.cjs。

HTTP 入口将自己的 invocationId/traceId/rootInvocationId 传给子执行上下文，不把自身父指针改成自己。传输层复用 HTTP 协议父节点；没有 HTTP 父节点的 STDIO/程序化请求创建独立 mcp_protocol，再创建 mcp_tool。非 Tool 请求不虚构 Tool；通知没有响应 ACK，因此只记录 unknown，不冒充业务成功。

Tool/独立协议终态等待原始 send Promise：失败保留原异常对象，正文标为 incomplete 且不存残片；会话关闭和发送竞争只产生一次终态。JSON-RPC error 与 Tool isError 独立记录，重复 ID 拒绝不删除原调用，多次安装采集不重复包装。文件写入仍为异步，不阻塞协议发送；异常文案不进入审计。

| 实际执行 | 结果 | 证据范围 |
| --- | --- | --- |
| npm.cmd run build --workspace api-nova-server；npm.cmd run build --workspace api-nova-api | 两个构建 PASS | 当前源码类型与依赖 |
| node --test packages/api-nova-server/scripts/test-mcp-transport-observability.cjs | 15/15 PASS | 传输模拟，不是真实 STDIO/SSE SDK 端到端 |
| 上述 MCP 脚本与 Gateway、API foundation、storage、GC 四脚本联合执行 | 140/140 PASS；0 fail；0 skipped | 新增 15 项 + 原有 125 项，不重复累计 |

TP-06 保持 IN_PROGRESS，完成数仍为 5/16。HTTP 全正文/认证前失败/取消、真实 SDK 三类传输矩阵、parser 实际上游适配仍未完成，不能宣布 MCP 全接入。下一步已定位现有 runtime-security-audit-smoke.js 的真实 Streamable/SSE 用例；其文件选择和计数仍是旧格式，需按当前 v2 阶段记录更新后运行，不增加旧格式兼容。新接口与推送仍为 PLANNED，未触碰业务库。

## 16. TP-06 第二批：真实 Streamable/SSE 验证

首批传输采集已提交为 70c4a56（feat: track MCP protocol parents and transport completion）。随后将既有 runtime-security-audit-smoke.js 改为只读取 calls-v2 文件与 finished 阶段，拒绝空证据；不增加旧格式兼容。新增 HTTP 协议入口到 Tool、Tool 到上游的 trace/root/parent 断言，以及临时目录删除前的归属检查。

执行 node packages/api-nova-server/scripts/runtime-security-audit-smoke.js，返回 RUNTIME_SECURITY_AUDIT_SMOKE_OK、退出码 0。真实 Streamable 服务和 SSE SDK 客户端完成认证失败、错误 audience/scope、跨用户会话隔离、Tool 权限拒绝、并发调用、令牌刷新、非法/超限正文及三次实际上游调用。成功调用的三层父子关系、调用者与 requestId/traceId/rootInvocationId 一致性通过，原始 Token 和上游秘密不出现在日志。

此脚本单独登记为一项集成场景，不把其中断言数或三次调用冒充独立测试。之前 140 项专项/回归仍为通过；本批仅修改烟测脚本，没有重新编译无变化源码。实际网络均为本机随机端口，上游为本地 HTTP 夹具，使用临时签名密钥和独有目录，未连接业务库。

TP-06 仍为 IN_PROGRESS、总完成数 5/16。下一批继续 HTTP 全正文/认证前失败/取消路径、parser 单次物理上游适配，以及真实 STDIO 与慢发送/断开矩阵。已有父子关系通过不代表这些剩余能力完成；新 API 和推送仍未开放。

## 17. TP-06 第三批：HTTP 采集的首次构建失败（历史快照）

新增 tools/mcp-http-audit.ts，调整 tools/httpServer.ts、tools/runtime-security.ts，新增 test-mcp-http-observability.cjs 的 15 项实际 HTTP 测试。目标为有界请求/响应字节采集、writeHead 响应头、认证前拒绝、认证与授权失败区分、JSON-RPC 错误、取消/中断及日志故障隔离；SSE 原始帧只计字节并省略内容，Tool 逻辑 Payload 仍独立保留。

实际执行 npm.cmd run build --workspace api-nova-server 失败，退出码 2。mcp-http-audit.ts:55 报 TS2322（IncomingMessage.emit 重载被推断为必须提供第二参数），:60 报 TS2683（this 隐式 any）。串行 API build 未执行，新增 15 项测试及真实传输回归均未执行。之前的 140 项和真实 Streamable/SSE 通过证据只对应上一批，不能用于证明本批通过。

已定位拟修复为显式声明包装函数的 this: IncomingMessage、event: string | symbol、...args: any[]，不改变运行行为；当前尚未修复，等待用户确认。本批未提交，TP-06 保持 IN_PROGRESS，总完成数仍为 5/16，接口/推送未开放，未连接业务库。

## 18. 2026-09-09 类型修复、物理上游接入与失败证据（历史快照）

用户已批准第 17 节的 emit 类型修复。包装函数补齐显式 this、event 和剩余参数类型，不改变运行语义。Server/API 首次重建通过；本轮最后按 parser、Server、API 顺序完整构建也全部通过。第 17 节的构建失败不再是当前阻塞点。

新增 parser/src/audit/runtime-http-agent.ts 与 runtime-http-agent.test.ts，调整 transformer/index.ts 和 runtime-upstream-attempt.ts。操作级 HTTP/HTTPS Agent 拟为每次原生请求建立独立 upstream_api，统一 upstreamOperationId，按跳转递增 redirectHopIndex；保留 Axios 的跳转上限、POST 重放和业务解码，不再以一次逻辑调用补写所有跳转。该接入没有实现自动重试，attemptIndex=1；无实际上游请求的自定义处理器不虚构调用事实。

新增编码正文保护拟保留观察字节，但不存压缩原文，原因 encoded_body；Axios 业务解码与审计正文独立。当前响应头观察时机尚待修复验证，不能将此目标描述为已兑现。每次操作创建 keepAlive=false 的专用 Agent，跨操作连接复用及开销未验收，纳入 TP-16 性能与连接复用评估。

### 18.1 本轮实际验证

| 实际命令 | 结果 | 范围 |
| --- | --- | --- |
| npm.cmd run build --workspace api-nova-parser；npm.cmd run build --workspace api-nova-server；npm.cmd run build --workspace api-nova-api | 全部 PASS；串行退出码 0 | 包含本轮物理上游与 HTTP 采集源码，不是仅用历史产物 |
| node --test packages/api-nova-server/scripts/test-mcp-http-observability.cjs | 14/15 PASS，1 FAIL | HTTP 200 的 JSON-RPC error 被错误分类为 success |
| npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts runtime-call-phases.test.ts runtime-security-audit.test.ts runtime-upstream-attempt.test.ts runtime-http-agent.test.ts | 5 suites：4 PASS、1 FAIL；69/72 tests PASS | 原有 60 项全部通过；新增 12 项中 9 PASS、3 FAIL |
| node --test --test-reporter=dot packages/api-nova-server/scripts/test-mcp-http-observability.cjs packages/api-nova-server/scripts/test-mcp-transport-observability.cjs packages/api-nova-api/scripts/test-gateway-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 154/155 PASS，1 FAIL；退出码 1 | 现有 140 项全部通过；新增 HTTP 14 PASS、1 FAIL，失败与单独执行为同一项，不重复计数 |
| node packages/api-nova-server/scripts/runtime-security-audit-smoke.js | RUNTIME_SECURITY_AUDIT_SMOKE_OK；退出码 0 | 当前重建版本的真实 Streamable/SSE 与三层父子链路；仍不是 STDIO 验收 |

HTTP 已通过边界包括实际正文和字节、认证前拒绝不主动排空正文、直接来源 IP、策略拒绝、SSE 原始帧省略、HEAD/OPTIONS、UTF-8 分块、非法/超限 JSON、部分响应失败、客户端断开、上传中止、Tool 权限父子关系及文件故障隔离。

新增上游已通过正常请求与元数据、GET/204、307 POST 重放、跳转上限、HTTP 503、响应中断、并发父子隔离、自定义处理器零上游和日志故障隔离。通过项不覆盖下表中的未决行为。

### 18.2 未通过项与处理顺序

| 编号 | 失败证据 | 处理方向与当前状态 |
| --- | --- | --- |
| OBS-FIX-01 | HTTP 200 JSON-RPC error 预期 error，实际 success；诊断确认公共 redactAuditValue 把字符串 "2.0" 改为 "2" | 保留 JSON 标量字符串原值，只对需要递归脱敏的结构化内容解析；补充正文完整性回归，不放宽 JSON-RPC 版本判断。已报告，尚未修复 |
| OBS-FIX-02 | 跳转首跳终态预期 incomplete，实际 success | 核实原生响应观察与 follow-redirects 处置的先后关系，按实际完整性决定终态；不为通过而删除断言。尚未修正 |
| OBS-FIX-03 | gzip 响应省略原因预期 encoded_body，实际 invalid_json | 核实 Axios 修改响应头前的观察时机，保证原始编码与正文状态一致；当前原因属于待验证定位。尚未修复 |
| OBS-FIX-04 | Axios 超时预期 timeout，实际 cancelled | 原生请求中止不能丢失逻辑调用的权威超时原因；补齐原因传递并保持原业务异常。尚未修复 |

公共脱敏问题属于 TP-04 的依赖契约缺陷，依计划重开为 IN_PROGRESS；原有通过记录作为历史证据保留。TP-07/08 从 READY 返回 BACKLOG，修复并重新验收后恢复。TP-05 的现有 21 项 Gateway 回归通过，暂不撤销其包级验收；公共修复后仍需再回归。

当前 DONE=4、IN_PROGRESS=2、READY=0、BACKLOG=10，共 16 包。本批源码和失败用例均未提交，不把构建成功、真实烟测通过或测试断言数量当作整个 TP-06 验收完成。修复这四项后继续真实 STDIO、慢发送/断开与剩余退出条件，再按需提交。

最新已提交基线仍为 a61618a。本轮未推送、未部署、未连接或清理业务数据库；28 个 HTTP Endpoint 与两类推送仍为 PLANNED，collector 与生产查询控制器仍未接入。

## 19. 2026-09-09 四项修复与重新验收

用户明确批准一并修复四项后继续回归。本轮仅修正审计侧行为，不放宽 JSON-RPC 版本判断，不改变 Axios 业务异常或自行实现跳转/重试。

| 修复项 | 实际处理 | 验证结果 |
| --- | --- | --- |
| OBS-FIX-01 标量保真与协议错误 | redactAuditValue 只递归解析字符串中的 JSON 对象/数组，不解析并重写标量字符串；原始 "2.0"、"1e2"、"001"、布尔/null 文本及空白保留 | 8 个标量参数用例、1 个编码对象/数组脱敏用例通过；原 HTTP 200 JSON-RPC error 严格断言通过 |
| OBS-FIX-02 跳转终态 | prependOnceListener 在 follow-redirects 丢弃正文之前安装响应观察；终结后不再接受迟到 data/end 覆盖正文完整性 | 原 302 incomplete 断言保留并通过；补充 incomplete 正文与无残片断言，跳转后超时仅影响待结束的后续跳 |
| OBS-FIX-03 编码正文 | 在 Axios 解压和删除 content-encoding 前记录原始响应头；编码正文不保存原文，仅记录实际字节和 encoded_body | gzip 原字节、原 content-encoding、省略原因与业务解压结果同时通过 |
| OBS-FIX-04 超时与取消 | 原生 error 携带的 Axios isAxiosError=true、ECONNABORTED 仅在审计侧映射为超时；业务异常对象不变，不用消息文本猜测 | Axios 默认/clarifyTimeoutError 两种错误码均保留；显式取消和非 Axios ECONNABORTED 不被误记为 timeout |

本轮修复修改 parser 的 runtime-call-audit.ts、runtime-http-agent.ts 及对应两份测试；前批 HTTP/transformer/单次适配源码同时纳入本轮构建与回归。没有为了得到通过结果修改原四项失败断言的预期值。

| 实际命令 | 结果 | 范围 |
| --- | --- | --- |
| npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts runtime-call-phases.test.ts runtime-security-audit.test.ts runtime-upstream-attempt.test.ts runtime-http-agent.test.ts | 5 suites / 86 tests PASS；0 fail | 原 60 项、物理上游原 12 项及本轮新增 14 项；原失败上游用例均重新执行 |
| npm.cmd run build --workspace api-nova-parser；npm.cmd run build --workspace api-nova-server；npm.cmd run build --workspace api-nova-api | 三包全部 PASS；串行退出码 0 | 当前共享源码、HTTP/上游接入及 API 依赖产物 |
| node --test --test-reporter=spec packages/api-nova-server/scripts/test-mcp-http-observability.cjs packages/api-nova-server/scripts/test-mcp-transport-observability.cjs packages/api-nova-api/scripts/test-gateway-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 155/155 PASS；0 fail、0 skipped、0 cancelled | HTTP 15、传输模拟 15、Gateway 21、权限/API 基础 56、存储/GC 48 |
| node packages/api-nova-server/scripts/runtime-security-audit-smoke.js | RUNTIME_SECURITY_AUDIT_SMOKE_OK；退出码 0 | 当前构建版本的真实 Streamable/SSE、认证与三层父子关系 |

86 与 155 为不同测试集合，共 241 项通过；真实 SDK 烟测单列一个集成场景，不重复累计其中断言或三次上游调用。固定文件故障和处理器失败警告来自预期注入，不代表未处理的回归失败。

第 18 节四项问题已全部解决，TP-04 恢复 DONE，TP-07/08 恢复 READY。当前 DONE=5、IN_PROGRESS=1、READY=2、BACKLOG=8；TP-06 不提前收口，后续按计划完成真实 STDIO、慢发送/断开及剩余传输矩阵。操作级 Agent 不复用跨操作连接，其性能与连接复用评估仍归 TP-16。

本轮证据满足阶段提交条件；具体提交号由 Git 记录。未部署、未推送、未连接或清理业务数据库。28 个 HTTP Endpoint 与两类推送仍为 PLANNED，collector、生产查询及推送调度仍未接入。

## 20. 2026-09-09 推送请求与真实 STDIO 首轮验收（历史快照）

开始本轮时工作区干净，当前本地 main 最新提交为 7214c46，上游为 origin/main。按用户要求执行 git push origin main 被自动安全审批拒绝，理由为尚未获得对具体代码发送到具体 GitHub 远端的明确确认；没有成功建立推送结果，也没有改用其他传输方式绕过。已向用户请求确认 https://github.com/joe-ieta/api-nova.git，当前仍待答复。不能将本地提交标为已推送。

独立推进 TP-06：新增 scripts/test-mcp-stdio-observability.cjs，直接启动真实 Node 子进程、调用公开 createMcpServer/startStdioMcpServer，并使用 SDK STDIO 解析与发送。测试控制信息走独立 IPC，仅供夹具使用，不占用 stdout 或新增生产 Endpoint。package.json 新增 test:stdio-audit，并将脚本加入服务器标准测试链；本批没有修改生产传输代码。

| 实际执行 | 结果 | 范围 |
| --- | --- | --- |
| npm.cmd run build --workspace api-nova-server | PASS | 当前服务器构建；parser/API 源码未改，本轮未重复其构建 |
| node --test --test-reporter=spec packages/api-nova-server/scripts/test-mcp-stdio-observability.cjs packages/api-nova-server/scripts/test-mcp-http-observability.cjs packages/api-nova-server/scripts/test-mcp-transport-observability.cjs packages/api-nova-api/scripts/test-gateway-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 162/163 PASS，1 FAIL；0 skipped、0 cancelled；退出码 1 | 原 155 项全部通过；新增真实 STDIO 8 项中 7 通过 |
| 串行后续 runtime-security-audit-smoke.js | NOT_RUN | 前一命令失败后停止；第 19 节通过记录仅为上一批证据 |

已通过的真实子进程场景：启动前发送 initialize 与 debug 模式 stdout 纯协议、工具发现不虚构 Tool/上游、逻辑 Payload 标量保真/秘密脱敏、实际转换 Tool 的 protocol/tool/upstream 三层关系和字节、Tool isError 与 JSON-RPC 错误、8 路并发独立 trace 和唯一终态、主动 server.close 后取消待完成调用并 flush 再自然退出、日志目录故障不改变业务成功。

未通过场景：暂停父进程读取 stdout 后发送 8 MiB 响应，再通过 IPC 要求子进程 flush/health 快照，在 8 秒后超时，尚未完成恢复读取后的成功终态断言。当前 Node v24.15.0/win32 的内置 net 实现明确对 fd 1/2 的管道调用 setBlocking(true) 和 makeSyncWrite；等待被同步输出阻塞的同一子进程响应 IPC 是夹具同步设计错误，不能据此直接认定审计终态错误。

拟修正为暂停期间由父进程直接观察调用日志，恢复读取后再请求 flush/health 快照；保留发送完成前不得记录成功及结束后唯一成功的严格断言，不扩大超时或跳过 Windows 用例。已报告并请求批准，尚未修正或重跑。

本批测试和脚本接入保持未提交，不将 7 个通过场景等同于 8/8 或整包完成。TP-06=IN_PROGRESS，当前仍完成 5/16；STDIO 的 stdin EOF、stdout 错误/断管、完整取消矩阵与 Linux/性能边界仍未验收。28 个 HTTP Endpoint 和两类推送保持 PLANNED；未部署、未访问业务数据库。

## 21. 2026-09-09 推送授权、STDIO 慢读修复与阶段验收

用户明确同意目标远端推送及慢读测试修正。执行 git push origin main 成功，Git 回执为 547d2e0..7214c46 main -> main，目标 https://github.com/joe-ieta/api-nova.git；第 20 节的推送审批阻拦已解除，未使用强制推送或绕过方式。

本轮只修正 test-mcp-stdio-observability.cjs 的同步方法。夹具生成大响应后先 flush started 记录，再发送测试控制通知；父进程暂停 stdout 消费并确认有实际响应字节进入管道后，直接读取已持久化日志，断言当前协议/Tool 各有一个 started 且均无 finished。恢复读取后才通过 IPC 获取 flush/health 快照，验证响应完整、两层唯一成功终态及 activeCalls=0。

没有删除原禁止提前成功的要求，没有扩大超时时间或跳过 Windows 用例，也没有为此修改生产传输、SDK 发送行为或认证策略。发送前 flush 仅是夹具建立观察基线的措施，不承诺生产环境所有 started 记录都在同步管道阻塞前持久化。

| 实际执行 | 结果 | 范围 |
| --- | --- | --- |
| node --test --test-reporter=spec packages/api-nova-server/scripts/test-mcp-stdio-observability.cjs packages/api-nova-server/scripts/test-mcp-http-observability.cjs packages/api-nova-server/scripts/test-mcp-transport-observability.cjs packages/api-nova-api/scripts/test-gateway-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-api-foundation.cjs packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 163/163 PASS；0 fail、0 skipped、0 cancelled | 新真实 STDIO 8 项和原 155 项回归；慢读恢复后的终态断言已实际执行 |
| node packages/api-nova-server/scripts/runtime-security-audit-smoke.js | RUNTIME_SECURITY_AUDIT_SMOKE_OK；退出码 0 | 当前产物真实 Streamable/SSE 与三层关系回归 |
| 构建 | 本轮 NOT_RUN | 仅调整测试代码，生产源码未变；沿用第 20 节 Server build PASS 及此前 parser/API 构建产物，不冒充本轮重建 |

新增脚本已接入 test:stdio-audit 及服务器标准测试链。本批具备阶段提交条件；163 项不与其内含的 155 项重复累计，也不将上一批 parser 86 项算成本轮重新执行。

TP-06 保持 IN_PROGRESS，完成数仍 5/16。下一步覆盖 stdin EOF、stdout 错误/断管、剩余取消与传输矩阵，再根据整包退出条件收口；TP-07/08 已就绪。Windows 同步 stdout 的调度限制仍存在，独立观察端需处理新鲜度，Linux/性能矩阵继续留待 TP-16。

本次文档和测试阶段提交/推送的实际结果以 Git 回执为准。未部署、未连接或清理业务数据库，28 个 HTTP Endpoint 与两类推送继续 PLANNED。

## 22. 回顾后关键路径与单文件增量采集（2026-09-09）

TP-08 只依赖已经完成的 TP-02/04，不再等待 TP-06 全传输矩阵。当前先打通文件、身份和恢复，再开放 TP-09/10/11 的明细、统计和事件能力。TP-06 的 EOF/断管仍保留；AC-02 的重试语义不能用重定向代替，也不会为凑验收擅自添加非幂等业务重试。

新增 CallObservabilityCollector：只消费当前 v2 专用文件；单次最多 128 条/4 MiB 读取，单行默认 64 MiB、最高 128 MiB；跨批保留一个有界未完成行，超长行流式计算摘要后隔离。未完成尾行不提交，进程重启回到数据库已提交字节。未知格式、非法 JSON/UTF-8 保存摘要和原因，不复制正文。

receipt、调用/版本、事件、检查点及尾部 64 字节指纹同事务提交。原生文件身份支持改名/轮转；截断、边界变化、硬链接/符号链接和越界路径拒绝处理，不自动重置断点。尾部指纹用于追加文件恢复，不等同于全文件防篡改证明。文件内已观察序号跳跃记录下界，不推断首条之前的未知缺口。

数据集起点持久化；首次现有 v2 终态可入库，但其事件为 suppressed，不进入实时分发引用。新终态仍为 pending；尚无分发器。管道记录最近文件积压、部分行、错误、成功时间和水位，backlogScope=last_visited_file，不把局部扫描伪装为全目录总量。

实际验证：npm.cmd run build --workspace api-nova-api PASS；node --test --test-reporter=spec 的 collector/storage/GC/API-foundation 四脚本共 118/118 PASS、0 skip、0 fail，其中新增 collector 14 项。均为隔离 Windows/SQL.js；未处理业务库、未部署、未新增公开 Endpoint。下一节点为调用者/来源同事务归并及有界目录调度和失联恢复。

## 23. 调用者归并、目录调度与恢复节点（2026-09-09）

新增 CallObservabilityCallersProjector，将可信 caller、凭证引用、来源和关联观察放入调用投影事务。沿用认证层 callerId，换凭证/换 IP 不换稳定主体；相同 IP 不合并不同主体。匿名/失败来源不创建 caller 或采信传入 Key/sub。test/probe/internal 和 upstream_api 不制造外部访问者。IP 使用有效 socket peer；只有生产者已经标明 trusted_proxy 且 proxyTrusted=true 才沿用可信客户端地址。

来源 HMAC 使用专用 API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET（至少 32 字节）与 SOURCE_ID_KEY_ID（默认 v1）；无弱回退，配置缺失保留待处理文件/断点重试。API_NOVA_OBSERVABILITY_SOURCES_PER_DAY 默认 10000、上限 100000，以资产/UTC 日/认证状态限制来源，超限归入有界 overflow；降级数按新 invocation 计，不冒充独立人数。

CallObservabilityWorker 有界发现 v2 文件，默认每轮最多 32 目录项/4 MiB/128 条，忽略旧日志与 caller 清单。显式 API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED=true 才启动每轮结束后间隔 1 秒的后台循环；退出等待活动批次。单管理实例模型不变，未接入根模块或启动业务实例。

只有完整扫描无已知积压、半行、坏行和读取故障时，才对扫描开始前至少 45 秒未更新的 started/progress 调用进行有界恢复（最多 128）。结果为 unknown/completionSource=reconciled，完成时间和耗时保持 null；真实终态可更正，历史推断事件同样抑制首次分发。不存在的源目录返回 waiting_for_source，不伪报无流量健康。

实际验证：API build PASS；worker 新增 15 项，连同 collector 14、存储/GC 48、权限基础 56，总计 133/133 PASS、0 skip、0 fail。包含真实共享生产器落盘后经目录发现入库，以及实际定时启停；失联等待通过隔离库观察时刻夹具推进，不声称实际等待 45 秒或强杀已经通过。下一节点补充独立管理进程与持久 SQL.js 文件重开证据；关闭后残片确认、生产应用接入和全平台矩阵继续保留。

## 24. 独立采集进程与持久库重启节点（2026-09-09）

17e9733（单文件采集）、ac56c0b（身份/worker）均已推送 main。新增 test-call-observability-restart.cjs，3 项测试使用不同 Node 子进程打开同一隔离 SQL.js 文件，不以同一进程重建对象代替重启。

覆盖半行补全后的字节续传、数据集边界和脱敏正文跨进程保留、重复记录不推进调用/事件水位；采集进程已提交且 await database.driver.save() 后被父进程 SIGKILL，独立进程重开后恢复 unknown，再以真实源终态更正一次；源文件改名与同名替换使用独立检查点，不重复导入旧事件。

失联时刻仍通过隔离测试库推进 ingestedAt，不声称实际等待 45 秒；强杀对象是自建采集进程，不是实际 Gateway/MCP 生产者，也不等同于 OS 断电或 SQL.js 文件发布中途损坏验证。全部源目录、payload 和 sqlite 文件均位于本轮 tmp/observability-restart-tests/run-*，仅清理本轮拥有的目录。

实际命令：node --test --test-reporter=spec 的 restart/worker/collector/storage/GC/API-foundation 六脚本，136/136 PASS、0 fail、0 skip。新增 3 项真实进程用例；本节点不改生产代码，因此沿用前节点 API 构建结果，不登记新的构建执行。

TP-08 保持 IN_PROGRESS：下一个明确收口项是关闭源文件残片与生产者退出证据对接，不能仅凭读取到 EOF 就认定进程已退出并丢弃残片。随后按退出条件评估 TP-09/10/11 就绪；TP-06 EOF/断管、TP-07 内部来源、全链路应用启用及 Linux/PostgreSQL 完整矩阵仍按原计划推进。
