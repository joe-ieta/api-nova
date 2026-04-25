# ApiNova Next Development Baseline

## Purpose

This document is the active execution baseline for the next development cycle.

## Current Status

The backend asset model correction through the Stage 0 through Stage 6 line is now treated as baseline.

The product-spine convergence line has also materially closed its upstream and downstream mainline phases:

1. Phase 1 closed the `API Registration -> API Testing -> API Governance` mainline
2. Phase 2 closed the `API Publication -> Runtime Assets / Monitoring` mainline
3. Phase 3 is active for compatibility cleanup, observability hardening, targeted i18n/encoding cleanup, and release validation

## Architecture Baseline To Preserve

The next cycle must preserve the current product layering:

- `parser -> server -> api -> ui`

Responsibilities must stay aligned:

- parser owns OpenAPI parsing, validation, normalization, and extracted structures
- server owns MCP transformation and MCP runtime behavior
- api owns orchestration, persistence, security, management contracts, and HTTP gateway runtime
- ui owns operator workflows and presentation

## Execution Order

1. Stage A: Rebuild top-level product structure - closed
2. Stage B: Stabilize API Registration Boundaries - closed
3. Stage C: Connect API Testing to the main flow - closed
4. Stage D: Rebuild API Governance around endpoint readiness - closed
5. Stage E: Rebuild API Publication - closed
6. Stage F: Remove transitional runtime-creation shortcuts - active in Phase 3 compatibility cleanup

Historical planning detail is archived at:

- `docs/archive/guides/product-spine-restructure-plan-2026-04.md`

## Current Delivery Phases

The active work queue is now grouped into the following delivery phases.

### Phase 1: Registration, Testing, Governance Mainline

Status:

- closed for mainline handoff

This phase stabilizes the upstream half of the operator workflow.

Scope:

1. stabilize `API Registration` boundaries while preserving separate batch-import and manual-registration entry surfaces
2. strengthen `API Testing` as the lifecycle gate consumed across registration, governance, and publication
3. rebuild `API Governance` into the single place where endpoint assets become `ready`

Closure baseline:

1. batch OpenAPI registration no longer quick-publishes runtime assets from the registration page
2. manual registration is now treated as endpoint intake and basic maintenance, not a mixed registration/governance/publication page
3. `API Testing` now presents itself as the explicit lifecycle gate between registration and governance
4. successful testing now gives operators a direct next step into `API Governance`
5. governance remains the only surface where readiness is evaluated before publication

Remaining follow-up should be treated as refinement, not as a Phase 2 blocker:

1. governance workbench layout can continue to improve around review productivity
2. compatibility APIs and older publication helpers can be removed when Phase 2 normalizes publication and runtime handoff
3. additional testing-state filters and reports can be added without reopening the registration boundary

### Phase 2: Publication, Runtime Model, Observability Mainline

Status:

- closed for mainline handoff

This phase closes the downstream half of the operator workflow.

Scope:

1. complete `API Publication` productization and publication-to-runtime handoff
2. continue removing residual server-first and endpoint-direct compatibility from the runtime-asset-first mainline
3. improve runtime observability so publication outputs, runtime assets, and monitoring form one traceable flow

Start order:

1. make `API Publication` consume governance-ready endpoints as the only normal candidate source
2. finish the create/select runtime asset draft flow for both MCP and Gateway publication targets
3. normalize runtime membership configuration, publish execution, and deployment handoff
4. remove or quarantine older registration-time and endpoint-direct publication shortcuts
5. close traceability from publication output into Runtime Assets and Monitoring

Current Phase 2 baseline:

- `API Publication` builder now uses governance-ready endpoint candidates as the normal candidate source
- blocked or non-ready endpoints remain diagnosis material outside the normal builder selection path
- runtime asset draft creation now starts from the selected ready candidate group and validates the draft identity before calling the backend
- publication memberships can be configured, published, offlined, batch-operated, deployed, started, stopped, and redeployed from the publication workbench
- publication output now links directly into Runtime Assets and Monitoring so operators can continue downstream observation after publication

Remaining follow-up is now Phase 3 intake:

1. remove residual compatibility APIs and older endpoint-direct helper contracts when they are no longer needed
2. deepen runtime-side audit and monitoring correlation beyond the current publication/runtime traceability fields
3. simplify the shared `EndpointRegistry` component after release hardening if the multi-surface implementation becomes difficult to maintain

### Phase 3: Engineering Polish And Release Hardening

This phase reduces long-tail operational and maintenance drift after the mainline workflow is stable. It also absorbs the remaining Phase 1 and Phase 2 residuals so they are tracked as one release-hardening backlog instead of leaking back into registration or publication design.

Scope:

1. compatibility cleanup for old registration-time quick-publish and endpoint-direct publication helpers
2. runtime-asset-first observability persistence and monitoring correlation hardening
3. cross-platform operational polish for Windows and Ubuntu
4. i18n and encoding hardening
5. UI bundle-size and structural cleanup

Execution order:

1. remove unused frontend compatibility contracts and quarantine remaining backend compatibility routes behind explicit follow-up notes
2. tighten Monitoring handoff from publication output into runtime-asset-first observability views
3. clean operator-facing copy, locale maintenance shape, and encoding risks introduced by the earlier UI convergence work
4. reduce `EndpointRegistry` structural drift only after the release path is stable
5. run release-readiness verification across frontend type-check and targeted backend checks

Current Phase 3 progress:

- unused frontend OpenAPI document quick-publish client contracts have been removed from the active UI client layer
- remaining backend quick-publish route is retained as an explicit compatibility cleanup target until external usage is ruled out
- Monitoring now consumes publication handoff query parameters and applies the runtime asset to gateway access-log filtering
- OpenAPI document client logs, dynamic validation fallbacks, and high-value maintenance comments have been normalized where they affect operators or future maintainers

### Deferred Topic: Email Delivery And Notification Completion

The following items are intentionally deferred and are not part of the current mainline phases:

1. email verification delivery
2. password reset email delivery
3. email notification delivery

These remain valid future work, but they should not block the current product-spine execution line.

## Current Mainline Goal

The next mainline is to make the product-facing workflow consistent with the corrected asset model.

That specifically means:

1. registration is not publication
2. testing is an explicit gate
3. governance is where endpoints become ready
4. publication is where runtime identity appears

## Retrospective Rule

Every stage must end with one backward review before the next stage starts.

Each review must check:

1. architecture drift
2. asset-layer alignment
3. unnecessary transitional complexity
4. optimization opportunities before moving forward
