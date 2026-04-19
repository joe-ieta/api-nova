# Open Items

## Purpose

This document records intentionally deferred, partially implemented, or not-yet-productized items in the current design.

## Active Execution Basis

Use the following documents together when planning the next development cycle:

- `NEXT_DEVELOPMENT_BASELINE.md`
- `docs/guides/staged-development-plan.md`
- `PRODUCT_CONSTRAINTS.md`

## Stage Snapshot

Corrected asset-model foundation already landed:

- Stage 0: Freeze the transitional model
- Stage 1: Build the corrected asset skeleton
- Stage 2: Implement source asset catalog and endpoint registry correction
- Stage 3: Move publication to runtime-asset membership
- Stage 4: Rebuild MCP runtime assets
- Stage 5: Rebuild Gateway runtime assets
- Stage 6: Migrate old model and remove dual-write shortcuts

Current active execution line has shifted to product-spine restructuring:

- Stage A: Rebuild top-level product structure
- Stage B: Unify API Registration
- Stage C: Connect API Testing to the main flow
- Stage D: Rebuild API Governance around endpoint readiness
- Stage E: Rebuild API Publication
- Stage F: Remove transitional runtime-creation shortcuts
- Stage G: Drift closure and legacy publication removal

## Current Open Items

### 1. Product workflow spine restructuring
Status: active / high priority

Why it remains open:

- the corrected backend asset model already distinguishes catalog assets from runtime assets
- the operator-facing product still does not consistently present `API Registration -> API Testing -> API Governance -> API Publication`
- OpenAPI import and manual endpoint registration still feel like two different product stories instead of two registration modes under one top-level concept
- some existing UI and API entry points still expose runtime publication concepts too early in the operator journey

Impact:

- high

### 2. Architecture documentation baseline rewrite
Status: partially addressed  
Impact: medium

### 3. Active guide set still needs pruning and normalization
Status: partially addressed  
Impact: high

### 4. Direct spec transformation fallback consistency
Status: partially addressed  
Impact: high

### 5. Security guard coverage on management endpoints
Status: materially addressed / follow-up verification only  
Impact: high

### 6. Permission and security workflow completeness
Status: deferred / partial  
Impact: medium

### 7. Email-based auth and notification delivery
Status: partially addressed / delivery still deferred  
Impact: medium

### 8. CPU usage and monitoring metric completeness
Status: partially addressed  
Impact: medium

### 9. UI non-baseline entry points and development placeholders
Status: partially addressed / narrowed further  
Impact: medium

### 10. Component and UI dependency cleanup in server management views
Status: partially addressed  
Impact: medium

### 11. Cross-platform operational polish
Status: partially addressed  
Impact: high

### 12. UI production bundle size and code-splitting
Status: partially addressed  
Impact: medium

### 13. Shared publication profile and semantic layer
Status: materially addressed / compatibility cleanup still pending

Why it remains open:

- publication profile ownership has been lifted to runtime-asset membership
- membership-level publication APIs and revision paths now exist
- legacy endpoint-based publication routes and compatibility write-back still remain and should be reduced later

Impact:

- high

### 14. API registration experience is not yet unified
Status: active / high priority

Why it remains open:

- import and manual registration now both land in the corrected asset catalog
- the product surface still does not clearly present them as two registration modes under one `API Registration` capability
- the main manual registration path no longer creates MCP runtime carriers implicitly, but some compatibility APIs and user-facing wording still reflect the older mental model
- registration pages still need to be cleaned so registration introduces assets only, without publication semantics

Impact:

- high

### 15. API testing is not yet a first-class lifecycle gate
Status: partially addressed / active

Why it remains open:

- endpoint test capability already exists
- endpoint functional test results now start writing back to `endpoint_definition.metadata`
- governance readiness and publication readiness now both treat passed testing as a prerequisite
- the remaining work is to complete productization, including broader testing-state visibility, filtering, i18n normalization, and lifecycle presentation across UI surfaces

Impact:

- high

### 16. API governance readiness surface still needs restructuring
Status: active / high priority

Why it remains open:

- endpoint governance capabilities already exist in data and service layers
- readiness shaping, probe verification, and lifecycle review are still being normalized into one consistent governance workbench
- governance must become the place where endpoints become `ready` before any publication choice is shown

Impact:

- high

### 17. API publication surface still needs dual-runtime productization
Status: active / high priority

Why it remains open:

- runtime-asset publication for MCP and Gateway is materially available in the backend
- publication should be exposed only after endpoints are `ready`
- publication UI and APIs still need a clean dual-path product surface where MCP Server and Gateway runtime are peer publication targets
- the current publication surface is still membership-first and assumes runtime assets plus memberships already exist
- the missing product gap is the entry flow from governance-ready endpoint catalog into runtime-asset draft construction

Current execution baseline:

- see `docs/guides/publication-resource-baseline.md`

Active delivery stages:

- `Stage P1`: rebuild publication entry around ready governance output
- `Stage P2`: create/select runtime asset draft and create memberships from ready endpoints
- `Stage P3`: complete membership configuration workbench
- `Stage P4`: connect publish execution cleanly into runtime deploy and runtime operations
- `Stage P5`: batch operations, traceability, and final closure

Current implementation note:

