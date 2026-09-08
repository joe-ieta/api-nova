---
doc-version: 1.3.0
doc-status: active
doc-updated: 2026-09-08
approval-status: approved
implementation-status: in-progress
---
# 可观测性开发执行与任务包完成状态

> Document status: Active execution ledger
> 当前阶段：全新版本范围已确认；OBS-TP-01/02 完成，OBS-TP-03 已就绪，OBS-TP-04 实施中。
> 关联：[任务计划](./runtime-observability-development-task-plan.md)、[对外 API](../reference/runtime-observability-api-endpoints.md)、[需求](./runtime-observability-requirements.md)、[设计](../reference/runtime-observability-design.md)。

## 1. 当前快照

| 项目 | 状态 |
| --- | --- |
| 需求、设计、建议默认值和开发计划 | 已由用户明确同意 |
| OBS-GATE-01 | PASSED；用户要求按计划持续推进 |
| 全新版本决策 | 统一当前格式、接口和数据库初始结构，不增加历史兼容层 |
| 实现任务总数 | 16 |
| DONE | 2 |
| IN_PROGRESS / REVIEW / BLOCKED | 1 / 0 / 0 |
| READY / BACKLOG | 1 / 12 |
| 代码验收完成率 | 2/16；仅按各包退出条件登记，不代表全链路完成 |
| 新 HTTP Endpoint | 28 个，全部 PLANNED |
| 新推送契约 | 2 类，全部 PLANNED |
| 本轮数据库实际操作 | 仅创建/初始化/清理脚本独有隔离库；未操作现有业务库 |
| 本轮新增验证 | API build PASS；48/48 存储/GC 测试 PASS；PostgreSQL 四进程调用仓储与回收测试 PASS，schemaDrift=0，清理退出码 0 |

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
| OBS-TP-03 | 权限与 API 基础 | 01、02 | READY | 硬依赖已完成；下一步实现资源范围、细分权限、响应封装与签名游标基础 |
| OBS-TP-04 | 共享上下文/正文/上游采集 | 01 | IN_PROGRESS | 阶段写入、预算和失败计数已写入；此前 44 项 parser 测试及构建通过，完整故障注入/退出条件待收口 |
| OBS-TP-05 | Gateway 接入 | 04 | BACKLOG | 04 尚未完成 |
| OBS-TP-06 | MCP 接入 | 04 | BACKLOG | 04 尚未完成 |
| OBS-TP-07 | 测试/探测/内部调用接入 | 04 | BACKLOG | 04 尚未完成 |
| OBS-TP-08 | 增量汇集/身份/恢复 | 02、04 | BACKLOG | 02 已完成、04 尚未完成；事务及恢复入口已提供，尚无自动汇集 worker |
| OBS-TP-09 | 明细/正文/调用者查询 API | 03、08 | BACKLOG | 03、08 尚未完成 |
| OBS-TP-10 | 聚合/状态/能力 API | 03、08 | BACKLOG | 03、08 尚未完成 |
| OBS-TP-11 | 持久事件/Outbox/历史 API | 03、08 | BACKLOG | 03、08 尚未完成；事件存储字段已准备，不等于分发已实现 |
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

新存储模块目前未接入应用入口，尚无新的 HTTP controller 或自动 collector。不能将实体或事件表字段视为可用接口。

## 6. 验收证据矩阵

下列端到端场景仍全部 NOT_RUN；parser、48 项存储/GC 测试、隔离烟测及 PostgreSQL 四进程测试只提供其实际覆盖范围内的基础证据。

| 场景 | 内容 | 责任任务包 | 结果 |
| --- | --- | --- | --- |
| AC-01 | Gateway 正常调用与父子证据 | 05、15 | NOT_RUN |
| AC-02 | MCP 重试与工具/上游分别计数 | 06、15 | NOT_RUN |
| AC-03 | 缓存/未匹配/拒绝/认证前边界 | 05、06 | NOT_RUN |
| AC-04 | 连接错误/超时/取消/流中断 | 04、05、06 | NOT_RUN |
| AC-05 | HTTP 200 下工具/协议错误 | 06 | NOT_RUN |
| AC-06 | 主体/凭证/IP 归并 | 08、09 | NOT_RUN |
| AC-07 | 伪造代理 Header/Key 与高基数 | 04、08 | NOT_RUN |
| AC-08 | 正文/脱敏/类型/上限/字节 | 04、05、06、09 | NOT_RUN |
| AC-09 | 半行/重复导入/重启 | 02、08 | NOT_RUN |
| AC-10 | 未终态/强杀/迟到更正 | 08、10 | NOT_RUN |
| AC-11 | 多服务器/多桶/去重与比率 | 10 | NOT_RUN |
| AC-12 | Webhook 超时/ACK 丢失/重复 | 12 | NOT_RUN |
| AC-13 | 重启/暂停/死信/人工重试 | 11、12 | NOT_RUN |
| AC-14 | 实时补拉/游标/过滤变化 | 11、13 | NOT_RUN |
| AC-15 | 数据库/磁盘/采集故障 | 04、08、14 | NOT_RUN |
| AC-16 | 正文/事件/去重与清理 | 09、11、14 | NOT_RUN |
| AC-17 | 权限及自身审计 | 03、09、11、12、13 | NOT_RUN |
| AC-18 | 测试/探测/报送不污染统计 | 07、12、15 | NOT_RUN |
| AC-19 | 无流量心跳与新鲜度 | 10、13 | NOT_RUN |
| AC-20 | 两方言/两平台/STDIO | 02、06、15、16 | NOT_RUN |

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

## 8. 本轮实施记录

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

- 下一步启动已满足依赖的 TP-03；Linux 完整矩阵保留在 TP-16，全系统 SQL.js 并发交互和 pg 弃用警告保留在 TP-15，不外推为已验证。
- TP-14 接入回收调度、策略、健康与配额闭环；当前 GC 服务没有自动定时器，没有开启业务数据清理。
- 完成 TP-04 退出条件与故障注入，再按依赖推进 Gateway/MCP/探测接入。
- 后续 worker 接入调用者归并、断点恢复与状态维护；现阶段只有存储基础，不生成虚假调用者/聚合结果。
- 权限、查询和推送均由后续任务落地；大屏 UI 仍为后续范围。
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
