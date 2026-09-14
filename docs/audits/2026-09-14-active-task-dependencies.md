---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 活跃任务包依赖与并发推进记录

> 范围：ApiNova 工作区；不包含其他项目的 Codex 任务。整包状态以各专项台账为准，本页记录本轮调度、增量和验证。

## 基线核查

可观测性共 16 包：DONE 10、IN_PROGRESS 2、BACKLOG 4。安全共 23 包：DONE 1、IN_PROGRESS 18、BACKLOG 3、DEFERRED 1。IN_PROGRESS 表示仍缺退出条件，不表示所有任务同时执行或受同一环境阻塞。

权威入口为[可观测性完成复核](../guides/runtime-observability-completion-review.md)、[可观测性执行证据](../guides/runtime-observability-development-execution-status.md)和[安全执行台账](../guides/security-development-execution-status.md)。旧 open-items 的 AUDIT 与安全能力描述不能覆盖 2026-09-14 的新基线。

## 依赖与并行面

| 工作流 | 已具备依赖 | 仍未闭合的依赖 | 本轮处理 |
| --- | --- | --- | --- |
| OBS-TP13 实时事件 | TP09/11 授权查询、签名游标、持久事件；TP10 调用事实快照 | TP10 完整服务器/管线状态与全局快照、现有 UI 消费者迁移 | 基于调用事实和同一事件源开发有界实时切片 |
| OBS-TP14 留存治理 | TP09/11/12 查询、Outbox 与投递管理 | TP10 完整状态，policy API、整体配额、安全 GC/恢复 | 先分离投递记录 30 天留存与事件过期后的重投资格 |
| SEC-D2 缓存身份 | A1/A2 模式、B1/B2 认证及现有鉴权先于缓存的顺序 | D1 完整 Header 策略、IP/Anonymous 限流层次 | 补缺身份时缓存旁路和可信身份隔离 |
| OBS-TP06/10 | 已有 MCP 采集和持久状态查询 | MCP 传输/正文矩阵、真实心跳与覆盖 | 保留 IN_PROGRESS，不将组件证据外推为全量验收 |
| SEC-C3/C4/E1 | 稳定文件源、进程内 Registry、Gateway 启动激活 | 受权 Reload/审计、可信 MCP 资产映射、跳转网络边界 | 不重复实现已打通的 Gateway 文件源；列入下一波 |
| OBS-TP15/16、SEC-F4 | 已有组件级证据 | 前述实现与当前版本跨平台、跨进程、环境验收 | 最终集成与发布门禁继续保留 |

任务包依赖不等于所有切片必须串行：消费已经冻结并验证的接口可以提前开发；缺失整包退出条件时只更新 IN_PROGRESS。Socket.IO 与 Outbox 共用 Store，不能复制事件源；缓存改动不触碰并发中的凭据解析工作。

## 本轮执行与验证

本轮分为三个并行源码切片，由主任务统一处理模块接线、能力声明、整合构建和台账。工作区原有未提交改动保留；不以旧日志作为本轮运行结果。

本轮结果：API统一构建PASS；可观测性六脚本联合75/75（含实时11项、投递33项，不重复累加）；Gateway全量15套161/161，句柄检测正常退出。日志为 tmp/active-tasks-api-build.log、tmp/active-tasks-observability-tests.log、tmp/security-d2-gateway-regression.log。

整合后：可观测性 DONE10、IN_PROGRESS4、BACKLOG2；TP13/14从BACKLOG转为IN_PROGRESS。安全状态不变，共23包。合计39包中DONE11、IN_PROGRESS22、BACKLOG5、DEFERRED1；本轮未新增整包DONE。

独立审查闭合两处实时竞态：退订不提前释放在途读取占位，错误路径不发送旧授权scope的动态恢复元数据。capabilities以socketEventStream单独表达有界事件页，完整socketPush仍未实现。

下一顺序：OBS-TP10状态/覆盖与TP14策略/安全GC可分工推进；TP13继续全局状态快照与旧消费者迁移；安全C3管理Reload/审计可与E1可信资产映射/共享Resolver并行，E1网络发送须先闭合D1/F3跳转边界。最终由TP15/16、SEC-F4整合验证。实际HTTP前缀/api与能力/links的/api/v1漂移已在API文档明确登记，归TP15收敛。

生产环境、真实业务数据库、Linux权限、多进程承载和外部投递没有本轮验收证据；不因本地切片完成关闭这些条件。没有发布、部署、迁移或清理业务数据，已有工作区改动保留。
