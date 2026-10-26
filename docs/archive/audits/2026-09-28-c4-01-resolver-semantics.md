---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-C4-01 运行时 Resolver 执行语义联合证据（2026-09-28）

> Document status: Active evidence。Gateway 代理路径与 MCP 工具路径在同一绑定下的继承/覆盖/None/Unresolved 一致性；不重写 Resolver。

## 1. 环境与执行

- 执行器：`npm run verify:c4-01 --workspace api-nova-api`，标记 `C4_01_VERIFY_OK`，**exit 0**（含 `C4_01_FORCE_FAIL` 反向门控）
- 结果：API **8/8 套件 92/92 测试**、Parser **5/5 套件 110/110**、managed handoff **32/32** + channel **15/15**、E1-03 真实 child 矩阵全绿
- 新增联合 spec：`credential-execution-semantics.c4-01.http.spec.ts`（1 套件/10 项，真实回环 HTTP）
- 回归：gateway-runtime **56/794**（含新增 1/10）、publication 21/252、servers 27/173、API build/type-check；f1-02f/f1-02c3g5/g6/f1-02e3b/f3-03/e1-04 全绿

## 2. 覆盖

| 语义 | 结果 |
| --- | --- |
| 继承 | Site/Endpoint 继承（listed/unlisted）在 Gateway 与 MCP 同绑定下决策一致 |
| 覆盖 | endpoint 级覆盖生效；未选中的继承凭据**不出现在上游线上** |
| None | 不发送任何凭据；consumer/Axios ambient/legacy env/custom header **无回退** |
| Unresolved | removed provider row、策略未解析、scope/site 未命中在**秘密读取、网络与 cache 之前**拒绝（固定码 `gateway_upstream_credential_unavailable` / `UPSTREAM_CREDENTIAL_UNAVAILABLE`），无 cache 条目、无部分状态且可恢复；不支持 provider 引用在激活期拒绝并保旧快照 |
| default-off | registry 语义 opt-in，legacy 路径 parity 保持 |

## 3. 边界

- 受管 child 真实路径由 E1-03 聚合（inherit/override/None=N1、unresolved=N3/N4），child IPC permit 归 G6/E3b；PG 重开/并发归 F1-02F；无真实 vault/外网；仅 Windows。
- 环境注意（预先存在）：4 个 `gateway-header-*` 历史套件要求 `TEMP` 与磁盘真实大小写一致（`E:\Temp`），否则 `CONFIGURATION_READ_FAILED`；非本包引入。
