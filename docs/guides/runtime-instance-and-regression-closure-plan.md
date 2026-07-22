# Runtime Instance And Regression Closure Development Plan

> Document status: Active
> Last reviewed: 2026-07-22

## Status

Active implementation baseline, amended on 2026-07-22.

This document defines the approved clean-baseline development task. Existing database structures, historical data, and legacy tests are not compatibility constraints; development and verification start from a newly initialized schema.

Implementation progress on 2026-07-22:

- completed runtime instance, endpoint test evidence, and runtime upstream binding backend foundations
- completed automatic distinct sample capture for successful endpoint tests
- completed clean SQLite initialization and verification tooling
- completed physical removal of runtime coordinates from `source_service_assets`
- completed instance-aware endpoint probe/test, Gateway snapshot, MCP assembly, publication routing, and Runtime Assets assembly
- completed Gateway `servicePrefix` creation contract and initial frontend support
- completed the first operator-facing runtime instance management dialog and API client integration
- completed the first operator-facing automatic sample library and maintenance workflow
- completed the operator-facing upstream-binding workflow with environment, strategy, candidate ordering, optimistic revision protection, and live resolution evidence
- completed the WP-70 verification planning and evidence persistence baseline, including deterministic candidate revisions and blocking precondition results
- completed Gateway candidate snapshot isolation, full-pipeline replay, atomic in-memory activation/rollback, and deploy/redeploy/start verification gates
- completed persisted Gateway behavior fingerprints: ordinary configuration events cannot replace public routes, and restart recovery rejects stale or unverified database state
- completed canonical clean-baseline migrations and empty-schema verification for SQLite and PostgreSQL
- completed MCP in-memory candidate tool replay and pre-persistence deploy/start verification gates; replay failure leaves the managed server unchanged
- completed atomic MCP server/runtime-asset/verification persistence, assembled-behavior fingerprinting, and quarantine of legacy direct start/restart controls
- completed durable immutable Gateway revision snapshots and restart restoration guarded by active revision plus behavior fingerprint
- completed response assertion gates for Gateway and MCP candidate replay, with status-only, schema, and exact modes plus ignored dynamic paths
- completed environment-backed per-instance credential references for Gateway and MCP runtime execution and candidate replay; no resolved secret is persisted
- completed operator-facing verification run drill-down with blockers, activation decisions, sample results, response assertions, and sanitized evidence
- completed repeatable isolated PostgreSQL baseline execution for the 38-table domain model, including the persisted Gateway snapshot table and automatic temporary-database cleanup
- completed authorized no-smoke waiver recording with operator identity, reason, environment, candidate identity, passed waiver evidence, and an explicit Runtime Asset UI action
- completed the automated WP-90 runtime-closure gate: removed-route scan, Parser build/tests, API build, UI type check, 13 core API suites, and isolated SQLite/PostgreSQL migration verification
- completed the Windows root production build for Parser, Server, API, and UI, plus the MCP Server streamable multi-session smoke
- in progress: manual real-upstream acceptance scenarios, Windows API/UI startup and basic import validation, and the complete Ubuntu release path

Drift review on 2026-07-22 found no architecture-level reversal: successful samples remain automatic, runtime coordinates remain instance-owned, and Runtime Asset managed MCP servers cannot bypass verification through legacy start/restart actions. The review did identify productization gaps in MCP endpoint configuration, eager verification-required state after upstream changes, instance-aware readiness staleness, sample retention/size controls, and mutation audit coverage. These are tracked as `DEV-01` through `DEV-05` in `docs/reference/open-items.md`. Manual real-upstream acceptance, the remaining Windows interactive startup/import checks, and the complete Ubuntu release path remain explicit release blockers.

## Purpose

Close the ApiNova product loop across:

1. OpenAPI batch registration and manual API registration
2. dynamic association between logical API assets and currently deployed upstream instances
3. endpoint testing against an explicitly selected runtime instance
4. durable request and response sample management
5. publication-time upstream selection
6. deployment-time automatic smoke and regression verification
7. accurate consumer-facing service addresses, runtime status, audit, and rollback

The target operator lifecycle remains:

1. `API Registration`
2. `API Testing`
3. `API Governance`
4. `API Publication`
5. `Runtime Assets / Monitoring`

The new work strengthens the contracts between these stages. It must not restore registration-time quick publish behavior.

## 1. Current Problems To Solve

### 1.1 Imported addresses are not durable runtime truth

Today, `source_service_asset` stores `scheme + host + port + normalizedBasePath` and those fields are used both as:

