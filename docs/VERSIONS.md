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
| [Header策略缓存隔离与真实命中验收](./audits/2026-09-22-header-cache-isolation.md) | 1.0.0 | active | 2026-09-22 |
| [四类上游凭据与生命周期作用域验收](./audits/2026-09-22-credential-types-scope.md) | 1.0.0 | active | 2026-09-22 |
| [Header双向过滤与受控真实流执行](./audits/2026-09-21-header-wire-execution.md) | 1.0.0 | active | 2026-09-21 |
| [上游凭据类型、生命周期与作用域合同](./guides/upstream-credential-types-contract.md) | 1.1.0 | active | 2026-09-22 |
| [锁定MCP Adapter协议边界验收](./audits/2026-09-21-mcp-adapter-contract.md) | 1.0.0 | active | 2026-09-21 |
| [Header策略编译与安全接线准备](./audits/2026-09-21-header-policy-compilation.md) | 1.0.0 | active | 2026-09-21 |
| [上游安全对账与发布门禁契约](./guides/upstream-security-reconciliation-contract.md) | 1.0.0 | active | 2026-09-21 |
| [Consumer与Upstream分区和重载恢复](./audits/2026-09-21-upstream-credential-management-ui.md) | 1.0.0 | active | 2026-09-21 |
| [锁定SDK会话与通知合同验证](./audits/2026-09-21-sdk-session-contract.md) | 1.0.0 | active | 2026-09-21 |
| [临时匿名管理界面验收](./audits/2026-09-21-temporary-anonymous-ui.md) | 1.0.0 | active | 2026-09-21 |
| [JWT参数保存与真实运行验收](./audits/2026-09-21-jwt-policy-lifecycle.md) | 1.0.0 | active | 2026-09-21 |
| [持久撤销与既有会话验证](./audits/2026-09-21-persistent-session-revocation.md) | 1.0.0 | active | 2026-09-21 |
| [六层限流组合验收](./audits/2026-09-21-layered-rate-limit-composition.md) | 1.0.0 | active | 2026-09-21 |
| [在线凭证轮换与临时匿名闭环](./audits/2026-09-21-live-rotation-temporary-anonymous.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-B1-01 统一消费者凭证模型与双入口验收](./audits/2026-09-21-unified-consumer-credentials.md) | 1.0.1 | active | 2026-09-21 |
| [SEC-C2-02 Windows秘密文件ACL验收](./audits/2026-09-21-windows-secret-acl.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-C3-02 Registry配置可信数据库归属验收](./audits/2026-09-21-registry-db-ownership.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-A1-02D 保存、发布、重启与真实请求闭环](./audits/2026-09-21-auth-publication-loop.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-D2-01 Gateway IP与匿名独立限流验收](./audits/2026-09-21-independent-rate-limits.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-C3-01 固定凭据文件自动重载验收](./audits/2026-09-21-registry-watch.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-A4-02当前版本PostgreSQL空库验收](./audits/2026-09-21-isolated-postgres-schema.md) | 1.0.0 | active | 2026-09-21 |
| [OBS-14-05C3 Windows PostgreSQL多写者验收](./audits/2026-09-21-pg-quota-multiwriter-evidence.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-A2-01B三入口拒绝矩阵](./audits/2026-09-21-mcp-rejection-matrix.md) | 1.0.0 | active | 2026-09-21 |
| [SEC-A1-02B4鉴权模式界面交付](./audits/2026-09-21-mcp-mode-ui-evidence.md) | 1.0.0 | active | 2026-09-21 |
| [docs/audits/2026-09-04-manual-registration-publication.md](./audits/2026-09-04-manual-registration-publication.md) | 1.0.0 | active | 2026-09-07 |
| [docs/audits/2026-09-07-reviewed-merge.md](./audits/2026-09-07-reviewed-merge.md) | 1.0.0 | active | 2026-09-07 |
| [docs/audits/README.md](./audits/README.md) | 1.44.0 | active | 2026-09-22 |
| [全范围审核与重拆](./audits/2026-09-15-work-package-replan.md) | 1.0.0 | active | 2026-09-15 |
| [PROD-03本地发布循环](./audits/2026-09-15-prod-03-local-publication-cycle.md) | 0.1.0 | active | 2026-09-15 |
| [重拆第二批限定证据](./audits/2026-09-16-replanned-batch-2-evidence.md) | 1.7.0 | active | 2026-09-16 |
| [重拆第三批限定证据](./audits/2026-09-16-replanned-batch-3-evidence.md) | 1.0.0 | active | 2026-09-16 |
| [重拆第四批限定证据](./audits/2026-09-16-replanned-batch-4-evidence.md) | 1.0.0 | active | 2026-09-16 |
| [配额恢复故障验收](./audits/2026-09-21-payload-recovery-acceptance.md) | 1.0.0 | active | 2026-09-21 |
| [受管鉴权模式一致性](./audits/2026-09-21-managed-inbound-mode-evidence.md) | 1.0.0 | active | 2026-09-21 |
| [额度中断恢复证据](./audits/2026-09-17-interruption-recovery-evidence.md) | 1.0.0 | active | 2026-09-17 |
| [重拆第五批限定证据](./audits/2026-09-16-replanned-batch-5-evidence.md) | 1.0.0 | active | 2026-09-16 |
| [端点测试二进制样例合同](./guides/endpoint-test-binary-sample-contract.md) | 0.8.0 | active | 2026-09-17 |
| [活跃工作包划分](./guides/active-work-package-breakdown.md) | 1.66.0 | active | 2026-09-24 |
| [安全交付验收证据索引](./guides/security-delivery-evidence-index.md) | 1.60.0 | active | 2026-09-24 |
| [MCP发布端点合同](./guides/mcp-publication-endpoint-contract.md) | 0.2.0 | active | 2026-09-21 |
| [活跃子任务执行状态](./guides/active-work-package-execution-status.md) | 1.107.0 | active | 2026-09-24 |
| [受管MCP启动交付设计](./guides/managed-mcp-credential-handoff-plan.md) | 0.4.0 | reviewed-slice | 2026-09-21 |
| [候选激活与GC重试](./audits/2026-09-15-activation-gc-wave.md) | 1.0.0 | active | 2026-09-15 |
| [上游归属交叉核验](./audits/2026-09-15-upstream-ownership-wave.md) | 1.0.0 | active | 2026-09-15 |
| [发布读取与停机收敛](./audits/2026-09-15-publication-shutdown-wave.md) | 1.0.0 | active | 2026-09-15 |
| [单查询归属与故障恢复](./audits/2026-09-15-ownership-recovery-wave.md) | 1.0.0 | active | 2026-09-15 |
| [MCP装配可信映射](./audits/2026-09-15-mcp-assembly-ownership-wave.md) | 1.0.0 | active | 2026-09-15 |
| [提交整理与可信资产快照](./audits/2026-09-14-commit-ownership-wave.md) | 1.0.0 | active | 2026-09-14 |
| [单跳凭据、容量样本与诊断UI](./audits/2026-09-14-single-hop-capacity-diagnostics-wave.md) | 1.0.0 | active | 2026-09-14 |
| [路由观测、可信映射与策略UI](./audits/2026-09-14-routing-policy-mapping-wave.md) | 1.0.0 | active | 2026-09-14 |
| [MCP可信操作映射](./guides/mcp-trusted-operation-bindings.md) | 1.6.0 | active | 2026-09-15 |
| [正文保留与消费端推进](./audits/2026-09-14-retention-consumer-wave.md) | 1.0.0 | active | 2026-09-14 |
| [管理心跳、请求头与Gateway消费者](./audits/2026-09-14-heartbeat-header-consumer-wave.md) | 1.0.0 | active | 2026-09-14 |
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
| [docs/guides/README.md](./guides/README.md) | 1.3.1 | active | 2026-09-16 |
| [docs/guides/release-readiness-checklist.md](./guides/release-readiness-checklist.md) | 1.1.0 | active | 2026-09-08 |
| [docs/guides/staged-development-plan.md](./guides/staged-development-plan.md) | 1.1.0 | active | 2026-09-15 |
| [docs/README.md](./README.md) | 1.3.1 | active | 2026-09-16 |
| [docs/reference/changelog-field-guide.md](./reference/changelog-field-guide.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/esm-commonjs-quick-reference.md](./reference/esm-commonjs-quick-reference.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/management-observability-baseline.md](./reference/management-observability-baseline.md) | 1.1.0 | active | 2026-09-14 |
| [docs/reference/management-permission-matrix.md](./reference/management-permission-matrix.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/mcp-jsonrpc-relationship.md](./reference/mcp-jsonrpc-relationship.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/nodejs-module-systems-guide.md](./reference/nodejs-module-systems-guide.md) | 1.0.0 | active | 2026-09-07 |
| [docs/reference/open-items.md](./reference/open-items.md) | 1.14.0 | active | 2026-09-15 |
| [docs/reference/README.md](./reference/README.md) | 1.3.0 | active | 2026-09-14 |
| [docs/reference/versioning-policy.md](./reference/versioning-policy.md) | 1.0.0 | active | 2026-09-07 |
| [docs/release/api-nova-release-requirements.md](./release/api-nova-release-requirements.md) | 1.1.0 | active | 2026-09-08 |
| [docs/release/offline-dependency-migration.md](./release/offline-dependency-migration.md) | 1.0.0 | active | 2026-09-07 |

