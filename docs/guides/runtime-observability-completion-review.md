---
doc-version: 2.1.0
doc-status: active
doc-updated: 2026-09-14
---
# 统一调用可观测性：当前完成情况与剩余工作

> Document status: Active implementation review
> 核对日期：2026-09-14。这里是任务完成情况的当前汇总，不是历史开发流水。

## 1. 项目能力与本轮核对范围

ApiNova 的主线是 API 资产导入、注册、测试、治理和发布，以及 Gateway/MCP 运行时调用。可观测性用于解释真实调用、协议处理、物理上游尝试与运行管线状态，不把测试、探测、内部管理或健康遥测混入外部业务流量。

本轮对照此前整合提交 `950e150` 后的实现、任务清单和已有验收证据，只整理文档，不修改生产代码或测试，不重新运行构建、部署或外部投递。

以远端 `7a7fc44` 的持久聚合、采集、事件历史、Outbox、订阅/投递管理及签名发送闭环为基础。保留本地独有的根模块接入、总览/依赖/服务器状态/pipeline 查询、缓存三态、内部 origin 隔离与 MCP 发送边界修复。不恢复已被替代的本地双重聚合、物化或发送消费者。

## 2. 当前任务包状态

**DONE=10，IN_PROGRESS=2，BACKLOG=4，共 16 包；READY=0。**

`DONE` 指该任务包约定范围已闭环，不表示所有需求、平台或部署均完成；`VERIFIED` 指限定接口契约已有验收证据；`AVAILABLE` 指部署交付，不等于代码存在。文档的 `active` 仅表示仍受维护。

| 任务 | 当前状态 | 已实现依据与尚未覆盖的边界 |
| --- | --- | --- |
| TP01~05 | DONE | 共享契约、存储、权限、采集与 Gateway 的既定任务范围已闭环；不代替整合后的跨平台验收 |
| TP06 | IN_PROGRESS | MCP 发送确认及错误/不完整终态修复已保留；完整传输、正文、平台矩阵及 Windows 大响应背压限制仍待收口 |
| TP07 | DONE | 真实测试、探测和候选验证接入，origin 隔离及 telemetry 排除已完成 |
| TP08~09 | DONE | 源身份、生命周期、调用/正文/trace/调用者查询等既定范围已闭环；根模块已接入 |
| TP10 | IN_PROGRESS | B01~B03 持久桶处理、桶/采集状态事件及统计查询已具备；总览、依赖、服务器状态和 pipeline 增量已整合；真实存活及完整覆盖/长期治理不能由这些局部能力推定 |
| TP11 | DONE | 远端规范事件、授权历史、持久 Outbox 与水位闭环；本地调用快照的可选授权桥接已整合 |
| TP12 | DONE | 远端订阅/投递 HTTP、受控测试、人工重投、签名、重试与相关管理审计已闭环；自动发送默认关闭，部署未验收 |
| TP13 | BACKLOG | 统一 Socket.IO 实时流、快照切换、补拉、撤权和慢消费者控制尚未实现 |
| TP14 | BACKLOG | 整体保留/配额、策略 API、安全清理与恢复仍待实现；已有 pipeline 查询不代表治理闭环 |
| TP15 | BACKLOG | 根接入已完成，但完整身份/拒绝审计、旧消费者收敛、全链路与部署切换仍待完成 |
| TP16 | BACKLOG | 整合后的 PostgreSQL/Linux、多进程、持续负载/容量、性能及对外交付矩阵尚未完成 |

任务定义、依赖与退出条件见[开发任务计划](./runtime-observability-development-task-plan.md)；证据与验收限制见[执行状态](./runtime-observability-development-execution-status.md)。不得因后续平台或治理工作未完成而重开 TP11/TP12 的既定闭环。

## 3. 当前接口与运行边界

- HTTP：API01~26 的限定契约已有整合验收证据，即 **26/28 VERIFIED**；API27/28 policies 仍未实现。
- 推送：Webhook 已实现并有隔离验收证据，但自动发送默认关闭；新的统一 Socket.IO 契约尚未实现。
- 部署：**AVAILABLE=0**。已有回环/注入网络验收不等于生产部署、真实外部 TLS 接收端或生产数据库验收。
- 根应用：`AppModule` 已导入 `CallObservabilityModule`，不能继续写成仅有未挂载模块。
- 唯一聚合链路：远端 Store 与 `metrics.recompute` 协议；唯一物化和发送消费者：远端 OutboxService 与 DeliveryWorker。数据库实体和初始化结构沿用远端。
- 订阅：`enabled/paused/deleted`，对象形式 `destination`，修订区间 `[effectiveFromSequence,effectiveUntilSequence)`；不使用已撤销的本地平行协议。
- 缓存：保留命中、未命中和未知证据的区分；旧桶缺少完整七字段时走既有明细降级，不将缺证据写成零命中或完整历史。
- 总览快照：当前是有界保留调用快照，授权桥接为进程内短期凭据；不是全局服务器/管线快照或完整长期历史。
- 服务器与管线状态：已有查询不代表真实心跳存活；Webhook Worker 状态是持久化最近一轮快照，不是累计计数、当前健康保证或 ACK 水位。
- Webhook 接入：Webhook 与 HTTP events 的报文不是同一消费契约；持久事件内容仍依赖生产端脱敏。订阅健康不是实时状态，`secretConfigured` 不保证密钥实际可用，不能仅凭这些字段宣告外部接入成功。

