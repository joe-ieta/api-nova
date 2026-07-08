# Offline Development Kit

This project now uses npm workspaces and a root `package-lock.json`.

## Create a Kit

Run this on a connected machine after dependencies have been installed at least once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-offline-dev-kit.ps1
```

The kit contains:

- a Git bundle of the repository
- current working tree patches and untracked files
- the current npm cache
- optional Node.js runtime files

## Restore a Kit

On the offline machine:

```powershell
powershell -ExecutionPolicy Bypass -File restore-offline-dev.ps1
```

The restore script runs:

```bash
npm ci --offline --cache <kit>/npm-cache
npm run build:packages
npm run type-check
```

## Development Commands

Open separate terminals as needed:

```bash
npm run dev --workspace api-nova-server
npm run start:dev --workspace api-nova-api
npm run dev --workspace api-nova-ui
```

If `npm ci --offline` cannot find a package, recreate the kit on a connected machine after running `npm install`.