- the logical identity of an imported source
- the live address used for probe, test, and Gateway forwarding

That assumption does not hold after the imported host is retired, a service moves to another port, or the same logical service exists in development, test, staging, and production.

OpenAPI file import also falls back to `unknown-host` when no absolute server URL is available. Such an asset can enter the catalog but cannot become a reliable runtime target.

### 1.2 Testing only stores latest status metadata

Endpoint testing currently writes the latest result into `endpoint_definition.metadata`, including fields such as:

- `testStatus`
- `lastTestAt`
- `lastTestUrl`
- `lastTestHttpStatus`
- `lastTestDurationMs`
- `lastTestError`

It does not provide an endpoint-centric library of:

- reusable request payloads
- captured successful responses
- assertions
- test execution history
- deployment regression suites

The existing `test_cases` table is server/tool-oriented and belongs to the older MCP server model. It must not become the canonical endpoint testing model.

### 1.3 Publication does not freeze or select upstream runtime intent

A publication membership identifies an endpoint and a runtime asset, but it does not carry a first-class upstream instance selection contract.

Gateway runtime currently rebuilds the upstream URL directly from `source_service_asset`. This makes a catalog address change silently affect all published services and prevents safe per-environment rollout.

### 1.4 The published service contract is incomplete

Gateway runtime assets are logical groups over one shared embedded Gateway data plane, but currently lack a runtime-asset-level service prefix. Consumer access URLs are also incomplete because Gateway has no managed-server endpoint equivalent.

MCP deployment supports a port in the backend contract, but the publication/runtime UI does not expose port, transport, or endpoint-path configuration.

### 1.5 Deployment is not verified with durable samples

Publication, deployment, start, and route activation do not yet form a verified release transaction. A deployment can be reported as complete without replaying known successful API behavior against the published service.

## 2. Product Outcome

The delivery is complete only when an operator can perform this flow:

1. register APIs through OpenAPI or manual entry
2. see a logical source asset independently from its deployed hosts
3. add one or more runtime instances for that source asset
4. label instances by environment and health state
5. select an instance when probing or testing an endpoint
6. execute a test and retain its sanitized request and response
7. automatically retain every successful observation as a maintainable sample
8. govern the endpoint using results from a valid instance
9. add the endpoint to an MCP or Gateway runtime asset
10. bind the publication membership to an upstream environment and instance policy
11. configure the public service prefix or MCP deployment endpoint
12. deploy a candidate runtime revision
13. automatically replay enabled smoke/regression cases
14. activate the candidate only after required verification passes
15. expose an accurate, copyable service URL
16. inspect deployment, instance, test-run, sample, and rollback evidence from Runtime Assets and Monitoring

## 3. Mandatory Architecture Boundaries

### 3.1 Logical asset and runtime instance must be separate

`source_service_asset` remains the logical catalog grouping and import provenance record.

It no longer owns live upstream coordinates. Scheme, host, port, and base path belong exclusively to runtime instances, and every live execution resolves through an explicit instance.

### 3.2 Registration still creates catalog assets only

OpenAPI and manual registration may create a provisional runtime instance when a valid absolute address is supplied, but they must not create runtime assets or publish services.

### 3.3 Instance changes must be explicit and audited

Changing a production target must require an explicit operator action, create a revision/audit event, refresh affected runtime configuration, and trigger verification. Editing a catalog record must not silently retarget a published service.

### 3.4 Tests and samples are endpoint-first

The canonical testing identity is `endpoint_definition`.

Runtime asset, membership, source instance, and deployment revision are execution dimensions, not replacements for endpoint identity.

### 3.5 Secrets must not be persisted in samples

Authorization headers, cookies, API keys, passwords, tokens, and configured sensitive JSON fields must be redacted before persistence. Runtime credentials are referenced through a secret/config reference and resolved only during execution.

The implemented reference contract is `env-headers:Header=ENV_NAME`, with semicolons separating multiple mappings. Example: `env-headers:Authorization=ORDER_API_TOKEN;X-Api-Key=ORDER_API_KEY`. Only this mapping is stored on the source-service instance and in assembled behavior; the environment values are resolved for each request. Transport-owned headers, missing variables, unsafe values, and malformed references are rejected. Gateway proxy calls and MCP operations consume the same per-instance reference.

### 3.6 Gateway remains embedded by default

The recommended baseline keeps one `api-nova-api` process and one shared Gateway listen port. A Gateway runtime asset receives a service prefix, not its own socket.

Per-Gateway-service ports require a separate data-plane process model and are outside the recommended first delivery.

### 3.7 Database development uses a clean baseline

