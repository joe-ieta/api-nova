# Open Items

## Purpose

This document records intentionally deferred, partially implemented, or not-yet-productized items in the current design.

## Active Execution Basis

Use the following documents together when planning the next development cycle:

- `NEXT_DEVELOPMENT_BASELINE.md`
- `docs/guides/staged-development-plan.md`
- `PRODUCT_CONSTRAINTS.md`

## Stage Snapshot

Completed or materially closed stages in the corrected asset model:

- Stage 0: Freeze the transitional model
- Stage 1: Build the corrected asset skeleton
- Stage 2: Implement source asset catalog and endpoint registry correction
- Stage 3: Move publication to runtime-asset membership

Remaining active stages:

- Stage 4: Rebuild MCP runtime assets
- Stage 5: Rebuild Gateway runtime assets
- Stage 6: Migrate old model and remove dual-write shortcuts

## Current Open Items

### 1. Architecture documentation baseline rewrite
Status: partially addressed  
Impact: medium

### 2. Active guide set still needs pruning and normalization
Status: partially addressed  
Impact: high

### 3. Direct spec transformation fallback consistency
Status: partially addressed  
Impact: high

### 4. Security guard coverage on management endpoints
Status: materially addressed / follow-up verification only  
Impact: high

### 5. Permission and security workflow completeness
Status: deferred / partial  
Impact: medium

### 6. Email-based auth and notification delivery
Status: partially addressed / delivery still deferred  
Impact: medium

### 7. CPU usage and monitoring metric completeness
Status: partially addressed  
Impact: medium

### 8. UI non-baseline entry points and development placeholders
Status: partially addressed / narrowed further  
Impact: medium

### 9. Component and UI dependency cleanup in server management views
Status: partially addressed  
Impact: medium

### 10. Cross-platform operational polish
Status: partially addressed  
Impact: high

### 11. UI production bundle size and code-splitting
Status: partially addressed  
Impact: medium

### 12. Shared publication profile and semantic layer
Status: materially addressed / compatibility cleanup still pending

Why it remains open:

- publication profile ownership has been lifted to runtime-asset membership
- membership-level publication APIs and revision paths now exist
- legacy endpoint-based publication routes and compatibility write-back still remain and should be reduced later

Impact:

- high

### 13. Imported-endpoint governance is still narrower than the manual registry path
Status: materially addressed / intentionally limited

Why it remains open:

- imported endpoints now have a lightweight registry view and clearer service-scope messaging
- they still do not have the same selective publication policy depth or lifecycle review depth as a full API governance platform

Impact:

- high

### 14. I18n locale-file modularization and encoding hardening
Status: partially addressed / still active  
Impact: medium

### 15. HTTP gateway runtime for published endpoints
Status: materially addressed / runtime-carrier decoupling still pending

Why it remains open:

- gateway forwarding, route binding, and basic publish-state enforcement already exist
- the HTTP path now resolves through `gateway_service_asset` membership and `source_service_asset`
- top-level runtime-asset control, policy-binding, and basic observability now exist for Gateway
- gateway runtime is still one in-process carrier and its observability is not yet persisted into the broader monitoring pipeline

Impact:

- high

### 16. Dual publish consistency and route binding
Status: partially implemented / compatibility cleanup still pending

Why it remains open:

- shared publication-related tables and membership-based publication ownership now exist
- MCP runtime asset path is materially established
- Gateway runtime asset path now has membership-first forwarding, top-level control, and basic observability
- cross-surface consistency still needs final tightening while legacy endpoint compatibility and server-first monitoring remain in place

Impact:

- high

### 17. Corrected asset hierarchy is not yet implemented
Status: materially addressed / legacy server-first compatibility still pending

Why it remains open:

- source service assets, endpoint definitions, and runtime-asset tables now exist
- document import and manual registration already land in the corrected source and endpoint catalog
- publication and MCP runtime paths now materially use runtime assets
- server-first management, monitoring, and some compatibility write-back still need to be reduced before the old mixed model can be retired

Impact:

- high

### 18. Runtime-asset-first observability persistence
Status: partially addressed / migration still in progress

Why it remains open:

- the new Stage 6 target model and persistence skeleton now exist
- gateway runtime request and control signals now start writing through the new runtime-asset-first data chain
- MCP runtime deploy, lifecycle, health, and tool-call paths now also write to the new runtime-asset-first path
- runtime-asset observability now exposes a normalized view from the new model instead of treating old server-first tables as compatibility targets
- legacy management overview and managed-server observability routes now also read from the normalized runtime-asset view
- monitoring dashboard and monitoring store now also use the normalized runtime-asset view, with websocket updates reduced to refresh-trigger semantics
- websocket gateway now emits runtime-native overview, asset observability, event, log, and alert messages as its primary monitoring contract
- system-log, audit-log, and metrics capability projections still need broader rollout on top of the new model

Impact:

- high

### 19. Frontend websocket runtime-native convergence
Status: materially addressed

Why it remains open:

- backend websocket management subscriptions now use runtime-native `subscribe-runtime-*` channels without the old `subscribe:*` aliases
- frontend websocket service no longer exposes `metrics:*`, `server:status`, or `process:*` compatibility events as its main API
- server-management views now subscribe through runtime-native event names
- remaining websocket-side auxiliary events such as management CRUD notifications are not part of the runtime-observability contract and therefore are not treated as a drift item

Impact:

- low

## What Is Not An Open Item

- supported MCP transports are `stdio`, `streamable`, and `sse`
- management websocket is not an MCP transport
- SQLite and PostgreSQL are both supported product paths, with SQLite as default
- Windows and Ubuntu must both remain supported
- ApiNova is not intended to become an enterprise full-traffic gateway in the current baseline
