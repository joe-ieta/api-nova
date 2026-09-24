---
doc-version: 2.19.0
doc-status: active
doc-updated: 2026-09-24
---
# 统一调用可观测性：当前完成情况与剩余工作

> Document status: Active implementation review
> 核对日期：2026-09-24。这里是任务完成情况的当前汇总，不是历史开发流水。

> 2026-09-15 调度重排：父包原退出条件不变；当前细分、跨计划归属和下一队列见[工作包划分](./active-work-package-breakdown.md)，逐项状态见[子任务执行台账](./active-work-package-execution-status.md)。父包 IN_PROGRESS 不表示正在同时执行；文档子项完成不计为代码完成。

## 1. 项目能力与本轮核对范围

ApiNova 的主线是 API 资产导入、注册、测试、治理和发布，以及 Gateway/MCP 运行时调用。可观测性用于解释真实调用、协议处理、物理上游尝试与运行管线状态，不把测试、探测、内部管理或健康遥测混入外部业务流量。

当前汇总覆盖执行台账第7~15节及2026-09-15最新审查：调用事实实时UI、Gateway日志查询、授权策略管理、管理心跳/路由/正文扫描诊断均已有实际接线；后续补齐扫描失败恢复与停机、诊断分来源超时隔离、策略冲突重读的请求取消。验证结果按各轮证据解释，不把历史计数当作本轮结果。

以远端 `7a7fc44` 的持久聚合、采集、事件历史、Outbox、订阅/投递管理及签名发送闭环为基础。保留本地独有的根模块接入、总览/依赖/服务器状态/pipeline 查询、缓存三态、内部 origin 隔离与 MCP 发送边界修复。不恢复已被替代的本地双重聚合、物化或发送消费者。实时流只是同一 EventsService 的有界读取者。

## 2. 当前任务包状态

**DONE=11，IN_PROGRESS=4，BACKLOG=1，共 16 包；READY=0。**

`DONE` 指该任务包约定范围已闭环，不表示所有需求、平台或部署均完成；`VERIFIED` 指限定接口契约已有验收证据；`AVAILABLE` 指部署交付，不等于代码存在。文档的 `active` 仅表示仍受维护。

| 任务 | 当前状态 | 已实现依据与尚未覆盖的边界 |
| --- | --- | --- |
| TP01~05 | DONE | 共享契约、存储、权限、采集与 Gateway 的既定任务范围已闭环；不代替整合后的跨平台验收 |
| TP06 | IN_PROGRESS | MCP 发送确认及错误/不完整终态修复已保留；完整传输、正文、平台矩阵及 Windows 大响应背压限制仍待收口 |
| TP07 | DONE | 真实测试、探测和候选验证接入，origin 隔离及 telemetry 排除已完成 |
| TP08~09 | DONE | 源身份、生命周期、调用/正文/trace/调用者查询等既定范围已闭环；根模块已接入 |
| TP10 | DONE | OBS-10-01/02A/B1/B2限定出口完成：managed lifecycle与有runtimeAssetId的gateway_request/mcp_tool在途成员变化已有同Store事务sequence-bound delta。B2为5 suites/28 tests及API build；storage修正后32/32，events16、invocations38、restart3分别通过。不接Realtime，legacy/asset/global多实例水位与live liveness仍unknown |
| TP11 | DONE | 远端规范事件、授权历史、持久 Outbox 与水位闭环；本地调用快照的可选授权桥接已整合 |
| TP12 | DONE | 远端订阅/投递 HTTP、受控测试、人工重投、签名、重试与相关管理审计已闭环；自动发送默认关闭，部署未验收 |
| TP13 | IN_PROGRESS | 授权持久事件分页流、调用事实快照接续、每页权限复验、ACK背压与隔离模式已实现；调用事实UI已接入。B1/B2的managed lifecycle与业务in-flight durable deltas已闭合前置依赖；OBS-13-01A以5 suites/31 tests及API build限定完成独立server_state_v1 grant/H与权限筛选，不接Realtime/消费者。B已拆为B1/B2：B1状态专用durable delta reader以3文件、6 suites/39 tests、旧脚本39/39及API build限定DONE，复用A grant/cursor/事件表并限定两类evidenceScope，生命周期delta仅为受限字段/refreshRequired；它未注册module/controller/WS。B2现READY，后续接新的状态WebSocket事件名、ACK与重连。C等待A/B1/B2后完成权限变化、重连与乱序负测。旧invocation_facts_only保持不变；legacy/asset/global多实例共同水位及live liveness仍unknown |
| TP14 | IN_PROGRESS | 新建投递记录30天与事件重投资格已分离；新事件/正文策略、默认关闭有界正文GC及受权策略管理UI已验证；已补GC同扫描容量样本、扫描失败重开与停机收尾及只读诊断UI；整体保留/配额与跨组件故障恢复仍待闭合 |
| TP15 | IN_PROGRESS | 公开/api路径已收敛，调用事实UI及Gateway日志入口已迁移到统一API/签名分页；完整身份/拒绝审计、其余消费者与部署切换未闭合 |
| TP16 | BACKLOG | 整合后的 PostgreSQL/Linux、多进程、持续负载/容量、性能及对外交付矩阵尚未完成 |

