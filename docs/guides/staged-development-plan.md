# Staged Development Plan

## Purpose

This document turns the current corrected asset model and the new product-spine target into an execution-oriented plan.

## Architecture Check Summary

The underlying asset direction remains correct:

- `parser -> server -> api -> ui` is still the right layering
- source service assets, endpoint definitions, runtime assets, and runtime observability are now the right backbone
- MCP runtime and Gateway runtime should continue to be treated as peer publication targets over the same endpoint catalog

The current problem is no longer the basic asset model. The main product drift is operator workflow:

1. registration is still not consistently separated from publication
2. testing is not yet a first-class lifecycle gate
3. governance is not yet the single place where endpoints become `ready`
4. publication is not yet a clean dual-runtime surface exposed only after readiness

## Current Completion Status

### Foundation already landed

- Stage 0 is complete enough to treat as baseline
- Stage 1 is complete enough to treat as baseline
- Stage 2 is materially complete enough to treat as baseline
- Stage 3 is materially complete enough to treat as baseline
- Stage 4 is materially complete enough to treat as baseline
- Stage 5 is materially complete enough to treat as baseline
- Stage 6 is materially complete enough to treat as baseline for the corrected asset and observability model

### What the foundation now gives us

- API import and manual registration both land in one corrected source-service and endpoint catalog
- publication ownership is runtime-asset membership first
- MCP and Gateway both already have runtime-asset level assembly and control paths
- runtime-asset-first observability is now the intended monitoring baseline

### Remaining drift after the foundation work

1. some operator-facing flows still make runtime creation appear too early
2. OpenAPI import and manual registration are still not productized as one registration surface
3. testing and governance are not yet clearly staged before publication
4. some compatibility APIs and UI paths still carry server-first or endpoint-direct assumptions

## Active Delivery Line

The next development cycle should execute against the following product spine:

1. API Registration
2. API Testing
3. API Governance
4. API Publication

Runtime Assets and Monitoring remain downstream operational surfaces, not substitutes for the top-level workflow.

## Top-Level Product Constraints

The following constraints should now be treated as product-level and architecture-level rules rather than optional UI wording:

1. registration introduces catalog assets only
2. testing is the explicit functional validation gate after registration
3. governance is the only surface where endpoints become `ready`
4. publication is the first surface where runtime identities appear
5. runtime assets and monitoring are downstream usage-side surfaces, not replacements for the top-level lifecycle

### Lifecycle Mapping

The top-level flow is:

1. `API Registration`
2. `API Testing`
3. `API Governance`
4. `API Publication`
5. `Runtime Assets / Monitoring`

Mapped to the corrected asset model:

- registration creates or updates `source_service_asset` and `endpoint_definition`
- testing validates one `endpoint_definition` functionally and writes testing qualification back onto the endpoint asset
- governance evaluates probe, metadata, lifecycle, and testing qualification, then decides readiness
- publication consumes readiness and creates `runtime_asset` plus runtime membership for MCP or Gateway
- runtime operations and monitoring act on runtime assets after publication

### State Transition Baseline

The main endpoint lifecycle should be understood as:

1. `registered`
2. `tested` or `test_blocked`
3. `ready` or `blocked`
4. `published / active / offline` on runtime memberships and runtime assets

Interpretation:

- `registered` means the endpoint is catalogued but has not yet passed functional verification
- `tested` means functional verification passed and the endpoint can enter governance readiness review
- `test_blocked` means testing failed or remains blocked; publication must not proceed
- `ready` means governance has accepted the endpoint for publication
- `blocked` means governance still prevents publication
- runtime publish state belongs to publication outputs, not to registration or testing

## Stage A: Rebuild Top-Level Product Structure

### Goal

Make the operator-facing product navigation and main workflow reflect the intended lifecycle instead of historical implementation order.

### Workstreams

1. move the top-level product language to `API Registration`, `API Testing`, `API Governance`, and `API Publication`
2. keep Runtime Assets and Monitoring as downstream operational surfaces
3. remove or demote legacy labels that imply registration equals publication

### Exit criteria

- product navigation matches the intended lifecycle
- registration, governance, and publication are no longer mixed together in the main flow

## Stage B: Unify API Registration

### Goal

Turn import and manual entry into two registration modes under one top-level capability.

### Workstreams

1. make `API Registration` the single entry point for import and manual registration
2. ensure registration writes catalog assets only
3. remove hidden runtime-creation semantics from registration APIs and UI flows
4. align registration detail views around source-service and endpoint catalog assets

### Exit criteria

- import and manual entry feel like two paths into the same registry
- registration does not imply MCP Server or Gateway runtime creation

## Stage C: Connect API Testing To The Main Flow

### Goal

Make endpoint testing the explicit functional validation gate after registration.

### Workstreams

1. expose testing as a distinct lifecycle stage
2. connect test results to endpoint qualification state
3. make downstream governance and publication surfaces depend on test-qualified endpoints

