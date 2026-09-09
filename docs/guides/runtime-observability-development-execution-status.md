---
doc-version: 1.28.0
doc-status: active
doc-updated: 2026-09-09
approval-status: approved
implementation-status: in-progress
---
# 可观测性开发执行与任务包完成状态

> Document status: Active execution ledger
> 当前阶段：OBS-TP-01/02/03/04/05/08/09 完成；TP-06/10 进行中。统计内核 46d50b9 已推送；汇总 20 项、能力 14 项与 378 项联合回归通过，见第 36 节。
> 关联：[任务计划](./runtime-observability-development-task-plan.md)、[对外 API](../reference/runtime-observability-api-endpoints.md)、[需求](./runtime-observability-requirements.md)、[设计](../reference/runtime-observability-design.md)。

## 1. 当前快照

| 项目 | 状态 |
| --- | --- |
| 需求、设计、建议默认值和开发计划 | 已由用户明确同意 |
| OBS-GATE-01 | PASSED；用户要求按计划持续推进 |
| 全新版本决策 | 统一当前格式、接口和数据库初始结构，不增加历史兼容层 |
| 实现任务总数 | 16 |
| DONE | 7 |
| IN_PROGRESS / REVIEW / BLOCKED | 2 / 0 / 0 |
| READY / BACKLOG | 2 / 5 |
| 代码验收完成率 | 7/16；TP-09 查询与审计包已收口，不代表业务根应用启用、推送或全平台验收 |
| 新 HTTP Endpoint | 28 个；01、03~11 共 10 个 VERIFIED，其余 18 个 PLANNED；均未部署为 AVAILABLE |
| 新推送契约 | 2 类，全部 PLANNED |
| 本轮数据库实际操作 | 隔离 SQL.js 内存库、独有临时目录及本机随机端口；未连接或清理业务数据库 |
| 本轮新增验证 | 汇总节点 API build PASS；汇总 20/20、能力 14/14、18 脚本联合 378/378 PASS；0 fail/cancelled/skipped |

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
| OBS-TP-08 | 增量汇集/身份/恢复 | 02、04 | DONE | 采集/身份/重启/源退出共 45 项专项通过；真实写入进程 UUID/PID、已关闭残片隔离和立即 unknown 恢复已接入。包级退出条件完成，应用启用与全平台集成另归 15/16 |
| OBS-TP-09 | 明细/正文/调用者查询 API | 03、08 | DONE | 03~10 八接口 VERIFIED；调用/trace 38、正文/审计 23、访客 24、标签/条件请求 27 项通过；联合 320 项和 API 构建通过 |
| OBS-TP-10 | 聚合/状态/能力 API | 03、08 | IN_PROGRESS | OBS-API-01/11 VERIFIED；授权修订快照汇总和 5000 条边界已验收；时间桶/排行、持久聚合、总览、依赖和状态待实施 |
| OBS-TP-11 | 持久事件/Outbox/历史 API | 03、08 | READY | 03、08 已完成；持久事件基础已有，仍需历史查询和 Outbox 消费 |
| OBS-TP-12 | Webhook/订阅/投递 API | 11 | BACKLOG | 11 尚未完成 |
| OBS-TP-13 | Socket.IO/快照与恢复 | 10、11 | BACKLOG | 10、11 尚未完成 |
| OBS-TP-14 | 配额/保留/策略/健康 | 09、10、11、12 | BACKLOG | 前置查询/投递能力尚未完成 |
| OBS-TP-15 | 全链路集成与旧能力收敛 | 05、06、07、09、10、12、13、14 | BACKLOG | 同步切换旧接口；覆盖全系统 SQL.js 事务交互并定位 pg 弃用警告，不再做兼容适配 |
| OBS-TP-16 | 总体验收/性能/文档收口 | 15 | BACKLOG | 15 尚未完成；Linux、跨平台/方言完整矩阵及负载验证仍未执行 |

## 5. 接口交付跟踪

| 接口范围 | 数量 | 主任务包 | 状态 |
| --- | --- | --- | --- |
| OBS-API-03~10：调用/正文/trace/调用者/来源 | 8 | 09 | VERIFIED；未部署 |
| OBS-API-01：能力 | 1 | 10 | VERIFIED；未部署 |
| OBS-API-11：统计汇总 | 1 | 10 | VERIFIED；未部署 |
| OBS-API-02/12~15：总览/时间桶/排行/依赖/状态 | 5 | 10 | PLANNED |
| OBS-API-16：事件补拉 | 1 | 11 | PLANNED |
| OBS-API-17~25：订阅/投递/重试 | 9 | 12 | PLANNED |
| OBS-API-26~28：健康/策略 | 3 | 14 | PLANNED |
| OBS-PUSH-01：Socket.IO | 1 | 13 | PLANNED |
| OBS-PUSH-02：Webhook | 1 | 12 | PLANNED |

