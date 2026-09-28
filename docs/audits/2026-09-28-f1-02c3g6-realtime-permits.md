---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-F1-02C3G6 MCP/Child 实时许可与撤销长链证据（2026-09-28）

> Document status: Active evidence。逐次执行实时许可 + 撤销传播；proof/capability 不序列化、不过 IPC。

## 1. 环境与执行

- 执行器：`npm run verify:f1-02c3g6`（根 `scripts/verify-f1-02c3g6.cjs`），标记 `F1_02C3G6_VERIFY_OK`，exit 0（**54 项检查**，真实构建产物 child）
- 单元：新增 3 套件 / 17 项；servers **27 suites / 173 tests**（基线 24/156）
- 回归：verify:f1-02e3b 49 检查、e1-03、e1-04、f3-03 全绿；API/Server 构建通过
- 注：与 G5 验证并发时 1 次负载竞争超时；隔离复跑通过（以隔离结果为准）。

## 2. 行为

| 能力 | 结果 |
| --- | --- |
| 逐次实时许可 | host 侧 G1 capability 按执行消费（source/endpoint/target/method/binding epoch）；child 经有界 IPC `permitMode`/`permitRequest`/`permitDecision`/`permitModeAck` 逐调用复核；拒绝固定码 `MANAGED_TOOL_EXECUTION_DENIED` 且零上游 |
| 撤销传播 | 挂起调用撤销：0 HTTP/HTTPS/DNS、0 新连接/请求、有界终止（<9s）、无重放、持久 `security_revoked`、authority 终结、迟到 authorize 拒绝 |
| 幂等/失败关闭 | 重复 permitMode/authorization 幂等；冲突/畸形事件 fail-closed；每调用重放不产生第二次上游 |
| proof 不序列化 | 合成值与字段名扫描（IPC、持久行、状态变更、stdout/stderr、argv/env、上游线上）全清；capability token 序列化为 `{}` 且 JSON/clone 往返被拒 |
| 重启 | 重新准备需全新每-launch 许可；默认关闭时无 permit 流量 |

## 3. 边界

- 在途上游请求主动 abort 归 F3（同 E1-04 边界）；仅显式触发器（无 watcher/推送）；Linux 未在 runner 覆盖（E2-02 双平台独立）；G1 challenge transport 未重跑（消费同一 in-process capability 语义并直接断言 token 不可序列化）；生产 permit provider 为 trusted-only 构造接缝。
