---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-07
---
# ApiNova Project Baseline

## Purpose

This document consolidates the historical product baselines. Current release requirements are defined by [RELEASE_STANDARD](../../RELEASE_STANDARD.md); current implementation constraints and acceptance evidence are defined by the runtime, security, database and testing documents linked below.

## Product Definition

ApiNova is an application-internal product gateway and API capability platform with dual access paths.

It turns OpenAPI/Swagger-described APIs into governed endpoint assets and publishes them through:

- MCP tools for model and agent invocation
- HTTP gateway routes for direct service invocation

The main product chain is:

- OpenAPI/Swagger input
- parsing and normalization
- API registration
- API testing
- API governance
- API publication
- source service asset cataloging
- endpoint item extraction and readiness shaping
- runtime asset assembly and publication shaping
- dual publish surfaces
- management and observability

## Naming And Ports

- Product name: `ApiNova`
- Chinese name: `达雅`
- Mixed Chinese form: `Api达雅`
- UI: `9000`
- API: `9001`
- MCP runtime: `9022`

## Product Surfaces

### 1. Parser layer

Package: `packages/api-nova-parser`

Responsibilities:

- parse OpenAPI and Swagger from URL, file, or content
- validate and normalize specs
- extract endpoints and metadata
- provide shared inputs for publication and execution

### 2. MCP runtime/server layer

Package: `packages/api-nova-server`

Responsibilities:

- transform parsed OpenAPI data into MCP tools
- host MCP runtime surfaces
- support `stdio`, `sse`, and `streamable`
- handle MCP request mapping, auth injection, and transport behavior

### 3. API/backend layer

Package: `packages/api-nova-api`

Responsibilities:

- act as the shared control plane
- provide management APIs and persistence
- persist documents, endpoint definitions, publish bindings, and operational records
- orchestrate MCP runtime lifecycle
- host the HTTP gateway runtime for published endpoints
- enforce security boundaries

### 4. UI/operator layer

Package: `packages/api-nova-ui`

Responsibilities:

- provide registration, testing, governance, publication, and monitoring workflows
- expose both MCP and HTTP publication state
- avoid re-implementing parser/runtime business logic

## Architecture Rules

### Single source of truth

- parser owns parsing, normalization, validation, and extracted OpenAPI structure
- server owns MCP transformation and MCP runtime behavior
- api owns orchestration, persistence, publication control, HTTP gateway runtime, and security
- ui owns presentation and operator flow

### Shared control plane, separate runtime surfaces

Endpoint registry, publish policy, auth configuration, lifecycle, and observability converge into one shared control plane.

MCP runtime and HTTP gateway runtime are parallel publish surfaces over that control plane. They share endpoint meaning and governance state, but they do not collapse into one transport implementation.

### Asset hierarchy must remain explicit

ApiNova has three asset layers:

- source service assets
- endpoint item assets
- runtime assets

Source service assets are grouped by upstream root identity, recommended as `scheme + host + port + normalized basePath`.

Endpoint item assets are the single-endpoint governance entries under a source service asset.

Runtime assets are the top-level usage assets. The primary runtime asset types are:

- MCP Server assets
- Gateway service assets

Top-level access control, policy, and monitoring should attach to runtime assets, while endpoint-level drill-down remains available below them.

## Product Workflow Spine

The active product workflow should be structured as:

1. API Registration
2. API Testing
3. API Governance
4. API Publication

Meaning:

- registration introduces API assets into the catalog
- testing verifies functional callability
- governance determines endpoint readiness
- publication turns ready endpoints into MCP or Gateway runtime assets

Registration must not implicitly mean runtime publication.

## Functional Scope

### In scope

- import OpenAPI/Swagger from URL, file, or raw content
- register APIs through both import and manual endpoint entry
- test registered endpoints before publication readiness
- validate and normalize specs
- generate MCP-compatible tools from parsed endpoints
- run MCP servers on supported transports
- manage runtime instances through the backend
- govern registered endpoints through shared lifecycle and readiness vocabulary
- manage source service assets and endpoint item assets
- assemble MCP Server assets from one or more endpoint items
- assemble Gateway service assets from one or more endpoint items
- publish runtime assets to MCP tools and HTTP gateway routes
- expose UI workflows for import, governance, publication, and monitoring

### Explicitly not the current baseline

- full automatic discovery-first import from arbitrary API homepages as a required path
- replacing current persistence architecture with a new storage model
- turning ApiNova into an enterprise full-traffic gateway
- taking over all internal service ingress or replacing an existing business gateway
- implementing complex heavy layer-7 scheduling before the dual publish baseline is stable

## Gateway Boundary

ApiNova's gateway role is product-internal and publication-oriented.

That means:

- it only exposes registered, governed, and published endpoints
- it does not aim to proxy all enterprise traffic
- it does not replace existing business gateways, ingress layers, or service meshes
- it can provide auth injection, route binding, observability, and policy enforcement for productized APIs

## Current Delivery Status

### Execution line

The backend asset model correction through the Stage 0 through Stage 6 line is now treated as baseline.

The product-spine convergence line has also materially closed its upstream and downstream mainline phases:

1. Phase 1 closed the `API Registration -> API Testing -> API Governance` mainline
2. Phase 2 closed the `API Publication -> Runtime Assets / Monitoring` mainline
3. Phase 3 is active for compatibility cleanup, observability hardening, targeted i18n/encoding cleanup, and release validation

