# ApiNova Next Development Baseline

## Purpose

This document is the active execution baseline for the next development cycle.

## Current Status

The current execution line has been corrected onto the asset-oriented Stage 0 through Stage 6 model.

Stages already completed or materially established:

- Stage 0: Freeze the transitional model
- Stage 1: Build the corrected asset skeleton
- Stage 2: Implement source asset catalog and endpoint registry correction
- Stage 3: Move publication to runtime-asset membership

The remaining main delivery line is therefore Stage 4 through Stage 6.

## Architecture Baseline To Preserve

The next cycle must preserve the current product layering:

- `parser -> server -> api -> ui`

Responsibilities must stay aligned:

- parser owns OpenAPI parsing, validation, normalization, and extracted structures
- server owns MCP transformation and MCP runtime behavior
- api owns orchestration, persistence, security, management contracts, and HTTP gateway runtime
- ui owns operator workflows and presentation

## Execution Order

1. Stage 4: Rebuild MCP runtime assets
2. Stage 5: Rebuild Gateway runtime assets
3. Stage 6: Migrate old model and remove dual-write shortcuts

## Stage 3: Move Publication To Runtime-Asset Membership

### Goal

Move publication ownership from endpoint-direct bindings to runtime-asset membership so MCP and Gateway can publish from the same corrected control model.

### Main inputs

- `docs/reference/open-items.md` item 12
- `docs/reference/open-items.md` item 13
- `docs/reference/open-items.md` item 15
- `docs/reference/open-items.md` item 16
- `docs/guides/endpoint-semantic-layer-requirements.md`

### Main workstreams

1. Add runtime-asset membership and publish binding persistence
2. Move publication profile ownership to runtime-asset membership
3. Add publication profile versioning and traceability at the correct asset layer
4. Generate publication drafts from OpenAPI metadata
5. Add operator review, edit, approve, and publish workflows
6. Stop extending endpoint-direct publish assumptions in new code

### Exit criteria

- publication profile ownership no longer depends on endpoint-direct publish bindings
- one endpoint item can be published through different runtime assets without identity confusion
- draft, review, publish, and offline state are traceable at runtime-asset membership level

## Stage 4: Rebuild MCP Runtime Assets

### Goal

Make MCP Server a first-class runtime asset rather than a mixed service record.

### Main workstreams

1. Assemble MCP runtime assets from endpoint members
2. Attach MCP policy and monitoring to runtime assets
3. Publish MCP tools from runtime-asset membership and publication revision
4. Reduce dependence on `MCPServerEntity` as endpoint identity

### Current implementation status

The Stage 4 main path is now materially present:

1. MCP runtime assets can be assembled from runtime memberships
2. runtime assets expose membership-level publication views
3. MCP assembly output can be exported as OpenAPI and MCP tools
4. runtime assets can be deployed into managed MCP server records
5. runtime assets now expose top-level `deploy`, `start`, `stop`, and `redeploy` operations
6. runtime asset list and detail views now expose managed-server runtime summary

### Remaining drift to finish later

1. existing server-first management APIs still remain as compatibility surfaces
2. monitoring and alerting still originate mainly from managed server records
3. MCP runtime process ownership is still executed through managed server records, not runtime assets directly

### Exit criteria

- MCP Server assets are first-class runtime assets
- MCP tool publication records runtime asset and publication revision
- MCP control and monitoring sit at runtime-asset level with endpoint drill-down preserved

## Stage 5: Rebuild Gateway Runtime Assets

### Goal

Make Gateway service a first-class runtime asset rather than endpoint-direct forwarding.

### Main workstreams

1. Assemble Gateway runtime assets from endpoint members
2. Move route binding to runtime-asset membership
3. Publish gateway routes from runtime assets with conflict checks
4. Attach Gateway policy and monitoring to runtime assets

### Current implementation status

The Stage 5 main path is now partially landed:

1. gateway route binding already persists on `runtimeAssetEndpointBindingId`
2. gateway runtime now resolves active forwarding targets through runtime membership and `source_service_asset`
3. runtime assets now expose `gateway-assembly` output for one `gateway_service` asset
4. gateway forwarding no longer needs to directly resolve upstream base URL from legacy endpoint carrier records
5. `gateway_service` runtime assets now expose independent `deploy`, `start`, `stop`, `redeploy`, `policy-binding`, and `observability` surfaces
6. gateway runtime now records per-runtime-asset request, error, latency, and per-route counters in the current in-process runtime

### Remaining drift to finish later

1. publication service still keeps legacy endpoint context to preserve compatibility profile defaults and write-back behavior
2. gateway runtime still runs as one in-process forwarding surface, not yet as an independently deployed gateway runtime carrier
3. gateway observability is currently in-memory runtime telemetry and not yet persisted or unified with broader observability/event pipelines

### Exit criteria

- Gateway service assets are first-class runtime assets
- published HTTP routes record runtime asset, route binding, and publication revision
- Gateway control and monitoring are independent from MCP runtime assets

## Stage 6: Migrate Old Model And Remove Dual-Write Shortcuts

### Goal

Retire transitional mixed identities and dual-write shortcuts after the corrected runtime model is usable.

### Main workstreams

1. Migrate transitional publication data where needed
2. Remove endpoint-to-runtime mixed assumptions
3. Remove compatibility write-back paths that are no longer required
4. Align management APIs with corrected asset layers
5. Re-check release behavior on Windows, Ubuntu, SQLite, and PostgreSQL

## Retrospective Rule

Every stage must end with one backward review before the next stage starts.

Each review must check:

1. architecture drift
2. asset-layer alignment
3. unnecessary transitional complexity
4. optimization opportunities before moving forward
