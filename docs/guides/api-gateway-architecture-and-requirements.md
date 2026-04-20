# ApiNova API Gateway Architecture And Requirements

## Purpose

This document defines the product-facing requirements and the target architecture for the ApiNova built-in API Gateway.

The gateway is part of the ApiNova runtime system. It is not a standalone generic proxy product and it is not a wrapper around an external gateway.

The design direction is fixed:

- built into ApiNova
- deeply integrated with MCP Server publication
- lightweight and easy to deploy
- custom publication model remains the source of truth
- implemented on the current Node.js and NestJS stack

This document replaces the earlier transitional view where gateway runtime was treated mainly as a JSON forwarding endpoint.

## Product Position

ApiNova Gateway is the HTTP runtime form of `gateway_service` under the unified `runtime_asset` model.

It is responsible for:

- publishing selected endpoint assets as consumer-facing HTTP routes
- transparently proxying requests to upstream services
- enforcing access, traffic, cache, and logging policy
- producing runtime metrics, events, and audit records
- integrating with MCP publication, runtime control, and observability

The gateway is not just a transport adapter. It is the HTTP data plane of the ApiNova publication system.

## Current Engineering Constraints

The target solution must fit the current codebase and runtime baseline.

### Stack constraints

- backend stack remains NestJS 10, Express, TypeORM, RxJS, PostgreSQL and SQLite support
- current runtime shape is centered on `runtime_assets`, `runtime_asset_endpoint_bindings`, and `gateway_route_bindings`
- security, audit, and runtime observability already exist and must be reused rather than duplicated

Relevant code:

- [app.module.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/app.module.ts)
- [main.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/main.ts)
- [gateway-runtime.module.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/gateway-runtime.module.ts)
- [publication.module.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/publication/publication.module.ts)
- [runtime-asset.entity.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/database/entities/runtime-asset.entity.ts)
- [runtime-asset-endpoint-binding.entity.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/database/entities/runtime-asset-endpoint-binding.entity.ts)
- [gateway-route-binding.entity.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/database/entities/gateway-route-binding.entity.ts)

### Product constraints

- publication model remains custom and under ApiNova control
- MCP Server and Gateway must share a unified runtime asset model
- the solution must be deployable in a single process by default
- the solution must leave room for a later split into control plane and data plane without rewriting core logic

### Correctness constraints

- gateway requests must no longer depend on parsed `req.body`
- `/api/v1/gateway/...` must support streaming and transparent payload forwarding
- no request-path database lookup should be required on the hot path once the route snapshot is loaded
- logging and observability must not block the main proxy response path

## Product Goals

The built-in gateway should give ApiNova a complete but intentionally scoped enterprise feature set.

### Primary goals

1. Provide full HTTP reverse proxy capability for published APIs.
2. Keep Gateway and MCP under one runtime asset system.
3. Preserve custom ApiNova publication semantics instead of adopting a third-party configuration model.
4. Support medium-scale enterprise API workloads with lightweight deployment.
5. Expose enough governance, logging, and observability to run production traffic responsibly.

### Explicit non-goals for the initial target

1. No requirement to become a generic external gateway platform.
2. No heavy plugin ecosystem in phase one.
3. No service-mesh control plane.
4. No requirement to support non-HTTP protocols in the first gateway iteration.
5. No requirement to match Envoy, Kong, or APISIX breadth feature-for-feature.

## Functional Requirements

## 1. Asset Inheritance And Publication

The gateway must remain a publication result, not an isolated runtime subsystem.

Requirements:

1. A gateway route originates from endpoint assets already registered and governed in ApiNova.
2. A `gateway_service` runtime asset can contain one or more endpoint members.
3. The same endpoint member may participate in both `mcp_server` and `gateway_service` publication.
4. Publication creates a stable runtime-facing route identity and upstream mapping.
5. Publication must support draft, active, offline, and revision-aware lifecycle.
6. Publication history and audit trail must remain queryable.

## 2. Routing And Transparent Proxying

The gateway must act as a real reverse proxy, not a JSON forwarding helper.

Requirements:

1. Route matching supports `host + path + method`.
2. Path modes support exact, prefix, and parameterized matching.
3. Query string must be transparently forwarded.
4. Request bodies must be transparently streamed to upstream.
5. Response bodies must be transparently streamed back to the caller.
6. Supported traffic types include JSON, form data, multipart upload, binary upload, binary download, and SSE.
7. Path rewrite, method mapping, host rewrite, and selected header rewrite must be supported.
8. Upstream timeout, retry, keep-alive, and cancellation propagation must be supported.