新观测模块已包含通过隔离 HTTP/Swagger 验证的能力、调用列表、明细、正文、trace、访客与标签控制器，但业务根应用未启用；collector/worker 支持显式启用的目录后台调度。不能将隔离验证、内部采集与事件持久化视为已部署接口或已运行的推送。

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
| AC-10 | 未终态/强杀/迟到更正 | 08、10 | PARTIAL；独立失联/迟到更正、采集进程强杀重启、真实写入进程强杀后的残片隔离和立即 unknown 通过；具体 Gateway/MCP 生产进程管理全链路及断电未验收 |
| AC-11 | 多服务器/多桶/去重与比率 | 10 | PARTIAL；纯计算及 SQL.js/HTTP 授权汇总、去重/比率/字节/直方图通过；多桶、长期聚合及完整方言矩阵待验收 |
| AC-12 | Webhook 超时/ACK 丢失/重复 | 12 | NOT_RUN |
| AC-13 | 重启/暂停/死信/人工重试 | 11、12 | NOT_RUN |
| AC-14 | 实时补拉/游标/过滤变化 | 11、13 | NOT_RUN |
| AC-15 | 数据库/磁盘/采集故障 | 04、08、14 | PARTIAL；存储异常重试、投影失败回滚、坏行与截断诊断通过；自动恢复及完整故障矩阵待验收 |
| AC-16 | 正文/事件/去重与清理 | 09、11、14 | PARTIAL；正文 API TTL、读取期间到期及保留元数据通过；事件/去重清理和策略联动待验收 |
| AC-17 | 权限及自身审计 | 03、09、11、12、13 | PARTIAL；TP-09 八个 HTTP 接口权限、正文/管理变更留痕及条件请求通过；入口统一审计与实时部分仍待 11/12/13/15 |
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

## 25. TP-08 源生命周期与包级收口（2026-09-09）

实际写入进程在首条 v2 源日志前发布 source-v2-UUID.json，包含当前格式、UUID、真实 process.pid 和启动时间，不含调用者或凭证。通过私有临时文件、sync 和不覆盖 link 发布；失败增加 sourceManifestFailures，但不阻止调用日志和业务响应。没有依赖 Windows shell 包装进程退出，也没有改变现有进程启动方式。

采集端有界读取并校验标识，仅 process.kill(pid,0) 返回 ESRCH 才持久化 UUID 绑定的退出证明。PID 存在只说明该 PID 当前可见，可能已复用，不据此确认原进程存活身份；EPERM/不支持/缺失/损坏标识均不确认关闭。这里信任受部署 ACL 保护的本机源目录，不提供远端证明或对任意进程的控制接口。

检查点记录单一来源绑定，混合来源禁止以一个标识关闭整个文件；已观察文件改名继续使用其绑定。确认关闭后保存最终文件身份、大小及尾摘要；后续追加/边界变化显式拒绝。残片仅保存 hash/reason，quarantine、缺口字节计数与检查点同事务，失败保留原断点重试，不删除原文件、不伪造调用。

完整无未处理积压扫描可直接按持久退出证明将未完成调用记为 unknown/process_exit，无需人为推进 45 秒；completedAt/durationMs 为 null，sourceExitedAt 单独记录。尚无退出证明的流量继续使用保守的新鲜度阈值，真实迟到终态仍可更正同一调用。

实际验证：parser 五套 86/86 PASS；parser/Server/API build 全部 PASS；11 个 Node 脚本联合 208/208 PASS（源生命周期新增 13 项）；真实 Streamable/SSE 烟测 RUNTIME_SECURITY_AUDIT_SMOKE_OK。新专项真实 fork 写入进程，注入末尾残片后 SIGKILL；还覆盖首行残片、活跃进程 EOF、改名、丢失/损坏标识、无法探测、发布失败放行、封存文件变化、混合来源、事务重试和真实迟到终态。非确定性 PID 回收/实际 EPERM 使用保守分支夹具，不虚称 OS 强制复用已测试。

按 TP-08 的 AC-06/07/09/10 核心退出条件登记 DONE。当前 DONE=6、IN_PROGRESS=1、READY=4、BACKLOG=5；TP-09/10/11 已就绪。运行模块仍未在业务应用启用，新 Endpoint/推送全部 PLANNED；Linux、PostgreSQL 新 worker 完整矩阵、源标识/封存元数据保留治理及机器断电验证分别归后续集成、治理和总体验收，不扩大本节点通过范围。

## 26. TP-09 调用列表与明细节点（2026-09-09）

