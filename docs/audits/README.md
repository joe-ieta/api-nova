> 2026-09-07: 本目录的旧记录描述来源分支当时的静态审查结果，不代表当前合并结果已经通过验证。请以 [审查性合并记录](./2026-09-07-reviewed-merge.md) 的问题处理与测试证据为准。

> 2026-09-08: 数据库与持久化清理、43 表 PG/SQLite 空库及完整回归结果见 [本轮清理审查记录](./2026-09-08-persistence-cleanup.md)。旧报告中的 38/40 表与环境阻塞结论保留为历史证据。

---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-08
---
# ApiNova 审查报告索引

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
