---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-27
---
# SEC-C3-03 多进程 Registry 版本协调证据（2026-09-27）

> Document status: Active evidence。真实 PostgreSQL 双进程协调；Windows 本机，未含 Linux/部署。

## 1. 环境与执行

- 执行器：`npm run verify:c3-03`（`verify-c3-03.cjs` + `verify-c3-03-instance.cjs`），标记 `C3_03_VERIFY_OK`
- 环境：win32 x64，Node v24.15.0；隔离真实 PostgreSQL（本机 PG16 二进制，运行后停止并移除集群）；2 个真实 Node API 进程共享同一数据库
- 结果：**18 项检查**通过，`generations [1,2,3,5,6]`（gen4 为故意被拒的陈旧包、从未成为 current），`firstOwner=p2 / secondOwner=p1`；集群已停止并移除
- 回归：servers **20 suites / 131 tests**、runtime-assets 7/128、全量 API **154 suites / 1678 tests**、C1 6/6、C2 10/10、构建与 type-check 通过

## 2. 覆盖

| 条款 | 证据 |
| --- | --- |
| 跨进程可观测 | 只读 reader `readManagedMcpLifecycleStatus`：状态、世代、`currentVerified`、快照 `registryRevision`/`registryContentDigest`、审批与终结静态码；他进程可读同一共享存储 |
| 无混版本执行 | 世代绑定快照摘要与 Registry revision；陈旧包被拒（gen4 未 current）；只有重新捕获才恢复 current |
| 单赢家 | 共享 PG 上 CAS 仅一个胜者；败者 `MANAGED_LIFECYCLE_CONFLICT`，零 spawn、零变更 |
| 外来操作防护 | 非属主 start/stop/event 失败关闭（`MANAGED_LIFECYCLE_FOREIGN_CURRENT`/rejected），消除双活/覆盖窗口 |
| 崩溃接管 | 崩溃属主的 current 保留到显式 `reconcile`（与 C2 决策一致），之后新世代接管 |

同时修复真实 PG 下 `readMcpOwnership` 的 `uuid` 主键与 `varchar(36)` 归属列连接不匹配（方言感知 `::text`，无 schema 变更、无漂移），此前该缺陷会阻断 PG 上的受管捕获路径。

## 3. 行为变更与边界

- 行为变更：仅属主进程可对活动世代 start/stop/event；崩溃接管须先显式 reconcile。
- 未覆盖：Registry watcher/推送（热更新仍为显式授权 stop→start 重准备，归 E1-04）；无租约/心跳（无自动过期）；Linux/部署证据；执行器对其一次性集群使用 `synchronize:true` 夹具（非生产迁移路径）。
