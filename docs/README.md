# ApiNova Documentation Index

> Document status: Active canonical index
> Last reviewed: 2026-07-22

## Documentation Classes

| Directory | Purpose | May define current behavior? |
| --- | --- | --- |
| repository root | product constraints and current project/release baseline | yes |
| `docs/guides` | current architecture, setup, operations, and active execution plans | yes |
| `docs/reference` | durable contracts, review records, permission matrices, and open items | yes |
| `docs/testing` | executable acceptance cases and evidence requirements | yes |
| `docs/archive` | completed, superseded, exploratory, or historical material | no |
| `packages/*/docs` | package-owned current API/architecture documentation only | package scope only |

## Canonical Governance

- [Product Constraints](../PRODUCT_CONSTRAINTS.md)
- [Project Baseline](../PROJECT_BASELINE.md)
- [Release Baseline V1](../RELEASE_BASELINE_V1.md)

## Current Product Closure

- [Staged Development Plan](./guides/staged-development-plan.md)
- [Runtime Instance And Regression Closure Plan](./guides/runtime-instance-and-regression-closure-plan.md)
- [Runtime Closure Design And Implementation Review](./reference/runtime-closure-design-implementation-review.md)
- [Open Items](./reference/open-items.md)
- [Runtime Publication Acceptance Cases](./testing/runtime-publication-acceptance-cases.md)
- [Release Readiness Checklist](./guides/release-readiness-checklist.md)

## Current Architecture And Operations

- [Package Management Policy](./guides/package-management-policy.md)
- [Release Requirements And Source Startup](./release/api-nova-release-requirements.md)
- [Guides Index](./guides/README.md)
- [Reference Index](./reference/README.md)
- [Testing Index](./testing/README.md)

## Archive

- [Archive Index](./archive/README.md)

Archived material is retained for traceability and must not be used as the current source of truth. If an archived decision becomes current again, extract it into a new active document and review it against the checkout.

## Status Convention

Every active central document carries a `Document status` marker. A document without an active marker must be classified through this index before it is used for product or release decisions.
