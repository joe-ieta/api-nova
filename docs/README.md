# ApiNova Documentation Index

## Purpose

This directory separates current-use documentation from archived historical material.

Use this index as the documentation entry point for ApiNova. Do not treat archived plans, old implementation notes, or completion summaries as the current project baseline.

The current top-level governance documents remain at repository root:

- [README](../README.md)
- [PRODUCT_CONSTRAINTS](../PRODUCT_CONSTRAINTS.md)
- [PROJECT_BASELINE](../PROJECT_BASELINE.md)
- [RELEASE_BASELINE_V1](../RELEASE_BASELINE_V1.md)

## Current Active Documents

### Baseline and current execution

- [Next Development Baseline](../NEXT_DEVELOPMENT_BASELINE.md)
- [Staged Development Plan](./guides/staged-development-plan.md)
- [Open Items](./reference/open-items.md)
- [Asset Model And Runtime Assets](./guides/asset-model-and-runtime-assets.md)
- [Publication Resource Baseline](./guides/publication-resource-baseline.md)

### Setup and release

- [Database Mode Quickstart](./guides/database-mode-quickstart.md)
- [Database Strategy](./guides/database-strategy.md)
- [Local Setup And Run](./guides/local-setup-and-run.md)
- [Parser Change Verification](./guides/parser-change-verification.md)
- [Release Readiness Checklist](./guides/release-readiness-checklist.md)

### Durable governance and reference

- [Fork Origin And Independence](./guides/fork-origin-and-independence.md)
- [Endpoint Semantic Layer Requirements](./guides/endpoint-semantic-layer-requirements.md)
- [Versioning Policy](./reference/versioning-policy.md)
- [GitHub Collaboration Workflow](./guides/github-collaboration-workflow.md)

## Archive

Historical documents live under:

- [archive](./archive/README.md)

Use archive for:

- superseded plans
- historical release notes
- obsolete guides
- exploratory design material
- prototypes and implementation history

Examples now treated as archive material:

- completed Phase 1/2/3 product-spine planning drafts
- release-specific notes
- troubleshooting deep dives that do not define the current baseline
- feature-specific implementation guides that are no longer part of the active operator path
- superseded convergence and next-phase planning drafts
- completed phase requirement and sprint breakdown notes
- earlier root-level project analysis snapshots that no longer define the current baseline

## Reading Order

For current product work, start here:

1. repository root governance documents
2. `docs/guides`
3. `docs/reference`
4. package-level README files when working within a specific package

Only use `docs/archive` when you need implementation history or decision background.
