# Open Items

> Document status: Active
> Last reviewed: 2026-09-06
> Owner: Product closure and release governance

## Purpose

This file contains only unfinished work. Completed implementation history belongs in `docs/archive`; detailed executable cases belong in `docs/testing`.

## Active Baseline

Use these documents together:

- `docs/guides/staged-development-plan.md`
- `docs/guides/runtime-instance-and-regression-closure-plan.md`
- `docs/reference/runtime-closure-design-implementation-review.md`
- `docs/testing/runtime-publication-acceptance-cases.md`
- `docs/guides/runtime-security-and-call-audit.md`
- `docs/testing/runtime-security-audit-cases.md`

## Remaining-Work Review: 2026-09-06

The recording/authentication implementation and controlled local integration are complete for the tested scope, not production acceptance. The remaining work is grouped below; adding a deferred item here does not authorize implementing it in the current change.

- Release/environment gates: `EXT-01` through `EXT-11`, `ENV-01`, `SEC-OPS-01`, and `SEC-DEP-01`.
- Existing productization gaps: `DEV-01` through `DEV-05`; the security work does not close them.
- Follow-up audit work: `AUDIT-01` through `AUDIT-04` (analysis, retention, durability and caller-inventory scaling).
- Follow-up security/governance design: `SEC-AUTH-01` and `SEC-POLICY-01` (token adapters and cross-protocol policy/QoS).

Record the responsible operator, target environment, tested commit, commands, result and sanitized evidence location when closing a gate. Keep credentials in approved local configuration/secret storage, never in this document or Git. Local fixture evidence must not be substituted for an unexecuted external case.

## 1. External-Environment Acceptance

Status: blocked by environment availability, not by the automated code baseline.

These tests must pass before release and are intentionally not claimed as complete:

- `EXT-01`: real upstream OpenAPI import with an absolute server URL
- `EXT-02`: unresolved OpenAPI import repaired by attaching a live runtime instance
- `EXT-03`: manual API registration against a live upstream
- `EXT-04`: move an API from retired host/port A to live host/port B without re-import
- `EXT-05`: live Gateway aggregate-service consumer probe through the configured service prefix
- `EXT-06`: live MCP consumer probe using the selected transport and runtime credentials
- `EXT-07`: failed candidate replay retains the last-known-good Gateway and MCP revisions
- `EXT-08`: Windows API/UI interactive startup and basic import/conversion workflow
- `EXT-09`: complete Ubuntu install, build, startup, parser verification, and streamable-session path
- `EXT-10`: real OAuth provider/JWKS rotation, HTTPS reverse proxy and third-party MCP client authorization flow (resource metadata, audience, scopes, reconnection). Local signed-token tests are not equivalent to this acceptance.
- `EXT-11`: rerun the 40-table canonical migration and full API startup against an approved isolated PostgreSQL instance. SQLite migration/startup and PostgreSQL column-definition tests passed on 2026-09-06; a live PostgreSQL run was not performed for the added configuration tables.
- `ENV-01`: full Windows `/health` disk probe requires access unavailable in the restricted test environment (WMI/profile permission errors). Do not relax system execution policies as a workaround. The local multi-process test uses `/api/health/ready`, not a claim that all system probes passed.

Controlled progress on 2026-09-06: `npm run verify:runtime-security-integration` passed real API/MCP processes with a local HTTPS reverse proxy and HTTPS JWKS rotation, SDK calls, protected management inventory and cross-process API evidence. This narrows but does not close `EXT-10`: issuer login/consent and actual deployment configuration remain external acceptance.

Execution details and evidence fields are defined in `docs/testing/runtime-publication-acceptance-cases.md`.

To resume external integration, supply the trusted issuer/JWKS URLs, Gateway/MCP public URLs and proxy configuration, the local path to test credentials, and permission/connection details for a dedicated temporary PostgreSQL database. Test the actual login/consent and client refresh/reconnect flow, then rerun `npm run verify:runtime-closure` against the 40-table target. The full closure gate has not been rerun with the updated PostgreSQL schema. The current security fixture seeds route snapshots directly and does not exercise registration, governance, publication or managed deployment end to end.

