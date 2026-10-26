---
doc-version: 1.14.0
doc-status: active
doc-updated: 2026-10-26
---
# Staged Development Plan

> Current closure baseline: v1.7.6-rc.5, reviewed 2026-10-26. Use the [unified ledger](../../../guides/active-work-package-execution-status.md) for status and [open items](../../../reference/open-items.md) for remaining exits. Phase 1/2 remain closed; Phase 3 contains existing acceptance and sign-off only. See the [closure evidence](../../audits/2026-10-26-existing-scope-closure.md). No new feature or task is added.

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

- no new Phase 1 feature is scheduled for this closure
- address only defects blocking the existing accepted workflow

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

- existing target acceptance continues under SEC-F4-02, OBS-16-04 and OPS-01
- this does not schedule open-ended compatibility or monitoring enhancements

## Phase 3: Product Workflow Acceptance And Release Sign-off

Status: active

Scope and completion criteria:

1. close the registration-to-Gateway workflow through the existing EXT-01 through EXT-05 acceptance cases
2. complete binary-sample retention acceptance using existing implementations and original PROD-04C criteria
3. finish environment and release sign-off against named targets, including runtime switches, audit retention, health, and rollback evidence
4. preserve scoped Windows/Ubuntu, security, and observability results; fix only defects that block these acceptance outcomes or have clear material impact
5. keep completed frontend/i18n work in regression maintenance; do not expand this phase into open-ended polish or structural refactoring

Current progress:

- frontend and backend OpenAPI document quick-publish contracts have been removed
- runtime instances, automatic endpoint samples, runtime upstream bindings, verification-gated Gateway/MCP activation, rollback retention, and operator evidence drill-down are implemented
- the automated runtime-closure gate and isolated SQLite/PostgreSQL clean-baseline verification pass
- Monitoring consumes runtime asset handoff query parameters for gateway access-log filtering
- active design deviations and external acceptance dependencies are explicitly tracked instead of being claimed as complete

Next order:

1. Reuse the rc.5 evidence for the local Gateway browser lifecycle, file/URL/no-server import, two endpoints, A/B migration, logs and monitoring. These branches are already accepted within their stated scope; human feedback and MCP-browser/auth-spec/multi-role combinations remain separately recorded.
2. Run existing bounded local acceptance where prerequisites are available, and record passed/failed/unrun with source and build identity. Do not turn missing target deployment into repeated local engineering.
3. Complete SEC-F4-02 and OBS-16-04 against the same approved target; OPS-01 consolidates the final deployment conclusion. Production remains unsigned while the user continues local isolated validation.

Timing targets and the incomplete SQLite3000 bounded observation remain non-blocking diagnostics under the user's existing decision. Preserve integrity, durability, authorization and recovery requirements; do not claim full capacity or invent a new optimization phase.

PROD-04C is complete within local Windows/isolated PostgreSQL scope: 16 real-HTTP lifecycle checks plus related regression coverage; production identity/ACL, Linux semantics and real MCP binary outbound remain outside this run. See [binary lifecycle evidence](../../audits/2026-10-08-prod-04c-binary-lifecycle.md).

ENV-01 uses the approved minimum 5GiB free-space policy. The 2026-10-26 isolated rerun passed full API+MCP health (200), MCP-down propagation (503), and eight packaged/Vite monitoring checks. Earlier disk failures are dated host observations. See [current evidence](../../audits/2026-10-26-existing-scope-closure.md); target account policy and production acceptance remain separate.

EXT-01 through EXT-05 are now complete within Windows local real-HTTP scope: 11/11 workflow stages, 94 suites/1312 tests, and the final API build passed. The workflow exposed and fixed incorrect instance creation for unbound imports, authenticated candidate replay, and stale probe addresses after instance migration. See [acceptance evidence](../../audits/2026-10-08-ext-01-05-gateway-lifecycle.md). That 10-08 HTTP run did not cover PostgreSQL, Linux, browser interaction, production identity or MCP. Later bounded browser evidence is in the rc.5 audit; original limits are not erased.

F3 host assembly, managed-child lifecycle and revocation, F1 evidence/permit integration, EXT-06 through EXT-09, controlled mail delivery, delivery i18n, and measured frontend chunking already have scoped acceptance records. Reuse those results; only fix defects that block the current workflow or have a clear material impact. Current details and remaining boundaries are maintained in [open items](../../../reference/open-items.md) and the [execution ledger](../../../guides/active-work-package-execution-status.md).

## Deferred Topic

OAuth2, additional token adapters, and cross-protocol QoS remain outside the current milestone. Controlled mail delivery has been implemented and validated; actual external delivery and production activation remain deployment acceptance, not an unimplemented mail feature.

## Archived Context

Historical detail for the completed product-spine restructure is archived at:

- `docs/archive/guides/product-spine-restructure-plan-2026-04.md`

Use archived documents only for decision history. Do not treat them as current baseline.
