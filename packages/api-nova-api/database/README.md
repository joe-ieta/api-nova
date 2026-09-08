# Initial Database Schemas

These exports are generated from the application's shared entity registry. Both engines contain 43 domain tables; the exports contain no seed records and no TypeORM migration ledger.

- `sqlite-schema.sql`: standalone SQLite schema-only DDL.
- `postgres-schema.sql`: standalone PostgreSQL schema-only DDL, including required enum/UUID support.

For application initialization, use the matching initial TypeORM migration against a deliberately selected NEW empty database. Do not apply an SQL export and then run the initial migration again on the same schema. Existing business databases are not upgrade targets.

## Safe Isolated Creation

Run from the repository root:

```bash
npm run build --workspace api-nova-api
npm run db:create-empty --workspace api-nova-api -- sqlite
npm run db:create-empty --workspace api-nova-api -- postgres
```

The commands retain a uniquely named empty database/file and print its location. PostgreSQL connection credentials are loaded from the API package environment files; the account needs database-creation permission. The configured business database is not reset.

## Persistence And Startup Smoke

```bash
npm run db:smoke --workspace api-nova-api -- sqlite --keep
npm run db:smoke --workspace api-nova-api -- postgres --keep
```

Each smoke verifies schema equality, emptiness, transactions and complete API startup, then removes only its own test rows and verifies the blank schema again. Omit `--keep` to remove the owned database entirely.

## Regenerate After Entity Changes

```bash
npm run build --workspace api-nova-api
npm run db:generate-schema --workspace api-nova-api -- sqlite
npm run db:generate-schema --workspace api-nova-api -- postgres
npm run build --workspace api-nova-api
npm run verify:runtime-closure
```

Generation replaces the initial migration and export for each dialect using isolated new databases. It does not generate a historical upgrade chain. Runtime automatic synchronization remains disabled.

See [Database Strategy](../../../docs/guides/database-strategy.md) and [Cleanup Review](../../../docs/audits/2026-09-08-persistence-cleanup.md) for configuration precedence, actual retained targets, test evidence and operational limits.
