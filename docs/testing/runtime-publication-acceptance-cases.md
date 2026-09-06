# Runtime Publication Acceptance Cases

> Document status: Active
> Last reviewed: 2026-09-06
> Release gate: Required together with `docs/guides/release-readiness-checklist.md`

## Evidence Header

For every manual execution record:

- commit or worktree identifier
- execution date and operator
- Windows/Ubuntu version
- Node and npm versions
- SQLite/PostgreSQL mode
- upstream service name, address, and revision
- created asset, instance, membership, verification-run, and runtime-asset IDs
- sanitized request/response or screenshot/log location

## Core Functional Cases

| ID | Preconditions | Action | Expected result | Coverage/status |
| --- | --- | --- | --- | --- |
| RI-01 | OpenAPI has an absolute server URL | import the specification | logical source asset and provisional runtime instance are created; no runtime asset is published | automated-covered |
| RI-02 | OpenAPI has no usable absolute URL | import the specification | logical asset is retained as unbound; no fake live instance is treated as runnable | manual-required |
| RI-03 | source instance exists | edit host, port, base path, environment, credential reference | values are validated and stored only on the instance | manual-required |
| RI-04 | enabled instance exists | probe it | status, HTTP result, latency, timestamp, and sanitized error are updated | manual-required |
| RI-05 | two environment instances exist | set one as default | exactly one enabled non-archived default remains in the environment | manual-required |
| RI-06 | active binding candidates exist | resolve `fixed_primary` | unhealthy/missing primary does not silently fail over | automated-covered |
| RI-07 | active ordered candidates exist | resolve `priority_failover` | first enabled healthy candidate by priority/order is selected | automated-covered |
| RI-08 | binding revision is N | update with stale expected revision | request fails with conflict; candidates are unchanged | automated-covered |
| ET-01 | endpoint and live instance exist | execute a successful API test twice with the same payload | two successful runs and two distinct sanitized samples are stored automatically | automated-passed |
| ET-02 | endpoint and live instance exist | execute a failed API test | failed run is stored and no sample is created | automated-passed |
| ET-03 | request/response contains credentials | execute a successful test | sensitive keys are redacted in run and sample evidence | automated-covered |
| ET-04 | active sample exists | edit title, tags, enabled state, assertion metadata | changes are queryable and affect later verification selection | automated-covered |
| ET-05 | active sample exists | archive then delete it | archived sample is disabled; explicit delete removes it | automated-passed |
| PB-01 | governance-ready endpoint exists | create Gateway runtime asset without prefix | request is rejected | automated-passed |
| PB-02 | governance-ready endpoint exists | create Gateway asset with `/Orders/` | stored prefix is normalized to `orders` and public route is prefix-scoped | automated-passed |
| PB-03 | blocked endpoint exists | add it to a runtime asset | request is rejected with readiness reasons | automated-passed |
| PB-04 | membership and instances exist | configure active upstream binding | membership stores environment, strategy, candidates, primary, and revision | automated-covered |
| VR-01 | enabled membership has no smoke sample | deploy normally | plan is blocked and no candidate activates | automated-passed |
| VR-02 | no smoke sample; authorized operator | deploy with a reason of at least 10 characters | waiver evidence stores actor, reason, environment, and candidate identity; activation may proceed | automated-passed |
| VR-03 | smoke and regression samples exist | deploy Gateway candidate | all required replays pass before atomic snapshot activation | automated-passed |
| VR-04 | previous Gateway revision active | make candidate replay fail | candidate is discarded and previous revision stays active | automated-passed |
| VR-05 | previous MCP revision active | make candidate replay/assertion fail | managed-server record is not overwritten and previous revision stays active | automated-passed |
| VR-06 | response schema differs | replay with schema assertion | activation fails with precise mismatch evidence | automated-passed |
| VR-07 | exact sample has dynamic paths | configure ignored paths and replay | ignored paths do not fail exact comparison; other mismatches do | automated-passed |
| CR-01 | instance uses valid `env-headers:` reference | deploy and invoke | secret is resolved at execution and not persisted in samples/runs/snapshots | automated-covered |
| CR-02 | referenced environment variable is missing | deploy or invoke | operation fails closed; candidate is not activated | automated-covered |
| DB-01 | isolated SQLite available | run `db:verify-isolated-sqlite` | 40 domain tables, zero domain rows, no forbidden columns/pending migrations; temp file removed | automated-passed |
| DB-02 | isolated PostgreSQL available | run `db:verify-isolated-postgres` | same 40-table clean contract as SQLite; temporary database removed | environment-blocked (EXT-11) |
| RG-01 | current checkout | run `npm run verify:runtime-closure` | all eight gate stages pass, including the current PostgreSQL target | automated-covered (full gate rerun pending EXT-11) |
| RG-02 | Windows checkout | run root production build | Parser, Server, API, and UI build successfully | automated-passed |
| RG-03 | Windows checkout | run streamable-session smoke | two MCP sessions remain isolated and disconnect cleanly | automated-passed |

