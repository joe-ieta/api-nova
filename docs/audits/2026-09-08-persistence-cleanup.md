---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-08
---
# Persistence And Compatibility Cleanup Review

> Document status: Completed local review and verification record
> Reviewed: 2026-09-08
> Workspace: E:\CodexDev\api-nova
> Scope: initial-development cleanup after the reviewed merge

## Outcome And Safety Boundary

The current checkout now uses one complete database entity registry, one configuration-loading path, and one initial migration per database engine. Historical persistence formats are not converted or silently repaired. Both isolated SQLite and real local PostgreSQL passed schema, persistence and full API-startup smoke tests.

This review concerns the merged current checkout; it does not attribute every pre-existing issue to the other repository. The earlier [reviewed merge record](2026-09-07-reviewed-merge.md) remains historical evidence.

The PostgreSQL account was loaded from the local API environment file without publishing credentials. All schema generation and database smoke operations created their own uniquely named databases/files. The existing configured business databases and actual environment files were not reset or modified.

The previously approved environment-example change was committed separately as `6bb27fa`. This cleanup and its documentation remain uncommitted; this step does not push changes.

Per the user's explicit instruction, these unrelated files were left untouched during documentation completion:

- `docs/README.md`
- `docs/guides/runtime-observability-requirements.md`
- `docs/reference/runtime-observability-design.md`

## Findings And Resolutions

| ID | Priority | Finding | Resolution and evidence |
| --- | --- | --- | --- |
| PC-01 | P1 | The migration datasource omitted active process and health entities registered by the application. A clean baseline could pass an incomplete registry check while required runtime tables were absent. | One shared 41-class registry now initializes 43 domain tables, including two junction tables and all three process/health tables. Both database smoke tests pass exact table-set and zero-drift checks. |
| PC-02 | P1 | Configuration imports accepted incomplete/older records, could partially apply changes and reported success without a single durable transaction. | Strict `config-overrides/v1` validation rejects duplicates, unknown fields and wrong types. Replacement plus import audit is transactional; the in-memory cache changes only after commit. API regression covers invalid input and failed persistence. |
| PC-03 | P1 | Session persistence tolerated malformed/legacy data and could lose state across concurrent writes or failed persistence. | Only the versioned session envelope is supported. Corrupt files fail closed without overwrite. Mutations are serialized and written through a temporary-file rename; memory changes only after the write succeeds. Persistence smoke covers concurrency, reload and malformed-file protection. |
| PC-04 | P1 | Development bootstrap could reactivate or unlock an existing administrator. | Existing account security state is preserved. Normal provisioning of missing initial users/roles remains. A dedicated seed regression covers this boundary. |
| PC-05 | P2 | Application and migration configuration had duplicated entity/options lists and inconsistent environment-file selection. | Shared environment initialization precedes entity decorators. Both entry points use `buildDatabaseOptions()`; unknown database types fail, automatic synchronization is disabled, and only the matching initial migration is loaded. |
| PC-06 | P2 | SQLite enum length metadata for process status/log level was not represented by the actual schema, causing repeated table-rebuild proposals. | Enum lengths are omitted for both engines. The initial SQLite smoke exposed 14 pending schema queries; after the fix, both database checks report zero drift without relaxing assertions. |
| PC-07 | P2 | Legacy flat headers/filters, duplicate wrappers, mock configuration migration UI, old storage keys and derived WebSocket events expanded the maintenance surface. | Removed the old branches and unused `node-persist` dependency. Canonical structured configuration, real API-backed configuration UI and canonical runtime events remain. Full builds and Server smoke tests pass. |

Relevant implementation:

- [Shared entity registry](../../packages/api-nova-api/src/database/database.entities.ts)
- [Shared database options](../../packages/api-nova-api/src/database/database-options.ts)
- [Environment initialization](../../packages/api-nova-api/src/config/environment.ts)
- [Database dialect mapping](../../packages/api-nova-api/src/database/database-dialect.ts)
- [Transactional configuration imports](../../packages/api-nova-api/src/config/app-config.service.ts)
- [Session persistence](../../packages/api-nova-server/src/interactive-cli/managers/session-manager.ts)
- [Database generation and smoke tool](../../packages/api-nova-api/scripts/database-tool.cjs)
- [Session/configuration smoke](../../packages/api-nova-server/scripts/persistence-smoke.js)

## Intentional Breaking Changes

- Historical database schemas are not upgraded. Schema changes require a separately approved new development database, not automatic migration of existing business data.
- The old baseline migrations and four duplicated database verifier scripts were replaced by the initial migrations and unified tool.
- Session files must use `api-nova-sessions/v1`; old raw arrays and malformed JSON are rejected, not overwritten or converted.
- Configuration imports must use `config-overrides/v1`. No best-effort migration, skipped invalid records, or string-to-boolean coercion is performed.
- Headers use structured `static/env/dynamic/conditional` configuration. CLI header arguments use `KEY=VALUE`, not the old colon format.
- Operation filters use structured include/exclude fields. Legacy flat-array configurations are rejected.
- Browser preferences use the current `api-nova-*` keys without reading old branded keys. Existing old-key preferences are not migrated.
- Canonical runtime WebSocket events replace the legacy derived events and duplicate subscriptions.

Real cross-engine SQL adaptation, supported OpenAPI/Swagger input handling, MCP transports and currently used managed-server operations are not historical persistence compatibility and remain supported.

## Executed Verification

All commands below ran on Windows against this cleanup checkout. Counts are actual observed results, not inferred from compilation.

