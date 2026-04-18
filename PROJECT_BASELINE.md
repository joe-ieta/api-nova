# ApiNova Project Baseline

## Purpose

This document defines the current baseline for architecture, functional scope, and development rules.

## Product Definition

ApiNova is an application-internal product gateway and API capability platform with dual access paths.

It turns OpenAPI/Swagger-described APIs into governed endpoint assets and publishes them through:

- MCP tools for model and agent invocation
- HTTP gateway routes for direct service invocation

The main product chain is:

- OpenAPI/Swagger input
- parsing and normalization
- source service asset cataloging
- endpoint item extraction and governance
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

- provide import, governance, publication, and monitoring workflows
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

## Functional Scope

### In scope

- import OpenAPI/Swagger from URL, file, or raw content
- validate and normalize specs
- generate MCP-compatible tools from parsed endpoints
- run MCP servers on supported transports
- manage server instances through the backend
- govern registered endpoints through shared lifecycle vocabulary
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

## Working Principle

Near-term work should prioritize:

- correctness
- contract consistency
- security posture
- runtime reliability
- publication consistency across both access paths
- release readiness
