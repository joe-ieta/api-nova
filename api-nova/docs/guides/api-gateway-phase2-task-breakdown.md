# ApiNova API Gateway Phase 2 Task Breakdown

## Purpose

This document turns phase two of the ApiNova Gateway redesign into concrete engineering work packages, task ownership boundaries, and migration items.

Phase two starts from the completed phase-one baseline:

- transparent reverse proxying already works
- route snapshots already exist
- request-level access logs already exist
- runtime observability already records gateway results
- gateway monitoring surfaces already exist in backend and UI

Phase two should not reopen phase-one data path work unless a bug is discovered.

Related documents:

- [api-gateway-architecture-and-requirements](./api-gateway-architecture-and-requirements.md)
- [api-gateway-phase1-technical-design](./api-gateway-phase1-technical-design.md)
- [api-gateway-phase1-task-breakdown](./api-gateway-phase1-task-breakdown.md)
- [asset-model-and-runtime-assets](./asset-model-and-runtime-assets.md)

## Phase 2 Outcome

Phase two is successful only if ApiNova Gateway can do the following on top of the current `/api/v1/gateway/...` path:

1. enforce route-level access mode with anonymous, JWT, and API key support
2. enforce route-level and runtime-level traffic governance, starting with rate limiting and concurrency guard
3. support bounded retry and basic circuit-breaker style upstream protection for safe/idempotent requests
4. support route-controlled in-process caching for GET and HEAD
5. make route policy binding explicit and queryable from publication and runtime management surfaces

## Delivery Strategy

Phase two should be delivered in six work packages:

1. policy model foundation and route-binding upgrades
2. gateway security enforcement
3. traffic control and resilience
4. route-controlled cache
5. management, monitoring, and UI closure
6. test, migration, and compatibility closure

Each work package below includes:

- implementation tasks
- file and module impact
- migration items
- exit criteria

## Work Package 1: Policy Model Foundation And Route-Binding Upgrades

### Goal

Upgrade `gateway_route_bindings` and adjacent runtime metadata so phase-two features are driven by explicit policy references instead of hard-coded behavior.

### Tasks

1. Extend `gateway_route_bindings` with:
   - `matchHost`
   - `pathMatchMode`
   - `priority`
   - `loggingPolicyRef`
   - `cachePolicyRef`
   - `rateLimitPolicyRef`
   - `circuitBreakerPolicyRef`
   - `upstreamConfig`
   - `routeStatusReason`
2. Introduce a gateway policy resolution contract inside `gateway-runtime`.
3. Add a `GatewayPolicyService` that resolves auth, traffic, logging, and cache policy for one route snapshot entry.
4. Keep the policy model lightweight:
   - string refs remain first-class
   - structured fallback can live inside route binding JSON fields where necessary
5. Add snapshot-level policy compilation:
   - route snapshot output should include resolved policy refs and normalized overrides
6. Add policy-related read surfaces to publication/runtime asset APIs where needed.

### Existing modules impacted

- [gateway-route-binding.entity.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/database/entities/gateway-route-binding.entity.ts)
- [publication.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/publication/services/publication.service.ts)
- [gateway-route-snapshot.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-route-snapshot.service.ts)
- [runtime-assets.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-assets/services/runtime-assets.service.ts)