| Command | Result |
| --- | --- |
| `npm run build` | Parser, Server, API and UI production builds passed, including UI type checking. |
| `npm run test --workspace api-nova-parser -- --runInBand` | 8 suites, 30 tests passed. |
| `npm run test --workspace api-nova-api -- --runInBand` | 45 suites, 237 tests passed after the final enum fix. |
| `npm run test --workspace api-nova-server` | 6 smoke groups passed: CLI, basic runtime, multi-session, direct specification transformation, runtime security/audit and persistence. |
| `npm run db:smoke --workspace api-nova-api -- sqlite --keep` | `DATABASE_SMOKE_OK`: 43 domain tables, empty, zero drift, persistence and API startup passed. |
| `npm run db:smoke --workspace api-nova-api -- postgres --keep` | Same checks passed against a newly created real local PostgreSQL database. |
| `npm run verify:runtime-closure` | 9 stages passed, including 13 selected API suites / 109 tests and repeat database smokes with owned-database cleanup. |
| `npm run verify:runtime-security-integration` | `RUNTIME_SECURITY_INTEGRATION_OK`: 7 checks, 3 upstream calls, 4 HTTPS JWKS reads. |
| `git diff --check` | Passed before the documentation-only completion. |

Database checks exercised exact table identity, zero business rows, zero pending migrations, zero TypeORM schema drift, JSON primitive/nested values, CRUD, unique-constraint rollback, explicit transaction rollback and process/health record persistence. SQLite also passed integrity and foreign-key checks.

Each database smoke then started the actual API, confirmed anonymous management requests return HTTP 401 and bootstrap users were persisted, stopped its child process, cleared only its own test database's domain rows, and rechecked emptiness. The migration ledger intentionally remains.

The security integration used real API/MCP processes, a local HTTPS proxy and JWKS fixture, verified credential isolation and key rotation, and checked cross-process caller identity and payload evidence. It is not a real external-provider login/consent or full publication-workflow acceptance test.

Initial cleanup validation found two stale TypeScript references and the SQLite enum drift. These were corrected with user authorization, then the relevant complete builds/tests/gates were rerun successfully. The record does not omit those intermediate failures.

Local command logs remain under `%TEMP%` with names `api-nova-cleanup-build.log`, `api-nova-cleanup-api-tests.log`, `api-nova-cleanup-parser-tests.log`, `api-nova-cleanup-server-tests.log`, `api-nova-cleanup-runtime-gate.log` and `api-nova-cleanup-integration.log`. They are local evidence, not committed artifacts.

## Retained Blank Databases

Both retained databases contain 43 empty domain tables plus the migration ledger. They are blank after smoke cleanup, not seeded application snapshots.

| Engine | Retained target | Evidence |
| --- | --- | --- |
| SQLite | `E:\CodexDev\api-nova\tmp\database-cleanup-sqlite-17792_1788841294650\empty.sqlite` | `tmp/database-cleanup-sqlite-17792_1788841294650/result.json` |
| PostgreSQL | `api_nova_verify_3568_1788841304690` on the locally configured PG instance | `tmp/database-cleanup-postgres-3568_1788841304690/result.json` |

No environment setting was switched to these targets. To use one, deliberately select its `DB_SQLITE_PATH` or `DB_DATABASE` before starting the API. First startup adds required users/roles and therefore ends its blank state. The retained SQLite file is a local `tmp` artifact, not a production storage location.

## Reusable Schema Artifacts And Commands

- [SQLite schema-only SQL](../../packages/api-nova-api/database/sqlite-schema.sql)
- [PostgreSQL schema-only SQL](../../packages/api-nova-api/database/postgres-schema.sql)
- [SQLite initial migration](../../packages/api-nova-api/src/database/migrations/1788825600000-InitialSqliteSchema.ts)
- [PostgreSQL initial migration](../../packages/api-nova-api/src/database/migrations/1788825601000-InitialPostgresSchema.ts)
- [Database operation guide](../guides/database-strategy.md)

The SQL exports contain schema only, without seeds or a TypeORM migration ledger. Use the initial migration for application initialization. Do not apply an export and then rerun the initial migration on the same schema.

```bash
npm run build --workspace api-nova-api
npm run db:create-empty --workspace api-nova-api -- sqlite
npm run db:create-empty --workspace api-nova-api -- postgres
npm run db:smoke --workspace api-nova-api -- sqlite --keep
npm run db:smoke --workspace api-nova-api -- postgres --keep
```

The commands create new targets. PostgreSQL requires permission to create a database, using `DB_ADMIN_DATABASE` or `postgres` for the administrative connection. Omit `--keep` from smoke commands to delete only their own temporary targets.

## Residual Risks And Acceptance Boundaries

- The full UI build passes, but interactive browser workflows and Ubuntu execution were not performed in this cleanup.
- Existing UI circular-chunk/third-party annotation warnings remain. PG client query-queue and Windows shell-spawn deprecation warnings were observed; no dependency-major upgrade is claimed.
- Local PostgreSQL initialization/startup is now verified, resolving the previous local `EXT-11` blocker. Production configuration, backup/restore, external identity providers and real upstream publication remain separate acceptance work.
- Transaction/rename regression coverage is not a guarantee against power loss, disk exhaustion, multiple independent session-writer processes, or production load.
- The cleanup does not claim a production-grade audit queue, retention system or complete historical-data migration support.
- Prior 38/40-table reports remain valid as historical observations only. They were not rewritten to imply current 43-table coverage.

This final documentation step changes no application code, does not rerun the already completed test matrix, and makes no commit or push.