新增 CallObservabilityInvocationsService、Controller 与 DTO，模块内注册 obsListInvocations、obsGetInvocation。真实 Nest 夹具使用全局 api/v1 前缀，验证完整路径和程序生成 Swagger；尚未将 CallObservabilityModule 接入业务根应用，因此两个接口登记 VERIFIED 而非 AVAILABLE，其余 26 个 HTTP 与两类推送仍 PLANNED。

CallObservabilityStore.readSnapshot 在 SQLite/SQL.js 共用原有串行通道并使用 SERIALIZABLE；PostgreSQL 分支使用 REPEATABLE READ。读取不创建/更新提交计数器、不分配序号或发事件。列表按历史修订可见区间与固定 snapshotSeq 读取，以 timeBasis DESC、invocationId DESC 分页；明细读取当前版本。排序列来自白名单，requestId/errorCategory 的 JSON 表达式固定且值参数化。includeTotal 仅按同一过滤和资产范围计数，大数保持十进制字符串。

游标恢复归一化时间窗，绑定主体/资产范围/过滤和接口；每次 HTTP 请求重新查当前角色。过期和保留期截止返回明确 410，不伪装最后一页；position 中的固定截止不随续页延长，取初始 15 分钟与结果集最早元数据过期时刻的较早者。后续 TP-14 若支持提前清理/缩短保留策略，还需使相关快照显式失效，不允许静默删页。

返回使用字段白名单，不返回正文、Header、Key/credentialId、路径或存储归属。来源 IP 按 monitoring:read AND monitoring:source:read 的资产交集逐条返回；未授权字段省略并标记 sourceRestricted。跨资产不可见父/根引用和对应 traceId 被裁剪，使用 linksRestricted 而非隐藏节点数量。正文只返回状态/过期时间，readLink=null；publicationSnapshot 尚未采集，返回 null 并进入 missingFields。覆盖范围尚未建模，meta.lagMs/historyCompleteSince=null、isPartial=true，不报假健康。

初次专项为 21/22：新增过期测试错误地要求导入 31 天前记录，被现有 OUTSIDE_METADATA_RETENTION 正确隔离，失败发生在夹具建数而非查询断言。已向用户说明并获得“允许修正并继续”；仅改为合法入库后在自有内存库推进 expiresAt，同时显式断言超期源记录拒绝导入，不改变生产保留逻辑、不放宽查询断言。

实际验证：API build PASS；修正后 12 个 Node 脚本联合 230/230 PASS，0 fail/skip/cancel，其中新增查询 22 项全部通过，覆盖真实管理 JWT、当前权限撤销、资产隔离/IP 交集、全过滤、SQL 注入值、半开区间、两种排序、快照更新与新增并发、游标篡改/过期/范围、隐藏引用、正文与元数据保留、错误安全和 Swagger。该节点没有重新运行 parser Jest、parser/Server 构建或独立 MCP 烟测，不把上一节点的 86 项重复计为本次执行。PostgreSQL 查询分支与 Linux 完整矩阵仍 NOT_RUN。

当前 DONE=6、IN_PROGRESS=2、READY=3、BACKLOG=5，TP-09 整包未完成。下一节点为分侧正文读取及敏感读取审计，随后 trace 和 callers/sources；TP-06/07、聚合/事件/推送/治理/根应用启用继续按依赖执行。本节点仅使用隔离 SQL.js、测试拥有的目录/进程和回环端口；未部署或连接业务数据库。提交推送结果以 Git 回执为准。

## 27. TP-09 分侧正文读取与管理审计（2026-09-09）

新增 OBS-API-05 / obsGetInvocationPayload，完整路径 /api/v1/monitoring/observability/invocations/{id}/payloads/{side}，side=request/response，不接受查询参数。独立 DTO/Controller/Service 注册在观测模块；列表和明细的正文链接指向这个受控接口，不给 fileKey 或静态下载路径。OBS-API-03/04/05 为 VERIFIED，剩余 25 条 HTTP 与两类推送 PLANNED；业务根模块仍未启用。

守卫要求当前管理身份的 monitoring:read AND monitoring:payload:read 及同资产交集。正文对象必须同时匹配 invocationId/side/当前引用；文件 I/O 后再次读取用户和角色并重校资产权限。缺失或错误侧引用返回 unavailable/content=null；真实空内容返回 captured/content=""，不能视为未采集。正文支持 json/text/base64/multipart 和标量类型；再次脱敏不改 observed_raw/partial 捕获摘要含义，readRedacted 单列读时变换。

正文 7 天 TTL 独立于调用元数据，检查发生在文件读取前、后与审计落库之后。过期返回 410 PAYLOAD_EXPIRED，error.details 只允许 state=expired/expiredAt；元数据不存在、过期或不可见仍统一 404。对象校验失败和存储错误返回安全 503，不把异常路径或正文写进错误。服务层最多 4 个并发正文读取，多余 429；文件读取仍受原有单对象边界限制，这不是 HTTP 缓冲/全系统内存配额声明。