### New files expected

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-policy.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/types/gateway-policy.types.ts`

### Migration items

Recommended new migration name:

- `1760000006000-GatewayPhase2PolicyFoundation.ts`

Recommended schema additions:

1. extend `gateway_route_bindings`
2. optionally add a lightweight `gateway_policy_bindings` table only if inline route binding fields become insufficient

### Exit criteria

1. Every active route can resolve a normalized policy bundle from snapshot state.
2. No policy lookup requires ORM work on the request hot path.
3. Publication/runtime APIs can surface the route policy references operators need to inspect.

## Work Package 2: Gateway Security Enforcement

### Goal

Move Gateway from “transparent published route” to “policy-controlled published route” by enforcing caller authentication and authorization at the route level.

### Tasks

1. Add `GatewaySecurityService`.
2. Support route-level access modes:
   - anonymous
   - JWT
   - API key
3. Reuse the existing `SecurityModule` and JWT model instead of creating a parallel identity store.
4. Introduce lightweight consumer credential storage for API keys:
   - key id
   - hashed secret
   - status
   - label
   - optional runtime asset or route scoping
5. Define API key extraction rules:
   - `Authorization: Bearer`
   - `x-api-key`
   - optional query-string support only if explicitly enabled
6. Add request context enrichment:
   - actor id
   - auth mode
   - consumer id
   - tenant/context key if later required
7. Support route-level policy failures with stable gateway error responses and observability events.

### Existing modules impacted

- [security.module.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/security/security.module.ts)
- [gateway-runtime.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)
- [gateway-access-log.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-access-log.service.ts)
- [runtime-observability.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability.service.ts)

### New files expected

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-security.service.ts`
- `packages/api-nova-api/src/database/entities/gateway-consumer-credential.entity.ts`

### Migration items

If API key support is in scope immediately:

- add `gateway_consumer_credentials`

Recommended schema fields:

- `id`
- `name`
- `keyId`
- `secretHash`
- `status`
- `runtimeAssetId`
- `routeBindingId`
- `metadata`
- `createdAt`
- `updatedAt`

### Exit criteria

1. Gateway can reject unauthorized JWT routes.
2. Gateway can reject invalid API keys.
3. Access logs and observability reflect auth mode and auth failure outcome.
4. Existing anonymous routes continue to work.

## Work Package 3: Traffic Control And Resilience

### Goal

Add the first production governance layer for throughput and upstream protection without turning the gateway into a heavyweight distributed system.

### Tasks

1. Add `GatewayTrafficControlService`.
2. Support in-process rate limiting for:
   - global gateway scope
   - runtime asset scope
   - route scope
   - consumer scope where identity exists
3. Support in-process concurrency limits per route and per runtime asset.
4. Add bounded retry support:
   - GET and HEAD by default
   - optional idempotent override for selected routes
   - no retry for non-idempotent requests unless explicitly enabled
5. Add circuit-breaker style state for upstream failure bursts:
   - closed
   - open
   - half-open
6. Add basic passive health signal updates from gateway request failures.
7. Emit runtime events for:
   - rate limit reject
   - concurrency reject
   - retry attempt
   - breaker open
   - breaker recover

### Existing modules impacted

- [gateway-proxy-engine.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts)
- [gateway-runtime.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)
- [gateway-runtime-metrics.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime-metrics.service.ts)
- [runtime-observability.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-observability/services/runtime-observability.service.ts)

### New files expected

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-traffic-control.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/types/gateway-traffic.types.ts`

### Migration items

No mandatory migration if state remains in memory during phase two.

Optional future migration:

- `gateway_breaker_states`

Not required for the initial phase-two drop.

### Exit criteria

1. Rate limit rejection works and is observable.
2. Concurrency guard works and is observable.
3. Retry only executes under explicit safe conditions.
4. Breaker state prevents repeated immediate upstream hammering.

## Work Package 4: Route-Controlled Cache

### Goal

Add a lightweight, route-controlled in-process cache that reuses the existing publication model and does not compromise correctness.

### Tasks

1. Add `GatewayCacheService`.
2. Support cache only for GET and HEAD in phase two.
3. Add route-level enablement through `cachePolicyRef` and route binding config.
4. Add cache key composition rules using:
   - normalized route path
   - selected query keys
   - selected headers
   - optional consumer identity
5. Store:
   - response status
   - selected response headers
   - response body buffer up to a configured size limit
6. Add cache TTL and eviction rules.
7. Add invalidation hooks for:
   - route publish/offline changes
   - route config changes
   - manual runtime asset redeploy where needed
8. Add cache hit/miss observability and monitoring counters.

### Existing modules impacted

- [gateway-runtime.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)
- [gateway-proxy-engine.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts)
- [runtime-assets.service.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-assets/services/runtime-assets.service.ts)

### New files expected

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-cache.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/types/gateway-cache.types.ts`