## 2. Design And Implementation Deviations

The main architecture is aligned, but the following productization gaps remain.

### AUDIT-01: Call analysis and inspection workflows

Status: explicitly deferred beyond the current recording/authentication work.

Caller timelines, API/transport/time-range search, Payload/Response inspection, analysis and controlled export remain unimplemented. The automatic caller inventory endpoint is not a log-analysis feature. Define access control, pagination, redaction and export authorization before adding UI; acceptance must preserve concurrent/parent-child relationships without treating timestamp order as causality.

### AUDIT-02: Audit retention and storage lifecycle

Status: follow-up development; deployment safeguards are required under `SEC-OPS-01`.

Daily JSONL splitting exists, but automatic retention cleanup, file/total-storage quotas, encrypted large-object storage and extended/nested multipart support do not. Define retention/deletion and backup policies for both call files and caller observations, test boundary-sized/binary evidence and safe cleanup, and document unsupported formats. Standard form-data field/file capture and per-body size limits already exist; do not conflate this item with the separate test-sample storage gap `DEV-04`.

### AUDIT-03: Durability and sustained-load guarantees

Status: follow-up design and fault/load validation; zero-loss auditing is not a current guarantee.

Current asynchronous JSONL writes fail open, emit a sanitized failure warning and flush on graceful shutdown. Durable queues, bounded write backlog/backpressure, crash recovery, tamper evidence and production-load guarantees remain unimplemented/unverified. Define the intended loss and latency budgets before choosing storage or queue mechanisms. Cover slow/full/read-only disks, process termination, long-running requests and sustained concurrent maximum-size bodies; no replay of a business call may be introduced merely to recover its audit record.

### AUDIT-04: Caller inventory scale and multi-host collection

Status: follow-up development; no caller preregistration requirement may be introduced.

The management endpoint merges append-only caller observations from the shared local directory on each read; it has no persistent search index/compaction or multi-host collector. Add bounded-cost indexing/aggregation and observation lifecycle handling when scale requires it, and define optional caller annotations/maintenance separately from authentication. Preserve issuer/subject identity across token refresh and transport changes; never merge different issuers by display name or turn an observed caller into an authorization grant.

The active recording contract is [安全调用与日志审计](../guides/runtime-security-and-call-audit.md).

### DEV-01: MCP deployment endpoint configuration

Priority: P1

The backend deploy DTO supports MCP `port` and `transport`, but the governed publication/runtime UI does not expose them. An explicit validated MCP `endpointPath` contract is also absent. Until this is implemented, the operator cannot fully define the published MCP endpoint before activation.

### DEV-02: Upstream-change verification state

Priority: P1

Changing a runtime upstream binding increments its revision and therefore changes the next deployment candidate identity. It does not immediately create a verification run or mark the active runtime asset as `verification_required`. Safety is enforced at deploy/redeploy, but operator-visible stale state is incomplete.

### DEV-03: Instance-aware governance evidence

Priority: P1

Endpoint readiness currently uses endpoint metadata such as `testStatus` and probe status. It does not explicitly invalidate governance readiness when the qualifying test instance is archived, the selected instance changes, or the endpoint contract revision changes. Deployment replay still protects activation, but pre-publication readiness can present stale evidence.

### DEV-04: Sample storage and retention controls

Priority: P1

Successful samples are automatically saved and sanitized, but payload-size limits, binary body metadata-only handling, configurable retention classes, and cleanup jobs are not implemented. This is a database-growth and sensitive-data-governance risk.

### DEV-05: Instance and binding mutation audit

Priority: P2

Runtime upstream bindings have optimistic revisions and deployment verification has actor evidence for waivers. Source-instance and binding mutations do not yet persist a complete actor/reason/history audit trail.

## 3. Runtime-Asset Observability Hardening

Status: active.

- broaden system-log, audit-log, and metrics projections on the runtime-asset-first model
- deepen publication-to-runtime-to-monitoring correlation
- keep residual `/v1/servers/*` observability routes marked as compatibility surfaces

