---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-27
---
# SEC-E1-02C2 受管重启/失败/legacy 边界证据（2026-09-27）

> Document status: Active evidence。在 E1-02C1 产品化协调之上完成失败/重启/legacy 边界；真实子进程验证，生产默认仍关闭。

## 1. 环境与执行

- 环境：win32 x64，Node v24.15.0；SQL.js CAS + 真实编译产物 `managed/entry.js` 子进程
- 结果：新增 2 个 spec（recovery 7 + error-handler guard 5）与 wiring 扩 7；servers 模块 **20 suites / 127 tests** 全通过；`verify:e1-02c2` 真实子进程 **10/10**，标记 `E1_02C2_VERIFY_OK`
- 回归：C1 `verify:e1-02c1` 6/6；channel 15/15、preparation 32/32、managed runtime 14/14；API build + type-check 通过

## 2. 边界实现

| 场景 | 行为 |
| --- | --- |
| 子进程意外退出/放弃 | 持久记录终结 → `managed.lifecycle.changed` → `MCPServerEntity.status=ERROR`（仅静态码/世代），绝无假 RUNNING；owned handle 幂等关闭 |
| 重启 | 可信模式**总是重新捕获**新包（世代+1）并逐次审批；不复用失败世代；legacy 自动重启对 `trusted_ipc_v1` 被抑制（`process.managed_restart_rejected`） |
| bootstrap 失败/超时 | 不置 STARTING/RUNNING，关闭子进程与计时器，记录 `failed`；按批准切换策略不保留旧实例（无免中断声明） |
| 父 IPC 断开 | 子进程停止，通道报 `MANAGED_CHANNEL_FAILED` |
| 陈旧包 | Registry 漂移后子进程拒绝旧期望，须重新准备 |
| legacy 凭据 | `trusted_ipc_v1` + bearer/custom-header 在 spawn 前失败关闭（`MCP_MANAGED_LEGACY_CREDENTIALS_REJECTED`），要求 Secret Reference/重准备，不自动迁移、不回退旧 CLI |
| 版本不匹配 | 父端预拒绝 + 子端拒绝 v2，无回退 |
| 序列化卫生 | stdout/持久状态/状态投影含合成秘密扫描通过 |

## 3. 决策

- legacy 托管记录仅在**非可信模式**按原样可启动；可信模式要求安全引用/重准备。
- 可信自动恢复=“停止→显式审批重准备”，不实现后台重试循环；错误处理链对可信模式 fail-closed（防重建秘密 argv）。
- 启动时不做自动 reconcile（共享 DB 多实例下会误弃他实例子进程）；未拥有世代报告 `current:false`，显式 reconcile 标记 `abandoned` 并通知。

## 4. 边界

- 未覆盖：PostgreSQL/Linux 运行时、跨进程 CAS、完整 Nest e2e（实体投影用 mock 仓储）、30 秒真实握手超时重跑（清理已由既有通道脚本覆盖）；`trusted_ipc_v1` 仍位于 free-form config。
