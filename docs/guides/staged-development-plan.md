---
doc-version: 1.7.0
doc-status: active
doc-updated: 2026-10-08
---
# Staged Development Plan

> Document status: Active
> Last reviewed: 2026-10-08

> 2026-09-15 调度重排：父包原退出条件不变；当前细分、跨计划归属和下一队列见[工作包划分](./active-work-package-breakdown.md)，逐项状态见[子任务执行台账](./active-work-package-execution-status.md)。父包 IN_PROGRESS 不表示正在同时执行；文档子项完成不计为代码完成。

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

1. Continue watcher/framework security risk remediation in parallel with observability throughput closure. The actual Nest parser dependency migration, source batching, ingestion transactions and outbox batching are implemented; full-load visibility and delivery targets remain unmet. SQL.js persistence correctness and single-call legacy metric/state atomic transactions pass isolated tests. The user-authorized relaxed wait profile lets all 3000 SQLite responses complete and the service shut down normally, but terminal visibility/delivery and query targets still fail. A PostgreSQL regression exposed connection-pool starvation while waiting for an asset lock; admission now precedes connection acquisition, with six isolated PostgreSQL checks. The final PostgreSQL run completes 3000 valid responses with business p95 49.163ms, but only 2883/3000 terminal records are visible and 2873/3000 delivered at cutoff. API regression passes all 181 suites / 1901 tests. Prioritize reducing cross-request/cross-module persistence and completing database projection/delivery, using actual queue and SQL.js export measurements. Original performance targets remain unchanged. Complete-cohort capacity and equivalent capture-overhead A/B follow throughput closure; see the active work-package breakdown and execution status.
2. Consolidate the results on one candidate version and finish target-environment sign-off (SEC-F4-02, OBS-16-04, OPS-01). The user selected local isolated validation for now; production sign-off remains open.

PROD-04C is complete within local Windows/isolated PostgreSQL scope: 16 real-HTTP lifecycle checks plus related regression coverage; production identity/ACL, Linux semantics and real MCP binary outbound remain outside this run. See [binary lifecycle evidence](../audits/2026-10-08-prod-04c-binary-lifecycle.md).

ENV-01 is complete under its original pass-or-evidenced-limitation criterion: the real MCP health failure is now propagated, while full health still reports the host system-disk threshold. Monitoring SPA routing is repaired in packaged and Vite startup modes. See [health evidence](../audits/2026-10-08-env-01-health-and-monitoring.md). A completed diagnostic task is not a claim that full health is green.

EXT-01 through EXT-05 are now complete within Windows local real-HTTP scope: 11/11 workflow stages, 94 suites/1312 tests, and the final API build passed. The workflow exposed and fixed incorrect instance creation for unbound imports, authenticated candidate replay, and stale probe addresses after instance migration. See [acceptance evidence](../audits/2026-10-08-ext-01-05-gateway-lifecycle.md). PostgreSQL, Linux, browser interaction, production identity, and MCP transport are outside this run.

F3 host assembly, managed-child lifecycle and revocation, F1 evidence/permit integration, EXT-06 through EXT-09, controlled mail delivery, delivery i18n, and measured frontend chunking already have scoped acceptance records. Reuse those results; only fix defects that block the current workflow or have a clear material impact. Current details and remaining boundaries are maintained in [open items](../reference/open-items.md) and the [execution ledger](./active-work-package-execution-status.md).

## Deferred Topic

OAuth2, additional token adapters, and cross-protocol QoS remain outside the current milestone. Controlled mail delivery has been implemented and validated; actual external delivery and production activation remain deployment acceptance, not an unimplemented mail feature.

## Archived Context

Historical detail for the completed product-spine restructure is archived at:

- `docs/archive/guides/product-spine-restructure-plan-2026-04.md`

Use archived documents only for decision history. Do not treat them as current baseline.
