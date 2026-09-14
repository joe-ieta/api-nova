---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-14
---
# Management Observability Baseline

## Document status

Active, version 1.1.0, updated 2026-09-14. The current integration baseline is the lead agent's supplied remote `950e150` context, not a Git verification performed here. The [completion review](../guides/runtime-observability-completion-review.md) is the current summary; [execution status](../guides/runtime-observability-development-execution-status.md) is the evidence index.

Current reported status: 26/28 verified; API-27/API-28 (policies and Socket.IO) not implemented; TP11/TP12 done; AVAILABLE=0. Signed delivery, destination safety checks and manual replay already exist and are not reopened development tasks. OUTBOX and WEBHOOK automatic loops default off.

This round is static documentation/configuration checking only. The previous round's three passing builds and Parser 103, MCP 53, API 548 results are historical evidence, not new executions. No code, tests, configuration values or deployment were changed. Real-environment deployment and acceptance remain unperformed. The [archived remaining-work record](../archive/summaries/runtime-observability-2026-09-14/remaining-work-2026-09-14.md) is historical, not the active backlog.

> Document status: Active
> Last reviewed: 2026-09-14 (static scope review only)

## Purpose

This document defines the Stage 2 baseline for management-side observability, operational event logging, and placeholder telemetry behavior.

It exists so ApiNova can evolve like a product, not only like a codebase. Management actions, status transitions, failures, and unavailable telemetry must all be visible in a consistent way.

## Scope

This baseline covers:

- operation logging
- lifecycle and state-change events
- observability API boundaries
- telemetry placeholder rules
- minimum event coverage required during management refactor

This baseline does not yet define a full alerting platform or external log shipping architecture.
This baseline remains active because its management audit/lifecycle separation and truthful telemetry principles still apply. It is normative management guidance, not a claim that every coverage item is implemented, a runtime event wire schema, or an inventory of registered HTTP routes. Age alone is not a reason to archive it.

The event fields, categories and status vocabulary below describe management normalization guidance; they do not replace the implemented runtime event schema or webhook envelope. The required coverage and exit conditions are acceptance criteria, not a newly verified checklist. Do not label implemented runtime capabilities as placeholders or present implementation evidence as deployment evidence.

See [runtime integration](../guides/runtime-observability-integration.md), [subscription integration](../guides/runtime-observability-subscription-integration.md), and [external validation handoff](../guides/runtime-observability-external-validation-handoff.md) for current configuration and HTTP/wire contracts. Secret references and their actual key mappings are provisioned only through approved local environment/deployment mechanisms; no secret values belong in chat or this document.

## Design Principles

- Product-observable behavior matters as much as internal diagnostics.
- Operator-facing events must be queryable independently of raw developer logs.
- Real telemetry and unavailable telemetry must be distinguished explicitly.
- Every critical management write action should emit a structured event.
- Placeholder or not-yet-wired metrics are acceptable only if they are labeled truthfully.

## Observability Layers

Stage 2 should treat observability as three related but distinct layers.

### 1. Audit and operation events

Purpose:

- record who triggered which management action
- record whether the action succeeded, failed, or was rejected

Examples:

- server created
- endpoint published
- permission denied
- process monitor started

### 2. Domain lifecycle events

Purpose:

- record state transitions of managed resources

Examples:

- server status changed from `stopped` to `running`
- endpoint lifecycle changed from `verified` to `published`
- probe result changed endpoint health to degraded

### 3. Runtime diagnostic logs

Purpose:

- support debugging, failure analysis, and internal runtime diagnosis

Examples:

- stack traces
- downstream request failures
- parser errors
- process monitor failures

These logs are not a substitute for audit events.

## Minimum Event Model

Stage 2 should converge on a structured event shape close to the following:

- `eventId`
- `timestamp`
- `category`
- `action`
- `resourceType`
- `resourceId`
- `resourceName`
- `actorType`
- `actorId`
- `status`
- `severity`
- `message`
- `metadata`
- `traceId`
- `requestId`

