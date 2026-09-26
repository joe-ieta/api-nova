---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# OBS-15-02 全链路身份与切换验收（Windows 本地）

> Document status: Active evidence。仅本地 SQL.js/回环、Windows x64；不含 PostgreSQL、Linux、真实外部接收端吞吐或部署签收。

## 1. 环境与命令

- 提交：`fb09dc1`（运行后新增执行器与夹具修复；以实际提交为准）
- 平台：Windows x64，Node `v24.15.0`
- 命令：`npm run verify:obs-15-full-chain`
- 执行器：[scripts/verify-obs-15-full-chain.cjs](../../scripts/verify-obs-15-full-chain.cjs)
- 标记：`OBS_15_FULL_CHAIN_OK`

## 2. 本次结果

| 脚本 | 结果 |
| --- | --- |
| `test-gateway-call-observability.cjs` | 21/21 |
| `test-call-observability-events.cjs` | 16/16 |
| `test-call-observability-deliveries.cjs` | 9/9 |
| `test-call-observability-invocations.cjs` | 38/38 |
| `test-call-observability-realtime.cjs` | 11/11 |
| `test-call-observability-overview.cjs` | 20/20 |

本次修复：`test-gateway-call-observability.cjs` 的凭据仓储夹具缺少 `update()`，与 `GatewaySecurityService` 现行为不符，导致 2/21 失败；补齐夹具后 21/21 通过（仅测试夹具改动）。

跳过（原因已记录）：`test-call-observability-postgres.cjs` 与 `test-call-observability-payload-pg-multiwriter.cjs` 需要真实 PostgreSQL。

## 3. 身份链与拒绝审计

- 外部 HTTP 请求 → Gateway 调用身份（caller/API key/route/origin/审计关联）；
- 源记录 → 调用明细/trace 身份（invocationId/requestId/traceId/callerId/sourceId/scope）；
- event → caller/endpoint/tool 维度与可见范围；
- event → subscription → delivery 身份（单事件单投递、幂等重放）；
- event sequence → 实时分页身份（高水位、无缺口/重复）；
- 记录 → 调用投影 → 总览聚合身份（单快照、诚实水位）。

拒绝审计：Gateway 断言请求级身份/审计行；invocations/events/overview 断言 401/403 且被拒读者无隐藏总量或资源标识；deliveries 断言 FORBIDDEN 重投路径并写入注入审计。

## 4. 旧端点与回退

- 已退役：`GET /api/v1/monitoring/management/external-callers`
- 统一入口：`GET /api/monitoring/observability/callers`
- 无别名/无回退（OBS-15-01）；静态检查确认控制器与 parser helper 均不存在。
- 回退步骤：冻结当前构建、保持统一 API 与 `monitoring:read` 资产范围、不得恢复旧路由或 helper；如必须回滚则重新部署上一个已验证构建，并重跑本执行器。

## 5. 非声明

- 不含 PostgreSQL、Linux、真实外部接收端吞吐与部署签收；跨平台身份切换归环境验收。
- 链路按边分别验证，未有单一进程同时串起所有边的声明。
