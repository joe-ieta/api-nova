---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-F1-02E3b 运行中更新阻断与实时授权 IPC 证据（2026-09-28）

> Document status: Active evidence。E3a 租约协调原语接入真实 lifecycle；trusted-only 且默认关闭。

## 1. 环境与执行

- 执行器：`npm run verify:f1-02e3b --workspace api-nova-api`，标记 `F1_02E3B_VERIFY_OK`，exit 0；真实构建产物 child，**5 场景 / 49 检查**
- 单元：新增 3 套件 / 16 项；servers 模块 **24 suites / 156 tests**（基线 21/140）
- 回归：e1-02c1 6、e1-02c2 10、e1-03（77/77+31）、e1-04 5、c3-03 18、f3-03（15渠道/904）全绿；API/Server 构建通过

## 2. 行为

| 能力 | 结果 |
| --- | --- |
| 运行中更新前阻断 | `isolateSourceForUpdate`：同步阻断租约→验证终止→持久化 `security_revoked`/`MANAGED_SECURITY_SOURCE_UPDATED`→再 prepare/restart；未启用租约返回 `unenforced` 并沿用 `checkRevision`（不弱化默认关闭） |
| 实时授权 IPC | child 侧有界 `authorization`/`authorizationAck` 协议 + per-call gate：allow/deny/revoke；缺失/畸形/冲突 fail-closed，逐字重复幂等；拒绝为固定 MCP 错误且零上游 |
| 在线撤销零联网 | 挂起调用期间撤销：**0 HTTP/HTTPS/DNS、0 新连接/请求**、无重放、有界终止、持久 `security_revoked` |
| 依赖接线 | E3a `ManagedChildSecurityLeaseCoordinator` 接入 coordinator（`managedMcp.securityLease.enabled` 默认关闭、仅 trusted 路径构造） |

## 3. 边界

- `isolateSourceForUpdate` 是接线屏障（contract 级），不拦截文件系统级写入；仓库内尚无生产调用方（operator/Registry 更新需调用该屏障）。
- `authorize` 为 trusted-only API 接缝，无生产 controller 调用；child 不自行退出（由 host 强制终止，避免终端竞态）。
- 未覆盖：Registry watcher/推送、在途上游 abort（F3）、逐工具许可、Linux。
