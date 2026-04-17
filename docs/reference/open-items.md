# Open Items

## Purpose

This document records intentionally deferred, partially implemented, or not-yet-productized items in the current design.

These items should stay visible. They should not be hidden from documentation simply because they are not finished yet.

At the same time, they are not part of the current release baseline unless explicitly stated otherwise.

## Open Item Rules

- An open item may be planned, partially implemented, or explicitly deferred.
- An open item is not a release commitment unless it is moved into the active baseline.
- If an open item affects operator expectations, active docs should reference it here instead of implying that it already works.

## Active Execution Basis

Use the following documents together when planning the next development cycle:

- `NEXT_DEVELOPMENT_BASELINE.md`
- `docs/guides/staged-development-plan.md`
- `PRODUCT_CONSTRAINTS.md`

The top priority after the current convergence pass is Stage 4 through Stage 5 work, not reopening already-hardened branding, release-baseline, management-contract, or endpoint-governance changes unless a regression is found.

## Stage Snapshot

Completed or materially closed stages:

- Stage 1: Anti-drift and release contract hardening
- Stage 2: Management contract refactor
- Stage 3: Endpoint governance parity
- Stage 6: Productionization and multilingual governance baseline

Remaining active stages:

- Stage 4: Semantic publication layer
- Stage 5: Production readiness polish

## Current Open Items

### 1. Architecture documentation baseline rewrite

Status:

- partially addressed

Why it remains open:

- architecture documentation has historically drifted away from the real implementation
- package-level architecture notes still need continued tightening as code evolves

Impact:

- medium

### 2. Active guide set still needs pruning and normalization

Status:

- partially addressed

Why it remains open:

- core setup and database-mode guides have been rewritten into the current baseline
- the broader active guide set still needs continued pruning and consistency review as release work continues
- several historical or feature-specific guides have now been moved to archive, but package-level README cleanup and some remaining guide normalization work still remain

Impact:

- high

### 3. Direct spec transformation fallback consistency

Related code:

- `packages/api-nova-server/src/lib/initTools.ts`

Status:

- partially addressed

Why it remains open:

- direct spec initialization is now supported in the runtime wrapper
- the legacy `lib/initTools.ts` helper no longer emits unconditional stdout logs and now follows the quiet-by-default runtime rule
- transformation behavior is still split across more than one entry path and should continue to be unified

Impact:

- high

### 4. Security guard coverage on management endpoints

Related code:

- `packages/api-nova-api/src/modules/servers/servers.controller.ts`

Status:

- materially addressed / follow-up verification only

Why it remains open:

- management routes now have narrower controller slices plus explicit permission/observability baseline documents
- remaining work is mostly follow-up verification and drift prevention, not large structural refactor

Impact:

- high

### 5. Permission and security workflow completeness

Related code:

- `packages/api-nova-api/src/modules/security/controllers/permission.controller.ts`

Status:

- deferred / partial

Why it remains open:

- some permission-related capabilities are present as structure or commented placeholders but are not fully productized

Impact:

- medium

### 6. Email-based auth and notification delivery

Related code:

- `packages/api-nova-api/src/modules/security/services/auth.service.ts`
- `packages/api-nova-api/src/modules/websocket/services/notification.service.ts`

Status:

- partially addressed / delivery still deferred

Why it remains open:

- registration verification, password reset mail delivery, and email notification sending are not fully implemented
- the current baseline now makes this boundary more explicit in API/runtime behavior, but it still does not provide a real outbound email path

Impact:

- medium

### 7. CPU usage and monitoring metric completeness

Related code:

- `packages/api-nova-api/src/modules/servers/services/server-metrics.service.ts`

Status:

- partially addressed

Why it remains open:

- placeholder CPU values in `ServerMetricsService` have been downgraded to explicit unavailable fields, and operator-visible telemetry now distinguishes measured, derived, and unavailable values more clearly
- a consistent real CPU telemetry path is still not implemented across summary metrics, so this remains a production-polish item rather than a management-contract blocker

Impact:

- medium

### 8. UI non-baseline entry points and development placeholders

Related code:

- `packages/api-nova-ui/src/layout/MainLayout.vue`
- `packages/api-nova-ui/src/locales/*`

