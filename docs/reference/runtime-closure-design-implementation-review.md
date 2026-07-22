# Runtime Closure Design And Implementation Review

> Document status: Active review record
> Review date: 2026-07-22
> Scope: Runtime instances, endpoint testing, publication bindings, Gateway/MCP deployment verification, and release closure

## Outcome

No architecture-level reversal was found. The implementation preserves the intended separation between logical API assets, live runtime instances, endpoint evidence, publication membership, and deployable runtime assets. Activation safety is materially stronger than the earlier baseline.

Five productization deviations remain. They are tracked as `DEV-01` through `DEV-05` in `open-items.md`; none is hidden by marking the work package complete.

## Reviewed Contract Map

| Design contract | Implementation evidence | Assessment |
| --- | --- | --- |
| Logical source assets do not own live coordinates | `source_service_assets` has no host/port/base-path columns; `source_service_instances` owns them | aligned |
| Imported or manually entered addresses can be replaced without re-import | instance management and runtime upstream binding APIs/UI are present | aligned |
| Successful API tests automatically save every distinct sample | success transaction writes one run and one sample; no confirmation path | aligned |
| Failed tests remain evidence but do not create samples | failed-run path writes only the run | aligned |
| Secrets are not persisted in samples or replay evidence | sensitive-key sanitization and `env-headers:` runtime references | aligned, retention limits remain open |
| Gateway services share one listen port and use a required prefix | required normalized `servicePrefix`; route snapshot scopes paths by prefix | aligned |
| Gateway/MCP candidates cannot activate before required verification | deploy/start/redeploy flow plans and executes verification; direct managed-server bypass is quarantined | aligned |
| Candidate failure keeps the previous active revision | Gateway snapshot rollback and MCP pre-persistence candidate replay | aligned |
| Verification evidence is operator-visible | Runtime Asset verification dialog exposes blockers, assertions, results, and sanitized evidence | aligned |
| SQLite/PostgreSQL start from a clean model | isolated verifiers confirm 38 domain tables and no pending migrations | aligned |
| MCP endpoint is fully configurable before activation | deploy DTO has port/transport, but governed UI and explicit endpoint-path contract are incomplete | deviation `DEV-01` |
| Upstream changes immediately expose verification-required state | candidate identity changes at next deploy, but no eager stale-state transition/run exists | deviation `DEV-02` |
| Governance readiness is tied to current instance and endpoint revision | readiness uses endpoint metadata and does not invalidate on instance/contract changes | deviation `DEV-03` |
| Sample storage is bounded and lifecycle-managed | samples are sanitized, but size/binary/retention controls are absent | deviation `DEV-04` |
| Instance and binding mutations are fully audited | binding revision exists; actor/reason/history coverage is incomplete | deviation `DEV-05` |

## Safety Boundary

The deviations do not permit an unverified candidate to silently replace an active Gateway or managed MCP revision. The remaining risk is primarily incomplete operator configuration, stale pre-publication presentation, storage governance, and audit completeness.

## Documentation Corrections Made By This Review

- external-environment tests moved into active open items
- the runtime closure plan is classified as an active implementation plan, not an awaiting-confirmation proposal
- completed Phase/Stage task breakdowns moved to archive
- obsolete package implementation plans moved to `docs/archive/packages`
- an executable acceptance matrix was added under `docs/testing`
- active-document status markers and documentation indexes were normalized

## Re-Review Exit Conditions

This review may be archived only after:

1. `DEV-01` through `DEV-05` are closed or explicitly deferred by a new approved baseline;
2. `EXT-01` through `EXT-09` have recorded evidence;
3. the release-readiness checklist is fully checked on Windows and Ubuntu;
4. no active document links to a superseded plan as its source of truth.
