# ApiNova 文档版本清单（VERSIONS）

> 本文件登记来源分支已纳入管理的文档及本次合并新增记录；不是当前仓库全部文档的穷举清单。带有 front-matter 的文档应同步维护版本、状态和更新时间。当前较新的工程规范仍以 docs/README.md 的入口为准。
> 归档区（docs/archive）文档为只读历史记录，不在文件中追加元数据块，仅在此登记其归档状态。

## 版本规则

- `doc-version`：文档内容版本号，采用语义化 `X.Y.Z`。影响基线/契约/操作步骤的变化递增；纯排版或笔误修复只递增 `patch`。
- `doc-status`：`active`（活跃）/ `archived`（已归档）/ `deprecated`（废弃待移除）。
- `doc-updated`：最近一次内容更新日期（YYYY-MM-DD），由维护者在此清单与页头元数据同步更新。
- 归档规则：文档不再代表当前基线时，将其移入 `docs/archive/<分类>/` 并在本清单标记 `archived`；归档文档只读。

## 活跃文档

| 文档 | 版本 | 状态 | 更新时间 |
| --- | --- | --- | --- |
| [docs/audits/2026-09-04-manual-registration-publication.md](./audits/2026-09-04-manual-registration-publication.md) | 1.0.0 | active | 2026-09-07 |
| [docs/audits/2026-09-07-reviewed-merge.md](./audits/2026-09-07-reviewed-merge.md) | 1.0.0 | active | 2026-09-07 |
| [docs/audits/README.md](./audits/README.md) | 1.1.0 | active | 2026-09-08 |
| [docs/baseline/PRODUCT_CONSTRAINTS.md](./baseline/PRODUCT_CONSTRAINTS.md) | 1.0.0 | active | 2026-09-07 |
| [docs/baseline/PROJECT_BASELINE.md](./baseline/PROJECT_BASELINE.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/api-gateway-architecture-and-requirements.md](./guides/api-gateway-architecture-and-requirements.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/asset-model-and-runtime-assets.md](./guides/asset-model-and-runtime-assets.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/database-mode-quickstart.md](./guides/database-mode-quickstart.md) | 1.1.0 | active | 2026-09-08 |
| [docs/guides/database-strategy.md](./guides/database-strategy.md) | 1.1.0 | active | 2026-09-08 |
| [docs/guides/endpoint-semantic-layer-requirements.md](./guides/endpoint-semantic-layer-requirements.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/fork-origin-and-independence.md](./guides/fork-origin-and-independence.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/github-collaboration-workflow.md](./guides/github-collaboration-workflow.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/local-setup-and-run.md](./guides/local-setup-and-run.md) | 1.1.0 | active | 2026-09-08 |
| [docs/guides/parser-change-verification.md](./guides/parser-change-verification.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/publication-resource-baseline.md](./guides/publication-resource-baseline.md) | 1.0.0 | active | 2026-09-07 |
| [docs/guides/README.md](./guides/README.md) | 1.2.0 | active | 2026-09-08 |
| [docs/guides/release-readiness-checklist.md](./guides/release-readiness-checklist.md) | 1.1.0 | active | 2026-09-08 |
| [docs/guides/staged-development-plan.md](./guides/staged-development-plan.md) | 1.0.0 | active | 2026-09-07 |
| [docs/README.md](./README.md) | 1.2.0 | active | 2026-09-08 |
| [docs/reference/changelog-field-guide.md](./reference/changelog-field-guide.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/esm-commonjs-quick-reference.md](./reference/esm-commonjs-quick-reference.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/management-observability-baseline.md](./reference/management-observability-baseline.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/management-permission-matrix.md](./reference/management-permission-matrix.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/mcp-jsonrpc-relationship.md](./reference/mcp-jsonrpc-relationship.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/nodejs-module-systems-guide.md](./reference/nodejs-module-systems-guide.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/open-items.md](./reference/open-items.md) | 1.1.0 | active | 2026-09-08 |
| [docs/reference/README.md](./reference/README.md) | 1.2.0 | active | 2026-09-08 |
| [docs/reference/versioning-policy.md](./reference/versioning-policy.md) | 1.0.0 | active | 2026-09-07 |
| [docs/release/api-nova-release-requirements.md](./release/api-nova-release-requirements.md) | 1.1.0 | active | 2026-09-08 |
| [docs/release/offline-dependency-migration.md](./release/offline-dependency-migration.md) | 1.0.0 | active | 2026-09-07 |