The implementation may replace existing tables, entities, and migrations instead of preserving historical layouts or data. SQLite and PostgreSQL verification must create the new schema from an empty database. No legacy backfill, rollback-to-old-schema, or old-test compatibility layer is required.

## 4. Proposed Domain Model

### 4.1 Rebuilt `source_service_assets`

Rebuild the table as the logical source and provenance owner. Its canonical fields are logical identity, display name, description, ownership, tags, import provenance, metadata, and timestamps.

Remove scheme, host, port, and normalized base path from this table. New OpenAPI or manual imports with a usable absolute server URL create an initial runtime instance in the same transaction; unusable or absent URLs leave the asset explicitly unbound.

### 4.2 New `source_service_instances`

One row represents one deployed instance of a logical source service.

Recommended fields:

- `id`
- `sourceServiceAssetId`
- `name`
- `environment`
- `scheme`
- `host`
- `port`
- `basePath`
- `enabled`
- `status`: `draft | healthy | unhealthy | offline`
- `priority`
- `weight`
- `isDefault`
- `credentialRef`
- `tlsPolicyRef`
- `metadata`
- `lastProbeStatus`
- `lastProbeAt`
- `lastProbeLatencyMs`
- `lastError`
- `createdAt`
- `updatedAt`

Recommended constraints:

- unique `(sourceServiceAssetId, environment, name)`
- only one default instance per source service and environment, enforced in service logic for SQLite/PostgreSQL parity
- port range validation
- HTTP/HTTPS scheme validation

Initial environments:

- `development`
- `test`
- `staging`
- `production`

The database field should remain an extensible normalized string so installations can add environment names without a schema migration.

### 4.3 New `runtime_upstream_bindings`

One row defines how one published runtime membership resolves its upstream.

Recommended fields:

- `id`
- `runtimeAssetEndpointBindingId`
- `sourceServiceAssetId`
- `environment`
- `selectionMode`: `fixed | healthy_priority`
- `primaryInstanceId`
- `status`: `draft | verified | active | blocked`
- `revision`
- `lastVerifiedAt`
- `lastVerificationRunId`
- `createdAt`
- `updatedAt`

Recommended constraint:

- unique `runtimeAssetEndpointBindingId`

### 4.4 New `runtime_upstream_binding_instances`

This table supplies ordered candidates for `healthy_priority` selection and avoids storing foreign keys inside JSON.

Recommended fields:

- `id`
- `runtimeUpstreamBindingId`
- `sourceServiceInstanceId`
- `priority`
- `weight`
- `enabled`

The first release should implement:

- fixed primary selection
- ordered healthy failover

Round-robin and load balancing are deferred until health, concurrency, and distributed-state semantics are defined.

### 4.5 New `endpoint_test_cases`

A durable, editable endpoint-centric test definition.

Recommended fields:

- `id`
- `endpointDefinitionId`
- `name`
- `description`
- `enabled`
- `suite`: `smoke | regression`
- `priority`
- `source`: `manual | captured | imported | generated`
- `requestTemplate`
- `assertions`
- `timeoutMs`
- `retryPolicy`
- `tags`
- `version`
- `createdBy`
- `updatedBy`
- `createdAt`
- `updatedAt`

`requestTemplate` must support:

- path parameters
- query parameters
- allowlisted headers
- content type
- JSON, form, text, or binary-reference body
- credential reference placeholders without resolved secret values

Assertions must initially support:

- HTTP status/status range
- JSON path equals/contains/exists
- response header equals/contains
- JSON schema validation where a response schema exists
- maximum duration

### 4.6 New `endpoint_test_runs`

An immutable execution record.

Recommended fields:

- `id`
- `endpointTestCaseId`
- `endpointDefinitionId`
- `sourceServiceInstanceId`
- `runtimeAssetId`
- `runtimeAssetEndpointBindingId`
- `runtimeVerificationRunId`
- `targetType`: `source_instance | gateway_route | mcp_tool`
- `trigger`: `manual | governance | pre_publish | post_deploy | scheduled`
- `status`: `pending | running | passed | failed | skipped | error`
- `requestSnapshot`
- `responseSnapshot`
- `assertionResults`
- `httpStatus`
- `durationMs`
- `errorMessage`
- `correlationId`
- `startedAt`
- `finishedAt`
- `createdAt`

### 4.7 New `endpoint_test_samples`

A managed successful request/response example derived from a test run.

Recommended fields:

- `id`
- `endpointDefinitionId`
- `endpointTestCaseId`
- `sourceTestRunId`
- `name`
- `requestSample`
- `responseSample`
- `fingerprint`
- `mediaType`
- `status`: `active | archived`
- `label`
- `tags`
- `regressionEnabled`
- `observedAt`
- `createdAt`
- `updatedAt`

Capture policy:

1. every successful execution persists an immutable test run
2. every successful execution automatically creates a distinct sanitized sample without operator confirmation
3. equivalent fingerprints remain separate records; fingerprints are used only for grouping, search, and later maintenance
4. regression eligibility is applied automatically by policy and can later be enabled, disabled, labeled, tagged, or archived through sample maintenance
5. no candidate-to-baseline promotion step exists in the capture path

### 4.8 New `runtime_verification_runs`

A deployment-level verification aggregate.

Recommended fields:

- `id`
- `runtimeAssetId`
- `deploymentRevision`
- `trigger`: `deploy | redeploy | instance_switch | manual`
- `status`: `pending | running | passed | failed | partial | rolled_back`
- `requiredCaseCount`
- `passedCount`
- `failedCount`
- `skippedCount`
- `previousRevision`
- `candidateRevision`
- `rollbackStatus`
- `startedBy`
- `startedAt`
- `finishedAt`
- `summary`
- `createdAt`

## 5. Runtime Instance Resolution

### 5.1 Registration behavior

OpenAPI batch registration:

- always creates/updates the logical source asset and endpoints
- creates a provisional instance only when an absolute valid server/original URL exists
- marks the instance environment from operator input, defaulting to `development`
- marks unresolved imports as `instance_required`
- blocks probe/test readiness until an instance is assigned

Manual registration:

- creates the logical source asset and endpoint
- creates one provisional/default instance from the supplied Base URL
- lets the operator choose environment during registration

### 5.2 Instance management behavior

Operators must be able to:

- list instances under one source service
- create, edit, enable, disable, and archive instances
- probe one instance
- compare health and last verification time
- set the default instance for an environment
- clone an instance into another environment
- see which endpoints, publication memberships, and runtime assets use it

Deletion must be blocked while an instance is referenced by an active upstream binding. Archive/offline is preferred over destructive deletion.

### 5.3 Test target resolution

API Testing must require an explicit target context:

- environment
- selected instance or environment default
- credential reference if required

The selected instance ID must be stored in the run. The resolved URL alone is insufficient for audit and later replay.

### 5.4 Publication target resolution

Each publication membership must show and persist:

- source service
- environment
- selected primary instance
- optional failover instances
- selection mode
- latest instance health
- latest successful regression evidence

Changing this binding creates a new binding revision and triggers runtime verification. It must not require re-importing the OpenAPI document.

### 5.5 Gateway hot-path behavior

Gateway route snapshots must contain already-resolved candidate instances. The request hot path must not query the database.

Snapshot refresh is triggered by:

- upstream binding activation
- instance enable/disable or health transition
- successful deployment verification
- rollback

The selected instance ID and target URL must be written into access logs and runtime observability dimensions.

## 6. Test Sample And Regression Behavior

### 6.1 Successful manual test

After a successful endpoint test:

1. persist an immutable test run
2. sanitize request and response
3. calculate a stable fingerprint
4. automatically create a distinct active sample for every successful run
5. update endpoint latest-test metadata as a projection only
6. apply the configured regression eligibility policy and expose later sample maintenance

Latest metadata remains useful for list performance, but the durable run is the source of truth.

### 6.2 Sample storage limits

Recommended defaults:

- JSON/text request preview: 256 KiB
- JSON/text response preview: 1 MiB
- binary content: size, media type, and hash only unless an external artifact store is configured
- Authorization, Cookie, Set-Cookie, API key, and configured sensitive fields: always redacted
- oversized content: store metadata, hash, truncation marker, and optional artifact reference

Retention must be configurable by run trigger and status. Failed deployment evidence should use a longer retention class than routine manual runs.

### 6.3 Regression selection

Deployment verification selects:

- all enabled `smoke` cases for active memberships
- enabled `regression` cases according to the runtime asset verification policy

Recommended first-release policy:

- smoke cases are required and blocking
- full regression is selectable as blocking or non-blocking per runtime asset
- absence of a smoke case blocks first production activation unless an authorized operator records a waiver with reason

### 6.4 Target-specific replay

Gateway:

- replay through the candidate published Gateway route, not directly against the source instance
- assert public path rewrite, auth policy, proxy behavior, and upstream response

MCP:

- replay by invoking the generated MCP tool through the candidate MCP endpoint
- validate tool result and error contract

Direct source-instance tests remain governance evidence but do not replace post-deployment verification.