Current Stage C.1 baseline:

- endpoint functional test results are written back onto `endpoint_definition.metadata`
- endpoint qualification is now expressed through testing metadata such as `testStatus` and `qualificationState`
- governance readiness now treats `testStatus=passed` as a prerequisite
- publication readiness now also treats `testStatus=passed` as a prerequisite for runtime exposure
- testing can now be entered directly from registration and governance surfaces against a concrete endpoint asset

### Exit criteria

- operators can see which endpoints are registered but untested, tested, or test-blocked
- testing outcome is visible as a gating condition before governance and publication

## Stage D: Rebuild API Governance Around Endpoint Readiness

### Goal

Make governance the single product surface where endpoints become `ready`.

### Workstreams

1. center governance on endpoint readiness, probe verification, and lifecycle review
2. keep governance endpoint-granular while preserving source-service grouping
3. remove publication-first assumptions from governance UX and APIs

### Exit criteria

- governance owns the transition from `tested` to `ready`
- readiness is no longer inferred indirectly from publication settings

## Stage E: Rebuild API Publication

### Goal

Expose publication as the first place where runtime identities appear, with MCP and Gateway as peer targets.

### Workstreams

1. show only `ready` endpoints or ready endpoint groups as publish candidates
2. create or choose MCP runtime assets and Gateway runtime assets from the publication surface
3. create runtime memberships from ready endpoint candidates instead of assuming memberships already exist
4. make publication output traceable to runtime assets, memberships, and revisions
5. keep publication-side asset management independent for MCP and Gateway

Reference baseline:

- `docs/guides/publication-resource-baseline.md`

Current Stage E.1/E.2 baseline:

- publication view now treats readiness as an upstream governance result rather than a local edit concern
- publication view defaults to `ready` candidates and can still expose blocked candidates for diagnosis
- MCP and Gateway publication targets are now shown as peer runtime-membership rows
- publication rows now expose target identity, runtime asset, publish state, target configuration summary, and readiness details
- non-ready publication rows are visible for diagnosis but are not directly publishable from the main action path

Current Stage E.3 baseline:

- publication rows now also expose membership revision and profile status directly in the publication list
- publication configuration dialogs now surface current revision and publish state before editing profile or route configuration
- publication configuration is becoming page-visible state rather than a hidden set of edit-only fields

Current Stage E.4 baseline:

- publication actions now distinguish publish intent at the list level more explicitly, including publish, republish, and activate semantics
- offline actions are now constrained to active publication rows instead of appearing equally actionable for every row
- publication action flow is being tightened so publication is treated as a runtime-membership lifecycle rather than a generic endpoint toggle
- publication success and failure feedback now use more explicit action-state wording in the publication surface
- publication failure feedback now starts classifying blocking causes into profile, target-config, readiness, or governance categories

Current Stage E.5 baseline:

- publication rows now provide a direct navigation path into Runtime Assets using runtime-asset-aware filtering
- publication outcomes are now more directly traceable from the publication surface into the downstream runtime operations surface

Current Stage E gap after baseline review:

- publication backend control logic is materially present at runtime-membership level
- publication still lacks the productized entry flow that turns governance-ready endpoints into runtime assets and memberships
- this means the current publication surface behaves more like a membership control panel than a complete publication workbench

Current Stage E.6 baseline:

- publication surface now also exposes governance-ready publication candidates before runtime memberships exist
- operators can now create publication runtime asset drafts for MCP and Gateway directly from the publication surface
- operators can now add selected ready endpoints into a chosen runtime asset, which creates runtime memberships from publication candidates
- publication page therefore no longer depends on pre-existing memberships to become usable as a publication workbench

Current Stage E.7 baseline:

- publication surface now also includes a selected-membership workbench instead of relying only on a configuration dialog
- publication readiness on the backend now re-checks governance-side lifecycle, probe, publish-enabled, and testing conditions in addition to profile and route requirements
- publication workbench now exposes publish state, profile state, route-config state, and blocking reasons more explicitly before operators attempt publish actions

Current Stage E.8 baseline:

- publication workbench now also includes direct runtime handoff controls for the selected runtime asset instead of forcing operators to switch surfaces immediately after publish
- runtime deploy, start, stop, and redeploy actions are now available from the publication workbench and refresh publication plus runtime summaries after execution
- runtime handoff actions now respect publication-side preconditions more explicitly, such as requiring active published memberships before deploy or redeploy and requiring an MCP deployment before start
- publication therefore now reaches one step further downstream into runtime operations while still keeping Runtime Assets and Monitoring as the dedicated operational surfaces
- publication workbench now also exposes a stage-by-stage flow view from governance readiness through membership publish, runtime deploy, and runtime activation
- publication workbench now also exposes traceability fields for runtime membership, runtime asset, endpoint definition, and source service asset so operators can follow one publication item across downstream surfaces