## 4. Frontend Structural And Bundle Cleanup

Status: deferred until release behavior is stable.

- split `EndpointRegistry` after the real acceptance path is stable
- preserve separate registration, governance, and publication responsibilities
- address production chunk-size warnings through measured code splitting

## 5. I18n And Encoding Hardening

Status: active maintenance.

- replace operator-visible mojibake in touched areas
- move remaining hard-coded operator copy into locale modules
- avoid unrelated cosmetic churn

## 6. Security And Notification Delivery

Status: notification delivery remains deferred. The release gates and follow-up capabilities below carry their own explicit statuses.

- email verification delivery
- password reset email delivery
- email notification delivery
- broader security-workflow completeness review

### SEC-DEP-01: Production dependency advisory check

Status: environment-blocked pending explicit data-transfer authorization (2026-09-06).

`npm audit --omit=dev --json` could not complete: sandbox network access failed and the approval reviewer blocked sending dependency names/versions to the npm registry without explicit user authorization. No audit result is claimed and no automatic dependency upgrades were performed. Complete the online check after authorization, triage the actual advisory paths, and rerun the affected package tests before release.

### SEC-OPS-01: Production security and audit deployment acceptance

Status: required before production exposure; depends on the target deployment environment.

- Verify issuer, audience, scopes, resource metadata, TLS/proxy paths and Host/Origin allowlists for every exposed runtime. Assign distinct audiences where services require separate authorization boundaries.
- Review persisted Gateway snapshots and explicitly reverify/redeploy routes needing OAuth. New production defaults do not rewrite existing anonymous or legacy-auth snapshots; management JWT and upstream credentials must remain separate from external caller tokens.
- Set a persistent absolute audit directory, Windows NTFS ACL or Linux ownership/modes, encrypted disk/backups, operational quota/retention safeguards, and business-specific redaction fields. Current file modes do not establish Windows ACLs, and arbitrary binary/business secrets cannot be automatically recognized.
- Connect `[RUNTIME_AUDIT_WRITE_FAILED]` to operational alerting and document acceptance of fail-open/loss behavior. Exercise access denial, alert delivery and backup/restore on the target host; unit failure injection is not deployment evidence.
- Confirm the migration CLI's explicit database environment and backup/rollback procedure before applying the 40-table schema to a real database. No current business database was migrated during local integration.

Close only with sanitized per-environment evidence and recorded operator decisions; automatic retention/durability implementation stays separately tracked in `AUDIT-02`/`AUDIT-03`.

### SEC-AUTH-01: Additional token adapters and revocation

Status: deferred capability design, not part of the implemented JWT resource-server contract.

Opaque-token introspection, immediate revocation and generalized multi-issuer adapters are not implemented. Confirm the actual provider requirement before expanding the adapter; define introspection authentication, caching/outage behavior and revoked-session handling. Current RS256/ES256 JWT validation relies on trusted issuer/JWKS and expiry. ApiNova remains a resource server; building an authorization server or automatically trusting arbitrary issuers is outside this baseline.

### SEC-POLICY-01: Cross-protocol fine-grained authorization and QoS

Status: deferred design/approval; not included in the current logging/authentication work.

Gateway OAuth base scopes are process-level and MCP supports additional per-tool scopes. A governed per-route/API scope editor, unified caller/API rate-limit policy across Gateway/MCP, and QoS tiers/quotas/priorities are not implemented as one shared contract. Existing Gateway traffic control must not be presented as cross-protocol QoS. Define scope inheritance, admission outcomes and observable rejection records before implementation, preserving MCP HTTP/SSE/Streamable semantics and ApiNova's lightweight product-gateway boundary.

## Evidence Boundary

Completed behavior and test counts are documented in the active design/acceptance records linked above, not treated as open work here. The historical July 38-table PostgreSQL result does not close current `EXT-11`. The controlled security integration and 40-table SQLite result do not close external identity-provider, managed-publication, UI/platform or production-operational acceptance.
