# ApiNova Release Requirements

> Document status: Active release operations
> Last reviewed: 2026-07-22

## Run From A Source Checkout

Use this path for local development and pre-release acceptance directly from the Git checkout. It starts the management API, UI, and standalone MCP server as three source processes. It is not a substitute for the portable or offline deployment packages described below.

### 1. Prerequisites

- Node.js `>= 20`
- npm `>= 10`
- run every repository command from the repository root
- use npm only; `package-lock.json` is the authoritative dependency lock

Verify the toolchain:

```bash
node -v
npm -v
```

### 2. Prepare A Clean Source Environment

Install exactly the locked dependencies and build all four workspaces:

```bash
npm ci
npm run verify:package-manager
npm run build
```

Create the API environment file only when one does not already exist.

Windows PowerShell:

```powershell
if (-not (Test-Path .\packages\api-nova-api\.env)) {
  Copy-Item .\packages\api-nova-api\.env.example .\packages\api-nova-api\.env
}
```

Linux / Ubuntu:

```bash
test -f ./packages/api-nova-api/.env || \
  cp ./packages/api-nova-api/.env.example ./packages/api-nova-api/.env
```

The source default is SQLite. Review `packages/api-nova-api/.env` before startup, especially `JWT_SECRET`, the default administrator password, and any upstream credentials. Do not use the example secrets for an externally reachable environment.

### 3. Start The Full Product From Source

Keep all three terminals open.

Terminal 1 - management API on port `9001`:

```bash
npm run start:dev --workspace api-nova-api
```

Terminal 2 - UI on port `9000`, proxying `/api` and WebSocket traffic to the API:

```bash
npm run dev --workspace api-nova-ui
```

Terminal 3 - standalone MCP server on port `9022`:

```bash
npm run dev --workspace api-nova-server
```

Open:

- UI: `http://127.0.0.1:9000/`
- API base: `http://127.0.0.1:9001/api`
- API documentation: `http://127.0.0.1:9001/api/docs`
- API startup health: `http://127.0.0.1:9001/api/health/live`
- MCP endpoint: `http://127.0.0.1:9022/mcp`
- MCP server health: `http://127.0.0.1:9022/health`

The source default administrator is `admin` / `admin@123456` unless overridden in the API environment file. Stop each process with `Ctrl+C`.

Important: the root `npm run dev` helper does not currently start `api-nova-api`, so it must not be used by itself as the full-product source startup command. Use the three explicit workspace commands above.

### 4. Start Built Backend Code From Source

For a backend-only production-style smoke test after `npm run build`:

Windows PowerShell:

```powershell
$env:NODE_ENV = "production"
$env:DB_TYPE = "sqlite"
$env:DB_SQLITE_PATH = "data/api-nova.db"
node .\packages\api-nova-api\dist\src\main.js
```

Linux / Ubuntu:

```bash
NODE_ENV=production \
DB_TYPE=sqlite \
DB_SQLITE_PATH=data/api-nova.db \
node ./packages/api-nova-api/dist/src/main.js
```

This command starts the built API from the repository root, but a normal source build does not copy the UI into the root `public/` directory. Use the three-process source startup for development, or build a release package when a single process must serve both the UI and API.

### 5. Start The MCP Server With A Specific OpenAPI Document

The default Server development command starts the standalone runtime on port `9022`. To start it with a specific OpenAPI document instead, stop Terminal 3 and run:

```bash
npm run cli --workspace api-nova-server -- \
  --openapi ./examples/minimal-openapi.json \
  --transport streamable \
  --port 9022
```

The MCP endpoint remains `http://127.0.0.1:9022/mcp`. Do not run this command at the same time as Terminal 3 because both bind port `9022`.

## Package Types

ApiNova has two supported release package types.

### Portable Package

Use this when one package should be copied between Windows and Linux hosts.

- Output example: `E:\CodexDev\api-nova-release`
- Includes compiled backend, compiled frontend, release manifests, startup scripts, and default `.env`.
- Does not include `node_modules`.
- First run installs production dependencies for the current OS/CPU using `npm ci --omit=dev`.
- This mode is not fully offline on first run.

### Offline Current-Platform Package

Use this when first run must not download anything.

- Output example: `E:\CodexDev\api-nova-release-offline-win-x64`
- Includes compiled backend, compiled frontend, production `node_modules`, startup scripts, default `.env`, and optionally a bundled Node executable.
- Must be built on the same OS/CPU architecture where it will run.
- Windows x64 offline packages are only for Windows x64.
- Ubuntu ARM64 offline packages must be built on Ubuntu ARM64, or in an equivalent Ubuntu ARM64 build environment.

## Required Runtime Behavior

- Startup must be one command:
  - Windows: `start.bat`
  - Linux / Ubuntu: `chmod +x ./start.sh && ./start.sh`
- Default URL: `http://127.0.0.1:9001/`
- Default local database: `data/api-nova.db`
- Runtime files must stay inside the package directory:
  - `data/`
  - `logs/`
  - `pids/`
- Default admin account:
  - username: `admin`
  - password: `admin@123456`

## Build Commands

Create the portable package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 `
  -Mode Portable `
  -OutputDir E:\CodexDev\api-nova-release
```

Create a Windows x64 offline package with bundled `node.exe`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 `
  -Mode OfflineCurrentPlatform `
  -OutputDir E:\CodexDev\api-nova-release-offline-win-x64 `
  -IncludeNode
```

Create an Ubuntu ARM64 offline package on an Ubuntu ARM64 machine with PowerShell installed:

```powershell
pwsh ./scripts/package-release.ps1 `
  -Mode OfflineCurrentPlatform `
  -OutputDir /opt/api-nova-release-offline-linux-arm64
```

## Validation

After packaging, validate from the output directory.

Windows:

```powershell
.\start.bat
```

Linux:

```bash
chmod +x ./start.sh
./start.sh
```

Then verify:

```text
http://127.0.0.1:9001/
http://127.0.0.1:9001/api/health/live
```

The strict `/health` endpoint may return `503` when optional MCP runtime health or disk threshold checks fail. Use `/api/health/live` for startup validation.

## Known Constraints

- A fully offline package cannot be architecture-neutral when dependencies include native modules such as `bcrypt`.
- Do not copy a Windows `node_modules` directory into an Ubuntu ARM64 package.
- Portable packages may be shared across platforms because dependencies are installed on first run.
- Offline packages must be rebuilt per target platform.
- `start.bat` must call npm with `call npm.cmd ...` in portable mode; otherwise Windows batch execution can stop after dependency installation.
