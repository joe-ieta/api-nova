# Runtime Observability Stage 6 Model

## Purpose

This document defines the Stage 6 observability target for ApiNova.

It replaces the current mixed model where runtime signals are split across:

- `audit_logs`
- `system_logs`
- in-memory metrics histories
- server-first process telemetry

The Stage 6 target is runtime-asset-first.

Historical legacy tables and records do not define the target architecture.

- old `audit_logs`
- old `system_logs`
- old server-first metric history

These may remain as historical data during transition, but they are not compatibility targets for the new model.
The goal is capability preservation through a new normalized runtime observability model, not schema preservation.

## 1. Design Goal

Observability must follow the corrected asset hierarchy:

1. source service asset
2. endpoint definition
3. runtime asset
4. runtime asset membership

From the usage side, the primary monitored object is the runtime asset.

That means:

- MCP runtime assets emit their own events and metrics
- Gateway runtime assets emit their own events and metrics
- endpoint and source-service drill-down remain available, but they are secondary dimensions

## 2. Problems In The Current Model

The current observability path has four structural problems:

1. `system_logs` are still server-first and bind mainly to `serverId`
2. `audit_logs` describe operator actions but do not align with runtime-asset identity
3. metric histories are in-memory and disappear on process restart
4. event, metric, and latest-state responsibilities are mixed together

This makes runtime-asset observability incomplete and forces Gateway to remain weaker than MCP.

The correction principle is:

1. keep the capability categories of system log, audit log, and metrics
2. stop treating old table structures as authoritative
3. derive those capability views from the new runtime-asset-first event, metric, and state model

## 3. New Three-Layer Observability Model

Stage 6 should use three complementary persistence layers.

### 3.1 Event stream

Table:

- `runtime_observability_events`

Purpose:

- immutable event stream
- audit-style runtime traceability
- route, policy, health, lifecycle, and publication event history

Examples:

- runtime asset deployed
- runtime asset started
- runtime asset stopped
- route publish activated
- upstream request failed
- health status changed
- policy binding changed

### 3.2 Metric series

Table:

- `runtime_metric_series`

Purpose:

- sampled or aggregated numeric time series
- fixed write rhythm instead of per-request raw persistence
- charting, trend, and alert evaluation input

Examples:

- requests per minute
- error count per minute
- p95 latency
- active routes
- active connections
- upstream availability ratio

### 3.3 Latest state snapshot

Table:

- `runtime_observability_states`

Purpose:

- one latest state row per runtime asset or runtime membership
- fast current-status reads for API and UI
- no need to scan event history for every detail request

Examples:

- current health
- current runtime status
- latest route counters
- last error summary
- last successful activity

## 4. Identity Rules

The new observability model must not use `MCPServerEntity.id` as the primary usage identity.

Primary references should be:

- `runtimeAssetId`
- `runtimeAssetEndpointBindingId`
- `endpointDefinitionId`
- `sourceServiceAssetId`

Optional compatibility references may exist only as metadata, not as the main relational anchor.

## 5. Core Data Shapes

### 5.1 `runtime_observability_events`

Recommended columns:

- `id`
- `runtimeAssetId`
- `runtimeAssetEndpointBindingId`
- `endpointDefinitionId`
- `sourceServiceAssetId`
- `eventFamily`
- `eventName`
- `severity`
- `status`
- `occurredAt`
- `correlationId`
- `actorType`
- `actorId`
- `summary`
- `details`
- `dimensions`
- `retentionClass`
- `createdAt`

Design notes:

- immutable append-only
- one normalized event vocabulary for both MCP and Gateway
- details payload stays JSON, but top-level query fields must be indexed

### 5.2 `runtime_metric_series`

Recommended columns:

- `id`
- `runtimeAssetId`
- `runtimeAssetEndpointBindingId`
- `endpointDefinitionId`
- `sourceServiceAssetId`
- `metricScope`
- `metricName`
- `aggregationWindow`
- `windowStartedAt`
- `windowEndedAt`
- `metricType`
- `value`
- `unit`
- `sampleCount`
- `dimensions`
- `createdAt`

Design notes:

- time-window aggregation, not unlimited raw request writes
- one row per metric name, scope, window, and dimension set
- dimensions can include route path, method, transport, status class, upstream host

### 5.3 `runtime_observability_states`

Recommended columns:

- `id`
- `scopeType`
- `runtimeAssetId`
- `runtimeAssetEndpointBindingId`
- `endpointDefinitionId`
- `sourceServiceAssetId`
- `currentStatus`
- `healthStatus`
- `severity`
- `lastEventAt`
- `lastSuccessAt`
- `lastFailureAt`
- `lastErrorCode`
- `lastErrorMessage`
- `summary`
- `counters`
- `gauges`
- `dimensions`
- `updatedAt`
- `createdAt`

Design notes:

- mutable latest-state table
- unique key by scope identity
- optimized for current dashboard, not for historical analytics

## 6. Event Vocabulary

The event model should use stable families rather than ad hoc names.

Recommended families:

- `runtime.lifecycle`
- `runtime.health`
- `runtime.policy`
- `runtime.publication`
- `runtime.route`
- `runtime.request`
- `runtime.error`
- `runtime.control`

Recommended severity:

- `debug`
- `info`
- `warning`
- `error`
- `critical`

Recommended status:

- `success`
- `failed`
- `partial`
- `active`
- `offline`
- `degraded`

## 7. Metric Write Policy

Stage 6 must not persist every raw request as a metric row.

Required policy:

1. per-request events only for selected failures, lifecycle changes, and sampled request traces
2. counters and latency metrics are aggregated in memory for a short interval
3. the flusher writes one time-window row into `runtime_metric_series`
4. `runtime_observability_states` is updated with the latest counters and last-error info

This keeps SQLite viable while preserving PostgreSQL scalability.

## 8. Retention Policy

Retention must be explicit by data class.

## 9. Capability Projection Rule

The product still needs three operational capability views:

1. system log view
2. audit log view
3. metrics view

Under the new architecture, these are projections over the new runtime observability model:

- system log view is derived mainly from lifecycle, health, request, and error events
- audit log view is derived mainly from control, policy, and publication events
- metrics view is derived from `runtime_metric_series` plus `runtime_observability_states`

This means APIs and UI can continue to expose these three capability families without keeping the old storage schema in the critical path.

Recommended baseline:

- event stream: 14 to 30 days by default
- metric series: 7 to 30 days at fine granularity, with optional roll-up later
- latest state: no history, current row only

Retention class examples:

- `short`
- `standard`
- `security`
- `long`

## 9. Query Model

The top-level API and UI should query by runtime asset first.

Primary read patterns:

- runtime asset overview
- runtime asset current observability summary
- runtime asset event timeline
- runtime asset metric charts
- runtime membership drill-down

The old server-first observability routes should become compatibility views, not the core model.

## 10. Migration Principle

Stage 6 should not try to fully normalize old observability records in place.

Instead:

1. keep old `audit_logs` and `system_logs` readable during transition
2. route all new runtime observability writes to the new tables
3. backfill only the minimum fields required for current dashboards if needed
4. reduce server-first observability APIs after runtime-asset APIs are stable

## 11. Initial Implementation Scope

The first Stage 6 observability delivery should land:

1. new entities and migrations
2. one runtime event writer service
3. one runtime metric flusher for Gateway and MCP runtime assets
4. one runtime state updater
5. runtime-asset-first observability read APIs

Full replacement of all old observability APIs can happen after this baseline is stable.
