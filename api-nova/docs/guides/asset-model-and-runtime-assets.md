# Asset Model And Runtime Assets

## Purpose

This document defines the corrected top-level asset model for ApiNova.

It resolves the ambiguity between:

- imported upstream services
- single endpoint entries
- published MCP and Gateway runtime entities

## 1. Top-Level Principles

### 1.1 Assets exist at more than one layer

ApiNova should not treat every endpoint row as the only product asset.

The product has three asset layers:

1. source service assets
2. endpoint item assets
3. runtime assets

### 1.2 Runtime assets are the top usage concept

From the usage side, the top-level assets are the published runtime entities:

- MCP Server assets
- Gateway service assets

These assets are what receive:

- access control
- policy control
- top-level monitoring
- alerting
- operational status

### 1.3 Endpoint items still remain important

Single endpoints must still be manageable at fine granularity.

That includes:

- governance
- readiness
- publication membership
- per-endpoint monitoring drill-down

## 2. Source Service Asset

### 2.1 Definition

A source service asset is the catalog grouping unit for imported or manually registered upstream APIs.

### 2.2 Grouping rule

Recommended grouping key:

- `scheme + host + port + normalized basePath`

Examples:

- `https://api.example.com:443/v1`
- `http://internal-service:8080`

### 2.3 Responsibilities

This asset layer owns:

- source identity
- upstream root metadata
- service-level tags and ownership
- source-level health and provenance
- endpoint membership

## 3. Endpoint Item Asset

### 3.1 Definition

A single endpoint item is the smallest governance entry under a source service asset.

### 3.2 Identity

Recommended identity:

- `source_service_asset_id + method + path`

### 3.3 Responsibilities

This layer owns:

- raw method and path
- raw OpenAPI meaning
- endpoint lifecycle
- endpoint probe and readiness
- endpoint-level metadata

## 4. Runtime Asset

### 4.1 Definition

A runtime asset is a usage-side asset assembled from one or more endpoint item assets.

### 4.2 Runtime asset types

- `mcp_server_asset`
- `gateway_service_asset`

### 4.3 Responsibilities

This layer owns:

- publication state
- runtime-level auth and policy
- runtime-level monitoring
- audit and operational events
- consumer-visible identity

## 5. Minimum Publish Unit

### 5.1 Correct answer

The minimum publishable member is one endpoint item.

The minimum publishable runtime asset is one runtime asset with one endpoint member.

### 5.2 Why this is the right unit

This allows:

- publishing one endpoint alone
- grouping many endpoints into one MCP Server asset
- grouping many endpoints into one Gateway service asset
- using different groupings for MCP and Gateway

### 5.3 What should not be forced

ApiNova should not force:

- one whole source service asset to always publish together
- one endpoint to always become its own standalone runtime asset

Both should remain supported patterns, not mandatory structure.

## 6. Dual Publication Interpretation

Dual publication does not mean one endpoint automatically equals one MCP asset and one Gateway asset.

It means:

- one endpoint item can participate in MCP and Gateway publication
- MCP runtime assets and Gateway runtime assets can assemble endpoint members differently
- those two runtime asset families are independently managed from a usage perspective

## 7. Monitoring And Control Model

### 7.1 Top-level view

The primary operational dashboard should show runtime assets.

That means:

- MCP Server asset status
- Gateway service asset status

### 7.2 Drill-down view

Operators must be able to drill down from runtime assets to:

- member endpoints
- source service asset
- endpoint readiness and errors

### 7.3 Independence requirement

MCP and Gateway runtime assets must be independently observable and controllable.

One side being degraded should not automatically collapse the other side's status semantics.

## 8. Recommended Data Model

At minimum, the corrected model should include:

- `source_service_asset`
- `endpoint_definition`
- `runtime_asset`
- `runtime_asset_endpoint_binding`
- `publication_profile`
- `runtime_asset_policy_binding`

Existing draft tables such as `publication_profile`, `endpoint_publish_binding`, and `gateway_route_binding` should evolve toward this structure rather than remain endpoint-only forever.

## 9. Consequence For Current Refactor

The current implementation should be treated as transitional if it still uses:

- one MCP server record as endpoint identity
- one endpoint publish binding as the top runtime asset

That model is not the final target.

The corrected target is:

- source service assets at the catalog layer
- endpoint items at the governance layer
- MCP and Gateway runtime assets at the usage layer

## 10. Consequence For Product Workflow

The product workflow must reflect the asset layers instead of hiding runtime creation inside registration.

The correct product spine is:

1. API Registration
2. API Testing
3. API Governance
4. API Publication

Mapped to asset layers:

- registration creates or updates catalog assets
- testing verifies endpoint function
- governance determines endpoint readiness
- publication creates runtime identity and runtime membership

This means:

- manual endpoint registration should not be presented as MCP Server creation
- OpenAPI import should not remain the only product-feeling path
- runtime assets should appear only inside publication and downstream runtime operations

## 11. Product-Lifecycle Constraint

The top-level product flow is not just navigation. It is a control-plane contract:

1. `API Registration`
2. `API Testing`
3. `API Governance`
4. `API Publication`
5. `Runtime Assets / Monitoring`

The corresponding state flow is:

1. endpoint is introduced as `registered`
2. testing moves it to `tested` or `test_blocked`
3. governance moves it to `ready` or `blocked`
4. publication creates runtime memberships and runtime assets, then manages runtime-side publish state such as `active` or `offline`

Important boundary rules:

- registration must not imply runtime creation
- testing must remain endpoint-granular
- governance must remain the only place that decides readiness
- publication must consume readiness instead of redefining it
- runtime monitoring must attach to runtime assets after publication, not to registration-time catalog entries
