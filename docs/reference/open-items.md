# Open Items

> Document status: Active
> Last reviewed: 2026-07-22
> Owner: Product closure and release governance

## Purpose

This file contains only unfinished work. Completed implementation history belongs in `docs/archive`; detailed executable cases belong in `docs/testing`.

## Active Baseline

Use these documents together:

- `docs/guides/staged-development-plan.md`
- `docs/guides/runtime-instance-and-regression-closure-plan.md`
- `docs/reference/runtime-closure-design-implementation-review.md`
- `docs/testing/runtime-publication-acceptance-cases.md`

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

Execution details and evidence fields are defined in `docs/testing/runtime-publication-acceptance-cases.md`.

## 2. Design And Implementation Deviations

The main architecture is aligned, but the following productization gaps remain.

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

Status: deferred outside the runtime-publication closure line.

- email verification delivery
- password reset email delivery
- email notification delivery
- broader security-workflow completeness review

## Closed Baseline

The following are no longer open:

- registration is separate from testing, governance, and publication
- document-level quick publication has been removed
- logical source assets no longer own live host/port coordinates
- successful endpoint tests automatically persist distinct sanitized samples
- Gateway uses a shared listen port and required per-service prefix
- Gateway and MCP activation are verification-gated and retain prior revisions on candidate failure
- SQLite and PostgreSQL clean-baseline migrations are automated and verified
