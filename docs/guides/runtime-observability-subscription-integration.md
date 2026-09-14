---
doc-version: 2.1.0
doc-status: active
doc-updated: 2026-09-14
---
# Runtime observability subscription integration

## Document status

Active, version 2.1.0, updated 2026-09-14. The current integration baseline is the lead agent's supplied remote `950e150` context, not a Git verification performed here. The [completion review](runtime-observability-completion-review.md) is the current summary; [execution status](runtime-observability-development-execution-status.md) is the evidence index.

Current reported status: 26/28 verified; API-27/API-28 (policies and Socket.IO) not implemented; TP11/TP12 done; AVAILABLE=0. Signed delivery, destination safety checks and manual replay already exist and are not reopened development tasks. OUTBOX and WEBHOOK automatic loops default off.

This round is static documentation/configuration checking only. The previous round's three passing builds and Parser 103, MCP 53, API 548 results are historical evidence, not new executions. No code, tests, configuration values or deployment were changed. Real-environment deployment and acceptance remain unperformed. The [archived remaining-work record](../archive/summaries/runtime-observability-2026-09-14/remaining-work-2026-09-14.md) is historical, not the active backlog.

## Scope and availability

This guide describes the retained remote implementation in the lead agent's supplied `950e150` integration context. Public subscription and delivery controllers, their services, the outbox, and `CallObservabilityDeliveryWorker` are already registered in `CallObservabilityModule`. Integrators should use those APIs rather than add a module factory, duplicate sender, or custom secret-backend composition.

This is a source-aligned integration guide, not deployment evidence. Real-environment deployment and validation remain unperformed. No network requests, tests, or builds were run for this documentation update.

## Base path and authentication

Controller-relative base: `monitoring/observability`. Current `main.ts` applies the global prefix `api`, giving the direct application base:

```text
/api/monitoring/observability
```

The command services use `/api/v1/monitoring/observability/...` strings for command identity/idempotency. Those strings do not themselves register a versioned HTTP route. If a deployment gateway supplies another public prefix or rewrite, use that explicitly configured mapping; do not assume `/api/v1` is directly mounted by these controllers.

All endpoints below require the existing management Bearer token and `monitoring:subscription:manage`. Manual retry additionally requires `monitoring:delivery:retry`. The guard validates management-token issuer, audience, token use and expiry, reloads the current user, and derives current permissions and runtime-asset scope. Ordinary runtime credentials or caller-supplied authorization context are not substitutes.

Subscription access requires coverage of the complete stored scope. An all-assets scope requires all-assets authorization. Delivery query access follows the current subscription scope; do not document an extra owner-equality requirement or event-asset check that the query service does not perform. The sending worker separately reloads the subscription owner's current authorization before sending. Out-of-scope reads are hidden as not found.

## Public routes

Paths below are relative to the base above. Success responses use the observability `status`, `data`, and `meta` envelope, except DELETE's empty 204 response.

| Method and path | Input and result |
| --- | --- |
| `POST /subscriptions` | Create body; optional `Idempotency-Key`; 201, `data.editEtag`, and `X-Subscription-ETag`. No synchronous network send. |
| `GET /subscriptions` | Optional `state=enabled|paused`, `cursor`, `limit`; 200 paginated subscriptions. |
| `GET /subscriptions/:id` | 200 subscription and `X-Subscription-ETag`; no query parameters. |
| `PATCH /subscriptions/:id` | Partial body and required `If-Match`; 200 with the current edit token. |
| `DELETE /subscriptions/:id` | Required `If-Match`; 204. Soft-deletes, revokes revisions, and cancels unfinished jobs. |
| `POST /subscriptions/:id/test` | Empty object or optional `reason`; optional `Idempotency-Key`; 202 queued delivery. |
| `GET /deliveries` | Optional `subscriptionId`, `eventId`, `status`, `from`, `to`, `cursor`, `limit`; 200 page. |
| `GET /deliveries/:id` | Optional `attemptsCursor`, `attemptsLimit`; 200 delivery plus bounded attempts. |
| `POST /deliveries/:id/retry` | Required `Idempotency-Key`; required `reason`, optional `subscriptionRevision`; 202 queued generation. |

List limits and attempt limits default to 50, with range 1 through 200. Delivery statuses are `pending`, `in_flight`, `retry_wait`, `succeeded`, `dead`, and `cancelled`. Cursors are opaque, query/auth-bound tokens: follow returned cursors instead of inventing offsets or exposing an internal attempt-number cursor. List pages provide `items`, `nextCursor`, `hasMore`, and a scan count; a permission-filtered page can be short even when another cursor exists. Observe `meta.isPartial` rather than treating a page as complete history.

Use the returned edit token unchanged as `If-Match` for PATCH/DELETE. Missing tokens produce 428 and stale tokens 412; reload and reconcile rather than blindly overwriting. The token header is `X-Subscription-ETag`, not a promised standard `ETag` header. For cross-origin browser clients, deployment CORS must permit `If-Match`/`Idempotency-Key` and expose the subscription token header; current `main.ts` does not include those names in its configured CORS lists. Same-origin/server-side access does not require inventing another HTTP API.

## Create and partial update

Preparation example only; identifiers and destination are placeholders, not provisioned values:

```json
{
  "name": "staging receiver",
  "destination": {
    "type": "webhook",
    "url": "https://receiver.example/observability"
  },
  "secretRef": "staging.receiver.v1",
  "filter": {
    "runtimeAssetIds": ["approved-asset-id"],
    "eventTypes": ["invocation.completed"]
  },
  "enabled": false,
  "reason": "Prepare controlled validation"
}
```