复用 AuditService.log，在 audit_logs 保存 API_CALLED / resource=observability.payload 与 operation=obsGetInvocationPayload。log 增加可选 EntityManager，观测读取通过 Store 事务通道提交，旧调用方式继续有效；不分配调用序号或制造业务事件。仅记录操作者、内部 requestId、调用引用/版本、侧、状态和安全结果，不记录正文、Header、客户端 requestId、用户代理或文件/凭证信息。结果 prepared 表示内容就绪且授权审计已提交，不代表客户端网络已收到；后续失败可按相同 requestId 关联。

成功/omitted/unavailable 读取，以及进入正文服务后发生的 404/410/429/503/读取期间撤权均留痕。审计无法提交就不返回内容并报 503。未认证、初始权限守卫和参数校验失败在读取服务前退出，不虚称这些分支已经写 sensitive-read 行；全局安全入口审计整合归后续 TP-15。还发现既有 AuditService.findLogs 使用旧 audit.timestamp，而实体列是 createdAt；本节点只复用已验证的写入和按 ID 读取，通用列表/日期/搜索对齐明确列入 TP-09 后续，未擅自运行旧清理方法。

实际验证：API build PASS；13 个 Node 脚本联合 249/249 PASS，0 fail/skip/cancel，新增正文 19 项全部通过。使用真实 Nest/JWT/SQL.js、实际私有文件、真实 audit_logs/User 外键及按 ID 审计查询；覆盖四类编码、标量/空值、残缺/省略、再次脱敏、过期和短时真实跨 TTL、读取期间撤权、同资产 AND、隐藏引用、文件损坏、审计失败、4 路准入和旧 log 调用方式，Swagger 路径/响应/错误模型一致。未运行业务库、部署、全 HTTP 内存/性能或 PostgreSQL/Linux 查询矩阵。

TP-09 仍 IN_PROGRESS，DONE=6、IN_PROGRESS=2、READY=3、BACKLOG=5。下一项先完成通用管理审计检索对齐，再推进 OBS-API-06 trace 和 OBS-API-07~10 callers/sources/标签；随后按依赖进入聚合、事件/推送、治理与应用启用。提交推送结果以 Git 回执为准。

## 28. TP-09 既有管理审计检索对齐（2026-09-09）

d96b9f6 正文读取节点已经提交并推送。继续修正复用时发现的 AuditService.findLogs 旧时间列引用：过滤和排序统一实体的 createdAt，日期使用 TypeORM Between/MoreThanOrEqual/LessThanOrEqual 映射绑定，保留该通用管理查询原有 startDate/endDate 含边界语义；不改变新观测 from/to 的 [from,to) 契约。相同时间以 id DESC 打破排序并列。

关键词查询将 action 与 details 显式 CAST AS TEXT，避免枚举/JSON 直接 LIKE 的方言类型问题；查询值继续参数化，不把用户输入拼接进 SQL。未改变现有管理权限、返回用户/资源范围或新增 Endpoint；未调用或改动历史审计清理方法。

新增四项隔离回归覆盖“实际正文读取产生留痕后在通用列表查到”、双/单侧时间边界与无匹配日期、operation/resource/action 关键词及 SQL 注入字符串、同时间多记录分页。API build PASS，13 脚本联合 253/253 PASS、0 fail/skip/cancel；正文/管理审计脚本现为 23 项。数据库为 SQL.js，PostgreSQL 实际执行、旧管理 HTTP 控制器整体联调和全平台验收仍待后续，不把服务检索通过外推为整套旧 API 已重新发布。

TP-09 已完成列表/明细、分侧正文及本节点管理审计检索，整包仍 IN_PROGRESS，3 条 HTTP VERIFIED/25 条 PLANNED、两类推送 PLANNED；没有业务根模块启用或部署。下一优先项 OBS-API-06 trace，再继续 OBS-API-07~10 callers/sources/标签；完成数仍 6/16。已知其他历史审计统计/清理方法不在本次检索修正范围，后续治理接入前应单独验证，不能据此启用旧清理任务。

## 29. TP-09 trace 调用链查询（2026-09-09）

OBS-API-06 / obsGetTrace 已实现并 VERIFIED。复用现有调用查询 Service/Controller/DTO，完整路径 GET /api/v1/monitoring/observability/traces/{traceId}。仅接受 origin（默认 external），读取保留期内选定来源、授权可见的全部当前版本，不继承列表默认一小时时间窗；按 startedAt/调用 ID 升序返回。

资产授权和元数据 TTL 先于节点上限。可见节点最多 200，恰好 200 正常返回，超过返回 413 QUERY_TOO_LARGE，不静默截断、不暴露隐藏数量。没有可见节点时统一 404。只读快照不生成序号、事件或正文 I/O；节点使用已有白名单及按资产的 source:read 权限。