- `Stage P1` and `Stage P2` mainline are now materially addressed in active code
- the publication page now exposes ready publication candidates and can create runtime-asset drafts plus memberships
- `Stage P3` mainline is now materially addressed with a selected-membership workbench, publication checklist, and clearer blocking visibility
- `Stage P4` mainline has now started by connecting selected publication memberships into direct runtime deploy, start, stop, and redeploy controls
- `Stage P4` mainline now also exposes publication-to-runtime flow stages and runtime/publication traceability fields directly in the publication workbench
- `Stage P5` mainline has now started with batch membership publish and batch membership offline actions in the publication workbench
- `Stage P5` mainline now also includes batch quick-selection helpers and a current publication-unit activity view in the publication workbench
- `Stage P5` mainline now also includes batch result summaries, recommended next steps, and current-unit runtime handoff shortcuts after batch actions
- publication backend mainline now also includes persisted `publication_batch_runs` and `publication_audit_events`, with publication UI batch actions switched onto the new batch endpoints
- remaining work is concentrated in larger-scope batch workflows, stronger runtime-side audit coverage, and final publication/runtime closure

Impact:

- high

### 18. Transitional runtime-creation shortcuts still exist
Status: partially addressed / compatibility cleanup pending

Why it remains open:

- corrected publication ownership is runtime-asset-first
- the main manual registration write path no longer creates runtime carriers during registration
- the old `ServersApiCenterController` compatibility routes are no longer mounted as active backend APIs
- remaining work is to retire leftover compatibility contracts and residual server-first detail or management entry points that still expose the old mixed model

Impact:

- high

### 18.1 Frontend server-first management state cleanup
Status: materially addressed / verification follow-up only

Why it remains open:

- the product spine has moved primary runtime operations onto runtime-asset-native list and detail pages
- the residual `selectedServer` and `selectedServerId` assumptions in frontend store, websocket, and composable layers have now been removed from the active mainline path
- remaining work is limited to follow-up verification and any optional simplification in non-baseline compatibility views

Impact:

- high

### 18.2 Publication service legacy carrier dependency removal
Status: materially addressed / follow-up verification only

Why it remains open:

- publication UI and runtime-asset surfaces already treat runtime memberships as the main publication unit
- `PublicationService` mainline resolution has now been moved onto endpoint definitions, source assets, runtime assets, and runtime memberships
- the unused endpoint-direct publication compatibility routes have been removed from the active mainline path; remaining work is follow-up verification only

Impact:

- high

### 18.3 Publication data-model semantic normalization
Status: materially addressed / verification follow-up only

Why it remains open:

- publication-side persistence and API semantics have been normalized around `endpointDefinitionId`
- publication profiles, publish bindings, route bindings, and profile-history records no longer treat legacy `endpointId` naming as the active publication identity
- remaining work is limited to rebuild verification and any optional cleanup of non-publication modules that still use their own local `endpointId` concepts

Impact:

- medium

### 19. I18n locale-file modularization and encoding hardening
Status: partially addressed / still active  
Impact: medium

### 20. HTTP gateway runtime for published endpoints
Status: materially addressed / runtime-carrier decoupling still pending

Why it remains open:

- gateway forwarding, route binding, and basic publish-state enforcement already exist
- the HTTP path now resolves through `gateway_service_asset` membership and `source_service_asset`
- top-level runtime-asset control, policy-binding, and basic observability now exist for Gateway
- gateway runtime is still one in-process carrier and its observability is not yet persisted into the broader monitoring pipeline

Impact:

- high

### 21. Dual publish consistency and route binding
Status: partially implemented / compatibility cleanup still pending

Why it remains open:

- shared publication-related tables and membership-based publication ownership now exist
- MCP runtime asset path is materially established
- Gateway runtime asset path now has membership-first forwarding, top-level control, and basic observability
- cross-surface consistency still needs final tightening while legacy endpoint compatibility and server-first monitoring remain in place

Impact:

- high

### 22. Corrected asset hierarchy is not yet implemented
Status: materially addressed / legacy server-first compatibility still pending

Why it remains open:

- source service assets, endpoint definitions, and runtime-asset tables now exist
- document import and manual registration already land in the corrected source and endpoint catalog
- publication and MCP runtime paths now materially use runtime assets
- the main runtime-assets list and detail path now expose runtime assets directly instead of routing operators through the old managed-server list for primary runtime navigation
- the old server-first detail page has been removed from the active UI path
- remaining work is concentrated in residual server-centric service/store APIs and other mixed-model management surfaces that still exist for compatibility or operational fallback

Impact:

- high

### 23. Runtime-asset-first observability persistence
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

### 24. Frontend websocket runtime-native convergence
Status: materially addressed

Why it remains open:

- backend websocket management subscriptions now use runtime-native `subscribe-runtime-*` channels without the old `subscribe:*` aliases
- frontend websocket service no longer exposes `metrics:*`, `server:status`, or `process:*` compatibility events as its main API
- server-management views now subscribe through runtime-native event names
- active websocket runtime-asset subscriptions now use `runtimeAssetId` as the public runtime-target key, and monitoring store runtime metrics are keyed by runtime asset instead of managed server on the mainline path
- runtime-asset detail has also been moved onto runtime-native websocket asset/event/log refresh instead of staying polling-only
- residual `/v1/servers/*` monitoring endpoints now expose `runtimeAssetId` more explicitly in the compatibility DTO surface, reducing ambiguity between managed-server carriers and runtime assets
- residual `/v1/servers/:id/process/*` compatibility endpoints now also surface `runtimeAssetId` in returned process/log/resource data instead of keeping process monitoring fully server-first
- remaining websocket-side auxiliary events such as management CRUD notifications are not part of the runtime-observability contract and therefore are not treated as a drift item

Impact:

- low

## What Is Not An Open Item

- supported MCP transports are `stdio`, `streamable`, and `sse`
- management websocket is not an MCP transport
- SQLite and PostgreSQL are both supported product paths, with SQLite as default
- Windows and Ubuntu must both remain supported
- ApiNova is not intended to become an enterprise full-traffic gateway in the current baseline
