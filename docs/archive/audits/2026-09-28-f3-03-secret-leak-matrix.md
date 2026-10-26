---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-F3-03 受管子进程秘密泄露矩阵证据（2026-09-28）

> Document status: Active evidence。合成秘密 + 回环上游 + 真实构建产物 child；15 渠道 904 项扫描 0 泄露；无生产部署/审计 sink。

## 1. 环境与执行

- 执行器：`npm run verify:f3-03 --workspace api-nova-api`（`scripts/verify-f3-03.cjs`），标记 `F3_03_VERIFY_OK`
- 环境：win32 x64，Node v24.15.0；三包构建后运行；9 个合成秘密（bearer/apiKey/customHeader/consumer/JWT/DB/legacy/OpenAPI marker），3 代生命周期、3 次 spawn、4 次工具调用、4 次回环上游请求
- 结果：**15/15 渠道、904 项扫描检查、0 泄露、16 项直接断言**；`failures: []`；检测器含非空洞自测（full/前8字符/禁用环境变量名）

## 2. 渠道覆盖（15）

1–2 OS 级 `Win32_Process` argv 与子进程自报 `process.argv/execArgv`；3–4 spawn 环境与子进程实际环境（owner 值精确、ambient 不继承）；5–7 子/父 stdout/stderr；8 异常面（重启拒绝/运行崩溃/陈旧 bootstrap 错误栈）；9 静态错误码格式；10 持久 store/snapshot/raw DB 行；11 协调器状态视图；12 状态变更事件；13 READY revisions/handle telemetry；14 管理日志投影（`log_entries` + `mcp_servers` ERROR）；15 管理审计可检索（`audit_logs` create/update/start/stop/delete，service 级真实 SQL.js）

## 3. 回归与边界

- 回归：channel 15/15、E1-02C2 10/10、E1-03 `E1_03_VERIFY_OK`（77/77+31 检查+Linux 4 项）、三包构建通过。
- `notCovered`：部署级 Nest HTTP/生产 DB 审计 sink、ProcessInfo（`trusted_ipc_v1` 不经 ProcessManager）、RuntimeObservability 事件 sink、Linux OS 级 argv；无外部网络/PG/生产启用。
