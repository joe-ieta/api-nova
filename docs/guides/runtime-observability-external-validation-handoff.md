---
doc-version: 2.1.0
doc-status: active
doc-updated: 2026-09-14
---
# Runtime observability external validation handoff

## Document status

Active, version 2.1.0, updated 2026-09-14. The current integration baseline is the lead agent's supplied remote `950e150` context, not a Git verification performed here. The [completion review](runtime-observability-completion-review.md) is the current summary; [execution status](runtime-observability-development-execution-status.md) is the evidence index.

Current reported status: 26/28 verified; API-27/API-28 (policies and Socket.IO) not implemented; TP11/TP12 done; AVAILABLE=0. Signed delivery, destination safety checks and manual replay already exist and are not reopened development tasks. OUTBOX and WEBHOOK automatic loops default off.

This round is static documentation/configuration checking only. The previous round's three passing builds and Parser 103, MCP 53, API 548 results are historical evidence, not new executions. No code, tests, configuration values or deployment were changed. Real-environment deployment and acceptance remain unperformed. The [archived remaining-work record](../archive/summaries/runtime-observability-2026-09-14/remaining-work-2026-09-14.md) is historical, not the active backlog.

## Baseline and evidence status

This handoff follows the retained remote implementation in the lead agent's supplied `950e150` integration context. It documents the current source, not a deployed environment. This documentation update did not build, run tests, enable workers, or send network requests.

Subscription CRUD, explicit test delivery, delivery queries, manual retry, durable outbox materialization, and the native webhook worker already exist and are registered by `CallObservabilityModule`. They are not APIs awaiting implementation from scratch. No additional module factory, injected sender, or external secret-backend adapter is required by this implementation.

**Real-environment deployment and external validation remain NOT PERFORMED.** Previous isolated or source test results do not establish receiver reachability, installed secrets, certificate validity, or deployment readiness.

## Deployment configuration, disabled by default

The following are the actual configuration names read by the retained implementation. This document does not change their values.

| Variable | Actual behavior |
| --- | --- |
| `API_NOVA_OBSERVABILITY_OUTBOX_ENABLED` | Schema default `false`. Only the exact string `true` starts automatic event-to-delivery materialization. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED` | Schema default `false`. Only the exact string `true` starts automatic network delivery. Independent of the outbox switch. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS` | Comma-separated exact, case-normalized URL `host` values, including non-default ports. Not origins, suffixes, wildcards, or full URLs. Empty configuration prevents subscription destination acceptance. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS` | Comma-separated, case-sensitive allowlist of reference identifiers accepted by subscription create/update. Empty configuration prevents reference acceptance. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS` | JSON object mapping reference identifiers to actual secret strings. Worker resolves the selected reference from this configuration for delivery; no Vault/backend injection contract is provided here. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP` | HTTP is rejected unless this is exactly `true`. Leave unset or `false`; use HTTPS for deployment. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS` | Comma-separated exact address exceptions to the worker's private-address rejection. Leave empty for public receivers. This is not an origin allowlist. |
| `API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS` | Default/fallback 10000 ms; accepted safe integers are 100 through 30000. This is not a fixed maximum of 10 seconds. |

Keep both automatic-worker switches disabled until a separate deployment approval. Also create preparation-stage subscriptions with `enabled: false`: the HTTP create default is **enabled**, independently of the two process switches.

Configure reference allowlists and secret values only on the deployment host or through the approved deployment secret-injection mechanism. API requests contain a reference identifier, never the key itself. Do not put real secrets in chat, committed examples, screenshots, command transcripts, or validation evidence. Environment injection is configuration delivery, not a newly implemented external secret backend.

