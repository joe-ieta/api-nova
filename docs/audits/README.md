> 2026-09-07: 本目录的旧记录描述来源分支当时的静态审查结果，不代表当前合并结果已经通过验证。请以 [审查性合并记录](./2026-09-07-reviewed-merge.md) 的问题处理与测试证据为准。

> 2026-09-08: 数据库与持久化清理、43 表 PG/SQLite 空库及完整回归结果见 [本轮清理审查记录](./2026-09-08-persistence-cleanup.md)。旧报告中的 38/40 表与环境阻塞结论保留为历史证据。

---
doc-version: 1.19.0
doc-status: active
doc-updated: 2026-09-16
---
# ApiNova 审查报告索引

> 最新调度审核：[全范围任务审核与重拆](./2026-09-15-work-package-replan.md)，任务划分与执行状态已独立维护。

## Purpose

本目录集中存放对 ApiNova 工程的能力、实现与安全审查报告，并跟踪每份报告所列问题的整改完成情况。

- 每个子文件对应一次审查（一份报告）。
- 本 README 作为索引，记录历次审查报告及其**整改完成状态**。
- 审查报告本身只读、单向递增：报告写成后不再改写现场结论；后续状态变化只更新本索引与对应问题行。

## 状态约定

| 状态 | 含义 |
| --- | --- |
| `待整改` | 报告发布，问题尚未开始处理 |
| `整改中` | 至少一个问题已开始处理，尚未全部完成 |
| `部分完成` | 部分问题已整改验证通过，仍有遗留 |
| `已整改` | 报告内所有问题均已整改并通过验证 |
| `已关闭` | 不再整改（明确不修/顺延的决策），需注明原因 |

## 报告列表

| # | 报告 | 日期 | 审查范围 | 问题数 | 严重问题 | 整改状态 | 最近更新 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | [2026-09-04-manual-registration-publication.md](./2026-09-04-manual-registration-publication.md) | 2026-09-04 | 手工服务注册 → 发布为代理服务（MCP / Gateway）能力与实现 | 11 | 3 高 | `已整改` | 2026-09-04 |

| A2 | [2026-09-08-persistence-cleanup.md](./2026-09-08-persistence-cleanup.md) | 2026-09-08 | 数据库、持久化及关联历史兼容清理 | 7 | 4 P1 | `已整改`（本地验证范围） | 2026-09-08 |

| A3 | [活跃任务依赖与并发推进](./2026-09-14-active-task-dependencies.md) | 2026-09-14 | 39包状态、依赖及TP13/14与D2并发切片 | - | - | 部分完成 | 2026-09-14 |

| A4 | [按规划继续执行](./2026-09-14-planned-next-wave.md) | 2026-09-14 | 新事件策略、状态覆盖、固定源Reload及公开路径 | - | - | 部分完成 | 2026-09-14 |
| A5 | [重拆第二批限定证据](./2026-09-16-replanned-batch-2-evidence.md) | 2026-09-16 | 受管通道、事件缺口/预览、配额门禁、发布端点与本地循环 | - | - | 部分完成 | 2026-09-16 |
| A6 | [重拆第三批限定证据](./2026-09-16-replanned-batch-3-evidence.md) | 2026-09-16 | 跨批围栏、原子基线、二进制样例与安全证据索引 | - | - | 部分完成 | 2026-09-16 |
| A7 | [重拆第四批限定证据](./2026-09-16-replanned-batch-4-evidence.md) | 2026-09-16 | 保守配额恢复、二进制样例撤销与当前空库 | - | - | 部分完成 | 2026-09-16 |
| A8 | [重拆第五批限定证据](./2026-09-16-replanned-batch-5-evidence.md) | 2026-09-16 | 发布意图、样例孤儿整理与鉴权语义 | - | - | 部分完成 | 2026-09-16 |

## 整改完成情况跟踪

### 报告 A1：手工注册发布代理服务审查（2026-09-04）

