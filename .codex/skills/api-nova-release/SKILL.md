---
name: api-nova-release
description: Build, validate, archive, and publish ApiNova product releases. Use when the user asks for an ApiNova version, release tag, green/offline runtime package, latest release directories, release notes, or reusable release workflow.
---

# ApiNova Release

Read `RELEASE_STANDARD.md` before planning or executing a product release. It is the canonical contract; this skill only preserves its operational invariants.

## Official Release Contract

An official product tag is one atomic native offline set:

- `api-nova-release-<tag>-win-x64.zip`
- `api-nova-release-<tag>-linux-x64.tar.gz`
- `api-nova-release-<tag>-linux-arm64.tar.gz`

All three artifacts must use the same tag, commit, release notes, dependency lock, and exact Node version. Each includes production dependencies and a bundled Node runtime, starts without downloads, and passes a fresh-extraction test on its matching OS and CPU.

Never create a Linux artifact by copying Windows `node_modules`, or an ARM64 artifact by copying x64 dependencies. If a matching native builder is unavailable, leave the release in staging and report the missing platform as blocked. Do not call a partial set published.

`Portable` mode is for development transfer only and is not an official product release artifact.

## Output Roots

Use separate roots:

- immutable versions: `api-nova-release-archive/<tag>/`;
- latest extracted mirrors: `api-nova-release/{win-x64,linux-x64,linux-arm64}/`;
- disposable builds: `api-nova-release-staging/<tag>/<platform-id>/`.

Never pass the latest root directly to the packaging script. It recreates its output and can delete runtime data.

Do not restructure the historical flat `E:\CodexDev\api-nova-release` directory without explicit approval. It may contain a live SQLite database.

## Workflow

1. Confirm the intended tag and fetch remote tags.
2. Require a clean, synchronized source commit.
3. Create `docs/release/versions/<tag>/RELEASE_NOTES.md` and `QUICK_START.md` from the templates before tagging.
4. Run every release gate listed in `RELEASE_STANDARD.md`; record failures instead of omitting them.
5. Build each platform on a matching native host with `scripts/package-release.ps1 -Mode OfflineCurrentPlatform -IncludeNode`.
6. Add `RELEASE_INFO.json`, release notes, and quick start to each package.
7. Verify staging output and a fresh extraction with network unavailable or blocked.
8. Create the Windows ZIP and Linux `.tar.gz` files, then generate the version manifest and SHA-256 file.
9. Require all three artifacts before promoting latest.
10. Promote all latest platform directories together and write `CURRENT_RELEASE.json` last.
11. Create and push an annotated tag only for the exact release commit.
12. Upload the same bytes, notes, manifest, and checksums to the remote Release.

Any artifact-content change after publication requires a new tag. Never replace bytes under an existing tag.

## Single-Platform Packaging

The repository script produces the current native platform directory:

```powershell
pwsh ./scripts/package-release.ps1 \
  -Mode OfflineCurrentPlatform \
  -OutputDir <versioned-staging-directory> \
  -IncludeNode
```

Before accepting it, assert the actual Node runtime identity matches the requested platform ID. On Linux, set executable bits on `start.sh` and the bundled Node before creating `.tar.gz`. On Windows, ensure workspace Junctions do not make the ZIP require elevated extraction.

Validate:

```text
http://127.0.0.1:9001/
http://127.0.0.1:9001/api/health/live
http://127.0.0.1:9001/api/system/initialization
```

Clean smoke-test databases, logs, PIDs, and temporary files before archiving.

## Publication Safety

Tag creation, tag push, latest-directory replacement, and remote upload are separate mutations. Obtain authorization when required immediately before each mutation.

Before a public upload, inspect `.env` and the archive for credentials. Explicitly disclose documented default accounts or keys. Do not infer authorization to publish a specific payload merely from authorization to build it.

## References

- Canonical standard: `RELEASE_STANDARD.md`
- Single-platform mechanics: `docs/release/api-nova-release-requirements.md`
- Release readiness: `docs/guides/release-readiness-checklist.md`
- Templates: `docs/release/templates/`
- Packaging script: `scripts/package-release.ps1`
- Native artifact builder: `scripts/build-release-artifact.ps1`
- Package smoke verifier: `scripts/test-release-package.ps1`
- Release manifest builder: `scripts/create-release-manifest.ps1`
- Atomic archive/latest promoter: `scripts/promote-release-set.ps1`
- Three-platform workflow: `.github/workflows/release-artifacts.yml`