返回 nodes、edges、missingParentReferences、structuralIssues、relationshipsComplete、isPartial、maxNodes 和 origin。缺失/不可见父引用仅在可见子节点上以通用原因报告，不返回隐藏父 ID；所选 origin/trace 之外的引用即使全局授权也裁剪，响应图保持闭合。循环边在响应中移除并按可见节点报告 parent_cycle，不更改原始证据、不虚构节点。relationshipsComplete 仅指返回节点所声明引用的完整且无环，不证明全部历史链路已采集；覆盖 meta 仍保守未知。

| 本节点实际执行 | 结果 |
| --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS |
| trace 专项（位于 invocation 查询脚本） | 新增 16/16 PASS；该脚本现 38 项 |
| 13 脚本联合 Node 回归 | 269/269 PASS；0 fail/cancelled/skipped |

包含完整多边界树、跨资产裁剪、迟到终态/unknown 修正、过期父节点、循环/自环、当前授权、SQL 参数化、IP 裁剪、精确节点上限和生成 Swagger。规模上限用独立 SQL.js 投影数据，不冒充 200 次生产采集或负载 SLA；未运行实际 PostgreSQL trace 查询、Linux、parser/Server 构建或独立烟测。没有业务库操作、应用启用或部署。

TP-09 继续 IN_PROGRESS，完成包仍 6/16；4 条 HTTP VERIFIED、24 条 PLANNED，两类推送 PLANNED。下一节点 OBS-API-07/08/10 调用者与来源查询，随后 OBS-API-09 标签和敏感管理审计。后续聚合/持久事件依赖不变，节点提交推送以 Git 回执为准。

## 30. TP-09 调用者与来源查询初次验证（2026-09-09，历史失败快照）

trace 节点 05af2c4 已普通提交并推送 main。随后新增 call-observability-visitors.service/controller/dto.ts 和 test-call-observability-visitors.cjs，在 opt-in 观测模块注册 OBS-API-07/08/10；共享参数解析增加 authState 枚举。未改数据库结构、生产身份归一化、采集或业务根应用入口。三接口为 IMPLEMENTED，尚未 VERIFIED。

查询依据当前管理授权、资产/时间内的保留调用修订，而非全局调用者/来源累计时间。仅 external 且 gateway_request/mcp_protocol/mcp_tool 边界；上游、测试、探测与内部记录不制造外部访问者。调用者必须可信认证，凭证引用只来自可见窗口；来源支持四类 authState。first/lastSeen、服务器数和 summary 均从选定修订推导；当前显示名/备注/标签以 profileSnapshot=current 明示，不返回会受隐藏观察影响的全局时间或版本号。

列表以 lastSeenAt DESC、visitorId DESC 排序，签名游标固定调用快照、时间窗和保留截止；档案可编辑字段不承诺历史快照。summary 按 spanKind/byteMeasurement/measurementStage 分组，不把协议/工具/HTTP 字节混加；空、未知、不完整字节分别表达，超安全整数总量使用十进制字符串。source IP 按 read AND source:read 的逐资产交集返回，不提供 IP 过滤、正文、密钥或内部对象路径。

首版最多处理 5000 条授权且匹配的当前修订，恰好 5000 正常、超过返回 413 QUERY_TOO_LARGE，不静默截断；限制对一个查询候选集生效，不是单页数。测试使用真实 JWT/Nest HTTP/SQL.js 与现有投影 hook，规模边界用独有内存库中的合成修订数据，不声称是生产采集吞吐、数据库高负载或全局内存 SLA。

| 本节点实际执行 | 结果 |
| --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS |
| node --test --test-reporter=spec packages/api-nova-api/scripts/test-call-observability-visitors.cjs | 24 项：23 PASS、1 FAIL；0 cancelled/skipped |
| 既有 13 脚本联合回归（不含本次新脚本） | 269/269 PASS；0 fail/cancelled/skipped |
| 包含新脚本的 14 脚本 / 293 项联合回归 | NOT_RUN |

失败用例为 anonymous and failed authentication observations cannot promote supplied caller or credential IDs，断言位于新脚本 222 行。匿名夹具误设 identitySource=unknown；既有归一化只有 identitySource=anonymous 才归类 anonymous，因此查询 anonymous 得到 0 而非预期 1。已定位为本次编写的夹具不符合现行契约，已向用户请求仅修正夹具并继续回归，尚未修改。生产代码没有为迎合测试放宽身份规则，也没有删减断言。

下一动作：得到修正许可后将匿名场景 identitySource 对齐 anonymous，运行 24 项专项及 293 项联合回归；通过后才能推进三接口 VERIFIED 并提交本节点。随后实现 OBS-API-09 标签修改、If-Match 与管理审计。当前包级状态仍 DONE=6、IN_PROGRESS=2、READY=3、BACKLOG=5，无业务库操作、部署或新推送能力上线。

