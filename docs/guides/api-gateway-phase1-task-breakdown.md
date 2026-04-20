# ApiNova API Gateway Phase 1 Task Breakdown

## Purpose

This document turns phase one of the ApiNova Gateway redesign into concrete engineering tasks and migration items.

It is meant to be executable against the current repository, module layout, and database baseline.

Related documents:

- [api-gateway-architecture-and-requirements](./api-gateway-architecture-and-requirements.md)
- [api-gateway-phase1-technical-design](./api-gateway-phase1-technical-design.md)
- [asset-model-and-runtime-assets](./asset-model-and-runtime-assets.md)

## Phase 1 Outcome

Phase one is successful only if ApiNova Gateway can do the following on the existing `/api/v1/gateway/...` path:

1. resolve active routes from in-memory state instead of ORM lookups on the hot path
2. transparently proxy JSON, multipart, binary upload, binary download, and SSE traffic
3. emit request-level access logs
4. preserve runtime observability metrics and runtime events
5. remain deployable in the current `api-nova-api` process

## Delivery Strategy

Phase one should be delivered in five work packages:

1. route snapshot and hot-path isolation
2. transparent stream proxy engine
3. request access logging and payload preview capture
4. observability bridge and error normalization
5. test and migration closure

Each work package below includes:

- implementation tasks
- file and module impact
- migration items
- exit criteria

## Work Package 1: Route Snapshot And Hot-Path Isolation

### Goal

Move gateway route resolution off the database hot path and prepare gateway execution to run from in-memory compiled state.

### Tasks

1. Add `GatewayRouteSnapshotService` under `gateway-runtime/services`.
2. Define a `ResolvedGatewayRoute` internal type that includes:
   - runtime asset id
   - runtime membership id
   - gateway route binding id
   - endpoint definition id
   - route path
   - route method
   - upstream base URL
   - upstream path
   - upstream method
   - timeout settings
   - policy references
3. Load active route data from existing publication and runtime tables into an immutable route snapshot.
4. Add route lookup API:
   - `resolve(host, method, path)`
5. Define snapshot reload triggers:
   - application bootstrap
   - publication changes
   - route binding updates
   - runtime asset activation or offline actions
6. Refactor current gateway runtime orchestration to depend on snapshot resolution instead of calling publication resolution on every request.

### Existing modules impacted

- [gateway-runtime.module.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/gateway-runtime.module.ts)
- [gateway-runtime.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)
- [publication.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/publication/services/publication.service.ts)

### New files expected

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-route-snapshot.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/types/gateway-route-snapshot.types.ts`

### Migration items

No database migration is strictly required for snapshot introduction.

Optional phase-one-ready migration:

- add `matchHost`, `pathMatchMode`, and `priority` to `gateway_route_bindings`

This is recommended if route ordering or host-based routing is needed immediately.

### Exit criteria

1. Gateway request handling can resolve active routes without per-request ORM queries.
2. A snapshot reload method exists and is testable.
3. Route resolution logic is covered by unit tests.

## Work Package 2: Transparent Stream Proxy Engine

### Goal

Replace the current buffered JSON forwarding behavior with a true stream-based reverse proxy engine.

### Tasks

1. Add `GatewayProxyEngine` under `gateway-runtime/services`.
2. Implement upstream request creation using Node native `http` and `https`.
3. Replace `HttpModule` and `axios` request dispatch on the gateway hot path.
4. Stream inbound request directly to upstream.
5. Stream upstream response directly to client response.
6. Implement target URL generation using:
   - upstream base URL
   - upstream path template
   - path params
   - original query string
7. Implement header forwarding rules:
   - drop hop-by-hop headers
   - rewrite `host`
   - attach `x-forwarded-*`
   - preserve business headers
8. Implement basic timeout handling:
   - connect timeout
   - overall upstream response timeout
9. Implement cancellation propagation:
   - if client aborts, cancel upstream request
10. Normalize gateway error results for:
   - route not found
   - upstream connection refused
   - timeout
   - client aborted request
   - internal proxy error

### Existing modules impacted

- [gateway-runtime.controller.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/gateway-runtime.controller.ts)
- [gateway-runtime.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)
- [main.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/main.ts)

### New files expected

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/types/gateway-proxy.types.ts`

### Migration items

No database migration required.

Runtime middleware change required:

- update [main.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/main.ts) so `express.json()` and `express.urlencoded()` bypass `/api/v1/gateway/`

### Exit criteria

1. Multipart upload proxies successfully.
2. Binary upload proxies successfully.
3. Binary download proxies successfully.
4. SSE is forwarded without buffering.
5. Gateway no longer relies on `req.body`.

