# Release Readiness Checklist

> Document status: Active
> Last reviewed: 2026-07-22

Use this checklist before cutting a release or calling the current baseline publishable.

The goal is to validate the real supported path, not to create an aspirational checklist for features that are still incomplete.

## 1. Baseline Confirmation

Confirm the release still matches the current baseline:

- supported MCP transports are `stdio`, `streamable`, and `sse`
- `streamable` multi-session behavior remains working
- default database mode is `SQLite`
- `PostgreSQL` remains a supported optional deployment mode
- email verification delivery, password reset mail delivery, and email notification delivery are not claimed as baseline features unless they are actually implemented
- active docs do not claim unsupported transport or feature behavior

## 2. Documentation Check

Confirm active documentation is aligned with the implementation:

- `README.md`
- `docs/guides/package-management-policy.md`
- `docs/guides/local-setup-and-run.md`
- `docs/guides/database-mode-quickstart.md`
- `docs/guides/database-strategy.md`
- `docs/guides/staged-development-plan.md`
- package README files for affected packages
- deferred or partial items are tracked in `docs/reference/open-items.md`

## 3. Build And Type Validation

Run:

```bash
npm ci
npm run verify:package-manager
npm run build
npm run type-check
npm run test --workspace api-nova-server
```

If parser behavior changed, also run:

```bash
npm run verify:parser-chain
```

If the release touches broader parser compatibility or downstream contracts, run:

```bash
npm run verify:parser-chain:full
```

## 4. API Test Verification

For targeted OpenAPI management and validation paths under `packages/api-nova-api`:

Windows PowerShell:

```powershell
cd packages\api-nova-api
.\node_modules\.bin\jest.cmd --runInBand src/modules/openapi/services/parser.service.spec.ts
.\node_modules\.bin\jest.cmd --runInBand src/modules/openapi/services/openapi.service.spec.ts
.\node_modules\.bin\jest.cmd --runInBand src/modules/openapi/services/validator.service.spec.ts
```

Ubuntu:

```bash
cd packages/api-nova-api
./node_modules/.bin/jest --runInBand src/modules/openapi/services/parser.service.spec.ts
./node_modules/.bin/jest --runInBand src/modules/openapi/services/openapi.service.spec.ts
./node_modules/.bin/jest --runInBand src/modules/openapi/services/validator.service.spec.ts
```

For broader API regression verification:

```bash
npm run test --workspace api-nova-api
```

## 5. Runtime Path Verification

Verify the main operator paths:

- UI main entry: `http://127.0.0.1:9000/`
- API main entry: `http://127.0.0.1:9001/api`
- API Swagger docs: `http://127.0.0.1:9001/api/docs`
- MCP endpoint example: `http://127.0.0.1:9022/mcp`

Check:

- `/mcp` is treated as an MCP protocol endpoint, not a browser page
- concurrent streamable sessions can be established

## 6. OpenAPI Management Verification

Use at least one known public operator test spec:

- `https://petstore.swagger.io/v2/swagger.json`

Verify:

- import from URL works
- the spec can be parsed and normalized
- validation succeeds on the normalized document
- tool preview renders usable results
- conversion to MCP succeeds on the supported path

## 7. Database Mode Verification

### SQLite

Verify:

- API runs with `DB_TYPE=sqlite` or with `DB_TYPE` omitted
- startup logs clearly report `Database mode: sqlite`
- SQLite migrations and startup behavior succeed

### PostgreSQL

Verify:

- API runs with `DB_TYPE=postgres`
- startup logs clearly report `Database mode: postgres`
- schema initialization and migrations succeed

Current clean-schema baseline verified on July 21, 2026:

- isolated empty SQLite and PostgreSQL databases both completed canonical `migration:run`
- both migrated schemas returned zero pending changes from `schema:log`
- each database contains 38 domain tables plus the migration ledger
- all domain tables remain empty before explicit seed initialization
- the nine runtime-instance, endpoint-testing, upstream-binding, verification, and persisted Gateway snapshot tables are present
- `source_service_assets` contains no legacy runtime host/port columns
- PostgreSQL uses a native UUID foreign key for `source_service_instances.sourceServiceAssetId`
- verification commands are `npm run db:verify-isolated-sqlite --workspace api-nova-api` and `npm run db:verify-isolated-postgres --workspace api-nova-api`

## 8. Endpoint Registry Verification

Verify the manual endpoint lifecycle path:

- register a manual endpoint from the UI or API
- edit the manual endpoint and confirm the method/path display updates correctly
- run `probe` and verify healthy endpoints do not incorrectly revive `offline` items
- run `publish readiness` and confirm blocking reasons are visible when applicable
- run `publish` and `offline` and confirm lifecycle status changes match the operator action
- delete the manual endpoint and confirm it disappears from the grouped registry view

Verify the imported endpoint governance path:

- enter the registry from OpenAPI Management and confirm the `imported` source view opens
- confirm imported endpoints can be listed and grouped without exposing manual create/edit/delete actions
- run `probe`, `publish readiness`, `publish`, and `offline` on an imported endpoint and confirm the lifecycle state updates correctly

## 9. Runtime Credential And Verification Gate

Verify:

- configure a source-service instance with `env-headers:Authorization=UPSTREAM_API_TOKEN`
- confirm create/update rejects a missing environment variable, malformed mapping, or transport-owned header
- confirm the saved instance, verification evidence, Gateway snapshot, MCP server configuration, and logs contain the reference but never the resolved secret
- confirm Gateway candidate replay and activated proxy calls replace consumer credentials with the upstream credential
- confirm each MCP operation resolves the credential reference of its own selected source-service instance
- change the selected instance or credential reference and confirm the candidate revision changes and fresh verification is required
- remove the environment variable after configuration and confirm execution fails closed without activating a candidate
- confirm deployment without a smoke sample remains blocked by default
- use the permission-guarded no-smoke waiver action, enter a reason of at least 10 characters, and confirm operator id, environment, reason, and `waiver` result are visible in verification drill-down
- confirm the waiver changes candidate identity and permits activation without fabricating a replay result

## 10. Windows And Ubuntu Verification

Check the documented run path on both:

- Windows PowerShell
- Ubuntu

At minimum verify:

- dependency install
- API startup
- UI startup
- basic import and conversion workflow
- parser verification path
- `npm run test:streamable-session --workspace api-nova-server`

Latest local evidence on 2026-07-22:

- Windows `npm run build` passed for Parser, Server, API, and UI production output
- Windows streamable multi-session smoke passed for two concurrent MCP sessions
- Windows API/UI interactive startup, basic import/conversion, and the complete Ubuntu path remain required before release

## 11. Open Items Review

Execute and record the [Runtime Publication Acceptance Cases](../testing/runtime-publication-acceptance-cases.md). Then review [Open Items](../reference/open-items.md) and confirm:

- unfinished items are not being claimed as release-complete
- operator-visible gaps are disclosed clearly enough
- no archived guide is still treated as an active source of truth
- security, auth, monitoring, and UI placeholder risks are understood
- deferred auth and notification flows are described honestly in API and operator guidance

A release is ready only when the documented baseline, the real implementation, and the tested operator path all match.

Automated runtime-closure gate:

```bash
npm run verify:runtime-closure
```

The gate is necessary but not sufficient: the manual real-upstream and cross-platform checks above must also pass before release.
