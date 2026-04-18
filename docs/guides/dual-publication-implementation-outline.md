# Dual Publication Implementation Outline

## Purpose

This document turns the Stage 4 baseline into an implementation-oriented module outline.

The key correction is that ApiNova does not have only one asset layer.

It has three:

- source service assets
- endpoint item assets
- runtime assets

Dual publication must be implemented on top of that hierarchy rather than by treating one endpoint record as the whole product asset.

## 1. Asset Hierarchy

### 1.1 Source service asset

This is the catalog-level asset for imported or registered upstream services.

Recommended grouping key:

- `scheme + host + port + normalized basePath`

This asset groups endpoints that come from the same upstream service root.

### 1.2 Endpoint item asset

This is the single-endpoint governance unit.

Recommended identity:

- `source_service_asset_id + method + path`

This layer owns:

- raw OpenAPI-derived meaning
- endpoint lifecycle
- probe and readiness data
- endpoint-level governance metadata

### 1.3 Runtime asset

This is the top-level usage asset.

It is what operators and consumers finally use, control, and monitor.

Two runtime asset types are required:

- `mcp_server_asset`
- `gateway_service_asset`

Runtime assets are the top-level concept for:

- access control
- publication status
- policy binding
- monitoring
- audit

## 2. Design Goal

One source service asset contains many endpoint item assets.

Those endpoint item assets can then be assembled into runtime assets.

Runtime assets publish through two independent usage paths:

- MCP Server
- HTTP Gateway

The same endpoint item may participate in both paths, but the runtime assets remain separate from a usage and observability perspective.

## 3. Minimum Publish Unit

The publish unit should not be the whole source service asset by default.

It also should not force every single endpoint to become a separate runtime asset.

The minimum publish unit should be:

- one runtime asset membership binding between a runtime asset and one endpoint item asset

That means:

- the smallest publishable member is one endpoint item
- the smallest publishable asset is one runtime asset containing one or more endpoint members

This supports:

- one endpoint published alone
- many endpoints grouped into one MCP Server asset
- many endpoints grouped into one Gateway service asset
- different grouping on MCP and Gateway sides

## 4. Core Domain Model

The corrected Stage 4 model should distinguish the following entities:

- `source_service_asset`
  - upstream grouping by `scheme + host + port + normalized basePath`
- `endpoint_definition`
  - one endpoint item under one source service asset
- `runtime_asset`
  - one usage-side asset
  - type is `mcp_server` or `gateway_service`
- `runtime_asset_endpoint_binding`
  - membership and publish binding between runtime asset and endpoint
- `publication_profile`
  - publish-time semantic and operator refinement
  - should attach to runtime-asset membership rather than directly to endpoint only
- `runtime_asset_policy_binding`
  - auth, rate limit, visibility, and traffic policy binding

## 5. Why The Correction Matters

Without this split, the implementation drifts into two problems:

1. source service records, endpoint records, and runtime assets are mixed into one entity
2. monitoring and policy are attached too low, so MCP and Gateway usage assets cannot be managed independently

That would make dual publication look correct in code while still being wrong at the product layer.

## 6. Control Plane Responsibilities

The control plane in `packages/api-nova-api` should own:

- source service asset catalog
- endpoint item registry
- runtime asset definition
- runtime asset membership
- publication profile
- publish review and rollout
- route conflict checks
- policy references
- audit and observability metadata

## 7. Runtime Plane Responsibilities

The runtime planes are:

- `packages/api-nova-server`
  - MCP runtime for `mcp_server_asset`
- `packages/api-nova-api`
  - HTTP gateway runtime for `gateway_service_asset`

The runtime planes should remain independent from a usage perspective even when they share endpoint members.

That means:

- separate status
- separate monitoring
- separate policy application
- separate runtime error visibility

## 8. Control And Monitoring Model

From the usage side:

- `mcp_server_asset` is monitored and controlled as one runtime asset
- `gateway_service_asset` is monitored and controlled as another runtime asset

From the governance side:

- operators can still drill down to a single endpoint item
- endpoint-level publication membership must remain visible

So the model is:

- top-level control and monitoring on runtime assets
- fine-grained governance and drill-down on endpoint items

## 9. Recommended Module Split

Inside `packages/api-nova-api`, Stage 4 should converge toward:

- `asset-catalog`
  - source service assets and endpoint item assets
- `publication`
  - runtime asset definition, endpoint membership, publication profile, publish review
- `gateway-runtime`
  - route resolution and forwarding for gateway runtime assets
