# Staged Development Plan

## Purpose

This document turns the current convergence notes and `open-items` register into an execution-oriented staged plan.

## Architecture Check Summary

The current architecture direction is still correct:

- `parser -> server -> api -> ui` remains the right product layering
- shared OpenAPI normalization and request-shaping logic should continue to converge downward rather than being reimplemented upward
- the current management flow is already usable, but the runtime product surface is still stronger on the MCP side than on the traditional HTTP side

The current codebase also shows four active structural risks:

1. runtime-path pollution still needs continued review in MCP helpers
2. the control plane is ahead of the HTTP runtime plane
3. endpoint governance depth is still publication-skewed toward MCP assumptions
4. encoding and localization discipline is still fragile

## Current Completion Status

### Completed stages

- Stage 0 is complete enough to treat as baseline
- Stage 1 is complete enough to treat as baseline
- Stage 2 is materially complete enough to treat as baseline
- Stage 3 is materially complete enough to treat as baseline

### What Stage 2 has actually landed

- source service asset grouping by `scheme + host + port + normalized basePath`
- endpoint definition persistence detached from `MCPServerEntity` identity
- document import and manual endpoint registration dual-write into the corrected asset catalog
- source-service and endpoint catalog query APIs
- endpoint-definition governance update entry for status, publish switch, and base metadata

### Stage 2 retrospective

Confirmed alignment:

1. source service asset, endpoint item asset, and runtime asset are now explicit concepts in code
2. endpoint governance can already operate through `endpoint_definition`
3. imported endpoints and manual endpoints now converge into one catalog structure

Confirmed drift still present:

1. publication still binds to endpoint-direct records and legacy endpoint ids
2. gateway runtime still resolves active routes through endpoint-direct bindings
3. probe, readiness, and publish/offline state still partially live in legacy management config
4. runtime assets exist in storage shape but are not yet the primary usage identity

### What Stage 3 has actually landed

- publication profile, publish binding, route binding, and history now support `runtimeAssetEndpointBindingId`
- publication controller now exposes runtime-membership level read and mutation APIs
- endpoint-level publication APIs now reuse membership-first service logic
- publication revision, publish/offline state, and gateway route binding now persist around runtime membership

### Stage 3 retrospective

Confirmed alignment:

1. publication ownership is now centered on runtime-asset membership
2. one endpoint can now participate in MCP and Gateway publication through separate memberships
3. management APIs now expose membership-level publication operations directly

Confirmed drift still present:

1. legacy endpoint-based publication routes still remain for compatibility
2. legacy management config still keeps compatibility write-back for publish/offline flags
3. Gateway runtime still needs full runtime-asset-first reconstruction

### Stage 4 current status

Materially landed:

1. runtime-asset list and detail APIs now expose runtime summary and managed-server binding
2. MCP runtime assets can assemble OpenAPI and MCP tools from published memberships
3. OpenAPI retrieval now supports runtime-asset assembly paths
4. managed MCP server deployment now binds explicitly to `runtimeAssetId`
5. runtime assets now support `deploy`, `start`, `stop`, and `redeploy`

Still transitional:

1. MCP process lifecycle still executes through managed server records
2. monitoring and alerting are still primarily server-first
3. server-first management views remain as compatibility entry points

The remaining active stages are therefore:

1. Stage 4: Rebuild MCP runtime assets
2. Stage 5: Rebuild Gateway runtime assets
3. Stage 6: Migrate old model and remove dual-write shortcuts

## Stage 3: Move Publication To Runtime-Asset Membership

### Goal

Attach publication semantics to the correct publish unit: runtime-asset membership.

### Workstreams

1. move publication profile ownership from endpoint-direct bindings to runtime-asset membership
2. add runtime-asset membership level publish state, review state, and revisioning
3. preserve endpoint drill-down while shifting top-level publication identity upward
4. keep transitional compatibility only where required for rollout safety

### Exit criteria

