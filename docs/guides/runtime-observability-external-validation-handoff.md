---
doc-version: 2.2.0
doc-status: active
doc-updated: 2026-09-15
---
# Runtime observability external validation handoff

## Document status

Active, version 2.2.0, updated 2026-09-15. OBS-16-01 calibrates this handoff against the maintained [completion review](runtime-observability-completion-review.md), [execution evidence register](runtime-observability-development-execution-status.md), and [latest recorded GC integration audit](../audits/2026-09-15-activation-gc-wave.md). This is a documentation-only subtask, not completion of TP16.

Current status: **DONE 10, IN_PROGRESS 5, BACKLOG 1; HTTP OBS-API-01~28 VERIFIED within their documented contracts; AVAILABLE=0.** OBS-API-27/28 are retention-policy read/update contracts for new events and payloads. Socket.IO is OBS-PUSH-01: bounded authorized event pages and the call-fact snapshot/UI bridge exist; complete global-state snapshots and the remaining consumers are unfinished. TP11/TP12 remain DONE within their agreed package scope. Do not rebuild their existing subscription, signed delivery, destination validation, outbox or manual-redelivery capabilities.

## Baseline and evidence status

The old `950e150` integration reference is historical, not the current acceptance build. Later source changes and scoped verification are recorded in execution-register sections 7-15 and their linked audits. This document does not certify a current checkout hash or deployment revision. Before running acceptance, record the exact commit, any uncommitted changes, built-artifact identity, Node/OS/database versions, process topology and test configuration. A historical remote commit cannot identify later local changes.

Recorded evidence includes the earlier Parser 103, MCP 53 and API 548 results, followed by separate scoped runs. The latest cited OBS run is the 60/60 payload/capacity/retention/pipeline group in the 2026-09-15 activation/GC audit. These overlapping groups must not be added together or represented as a fresh full-system run. Raw `tmp`/`.tmp` logs are local evidence paths, not guaranteed permanent release artifacts; archive them with the tested revision and environment when handing over a release. This document update ran no build, functional test, worker or network delivery.

Already implemented and locally verified slices include new delivery retention of 30 days independent of event eligibility; versioned policy reads/updates for new events and payloads; default-off bounded payload GC; scan-capacity samples and diagnostics; management heartbeat and local Gateway routing-registry observations. The last two do not prove business-server liveness. Capacity samples are pre-cleanup logical file lengths, not current total disk usage or quota enforcement. Full quota/lifecycle management, management-audit retention of 30 days and post-unlink database-rollback metadata reconciliation remain unfinished.

**Real-environment deployment acceptance remains NOT PERFORMED.** Current integrated Linux/PostgreSQL, multi-process and sustained-load/performance acceptance also remain unverified. TP02 has historical PostgreSQL storage evidence; do not describe PostgreSQL as never tested, or extrapolate that evidence to the current whole system. Isolated fixtures do not establish receiver reachability, installed secrets, certificates or deployment readiness.

## AC evidence map and remaining acceptance

The authoritative expected results are [AC-01~20 in the requirements](runtime-observability-requirements.md); ownership and package exits are in the [task plan](runtime-observability-development-task-plan.md). The table maps evidence entry points, **not twenty newly passed ACs**. Script names below are relative to [API scripts](../../packages/api-nova-api/scripts/), prefixed `test-call-observability-` and suffixed `.cjs` unless another name/path is given. Read each script's fixture, build and environment requirements before running it; some consume built `dist`, others load source. No script was rerun for this handoff.

