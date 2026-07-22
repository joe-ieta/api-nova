---
name: api-nova-release
description: Package ApiNova release bundles and validate release outputs. Use when the user asks to pull latest ApiNova code, build ApiNova, create a green one-click runtime package, create a portable Windows/Linux package, create a first-run offline package, or document/reuse ApiNova release requirements.
---

# ApiNova Release

Use this skill for release packaging in the `api-nova` monorepo.

## Core Rules

- Pull latest code before packaging unless the user explicitly asks not to.
- Preserve unrelated working tree changes. The existing untracked `data/` directory is user/runtime data; do not delete it.
- Use npm only. Restore the locked dependency tree with `npm.cmd ci`, then run `npm.cmd run verify:package-manager` before release validation.
- Run `npm.cmd run build` on Windows before packaging unless the user only asks for documentation.
- Keep runtime output under the requested release directory.
- Use SQLite by default with `DB_TYPE=sqlite` and `DB_SQLITE_PATH=data/api-nova.db`.
- Serve the built UI from the API process by copying `packages/api-nova-ui/dist` into release `public/`.
- Start the backend with `node packages/api-nova-api/dist/src/main.js`.
- Validate startup with `/api/health/live`, not strict `/health`.

## Package Modes

Choose one mode explicitly.

`Portable`:

- Use when one package should be copied between Windows and Linux.
- Does not include `node_modules`.
- First run installs production dependencies for the current OS/CPU.
- Not fully offline on first run.

`OfflineCurrentPlatform`:

- Use when first run must not download anything.
- Includes production `node_modules`.
- Must be built on the same OS/CPU that will run it.
- Windows x64 offline packages are not valid Ubuntu ARM64 packages.
- Ubuntu ARM64 offline packages must be built on Ubuntu ARM64 or an equivalent ARM64 build environment.

## Preferred Script

Use the repository script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Mode Portable -OutputDir E:\CodexDev\api-nova-release
```

For a Windows x64 offline package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Mode OfflineCurrentPlatform -OutputDir E:\CodexDev\api-nova-release-offline-win-x64 -IncludeNode
```

## Validation

After packaging, run the start script from the output directory and verify:

```text
http://127.0.0.1:9001/
http://127.0.0.1:9001/api/health/live
```

If strict `/health` returns `503`, inspect details before treating it as release failure; disk threshold and optional MCP checks can fail while the app is still runnable.

## References

- Detailed requirements: `docs/release/api-nova-release-requirements.md`
- Packaging script: `scripts/package-release.ps1`
