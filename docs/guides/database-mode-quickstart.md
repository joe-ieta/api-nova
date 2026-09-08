---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-08
---
# Database Mode Quickstart

> Document status: Active
> Last reviewed: 2026-09-08

This project supports two database modes:

- `SQLite`: default, simplest local path
- `PostgreSQL`: optional, stronger operational path for heavier deployment

They are complementary modes, not replacement relationships.

## SQLite

Use SQLite when you want the fastest single-machine setup.

Example `packages/api-nova-api/.env`:

```env
NODE_ENV=development
PORT=9001
MCP_PORT=9022

DB_TYPE=sqlite
DB_SQLITE_PATH=data/api-nova.db

JWT_SECRET=change-this-jwt-secret
JWT_REFRESH_SECRET=change-this-refresh-secret
API_KEY=change-this-api-key
```

Initialize a NEW empty database, then start (the migration targets the API environment file):

```bash
npm run build --workspace api-nova-api
npm run migration:run --workspace api-nova-api
node packages/api-nova-api/dist/src/main.js
```

Notes:

- if `DB_TYPE` is omitted, the API still defaults to SQLite
- `DB_HOST`, `DB_PORT`, and `DB_DATABASE` alone do not switch runtime to PostgreSQL
- `DB_SQLITE_PATH` may be absolute, or relative to the repository root
- the default SQLite file resolves to `data/api-nova.db` under the repository root
- startup logs should print `Database mode: sqlite`
- this is the recommended baseline for local development and light-load use

## PostgreSQL

Use PostgreSQL when you need a stronger long-running deployment posture.

Create the database:

Windows PowerShell:

```powershell
psql -U postgres -h localhost -p 5432 -c "CREATE DATABASE api_nova_api;"
```

Ubuntu:

```bash
sudo -u postgres psql -c "CREATE DATABASE api_nova_api;"
```

Example `packages/api-nova-api/.env`:

```env
NODE_ENV=development
PORT=9001
MCP_PORT=9022

DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your-postgres-password
DB_DATABASE=api_nova_api

JWT_SECRET=change-this-jwt-secret
JWT_REFRESH_SECRET=change-this-refresh-secret
API_KEY=change-this-api-key
```

Notes:

- startup logs should print `Database mode: postgres`
- PostgreSQL mode is active only when `DB_TYPE=postgres` is set explicitly
- PostgreSQL is recommended for heavier write volume and multi-user operation

For an isolated blank database or smoke test, without resetting the configured database:

```bash
npm run build --workspace api-nova-api
npm run db:create-empty --workspace api-nova-api -- postgres
npm run db:smoke --workspace api-nova-api -- postgres --keep
```

The command prints a new database name. Set `DB_DATABASE` to that name if you choose to use it. It already contains the initial migration; starting the API will add required seed users/roles.

For an explicitly selected NEW empty application database, run `npm run migration:run --workspace api-nova-api` before starting the API. Never apply the initial migration to an existing business schema. Automatic schema synchronization is disabled in every mode.

See [Database Strategy](database-strategy.md) for both SQL exports, environment precedence and schema regeneration.

## Product Guidance

Choose SQLite when:

- the service is deployed on a single machine
- write volume is light
- simplicity matters more than shared concurrency

Choose PostgreSQL when:

- the service is expected to run long term
- multiple operators or higher write concurrency are expected
- stronger operational isolation and recovery behavior are needed

## Concurrency Position

SQLite is acceptable for the current small-scale single-machine path, especially when simplicity is the priority.

PostgreSQL remains the better choice when concurrency, operational durability, and heavier background activity become more important.
