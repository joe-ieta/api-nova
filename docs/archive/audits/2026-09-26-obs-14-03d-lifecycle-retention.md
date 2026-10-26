---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# OBS-14-03D 投递/尝试保留与导入墓碑（Windows 本地）

> Document status: Active evidence。仅 Windows x64、Node v24.15.0、SQL.js；物理删除默认关闭。PostgreSQL 并发/多进程未验（归 OBS-14-05C3/平台项）。

## 1. 环境与命令

- 提交：`8acc955`（以实际提交为准）
- 核心命令：`npm test --workspace api-nova-api -- --runInBand call-observability-lifecycle-retention`
- 回归：`call-observability` 模块套件、`test-call-observability-{deliveries,outbox,webhook-worker,api-foundation,collector}.cjs`

## 2. 交付范围

- 新增 `RuntimeIngestReceiptTombstoneEntity`（`runtime_ingest_receipt_tombstones`，唯一 `(sourceInstanceId,eventId)`），并同步 SQLite/PostgreSQL schema 与两份 Initial 迁移。
- `call-observability.store.ts` 增加墓碑读取门禁：receipt 仍在时以其为准；receipt 被物理删除后，同身份同 hash → `duplicate`（不新增调用/事件/序号），同身份不同 hash → `SOURCE_EVENT_CONFLICT` 隔离。
- 新增 `call-observability-lifecycle-retention.service.ts`：单事务三阶段有界清理（幂等记录 → receipt 墓碑化+删除 → 投递/尝试删除），持久游标、无 `nextSequence()`；投递候选按 `expiresAt`+30天创建下限、非 in_flight、无活跃租约、无未完成 attempt，并受未过期幂等结果 `resourceId` 保护；墓碑无 TTL。
- 新增默认关闭 worker（`API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_*`，`evidenceScope: lifecycle_retention`）。

## 3. 本次结果

| 验证 | 结果 |
| --- | --- |
| 新专项 `call-observability-lifecycle-retention.spec.ts` | 12/12 |
| `call-observability` 模块套件 | 11 suites / 94 tests |
| `test-call-observability-deliveries.cjs` | 9/9 |
| `test-call-observability-outbox.cjs` | 12/12 |
| `test-call-observability-webhook-worker.cjs` | 12/12 |
| `test-call-observability-api-foundation.cjs` | 56/56 |
| `test-call-observability-collector.cjs` | 14/14（本次修正 2 项因在途 delta 事件而陈旧的计数断言） |
| `database-tool.cjs create sqlite` | 73 实体/73 表、schemaDrift 0 |

覆盖：29/30 天边界、事件先到期仍可查且拒绝重投、在途租约/未完成 attempt 保护、receipt 32 天边界、原文件/改名文件重放不增计数、hash 冲突仍隔离、24 小时幂等到期后可重执行、有效幂等结果保护对象、三阶段事务失败回滚、审计行不被级联删除、重启分页恢复、默认关闭与严格配置、双 schema/迁移同步。

## 4. 非声明

- 物理删除保持默认关闭；墓碑在本叶不退休（数据集退休流程未实现）。
- PostgreSQL 真实并发/多进程、Linux、长时间运行与部署签收未验。
