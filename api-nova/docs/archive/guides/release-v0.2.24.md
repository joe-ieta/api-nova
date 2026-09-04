# Release v0.2.24

## Scope

This release advances the management observability baseline and converges imported and manual endpoint governance into a more consistent operator surface.

## Core Changes

- advanced the management observability baseline so operator-facing management flows have clearer trace points and implementation boundaries
- unified the endpoint governance surface so imported endpoints and manual endpoints are managed through the same registry entry path
- added imported endpoint governance editing for profile-level controls without reopening structural import contracts
- aligned server management and OpenAPI management navigation to the unified endpoint governance entry
- removed several placeholder UI actions that implied unfinished settings or profile features
- updated active planning and open-items documents so the completed stage boundaries and remaining work are stated consistently
- corrected the top-level baseline drift wording so active default ports remain `9000`, `9001`, and `9022`

## Operator Impact

### Endpoint Governance

- operators no longer need to treat imported endpoints and manual endpoints as two separate management products
- the endpoint registry now supports a unified view and keeps source type visible within the table
- imported service records can be adjusted through governance metadata edits without changing the imported structural source

### Management Navigation

- server management and OpenAPI management now route into the same governance surface
- misleading placeholder profile and settings actions were removed from the main UI shell

## Verified In This Release

- `pnpm --filter api-nova-ui run type-check`

## Residual Risks

This release tightens governance consistency, but the following work remains intentionally outside this tag:

- Stage 4 semantic publication remains planned and documented, not implemented
- Stage 5 production-readiness polish remains open, especially around deeper hardening and broader cross-platform verification
- some broader documentation consistency work is still expected as later release-line follow-up

## Related Guides

- [Staged Development Plan](../../guides/staged-development-plan.md)
- [Open Items](../../reference/open-items.md)
- [Versioning Policy](../../reference/versioning-policy.md)
- [GitHub Collaboration Workflow](../../guides/github-collaboration-workflow.md)