## 31. TP-09 访客夹具修正与查询节点验收（2026-09-09）

用户明确同意后，仅将新专项中匿名场景的 identitySource 改为 anonymous，认证失败场景保留 unknown。生产身份归一化、查询逻辑、保留策略、数据库结构和业务库均未改动；第 30 节初始 23/24 失败记录保留。

| 实际执行 | 结果 |
| --- | --- |
| node --test --test-reporter=spec packages/api-nova-api/scripts/test-call-observability-visitors.cjs | 24/24 PASS |
| 包含访客脚本的 14 脚本联合回归 | 293/293 PASS；0 fail/cancelled/skipped |
| API build | 已在同一生产查询源码上通过；本次仅夹具修正，不重复声称新生产构建 |

OBS-API-07/08/10 推进为 VERIFIED，合计 7 条 HTTP VERIFIED、21 条 PLANNED；推送仍 PLANNED、根应用未启用。覆盖匿名/失败身份、资产范围、凭证轮换、固定分页、字节口径、IP AND 权限、5000/5001 精确边界与 Swagger。Windows/SQL.js 证据不外推实际 PostgreSQL、Linux、性能或部署。TP-09 仍 IN_PROGRESS，下一节点为 OBS-API-09 标签修改、If-Match 与事务管理审计；节点提交推送以 Git 回执为准。

## 32. TP-09 标签实现与条件请求待修正项（2026-09-09，历史问题快照）

访客查询节点 f9b4a44 已普通提交并推送 main。新增 caller-profile 权限/ETag 辅助、caller-labels Service/Controller，以及 22 项实际 HTTP/SQL.js 专项；注册到 opt-in 模块并扩展访客详情 DTO。未改数据库结构、业务根模块、生产身份或保留策略。当前标签节点尚未提交。

PATCH /callers/{id} 只修改 displayName/note/labels。管理权限必须是 read AND manage 在全部登记关联资产上的覆盖；关联包含未清理的历史观察，不能只借一个可见窗口修改共享档案。未分配资产需要显式全局范围；必须仍有保留的可信外部调用。权限在事务内重新读取账号/角色；不存在和不完整授权统一 404，拒绝审计不复制隐藏调用者 ID。

GET 详情新增可选 profileEtag，仅给完整管理者。If-Match 在同一串行事务内验证；真实变更推进已有 version，普通观察不再推进档案编辑版本。保留已有版本值，不执行数据重置；版本耗尽时编辑失败，采集仍可继续。规范化 no-op 保留版本但写审计。成功修改与 AuditService.log 同事务提交；审计失败回滚，普通日志、事件和调用修订不被伪造成标签更新。

审计记录 actor、服务器生成的 requestId、字段名、前后版本和标签数量，不复制自由文本、IP、密钥、原始头或正文。它支持追踪谁修改了哪些字段/版本，不提供旧备注或标签值的完整重建。可判定的资源/参数/版本拒绝在返回错误前留痕；初始认证/守卫或刷新授权失败、HTTP JSON 解析失败仍在 TP-15 全局入口审计边界内。

| 已执行验证 | 结果 |
| --- | --- |
| API build | PASS |
| test-call-observability-caller-labels.cjs | 22/22 PASS |
| 15 脚本联合回归 | 315/315 PASS；0 fail/cancelled/skipped |
| 额外本机 Express 条件请求实验 | 第一次 200 observation=1，第二次 observation 已变为 2，但携带相同 If-None-Match 得到 304 |

新增问题：本次把档案专用版本写入 GET 详情的通用 ETag 头，而该响应还包含会随调用变化的统计、水位和时间窗。框架实验表明 Cache-Control=no-store 不能阻止这个不正确的条件请求判断。上述 22/315 用例没有覆盖此边界；实验不是已完成真实调用者路由修正回归，不能据其掩盖问题或宣称已修复。

已请求用户允许：将编辑预条件继续放在 JSON profileEtag，并改用专用 X-Profile-ETag 响应头，不替换完整 GET 响应的普通 ETag；补真实 HTTP If-None-Match 回归，再构建/联合回归/提交。尚未修改相关实现。由于工作树中的 OBS-API-08 详情发生该变化，08 从已验证查询基线暂退至 IMPLEMENTED，09 也仅 IMPLEMENTED；6 条 HTTP VERIFIED、2 条 IMPLEMENTED、20 条 PLANNED，根应用未启用。

TP-09 保持 IN_PROGRESS，DONE=6、IN_PROGRESS=2、READY=3、BACKLOG=5。修正后再按八接口的参数/分页/正文过期/资源权限/审计/Swagger 退出条件收口；之后推进 TP-10 聚合/状态/能力和 TP-11 事件/Outbox。跨平台、实际 PostgreSQL、本体部署与实时推送不在此次成功测试证据范围。