References must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`. The worker accepts secret strings of 32 through 4096 UTF-8 bytes; its serialized secret map is bounded to 65536 bytes and 1000 keys. Values are used as strings, not automatically base64-decoded. Provision matching keys at the receiver through a separate secure channel. Subscription `secretConfigured: true` is not proof that a usable key was installed: subscription admission checks the reference allowlist, while the worker resolves the secret later.

## Receiver wire contract

The worker sends a POST with a canonical JSON body, bounded to 256 KiB. The envelope contains:

```text
schemaVersion = "1.0"
eventId, eventType, sequence, occurredAt, severity, status
subject = { id, version }
data, dimensions
delivery = { id, attemptNo, replayGeneration, subscriptionRevision }
```

`sequence` is a public decimal sequence string. The signature is computed over the exact UTF-8 body sent, not over a receiver's parsed and reserialized JSON:

```text
timestamp = Unix seconds, encoded as a decimal string
signature = lowercase_hex(HMAC_SHA256(secret, timestamp + "." + rawBody))
X-ApiNova-Signature: sha256=<signature>
```

Other emitted headers are `X-ApiNova-Timestamp`, `X-ApiNova-Event-Id`, `X-ApiNova-Delivery-Id`, `Content-Type: application/json`, byte-accurate `Content-Length`, and `User-Agent: ApiNova-Observability-Webhook/1.0`. The actual worker does not emit a signing-key-ID header; do not require one based on older proposals. Key selection and rotation must be coordinated with the receiver using the configured subscription/revision, not an assumed header.

The receiver should verify the raw body before processing, compare signatures in constant time, enforce its own timestamp acceptance window, and durably deduplicate authenticated delivery/event identities. Timestamp skew policy and business handling of deliberate replay are receiver policies, not additional sender configuration switches. A 2xx response acknowledges delivery; return it only after the receiver's required durable acceptance.

## Network and retry boundaries

- Destination validation rejects credentials, query strings, and fragments. HTTPS is the default policy; the explicit HTTP exception exists and should remain off.
- The worker checks all DNS results, rejects its configured private/reserved IPv4 and IPv6 ranges unless an exact private-IP exception applies, and unconditionally blocks the explicit metadata addresses `169.254.169.254` and `fd00:ec2::254`. Do not describe private-IP exceptions as harmless or claim a universally complete metadata denylist.
- Native HTTP/HTTPS connects to a selected resolved address, uses the original URL host in `Host`, and sets the original hostname as TLS SNI for hostname destinations. Native requests do not follow redirects. The retained code does not explicitly set `agent: false` or install a custom `checkServerIdentity`; do not carry over guarantees from removed transport drafts.
- DNS waiting is bounded and preparation time is subtracted before the socket timeout. The request uses `request.setTimeout`, which is a socket inactivity timeout, not an independent wall-clock timer covering all response activity. Do not certify a strict total deadline from the configuration name.
- The worker retains at most 2048 response bytes for a length/hash summary, not the raw response body. It continues receiving/discarding additional bytes; this memory bound is not a total response-download bound.
- 2xx succeeds. HTTP 408, 429, and 5xx are retryable; other HTTP statuses are terminal, including redirects. Retryable failures use base delays of 5 s, 30 s, 2 min, 10 min, and 30 min with deterministic 0.8 through 1.2 jitter. Retry-After supports seconds or an HTTP date and remains subject to the active retry window and expiry.
- Automatic attempts are bounded to six per replay generation and a 24-hour active retry window, also bounded by delivery/event validity. Attempts are not exactly-once delivery; a receiver must tolerate retries after uncertain outcomes.
- Nonzero `replayGeneration` is supported. Manual retry can start a new generation while retaining the cumulative attempt history. Revision revocation, subscription state, current owner authorization, and expiry still constrain sending.
- Outbox and delivery workers poll with a one-second delay after a cycle. Outbox event leases are 15 seconds; delivery leases are 30 seconds. PostgreSQL uses row locks with skip-locked claiming. These source mechanisms are not proof of deployment-level crash recovery or multi-worker acceptance.

## Controlled external validation checklist

All items below remain pending in a real deployment. Record sanitized identifiers, timestamps, statuses, and summaries only.

1. Record the deployed build, database mode, schema readiness, process topology, and receiver owner. Confirm both switches remain disabled during preparation.
2. Confirm the actual API base path and management authentication in the deployment. The current application's direct mount is `/api/monitoring/observability`; see the integration guide for the distinction from internal command path strings.
3. Provision an approved HTTPS host allowlist and local secret mapping without exposing keys. Verify certificates, DNS answers, egress policy, and receiver raw-body signature handling in the approved environment.
4. Create a paused subscription, verify the returned edit token, and exercise authorized/unauthorized reads and partial updates. Missing and stale edit tokens must not silently overwrite revisions.
5. With explicit deployment approval, enable the necessary workers and subscription. Queue one test through the existing HTTP API. A 202 response proves queueing, not remote receipt; correlate receiver evidence with delivery detail and attempts.
6. Exercise controlled 2xx, retryable errors, Retry-After, terminal HTTP errors, missing local secrets, and TLS/DNS failure cases against an owned test receiver. Observe bounds rather than inferring a strict total timeout.
7. Exercise a retained eligible manual retry and a nonzero replay generation; check idempotency, revision choice, cumulative attempts, and receiver deduplication.
8. Exercise pause/resume, deletion, authorization revocation, expiry, and controlled worker restart. Confirm pause is reported separately from delivery status and that a deleted subscription cannot be used for new sends.
9. Validate ordinary event materialization separately from explicit test delivery. The test endpoint creates its delivery directly and is not evidence that the outbox materializer is enabled or healthy.
10. Disable the workers after the approved exercise unless continued operation was authorized. Publish a sanitized acceptance report distinguishing passed, failed, and unexecuted cases.

## Source boundary

Source basis: `packages/api-nova-api/src/main.ts`, `src/config/validation.schema.ts`, and the call-observability module's subscriptions/deliveries controllers, DTOs and services, access guard, outbox service, and delivery worker. The module paths are relative to `packages/api-nova-api` where abbreviated.

Only this handoff and the subscription integration guide were revised. No production behavior or deployment configuration was changed. Public implementation availability does not close real-environment validation.
