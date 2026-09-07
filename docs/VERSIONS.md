# ApiNova 文档版本清单（VERSIONS）

> 本文件是 docs/ 下全部 Markdown 文档的版本登记清单，与每份活跃文档页头的 front-matter 元数据块（文档版本/文档状态/更新时间）保持一致。
> 归档区（docs/archive）文档为只读历史记录，不在文件中追加元数据块，仅在此登记其归档状态。

## 版本规则

- `doc-version`：文档内容版本号，采用语义化 `X.Y.Z`。影响基线/契约/操作步骤的变化递增；纯排版或笔误修复只递增 `patch`。
- `doc-status`：`active`（活跃）/ `archived`（已归档）/ `deprecated`（废弃待移除）。
- `doc-updated`：最近一次内容更新日期（YYYY-MM-DD），由维护者在此清单与页头元数据同步更新。
- 归档规则：文档不再代表当前基线时，将其移入 `docs/archive/<分类>/` 并在本清单标记 `archived`；归档文档只读。

## 活跃文档

| 文档 | 版本 | 状态 | 更新时间 |
| --- | --- | --- | --- |
| [docs/audits/2026-09-04-manual-registration-publication.md](docs/audits/2026-09-04-manual-registration-publication.md) | 1.0.0 | active | 2026-09-07 |
| [docs/audits/README.md](docs/audits/README.md) | 1.0.0 | active | 2026-09-07 |
| [docs/baseline/PRODUCT_CONSTRAINTS.md](docs/baseline/PRODUCT_CONSTRAINTS.md) | 1.0.0 | active | 2026-09-07 |
| [docs/baseline/PROJECT_BASELINE.md](docs/baseline/PROJECT_BASELINE.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/api-gateway-architecture-and-requirements.md](docs/guides/api-gateway-architecture-and-requirements.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/asset-model-and-runtime-assets.md](docs/guides/asset-model-and-runtime-assets.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/database-mode-quickstart.md](docs/guides/database-mode-quickstart.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/database-strategy.md](docs/guides/database-strategy.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/endpoint-semantic-layer-requirements.md](docs/guides/endpoint-semantic-layer-requirements.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/fork-origin-and-independence.md](docs/guides/fork-origin-and-independence.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/github-collaboration-workflow.md](docs/guides/github-collaboration-workflow.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/local-setup-and-run.md](docs/guides/local-setup-and-run.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/parser-change-verification.md](docs/guides/parser-change-verification.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/publication-resource-baseline.md](docs/guides/publication-resource-baseline.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/README.md](docs/guides/README.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/release-readiness-checklist.md](docs/guides/release-readiness-checklist.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/staged-development-plan.md](docs/guides/staged-development-plan.md) | 1.0.0 | active | 2026-09-07 |
| [docs/README.md](docs/README.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/changelog-field-guide.md](docs/reference/changelog-field-guide.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/esm-commonjs-quick-reference.md](docs/reference/esm-commonjs-quick-reference.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/management-observability-baseline.md](docs/reference/management-observability-baseline.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/management-permission-matrix.md](docs/reference/management-permission-matrix.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/mcp-jsonrpc-relationship.md](docs/reference/mcp-jsonrpc-relationship.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/nodejs-module-systems-guide.md](docs/reference/nodejs-module-systems-guide.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/open-items.md](docs/reference/open-items.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/README.md](docs/reference/README.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/versioning-policy.md](docs/reference/versioning-policy.md) | 1.0.0 | active | 2026-09-07 |
| [docs/release/api-nova-release-requirements.md](docs/release/api-nova-release-requirements.md) | 1.0.0 | active | 2026-09-07 |
| [docs/release/offline-dependency-migration.md](docs/release/offline-dependency-migration.md) | 1.0.0 | active | 2026-09-07 |

## 归档文档

归档区各子目录 README 与对应文档见下表。归档文档一律标记 `archived`，表格仅登记状态，不强制记录每个文件的 patch 版本。

