# Management Permission Matrix

## Purpose

This document defines the intended permission boundary for ApiNova management endpoints in the Stage 2 refactor.

Its purpose is to make route protection auditable before controller splitting and endpoint refactoring begin.

This is a design baseline first. It should be updated together with controller refactors and guard changes.

## Design Principles

- Use `JwtAuthGuard` consistently for management surfaces.
- Keep permission requirements explicit at method level instead of relying on broad controller-level permission declarations.
- Separate read, write, execute, governance, and observability permissions where possible.
- Prefer stable route-family contracts over one-off per-method exceptions.
- If a route exposes sensitive operational state, it must not be protected only by authentication.

## Permission Semantics To Confirm In Code

Before implementation, confirm and document the effective semantics of `@RequirePermissions(...)`:

- whether listed permissions mean `ANY OF`
- or whether they mean `ALL OF`

The current controller usage strongly suggests that many routes assume `ANY OF` semantics.

Stage 2 should preserve behavior intentionally, not accidentally.

## Route Families

### 1. Server lifecycle

Route family:

- `/v1/servers`
- `/v1/servers/:id`
- start / stop / restart / batch-action endpoints

Primary permissions:

- `server:read`
- `server:create`
- `server:update`
- `server:delete`
- `server:execute`

Recommended mapping:

- list / detail / tools / simple status reads:
  - `server:read`
- create:
  - `server:create`
- update:
  - `server:update`
- delete:
  - `server:delete`
- start / stop / restart / batch execution:
  - `server:execute`
- high-risk lifecycle actions may additionally accept:
  - `server:manage`

### 2. Asset catalog, governance, and publication

Route family:

- `/v1/assets/source-services/*`
- `/v1/assets/endpoints/*`
- `/v1/publication/endpoints/runtime-memberships/*`

Primary permissions:

- `server:read`
- `server:update`
- `server:manage`

Recommended mapping:

- source-service and endpoint catalog reads:
  - `server:read`
- endpoint governance edit / probe / test execution:
  - `server:update`
- manual endpoint registration / publication profile change / publish / offline:
  - `server:manage`

### 3. Process operations

Route family:

- `/v1/servers/:id/process/*`

Primary permissions:

- `server:read`
- `server:manage`
- `monitoring:manage`

Recommended mapping:

- process info / process full info / process log history reads:
  - `server:read`
- process monitor start / stop / clear operations:
  - `monitoring:manage`
- destructive or control-like process actions:
  - `server:manage`

### 4. Observability and metrics

Route family:

- server-scoped metrics and stats
- MCP connection stats
- system logs
- monitoring summary endpoints

Primary permissions:

- `server:read`
- `system:view`
- `monitoring:read`
- `monitoring:manage`

Recommended mapping:

- server metrics summary:
  - `server:read`
- sensitive operational visibility such as system-wide logs or cross-server connection stats:
  - `system:view`
- monitoring configuration writes:
  - `monitoring:manage`
- if `monitoring:read` does not exist yet, Stage 2 may temporarily reuse:
  - `server:read`
  - plus `system:view` for broader scope

### 5. Permission and security administration

Route family:

- `/permissions`
- related security administration endpoints

Primary permissions:

- `permission:read`
- `permission:create`
- `permission:update`
- `permission:delete`
- `system:manage`

Recommended mapping:

- permission list / detail:
  - `permission:read`
- create / batch create:
  - `permission:create`
- update / toggle:
  - `permission:update`
- delete:
  - `permission:delete`
- system permission initialization:
  - `system:manage`

## Proposed Controller Mapping

Stage 2 should split the current oversized server management controller into:

- `ServersLifecycleController`
- `ServersProcessController`
- `ServersObservabilityController`

Suggested guard pattern:

- class level:
  - `@UseGuards(JwtAuthGuard, PermissionsGuard)`
- method level:
  - explicit `@RequirePermissions(...)`

Avoid broad class-level `@RequirePermissions(...)` on these controllers after the split.

## Audit Requirements

The following management actions must produce auditable operation events:

- server create
- server update
- server delete
- server start
- server stop
- server restart
- endpoint profile update
- endpoint probe
- endpoint publish
- endpoint offline
- monitor start
- monitor stop
- permission denied

These events should not depend on developer-oriented console logs to exist.

## Open Questions To Resolve During Implementation

1. Whether `monitoring:read` should be introduced explicitly or whether `server:read` plus `system:view` is enough for the current release line.
2. Whether `server:manage` should remain an override-style broad permission or be narrowed over time.
3. Whether MCP connection stats are part of server observability or system observability for permission purposes.
4. Whether batch lifecycle operations should require a stricter permission than single-resource execution.

## Exit Condition

This matrix is considered implemented only when:

1. controllers are split by route family
2. method-level permission declarations match this baseline or an explicitly updated version of it
3. permission semantics are documented
4. related tests and docs reflect the same route protection rules