## 33. ETag 修正与 TP-09 包级收口（2026-09-09）

用户明确要求修正并继续。GET 详情和 PATCH 响应现在将档案编辑令牌放在 data.profileEtag 与 X-Profile-ETag，不覆盖完整响应的普通 HTTP ETag。If-Match 仍使用档案令牌，不接受普通响应校验值；并发保护、资产授权和事务审计语义不变。接口文档与 Swagger 同步更新，初始问题记录保留在第 32 节。

新增 5 项真实 Nest/HTTP 回归使用 Node 原生 http 客户端，避免 fetch 自动 no-cache 掩盖条件请求问题。验证档案令牌不会触发统计响应的错误 304；完整响应未变仍能合法 304，调用/窗口变化得到 200；管理权限撤销后不复用旧令牌；PATCH 正确使用独立编辑令牌。

| 已执行 | 结果 |
| --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS |
| 标签/条件请求专项 | 27/27 PASS（原 22 项 + 新 5 项） |
| 15 脚本联合回归 | 320/320 PASS；0 fail/cancelled/skipped |

| TP-09 退出条件 | 包内证据 |
| --- | --- |
| 03~10 全部接口、查询参数/响应/错误与 Swagger 对齐 | 调用/trace 38、正文/审计 23、访客 24、标签/条件请求 27 项；共 112 项相关 HTTP/服务/Swagger 回归 |
| 管理身份、AND 资源范围、跨资产 trace 裁剪 | 真实 JWT/当前角色、隐藏节点/来源/共享档案用例通过 |
| 正文状态、过期与敏感读取审计 | 到期前后复核、完整性/失败关闭、管理审计检索与回滚通过 |
| 修改预条件、并发和管理审计 | 同事务权限/If-Match/版本/审计、no-op、并发唯一成功、失败回滚与条件请求通过 |
| 覆盖范围不伪造 | 缺失 publicationSnapshot、未知历史/lag 均显式 null/partial；历史覆盖汇总继续由 TP-10 实现 |

OBS-TP-09=DONE，DONE=7、IN_PROGRESS=1（06）、READY=3（07/10/11）、BACKLOG=5。八条 HTTP VERIFIED、二十条 PLANNED；两类推送仍 PLANNED。AC-17 仅本包 HTTP 部分通过，不外推实时权限或全局入口留痕。未启用业务根模块、迁移/清理业务库、发布运行包或部署。

下一节点 TP-10 先交付 capabilities，精确区分当前已实现/按权限可用的接口、查询边界与尚未实现的聚合/推送；再推进统计与状态，TP-11 事件/Outbox 按已满足依赖继续。实际 PostgreSQL 查询、Linux、负载及全系统 SQL.js 并发、根应用启用继续由后续包验证。节点提交推送以 Git 回执为准。

## 34. TP-10 能力查询与类型修正验收（2026-09-09）

上一节点 a79720f 已普通提交并推送 main。新增 capabilities Service/Controller/DTO 和 14 项实际 Nest HTTP/SQL.js/Swagger 专项，注册到 opt-in 观测模块，未启用业务根应用。初次 API 构建因本次新增 readSnapshot 回调未返回 Promise 而报 TS2739，专项未执行；用户批准后仅补 async，未改 Store 签名、数据库或生产保留策略。

| 已执行 | 结果 |
| --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS |
| test-call-observability-capabilities.cjs | 14/14 PASS |
| 16 脚本联合回归 | 334/334 PASS；0 fail/cancelled/skipped |

OBS-API-01 只说明代码已实现及当前管理身份资源范围是否具备使用资格，不承诺运行健康、根模块启用或每个目标资源都可访问。权限按 read 与可选 payload/source/manage 求资产交集；不返回资产 ID/隐藏数量，空范围仅保留自身发现。共享档案修改仍需全部登记关联资产覆盖，能力标志不替代具体对象授权。

显式报告分页/时间/trace/访客边界和分侧正文单对象读取上限；默认保留时长不等于已有历史覆盖。未知有效采集配置、历史完整起点、lag 和健康保持 null/unknown/partial；尚未交付的聚合维度、桶数、事件保留与推送能力不伪造启用。查询只读现存水位，不扫描来源、不读正文、不初始化计数器或生成事件。errorCategory 为自由文本过滤，返回分类仅为建议值。

TP-10=IN_PROGRESS，DONE=7、IN_PROGRESS=2（06/10）、READY=2（07/11）、BACKLOG=5。01、03~10 共九条 HTTP VERIFIED，十九条 PLANNED；两类推送仍 PLANNED。下一节点推进统计聚合及可解释指标，再补总览/状态/覆盖；TP-11 按现有依赖接续。Windows/SQL.js 包内证据不外推实际 PostgreSQL 查询、Linux、负载或部署。节点提交推送以 Git 回执为准。

