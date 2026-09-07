# Database Strategy

> Document status: Active
> Last reviewed: 2026-09-07

## Decision

ApiNova supports two first-class database modes:

- `SQLite`: default for local, evaluation, single-node, and light-load deployment
- `PostgreSQL`: recommended for production, multi-user, higher-write, and long-running deployment

The engines share one domain model but do not have identical scaling or operational characteristics.

## Current Contract

1. Database selection is configuration-driven through `DB_TYPE=sqlite|postgres`.
2. SQLite is the default and uses an explicit writable database path.
3. PostgreSQL remains the production recommendation.
4. Shared service logic must not depend on engine-specific SQL.
5. Database-specific types stay behind datasource dialect helpers；这些辅助函数服务于 PG/SQLite 双引擎，不承担历史版本兼容。
6. 开发阶段只支持从 canonical clean schema 初始化；不提供历史 schema/data 升级路径，结构变化时重建开发数据库。
7. 迁移目录只保留 SQLite/PostgreSQL 两个 canonical baseline；后置修补必须在合入前折叠回对应基线。

## Runtime Boundaries

### SQLite

Use SQLite when one ApiNova API instance manages a moderate number of assets and operational writes. It is not a shared database for multiple API replicas.

SQLite needs bounded operational data growth, a writable persistent file path, backup guidance, and controlled log/metric write rates.

### PostgreSQL

Use PostgreSQL for sustained multi-user operation, higher concurrent writes, longer retention, and future multi-instance evolution. PostgreSQL must not be reduced to SQLite's operational limits merely to keep a common schema.

## Data Classes

Lower-frequency configuration data includes users, permissions, documents, logical assets, runtime instances, memberships, credentials references, and publication configuration.

Potentially higher-frequency data includes test runs/samples, verification evidence, access logs, system logs, metrics, audit events, and health history. Retention and payload-size controls are especially important for the second group.

## Current Verification

The canonical model is verified from isolated empty databases:

```bash
npm run db:verify-isolated-sqlite --workspace api-nova-api
npm run db:verify-isolated-postgres --workspace api-nova-api
```

The current canonical target on 2026-09-07 is **40 domain tables** plus the migration ledger. `config_overrides` and `config_backups` are now part of both engine baselines; the separate compatibility migration was removed. Isolated SQLite initialization passes with zero schema drift and `DB_SYNCHRONIZE=false`. PostgreSQL SQL compiles with the API build, but isolated execution is environment-blocked because the configured local `postgres` credential was rejected; it remains pending as `EXT-11`.

Historical verification on 2026-07-22 (before the configuration persistence migration):

- 38 domain tables plus the migration ledger in each engine
- all nine runtime-closure core tables present
- zero domain rows in isolated databases
- no legacy source host/port columns
- UUID source-instance foreign key
- zero pending migrations
- isolated database cleanup after verification

The root gate runs both verifiers:

```bash
npm run verify:runtime-closure
```

## Reliability Requirements

Both modes require:

- explicit startup validation
- migration-only schema ownership in production
- secret redaction in persisted evidence
- bounded sample/log/metric/audit growth
- backup and recovery guidance
- failed-migration visibility

SQLite additionally requires single-instance deployment and a durable writable volume. PostgreSQL additionally requires connection, credential, availability, and operational backup management.

## Known Open Work

Payload-size policies, binary evidence handling, retention classes, and cleanup jobs for test and verification evidence remain open as `DEV-04` in `docs/reference/open-items.md`. Windows interactive and Ubuntu database-path verification remain in the external acceptance matrix.

## Release Acceptance

Database support is release-ready only when:

1. both isolated verifiers pass;
2. application startup succeeds using the documented configuration for each engine;
3. Windows and Ubuntu paths are verified;
4. retention and backup boundaries are documented honestly;
5. no active guide claims historical table counts or schema compatibility.