## 3. Access Control And Security

Requirements:

1. Route-level access modes support anonymous, API key, and JWT.
2. The gateway must integrate with the existing security model instead of creating a parallel user store.
3. Route-level permission checks must support policy references from publication.
4. IP allowlist and denylist must be supported.
5. Sensitive request and response fields must support redaction rules.
6. Request-size and response-size safety limits must be configurable.

## 4. Traffic Governance

Requirements:

1. Support global, runtime-asset, route, and consumer-level rate limiting.
2. Support concurrency control.
3. Support timeout policy by connection phase where practical.
4. Support retry policy for idempotent methods.
5. Support circuit-breaker style upstream protection.
6. Support active or passive health signals for upstream targets.
7. Support slow request detection and runtime degradation signals.

## 5. Logging, Audit, And Content Tracking

Requirements:

1. Every gateway request must produce an access log record.
2. Metadata-only logging is the default.
3. Request and response body capture must be policy controlled.
4. Error paths must support stronger capture for diagnosis.
5. Request tracking must support `requestId` and `correlationId`.
6. Log storage must distinguish summary events from request-level payload capture.
7. Query and export capabilities must reuse the existing monitoring and audit surfaces where appropriate.

## 6. Observability

Requirements:

1. Gateway runtime must emit request count, success rate, latency, and traffic volume metrics.
2. Metrics must aggregate by runtime asset, route, and upstream target.
3. Runtime error, throttling, breaker, and policy enforcement events must be recorded.
4. Existing runtime observability infrastructure remains the summary-event backbone.
5. Metrics output must remain Prometheus compatible.

## 7. Cache

Requirements:

1. Cache is optional and route controlled.
2. Cache initially applies only to safe methods such as GET and HEAD.
3. Cache key composition must be configurable using path, selected query, selected headers, and optionally consumer identity.
4. Cache invalidation must support TTL expiry and manual purge.
5. Publication changes must invalidate route-level cache safely.

## 8. MCP Integration

Requirements:

1. Gateway and MCP share the same `runtime_asset` top-level abstraction.
2. Endpoint membership rules remain consistent across MCP and Gateway publication.
3. Gateway observability and MCP observability must be correlatable through shared runtime identifiers and request correlation metadata.
4. MCP automation or generated runtime flows may rely on gateway-protected HTTP routes where appropriate.

## Architecture Overview

The gateway architecture follows a lightweight control plane plus lightweight data plane model.

The first implementation remains deployable inside the current `api-nova-api` process.

The internal architecture should still be written as if the gateway data plane could later be split into a separate process.

## 1. Control Plane

The control plane remains inside `packages/api-nova-api`.

Responsibilities:

- runtime asset definition
- endpoint membership management
- route binding and route conflict validation
- policy binding
- publication review and rollout
- revision history
- audit access
- management and monitoring APIs

Primary modules:

- `publication`
- `runtime-assets`
- `security`
- `monitoring`
- `runtime-observability`

## 2. Data Plane

The gateway data plane is the runtime path that receives external HTTP traffic and forwards it to upstream targets.

Phase-one shape:

- implemented inside `gateway-runtime`
- loaded from pre-resolved route and policy snapshots
- no ORM query in the request hot path

Later shape:

- may be split into a dedicated gateway engine process
- must preserve the same internal interfaces and policy pipeline

## 3. Shared Runtime Contract

Gateway and MCP stay unified at the runtime asset layer.

That means:

- one runtime asset type per runtime family
- one endpoint membership model
- one publication control plane
- one top-level runtime observability spine

This is already reflected in:

- [runtime-asset.entity.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/database/entities/runtime-asset.entity.ts)
- [runtime-asset-endpoint-binding.entity.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/database/entities/runtime-asset-endpoint-binding.entity.ts)

## Request Processing Pipeline

The gateway hot path should be implemented as a deterministic pipeline.

1. Receive request on `/api/v1/gateway/...`
2. Assign `requestId` and `correlationId`
3. Match route from in-memory route snapshot
4. Resolve route policy bundle
5. Authenticate caller
6. Authorize caller
7. Apply rate limit and concurrency guard
8. Check cache if route allows cache
9. Start proxy streaming to upstream
10. Stream upstream response back to caller
11. Record request-level access log
12. Record summary observability metrics and runtime events
13. Release counters and cleanup resources

Properties:

