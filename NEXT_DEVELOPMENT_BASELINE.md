# ApiNova Next Development Baseline

## Purpose

This document is the active execution baseline for the next development cycle after the first release-hardening and branding-convergence work.

It is not a speculative roadmap. It is a working contract for what should be built next, in what order, and under what boundaries.

If a later proposal conflicts with this document, this document wins until it is explicitly updated.

## Current Status

The following work has already been substantially advanced and should not be reopened casually:

- Stage 1 release-path hardening
  - anti-drift rules were tightened
  - default ports were aligned to `9000` / `9001` / `9022`
  - runtime helper logging was moved toward quiet-by-default behavior
  - active docs and product naming were converged toward `ApiNova`
- Stage 2 management contract refactor
  - oversized management controller responsibilities were split into narrower controller groups
  - management permission and observability baselines were documented explicitly
  - management-event logging was introduced for operator-visible actions
  - telemetry placeholders were downgraded so API and UI do not overstate runtime quality
- Stage 3 endpoint governance parity
  - imported endpoints now share the same core lifecycle vocabulary as manual endpoints
  - imported endpoints now support governance editing and service-level lifecycle operations from the registry
  - server management, OpenAPI management, and endpoint registry surfaces are linked more coherently
  - operator-facing labels now explain when imported endpoint actions apply to the imported service record rather than only the displayed path row
- Stage 6 productionization and multilingual governance
  - Chinese remains the default locale
  - English fallback is active
  - locale resources have started moving to feature-level modularization
  - encoding hardening is now an explicit product constraint

The remaining main delivery line is therefore Stage 4 through Stage 5.

## Architecture Baseline To Preserve

The next cycle must preserve the current product layering:

- `parser -> server -> api -> ui`

Responsibilities must stay aligned:

- parser owns OpenAPI parsing, validation, normalization, and extracted structures
- server owns MCP transformation and runtime behavior
- api owns orchestration, persistence, security, and management contracts
- ui owns operator workflows and presentation

The next stages should reduce contract drift, not create new parallel logic paths.

## Execution Order

The active order is:

1. Stage 4: Semantic Publication Layer
2. Stage 5: Production Readiness Polish

Do not expand Stage 4 materially beyond the documented semantic publication boundary before its persistence, review, and publication contracts are stable.

## Stage 2: Management Contract Refactor

### Goal

Reduce structural complexity in the management backend so permission review, operator trust, and later governance work are built on smaller and clearer contracts.

### Main inputs

- `docs/reference/open-items.md` item 4
- `docs/reference/open-items.md` item 5
- `docs/reference/open-items.md` item 7
- `docs/reference/management-permission-matrix.md`
- `docs/reference/management-observability-baseline.md`

### Main workstreams

1. Split `packages/api-nova-api/src/modules/servers/servers.controller.ts` by responsibility
2. Produce a route-level permission matrix for management endpoints
3. Align guards with real route groups and operator roles
4. Introduce a structured management-event baseline for operator-visible actions and state changes
5. Reclassify incomplete monitoring and telemetry fields so UI and API do not overstate quality
6. Document the refactored management contract after code changes land

### Suggested controller slices

- core server lifecycle
- API center and endpoint governance
- process and monitoring operations

### Exit criteria

- controller responsibilities are narrower and auditable
- permission coverage is explicit by route family
- telemetry surfaces distinguish real values from unavailable values
- API docs and implementation boundaries match

## Stage 3: Endpoint Governance Parity

### Goal

Make imported endpoints and manual endpoints feel like one coherent governance product while keeping scope intentionally lightweight.

### Main inputs

- `docs/reference/open-items.md` item 8
- `docs/reference/open-items.md` item 9
- `docs/reference/open-items.md` item 13

### Main workstreams

1. Add missing operator governance actions for imported endpoints where they materially reduce confusion
2. Align lifecycle vocabulary and lifecycle transitions across imported and manual flows
3. Simplify interactions between server management and endpoint registry surfaces
4. Continue downgrading or removing non-baseline UI routes and placeholders

### Required vocabulary to preserve

- `draft`
- `verified`
- `published`
- `degraded`
- `offline`

### Exit criteria

- imported and manual endpoints follow the same core governance model
- imported endpoints no longer feel like a secondary hidden path
- operators can understand endpoint state directly from UI behavior and labels
- placeholder-driven navigation is reduced further

## Remaining Stages Snapshot

Only the following two stages remain on the active execution line:

1. Stage 4: Semantic Publication Layer
   - introduce semantic profile storage, versioning, review, and publish flows
   - keep semantic drafts isolated from raw imported meaning and from public runtime output until published
2. Stage 5: Production Readiness Polish
   - finish deferred auth/notification boundary decisions
   - continue UI bundle reduction, locale modularization, and cross-platform release verification

## Stage 4: Semantic Publication Layer

### Goal

Introduce the semantic endpoint layer only after governance and release contracts are stable enough to carry it without multiplying drift.

### Main inputs

- `docs/reference/open-items.md` item 12
- `docs/guides/endpoint-semantic-layer-requirements.md`
- `docs/guides/endpoint-semantic-layer-sprint-breakdown.md`

### Main workstreams

1. Add semantic profile domain model and persistence
2. Add semantic profile versioning and traceability
3. Generate semantic drafts from OpenAPI metadata
4. Add operator review, edit, approve, and publish workflows
5. Apply semantic overrides during MCP tool publication
6. Add rollback-safe handling for semantic revisions

### Non-goals during initial implementation

- rewriting raw OpenAPI meaning in storage
- exposing draft semantic output as published runtime behavior
- broad new product surfaces unrelated to publication semantics

### Exit criteria

- semantic refinement can be applied without mutating raw imported meaning directly
- published tools record semantic version information
- unpublished semantic drafts do not leak into public runtime output
- SQLite and PostgreSQL both support the feature path

## Stage 5: Production Readiness Polish

### Goal

Finish the highest-value hardening work needed to make the converged product safer to operate and easier to scale into the next release line.

### Main inputs

- `docs/reference/open-items.md` item 2
- `docs/reference/open-items.md` item 6
- `docs/reference/open-items.md` item 10
- `docs/reference/open-items.md` item 11
- `docs/reference/open-items.md` item 14

### Main workstreams

1. Decide whether outbound email remains deferred or becomes a real supported capability
2. Continue UI bundle reduction in Monaco, charts, and Element Plus heavy paths
3. Finish remaining locale modularization and UTF-8-safe editing discipline
4. Do the final active-doc cleanup after technical changes stabilize
5. Re-check Windows, Ubuntu, SQLite, and PostgreSQL release-path verification

### Exit criteria

- deferred auth and notification boundaries are explicit and truthful
- UI startup and route chunks are smaller and more intentional
- locale changes are less fragile and no longer depend on legacy centralized payloads
- active docs describe the real current main path without stale or garbled content

## Guardrails

Before Stage 2 is materially complete, avoid prioritizing:

- new transport families
- large storage abstractions
- broad UI redesign unrelated to current product surfaces
- semantic-layer feature expansion that depends on unresolved governance rules

Before Stage 3 is materially complete, avoid treating imported endpoint governance as a solved product surface.

Before Stage 5 is materially complete, do not describe multilingual and production-polish work as fully finished.

## Promotion Rule

A stage should only be considered complete when all of the following are true:

1. implementation is complete enough for product use
2. API, UI, CLI, and docs are aligned
3. release-path verification exists for the affected path
4. related `open-items` entries can be reduced, reclassified, or closed with evidence