## 7. Deployment And Activation Contract

### 7.1 Required state flow

The runtime lifecycle must distinguish configuration from verified activation:

```text
draft
  -> deployed_candidate
  -> verifying
  -> active
  -> degraded
  -> offline
```

The exact persistence representation may extend the runtime status enum or use a separate deployment/verification state, but UI and APIs must expose the distinction.

### 7.2 First activation

For a runtime asset with no active revision:

1. assemble candidate revision
2. resolve and validate all upstream bindings
3. make the candidate available to the internal verification runner
4. execute required smoke/regression cases
5. activate public routing only after required cases pass
6. otherwise keep the runtime inactive and return verification evidence

### 7.3 Redeploy or instance switch

For an already active runtime asset:

1. retain the previous active revision
2. build a candidate revision
3. verify the candidate
4. atomically switch the active snapshot on success
5. retain the previous revision during the rollback window
6. on verification failure, keep or restore the previous active revision
7. mark `degraded` only when rollback cannot preserve the last known-good service

### 7.4 Verification result contract

Deploy/redeploy APIs must return:

- runtime asset ID
- deployment/candidate revision
- selected upstream binding revisions
- verification run ID
- test totals and failures
- activation status
- rollback status
- accurate consumer access URLs
- recommended next action

## 8. Published Service Contract Closure

### 8.1 Gateway service prefix

Add runtime-asset-level Gateway fields, preferably as explicit columns or a validated typed deployment configuration:

- `servicePrefix`
- optional `publicBaseUrlRef`
- optional default environment
- verification policy

Recommended external contract:

```text
{gatewayPublicBaseUrl}/api/v1/gateway/{servicePrefix}/{memberRoutePath}
```

Rules:

- `servicePrefix` is required and unique within one Gateway data-plane namespace
- member route paths are relative to the service prefix in the UI
- effective paths are computed and conflict-checked by the backend
- access URL generation always includes the actual global prefix and Gateway controller prefix

### 8.2 Gateway port policy

In the embedded baseline:

- Gateway listen port is deployment-level/global
- an individual `gateway_service` cannot request another port
- service isolation is provided by prefix and optionally host matching

If per-service ports are required, approve a separate future architecture for independently managed Gateway data-plane processes.

### 8.3 MCP deployment configuration

Expose the existing backend deployment capabilities in the runtime/publication UI:

- port
- transport
- endpoint path
- auto-start
- conflict validation
- final endpoint preview

The endpoint path must become an explicit validated deployment field instead of relying only on `/mcp` or `/sse` defaults.

## 9. Management UI Scope

### 9.1 API Registration

Add an instance step or post-registration action:

- environment
- instance name
- scheme/host/port/base path
- credential reference
- probe now

For imports without a usable server URL, show `Runtime instance required` instead of silently displaying `unknown-host` as a valid target.

### 9.2 API Testing

Add an endpoint testing workbench with:

- target environment and instance selector
- request payload editor
- response viewer
- assertions
- saved test cases
- sample library
- run history
- compare current response with selected historical samples
- edit sample label/tags/regression eligibility, archive, or delete a sample

### 9.3 API Governance

Readiness must display:

- selected/last-tested instance
- instance health
- test case and eligible sample availability
- latest successful test run
- stale evidence warning when instance binding or endpoint contract changed

Readiness must become false when its qualifying evidence refers to an archived/different instance or an obsolete endpoint revision.

### 9.4 API Publication

Add to each membership configuration:

- target environment
- upstream selection mode
- primary and failover instances
- latest verification evidence
- effective Gateway path or MCP endpoint preview

Add to Gateway runtime asset creation:

- service prefix
- public base URL/deployment target reference
- verification policy

### 9.5 Runtime Assets And Monitoring

Display:

- active and candidate revisions
- selected upstream instances
- effective consumer URLs
- last deployment verification
- sample/case counts
- failed case drill-down
- rollback state
- instance health and failover events

## 10. API Surface Plan

Recommended resource families:

```text
GET    /api/v1/assets/source-services/:id/instances
POST   /api/v1/assets/source-services/:id/instances
GET    /api/v1/assets/source-services/:id/instances/:instanceId
PATCH  /api/v1/assets/source-services/:id/instances/:instanceId
POST   /api/v1/assets/source-services/:id/instances/:instanceId/probe
POST   /api/v1/assets/source-services/:id/instances/:instanceId/set-default
POST   /api/v1/assets/source-services/:id/instances/:instanceId/archive

GET    /api/v1/assets/endpoints/:id/test-cases
POST   /api/v1/assets/endpoints/:id/test-cases
PATCH  /api/v1/assets/endpoints/:id/test-cases/:caseId
POST   /api/v1/assets/endpoints/:id/test-cases/:caseId/run
GET    /api/v1/assets/endpoints/:id/test-runs
GET    /api/v1/assets/endpoints/:id/test-samples
PATCH  /api/v1/assets/endpoints/:id/test-samples/:sampleId
POST   /api/v1/assets/endpoints/:id/test-samples/:sampleId/archive
DELETE /api/v1/assets/endpoints/:id/test-samples/:sampleId

PUT    /api/v1/publication/endpoints/runtime-memberships/:membershipId/upstream-binding
GET    /api/v1/publication/endpoints/runtime-memberships/:membershipId/upstream-binding

POST   /api/v1/runtime-assets/:id/verify
GET    /api/v1/runtime-assets/:id/verification-runs
GET    /api/v1/runtime-assets/:id/verification-runs/:runId
```

Existing endpoint test callers and UI migrate in the same release. The clean baseline does not retain an old API or persistence compatibility path.

## 11. Delivery Work Packages

### WP-00: Contract Freeze And Clean Database Baseline

Implementation status on 2026-07-21:

- canonical SQLite and PostgreSQL migrations were generated from the same 38-table entity model
- migration discovery is restricted to compiled `Canonical` migrations under the actual `dist/src/database/migrations` output path
- clean `migration:run` succeeded against both engines, followed by zero-drift `schema:log` checks
- the isolated PostgreSQL verifier confirmed 38 domain tables, zero domain rows, all nine new core tables including `gateway_route_snapshots`, no legacy source host/port columns, a native UUID instance foreign key, zero pending migrations, and automatic temporary-database cleanup
- historical incremental migrations remain source-only reference material and are excluded from migration discovery

Scope:

- confirm the decisions in section 14
- define the new canonical SQLite and PostgreSQL schema from an empty database
- replace obsolete tables and migration assumptions; no historical data recovery or conversion is required
- define repeatable clean initialization and developer reset procedures
- freeze names, enums, URL contracts, and redaction defaults

Exit criteria:

- approved architecture decision record
- both database engines initialize the same canonical schema from empty state
- clean reset and seed procedure is documented and verified

### WP-10: Runtime Instance Schema And Clean Initialization

Scope:

- add source service instance entities
- add runtime upstream binding entities
- rebuild source service assets without embedded runtime coordinates
- create an initial instance only for newly imported usable server URLs
- add clean SQLite and PostgreSQL initialization migrations and schema tests

Exit criteria:

- an empty database initializes without legacy tables or compatibility columns
- source assets and runtime locations have separate enforced ownership
- repeated clean initialization is deterministic in development and test environments

### WP-20: Runtime Instance Backend

Scope:

- CRUD, archive, probe, default selection, reference checks
- credential reference integration
- health projection and audit events
- instance resolution service
- snapshot refresh events

Exit criteria:

- tests and runtime code resolve by instance ID
- no new path treats imported host/port as unconditional live truth

### WP-30: Runtime Instance Management UI

Scope:

- source service instance list/detail/editor
- registration integration
- environment and target selection in API Testing
- unresolved-import repair flow
- usage/reference view

Exit criteria:

- an operator can move an API from an offline imported host to a new instance without re-importing the API contract

### WP-40: Endpoint Test Case, Run, And Sample Model

Scope:

- add endpoint-centric entities, migrations, services, and APIs
- sanitize and persist request/response snapshots
- automatically save one distinct sample for every successful execution
- use fingerprints for grouping only; do not deduplicate successful observations
- remove the legacy server/tool `test_cases` model from the new schema and runtime

Exit criteria:

- every successful endpoint test produces durable, sanitized evidence
- cases, runs, and samples are independently queryable
- no save path requires sample confirmation or promotion

### WP-50: Testing And Governance Closure

Scope:

- testing workbench UI
- baseline comparison and assertion reporting
- instance-aware readiness
- evidence staleness rules
- governance drill-down into runs and samples

Exit criteria:

- readiness proves which endpoint revision was tested against which runtime instance

### WP-60: Publication Upstream Binding And Service Contract

Implementation status on 2026-07-22:

- implemented membership-level upstream binding management, environment selection, optimistic revisions, deterministic resolution, and operator UI
- implemented required normalized Gateway `servicePrefix` and prefix-scoped effective routes on the shared Gateway listen port
- remaining: governed MCP port/transport controls, an explicit validated MCP endpoint-path contract, and accurate pre-activation MCP consumer endpoint preview (`DEV-01`)
- remaining: eager operator-visible verification-required state after an upstream binding change (`DEV-02`)
- WP-60 is partially complete and must not be treated as closed while these deviations remain