| 编号 | 问题摘要 | 严重度 | 整改状态 | 整改日期 | 整改人 | 验证/备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A1-01 | 手工端点无参数信息，MCP 工具输入 Schema 为空且 `additionalProperties:false`，无法传参 | 高 | `已整改` | 2026-09-04 | 开发 | 手工注册 DTO 支持 `parameters`/`requestBody` 简化模板，落库为 `rawOperation`，MCP 装配自动透传 |
| A1-02 | 手工端点 MCP 工具名为 `method_/path` 含 `/`，违反 MCP 规范，客户端拒绝/错乱 | 高 | `已整改` | 2026-09-04 | 开发 | parser 工具名清洗（非法字符→`_`、折叠、截断 64）；runtime-assets 装配端合成 operationId 同步清洗 |
| A1-03 | 手工端点的 query 参数无法透传、POST/PUT 请求体无法传递（代理不可用） | 高 | `已整改` | 2026-09-04 | 开发 | 参数/请求体模板写入 `rawOperation` 后，parser 的 URL/query/body 透传逻辑自动生效 |
| A1-04 | 带 `{path 参数}` 的手工端点探活/测试用字面量，无法通过就绪门禁，发布被阻塞 | 中 | `已整改` | 2026-09-04 | 开发 | probe/test 对 `{param}` 用示例值替换（metadata.testParameters > 参数 example > 默认值），就绪门禁可正常通过 |
| A1-05 | MCP 发布后仅自动 deploy 不自动 start，服务进程未运行 | 中 | `已整改` | 2026-09-04 | 开发 | 发布 DTO 增加 `autoStart`（默认 true），MCP 发布后自动 deploy+start；失败返回 `start_failed` 提示 |
| A1-06 | Gateway 发布需手工配置 route，无默认建路由行为 | 中 | `已整改` | 2026-09-04 | 开发 | 发布 DTO 增加 `autoConfigureRoute`（默认 true），Gateway 发布无 route 时按 method/path 自动建默认路由（internal） |
| A1-07 | Gateway runtime 的 `accessUrls` 为空/失真，与真实 `/api/v1/gateway/*` 入口不一致 | 中 | `已整改` | 2026-09-04 | 开发 | accessUrls 无 managedServer/matchHost 时回退为 `{API_BASE_URL}/api/v1/gateway/{path}`（未配置则相对路径） |
| A1-08 | `routeVisibility=internal` 只存不查，内部路由仍对外可访问 | 中 | `已整改` | 2026-09-04 | 开发 | gateway `authorize` 对 internal 路由强制要求 JWT（禁止 anonymous），语义落地 |
| A1-09 | Gateway 转发入口无 JWT 守卫，默认匿名可调；openapi 公共端点泄露上游信息 | 中 | `已整改` | 2026-09-04 | 开发 | 默认路由为 internal→匿名访问被拒绝；openapi 控制器挂 `JwtAuthGuard` 并移除类级 `@Public()`，上游信息不再公开可读 |
| A1-10 | 已发布手工端点的编辑不校验/不同步 route，删除不级联清理 membership/route/profile | 中 | `已整改` | 2026-09-04 | 开发 | 发布态校验（active 时禁改 method/path/baseUrl、禁删）；非 active route 更新时自动同步；删除事务级联清理 membership/publish-binding/route/profile/history/audit |
| A1-11 | `packages/api-nova-ui/src` 为空目录，UI 侧运营闭环源码缺失 | 中 | `已整改` | 2026-09-04 | 开发 | 从 git HEAD 恢复 122 个 UI 源文件到 `api-nova/packages/api-nova-ui/src`（含 EndpointRegistry 的 governance/publication workbench） |

> 注：本次整改以静态代码验证为主（tsc 对改动文件无新增错误）；本机 jest 依赖在当前 monorepo 迁移后的 node_modules 状态下未就绪，运行级 E2E 复核列为后续项，待环境修复后补充。个别结论（如空 schema/含 `/` 工具名在真实 MCP 客户端的表现）建议端到端联调复核。

