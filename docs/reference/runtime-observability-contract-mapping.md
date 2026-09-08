---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-08
---
# 可观测性共享契约与接入映射

> Document status: OBS-TP-01 completed contract and source mapping
> 用户已确认全新开发版本策略；只支持当前 v2 源记录，不导入旧格式或建立历史迁移链。

## 冻结的契约

- 源记录 schemaVersion=2，对外 API schemaVersion=1.0；未知源 schema 拒绝。
- gateway_request/mcp_protocol/mcp_tool/upstream_api 分开计数。
- started/progress/finished 使用相同 invocationId，不同 eventId 和递增 recordVersion。
- 进程 sourceSequence 是源内顺序；对外 sequence 只能由管理数据库提交分配。
- API Key/JWT 主体必须经过认证；来源 IP 不等同于身份。
- HTTP body、MCP 序列化 Payload 按 byteMeasurement/measurementStage 分组，不混加。
- 缓存命中不生成上游调用；重定向的请求次数与重试轮次分别统计。
- 没有观察到正文返回 null/原因，不用空正文或 0 代替。
- 缺少父节点保持未关联；迟到终态提升版本并更新同一调用。
- 新查询路径为 /api/v1/monitoring/observability，来自全局 api + v1 控制器前缀。
- Socket.IO namespace=/monitoring，现有服务未自定义 Engine.IO path；新契约使用 /socket.io 和 auth.token。
- 现有 PermissionsGuard 为 ANY-OF；新正文/来源等权限必须使用明确 AND 检查。

## 当前源码边界与后续负责人

| 源路径 | 当前事实/后续改造 | 任务包 |
| --- | --- | --- |
| parser/src/audit/runtime-call-audit.ts | 已写入 v2 started/progress/finished、有界正文预算/写入队列及失败计数；接入与完整故障验收待后续完成 | 04 |
| parser/src/audit/runtime-observability-contract.ts | v2 校验、规范化、scope/去重参考计数；已实现 | 01 |
| gateway-runtime/services/gateway-runtime.service.ts | 路由、拒绝、缓存与重试外层；建立入口节点和尝试编号 | 05 |
| gateway-runtime/services/gateway-proxy-engine.service.ts | 实际 HTTP 出站与 body tracker；关联父入口，不当作外部访问 | 05 |
| gateway-runtime/services/gateway-access-log.service.ts | 旧 DB 与 fallback 审计；后续收敛为单一规范事实，避免重复 | 05、15 |
| api-nova-server/src/transportUtils/audit.ts | tools/call 捕获；须补齐协议节点/终态发送结果 | 06 |
| api-nova-server/src/tools/runtime-security.ts | 逐请求主体和工具权限；拒绝不能虚构成功身份 | 06 |
| security/guards/permissions.guard.ts | ANY-OF，与新正文权限不兼容；新增明确策略 | 03 |
| database/database-options.ts | 已登记新存储实体并更新两方言初始基线；未执行数据库初始化/验证 | 02 |
| websocket/websocket.gateway.ts | 现有 namespace 和实时广播；新敏感订阅必须鉴权并接持久事件 | 13 |

路径均指 packages 下对应包的 src；实际绝对工作区为 E:/CodexDev/api-nova。

## 验证证据

2026-09-08：npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts，1 suite、23 tests 全部通过。覆盖工具/上游分层、缓存、工具错误、失败身份、正文缺失、迟到终态、非业务 origin、STDIO、重试/重定向、未知父节点、混合计量和非法 schema 拒绝。

2026-09-08：npm.cmd run type-check --workspace api-nova-parser，通过。

本包只是共享契约验证，不将未完成的采集器、数据库、API 或推送标为已实现。

## 后续基础代码证据

共享采集器新增阶段测试；此前运行 runtime-observability-contract.test.ts、runtime-call-phases.test.ts、runtime-security-audit.test.ts，3 suites / 44 tests PASS；parser build PASS。这些结果不替代 Gateway/MCP 接入或存储端到端验收。

存储基础于 2026-09-08 写入，详见[存储基础实现说明](./runtime-observability-storage-foundation.md)。本轮仅写入源码/初始化文件，没有运行新的测试、构建或数据库验证。