| AC | Existing evidence or runnable entry point | Remaining acceptance / limitation |
| --- | --- | --- |
| 01, 03 | `test-gateway-call-observability.cjs`; execution register historical integration and later Gateway slices | Full integrated request-to-receiver chain, all rejection/identity paths and old-consumer removal remain TP15 work. MCP admission coverage also belongs to TP06. |
| 02, 04, 05 | [Server transport scripts](../../packages/api-nova-server/scripts/): `test-mcp-http-observability.cjs`, `test-mcp-http-delivery.cjs`, `test-mcp-transport-observability.cjs`, `test-mcp-stdio-observability.cjs`; [Parser audit tests](../../packages/api-nova-parser/src/audit/) | Complete retry/error/transport matrix remains TP06/16. Windows Node v24.15.0 16 MiB Streamable cork/uncork has a recorded 3-second noncompletion in both native and audited controls; passing the control test does not mean recovery succeeded. |
| 06, 07 | `source-identity`, `visitors`, `api-foundation`; TP03/08/09 evidence | Preserve trusted-subject, proxy-header and authorization boundaries when validating the complete chain. |
| 08 | `payloads`; Parser audit and Server transport suites | Complete content-type/large-body/long-stream/platform matrix remains; component results do not cover all combinations. |
| 09, 10 | `collector`, `worker`, `restart`, `source-lifecycle`, `bucket-projection-recovery` | Current integrated multi-process/crash-recovery matrix still required; do not equate injected rollback with process termination. |
| 11 | `statistics`, `series-groups`, `metrics`, `overview` | TP10 still needs complete historical dimensions and full metric acceptance with reproducible expected counts. |
| 12, 13 | `outbox`, `deliveries`, `webhook-worker`; TP11/12 recorded closure | Real controlled TLS receiver, response-loss, restart and multi-worker acceptance remain separate environment checks. |
| 14 | `realtime`, `events-overview-bridge`, `overview-snapshots`; recorded Socket.IO/UI slices | Global-state snapshots, other consumers and long-running/cross-platform recovery remain TP13 work. |
| 15, 16 | `policies`, `payloads`, `gc`, `payload-capacity`, `retention-worker`, `pipeline`, `events`; latest 60/60 scoped audit | Quota exhaustion/forced degradation, full metadata lifecycle and cross-component recovery remain TP14. Post-unlink metadata rollback residue is not repaired by scanner retry; reads still return expired. |
| 17 | `api-foundation`, `invocations`, `payloads`, `realtime`, subscription/delivery suites | Existing scoped permission/read-audit evidence must be preserved; full service-identity/rejection and consumer integration remain TP15. |
| 18 | `test-endpoint-dependency-observability.cjs`; TP07 evidence | Verify origin isolation in the final complete-chain run; do not reopen the completed producer integration. |
| 19 | `heartbeat`, `pipeline`, `overview`; routing/diagnostics wave in execution register | Management storage round trips and local routing registrations are not business heartbeats. True business liveness and live in-flight evidence remain TP10. |
| 20 | `postgres`; [storage foundation evidence](../reference/runtime-observability-storage-foundation.md); Server STDIO script | Historical database primitives do not close current Windows/Linux with SQLite/PostgreSQL, multi-process or STDIO whole-system acceptance. |

## Execution lanes and evidence to collect

| Lane | What can proceed | Current status and exit evidence |
| --- | --- | --- |
| Local preparation | Map each AC to cases, commands, expected results and existing logs; capture source/build identity; prepare synthetic datasets, failure injection and a results manifest. Review contract/Swagger/configuration consistency. | This handoff provides the mapping only. A complete manifest/runner and fresh full matrix have not been executed or certified here. |
| Local isolated execution | Run applicable Windows/source or built-fixture suites; prepare bounded restart, sustained-load and capacity/performance scenarios using isolated storage. Record duration, workload, body policy, latency, lag, memory and disk measurements. | Earlier scoped passes are in the evidence register. Current full-system sustained-load/performance acceptance is not recorded; missing scenarios may require harness implementation. No production deployment permission is needed merely to prepare or run isolated local fixtures. |
| Environment-dependent execution | Current integrated Linux/PostgreSQL, real multi-process recovery and an owned TLS test receiver. Supply an isolated database, runtime topology, receiver ownership and secure configuration injection. | Environment readiness has not been established by this document. Record each unavailable matrix cell as blocked/unrun with its concrete prerequisite; offline SQL generation and SQL.js are not substitutes. |
| Actual deployment acceptance | Enable automatic workers and subscriptions on the approved deployment, verify receipt and controlled failures, then follow the agreed shutdown/continued-operation decision. | NOT PERFORMED; requires the intended environment and deployment authorization. A queued 202 or local test pass does not establish AVAILABLE. |

For every new run record AC/case IDs, exact command, source and artifact identity, environment, fixture/workload, timestamp/duration, pass/fail/unrun result and sanitized raw-log location. Report unknown measurements as unknown. Keep environment blocks separate from unfinished implementation and from cases simply not yet run. Final TP16 exit still requires the completed integrated version and all mandatory evidence; OBS-16-01 does not change TP16 from BACKLOG.

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

Only this handoff was revised for OBS-16-01. No production behavior, test result or deployment configuration was changed. Limited-contract VERIFIED status does not close real-environment acceptance or imply AVAILABLE.