- `policy`
  - auth, visibility, and traffic policy references
- `observability`
  - runtime asset and endpoint-level monitoring views

## 10. Execution Stages

### Stage 0: Freeze the transitional model

Goal:

- stop extending the current endpoint-as-runtime-asset shortcut

Main work:

- treat current publication and gateway code as transitional
- stop adding new endpoint-direct publication behavior before asset correction
- record the known drift explicitly in active docs and open items

Stage exit check:

- no new code depends on `endpointId = MCPServerEntity.id` as the final asset identity

### Stage 1: Build the corrected asset skeleton

Goal:

- introduce the three-layer asset model in persistence and modules

Main work:

1. add `source_service_asset`
2. add `endpoint_definition`
3. add `runtime_asset`
4. add `runtime_asset_endpoint_binding`

Stage exit check:

- source service assets, endpoint items, and runtime assets exist as separate concepts in code and storage

### Stage 2: Implement source asset catalog and endpoint registry correction

Goal:

- make imported and manual endpoints land in the corrected catalog structure

Main work:

1. group upstream services by `scheme + host + port + normalized basePath`
2. attach endpoint items to source service assets
3. preserve endpoint-level lifecycle, probe, and readiness behavior
4. expose source-service-to-endpoint catalog views

Stage exit check:

- single endpoint governance works without relying on MCP server records as endpoint identity

### Stage 3: Move publication to runtime-asset membership

Goal:

- attach publication semantics to the correct publish unit

Main work:

1. move publication profile ownership to `runtime_asset_endpoint_binding`
2. replace endpoint-direct publish binding assumptions
3. add revisioning and review flow at runtime-asset membership level

Stage exit check:

- the minimum publishable member is one endpoint item, but publication is owned by runtime-asset membership

### Stage 4: Rebuild MCP runtime assets

Goal:

- make MCP Server a first-class runtime asset rather than a mixed service record

Main work:

1. let MCP publication assemble runtime assets from endpoint members
2. attach top-level MCP policy and monitoring to runtime assets
3. remove direct dependence on service records for MCP publish identity

Current status:

1. runtime asset membership can now assemble MCP OpenAPI and MCP tools
2. runtime assets expose deployment and runtime operations toward managed MCP server records
3. runtime asset list and detail views now expose managed runtime summary
4. managed server records still remain as the actual process carrier in the current compatibility layer

Stage exit check:

- MCP Server assets are first-class runtime assets with independent status and monitoring

### Stage 5: Rebuild Gateway runtime assets

Goal:

- make Gateway service a first-class runtime asset rather than endpoint-direct forwarding

Main work:

1. let gateway runtime resolve membership through `gateway_service_asset`
2. keep route binding at runtime-asset membership level
3. attach top-level Gateway policy and monitoring to runtime assets

Current status:

1. gateway route matching now resolves active forwarding targets through runtime membership rather than directly through legacy endpoint records
2. `gateway_service` runtime assets can now produce assembled route output with upstream base URL derived from `source_service_asset`
3. `gateway_service` runtime assets now expose top-level control, policy-binding, and observability read surfaces
4. publication and management compatibility still retain legacy endpoint references behind the control plane

Stage exit check:

- Gateway service assets are first-class runtime assets with independent status and monitoring

### Stage 6: Migrate old model and remove dual-write shortcuts

Goal:

- retire transitional state coupling and mixed identities

Main work:

1. migrate transitional publication data
2. remove endpoint-to-runtime mixed assumptions
3. remove legacy dual-write paths where possible
4. align management APIs with corrected asset layers

Stage exit check:

- current runtime state no longer depends on legacy mixed records or compatibility write-back

## 11. Retrospective Rule

After each stage is completed, do one explicit retrospective pass before starting the next stage.

Each retrospective should check:

1. whether code, docs, and database structure still align with the three-layer asset model
2. whether any new shortcut has reintroduced mixed identity between source assets, endpoint items, and runtime assets
3. whether MCP and Gateway runtime assets remain independently controllable and observable
4. whether the just-finished stage can be simplified, cleaned up, or further normalized before moving on

Retrospective output should include:

- drift found
- corrections applied
- leftover debt intentionally deferred to the next stage

## 12. Exit Criteria

The implementation is correctly aligned only when:

1. source service assets are distinct from runtime assets
2. endpoint item identity is no longer aliased to an MCP server record
3. MCP Server assets and Gateway service assets are first-class runtime assets
4. runtime asset monitoring and control are independent across MCP and Gateway
5. operators can still manage one endpoint item at a fine-grained level