Create requires `name`, `destination`, and `secretRef`. Name is at most 200 characters, URL 2048, reference 128, and optional reason 500. Unknown body fields are rejected; the body is bounded to 65536 UTF-8 bytes. `enabled` defaults to **true** when omitted, so explicitly use `false` during preparation. Public inputs do not include a caller-selected owner, scope object, or signing-key-ID field.

PATCH is a **partial update**, not complete replacement. Omitted top-level fields are preserved. Supplying `filter` replaces the filter object; supplying `destination` requires its complete `{type,url}` object. An empty patch or reason-only patch is invalid. For example, with the current `If-Match`, this pauses without resending destination or reference:

```json
{"enabled": false, "reason": "Pause controlled validation"}
```

A changed configuration creates a new effective revision atomically; an unchanged update reports `changed: false`. `effectiveFromSeq` and optional `pausedGapRange` describe sequence boundaries. Resuming is not an instruction to backfill all events from the paused interval. Pause is represented by subscription state and `suspendedBySubscription`, not by rewriting the stored delivery status to a nonexistent `paused` status.

Filter keys are `runtimeAssetIds`, `serverTypes`, `eventTypes`, `severities`, `spanKinds`, `outcomes`, `callerIds`, `endpointDefinitionIds`, and `toolNames`. Each supplied array must contain 1 through 100 unique nonempty values, with each text value bounded to 240 characters. Omit a key instead of passing an empty array.

| Filter | Accepted enum values |
| --- | --- |
| `serverTypes` | `gateway`, `mcp` |
| `eventTypes` | `invocation.completed`, `invocation.reconciled`, `caller.discovered`, `server.state_changed`, `server.snapshot`, `metrics.bucket_updated`, `pipeline.state_changed` |
| `severities` | `debug`, `info`, `warning`, `error`, `critical` |
| `spanKinds` | `gateway_request`, `mcp_protocol`, `mcp_tool`, `upstream_api` |
| `outcomes` | `success`, `error`, `rejected`, `timeout`, `cancelled`, `incomplete`, `unknown` |

Explicit asset filters must be within current authorization. Without an explicit asset filter, creation derives scope from current authorization. Updating without `filter` preserves the stored scope; supplying a replacement filter derives its scope again from current authorization.

## Test, retry, and readback

A subscription test inserts a `subscription.test` event and a pending delivery in the database; it does not synchronously contact the receiver. The event is already marked materialized, so this endpoint does not require the outbox loop to create that test job. Network delivery still requires an enabled subscription, an enabled/running worker, a usable local secret, and accepted destination and authorization checks. A paused subscription's job can remain suspended.

Manual retry accepts only eligible retained `dead` or `cancelled` deliveries. It requires a nonempty reason of at most 500 characters and an idempotency key. An optional revision is an integer from 1 through 2147483647. A cancelled delivery requires an explicit current revision and a live enabled subscription. The selected revision must exist and not be revoked; missing/expired source events cannot be replayed. An in-flight or succeeded delivery is not retryable through this endpoint.

Accepted retry keeps the delivery ID, increments `replayGeneration`, returns to `pending`, and retains cumulative attempt history. Nonzero replay generations are supported by the worker, not rejected as an unimplemented case. Reusing an idempotency key is a command replay, distinct from creating another delivery replay generation. Clients should retain the same key when retrying an uncertain command response and not reuse it for a different command body.

Delivery detail includes `deliveryId`, `eventId`, `subscriptionId`, `subscriptionRevision`, `version`, `status`, `attemptCount`, `replayGeneration`, `suspendedBySubscription`, `nextAttemptAt`, bounded `lastError`, and creation/update/expiry timestamps. Attempt entries include `attemptNo`, `startedAt`, `completedAt`, `durationMs`, `httpStatus`, `result`, `errorCategory`, and sanitized `responseSummary`. The public API therefore does expose a bounded summary field; it does not promise that the field is absent. The current worker produces a length/hash summary rather than raw receiver body text.

Attempt pagination is newest-first, bounded to the initial maximum attempt number, using `nextAttemptsCursor` and `hasMoreAttempts`. Delivery readback does not itself enforce an expiry cutoff; do not claim that expired records disappear immediately. Expiry is a send/retry eligibility boundary and retention cleanup is separate from read presentation.

Subscription responses expose `signingKeyId` as the configured reference, not secret bytes. `secretConfigured: true` and the current placeholder `health.state: not_started` are not live secret or network-health checks. Use actual delivery attempts and receiver evidence for acceptance.

## Runtime configuration and receiver coordination

Automatic outbox and webhook loops both default off: `API_NOVA_OBSERVABILITY_OUTBOX_ENABLED` and `API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED`. No deployment was enabled by this work. Ordinary committed events need outbox materialization before sending; explicit test delivery follows the direct queueing path described above.

Subscription admission reads `API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS` and `API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS`. Worker secret resolution reads `API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS`, a local JSON reference-to-secret-string map. Actual key material belongs only in local environment/deployment secret injection and the receiver's secure configuration, never API bodies, source control, chat, or acceptance evidence.

The actual worker signs `timestamp + "." + raw UTF-8 body` with HMAC-SHA256 and sends `X-ApiNova-Signature: sha256=<lowercase hex>`, `X-ApiNova-Timestamp`, `X-ApiNova-Event-Id`, and `X-ApiNova-Delivery-Id`. There is no emitted key-ID header. Coordinate key selection/rotation with the receiver; do not infer that changing a local secret value safely rotates immutable historical revisions.

Consult `runtime-observability-external-validation-handoff.md` in this directory for the complete actual variable table, network/timeout limitations, retry bounds, and pending deployment checklist. The remaining work is controlled real-environment acceptance of existing functionality, not rebuilding the remote public APIs from zero.
