---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-E1-04 运行中版本变更与撤销证据（2026-09-28）

> Document status: Active evidence。显式 `checkRevision`/`revoke` 触发器；真实构建产物 child；无 watcher/推送（计划明确延后）。

## 1. 环境与执行

- 执行器：`npm run verify:e1-04 --workspace api-nova-api`（`verify-e1-04.cjs`），**exit 0**，`E1_04_VERIFY_OK`，真实构建产物 child，5/5
- 单元：`managed-mcp-lifecycle-revision.spec.ts` + wiring 共 **2 suites / 23 tests**；servers 模块 **21 suites / 140 tests**
- 回归：verify:e1-02c1 6/6、e1-02c2 10/10、e1-03（77/77+31 检查）、c3-03 18、f3-03（15渠道/904项）、e2-01（153/153+19）全绿；API 构建通过

## 2. 行为

| 触发 | 结果 |
| --- | --- |
| 运行中 Registry/候选版本变化（`checkRevision`） | 验证终止旧世代 → 重准备新世代（新 revision/digest）成为 current；旧世代不再执行 |
| 快照失效捕获失败 | fail-closed 终止 |
| 撤销（`revoke`） | 落库终态 `security_revoked`，不自动重启；后续 start 需重新准备 + 审批 |
| 重复/并发信号 | 幂等；外来世代失败关闭 |
| 在途工具调用期间变更 | 有界终止、无重放、无陈旧秘密 |

修复记录（仅 runner）：夹具 upstream 状态改用既有 enum `blocked`（约束未放宽）；先 `client.close()` 再 await 以避开 SDK 60s 默认超时竞态；marker 改为 **exit-code 门控**（失败打印 `E1_04_VERIFY_FAILED` 且非零退出，无假 OK）。

## 3. 边界

- 无 Registry watcher/推送协议（明确延后）；在途上游请求的主动 abort 归 F3 范围（本项验证有界终止与无重放）。
