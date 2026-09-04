# Publication Resource Baseline

## Purpose

This document defines the product and architecture baseline for `API Publication`.

It exists to remove the remaining ambiguity between:

- governance output
- publication input
- runtime-side published assets

## 1. Position In The Product Spine

`API Publication` is the fourth stage in the active product spine:

1. `API Registration`
2. `API Testing`
3. `API Governance`
4. `API Publication`
5. `Runtime Assets / Monitoring`

Publication must not appear before governance readiness is established.

## 2. What Governance Produces

The governance stage produces:

- grouped endpoint catalog views based on `scheme + host + port + normalizedBasePath`
- endpoint-level testing qualification
- endpoint-level readiness result: `ready` or `blocked`

These are publication inputs, not final publication entities.

Governance grouping answers:

- where the endpoint comes from
- which source service asset it belongs to
- whether it is ready for publication

Governance grouping does **not** answer:

- how the endpoint should be exposed to consumers
- which runtime entity it belongs to
- whether it should be published through MCP, Gateway, or both

## 3. Publication Must Build A New Unit

Publication requires a new runtime-side publish unit.

The correct unit is not the governance category itself.

The recommended publication unit is:

- one `runtime_asset`
- with one or more `runtime_asset_endpoint_binding` memberships

This means:

- governance grouping remains source-oriented
- publication grouping becomes usage-oriented
- one governance group can feed multiple publication units
- one publication unit can include ready endpoints from one or more governance groups

## 4. Core Publication Objects

### 4.1 Publish Candidate

A publish candidate is one ready endpoint item that is eligible to enter publication.

It still belongs to:

- one `source_service_asset`
- one `endpoint_definition`

### 4.2 Publication Unit

The minimum publishable runtime unit is:

- one `runtime_asset`
- containing at least one ready endpoint membership

In the current baseline, no extra permanent pre-runtime entity is required before `runtime_asset`.

That means:

- a draft `runtime_asset` is already the correct publication container
- its memberships are the publish-membership rows
- later publish, offline, profile, and route actions all act on memberships under that runtime asset

### 4.3 Runtime Asset Types

Two peer publication targets are supported:

- `mcp_server`
- `gateway_service`

They are peer targets over the same ready endpoint catalog.

## 5. Functional Baseline For API Publication

The publication surface must provide the following baseline capabilities.

### 5.1 Candidate Intake

The page must show:

- ready governance groups
- ready endpoints under those groups
- blocked endpoints only as diagnostic rows, not as primary publish actions

### 5.2 Publication Unit Construction

Operators must be able to:

- create a new MCP runtime asset
- create a new Gateway runtime asset
- add one or more ready endpoints into that runtime asset
- add ready endpoints to an existing runtime asset

### 5.3 Membership Configuration

For each runtime membership, operators must be able to manage:

- publication profile
- intent name
- description for LLM
- visibility and operator notes
- Gateway route binding when target type is `gateway_service`

### 5.4 Publish Control

Operators must be able to:

- publish one membership
- offline one membership
- view publication revision
- view publish state
- understand why a membership is blocked from publication

### 5.5 Runtime Handoff

Publication outcomes must remain traceable to:

- runtime asset
- runtime membership
- endpoint definition
- source service asset

Publication must hand off cleanly into:

- runtime deployment
- runtime operations
- runtime monitoring

The publication workbench should therefore provide a lightweight downstream handoff layer for the selected runtime asset:

- deploy runtime asset
- start runtime asset
- stop runtime asset
- redeploy runtime asset

This handoff layer does not replace the dedicated `Runtime Assets / Monitoring` surfaces.

It exists to avoid a broken operator flow where publication succeeds but the next runtime step is hidden on another page.

The handoff layer should still obey runtime-side prerequisites:

- no deploy or redeploy action should appear actionable when there are no active published memberships
- MCP runtime start should require an existing deployment target
- runtime detail and monitoring remain the deeper operational surfaces after handoff

The publication workbench should also make the cross-stage state visible rather than hiding it behind separate pages:

- governance readiness
- membership publication state
- runtime deployment state
- runtime activation state

And it should expose the minimum traceability keys needed for operator follow-through:

- runtime membership id
- runtime asset id
- endpoint definition id
- source service asset id

The publication surface should also support batch operations over memberships inside one publication unit, at least for:

- batch publish
- batch offline

And it should expose operator-facing activity context for one publication unit so recent publication and runtime-handoff actions can be reviewed without leaving the page.

Batch publication actions should also return a page-visible outcome summary with:

- success count
- failure count
- recommended next step for runtime handoff or failure review

To make publication history durable rather than page-local, publication must also persist:

- `publication_batch_run`
- `publication_audit_event`

These records exist to support:

- membership-level publication audit
- batch-level success and failure review
- operator traceability across runtime asset, membership, endpoint definition, and source service asset

## 6. Current Implementation Baseline

The current codebase already has the following publication foundations:

- membership-level publication APIs
- publication profile persistence
- Gateway route binding persistence
- membership publish and offline actions
- runtime-asset-first publication ownership
- runtime asset payload assembly for MCP and Gateway
- runtime asset deployment and runtime operations

The main missing part is not the publication state machine itself.

The main missing part is the publication entry and construction flow:

- selecting ready endpoints from governance output
- creating or choosing runtime assets
- creating memberships from publication candidates
- making the publication page feel like a real operator workbench instead of a membership-only control panel

## 7. Boundary Rules

The following rules are mandatory for the corrected baseline.

### 7.1 Registration Boundary

Registration must not create runtime assets implicitly.

### 7.2 Governance Boundary

Governance alone decides whether an endpoint becomes `ready`.

Publication must consume `ready`; it must not redefine readiness.

### 7.3 Publication Boundary

Publication creates or manages runtime identity.

Publication is the first stage where:

- runtime asset naming
- runtime grouping
- runtime membership
- target-specific profile and route configuration

become operator-visible.

### 7.4 Runtime Boundary

Runtime assets and monitoring are downstream surfaces.

They operate on published runtime assets, not on governance groupings.

## 8. Publication Lifecycle Baseline

The publication-side lifecycle should be understood as:

1. ready endpoint enters publication candidate pool
2. endpoint is assigned into one runtime asset as one membership
3. membership profile and target configuration are completed
4. membership becomes publishable
5. membership enters `active` or `offline`
6. runtime asset is assembled, deployed, and operated downstream
7. operators can continue into dedicated runtime assets and monitoring views for deeper control and observation

## 9. Delivery Stages For Publication

The publication line should now be delivered in the following stages.

### Stage P1: Publication Entry Reconstruction

Goal:

- rebuild the publication page around ready governance output

Work:

- show ready groups and ready endpoint candidates
- keep blocked rows only as diagnosis
- make the page non-empty even before publish actions occur

Exit:

- publication page starts from ready candidates instead of hidden runtime memberships only

### Stage P2: Runtime Asset Draft Construction

Goal:

- allow operators to build publication units explicitly

Work:

- create MCP runtime asset draft
- create Gateway runtime asset draft
- add selected ready endpoints into a chosen runtime asset
- support adding to existing draft/runtime asset

Exit:

- publication page can construct runtime assets and memberships from governance output

### Stage P3: Membership Configuration Workbench

Goal:

- make membership configuration a first-class workbench

Work:

- complete profile editing flow
- complete Gateway route editing flow
- show per-membership blocking reasons clearly
- expose revision, profile status, route readiness, and target config summary consistently

Exit:

- each runtime membership can be configured to a publishable state from the publication surface

### Stage P4: Publish Execution And Runtime Handoff

Goal:

- make publication result in a real runtime-side outcome

Work:

- publish and offline membership actions
- connect publication result to runtime asset detail
- connect MCP/Gateway publish output to runtime deploy/start paths

Exit:

- published memberships can be traced directly into runtime assets and runtime operations

### Stage P5: Publication Operations Closure

Goal:

- finish publication as a stable operator surface

Work:

- batch publish support where appropriate
- clearer runtime-type separation while preserving one publication surface
- stronger revision history and audit visibility
- final cleanup of residual legacy publication assumptions

Exit:

- publication becomes a complete dual-runtime operator workbench

## 10. Immediate Next Implementation Target

The next implementation step should start from `Stage P1` and `Stage P2`.

That means the first concrete product gap to close is:

- publication page must display ready governance outputs
- operators must be able to create or select runtime assets
- operators must be able to convert ready endpoints into runtime memberships

Only after that does the current membership-level publish logic become product-complete.
