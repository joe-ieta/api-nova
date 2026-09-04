# ApiNova API Gateway Phase 1 Technical Design

## Purpose

This document turns the gateway architecture requirements into an implementation plan for phase one.

Phase one is intentionally narrow:

- make gateway proxying correct
- make gateway proxying transparent
- make gateway proxying observable
- keep deployment lightweight

Phase one does not attempt to ship every governance feature at once.

## Phase 1 Scope

Phase one delivers the minimum production-worthy gateway core for ApiNova.

Included:

- route snapshot loading for gateway runtime
- transparent request and response streaming
- path and method mapping
- request and response metadata logging
- request and response body preview capture under policy
- runtime metrics and summary events
- route-level timeout and basic retry support
- gateway route parser bypass for body middleware

Deferred to later phases:

- distributed rate limiting
- full API key consumer lifecycle
- circuit breaker state persistence
- Redis cache
- advanced cache invalidation
- full management UI

## Baseline Problem

The current gateway runtime is transitional.

Current limitations:

- it uses `HttpModule` and buffered request dispatch
- it forwards `req.body` rather than the original request stream
- it depends on Express body parsing behavior that is not compatible with transparent proxying

Relevant files:

- [main.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/main.ts)
- [gateway-runtime.controller.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/gateway-runtime.controller.ts)
- [gateway-runtime.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)
- [gateway-runtime-metrics.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime-metrics.service.ts)

Phase one replaces this path with an internal gateway execution pipeline.

## Delivery Objectives

Phase one is complete when the gateway can:

1. receive requests on `/api/v1/gateway/...`
2. match active routes without per-request database access
3. transparently proxy JSON, multipart, binary, download, and SSE traffic
4. preserve route-level observability and request tracking
5. write request-level logs without blocking the response path

## Target Internal Modules

Phase one should create or refactor toward the following services inside `gateway-runtime`.

## 1. `GatewayRouteSnapshotService`

Purpose:

- compile active gateway publication state into an in-memory route table

Responsibilities:

- load all active `gateway_service` route bindings
- join route bindings, runtime assets, membership bindings, and publication state
- generate normalized route match entries
- expose reload hooks on publication changes

Inputs:

- `PublicationService`
- TypeORM repositories for runtime and route entities

Outputs:

- immutable in-memory route snapshot

Hot-path contract:

- `resolve(host, method, path): ResolvedGatewayRoute | null`

## 2. `GatewayProxyEngine`

Purpose:

- execute transparent upstream proxying using Node streams

Responsibilities:

- construct target upstream URL
- build proxy request options
- stream inbound request to upstream
- stream upstream response to client
- surface normalized proxy result metadata

Implementation rules:

- use Node native `http` and `https`
- do not use `axios`
- do not buffer full request or response bodies unless capture policy explicitly requires preview buffering
- keep backpressure support through stream piping

## 3. `GatewayAccessLogService`

Purpose:

- persist request-level access records

Responsibilities:

- record request meta and response meta
- capture body preview based on route policy
- apply redaction rules
- store large payload references if later required

Recommended phase-one entity:

- `gateway_access_logs`

Minimum fields:

- `requestId`
- `correlationId`
- `runtimeAssetId`
- `runtimeMembershipId`
- `routeBindingId`
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

## 4. `GatewayRequestCaptureService`

Purpose:

- produce safe body previews for logging without breaking transparent proxying

Responsibilities:

- tee inbound and outbound streams into capped preview buffers
- calculate byte counts
- calculate payload hashes
- enforce capture size limits
- apply redaction and content-type aware logic

Phase-one behavior:

- JSON and text types may store preview text
- multipart stores metadata and capped textual preview only
- binary stores size and hash only

## 5. `GatewayObservabilityBridgeService`

Purpose:

- bridge gateway runtime results into existing observability modules

Responsibilities:

- feed request counters and latency metrics
- emit runtime error and route degradation events
- connect request identifiers to runtime observability details

This service should build on the existing:

- [gateway-runtime-metrics.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime-metrics.service.ts)
- [runtime-observability.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability.service.ts)

## 6. `GatewayRuntimeService`

Purpose:

- remain the orchestrator, not the low-level proxy executor

Phase-one orchestration flow:

1. resolve route
2. create request context
3. invoke proxy engine
4. hand off access log write
5. hand off observability update
6. return or stream final response

## Hot Path Design

The phase-one request flow should be:

1. controller receives request and response objects
2. runtime service allocates `requestId`
3. snapshot service resolves route entry
4. capture service initializes request-side tee if policy requires
5. proxy engine opens upstream connection
6. request is streamed upstream
7. upstream response is streamed back to client
8. capture service finalizes preview, counts, and hashes
9. access log write is dispatched
10. observability summary is dispatched

Request hot-path rules:

- no ORM lookups after route resolution begins
- no full payload materialization
- no blocking log flush before response end

## Data Model Changes

Phase one should keep schema additions narrow.

## 1. Extend `gateway_route_bindings`

Recommended additions for immediate use:

- `matchHost` nullable
- `pathMatchMode` default `exact`
- `priority` default `0`
- `loggingPolicyRef` nullable
- `cachePolicyRef` nullable
- `rateLimitPolicyRef` nullable
- `upstreamConfig` JSON nullable

## 2. Add `gateway_access_logs`

Purpose:

- request-level proxy log persistence

Reason:

- existing runtime observability is a summary-event model
- existing audit log is not a good fit for every single proxy access record

## 3. Add `gateway_runtime_snapshots`

Purpose:

- persist the compiled route and policy view used by the runtime

Phase-one minimum:

- `runtimeAssetId`
- `revision`
- `status`
- `snapshotJson`
- `checksum`
- `activatedAt`

If schema cost is too high for phase one, the snapshot may start in memory only, but the code should keep the abstraction ready.

## Middleware Change Requirement

Transparent proxying is blocked by current global body parsing.

Required change in [main.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/main.ts):

- `express.json()` and `express.urlencoded()` must skip gateway routes

Recommended implementation shape:

- wrap body parser registration in a conditional middleware
- if request path starts with `/api/v1/gateway/`, bypass parser
- otherwise apply existing parser behavior

This is a hard requirement for correct multipart and binary forwarding.

## Header Handling Rules

Proxy request header logic must follow strict rules.

### Drop hop-by-hop headers

- `connection`
- `keep-alive`
- `proxy-authenticate`
- `proxy-authorization`
- `te`
- `trailers`
- `transfer-encoding`
- `upgrade`

### Rewrite selected headers

- `host`
- `x-forwarded-for`
- `x-forwarded-host`
- `x-forwarded-proto`
- `x-request-id`

### Preserve business headers

- `authorization`
- `content-type`
- custom application headers

## Logging Policy In Phase 1

Phase one should support only a small set of capture modes.

- `meta_only`
- `headers_only`
- `body_preview`
- `body_on_error`

Defaults:

- route default is `meta_only`
- preview byte limit should be small and configurable
- full body persistence is deferred

## Error Model

Phase one should normalize proxy failures into a stable result model.

Error classes:

- route not found
- route inactive
- upstream connect timeout
- upstream response timeout
- upstream connection refused
- client aborted request
- gateway internal error

Each error should yield:

- normalized HTTP status
- gateway error code
- requestId in response headers where possible
- observability event payload

## Tests

Phase one requires automated coverage in four layers.

## 1. Unit tests

- route snapshot normalization
- path parameter replacement
- header filtering and forwarding rules
- capture preview truncation and hashing

## 2. Service tests

- runtime service orchestration
- proxy engine error mapping
- access log persistence behavior

## 3. Integration tests

- JSON POST proxy
- multipart upload proxy
- binary upload proxy
- binary download proxy
- SSE proxy
- route not found
- upstream timeout

## 4. Non-regression tests

- existing publication logic still resolves valid active gateway routes
- existing runtime observability metrics still record request results

## Implementation Sequence

The recommended coding order is:

1. add route snapshot abstraction
2. add parser bypass for gateway paths
3. introduce low-level proxy engine
4. refactor controller and runtime service to stream results
5. add access log entity and service
6. add request capture and preview logic
7. bridge access results into observability
8. add integration tests

## Exit Criteria

Phase one is done only when all of the following are true.

1. Gateway no longer depends on `req.body` for proxying.
2. Multipart upload works through `/api/v1/gateway/...`.
3. Binary upload and download work through `/api/v1/gateway/...`.
4. SSE can stream through the gateway.
5. Per-request access logs exist and are queryable.
6. Existing runtime metrics still work.
7. The solution still runs in the current NestJS application without requiring a second deployable.

## Phase 2 Preview

After phase one, the next layer of work is:

- JWT and API key enforcement
- rate limiting and concurrency guards
- cache
- circuit breaker and retry policy expansion
- richer route policy binding

These are intentionally deferred until the transparent data path is correct.