## Open-Gap Cases

| ID | Required behavior | Current status |
| --- | --- | --- |
| GAP-01 | operator configures MCP port, transport, and validated endpoint path before activation | open-gap `DEV-01` |
| GAP-02 | binding/instance change immediately marks affected runtime asset verification-required | open-gap `DEV-02` |
| GAP-03 | readiness becomes false when qualifying instance is archived/changed or endpoint revision is obsolete | open-gap `DEV-03` |
| GAP-04 | oversized JSON is truncated/rejected by policy; binary bodies store metadata/hash only | open-gap `DEV-04` |
| GAP-05 | retention cleanup differs by manual/deploy success/deploy failure classes | open-gap `DEV-04` |
| GAP-06 | instance and binding mutations record actor, reason, before/after revision | open-gap `DEV-05` |

## External-Environment Cases

| ID | Procedure | Pass criteria | Status |
| --- | --- | --- | --- |
| EXT-01 | import a real OpenAPI URL whose server is reachable | import creates provisional instance; live probe/test succeeds; sample is stored | environment-blocked |
| EXT-02 | import a spec without a usable server, then attach a live instance | same endpoint IDs become testable without re-import | environment-blocked |
| EXT-03 | manually register an API against a live upstream | registration, test, governance, publication, deployment, and consumer call close successfully | environment-blocked |
| EXT-04 | test against host A, retire A, attach host B, switch binding, redeploy | endpoint identity is unchanged; new candidate verifies against B; evidence identifies B | environment-blocked |
| EXT-05 | publish at least two endpoints under one Gateway prefix | consumer calls resolve through the advertised aggregate-service URLs | environment-blocked |
| EXT-06 | deploy MCP with runtime credentials and invoke from a real MCP client | advertised endpoint works and secrets are absent from persisted evidence | environment-blocked |
| EXT-07 | activate revision N, introduce a failing N+1, redeploy | N remains callable; N+1 failure and rollback/retention evidence are visible | environment-blocked |
| EXT-08 | install/start API and UI on Windows; run basic import/conversion | documented commands and browser workflow pass without undocumented steps | manual-required |
| EXT-09 | repeat install/build/start/parser/session workflow on Ubuntu | all documented Ubuntu commands and core workflow pass | environment-blocked |

## Latest Automated Evidence

On 2026-09-06, isolated SQLite verification passed with 40 domain tables, zero domain rows and no pending migrations. Full API startup with `DB_SYNCHRONIZE=false` and the Gateway/MCP multi-process security integration also passed; see [security audit cases](runtime-security-audit-cases.md). This fixture uses pre-seeded publication snapshots and does not close the real registration/publication workflow cases. The updated PostgreSQL baseline and full closure gate remain pending `EXT-11`.

Historical evidence from the 2026-07-22 worktree (not current database acceptance):

- `npm run verify:runtime-closure`: 8 stages, 3 Parser tests, 81 API tests
- isolated SQLite and PostgreSQL verification: 38 domain tables each, zero pending migrations
- `npm run build`: all four packages
- `npm run test:streamable-session --workspace api-nova-server`: multi-session smoke

This evidence does not close `EXT-01` through `EXT-09` or `GAP-01` through `GAP-06`.