| 归档分类 | 文档 | 状态 | 说明 |
| --- | --- | --- | --- |
| architecture | [monorepo-refactoring-proposal](docs/archive/architecture/monorepo-refactoring-proposal.md) | archived | 历史记录，仅回溯用 |
| architecture | [parser-extraction-implementation-plan](docs/archive/architecture/parser-extraction-implementation-plan.md) | archived | 历史记录，仅回溯用 |
| architecture | [README](docs/archive/architecture/README.md) | archived | 历史记录，仅回溯用 |
| baselines | [NEXT_DEVELOPMENT_BASELINE](docs/archive/baselines/NEXT_DEVELOPMENT_BASELINE.md) | archived | 原始基线，内容已并入合并基线 |
| baselines | [PROJECT_BASELINE](docs/archive/baselines/PROJECT_BASELINE.md) | archived | 原始基线，内容已并入合并基线 |
| baselines | [RELEASE_BASELINE_V1](docs/archive/baselines/RELEASE_BASELINE_V1.md) | archived | 原始基线，内容已并入合并基线 |
| guides | [api-authentication-guide](docs/archive/guides/api-authentication-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [bearer-token-quickstart](docs/archive/guides/bearer-token-quickstart.md) | archived | 历史记录，仅回溯用 |
| guides | [bearer-token-usage-guide](docs/archive/guides/bearer-token-usage-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [current-convergence-plan](docs/archive/guides/current-convergence-plan.md) | archived | 历史记录，仅回溯用 |
| guides | [custom-headers-quickstart](docs/archive/guides/custom-headers-quickstart.md) | archived | 历史记录，仅回溯用 |
| guides | [deployment-guide](docs/archive/guides/deployment-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [endpoint-semantic-layer-sprint-breakdown](docs/archive/guides/endpoint-semantic-layer-sprint-breakdown.md) | archived | 历史记录，仅回溯用 |
| guides | [lightweight-api-access-management-requirements](docs/archive/guides/lightweight-api-access-management-requirements.md) | archived | 历史记录，仅回溯用 |
| guides | [lightweight-api-access-management-sprint-breakdown](docs/archive/guides/lightweight-api-access-management-sprint-breakdown.md) | archived | 历史记录，仅回溯用 |
| guides | [next-phase-development-plan](docs/archive/guides/next-phase-development-plan.md) | archived | 历史记录，仅回溯用 |
| guides | [product-spine-restructure-plan-2026-04](docs/archive/guides/product-spine-restructure-plan-2026-04.md) | archived | 历史记录，仅回溯用 |
| guides | [quick-start-guide](docs/archive/guides/quick-start-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [release-convergence-checklist](docs/archive/guides/release-convergence-checklist.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.14](docs/archive/guides/release-v0.2.14.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.17](docs/archive/guides/release-v0.2.17.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.24](docs/archive/guides/release-v0.2.24.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.25](docs/archive/guides/release-v0.2.25.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.26](docs/archive/guides/release-v0.2.26.md) | archived | 历史记录，仅回溯用 |
| guides | [restart-guide](docs/archive/guides/restart-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [usage-guide](docs/archive/guides/usage-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [websocket-troubleshooting](docs/archive/guides/websocket-troubleshooting.md) | archived | 历史记录，仅回溯用 |
| plans | [api-gateway-phase1-task-breakdown](docs/archive/plans/api-gateway-phase1-task-breakdown.md) | archived | 历史记录，仅回溯用 |
| plans | [api-gateway-phase1-technical-design](docs/archive/plans/api-gateway-phase1-technical-design.md) | archived | 历史记录，仅回溯用 |
| plans | [api-gateway-phase2-task-breakdown](docs/archive/plans/api-gateway-phase2-task-breakdown.md) | archived | 历史记录，仅回溯用 |
| plans | [architecture-optimization-plan](docs/archive/plans/architecture-optimization-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [backend-api-service-implementation-plan](docs/archive/plans/backend-api-service-implementation-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [backend-technology-stack-analysis](docs/archive/plans/backend-technology-stack-analysis.md) | archived | 历史记录，仅回溯用 |
| plans | [backend-technology-stack-final-recommendation](docs/archive/plans/backend-technology-stack-final-recommendation.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-authentication-design](docs/archive/plans/bearer-token-authentication-design.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-implementation-plan](docs/archive/plans/bearer-token-implementation-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-implementation-plan-revised](docs/archive/plans/bearer-token-implementation-plan-revised.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-implementation-steps](docs/archive/plans/bearer-token-implementation-steps.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-solution-comparison](docs/archive/plans/bearer-token-solution-comparison.md) | archived | 历史记录，仅回溯用 |
| plans | [cli-architecture-analysis](docs/archive/plans/cli-architecture-analysis.md) | archived | 历史记录，仅回溯用 |
| plans | [cli-design-showcase](docs/archive/plans/cli-design-showcase.md) | archived | 历史记录，仅回溯用 |
| plans | [custom-headers-design](docs/archive/plans/custom-headers-design.md) | archived | 历史记录，仅回溯用 |
| plans | [custom-headers-implementation](docs/archive/plans/custom-headers-implementation.md) | archived | 历史记录，仅回溯用 |
| plans | [dual-publication-implementation-outline](docs/archive/plans/dual-publication-implementation-outline.md) | archived | 历史记录，仅回溯用 |
| plans | [enterprise-token-integration-solution](docs/archive/plans/enterprise-token-integration-solution.md) | archived | 历史记录，仅回溯用 |
| plans | [frontend-design-spec](docs/archive/plans/frontend-design-spec.md) | archived | 历史记录，仅回溯用 |
| plans | [immediate-tasks-week1](docs/archive/plans/immediate-tasks-week1.md) | archived | 历史记录，仅回溯用 |
| plans | [improvement-plan](docs/archive/plans/improvement-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [mcp-centered-architecture-design](docs/archive/plans/mcp-centered-architecture-design.md) | archived | 历史记录，仅回溯用 |
| plans | [mcp-openapi-auto-testing-feasibility](docs/archive/plans/mcp-openapi-auto-testing-feasibility.md) | archived | 历史记录，仅回溯用 |
| plans | [mcp-openapi-auto-testing-implementation](docs/archive/plans/mcp-openapi-auto-testing-implementation.md) | archived | 历史记录，仅回溯用 |
| plans | [monorepo-architecture-proposal](docs/archive/plans/monorepo-architecture-proposal.md) | archived | 历史记录，仅回溯用 |
| plans | [monorepo-dependency-management](docs/archive/plans/monorepo-dependency-management.md) | archived | 历史记录，仅回溯用 |
| plans | [nestjs-implementation-checklist](docs/archive/plans/nestjs-implementation-checklist.md) | archived | 历史记录，仅回溯用 |
| plans | [nestjs-implementation-guide](docs/archive/plans/nestjs-implementation-guide.md) | archived | 历史记录，仅回溯用 |
| plans | [practical-mcp-ui-architecture](docs/archive/plans/practical-mcp-ui-architecture.md) | archived | 历史记录，仅回溯用 |
| plans | [project-analysis-and-v1-plan](docs/archive/plans/project-analysis-and-v1-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [project-roadmap-and-planning](docs/archive/plans/project-roadmap-and-planning.md) | archived | 历史记录，仅回溯用 |
| plans | [runtime-observability-stage6-model](docs/archive/plans/runtime-observability-stage6-model.md) | archived | 历史记录，仅回溯用 |
| plans | [swagger2openapi-integration-plan](docs/archive/plans/swagger2openapi-integration-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [technical-architecture](docs/archive/plans/technical-architecture.md) | archived | 历史记录，仅回溯用 |
| reference | [changesets-implementation-guide](docs/archive/reference/changesets-implementation-guide.md) | archived | 历史记录，仅回溯用 |
| reference | [changesets-integration-guide](docs/archive/reference/changesets-integration-guide.md) | archived | 历史记录，仅回溯用 |
| reference | [configuration-audit-2026-04](docs/archive/reference/configuration-audit-2026-04.md) | archived | 历史记录，仅回溯用 |
| reference | [mcp-tool-response-validation](docs/archive/reference/mcp-tool-response-validation.md) | archived | 历史记录，仅回溯用 |
| reference | [npm-publication-guide](docs/archive/reference/npm-publication-guide.md) | archived | 历史记录，仅回溯用 |
| reference | [npm-tslib-issue-fix](docs/archive/reference/npm-tslib-issue-fix.md) | archived | 历史记录，仅回溯用 |
| reference | [why-no-type-module](docs/archive/reference/why-no-type-module.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-completion-summary](docs/archive/summaries/bearer-token-completion-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-implementation-summary](docs/archive/summaries/bearer-token-implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-solution-summary](docs/archive/summaries/bearer-token-solution-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-solution-summary-final](docs/archive/summaries/bearer-token-solution-summary-final.md) | archived | 历史记录，仅回溯用 |
| summaries | [complete-upgrade-summary](docs/archive/summaries/complete-upgrade-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [custom-headers-implementation-summary](docs/archive/summaries/custom-headers-implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [implementation-summary](docs/archive/summaries/implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [mcp-response-fix-summary](docs/archive/summaries/mcp-response-fix-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [migration-summary](docs/archive/summaries/migration-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [post-publication-guide](docs/archive/summaries/post-publication-guide.md) | archived | 历史记录，仅回溯用 |
| summaries | [swagger2-support-implementation-summary](docs/archive/summaries/swagger2-support-implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [task-5.1-completion-summary](docs/archive/summaries/task-5.1-completion-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [websocket-final-solution](docs/archive/summaries/websocket-final-solution.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-architecture](docs/archive/ui/mcp-swagger-ui-architecture.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-development-guide](docs/archive/ui/mcp-swagger-ui-development-guide.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-technical-documentation](docs/archive/ui/mcp-swagger-ui-technical-documentation.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-upgrade-summary](docs/archive/ui/mcp-swagger-ui-upgrade-summary.md) | archived | 历史记录，仅回溯用 |