### Migration items

No database migration required if phase-two cache remains in-process.

If durable cache metadata becomes necessary:

- add `gateway_cache_entries`

This should stay optional.

### Exit criteria

1. Enabled GET routes can serve cache hits safely.
2. Non-cacheable methods bypass cache completely.
3. Route publish changes invalidate cache entries tied to changed routes.
4. Cache hit ratio becomes visible in runtime metrics.

## Work Package 5: Management, Monitoring, And UI Closure

### Goal

Make phase-two governance features operable from the existing control plane instead of leaving them as hidden backend switches.

### Tasks

1. Extend publication/runtime APIs so operators can:
   - configure route policy references
   - inspect auth mode
   - inspect rate limit and cache policy refs
2. Extend monitoring APIs to expose:
   - throttling counts
   - breaker state
   - cache hits/misses
   - auth failure counts
3. Extend runtime asset detail and monitoring UI to show:
   - route policy refs
   - access mode
   - cache state
   - rate-limit/breaker related runtime events
4. Add minimal management flows for API key credential listing and revocation if API key support lands in the same phase.
5. Keep UI additions narrow and operationally useful; do not attempt a full gateway admin console in phase two.

### Existing modules impacted

- [monitoring.controller.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/monitoring/monitoring.controller.ts)
- [runtime-assets.controller.ts](/E:/CodexDev/api-nova/packages/api-nova-api/src/modules/runtime-assets/runtime-assets.controller.ts)
- [api.ts](/E:/CodexDev/api-nova/packages/api-nova-ui/src/services/api.ts)
- [monitoring.ts](/E:/CodexDev/api-nova/packages/api-nova-ui/src/stores/monitoring.ts)
- [Dashboard.vue](/E:/CodexDev/api-nova/packages/api-nova-ui/src/modules/monitoring/monitoring/Dashboard.vue)
- [RuntimeAssetDetail.vue](/E:/CodexDev/api-nova/packages/api-nova-ui/src/modules/runtime-assets/RuntimeAssetDetail.vue)

### Migration items

No required migration beyond the policy foundation and optional consumer credential table.

### Exit criteria

1. Operators can inspect route policy state from the current management surfaces.
2. Monitoring shows auth, throttling, breaker, and cache signals.
3. UI stays aligned with the runtime-asset-first product model.

## Work Package 6: Test, Migration, And Compatibility Closure

### Goal

Close phase two with explicit coverage for security, governance, resilience, and cache behavior.

### Tasks

1. Add unit tests for:
   - policy resolution
   - API key parsing and validation
   - rate limit key generation
   - concurrency counter behavior
   - cache key generation
   - cache invalidation
2. Add service tests for:
   - security enforcement orchestration
   - retry decision rules
   - breaker transitions
   - cache decision flow
3. Add integration tests for:
   - anonymous route success
   - JWT-protected route success/failure
   - API key-protected route success/failure
   - rate-limited route rejection
   - concurrency guard rejection
   - retry on upstream failure for idempotent route
   - breaker open behavior
   - cache hit/miss for GET route
4. Add migration tests for new route binding fields and optional consumer credential schema.
5. Re-run full repository tests and UI type-check after phase-two changes land.

### Existing modules impacted

- `packages/api-nova-api/src/modules/gateway-runtime/**/*.spec.ts`
- `packages/api-nova-api/src/modules/publication/**/*.spec.ts`
- `packages/api-nova-api/src/modules/runtime-assets/**/*.spec.ts`
- `packages/api-nova-ui` type-check and any relevant component tests

### Migration items

1. create and commit the phase-two schema migration
2. validate migration behavior for SQLite and PostgreSQL compatibility
3. update entity registration and monitoring DTOs as needed

### Exit criteria

1. `pnpm.cmd --dir packages/api-nova-api type-check` passes
2. `pnpm.cmd test` passes
3. `pnpm.cmd --dir packages/api-nova-ui type-check` passes
4. phase-two governance features are covered by targeted tests

## Phase 2 Migration Plan