Status:

- partially addressed / narrowed further

Why it remains open:

- endpoint governance and management navigation are now materially clearer than before
- some placeholder-oriented routes and screens still exist and should remain clearly marked until they are fully implemented or archived

Impact:

- medium

### 9. Component and UI dependency cleanup in server management views

Related code:

- `packages/api-nova-ui/src/modules/servers/ServerManager.vue`

Status:

- partially addressed

Why it remains open:

- server management now links more coherently into endpoint governance and no longer blocks the main operator path
- the view still needs continued cleanup around interaction complexity, historical debug-oriented behavior, and general production polish

Impact:

- medium

### 10. Cross-platform operational polish

Status:

- partially addressed

Why it remains open:

- Windows and Ubuntu remain supported product targets
- active local setup and database-mode guides have been rewritten into a clean baseline
- command examples, process behavior, encoding, and path handling still require continued review whenever runtime changes occur

Impact:

- high

### 11. UI production bundle size and code-splitting

Related code:

- `packages/api-nova-ui/vite.config.ts`
- `packages/api-nova-ui/src/modules/*`

Status:

- partially addressed

Why it remains open:

- Monaco editor has been moved out of the application startup path and the UI build now uses clearer feature-level chunking
- vendor splitting now separates Vue/runtime dependencies, app-heavy libraries, Monaco, charts, and feature-level i18n payloads more explicitly
- the main entry bundle is materially smaller, but Vite still reports oversized vendor chunks for Monaco, charts, and Element Plus
- further reduction likely needs more selective dependency loading and targeted vendor-splitting rather than only route-level chunking

Impact:

- medium

### 12. Semantic endpoint layer for LLM-oriented publishing

Related documents:

- `docs/guides/endpoint-semantic-layer-requirements.md`
- `docs/archive/guides/endpoint-semantic-layer-sprint-breakdown.md`

Status:

- planned / not yet implemented

Why it remains open:

- manual and imported endpoints now share a lightweight governance model, which removes the biggest precondition for semantic publication work
- tool publication still largely reflects upstream API semantics directly
- the planned semantic layer for operator-defined endpoint meaning, naming refinement, and LLM-oriented descriptions has not been implemented yet

Impact:

- high

### 13. Imported-endpoint governance is still narrower than the manual registry path

Related code:

- `packages/api-nova-api/src/modules/servers/services/api-management-center.service.ts`
- `packages/api-nova-ui/src/modules/endpoint-registry/EndpointRegistry.vue`

Status:

- materially addressed / intentionally limited

Why it remains open:

- imported OpenAPI endpoints now have a lightweight registry view with probe/readiness/publish/offline controls, governance editing, and clearer operator-facing service-scope messaging
- they still do not have the same selective publication policy depth or lifecycle review depth as a full API governance platform
- this is now an intentional product-scope boundary rather than a hidden UX gap, but it should remain visible until Stage 4 and later work decide whether deeper governance is needed

Impact:

- high

### 14. I18n locale-file modularization and encoding hardening

Related code:

- `packages/api-nova-ui/src/locales/zh-CN.ts`
- `packages/api-nova-ui/src/locales/en-US.ts`

Status:

- partially addressed / still active

Why it remains open:

- active locale entrypoints now use modular message overlays instead of relying only on one centralized file
- Chinese remains the default locale and now falls back to English instead of showing corrupted operator text when coverage is incomplete
- several operator-facing surfaces have already been re-aligned to modular locale resources during Stage 3 convergence
- historical encoding corruption is still present in older locale payloads and some non-i18n source comments
- more feature areas still need to migrate out of legacy centralized locale resources

Impact:

- medium

## What Is Not An Open Item

The following are already decided baseline positions, not open items:

- supported MCP transports are `stdio`, `streamable`, and `sse`
- management websocket is not an MCP transport
- SQLite and PostgreSQL are both supported product paths, with SQLite as default
- Windows and Ubuntu must both remain supported

## Promotion Rule

An open item should only move into the active baseline after all of the following are true:

1. implementation is complete enough for product use
2. API/UI/CLI/docs behavior is aligned
3. release verification exists for the affected path
4. the item no longer creates operator confusion