- the request body is not eagerly parsed
- the response body is not eagerly buffered
- logging is policy aware and non-blocking
- failures at any stage emit a normalized gateway result

## Module Refactoring Target

The current `gateway-runtime` module should evolve into the following internal services.

### `GatewayRoutingService`

Responsibilities:

- build and hold route snapshots
- resolve `host + path + method`
- surface route conflicts before activation

### `GatewayPolicyService`

Responsibilities:

- resolve and merge auth, traffic, logging, and cache policy
- interpret current reference fields such as `authPolicyRef` and `trafficPolicyRef`

### `GatewayProxyEngine`

Responsibilities:

- execute stream-based upstream proxying
- support upload, download, binary, and SSE transparently
- apply low-level timeout, retry, and header rules

### `GatewaySecurityService`

Responsibilities:

- authenticate and authorize callers
- integrate with `SecurityModule`
- evaluate route visibility and access mode

### `GatewayTrafficControlService`

Responsibilities:

- rate limit
- concurrency guard
- circuit breaker
- health and retry decisions

### `GatewayCacheService`

Responsibilities:

- route-level cache decision
- cache key generation
- cache lookup and cache writeback

### `GatewayAccessLogService`

Responsibilities:

- request-level log persistence
- redaction and body preview capture
- payload reference management for large bodies

### `GatewayObservabilityService`

Responsibilities:

- aggregate metrics
- publish runtime summary events
- feed management dashboards

## Data Model Direction

The target architecture extends the current model. It does not replace it wholesale.

### Existing entities to preserve

- `runtime_assets`
- `runtime_asset_endpoint_bindings`
- `gateway_route_bindings`

### Existing entity upgrades

`gateway_route_bindings` should evolve to hold stronger route and policy semantics.

Recommended additions:

- `matchHost`
- `pathMatchMode`
- `priority`
- `loggingPolicyRef`
- `cachePolicyRef`
- `rateLimitPolicyRef`
- `circuitBreakerPolicyRef`
- `upstreamConfig`
- `routeStatusReason`

### New entities recommended

- `gateway_runtime_snapshots`
- `gateway_access_logs`
- `gateway_policy_bindings`
- `gateway_consumer_credentials`
- `gateway_cache_entries` only if cache is not fully in-memory

## Logging And Audit Model

The gateway must use a layered logging design.

### 1. Access log layer

Always records:

- request and route identity
- actor and source metadata
- upstream target
- status and latency
- request and response byte counts

### 2. Runtime summary event layer

Uses the existing runtime observability event model for:

- throttling
- timeout
- upstream failure
- route degradation
- breaker transitions

### 3. Audit layer

Uses the existing audit model for:

- privileged route access
- policy change traceability
- security-sensitive request categories

### 4. Content capture policy

Supported modes:

- `meta_only`
- `headers_only`
- `body_preview`
- `body_on_error`
- `full_body_small_payload`
- `sampled_full_body`

Defaults:

- no full body capture by default
- multipart file contents are not stored by default
- binary response bodies are not stored by default

## Cache Model

Cache is a controlled policy feature, not a universal behavior.

### Initial scope

- GET and HEAD only
- route-enabled only
- in-process memory cache

### Future scope

- Redis-backed distributed cache
- manual purge and publish-triggered purge
- cache metrics and cache hit observability

## Deployment Model

The gateway must remain easy to deploy.

### Default deployment

- one `api-nova-api` process handles both control plane and lightweight data plane

### Scale-out deployment

- multiple `api-nova-api` instances behind a load balancer
- shared database
- optional Redis for stronger distributed limits and cache

### Future split

- optional standalone gateway data plane process
- same publication control plane and snapshot contract

## Acceptance Boundaries

The gateway redesign is acceptable only if the following boundaries hold.

1. It remains aligned with the ApiNova product model and does not adopt a foreign gateway configuration language as the source of truth.
2. It remains lightweight enough to run as part of the current application by default.
3. It supports transparent HTTP proxying rather than JSON-only forwarding.
4. It reuses current publication, security, audit, and observability modules instead of duplicating them.
5. It keeps MCP and Gateway integrated at the runtime asset layer.

## Implementation Priority

The first implementation priority is correctness of the data plane:

1. route snapshot resolution
2. transparent stream-based proxy
3. request logging and observability
4. security and traffic policy
5. cache

For the concrete delivery sequence, see [api-gateway-phase1-technical-design](./api-gateway-phase1-technical-design.md).