消费者参数、权限和限制以[API 契约](../reference/runtime-observability-api-endpoints.md)为准；运行配置以[集成指南](./runtime-observability-integration.md)为准。

## 4. 已有验收证据

2026-09-14 整合验收：Parser、Server、API 构建均 PASS；Parser 审计 **103/103**；MCP 四脚本 **53/53**；API 可观测性、Gateway 和内部依赖联合 **548/548**，无失败、取消或跳过。各专项可能重叠，不能相加为一个新的不重复测试总数。本轮仅核对已有日志，不将其登记为新运行。

最初 543/548 的五项旧测试问题已经在前次整合中修正；它们不是当前待办。原始失败过程、修正原因及最终结果保存在[历史执行记录](../archive/summaries/runtime-observability-2026-09-14/runtime-observability-development-execution-status.md)。

Windows / Node v24.15.0、16 MiB Streamable 响应的原生 cork/uncork 恢复组合，原生 SDK 与审计版本均有 3 秒未完成复现。对照通过不等于恢复成功；等待期间不报告伪成功，断开后为 error/incomplete。完整矩阵仍归 TP06/16。

## 5. 未完成工作及并行边界

| 工作流 | 继续完成的工作 | 完成判定与依赖 |
| --- | --- | --- |
| TP13 实时流 | 使用现有持久事件/水位实现 Socket.IO、快照与实时切换、有界补拉、撤权及背压 | 不引入第二套事件源；断线恢复、权限变化、慢消费者均需证据 |
| TP10 状态与覆盖 | 真实存活证据、覆盖解释和剩余统计/状态闭环 | 明确心跳、生命周期与采集新鲜度的区别；不把保留调用快照解释为全量历史 |
| TP14 治理 | API27/28、配额、整体保留、安全 GC 与恢复；投递留存从当前至多 14 天对齐 FR-10 的 30 天目标 | 明确事件过期后的投递记录留存与重投资格分离；不能清除仍被活动投递引用的事件，不能直接启用破坏性清理 |
| TP06/16 平台验收 | MCP 完整传输/正文矩阵、Windows 限制、PostgreSQL/Linux、多进程及负载/性能 | 可与实时流/治理开发并行准备环境；最终矩阵必须针对完成后的整合版本 |
| TP15 集成收敛 | 服务身份、完整拒绝审计、旧消费者收敛和部署切换 | 根模块接入不再重复开发；最终切换依赖相应实时/治理能力和部署授权 |

本轮确认的具体需求差异：`CallObservabilityOutboxService` 当前 `DELIVERY_RETENTION_DAYS = 14`，delivery 到期时间取事件到期与创建后 14 天的较早值，而[批准需求 FR-10](./runtime-observability-requirements.md)要求投递与本功能管理审计保留 30 天。投递留存差异归 TP14 跟踪，不撤销 TP12 的既定 DONE，也不声称 30 天目标已经实现。源码依据见[Outbox 服务](../../packages/api-nova-api/src/modules/call-observability/call-observability-outbox.service.ts)。

以上是剩余工作，不代表本轮已经启动源码开发。需要外部环境时，按[外部验收交接](./runtime-observability-external-validation-handoff.md)提供隔离数据库、运行环境与受控接收端；不要在文档或会话中提供真实秘密。

## 6. 文档整理结果与维护规则

已将“新接口均未开放”“根模块未接入”“Webhook 未实现”“整合回归待执行”和历史任务计数从当前说明中移除或改为明确的历史记录；没有降低远端已闭环任务状态，也没有把未实现的策略/实时流标成完成。

- 当前完成情况与剩余工作：本页。
- 批准的任务和退出条件：[任务计划](./runtime-observability-development-task-plan.md)。
- 验收结果、环境与证据边界：[执行状态](./runtime-observability-development-execution-status.md)。
- 需求与设计保留为规范基线，不因日期较早就归档；规范目标不能代替实现证据。
- 旧待办报告和整理前混有历史流水的七份全文快照：[归档索引](../archive/summaries/runtime-observability-2026-09-14/README.md)。归档只供追溯，不参与当前状态计数。

后续更新应替换当前结论并登记证据，不再在同一文件末尾追加相互矛盾的“当前状态”。
