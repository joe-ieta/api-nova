# ApiNova Release Requirements

> Document status: Active release operations
> Last reviewed: 2026-09-04
> Canonical packaging contract: [ApiNova Version Release Standard](../../RELEASE_STANDARD.md)

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

## Official Release Packaging

The canonical artifact, archive, latest-directory, version-document, and publication rules are defined in [ApiNova Version Release Standard](../../RELEASE_STANDARD.md). This document describes the underlying single-platform packaging mechanics only.

### Official Package Set

An official product version is an atomic set of three native offline packages:

| Platform ID | Target | Archive |
| --- | --- | --- |
| `win-x64` | Windows x64 | `.zip` |
| `linux-x64` | Ubuntu/Linux AMD64 | `.tar.gz` |
| `linux-arm64` | Ubuntu/Linux ARM64 | `.tar.gz` |

Every package includes compiled backend and frontend output, production `node_modules`, startup scripts, default local-test `.env`, and a bundled Node executable. First startup must not download anything.

Build each package on its target OS and CPU. Do not copy Windows dependencies to Linux, or x64 dependencies to ARM64.

The `Portable` script mode remains available for development transfer, but it is not an official release artifact because first startup may install dependencies from the network.

### Staging Output

Never package directly into `E:\CodexDev\api-nova-release`. That path is the latest three-platform mirror and may contain runtime data.

Use a disposable versioned staging path:

```text
E:\CodexDev\api-nova-release-staging\<tag>\<platform-id>\
```

The final uncompressed package directory is named:

```text
api-nova-release-<tag>-<platform-id>
```

### Required Runtime Behavior

- Windows startup: `start.bat`
- Linux startup: `./start.sh`
- Default UI: `http://127.0.0.1:9001/`
- Startup health: `http://127.0.0.1:9001/api/health/live`
- Default database: `data/api-nova.db`
- Runtime files remain under `data/`, `logs/`, and `pids/`
- Default local test account: `admin` / `admin@123456`
- Shared-network testing requires changing default credentials and JWT secrets

### Build Commands

Windows x64, run on Windows x64:

```powershell
$tag = 'vX.Y.Z'
$output = "E:\CodexDev\api-nova-release-staging\$tag\win-x64\api-nova-release-$tag-win-x64"

powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 `
  -Mode OfflineCurrentPlatform `
  -OutputDir $output `
  -IncludeNode
```

Linux x64, run on Ubuntu x64:

```bash
tag='vX.Y.Z'
output="/opt/api-nova-release-staging/${tag}/linux-x64/api-nova-release-${tag}-linux-x64"

pwsh ./scripts/package-release.ps1 \
  -Mode OfflineCurrentPlatform \
  -OutputDir "${output}" \
  -IncludeNode
```

Linux ARM64, run on Ubuntu ARM64:

```bash
tag='vX.Y.Z'
output="/opt/api-nova-release-staging/${tag}/linux-arm64/api-nova-release-${tag}-linux-arm64"

pwsh ./scripts/package-release.ps1 \
  -Mode OfflineCurrentPlatform \
  -OutputDir "${output}" \
  -IncludeNode
```

Before archiving Linux output, ensure `start.sh` and `runtime/node/bin/node` are executable. Use `.tar.gz` so Unix permissions are retained.

### Validation

Validate the staging directory and a new extraction of the final archive on the matching platform:

```text
http://127.0.0.1:9001/
http://127.0.0.1:9001/api/health/live
http://127.0.0.1:9001/api/system/initialization
```

The strict `/health` endpoint may return `503` when optional MCP or disk-threshold checks fail. Use `/api/health/live` for startup validation.

The final release must also satisfy the repository gates, document templates, archive layout, three-platform checksums, and atomic latest promotion in `RELEASE_STANDARD.md`.

### Constraints

- Offline packages are OS/CPU specific.
- Linux artifacts require native execution evidence on their matching architecture.
- Windows ZIP creation must not leave npm workspace Junctions that require elevated extraction.
- A version is not published while any of the three official artifacts is missing or unverified.