任务定义、依赖与退出条件见[开发任务计划](./runtime-observability-development-task-plan.md)；证据与验收限制见[执行状态](./runtime-observability-development-execution-status.md)。不得因后续平台或治理工作未完成而重开 TP11/TP12 的既定闭环。

## 3. 当前接口与运行边界

- HTTP：API01~28 的限定契约已有整合验收证据，即 **28/28 VERIFIED（限定契约）**；API27/28覆盖新事件与新正文留存，不代表完整治理。
- 推送：Webhook 已实现并有隔离验收证据，但自动发送默认关闭；有界 Socket.IO 事件页切片已接入；完整统一状态/快照契约未闭合。
- 部署：**AVAILABLE=0**。已有回环/注入网络验收不等于生产部署、真实外部 TLS 接收端或生产数据库验收。
- 根应用：`AppModule` 已导入 `CallObservabilityModule`，不能继续写成仅有未挂载模块。
- 唯一聚合链路：远端 Store 与 `metrics.recompute` 协议；唯一物化和发送消费者：远端 OutboxService 与 DeliveryWorker。数据库实体和初始化结构沿用远端。
- 订阅：`enabled/paused/deleted`，对象形式 `destination`，修订区间 `[effectiveFromSequence,effectiveUntilSequence)`；不使用已撤销的本地平行协议。
- 缓存：保留命中、未命中和未知证据的区分；旧桶缺少完整七字段时走既有明细降级，不将缺证据写成零命中或完整历史。
- 总览快照：当前是有界保留调用快照，授权桥接为进程内短期凭据；不是全局服务器/管线快照或完整长期历史。
- 服务器与管线状态：管理心跳仅证明单租约持有者的进程存储往返，Gateway路由仅证明本实例注册表，两者不证明业务服务健康，stale不等于offline。诊断UI按来源保留读取/报告时间，失败显示未知；scanUsage仅为清理前扫描样本，不是当前磁盘总量或配额。Webhook Worker 状态是持久化最近一轮快照，不是累计计数、当前健康保证或 ACK 水位。
- Webhook 接入：Webhook 与 HTTP events 的报文不是同一消费契约；持久事件内容仍依赖生产端脱敏。订阅健康不是实时状态，`secretConfigured` 不保证密钥实际可用，不能仅凭这些字段宣告外部接入成功。

消费者参数、权限和限制以[API 契约](../reference/runtime-observability-api-endpoints.md)为准；运行配置以[集成指南](./runtime-observability-integration.md)为准。

## 4. 已有验收证据

2026-09-14 整合验收：Parser、Server、API 构建均 PASS；Parser 审计 **103/103**；MCP 四脚本 **53/53**；API 可观测性、Gateway 和内部依赖联合 **548/548**，无失败、取消或跳过。各专项可能重叠，不能相加为一个新的不重复测试总数。这些是整合历史证据，不与本轮专项相加；本轮结果独立登记于执行台账。

最初 543/548 的五项旧测试问题已经在前次整合中修正；它们不是当前待办。原始失败过程、修正原因及最终结果保存在[历史执行记录](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-development-execution-status.md)。

