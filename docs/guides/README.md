# Guides

This directory contains active operational and usage-oriented documentation for the current product baseline.

## Current Baseline Guides

- [staged-development-plan](./staged-development-plan.md)
- [asset-model-and-runtime-assets](./asset-model-and-runtime-assets.md)
- [publication-resource-baseline](./publication-resource-baseline.md)
- [release-readiness-checklist](./release-readiness-checklist.md)

## Setup And Operations

- [database-mode-quickstart](./database-mode-quickstart.md)
- [database-strategy](./database-strategy.md)
- [local-setup-and-run](./local-setup-and-run.md)
- [parser-change-verification](./parser-change-verification.md)
- [github-collaboration-workflow](./github-collaboration-workflow.md)

## Durable Feature Baselines

- [endpoint-semantic-layer-requirements](./endpoint-semantic-layer-requirements.md)
- [dual-publication-implementation-outline](./dual-publication-implementation-outline.md)
- [api-gateway-architecture-and-requirements](./api-gateway-architecture-and-requirements.md)
- [api-gateway-phase1-technical-design](./api-gateway-phase1-technical-design.md)
- [api-gateway-phase1-task-breakdown](./api-gateway-phase1-task-breakdown.md)
- [api-gateway-phase2-task-breakdown](./api-gateway-phase2-task-breakdown.md)

## Guide Inclusion Rule

A guide belongs here only if it describes a currently supported product path or a currently required engineering workflow.

If a guide becomes stale, historical, or too drifted from the current baseline, move it into `docs/archive` instead of leaving it in the active set.

## Current Narrow Baseline

The active guide set is intentionally narrow during product convergence.

It should primarily cover:

- current product-spine baseline
- setup and run
- database mode selection
- parser-change verification
- release verification
- durable architecture baselines that still describe supported behavior

Feature-specific experiments, release notes, troubleshooting deep dives, and historical implementation guides should live in `docs/archive/guides`.
