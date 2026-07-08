# Local Setup And Run

This is the active setup and run baseline for the current product path.

It covers:

- Windows PowerShell
- Linux, especially Ubuntu
- API, UI, and runtime CLI startup
- SQLite default mode and PostgreSQL optional mode

## 1. Prerequisites

Required:

- Node.js `>= 20`
- `npm >= 10`

Optional:

- PostgreSQL `>= 14` when using the heavier deployment mode
- GitHub CLI `gh` when creating PRs or releases from the command line

Windows PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify:

```bash
node -v
npm -v
```

## 2. Install Dependencies

Run from repository root.

Windows PowerShell:

```powershell
cd E:\CodexDev\api-nova-server
npm install
```

Ubuntu:

```bash
cd /path/to/api-nova-server
npm install
```

## 3. Choose Database Mode

Two product modes are supported:

- `SQLite`: default, single-machine, light-load, easiest to use
- `PostgreSQL`: optional, heavier deployment, higher concurrency, better fit for long-running multi-user operation

### 3.1 SQLite default mode

Copy the API env template:

Windows PowerShell:

```powershell
Copy-Item packages\api-nova-api\.env.example packages\api-nova-api\.env
```

Ubuntu:

```bash
cp packages/api-nova-api/.env.example packages/api-nova-api/.env
```

Recommended minimum env:

```env
NODE_ENV=development
PORT=9001
MCP_PORT=9022

DB_TYPE=sqlite
DB_SQLITE_PATH=data/api-nova.db

JWT_SECRET=change-this-jwt-secret
JWT_REFRESH_SECRET=change-this-refresh-secret
API_KEY=change-this-api-key

SUPER_ADMIN_USERNAME=admin
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD=Admin@123456
```

Notes:

- if `DB_TYPE` is omitted, the API defaults to `sqlite`
- if `packages/api-nova-api/.env` only contains `DB_HOST` / `DB_PORT` / `DB_DATABASE` but omits `DB_TYPE`, runtime still uses SQLite instead of PostgreSQL
- `DB_SQLITE_PATH` may be absolute, or relative to the repository root
- with the default setting, the SQLite file resolves to `data/api-nova.db` under the repository root
- startup logs should report `Database mode: sqlite`

### 3.2 PostgreSQL optional mode

Create the database first.

Windows PowerShell:

```powershell
psql -U postgres -h localhost -p 5432 -c "CREATE DATABASE api_nova_api;"
```

Ubuntu:

```bash
sudo -u postgres psql -c "CREATE DATABASE api_nova_api;"
```

Then configure `packages/api-nova-api/.env`:

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

SUPER_ADMIN_USERNAME=admin
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD=Admin@123456
```

Notes:

- startup logs should report `Database mode: postgres`
- PostgreSQL mode is enabled only when `DB_TYPE=postgres` is set explicitly
- PostgreSQL remains the recommended mode for heavier and longer-running deployments

Clean reinitialization path:

Windows PowerShell:

```powershell
psql -U postgres -h localhost -p 5432 -d postgres -c "DROP DATABASE IF EXISTS api_nova_api;"
psql -U postgres -h localhost -p 5432 -d postgres -c "CREATE DATABASE api_nova_api;"
```

Ubuntu:

```bash
sudo -u postgres psql -d postgres -c "DROP DATABASE IF EXISTS api_nova_api;"
sudo -u postgres psql -d postgres -c "CREATE DATABASE api_nova_api;"
```

Recommended validation after switching to PostgreSQL:

Windows PowerShell:

```powershell
cd E:\CodexDev\api-nova-server
npm run build --workspace api-nova-api
$env:DB_TYPE="postgres"
npm run test --workspace api-nova-api -- --runInBand
node packages\api-nova-api\dist\src\main.js
```

Ubuntu:

```bash
cd /path/to/api-nova-server
npm run build --workspace api-nova-api
DB_TYPE=postgres npm run test --workspace api-nova-api -- --runInBand
DB_TYPE=postgres node packages/api-nova-api/dist/src/main.js
```

Validation points:

- startup log prints `Database mode: postgres`
- startup log prints the target PostgreSQL host, port, and database
- `GET http://localhost:9001/api/health/live` returns `200`
- `GET http://localhost:9001/api/system/initialization` returns initialized status

Current verified baseline:

- SQLite default path: build + test + startup
- PostgreSQL path: database recreation, schema initialization, seed initialization, health endpoint, initialization endpoint, and full package test pass