Current Stage E.9 baseline:

- publication workbench now also supports batch membership operations within the selected publication unit, starting with batch publish and batch offline
- batch operations currently reuse the normalized membership publish and offline APIs, keeping Stage P5 aligned with the runtime-membership-first publication model
- publication batch toolbar now also provides quick selection helpers for publishable and already-active memberships
- publication workbench now also exposes a recent activity view for the current publication unit, using normalized operation-feed entries with runtime asset and membership context
- publication batch area now also surfaces current-unit runtime deploy and start shortcuts so publish-side operators can continue runtime handoff without leaving the selected publication unit
- publication batch actions now persist a last-run result summary together with the recommended next step, reducing ambiguity after batch publish or batch offline completes
- publication backend now persists `publication_batch_runs` and `publication_audit_events`, and batch publish/offline paths now write structured batch plus per-membership audit records
- publication UI activity view can now read persisted publication audit events for the current runtime asset instead of relying only on local page state

### Exit criteria

- publication is a dual-runtime surface, not a registration side effect
- MCP Server and Gateway runtime are both visible as publication outcomes

Current Stage F baseline:

- manual endpoint registration no longer creates `MCPServerEntity` carrier records implicitly and now lands as catalog assets only
- active registration, governance, and publication UI paths no longer fall back to `servers/api-center/*` write operations for their main actions
- the `/runtime-assets` surface now reads from `v1/runtime-assets` and uses runtime-asset-native start, stop, and redeploy operations instead of the old managed-server list path
- the frontend `api-center` client methods that were no longer used by the active product spine have been removed from the main UI client surface
- runtime asset list items can now open a dedicated runtime-asset detail view instead of redirecting operators back into the old server-first detail page
- the old `/servers/:id` route and `ServerDetail.vue` page have been removed from the active UI flow so runtime asset detail is the only primary detail entry in the current product spine

Current post-Stage F drift review:

- frontend server-management store cleanup has been closed on the mainline, and residual `selectedServer` / `selectedServerId` assumptions have been removed from the active store, websocket, and composable path
- publication internals have now been moved onto endpoint-definition and runtime-membership-first resolution for the active mainline path, removing `MCPServerEntity` / `legacyEndpointId` as publication-core dependencies
- active documentation drift has been corrected, and old registration-time MCP creation plus active `servers/api-center/*` contract references have been removed from the main guide set
- publication profile, publish binding, route binding, and profile-history semantics are now being normalized around `endpointDefinitionId` instead of legacy `endpointId` naming in the active model
- websocket runtime observability subscriptions now take `runtimeAssetId` as the public runtime-target identity in the active UI and backend contract, with monitoring metrics keyed by runtime asset instead of managed server at the subscription boundary
- runtime-asset detail now also consumes runtime-native websocket asset/event/log updates for live refresh, instead of remaining a polling-only management detail page
- residual `/v1/servers/*` observability endpoints are now more explicitly treated as managed-server compatibility entrypoints that surface `runtimeAssetId` in query/response models, instead of pretending the managed server id is the only runtime identity
- residual `/v1/servers/:id/process/*` endpoints now also return `runtimeAssetId` context in their compatibility responses, so process-side management data no longer hides the runtime-asset identity behind the managed-server carrier

## Stage F: Remove Transitional Runtime-Creation Shortcuts

### Goal

Retire the remaining compatibility behaviors that contradict the corrected product spine.

### Workstreams

1. remove registration-time runtime creation shortcuts
2. retire endpoint-direct or server-first compatibility APIs where replacement surfaces exist
3. complete final drift review across docs, APIs, UI, and runtime control flows

### Exit criteria

- registration no longer creates runtime carriers implicitly
- runtime identity exists only after publication

## Stage G: Drift Closure And Legacy Publication Removal

### Goal

Close the remaining mismatches found after the product-spine restructuring and make the mainline code and documentation converge on the same runtime-asset-first model.

### Workstreams

1. update active documentation so it reflects the current post-Stage F baseline instead of the removed compatibility model
2. finish frontend server-first store cleanup and restore green type-check
3. migrate publication internals away from `MCPServerEntity`-first resolution and reduce `legacyEndpointId` compatibility dependencies
4. run one explicit regression review after each closure item

### Exit criteria

- active docs no longer describe registration-time MCP creation or `servers/api-center/*` as active mainline contracts
- frontend mainline passes type-check without residual selected-server compatibility state
- publication service resolves publication state through endpoint definitions, source assets, runtime assets, and memberships as the main path
- endpoint-direct publication compatibility routes are no longer part of the active publication contract where membership APIs already exist
- publication data contracts and persistence semantics use `endpointDefinitionId` as the normalized publication-side identity

## Retrospective Rule

Each stage must end with one explicit backward review covering:

1. architecture drift
2. product workflow drift
3. unnecessary transitional complexity
4. optimization opportunities before moving forward