Windows / Node v24.15.0、16 MiB Streamable 响应的原生 cork/uncork 恢复组合，原生 SDK 与审计版本均有 3 秒未完成复现。对照通过不等于恢复成功；等待期间不报告伪成功，断开后为 error/incomplete。完整矩阵仍归 TP06/16。

最新增量已验证扫描失败重开/停机等待、诊断来源隔离与登出清理、策略412重读失败后的剩余GET取消；Gateway分页独立复核未发现新增缺口。详见[故障恢复审查](../audits/2026-09-15-ownership-recovery-wave.md)、[停机与取消审查](../audits/2026-09-15-publication-shutdown-wave.md)及[最新复核](../audits/2026-09-15-upstream-ownership-wave.md)。这些局部证据不完成整体配额、业务健康或平台验收。

## 5. 未完成工作及并行边界

| 工作流 | 继续完成的工作 | 完成判定与依赖 |
| --- | --- | --- |
| TP13 实时流 | 在已有调用事实快照接续、签名页流、权限复验、ACK背压和实际UI消费之上，完成server_state_v1受限状态快照/增量、其余消费者与长期/跨平台矩阵 | 不引入第二套事件源；保留已有恢复、撤权和慢消费专项，补齐已声明状态及跨环境验收；legacy/asset/global多实例共同水位保持unknown |
| TP10 状态与覆盖 | 管理心跳、本实例路由、诊断UI、受管child最新generation投影及限定retained读模型已接入；B1/B2继续补managed lifecycle与in-flight的同事务sequence事件 | B1/B2不接Realtime；管理心跳不代表业务存活，保留窗口不是全历史。legacy状态、asset目录、全局多实例水位及live active继续unknown |
| TP14 治理 | 在新事件/正文TTL、授权策略UI及默认关闭正文GC之上，完成配额强制、其余元数据生命周期、跨组件恢复、管理审计30天及历史记录策略 | 明确事件过期后的投递记录留存与重投资格分离；不能清除仍被活动投递引用的事件，不能直接启用破坏性清理 |
| TP06/16 平台验收 | MCP 完整传输/正文矩阵、Windows 限制、PostgreSQL/Linux、多进程及负载/性能 | 可与实时流/治理开发并行准备环境；最终矩阵必须针对完成后的整合版本 |
| TP15 集成收敛 | 服务身份、完整拒绝审计、旧消费者收敛和部署切换 | 根模块接入不再重复开发；最终切换依赖相应实时/治理能力和部署授权 |

本轮已修复投递留存差异：Outbox 与订阅测试新建 delivery 均到创建后30天过期，事件仍按14天保留。worker 在发送前复核事件有效性，重试不得越过事件到期；事件过期/不存在时投递记录仍可查询，人工重投返回 EVENT_EXPIRED。历史记录不自动延长，管理审计30天和完整 GC/配额仍待 TP14，不撤销 TP12 的既定 DONE。

上述工作已有本轮源码切片；不等于整包或部署完成。需要外部环境时，按[外部验收交接](./runtime-observability-external-validation-handoff.md)提供隔离数据库、运行环境与受控接收端；不要在文档或会话中提供真实秘密。

## 6. 文档整理结果与维护规则

已将“新接口均未开放”“根模块未接入”“Webhook 未实现”“整合回归待执行”和历史任务计数从当前说明中移除或改为明确的历史记录；没有降低远端已闭环任务状态，也没有把限定策略/实时流切片外推为整包完成。

- 当前完成情况与剩余工作：本页。
- 批准的任务和退出条件：[任务计划](./runtime-observability-development-task-plan.md)。
- 验收结果、环境与证据边界：[执行状态](./runtime-observability-development-execution-status.md)。
- 需求与设计保留为规范基线，不因日期较早就归档；规范目标不能代替实现证据。
- 旧待办报告和整理前混有历史流水的七份全文快照：[归档索引](../archive/summaries/runtime-observability-2026-09-14/README.md)。归档只供追溯，不参与当前状态计数。

后续更新应替换当前结论并登记证据，不再在同一文件末尾追加相互矛盾的“当前状态”。