## 4. Build Commands

From repository root:

```bash
npm run build
```

Per-package build:

```bash
npm run build --workspace api-nova-parser
npm run build --workspace api-nova-server
npm run build --workspace api-nova-api
npm run build --workspace api-nova-ui
```

If parser behavior changed, run:

```bash
npm run verify:parser-chain
```

For broader downstream verification:

```bash
npm run verify:parser-chain:full
```

## 5. Start Commands

### 5.1 Start API

Development mode:

```bash
npm run start:dev --workspace api-nova-api
```

Built mode:

Windows PowerShell:

```powershell
npm run build --workspace api-nova-api
node packages\api-nova-api\dist\src\main.js
```

Ubuntu:

```bash
npm run build --workspace api-nova-api
node packages/api-nova-api/dist/src/main.js
```

Main addresses:

- API base: `http://127.0.0.1:9001/api`
- API docs: `http://127.0.0.1:9001/api/docs`
- health: `http://127.0.0.1:9001/health`

### 5.2 Start UI

```bash
npm run dev --workspace api-nova-ui
```

Main address:

- UI: `http://127.0.0.1:9000/`

The default dev proxy target is:

- `http://127.0.0.1:9001`

### 5.3 Start Runtime CLI

Windows PowerShell:

```powershell
npm run build --workspace api-nova-server
node packages\api-nova-server\dist\cli.js --openapi .\examples\minimal-openapi.json --transport streamable --port 9022
```

Ubuntu:

```bash
npm run build --workspace api-nova-server
node packages/api-nova-server/dist/cli.js --openapi ./examples/minimal-openapi.json --transport streamable --port 9022
```

Main addresses:

- MCP endpoint: `http://127.0.0.1:9022/mcp`
- CLI health: `http://127.0.0.1:9022/health`

Notes:

- `/mcp` is an MCP protocol endpoint, not a browser page
- direct browser access without MCP headers is expected to fail
- concurrent Streamable HTTP sessions are part of the current baseline

## 6. Minimal Run Order

### SQLite path

1. `npm install`
2. Copy `.env.example` to `packages/api-nova-api/.env`
3. Keep `DB_TYPE=sqlite` or omit it
4. Start API
5. Open `http://127.0.0.1:9001/api/docs`
6. Start UI if needed
7. Start runtime CLI if MCP endpoint testing is needed

### PostgreSQL path

1. Start PostgreSQL
2. Create database `api_nova_api`
3. Configure `packages/api-nova-api/.env`
4. Set `DB_TYPE=postgres`
5. Start API
6. Open `http://127.0.0.1:9001/api/docs`
7. Start UI if needed

## 7. Verification Commands

Core checks:

```bash
npm run build
npm run type-check
npm run test --workspace api-nova-server
```

Targeted runtime checks:

```bash
npm run test:transform-spec --workspace api-nova-server
npm run test:streamable-session --workspace api-nova-server
```

## 8. Common Problems

### 8.1 PostgreSQL authentication failure

Check:

- `DB_HOST`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_DATABASE`

Manual test:

```bash
psql -U postgres -h localhost -p 5432 -d api_nova_api
```

### 8.2 UI cannot reach API

Check:

- API is running on `9001`
- UI is running on `9000`
- `http://127.0.0.1:9001/health` responds

### 8.3 PostgreSQL startup fails after database creation

Symptoms:

- database credentials are correct
- PostgreSQL is reachable
- API still fails during TypeORM metadata validation or schema initialization

Check:

- use the latest codebase after the dual-database enum compatibility fix
- rebuild the API package before restart:

```bash
npm run build --workspace api-nova-api
```

If startup succeeds, logs should include:

- `Database mode: postgres`
- `PostgreSQL database: <host>:<port>/<database>`

### 8.4 SQLite path is wrong or not writable

Check:

- `DB_SQLITE_PATH`
- write permission on the parent directory
- whether an absolute path would be clearer for your environment

### 8.5 PowerShell blocks npm script execution

Use:

```powershell
npm.cmd -v
```

If needed:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 9. Current Baseline Summary

Currently verified in the active baseline:

- supported MCP transports are `stdio`, `streamable`, and `sse`
- SQLite is the default database mode
- PostgreSQL remains supported
- API docs are exposed at `http://127.0.0.1:9001/api/docs`
- runtime direct-spec transformation smoke passes
- Streamable multi-session smoke passes

If another document conflicts with this one, use this file as the active local-run baseline.
