# Nest SSE security backport

This directory contains the MIT-licensed `@nestjs/core@10.4.22` npm archive with only the SSE field sanitization from upstream commit [0f962c75a474b08fbc1bdf072b89eda14151c856](https://github.com/nestjs/nest/commit/0f962c75a474b08fbc1bdf072b89eda14151c856) backported. The original `package/LICENSE`, version, metadata, and every other file are unchanged. This local archive is **not an upstream Nest release**.

`nestjs-core-sse-backport.json` records provenance and hashes. `package-lock.json` pins the archive integrity; the root override keeps all Nest consumers on the same patched bytes. The release packager copies this directory so both portable installs and native offline builds resolve the same archive. No postinstall patch or mutable runtime monkey patch is used; `npm ci --ignore-scripts` still installs the fix.

Rebuild from the official npm archive, without executing package scripts:

```powershell
npm pack @nestjs/core@10.4.22 --pack-destination .tmp --silent
node scripts/build-nest-sse-backport.cjs .tmp/nestjs-core-10.4.22.tgz .tmp/nestjs-core-backport-rebuilt.tgz
```

Compare SHA-256 with `archiveSha256` in the provenance JSON. The builder validates the original npm SHA-512 integrity and exact original SSE file, preserves other tar entries byte for byte, and fixes compression settings/header. Unknown input fails closed. The checked-in archive is the distribution authority if compression-library differences produce a different compressed hash; never replace its bytes without review and updating the lock/provenance.

Use root `npm ci` to refresh existing installations: plain `npm install` can retain stale same-version registry bytes. Build, packaging (including SkipBuild), and generated release startup scripts verify the actual module hash and stop on stale bytes. Run `npm run verify:security-nest-sse`. Optionally set `API_NOVA_SECURITY_CANDIDATE_ROOT` to a clean install or extracted release root. These tests verify the actual core module consumed by the API, Express adapter, Socket.IO adapter, websockets and Swagger, not just the manifest range.

The version remains `10.4.22`: npm audit still reports the upstream vulnerable version range (10 moderate affected package nodes from the same SSE advisory). This backport fixes the reviewed code path; it does not imply Nest 10 has upstream support or that the broader security work package is complete. Reassess/remove the backport when adopting a coherently maintained Nest framework release, with Gateway/Express route, raw-stream, auth, upload, Socket.IO and Swagger compatibility checks. A standalone workspace installation that does not use the root manifest/lock is outside this guarantee; the API is a private workspace delivered with the product root.