| [docs/audits/2026-09-08-persistence-cleanup.md](./audits/2026-09-08-persistence-cleanup.md) | 1.0.0 | active | 2026-09-08 |

## 可观测性增强文档

active 表示文档正在维护，不表示接口已经实现。需求、设计、任务计划和全新版本范围均已确认；存储及采集基础实施中，新 Endpoint 尚未开放。实现与验证状态以执行台账为准。

| 文档 | 版本 | 状态 | 更新时间 |
| --- | --- | --- | --- |
| [可观测性功能需求](./guides/runtime-observability-requirements.md) | 1.2.0 | active | 2026-09-08 |
| [可观测性设计](./reference/runtime-observability-design.md) | 1.6.0 | active | 2026-09-09 |
| [可观测性 API Endpoint](./reference/runtime-observability-api-endpoints.md) | 1.5.1 | active | 2026-09-09 |
| [可观测性开发任务计划](./guides/runtime-observability-development-task-plan.md) | 1.5.1 | active | 2026-09-09 |
| [可观测性执行与完成状态](./guides/runtime-observability-development-execution-status.md) | 1.8.0 | active | 2026-09-09 |
| [可观测性契约与接入映射](./reference/runtime-observability-contract-mapping.md) | 1.5.0 | active | 2026-09-09 |
| [可观测性存储基础](./reference/runtime-observability-storage-foundation.md) | 1.1.0 | active | 2026-09-08 |

## 归档文档

归档区各子目录 README 与对应文档见下表。归档文档一律标记 `archived`，表格仅登记状态，不强制记录每个文件的 patch 版本。