| [docs/audits/2026-09-08-persistence-cleanup.md](./audits/2026-09-08-persistence-cleanup.md) | 1.0.0 | active | 2026-09-08 |

| [活跃任务依赖与并发推进](./audits/2026-09-14-active-task-dependencies.md) | 1.0.0 | active | 2026-09-14 |

| [按规划继续执行](./audits/2026-09-14-planned-next-wave.md) | 1.0.0 | active | 2026-09-14 |

## 安全开发文档

2026-09-14 按依赖完成 C3 稳定文件读取与 Gateway 配置激活：Parser 全量 342/342、Gateway 完整专项 123/123、三包构建通过；旧夹具 4 项失败已修复。新增文件激活手册和 D1/F3 draft 契约（30 项矩阵）。下一关键节点为 MCP 可信绑定到发送链路；Watch/管理 API、Header Allowlist、网络控制和 Linux 权限证据仍未闭环。

| 文档 | 版本 | 状态 | 更新时间 |
| --- | --- | --- | --- |
| [安全任务计划](./guides/security-development-task-plan.md) | 1.56.0 | active | 2026-09-24 |
| [安全执行状态](./guides/security-development-execution-status.md) | 1.84.0 | active | 2026-09-24 |
| [安全功能需求](./guides/security-functional-requirements.md) | 1.1.0 | active | 2026-09-15 |
| [安全设计](./reference/security-design-and-implementation.md) | 1.2.0 | active | 2026-09-14 |
| [Gateway 文件激活](./guides/gateway-upstream-credential-file-activation.md) | 1.1.0 | active | 2026-09-14 |
| [D1/F3 边界契约](./guides/security-header-network-boundary-contract.md) | 1.33.0 | active | 2026-09-24 |
| [安全调用与日志审计](./guides/runtime-security-and-call-audit.md) | 1.2.0 | active | 2026-09-14 |
| [安全验收用例](./testing/runtime-security-audit-cases.md) | 1.2.0 | active | 2026-09-14 |
| [SEC-A1-01鉴权模式跨层矩阵](./testing/sec-a1-01-auth-mode-cross-layer-matrix.md) | 0.2.0 | validation-evidence | 2026-09-16 |