Scope:

- membership-level upstream binding configuration
- Gateway service prefix and effective-path calculation
- accurate Gateway access URLs
- MCP port/transport/endpoint-path UI
- conflict validation and typed deployment previews

Exit criteria:

- every publishable membership has an explicit upstream target contract
- every runtime asset exposes an accurate consumer endpoint before activation

### WP-70: Deployment Verification And Rollback

Implementation status on 2026-07-22:

- implemented `runtime_verification_runs` and `runtime_verification_results` as clean-baseline entities
- implemented deterministic candidate revision planning from runtime asset configuration, membership revisions, upstream binding revisions, and selected samples
- implemented blocking plans for missing active upstream bindings, unresolved healthy candidates, missing enabled memberships, and missing enabled active `smoke` samples
- implemented read APIs for verification-run evidence and targeted planner tests
- implemented isolated Gateway candidate snapshots and replay through authorization, traffic control, retry, proxy, metrics, and logging while bypassing response cache
- implemented atomic Gateway activation with in-memory last-known-good rollback; failed replay retains the prior public snapshot
- gated Gateway deploy, redeploy, and start so none can directly mark an unverified candidate active
- persisted a Gateway behavior fingerprint with the activated revision; ordinary publication/configuration refresh events cannot replace public routes, and process restart refuses stale persisted state
- implemented sanitized replay evidence, conditional run claiming, activation metadata, and targeted pass/fail tests
- implemented MCP candidate replay through the generated tool handlers before any managed-server persistence; failed replay cannot overwrite the prior server record
- gated MCP deploy, redeploy, and Runtime Asset start through the verification plan and candidate replay
- implemented one database transaction for MCP server persistence, Runtime Asset metadata, and verification activation; transaction failure rolls all three writes back
- included the canonical assembled MCP OpenAPI behavior fingerprint in candidate identity and persisted activation evidence
- quarantined direct start/restart through the legacy Servers control plane for Runtime Asset managed MCP servers
- implemented immutable persisted Gateway revision snapshots; restart restores only the fingerprint-valid snapshot referenced by Runtime Asset `activeRevision`, while failed or partial candidates leave prior revisions recoverable
- implemented reusable response assertions for Gateway and MCP replay: saved response payloads default to schema validation, while samples may select exact or status-only comparison and ignore explicit dynamic paths
- persisted sanitized assertion evidence and fail candidate activation when the status code matches but the response assertion does not
- implemented per-instance `env-headers:` credential references across Gateway proxying, MCP operation handlers, and candidate replay without persisting resolved secrets
- included the resolved source-service instance identity and credential-reference fingerprint in candidate identity, so failover or credential changes require fresh verification
- implemented operator-facing verification drill-down from Runtime Asset detail, including blockers, activation status, per-case HTTP results, response assertions, errors, and sanitized evidence
- implemented and executed isolated PostgreSQL migration verification for all 38 domain tables, with zero rows, no pending migrations, and cleanup of the dedicated temporary database
- implemented authorized no-smoke waiver recording: the permission-guarded operator supplies a reason, the actor/environment/reason are persisted as a passed `waiver` result, and the waiver participates in candidate identity
- added an explicit warning UI for waiver deployment; ordinary no-case deployment remains blocked
- WP-70 implementation is complete; WP-90 end-to-end release scenarios remain

For Gateway assets, a `planned` run is executable and deployment success is reported only after replay and atomic route activation. For MCP assets, the candidate tool handlers are replayed before persistence, and activation is finalized with the managed server and Runtime Asset metadata in one database transaction.

Scope:

- runtime verification runs
- candidate revision assembly
- smoke/regression orchestration
- Gateway candidate snapshot and atomic activation
- MCP candidate verification and rollback behavior
- deployment result contract

Exit criteria:

- failed required verification cannot silently become an active first deployment
- an update retains/restores the last known-good revision when possible

### WP-80: Runtime And Monitoring Product Closure

Scope:

- runtime instance and verification views
- failed test drill-down
- access URL copy/probe actions
- failover and rollback observability events
- correlation across instance, endpoint, membership, runtime, deployment, and test run

Exit criteria:

- an operator can diagnose a failed published service without database inspection

### WP-90: End-To-End And Release Gate

Implementation status on 2026-07-22:

- implemented `npm run verify:runtime-closure` as a cross-platform, fail-fast automated gate
- the gate verifies that the retired document quick-publish route has no remaining references, builds Parser/API, type-checks UI, runs Parser credential tests and 13 core API suites, and creates/cleans isolated SQLite and PostgreSQL databases
- latest execution passed 8 gate stages, 3 Parser tests, 81 API tests, 38 domain tables in each database, and zero pending migrations
- Windows release evidence passed `npm run build` for all four packages and `npm run test:streamable-session --workspace api-nova-server` for two concurrent MCP sessions
- not yet complete: real upstream OpenAPI/manual-registration flows, live Gateway/MCP consumer probes, Windows API/UI startup plus basic import validation, and the complete Ubuntu release path

Scope:

- OpenAPI absolute-server import E2E
- OpenAPI unresolved-server repair E2E
- manual registration E2E
- instance switch E2E
- Gateway aggregate service E2E
- MCP deployment parameter E2E
- post-deploy pass/fail/rollback E2E
- security/redaction tests
- SQLite/PostgreSQL parity
- Windows/Ubuntu release commands
- canonical documentation update

Exit criteria:

- all acceptance scenarios in section 12 pass
- release-readiness checklist includes runtime-instance and regression gates

## 12. Acceptance Scenarios

### Scenario A: Imported host is offline

1. import an OpenAPI document pointing to host A
2. host A becomes unavailable
3. add production instance host B without changing the OpenAPI contract
4. test against host B and capture a successful sample
5. bind publication to host B
6. deploy and verify through the published service

Expected: no re-import and no endpoint identity change are required.

### Scenario B: Same service in multiple environments

1. register one logical source service
2. add test and production instances
3. run governance tests against test
4. require a production smoke test before activation
5. publish production binding

Expected: all evidence clearly identifies environment and instance.

### Scenario C: Gateway aggregate service

1. create one Gateway runtime asset with prefix `orders`
2. add endpoints from one or more source services
3. configure member-relative paths
4. deploy and run smoke tests

Expected URLs:

```text
/api/v1/gateway/orders/create
/api/v1/gateway/orders/{id}
/api/v1/gateway/orders/search
```

### Scenario D: Deployment regression failure

1. deploy revision N successfully
2. change upstream binding or runtime configuration
3. build revision N+1
4. required test fails

Expected: revision N remains active, N+1 is rejected, failure evidence and rollback status are visible.

### Scenario E: Sensitive payload

1. test an API with bearer token, cookie, and sensitive JSON field
2. test succeeds

Expected: replay and the activated Gateway/MCP service resolve `env-headers:` credentials at request time, while persisted run/sample/runtime content contains no raw secret.

## 13. Out Of Scope For The First Delivery

- automatic Kubernetes/Consul/Nacos service discovery
- distributed weighted load balancing
- arbitrary user-supplied test scripts executed inside the API process
- a separate Gateway process per runtime asset
- per-Gateway-service listening ports in embedded mode
- large binary payload storage without an artifact-store design

## 14. Confirmed Product Decisions

The following decisions form the implementation baseline:

1. **Gateway deployment model**: keep one shared embedded port and introduce a required service prefix. Per-service Gateway ports remain out of scope.
2. **Instance selection**: deliver fixed primary plus ordered healthy failover first. Do not implement round-robin in this cycle.
3. **Environment model**: provide standard values but allow validated custom environment names.
4. **Sample capture**: every successful test automatically persists a distinct sanitized sample; no operator confirmation, promotion, or fingerprint deduplication is required. Sample maintenance is delivered as a subsequent management capability.
5. **Activation gate**: required smoke failure blocks first activation; update failure keeps/rolls back to the last known-good revision.
6. **No-case behavior**: production activation without a smoke case is blocked unless an authorized operator records a waiver and reason.
7. **Clean database baseline**: do not migrate or backfill existing table structures, test cases, or historical data. Reinitialize SQLite and PostgreSQL from the new canonical schema for development and verification.
8. **Legacy tests**: remove the server/tool `test_cases` model from the new schema; only endpoint-centric cases, runs, and samples are supported.

## 15. Recommended Implementation Order

Do not start UI-first or deployment-first.

Required order:

1. WP-00 contract and database safety
2. WP-10/WP-20 runtime instance foundation
3. WP-40 endpoint testing persistence
4. WP-30/WP-50 operator workflow
5. WP-60 publication and service contract
6. WP-70 verified deployment and rollback
7. WP-80 observability closure
8. WP-90 release gate

This order ensures later publication and deployment work consumes stable instance and testing contracts instead of creating another transitional shortcut.
