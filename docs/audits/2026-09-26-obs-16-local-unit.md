---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# OBS-16-02 本地故障与承载单元（Windows 冻结规模）

> Document status: Active evidence。仅 Windows x64、Node v24.15.0、SQL.js 文件库单进程；不含 Linux/PostgreSQL/多进程/持续负载/性能与部署签收。

## 1. 环境与命令

- 提交：`fb09dc1`（以实际提交为准）
- 命令：`npm run verify:obs-16-local-unit`
- 执行器：[scripts/verify-obs-16-local-unit.cjs](../../scripts/verify-obs-16-local-unit.cjs)
- 新故障单元：[packages/api-nova-api/scripts/test-call-observability-local-fault-unit.cjs](../../packages/api-nova-api/scripts/test-call-observability-local-fault-unit.cjs)
- 标记：`OBS_16_LOCAL_UNIT_OK`

冻结规模：`CALL_COUNT=500`、`EVENT_BATCH=200`、`PAYLOAD_COUNT=50`、`SEED=20260926`；期望指标（invocations 500、receipts 1000、revisions 1000、payload rows 1050、captured payloads 50、completed events 500、raw batch events 200、watermark 2200）在 runner 内校验。

## 2. 本次结果

| 套件 | 结果 |
| --- | --- |
| `test-call-observability-statistics.cjs` | 20/20 |
| `test-call-observability-series-groups.cjs` | 28/28 |
| `test-call-observability-overview.cjs` | 20/20 |
| `test-call-observability-payloads.cjs` | 23/23 |
| `test-call-observability-restart.cjs` | 3/3 |
| `test-call-observability-local-fault-unit.cjs`（新增） | 3/3 |

新故障单元断言：500 条 start/finish + 200 批事件后关闭并重开 DataSource；重放 1000 条记录为重复不双计数；冲突重复记录进入隔离（`SOURCE_EVENT_CONFLICT`）；对已关闭 store 的写入明确拒绝且无部分持久化；冻结指标全部匹配。

## 3. 非声明

- 不含 Linux 执行（OBS-16-03 NEED_ENV）、PostgreSQL 及双方言、多进程/多写者并发（restart 子进程之外）、持续负载与性能测量、部署激活与回退。
- 本地通过不替代平台/生产验收。