## Event Categories

Recommended top-level categories:

- `server.lifecycle`
- `server.observability`
- `endpoint.governance`
- `process.lifecycle`
- `process.monitoring`
- `security.permission`
- `system.audit`

## Resource Types

The first implementation should support at least:

- `server`
- `endpoint`
- `document`
- `process`
- `mcp_session`
- `system`

## Action Vocabulary

The initial event vocabulary should cover:

- `create`
- `update`
- `delete`
- `start`
- `stop`
- `restart`
- `probe`
- `publish`
- `offline`
- `import`
- `validate`
- `convert`
- `monitor_start`
- `monitor_stop`
- `permission_denied`
- `health_check`

## Status Vocabulary

Use one normalized status set for management events:

- `success`
- `failed`
- `rejected`
- `timeout`
- `partial`
- `unavailable`

Avoid mixing ad hoc event result words unless there is a strong reason.

## Telemetry Contract Rules

All product-facing telemetry should fall into one of three modes:

- `measured`
- `derived`
- `unavailable`

For values that are not fully available, the API contract should still be explicit.

Recommended metric field structure:

- `value`
- `available`
- `source`
- `note`
- `updatedAt`

Examples:

- True measured process CPU from process monitoring: `available: true`, `source: "process-resource-monitor"`.
- Placeholder summary CPU not yet wired: `available: false`, `source: "not-wired"`, `note: "Use process resource monitoring for real CPU telemetry"`.

Returning fake `0` values for unavailable telemetry should be treated as a product defect.

## Required Stage 2 Event Coverage

The following operations must emit structured management events during Stage 2:

- server create
- server update
- server delete
- server start
- server stop
- server restart
- manual endpoint register
- API center profile update
- endpoint probe
- endpoint publish
- endpoint offline
- process resource monitoring start
- process resource monitoring stop
- process log monitoring start
- process log monitoring stop
- permission denied on protected management endpoints

## Proposed API Surface

The routes below are original Stage 2 design examples, not verified mounted endpoints or a current client contract. Use the linked integration guides for actual routes and deployment prefix boundaries. Retaining these examples does not create new implementation tasks.

Stage 2 should move toward a stable server-scoped observability contract such as:

- `GET /v1/servers/:id/observability/summary`
- `GET /v1/servers/:id/observability/events`
- `GET /v1/servers/:id/observability/metrics`
- `GET /v1/servers/:id/observability/process`
- `GET /v1/servers/:id/observability/logs`

And a broader management/system-level contract such as:

- `GET /v1/observability/audit`
- `GET /v1/observability/system`

Stage 2 does not need to finalize every route name immediately, but it should establish this boundary in controller design.

## Relationship To Existing Services

The original Stage 2 baseline identified these building blocks; this scope review does not reverify their individual implementation status:

- `SystemLogService`
- `ServerMetricsService`
- process log and resource monitor services
- security audit-style events in other modules

Stage 2 should not throw these away. It should standardize how they surface product-observable data.

## Placeholder Strategy

If the current monitoring stack cannot yet provide a required product-facing capability, Stage 2 must add an explicit placeholder mechanism instead of silently omitting the feature.

Acceptable placeholder forms:

- `available: false`
- `status: "unavailable"`
- clear UI labels such as `Unavailable` or `Not wired yet`
- event records that explain why an operation could not be fully observed

Unacceptable placeholder forms:

- fake zero values
- empty payloads that look like success
- undocumented partial behavior

## Implementation Order Within Stage 2

Recommended order:

1. define event model and telemetry placeholder rules
2. split observability-related controller boundaries
3. add structured event writing to critical write operations
4. unify server-scoped observability read APIs
5. align UI wording with unavailable / measured / derived states

## Exit Condition

This baseline is considered implemented only when:

1. critical management write operations emit structured events
2. server-scoped observability routes have a stable boundary
3. telemetry placeholder semantics are explicit in API responses
4. UI and docs no longer overstate missing observability capabilities