## Work Package 3: Request Access Logging And Payload Preview Capture

### Goal

Introduce request-level access logging without breaking transparent proxying or causing uncontrolled data growth.

### Tasks

1. Add `GatewayAccessLogEntity`.
2. Add `GatewayAccessLogService`.
3. Add `GatewayRequestCaptureService`.
4. Capture the following for every request:
   - request id
   - correlation id
   - runtime asset id
   - runtime membership id
   - route binding id
   - method
   - route path
   - upstream URL
   - status code
   - latency
   - request bytes
   - response bytes
   - request content type
   - response content type
   - client IP
   - actor or user id when available
5. Implement capture policy modes for phase one:
   - `meta_only`
   - `headers_only`
   - `body_preview`
   - `body_on_error`
6. Implement capped request and response preview buffers.
7. Implement content-type-aware preview behavior:
   - text or JSON preview allowed
   - multipart metadata only
   - binary hash and size only
8. Implement redaction rules for:
   - `authorization`
   - `cookie`
   - `set-cookie`
   - `x-api-key`
   - common JSON secret fields
9. Persist access logs asynchronously after response completion where possible.

### Existing modules impacted

- `gateway-runtime` module
- `monitoring` query surfaces in later steps

### New files expected

- `packages/api-nova-api/src/database/entities/gateway-access-log.entity.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-access-log.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-request-capture.service.ts`

### Migration items

Add a new migration after the current latest baseline in `packages/api-nova-api/src/database/migrations`.

Recommended new migration name:

- `1760000005000-GatewayPhase1AccessLogs.ts`

Recommended schema additions:

1. create table `gateway_access_logs`
2. create indexes:
   - `requestId`
   - `runtimeAssetId`
   - `runtimeMembershipId`
   - `routeBindingId`
   - `statusCode`
   - `createdAt`

Suggested columns:

- `id`
- `requestId`
- `correlationId`
- `runtimeAssetId`
- `runtimeMembershipId`
- `routeBindingId`
- `endpointDefinitionId`
- `method`
- `routePath`
- `upstreamUrl`
- `statusCode`
- `latencyMs`
- `clientIp`
- `actorId`
- `requestContentType`
- `responseContentType`
- `requestBytes`
- `responseBytes`
- `requestHeaders`
- `responseHeaders`
- `requestQuery`
- `requestBodyPreview`
- `responseBodyPreview`
- `requestBodyHash`
- `responseBodyHash`
- `captureMode`
- `errorMessage`
- `createdAt`

Optional same migration additions to `gateway_route_bindings`:

- `loggingPolicyRef`

### Exit criteria

1. Each gateway request persists one access log row.
2. Preview capture does not break file upload or streaming proxy behavior.
3. Sensitive headers are redacted.
4. Large binary bodies do not get fully persisted.

## Work Package 4: Observability Bridge And Error Normalization

### Goal

Integrate the new proxy path with the existing runtime observability model and preserve operator-facing monitoring value.

### Tasks

1. Refactor current metrics recording into a gateway observability bridge service.
2. Keep [gateway-runtime-metrics.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime-metrics.service.ts) as the runtime metrics aggregator or make it an internal dependency of the new bridge.
3. Ensure every request result writes:
   - request count
   - success or failure count
   - latency
   - last status code
4. Emit runtime events for:
   - timeout
   - upstream connection failure
   - throttling once phase two lands
   - route degradation on repeated upstream failures
5. Add `requestId` and `correlationId` into observability event details where possible.
6. Standardize gateway error codes and response mapping.

### Existing modules impacted

- [gateway-runtime-metrics.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime-metrics.service.ts)
- [runtime-observability.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability.service.ts)

### Migration items

No mandatory database migration if existing runtime observability event storage is reused as-is.

Optional additions later:

- enrich runtime observability event details with gateway request identifiers

### Exit criteria

1. Gateway metrics still appear in monitoring.
2. Gateway proxy failures create observability events with actionable details.
3. Error responses and observability payloads use a consistent error model.

## Work Package 5: Test, Compatibility, And Migration Closure

### Goal

Close phase one with explicit test coverage, migration safety, and compatibility validation.

### Tasks

1. Add unit tests for:
   - route snapshot resolution
   - path parameter substitution
   - header forwarding rules
   - preview capture truncation
2. Add service tests for:
   - runtime orchestration
   - proxy error mapping
   - access log persistence
3. Add integration tests for:
   - JSON POST
   - multipart upload
   - binary upload
   - binary download
   - SSE
   - route not found
   - upstream timeout
