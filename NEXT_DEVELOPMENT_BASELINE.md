# ApiNova Next Development Baseline

## Purpose

This document is the active execution baseline for the next development cycle.

## Current Status

The current implementation has materially corrected the backend asset model through the Stage 0 through Stage 6 line, but the top-level operator product spine still needs restructuring.

That means the next cycle is no longer just about continuing Stage 4 through Stage 6 internals.

It must first rebuild the product-mainline workflow around:

1. API Registration
2. API Testing
3. API Governance
4. API Publication

## Architecture Baseline To Preserve

The next cycle must preserve the current product layering:

- `parser -> server -> api -> ui`

Responsibilities must stay aligned:

- parser owns OpenAPI parsing, validation, normalization, and extracted structures
- server owns MCP transformation and MCP runtime behavior
- api owns orchestration, persistence, security, management contracts, and HTTP gateway runtime
- ui owns operator workflows and presentation

## Execution Order

1. Stage A: Rebuild top-level product structure
2. Stage B: Unify API Registration
3. Stage C: Connect API Testing to the main flow
4. Stage D: Rebuild API Governance around endpoint readiness
5. Stage E: Rebuild API Publication
6. Stage F: Remove transitional runtime-creation shortcuts

See:

- `docs/guides/product-spine-restructure-plan.md`

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
