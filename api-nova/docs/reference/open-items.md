# Open Items

## Purpose

This file tracks only work that is still open after the Phase 1, Phase 2, and Phase 3 convergence pass.

Closed phase notes and superseded execution detail should not be re-added here. Use archived guides for historical context.

## Current Baseline

Use these documents as the active planning basis:

- `NEXT_DEVELOPMENT_BASELINE.md`
- `docs/guides/staged-development-plan.md`
- `docs/guides/asset-model-and-runtime-assets.md`
- `docs/reference/management-observability-baseline.md`

## Active Open Items

### 1. Phase 3 compatibility cleanup

Status: active

Remaining work:

- verify whether external callers still use backend `documents/:id/quick-publish-mcp`
- remove or quarantine the backend quick-publish compatibility route after usage is ruled out
- continue reducing endpoint-direct or server-first helper contracts where runtime-asset replacement surfaces already exist

Reason:

- OpenAPI import and manual registration no longer publish runtime assets from the active UI path
- frontend quick-publish client contracts have already been removed
- backend compatibility should be removed deliberately, not silently

### 2. Runtime-asset-first observability hardening

Status: active

Remaining work:

- broaden system-log, audit-log, and metrics projections on top of the runtime-asset-first model
- deepen publication-to-runtime-to-monitoring correlation beyond the current handoff links and query filters
- keep residual `/v1/servers/*` observability routes clearly marked as compatibility surfaces

Progress:

- Monitoring now consumes runtime asset handoff query parameters for gateway access-log filtering
- runtime-native websocket and normalized runtime-asset observability are the mainline contracts

### 3. I18n and encoding hardening

Status: active

Remaining work:

- continue replacing user-visible or high-maintenance mojibake in touched areas
- modularize large locale files when doing related feature work
- avoid broad churn in template/style comments that do not affect operators or maintainers

Progress:

- OpenAPI document client logs, dynamic validation fallback messages, and high-value comments have been normalized
- the current policy is targeted cleanup, not whole-file cosmetic rewriting

### 4. Frontend structural cleanup

Status: active / defer until behavior is stable

Remaining work:

- split `EndpointRegistry` only after release behavior is stable
- keep registration, governance, and publication behavior separate even while they still share implementation surface
- monitor bundle-size and code-splitting opportunities during release hardening

Reason:

- Phase 1/2 behavior is now aligned, but a large component refactor would add risk before release validation

### 5. Cross-platform operational polish

Status: active

Remaining work:

- keep Windows and Ubuntu setup, build, and validation commands in sync
- verify release-readiness commands on the supported local development paths
- avoid platform-specific shortcuts in docs unless explicitly scoped

### 6. Security and notification delivery

Status: deferred

Deferred work:

- email verification delivery
- password reset email delivery
- email notification delivery
- additional security workflow completeness checks beyond the current management guards

Reason:

- these remain valid product work, but they are intentionally outside the current product-spine closure line

## Closed In Phase 1

- OpenAPI import and manual endpoint registration are separate construction methods under `API Registration`
- registration no longer implies runtime publication
- `API Testing` is now visible as the lifecycle gate before governance
- successful testing links operators into governance
- governance remains the only readiness decision surface before publication

## Closed In Phase 2

- publication consumes governance-ready endpoint candidates as the normal input
- blocked candidates are no longer selectable in the normal publication builder flow
- MCP Server and Gateway runtime targets are peer publication options
- runtime asset drafts and memberships are created from publication, not registration
- publication membership workbench supports configuration, publish/offline, deploy/start/stop/redeploy, batch actions, audit visibility, and downstream Runtime Assets / Monitoring handoff

## Closed Or No Longer Open

- supported MCP transports are `stdio`, `streamable`, and `sse`
- management websocket is not an MCP transport
- SQLite and PostgreSQL are both supported product paths, with SQLite as default
- ApiNova is not intended to become an enterprise full-traffic gateway in the current baseline
- earlier Stage 0 through Stage 6 asset-model correction work is historical baseline, not an active open item
