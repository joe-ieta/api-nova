---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-08
---
# Database Strategy

> Document status: Active
> Last reviewed: 2026-09-08

## Current Contract

- SQLite is the default for a single API instance and a durable writable file.
- PostgreSQL is supported for higher write concurrency and multi-user deployments.
- Only `DB_TYPE=sqlite|postgres` is accepted. An unsupported value fails startup.
- Both engines use `DATABASE_ENTITIES` and `buildDatabaseOptions()`: 41 entity classes, 43 domain tables including two junction tables.
- `database-dialect.ts` expresses real JSON, enum, UUID, timestamp and IP differences; it is not a historical-data compatibility layer.
- This initial-development project supports only clean initialization. No old-table conversion, data backfill, automatic repair, or historical migration chain is maintained.
- Each engine has exactly one initial migration. Runtime `synchronize` is always false; `DB_SYNCHRONIZE=true` is rejected.
- Configuration imports use only `config-overrides/v1`; unknown fields, duplicate keys, mismatched types and older formats are rejected atomically.

## Environment And Initialization

The application and migration CLI load the same API-package environment files: explicit process variables first, then `.env.local`, `.env.<NODE_ENV>`, and `.env`. `API_NOVA_ENV_FILE` can explicitly select one existing file. Tests do not load environment files unless explicitly selected.

Entity decorators are loaded after environment initialization. Starting from another working directory does not change the selected API environment file. Relative SQLite paths resolve from the workspace root.

For a deliberately selected NEW empty application database:

```bash
npm run build --workspace api-nova-api
npm run migration:run --workspace api-nova-api
npm run start:dev --workspace api-nova-api
```

The migration command targets the configured database. Confirm its identity and emptiness first. Do not run the initial migration on an existing business database. First API startup provisions required roles/users, so a running application database is no longer blank.

## Isolated Empty Databases And Smoke Tests

These commands create uniquely named databases/files instead of resetting the configured business database:

```bash
npm run build --workspace api-nova-api
npm run db:create-empty --workspace api-nova-api -- sqlite
npm run db:create-empty --workspace api-nova-api -- postgres
npm run db:smoke --workspace api-nova-api -- sqlite --keep
npm run db:smoke --workspace api-nova-api -- postgres --keep
```

PostgreSQL credentials come from the API environment file; the account needs permission to create a temporary database. `DB_ADMIN_DATABASE` defaults to `postgres`. The configured `DB_DATABASE` is not used as the smoke target.

`create-empty` retains an empty schema without seeds. `smoke` checks migration ownership, exact tables, zero rows, zero pending migrations, zero schema drift, JSON primitives, CRUD, rollback/unique constraints, process persistence, API startup, and anonymous management denial. It removes its own seeded test rows before verifying emptiness again. Omit `--keep` to remove the test-owned database after a successful smoke. Retained paths and database names are printed and written to `tmp/database-cleanup-*/result.json`.

## Schema Artifacts And Regeneration

The checked-in schema exports are `packages/api-nova-api/database/sqlite-schema.sql` and `postgres-schema.sql`. They contain no seed data and no TypeORM migration ledger. Use the corresponding initial migration for application initialization; do not apply a SQL export and then run that migration again on the same database.

After changing the shared entity model:

```bash
npm run build --workspace api-nova-api
npm run db:generate-schema --workspace api-nova-api -- sqlite
npm run db:generate-schema --workspace api-nova-api -- postgres
npm run build --workspace api-nova-api
npm run verify:runtime-closure
```

Generation uses isolated new databases and replaces the initial migration/export for each dialect. It is a development operation, not an upgrade of an existing database. Discarding existing development data requires its owner's explicit approval.

## Verification And Boundaries

On 2026-09-08, both real local engines passed the 43-table empty-schema, persistence and complete API-startup smoke with zero drift and automatic synchronization disabled. The missing `process_info`, `process_logs`, and `health_check_results` tables are now included. SQLite enum-length metadata no longer causes repeated table rebuilds.

See [Persistence Cleanup Review](../audits/2026-09-08-persistence-cleanup.md) for commands, retained databases, regressions and evidence. Older 38/40-table results describe historical models only.

SQLite still requires one API instance and a durable writable volume. PostgreSQL needs operational backup, connection and permission management. Payload retention, production fault/load testing, real upstream publication and Ubuntu acceptance remain separate work in [Open Items](../reference/open-items.md).