Historical planning detail is archived at:

- `docs/archive/guides/product-spine-restructure-plan-2026-04.md`

### Phase 1: Registration, Testing, Governance Mainline

Status:

- closed for mainline handoff

Closure baseline:

1. batch OpenAPI registration no longer quick-publishes runtime assets from the registration page
2. manual registration is now treated as endpoint intake and basic maintenance, not a mixed registration/governance/publication page
3. `API Testing` now presents itself as the explicit lifecycle gate between registration and governance
4. successful testing now gives operators a direct next step into `API Governance`
5. governance remains the only surface where readiness is evaluated before publication

### Phase 2: Publication, Runtime Model, Observability Mainline

Status:

- closed for mainline handoff

Current Phase 2 baseline:

- `API Publication` builder now uses governance-ready endpoint candidates as the normal candidate source
- blocked or non-ready endpoints remain diagnosis material outside the normal builder selection path
- runtime asset draft creation starts from the selected ready candidate group and validates the draft identity before calling the backend
- publication memberships can be configured, published, offlined, batch-operated, deployed, started, stopped, and redeployed from the publication workbench
- publication output links directly into Runtime Assets and Monitoring so operators can continue downstream observation

### Phase 3: Engineering Polish And Release Hardening

Current status:

- active

Scope:

1. compatibility cleanup for old registration-time quick-publish and endpoint-direct publication helpers
2. runtime-asset-first observability persistence and monitoring correlation hardening
3. cross-platform operational polish for Windows and Ubuntu
4. i18n and encoding hardening
5. UI bundle-size and structural cleanup

Current Phase 3 progress:

- unused frontend OpenAPI document quick-publish client contracts have been removed from the active UI client layer
- remaining backend quick-publish route is retained as an explicit compatibility cleanup target until external usage is ruled out
- Monitoring now consumes publication handoff query parameters and applies the runtime asset to gateway access-log filtering
- OpenAPI document client logs, dynamic validation fallbacks, and high-value maintenance comments have been normalized

### Deferred Topic: Email Delivery And Notification Completion

Intentionally deferred and not part of the current mainline phases:

1. email verification delivery
2. password reset email delivery
3. email notification delivery

These remain valid future work, but they should not block the current product-spine execution line.

### Current Mainline Goal

The next mainline is to make the product-facing workflow consistent with the corrected asset model:

1. registration is not publication
2. testing is an explicit gate
3. governance is where endpoints become ready
4. publication is where runtime identity appears

### Retrospective Rule

Every stage must end with one backward review before the next stage starts. Each review must check:

1. architecture drift
2. asset-layer alignment
3. unnecessary transitional complexity
4. optimization opportunities before moving forward

## Release Baseline

The release baseline is a convergence version, not a feature explosion version. The goal is a basic usable version that can be connected to real AI applications.

### Definition of "Basic Usable, Releasable"

The release baseline is acceptable only if the following are true:

- the OpenAPI-to-MCP main path is correct enough for normal product use
- CLI, API, and UI no longer materially contradict each other on the main path
- the main management surface has explicit security boundaries
- runtime logging does not pollute MCP transports by default
- Windows and Ubuntu usage paths are both documented and viable
- a user can import an OpenAPI spec, generate tools, run an MCP server, and connect it to an AI application with a documented path

### Expected Characteristics

- fewer surprises
- clearer contracts
- easier setup
- easier connection to MCP-capable AI applications

### Release Constraints

Until this release baseline is reached, do not prioritize:

- large new import workflows
- broad UI redesign
- major storage changes
- speculative discovery systems
- new feature clusters that increase maintenance burden

Intentionally deferred unless they directly unblock release:

- replacing the current database strategy
- introducing a new top-level architecture style
- broad automatic discovery systems
- nonessential new management modules
- demo-oriented features that do not improve the release path

Planned for later versions, but not release blockers:

- automatic OpenAPI discovery from base URLs
- richer endpoint risk scoring
- strategy-driven import wizard flows
- deeper auth scheme automation

## Working Principle

Near-term work should prioritize:

- correctness
- contract consistency
- security posture
- runtime reliability
- publication consistency across both access paths
- release readiness
- keeping Windows and Linux / Ubuntu support consistent

## Related Documents

- [Product Constraints](./PRODUCT_CONSTRAINTS.md)
- [Documentation Index](../README.md)
- [Staged Development Plan](../guides/staged-development-plan.md)
- [Open Items](../reference/open-items.md)
- [Asset Model And Runtime Assets](../guides/asset-model-and-runtime-assets.md)
## Integrated Runtime And Security Baseline (2026-09-07)

The reviewed integration retains the current repository's logical source assets and separate runtime instances, explicit upstream bindings, shared runtime authentication, captured call evidence, and candidate verification before activation. Manual publication convenience options do not bypass verification prerequisites.

- [Runtime instance and regression closure](../guides/runtime-instance-and-regression-closure-plan.md)
- [Runtime security and call audit](../guides/runtime-security-and-call-audit.md)
- [Current database baseline](../guides/database-strategy.md)
- [Package management policy](../guides/package-management-policy.md)
- [Release standard](../../RELEASE_STANDARD.md)
- [Reviewed merge and verification](../audits/2026-09-07-reviewed-merge.md)

Historical completion claims in the consolidated sections are not acceptance evidence for these later changes.
