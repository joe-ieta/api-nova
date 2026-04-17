# Release v0.2.25

## Scope

This release focuses on UI runtime stability, operator-facing warning cleanup, and safer local development proxy behavior.

## Core Changes

- fixed missing `userAuth.messages.*` locale keys used during login and logout flows
- corrected global error handler injection so `MainLayout` and related views can resolve `$globalErrorHandler`
- reduced websocket subscription noise by guarding against empty `serverId` values during subscribe, unsubscribe, and reconnect restore flows
- made the UI dev proxy configurable through `VITE_PROXY_TARGET`
- changed the default local proxy target to `http://127.0.0.1:9001` to avoid noisy localhost resolution failures during development

## Operator Impact

### UI Runtime Behavior

- login and logout flows no longer emit missing locale key warnings for the patched auth messages
- layout-level error handler injection warnings are removed from the browser console
- websocket teardown and reconnect flows no longer emit `server-metrics-undefined` or `server-logs-undefined` unsubscribe confirmations

### Local Development

- the Vite development proxy can now follow an explicit backend target without editing source code
- local websocket proxy failures are easier to diagnose because the proxy target is now explicit and stable

## Verified In This Release

- `pnpm --filter api-nova-ui run type-check`

## Residual Risks

- backend health and websocket availability still depend on the `api-nova-api` process being healthy on the configured target
- `.env.development` remains a local developer file and is not part of the committed release payload

## Related Guides

- [Versioning Policy](../../reference/versioning-policy.md)
- [GitHub Collaboration Workflow](../../guides/github-collaboration-workflow.md)
