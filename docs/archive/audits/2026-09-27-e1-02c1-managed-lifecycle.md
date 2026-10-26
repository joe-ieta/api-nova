---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-27
---
# SEC-E1-02C1 受管 MCP 生命周期跨进程协调证据（2026-09-27，授权后）

> Document status: Active evidence。用户已明确授权启动/停止状态行为变更；实现为产品代码、默认关闭（仅显式 `executionMode: 'trusted_ipc_v1'` 路由），本地真实子进程验证。

## 1. 环境与执行

- 环境：win32 x64，Node v24.15.0；SQL.js（Jest）与真实 Node IPC 子进程（执行器）
- 结果：新增 21 项 Jest（coordinator 14 + wiring 7）；`src/modules/servers` **18 suites / 108 tests** 全通过；`npm run verify:e1-02c1 --workspace api-nova-api` 真实子进程 **6/6**，标记 `E1_02C1_VERIFY_OK`；API build 与 type-check 通过
- 回归：E1-02A 15/15、E1-02B1 32/32、E1-02B2 14/14

## 2. 实现要点

- **持久世代**：协调记录落在既有 `runtime_pipeline_state`（前缀 `managed-mcp-lifecycle:`），单调递增世代 + `updatedAt`/唯一 token CAS，跨父/子重启与崩溃不回退；旧世代事件被拒绝。
- **每次启动快照**：start 路径复用 B1 捕获（`captureForManagedLifecycle`）生成快照身份/摘要，绑定世代；缺失即失败关闭。
- **显式审批**：受保护配置 `managedMcp.lifecycleApproval`（按 runtimeAssetId 的版本化策略）提供自动审批，逐次转移写入决策记录（approver/policy/摘要/世代）；缺失或非法即拒绝且零 spawn。
- **状态机**：`starting → current`、`stopping → stopped`；停止幂等；发现的遗留子进程对账为 `abandoned` 且不得成为 current；并发启动仅一个胜者。
- **路由**：`ServerLifecycleService` 仅对 `config.executionMode === 'trusted_ipc_v1'` 走协调器；legacy 路径不变；可信模式 RUNNING 仅在 READY 后置位。

## 3. 边界（如实）

- 无 PostgreSQL/Linux/部署证据：CAS 在 SQL.js 验证，PG 条件更新路径未对真实集群执行；无 schema/迁移变更。
- C2 边界：子进程意外退出会标记持久记录 `failed`，但不回写 `MCPServerEntity.status`、不自动重启；重启仅经 STOPPED→start（归 E1-02C2）。
- `trusted_ipc_v1` 仍位于 free-form `server.config`，未新增 DTO/UI 治理；无该配置时失败关闭且默认不启用。
- C3-03 所需的持久世代/快照协调原语已具备，但其跨进程 Registry 集成仍需单独复核后推进。