### 报告 A2：数据库与持久化清理（2026-09-08）

- PC-01 至 PC-07 已修复，范围与代码入口见报告。
- API 45 套件/237 例、Parser 8 套件/30 例、Server 6 组冒烟全部通过。
- PG、SQLite 各 43 张业务表通过零数据、零结构差异、事务和完整 API 启动检查；九阶段门禁与七项安全联调通过。
- 生产部署、Ubuntu、交互式 UI 与真实外部身份提供方验收不在本地通过结论之内。

## 使用说明

- 每次发布新审查报告时，在"报告列表"追加一行，并在"整改完成情况跟踪"下新建小节。
- 问题整改完成后：更新对应行的"整改状态"为 `已整改`，并填写整改日期、整改人与验证方式。
- 状态变更应及时回写本 README，保证索引与最新现场一致。

## 相关文档

- [Documentation Index](../README.md)
- 本审查依据的工程现状文档：[Publication Resource Baseline](../guides/publication-resource-baseline.md)、[Open Items](../reference/open-items.md)


- [2026-09-14 正文保留与消费端推进](./2026-09-14-retention-consumer-wave.md)：正文TTL、默认关闭有界GC及调用事实UI切片完成；整包仍部分完成。


- [2026-09-14 管理心跳、请求头与Gateway消费者](./2026-09-14-heartbeat-header-consumer-wave.md)：三路切片已验证，整包退出条件仍部分完成。


- [2026-09-14 路由观测、可信映射与策略UI](./2026-09-14-routing-policy-mapping-wave.md)：四包构建及联合回归通过；业务存活、完整发送安全与治理仍部分完成。


- [2026-09-14 单跳凭据、容量样本与诊断UI](./2026-09-14-single-hop-capacity-diagnostics-wave.md)：三路切片与四包构建通过；已修复两项实际审查发现，整包仍有退出条件。

- [2026-09-14 提交整理与可信资产快照](./2026-09-14-commit-ownership-wave.md)：本地提交已完成；归属生成器、JWT与界面提示通过验证，原推送阻塞已于2026-09-15获确认并解除，4笔提交已推送至origin/main（eaa143a）。

- [2026-09-15 MCP装配可信映射](./2026-09-15-mcp-assembly-ownership-wave.md)：装配读取结果内部归属核验已接线，50项回归和API构建通过；7ea27a0已获授权并推送。一致事务与受管启动仍待完成。

- [2026-09-15 单查询归属与故障恢复](./2026-09-15-ownership-recovery-wave.md)：单SELECT接线、扫描故障重试和UI诊断隔离已验证；完整退出条件仍部分完成。

- [2026-09-15 发布读取与停机收敛](./2026-09-15-publication-shutdown-wave.md)：发布信息并入单SELECT、扫描停机与策略请求取消已验证；上游一致性和完整退出条件仍待完成。

- [2026-09-15 上游归属交叉核验](./2026-09-15-upstream-ownership-wave.md)：跨源混读已固定拒绝，76项与API构建通过；观测停机和Gateway分页复核无新增问题。

- [2026-09-15 候选激活与GC重试](./2026-09-15-activation-gc-wave.md)：旧候选拒绝/回滚与删除失败重扫已验证，总验收文档已对齐；完整CAS和生命周期仍待完成。

- [2026-09-15 全范围审核与子任务重排](./2026-09-15-work-package-replan.md)：确认粒度/偏移/口径问题，建立划分与独立子任务台账，并完成交接校准及启动方案草案。

- [2026-09-15 PROD-03 本地发布状态循环](./2026-09-15-prod-03-local-publication-cycle.md)：SQL.js前置与注入回放七套76/76；真实HTTP/上游仍归外部验收。
- [2026-09-16 重拆第二批限定证据](./2026-09-16-replanned-batch-2-evidence.md)：102条后续细化至108条，已完成切片与待授权/待验收边界分开登记。
