# Staged Development Plan

## Purpose

This document turns the current convergence notes and `open-items` register into an execution-oriented staged plan.

It is not a broad roadmap. It is a sequencing document for reducing the highest-value product risks without reopening uncontrolled scope.

## Architecture Check Summary

The current architecture direction is still correct:

- `parser -> server -> api -> ui` remains the right product layering
- shared OpenAPI normalization and MCP transformation should continue to converge downward rather than being reimplemented upward
- the current management flow is already usable, but its depth is still uneven across manual and imported endpoint paths

The current codebase also shows four active structural risks:

1. Runtime-path pollution still exists in legacy server helpers  
   `packages/api-nova-server/src/lib/initTools.ts` still emits direct `console.log` / `console.error`, which conflicts with transport-safety constraints and quiet-by-default MCP runtime behavior.

2. API controller surface is still too large  
   `packages/api-nova-api/src/modules/servers/servers.controller.ts` remains oversized and mixes lifecycle, process, monitoring, and API-center responsibilities, which slows permission review and contract hardening.

3. Endpoint governance depth is asymmetric  
   `ApiManagementCenterService` and `EndpointRegistry.vue` provide a workable lifecycle path, but imported endpoints still lag behind the manual path in editability, publication policy depth, and operator review semantics.

4. Encoding and localization discipline is still fragile  
   Multiple docs and source files still show visible encoding corruption, especially in Chinese content and older comments. This is a product-quality issue, not only a localization issue.

## Current Completion Status

The staged plan has progressed further than the original draft:

- Stage 1 is complete enough to treat as baseline
- Stage 2 is complete enough to treat as baseline
- Stage 3 is complete enough to treat as baseline
- Stage 6 multilingual governance has been materially advanced and remains a constraint, not an active mainline stage

The remaining active stages are therefore:

1. Stage 4: Semantic Publication Layer
2. Stage 5: Production Readiness Polish

## Stage Design Principles

- Finish convergence before broad expansion
- Close high-impact `open-items` that affect trust, release readiness, and operator understanding first
- Keep each stage small enough to verify across Windows, Ubuntu, SQLite, and PostgreSQL
- Do not start semantic-layer feature work until release-path contracts are quieter and more stable

## Stage 1: Anti-Drift And Release Contract Hardening

### Goal

Lock the current product identity, default ports, runtime behavior, and release-path expectations so future work does not regress into legacy naming, stale defaults, or contradictory docs.

### Main inputs from open-items

- architecture documentation baseline rewrite
- active guide pruning and normalization
- cross-platform operational polish

### Workstreams

1. Strengthen anti-drift rules in top-level governance docs
2. Continue active-doc normalization and remove remaining stale or garbled product references
3. Audit runtime-path logging and convert legacy direct stdout noise into controllable logging
4. Re-check the release path against Windows, Ubuntu, SQLite default mode, and PostgreSQL optional mode

### Exit criteria

- active docs no longer drift on naming or default ports
- MCP runtime main path is quiet-by-default where transport safety requires it
- release, README, and setup docs agree on the same product labels and default ports
- cross-platform run guidance is re-verified instead of assumed

## Stage 2: Management Contract Refactor

### Goal

Reduce structural complexity in the management backend so security review, operator trust, and future feature work are built on smaller and clearer contracts.

### Main inputs from open-items

- security guard coverage on management endpoints
- permission and security workflow completeness
- CPU usage and monitoring metric completeness

### Workstreams

1. Split `ServersController` by responsibility
   Suggested slices:
   - core server lifecycle
   - API center and endpoint governance
   - process and monitoring operations
2. Perform endpoint-by-endpoint permission review and align guards with real product roles
3. Reclassify incomplete monitoring paths so UI and API do not overstate telemetry quality
4. Document the final management contract after refactor

### Exit criteria

- controller responsibilities are narrower and auditable
- permission coverage is explicit by route group
- monitoring surfaces distinguish real telemetry from unavailable fields
- API docs match the refactored route boundaries

## Stage 3: Endpoint Governance Parity

### Goal

Make imported endpoints and manual endpoints feel like one coherent governance product, while still keeping the current scope intentionally lightweight.

### Main inputs from open-items

- imported-endpoint governance narrower than manual registry path
- UI non-baseline entry points and placeholders
- component and UI dependency cleanup in server management views

### Workstreams

1. Add missing governance actions for imported endpoints where they materially reduce operator confusion
2. Align endpoint lifecycle concepts across imported and manual flows
3. Remove or clearly downgrade remaining non-baseline UI routes and placeholders
4. Simplify server-management and endpoint-registry interaction patterns

### Exit criteria

- imported and manual governance flows use the same core lifecycle vocabulary
- imported endpoints no longer feel like a secondary hidden path
- UI main path is narrower, clearer, and less placeholder-driven
- operators can understand why an endpoint is `draft`, `verified`, `published`, `degraded`, or `offline` without cross-reading source code

## Stage 4: Semantic Publication Layer

### Goal

Introduce the semantic endpoint layer only after the release-path and governance surfaces are stable enough to support it without multiplying drift.

### Main inputs from open-items

- semantic endpoint layer for LLM-oriented publishing

### Workstreams

1. Add semantic profile domain model, storage, and versioning
2. Generate semantic drafts from OpenAPI metadata
3. Add operator review, edit, and publish workflows
4. Apply semantic overrides during MCP tool publication
5. Add rollback and version traceability

### Exit criteria

- tool metadata can be semantically refined without mutating raw OpenAPI meaning directly
- published tool output records semantic version
- unpublished semantic drafts do not leak into public tool exposure
- semantic publication works on both SQLite and PostgreSQL

## Stage 5: Production Readiness Polish

### Goal

Finish the high-value product-hardening work that makes the converged system safer to operate and easier to scale into the next release line.

### Main inputs from open-items

- email-based auth and notification delivery
- UI production bundle size and code-splitting
- i18n locale-file modularization and encoding hardening

### Workstreams

1. Decide whether outbound email is a real near-term product capability or remains explicitly deferred
2. Reduce UI bundle cost in Monaco, charts, and Element Plus heavy paths
3. Modularize locale files by feature and enforce UTF-8-safe editing discipline
4. Finish final active-doc cleanup after technical changes land

### Exit criteria

- deferred auth and notification items are either fully productized or explicitly held back
- UI startup and route chunks are smaller and more intentional
- locale editing no longer causes large fragile diffs or encoding regressions
- Chinese and English operator-facing content are stable enough for iterative release work

## Recommended Remaining Execution Order

1. Stage 4: Semantic Publication Layer
2. Stage 5: Production Readiness Polish

## What Should Not Be Started Early

Before Stage 2 is materially complete, avoid prioritizing:

- new transport families
- broad UI redesign
- large new storage abstractions
- feature clusters that depend on unresolved permission or governance semantics
- semantic-layer implementation that sits on top of still-drifting endpoint lifecycle rules

## Promotion Rule

A stage should only be considered complete when:

1. code changes are implemented
2. API, UI, CLI, and docs are aligned
3. release-path verification exists for the affected surface
4. the corresponding `open-items` entries can be reduced, reclassified, or closed with evidence