[安全历史归档](./archive/summaries/security-2026-09-14/README.md)的四份原始快照为 archived，页内旧状态仅供追溯。

## 可观测性增强文档

`active` 表示文档正在维护，不表示已部署。当前完成情况、剩余任务及实现边界以[完成情况复核](./guides/runtime-observability-completion-review.md)为统一入口；验收结果和环境范围以[执行状态](./guides/runtime-observability-development-execution-status.md)为准。需求和设计保留规范目标，不能代替代码或验收证据。

| 文档 | 版本 | 状态 | 更新时间 |
| --- | --- | --- | --- |
| [可观测性功能需求](./guides/runtime-observability-requirements.md) | 2.2.0 | active | 2026-09-14 |
| [可观测性设计](./reference/runtime-observability-design.md) | 2.2.0 | active | 2026-09-14 |
| [可观测性 API Endpoint](./reference/runtime-observability-api-endpoints.md) | 2.7.0 | active | 2026-09-14 |
| [可观测性开发任务计划](./guides/runtime-observability-development-task-plan.md) | 2.9.0 | active | 2026-09-15 |
| [可观测性执行与完成状态](./guides/runtime-observability-development-execution-status.md) | 2.29.0 | active | 2026-09-24 |
| [任务完成情况复核](./guides/runtime-observability-completion-review.md) | 2.21.0 | active | 2026-09-24 |
| [可观测性契约与接入映射](./reference/runtime-observability-contract-mapping.md) | 2.1.0 | active | 2026-09-14 |
| [可观测性存储基础](./reference/runtime-observability-storage-foundation.md) | 2.1.0 | active | 2026-09-14 |
| [可观测性生命周期合同](./reference/runtime-observability-lifecycle-contract.md) | 1.0.0 | active | 2026-09-15 |
| [可观测性容量配额合同](./reference/runtime-observability-capacity-quota-contract.md) | 1.10.0 | active | 2026-09-21 |
| [运行集成指南](./guides/runtime-observability-integration.md) | 2.7.0 | active | 2026-09-14 |
| [订阅集成指南](./guides/runtime-observability-subscription-integration.md) | 2.4.0 | active | 2026-09-14 |
| [外部验收交接](./guides/runtime-observability-external-validation-handoff.md) | 2.2.0 | active | 2026-09-15 |