- publication profile is owned by runtime-asset membership
- one endpoint can participate in multiple runtime assets without publication identity collision
- publish and offline behavior is no longer modeled as endpoint-only state

## Stage 4: Rebuild MCP Runtime Assets

### Goal

Make MCP publication consume first-class runtime assets instead of mixed endpoint/service records.

### Workstreams

1. assemble MCP runtime assets from endpoint memberships
2. publish MCP tools from runtime assets and publication revisions
3. attach MCP runtime monitoring and policy to runtime assets
4. reduce direct dependence on `MCPServerEntity` as the effective runtime identity

### Exit criteria

- MCP Server becomes a first-class runtime asset
- MCP publication output can be traced to runtime asset and publication revision
- MCP control surface is runtime-asset first, with endpoint drill-down retained

## Stage 5: Rebuild Gateway Runtime Assets

### Goal

Make the HTTP path publish and run as first-class gateway runtime assets.

### Workstreams

1. assemble Gateway runtime assets from endpoint memberships
2. move route binding and conflict detection to runtime-asset membership
3. publish gateway routes from runtime assets
4. separate Gateway monitoring and control from MCP runtime assets

### Current status

Materially landed:

1. route binding and conflict detection already operate on runtime-asset membership
2. gateway runtime forwarding now resolves active targets through runtime membership plus `source_service_asset`
3. runtime assets expose gateway assembly output for published route members
4. `gateway_service` runtime assets now support top-level start, stop, redeploy, policy-binding, and observability reads
5. gateway forwarding now records runtime-asset level counters for requests, errors, latency, and route activity

Still transitional:

1. publication context still resolves legacy endpoint carrier records for compatibility data and profile bootstrapping
2. gateway runtime process/control is not yet an independently deployable runtime carrier
3. gateway observability is currently in-memory and has not yet been folded into the broader monitoring and audit pipeline

### Exit criteria

- Gateway service becomes a first-class runtime asset
- HTTP route publication is traceable to runtime asset and publication revision
- Gateway monitoring and control are independent at top level

## Stage 6: Migrate Old Model And Remove Dual-Write Shortcuts

### Goal

Retire transitional mixed identities after the corrected dual-runtime model is operational.

### Workstreams

1. migrate remaining publication and route state from legacy endpoint-direct records
2. remove compatibility write-back where no longer required
3. align management APIs and views to the corrected asset model
4. perform release-path verification on supported environments
5. replace server-first observability with runtime-asset-first event, metric, and state persistence

### Current status

Materially landed:

1. Stage 6 runtime-observability baseline has been documented as event stream, metric series, and latest state snapshot
2. new persistence entities and migration skeleton now exist for runtime-asset-first observability
3. gateway request results now write into the new runtime observability event, metric, and state path
4. gateway runtime control actions now emit top-level runtime observability events
5. MCP runtime deploy, lifecycle, health check, and tool-call paths now also emit runtime-asset-first observability writes
6. runtime-asset observability reads now expose a normalized runtime-asset-first view derived from the new persistence model
7. old server-first observability tables are now treated as historical legacy data rather than compatibility targets
8. management overview and managed-server observability routes now resolve through normalized runtime-asset observability instead of old system-log or audit-log storage
9. monitoring dashboard and monitoring websocket store now consume runtime-asset-first overview, event, and log projections instead of system-level placeholder metrics
10. websocket gateway now emits runtime-native overview, runtime-asset observability, runtime-event, runtime-log, and runtime-alert messages as the primary monitoring event surface

Still transitional:

1. some MCP runtime telemetry still depends on server/process-side compatibility services before being normalized further
2. `ResourceMonitor` and some non-mainline monitoring subcomponents still expose placeholder process telemetry rather than runtime-asset-first data
3. semantic system-log, audit-log, and metric projections still need to be expanded across all remaining management entry points

## Retrospective Rule

Each stage must end with one explicit backward review covering:

1. architecture drift
2. asset-layer alignment
3. unnecessary transitional complexity
4. optimization opportunities before moving forward
