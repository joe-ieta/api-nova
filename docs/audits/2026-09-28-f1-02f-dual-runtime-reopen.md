---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-F1-02F 双运行时端到端与持久重开证据（2026-09-28）

> Document status: Active evidence。Gateway + MCP 双运行时、SQL.js + 隔离 PostgreSQL 16.10；Verified/canPublish 未开放。

## 1. 环境与执行

- 执行器：`npm run verify:f1-02f --workspace api-nova-api`（`API_NOVA_TEST_PG_BIN=E:\Programs\PostgreSQL\16\bin`），标记 `F1_02F_VERIFY_OK`，**exit 0**
- 结果：聚合 **18/18 套件、165/165 测试**；含 `F1_02F_FORCE_FAIL` 反向验证（失败打印 `F1_02F_VERIFY_FAILED` 且非零退出）
- 隔离 PG：16.10，**73 表/8 迁移**，重开零漂移、撤销持久、双连接并发竞态 `winners:1, losers:1`（失败方序列化冲突）→ revision+1；集群停止并删除

## 2. 覆盖

| 条款 | 结果 |
| --- | --- |
| 双运行时端到端 | 真实 Nest HTTP Gateway（proof provider 启用 + default-off 对照、保护路由保持 E1-Verified-closed）与真实 MCP Streamable HTTP（受信 single-hop、保护工具联网前 `UPSTREAM_SECURITY_UNVERIFIED`、秘密轮换重解析） |
| 持久重开 | SQL.js 与真实 PG：激活/guard/membership/撤销跨重开保持；零漂移；无迁移重放 |
| 并发迟到 | 迟到 proof/激活/发布拒绝；重复/交错发布单一胜者；PG 双连接并发恰好一胜 |
| 同 revision Provider 变化 | 生产修正：pinned evaluation 在 `toValidator`/`assertTransactionCurrent` 边界**重新授权**（`publication_evaluation_context_changed`/`publication_transaction_context_changed`），同 revision 秘密轮换无法复用旧证据发布（无 schema） |

## 3. 边界

- 跨进程发布竞态仍由 `verify:c3-03` 覆盖（本项 PG 并发为同进程双连接；另在 SQL.js 与 PG 乐观 CAS 路径验证）；受管 child IPC permit 路径由 G6/E3b 覆盖，未在本 runner 重跑。
- Provider 轮换使用注入的受信 provider（外部 vault 不真实）；Verified/canPublish 保持关闭、未注册生产 DI；仅 Windows。