### 2026-09-14 可观测性历史归档

[归档索引](./archive/summaries/runtime-observability-2026-09-14/README.md)说明原始位置和当前替代入口。快照原文只读保留，页内旧状态属于历史上下文；归档状态以本表与索引为准。

| 历史文档 | 状态 | 归档原因 |
| --- | --- | --- |
| [合并前未完成工作报告](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-remaining-work-2026-09-14.md) | archived | 过期待办，已移出 guides |
| [完成情况整理前快照](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-completion-review.md) | archived | 保留相互覆盖的阶段结论 |
| [执行状态历史流水](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-development-execution-status.md) | archived | 保留旧阶段计数、失败及后续通过证据 |
| [任务计划整理前快照](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-development-task-plan.md) | archived | 批准任务仍有当前版本，旧进展留作历史 |
| [API 契约整理前快照](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-api-endpoints.md) | archived | 历史接口状态不再定义当前契约 |
| [存储基础整理前快照](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-storage-foundation.md) | archived | 保留阶段实现与数据库专项证据 |
| [契约映射整理前快照](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-contract-mapping.md) | archived | 历史映射由当前实现映射替代 |
| [设计整理前快照](./archive/summaries/runtime-observability-2026-09-14/runtime-observability-design.md) | archived | 规范基线继续维护，阶段快照只供追溯 |

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

## 上游凭证 Linux 专项操作

| 文档 | doc-version | 状态 | 说明 |
| --- | --- | --- | --- |
| [upstream-secret-provider-linux.md](testing/upstream-secret-provider-linux.md) | 1.0.0 | active | 待执行的隔离操作说明，不是 Linux 验收通过证据 |