4. Validate that current publication flows still produce gateway routes consumable by the snapshot loader.
5. Add migration test or migration dry-run check for PostgreSQL and SQLite compatibility where practical.
6. Update active docs if implementation differs from the current architecture document.

### Existing modules impacted

- [gateway-runtime.service.spec.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.spec.ts)
- test setup under `packages/api-nova-api`

### Migration items

1. Create and commit new migration file for `gateway_access_logs`.
2. If `gateway_route_bindings` gets new fields in phase one, include them in the same migration or a paired migration.
3. Update `DatabaseModule` entity registration if required.
4. Validate `typeorm migration:run` path against the current baseline numbering:
   - latest existing migration is `1760000004000-PublicationAuditFoundation.ts`

### Exit criteria

1. `pnpm.cmd --dir packages/api-nova-api type-check` passes.
2. Gateway integration tests pass.
3. New migration applies cleanly.
4. Existing gateway publication paths remain functional.

## Phase 1 Migration Plan

The recommended migration sequence is:

1. add `gateway_access_logs`
2. optionally extend `gateway_route_bindings` with host and policy fields

Recommended migration file:

- `1760000005000-GatewayPhase1AccessLogs.ts`

If route binding changes are included together, name can become:

- `1760000005000-GatewayPhase1ProxyFoundation.ts`

Recommended migration content:

1. create `gateway_access_logs`
2. add indexes
3. add route-binding fields if phase-one route matching needs them

## Suggested Task Board

Implementation can be tracked with the following task IDs.

### GW-P1-01

Build `GatewayRouteSnapshotService` and route snapshot types.

### GW-P1-02

Refactor `GatewayRuntimeService` to use snapshot resolution.

### GW-P1-03

Add gateway parser bypass in `main.ts`.

### GW-P1-04

Implement `GatewayProxyEngine` with Node `http` and `https`.

### GW-P1-05

Implement normalized gateway header forwarding and path rewrite helpers.

### GW-P1-06

Add `GatewayAccessLogEntity` and migration.

### GW-P1-07

Implement `GatewayRequestCaptureService`.

### GW-P1-08

Implement `GatewayAccessLogService`.

### GW-P1-09

Bridge proxy results into runtime observability and metrics.

### GW-P1-10

Implement gateway error normalization and response contract.

### GW-P1-11

Add unit tests.

### GW-P1-12

Add integration tests for multipart, binary, download, and SSE.

### GW-P1-13

Run type-check, migration validation, and phase-one regression verification.

## Implementation Dependencies

The work package dependency order should be:

1. `GW-P1-01`
2. `GW-P1-02`
3. `GW-P1-03`
4. `GW-P1-04`
5. `GW-P1-05`
6. `GW-P1-06`
7. `GW-P1-07`
8. `GW-P1-08`
9. `GW-P1-09`
10. `GW-P1-10`
11. `GW-P1-11`
12. `GW-P1-12`
13. `GW-P1-13`

Reasoning:

- route resolution and parser bypass are prerequisites for a correct proxy
- access logging depends on proxy and capture plumbing
- observability depends on stable proxy result contracts
- broad integration tests should land after the data path is in place

## Risks And Controls

### Risk 1: body parser still intercepts gateway requests

Control:

- land parser bypass before proxy engine rollout

### Risk 2: payload capture breaks streaming semantics

Control:

- implement capped tee capture instead of full buffering

### Risk 3: per-request logging causes latency spikes

Control:

- write logs asynchronously after response completion

### Risk 4: route resolution diverges from publication semantics

Control:

- build the snapshot from publication-owned state and validate with integration tests

### Risk 5: SQLite and PostgreSQL drift in migration behavior

Control:

- keep phase-one schema additions simple and JSON-column usage aligned with existing db-compat patterns

## Deliverables

Phase one should produce the following artifacts.

### Code

- route snapshot service
- stream-based proxy engine
- access log entity and service
- request capture service
- updated runtime orchestration
- updated tests

### Database

- one new migration for gateway access logs and optional route-binding extensions

### Documentation

- updated gateway implementation notes if behavior changes from the current phase-one design

## Final Acceptance Checklist

Before phase one is closed, all of the following must be true:

1. Gateway route resolution runs from in-memory snapshot state.
2. Gateway proxies multipart, binary, download, and SSE traffic.
3. Gateway no longer depends on parsed request body.
4. Gateway writes request-level access logs.
5. Gateway continues to emit runtime metrics and runtime events.
6. Migration applies cleanly.
7. Type-check passes.
8. Integration tests for the new proxy path pass.
