# Staged Development Plan

## Purpose

This document records the current staged delivery baseline after the Phase 1, Phase 2, and Phase 3 convergence work.

It is intentionally concise. Historical planning detail lives in `docs/archive`.

## Product Spine

The active operator lifecycle is:

1. `API Registration`
2. `API Testing`
3. `API Governance`
4. `API Publication`
5. downstream `Runtime Assets` and `Monitoring`

Core rules:

1. registration creates catalog assets only
2. testing is the functional validation gate
3. governance is where endpoints become `ready`
4. publication is where runtime identity appears
5. runtime assets and monitoring are operational follow-up surfaces, not replacements for the lifecycle

## Phase 1: Registration, Testing, Governance

Status: closed for mainline handoff

Closed baseline:

- OpenAPI import and manual endpoint registration remain separate construction methods under `API Registration`
- both construction methods converge into the same asset catalog and downstream lifecycle
- registration no longer exposes runtime publication semantics as the normal operator path
- `API Testing` is now presented as the lifecycle gate after registration and before governance
- successful testing gives operators a direct path into governance
- governance remains the only readiness decision surface before publication

Remaining work:

- only incremental governance productivity and testing-report refinements remain
- these refinements do not reopen Phase 1

## Phase 2: Publication, Runtime Model, Observability

Status: closed for mainline handoff

Closed baseline:

- publication consumes governance-ready endpoint candidates as the normal input
- blocked or non-ready endpoints are diagnostic material, not normal builder selections
- MCP Server and Gateway are peer publication targets
- runtime asset drafts are created from publication, not registration
- runtime memberships can be configured, published, offlined, batch-operated, deployed, started, stopped, and redeployed from the publication workbench
- publication output links directly into Runtime Assets and Monitoring

Remaining work:

- compatibility cleanup and deeper monitoring correlation continue in Phase 3
- these follow-ups do not reopen Phase 2

## Phase 3: Engineering Polish And Release Hardening

Status: active

Scope:

1. remove or quarantine residual quick-publish, endpoint-direct, and server-first compatibility contracts
2. harden runtime-asset-first observability and publication-to-monitoring correlation
3. clean user-visible and high-maintenance i18n or encoding drift
4. keep Windows and Ubuntu operational paths aligned
5. defer large frontend structural refactors until release behavior is stable

Current progress:

- frontend OpenAPI document quick-publish client contracts have been removed
- backend document quick-publish remains as an explicit compatibility cleanup target pending external-usage verification
- Monitoring now consumes runtime asset handoff query parameters for gateway access-log filtering
- OpenAPI document logs, dynamic validation fallback messages, and high-value maintenance comments have been normalized in touched areas

Next order:

1. verify backend quick-publish external usage before removal
2. broaden runtime-asset-first audit, system-log, and metrics projections
3. continue targeted encoding cleanup only where it affects operators or future maintenance
4. run release-readiness validation before any large component split

## Deferred Topic

Email delivery remains deferred:

- email verification delivery
- password reset email delivery
- email notification delivery

This work is intentionally outside the current product-spine closure line.

## Archived Context

Historical detail for the completed product-spine restructure is archived at:

- `docs/archive/guides/product-spine-restructure-plan-2026-04.md`

Use archived documents only for decision history. Do not treat them as current baseline.
