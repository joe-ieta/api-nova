# Runtime observability: external validation handoff

## Current boundary

This handoff follows the existing TP12, TP15 and TP16 plan. It is not a deployment or acceptance record. Webhook signature, retry and destination/lease helpers do not constitute a configured sender. Subscription APIs and the actual sender must be integrated before performing live receiver acceptance. Do not enable dispatch expecting HTTP delivery: dispatch currently creates database delivery tasks only.

Local implementation can continue without external assistance. No production database, credentials or external receiver are needed for the current coding increment.

## 1. Receiver environment to prepare

Provide these non-secret details when live sender integration is ready:

- A dedicated staging HTTPS receiver URL with a publicly trusted TLS certificate and a stable DNS name.
- The exact allowed origin, including a non-default port if used. Do not use wildcard domains. Use a path without query parameters, URL credentials or fragments for the initial integration.
- Whether the receiver has public addresses or requires a private network. Private destinations must not be enabled by weakening address checks; report this requirement for a separately reviewed deployment policy.
- The signing key's public key ID and the authorized secret reference name, never the key bytes. Install the dedicated random signing secret in the agreed secret backend on each side. Do not reuse a business API key or put secrets in URLs, source files, tickets or chat.
- The person/environment authorized to receive synthetic test events, plus the approved test window and maximum request count.

Receiver behavior required by the existing contract:

- Verify HMAC-SHA256(secret, timestamp + "." + exact raw request bytes), with lowercase hexadecimal prefixed by sha256=. Read the timestamp and signature from X-ApiNova-Timestamp and X-ApiNova-Signature.
- Validate the event ID against X-ApiNova-Event-Id and persist deduplication by eventId before returning 2xx/202. A repeated event is expected after a lost response; do not repeat downstream work.
- Enforce an agreed timestamp window (the current reference suggests +/-300 seconds). Synchronize clocks. Never reserialize JSON before verifying its signature.
- Record only safe acceptance evidence: eventId, deliveryId, received time, response status and deduplication outcome. Do not record signing secrets or unrestricted payloads.
- Prepare controlled modes for 202, 429 plus Retry-After, 503, delayed response beyond 10 seconds, and connection termination. Do not apply these modes to a production endpoint.

When sender integration is complete, the agent will supply the exact supported subscription request and test invocation. Do not guess or call currently PLANNED routes.

## 2. PostgreSQL and Linux environment to prepare

Provide the PostgreSQL version, Linux distribution/version, Node version and a disposable database name. Provision a dedicated least-privilege database account through the deployment's secret mechanism, not this conversation. Explicitly confirm that schema initialization and cleanup are permitted for that disposable database only.

The eventual validation needs two application processes sharing the same database to exercise claims, stale leases and transaction serialization. Specify how both processes reach the producer audit directory and private payload directory; process-local directories must not be mistaken for shared evidence. Keep payload storage outside static web roots.

Do not point isolation fixtures at production, set DB_SYNCHRONIZE=true on an existing database, or delete audit/payload directories to reset a run. Exact launch and initialization commands must be derived from the configured environment and approved fixture before execution.

## 3. Acceptance evidence to collect after integration

- Lost receiver response can cause a repeat of the same eventId, but cannot create a second logical delivery or repeat receiver business work.
- Six total automatic attempts per generation, five backoffs (5s, 30s, 2min, 10min, 30min) with jitter, and no retry beyond the earlier of the activity window (24h) and retained delivery expiry.
- Permission revocation, subscription pause/deletion and revision revocation prevent unauthorized sends. A stale worker cannot finalize a successor's lease.
- Redirects are not followed; private/link-local destinations and DNS rebinding are rejected; TLS verifies the original hostname when connecting to a checked address.
- Database rollback leaves no successful task claim or attempt; process termination recovers leases without resetting the attempt budget.
- Save command versions, sanitized output, timestamps and failure/recovery evidence. Only mark VERIFIED after the relevant tests pass; deployment AVAILABLE requires separate environment evidence.
## Sender integration increment (2026-09-11)

`CallObservabilityWebhookSender.runOnce(limit)` now provides explicitly invoked orchestration: claim one durable lease at a time, check the immutable revision destination, validate all resolved addresses, resolve the authorized signing secret, recheck the current lease/authorization, sign a metadata-only event and send outside the database transaction. Completion returns through lease/version fencing. No startup worker or new environment switch enables this sender.

The trusted composition root must supply the exact allowed origins, a complete bounded DNS resolver and an authorized secret resolver. The internal immutable revision config currently requires string fields `destination`, `secretRef` and `signingKeyId`; the sender never falls back to the subscription's newer destination. These are internal integration requirements, not a declaration that subscription management HTTP endpoints have shipped.

`readForSend` is an internal service method, not a management response. Do not expose its raw event or secret reference. Preparation has a 10-second total deadline bounded by the lease; the sender passes only the remaining time to transport. The secret resolver returns an owned byte buffer, which is cleared after use, including late completion after timeout. No arbitrary database event details are serialized for sending.

Remaining work still includes subscription management and secret-backend composition, automatic worker lifecycle, manual replay generations, integrated live-receiver evidence and PostgreSQL/Linux acceptance. Nonzero replay generations are deliberately rejected by the current lease core. Deployment remains disabled until those integration requirements are met; unit tests with injected network capabilities are not proof of a deployed receiver.
## Opt-in worker composition increment (2026-09-11)

This section supersedes the earlier statement that no worker or environment switch exists. `CallObservabilityWebhookWorker` now provides explicit startup/shutdown lifecycle, one delivery per iteration and a one-second delay after completion. Its `getStatus()` reports disabled/blocked/running/stopped and the latest invocation failure without exposing secret material. Shutdown cancels future scheduling and waits for the active sender call; it does not forcibly terminate an arbitrary injected backend.

`API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED` accepts the strings true/false and defaults to false. It is independent from `API_NOVA_OBSERVABILITY_DISPATCH_ENABLED`: dispatch creates delivery tasks; webhook sending consumes them. Enabling dispatch alone does not cause network sends. Enabling the webhook flag without an injected sender leaves the worker blocked.

The trusted application composition root can replace its plain `CallObservabilityModule` import with `CallObservabilityModule.withWebhook(dependencies)`. Do not import both forms. Dependencies must supply a deployment origin allowlist, a complete bounded DNS resolver and an authorized secret resolver. The module snapshots the allowlist. Its optional transport injection is for trusted tests, never user input. No root application import or environment file has been changed to enable this composition.

Before enabling the worker, install and authorize the dedicated secret backend, confirm the staging receiver and allowlist, and validate the composed module. Never enable the flag merely to clear a blocked status. Subscription HTTP management and replay generations are still separate remaining work. This increment has not yet been built or tested; the preceding 67-test result applies only to the preceding implementation.