| 归档分类 | 文档 | 状态 | 说明 |
| --- | --- | --- | --- |
| architecture | [monorepo-refactoring-proposal](./archive/architecture/monorepo-refactoring-proposal.md) | archived | 历史记录，仅回溯用 |
| architecture | [parser-extraction-implementation-plan](./archive/architecture/parser-extraction-implementation-plan.md) | archived | 历史记录，仅回溯用 |
| architecture | [README](./archive/architecture/README.md) | archived | 历史记录，仅回溯用 |
| baselines | [NEXT_DEVELOPMENT_BASELINE](./archive/plans/next-development-baseline.md) | archived | 原始基线，内容已并入合并基线 |
| baselines | [PROJECT_BASELINE](./archive/baselines/PROJECT_BASELINE.md) | archived | 原始基线，内容已并入合并基线 |
| baselines | [RELEASE_BASELINE_V1](./archive/baselines/RELEASE_BASELINE_V1.md) | archived | 原始基线，内容已并入合并基线 |
| guides | [api-authentication-guide](./archive/guides/api-authentication-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [bearer-token-quickstart](./archive/guides/bearer-token-quickstart.md) | archived | 历史记录，仅回溯用 |
| guides | [bearer-token-usage-guide](./archive/guides/bearer-token-usage-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [current-convergence-plan](./archive/guides/current-convergence-plan.md) | archived | 历史记录，仅回溯用 |
| guides | [custom-headers-quickstart](./archive/guides/custom-headers-quickstart.md) | archived | 历史记录，仅回溯用 |
| guides | [deployment-guide](./archive/guides/deployment-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [endpoint-semantic-layer-sprint-breakdown](./archive/guides/endpoint-semantic-layer-sprint-breakdown.md) | archived | 历史记录，仅回溯用 |
| guides | [lightweight-api-access-management-requirements](./archive/guides/lightweight-api-access-management-requirements.md) | archived | 历史记录，仅回溯用 |
| guides | [lightweight-api-access-management-sprint-breakdown](./archive/guides/lightweight-api-access-management-sprint-breakdown.md) | archived | 历史记录，仅回溯用 |
| guides | [next-phase-development-plan](./archive/guides/next-phase-development-plan.md) | archived | 历史记录，仅回溯用 |
| guides | [product-spine-restructure-plan-2026-04](./archive/guides/product-spine-restructure-plan-2026-04.md) | archived | 历史记录，仅回溯用 |
| guides | [quick-start-guide](./archive/guides/quick-start-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [release-convergence-checklist](./archive/guides/release-convergence-checklist.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.14](./archive/guides/release-v0.2.14.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.17](./archive/guides/release-v0.2.17.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.24](./archive/guides/release-v0.2.24.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.25](./archive/guides/release-v0.2.25.md) | archived | 历史记录，仅回溯用 |
| guides | [release-v0.2.26](./archive/guides/release-v0.2.26.md) | archived | 历史记录，仅回溯用 |
| guides | [restart-guide](./archive/guides/restart-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [usage-guide](./archive/guides/usage-guide.md) | archived | 历史记录，仅回溯用 |
| guides | [websocket-troubleshooting](./archive/guides/websocket-troubleshooting.md) | archived | 历史记录，仅回溯用 |
| plans | [api-gateway-phase1-task-breakdown](./archive/guides/api-gateway-phase1-task-breakdown.md) | archived | 历史记录，仅回溯用 |
| plans | [api-gateway-phase1-technical-design](./archive/guides/api-gateway-phase1-technical-design.md) | archived | 历史记录，仅回溯用 |
| plans | [api-gateway-phase2-task-breakdown](./archive/guides/api-gateway-phase2-task-breakdown.md) | archived | 历史记录，仅回溯用 |
| plans | [architecture-optimization-plan](./archive/plans/architecture-optimization-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [backend-api-service-implementation-plan](./archive/plans/backend-api-service-implementation-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [backend-technology-stack-analysis](./archive/plans/backend-technology-stack-analysis.md) | archived | 历史记录，仅回溯用 |
| plans | [backend-technology-stack-final-recommendation](./archive/plans/backend-technology-stack-final-recommendation.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-authentication-design](./archive/plans/bearer-token-authentication-design.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-implementation-plan](./archive/plans/bearer-token-implementation-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-implementation-plan-revised](./archive/plans/bearer-token-implementation-plan-revised.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-implementation-steps](./archive/plans/bearer-token-implementation-steps.md) | archived | 历史记录，仅回溯用 |
| plans | [bearer-token-solution-comparison](./archive/plans/bearer-token-solution-comparison.md) | archived | 历史记录，仅回溯用 |
| plans | [cli-architecture-analysis](./archive/plans/cli-architecture-analysis.md) | archived | 历史记录，仅回溯用 |
| plans | [cli-design-showcase](./archive/plans/cli-design-showcase.md) | archived | 历史记录，仅回溯用 |
| plans | [custom-headers-design](./archive/plans/custom-headers-design.md) | archived | 历史记录，仅回溯用 |
| plans | [custom-headers-implementation](./archive/plans/custom-headers-implementation.md) | archived | 历史记录，仅回溯用 |
| plans | [dual-publication-implementation-outline](./archive/guides/dual-publication-implementation-outline.md) | archived | 历史记录，仅回溯用 |
| plans | [enterprise-token-integration-solution](./archive/plans/enterprise-token-integration-solution.md) | archived | 历史记录，仅回溯用 |
| plans | [frontend-design-spec](./archive/plans/frontend-design-spec.md) | archived | 历史记录，仅回溯用 |
| plans | [immediate-tasks-week1](./archive/plans/immediate-tasks-week1.md) | archived | 历史记录，仅回溯用 |
| plans | [improvement-plan](./archive/plans/improvement-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [mcp-centered-architecture-design](./archive/plans/mcp-centered-architecture-design.md) | archived | 历史记录，仅回溯用 |
| plans | [mcp-openapi-auto-testing-feasibility](./archive/plans/mcp-openapi-auto-testing-feasibility.md) | archived | 历史记录，仅回溯用 |
| plans | [mcp-openapi-auto-testing-implementation](./archive/plans/mcp-openapi-auto-testing-implementation.md) | archived | 历史记录，仅回溯用 |
| plans | [monorepo-architecture-proposal](./archive/plans/monorepo-architecture-proposal.md) | archived | 历史记录，仅回溯用 |
| plans | [monorepo-dependency-management](./archive/plans/monorepo-dependency-management.md) | archived | 历史记录，仅回溯用 |
| plans | [nestjs-implementation-checklist](./archive/plans/nestjs-implementation-checklist.md) | archived | 历史记录，仅回溯用 |
| plans | [nestjs-implementation-guide](./archive/plans/nestjs-implementation-guide.md) | archived | 历史记录，仅回溯用 |
| plans | [practical-mcp-ui-architecture](./archive/plans/practical-mcp-ui-architecture.md) | archived | 历史记录，仅回溯用 |
| plans | [project-analysis-and-v1-plan](./archive/plans/project-analysis-and-v1-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [project-roadmap-and-planning](./archive/plans/project-roadmap-and-planning.md) | archived | 历史记录，仅回溯用 |
| plans | [runtime-observability-stage6-model](./archive/guides/runtime-observability-stage6-model.md) | archived | 历史记录，仅回溯用 |
| plans | [swagger2openapi-integration-plan](./archive/plans/swagger2openapi-integration-plan.md) | archived | 历史记录，仅回溯用 |
| plans | [technical-architecture](./archive/plans/technical-architecture.md) | archived | 历史记录，仅回溯用 |
| reference | [changesets-implementation-guide](./archive/reference/changesets-implementation-guide.md) | archived | 历史记录，仅回溯用 |
| reference | [changesets-integration-guide](./archive/reference/changesets-integration-guide.md) | archived | 历史记录，仅回溯用 |
| reference | [configuration-audit-2026-04](./archive/summaries/configuration-audit-2026-04.md) | archived | 历史记录，仅回溯用 |
| reference | [mcp-tool-response-validation](./archive/reference/mcp-tool-response-validation.md) | archived | 历史记录，仅回溯用 |
| reference | [npm-publication-guide](./archive/reference/npm-publication-guide.md) | archived | 历史记录，仅回溯用 |
| reference | [npm-tslib-issue-fix](./archive/reference/npm-tslib-issue-fix.md) | archived | 历史记录，仅回溯用 |
| reference | [why-no-type-module](./archive/reference/why-no-type-module.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-completion-summary](./archive/summaries/bearer-token-completion-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-implementation-summary](./archive/summaries/bearer-token-implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-solution-summary](./archive/summaries/bearer-token-solution-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [bearer-token-solution-summary-final](./archive/summaries/bearer-token-solution-summary-final.md) | archived | 历史记录，仅回溯用 |
| summaries | [complete-upgrade-summary](./archive/summaries/complete-upgrade-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [custom-headers-implementation-summary](./archive/summaries/custom-headers-implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [implementation-summary](./archive/summaries/implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [mcp-response-fix-summary](./archive/summaries/mcp-response-fix-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [migration-summary](./archive/summaries/migration-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [post-publication-guide](./archive/summaries/post-publication-guide.md) | archived | 历史记录，仅回溯用 |
| summaries | [swagger2-support-implementation-summary](./archive/summaries/swagger2-support-implementation-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [task-5.1-completion-summary](./archive/summaries/task-5.1-completion-summary.md) | archived | 历史记录，仅回溯用 |
| summaries | [websocket-final-solution](./archive/summaries/websocket-final-solution.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-architecture](./archive/ui/mcp-swagger-ui-architecture.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-development-guide](./archive/ui/mcp-swagger-ui-development-guide.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-technical-documentation](./archive/ui/mcp-swagger-ui-technical-documentation.md) | archived | 历史记录，仅回溯用 |
| ui | [mcp-swagger-ui-upgrade-summary](./archive/ui/mcp-swagger-ui-upgrade-summary.md) | archived | 历史记录，仅回溯用 |
| guides | [offline-dependency-migration-pnpm](./archive/guides/offline-dependency-migration-pnpm.md) | archived | 旧 pnpm 迁移记录，当前使用 npm |