## 35. TP-10 统计计算内核与夹具修正（2026-09-09）

能力节点 fb295ff 已提交推送。新增 call-observability-metrics.ts 与 24 项专项；本节点为无 I/O 的有界计算组件，不注册公开路由，不启用 statistics 能力，也不读写聚合表或事件。调用方必须先落实资源授权、保留期及快照可见性。

计算按数据库 revision 选取同一 invocation 的最新投影，再应用 scope/origin/半开时间窗。保留七类终态、成功率与技术失败率的独立分母；没有进程有效存活证据时，未结束记录归 unknownInFlight。跨服务器调用者取可信主体并集；匿名来源取注册 ID 并集，overflow/缺失关联另报，不冒充人数。字节按 spanKind/byteMeasurement/measurementStage 分组，缺失不补零、部分观察给下界，超安全整数保留十进制字符串。固定直方图返回区间，溢出分位不给伪精确有限估计。

初次 API build PASS，专项 21/24：三个用例误把数据库推断终态送入要求 completedAt 的源记录归一化，失败发生在夹具建数阶段。获用户批准后仅修改夹具：先归一化合法 started 源记录，再构建 reconciled/unknown、completedAt/durationMs=null 的数据库投影；不放松生产源记录校验，不改 Store 或计算实现。

| 已执行 | 结果 |
| --- | --- |
| 内核加入后的 API 构建 | PASS；夹具修正不改生产源码，未重复构建 |
| 统计内核专项 | 24/24 PASS |
| 17 脚本联合回归 | 358/358 PASS；0 fail/cancelled/skipped |

范围最多 5000 输入观察；超限明确失败，不能视为吞吐验收。completedAt 选择时 selectedInvocations 有值而 totalStarted=null，避免把完成窗口偷换为开始总量。历史覆盖、健康继续未知；内核不是数据库权限边界或聚合作业。九条 HTTP VERIFIED、十九条 PLANNED，任务状态保持 7 DONE/2 IN_PROGRESS/2 READY/5 BACKLOG。

用户现要求提交后继续。下一节点接入 OBS-API-11 汇总的授权只读数据库查询、显式 DTO/Swagger、能力清单与真实 HTTP 回归；时间桶/排行、依赖/状态、事件与治理继续按原计划推进。不将此纯计算验收外推为实际 PostgreSQL 查询、Linux、负载或根应用部署。

## 36. OBS-API-11 汇总接口与来源筛选验收（2026-09-09）

统计内核 46d50b9 已普通提交并推送 main。新增 statistics Service/Controller/DTO 与 20 项实际 Nest/SQL.js/Swagger 专项，在 opt-in 模块注册。capabilities 同步汇总路由、五类 scope 和 5000 条限制；statistics 仅指 summary，statisticsTimeSeries/statisticsGroups 仍 not_implemented。

同一只读事务先应用资产范围、TTL、修订可见区间、scope/origin/时间及等值筛选，再最多读取 5001 条判定上限；越限 413，不截断。HTTP ingress 在数据库内排除 STDIO，隐藏/不匹配行不消耗可见预算。来源必须同资产关联，仅选 ID/overflow 判定列，不返回关联标识、IP、正文或凭证。

初次 API build PASS，能力 14/14、汇总 19/20。唯一失败是新测试误认为 Gateway/MCP 在同资产/IP/日期下共用 sourceId；现有 HMAC 包含 serverType，两个源本应分开。用户批准后仅修改断言与注释，不改生产身份或查询逻辑。

| 已执行 | 结果 |
| --- | --- |
| 汇总节点 API 构建 | PASS；测试修正后生产源码未改，未重复构建 |
| 汇总/能力专项 | 20/20 + 14/14 PASS |
| 18 脚本联合回归 | 378/378 PASS；0 fail/cancelled/skipped |

queryMode=retained_invocation_snapshot，不冒充长期聚合；completedAt 下 totalStarted=null。livenessEvaluated=false，未读取心跳，不把未结束调用当作已确认存活。覆盖、lag 与健康仍为 null/partial/unknown；不写 bucket/contribution/event 或推进水位。

01、03~11 共十条 HTTP VERIFIED，十八条 PLANNED；根应用未启用，两类推送仍 PLANNED，TP-10 未整包完成。下一节点为时间序列/排行及持久桶、迟到更正，随后依赖、状态、总览和 TP-11 事件/Outbox。证据仅 Windows/SQL.js/回环 HTTP，不外推 PostgreSQL 实际查询、Linux、负载、业务库或部署。提交推送以 Git 回执为准。