The recommended migration order is:

1. extend `gateway_route_bindings` with policy and routing fields
2. optionally add `gateway_consumer_credentials`
3. avoid durable cache or breaker tables unless clearly required

Recommended migration file:

- `1760000006000-GatewayPhase2PolicyFoundation.ts`

If API key storage lands in the same migration, the name can become:

- `1760000006000-GatewayPhase2GovernanceFoundation.ts`

## Suggested Task Board

Implementation can be tracked with the following task IDs.

### GW-P2-01

Extend `gateway_route_bindings` with phase-two policy fields.

### GW-P2-02

Implement `GatewayPolicyService` and snapshot-level policy compilation.

### GW-P2-03

Implement `GatewaySecurityService` with anonymous/JWT/API key route access modes.

### GW-P2-04

Add API key credential persistence and management read surface.

### GW-P2-05

Implement in-process rate limiting and concurrency guard.

### GW-P2-06

Implement bounded retry and basic breaker state transitions.

### GW-P2-07

Implement `GatewayCacheService` with GET/HEAD-only route cache.

### GW-P2-08

Emit auth/throttle/cache/breaker metrics and runtime events.

### GW-P2-09

Extend publication/runtime/monitoring APIs for policy inspection and governance signals.

### GW-P2-10

Update UI monitoring and runtime asset views for phase-two governance state.

### GW-P2-11

Add unit and service tests for security, traffic control, and cache.

### GW-P2-12

Add integration tests for auth, limit, retry, breaker, and cache flows.

### GW-P2-13

Run migration validation, full repository tests, and UI type-check.

## Implementation Dependencies

The work package dependency order should be:

1. `GW-P2-01`
2. `GW-P2-02`
3. `GW-P2-03`
4. `GW-P2-05`
5. `GW-P2-06`
6. `GW-P2-07`
7. `GW-P2-08`
8. `GW-P2-09`
9. `GW-P2-10`
10. `GW-P2-11`
11. `GW-P2-12`
12. `GW-P2-13`

`GW-P2-04` can land alongside `GW-P2-03` if API key support is not deferred.

Reasoning:

- policy fields and policy resolution are prerequisites for every later governance feature
- security and traffic control need stable policy resolution first
- cache should be added only after request admission and retry/breaker rules are clear
- monitoring and UI should reflect already-landed backend semantics rather than guess them

## Risks And Controls

### Risk 1: governance logic leaks ORM work back into the hot path

Control:

- compile policy bundle into the route snapshot

### Risk 2: JWT/API key handling diverges from the existing security model

Control:

- reuse `SecurityModule` semantics and avoid a parallel auth stack

### Risk 3: retry introduces duplicate side effects

Control:

- default retry to GET and HEAD only
- require explicit opt-in for other methods

### Risk 4: in-process rate limit and breaker state behave inconsistently across multi-instance deployments

Control:

- document the in-process boundary clearly in phase two
- keep Redis-backed distributed coordination as a later enhancement

### Risk 5: cache serves incorrect responses across consumer contexts

Control:

- require explicit cache key policy
- default cache key to include route path and selected query only
- add consumer identity only when the route policy requires it

## Deliverables

Phase two should produce the following artifacts.

### Code

- gateway policy service
- gateway security service
- gateway traffic control service
- gateway cache service
- upgraded route binding model
- expanded monitoring and management surfaces
- updated UI operational views
- updated tests

### Database

- one phase-two governance migration
- optional API key credential schema

### Documentation

- this phase-two task breakdown
- any follow-up technical design updates if implementation materially narrows or expands scope

## Final Acceptance Checklist

Before phase two is closed, all of the following must be true:

1. Route policy is explicit and snapshot-resolved.
2. JWT and API key protected routes can be enforced.
3. Rate limiting and concurrency guard work.
4. Retry and breaker behavior are bounded and observable.
5. GET/HEAD route cache works and can be invalidated on publication changes.
6. Operators can inspect gateway governance state from existing management surfaces.
7. Full repository tests pass.
8. UI type-check passes.
