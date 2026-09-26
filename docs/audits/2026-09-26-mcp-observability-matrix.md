---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# OBS-06-01 MCP 正文与终态矩阵（Windows 本地）

> Document status: Active evidence。仅本地回环、Windows x64 单平台；不包含 Linux/OBS-06-02、生产部署、PostgreSQL 或 AC-02 retry 矩阵。

## 1. 环境与命令

- 提交：`765408a`（运行后新增本矩阵执行器与断言；以实际提交为准）
- 平台：Windows x64，Node `v24.15.0`，MCP SDK `1.29.0`
- 命令：`npm run verify:mcp-observability-matrix`
- 执行器：[scripts/verify-mcp-observability-matrix.cjs](../../scripts/verify-mcp-observability-matrix.cjs)
- 原始日志：本地 `tmp/`（仅本地证据，不作为发布产物）

执行器先校验 Parser/Server 构建产物存在，然后分别运行 4 个 server `node --test` 脚本与 3 个 Parser Jest 上游失败套件，解析 TAP/汇总并输出 `MCP_OBSERVABILITY_MATRIX_OK` 矩阵；Windows native/audited A/B 诊断必须可解析，否则失败退出。

## 2. 本次结果

| 套件 | 结果 |
| --- | --- |
| `test-mcp-http-delivery.cjs` | 11/11 |
| `test-mcp-http-observability.cjs` | 17/17 |
| `test-mcp-transport-observability.cjs` | 15/15 |
| `test-mcp-stdio-observability.cjs` | 12/12 |
| Parser `runtime-http-agent` / `runtime-upstream-attempt` / `runtime-observability-contract` | 74/74 |

| Transport | 成功 | 取消 | 发送中断 | 大响应 | 超时 |
| --- | --- | --- | --- | --- | --- |
| streamable | covered | covered | covered | covered（16 MiB，正文 omitted/size_limit） | partial：仅入口鉴权截止（`MCP_AUTH_EXPIRED`） |
| sse | covered | covered | covered | covered（16 MiB） | not_applicable：不存在服务端 MCP 调用超时 |
| stdio | covered | covered | covered | covered（8 MiB，正文 complete） | not_applicable：不存在服务端 MCP 调用超时 |

本轮新增断言（`OBS-06-01` 限定交付）：

- http-delivery 16 MiB 成功：Tool 请求 `complete`；Tool 响应 `omitted/size_limit`、`data=undefined`、`totalBytes >= 16 MiB`（省略而非截断）。
- stdio 8 MiB 成功：protocol 与 Tool 响应均 `complete`，Tool 正文完整保留。
- 既有成功/取消/中断/错误终态、发送确认门禁与秘密不外泄断言全部保留。

## 3. Windows 原生对照（受限基线）

16 MiB Streamable 在原生 SDK 与审计传输上均出现 cork/uncork 后 3 秒未完成：

- native：`status=timeout`，`corked=0, buffered=0, finished=false, needDrain=true`
- audited：`status=timeout`，同样状态；两者一致（`match=true`）
- 执行器输出 `SDK_BASELINE_LIMITATION`：对照通过不等于恢复成功；断开后为 error/incomplete。

该结果是既有限制的复现，不构成恢复能力或生产可用性声明。

## 4. 非声明与剩余

- 不含 Linux/PostgreSQL/多进程/持续负载证据；Linux 矩阵归 OBS-06-02（NEED_ENV）。
- 不含 AC-02 上游 3 次 retry 矩阵与 MCP 调用级超时实现，仍归 TP06/16。
- 不含生产启用、外部接收端或部署验收。
