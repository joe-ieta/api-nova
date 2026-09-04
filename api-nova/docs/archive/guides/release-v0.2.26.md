# Release v0.2.26

This release consolidates the corrected dual-runtime asset model, moves publication and observability further toward runtime-asset-first ownership, and removes the remaining mainline websocket compatibility aliases from the active management path.

## Highlights

- established source service assets, endpoint definitions, runtime assets, publication profiles, route bindings, and runtime-observability entities as the main control-plane model
- moved publication ownership and runtime assembly further onto runtime-asset membership instead of endpoint-direct records
- advanced MCP and Gateway runtime observability so management reads now resolve through normalized runtime-asset views
- converged management websocket subscriptions and frontend event handling onto runtime-native contracts
- reduced the old websocket compatibility layer from the active management path and kept only non-observability management notifications outside that contract

## Verification

- `pnpm.cmd --filter api-nova-ui type-check`
- `pnpm.cmd --filter api-nova-api type-check`
- `packages/api-nova-api`: Jest suites passed in-band during this convergence cycle
- `packages/api-nova-parser`: Jest suites passed in-band during this convergence cycle
- `packages/api-nova-server`: package test script passed during this convergence cycle

## Notes

- product-facing release identity continues to use the repository tag `v0.2.26`
- package `version` fields remain package-internal identifiers under the current transitional versioning policy

## Remaining Follow-Up

- some MCP runtime telemetry still depends on process-side compatibility services before further normalization
- `ResourceMonitor` and some non-mainline monitoring subcomponents still expose placeholder process telemetry
- semantic system-log, audit-log, and metric projections still need broader rollout on top of the new runtime-observability model
