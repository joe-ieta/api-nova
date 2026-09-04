# ApiNova Release Requirements

## Package Types

ApiNova has two supported release package types.

### Portable Package

Use this when one package should be copied between Windows and Linux hosts.

- Output example: `E:\CodexDev\api-nova-release`
- Includes compiled backend, compiled frontend, release manifests, startup scripts, and default `.env`.
- Does not include `node_modules`.
- First run installs production dependencies for the current OS/CPU using `corepack pnpm install --prod --frozen-lockfile`.
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
- `start.bat` must call pnpm with `call corepack pnpm ...` in portable mode; otherwise Windows batch execution can stop after dependency installation.
