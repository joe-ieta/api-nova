---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-08
---
# ApiNova Documentation Index

> Document status: Active canonical index
> Last reviewed: 2026-09-08

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

- [Product Constraints](./baseline/PRODUCT_CONSTRAINTS.md)
- [Project Baseline](./baseline/PROJECT_BASELINE.md)
- [Version Release Standard](../RELEASE_STANDARD.md)
- [Document Versions](./VERSIONS.md)
- [Merge Review And Verification](./audits/2026-09-07-reviewed-merge.md)

## Current Product Closure

- [Security Development Task Plan](./guides/security-development-task-plan.md)
- [Security Development Execution Status](./guides/security-development-execution-status.md)
- [Staged Development Plan](./guides/staged-development-plan.md)
- [Runtime Instance And Regression Closure Plan](./guides/runtime-instance-and-regression-closure-plan.md)
- [Runtime Closure Design And Implementation Review](./reference/runtime-closure-design-implementation-review.md)
- [Open Items](./reference/open-items.md)
- [Runtime Publication Acceptance Cases](./testing/runtime-publication-acceptance-cases.md)
- [Release Readiness Checklist](./guides/release-readiness-checklist.md)
- [Release Requirements](./release/api-nova-release-requirements.md)

## Current Architecture And Operations

- [安全调用与日志审计](./guides/runtime-security-and-call-audit.md)
- [Security Functional Requirements](./guides/security-functional-requirements.md)
- [Security Design And Implementation](./reference/security-design-and-implementation.md)
- [Package Management Policy](./guides/package-management-policy.md)
- [Release Requirements And Source Startup](./release/api-nova-release-requirements.md)
- [Product Release Documents](./release/versions/README.md)
- [Guides Index](./guides/README.md)
- [Reference Index](./reference/README.md)
- [Testing Index](./testing/README.md)
- [Fork Origin And Independence](./guides/fork-origin-and-independence.md)
- [Endpoint Semantic Layer Requirements](./guides/endpoint-semantic-layer-requirements.md)
- [API Gateway Architecture And Requirements](./guides/api-gateway-architecture-and-requirements.md)
- [Versioning Policy](./reference/versioning-policy.md)
- [GitHub Collaboration Workflow](./guides/github-collaboration-workflow.md)

## Runtime Observability Enhancement

Requirements and design defaults are approved. The development plan and endpoint-level contract await confirmation before coding. Planned endpoints are not yet available.

- [Unified Call Logging And Observability Requirements](./guides/runtime-observability-requirements.md)
- [Unified Call Logging And Observability Design](./reference/runtime-observability-design.md)
- [Observability Public API Endpoints](./reference/runtime-observability-api-endpoints.md)
- [Observability Development Task Plan](./guides/runtime-observability-development-task-plan.md)
- [Observability Development Execution Status](./guides/runtime-observability-development-execution-status.md)

## Archive

- [Archive Index](./archive/README.md)

Archived material is retained for traceability and must not be used as the current source of truth. If an archived decision becomes current again, extract it into a new active document and review it against the checkout.

## Status Convention

Every active central document carries a `Document status` marker. A document without an active marker must be classified through this index before it is used for product or release decisions.
